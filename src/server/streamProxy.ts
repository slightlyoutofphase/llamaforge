/**
 * @packageDocumentation
 * Proxies streaming inference from llama-server to clients over WebSocket.
 * Handles thinking tag splitting and prompt cache bookkeeping.
 */

import type { ChatMessage } from "@shared/types.js";
import { triggerAutoname } from "./autoname";
import { detectThinkingConfig, parseThinkTags } from "./chatTemplateEngine";
import { getServerStatus } from "./llamaServer";
import { logError, logWarn } from "./logger";
import { processUpload } from "./multimodal";
import { addMessage, getChat, getNextPosition, updateChat } from "./persistence/chatRepo";
import { getInferencePresets, getSystemPresets } from "./persistence/presetRepo";
import { loadSettings } from "./persistence/settingsRepo";
import { updatePromptCacheStats } from "./promptCache";
import { broadcast } from "./wsHub";

type GenerationSession = {
  chatId: string;
  controller: AbortController;
  messageId: string;
  startedAt: number;
};

const activeGenerations = new Map<string, GenerationSession>();

function logStreamProxyError(context: string, err: unknown, details?: Record<string, unknown>) {
  logError(
    "[streamProxy] Error in",
    context,
    details ? JSON.stringify(details) : undefined,
    err instanceof Error ? err.stack || err.message : err,
  );
}

/**
 * Terminate an active generation.
 *
 * @param idOrChatId - The generation session ID or chat ID.
 */
export function abortGeneration(idOrChatId: string) {
  const exact = activeGenerations.get(idOrChatId);
  if (exact) {
    exact.controller.abort();
    activeGenerations.delete(idOrChatId);
    return;
  }

  for (const [id, session] of activeGenerations.entries()) {
    if (session.chatId === idOrChatId) {
      session.controller.abort();
      activeGenerations.delete(id);
    }
  }
}

