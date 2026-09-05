/**
 * @packageDocumentation
 * Proxies streaming inference from llama-server to clients over WebSocket.
 * Handles thinking tag splitting and prompt cache bookkeeping.
 */

import { createDefaultInferenceSampling } from "../shared/defaults";
import { isExtractedVideoAudioAttachment } from "../shared/extractedAudio";
import { buildMessageMetrics } from "../shared/generationMetrics";
import { resolveInferencePreset } from "../shared/inferencePresetResolve";
import { parseToolCallsJson, toApiToolCalls } from "../shared/toolCalls";
import { toStoredToolDefinition } from "../shared/toolModule";
import type { ChatMessage } from "../shared/types";
import { triggerAutoname } from "./autoname";
import {
  applyAssistantStreamDelta,
  type AssistantStreamState,
  detectThinkingConfig,
  inferNativeReasoningReuse,
  reconstructPreservedAssistantContent,
  shouldReconstructPreservedAssistantContent,
  shouldSendAssistantReasoningContent,
} from "./chatTemplateEngine";
import { getActiveGenerations } from "./generationRegistry";
import {
  getActiveThinkingTagOverride,
  getProc,
  getRecentServerLogs,
  getServerStatus,
} from "./llamaServer";
import { logDebug, logError, logInfo, logVerbose, logWarn } from "./logger";
import {
  mergeExtractedAttachmentText,
  type ProcessedAttachment,
  processUpload,
} from "./multimodal";
import { ContextOverflowError, getTokens, truncateMessages } from "./overflow";
import { addMessage, getChat, getMetadataForPath, updateChat } from "./persistence/chatRepo";
import { getDb } from "./persistence/db";
import { getInferencePresets, getLoadPresets, getSystemPresets } from "./persistence/presetRepo";
import { loadSettings } from "./persistence/settingsRepo";
import { updatePromptCacheStats } from "./promptCache";
import { listAvailableTools } from "./toolRegistry";
import { cancelPendingApprovals } from "./tools";
import { broadcast } from "./wsHub";

export { getActiveGenerationChatIds } from "./generationRegistry";

const activeGenerations = getActiveGenerations();
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
  chat_template_kwargs?: {
    enable_thinking: boolean;
    preserve_thinking?: boolean;
    enable_token?: string;
  };
  reasoning_format?: "none";
};

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
 * Summarizes a chat-completion `content` field as part types for logs.
 *
 * @param content - String body or OpenAI-style content-part array.
 * @returns `"text"` for a string body, or the ordered part `type` values.
 */
function summarizeContentPartTypes(content: unknown): string | string[] {
  if (typeof content === "string") return "text";
  if (!Array.isArray(content)) return [];
  return content.map((part) => {
    if (part && typeof part === "object" && "type" in part && typeof part.type === "string") {
      return part.type;
    }
    return "unknown";
  });
}

/**
 * Builds a per-message outline of the llama-server payload for verbose logs.
 * Each entry is one chat turn (system, user, assistant, or tool), not a growing bag of parts.
 *
 * @param messages - OpenAI-style messages about to be sent.
 * @returns Role plus content-part types for each message.
 */
