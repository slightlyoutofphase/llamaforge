/**
 * @packageDocumentation
 * Basic router for the backend API.
 */

import path from "node:path";
import type {
  LoadModelRequest,
  ModelLoadConfig,
  ModelEntry,
  ThinkingTagConfig,
} from "../shared/types";
import type { Server, ServerWebSocket } from "bun";
import { getHardwareInfo } from "./hardwareProbe";
import { getServerStatus, loadModel, requestUnloadModel } from "./llamaServer";
import { logDebug, logError, logInfo, logWarn } from "./logger";
import { populateMetadata, scanModels } from "./modelScanner";
import { isAllowedMutationOrigin, isAllowedWebSocketOrigin, isMutatingMethod } from "./origin";
import { getAppDataDir } from "./persistence/db";
import { loadSettings } from "./persistence/settingsRepo";
import { addConnection, getConnectionCount, recordPong, removeConnection } from "./wsHub";

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
 * @returns No return value.
 * @internal
 */
export function __setHardwareProbe(override: { getHardwareInfo: typeof getHardwareInfo }) {
  getHardwareInfoImpl = override.getHardwareInfo;
}

/**
 * Builds a JSON response with the standard API content type.
 *
 * @param body - Response payload to serialize.
 * @param status - HTTP status code to apply.
 * @returns JSON response object.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      Connection: "close",
    },
  });
}

/**
 * Builds a standard HTTP 400 response for invalid client input.
 *
 * @param message - Human-readable validation error.
 * @returns JSON error response with status `400`.
 */
function badRequest(message: string): Response {
  return jsonResponse({ error: message }, 400);
}

/**
 * Checks whether a value is a non-array object.
 *
 * @param value - Unknown value to validate.
 * @returns `true` when the value is a plain object-like record.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a string field from an object payload.
 *
 * @param record - Object payload containing request data.
 * @param key - Field name to extract.
 * @returns String field value, or `undefined` when the field is missing or not a string.
 */
function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Parses a query-string integer, rejecting NaN and clamping to an inclusive range.
 *
 * @param raw - Raw query parameter value.
 * @param fallback - Value used when the parameter is omitted.
 * @param min - Inclusive minimum.
 * @param max - Inclusive maximum.
 * @returns The parsed integer, or `null` when the raw value is present but not a finite integer.
 */
function parseQueryInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === null || raw === "") return fallback;
  if (!/^-?\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Reads a JSON object body, returning a 400 response when parsing fails.
 *
 * @param req - Incoming HTTP request.
 * @returns Parsed object, or a 400 Response.
 */
async function readJsonObject(req: Request): Promise<Record<string, unknown> | Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return badRequest("Invalid JSON payload.");
  }
  if (!isPlainObject(parsed)) {
    return badRequest("JSON payload must be an object.");
  }
  return parsed;
}

/**
 * Parses an optional thinking-tag override payload from a request body.
 *
 * @param record - Request body payload.
 * @returns Parsed thinking-tag override, or `undefined` when none was supplied.
 * @throws {Error} If the override shape is invalid.
 */
function getThinkingTagOverride(record: Record<string, unknown>): ThinkingTagConfig | undefined {
  const rawValue = record["thinkingTagOverride"];
  if (rawValue === undefined) {
    return undefined;
  }
  if (!isPlainObject(rawValue)) {
    throw new Error("thinkingTagOverride must be an object when provided.");
  }

  const openTag = getStringField(rawValue, "openTag");
  const closeTag = getStringField(rawValue, "closeTag");
  const enableToken = rawValue["enableToken"];

  if (!openTag || !closeTag) {
    throw new Error("thinkingTagOverride requires non-empty openTag and closeTag strings.");
  }
  if (enableToken !== undefined && typeof enableToken !== "string") {
    throw new Error("thinkingTagOverride.enableToken must be a string when provided.");
  }

  return {
    openTag,
    closeTag,
    enableToken:
      typeof enableToken === "string" && enableToken.length > 0 ? enableToken : undefined,
  };
}

/**
 * Determines whether a multipart form entry is a browser `File` object.
 *
 * @param value - Multipart form value.
 * @returns `true` when the value behaves like a `File`.
 */
function isRequestFile(value: unknown): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "type" in value &&
    "size" in value &&
    "arrayBuffer" in value
  );
}

const MAX_MESSAGE_CONTENT_LENGTH = 25000;
const MAX_MESSAGE_ATTACHMENTS = 5;
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;

