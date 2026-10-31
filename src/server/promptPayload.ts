/**
 * @packageDocumentation
 * Builds the llama-server chat-completion payload shared by sending and context usage.
 */

import { isExtractedVideoAudioAttachment } from "../shared/extractedAudio";
import { parseToolCallsJson, toApiToolCalls } from "../shared/toolCalls";
import { toStoredToolDefinition } from "../shared/toolModule";
import type {
  ChatMessage,
  GgufDisplayMetadata,
  InferencePreset,
  ThinkingTagConfig,
  ToolDefinition,
} from "../shared/types";
import {
  reconstructPreservedAssistantContent,
  shouldReconstructPreservedAssistantContent,
  shouldSendAssistantReasoningContent,
} from "./chatTemplateEngine";
import { buildContentParts } from "./multimodal";
import { getLoadPresetPreserveThinking } from "./persistence/presetRepo";
import { listAvailableTools } from "./toolRegistry";

/**
 * One OpenAI-style chat message sent to llama-server.
 */
export interface ChatCompletionMessage {
  /** Author role. */
  role: string;
  /** Visible text, or a multipart content array when the turn has media. */
  content: unknown;
  /** Tool calls emitted by an assistant turn. */
  tool_calls?: unknown[];
  /** Tool-call id this tool result answers. */
  tool_call_id?: string;
  /** Tool name attached to a tool-result message. */
  name?: string;
  /** Native reasoning trace, when the template expects `reasoning_content`. */
  reasoning_content?: string;
}

/**
 * A function tool entry in the chat-completion `tools` array.
 */
export interface PromptTool {
  /** OpenAI tool type. Always `function` for LlamaForge tools. */
  type: "function";
  /** Stored or live tool schema sent to the model. */
  function: ToolDefinition | unknown;
}

/**
 * Structured-output constraint sent as `response_format`.
 */
export interface PromptResponseFormat {
  /** llama-server JSON-schema response format. */
  type: "json_schema";
  /** JSON schema the reply must satisfy. */
  schema: Record<string, unknown>;
}

/**
 * Jinja kwargs and reasoning format that accompany every chat completion.
 */
export interface PromptThinkingConfig {
  /** Template kwargs for thinking and preserve-thinking. */
  chat_template_kwargs: {
    /** Whether the template should open a thinking block. */
    enable_thinking: boolean;
    /** Whether earlier thinking traces stay in the prompt. */
    preserve_thinking: boolean;
    /** Optional token the template treats as the thinking switch. */
    enable_token?: string;
  };
  /**
   * Always `none`, so tagged tokens stay in `delta.content` and this process
   * splits them as they arrive.
   */
  reasoning_format: "none";
}

/**
 * Model and template facts needed to turn stored messages into API messages.
 */
export interface ApiMessageBuildContext {
  /** Whether the loaded preset asked the template to preserve thinking. */
  preserveThinking: boolean;
  /** Open and close tags used to reconstruct preserved traces. */
  thinkingConfig: ThinkingTagConfig;
  /** Loaded model metadata, or `null` when no model is running. */
  modelMeta: GgufDisplayMetadata | null;
}

/**
 * Reads `preserve_thinking` from the load preset that produced the running model.
 *
 * @param presetId - Load-preset id stored on the running model config.
 * @returns `true` when that load preset has preserve-thinking enabled.
 */
export async function resolveLoadedPreserveThinking(
  presetId: string | undefined,
): Promise<boolean> {
  if (!presetId) return false;
  return getLoadPresetPreserveThinking(presetId);
}

/**
 * Replaces the textual portion of an OpenAI chat-completion `content` value.
 *
 * Multipart messages keep image, audio, and video parts. Only the text part changes.
 * String content is replaced entirely.
 *
 * @param content - Current string or multipart content.
 * @param text - Replacement visible or tagged text.
 * @returns The same shape as `content`, with the text part updated.
 */
