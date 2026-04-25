/**
 * @packageDocumentation
 * Strategies for handling context window overflow by truncating or sliding message history.
 */

import type { ChatMessage } from "@shared/types.js";

const tokenCountCache = new Map<string, number>();
const DEFAULT_CTX_SIZE = 4096;
const DEFAULT_RESERVED_TOKENS = 512;
const MIN_RESERVED_TOKENS = 128;

function normalizeCtxSize(ctxSize: number): number {
  return Number.isFinite(ctxSize) && ctxSize > 0 ? Math.floor(ctxSize) : DEFAULT_CTX_SIZE;
}

function normalizeMaxTokens(maxTokens: number): number {
  return Number.isFinite(maxTokens) && maxTokens > 0
    ? Math.floor(maxTokens)
    : DEFAULT_RESERVED_TOKENS;
}

function buildMessageKey(message: ChatMessage): string {
  const attachments = (message.attachments || []).map((a) => `${a.mimeType}`).join("|");
  return `${message.role}:${message.content}:${attachments}`;
}

function buildMessagesKey(messages: ChatMessage[], port?: number): string {
  return `${messages.map((m) => buildMessageKey(m)).join("||")}|port:${port ?? 0}`;
}

async function fetchTokenCount(text: string, port?: number): Promise<number> {
  if (!port) return Math.ceil(text.length / 3.5);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) return Math.ceil(text.length / 3.5);
    const data: any = await res.json();
    if (Array.isArray(data.tokens)) return data.tokens.length;
  } catch {
    // Fallback to heuristic token count
  }
  return Math.ceil(text.length / 3.5);
}

/**
 * Calculates current token usage for a list of messages.
 */
export async function getTokens(msgs: ChatMessage[], port?: number): Promise<number> {
  const cacheKey = buildMessagesKey(msgs, port);
  const cached = tokenCountCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let contentTokens = 0;
  for (const message of msgs) {
    contentTokens += await fetchTokenCount(message.content, port);
  }

  let attachmentTokens = 0;
  for (const message of msgs) {
    if (!message.attachments) continue;
    for (const attachment of message.attachments) {
      if (attachment.mimeType.startsWith("image/")) {
        attachmentTokens += 560;
      } else if (attachment.mimeType.startsWith("audio/")) {
        attachmentTokens += 256;
      }
    }
  }

  const total = contentTokens + attachmentTokens;
  tokenCountCache.set(cacheKey, total);
  if (tokenCountCache.size > 500) {
    tokenCountCache.clear();
  }
  return total;
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return { ...message, attachments: message.attachments ? [...message.attachments] : undefined };
}

function getReservedTokens(maxTokens: number): number {
  return Math.max(MIN_RESERVED_TOKENS, normalizeMaxTokens(maxTokens));
}

function getProtectedPrefixLength(messages: ChatMessage[], roleSystemPrompt: boolean): number {
  let protectedCount = 0;
  if (roleSystemPrompt && messages.length > 0 && messages[0].role === "system") {
    protectedCount = 1;
  }
  return protectedCount;
}

/**
 * Truncates message history based on context overflow policies.
 */
export async function truncateMessages(
  rawMessages: ChatMessage[],
  overflowPolicy: "StopAtLimit" | "TruncateMiddle" | "RollingWindow",
  ctxSize: number,
  maxTokens: number,
  port?: number,
  roleSystemPrompt: boolean = true,
): Promise<ChatMessage[]> {
  if (overflowPolicy === "StopAtLimit") return rawMessages;

  const messages = [...rawMessages].map(cloneMessage);
  const normalizedCtxSize = normalizeCtxSize(ctxSize);
  const reservedTokens = getReservedTokens(maxTokens);
  const maxPromptTokens = normalizedCtxSize - reservedTokens;
  if (maxPromptTokens <= 0) return messages;

  const getMessageTokens = async (message: ChatMessage) => {
    return await getTokens([message], port);
  };

  let currentTokens = await getTokens(messages, port);
  if (currentTokens <= maxPromptTokens) return messages;

  const protectedPrefix = getProtectedPrefixLength(messages, roleSystemPrompt);
  const keepLastCount = 1;

  if (overflowPolicy === "TruncateMiddle") {
    const firstUserIndex = messages.findIndex(
      (m, idx) => idx >= protectedPrefix && m.role === "user",
    );
    const preserveUntil = firstUserIndex !== -1 ? firstUserIndex + 1 : protectedPrefix;
    while (currentTokens > maxPromptTokens && messages.length > preserveUntil + keepLastCount) {
      const removed = messages.splice(preserveUntil, 1)[0];
      currentTokens -= await getMessageTokens(removed);
    }
  } else {
    while (currentTokens > maxPromptTokens && messages.length > protectedPrefix + keepLastCount) {
      const removed = messages.splice(protectedPrefix, 1)[0];
      currentTokens -= await getMessageTokens(removed);
    }
  }

  const hardProtectedIndex = protectedPrefix;
  while (currentTokens > maxPromptTokens && messages.length > hardProtectedIndex + keepLastCount) {
    const removed = messages.splice(hardProtectedIndex, 1)[0];
    currentTokens -= await getMessageTokens(removed);
  }

  if (currentTokens > maxPromptTokens && messages.length > 0) {
    const last = { ...messages[messages.length - 1] };
    const lastTokens = await getMessageTokens(last);
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