// S5 fix: removed debounce and background logic because it broke UI immediate availability

/**
 * Checks whether an HTTP method is safe for static file serving.
 *
 * @param method - Incoming request method.
 * @returns `true` for static asset-safe methods.
 */
function isStaticMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/**
 * Determines whether a pathname looks like a static asset request.
 *
 * @param pathname - URL pathname to inspect.
 * @returns `true` when the pathname points to an asset-like resource.
 */
function isAssetLikePath(pathname: string): boolean {
  if (pathname === "/") return false;
  if (pathname.startsWith("/assets/")) return true;
  return path.posix.basename(pathname).includes(".");
}

/**
 * Determines whether the client prefers an HTML document response.
 *
 * @param req - Incoming HTTP request.
 * @returns `true` when the request accepts HTML content.
 */
function wantsHtmlDocument(req: Request): boolean {
  const accept = req.headers.get("accept")?.toLowerCase() ?? "";
  return accept.includes("text/html") || accept.includes("application/xhtml+xml");
}

/**
 * Resolves `relativePath` under `root`, rejecting empty, absolute, and escaping paths.
 *
 * @param root - Directory that must contain the result.
 * @param relativePath - Caller-supplied relative path (leading slashes already stripped).
 * @returns Absolute path inside `root`, or `null` when the path is unsafe.
 */
function resolveContainedPath(root: string, relativePath: string): string | null {
  if (!relativePath || typeof relativePath !== "string") return null;
  const stripped = relativePath.replace(/^[\\/]+/, "").replace(/\\/g, "/");
  if (!stripped) return null;
  if (path.isAbsolute(stripped) || path.win32.isAbsolute(stripped)) return null;

  const normalized = path.normalize(stripped);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) return null;

  const absRoot = path.resolve(root);
  const absPath = path.resolve(absRoot, normalized);
  const relative = path.relative(absRoot, absPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return absPath;
}

/**
 * Resolves a client attachment route parameter to a safe absolute file path
 * inside the attachments directory (not the app-data root).
 *
 * Client `filePath` values are stored as `attachments/<chat>/<msg>/<file>`, so a
 * leading `attachments/` prefix is stripped before joining the attachments root.
 *
 * @param attachPath - Attachment path segment from the request URL.
 * @returns Absolute attachment path, or `null` when the path is unsafe.
 */
function normalizeAttachmentPath(attachPath: string): string | null {
  if (!attachPath || typeof attachPath !== "string") return null;
  if (path.isAbsolute(attachPath) || path.win32.isAbsolute(attachPath)) return null;

  let relative = attachPath.replace(/\\/g, "/");
  while (relative.startsWith("attachments/")) {
    relative = relative.slice("attachments/".length);
  }
  if (relative === "attachments") return null;

  const attachmentsRoot = path.join(getAppDataDir(), "attachments");
  return resolveContainedPath(attachmentsRoot, relative);
}

/**
 * Creates the main application router for HTTP and WebSocket requests.
 *
 * @returns An object containing `fetch` and `websocket` handlers compatible with `Bun.serve`.
 * @example
 * ```typescript
 * const router = createRouter();
 * Bun.serve({
 *   fetch: router.fetch,
 *   websocket: router.websocket,
 * });
 * ```
 */