/**
 * Returns the set of chat IDs that currently have active generations in progress.
 * Used by cleanup.ts to avoid deleting attachment files that may be actively read.
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
  if (server.status !== "running" || !server.port) {
    throw new Error("Llama-server is not running.");
  }

  const chat = await getChat(chatId);
  if (!chat) throw new Error("Chat not found");

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
  const sysPresets = await getSystemPresets();
  const infPresets = await getInferencePresets();

  const sysPreset = sysPresets.find((p) => p.id === chat.systemPresetId);
  const infPreset = infPresets.find((p) => p.id === chat.inferencePresetId) || infPresets[0];

  const processedAttachments: any[] = [];
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
  let dbContent = newMessage;
  for (const a of processedAttachments) {
    if (a.extractedText) {
      dbContent += `\n--- Attached file: ${a.fileName} ---\n${a.extractedText}\n--- End of file ---\n`;
    }
  }

  let rawMessages: ChatMessage[] = [];
  if (sysPreset) {
    rawMessages.push({
      id: "sys",
      chatId,
      role: "system",
      content: sysPreset.content,
      rawContent: sysPreset.content,
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

      const db = await import("./persistence/db").then((m) => m.getDb());
      db.prepare("UPDATE messages SET content = ?, raw_content = ? WHERE id = ?").run(
        dbContent,
        dbContent,
        userMessageId,
      );
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
  const { truncateMessages, getTokens } = await import("./overflow");
  const ctxSize = server.config?.contextSize || 4096;
  rawMessages = await truncateMessages(
    rawMessages,
    overflowPolicy,
    ctxSize,
    safeInfPreset.maxTokens,
    server.port,
  );
  const promptTokensCount = await getTokens(rawMessages, server.port);
  // --- End Overflow Policy ---

  const { getMetadataForPath } = await import("./persistence/chatRepo");
  const modelMeta = server.config?.modelPath
    ? await getMetadataForPath(server.config.modelPath)
    : null;
  const thinkingConfig = detectThinkingConfig(
    modelMeta?.architecture,
    infPreset?.thinkingTagOverride,
  );
  const useTools = infPreset?.toolCallsEnabled && infPreset.tools && infPreset.tools.length > 0;
  const _hasMedia = rawMessages.some((m) =>
    m.attachments?.some((a) => a.mimeType.startsWith("image/") || a.mimeType.startsWith("audio/")),
  );
  // Always use /v1/chat/completions — llama-server is launched with --jinja
  // and handles chat template rendering natively. The old /completion fallback
  // used a broken "{{ messages }}" Jinja template that serialized the messages
  // array as raw JSON, producing garbage output.
  const _useChatCompletions = true;

  const endpoint = `http://127.0.0.1:${server.port}/v1/chat/completions`;
  const requestBody: Record<string, unknown> = {
    stream: true,
    cache_prompt: true,
    temperature: infPreset?.temperature ?? 0.8,
    top_k: infPreset?.topK ?? 40,
    top_p: infPreset?.topP ?? 0.95,
    min_p: infPreset?.minP ?? 0.05,
    n_predict: infPreset?.maxTokens ?? -1,
    stop: infPreset?.stopStrings ?? [],
  };

  const { buildContentParts } = await import("./multimodal");

  requestBody.messages = [];
  for (const m of rawMessages) {
    const mediaAtts =
      m.attachments?.filter(
        (a) => a.mimeType.startsWith("image/") || a.mimeType.startsWith("audio/"),
      ) || [];

    // For messages with media attachments, build multimodal content parts;
    // for plain text messages, just use the text content string directly.
    const hasMediaAttachments = mediaAtts.length > 0;
    const contentParts = hasMediaAttachments
      ? await buildContentParts(m.content, m.attachments || [], modelMeta || undefined)
      : m.content;

    let finalContent = contentParts;

    // Multimodal warning for history
    const hasUnsupportedMedia = mediaAtts.some((a) => {
      if (a.mimeType.startsWith("image/") && !modelMeta?.hasVisionEncoder) return true;
      if (a.mimeType.startsWith("audio/") && !modelMeta?.hasAudioEncoder) return true;
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

    const apiMsg: {
      role: string;
      content: any;
      tool_calls?: any[];
      tool_call_id?: string;
      name?: string;
    } = { role: m.role, content: finalContent };

    if (m.toolCallsJson) {
      try {
        apiMsg.tool_calls = JSON.parse(m.toolCallsJson);
      } catch (_e) {}
    }
    if (m.toolCallId) {
      apiMsg.tool_call_id = m.toolCallId;
      // Find function name for tool result
      const assistantMsg = rawMessages.find(
        (prev) =>
          prev.role === "assistant" &&
          prev.toolCallsJson &&
          JSON.parse(prev.toolCallsJson).some((tc: { id: string }) => tc.id === m.toolCallId),
      );
      if (assistantMsg?.toolCallsJson) {
        const tcs = JSON.parse(assistantMsg.toolCallsJson);
        const matchingTc = tcs.find((tc: { id: string }) => tc.id === m.toolCallId);
        if (matchingTc) apiMsg.name = matchingTc.function.name;
      }
    }
    (requestBody.messages as any[]).push(apiMsg);
  }

  if (useTools) {
    requestBody.tools = infPreset.tools.map((t) => ({
      type: "function",
      function: t,
    }));
  }

  if (infPreset?.structuredOutput?.enabled && infPreset.structuredOutput.schema) {
    requestBody.response_format = {
      type: "json_schema",
      json_schema: infPreset.structuredOutput.schema,
    };
  }

  // Enable thinking tag handling via llama-server's native template kwargs
  if (infPreset?.thinkingEnabled ?? true) {
    requestBody.chat_template_kwargs = { enable_thinking: true };
    // Use reasoning_format "none" so we get raw thinking tags we can parse ourselves
    requestBody.reasoning_format = "none";
  }

  const abortController = new AbortController();
  const generationId = Bun.randomUUIDv7();
  activeGenerations.set(generationId, {
    chatId,
    controller: abortController,
    messageId: assistantMessageId,
    startedAt: Date.now(),
  });

  const settings = await loadSettings();
  const timeoutMs = (settings.requestTimeoutSeconds || 60) * 1000;
  let inactivityTimer: ReturnType<typeof setTimeout>;

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
        INSERT INTO messages (id, chat_id, role, content, raw_content, thinking_content, position, created_at, tool_call_id, tool_calls_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    );
  }

  fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
    signal: abortController.signal,
  })
    .then(async (res) => {
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
          resetInactivityTimer();

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
              timings?: import("@shared/types.js").LlamaTimings;
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

              for (const tc of toolCalls) {
                const { approved, editedArguments } = await waitForToolApproval(chatId, tc.id);
                if (!approved) {
                  broadcast({
                    type: "stop",
                    chatId,
                    messageId: assistantMessageId,
                    generationId,
                    stopReason: "error",
                    timings: parsed.timings || ({} as import("@shared/types.js").LlamaTimings),
                    fullContent: prevContent,
                    fullRawContent,
                    fullThinking: prevThinking,
                  });
                  shouldStop = true;
                  break;
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
                broadcast({
                  type: "stop",
                  chatId,
                  messageId: assistantMessageId,
                  generationId,
                  stopReason: "tool_calls",
                  timings: parsed.timings || ({} as import("@shared/types.js").LlamaTimings),
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
                });
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
              let stopReason: import("@shared/types.js").WsStopFrame["stopReason"] = "eos";
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
                  "UPDATE messages SET content = ?, raw_content = ?, thinking_content = ? WHERE id = ?",
                )
                .run(prevContent, fullRawContent, prevThinking || null, assistantMessageId);

              if (settings.autonameEnabled) await triggerAutoname(chatId);
              shouldStop = true;
              break;
            }
          }

          if (shouldStop || done) break;
        }
      } catch (err: any) {
        if (err.name === "AbortError") {
          const db = await import("./persistence/db").then((m) => m.getDb());
          db.prepare(
            "UPDATE messages SET content = ?, raw_content = ?, thinking_content = ? WHERE id = ?",
          ).run(prevContent, fullRawContent, prevThinking || null, assistantMessageId);
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
            message: "Generation cancelled.",
          });
        } else {
          logStreamProxyError("stream-parse", err, {
            chatId,
            assistantMessageId,
            generationId,
          });
          // C6 fix: delete the empty assistant row if generation failed
          // to prevent orphaned blank messages in chat history.
          if (!isContinue) {
            try {
              const dbCleanup = await import("./persistence/db").then((m) => m.getDb());
              const row = dbCleanup
                .query<{ content: string }, [string]>("SELECT content FROM messages WHERE id = ?")
                .get(assistantMessageId);
              if (row && row.content.length === 0) {
                dbCleanup.prepare("DELETE FROM messages WHERE id = ?").run(assistantMessageId);
              }
            } catch (cleanupErr) {
              logError("[streamProxy] Failed to clean up orphaned assistant message", cleanupErr);
            }
          }
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
        const { cancelPendingApprovals } = await import("./tools");
        cancelPendingApprovals(chatId);
        activeGenerations.delete(generationId);
      }
    })
    .catch(async (err) => {
      clearTimeout(inactivityTimer);
      const { cancelPendingApprovals } = await import("./tools");
      cancelPendingApprovals(chatId);
      activeGenerations.delete(generationId);
      logStreamProxyError("fetch-catch", err, {
        endpoint,
        chatId,
        assistantMessageId,
        generationId,
      });
      // C6 fix: delete the empty assistant row if the fetch itself failed
      // (e.g., model server unreachable, connection refused)
      if (!isContinue) {
        try {
          const dbCleanup = await import("./persistence/db").then((m) => m.getDb());
          const row = dbCleanup
            .query<{ content: string }, [string]>("SELECT content FROM messages WHERE id = ?")
            .get(assistantMessageId);
          if (row && row.content.length === 0) {
            dbCleanup.prepare("DELETE FROM messages WHERE id = ?").run(assistantMessageId);
          }
        } catch (cleanupErr) {
          logError("[streamProxy] Failed to clean up orphaned assistant message", cleanupErr);
        }
      }
      broadcast({
        type: "error",
        chatId,
        messageId: assistantMessageId,
        generationId,
        message: String(err),
      });
    });

  return assistantMessageId;
}
