/**
 * @packageDocumentation
 * Worker thread that evaluates mathjs expressions off the LlamaForge main thread.
 *
 * The parent posts `{ id, expression }` or a test-only `{ id, delayMs }` and receives
 * `{ id, ok: true, result }` or `{ id, ok: false, error }`. A `{ ready: true }` message
 * is posted once mathjs has finished loading. Matrix, Unit, Complex, and BigNumber
 * results are formatted with `math.format`. Numbers and booleans stay as they are.
 */

import { all, create, type MathJsInstance } from "mathjs";

/** Expressions longer than this are rejected before mathjs sees them. */
const MAX_EXPRESSION_LENGTH = 1_000;

/** Matrices, ranges, and arrays with more elements than this are rejected. */
const MAX_RESULT_ELEMENTS = 10_000;

/** Formatted results longer than this are rejected. */
const MAX_FORMATTED_LENGTH = 100_000;

/** Upper bound on a test-only pre-evaluation delay, in milliseconds. */
const MAX_TEST_DELAY_MS = 60_000;

const EXPRESSION_LIMIT_MESSAGE = "Expression exceeds the 1,000 character limit.";
const SIZE_LIMIT_MESSAGE = "Calculation result exceeds the 10,000 element limit.";
const TEXT_LIMIT_MESSAGE = "Calculation result exceeds the 100,000 character limit.";

const MATRIX_FORMATS: ReadonlySet<string> = new Set(["dense", "sparse"]);

if (!all) {
  throw new Error("mathjs factory map is unavailable.");
}

const math: MathJsInstance = create(all);

/** How long the next evaluation should wait. Armed only by the parent test seam. */
let nextDelayMs = 0;

/**
 * Reads a finite number from a mathjs scalar.
 *
 * @param value - Candidate numeric argument.
 * @returns The number, or `null` when the value is not a finite scalar.
 */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (math.isBigNumber(value)) {
    const numeric = value.toNumber();
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

/**
 * Reads a non-negative integer dimension.
 *
 * @param value - Candidate dimension.
 * @returns The dimension, or `null` when it is not a safe count.
 */
function toCount(value: unknown): number | null {
  const numeric = toFiniteNumber(value);
  if (numeric === null || !Number.isInteger(numeric) || numeric < 0) {
    return null;
  }
  return numeric;
}

/**
 * Returns whether `value` names a mathjs matrix storage format.
 *
 * @param value - Argument that may be the trailing format string.
 * @returns `true` for `dense` or `sparse`.
 */
function isMatrixFormat(value: unknown): value is string {
  return typeof value === "string" && MATRIX_FORMATS.has(value);
}

/**
 * Drops a trailing matrix format argument.
 *
 * @param args - Arguments passed to a matrix factory.
 * @returns The arguments that describe the shape.
 */
function stripFormat(args: readonly unknown[]): readonly unknown[] {
  const last = args[args.length - 1];
  if (args.length > 0 && isMatrixFormat(last)) {
    return args.slice(0, -1);
  }
  return args;
}

/**
 * Rejects counts that are negative, non-finite, or above the element cap.
 *
 * @param count - Element count to test.
 * @throws When the count is not allowed.
 */
function assertElementCount(count: number): void {
  if (!Number.isFinite(count) || count < 0 || count > MAX_RESULT_ELEMENTS) {
    throw new Error(SIZE_LIMIT_MESSAGE);
  }
}

/**
 * Multiplies dimensions, stopping once the product exceeds the element cap.
 *
 * @param dimensions - Matrix dimensions.
 * @returns The product, or `Infinity` when a dimension is not a safe count.
 */
function productOfDimensions(dimensions: readonly number[]): number {
  if (dimensions.length === 0) {
    return 1;
  }
  let product = 1;
  for (const dimension of dimensions) {
    if (!Number.isInteger(dimension) || dimension < 0) {
      return Number.POSITIVE_INFINITY;
    }
    product *= dimension;
    if (!Number.isFinite(product) || product > MAX_RESULT_ELEMENTS) {
      return product;
    }
  }
  return product;
}

/**
 * Estimates how many values an exclusive numeric range contains.
 *
 * The count is arithmetic so `range(0, 1e9)` does not loop. A tiny epsilon keeps
 * exact multiples from rounding up an extra step.
 *
 * @param start - First value.
 * @param end - End value, excluded.
 * @param step - Distance between values.
 * @returns The element count, or `Infinity` when the range cannot be measured.
 */
function exclusiveRangeCount(start: number, end: number, step: number): number {
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step) || step === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const raw = Math.abs(end - start) / Math.abs(step);
  if (!Number.isFinite(raw)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.ceil(raw - 1e-9));
}