export function replaceApiMessageText(content: unknown, text: string): unknown {
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
 * Places the system prompt in front of the stored transcript.
 *
 * An empty system prompt is omitted. The system row uses a stable id so it is
 * not persisted as a chat message.
 *
 * @param chatId - Chat the prompt belongs to.
 * @param systemContent - System preset body. Blank values are omitted.
 * @param messages - Stored transcript, without a synthetic system row.
 * @param createdAt - Timestamp stored on the synthetic system row.
 * @returns The message list inference and context usage both tokenize.
 */
export function withSystemPrompt(
  chatId: string,
  systemContent: string,
  messages: readonly ChatMessage[],
  createdAt: number,
): ChatMessage[] {
  const prefixed: ChatMessage[] = [];
  if (systemContent) {
    prefixed.push({
      id: "sys",
      chatId,
      role: "system",
      content: systemContent,
      rawContent: systemContent,
      position: 0,
      createdAt,
    });
  }
  prefixed.push(...messages);
  return prefixed;
}

/**
 * Builds the `tools` array for a chat completion.
 *
 * A live tool module replaces the copy stored on the preset when the names match.
 * Tools stay off when the preset has not enabled them or lists none.
 *
 * @param preset - Inference preset selected for this chat.
 * @returns Tool entries, or `undefined` when the request should omit `tools`.
 */
export async function buildRequestTools(
  preset: InferencePreset | undefined,
): Promise<PromptTool[] | undefined> {
  const useTools = Boolean(preset?.toolCallsEnabled && preset.tools && preset.tools.length > 0);
  if (!useTools || !preset) return undefined;
  const liveTools = new Map(
    (await listAvailableTools()).map((tool) => [tool.name, toStoredToolDefinition(tool)] as const),
  );
  return preset.tools.map((tool) => ({
    type: "function" as const,
    function: liveTools.get(tool.name) ?? tool,
  }));
}

/**
 * Builds the structured-output constraint for a chat completion.
 *
 * @param preset - Inference preset selected for this chat.
 * @returns The JSON schema format, or `undefined` when structured output is off.
 */
export function buildRequestResponseFormat(
  preset: InferencePreset | undefined,
): PromptResponseFormat | undefined {
  if (!preset?.structuredOutput?.enabled || !preset.structuredOutput.schema) return undefined;
  return {
    type: "json_schema",
    schema: preset.structuredOutput.schema,
  };
}

/**
 * Builds the thinking kwargs sent with every chat completion.
 *
 * @param preset - Inference preset selected for this chat.
 * @param loadPresetId - Load preset that started the running model, if any.
 * @param enableToken - Optional thinking-switch token from the load preset.
 * @returns Template kwargs and `reasoning_format: "none"`.
 */
export async function buildRequestThinkingConfig(
  preset: InferencePreset | undefined,
  loadPresetId: string | undefined,
  enableToken: string | undefined,
): Promise<PromptThinkingConfig> {
  const chatTemplateKwargs: PromptThinkingConfig["chat_template_kwargs"] = {
    enable_thinking: preset?.thinkingEnabled ?? true,
    preserve_thinking: await resolveLoadedPreserveThinking(loadPresetId),
  };
  if (enableToken) chatTemplateKwargs.enable_token = enableToken;
  return {
    chat_template_kwargs: chatTemplateKwargs,
    reasoning_format: "none",
  };
}

/**
 * Converts persisted chat messages into the OpenAI-compatible messages sent to llama-server.
 *
 * @param messages - Chat history, including the synthetic system row when one applies.
 * @param context - Preserve-thinking flag, tag pair, and loaded model metadata.
 * @returns OpenAI-style chat completion messages.
 */
export async function buildApiMessages(
  messages: readonly ChatMessage[],
  context: ApiMessageBuildContext,
): Promise<ChatCompletionMessage[]> {
  const apiMessages: ChatCompletionMessage[] = [];
  const { preserveThinking, thinkingConfig, modelMeta } = context;
  let lastUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") lastUserIdx = i;
  }

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    if (!message) continue;
    const mediaAttachments =
      message.attachments?.filter(
        (attachment) =>
          attachment.mimeType.startsWith("image/") ||
          attachment.mimeType.startsWith("audio/") ||
          attachment.mimeType.startsWith("video/"),
      ) || [];

    const contentParts =
      mediaAttachments.length > 0
        ? await buildContentParts(
            message.content,
            message.attachments || [],
            modelMeta || undefined,
          )
        : message.content;

    let finalContent: unknown = contentParts;
    const parsedToolCalls = parseToolCallsJson(message.toolCallsJson);
    const sendReasoningContent =
      message.role === "assistant" &&
      Boolean(message.thinkingContent) &&
      shouldSendAssistantReasoningContent({
        messageIndex,
        lastUserIndex: lastUserIdx,
        preserveThinking,
        hasToolCalls: Boolean(parsedToolCalls),
      });

    if (
      shouldReconstructPreservedAssistantContent({
        preserveThinking,
        sendReasoningContent,
        openTag: thinkingConfig.openTag,
      }) &&
      message.role === "assistant" &&
      message.thinkingContent
    ) {
      finalContent = replaceApiMessageText(
        finalContent,
        reconstructPreservedAssistantContent(message, thinkingConfig),
      );
    }

    const hasUnsupportedMedia = mediaAttachments.some((attachment) => {
      if (isExtractedVideoAudioAttachment(attachment)) return false;
      if (attachment.mimeType.startsWith("image/") && !modelMeta?.hasVisionEncoder) return true;
      if (attachment.mimeType.startsWith("audio/") && !modelMeta?.hasAudioEncoder) return true;
      if (attachment.mimeType.startsWith("video/") && !modelMeta?.hasVisionEncoder) return true;
      return false;
    });

    if (hasUnsupportedMedia) {
      const warning =
        "[System info: Some multimodal attachments were removed because the current active model lacks encoders for them.]\n";
      if (typeof finalContent === "string") {
        finalContent = warning + finalContent;
      } else if (Array.isArray(finalContent)) {
        const textPart = finalContent.find((part) => part.type === "text");
        if (textPart) {
          textPart.text = warning + textPart.text;
        } else {
          finalContent.push({ type: "text", text: warning });
        }
      }
    }

    const apiMessage: ChatCompletionMessage = { role: message.role, content: finalContent };
    if (sendReasoningContent && message.thinkingContent) {
      apiMessage.reasoning_content = message.thinkingContent;
    }
    if (parsedToolCalls) {
      apiMessage.tool_calls = toApiToolCalls(parsedToolCalls);
    }
    if (message.toolCallId) {
      apiMessage.tool_call_id = message.toolCallId;
      const assistantMessage = messages.find(
        (previous) =>
          previous.role === "assistant" &&
          parseToolCallsJson(previous.toolCallsJson)?.some(
            (call) => call.id === message.toolCallId,
          ),
      );
      const toolCalls = parseToolCallsJson(assistantMessage?.toolCallsJson);
      const matchingCall = toolCalls?.find((call) => call.id === message.toolCallId);
      if (matchingCall) apiMessage.name = matchingCall.function.name;
    }
    apiMessages.push(apiMessage);
  }

  return apiMessages;
}

/**
 * Serializes the prompt fields that occupy the context window.
 *
 * Sampling fields are omitted. Messages, tools, the response schema, and thinking
 * kwargs are included in the same order the send path tokenizes.
 *
 * @param apiMessages - OpenAI-style messages about to be sent.
 * @param extras - Tools, response format, and thinking kwargs for the same request.
 * @returns JSON text passed to the tokenizer.
 */
export function serializePromptForTokens(
  apiMessages: readonly ChatCompletionMessage[],
  extras: {
    /** Tool definitions, omitted when tools are off. */
    tools?: PromptTool[] | undefined;
    /** Structured-output schema, omitted when that mode is off. */
    responseFormat?: PromptResponseFormat | undefined;
    /** Thinking kwargs included with every completion. */
    thinking: PromptThinkingConfig;
  },
): string {
  return JSON.stringify({
    messages: apiMessages,
    ...(extras.tools ? { tools: extras.tools } : {}),
    ...(extras.responseFormat ? { response_format: extras.responseFormat } : {}),
    ...extras.thinking,
  });
}
