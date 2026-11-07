/**
 * @packageDocumentation
 * Strategies for handling context window overflow by truncating or sliding message history.
 */

import type { ChatMessage } from "../shared/types";
import { parseToolCallsJson } from "../shared/toolCalls";
import type {
  ChatCompletionMessage,
  PromptResponseFormat,
  PromptThinkingConfig,
  PromptTool,
} from "./promptPayload";
import { sumMessageVirBudget } from "./mediaBudget";

const tokenCountCache = new Map<string, number>();
/** Increments whenever the loaded tokenizer may have changed. */
let tokenizerEpoch = 0;

/**
 * Returns the current tokenizer generation.
 *
 * The count increases when a model finishes loading and when llama-server exits,
 * so cached token counts from a previous model are not reused.
 *
 * @returns Monotonic epoch for the active tokenizer.
 */
export function getTokenizerEpoch(): number {
  return tokenizerEpoch;
}

/**
 * Drops cached token counts and advances {@link getTokenizerEpoch}.
 *
 * Call this after a model becomes ready and after llama-server exits. The port
 * stays in each cache key; this reset is what makes a reused port safe.
 *
 * @returns No return value.
 */
export function resetTokenCountCache(): void {
  tokenCountCache.clear();
  tokenizerEpoch += 1;
}

/**
 * Rough group size used only to choose a starting cut.
 *
 * The number that decides whether the prompt fits is always
 * {@link countTemplatedPromptTokens}. This hint is not returned to callers.
 *
 * @param group - Messages that must be kept or dropped together.
 * @returns A positive size hint.
 */
function estimateGroupTokens(group: readonly ChatMessage[]): number {
  let tokens = 1;
  for (const message of group) {
    tokens += message.content.length + sumMessageVirBudget(message);
  }
  return tokens;
}
const DEFAULT_CTX_SIZE = 4096;
const DEFAULT_RESERVED_TOKENS = 512;
const MIN_RESERVED_TOKENS = 128;

/**
 * Already-built completion fields used to count tokens without rebuilding media.
 */
export interface TokenEstimationOptions {
  /** API messages aligned with the chat messages being counted. */
  apiMessages?: readonly ChatCompletionMessage[] | undefined;
  /** Encoder tokens aligned with `apiMessages`, one sum per message. */
  mediaTokens?: readonly number[] | undefined;
  /** Tool definitions included in the completion body. */
  tools?: PromptTool[] | undefined;
  /** Structured-output schema included in the completion body. */
  responseFormat?: PromptResponseFormat | undefined;
  /** Thinking kwargs included in the completion body. */
  chatTemplateKwargs?: PromptThinkingConfig["chat_template_kwargs"] | undefined;
}

/**
 * Thrown when `/apply-template` or `/tokenize` cannot produce a prompt count.
 */
export class PromptTokenCountError extends Error {
  /**
   * @param message - Why the count failed.
   */
  constructor(message: string) {
    super(message);
    this.name = "PromptTokenCountError";
  }
}

/**
 * Normalizes a context-window size to a positive integer fallback value.
 *
 * @param ctxSize - Requested context window size.
 * @returns A valid context size suitable for overflow calculations.
 */
function normalizeCtxSize(ctxSize: number): number {
  return Number.isFinite(ctxSize) && ctxSize > 0 ? Math.floor(ctxSize) : DEFAULT_CTX_SIZE;
}

/**
 * Normalizes a requested max-token budget to a positive integer fallback value.
 *
 * @param maxTokens - Requested generation token budget.
 * @returns A normalized reserved-token count.
 */
function normalizeMaxTokens(maxTokens: number): number {
  return Number.isFinite(maxTokens) && maxTokens > 0
    ? Math.floor(maxTokens)
    : DEFAULT_RESERVED_TOKENS;
}

/**
 * Applies the chat template and tokenizes the returned prompt string.
 *
 * Media encoder tokens are added afterwards. A failed template or tokenize
 * call throws. There is no character-length fallback.
 *
 * @param args - Port, API messages, completion extras, and media token sum.
 * @returns Text tokens plus media tokens.
 */
