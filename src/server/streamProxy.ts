/**
 * @packageDocumentation
 * Proxies streaming inference from llama-server to clients over WebSocket.
 * Handles thinking tag splitting and prompt cache bookkeeping.
 */

import type { ChatMessage, MessageMetrics } from "../shared/types";
import { parseToolCallsJson } from "../shared/toolCalls";
import { triggerAutoname } from "./autoname";
import { detectThinkingConfig, parseThinkTags } from "./chatTemplateEngine";
import {
  getActiveThinkingTagOverride,
  getProc,
  getRecentServerLogs,
  getServerStatus,
} from "./llamaServer";
import { logDebug, logError, logInfo, logWarn } from "./logger";
import {
  mergeExtractedAttachmentText,
  processUpload,
  type ProcessedAttachment,
} from "./multimodal";
import { addMessage, getChat, getNextPosition, updateChat } from "./persistence/chatRepo";
import { getInferencePresets, getSystemPresets } from "./persistence/presetRepo";
import { loadSettings } from "./persistence/settingsRepo";
import { updatePromptCacheStats } from "./promptCache";
import { broadcast } from "./wsHub";
import { truncateMessages, getTokens } from "./overflow";
import { cancelPendingApprovals } from "./tools";
import { getMetadataForPath } from "./persistence/chatRepo";
import { getDb } from "./persistence/db";

type GenerationSession = {
  chatId: string;
  controller: AbortController;
  messageId: string;
  startedAt: number;
};

const MAX_TOOL_RECURSION_DEPTH = 5;

type ChatCompletionMessage = {
  role: string;
  content: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
};

type ChatCompletionRequestBody = {
  stream: boolean;
  cache_prompt: boolean;
  temperature: number;
  top_k: number;
  top_p: number;
  min_p: number;
  typical_p: number;
  repeat_penalty: number;
  repeat_last_n: number;
  presence_penalty: number;
  frequency_penalty: number;
  mirostat: 0 | 1 | 2;
  mirostat_tau: number;
  mirostat_eta: number;
  dynatemp_range: number;
  dynatemp_exponent: number;
  dry_multiplier: number;
  dry_base: number;
  dry_allowed_length: number;
  dry_penalty_last_n: number;
  dry_sequence_breakers: string[];
  xtc_probability: number;
  xtc_threshold: number;
  seed?: number | undefined;
  n_predict: number;
  stop: string[];
  messages: ChatCompletionMessage[];
  tools?: { type: "function"; function: unknown }[];
  response_format?: {
    type: "json_schema";
    json_schema: Record<string, unknown>;
  };
  chat_template_kwargs?: { enable_thinking: true; preserve_thinking?: boolean };
  reasoning_format?: "none";
};

const activeGenerations = new Map<string, GenerationSession>();

/**
 * Converts raw llama.cpp timing metrics into the message metrics stored on assistant turns.
 *
 * @param timings - Timing payload reported by llama-server.
 * @param promptTokensCount - Prompt token count used for the generation request.
 * @returns Message-level metrics suitable for persistence and UI display.
 */
function buildMessageMetrics(
  timings: import("../shared/types").LlamaTimings,
  promptTokensCount: number,
): MessageMetrics {
  return {
    predictedTokens: timings.predicted_n || 0,
    tokensPerSecond: timings.predicted_per_second || 0,
    promptTokens: promptTokensCount,
    promptTokensPerSecond: timings.prompt_per_second || 0,
    cachedPromptTokens: timings.tokens_cached || 0,
    evaluatedPromptTokens: timings.tokens_evaluated || 0,
  };
}

/**
 * Logs a structured stream-proxy failure with optional contextual metadata.
 *
 * @param context - High-level stage where the error occurred.
 * @param err - Underlying error or failure payload.
 * @param details - Optional structured metadata describing the failed operation.
 * @returns No return value.
 */
function logStreamProxyError(context: string, err: unknown, details?: Record<string, unknown>) {
  logError(
    "[streamProxy] Error in",
    context,
    details ? JSON.stringify(details) : undefined,
    err instanceof Error ? err.stack || err.message : err,
  );
}

/**
 * Captures the current llama-server process state so transport failures can be tied to
 * an exited process or the latest server-side stderr/stdout lines.
 *
 * @returns Structured diagnostics describing the active model process at failure time.
 */
