/**
 * @packageDocumentation
 * Strategies for handling context window overflow by truncating or sliding message history.
 */

import type { ChatMessage } from "../shared/types";
import { parseToolCallsJson } from "../shared/toolCalls";

const tokenCountCache = new Map<string, number>();
/** Increments whenever the loaded tokenizer may have changed. */
let tokenizerEpoch = 0;
/** Characters per token observed from the latest exact `/tokenize` result. */
let calibratedCharsPerToken = 3.5;
/** Tokenizer epoch that {@link calibratedCharsPerToken} belongs to. */
let calibratedCharsPerTokenEpoch = -1;

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
  calibratedCharsPerToken = 3.5;
  calibratedCharsPerTokenEpoch = tokenizerEpoch;
}

/**
 * Returns the characters-per-token ratio for the active tokenizer.
 *
 * The ratio starts at 3.5 and is replaced by `text.length / tokens` after each
 * exact `/tokenize` result. A model change resets it.
 *
 * @returns Characters represented by one token.
 */
function currentCharsPerToken(): number {
  if (calibratedCharsPerTokenEpoch !== tokenizerEpoch) {
    calibratedCharsPerTokenEpoch = tokenizerEpoch;
    calibratedCharsPerToken = 3.5;
  }
  return calibratedCharsPerToken;
}

/**
 * Records the characters-per-token ratio from an exact token count.
 *
 * @param text - Text that was tokenized.
 * @param tokens - Token count returned by `/tokenize`.
 * @returns No return value.
 */
function observeExactTokenCount(text: string, tokens: number): void {
  if (text.length === 0 || tokens <= 0) return;
  calibratedCharsPerTokenEpoch = tokenizerEpoch;
  calibratedCharsPerToken = text.length / tokens;
}

/**
 * Estimates tokens from text length using the calibrated ratio.
 *
 * @param text - Text to estimate.
 * @returns A non-negative token estimate.
 */
function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / currentCharsPerToken());
}

/**
 * Estimates the tokens in one atomic message group from text length and media budgets.
 *
 * @param group - Messages that must be kept or dropped together.
 * @returns Estimated tokens for the group.
 */
function estimateGroupTokens(group: readonly ChatMessage[]): number {
  let tokens = 0;
  for (const message of group) {
    tokens += estimateTextTokens(`${message.role}\n${message.content}`);
    tokens += estimateAttachmentMediaTokens([message]);
  }
  return tokens;
}
const DEFAULT_CTX_SIZE = 4096;
const DEFAULT_RESERVED_TOKENS = 512;
const MIN_RESERVED_TOKENS = 128;

export interface TokenEstimationOptions {
  /** Optional builder for a serialized prompt payload matching the real request shape. */
  buildPromptText?: ((messages: ChatMessage[]) => Promise<string>) | undefined;
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
 * Builds a cache key for a single message tokenization input.
 *
 * @param message - Chat message contributing to the prompt.
 * @returns A cache key that uniquely identifies the message content and attachment types.
 */
function buildMessageKey(message: ChatMessage): string {
  // M1 fix: include message ID to prevent key collisions across different message sets
  const attachments = (message.attachments || []).map((a) => `${a.mimeType}`).join("|");
  return `${message.id ?? "_"}:${message.role}:${message.content}:${attachments}`;
}

/**
 * Builds a cache key for an ordered message list.
 *
 * @param messages - Prompt messages whose token count should be cached.
 * @param port - Optional llama-server port used for tokenization.
 * @returns A cache key representing the full message array.
 */
function buildMessagesKey(messages: ChatMessage[], port?: number): string {
  const material = `${messages.length}|${messages.map((message) => buildMessageKey(message)).join("||")}|port:${port ?? 0}`;
  return `msgs:${String(Bun.hash(material))}`;
}

/**
 * Builds a cache key for a fully serialized prompt payload.
 *
 * @param serializedPrompt - Prompt body sent to the tokenizer.
 * @param port - Optional llama-server port used for tokenization.
 * @returns A cache key for prompt-level token counts.
 */
function buildSerializedPromptKey(serializedPrompt: string, port?: number): string {
  return `payload:${port ?? 0}:${String(Bun.hash(serializedPrompt))}`;
}

/**
 * Serializes a message list into a stable text payload for heuristic token counting.
 *
 * @param messages - Prompt messages to serialize.
 * @returns JSON text representing the message content relevant to prompt budgeting.
 */
function serializeMessagesForPromptBudget(messages: ChatMessage[]): string {
  return JSON.stringify(
    messages.map((message) => ({
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolCallsJson: message.toolCallsJson,
    })),
  );
}

/**
 * Estimates the fixed token overhead contributed by image and audio attachments.
 *
 * @param messages - Prompt messages whose attachments should be counted.
 * @returns Estimated attachment token overhead.
 */
function estimateAttachmentMediaTokens(messages: ChatMessage[]): number {
  let attachmentTokens = 0;
  for (const message of messages) {
    if (!message.attachments) continue;
    for (const attachment of message.attachments) {
      if (attachment.mimeType.startsWith("image/")) {
        attachmentTokens += 560;
      } else if (attachment.mimeType.startsWith("audio/")) {
        attachmentTokens += 256;
      } else if (attachment.mimeType.startsWith("video/")) {
        attachmentTokens += 1024;
      }
    }
  }
  return attachmentTokens;
}

/**
 * Fetches an exact or heuristic token count for arbitrary prompt text.
 *
 * @param text - Serialized prompt text to tokenize.
 * @param port - Optional llama-server port exposing the `/tokenize` endpoint.
 * @returns Token count for the serialized prompt text.
 */
async function fetchTokenCount(text: string, port?: number): Promise<number> {
  if (!port) return Math.ceil(text.length / 3.5);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) return Math.ceil(text.length / 3.5);
    const data: unknown = await res.json();
    if (
      data &&
      typeof data === "object" &&
      "tokens" in data &&
      Array.isArray((data as { tokens: unknown }).tokens)
    ) {
      const tokens = (data as { tokens: unknown[] }).tokens.length;
      observeExactTokenCount(text, tokens);
      return tokens;
    }
  } catch {
    // Fallback to heuristic token count
  }
  return Math.ceil(text.length / 3.5);
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
  if (options?.buildPromptText) {
    return getPromptTokens(msgs, port, options);
  }

  const cacheKey = buildMessagesKey(msgs, port);
  const cached = tokenCountCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const start = Date.now();
  const serializedPrompt = serializeMessagesForPromptBudget(msgs);
  const serializedCacheKey = buildSerializedPromptKey(serializedPrompt, port);
  const serializedCached = tokenCountCache.get(serializedCacheKey);
  const contentTokens =
    serializedCached !== undefined
      ? serializedCached
      : await fetchTokenCount(serializedPrompt, port);

  const duration = Date.now() - start;
  if (duration > 100) {
    const { logDebug } = await import("./logger");
    logDebug("Tokenization completed", {
      durationMs: duration,
      messageCount: msgs.length,
      totalTokens: contentTokens,
    });
  }

  const attachmentTokens = estimateAttachmentMediaTokens(msgs);

  const total = contentTokens + attachmentTokens;
  tokenCountCache.set(serializedCacheKey, contentTokens);
  tokenCountCache.set(cacheKey, total);
  // S7 fix: evict oldest 25% instead of clearing everything to prevent thrashing
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
 * Calculates token usage for a prompt using the exact serialized request payload when available.
 *
 * @param messages - Prompt messages to estimate.
 * @param port - Optional llama-server port used for exact tokenization.
 * @param options - Token estimation options containing the prompt serializer.
 * @returns Total estimated prompt tokens including attachment overhead.
 */
