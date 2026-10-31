/**
 * @packageDocumentation
 * Built-in tool that evaluates mathjs expressions on a dedicated worker thread.
 *
 * One worker is created on the first call and reused. Calls are serialized.
 * Each evaluation is limited to two seconds after the worker is ready. A timeout
 * or a worker crash terminates that worker so the next call starts a fresh one.
 */

import type { LlamaForgeTool } from "../../shared/types";

/** How long one evaluation may run once the worker has finished loading mathjs. */
const CALCULATION_TIMEOUT_MS = 2_000;

/** How long to wait for the worker to load mathjs and report that it is ready. */
const WORKER_START_TIMEOUT_MS = 60_000;

/** Upper bound accepted by {@link __armCalculateWorkerDelay}. */
const MAX_TEST_DELAY_MS = 60_000;

const TIMEOUT_MESSAGE = "Calculation timed out.";
const EXPRESSION_LIMIT_MESSAGE = "Expression exceeds the 1,000 character limit.";
const CANCELLED_MESSAGE = "Calculation cancelled.";

/**
 * One in-flight worker request.
 */
interface PendingEvaluation {
  /** Whether the request has already settled. */
  settled: boolean;
  /** Timer that enforces {@link CALCULATION_TIMEOUT_MS}. */
  timer: ReturnType<typeof setTimeout>;
  /** Resolves the caller's promise with the worker's `result` field. */
  resolve: (value: unknown) => void;
  /** Rejects the caller's promise. */
  reject: (error: Error) => void;
}

/**
 * A live calculator worker and the startup handshake attached to it.
 */
interface CalculatorWorker {
  /** Bun worker running `calculateWorker`. */
  worker: Worker;
  /** Resolves once the worker posts `{ ready: true }`. Rejects if startup fails. */
  ready: Promise<void>;
  /** Rejects {@link ready} at most once. Later calls are ignored. */
  fail: (error: Error) => void;
  /** Timer that abandons a worker which never posts ready. */
  startupTimer: ReturnType<typeof setTimeout>;
}

/** Active worker, or `null` after termination. */
let active: CalculatorWorker | null = null;

/** Next id stamped onto a parent-to-worker message. */
let nextRequestId = 0;

/** In-flight requests keyed by message id. */
const pending = new Map<number, PendingEvaluation>();

/**
 * Serializes worker calls so two evaluations cannot run at the same time.
 * The tail always settles, including when a call fails.
 */
let tail: Promise<void> = Promise.resolve();

/**
 * Resolves the calculator worker for the way this module is currently running.
 *
 * `bun run src/server/index.ts` and the test runner load this file as TypeScript,
 * so the worker is the sibling `calculateWorker.ts`. The production bundle inlines
 * this module into `dist/server/index.js`. Bun keeps the worker's path under that
 * directory (`dist/server/builtinTools/calculateWorker.js`) because both build
 * entries live under `src/server`.
 *
 * @param moduleUrl - Module URL to resolve against. Defaults to this file, or to the bundle when the server is built.
 * @returns URL passed to the Bun `Worker` constructor.
 */
export function resolveCalculateWorkerUrl(moduleUrl: string = import.meta.url): URL {
  if (moduleUrl.endsWith(".ts")) {
    return new URL("./calculateWorker.ts", moduleUrl);
  }
  return new URL("./builtinTools/calculateWorker.js", moduleUrl);
}

/**
 * Rejects every in-flight request that has not already settled.
 *
 * @param error - Error delivered to each waiting caller.
 */
function failPending(error: Error): void {
  const entries = [...pending.values()];
  pending.clear();
  for (const entry of entries) {
    if (entry.settled) {
      continue;
    }
    entry.settled = true;
    clearTimeout(entry.timer);
    entry.reject(error);
  }
}

/**
 * Terminates the current worker, fails its startup handshake, and rejects in-flight calls.
 *
 * @param error - Error reported to waiters. Callers waiting for a result see this message.
 */
function failActive(error: Error): void {
  const current = active;
  active = null;
  if (current) {
    clearTimeout(current.startupTimer);
    current.worker.onmessage = null;
    current.worker.onerror = null;
    current.fail(error);
    current.worker.terminate();
  }
  failPending(error);
}

/**
 * Returns whether a worker message is the startup handshake.
 *
 * @param data - Payload received from the worker.
 * @returns `true` when the worker has finished loading mathjs.
 */
function isReadySignal(data: unknown): boolean {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  return (data as Record<string, unknown>)["ready"] === true;
}

/**
 * Reads a worker response for an in-flight id.
 *
 * @param data - Payload received from the worker.
 * @returns The parsed response, or `null` when the payload is not a calculation result.
 */
function readWorkerResponse(
  data: unknown,
): { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string } | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const id = record["id"];
  const ok = record["ok"];
  if (typeof id !== "number" || typeof ok !== "boolean") {
    return null;
  }
  if (ok) {
    return { id, ok: true, result: record["result"] };
  }
  const error = record["error"];
  return {
    id,
    ok: false,
    error: typeof error === "string" && error.length > 0 ? error : "Calculation failed.",
  };
}

/**
 * Settles the pending call that matches a worker response.
 *
 * @param data - Payload received from the worker.
 */
function onWorkerMessage(data: unknown): void {
  const response = readWorkerResponse(data);
  if (!response) {
    return;
  }
  const entry = pending.get(response.id);
  if (!entry || entry.settled) {
    return;
  }
  entry.settled = true;
  clearTimeout(entry.timer);
  pending.delete(response.id);
  if (response.ok) {
    entry.resolve(response.result);
    return;
  }
  entry.reject(new Error(response.error));
}

