/**
 * @packageDocumentation
 * Real llama-server integration using the locally installed Qwen3.5-0.8B fixture.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createChat, getChat, updateChat } from "../../src/server/persistence/chatRepo";
import { initDb, resetDb } from "../../src/server/persistence/db";
import { createInferencePreset } from "../../src/server/persistence/presetRepo";
import { saveSettings } from "../../src/server/persistence/settingsRepo";
import { getProc, getServerStatus, loadModel, unloadModel } from "../../src/server/llamaServer";
import { proxyCompletion } from "../../src/server/streamProxy";
import type {
  AppSettings,
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
      ? { chatTemplateFile: loadPreset.chatTemplateOverride }
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

function _buildLocalVideoChatRequest(
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
  const health = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(5_000),
  });
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
): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
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
        `exitCode=${exitCode === null || exitCode === undefined ? "null" : String(exitCode)}`,
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
});