function getModelFailureContext(): {
  serverStatus: ReturnType<typeof getServerStatus>["status"];
  serverPort: number | null;
  modelPath: string | null;
  processExitCode: number | null;
  recentServerLogs: string[];
} {
  const server = getServerStatus();
  const proc = getProc();

  return {
    serverStatus: server.status,
    serverPort: server.port ?? null,
    modelPath: server.config?.modelPath ?? null,
    processExitCode: proc?.exitCode ?? null,
    recentServerLogs: getRecentServerLogs(20),
  };
}

/**
 * Formats a user-visible transport failure message with model-process context when available.
 *
 * @param err - Underlying transport error.
 * @param failureContext - Captured llama-server process diagnostics.
 * @returns Concise error text suitable for the websocket error frame.
 */
function formatTransportErrorMessage(
  err: unknown,
  failureContext: ReturnType<typeof getModelFailureContext>,
): string {
  const parts = [String(err)];

  if (failureContext.processExitCode !== null) {
    parts.push(`llama-server exited with code ${failureContext.processExitCode}.`);
  } else if (failureContext.serverStatus !== "running") {
    parts.push(`llama-server status is ${failureContext.serverStatus}.`);
  }

  const lastServerLog = failureContext.recentServerLogs.at(-1);
  if (lastServerLog) {
    parts.push(`Last server log: ${lastServerLog}`);
  }

  return parts.join(" ");
}

/**
 * Terminate an active generation.
 *
 * @param idOrChatId - The generation session ID or chat ID.
 * @returns No return value.
 */
export function abortGeneration(idOrChatId: string) {
  const exact = activeGenerations.get(idOrChatId);
  if (exact) {
    exact.controller.abort();
    cancelPendingApprovals(exact.chatId, "cancelled");
    activeGenerations.delete(idOrChatId);
    return;
  }

  for (const [id, session] of activeGenerations.entries()) {
    if (session.chatId === idOrChatId) {
      session.controller.abort();
      cancelPendingApprovals(session.chatId, "cancelled");
      activeGenerations.delete(id);
    }
  }
}

/**
 * Maps a tool-approval cancellation reason to a user-facing assistant message.
 *
 * @param reason - Tool approval termination reason returned by the approval subsystem.
 * @returns Human-readable text describing why tool execution could not continue.
 */
function getToolApprovalFailureMessage(reason?: string): string {
  if (reason === "timeout") return "Tool approval timed out.";
  if (reason === "disconnected") return "Tool approval cancelled because the client disconnected.";
  if (reason === "unloaded") return "Tool approval cancelled because the model was unloaded.";
  if (reason === "cancelled") return "Tool approval cancelled.";
  return "Tool approval rejected.";
}

/**
 * Returns the set of chat IDs that currently have active generations in progress.
 * Used by cleanup.ts to avoid deleting attachment files that may be actively read.
 *
 * @returns A set containing the chat IDs of all active generations.
 */
export function getActiveGenerationChatIds(): Set<string> {
  const chatIds = new Set<string>();
  for (const session of activeGenerations.values()) {
    chatIds.add(session.chatId);
  }
  return chatIds;
}

/**
 * Defines the parameters for proxying completion requests against the backend server.
 */
export interface ProxyCompletionParams {
  /** Chat session identifier for the completion request. */
  chatId: string;
  /** User content to send to the backend as the new message. */
  content: string;
  /** Files attached to the completion request. */
  attachments: File[];
  /** Whether this request should continue the last assistant response. */
  isContinue?: boolean;
  /** Whether this request should recursively re-run the same prompt context. */
  isRecursive?: boolean;
  /** Whether this request should regenerate the current assistant message. */
  isRegenerate?: boolean;
  /** Whether this request is triggered from an internal tool call recursion. */
  isToolRecurse?: boolean;
  /** The current depth of internal tool-call recursion for this request chain. */
  toolRecursionDepth?: number;
}

/**
 * Proxies a completion request to the llama-server and broadcasts results over WebSocket.
 *
 * @param params - Configuration for the request, including message content and attachments.
 * @returns The UUID of the assistant message being generated.
 * @throws {Error} If the server is not running or the chat is not found.
 */