/**
 * Parses a mathjs range string such as `0:10` or `0:2:10`.
 *
 * @param input - Text passed to `range`.
 * @returns The numeric bounds, or `null` when the string is not a simple range.
 */
function parseRangeString(input: string): { start: number; end: number; step: number } | null {
  const parts = input.split(":");
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }
  const numbers = parts.map((part) => Number(part.trim()));
  if (numbers.some((part) => !Number.isFinite(part))) {
    return null;
  }
  const start = numbers[0];
  const middle = numbers[1];
  const last = numbers[2];
  if (start === undefined || middle === undefined) {
    return null;
  }
  if (numbers.length === 2) {
    return { start, end: middle, step: 1 };
  }
  if (last === undefined) {
    return null;
  }
  return { start, end: last, step: middle };
}

/**
 * Rejects ranges whose result would exceed the element cap.
 *
 * Runs before the original `range` allocates. Unknown bounds are rejected as well,
 * because a range that cannot be measured is not safe to materialize.
 *
 * @param args - Arguments forwarded to mathjs `range`.
 * @throws When the range is larger than the cap or its size cannot be proven.
 */
function assertRangeAllowed(args: readonly unknown[]): void {
  let start: number | null;
  let end: number | null;
  let step = 1;
  let includeEnd = false;

  if (typeof args[0] === "string") {
    const parsed = parseRangeString(args[0]);
    if (!parsed) {
      throw new Error(SIZE_LIMIT_MESSAGE);
    }
    start = parsed.start;
    end = parsed.end;
    step = parsed.step;
    if (typeof args[1] === "boolean") {
      includeEnd = args[1];
    }
  } else {
    start = toFiniteNumber(args[0]);
    end = toFiniteNumber(args[1]);
    if (args.length >= 3 && typeof args[2] === "boolean") {
      includeEnd = args[2];
    } else if (args.length >= 3) {
      const parsedStep = toFiniteNumber(args[2]);
      if (parsedStep === null) {
        throw new Error(SIZE_LIMIT_MESSAGE);
      }
      step = parsedStep;
      if (typeof args[3] === "boolean") {
        includeEnd = args[3];
      }
    }
  }

  if (start === null || end === null) {
    throw new Error(SIZE_LIMIT_MESSAGE);
  }
  const count = exclusiveRangeCount(start, end, step) + (includeEnd ? 1 : 0);
  assertElementCount(count);
}

/**
 * Reads a list of numeric dimensions from an array or matrix.
 *
 * @param value - Shape argument passed to a matrix factory.
 * @returns The dimensions, or `null` when any entry is not a count.
 */
function numericDimensions(value: unknown): number[] | null {
  const list = math.isMatrix(value) ? value.toArray() : value;
  if (!Array.isArray(list)) {
    return null;
  }
  const dimensions: number[] = [];
  for (const entry of list) {
    const count = toCount(entry);
    if (count === null) {
      return null;
    }
    dimensions.push(count);
  }
  return dimensions;
}

/**
 * Rejects `zeros` / `ones` / `identity` shapes above the element cap.
 *
 * @param args - Factory arguments, including an optional trailing format string.
 * @param squareSingle - When true, a single numeric argument is an n-by-n matrix.
 * @throws When the shape is too large or cannot be read.
 */
