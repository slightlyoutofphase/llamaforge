/**
 * @packageDocumentation
 * Basic router for the backend API.
 */

import os from "node:os";
import path from "node:path";
import type { AppSettings } from "@shared/types.js";
import type { ServerWebSocket } from "bun";
import { getHardwareInfo } from "./hardwareProbe";
import { getServerStatus, loadModel, unloadModel } from "./llamaServer";
import { populateMetadata, scanModels } from "./modelScanner";
import { loadSettings } from "./persistence/settingsRepo";
import { addConnection, removeConnection } from "./wsHub";

/**
 * Current hardware probe implementation used by backend routing.
 *
 * This value may be replaced during testing to avoid calling the real
 * hardware probe and to exercise predictable responses.
 */
export let getHardwareInfoImpl = getHardwareInfo;

/**
 * Overrides the runtime hardware probe implementation for test injection.
 *
 * @param override - Object containing a replacement `getHardwareInfo` implementation.
 * @internal
 */
export function __setHardwareProbe(override: { getHardwareInfo: typeof getHardwareInfo }) {
  getHardwareInfoImpl = override.getHardwareInfo;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function badRequest(message: string): Response {
  return jsonResponse({ error: message }, 400);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_MESSAGE_CONTENT_LENGTH = 25000;
const MAX_MESSAGE_ATTACHMENTS = 5;
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;

function normalizeAttachmentPath(attachPath: string): string | null {
  if (!attachPath || typeof attachPath !== "string") return null;
  if (path.isAbsolute(attachPath)) return null;
  const normalized = path.normalize(attachPath);
  if (normalized.startsWith(`..${path.sep}`) || normalized === "..") return null;

  const root = path.join(os.homedir(), ".llamaforge");
  const absPath = path.join(root, normalized);
  const relative = path.relative(root, absPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return absPath;
}

/**
 * Creates the main application router for HTTP and WebSocket requests.
 *
 * @param settings - Current application settings used for routing decisions.
 * @returns An object containing `fetch` and `websocket` handlers compatible with `Bun.serve`.
 * @example
 * ```typescript
 * const router = createRouter(settings);
 * Bun.serve({
 *   fetch: router.fetch,
 *   websocket: router.websocket,
 * });
 * ```
 */
export function createRouter(_settings: AppSettings) {
  return {
    async fetch(req: Request, server: any): Promise<Response | undefined> {
      const url = new URL(req.url);

      if (url.pathname === "/ws") {
        if (server.upgrade(req)) {
          return; // upgrade successful
        }
        return new Response("Upgrade failed", { status: 400 });
      }

      if (
        process.env.NODE_ENV === "production" &&
        !url.pathname.startsWith("/api/") &&
        !url.pathname.startsWith("/health")
      ) {
        let filePath = path.join(process.cwd(), "dist/client", url.pathname);
        let file = Bun.file(filePath);
        if (!(await file.exists()) || url.pathname === "/") {
          filePath = path.join(process.cwd(), "dist/client", "index.html");
          file = Bun.file(filePath);
        }
        return new Response(file);
      }

      if (req.method === "GET" && url.pathname === "/api/models") {
        const currentSettings = await loadSettings();
        const rawModels = await scanModels(currentSettings.modelsPath);
        const { getMetadataForPath } = await import("./persistence/chatRepo");
        const models = await Promise.all(
          rawModels.map(async (m) => {
            const cachedMetadata = await getMetadataForPath(m.primaryPath);
            return cachedMetadata ? { ...m, metadata: cachedMetadata } : await populateMetadata(m);
          }),
        );

        void (async () => {
          try {
            const enriched = await Promise.all(rawModels.map((m) => populateMetadata(m)));
            const { ensureModelDefaultPresets } = await import("./persistence/presetRepo");
            await ensureModelDefaultPresets(enriched);
          } catch (e) {
            console.error("Background model metadata population failed:", e);
          }
        })();

        return new Response(JSON.stringify(models), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (req.method === "POST" && url.pathname === "/api/models/rescan") {
        const currentSettings = await loadSettings();
        const rawModels = await scanModels(currentSettings.modelsPath);
        const { getMetadataForPath } = await import("./persistence/chatRepo");
        const models = await Promise.all(
          rawModels.map(async (m) => {
            const cachedMetadata = await getMetadataForPath(m.primaryPath);
            return cachedMetadata ? { ...m, metadata: cachedMetadata } : await populateMetadata(m);
          }),
        );

        void (async () => {
          try {
            const enriched = await Promise.all(rawModels.map((m) => populateMetadata(m)));
            const { ensureModelDefaultPresets } = await import("./persistence/presetRepo");
            await ensureModelDefaultPresets(enriched);
          } catch (e) {
            console.error("Background model metadata population failed:", e);
          }
        })();

        return new Response(JSON.stringify(models), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (req.method === "POST" && url.pathname === "/api/server/load") {
        let body: any;
        try {
          body = await req.json();
        } catch (_err: unknown) {
          return badRequest("Invalid JSON payload for server load.");
        }

        if (
          !isPlainObject(body) ||
          typeof body.modelPath !== "string" ||
          body.modelPath.length === 0
        ) {
          return badRequest("server/load requires a valid modelPath string.");
        }

        const curSettings = await loadSettings();
        if (!curSettings.llamaServerPath) {
          return jsonResponse(
            {
              error: "No llama-server binary path configured",
              code: "NOT_CONFIGURED",
            },
            400,
          );
        }
        if (
          typeof curSettings.llamaServerPath !== "string" ||
          curSettings.llamaServerPath.length === 0
        ) {
          return jsonResponse(
            {
              error: "Configured llama-server path is invalid",
              code: "INVALID_PATH",
            },
            400,
          );
        }
        try {
          const port = await loadModel(
            body,
            curSettings.llamaServerPath,
            curSettings.llamaPortRangeMin,
            curSettings.llamaPortRangeMax,
          );
          return jsonResponse({ port });
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          return jsonResponse({ error: errorMsg, code: "LOAD_FAILED" }, 500);
        }
      }

      if (req.method === "POST" && url.pathname === "/api/server/unload") {
        await unloadModel();
        return new Response(JSON.stringify({ success: true }));
      }

      if (req.method === "GET" && url.pathname === "/api/server/status") {
        return new Response(JSON.stringify(getServerStatus()), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (req.method === "GET" && url.pathname === "/api/hardware") {
        const hw = await getHardwareInfoImpl();
        return new Response(JSON.stringify(hw), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (req.method === "POST" && url.pathname === "/api/hardware/optimize") {
        const body: any = await req.json();
        const { getMetadataForPath } = await import("./persistence/chatRepo");
        const { optimizeLoadConfig } = await import("./optimizer");

        const hw = await getHardwareInfo();
        const metadata = await getMetadataForPath(body.modelPath);
        if (!metadata) return new Response("Model metadata not found", { status: 404 });

        const optimized = optimizeLoadConfig(hw, metadata);
        return new Response(JSON.stringify(optimized), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (req.method === "GET" && url.pathname === "/api/settings") {
        const s = await loadSettings();
        return new Response(JSON.stringify(s), { headers: { "Content-Type": "application/json" } });
      }

      if (req.method === "PUT" && url.pathname === "/api/settings") {
        let body: any;
        try {
          body = await req.json();
        } catch (_err: unknown) {
          return badRequest("Invalid JSON payload for settings.");
        }
        if (!isPlainObject(body)) {
          return badRequest("Settings payload must be an object.");
        }
        try {
          const { saveSettings } = await import("./persistence/settingsRepo");
          await saveSettings(body);
          return jsonResponse({ success: true });
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          return jsonResponse({ error: errorMsg, code: "SAVE_FAILED" }, 500);
        }
      }

      if (
        req.method === "POST" &&
        url.pathname.startsWith("/api/chats/") &&
        url.pathname.endsWith("/messages")
      ) {
        const parts = url.pathname.split("/");
        if (parts.length === 5) {
          const chatId = parts[3] as string;
          try {
            const formData = await req.formData();
            const content = formData.get("content")?.toString() || "";
            if (typeof content !== "string" || content.length === 0) {
              return badRequest("chat message content is required.");
            }
            if (content.length > MAX_MESSAGE_CONTENT_LENGTH) {
              return badRequest(
                `Chat messages cannot exceed ${MAX_MESSAGE_CONTENT_LENGTH} characters.`,
              );
            }

            const attachments = [];

            // Loop through all file inputs
            for (const [key, value] of formData.entries()) {
              if (key === "file" && value instanceof File) {
                if (attachments.length >= MAX_MESSAGE_ATTACHMENTS) {
                  return badRequest(
                    `A maximum of ${MAX_MESSAGE_ATTACHMENTS} attachments is allowed.`,
                  );
                }
                if (value.size > MAX_ATTACHMENT_SIZE_BYTES) {
                  return badRequest("Each attachment must be 10MB or smaller.");
                }
                attachments.push(value);
              }
            }

            const { proxyCompletion } = await import("./streamProxy");
            const messageId = await proxyCompletion({ chatId, content, attachments });
            return jsonResponse({ messageId });
          } catch (e: any) {
            // fallback if it's JSON
            try {
              const body: any = await req.json();
              if (!isPlainObject(body) || typeof body.content !== "string") {
                return badRequest("chat message content is required.");
              }
              if (body.content.length > MAX_MESSAGE_CONTENT_LENGTH) {
                return badRequest(
                  `Chat messages cannot exceed ${MAX_MESSAGE_CONTENT_LENGTH} characters.`,
                );
              }
              const { proxyCompletion } = await import("./streamProxy");
              const messageId = await proxyCompletion({
                chatId,
                content: body.content,
                attachments: [],
              });
              return jsonResponse({ messageId });
            } catch (e2: any) {
              return jsonResponse(
                { error: e2?.message || e?.message || "Invalid chat message request." },
                400,
              );
            }
          }
        }
      }

      const { getChats } = await import("./persistence/chatRepo");
      if (req.method === "GET" && url.pathname === "/api/chats") {
        const q = url.searchParams.get("q") || undefined;
        let limit = 150;
        let offset = 0;
        if (url.searchParams.has("limit")) {
          limit = parseInt(url.searchParams.get("limit") || "150", 10);
        }
        if (url.searchParams.has("offset")) {
          offset = parseInt(url.searchParams.get("offset") || "0", 10);
        }
        const chats = await getChats(q, limit, offset);
        return new Response(JSON.stringify(chats), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Chat CRUD
      const chatRepo = await import("./persistence/chatRepo");
      if (req.method === "POST" && url.pathname === "/api/chats") {
        const body: any = await req.json();
        const chat = await chatRepo.createChat(body.name, body.modelPath);
        return new Response(JSON.stringify(chat), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname.startsWith("/api/chats/")) {
        const parts = url.pathname.split("/");
        const id = parts[3] as string;
        if (parts.length === 4) {
          if (req.method === "GET") {
            const chat = await chatRepo.getChat(id);
            if (!chat) return new Response("Not Found", { status: 404 });
            return new Response(JSON.stringify(chat), {
              headers: { "Content-Type": "application/json" },
            });
          }
          if (req.method === "PUT") {
            const body: any = await req.json();
            await chatRepo.updateChat(id, body);
            return new Response(JSON.stringify({ success: true }));
          }
          if (req.method === "DELETE") {
            await chatRepo.deleteChat(id);
            return new Response(JSON.stringify({ success: true }));
          }
        }

        if (parts.length === 5 && req.method === "GET" && parts[4] === "prompt-cache") {
          const { getPromptCacheStats } = await import("./promptCache");
          const stats = getPromptCacheStats(id);
          return new Response(JSON.stringify(stats || { totalEvaluated: 0, totalCached: 0 }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        if (parts.length === 5 && req.method === "POST") {
          const action = parts[4] as string;
          if (action === "branch") {
            let body: any;
            try {
              body = await req.json();
            } catch (_err: unknown) {
              return badRequest("Invalid JSON payload for branch.");
            }
            if (!isPlainObject(body) || typeof body.messageId !== "string" || !body.messageId) {
              return badRequest("Branch creation requires a valid messageId.");
            }
            const newId = await chatRepo.createBranch(id, body.messageId);
            return jsonResponse({ id: newId });
          }
          if (action === "export") {
            const body: any = await req.json();
            const format = body.format || "json";
            const exported = await chatRepo.exportChat(id, format);
            return jsonResponse({ content: exported });
          }
          if (action === "regenerate") {
            const chatForRegen = await chatRepo.getChat(id);
            const msgs = chatForRegen?.messages || [];

            if (msgs.length > 0) {
              const lastMsg = msgs[msgs.length - 1];
              if (lastMsg.role === "assistant" || lastMsg.role === "tool") {
                // Find the last user message to keep
                let lastUserIdx = msgs.length - 1;
                while (lastUserIdx >= 0 && msgs[lastUserIdx].role !== "user") {
                  lastUserIdx--;
                }
                const positionToKeep = lastUserIdx >= 0 ? msgs[lastUserIdx].position : 0;
                await chatRepo.deleteMessagesAfter(id, positionToKeep);
              }
            }

            const { proxyCompletion } = await import("./streamProxy");
            const messageId = await proxyCompletion({
              chatId: id,
              content: "",
              attachments: [],
              isRegenerate: true,
            });
            return new Response(JSON.stringify({ messageId }), {
              headers: { "Content-Type": "application/json" },
            });
          }
          if (action === "continue") {
            const { proxyCompletion } = await import("./streamProxy");
            const messageId = await proxyCompletion({
              chatId: id,
              content: "",
              attachments: [],
              isContinue: true,
            });
            return new Response(JSON.stringify({ messageId }), {
              headers: { "Content-Type": "application/json" },
            });
          }
          if (action === "branch-and-regenerate") {
            let body: any;
            try {
              body = await req.json();
            } catch (_err: unknown) {
              return badRequest("Invalid JSON payload for branch-and-regenerate.");
            }
            if (!isPlainObject(body) || typeof body.messageId !== "string" || !body.messageId) {
              return badRequest("branch-and-regenerate requires a valid messageId.");
            }

            // We need to branch from the user message BEFORE the assistant message we are regenerating
            const chatForRegen = await chatRepo.getChat(id);
            const msgs = chatForRegen?.messages || [];
            let branchPoint = body.messageId;
            const msgIdx = msgs.findIndex((m) => m.id === branchPoint);

            if (
              msgIdx >= 0 &&
              (msgs[msgIdx].role === "assistant" || msgs[msgIdx].role === "tool")
            ) {
              let lastUserIdx = msgIdx;
              while (lastUserIdx >= 0 && msgs[lastUserIdx].role !== "user") {
                lastUserIdx--;
              }
              if (lastUserIdx >= 0) branchPoint = msgs[lastUserIdx].id;
            }

            const newId = await chatRepo.createBranch(id, branchPoint);
            const { proxyCompletion } = await import("./streamProxy");
            // Regenerate
            const messageId = await proxyCompletion({
              chatId: newId,
              content: "",
              attachments: [],
              isRegenerate: true,
            });
            return jsonResponse({ id: newId, messageId });
          }
          if (action === "branch-and-edit") {
            let body: any;
            try {
              body = await req.json();
            } catch (_err: unknown) {
              return badRequest("Invalid JSON payload for branch-and-edit.");
            }
            if (
              !isPlainObject(body) ||
              typeof body.messageId !== "string" ||
              !body.messageId ||
              typeof body.newContent !== "string" ||
              body.newContent.length === 0
            ) {
              return badRequest("branch-and-edit requires a valid messageId and newContent.");
            }
            const newId = await chatRepo.createBranch(id, body.messageId);
            const newChat = await chatRepo.getChat(newId);
            const newMsg = newChat?.messages?.[newChat.messages.length - 1];

            if (newMsg) {
              await chatRepo.updateMessage(newMsg.id, body.newContent, body.newContent, undefined);
            }

            const { proxyCompletion } = await import("./streamProxy");
            const messageId = await proxyCompletion({
              chatId: newId,
              content: "",
              attachments: [],
              isRegenerate: true, // it will regenerate acting from the newly updated last user message
            });
            return jsonResponse({ id: newId, messageId });
          }
          if (action === "branch-and-continue") {
            let body: any;
            try {
              body = await req.json();
            } catch (_err: unknown) {
              return badRequest("Invalid JSON payload for branch-and-continue.");
            }
            if (!isPlainObject(body) || typeof body.messageId !== "string" || !body.messageId) {
              return badRequest("branch-and-continue requires a valid messageId.");
            }

            // Fix for branch-and-continue orphan issue:
            // If we are branching from an assistant message, we must also include
            // any immediately following tool messages in the branch to maintain state integrity.
            const chatForBranch = await chatRepo.getChat(id);
            const msgs = chatForBranch?.messages || [];
            let branchPoint = body.messageId;
            const msgIdx = msgs.findIndex((m) => m.id === branchPoint);

            if (msgIdx >= 0 && msgs[msgIdx].role === "assistant") {
              let forwardIdx = msgIdx + 1;
              while (forwardIdx < msgs.length && msgs[forwardIdx].role === "tool") {
                branchPoint = msgs[forwardIdx].id;
                forwardIdx++;
              }
            }

            const newId = await chatRepo.createBranch(id, branchPoint);
            const { proxyCompletion } = await import("./streamProxy");
            const messageId = await proxyCompletion({
              chatId: newId,
              content: "",
              attachments: [],
              isContinue: true,
            });
            return jsonResponse({ id: newId, messageId });
          }
        }
        if (parts.length === 6 && parts[4] === "messages") {
          const msgId = parts[5] as string;
          if (req.method === "PUT") {
            const body: any = await req.json();
            await chatRepo.updateMessage(msgId, body.content, body.content, body.thinkingContent);
            return new Response(JSON.stringify({ success: true }));
          }
          if (req.method === "DELETE") {
            await chatRepo.deleteMessageAndSubsequent(id, msgId);
            return new Response(JSON.stringify({ success: true }));
          }
        }
      }
      if (req.method === "POST" && url.pathname === "/api/chats/import") {
        let body: any;
        try {
          body = await req.json();
        } catch (_err: unknown) {
          return badRequest("Invalid JSON payload for chat import.");
        }
        if (!isPlainObject(body) || typeof body.content !== "string") {
          return badRequest("chat import requires a valid content string.");
        }
        try {
          const newId = await chatRepo.importChat(body.content);
          return jsonResponse({ id: newId });
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          return jsonResponse({ error: errorMsg, code: "IMPORT_FAILED" }, 400);
        }
      }

      // Presets
      const presetRepo = await import("./persistence/presetRepo");
      if (url.pathname.startsWith("/api/presets/")) {
        const parts = url.pathname.split("/");
        const type = parts[3] as string;
        const id = parts[4] as string;

        if (parts.length === 4 && req.method === "GET") {
          if (type === "load")
            return new Response(JSON.stringify(await presetRepo.getLoadPresets()), {
              headers: { "Content-Type": "application/json" },
            });
          if (type === "inference")
            return new Response(JSON.stringify(await presetRepo.getInferencePresets()), {
              headers: { "Content-Type": "application/json" },
            });
          if (type === "system")
            return new Response(JSON.stringify(await presetRepo.getSystemPresets()), {
              headers: { "Content-Type": "application/json" },
            });
        }

        if (parts.length === 4 && req.method === "POST") {
          let body: any;
          try {
            body = await req.json();
          } catch (_err: unknown) {
            return badRequest("Invalid JSON payload for preset creation.");
          }
          if (!isPlainObject(body) || typeof body.name !== "string" || body.name.length === 0) {
            return badRequest("Preset creation requires a name.");
          }
          if (type === "load") await presetRepo.createLoadPreset(body);
          if (type === "inference") await presetRepo.createInferencePreset(body);
          if (type === "system") await presetRepo.createSystemPreset(body);
          return jsonResponse({ success: true });
        }

        if (parts.length === 5 && req.method === "PUT") {
          let body: any;
          try {
            body = await req.json();
          } catch (_err: unknown) {
            return badRequest("Invalid JSON payload for preset update.");
          }
          if (!isPlainObject(body)) {
            return badRequest("Preset update requires a JSON object.");
          }
          if (type === "load") await presetRepo.updateLoadPreset(id, body);
          if (type === "inference") await presetRepo.updateInferencePreset(id, body);
          if (type === "system") await presetRepo.updateSystemPreset(id, body);
          return jsonResponse({ success: true });
        }

        if (parts.length === 5 && req.method === "DELETE") {
          if (type === "load") await presetRepo.deleteLoadPreset(id);
          if (type === "inference") await presetRepo.deleteInferencePreset(id);
          if (type === "system") await presetRepo.deleteSystemPreset(id);
          return new Response(JSON.stringify({ success: true }));
        }
      }

      // Autoname
      if (req.method === "POST" && url.pathname === "/api/autoname") {
        const body: any = await req.json();
        const autoname = await import("./autoname");
        await autoname.triggerAutoname(body.chatId);
        return new Response(JSON.stringify({ success: true }));
      }

      // Health check
      if (req.method === "GET" && url.pathname === "/health") {
        return new Response("OK", { status: 200 });
      }

      // Serve attachments
      if (req.method === "GET" && url.pathname.startsWith("/api/attachments/")) {
        const attachPath = decodeURIComponent(url.pathname.replace("/api/attachments/", ""));
        const absPath = normalizeAttachmentPath(attachPath);
        if (!absPath) {
          return badRequest("Invalid attachment path.");
        }
        const file = Bun.file(absPath);
        if (await file.exists()) {
          return new Response(file);
        }
        return new Response("Not Found", { status: 404 });
      }

      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      message(_ws: ServerWebSocket<unknown>, message: string | Buffer) {
        try {
          const frame = JSON.parse(message.toString());
          if (frame.type === "cancel" && frame.chatId) {
            import("./streamProxy").then(({ abortGeneration }) => {
              abortGeneration(frame.generationId ?? frame.chatId);
            });
          }
          if (frame.type === "tool_approval" && frame.toolCallId) {
            import("./tools").then(({ resolveToolApproval }) => {
              resolveToolApproval(frame.toolCallId, frame.approved, frame.editedArguments);
            });
          }
        } catch (_e) {}
      },
      open(ws: ServerWebSocket<unknown>) {
        addConnection(ws);
      },
      close(ws: ServerWebSocket<unknown>) {
        removeConnection(ws);
      },
    },
  };
}
