/**
 * @packageDocumentation
 * Real llama-server integration using the locally installed Qwen3.5-0.8B fixture.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bunNativeFetch, restoreBunNativeWebGlobals } from "../happy-setup";
import {
  getProc,
  getRecentServerLogs,
  getServerStatus,
  loadModel,
  unloadModel,
} from "../../src/server/llamaServer";
import { buildContentParts } from "../../src/server/multimodal";
import { addMessage, createChat, getChat, updateChat } from "../../src/server/persistence/chatRepo";
import { initDb, resetDb } from "../../src/server/persistence/db";
import { createInferencePreset, createSystemPreset } from "../../src/server/persistence/presetRepo";
import { saveSettings } from "../../src/server/persistence/settingsRepo";
import { proxyCompletion } from "../../src/server/streamProxy";
import type {
  AppSettings,
  GgufDisplayMetadata,
  InferencePreset,
  LoadPreset,
  ModelLoadConfig,
  WsFrame,
} from "../../src/shared/types";

type RealLlamaFixture = {
  settings: Pick<AppSettings, "modelsPath" | "llamaServerPath"> & { llamaServerPath: string };
  loadPreset: LoadPreset;
  inferencePreset: Omit<InferencePreset, "structuredOutput"> & {
    structuredOutput?: InferencePreset["structuredOutput"] | null;
  };
};

const describeReal = process.platform === "win32" ? describe : describe.skip;
const TEST_DATA_DIR = path.dirname(
  fileURLToPath(new URL("../data/real-llama-fixture.json", import.meta.url)),
);
const TEST_APP_DATA_DIR = path.join(TEST_DATA_DIR, ".llamaforge");
const REAL_DB_PATH = path.join(TEST_APP_DATA_DIR, "real-llama-integration.db");
const TEST_PORT_MIN = 12400;
const TEST_PORT_MAX = 12410;
const REAL_MEDIA_CHAT_ID = "real-qwen-multimodal-chat";
const TEST_VIDEO_FILE = "test_vid.mp4";
const VIDEO_COMPLETION_TIMEOUT_MS = 180_000;

let fixture: {
  settings: RealLlamaFixture["settings"];
  loadPreset: LoadPreset;
  inferencePreset: InferencePreset;
};
let previousAppDataDir: string | undefined;

async function resetTestAppDataDir(): Promise<void> {
  await fs.rm(TEST_APP_DATA_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(TEST_APP_DATA_DIR, { recursive: true });
}

function buildLoadRequest(loadPreset: LoadPreset): {
  config: ModelLoadConfig;
  thinkingTagOverride?: LoadPreset["thinkingTagOverride"];
} {
  const config: ModelLoadConfig = {
    ...loadPreset.config,
    ...(loadPreset.chatTemplateOverride
      ? { chatTemplateContent: loadPreset.chatTemplateOverride }
      : {}),
  };

  return {
    config,
    ...(loadPreset.thinkingTagOverride
      ? { thinkingTagOverride: loadPreset.thinkingTagOverride }
      : {}),
  };
}

function buildChatRequestBase(inferencePreset: InferencePreset) {
  return {
    stream: false,
    cache_prompt: true,
    temperature: inferencePreset.temperature,
    top_k: inferencePreset.topK,
    top_p: inferencePreset.topP,
    min_p: inferencePreset.minP,
    typical_p: inferencePreset.typicalP,
    repeat_penalty: inferencePreset.repeatPenalty,
    repeat_last_n: inferencePreset.repeatLastN,
    presence_penalty: inferencePreset.presencePenalty,
    frequency_penalty: inferencePreset.frequencyPenalty,
    mirostat: inferencePreset.mirostat,
    mirostat_tau: inferencePreset.mirostatTau,
    mirostat_eta: inferencePreset.mirostatEta,
    dynatemp_range: inferencePreset.dynaTempRange,
    dynatemp_exponent: inferencePreset.dynaTempExponent,
    dry_multiplier: inferencePreset.dryMultiplier ?? 0,
    dry_base: inferencePreset.dryBase ?? 1.75,
    dry_allowed_length: inferencePreset.dryAllowedLength ?? 2,
    dry_penalty_last_n: inferencePreset.dryPenaltyLastN ?? 64,
    dry_sequence_breakers: inferencePreset.drySequenceBreakers ?? ["\n", ":", '"', "*"],
    xtc_probability: inferencePreset.xtcProbability ?? 0,
    xtc_threshold: inferencePreset.xtcThreshold ?? 0.1,
    seed: 7,
    n_predict: 8,
    stop: inferencePreset.stopStrings,
    chat_template_kwargs: { enable_thinking: false },
    reasoning_format: "none",
  };
}

function buildShortChatRequest(inferencePreset: InferencePreset) {
  return {
    ...buildChatRequestBase(inferencePreset),
    messages: [
      {
        role: "user",
        content: "Reply with the exact text integration-ok and nothing else.",
      },
    ],
  };
}

function buildLocalImageChatRequest(
  inferencePreset: InferencePreset,
  mediaUrl: string,
  prompt: string,
) {
  return {
    ...buildChatRequestBase(inferencePreset),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: mediaUrl } },
        ],
      },
    ],
  };
}

function buildLocalVideoChatRequest(
  inferencePreset: InferencePreset,
  mediaUrl: string,
  prompt: string,
) {
  return {
    ...buildChatRequestBase(inferencePreset),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "input_video", input_video: { url: mediaUrl } },
        ],
      },
    ],
  };
}

async function requireDataFixture(fileName: string): Promise<void> {
  const file = Bun.file(new URL(`../data/${fileName}`, import.meta.url));
  if (!(await file.exists()) || file.size <= 0) {
    throw new Error(
      `Missing test fixture tests/data/${fileName}. The Qwen video test requires this file on disk.`,
    );
  }
}

async function stageMediaFixture(fileName: string, messageId: string): Promise<string> {
  const relativePath = `attachments/${REAL_MEDIA_CHAT_ID}/${messageId}/${fileName}`;
  const absolutePath = path.join(TEST_APP_DATA_DIR, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await Bun.write(absolutePath, Bun.file(new URL(`../data/${fileName}`, import.meta.url)));
  return `file://${relativePath}`;
}

async function createFixtureFile(fileName: string, mimeType: string): Promise<File> {
  const bytes = await Bun.file(new URL(`../data/${fileName}`, import.meta.url)).arrayBuffer();
  return new File([bytes], fileName, { type: mimeType });
}

async function assertHealthy(port: number): Promise<void> {
  const health = await bunNativeFetch(`http://127.0.0.1:${port}/health`);
  expect(health.ok).toBe(true);
}

function extractAssistantContent(payload: Record<string, unknown>): string {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(`Missing choices array in payload: ${JSON.stringify(payload)}`);
  }

  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") {
    throw new Error(`Invalid first choice in payload: ${JSON.stringify(payload)}`);
  }

  const message = (firstChoice as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    throw new Error(`Missing assistant message in payload: ${JSON.stringify(payload)}`);
  }

  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string") {
    throw new Error(`Assistant content was not a string: ${JSON.stringify(payload)}`);
  }

  return content;
}

async function postChatCompletion(
  port: number,
  body: Record<string, unknown>,
  label: string,
  timeoutMs: number = 20_000,
): Promise<Record<string, unknown>> {
  try {
    const response = await bunNativeFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const rawBody = await response.text();
    if (!response.ok) {
      throw new Error(`${label} returned HTTP ${response.status}: ${rawBody}`);
    }

    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    if (Object.hasOwn(payload, "error")) {
      throw new Error(`${label} returned error payload: ${JSON.stringify(payload.error)}`);
    }

    return payload;
  } catch (error) {
    const status = getServerStatus();
    const exitCode = getProc()?.exitCode;
    throw new Error(
      `${label} failed: ${error instanceof Error ? error.message : String(error)} | ` +
        `serverStatus=${status.status} | activePort=${status.port ?? "none"} | ` +
        `exitCode=${exitCode === null || exitCode === undefined ? "null" : String(exitCode)} | ` +
        `serverLogs=${getRecentServerLogs(40).join(" | ")}`,
    );
  }
}

async function waitForTerminalFrame(
  broadcastSpy: ReturnType<typeof spyOn>,
  chatId: string,
  messageId: string,
  timeoutMs: number = 45_000,
): Promise<Extract<WsFrame, { type: "stop" | "error" }>> {
  const deadline = Date.now() + timeoutMs;
  let inspectedCalls = 0;

  while (Date.now() < deadline) {
    const calls = broadcastSpy.mock.calls;
    for (; inspectedCalls < calls.length; inspectedCalls++) {
      const frame = calls[inspectedCalls]?.[0] as WsFrame | undefined;
      if (!frame || (frame.type !== "stop" && frame.type !== "error")) {
        continue;
      }
      if (frame.chatId === chatId && frame.messageId === messageId) {
        return frame;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for a terminal frame for message ${messageId}.`);
}

describeReal("llamaServer real integration", () => {
  beforeAll(async () => {
    restoreBunNativeWebGlobals();
    previousAppDataDir = process.env.LLAMAFORGE_APP_DATA_DIR;
    process.env.LLAMAFORGE_APP_DATA_DIR = TEST_APP_DATA_DIR;

    const rawFixture = (await Bun.file(
      new URL("../data/real-llama-fixture.json", import.meta.url),
    ).json()) as RealLlamaFixture;

    fixture = {
      settings: rawFixture.settings,
      loadPreset: rawFixture.loadPreset,
      inferencePreset: {
        ...rawFixture.inferencePreset,
        structuredOutput: rawFixture.inferencePreset.structuredOutput ?? undefined,
      },
    };

    await unloadModel();
    resetDb();
    await resetTestAppDataDir();
    await initDb(REAL_DB_PATH);
    await saveSettings({
      modelsPath: fixture.settings.modelsPath,
      llamaServerPath: fixture.settings.llamaServerPath,
      autoloadLastModel: false,
      llamaPortRangeMin: TEST_PORT_MIN,
      llamaPortRangeMax: TEST_PORT_MAX,
      requestTimeoutSeconds: 20,
    });
    await createInferencePreset({
      ...fixture.inferencePreset,
      isDefault: false,
    });
  });

  beforeEach(() => {
    restoreBunNativeWebGlobals();
  });

  afterAll(async () => {
    await unloadModel();
    resetDb();
    await resetTestAppDataDir();
    if (previousAppDataDir === undefined) {
      delete process.env.LLAMAFORGE_APP_DATA_DIR;
    } else {
      process.env.LLAMAFORGE_APP_DATA_DIR = previousAppDataDir;
    }
  });

  it("loads the real Qwen preset and completes a short bounded real generation", async () => {
    const loadRequest = buildLoadRequest(fixture.loadPreset);
    let port: number | null = null;
    try {
      port = await loadModel(
        loadRequest.config,
        fixture.settings.llamaServerPath,
        TEST_PORT_MIN,
        TEST_PORT_MAX,
        loadRequest.thinkingTagOverride,
      );

      expect(port).toBeGreaterThanOrEqual(TEST_PORT_MIN);
      expect(port).toBeLessThanOrEqual(TEST_PORT_MAX);
      expect(getServerStatus().status).toBe("running");
      expect(getServerStatus().config?.modelPath).toBe(fixture.loadPreset.modelPath);
      expect(loadRequest.config.mmProjPath).toBeTruthy();

      await assertHealthy(port);

      const payload = await postChatCompletion(
        port,
        buildShortChatRequest(fixture.inferencePreset),
        "plain text real completion",
      );

      expect(payload).toBeTruthy();
      expect(Object.keys(payload).length).toBeGreaterThan(0);
      expect(Object.hasOwn(payload, "error")).toBe(false);
      expect(extractAssistantContent(payload).length).toBeGreaterThan(0);
    } finally {
      await unloadModel();
      expect(getServerStatus().status).toBe("idle");
    }
  }, 90_000);

  it("accepts staged local file media via image_url for the real Qwen multimodal fixture", async () => {
    const loadRequest = buildLoadRequest(fixture.loadPreset);
    const pngUrl = await stageMediaFixture("Back.PNG", "msg-png");
    const jpgUrl = await stageMediaFixture("CH_Santa_Dream_Vilgelm_16.jpg", "msg-jpg");

    let port: number | null = null;
    try {
      port = await loadModel(
        loadRequest.config,
        fixture.settings.llamaServerPath,
        TEST_PORT_MIN,
        TEST_PORT_MAX,
        loadRequest.thinkingTagOverride,
      );

      expect(port).toBeGreaterThanOrEqual(TEST_PORT_MIN);
      expect(port).toBeLessThanOrEqual(TEST_PORT_MAX);
      expect(getServerStatus().status).toBe("running");
      expect(loadRequest.config.mmProjPath).toBeTruthy();

      await assertHealthy(port);

      const pngPayload = await postChatCompletion(
        port,
        buildLocalImageChatRequest(
          fixture.inferencePreset,
          pngUrl,
          "Reply with a short sentence confirming the image request succeeded.",
        ),
        "PNG local-media multimodal completion",
      );
      expect(extractAssistantContent(pngPayload).length).toBeGreaterThan(0);

      await assertHealthy(port);

      const jpgPayload = await postChatCompletion(
        port,
        buildLocalImageChatRequest(
          fixture.inferencePreset,
          jpgUrl,
          "Reply with a short sentence confirming the image request succeeded.",
        ),
        "JPG local-media multimodal completion",
      );
      expect(extractAssistantContent(jpgPayload).length).toBeGreaterThan(0);

      await assertHealthy(port);
    } finally {
      await unloadModel();
      expect(getServerStatus().status).toBe("idle");
    }
  }, 120_000);

  it("sends the real tests/data/test_vid.mp4 fixture as native input_video to Qwen 3.5", async () => {
    await requireDataFixture(TEST_VIDEO_FILE);
    // Native video tokenization of this clip is ~22k tokens; the default 8k fixture window rejects it.
    const loadRequest = buildLoadRequest({
      ...fixture.loadPreset,
      config: {
        ...fixture.loadPreset.config,
        contextSize: 32768,
      },
    });
    const videoUrl = await stageMediaFixture(TEST_VIDEO_FILE, "msg-mp4");
    const relativePath = videoUrl.replace(/^file:\/\//, "");
    const stagedAbs = path.join(TEST_APP_DATA_DIR, ...relativePath.split("/"));
    expect(await Bun.file(stagedAbs).exists()).toBe(true);
    expect(Bun.file(stagedAbs).size).toBeGreaterThan(32);

    const parts = await buildContentParts(
      "Reply with a short sentence confirming the video request succeeded.",
      [
        {
          id: "vid-1",
          messageId: "msg-mp4",
          mimeType: "video/mp4",
          fileName: TEST_VIDEO_FILE,
          filePath: relativePath,
          createdAt: Date.now(),
        },
      ],
      { hasVisionEncoder: true } as GgufDisplayMetadata,
    );
    expect(Array.isArray(parts)).toBe(true);
    const videoPart = (parts as Array<{ type?: string; input_video?: { url?: string } }>)[0];
    expect(videoPart?.type).toBe("input_video");
    expect(videoPart?.input_video?.url).toBe(videoUrl);

    const videoPresetId = Bun.randomUUIDv7();
    await createInferencePreset({
      ...fixture.inferencePreset,
      id: videoPresetId,
      name: "Qwen video input_video",
      isDefault: false,
      thinkingEnabled: false,
      maxTokens: 32,
    });
    await saveSettings({ requestTimeoutSeconds: VIDEO_COMPLETION_TIMEOUT_MS / 1000 });

    const wsHubModule = await import("../../src/server/wsHub");
    const broadcastSpy = spyOn(wsHubModule, "broadcast");
    const capturedBodies: Array<{
      messages?: Array<{ content?: unknown }>;
    }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/chat/completions") && init?.body) {
        try {
          capturedBodies.push(JSON.parse(String(init.body)));
        } catch {
          // Ignore malformed bodies; the original fetch still runs.
        }
      }
      return bunNativeFetch(input, init);
    }) as typeof fetch;

    let port: number | null = null;
    try {
      port = await loadModel(
        loadRequest.config,
        fixture.settings.llamaServerPath,
        TEST_PORT_MIN,
        TEST_PORT_MAX,
        loadRequest.thinkingTagOverride,
      );
      expect(loadRequest.config.mmProjPath).toBeTruthy();
      await assertHealthy(port);

      const directPayload = await postChatCompletion(
        port,
        buildLocalVideoChatRequest(
          fixture.inferencePreset,
          videoUrl,
          "Reply with a short sentence confirming the video request succeeded.",
        ),
        "MP4 local-media input_video completion",
        VIDEO_COMPLETION_TIMEOUT_MS,
      );
      expect(extractAssistantContent(directPayload).length).toBeGreaterThan(0);
      await assertHealthy(port);

      const chat = await createChat("Real Qwen input_video", fixture.loadPreset.modelPath);
      await updateChat(chat.id, { inferencePresetId: videoPresetId });
      const assistantId = await proxyCompletion({
        chatId: chat.id,
        content: "Reply with a short sentence confirming the video request succeeded.",
        attachments: [await createFixtureFile(TEST_VIDEO_FILE, "video/mp4")],
      });
      const frame = await waitForTerminalFrame(
        broadcastSpy,
        chat.id,
        assistantId,
        VIDEO_COMPLETION_TIMEOUT_MS,
      );
      if (frame.type === "error") {
        throw new Error(`streamProxy input_video request failed: ${frame.message}`);
      }

      const stored = await getChat(chat.id);
      const userWithVideo = stored?.messages?.find(
        (message) =>
          message.role === "user" &&
          message.attachments?.some((att) => att.fileName === TEST_VIDEO_FILE),
      );
      const assistant = stored?.messages?.find((message) => message.id === assistantId);
      expect(userWithVideo).toBeDefined();
      const visible =
        assistant?.content ||
        (frame.type === "stop" ? frame.fullContent || frame.fullRawContent || "" : "");
      expect(visible.length).toBeGreaterThan(0);

      const proxyBody = capturedBodies.at(-1);
      const inputVideoUrls: string[] = [];
      for (const message of proxyBody?.messages ?? []) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content) {
          if (
            part &&
            typeof part === "object" &&
            (part as { type?: string }).type === "input_video"
          ) {
            const url = (part as { input_video?: { url?: string } }).input_video?.url;
            if (url) inputVideoUrls.push(url);
          }
        }
      }
      expect(inputVideoUrls.length).toBeGreaterThan(0);
      expect(inputVideoUrls.some((url) => url.endsWith(".mp4"))).toBe(true);
      await assertHealthy(port);
    } finally {
      restoreBunNativeWebGlobals();
      broadcastSpy.mockRestore();
      await saveSettings({ requestTimeoutSeconds: 20 });
      await unloadModel();
      expect(getServerStatus().status).toBe("idle");
    }
  }, 300_000);

  it("completes real multimodal requests through streamProxy with persisted attachment replay", async () => {
    const loadRequest = buildLoadRequest(fixture.loadPreset);
    const wsHubModule = await import("../../src/server/wsHub");
    const broadcastSpy = spyOn(wsHubModule, "broadcast");

    let port: number | null = null;
    try {
      port = await loadModel(
        loadRequest.config,
        fixture.settings.llamaServerPath,
        TEST_PORT_MIN,
        TEST_PORT_MAX,
        loadRequest.thinkingTagOverride,
      );

      await assertHealthy(port);

      const chat = await createChat("Real streamProxy multimodal", fixture.loadPreset.modelPath);
      await updateChat(chat.id, { inferencePresetId: fixture.inferencePreset.id });

      const firstAssistantId = await proxyCompletion({
        chatId: chat.id,
        content: "Reply with a short sentence confirming the image request succeeded.",
        attachments: [await createFixtureFile("Back.PNG", "image/png")],
      });
      const firstFrame = await waitForTerminalFrame(
        broadcastSpy,
        chat.id,
        firstAssistantId,
        90_000,
      );
      if (firstFrame.type === "error") {
        throw new Error(`First streamProxy multimodal request failed: ${firstFrame.message}`);
      }

      const firstChat = await getChat(chat.id);
      const firstUserWithAttachment = firstChat?.messages?.find(
        (message) =>
          message.role === "user" &&
          message.attachments?.some((att) => att.fileName === "Back.PNG"),
      );
      const firstAssistant = firstChat?.messages?.find(
        (message) => message.id === firstAssistantId,
      );
      expect(firstUserWithAttachment).toBeDefined();
      expect(firstAssistant?.content.length).toBeGreaterThan(0);

      const secondAssistantId = await proxyCompletion({
        chatId: chat.id,
        content: "Reply with a short sentence confirming the second image request succeeded.",
        attachments: [await createFixtureFile("CH_Santa_Dream_Vilgelm_16.jpg", "image/jpeg")],
      });
      const secondFrame = await waitForTerminalFrame(
        broadcastSpy,
        chat.id,
        secondAssistantId,
        90_000,
      );
      if (secondFrame.type === "error") {
        throw new Error(
          `Second streamProxy multimodal request failed after persisted-history replay: ${secondFrame.message}`,
        );
      }

      const secondChat = await getChat(chat.id);
      const userMessagesWithAttachments =
        secondChat?.messages?.filter(
          (message) => message.role === "user" && (message.attachments?.length ?? 0) > 0,
        ) ?? [];
      const secondAssistant = secondChat?.messages?.find(
        (message) => message.id === secondAssistantId,
      );

      expect(userMessagesWithAttachments).toHaveLength(2);
      expect(
        userMessagesWithAttachments.some((message) =>
          message.attachments?.some((att) => att.fileName === "CH_Santa_Dream_Vilgelm_16.jpg"),
        ),
      ).toBe(true);
      expect(secondAssistant?.content.length).toBeGreaterThan(0);

      await assertHealthy(port);
    } finally {
      broadcastSpy.mockRestore();
      await unloadModel();
      expect(getServerStatus().status).toBe("idle");
    }
  }, 180_000);

  describe("context overflow policies", () => {
    const FILLER =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet kelvin lima ".repeat(80);

    function buildOverflowLoadConfig(): ModelLoadConfig {
      const config: ModelLoadConfig = {
        ...fixture.loadPreset.config,
        contextSize: 1024,
      };
      delete config.mmProjPath;
      delete config.imageMaxTokens;
      return config;
    }

    async function seedOversizedHistory(chatId: string): Promise<void> {
      await addMessage({
        id: Bun.randomUUIDv7(),
        chatId,
        role: "user",
        content: "FIRST USER",
        rawContent: "FIRST USER",
        position: 0,
        createdAt: Date.now(),
      });
      await addMessage({
        id: Bun.randomUUIDv7(),
        chatId,
        role: "assistant",
        content: `MIDDLE TURN ${FILLER}${FILLER}`,
        rawContent: `MIDDLE TURN ${FILLER}${FILLER}`,
        position: 1,
        createdAt: Date.now(),
      });
      await addMessage({
        id: Bun.randomUUIDv7(),
        chatId,
        role: "user",
        content: `SECOND USER ${FILLER}`,
        rawContent: `SECOND USER ${FILLER}`,
        position: 2,
        createdAt: Date.now(),
      });
      await addMessage({
        id: Bun.randomUUIDv7(),
        chatId,
        role: "assistant",
        content: `MORE MIDDLE ${FILLER}${FILLER}`,
        rawContent: `MORE MIDDLE ${FILLER}${FILLER}`,
        position: 3,
        createdAt: Date.now(),
      });
    }

    /**
     * Captures llama-server chat-completion request bodies while still forwarding them.
     *
     * @returns Captured bodies plus a restore callback.
     */
    function captureCompletions(): {
      bodies: Array<{ messages?: Array<{ role?: string; content?: string }> }>;
      restore: () => void;
    } {
      const bodies: Array<{ messages?: Array<{ role?: string; content?: string }> }> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/v1/chat/completions") && init?.body) {
          try {
            bodies.push(JSON.parse(String(init.body)));
          } catch {
            // Ignore malformed bodies; the original fetch still runs.
          }
        }
        return bunNativeFetch(input, init);
      }) as typeof fetch;
      return {
        bodies,
        restore: () => {
          restoreBunNativeWebGlobals();
        },
      };
    }

    it("StopAtLimit refuses to generate when the conversation exceeds the window", async () => {
      const loadConfig = buildOverflowLoadConfig();
      const presetId = "overflow-stop-at-limit";
      await createInferencePreset({
        ...fixture.inferencePreset,
        id: presetId,
        name: "StopAtLimit overflow",
        isDefault: false,
        contextOverflowPolicy: "StopAtLimit",
        thinkingEnabled: false,
        maxTokens: 8,
      });

      const wsHubModule = await import("../../src/server/wsHub");
      const broadcastSpy = spyOn(wsHubModule, "broadcast");
      try {
        const port = await loadModel(
          loadConfig,
          fixture.settings.llamaServerPath,
          TEST_PORT_MIN,
          TEST_PORT_MAX,
        );
        await assertHealthy(port);

        const chat = await createChat("StopAtLimit overflow", loadConfig.modelPath);
        await updateChat(chat.id, { inferencePresetId: presetId });
        await seedOversizedHistory(chat.id);

        const assistantId = await proxyCompletion({
          chatId: chat.id,
          content: "Reply with the word ok.",
          attachments: [],
        });
        const frame = await waitForTerminalFrame(broadcastSpy, chat.id, assistantId, 90_000);
        expect(frame.type).toBe("error");
        if (frame.type === "error") {
          expect(frame.message.toLowerCase()).toContain("context");
        }
      } finally {
        broadcastSpy.mockRestore();
        await unloadModel();
      }
    }, 180_000);

    it("TruncateMiddle keeps the system prompt and first user turn while dropping the middle", async () => {
      const loadConfig = buildOverflowLoadConfig();
      const presetId = "overflow-truncate-middle";
      await createInferencePreset({
        ...fixture.inferencePreset,
        id: presetId,
        name: "TruncateMiddle overflow",
        isDefault: false,
        contextOverflowPolicy: "TruncateMiddle",
        thinkingEnabled: false,
        maxTokens: 8,
      });
      await createSystemPreset({
        id: "overflow-system",
        name: "Overflow system",
        content: "You are a terse assistant.",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const capture = captureCompletions();
      const wsHubModule = await import("../../src/server/wsHub");
      const broadcastSpy = spyOn(wsHubModule, "broadcast");
      try {
        const port = await loadModel(
          loadConfig,
          fixture.settings.llamaServerPath,
          TEST_PORT_MIN,
          TEST_PORT_MAX,
        );
        await assertHealthy(port);

        const chat = await createChat("TruncateMiddle overflow", loadConfig.modelPath);
        await updateChat(chat.id, {
          inferencePresetId: presetId,
          systemPresetId: "overflow-system",
        });
        await seedOversizedHistory(chat.id);

        const assistantId = await proxyCompletion({
          chatId: chat.id,
          content: "LATEST QUERY reply with ok.",
          attachments: [],
        });
        const frame = await waitForTerminalFrame(broadcastSpy, chat.id, assistantId, 90_000);
        expect(frame.type).not.toBe("error");

        const completion = capture.bodies.at(-1);
        const contents = (completion?.messages ?? []).map((message) =>
          String(message.content ?? ""),
        );
        expect(contents.some((content) => content.includes("You are a terse assistant."))).toBe(
          true,
        );
        expect(contents.some((content) => content.includes("FIRST USER"))).toBe(true);
        expect(contents.some((content) => content.includes("LATEST QUERY"))).toBe(true);
        expect(contents.some((content) => content.includes("MORE MIDDLE"))).toBe(false);
      } finally {
        capture.restore();
        broadcastSpy.mockRestore();
        await unloadModel();
      }
    }, 180_000);

    it("RollingWindow drops the oldest turns while preserving the system prompt and latest query", async () => {
      const loadConfig = buildOverflowLoadConfig();
      const presetId = "overflow-rolling-window";
      await createInferencePreset({
        ...fixture.inferencePreset,
        id: presetId,
        name: "RollingWindow overflow",
        isDefault: false,
        contextOverflowPolicy: "RollingWindow",
        thinkingEnabled: false,
        maxTokens: 8,
      });
      await createSystemPreset({
        id: "overflow-system-rolling",
        name: "Overflow rolling system",
        content: "You are a terse assistant.",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const capture = captureCompletions();
      const wsHubModule = await import("../../src/server/wsHub");
      const broadcastSpy = spyOn(wsHubModule, "broadcast");
      try {
        const port = await loadModel(
          loadConfig,
          fixture.settings.llamaServerPath,
          TEST_PORT_MIN,
          TEST_PORT_MAX,
        );
        await assertHealthy(port);

        const chat = await createChat("RollingWindow overflow", loadConfig.modelPath);
        await updateChat(chat.id, {
          inferencePresetId: presetId,
          systemPresetId: "overflow-system-rolling",
        });
        await seedOversizedHistory(chat.id);

        const assistantId = await proxyCompletion({
          chatId: chat.id,
          content: "LATEST QUERY reply with ok.",
          attachments: [],
        });
        const frame = await waitForTerminalFrame(broadcastSpy, chat.id, assistantId, 90_000);
        expect(frame.type).not.toBe("error");

        const completion = capture.bodies.at(-1);
        const contents = (completion?.messages ?? []).map((message) =>
          String(message.content ?? ""),
        );
        expect(contents.some((content) => content.includes("You are a terse assistant."))).toBe(
          true,
        );
        expect(contents.some((content) => content.includes("FIRST USER"))).toBe(false);
        expect(contents.some((content) => content.includes("LATEST QUERY"))).toBe(true);
      } finally {
        capture.restore();
        broadcastSpy.mockRestore();
        await unloadModel();
      }
    }, 180_000);
  });
});