function assertFactoryShape(args: readonly unknown[], squareSingle: boolean): void {
  const shapeArgs = stripFormat(args);
  if (shapeArgs.length === 0) {
    return;
  }
  const only = shapeArgs[0];
  if (squareSingle && shapeArgs.length === 1 && !Array.isArray(only) && !math.isMatrix(only)) {
    const side = toCount(only);
    if (side === null) {
      throw new Error(SIZE_LIMIT_MESSAGE);
    }
    assertElementCount(side * side);
    return;
  }
  if (shapeArgs.length === 1 && (Array.isArray(only) || math.isMatrix(only))) {
    const dimensions = numericDimensions(only);
    if (!dimensions) {
      throw new Error(SIZE_LIMIT_MESSAGE);
    }
    assertElementCount(productOfDimensions(dimensions));
    return;
  }
  const dimensions: number[] = [];
  for (const arg of shapeArgs) {
    const count = toCount(arg);
    if (count === null) {
      throw new Error(SIZE_LIMIT_MESSAGE);
    }
    dimensions.push(count);
  }
  assertElementCount(productOfDimensions(dimensions));
}

/**
 * Rejects `random` / `randomInt` calls that ask for a matrix above the cap.
 *
 * Scalar calls such as `random(1, 6)` are left alone. Only a leading size
 * array or matrix is treated as an allocation.
 *
 * @param args - Arguments forwarded to the random factory.
 * @throws When the requested matrix is too large or its size cannot be read.
 */
function assertRandomAllowed(args: readonly unknown[]): void {
  const first = args[0];
  if (!Array.isArray(first) && !math.isMatrix(first)) {
    return;
  }
  const dimensions = numericDimensions(first);
  if (!dimensions) {
    throw new Error(SIZE_LIMIT_MESSAGE);
  }
  assertElementCount(productOfDimensions(dimensions));
}

/**
 * Describes the shape of a matrix, array, or scalar already in memory.
 *
 * @param value - Value whose shape is needed before another allocation.
 * @returns Dimensions, an empty list for a scalar, or `null` when unknown.
 */
function collectionShape(value: unknown): number[] | null {
  if (math.isMatrix(value)) {
    return value.size();
  }
  if (Array.isArray(value)) {
    return nestedArrayShape(value);
  }
  if (typeof value === "number" || math.isBigNumber(value) || typeof value === "boolean") {
    return [];
  }
  return null;
}

/**
 * Measures a nested JavaScript array as a rectangular shape.
 *
 * @param value - Array to measure.
 * @returns The outer length followed by the first child's shape when every child is an array.
 */
function nestedArrayShape(value: readonly unknown[]): number[] {
  if (value.length === 0) {
    return [0];
  }
  const first = value[0];
  if (Array.isArray(first) && value.every((entry) => Array.isArray(entry))) {
    return [value.length, ...nestedArrayShape(first)];
  }
  return [value.length];
}

/**
 * Counts elements already stored in a collection.
 *
 * @param value - Matrix, array, or scalar.
 * @returns The element count, or `null` when the value is not a collection or scalar.
 */
function elementCountOf(value: unknown): number | null {
  const shape = collectionShape(value);
  if (!shape) {
    return null;
  }
  if (shape.length === 0) {
    return 1;
  }
  return productOfDimensions(shape);
}

/**
 * Rejects `resize` and `reshape` targets above the element cap.
 *
 * @param args - Arguments whose second entry is the new size.
 * @throws When the new size is too large or cannot be read.
 */
function assertResizeAllowed(args: readonly unknown[]): void {
  const dimensions = numericDimensions(args[1]);
  if (!dimensions) {
    throw new Error(SIZE_LIMIT_MESSAGE);
  }
  assertElementCount(productOfDimensions(dimensions));
}

/**
 * Rejects a diagonal matrix that would be larger than the element cap.
 *
 * A vector of length n becomes an n-by-n matrix. A matrix input only reads a diagonal.
 *
 * @param args - Arguments forwarded to `diag`.
 * @throws When the resulting matrix would be too large.
 */
function assertDiagAllowed(args: readonly unknown[]): void {
  const shape = collectionShape(args[0]);
  if (!shape) {
    throw new Error(SIZE_LIMIT_MESSAGE);
  }
  let shift = 0;
  const second = args[1];
  if (args.length >= 2 && !isMatrixFormat(second)) {
    const parsed = toFiniteNumber(second);
    if (parsed === null) {
      throw new Error(SIZE_LIMIT_MESSAGE);
    }
    shift = Math.abs(parsed);
  }
  if (shape.length <= 1) {
    const length = shape.length === 0 ? 1 : (shape[0] ?? 0);
    assertElementCount((length + shift) * (length + shift));
    return;
  }
  const longest = shape.reduce((max, dimension) => Math.max(max, dimension), 0);
  assertElementCount(longest + shift);
}