/**
 * Starts a calculator worker and waits for its ready handshake.
 *
 * @returns The session that owns the new worker. Stored in {@link active}.
 */
function startWorker(): CalculatorWorker {
  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let settled = false;
  const succeed = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    resolveReady();
  };
  const fail = (error: Error): void => {
    if (settled) {
      return;
    }
    settled = true;
    rejectReady(error);
  };

  const created = new Worker(resolveCalculateWorkerUrl(), { ref: false });
  const startupTimer = setTimeout(() => {
    if (active?.worker !== created) {
      return;
    }
    failActive(new Error("Calculator failed to start."));
  }, WORKER_START_TIMEOUT_MS);
  const session: CalculatorWorker = { worker: created, ready, fail, startupTimer };
  created.onmessage = (event: MessageEvent) => {
    if (active?.worker !== created) {
      return;
    }
    const data: unknown = event.data;
    if (isReadySignal(data)) {
      clearTimeout(startupTimer);
      succeed();
      return;
    }
    onWorkerMessage(data);
  };
  created.onerror = (event: ErrorEvent) => {
    event.preventDefault();
    if (active?.worker !== created) {
      return;
    }
    failActive(new Error(TIMEOUT_MESSAGE));
  };
  active = session;
  return session;
}

/**
 * Returns the live worker, creating it on first use.
 *
 * Startup is not part of the two-second evaluation timeout. mathjs takes
 * several seconds to load, and that work happens before a request is posted.
 *
 * @returns The worker that is ready to accept a message.
 * @throws When the worker fails to start or was cancelled while starting.
 */
async function ensureWorker(): Promise<Worker> {
  const session = active ?? startWorker();
  await session.ready;
  if (!active || active.worker !== session.worker) {
    throw new Error(CANCELLED_MESSAGE);
  }
  return session.worker;
}

/**
 * Posts one message and waits for the matching response or the evaluation timeout.
 *
 * @param body - Message fields other than `id`.
 * @returns The worker's `result` field.
 * @throws When the worker reports an error, crashes, or exceeds the timeout.
 */
async function beginRequest(body: { expression: string } | { delayMs: number }): Promise<unknown> {
  const worker = await ensureWorker();
  return new Promise((resolve, reject) => {
    const id = ++nextRequestId;
    const entry: PendingEvaluation = {
      settled: false,
      resolve,
      reject,
      timer: setTimeout(() => {
        const current = pending.get(id);
        if (!current || current.settled) {
          return;
        }
        failActive(new Error(TIMEOUT_MESSAGE));
      }, CALCULATION_TIMEOUT_MS),
    };
    pending.set(id, entry);
    try {
      if ("expression" in body) {
        worker.postMessage({ id, expression: body.expression });
      } else {
        worker.postMessage({ id, delayMs: body.delayMs });
      }
    } catch (error: unknown) {
      failActive(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Runs `operation` after every earlier calculator call has settled.
 *
 * @param operation - Work that must not overlap another evaluation.
 * @returns The operation's result.
 */
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const run = tail.then(operation);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Stops the calculator worker and rejects any call that is still waiting.
 *
 * The next evaluation creates a new worker. Server shutdown calls this so a
 * background evaluation does not outlive the process.
 */
export function shutdownCalculateWorker(): void {
  failActive(new Error(CANCELLED_MESSAGE));
}

/**
 * Arms a one-shot delay inside the calculator worker before the next evaluation.
 *
 * Test seam for the timeout path. The delay is cleared when that evaluation
 * starts, and terminating the worker discards it. Production code does not call this.
 *
 * @param delayMs - How long the next evaluation should wait before `math.evaluate`, from 0 through 60,000.
 * @throws When `delayMs` is not a finite number in that range.
 */
export function __armCalculateWorkerDelay(delayMs: number): Promise<void> {
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_TEST_DELAY_MS) {
    return Promise.reject(
      new Error("Calculate worker delay must be a finite number from 0 through 60,000."),
    );
  }
  return enqueue(async () => {
    await beginRequest({ delayMs });
  });
}

/**
 * Evaluates a mathjs expression supplied by the model.
 */
const calculateTool: LlamaForgeTool = {
  name: "calculate",
  description: "Perform basic mathematical calculations.",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "The mathjs expression to evaluate (e.g. '2 + 2' or 'sqrt(16)').",
      },
    },
    required: ["expression"],
  },
  /**
   * Evaluates `args.expression` on the shared calculator worker.
   *
   * The worker rejects expressions longer than 1,000 characters, results with more
   * than 10,000 elements, and formatted text longer than 100,000 characters.
   * A single call waits at most two seconds after the worker is ready. If that
   * timer fires, or the worker crashes, the worker is terminated and the next
   * call creates a new one.
   *
   * @param args - Object expected to contain a string `expression` field.
   * @returns `{ result }` on success. Numbers and booleans keep their types. Other mathjs values are formatted text.
   * @throws If the expression is missing, mathjs rejects it, the result is too large, or the calculation times out.
   */
  async execute(args: Record<string, unknown>): Promise<{ result: unknown }> {
    const expression = args["expression"];
    if (typeof expression !== "string" || expression.trim().length === 0) {
      throw new Error("calculate requires a non-empty string expression.");
    }
    if (expression.length > 1_000) {
      throw new Error(EXPRESSION_LIMIT_MESSAGE);
    }
    const result = await enqueue(() => beginRequest({ expression }));
    return { result };
  },
};

export default calculateTool;
