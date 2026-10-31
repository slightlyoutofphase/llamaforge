/**
 * @packageDocumentation
 * Builds the model-load request shared by the registry and the model library.
 */

import { resolveSpecDraftModelPath } from "../shared/defaults";
import type { ChatMessage, LoadModelRequest, LoadPreset, ModelEntry } from "../shared/types";

/**
 * Outcome of planning a model load against the current transcript.
 */
export type ModelLoadPlan =
  | { kind: "load"; request: LoadModelRequest }
  | {
      kind: "guard";
      reason: "vision" | "audio" | "both";
      messages: ChatMessage[];
      request: LoadModelRequest;
    };

/**
 * Builds the load request for a model and preset, or a multimodal guard when the transcript cannot move with it.
 *
 * The request always uses the selected model path. Preset sampling, the preset id, a thinking-tag override,
 * a chat-template override that differs from the model default, and the resolved draft path are included when set.
 *
 * @param model - Model the user chose to load.
 * @param preset - Load preset that has already been resolved for that model.
 * @param messages - Transcript that would stay open after the load.
 * @returns A ready load request, or a guard describing attachments the model cannot accept.
 */
export function planModelLoad(
  model: ModelEntry,
  preset: LoadPreset,
  messages: readonly ChatMessage[],
): ModelLoadPlan {
  const request: LoadModelRequest = {
    ...preset.config,
    modelPath: model.primaryPath,
    presetId: preset.id,
  };
  if (preset.thinkingTagOverride) {
    request.thinkingTagOverride = preset.thinkingTagOverride;
  }
  const resolvedDraftPath = resolveSpecDraftModelPath(
    preset.config.specType,
    preset.config.specDraftModelPath,
    model.draftModelPath,
    model.draftSpecType,
  );
  if (resolvedDraftPath) {
    request.specDraftModelPath = resolvedDraftPath;
  }
  if (
    preset.chatTemplateOverride &&
    preset.chatTemplateOverride.length > 0 &&
    preset.chatTemplateOverride !== model.metadata?.chatTemplate
  ) {
    request.chatTemplateContent = preset.chatTemplateOverride;
  }

  const hasVision = model.metadata?.hasVisionEncoder === true;
  const hasAudio = model.metadata?.hasAudioEncoder === true;
  const visionMsgs = messages.filter((message) =>
    message.attachments?.some(
      (attachment) =>
        attachment.mimeType.startsWith("image/") || attachment.mimeType.startsWith("video/"),
    ),
  );
  const audioMsgs = messages.filter((message) =>
    message.attachments?.some((attachment) => attachment.mimeType.startsWith("audio/")),
  );

  if (!hasVision && visionMsgs.length > 0 && !hasAudio && audioMsgs.length > 0) {
    return {
      kind: "guard",
      reason: "both",
      messages: [...visionMsgs, ...audioMsgs],
      request,
    };
  }
  if (!hasVision && visionMsgs.length > 0) {
    return { kind: "guard", reason: "vision", messages: visionMsgs, request };
  }
  if (!hasAudio && audioMsgs.length > 0) {
    return { kind: "guard", reason: "audio", messages: audioMsgs, request };
  }
  return { kind: "load", request };
}