/**
 * Rejects a Kronecker product whose element count is the product of the inputs.
 *
 * @param args - The two collections to multiply.
 * @throws When either side cannot be measured or the product is too large.
 */
function assertKronAllowed(args: readonly unknown[]): void {
  const left = elementCountOf(args[0]);
  const right = elementCountOf(args[1]);
  if (left === null || right === null) {
    throw new Error(SIZE_LIMIT_MESSAGE);
  }
  assertElementCount(left * right);
}

/**
 * Calls a mathjs function captured before the sandbox overrides were installed.
 *
 * @param original - Bound original implementation.
 * @param args - Arguments the guarded wrapper received.
 * @returns The original function's return value.
 */
function applyOriginal(
  original: (...args: unknown[]) => unknown,
  args: readonly unknown[],
): unknown {
  return original(...args);
}

/**
 * Binds a mathjs function so later `import` overrides do not replace the copy.
 *
 * @param fn - Function taken from the mathjs instance before overrides.
 * @returns A function that still calls the original implementation.
 * @throws When `fn` is not a function.
 */
function bindOriginal(fn: unknown): (...args: unknown[]) => unknown {
  if (typeof fn !== "function") {
    throw new Error("mathjs function is unavailable.");
  }
  const bound: unknown = fn.bind(math);
  if (typeof bound !== "function") {
    throw new Error("mathjs function is unavailable.");
  }
  return (...args: unknown[]) => (bound as (...args: unknown[]) => unknown)(...args);
}

const originalRange = bindOriginal(math.range);
const originalZeros = bindOriginal(math.zeros);
const originalOnes = bindOriginal(math.ones);
const originalIdentity = bindOriginal(math.identity);
const originalRandom = bindOriginal(math.random);
const originalRandomInt = bindOriginal(math.randomInt);
const originalResize = bindOriginal(math.resize);
const originalReshape = bindOriginal(math.reshape);
const originalDiag = bindOriginal(math.diag);
const originalKron = bindOriginal(math.kron);

math.import(
  {
    import: () => {
      throw new Error("Function import is disabled");
    },
    createUnit: () => {
      throw new Error("Function createUnit is disabled");
    },
    range: (...args: unknown[]) => {
      assertRangeAllowed(args);
      return applyOriginal(originalRange, args);
    },
    zeros: (...args: unknown[]) => {
      assertFactoryShape(args, false);
      return applyOriginal(originalZeros, args);
    },
    ones: (...args: unknown[]) => {
      assertFactoryShape(args, false);
      return applyOriginal(originalOnes, args);
    },
    identity: (...args: unknown[]) => {
      assertFactoryShape(args, true);
      return applyOriginal(originalIdentity, args);
    },
    random: (...args: unknown[]) => {
      assertRandomAllowed(args);
      return applyOriginal(originalRandom, args);
    },
    randomInt: (...args: unknown[]) => {
      assertRandomAllowed(args);
      return applyOriginal(originalRandomInt, args);
    },
    resize: (...args: unknown[]) => {
      assertResizeAllowed(args);
      return applyOriginal(originalResize, args);
    },
    reshape: (...args: unknown[]) => {
      assertResizeAllowed(args);
      return applyOriginal(originalReshape, args);
    },
    diag: (...args: unknown[]) => {
      assertDiagAllowed(args);
      return applyOriginal(originalDiag, args);
    },
    kron: (...args: unknown[]) => {
      assertKronAllowed(args);
      return applyOriginal(originalKron, args);
    },
  },
  { override: true },
);

/**
 * Counts elements in a value, stopping once the cap is passed.
 *
 * @param value - Result or nested child to measure.
 * @param depth - Current nesting depth.
 * @returns An element count. Values above the cap are returned as-is so the caller can reject them.
 */