export async function countTemplatedPromptTokens(args: {
  port: number;
  messages: readonly ChatCompletionMessage[];
  tools?: PromptTool[] | undefined;
  responseFormat?: PromptResponseFormat | undefined;
  chatTemplateKwargs?: PromptThinkingConfig["chat_template_kwargs"] | undefined;
  mediaTokens: number;
}): Promise<number> {
  if (!Number.isInteger(args.port) || args.port <= 0) {
    throw new PromptTokenCountError("Cannot count prompt tokens without a loaded model.");
  }
  const applyBody = {
    messages: args.messages,
    ...(args.tools && args.tools.length > 0 ? { tools: args.tools } : {}),
    ...(args.responseFormat ? { response_format: args.responseFormat } : {}),
    ...(args.chatTemplateKwargs ? { chat_template_kwargs: args.chatTemplateKwargs } : {}),
  };
  const cacheMaterial = `${tokenizerEpoch}|${args.port}|${args.mediaTokens}|${JSON.stringify(applyBody)}`;
  const cacheKey = `templated:${String(Bun.hash(cacheMaterial))}`;
  const cached = tokenCountCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let prompt: string;
  try {
    const applied = await fetch(`http://127.0.0.1:${args.port}/apply-template`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify(applyBody),
    });
    if (!applied.ok) {
      throw new PromptTokenCountError(`apply-template failed with HTTP ${applied.status}.`);
    }
    const appliedBody: unknown = await applied.json();
    if (
      !appliedBody ||
      typeof appliedBody !== "object" ||
      typeof (appliedBody as { prompt?: unknown }).prompt !== "string"
    ) {
      throw new PromptTokenCountError("apply-template did not return a prompt string.");
    }
    prompt = (appliedBody as { prompt: string }).prompt;
  } catch (err: unknown) {
    if (err instanceof PromptTokenCountError) throw err;
    throw new PromptTokenCountError(err instanceof Error ? err.message : "apply-template failed.");
  }

  let textTokens: number;
  try {
    const tokenized = await fetch(`http://127.0.0.1:${args.port}/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ content: prompt, add_special: false, parse_special: true }),
    });
    if (!tokenized.ok) {
      throw new PromptTokenCountError(`tokenize failed with HTTP ${tokenized.status}.`);
    }
    const tokenBody: unknown = await tokenized.json();
    if (
      !tokenBody ||
      typeof tokenBody !== "object" ||
      !Array.isArray((tokenBody as { tokens?: unknown }).tokens)
    ) {
      throw new PromptTokenCountError("tokenize did not return a token array.");
    }
    textTokens = (tokenBody as { tokens: unknown[] }).tokens.length;
  } catch (err: unknown) {
    if (err instanceof PromptTokenCountError) throw err;
    throw new PromptTokenCountError(err instanceof Error ? err.message : "tokenize failed.");
  }

  const total = textTokens + Math.max(0, args.mediaTokens);
  tokenCountCache.set(cacheKey, total);
  if (tokenCountCache.size > 500) {
    const evictCount = Math.floor(tokenCountCache.size * 0.25);
    let removed = 0;
    for (const key of tokenCountCache.keys()) {
      if (removed >= evictCount) break;
      tokenCountCache.delete(key);
      removed++;
    }
  }
  return total;
}

/**
 * Builds a minimal API message list from chat rows when the caller has not
 * already rendered one. Production sends pass the rendered array instead.
 *
 * @param messages - Chat rows to mirror.
 * @returns One API message per row, using the stored text content.
 */
function apiMessagesFromChat(messages: readonly ChatMessage[]): ChatCompletionMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
  }));
}

/**
 * Calculates current token usage for a list of messages.
 *
 * @param msgs - Prompt messages to estimate.
 * @param port - Optional llama-server port used for exact tokenization.
 * @param options - Optional prompt serialization override matching the real request body.
 * @returns Total estimated prompt tokens including attachment overhead.
 */
export async function getTokens(
  msgs: ChatMessage[],
  port?: number,
  options?: TokenEstimationOptions,
): Promise<number> {
  if (!port) {
    throw new PromptTokenCountError("Cannot count prompt tokens without a loaded model.");
  }
  const apiMessages =
    options?.apiMessages && options.apiMessages.length === msgs.length
      ? options.apiMessages
      : apiMessagesFromChat(msgs);
  const mediaTokens =
    options?.mediaTokens && options.mediaTokens.length === msgs.length
      ? options.mediaTokens.reduce((sum, value) => sum + value, 0)
      : msgs.reduce((sum, message) => sum + sumMessageVirBudget(message), 0);
  return countTemplatedPromptTokens({
    port,
    messages: apiMessages,
    tools: options?.tools,
    responseFormat: options?.responseFormat,
    chatTemplateKwargs: options?.chatTemplateKwargs,
    mediaTokens,
  });
}

/**
 * Counts one slice of an already-built API message list.
 *
 * @param messages - Chat rows in the slice. Used only for length checks.
 * @param port - llama-server port.
 * @param options - Prepared API messages and completion extras for the full list.
 * @param indexes - Positions in the original prepared arrays.
 * @returns Templated text tokens plus the slice's `virBudget` sum.
 */
async function getPromptTokens(
  messages: ChatMessage[],
  port: number | undefined,
  options: TokenEstimationOptions | undefined,
  indexes?: readonly number[],
): Promise<number> {
  if (!port) {
    throw new PromptTokenCountError("Cannot count prompt tokens without a loaded model.");
  }
  if (
    options?.apiMessages &&
    options.mediaTokens &&
    indexes &&
    options.apiMessages.length === options.mediaTokens.length
  ) {
    const apiMessages = indexes
      .map((index) => options.apiMessages?.[index])
      .filter((message): message is ChatCompletionMessage => message !== undefined);
    const mediaTokens = indexes.reduce(
      (sum, index) => sum + (options.mediaTokens?.[index] ?? 0),
      0,
    );
    return countTemplatedPromptTokens({
      port,
      messages: apiMessages,
      tools: options.tools,
      responseFormat: options.responseFormat,
      chatTemplateKwargs: options.chatTemplateKwargs,
      mediaTokens,
    });
  }
  return getTokens(messages, port, options);
}

/**
 * Clones a chat message shallowly so overflow truncation can mutate a safe copy.
 *
 * @param message - Source message to clone.
 * @returns A shallow clone of the message and its attachment list.
 */
function cloneMessage(message: ChatMessage): ChatMessage {
  return { ...message, attachments: message.attachments ? [...message.attachments] : undefined };
}

/**
 * Computes the reserved completion-token budget that must remain free in the context window.
 *
 * @param maxTokens - Requested generation token budget.
 * @returns Reserved prompt budget after enforcing the minimum floor.
 */
function getReservedTokens(maxTokens: number): number {
  return Math.max(MIN_RESERVED_TOKENS, normalizeMaxTokens(maxTokens));
}

/**
 * Groups chat messages so an assistant tool-call turn and its tool responses
 * are truncated as a single unit.
 *
 * @param messages - Chat messages in prompt order.
 * @returns Atomic message groups.
 */
function groupMessagesAtomically(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (!message) break;
    if (message.role === "assistant" && parseToolCallsJson(message.toolCallsJson)) {
      const group: ChatMessage[] = [message];
      index += 1;
      while (index < messages.length && messages[index]?.role === "tool") {
        const toolMessage = messages[index];
        if (toolMessage) group.push(toolMessage);
        index += 1;
      }
      groups.push(group);
      continue;
    }
    groups.push([message]);
    index += 1;
  }
  return groups;
}

/**
 * Maps a message-index prefix length onto the group that starts at or after it.
 *
 * If the index lands inside a tool-call group, the whole group is preserved.
 *
 * @param groups - Atomic message groups.
 * @param messageIndex - Number of leading messages that must be kept.
 * @returns Group index from which truncation may delete.
 */
function preservedGroupCount(groups: ChatMessage[][], messageIndex: number): number {
  let counted = 0;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex];
    if (!group) continue;
    if (messageIndex <= counted) return groupIndex;
    counted += group.length;
    if (messageIndex < counted) return groupIndex + 1;
  }
  return groups.length;
}

/**
 * Determines how many leading messages must be preserved during overflow truncation.
 *
 * @param messages - Prompt messages currently under consideration.
 * @param roleSystemPrompt - Whether the first system message must be protected.
 * @returns Number of prefix messages that truncation must preserve.
 */
function getProtectedPrefixLength(messages: ChatMessage[], roleSystemPrompt: boolean): number {
  let protectedCount = 0;
  if (roleSystemPrompt && messages[0]?.role === "system") {
    protectedCount = 1;
  }
  return protectedCount;
}

export class ContextOverflowError extends Error {
  constructor(message = "Conversation exceeds the context window (Stop At Limit).") {
    super(message);
    this.name = "ContextOverflowError";
  }
}

/**
 * Truncates message history according to the configured context overflow policy.
 *
 * @param rawMessages - Full message history before overflow handling.
 * @param overflowPolicy - Strategy used to drop or preserve messages.
 * @param ctxSize - Active model context size.
 * @param maxTokens - Reserved completion token budget.
 * @param port - Optional llama-server port used for exact tokenization.
 * @param roleSystemPrompt - Whether the leading system prompt must always be preserved.
 * @param tokenOptions - Optional serializer matching the real inference request payload.
 * @returns A truncated message list that fits within the prompt token budget.
 */
export async function truncateMessages(
  rawMessages: ChatMessage[],
  overflowPolicy: "StopAtLimit" | "TruncateMiddle" | "RollingWindow",
  ctxSize: number,
  maxTokens: number,
  port?: number,
  roleSystemPrompt: boolean = true,
  tokenOptions?: TokenEstimationOptions,
): Promise<ChatMessage[]> {
  const indexById = new Map<string, number>();
  rawMessages.forEach((message, index) => {
    if (message.id) indexById.set(message.id, index);
  });
  const countSubset = (subset: readonly ChatMessage[]): Promise<number> => {
    const indexes = subset
      .map((message) => indexById.get(message.id))
      .filter((index): index is number => index !== undefined);
    return getPromptTokens([...subset], port, tokenOptions, indexes);
  };

  if (overflowPolicy === "StopAtLimit") {
    const reservedTokens = getReservedTokens(maxTokens);
    const maxPromptTokens = normalizeCtxSize(ctxSize) - reservedTokens;
    if (maxPromptTokens > 0) {
      const currentTokens = await countSubset(rawMessages);
      if (currentTokens > maxPromptTokens) {
        throw new ContextOverflowError();
      }
    }
    return rawMessages;
  }

  const messages = [...rawMessages].map(cloneMessage);
  const normalizedCtxSize = normalizeCtxSize(ctxSize);
  const reservedTokens = getReservedTokens(maxTokens);
  const maxPromptTokens = normalizedCtxSize - reservedTokens;
  if (maxPromptTokens <= 0) return messages;

  let currentTokens = await countSubset(messages);
  if (currentTokens <= maxPromptTokens) return messages;

  const protectedPrefix = getProtectedPrefixLength(messages, roleSystemPrompt);
  const keepLastCount = 1;
  const groups = groupMessagesAtomically(messages);

  /**
   * Estimates the token cost of the groups that would remain after a cut.
   *
   * Prefix sums are taken from the groups still present, so a later pass does not
   * reuse sums from groups that have already been removed.
   *
   * @param startGroupIndex - First group that may be removed.
   * @param removeCount - How many groups to drop from that point.
   * @returns Estimated tokens, including constant request overhead.
   */
  const estimateRemaining = (startGroupIndex: number, removeCount: number): number => {
    const estimates = groups.map((group) => estimateGroupTokens(group));
    const prefix: number[] = [0];
    for (const estimate of estimates) prefix.push((prefix.at(-1) ?? 0) + estimate);
    const afterIndex = Math.min(groups.length, startGroupIndex + removeCount);
    const keptBefore = prefix[startGroupIndex] ?? 0;
    const keptAfter = (prefix[groups.length] ?? 0) - (prefix[afterIndex] ?? 0);
    return keptBefore + keptAfter;
  };

  const removeGroupsUntilFit = async (
    startGroupIndex: number,
    minRemainingGroups: number,
  ): Promise<void> => {
    if (currentTokens <= maxPromptTokens) return;
    if (startGroupIndex < 0 || startGroupIndex >= groups.length) return;
    const lastRemovableIndex =
      keepLastCount > 0 ? Math.max(startGroupIndex, groups.length - 1) - 1 : groups.length - 1;
    const maxK = Math.min(
      Math.max(0, groups.length - minRemainingGroups),
      Math.max(0, lastRemovableIndex - startGroupIndex + 1),
    );
    if (maxK <= 0) return;

    let removeCount = maxK;
    for (let count = 1; count <= maxK; count++) {
      if (estimateRemaining(startGroupIndex, count) <= maxPromptTokens) {
        removeCount = count;
        break;
      }
    }
    groups.splice(startGroupIndex, removeCount);

    currentTokens = await countSubset(groups.flat());
    while (currentTokens > maxPromptTokens) {
      const nextLastRemovable =
        keepLastCount > 0 ? Math.max(startGroupIndex, groups.length - 1) - 1 : groups.length - 1;
      const canDrop =
        startGroupIndex <= nextLastRemovable && groups.length - 1 >= minRemainingGroups;
      if (!canDrop || startGroupIndex >= groups.length) break;
      groups.splice(startGroupIndex, 1);
      currentTokens = await countSubset(groups.flat());
    }
  };

  if (overflowPolicy === "TruncateMiddle") {
    const firstUserIndex = messages.findIndex(
      (m, idx) => idx >= protectedPrefix && m.role === "user",
    );
    const preserveUntil = firstUserIndex !== -1 ? firstUserIndex + 1 : protectedPrefix;
    const preserveGroups = Math.max(
      preservedGroupCount(groups, preserveUntil),
      preservedGroupCount(groups, protectedPrefix),
    );
    await removeGroupsUntilFit(preserveGroups, preserveGroups + keepLastCount);
  } else {
    const preserveGroups = preservedGroupCount(groups, protectedPrefix);
    await removeGroupsUntilFit(preserveGroups, preserveGroups + keepLastCount);
  }

  const hardProtectedGroups = preservedGroupCount(groups, protectedPrefix);
  await removeGroupsUntilFit(hardProtectedGroups, hardProtectedGroups + keepLastCount);

  messages.length = 0;
  messages.push(...groups.flat());

  if (currentTokens > maxPromptTokens) {
    throw new ContextOverflowError(
      `Conversation exceeds the context window (Stop At Limit). counted ${currentTokens} tokens against a ${maxPromptTokens} token prompt budget.`,
    );
  }

  return messages;
}