async function getPromptTokens(
  messages: ChatMessage[],
  port?: number,
  options?: TokenEstimationOptions,
): Promise<number> {
  if (!options?.buildPromptText) {
    return getTokens(messages, port);
  }

  const serializedPrompt = await options.buildPromptText(messages);
  const serializedCacheKey = buildSerializedPromptKey(serializedPrompt, port);
  const cached = tokenCountCache.get(serializedCacheKey);
  const contentTokens =
    cached !== undefined ? cached : await fetchTokenCount(serializedPrompt, port);
  const total = contentTokens + estimateAttachmentMediaTokens(messages);

  tokenCountCache.set(serializedCacheKey, contentTokens);
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
  if (overflowPolicy === "StopAtLimit") {
    const reservedTokens = getReservedTokens(maxTokens);
    const maxPromptTokens = normalizeCtxSize(ctxSize) - reservedTokens;
    if (maxPromptTokens > 0) {
      const currentTokens = await getPromptTokens(rawMessages, port, tokenOptions);
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

  let currentTokens = await getPromptTokens(messages, port, tokenOptions);
  if (currentTokens <= maxPromptTokens) return messages;

  const protectedPrefix = getProtectedPrefixLength(messages, roleSystemPrompt);
  const keepLastCount = 1;
  const groups = groupMessagesAtomically(messages);

  const overheadTokens = tokenOptions?.buildPromptText
    ? estimateTextTokens(await tokenOptions.buildPromptText([]))
    : 0;
  const estimateScale = tokenOptions?.buildPromptText ? 1.25 : 1;

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
    return overheadTokens + Math.ceil((keptBefore + keptAfter) * estimateScale);
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

    let corrections = 0;
    currentTokens = await getPromptTokens(groups.flat(), port, tokenOptions);
    while (currentTokens > maxPromptTokens && corrections < 3) {
      const nextLastRemovable =
        keepLastCount > 0 ? Math.max(startGroupIndex, groups.length - 1) - 1 : groups.length - 1;
      const canDrop =
        startGroupIndex <= nextLastRemovable && groups.length - 1 >= minRemainingGroups;
      if (!canDrop || startGroupIndex >= groups.length) break;
      groups.splice(startGroupIndex, 1);
      corrections += 1;
      currentTokens = await getPromptTokens(groups.flat(), port, tokenOptions);
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

  const lastMessage = messages.at(-1);
  if (currentTokens > maxPromptTokens && lastMessage) {
    const last = cloneMessage(lastMessage);
    const lastTokens = await getPromptTokens([last], port, tokenOptions);
    if (lastTokens > maxPromptTokens && last.content.length > 100) {
      const keepCount = Math.max(
        64,
        Math.floor((last.content.length * maxPromptTokens) / lastTokens),
      );
      last.content = `[TRUNCATED]\n...\n${last.content.substring(last.content.length - keepCount)}`;
      messages[messages.length - 1] = last;
    }
  }

  return messages;
}