function countValueElements(value: unknown, depth: number): number {
  if (depth > 32) {
    return MAX_RESULT_ELEMENTS + 1;
  }
  if (math.isMatrix(value)) {
    return productOfDimensions(value.size());
  }
  if (Array.isArray(value)) {
    let total = 0;
    for (const entry of value) {
      total += countValueElements(entry, depth + 1);
      if (total > MAX_RESULT_ELEMENTS) {
        return total;
      }
    }
    return total;
  }
  return 1;
}

/**
 * Rejects text results that are larger than the formatted-string cap.
 *
 * @param value - Text to return to the parent.
 * @returns The same text when it fits.
 * @throws When the text is longer than 100,000 characters.
 */
function guardText(value: string): string {
  if (value.length > MAX_FORMATTED_LENGTH) {
    throw new Error(TEXT_LIMIT_MESSAGE);
  }
  return value;
}

/**
 * Converts a mathjs result into a structured-clone value the parent can JSON-encode.
 *
 * Numbers and booleans are preserved. Matrices and other mathjs objects become text
 * from `math.format`.
 *
 * @param value - Raw `math.evaluate` result.
 * @param depth - Current nesting depth for arrays.
 * @returns A JSON-safe value.
 * @throws When the value exceeds the element or text cap.
 */
function toJsonSafe(value: unknown, depth: number): unknown {
  if (depth > 32) {
    throw new Error(SIZE_LIMIT_MESSAGE);
  }
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return guardText(value);
  }
  if (typeof value === "bigint") {
    return guardText(value.toString());
  }
  if (math.isMatrix(value)) {
    assertElementCount(productOfDimensions(value.size()));
    return guardText(math.format(value));
  }
  if (Array.isArray(value)) {
    assertElementCount(countValueElements(value, depth));
    return value.map((entry) => toJsonSafe(entry, depth + 1));
  }
  return guardText(math.format(value));
}

/**
 * Reads a message for the parent thread.
 *
 * @param error - Failure thrown while evaluating.
 * @returns A short message safe to show in the tool result.
 */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Calculation failed.";
}

/**
 * Parent request accepted by this worker.
 */
type IncomingMessage =
  | { type: "evaluate"; id: number; expression: string }
  | { type: "delay"; id: number; delayMs: number };

/**
 * Parses a parent message.
 *
 * @param data - Structured-cloned `postMessage` payload.
 * @returns The request, or `null` when the payload is not a calculation message.
 */
function readIncoming(data: unknown): IncomingMessage | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "number" || !Number.isFinite(id)) {
    return null;
  }
  if (typeof record["delayMs"] === "number") {
    return { type: "delay", id, delayMs: record["delayMs"] };
  }
  if (typeof record["expression"] === "string") {
    return { type: "evaluate", id, expression: record["expression"] };
  }
  return null;
}

/**
 * Evaluates one parent request and posts the result.
 *
 * @param data - Message received from the parent thread.
 * @returns Nothing. The response is posted back to the parent.
 */
async function handleMessage(data: unknown): Promise<void> {
  const message = readIncoming(data);
  if (!message) {
    return;
  }
  try {
    if (message.type === "delay") {
      if (
        !Number.isFinite(message.delayMs) ||
        message.delayMs < 0 ||
        message.delayMs > MAX_TEST_DELAY_MS
      ) {
        postMessage({ id: message.id, ok: false, error: "Invalid calculate worker delay." });
        return;
      }
      nextDelayMs = message.delayMs;
      postMessage({ id: message.id, ok: true, result: null });
      return;
    }
    if (message.expression.length > MAX_EXPRESSION_LENGTH) {
      postMessage({ id: message.id, ok: false, error: EXPRESSION_LIMIT_MESSAGE });
      return;
    }
    const delayMs = nextDelayMs;
    nextDelayMs = 0;
    if (delayMs > 0) {
      await Bun.sleep(delayMs);
    }
    const raw: unknown = math.evaluate(message.expression);
    postMessage({ id: message.id, ok: true, result: toJsonSafe(raw, 0) });
  } catch (error: unknown) {
    postMessage({ id: message.id, ok: false, error: errorText(error) });
  }
}

addEventListener("message", (event: MessageEvent) => {
  void handleMessage(event.data);
});

postMessage({ ready: true });