export function createRouter() {
  let cachedModels: { modelsPath: string; models: ModelEntry[] } | null = null;
  let modelsRefreshPromise: Promise<ModelEntry[]> | null = null;

  /**
   * Hydrates raw scanned model entries with any metadata already cached in persistence.
   *
   * @param rawModels - Raw model entries returned by the filesystem scan.
   * @returns Models enriched with cached metadata when available.
   */
  const readCachedModelMetadata = async (rawModels: ModelEntry[]): Promise<ModelEntry[]> => {
    const { getMetadataForPath } = await import("./persistence/chatRepo");
    return Promise.all(
      rawModels.map(async (model) => {
        const cachedMetadata = await getMetadataForPath(model.primaryPath);
        return cachedMetadata ? { ...model, metadata: cachedMetadata } : model;
      }),
    );
  };

  /**
   * Refreshes the cached model list, optionally populating metadata and default presets.
   *
   * @param modelsPath - Root models directory to scan.
   * @param withSideEffects - Whether to populate metadata and emit preset updates.
   * @returns Refreshed model list for the configured models directory.
   */
  const refreshModels = async (
    modelsPath: string,
    withSideEffects: boolean,
  ): Promise<ModelEntry[]> => {
    const refreshPromise = (async () => {
      const rawModels = await scanModels(modelsPath);
      const models = withSideEffects
        ? await Promise.all(rawModels.map((model) => populateMetadata(model)))
        : await readCachedModelMetadata(rawModels);

      cachedModels = { modelsPath, models };

      if (withSideEffects) {
        try {
          logInfo("Synchronous model metadata population complete.");
          const { ensureModelDefaultPresets } = await import("./persistence/presetRepo");
          await ensureModelDefaultPresets(models);
          const { broadcast } = await import("./wsHub");
          broadcast({ type: "presets_updated" });
        } catch (e) {
          logError("Synchronous model metadata population failed:", e);
        }
      }

      return models;
    })();

    modelsRefreshPromise = refreshPromise.finally(() => {
      if (modelsRefreshPromise === refreshPromise) {
        modelsRefreshPromise = null;
      }
    });

    return refreshPromise;
  };

  /**
   * Returns the current model snapshot, reusing cached or in-flight scans when possible.
   *
   * @param modelsPath - Root models directory to scan.
   * @param forceRefresh - Whether to ignore cached models and rescan immediately.
   * @returns Current model snapshot for the requested models directory.
   */
  const getModelsSnapshot = async (
    modelsPath: string,
    forceRefresh = false,
  ): Promise<ModelEntry[]> => {
    if (!forceRefresh && cachedModels?.modelsPath === modelsPath) {
      return cachedModels.models;
    }
    if (!forceRefresh && modelsRefreshPromise) {
      return modelsRefreshPromise;
    }
    return refreshModels(modelsPath, forceRefresh);
  };

  return {
    /**
     * Handles all HTTP requests routed through the Bun backend.
     *
     * @param req - Incoming HTTP request.
     * @param server - Bun server instance used for WebSocket upgrades.
     * @returns Response to send to the client, or `undefined` when a WebSocket upgrade succeeds.
     */
    async fetch(req: Request, server: Server<unknown>): Promise<Response | undefined> {
      const url = new URL(req.url);
      logDebug(`API Request: ${req.method} ${url.pathname}`);

      if (url.pathname === "/ws") {
        if (!isAllowedWebSocketOrigin(req)) {
          return jsonResponse({ error: "Forbidden origin." }, 403);
        }
        if (server.upgrade(req, { data: null })) {
          return; // upgrade successful
        }
        return new Response("Upgrade failed", { status: 400 });
      }

      if (isMutatingMethod(req.method) && url.pathname.startsWith("/api/")) {
        if (!isAllowedMutationOrigin(req)) {
          return jsonResponse({ error: "Forbidden origin." }, 403);
        }
      }

      const isProd = process.env.NODE_ENV === "production" || Bun.argv[1]?.includes("dist");
      if (isProd && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/health")) {
        if (!isStaticMethod(req.method)) {
          return new Response("Not Found", { status: 404 });
        }

        const staticRoot = path.resolve(process.cwd(), "dist/client");
        const relativeUrlPath = url.pathname.replace(/^\/+/, "");
        const requestedPath = resolveContainedPath(staticRoot, relativeUrlPath);

        if (requestedPath) {
          const requestedFile = Bun.file(requestedPath);
          if (url.pathname !== "/" && (await requestedFile.exists())) {
            return new Response(requestedFile);
          }
        } else if (isAssetLikePath(url.pathname)) {
          return new Response("Not Found", { status: 404 });
        }

        const isDocumentRequest =
          url.pathname === "/" || (!isAssetLikePath(url.pathname) && wantsHtmlDocument(req));
        if (!isDocumentRequest) {
          return new Response("Not Found", { status: 404 });
        }

        const indexPath = resolveContainedPath(staticRoot, "index.html");
        if (!indexPath) {
          return new Response("Not Found", { status: 404 });
        }
        const indexFile = Bun.file(indexPath);
        if (!(await indexFile.exists())) {
          return new Response("Not Found", { status: 404 });
        }

        return new Response(indexFile);
      }

      if (req.method === "GET" && url.pathname === "/api/models") {
        const currentSettings = await loadSettings();
        const models = await getModelsSnapshot(currentSettings.modelsPath);

        return jsonResponse(models);
      }

      if (req.method === "POST" && url.pathname === "/api/models/rescan") {
        const currentSettings = await loadSettings();
        const models = await getModelsSnapshot(currentSettings.modelsPath, true);

        return jsonResponse(models);
      }

      if (req.method === "POST" && url.pathname === "/api/server/load") {
        const body = await readJsonObject(req);
        if (body instanceof Response) return body;

        const modelPath = getStringField(body, "modelPath");
        if (!modelPath) {
          return badRequest("server/load requires a valid modelPath string.");
        }

        let thinkingTagOverride: ThinkingTagConfig | undefined;
        try {
          thinkingTagOverride = getThinkingTagOverride(body);
        } catch (err: unknown) {
          return badRequest(err instanceof Error ? err.message : String(err));
        }

        const curSettings = await loadSettings();
        const modelsRoot = path.resolve(curSettings.modelsPath);
        const resolvedModelPath = path.resolve(modelPath);
        const relativeToModels = path.relative(modelsRoot, resolvedModelPath);
        if (relativeToModels.startsWith("..") || path.isAbsolute(relativeToModels)) {
          logWarn("Model load requested outside the configured models directory", {
            modelPath: resolvedModelPath,
            modelsPath: modelsRoot,
          });
        }
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
          const { thinkingTagOverride: _unusedThinkingTagOverride, ...requestBody } =
            body as unknown as LoadModelRequest;
          const loadConfig: ModelLoadConfig = {
            ...(requestBody as ModelLoadConfig),
            modelPath,
          };
          const models = await getModelsSnapshot(curSettings.modelsPath);
          const selectedModel = models.find((model) => model.primaryPath === modelPath);
          if (selectedModel?.mmProjPath) {
            loadConfig.mmProjPath = selectedModel.mmProjPath;
          }
          if (
            (loadConfig.specType === "draft-simple" || loadConfig.specType === "draft-eagle3") &&
            selectedModel?.draftModelPath
          ) {
            loadConfig.specDraftModelPath = selectedModel.draftModelPath;
          }
          const port = await loadModel(
            loadConfig,
            curSettings.llamaServerPath,
            curSettings.llamaPortRangeMin,
            curSettings.llamaPortRangeMax,
            thinkingTagOverride,
          );
          return jsonResponse({ port });
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          return jsonResponse({ error: errorMsg, code: "LOAD_FAILED" }, 500);
        }
      }

      if (req.method === "POST" && url.pathname === "/api/server/unload") {
        void requestUnloadModel().catch((err: unknown) => {
          logError("Background unload failed:", err);
        });
        return jsonResponse({ success: true });
      }

      if (req.method === "GET" && url.pathname === "/api/server/status") {
        return jsonResponse(getServerStatus());
      }

      if (req.method === "GET" && url.pathname === "/api/hardware") {
        const hw = await getHardwareInfoImpl();
        return jsonResponse(hw);
      }

      if (req.method === "POST" && url.pathname === "/api/hardware/optimize") {
        const body = await readJsonObject(req);
        if (body instanceof Response) return body;
        const modelPath = getStringField(body, "modelPath");
        if (!modelPath) {
          return badRequest("hardware/optimize requires a valid modelPath string.");
        }
        const { getMetadataForPath } = await import("./persistence/chatRepo");
        const { optimizeLoadConfig } = await import("./optimizer");

        const hw = await getHardwareInfo();
        const metadata = await getMetadataForPath(modelPath);
        if (!metadata) return new Response("Model metadata not found", { status: 404 });

        const optimized = optimizeLoadConfig(hw, metadata);
        return jsonResponse(optimized);
      }

      if (req.method === "GET" && url.pathname === "/api/settings") {
        const s = await loadSettings();
        return jsonResponse(s);
      }

      if (req.method === "PUT" && url.pathname === "/api/settings") {
        const body = await readJsonObject(req);
        if (body instanceof Response) return body;
        const { InvalidSettingsError, saveSettings } = await import("./persistence/settingsRepo");
        try {
          await saveSettings(body);
          return jsonResponse({ success: true });
        } catch (err: unknown) {
          if (err instanceof InvalidSettingsError) {
            return badRequest(err.message);
          }
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

          let content = "";
          const attachments: File[] = [];
          const contentType = req.headers.get("content-type")?.toLowerCase() || "";

          if (contentType.includes("multipart/form-data")) {
            try {
              const formData = await req.formData();
              content = formData.get("content")?.toString() || "";

              for (const [key, value] of formData.entries()) {
                if (key === "file" && isRequestFile(value)) {
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
            } catch (_formErr) {
              return badRequest("Invalid multipart chat message payload.");
            }
          } else {
            const body = await readJsonObject(req);
            if (body instanceof Response) return body;

            const bodyContent = getStringField(body, "content");
            if (bodyContent !== undefined) {
              content = bodyContent;
            }
          }

          // C4 fix: allow empty content when attachments are present
          if (content.length === 0 && attachments.length === 0) {
            return badRequest("chat message content is required when no attachments are provided.");
          }
          if (content.length > MAX_MESSAGE_CONTENT_LENGTH) {
            return badRequest(
              `Chat messages cannot exceed ${MAX_MESSAGE_CONTENT_LENGTH} characters.`,
            );
          }

          try {
            const { proxyCompletion } = await import("./streamProxy");
            const messageId = await proxyCompletion({ chatId, content, attachments });
            return jsonResponse({ messageId });
          } catch (e: unknown) {
            return jsonResponse(
              { error: e instanceof Error ? e.message : "Chat message send failed." },
              500,
            );
          }
        }
      }

      const { getChats } = await import("./persistence/chatRepo");
      if (req.method === "GET" && url.pathname === "/api/chats") {
        const q = url.searchParams.get("q") || undefined;
        const limit = parseQueryInt(url.searchParams.get("limit"), 300, 1, 1000);
        const offset = parseQueryInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
        if (limit === null || offset === null) {
          return badRequest("limit and offset must be finite integers.");
        }
        const chats = await getChats(q, limit, offset);
        return jsonResponse(chats);
      }

      // Chat CRUD
      const chatRepo = await import("./persistence/chatRepo");
      if (req.method === "POST" && url.pathname === "/api/chats") {
        const body = await readJsonObject(req);
        if (body instanceof Response) return body;
        const name = getStringField(body, "name") || "New Chat";
        const modelPath = getStringField(body, "modelPath");
        const chat = await chatRepo.createChat(name, modelPath);
        return jsonResponse(chat);
      }
      if (url.pathname.startsWith("/api/chats/")) {
        const parts = url.pathname.split("/");
        const id = parts[3] as string;
        if (parts.length === 4) {
          if (req.method === "GET") {
            // M10 fix: support message pagination via query params to avoid
            // loading 10,000+ messages in a single response.
            // Default to last 500 messages; client can pass ?messageLimit=0 for all.
            const messageLimit = parseQueryInt(
              url.searchParams.get("messageLimit"),
              500,
              0,
              10_000,
            );
            const messageOffset = parseQueryInt(
              url.searchParams.get("messageOffset"),
              0,
              0,
              1_000_000,
            );
            const beforeRaw = url.searchParams.get("beforePosition");
            const beforePosition =
              beforeRaw === null || beforeRaw === ""
                ? undefined
                : parseQueryInt(beforeRaw, 0, 0, 1_000_000);
            if (messageLimit === null || messageOffset === null || beforePosition === null) {
              return badRequest(
                "messageLimit, messageOffset, and beforePosition must be finite integers.",
              );
            }
            const chat = await chatRepo.getChat(
              id,
              messageLimit > 0 ? messageLimit : undefined,
              messageOffset > 0 ? messageOffset : undefined,
              beforePosition,
            );
            if (!chat) return new Response("Not Found", { status: 404 });
            return jsonResponse(chat);
          }
          if (req.method === "PUT") {
            const body = await readJsonObject(req);
            if (body instanceof Response) return body;
            await chatRepo.updateChat(id, body);
            return jsonResponse({ success: true });
          }
          if (req.method === "DELETE") {
            try {
              await chatRepo.deleteChat(id);
              return jsonResponse({ success: true });
            } catch (err: unknown) {
              logError("Failed to delete chat", err);
              return jsonResponse(
                {
                  error: err instanceof Error ? err.message : "Failed to delete chat.",
                },
                500,
              );
            }
          }
        }

        if (parts.length === 5 && req.method === "GET" && parts[4] === "prompt-cache") {
          const { getPromptCacheStats } = await import("./promptCache");
          const stats = getPromptCacheStats(id);
          return jsonResponse(stats || { totalEvaluated: 0, totalCached: 0 });
        }

        if (parts.length === 5 && req.method === "POST") {
          const action = parts[4] as string;
          if (action === "branch") {
            const body = await readJsonObject(req);
            if (body instanceof Response) return body;
            const messageId = getStringField(body, "messageId");
            if (!messageId) {
              return badRequest("Branch creation requires a valid messageId.");
            }
            const newId = await chatRepo.createBranch(id, messageId);
            return jsonResponse({ id: newId });
          }
          if (action === "export") {
            const body = await readJsonObject(req);
            if (body instanceof Response) return body;
            const format = getStringField(body, "format") === "markdown" ? "markdown" : "json";
            const exported = await chatRepo.exportChat(id, format);
            return new Response(exported, {
              headers: {
                "Content-Type":
                  format === "markdown"
                    ? "text/markdown; charset=utf-8"
                    : "application/json; charset=utf-8",
              },
            });
          }
          if (action === "regenerate") {
            const chatForRegen = await chatRepo.getChat(id);
            const msgs = chatForRegen?.messages || [];

            if (msgs.length > 0) {
              const lastMsg = msgs[msgs.length - 1];
              if (lastMsg && (lastMsg.role === "assistant" || lastMsg.role === "tool")) {
                // Find the last user message to keep
                let lastUserIdx = msgs.length - 1;
                while (lastUserIdx >= 0) {
                  const currentMessage = msgs[lastUserIdx];
                  if (!currentMessage || currentMessage.role === "user") break;
                  lastUserIdx--;
                }
                const positionToKeep = lastUserIdx >= 0 ? (msgs[lastUserIdx]?.position ?? 0) : 0;
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
            return jsonResponse({ messageId });
          }
          if (action === "continue") {
            const chatForContinue = await chatRepo.getChat(id);
            if (!chatForContinue) {
              return jsonResponse({ error: "Chat not found" }, 404);
            }
            const lastMsg = chatForContinue.messages?.[chatForContinue.messages.length - 1];
            if (!lastMsg || lastMsg.role !== "assistant") {
              return badRequest("Continue requires the last message to be an assistant response.");
            }
            const { proxyCompletion } = await import("./streamProxy");
            const messageId = await proxyCompletion({
              chatId: id,
              content: "",
              attachments: [],
              isContinue: true,
            });
            return jsonResponse({ messageId });
          }
          if (action === "branch-and-regenerate") {
            const body = await readJsonObject(req);
            if (body instanceof Response) return body;
            const requestedMessageId = getStringField(body, "messageId");
            if (!requestedMessageId) {
              return badRequest("branch-and-regenerate requires a valid messageId.");
            }

            // We need to branch from the user message BEFORE the assistant message we are regenerating
            const chatForRegen = await chatRepo.getChat(id);
            const msgs = chatForRegen?.messages || [];
            let branchPoint = requestedMessageId;
            const msgIdx = msgs.findIndex((m) => m.id === branchPoint);

            const selectedMessage = msgIdx >= 0 ? msgs[msgIdx] : undefined;
            if (
              selectedMessage &&
              (selectedMessage.role === "assistant" || selectedMessage.role === "tool")
            ) {
              let lastUserIdx = msgIdx;
              while (lastUserIdx >= 0) {
                const currentMessage = msgs[lastUserIdx];
                if (!currentMessage || currentMessage.role === "user") break;
                lastUserIdx--;
              }
              const branchMessage = lastUserIdx >= 0 ? msgs[lastUserIdx] : undefined;
              if (branchMessage) branchPoint = branchMessage.id;
            }

            const newId = await chatRepo.createBranch(id, branchPoint);
            const { proxyCompletion } = await import("./streamProxy");
            // Regenerate
            const generatedMessageId = await proxyCompletion({
              chatId: newId,
              content: "",
              attachments: [],
              isRegenerate: true,
            });
            return jsonResponse({ id: newId, messageId: generatedMessageId });
          }
          if (action === "branch-and-edit") {
            const body = await readJsonObject(req);
            if (body instanceof Response) return body;
            const requestedMessageId = getStringField(body, "messageId");
            const newContent = getStringField(body, "newContent");
            if (!requestedMessageId || !newContent || newContent.length === 0) {
              return badRequest("branch-and-edit requires a valid messageId and newContent.");
            }
            try {
              const newId = await chatRepo.createBranch(id, requestedMessageId);
              const newChat = await chatRepo.getChat(newId);
              const newMsg = newChat?.messages?.at(-1);

              if (!newMsg) {
                throw new Error("Branched chat is missing its edited message.");
              }

              await chatRepo.updateMessage(newMsg.id, newContent, newContent, undefined);

              const { proxyCompletion } = await import("./streamProxy");
              const generatedMessageId = await proxyCompletion({
                chatId: newId,
                content: "",
                attachments: [],
                isRegenerate: true, // it will regenerate acting from the newly updated last user message
              });
              return jsonResponse({ id: newId, messageId: generatedMessageId });
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Failed to branch and edit chat.";
              const status =
                message === "Chat not found" || message === "Message not found in chat" ? 404 : 500;
              return jsonResponse({ error: message }, status);
            }
          }
          if (action === "branch-and-continue") {
            const body = await readJsonObject(req);
            if (body instanceof Response) return body;
            const requestedMessageId = getStringField(body, "messageId");
            if (!requestedMessageId) {
              return badRequest("branch-and-continue requires a valid messageId.");
            }

            // Fix for branch-and-continue orphan issue:
            // If we are branching from an assistant message, we must also include
            // any immediately following tool messages in the branch to maintain state integrity.
            const chatForBranch = await chatRepo.getChat(id);
            const msgs = chatForBranch?.messages || [];
            let branchPoint = requestedMessageId;
            const msgIdx = msgs.findIndex((m) => m.id === branchPoint);

            const selectedMessage = msgIdx >= 0 ? msgs[msgIdx] : undefined;
            if (selectedMessage?.role === "assistant") {
              let forwardIdx = msgIdx + 1;
              while (forwardIdx < msgs.length) {
                const forwardMessage = msgs[forwardIdx];
                if (forwardMessage?.role !== "tool") break;
                branchPoint = forwardMessage.id;
                forwardIdx++;
              }
            }

            const newId = await chatRepo.createBranch(id, branchPoint);
            const { proxyCompletion } = await import("./streamProxy");
            const generatedMessageId = await proxyCompletion({
              chatId: newId,
              content: "",
              attachments: [],
              isContinue: true,
            });
            return jsonResponse({ id: newId, messageId: generatedMessageId });
          }
        }
        if (parts.length === 6 && parts[4] === "messages") {
          const msgId = parts[5] as string;
          if (req.method === "PUT") {
            const body = await readJsonObject(req);
            if (body instanceof Response) return body;
            const content = getStringField(body, "content");
            if (!content) {
              return badRequest("Message update requires a content string.");
            }
            await chatRepo.updateMessage(
              msgId,
              content,
              content,
              getStringField(body, "thinkingContent"),
            );
            return jsonResponse({ success: true });
          }
          if (req.method === "DELETE") {
            await chatRepo.deleteMessageAndSubsequent(id, msgId);
            return jsonResponse({ success: true });
          }
        }
      }
      if (req.method === "POST" && url.pathname === "/api/chats/import") {
        const contentLength = Number(req.headers.get("content-length") || "0");
        if (contentLength > 50 * 1024 * 1024) {
          return jsonResponse({ error: "Import payload exceeds 50MB." }, 413);
        }
        const body = await readJsonObject(req);
        if (body instanceof Response) return body;
        const importContent = getStringField(body, "content");
        if (!importContent) {
          return badRequest("chat import requires a valid content string.");
        }
        if (importContent.length > 50 * 1024 * 1024) {
          return jsonResponse({ error: "Import payload exceeds 50MB." }, 413);
        }
        try {
          const newId = await chatRepo.importChat(importContent);
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
          if (type === "load") return jsonResponse(await presetRepo.getLoadPresets());
          if (type === "inference") return jsonResponse(await presetRepo.getInferencePresets());
          if (type === "system") return jsonResponse(await presetRepo.getSystemPresets());
          return badRequest("Unknown preset type.");
        }

        if (parts.length === 4 && req.method === "POST") {
          const body = await readJsonObject(req);
          if (body instanceof Response) return body;
          const presetName = getStringField(body, "name");
          if (!presetName || presetName.length === 0) {
            return badRequest("Preset creation requires a name.");
          }
          if (type !== "load" && type !== "inference" && type !== "system") {
            return badRequest("Unknown preset type.");
          }
          if (type === "load") {
            try {
              presetRepo.assertWritableLoadPreset(body);
              await presetRepo.createLoadPreset(
                body as unknown as import("../shared/types").LoadPreset,
              );
            } catch (err: unknown) {
              if (err instanceof presetRepo.PresetValidationError) {
                return badRequest(err.message);
              }
              throw err;
            }
          } else if (type === "inference") {
            await presetRepo.createInferencePreset(
              body as unknown as import("../shared/types").InferencePreset,
            );
          } else {
            await presetRepo.createSystemPreset(
              body as unknown as import("../shared/types").SystemPromptPreset,
            );
          }
          return jsonResponse({ success: true });
        }

        if (parts.length === 5 && req.method === "PUT") {
          const body = await readJsonObject(req);
          if (body instanceof Response) return body;
          if (type !== "load" && type !== "inference" && type !== "system") {
            return badRequest("Unknown preset type.");
          }
          let result: import("./persistence/presetRepo").PresetMutationResult = "updated";
          if (type === "load") {
            try {
              if (body["config"] !== undefined) {
                presetRepo.assertWritableLoadPresetConfig(body["config"]);
              }
              result = await presetRepo.updateLoadPreset(id, body);
            } catch (err: unknown) {
              if (err instanceof presetRepo.PresetValidationError) {
                return badRequest(err.message);
              }
              throw err;
            }
          } else if (type === "inference") {
            result = await presetRepo.updateInferencePreset(id, body);
          } else {
            result = await presetRepo.updateSystemPreset(id, body);
          }
          if (result === "not_found") {
            return jsonResponse({ error: "Preset not found." }, 404);
          }
          return jsonResponse({ success: true });
        }

        if (parts.length === 5 && req.method === "DELETE") {
          if (type !== "load" && type !== "inference" && type !== "system") {
            return badRequest("Unknown preset type.");
          }
          const result =
            type === "load"
              ? await presetRepo.deleteLoadPreset(id)
              : type === "inference"
                ? await presetRepo.deleteInferencePreset(id)
                : await presetRepo.deleteSystemPreset(id);
          if (result === "not_found") {
            return jsonResponse({ error: "Preset not found." }, 404);
          }
          if (result === "protected") {
            return jsonResponse({ error: "Preset is protected and cannot be deleted." }, 403);
          }
          return jsonResponse({ success: true });
        }
      }

      // Autoname
      if (req.method === "POST" && url.pathname === "/api/autoname") {
        const body = await readJsonObject(req);
        if (body instanceof Response) return body;
        const chatId = getStringField(body, "chatId");
        if (!chatId) {
          return badRequest("autoname requires a valid chatId.");
        }
        const autoname = await import("./autoname");
        await autoname.triggerAutoname(chatId);
        return jsonResponse({ success: true });
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
          const fileName = path.basename(absPath);
          return new Response(file, {
            headers: {
              "Content-Type": file.type || "application/octet-stream",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "default-src 'none'",
              "Content-Disposition": `attachment; filename="${fileName.replace(/"/g, "")}"`,
            },
          });
        }
        return new Response("Not Found", { status: 404 });
      }

      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      /**
       * Handles inbound WebSocket control frames from the client.
       *
       * @param _ws - WebSocket connection that sent the message.
       * @param message - Raw WebSocket message payload.
       * @returns No return value.
       */
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
              resolveToolApproval(
                frame.toolCallId,
                frame.approved,
                frame.editedArguments,
                frame.chatId,
              );
            });
          }
        } catch (_e) {}
      },
      /**
       * Registers a newly opened WebSocket connection.
       *
       * @param ws - Open WebSocket connection.
       * @returns No return value.
       */
      open(ws: ServerWebSocket<unknown>) {
        addConnection(ws);
      },
      /**
       * Records heartbeat activity from a connected WebSocket client.
       *
       * @param ws - WebSocket connection that responded to a ping.
       * @returns No return value.
       */
      pong(ws: ServerWebSocket<unknown>) {
        // M4 fix: record pong time for heartbeat staleness detection
        recordPong(ws);
      },
      /**
       * Cleans up a closing WebSocket connection and cancels pending approvals tied to disconnected clients.
       *
       * @param ws - WebSocket connection that closed.
       * @returns No return value.
       */
      close(ws: ServerWebSocket<unknown>) {
        removeConnection(ws);
        import("./tools").then(({ cancelPendingApprovals }) => {
          if (getConnectionCount() === 0) {
            cancelPendingApprovals(undefined, "disconnected");
          }
        });
      },
    },
  };
}