export async function proxyCompletion(params: ProxyCompletionParams): Promise<string> {
  const {
    chatId,
    content: newMessage,
    attachments,
    isContinue = false,
    isRegenerate = false,
    isToolRecurse = false,
    toolRecursionDepth = 0,
  } = params;

  if (!isToolRecurse) {
    for (const [id, session] of activeGenerations.entries()) {
      if (session.chatId === chatId) {
        session.controller.abort();
        activeGenerations.delete(id);
      }
    }
  }

  const server = getServerStatus();
  logDebug("Starting proxyCompletion", {
    chatId,
    isContinue,
    isRegenerate,
    serverStatus: server.status,
  });

  if (server.status !== "running" || !server.port) {
    logWarn("proxyCompletion blocked: server is not running");
    throw new Error("Llama-server is not running.");
  }

  const chat = await getChat(chatId);
  if (!chat) {
    logError("proxyCompletion failed: chat not found", chatId);
    throw new Error("Chat not found");
  }

  const lastMessage = chat.messages?.[chat.messages.length - 1];
  if (isContinue) {
    if (!lastMessage) {
      throw new Error("Cannot continue because there is no last message.");
    }
    if (lastMessage.role !== "assistant" && lastMessage.role !== "tool") {
      throw new Error(
        "Cannot continue because the last message is not an assistant or tool response.",
      );
    }
  }
  const assistantMessageId = isContinue && lastMessage ? lastMessage.id : Bun.randomUUIDv7();
  const userMessageId = Bun.randomUUIDv7();
  const [sysPresets, infPresets] = await Promise.all([getSystemPresets(), getInferencePresets()]);

  const sysPreset = sysPresets.find((p) => p.id === chat.systemPresetId);
  const infPreset = infPresets.find((p) => p.id === chat.inferencePresetId) || infPresets[0];

  const processedAttachments: ProcessedAttachment[] = [];
  let userMsg: ChatMessage | null = null;
  let userMessageInserted = false;

  if (!isContinue && !isRegenerate && !isToolRecurse) {
    userMsg = {
      id: userMessageId,
      chatId,
      role: "user",
      content: newMessage,
      rawContent: newMessage,
      position: getNextPosition(chatId),
      createdAt: Date.now(),
    };
    await addMessage(userMsg);
    userMessageInserted = true;
  }

  try {
    for (const file of attachments) {
      const arr = await file.arrayBuffer();
      processedAttachments.push(
        await processUpload(chatId, userMessageId, file.name, file.type, arr),
      );
    }
  } catch (err) {
    if (userMessageInserted) {
      const db = await import("./persistence/db").then((m) => m.getDb());
      db.prepare("DELETE FROM attachments WHERE message_id = ?").run(userMessageId);
      db.prepare("DELETE FROM messages WHERE id = ?").run(userMessageId);
      logError(
        "[streamProxy] Rolled back partially created user message after attachment processing failed",
        {
          chatId,
          userMessageId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
    throw err;
  }

  // Construct message content parts
  const dbContent = mergeExtractedAttachmentText(newMessage, processedAttachments);

  const modelMeta = server.config?.modelPath
    ? await getMetadataForPath(server.config.modelPath)
    : null;
  const thinkingConfig = detectThinkingConfig(
    modelMeta?.architecture,
    getActiveThinkingTagOverride(),
  );
  const thinkingEnabled = infPreset?.thinkingEnabled ?? true;

  let rawMessages: ChatMessage[] = [];

  let sysContent = sysPreset?.content || "";
  if (thinkingEnabled && thinkingConfig.enableToken) {
    sysContent = sysContent
      ? `${sysContent}\n\n${thinkingConfig.enableToken}`
      : thinkingConfig.enableToken;
  }

  if (sysContent) {
    rawMessages.push({
      id: "sys",
      chatId,
      role: "system",
      content: sysContent,
      rawContent: sysContent,
      position: 0,
      createdAt: Date.now(),
    });
  }

  rawMessages.push(...(chat.messages || []));

  if (!isContinue && !isRegenerate && !isToolRecurse) {
    if (userMsg) {
      userMsg.content = dbContent;
      userMsg.rawContent = dbContent;
      userMsg.attachments = processedAttachments;
      rawMessages.push(userMsg);

      const db = getDb();
      db.prepare("UPDATE messages SET content = ?, raw_content = ? WHERE id = ?").run(
        dbContent,
        dbContent,
        userMessageId,
      );

      // Reconcile optimistic client-side temp IDs with the persisted user message ID.
      broadcast({ type: "message", chatId, message: userMsg });
    } else {
      const userMsgFinal: ChatMessage = {
        id: userMessageId,
        chatId,
        role: "user",
        content: dbContent,
        rawContent: dbContent,
        position: rawMessages.length,
        createdAt: Date.now(),
        attachments: processedAttachments,
      };
      rawMessages.push(userMsgFinal);
      await addMessage(userMsgFinal);
      broadcast({ type: "message", chatId, message: userMsgFinal });
    }
  }

  // --- Overflow Policy Truncation ---
  // C7 fix: guard against infPreset being undefined (edge case after data wipe)
  const safeInfPreset = infPreset ?? {
    maxTokens: -1,
    contextOverflowPolicy: "TruncateMiddle" as const,
    temperature: 0.8,
    topK: 40,
    topP: 0.95,
    minP: 0.05,
    stopStrings: [] as string[],
  };
  const overflowPolicy = safeInfPreset?.contextOverflowPolicy || "TruncateMiddle";
  const ctxSize = server.config?.contextSize || 4096;
  const useTools = infPreset?.toolCallsEnabled && infPreset.tools && infPreset.tools.length > 0;
  const requestTools = useTools
    ? infPreset.tools.map((t) => ({
        type: "function" as const,
        function: t,
      }))
    : undefined;
  const requestResponseFormat =
    infPreset?.structuredOutput?.enabled && infPreset.structuredOutput.schema
      ? {
          type: "json_schema" as const,
          json_schema: infPreset.structuredOutput.schema,
        }
      : undefined;
  const requestThinkingConfig =
    (infPreset?.thinkingEnabled ?? true)
      ? {
          chat_template_kwargs: {
            enable_thinking: true as const,
            preserve_thinking: infPreset?.preserveThinking ?? false,
          },
          reasoning_format: "none" as const,
        }
      : undefined;
  const { buildContentParts } = await import("./multimodal");

  /**
   * Converts persisted chat messages into the OpenAI-compatible message payload sent to llama-server.
   *
   * @param messages - Chat history after overflow handling.
   * @returns OpenAI-style chat completion messages.
   */
  const buildApiMessages = async (messages: ChatMessage[]): Promise<ChatCompletionMessage[]> => {
    const apiMessages: ChatCompletionMessage[] = [];

    for (const m of messages) {
      const mediaAtts =
        m.attachments?.filter(
          (a) =>
            a.mimeType.startsWith("image/") ||
            a.mimeType.startsWith("audio/") ||
            a.mimeType.startsWith("video/"),
        ) || [];

      const hasMediaAttachments = mediaAtts.length > 0;
      const contentParts = hasMediaAttachments
        ? await buildContentParts(m.content, m.attachments || [], modelMeta || undefined)
        : m.content;

      let finalContent = contentParts;

      const hasUnsupportedMedia = mediaAtts.some((a) => {
        if (a.mimeType.startsWith("image/") && !modelMeta?.hasVisionEncoder) return true;
        if (a.mimeType.startsWith("audio/") && !modelMeta?.hasAudioEncoder) return true;
        if (a.mimeType.startsWith("video/") && !modelMeta?.hasVisionEncoder) return true;
        return false;
      });

      if (hasUnsupportedMedia) {
        const warning =
          "[System info: Some multimodal attachments were removed because the current active model lacks encoders for them.]\n";
        if (typeof finalContent === "string") {
          finalContent = warning + finalContent;
        } else if (Array.isArray(finalContent)) {
          const textPart = finalContent.find((p) => p.type === "text");
          if (textPart) {
            textPart.text = warning + textPart.text;
          } else {
            finalContent.push({ type: "text", text: warning });
          }
        }
      }

      const apiMsg: ChatCompletionMessage = { role: m.role, content: finalContent };

      // Include previous thinking content in history when preserve_thinking is enabled
      if (
        m.role === "assistant" &&
        requestThinkingConfig?.chat_template_kwargs?.preserve_thinking &&
        m.thinkingContent
      ) {
        apiMsg.reasoning_content = m.thinkingContent;
      }

      const parsedToolCalls = parseToolCallsJson(m.toolCallsJson);
      if (parsedToolCalls) {
        apiMsg.tool_calls = parsedToolCalls;
      }
      if (m.toolCallId) {
        apiMsg.tool_call_id = m.toolCallId;
        const assistantMsg = messages.find(
          (prev) =>
            prev.role === "assistant" &&
            parseToolCallsJson(prev.toolCallsJson)?.some((tc) => tc.id === m.toolCallId),
        );
        const tcs = parseToolCallsJson(assistantMsg?.toolCallsJson);
        if (tcs) {
          const matchingTc = tcs.find((tc: { id: string }) => tc.id === m.toolCallId);
          if (matchingTc) apiMsg.name = matchingTc.function.name;
        }
      }
      apiMessages.push(apiMsg);
    }

    return apiMessages;
  };

  /**
   * Serializes the exact inference payload used for token-budget estimation.
   *
   * @param messages - Chat history after overflow handling.
   * @returns JSON text matching the request payload shape used for prompt tokenization.
   */
  const buildPromptText = async (messages: ChatMessage[]): Promise<string> =>
    JSON.stringify({
      messages: await buildApiMessages(messages),
      ...(requestTools ? { tools: requestTools } : {}),
      ...(requestResponseFormat ? { response_format: requestResponseFormat } : {}),
      ...(requestThinkingConfig ?? {}),
    });

  logDebug("Truncating message history", { ctxSize, overflowPolicy });
  rawMessages = await truncateMessages(
    rawMessages,
    overflowPolicy,
    ctxSize,
    safeInfPreset.maxTokens || 4096,
    server.port,
    true,
    { buildPromptText },
  );
  logDebug("Calculating prompt token count");
  const promptTokensCount = await getTokens(rawMessages, server.port, { buildPromptText });
  logInfo("Prompt prepared", { tokens: promptTokensCount, model: server.config?.modelPath });
  // --- End Overflow Policy ---
  // Always use /v1/chat/completions — llama-server is launched with --jinja
  // and handles chat template rendering natively. The old /completion fallback
  // used a broken "{{ messages }}" Jinja template that serialized the messages
  // array as raw JSON, producing garbage output.

  const requestBody: ChatCompletionRequestBody = {
    stream: true,
    cache_prompt: true,
    temperature: infPreset?.temperature ?? 0.8,
    top_k: infPreset?.topK ?? 40,
    top_p: infPreset?.topP ?? 0.95,
    min_p: infPreset?.minP ?? 0.05,
    typical_p: infPreset?.typicalP ?? 1.0,

    repeat_penalty: infPreset?.repeatPenalty ?? 1.1,
    repeat_last_n: infPreset?.repeatLastN ?? 64,
    presence_penalty: infPreset?.presencePenalty ?? 0.0,
    frequency_penalty: infPreset?.frequencyPenalty ?? 0.0,
    mirostat: infPreset?.mirostat ?? 0,
    mirostat_tau: infPreset?.mirostatTau ?? 5.0,
    mirostat_eta: infPreset?.mirostatEta ?? 0.1,
    dynatemp_range: infPreset?.dynaTempRange ?? 0.0,
    dynatemp_exponent: infPreset?.dynaTempExponent ?? 1.0,
    dry_multiplier: infPreset?.dryMultiplier ?? 0.0,
    dry_base: infPreset?.dryBase ?? 1.75,
    dry_allowed_length: infPreset?.dryAllowedLength ?? 2,
    dry_penalty_last_n: infPreset?.dryPenaltyLastN ?? 64,
    dry_sequence_breakers: infPreset?.drySequenceBreakers ?? ["\n", ":", '"', "*"],
    xtc_probability: infPreset?.xtcProbability ?? 0.0,
    xtc_threshold: infPreset?.xtcThreshold ?? 0.1,
    seed: infPreset?.seed !== undefined && infPreset.seed !== -1 ? infPreset.seed : undefined,
    n_predict: infPreset?.maxTokens ?? -1,
    stop: infPreset?.stopStrings ?? [],
    messages: await buildApiMessages(rawMessages),
  };

  if (requestTools) {
    requestBody.tools = requestTools;
  }

  if (requestResponseFormat) {
    requestBody.response_format = requestResponseFormat;
  }

  if (requestThinkingConfig) {
    requestBody.chat_template_kwargs = requestThinkingConfig.chat_template_kwargs;
    requestBody.reasoning_format = requestThinkingConfig.reasoning_format;
  }

  const endpoint = `http://127.0.0.1:${server.port}/v1/chat/completions`;
  logDebug("Constructed inference request", {
    endpoint,
    promptTokensCount,
    ctxSize,
    messagesCount: requestBody.messages.length,
  });

  const abortController = new AbortController();
  const generationId = Bun.randomUUIDv7();

  logInfo("Initiating model inference", {
    chatId,
    endpoint,
    messages: requestBody.messages.length,
    maxTokens: requestBody.n_predict,
    thinking: requestBody.chat_template_kwargs?.enable_thinking,
  });

  activeGenerations.set(generationId, {
    chatId,
    controller: abortController,
    messageId: assistantMessageId,
    startedAt: Date.now(),
  });

  const settings = await loadSettings();
  const timeoutMs = (settings.requestTimeoutSeconds || 60) * 1000;
  let inactivityTimer: ReturnType<typeof setTimeout>;

  /**
   * Rearms the inactivity timeout that protects long-running streaming generations.
   *
   * @returns No return value.
   */
  const resetInactivityTimer = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      logWarn(`Generation timeout for chat ${chatId} (${timeoutMs}ms)`);
      abortGeneration(chatId);
    }, timeoutMs);
  };

  resetInactivityTimer();

  if (!isContinue) {
    const db = await import("./persistence/db").then((m) => m.getDb());
    db.prepare(
      `
        INSERT INTO messages (id, chat_id, role, content, raw_content, thinking_content, position, created_at, tool_call_id, tool_calls_json, metrics_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     `,
    ).run(
      assistantMessageId,
      chatId,
      "assistant",
      "",
      "",
      null,
      getNextPosition(chatId),
      Date.now(),
      null,
      null,
      null,
    );
  }

  /**
   * Removes the placeholder assistant row when generation fails before any content is written.
   *
   * @returns No return value.
   */
  const cleanupEmptyAssistantMessage = () => {
    if (isContinue) return;

    try {
      const row = getDb()
        .query<{ content: string }, [string]>("SELECT content FROM messages WHERE id = ?")
        .get(assistantMessageId);
      if (row && row.content.length === 0) {
        getDb().prepare("DELETE FROM messages WHERE id = ?").run(assistantMessageId);
      }
    } catch (cleanupErr) {
      logError("[streamProxy] Failed to clean up orphaned assistant message", cleanupErr);
    }
  };

  fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
    signal: abortController.signal,
  })
    .then(async (res) => {
      // Keep the timeout armed between response headers and the first SSE chunk.
      resetInactivityTimer();
      logDebug("Model server response received", { status: res.status });
      if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        const err = new Error(
          `Model server request failed: ${res.status}${errorBody ? `: ${errorBody}` : ""}`,
        );
        logStreamProxyError("fetch-response", err, {
          endpoint,
          chatId,
          assistantMessageId,
          generationId,
          responseStatus: res.status,
          responseBody: errorBody,
        });
        throw err;
      }
      if (!res.body) {
        const err = new Error("Model server returned an empty response stream.");
        logStreamProxyError("fetch-empty-body", err, {
          endpoint,
          chatId,
          assistantMessageId,
          generationId,
        });
        throw err;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      let fullRawContent = isContinue
        ? chat.messages?.[chat.messages.length - 1]?.rawContent || ""
        : "";
      let prevContent = isContinue ? chat.messages?.[chat.messages.length - 1]?.content || "" : "";
      let prevThinking = isContinue
        ? chat.messages?.[chat.messages.length - 1]?.thinkingContent || ""
        : "";

      const accumulatedToolCalls: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
        index?: number;
      }[] = [];
      let lastFlushTime = Date.now();
      let streamBuffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          clearTimeout(inactivityTimer);

          const chunk = value ? decoder.decode(value, { stream: true }) : "";
          streamBuffer += chunk;

          const lines = streamBuffer.split("\n");
          if (!done) {
            streamBuffer = lines.pop() || "";
          } else {
            streamBuffer = "";
          }

          let shouldStop = false;

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const dataStr = line.slice(6);
            if (dataStr === "[DONE]") continue;

            let parsed: {
              choices?: {
                delta?: {
                  content?: string;
                  tool_calls?: {
                    index: number;
                    id: string;
                    function: { name?: string; arguments?: string };
                  }[];
                };
                finish_reason?: string;
              }[];
              content?: string;
              stop?: boolean;
              timings?: import("../shared/types").LlamaTimings;
              stopped_limit?: boolean;
            };
            try {
              parsed = JSON.parse(dataStr);
            } catch {
              continue;
            }

            // Extract content delta from the OpenAI-style chat completions response
            const tcDelta = parsed.choices?.[0]?.delta?.tool_calls;
            if (tcDelta) {
              for (const tc of tcDelta) {
                const idx = tc.index ?? 0;
                if (!accumulatedToolCalls[idx]) {
                  accumulatedToolCalls[idx] = {
                    id: tc.id,
                    type: "function",
                    function: { name: "", arguments: "" },
                  };
                }
                if (tc.id) accumulatedToolCalls[idx].id = tc.id;
                if (tc.function?.name) accumulatedToolCalls[idx].function.name += tc.function.name;
                if (tc.function?.arguments)
                  accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
            const delta = parsed.choices?.[0]?.delta?.content || "";

            if (useTools && parsed.choices?.[0]?.finish_reason === "tool_calls") {
              const toolCalls = accumulatedToolCalls.filter(Boolean);
              broadcast({
                type: "tool_call",
                chatId,
                messageId: assistantMessageId,
                generationId,
                toolCalls,
              });

              const { waitForToolApproval, executeTool } = await import("./tools");
              // C1 fix: The assistant row was already INSERTed at line ~407.
              // Use UPDATE instead of a second INSERT to avoid PRIMARY KEY violation.
              const dbToolUpdate = await import("./persistence/db").then((m) => m.getDb());
              dbToolUpdate
                .prepare(
                  "UPDATE messages SET content = ?, raw_content = ?, thinking_content = ?, tool_calls_json = ? WHERE id = ?",
                )
                .run(
                  prevContent,
                  fullRawContent,
                  prevThinking || null,
                  JSON.stringify(toolCalls),
                  assistantMessageId,
                );

              broadcast({
                type: "tool_approval_state",
                chatId,
                messageId: assistantMessageId,
                generationId,
                pending: true,
                toolCallId: toolCalls[0]?.id,
                reason: "awaiting_user",
              });

              for (const tc of toolCalls) {
                const { approved, editedArguments, reason } = await waitForToolApproval(
                  chatId,
                  tc.id,
                );
                if (!approved) {
                  broadcast({
                    type: "tool_approval_state",
                    chatId,
                    messageId: assistantMessageId,
                    generationId,
                    pending: false,
                    resumeGeneration: false,
                    toolCallId: tc.id,
                    reason: reason ?? "rejected",
                  });
                  broadcast({
                    type: "error",
                    chatId,
                    messageId: assistantMessageId,
                    generationId,
                    message: getToolApprovalFailureMessage(reason),
                  });
                  broadcast({
                    type: "stop",
                    chatId,
                    messageId: assistantMessageId,
                    generationId,
                    stopReason: "error",
                    timings: parsed.timings || ({} as import("../shared/types").LlamaTimings),
                    fullContent: prevContent,
                    fullRawContent,
                    fullThinking: prevThinking,
                  });
                  shouldStop = true;
                  break;
                }

                if (tc === toolCalls[toolCalls.length - 1]) {
                  broadcast({
                    type: "tool_approval_state",
                    chatId,
                    messageId: assistantMessageId,
                    generationId,
                    pending: false,
                    resumeGeneration: true,
                    toolCallId: tc.id,
                    reason: "approved",
                  });
                }

                const toolResult = await executeTool(
                  tc.function.name,
                  editedArguments ?? tc.function.arguments,
                );
                const toolMsgId = Bun.randomUUIDv7();
                const toolMsg: ChatMessage = {
                  id: toolMsgId,
                  chatId,
                  role: "tool",
                  content: toolResult,
                  rawContent: toolResult,
                  position: getNextPosition(chatId),
                  createdAt: Date.now(),
                  toolCallId: tc.id,
                };
                await addMessage(toolMsg);
                broadcast({ type: "message", chatId, message: toolMsg });
              }

              if (!shouldStop) {
                const timings = parsed.timings || ({} as import("../shared/types").LlamaTimings);
                if (toolRecursionDepth >= MAX_TOOL_RECURSION_DEPTH) {
                  const recursionMessage = `Tool recursion limit (${MAX_TOOL_RECURSION_DEPTH}) reached for chat ${chatId}.`;
                  logWarn(recursionMessage);
                  broadcast({
                    type: "error",
                    chatId,
                    messageId: assistantMessageId,
                    generationId,
                    message: recursionMessage,
                  });
                  broadcast({
                    type: "stop",
                    chatId,
                    messageId: assistantMessageId,
                    generationId,
                    stopReason: "error",
                    timings,
                    fullContent: prevContent,
                    fullRawContent,
                    fullThinking: prevThinking,
                  });
                } else {
                  broadcast({
                    type: "stop",
                    chatId,
                    messageId: assistantMessageId,
                    generationId,
                    stopReason: "tool_calls",
                    timings,
                    fullContent: prevContent,
                    fullRawContent,
                    fullThinking: prevThinking,
                  });

                  const { proxyCompletion } = await import("./streamProxy");
                  await proxyCompletion({
                    chatId,
                    content: "",
                    attachments: [],
                    isToolRecurse: true,
                    isRecursive: true,
                    toolRecursionDepth: toolRecursionDepth + 1,
                  });
                }
              }

              shouldStop = true;
              break;
            }

            if (delta) {
              fullRawContent += delta;
              const parsedTags = parseThinkTags(
                fullRawContent,
                thinkingConfig.openTag,
                thinkingConfig.closeTag,
              );
              const contentDelta = parsedTags.content.substring(prevContent.length);
              const thinkingDelta = parsedTags.thinking.substring(prevThinking.length);
              prevContent = parsedTags.content;
              prevThinking = parsedTags.thinking;

              if (contentDelta || thinkingDelta) {
                broadcast({
                  type: "token",
                  chatId,
                  messageId: assistantMessageId,
                  generationId,
                  delta: contentDelta,
                  thinkingDelta: thinkingDelta || undefined,
                  promptTokens: promptTokensCount,
                  contextSize: ctxSize,
                });
              }

              if (Date.now() - lastFlushTime > 1000) {
                lastFlushTime = Date.now();
                const dbInstance = await import("./persistence/db").then((m) => m.getDb());
                dbInstance
                  .prepare(
                    "UPDATE messages SET content = ?, raw_content = ?, thinking_content = ? WHERE id = ?",
                  )
                  .run(prevContent, fullRawContent, prevThinking || null, assistantMessageId);
              }
            }

            // Detect stop condition from the chat completions response
            const finishReason = parsed.choices?.[0]?.finish_reason;
            if (finishReason) {
              const timings = parsed.timings || {
                tokens_cached: 0,
                tokens_evaluated: 0,
                predicted_ms: 0,
                predicted_n: 0,
                predicted_per_second: 0,
                predicted_per_token_ms: 0,
                prompt_ms: 0,
                prompt_n: 0,
                prompt_per_second: 0,
                prompt_per_token_ms: 0,
              };
              let stopReason: import("../shared/types").WsStopFrame["stopReason"] = "eos";
              if (finishReason === "length") stopReason = "max_tokens";
              if (finishReason === "tool_calls") stopReason = "tool_calls";

              if (
                stopReason === "max_tokens" &&
                infPreset?.contextOverflowPolicy === "StopAtLimit"
              ) {
                const ctxSize = server.config?.contextSize || 4096;
                if ((timings.predicted_n || 0) + (timings.prompt_n || 0) >= ctxSize - 16)
                  stopReason = "contextLengthReached";
              }

              updatePromptCacheStats(chatId, timings);
              const messageMetrics = buildMessageMetrics(timings, promptTokensCount);
              broadcast({
                type: "stop",
                chatId,
                messageId: assistantMessageId,
                generationId,
                stopReason,
                timings,
                promptTokens: promptTokensCount,
                contextSize: ctxSize,
                fullContent: prevContent,
                fullRawContent,
                fullThinking: prevThinking,
              });

              // C8 fix: explicitly pass updatedAt instead of relying on implicit empty-object behavior
              await updateChat(chatId, { updatedAt: Date.now() });
              const dbFinal = await import("./persistence/db").then((m) => m.getDb());
              dbFinal
                .prepare(
                  "UPDATE messages SET content = ?, raw_content = ?, thinking_content = ?, metrics_json = ? WHERE id = ?",
                )
                .run(
                  prevContent,
                  fullRawContent,
                  prevThinking || null,
                  JSON.stringify(messageMetrics),
                  assistantMessageId,
                );
              if (settings.autonameEnabled) await triggerAutoname(chatId);
              shouldStop = true;
              break;
            }
          }
          if (shouldStop || done) break;
          resetInactivityTimer();
        }
      } catch (err: any) {
        if (err.name === "AbortError" || abortController.signal.aborted) {
          const db = await import("./persistence/db").then((m) => m.getDb());
          db.prepare(
            "UPDATE messages SET content = ?, raw_content = ?, thinking_content = ? WHERE id = ?",
          ).run(prevContent, fullRawContent, prevThinking || null, assistantMessageId);
          cleanupEmptyAssistantMessage();
          logWarn("[streamProxy] Generation aborted by user or timeout", {
            chatId,
            assistantMessageId,
            generationId,
          });
          broadcast({
            type: "error",
            chatId,
            messageId: assistantMessageId,
            generationId,
            message: "Generation cancelled or timed out.",
          });
        } else {
          logStreamProxyError("stream-parse", err, {
            chatId,
            assistantMessageId,
            generationId,
          });
          cleanupEmptyAssistantMessage();
          broadcast({
            type: "error",
            chatId,
            messageId: assistantMessageId,
            generationId,
            message: String(err),
          });
        }
      } finally {
        clearTimeout(inactivityTimer);
        cancelPendingApprovals(chatId);
        activeGenerations.delete(generationId);
      }
    })
    .catch(async (err: any) => {
      clearTimeout(inactivityTimer);
      cancelPendingApprovals(chatId);
      activeGenerations.delete(generationId);
      const failureContext = getModelFailureContext();
      logStreamProxyError("fetch-catch", err, {
        endpoint,
        chatId,
        assistantMessageId,
        generationId,
        ...failureContext,
      });
      cleanupEmptyAssistantMessage();
      broadcast({
        type: "error",
        chatId,
        messageId: assistantMessageId,
        generationId,
        message: formatTransportErrorMessage(err, failureContext),
      });
    });

  return assistantMessageId;
}
