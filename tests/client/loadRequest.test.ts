/**
 * @packageDocumentation
 * Tests for the shared model-load planner.
 */

import { describe, expect, it } from "bun:test";
import { planModelLoad } from "../../src/client/loadRequest";
import { createDefaultLoadConfig } from "../../src/shared/defaults";
import type { ChatMessage, LoadPreset, ModelEntry } from "../../src/shared/types";
import { ggufDisplayMetadata } from "../fixtures";

/**
 * Builds a chat message carrying one attachment.
 *
 * @param id - Message and attachment id.
 * @param mimeType - Attachment MIME type.
 * @returns A user message with that attachment.
 */
function messageWith(id: string, mimeType: string): ChatMessage {
  return {
    id,
    chatId: "chat-1",
    role: "user",
    content: "",
    rawContent: "",
    position: 0,
    createdAt: 0,
    attachments: [
      {
        id: `${id}-file`,
        messageId: id,
        mimeType,
        filePath: `${id}.bin`,
        fileName: `${id}.bin`,
        createdAt: 0,
      },
    ],
  };
}

/**
 * Builds a text-only chat message.
 *
 * @param id - Message id.
 * @returns A user message with no attachments.
 */
function textMessage(id: string): ChatMessage {
  return {
    id,
    chatId: "chat-1",
    role: "user",
    content: "hello",
    rawContent: "hello",
    position: 0,
    createdAt: 0,
  };
}

const modelPath = "D:/models/main.gguf";

/**
 * Builds a load preset whose stored path differs from the model being loaded.
 *
 * @param overrides - Fields to replace on the preset.
 * @returns A complete load preset.
 */
function preset(overrides: Partial<LoadPreset> = {}): LoadPreset {
  return {
    id: "preset-1",
    name: "Balanced",
    modelPath: "D:/models/other.gguf",
    isDefault: false,
    isReadonly: false,
    config: createDefaultLoadConfig("D:/models/other.gguf"),
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/**
 * Builds a model entry for planner tests.
 *
 * @param overrides - Fields to replace on the model.
 * @returns A model entry pointed at {@link modelPath}.
 */
function model(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    publisher: "lab",
    modelName: "Main",
    primaryPath: modelPath,
    metadata: ggufDisplayMetadata({ chatTemplate: "built-in" }),
    ...overrides,
  };
}

describe("planModelLoad", () => {
  it("uses the selected model path and omits a template that matches the model", () => {
    const plan = planModelLoad(
      model(),
      preset({
        chatTemplateOverride: "built-in",
        thinkingTagOverride: { openTag: "<think>", closeTag: "</think>", enableToken: undefined },
      }),
      [textMessage("m1")],
    );
    expect(plan.kind).toBe("load");
    if (plan.kind !== "load") return;
    expect(plan.request.modelPath).toBe(modelPath);
    expect(plan.request.presetId).toBe("preset-1");
    expect(plan.request.chatTemplateContent).toBeUndefined();
    expect(plan.request.thinkingTagOverride).toEqual({
      openTag: "<think>",
      closeTag: "</think>",
      enableToken: undefined,
    });
  });

  it("keeps a non-empty template override and a configured draft path", () => {
    const plan = planModelLoad(
      model({
        draftModelPath: "D:/models/detected.gguf",
        draftSpecType: "draft-mtp",
      }),
      preset({
        chatTemplateOverride: "  custom  ",
        config: {
          ...createDefaultLoadConfig(modelPath),
          specType: "draft-simple",
          specDraftModelPath: "D:/models/configured.gguf",
        },
      }),
      [],
    );
    expect(plan.kind).toBe("load");
    if (plan.kind !== "load") return;
    expect(plan.request.chatTemplateContent).toBe("  custom  ");
    expect(plan.request.specDraftModelPath).toBe("D:/models/configured.gguf");
  });

  it("uses a matching scanned draft when the preset path is blank", () => {
    const plan = planModelLoad(
      model({ draftModelPath: "D:/models/detected.gguf", draftSpecType: "draft-simple" }),
      preset({
        config: {
          ...createDefaultLoadConfig(modelPath),
          specType: "draft-simple",
          specDraftModelPath: "   ",
        },
      }),
      [],
    );
    expect(plan.kind).toBe("load");
    if (plan.kind !== "load") return;
    expect(plan.request.specDraftModelPath).toBe("D:/models/detected.gguf");
  });

  it("leaves a mismatched scanned draft off the request", () => {
    const plan = planModelLoad(
      model({ draftModelPath: "D:/models/detected.gguf", draftSpecType: "draft-mtp" }),
      preset({
        config: {
          ...createDefaultLoadConfig(modelPath),
          specType: "draft-simple",
          specDraftModelPath: "",
        },
      }),
      [],
    );
    expect(plan.kind).toBe("load");
    if (plan.kind !== "load") return;
    expect(plan.request.specDraftModelPath).toBe("");
  });

  it("guards vision, audio, and both, including video frames", () => {
    const image = messageWith("image", "image/png");
    const video = messageWith("video", "video/mp4");
    const audio = messageWith("audio", "audio/wav");
    const both = messageWith("both", "image/png");
    both.attachments = [
      ...(both.attachments ?? []),
      {
        id: "both-audio",
        messageId: "both",
        mimeType: "audio/wav",
        filePath: "both.wav",
        fileName: "both.wav",
        createdAt: 0,
      },
    ];

    const vision = planModelLoad(model(), preset(), [textMessage("plain"), image]);
    expect(vision.kind).toBe("guard");
    if (vision.kind === "guard") {
      expect(vision.reason).toBe("vision");
      expect(vision.messages.map((entry) => entry.id)).toEqual(["image"]);
    }

    const clip = planModelLoad(model(), preset(), [video]);
    expect(clip.kind).toBe("guard");
    if (clip.kind === "guard") expect(clip.reason).toBe("vision");

    const sound = planModelLoad(model(), preset(), [audio]);
    expect(sound.kind).toBe("guard");
    if (sound.kind === "guard") expect(sound.reason).toBe("audio");

    const mixed = planModelLoad(model(), preset(), [image, audio, both]);
    expect(mixed.kind).toBe("guard");
    if (mixed.kind === "guard") {
      expect(mixed.reason).toBe("both");
      expect(mixed.messages.map((entry) => entry.id)).toEqual(["image", "both", "audio", "both"]);
    }
  });

  it("skips a guard for a modality the model can accept", () => {
    const image = messageWith("image", "image/png");
    const audio = messageWith("audio", "audio/wav");
    const visionModel = planModelLoad(
      model({ metadata: ggufDisplayMetadata({ hasVisionEncoder: true }) }),
      preset(),
      [image, audio],
    );
    expect(visionModel.kind).toBe("guard");
    if (visionModel.kind === "guard") expect(visionModel.reason).toBe("audio");

    const ready = planModelLoad(
      model({
        metadata: ggufDisplayMetadata({ hasVisionEncoder: true, hasAudioEncoder: true }),
      }),
      preset(),
      [image, audio],
    );
    expect(ready.kind).toBe("load");
  });

  it("omits an empty template override", () => {
    const plan = planModelLoad(model(), preset({ chatTemplateOverride: "" }), []);
    expect(plan.kind).toBe("load");
    if (plan.kind !== "load") return;
    expect(plan.request.chatTemplateContent).toBeUndefined();
    expect(plan.request.thinkingTagOverride).toBeUndefined();
  });
});