function summarizeRequestMessages(
  messages: ChatCompletionMessage[],
): Array<{ role: string; content: string | string[] }> {
  return messages.map((message) => ({
    role: message.role,
    content: summarizeContentPartTypes(message.content),
  }));
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
 * Reads `preserve_thinking` from the load preset that produced the running model.
 *
 * This is a per-request Jinja kwarg, so the saved load preset is consulted on
 * each generation rather than being frozen at spawn time.
 *
 * @param presetId - Load-preset id stored on the running `ModelLoadConfig`.
 * @returns `true` when that load preset has preserve-thinking enabled.
 */
async function resolveLoadedPreserveThinking(presetId: string | undefined): Promise<boolean> {
  if (!presetId) return false;
  const presets = await getLoadPresets();
  return Boolean(presets.find((preset) => preset.id === presetId)?.preserveThinking);
}

/**
 * Replaces the textual portion of an OpenAI chat-completion `content` value.
 *
 * Multipart messages keep image/audio/video parts and only the `text` part is
 * updated. String content is replaced entirely.
 *
 * @param content - Current string or multipart content.
 * @param text - Replacement visible or tagged text.
 * @returns The same shape as `content`, with the text part updated.
 */
function replaceApiMessageText(content: unknown, text: string): unknown {
  if (!Array.isArray(content)) return text;
  let replaced = false;
  const next = content.map((part: unknown) => {
    if (
      part &&
      typeof part === "object" &&
      "type" in part &&
      (part as { type: unknown }).type === "text"
    ) {
      replaced = true;
      return { ...(part as object), text };
    }
    return part;
  });
  if (!replaced) next.push({ type: "text", text });
  return next;
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
  attachments?: File[];
  /** Whether this request should continue the last assistant response. */
  isContinue?: boolean;
  /** Whether this request should regenerate the current assistant message. */
  isRegenerate?: boolean;
  /** Whether this request is triggered from an internal tool call recursion. */
  isToolRecurse?: boolean;
  /** The current depth of internal tool-call recursion for this request chain. */
  toolRecursionDepth?: number;
  /**
   * Inference preset the client is currently displaying. Used when the chat row
   * has not yet persisted `inferencePresetId`.
   */
  inferencePresetId?: string | undefined;
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
    attachments = [],
    isContinue = false,
    isRegenerate = false,
    isToolRecurse = false,
    toolRecursionDepth = 0,
    inferencePresetId: requestedInferencePresetId,
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
  let reuseAssistantRow = false;
  if (isContinue) {
    if (!lastMessage) {
      throw new Error("Cannot continue because there is no last message.");
    }
    if (lastMessage.role === "assistant") {
      reuseAssistantRow = true;
    } else if (lastMessage.role === "tool") {
      // Continue must never overwrite a tool row. Append a new assistant turn instead.
      reuseAssistantRow = false;
    } else {
      throw new Error(
        "Cannot continue because the last message is not an assistant or tool response.",
      );
    }
  }
  const assistantMessageId = reuseAssistantRow && lastMessage ? lastMessage.id : Bun.randomUUIDv7();
  const userMessageId = Bun.randomUUIDv7();
  const abortController = new AbortController();
  const generationId = Bun.randomUUIDv7();
  activeGenerations.set(generationId, {
    chatId,
    controller: abortController,
    messageId: assistantMessageId,
    startedAt: Date.now(),
  });
  const [sysPresets, infPresets] = await Promise.all([getSystemPresets(), getInferencePresets()]);

  const sysPreset = sysPresets.find((p) => p.id === chat.systemPresetId);
  const infPreset = resolveInferencePreset(infPresets, {
    chatPresetId: chat.inferencePresetId,
    preferredPresetId: requestedInferencePresetId,
    modelPath: server.config?.modelPath ?? chat.modelPath,
  });
  if (infPreset && infPreset.id !== chat.inferencePresetId && !isToolRecurse) {
    await updateChat(chatId, { inferencePresetId: infPreset.id });
    chat.inferencePresetId = infPreset.id;
  }

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
      position: 0,
      createdAt: Date.now(),
    };
    await addMessage(userMsg);
    userMessageInserted = true;
  }

  try {
    for (const file of attachments) {
      if (abortController.signal.aborted) {
        throw new Error("Generation cancelled.");
      }
      const arr = await file.arrayBuffer();
      processedAttachments.push(
        await processUpload(chatId, userMessageId, file.name, file.type, arr),
      );
    }
  } catch (err) {
    activeGenerations.delete(generationId);
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

  if (abortController.signal.aborted) {
    activeGenerations.delete(generationId);
    if (userMessageInserted) {
      const db = getDb();
      db.prepare("DELETE FROM attachments WHERE message_id = ?").run(userMessageId);
      db.prepare("DELETE FROM messages WHERE id = ?").run(userMessageId);
    }
    throw new Error("Generation cancelled.");
  }

  // Construct message content parts
  const dbContent = mergeExtractedAttachmentText(newMessage, processedAttachments);

  const modelMeta = server.config?.modelPath
    ? await getMetadataForPath(server.config.modelPath)
    : null;
  const thinkingTagOverride = getActiveThinkingTagOverride();
  const thinkingConfig = detectThinkingConfig(modelMeta?.architecture, thinkingTagOverride);

  let rawMessages: ChatMessage[] = [];
  const sysContent = sysPreset?.content || "";

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
    }
  }

  // --- Overflow Policy Truncation ---
  // C7 fix: guard against infPreset being undefined (edge case after data wipe)
  const inferenceDefaults = createDefaultInferenceSampling();
  const safeInfPreset = infPreset ?? inferenceDefaults;
  const overflowPolicy = safeInfPreset.contextOverflowPolicy ?? "TruncateMiddle";
  const ctxSize = server.config?.contextSize || 4096;
  const useTools = infPreset?.toolCallsEnabled && infPreset.tools && infPreset.tools.length > 0;
  const liveTools = useTools
    ? new Map(
        (await listAvailableTools()).map(
          (tool) => [tool.name, toStoredToolDefinition(tool)] as const,
        ),
      )
    : undefined;
  const requestTools = useTools
    ? infPreset.tools.map((t) => ({
        type: "function" as const,
        function: liveTools?.get(t.name) ?? t,
      }))
    : undefined;
  const requestResponseFormat =
    infPreset?.structuredOutput?.enabled && infPreset.structuredOutput.schema
      ? {
          type: "json_schema" as const,
          json_schema: infPreset.structuredOutput.schema,
        }
      : undefined;
  const enableThinking = infPreset?.thinkingEnabled ?? true;
  const requestThinkingConfig = {
    chat_template_kwargs: {
      enable_thinking: enableThinking,
      preserve_thinking: await resolveLoadedPreserveThinking(server.config?.presetId),
      ...(thinkingTagOverride?.enableToken
        ? { enable_token: thinkingTagOverride.enableToken }
        : {}),
    },
    // Always `none` so llama-server streams tagged tokens in `delta.content`
    // instead of buffering the visible answer until native reasoning parsing
    // finishes. This process splits open/close tags as they arrive so the
    // reply can start streaming the moment thinking ends.
    reasoning_format: "none" as const,
  };
  const { buildContentParts } = await import("./multimodal");

  /**
   * Converts persisted chat messages into the OpenAI-compatible message payload sent to llama-server.
   *
   * @param messages - Chat history after overflow handling.
   * @returns OpenAI-style chat completion messages.
   */
  const buildApiMessages = async (messages: ChatMessage[]): Promise<ChatCompletionMessage[]> => {
    const apiMessages: ChatCompletionMessage[] = [];
    const preserveThinking = Boolean(requestThinkingConfig.chat_template_kwargs.preserve_thinking);
    let lastUserIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.role === "user") lastUserIdx = i;
    }

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const m = messages[messageIndex];
      if (!m) continue;
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

      let finalContent: unknown = contentParts;

      const parsedToolCalls = parseToolCallsJson(m.toolCallsJson);
      const sendReasoningContent =
        m.role === "assistant" &&
        Boolean(m.thinkingContent) &&
        shouldSendAssistantReasoningContent({
          messageIndex,
          lastUserIndex: lastUserIdx,
          preserveThinking,
          hasToolCalls: Boolean(parsedToolCalls),
        });

      // Qwen templates (including froggeric) replay traces by splitting think
      // tags out of `content` when preserve_thinking is on. Putting those traces
      // in `reasoning_content` on older turns makes llama.cpp treat thinking as
      // already finished (Gemma follow-up) or stay in a think-only parse (Qwen
      // shows a trace and no answer). Continue and Gemma tool-call replay still
      // use the field below.
      if (
        shouldReconstructPreservedAssistantContent({
          preserveThinking,
          sendReasoningContent,
          openTag: thinkingConfig.openTag,
        }) &&
        m.role === "assistant" &&
        m.thinkingContent
      ) {
        finalContent = replaceApiMessageText(
          finalContent,
          reconstructPreservedAssistantContent(m, thinkingConfig),
        );
      }

      const hasUnsupportedMedia = mediaAtts.some((a) => {
        if (isExtractedVideoAudioAttachment(a)) return false;
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
      if (sendReasoningContent && m.thinkingContent) {
        apiMsg.reasoning_content = m.thinkingContent;
      }
      if (parsedToolCalls) {
        apiMsg.tool_calls = toApiToolCalls(parsedToolCalls);
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

  if (!reuseAssistantRow) {
    const assistantPlaceholder: ChatMessage = {
      id: assistantMessageId,
      chatId,
      role: "assistant",
      content: "",
      rawContent: "",
      position: 0,
      createdAt: Date.now(),
    };
    await addMessage(assistantPlaceholder);
    broadcast({ type: "message", chatId, message: assistantPlaceholder });
  }

  /**
   * Removes the placeholder assistant row when generation fails before any content is written.
   * Reasoning traces and tool-call metadata are substantive and must not be discarded.
   *
   * @returns No return value.
   */
  const cleanupEmptyAssistantMessage = () => {
    if (reuseAssistantRow) return;

    try {
      const row = getDb()
        .query<
          { content: string; thinking_content: string | null; tool_calls_json: string | null },
          [string]
        >("SELECT content, thinking_content, tool_calls_json FROM messages WHERE id = ?")
        .get(assistantMessageId);
      const hasContent = Boolean(row?.content);
      const hasThinking = Boolean(row?.thinking_content);
      const hasToolCalls = Boolean(row?.tool_calls_json);
      if (row && !hasContent && !hasThinking && !hasToolCalls) {
        getDb().prepare("DELETE FROM messages WHERE id = ?").run(assistantMessageId);
      }
    } catch (cleanupErr) {
      logError("[streamProxy] Failed to clean up orphaned assistant message", cleanupErr);
    }
  };

  /**
   * Truncates history, tokenises the prompt, and starts the llama-server stream.
   * Runs after the HTTP handler has already returned the assistant message ID.
   *
   * @returns A promise that resolves once the stream has been started or failed.
   */
  const runInference = async (): Promise<void> => {
    logDebug("Truncating message history", { ctxSize, overflowPolicy });
    rawMessages = await truncateMessages(
      rawMessages,
      overflowPolicy,
      ctxSize,
      safeInfPreset.maxTokens || 4096,
      server.port ?? undefined,
      true,
      { buildPromptText },
    );
    if (abortController.signal.aborted) {
      cleanupEmptyAssistantMessage();
      activeGenerations.delete(generationId);
      return;
    }
    logDebug("Calculating prompt token count");
    const apiMessages = await buildApiMessages(rawMessages);
    const promptTokensCount = await getTokens(rawMessages, server.port ?? undefined, {
      buildPromptText: async () =>
        JSON.stringify({
          messages: apiMessages,
          ...(requestTools ? { tools: requestTools } : {}),
          ...(requestResponseFormat ? { response_format: requestResponseFormat } : {}),
          ...(requestThinkingConfig ?? {}),
        }),
    });
    if (abortController.signal.aborted) {
      cleanupEmptyAssistantMessage();
      activeGenerations.delete(generationId);
      return;
    }
    logInfo("Prompt prepared", { tokens: promptTokensCount, model: server.config?.modelPath });
    // --- End Overflow Policy ---
    // Always use /v1/chat/completions — llama-server is launched with --jinja
    // and handles chat template rendering natively. The old /completion fallback
    // used a broken "{{ messages }}" Jinja template that serialized the messages
    // array as raw JSON, producing garbage output.

    const requestBody: ChatCompletionRequestBody = {
      stream: true,
      cache_prompt: true,
      temperature: infPreset?.temperature ?? inferenceDefaults.temperature,
      top_k: infPreset?.topK ?? inferenceDefaults.topK,
      top_p: infPreset?.topP ?? inferenceDefaults.topP,
      min_p: infPreset?.minP ?? inferenceDefaults.minP,
      typical_p: infPreset?.typicalP ?? inferenceDefaults.typicalP,

      repeat_penalty: infPreset?.repeatPenalty ?? inferenceDefaults.repeatPenalty,
      repeat_last_n: infPreset?.repeatLastN ?? inferenceDefaults.repeatLastN,
      presence_penalty: infPreset?.presencePenalty ?? inferenceDefaults.presencePenalty,
      frequency_penalty: infPreset?.frequencyPenalty ?? inferenceDefaults.frequencyPenalty,
      mirostat: infPreset?.mirostat ?? inferenceDefaults.mirostat,
      mirostat_tau: infPreset?.mirostatTau ?? inferenceDefaults.mirostatTau,
      mirostat_eta: infPreset?.mirostatEta ?? inferenceDefaults.mirostatEta,
      dynatemp_range: infPreset?.dynaTempRange ?? inferenceDefaults.dynaTempRange,
      dynatemp_exponent: infPreset?.dynaTempExponent ?? inferenceDefaults.dynaTempExponent,
      dry_multiplier: infPreset?.dryMultiplier ?? inferenceDefaults.dryMultiplier ?? 0.0,
      dry_base: infPreset?.dryBase ?? inferenceDefaults.dryBase ?? 1.75,
      dry_allowed_length: infPreset?.dryAllowedLength ?? inferenceDefaults.dryAllowedLength ?? 2,
      dry_penalty_last_n: infPreset?.dryPenaltyLastN ?? inferenceDefaults.dryPenaltyLastN ?? 64,
      dry_sequence_breakers: infPreset?.drySequenceBreakers ??
        inferenceDefaults.drySequenceBreakers ?? ["\n", ":", '"', "*"],
      xtc_probability: infPreset?.xtcProbability ?? inferenceDefaults.xtcProbability ?? 0.0,
      xtc_threshold: infPreset?.xtcThreshold ?? inferenceDefaults.xtcThreshold ?? 0.1,
      seed: infPreset?.seed !== undefined && infPreset.seed !== -1 ? infPreset.seed : undefined,
      n_predict: infPreset?.maxTokens ?? inferenceDefaults.maxTokens,
      stop: infPreset?.stopStrings ?? inferenceDefaults.stopStrings,
      messages: apiMessages,
    };

    if (requestTools) {
      requestBody.tools = requestTools;
    }

    if (requestResponseFormat) {
      requestBody.response_format = requestResponseFormat;
    }

    if (requestThinkingConfig) {
      requestBody.chat_template_kwargs = requestThinkingConfig.chat_template_kwargs;
      if (requestThinkingConfig.reasoning_format) {
        requestBody.reasoning_format = requestThinkingConfig.reasoning_format;
      }
    }

    const endpoint = `http://127.0.0.1:${server.port}/v1/chat/completions`;
    logDebug("Constructed inference request", {
      endpoint,
      promptTokensCount,
      ctxSize,
      messagesCount: requestBody.messages.length,
      messages: summarizeRequestMessages(requestBody.messages),
    });

    logInfo("Initiating model inference", {
      chatId,
      endpoint,
      messages: requestBody.messages.length,
      maxTokens: requestBody.n_predict,
      thinking: requestBody.chat_template_kwargs?.enable_thinking,
    });
    logVerbose("Active inference settings", {
      chatId,
      generationId,
      modelPath: server.config?.modelPath,
      inferencePresetId: infPreset?.id ?? null,
      inferencePresetName: infPreset?.name ?? null,
      sampling: {
        temperature: requestBody.temperature,
        top_k: requestBody.top_k,
        top_p: requestBody.top_p,
        min_p: requestBody.min_p,
        typical_p: requestBody.typical_p,
        repeat_penalty: requestBody.repeat_penalty,
        repeat_last_n: requestBody.repeat_last_n,
        presence_penalty: requestBody.presence_penalty,
        frequency_penalty: requestBody.frequency_penalty,
        mirostat: requestBody.mirostat,
        mirostat_tau: requestBody.mirostat_tau,
        mirostat_eta: requestBody.mirostat_eta,
        dynatemp_range: requestBody.dynatemp_range,
        dynatemp_exponent: requestBody.dynatemp_exponent,
        dry_multiplier: requestBody.dry_multiplier,
        dry_base: requestBody.dry_base,
        dry_allowed_length: requestBody.dry_allowed_length,
        dry_penalty_last_n: requestBody.dry_penalty_last_n,
        dry_sequence_breakers: requestBody.dry_sequence_breakers,
        xtc_probability: requestBody.xtc_probability,
        xtc_threshold: requestBody.xtc_threshold,
        seed: requestBody.seed ?? null,
        n_predict: requestBody.n_predict,
        stop: requestBody.stop,
      },
      chat_template_kwargs: requestBody.chat_template_kwargs ?? null,
      reasoning_format: requestBody.reasoning_format ?? null,
      toolsEnabled: Boolean(requestBody.tools?.length),
      structuredOutput: Boolean(requestBody.response_format),
      messageCount: requestBody.messages.length,
      messages: summarizeRequestMessages(requestBody.messages),
      promptTokensCount,
      ctxSize,
    });

    const settings = await loadSettings();
    const timeoutSeconds = settings.requestTimeoutSeconds ?? 60;
    const timeoutMs = timeoutSeconds === 0 ? 0 : timeoutSeconds * 1000;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Rearms the inactivity timeout that protects long-running streaming generations.
     *
     * @returns No return value.
     */
    const resetInactivityTimer = () => {
      if (timeoutMs <= 0) return;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        logWarn(`Generation timeout for generation ${generationId} (${timeoutMs}ms)`);
        abortGeneration(generationId);
      }, timeoutMs);
    };

    resetInactivityTimer();

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

        const reusedRaw = reuseAssistantRow ? lastMessage?.rawContent || "" : "";
        const streamState: AssistantStreamState = {
          fullRawContent: reusedRaw,
          prevContent: reuseAssistantRow ? lastMessage?.content || "" : "",
          prevThinking: reuseAssistantRow ? lastMessage?.thinkingContent || "" : "",
          usedNativeReasoning: Boolean(
            reuseAssistantRow &&
            inferNativeReasoningReuse(
              lastMessage?.thinkingContent,
              reusedRaw,
              thinkingConfig.openTag,
              thinkingConfig.closeTag,
              lastMessage?.metrics?.thinkingSource,
            ),
          ),
        };

        const accumulatedToolCalls: {
          id: string;
          type: "function";
          function: { name: string; arguments: string };
          index?: number;
        }[] = [];
        let lastFlushTime = Date.now();
        let streamBuffer = "";
        let thinkingStartedAt: number | null = null;
        let thinkingEndedAt: number | null = null;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (inactivityTimer) clearTimeout(inactivityTimer);

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
                    reasoning_content?: string;
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
                  if (tc.function?.name)
                    accumulatedToolCalls[idx].function.name += tc.function.name;
                  if (tc.function?.arguments)
                    accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
                }
              }
              const contentPiece = parsed.choices?.[0]?.delta?.content || "";
              const reasoningPiece = parsed.choices?.[0]?.delta?.reasoning_content || "";

              if (contentPiece || reasoningPiece) {
                const { contentDelta, thinkingDelta, isThinking } = applyAssistantStreamDelta(
                  streamState,
                  contentPiece,
                  reasoningPiece,
                  thinkingConfig.openTag,
                  thinkingConfig.closeTag,
                );

                if (thinkingDelta && thinkingStartedAt === null) {
                  thinkingStartedAt = Date.now();
                }
                if (thinkingStartedAt !== null && !isThinking && thinkingEndedAt === null) {
                  thinkingEndedAt = Date.now();
                }

                if (contentDelta || thinkingDelta) {
                  const thinkingDurationMs =
                    thinkingStartedAt !== null && thinkingEndedAt !== null
                      ? Math.max(0, thinkingEndedAt - thinkingStartedAt)
                      : undefined;
                  broadcast({
                    type: "token",
                    chatId,
                    messageId: assistantMessageId,
                    generationId,
                    delta: contentDelta,
                    thinkingDelta: thinkingDelta || undefined,
                    promptTokens: promptTokensCount,
                    contextSize: ctxSize,
                    ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
                  });
                }

                if (Date.now() - lastFlushTime > 1000) {
                  lastFlushTime = Date.now();
                  const dbInstance = await import("./persistence/db").then((m) => m.getDb());
                  dbInstance
                    .prepare(
                      "UPDATE messages SET content = ?, raw_content = ?, thinking_content = ? WHERE id = ?",
                    )
                    .run(
                      streamState.prevContent,
                      streamState.fullRawContent,
                      streamState.prevThinking || null,
                      assistantMessageId,
                    );
                }
              }

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
                    streamState.prevContent,
                    streamState.fullRawContent,
                    streamState.prevThinking || null,
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
                      fullContent: streamState.prevContent,
                      fullRawContent: streamState.fullRawContent,
                      fullThinking: streamState.prevThinking,
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
                    position: 0,
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
                      fullContent: streamState.prevContent,
                      fullRawContent: streamState.fullRawContent,
                      fullThinking: streamState.prevThinking,
                    });
                  } else {
                    broadcast({
                      type: "stop",
                      chatId,
                      messageId: assistantMessageId,
                      generationId,
                      stopReason: "tool_calls",
                      timings,
                      fullContent: streamState.prevContent,
                      fullRawContent: streamState.fullRawContent,
                      fullThinking: streamState.prevThinking,
                    });

                    const { proxyCompletion } = await import("./streamProxy");
                    await proxyCompletion({
                      chatId,
                      content: "",
                      attachments: [],
                      isToolRecurse: true,
                      toolRecursionDepth: toolRecursionDepth + 1,
                    });
                  }
                }

                shouldStop = true;
                break;
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
                if (thinkingStartedAt !== null && thinkingEndedAt === null) {
                  thinkingEndedAt = Date.now();
                }
                const thinkingDurationMs =
                  thinkingStartedAt !== null
                    ? Math.max(0, (thinkingEndedAt ?? Date.now()) - thinkingStartedAt)
                    : streamState.prevThinking
                      ? Math.max(0, timings.predicted_ms || 0)
                      : undefined;
                const messageMetrics = buildMessageMetrics(timings, promptTokensCount, {
                  thinkingDurationMs,
                  stopReason,
                  thinkingSource: streamState.prevThinking
                    ? streamState.usedNativeReasoning
                      ? "native"
                      : "tags"
                    : undefined,
                });
                broadcast({
                  type: "stop",
                  chatId,
                  messageId: assistantMessageId,
                  generationId,
                  stopReason,
                  timings,
                  promptTokens: promptTokensCount,
                  contextSize: ctxSize,
                  fullContent: streamState.prevContent,
                  fullRawContent: streamState.fullRawContent,
                  fullThinking: streamState.prevThinking,
                  ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
                });

                // C8 fix: explicitly pass updatedAt instead of relying on implicit empty-object behavior
                await updateChat(chatId, { updatedAt: Date.now() });
                const dbFinal = await import("./persistence/db").then((m) => m.getDb());
                dbFinal
                  .prepare(
                    "UPDATE messages SET content = ?, raw_content = ?, thinking_content = ?, metrics_json = ? WHERE id = ?",
                  )
                  .run(
                    streamState.prevContent,
                    streamState.fullRawContent,
                    streamState.prevThinking || null,
                    JSON.stringify(messageMetrics),
                    assistantMessageId,
                  );
                if (settings.autonameEnabled) void triggerAutoname(chatId);
                shouldStop = true;
                break;
              }
            }
            if (shouldStop || done) break;
            resetInactivityTimer();
          }
        } catch (err: unknown) {
          const aborted =
            abortController.signal.aborted || (err instanceof Error && err.name === "AbortError");
          if (aborted) {
            const db = await import("./persistence/db").then((m) => m.getDb());
            db.prepare(
              "UPDATE messages SET content = ?, raw_content = ?, thinking_content = ? WHERE id = ?",
            ).run(
              streamState.prevContent,
              streamState.fullRawContent,
              streamState.prevThinking || null,
              assistantMessageId,
            );
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
          if (inactivityTimer) clearTimeout(inactivityTimer);
          cancelPendingApprovals(chatId);
          activeGenerations.delete(generationId);
        }
      })
      .catch(async (err: unknown) => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
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
  };

  void Promise.resolve()
    .then(() => runInference())
    .catch((err: unknown) => {
      cancelPendingApprovals(chatId);
      activeGenerations.delete(generationId);
      cleanupEmptyAssistantMessage();
      if (err instanceof ContextOverflowError) {
        broadcast({
          type: "error",
          chatId,
          messageId: assistantMessageId,
          generationId,
          message: err.message,
        });
        return;
      }
      const failureContext = getModelFailureContext();
      logStreamProxyError("run-inference", err, {
        chatId,
        assistantMessageId,
        generationId,
        ...failureContext,
      });
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
