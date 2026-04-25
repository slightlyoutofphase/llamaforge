# LlamaForge — Comprehensive Implementation Specification

**Project codename:** LlamaForge
**Date:** April 16, 2026
**Runtime:** Bun (backend process manager + IPC server) + React + Vite (frontend SPA served by Bun's built-in HTTP server)
**Language:** TypeScript throughout — zero non-TypeScript runtime code in app (tests may use test-framework CLI helpers)
**Mock/Simulated data policy:** Mocks and simulated data are BANNED in all application source files. Any fake model entries, placeholder responses, or stub inference calls are forbidden. Mocks may only appear inside `*.test.ts` / `*.spec.ts` files as controlled test doubles.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Repository & Toolchain Setup](#2-repository--toolchain-setup)
3. [Dependency Manifest](#3-dependency-manifest)
4. [TypeScript & Formatting Configuration](#4-typescript--formatting-configuration)
5. [Backend: Bun Process Server](#5-backend-bun-process-server)
6. [llama-server Lifecycle Management](#6-llama-server-lifecycle-management)
7. [GGUF Model Scanner & Header Parser](#7-gguf-model-scanner--header-parser)
8. [Prompt Caching Strategy](#8-prompt-caching-strategy)
9. [Chat Template & Jinja Engine Integration](#9-chat-template--jinja-engine-integration)
10. [Thinking Tag Handling & Gemma 4 Variable Image Resolution](#10-thinking-tag-handling--gemma-4-variable-image-resolution)
11. [Context Window Overflow Policies](#11-context-window-overflow-policies)
12. [Streaming Inference Pipeline](#12-streaming-inference-pipeline)
13. [Multimodal File Upload Handling](#13-multimodal-file-upload-handling)
14. [Tool Calling & Structured Output](#14-tool-calling--structured-output)
15. [Frontend Application Architecture](#15-frontend-application-architecture)
16. [State Management](#16-state-management)
17. [UI Layout & Navigation](#17-ui-layout--navigation)
18. [Model Library Panel](#18-model-library-panel)
19. [Model Load / Inference / System Prompt Preset System](#19-model-load--inference--system-prompt-preset-system)
20. [Chat View](#20-chat-view)
21. [Message Actions: Edit, Branch, Regen, Continue](#21-message-actions-edit-branch-regen-continue)
22. [Autonaming](#22-autonaming)
23. [Chat History Sidebar](#23-chat-history-sidebar)
24. [Settings Panel](#24-settings-panel)
25. [Model Load Optimization Feature](#25-model-load-optimization-feature)
26. [Debug & Server Log Console](#26-debug--server-log-console)
27. [Persistence Layer](#27-persistence-layer)
28. [TypeDoc Documentation Standards](#28-typedoc-documentation-standards)
29. [Implementation Phases with Tests](#29-implementation-phases-with-tests)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  User's Browser (localhost)                                         │
│  React SPA (Vite-built, served by Bun HTTP)                         │
│    ├── TanStack Router (file-based, type-safe routes)               │
│    ├── Zustand stores (ephemeral UI + model state)                  │
│    ├── TanStack Query (server-state, cache, refetch)                │
│    └── WebSocket client  ←──────────────────────────────────┐       │
└──────────────────────────────────────┬──────────────────────┼───────┘
                                       │ HTTP REST            │ WS
┌──────────────────────────────────────▼──────────────────────▼───────┐
│  Bun HTTP + WS Server  (src/server/)                                │
│    ├── /api/models          – model index & GGUF metadata           │
│    ├── /api/server/*        – llama-server control endpoints         │
│    ├── /api/chat/*          – chat CRUD, history, presets, export   │
│    ├── /api/hardware        – hardware introspection                │
│    └── WS /ws               – SSE-over-WS proxy for streaming tokens│
└──────────────────────────────────────┬───────────────────────────────┘
                                       │ spawn/kill + stdio/stderr pipe
┌──────────────────────────────────────▼───────────────────────────────┐
│  llama-server child process                                          │
│    Exposes OpenAI-compatible API on 127.0.0.1:DYNAMIC_PORT           │
│    Flags controlled entirely by Bun server at spawn time             │
└──────────────────────────────────────────────────────────────────────┘
```

**Key design decisions:**

- The browser **never** communicates directly with `llama-server`. All traffic is proxied through the Bun server. This allows the Bun layer to intercept and augment requests/responses (thinking-tag parsing, context flow management, prompt caching bookkeeping, autonaming triggers, etc.) without any awareness required in the React layer.
- `llama-server` is launched in single-model mode (not router mode) because llama-server router mode exposes an API for dynamically loading and unloading models, with the router automatically forwarding each request to the appropriate model instance — a design that, as stated in the requirements, precludes per-request system prompt and inference preset switching on already-loaded models. Full model reload via llama-server restart is used instead.
- `llama-server` is bound exclusively to `127.0.0.1` on a randomly-selected free port at startup.
- The Bun server binds to `127.0.0.1:11435` (configurable in settings; default avoids collision with Ollama).

---

## 2. Repository & Toolchain Setup

```
llamaforge/
├── src/
│   ├── server/                  # Bun backend
│   │   ├── index.ts             # Bun.serve() entry point
│   │   ├── router.ts            # route dispatch
│   │   ├── llamaServer.ts       # llama-server lifecycle
│   │   ├── modelScanner.ts      # GGUF directory walker
│   │   ├── ggufReader.ts        # GGUF header parsing via @huggingface/gguf
│   │   ├── chatTemplateEngine.ts# Jinja rendering via @huggingface/jinja
│   │   ├── streamProxy.ts       # SSE proxy + thinking-tag splitter
│   │   ├── promptCache.ts       # cache_prompt bookkeeping
│   │   ├── hardwareProbe.ts     # VRAM/RAM/CPU introspection
│   │   ├── autoname.ts          # autonaming call logic
│   │   ├── persistence/
│   │   │   ├── db.ts            # SQLite via bun:sqlite
│   │   │   ├── chatRepo.ts
│   │   │   ├── presetRepo.ts
│   │   │   └── settingsRepo.ts
│   │   └── types/
│   │       └── server.ts
│   ├── client/                  # React SPA
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── routes/
│   │   ├── components/
│   │   │   ├── chat/
│   │   │   ├── model/
│   │   │   ├── preset/
│   │   │   ├── settings/
│   │   │   ├── sidebar/
│   │   │   ├── toolbar/
│   │   │   └── shared/
│   │   ├── stores/
│   │   ├── hooks/
│   │   ├── lib/
│   │   │   ├── api.ts           # typed fetch wrappers
│   │   │   ├── ws.ts            # WebSocket singleton
│   │   │   └── utils.ts
│   │   └── types/
│   │       └── client.ts
│   └── shared/
│       └── types.ts             # types shared between server and client
├── tests/
│   ├── server/
│   └── client/
├── public/
├── vite.config.ts
├── tsconfig.json
├── tsconfig.server.json
├── .prettierrc
├── biome.json                   # linting (Biome replaces ESLint)
├── bunfig.toml
└── package.json
```

**Entry points:**

- `bun run dev` — starts Vite dev server (client HMR) and Bun backend concurrently via `concurrently` scripts with explicit port signaling for more reliable HMR (the single `bun src/server/index.ts` invocation also spawns the Vite dev server as a child process in development mode).
- `bun run build` — `vite build` compiles client to `dist/client/`; `bun build src/server/index.ts --target bun --outdir dist/server` compiles backend.
- `bun run start` — runs `dist/server/index.js` which serves the built client from `dist/client/`.
- `bun run test` — `bun test` discovers all `*.test.ts` files.

---

## 3. Dependency Manifest

All versions are the latest available on npm as of April 16, 2026, verified from live npm registry results above.

### Runtime dependencies

| Package | Version | Purpose |
|---|---|---|
| `react` | `^19.1.0` | UI framework |
| `react-dom` | `^19.1.0` | DOM renderer |
| `@tanstack/react-router` | `^1.168.22` | Type-safe file-based routing |
| `@tanstack/react-query` | `^5.99.0` | Server-state management / async cache |
| `zustand` | `^5.0.12` | Ephemeral client state |
| `@huggingface/gguf` | `^0.4.2` | GGUF header parsing |
| `@huggingface/jinja` | `^0.5.5` | Jinja chat template rendering |
| `@uiw/react-codemirror` | `^4.25.9` | Code editor for Jinja / JSON template overrides |
| `@codemirror/lang-json` | latest | JSON syntax highlighting in CodeMirror |
| `@codemirror/lang-markdown` | latest | Markdown syntax support |
| `react-markdown` | latest | Markdown rendering in chat messages |
| `remark-gfm` | latest | GFM tables / strikethrough in react-markdown |
| `rehype-highlight` | latest | Code block syntax highlighting |
| `highlight.js` | latest | Syntax highlight engine |
| `react-dropzone` | latest | Drag-and-drop file upload |
| `framer-motion` | latest | Animations |
| `lucide-react` | latest | Icon set |
| `clsx` | latest | Conditional class names |
| `tailwind-merge` | latest | Tailwind class merging |
| `date-fns` | latest | Date formatting for chat history |
| `uuid` | latest | ID generation |
| `mime` | latest | MIME type detection for uploads |
| `pdfjs-dist` | latest | Pure-TypeScript PDF text extraction for multimodal file uploads |

### Dev dependencies

| Package | Version | Purpose |
|---|---|---|
| `vite` | `^8.0.8` | Build tool |
| `@vitejs/plugin-react` | latest | React Fast Refresh |
| `typescript` | `^5.8.0` | TypeScript compiler |
| `@types/react` | `^19.1.0` | React types |
| `@types/react-dom` | `^19.2.3` | React DOM types |
| `@types/uuid` | latest | uuid types |
| `@types/mime` | latest | mime types |
| `tailwindcss` | `^4.1.0` | CSS framework |
| `@tailwindcss/vite` | `^4.1.0` | Tailwind Vite integration |
| `@biomejs/biome` | latest | Linter + formatter (lint only; Prettier handles format) |
| `prettier` | latest | Code formatter |
| `typedoc` | latest | Documentation generator |
| `typedoc-plugin-markdown` | latest | Markdown output for TypeDoc |
| `happy-dom` | latest | DOM environment for Bun test |

**CSS approach:** Tailwind CSS v4 (Vite plugin, no `tailwind.config.ts` file needed — configuration lives in `src/client/styles/globals.css` using `@theme` directive). Tailwind v4's design-token system is used to define the design system (colors, radii, spacing, typography, shadows) in one place.

**No Electron, no separate Node.js runtime, no Docker, no WASM inference.**

---

## 4. TypeScript & Formatting Configuration

### `tsconfig.json` (client — consumed by Vite)

```jsonc
{
  "compilerOptions": {
    "target": "ESNext",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "outDir": "dist/client",
    "rootDir": "src/client",
    "baseUrl": ".",
    "paths": { "@shared/*": ["src/shared/*"] },

    // Mandated flags
    "strict": true,
    "noImplicitAny": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noImplicitThis": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true,
    "noStrictGenericChecks": false,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "useUnknownInCatchVariables": true,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,

    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "skipLibCheck": true
  },
  "include": ["src/client", "src/shared"],
  "exclude": ["node_modules", "dist"]
}
```

### `tsconfig.server.json` (backend — consumed by Bun directly)

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "target": "ESNext",
    "lib": ["ESNext"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "preserve",
    "outDir": "dist/server",
    "rootDir": "src/server",
    "types": ["bun-types"]
  },
  "include": ["src/server", "src/shared"]
}
```

All mandated flags from the specification are present in both configs. `noUncheckedIndexedAccess` means every array/record access is typed as `T | undefined` and must be narrowed before use. `exactOptionalPropertyTypes` means optional properties cannot be assigned `undefined` explicitly unless the type union includes `undefined`. `noPropertyAccessFromIndexSignature` means index-signature properties must be accessed via bracket notation. These constraints are enforced by Biome lint rules in addition to the compiler.

### `.prettierrc`

```json
{
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "semi": true,
  "singleQuote": false,
  "quoteProps": "as-needed",
  "trailingComma": "all",
  "bracketSpacing": true,
  "bracketSameLine": true,
  "arrowParens": "always",
  "proseWrap": "always",
  "endOfLine": "lf"
}
```

A pre-commit hook (via `bun run format` + `bun run lint`) enforces both Prettier and Biome on staged files.

---

## 5. Backend: Bun Process Server

### `src/server/index.ts`

The Bun server is the application's backbone. It:

1. Reads or initialises the SQLite database (via `bun:sqlite`).
2. Runs the model directory scan.
3. Starts `Bun.serve()` with both HTTP and WebSocket handlers.
4. Serves the built Vite SPA from `dist/client/` in production or proxies to Vite dev server in development.

```typescript
/**
 * @packageDocumentation
 * Entry point for the LlamaForge Bun backend server.
 *
 * Initialises the SQLite database, scans the model directory,
 * and starts the HTTP + WebSocket server.
 */
import { serve } from "bun";
import { initDb } from "./persistence/db.js";
import { createRouter } from "./router.js";
import { scanModels } from "./modelScanner.js";
import { loadSettings } from "./persistence/settingsRepo.js";

const settings = await loadSettings();
await initDb();
await scanModels(settings.modelsPath);

const router = createRouter(settings);

serve({
  port: settings.serverPort ?? 11435,
  hostname: "127.0.0.1",
  fetch: router.fetch,
  websocket: router.websocket,
});
```

### HTTP Route Table

| Method | Path | Handler module | Description |
|---|---|---|---|
| `GET` | `/api/models` | `modelScanner` | Returns indexed model list with parsed GGUF metadata |
| `POST` | `/api/server/load` | `llamaServer` | Spawn llama-server with provided load config |
| `POST` | `/api/server/unload` | `llamaServer` | Kill llama-server process |
| `GET` | `/api/server/status` | `llamaServer` | Current load state + active model |
| `GET` | `/api/chats` | `chatRepo` | List all chat sessions |
| `POST` | `/api/chats` | `chatRepo` | Create new chat session |
| `GET` | `/api/chats/:id` | `chatRepo` | Get single chat with full message history |
| `PUT` | `/api/chats/:id` | `chatRepo` | Update chat metadata (name, system prompt preset, etc.) |
| `DELETE` | `/api/chats/:id` | `chatRepo` | Delete chat |
| `POST` | `/api/chats/:id/messages` | `streamProxy` | Send user message → stream assistant response via WS |
| `PUT` | `/api/chats/:id/messages/:msgId` | `chatRepo` | Edit message content |
| `DELETE` | `/api/chats/:id/messages/:msgId` | `chatRepo` | Delete message + all subsequent (for branch/regen) |
| `POST` | `/api/chats/:id/branch` | `chatRepo` | Create branch from message index |
| `POST` | `/api/chats/:id/export` | `chatRepo` | Export chat as JSON or Markdown |
| `POST` | `/api/chats/import` | `chatRepo` | Import chat from JSON |
| `GET` | `/api/presets/load` | `presetRepo` | List model load presets |
| `GET` | `/api/presets/inference` | `presetRepo` | List inference presets |
| `GET` | `/api/presets/system` | `presetRepo` | List system prompt presets |
| `POST/PUT/DELETE` | `/api/presets/*` | `presetRepo` | CRUD for all preset types |
| `GET` | `/api/hardware` | `hardwareProbe` | CPU, RAM, GPU, VRAM info |
| `GET` | `/api/settings` | `settingsRepo` | Get all settings |
| `PUT` | `/api/settings` | `settingsRepo` | Save settings |
| `POST` | `/api/autoname` | `autoname` | Trigger autonaming for a chat session |
| `GET` | `/*` | static | Serve Vite build (prod) or proxy (dev) |

All API responses are `application/json`. Errors return `{ error: string, code: string }` with appropriate HTTP status codes.

### WebSocket Protocol

A single WebSocket connection is maintained per browser session at `/ws`. All streaming inference output is delivered over this channel as newline-delimited JSON frames.

**Frame types (server → client):**

```typescript
// src/shared/types.ts (excerpt)

/** A single streamed token chunk from llama-server. */
export interface WsTokenFrame {
  type: "token";
  chatId: string;
  messageId: string;
  delta: string;
  thinkingDelta?: string; // separated thinking trace content
}

/** Signals end of a generation turn. */
export interface WsStopFrame {
  type: "stop";
  chatId: string;
  messageId: string;
  stopReason: "eos" | "max_tokens" | "stop_string" | "error";
  timings: LlamaTimings;
}

/** Server-side error during streaming. */
export interface WsErrorFrame {
  type: "error";
  chatId: string;
  messageId?: string;
  message: string;
}

/** llama-server log lines forwarded to console panel. */
export interface WsLogFrame {
  type: "log";
  level: "info" | "warn" | "error" | "debug" | "server";
  body: string;
  ts: number;
}

/** Model load/unload status change. */
export interface WsServerStatusFrame {
  type: "server_status";
  status: LlamaServerStatus;
}

/** Autonaming result. */
export interface WsAutonameFrame {
  type: "autoname_result";
  chatId: string;
  name: string;
}

export type WsFrame =
  | WsTokenFrame
  | WsStopFrame
  | WsErrorFrame
  | WsLogFrame
  | WsServerStatusFrame
  | WsAutonameFrame;
```

**Frame types (client → server):**

```typescript
export interface WsCancelFrame {
  type: "cancel";
  chatId: string;
  messageId: string;
}

export type WsClientFrame = WsCancelFrame;
```

---

## 6. llama-server Lifecycle Management

### `src/server/llamaServer.ts`

This module owns the entire lifecycle of the `llama-server` child process. No other module interacts with the process directly.

#### State machine

```
IDLE ──load()──► LOADING ──ready──► RUNNING
                              └──error──► IDLE
RUNNING ──unload()──► UNLOADING ──killed──► IDLE
RUNNING ──switchModel()──► UNLOADING ──killed──► LOADING ──ready──► RUNNING
```

#### Spawn logic

```typescript
/**
 * @module llamaServer
 * Manages the llama-server child process lifecycle.
 * All load, unload, and restart operations pass through this module.
 */

import { type Subprocess } from "bun";
import { type ModelLoadConfig } from "@shared/types.js";
import { findFreePort } from "./utils/network.js";
import { broadcastStatus, broadcastLog } from "./wsHub.js";

let proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
let activePort: number | null = null;
let currentConfig: ModelLoadConfig | null = null;

/**
 * Spawns llama-server with the given load configuration.
 * Resolves when the server signals readiness on its HTTP health endpoint.
 *
 * @param config - Full model load configuration including all CLI flags.
 * @param llamaServerBin - Absolute path to the llama-server binary.
 * @returns The port number on which the spawned server is listening.
 * @throws If the binary is not found, or the server fails to become ready within timeout.
 */
export async function loadModel(
  config: ModelLoadConfig,
  llamaServerBin: string,
): Promise<number> { ... }
```

The flags array is constructed deterministically from `ModelLoadConfig`:

```typescript
/**
 * Builds the CLI argument array for llama-server from a ModelLoadConfig.
 * Every field in ModelLoadConfig maps 1:1 to a documented llama-server flag.
 *
 * @param config - The load configuration.
 * @param port - The port to bind to.
 * @returns Ordered array of CLI arguments.
 */
function buildArgs(config: ModelLoadConfig, port: number): readonly string[] {
  const args: string[] = [
    "--model", config.modelPath,
    "--port", String(port),
    "--host", "127.0.0.1",
    "--ctx-size", String(config.contextSize),
    "--n-gpu-layers", String(config.gpuLayers),
    "--threads", String(config.threads),
    "--batch-size", String(config.batchSize),
    "--ubatch-size", String(config.microBatchSize),
    "--rope-scaling", config.ropeScaling,
    "--rope-freq-base", String(config.ropeFreqBase),
    "--rope-freq-scale", String(config.ropeFreqScale),
    "--cache-type-k", config.kvCacheTypeK,
    "--cache-type-v", config.kvCacheTypeV,
    "--parallel", "1",           // single-user, single slot
    "--cont-batching",           // always enabled for responsiveness
    "--flash-attn",              // always enabled
    "--jinja",                   // required for tool calling (see §13)
  ];

  if (config.mmProjPath !== undefined) {
    args.push("--mmproj", config.mmProjPath);
  }
  if (config.mainGpu !== undefined) {
    args.push("--main-gpu", String(config.mainGpu));
  }
  if (config.tensorSplit !== undefined) {
    args.push("--tensor-split", config.tensorSplit.join(","));
  }
  if (config.mlock) {
    args.push("--mlock");
  }
  if (config.noMmap) {
    args.push("--no-mmap");
  }
  if (config.numa !== undefined) {
    args.push("--numa", config.numa);
  }
  if (config.logLevel !== undefined) {
    args.push("--log-verbosity", String(config.logLevel));
  }
  if (config.seedOverride !== undefined) {
    args.push("--seed", String(config.seedOverride));
  }
  if (config.chatTemplate !== undefined) {
    args.push("--chat-template", config.chatTemplate);
  }
  if (config.chatTemplateFile !== undefined) {
    args.push("--chat-template-file", config.chatTemplateFile);
  }
  // NOTE: --cache-prompt is NOT passed here; prompt caching is handled
  // at the /completion level (cache_prompt: true in request body).
  // See §8 for the full cache_prompt architecture rationale.

  return args;
}
```

**Readiness detection:** After spawning, the module polls `http://127.0.0.1:{port}/health` every 250 ms with a 60-second total timeout. The server is considered ready when it returns HTTP 200. During the poll interval, stderr lines are captured and broadcast as `WsLogFrame` messages.

**stderr / stdout pipe:** `proc.stderr` (a `ReadableStream<Uint8Array>`) is consumed in a `for await` loop. Each line is parsed: if it matches the llama-server JSON log format, it is decoded and re-broadcast; otherwise it is broadcast as a raw `server`-level log frame.

**Unload:** Sends `SIGTERM` to the child process, waits up to 5 seconds for clean exit, then sends `SIGKILL`. After the process exits, `activePort`, `proc`, and `currentConfig` are all set to `null`.

**Model switch (mid-conversation):** The `switchModel()` exported function:
1. Calls `unloadModel()` and awaits it.
2. Calls `loadModel()` with the new config.
3. Returns the new port.

The frontend receives `WsServerStatusFrame` events at each state transition.

#### `ModelLoadConfig` type

```typescript
// src/shared/types.ts

/**
 * All parameters needed to launch llama-server for a single model.
 * Fields map directly to documented llama-server CLI flags.
 */
export interface ModelLoadConfig {
  /** Absolute path to the primary .gguf model file. */
  modelPath: string;
  /** Absolute path to the mmproj .gguf file, if applicable. */
  mmProjPath?: string;
  contextSize: number;
  gpuLayers: number;
  threads: number;
  batchSize: number;
  microBatchSize: number;
  ropeScaling: "none" | "linear" | "yarn";
  ropeFreqBase: number;
  ropeFreqScale: number;
  kvCacheTypeK: "f16" | "f32" | "q8_0" | "q4_0";
  kvCacheTypeV: "f16" | "f32" | "q8_0" | "q4_0";
  mlock: boolean;
  noMmap: boolean;
  mainGpu?: number;
  tensorSplit?: number[];
  numa?: "distribute" | "isolate" | "numactl";
  logLevel?: number;
  seedOverride?: number;
  chatTemplate?: string;
  chatTemplateFile?: string;
}
```

---

## 7. GGUF Model Scanner & Header Parser

### `src/server/modelScanner.ts`

At startup (and on demand via `POST /api/models/rescan`), the scanner walks the user-configured `MODELS_PATH` directory tree using Bun's `Bun.file` + recursive directory enumeration.

#### Directory walk algorithm

```
for each PUBLISHERNAME/ in MODELS_PATH/:
  for each MODELNAME/ in PUBLISHERNAME/:
    collect all *.gguf files in MODELNAME/
    partition into:
      mmproj_files  = files where basename.toUpperCase().includes("MMPROJ")
      primary_files = all other *.gguf files
    if primary_files.length === 0:
      skip this folder entirely (no model to load)
    for each primary in primary_files:
      find matching mmproj:
        search mmproj_files for one whose stem begins with primary.stem
        or, fallback: take the sole mmproj if exactly one exists
      emit ModelEntry { publisher, modelName, primaryPath, mmProjPath? }
```

This satisfies the requirement: if ONLY an MMPROJ file is present in a folder with no primary model, no model entry is emitted for that folder. If both are present, the MMPROJ is automatically associated.

#### GGUF header parsing

The `@huggingface/gguf` package exposes a `gguf()` function that returns `{ metadata, tensorInfos }`. For local files it requires `{ allowLocalFile: true }` in options.

The following metadata keys are extracted for display and preset initialisation:

```typescript
/**
 * Metadata extracted from a GGUF file header for display and default preset population.
 * Keys correspond to GGUF spec constants from gguf-py/gguf/constants.py.
 */
export interface GgufDisplayMetadata {
  /** e.g. "llama", "gemma4", "mistral" — from `general.architecture` */
  architecture: string;
  /** Model name string — from `general.name` */
  name: string;
  /** GGUF file size in bytes */
  fileSizeBytes: number;
  /** Maximum context length — from `{arch}.context_length` */
  contextLength: number | undefined;
  /** Embedding size — from `{arch}.embedding_length` */
  embeddingLength: number | undefined;
  /** Number of attention heads — from `{arch}.attention.head_count` */
  attentionHeadCount: number | undefined;
  /** Number of KV attention heads — from `{arch}.attention.head_count_kv` */
  attentionHeadCountKv: number | undefined;
  /** Number of layers — from `{arch}.block_count` */
  blockCount: number | undefined;
  /** Feed-forward length — from `{arch}.feed_forward_length` */
  feedForwardLength: number | undefined;
  /** Quantisation type string derived from `general.file_type` */
  quantType: string | undefined;
  /** Whether this model has a vision encoder — from `clip.has_vision_encoder` */
  hasVisionEncoder: boolean;
  /** Whether this model has an audio encoder — from `clip.has_audio_encoder` */
  hasAudioEncoder: boolean;
  /** Default temperature from GGUF sampling metadata — from `general.sampling.temperature` if present */
  defaultTemperature: number | undefined;
  /** Default top-k — from `general.sampling.top_k` if present */
  defaultTopK: number | undefined;
  /** Default top-p — from `general.sampling.top_p` if present */
  defaultTopP: number | undefined;
  /** Default min-p — from `general.sampling.min_p` if present */
  defaultMinP: number | undefined;
  /** Default repetition penalty — from `general.sampling.penalty_repeat` if present */
  defaultRepeatPenalty: number | undefined;
  /** Tokenizer chat template string — from `tokenizer.chat_template` */
  chatTemplate: string | undefined;
  /** BOS token string — from `tokenizer.ggml.bos_token_id` cross-referenced with token list */
  bosToken: string | undefined;
  /** EOS token string */
  eosToken: string | undefined;
}
```

The key pattern `{arch}.context_length` is resolved by reading `general.architecture` first, then composing the key. For example, if `general.architecture` is `"llama"`, then the context length key is `"llama.context_length"`.

The `clip.has_vision_encoder` and `clip.has_audio_encoder` keys are read to determine multimodal capabilities. These drive the model switching guard (§19).

All GGUF parsing is done server-side only. The client receives the already-parsed `GgufDisplayMetadata` in API responses. Parsing is done lazily: when the scanner first finds a model, it enqueues the file for parsing. Parsed results are cached in the SQLite model cache table keyed by `(absolutePath, mtime)`.

Here's the full section rewritten cleanly:

---

## 8. Prompt Caching Strategy

### Rationale: `cache_prompt` in llama-server

The `cache_prompt` parameter operates at the **per-request** level in the `/completion` endpoint. When `cache_prompt` is true, the server compares the incoming prompt to the one from the previous completion on the same slot, and only evaluates the "unseen" suffix — the shared prefix tokens are read from the KV cache and not re-evaluated.

`cache_prompt` defaults to `true` in the current llama-server API, so the app explicitly sending it on every request is technically redundant. It is still good practice to send it explicitly for forward-compatibility, since the default has changed before (it was previously `false`).

**Implication for this app:** Because the app uses a single slot (`--parallel 1`), the KV cache state is always that of the previous completion. In a standard conversation this is optimal: each new user message extends the previous context, so the system prompt and all previous turns are already cached and only the new user message tokens need evaluation.

**When caching is invalidated:** The KV cache is invalidated whenever the prompt prefix changes. This occurs on:
- Model switch (new process = no cache).
- System prompt change (changes the beginning of the rendered prompt).
- Message edit that changes a turn that precedes the current position.
- Branch navigation that loads a different conversation history.

**System prompt prefix optimisation:** Because prefix caching only covers the unmodified leading tokens, the system prompt is always rendered first in the Jinja template. This means after the first message in a conversation, the system prompt tokens are always a cached prefix and are never re-evaluated. The app never artificially moves the system prompt out of position.

**The `cache_prompt` / `--cache-reuse` / `n_cache_reuse` distinction:**

`cache_prompt` is a **per-request** body parameter, not a server startup flag. It instructs the server to re-use the KV cache from the previous request on the same slot, so a common prompt prefix does not have to be re-processed — only the differing suffix needs evaluation.

`--cache-reuse` is a **separate, distinct** mechanism. Its corresponding per-request field `n_cache_reuse` sets the minimum chunk size to attempt reusing from the cache via **KV shifting** — a different code path aimed at slightly-changed prompts rather than identical prefixes. It defaults to `0`, which disables it. This is entirely independent of the slot-level prefix caching that `cache_prompt` controls.

In short: `cache_prompt: true` enables standard prefix KV cache reuse at the slot level; `--cache-reuse` (and its per-request counterpart `n_cache_reuse`) governs the separate KV-shifting reuse mechanism with a minimum chunk size threshold. They are **not** the same feature, and neither is a prerequisite for the other.

**`tokens_cached` feedback:** The `tokens_cached` field in the completion response indicates the number of tokens from the prompt that were re-used from the previous completion. This value is forwarded to the UI in the `WsStopFrame` `timings` payload so it can be displayed in the debug console.

## 9. Chat Template & Jinja Engine Integration

### `src/server/chatTemplateEngine.ts`

`@huggingface/jinja` is a minimalistic JavaScript implementation of the Jinja templating engine, specifically designed for parsing and rendering ML chat templates.

The engine is responsible for constructing the complete prompt string from conversation history before sending it to llama-server. This is done in the Bun backend (not the browser) so the rendered prompt never crosses the network boundary to the client.

```typescript
/**
 * @module chatTemplateEngine
 * Renders conversation history into a prompt string using Jinja templates
 * sourced from GGUF metadata or user override.
 */

import { Template } from "@huggingface/jinja";
import { type ChatMessage, type SystemPromptPreset, type ThinkingTagConfig } from "@shared/types.js";

/**
 * Renders a full prompt string for submission to llama-server /completion.
 *
 * @param messages - Ordered array of chat messages including system role if present.
 * @param templateStr - Raw Jinja template string from GGUF or user override.
 * @param addGenerationPrompt - Whether to append the generation-prompt suffix.
 * @param extraVars - Additional template variables (e.g. `enable_thinking`).
 * @returns The fully rendered prompt string.
 */
export function renderPrompt(
  messages: readonly ChatMessage[],
  templateStr: string,
  addGenerationPrompt: boolean,
  extraVars: Record<string, unknown> = {},
): string {
  const template = new Template(templateStr);
  return template.render({
    messages,
    add_generation_prompt: addGenerationPrompt,
    ...extraVars,
  });
}
```

**Template source priority (highest to lowest):**
1. User manual override stored in the active load preset (`loadPreset.chatTemplateOverride`).
2. `tokenizer.chat_template` value read from GGUF header at scan time.
3. llama-server's built-in template (used when `--chat-template` is not passed and GGUF has no template).

When a user override is active and the model is being loaded, the override is passed to llama-server via `--chat-template` flag if it is a named built-in (e.g. `chatml`), or via a temp file written to the OS temp directory and passed via `--chat-template-file` if it is a custom Jinja string.

**Reasoning trace stripping for multi-turn history:** For models with thinking enabled, the thinking block content must be stripped from assistant messages when those messages are re-injected into subsequent prompts (because the model was not trained to see raw thoughts in history outside of specific tool-call scenarios). The engine's `prepareHistoryForRender()` function handles this per-model based on the active `ThinkingTagConfig`.

---

## 10. Thinking Tag Handling & Gemma 4 Variable Image Resolution

### 10.1 Generalized Thinking Tag Handling

The app detects and extracts reasoning/thinking traces from any model that uses delimiters. By default, it looks for `<think>\n` and `</think>\n` tags (common for DeepSeek models). If the model's architecture is identified as `gemma4`, it automatically switches to Gemma 4's native thought delimiters: `<|channel>thought\n` and `<channel|>`.

**History re-injection:** When an assistant turn is stored, the raw full response (including tags) is persisted. When that turn is later rendered into a prompt for a new turn, `prepareHistoryForRender()` strips all thinking blocks from the history. This prevents the model from being confused by its own internal thoughts from previous turns.

**Streaming thinking extraction:**
The proxy accumulates the streamed raw assistant output in `fullRawContent` and re-parses the complete accumulated text with `parseThinkTags()` after each token delta. This separates final `content` from `thinking` content without emitting half-open thinking tags prematurely. Token deltas are emitted to clients as `WsTokenFrame` objects containing both `delta` and `thinkingDelta`.

### 10.2 Gemma 4 Details

For Gemma 4 models specifically:
- **Architecture check:** Detected via `general.architecture === "gemma4"`.
- **Enable Token:** For the legacy `/completion` path, if thinking is enabled and the selected model config exposes an `enableToken`, the proxy appends that token to the rendered prompt. For chat-completion mode, thinking is enabled instead by setting `chat_template_kwargs.enable_thinking = true` and `reasoning_format = "none"`.
- **Variable Image Resolution (VIR):** Gemma 4 supports processing images at varying resolutions (70, 140, 280, 560, 1120 tokens). VIR is selected in the model load preset and mapped to llama-server load-only flags; it is not supplied per attachment at inference time.

## 11. Context Window Overflow Policies

When a chat exceeds the model's context window (`ctx_size`), the Bun proxy applies one of three configurable policies in `src/server/overflow.ts`:

- **StopAtLimit:** No truncation. The request is sent as-is, letting `llama-server` handle the overflow. The proxy still computes token counts, but it does not remove history.
- **TruncateMiddle (Default):**
  - **Protected:** System prompt and the first user message.
  - **Truncated:** Oldest messages after the preserved prefix are removed until the token count fits within `ctx_size` minus a reserved response budget.
  - This preserves the initial objective and early user context while dropping middle history.
- **RollingWindow:**
  - **Protected:** System prompt.
  - **Truncated:** Oldest messages after the system prompt are removed until the limit is met.
  - This behaves like a sliding window that forgets earlier conversation history.

The token estimator uses `getTokens()`, which queries the local llama-server `/tokenize` endpoint when available and falls back to a heuristic of ~1 token per 3.5 characters. It also adds attachment token estimates from the image attachment type heuristic (560 tokens for images, 256 tokens for audio); image resolution is controlled by load-time flags, not per-message budgets.

If truncation still cannot bring the history under the budget, the proxy will finally truncate the last message content itself and prepend it with `[TRUNCATED]\n...\n`.

## 12. Streaming Inference Pipeline

### `src/server/streamProxy.ts`

This module orchestrates the complete request-response cycle for a chat turn.

#### Full flow for a single user message

```
1. Client POSTs to /api/chats/:id/messages
2. streamProxy:
   a. Loads full chat history from DB
   b. Loads active inference preset
   c. Loads active system prompt preset
   d. Calls chatTemplateEngine.prepareHistoryForRender() (strips thinking from history)
   e. Calls chatTemplateEngine.renderPrompt() to get the full prompt string
   f. Constructs the /completion request body:
      {
        prompt: <rendered string>,
        stream: true,
        cache_prompt: true,
        temperature: inferencePreset.temperature,
        top_k: inferencePreset.topK,
        top_p: inferencePreset.topP,
        min_p: inferencePreset.minP,
        repeat_penalty: inferencePreset.repeatPenalty,
        repeat_last_n: inferencePreset.repeatLastN,
        tfs_z: inferencePreset.tfsZ,
        typical_p: inferencePreset.typicalP,
        presence_penalty: inferencePreset.presencePenalty,
        frequency_penalty: inferencePreset.frequencyPenalty,
        mirostat: inferencePreset.mirostat,
        mirostat_tau: inferencePreset.mirostatTau,
        mirostat_eta: inferencePreset.mirostatEta,
        seed: inferencePreset.seed ?? -1,
        n_predict: inferencePreset.maxTokens ?? -1,
        stop: inferencePreset.stopStrings ?? [],
        grammar: structuredOutputPreset?.grammar,  // if active
      }
   g. Sends HTTP POST to llama-server /completion with stream: true
   h. Begins reading the SSE stream from llama-server
   i. For each SSE data line:
      - Parses JSON
      - Runs thinking-tag state machine (§10.1)
      - Constructs WsTokenFrame { type: "token", chatId, messageId, delta, thinkingDelta }
      - Broadcasts frame to the WebSocket connection for this session
      - Appends raw delta to in-memory buffer for the current generation
   j. On stop event:
      - Constructs WsStopFrame with timings
      - Broadcasts WsStopFrame
      - Persists the complete assistant message (rawContent + finalContent) to DB
      - Marks chat as needing autonaming if conditions met (§21)
3. HTTP response to the POST returns immediately with { messageId }
   (streaming occurs out-of-band over WebSocket)
```

**Tool calling / structured output:** When the active inference preset has `toolCallsEnabled: true`, the request is sent to `/v1/chat/completions` instead of `/completion` (the OpenAI-compatible endpoint), because OpenAI-style function calling is supported with the `--jinja` flag. The `messages` array is passed in OpenAI format rather than a rendered string.

**Cancellation:** The client sends a `WsCancelFrame`. The proxy aborts the in-flight fetch to llama-server using an `AbortController` and stores the partially generated content to the database.

**Single-slot constraint:** Because llama-server is started with `--parallel 1`, concurrent inference requests are not possible. The proxy maintains a boolean `isBusy` flag. If a new inference request arrives while busy, it returns HTTP 429 until the current generation completes or is cancelled.

---

## 13. Multimodal File Upload Handling

### Upload flow

```
User drops/selects file(s) in chat input
  → react-dropzone triggers file list
  → Client sends a `FormData` payload containing `content` and file inputs named `file`
  → Bun backend reads each uploaded `File` via `.arrayBuffer()` and saves binary to disk at {APP_DATA}/attachments/{chatId}/{msgId}/
  → Database stores relative path only
  → Inference: `buildContentParts()` resolves stored attachments to local file URLs and builds OpenAI-compatible `image_url` parts without persisting base64 blobs
```

The Bun backend receives the uploaded files and stores them on disk under `{HOME}/.llamaforge/attachments/{chatId}/{messageId}/`. The database stores the relative path. This avoids bloating the SQLite database with binary data and minimizes memory usage during prompt construction.

### Supported file types and handling

| Category | MIME types | Handling |
|---|---|---|
| Images | `image/jpeg`, `image/png`, `image/gif`, `image/webp` | Passed as local file URL `image_url` parts referencing stored `.llamaforge` attachments; VIR is governed by the active model load preset via `--image-max-tokens` |
| Audio | `audio/wav`, `audio/mp3`, `audio/ogg`, `audio/flac`, `audio/webm` | Passed as local file URL `image_url` parts referencing stored `.llamaforge` attachments (requires `clip.has_audio_encoder: true`) |
| Plain text | `text/plain` | Content read and injected as text block in the user message |
| Markdown | `text/markdown` | Same as plain text |
| PDF | `application/pdf` | Extracted text using `pdfjs-dist` (pure-TypeScript PDF parser); injected as text block. Text-extraction path is fully documented in `src/server/multimodal.ts`. |
| Code files | `text/x-python`, etc. | Same as plain text, with filename preserved as context |
| JSON | `application/json` | Same as plain text |
| CSV | `text/csv` | Same as plain text |
| XML | `application/xml`, `text/xml` | Same as plain text |

**Multimodal guard:** When constructing the message, the proxy checks whether the loaded model has the required encoder:
- If an image or audio file is present but the model lacks the corresponding encoder, the attachment is **filtered out** from the prompt.
- A `[System info: Some multimodal attachments were removed because the current active model lacks encoders for them.]` warning is prepended to the user's message text in the prompt to inform the model and maintain context safety.
- This allows switching to vision-incapable models within a multimodal chat without technical failure.

**Model switch guard with multimodal history:** When the user attempts to switch models in a chat that contains image or audio attachments in its history:
- The target model's `GgufDisplayMetadata` is checked.
- If the current history has images and `target.hasVisionEncoder === false`, the switch is blocked with a modal explaining the incompatibility.
- If the current history has audio and `target.hasAudioEncoder === false`, the switch is blocked similarly.
- The block is shown in the UI using the `MultimodalGuardModal` component as a non-dismissible confirmation dialog that lists which messages contain incompatible attachments and requires the user to either select a compatible model or start a new chat.

**Message content part structure** (sent to llama-server via Bun proxy):

For image uploads, the OpenAI-compatible content array format is used:
```json
{
  "role": "user",
  "content": [
    {
      "type": "image_url",
      "image_url": { "url": "file:///home/user/.llamaforge/attachments/<chatId>/<messageId>/image.png" }
    },
    {
      "type": "text",
      "text": "User's text message here"
    }
  ]
}
```

For Gemma 4 VIR, the image budget is configured as model load flags (`--image-min-tokens 70 --image-max-tokens <budget>`). No per-image resolution field is emitted in the request payload; the loaded model is responsible for applying the configured image token range.

For text file uploads, the content is prepended to the user's text message in a clearly demarcated block:
```
--- Attached file: filename.py ---
<file content>
--- End of file ---

User message here
```

---

## 14. Tool Calling & Structured Output

### 13.1 Tool Calling

Tool use requires the `--jinja` flag. The app always starts llama-server with `--jinja` (see §6 spawn logic).

The UI provides a **Tools Editor** panel (see §19) where users can define custom tools as JSON Schema objects. The schema editor uses `@uiw/react-codemirror` with `@codemirror/lang-json` for syntax highlighting and real-time JSON validation.

Each tool definition follows the OpenAI function-calling schema:
```json
{
  "name": "get_weather",
  "description": "Get the current weather for a location.",
  "parameters": {
    "type": "object",
    "properties": {
      "location": { "type": "string", "description": "City name" }
    },
    "required": ["location"]
  }
}
```

When tool calling is enabled for an inference session:
- The proxy sends the request to `/v1/chat/completions` with `tools: [...]` and `tool_choice: "auto"`.
- The response is parsed for `tool_calls` in the assistant message.
- If a tool call is detected, the UI renders it with a dedicated `ToolCard` component showing the function name and arguments.
- The user can inspect, edit, and approve/reject the tool call from the UI before submitting the tool result.
- On approval, the tool result is appended as a `tool` role message and inference continues.
- Custom tool calls (where the user manually supplies the result) are fully supported.

The active tool set is part of the inference preset (saved and loadable).

### 13.2 Structured Output

The inference preset includes an optional `structuredOutput` field:
```typescript
export interface StructuredOutputConfig {
  enabled: boolean;
  /** JSON Schema to constrain output to. */
  schema: Record<string, unknown>;
  /** Compiled GBNF grammar string derived from the schema (cached). */
  grammar: string | undefined;
}
```

A GBNF grammar is generated from the JSON Schema in the Bun backend using a pure-TypeScript JSON-Schema-to-GBNF converter (no native binaries). The grammar is passed as the `grammar` field in the `/completion` request body. The UI exposes a JSON Schema editor (CodeMirror, JSON mode) for defining the schema, with a preview of the resulting grammar.

---

## 15. Frontend Application Architecture

### Technology choices

| Concern | Choice | Rationale |
|---|---|---|
| Routing | `@tanstack/react-router` | Type-safe, file-based, tree-shakeable; no `react-router-dom` legacy patterns |
| Server state | `@tanstack/react-query` | Automatic caching, invalidation, loading/error states for API calls |
| Client state | `zustand` | Minimal, TypeScript-first, no boilerplate; ideal for UI-only ephemeral state |
| Styling | Tailwind CSS v4 | Design-token system in CSS, no runtime overhead |
| Animation | `framer-motion` | Production-grade motion for panel transitions, message entrances |
| Icons | `lucide-react` | Tree-shakeable, consistent, modern iconography |
| Code editors | `@uiw/react-codemirror` | CodeMirror 6 React wrapper; used for Jinja, JSON, and grammar editors |

### Application shell structure

```
<App>
  <QueryClientProvider>
    <RouterProvider>
      <AppShell>
        ├── <Sidebar />               left panel: chat history list
        ├── <MainArea>
        │   ├── <Toolbar />           top bar: model selector, status, settings toggle
        │   ├── <ChatView />          main chat content area
        │   └── <InputBar />          message input + file attach + send
        └── <RightPanel />           model settings, presets (slide-in)
```

**Panel system:** The right panel is a slide-in drawer controlled by a Zustand store flag. It can display:
- Model Library
- Load Preset Editor
- Inference Preset Editor (which includes tool list editing and structured output schema editing)
- System Prompt Preset Editor
- Settings
- Hardware Info (default view when no editor is selected)

Only one right-panel view is active at a time. The left navigation sidebar is always visible in the chat workspace.

### Model Registry / Model Selector

The app has a dedicated Model Registry page powered by `src/client/ModelSelector.tsx`.
- Displays all discovered models in a responsive card grid.
- Each card shows publisher, architecture, file size, active state, and vision/audio capability badges.
- Users can select a per-model load preset from a dropdown. The selected preset is persisted in `localStorage` per model path.
- The Load button is disabled while the server is busy, while generation is active, or if the model is already loaded.
- An unload button is shown when a model is active.
- A full-screen `loading` overlay appears while the server is spawning `llama-server`.
- If the selected model cannot support the current history's attachments, the `MultimodalGuardModal` blocks the load and offers a choice to start a new chat or cancel.

### Settings Panel

The settings panel in `src/client/SettingsPanel.tsx` includes:
- Binary paths: `llama-server` path and model root directory.
- Quick navigation buttons to the preset editors: inference, load, and system prompt.
- Appearance controls: theme (dark/light/system), accent color picker, chat bubble style, font size.
- Toggles: autoname chats, autoload last model, show console on startup.
- Advanced controls: log level, request timeout, networking port range, Bun server port.
- Save button with loading spinner when persistence is pending.

### Hardware Info Panel

The default right-hand panel view is `HardwareInfo`.
- Shows CPU thread count, total system RAM, and detected GPU accelerators.
- GPU cards show backend type and VRAM capacity.
- This panel is hidden on smaller screens and only visible on large viewports.

The app shell also includes:
- A top status bar showing `llama-server` status and a reconnect/disconnect button.
- A dismissible error banner for critical application errors with an optional corrective action button.
- Toast-style notifications in the bottom-right corner for transient user feedback.
- A developer console toggle accessible from the left nav and via the hotkey `Ctrl+` ` (or `Cmd+`` on Mac).

---

## 16. State Management

### Zustand stores (ephemeral, not persisted)

```typescript
// src/client/stores/uiStore.ts
/**
 * @module uiStore
 * Zustand store for ephemeral UI state.
 * Nothing in this store persists across page loads.
 */
interface UiState {
  rightPanelView: RightPanelView | null;
  isConsoleVisible: boolean;
  isGenerating: boolean;
  currentChatId: string | null;
  pendingThinkingBuffer: string;
  pendingContentBuffer: string;
  setRightPanelView: (view: RightPanelView | null) => void;
  toggleConsole: () => void;
  setGenerating: (v: boolean) => void;
  setCurrentChatId: (id: string | null) => void;
  appendTokenDelta: (delta: string, thinkingDelta: string | undefined) => void;
  clearPendingBuffers: () => void;
}
```

```typescript
// src/client/stores/serverStore.ts
/**
 * @module serverStore
 * Zustand store for llama-server status and loaded model info.
 */
interface ServerState {
  status: LlamaServerStatus;
  loadedModel: ModelEntry | null;
  activeLoadPresetId: string | null;
  activeInferencePresetId: string | null;
  activeSystemPresetId: string | null;
  setStatus: (s: LlamaServerStatus) => void;
  setLoadedModel: (m: ModelEntry | null) => void;
  setActivePresets: (load: string | null, inf: string | null, sys: string | null) => void;
}
```

### TanStack Query keys

All server-state (chat list, messages, model list, presets, hardware) is managed through React Query. Invalidation happens when WebSocket frames signal state changes (model loaded, chat renamed, etc.).

```typescript
// src/client/lib/queryKeys.ts
export const queryKeys = {
  models: () => ["models"] as const,
  chats: () => ["chats"] as const,
  chat: (id: string) => ["chats", id] as const,
  presetsLoad: () => ["presets", "load"] as const,
  presetsInference: () => ["presets", "inference"] as const,
  presetsSystem: () => ["presets", "system"] as const,
  hardware: () => ["hardware"] as const,
  settings: () => ["settings"] as const,
  serverStatus: () => ["serverStatus"] as const,
} as const;
```

---

## 17. UI Layout & Navigation

### Design system

The design language is dark-first (light theme switchable in settings) with these principles:
- **Glass morphism** for panels: semi-transparent backgrounds with backdrop blur on floating surfaces.
- **Monochrome base** with a single accent color (configurable; default indigo/violet gradient).
- **Sharp micro-interactions**: streaming token text fades in character-by-character using CSS animation; panel transitions use spring physics (framer-motion).
- **8px grid** for all spacing.
- **14px base font** (inter), 13px for secondary text, 12px for metadata labels.
- **Radii**: 6px for inputs/chips, 10px for cards, 16px for panels.

### Tailwind v4 theme (`src/client/styles/globals.css` excerpt)

```css
@import "tailwindcss";

@theme {
  --color-bg: oklch(12% 0.02 260);
  --color-surface: oklch(16% 0.02 260);
  --color-surface-elevated: oklch(20% 0.025 260);
  --color-border: oklch(28% 0.03 260);
  --color-accent: oklch(65% 0.18 280);
  --color-accent-dim: oklch(50% 0.14 280);
  --color-text-primary: oklch(92% 0.01 260);
  --color-text-secondary: oklch(65% 0.02 260);
  --color-text-muted: oklch(45% 0.015 260);
  --color-error: oklch(62% 0.22 28);
  --color-success: oklch(68% 0.2 145);
  --color-warning: oklch(80% 0.2 75);

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --radius-xl: 24px;

  --font-sans: "Inter Variable", system-ui, sans-serif;
  --font-mono: "JetBrains Mono Variable", "Fira Code", monospace;
}
```

Inter Variable and JetBrains Mono Variable are loaded from `public/fonts/` (bundled with the app, no external CDN calls).

### Accessibility

- All interactive elements have accessible labels.
- Focus management via `tabIndex` and `aria-*` attributes.
- High-contrast mode support via CSS `prefers-contrast` media query.
- Reduced motion support via `prefers-reduced-motion` media query (disables framer-motion animations, uses instant transitions).
- WCAG AA contrast ratio maintained on all text/background combinations.

---

## 18. Model Library Panel

The model library is a right-panel view that lists all discovered models from the `/api/models` endpoint.

### Layout

```
┌─ Model Library ──────────────────────────────────────────────────────┐
│ 🔍 [Search models...]                                 [⟳ Rescan]    │
│                                                                      │
│ ▼ PUBLISHER_A                                                        │
│   ▼ ModelName-7B                                                     │
│     ○ modelname-7b-Q4_K_M.gguf                                       │
│       Architecture: llama   Quant: Q4_K_M   Size: 4.12 GB           │
│       Context: 32768   Layers: 32   Heads: 32                        │
│       Vision: ✓ [badge]   Audio: ✗                                          │
│       [Load]  [Load with preset ▾]                                   │
│   ▼ ModelName-13B                                                    │
│     ○ modelname-13b-Q5_K_M.gguf        [LOADED ●]                   │
│       ...                                                            │
│ ▼ PUBLISHER_B                                                        │
│   ...                                                                │
└──────────────────────────────────────────────────────────────────────┘
```

- The tree is collapsible per publisher and per model name.
- Each GGUF entry shows: file size (formatted), architecture, quantisation type, context length, block count, attention head counts, vision encoder presence, audio encoder presence.
- The currently loaded model is indicated with a green dot and "LOADED" badge.
- The "Load" button opens the Load Preset Editor pre-populated with defaults for that model.
- The "Load with preset ▾" button opens a dropdown of saved load presets for that model.
- Search filters the tree in real-time.
- "Rescan" triggers `POST /api/models/rescan` and invalidates the `models` query key.

---

## 19. Model Load / Inference / System Prompt Preset System

### Preset types

```typescript
/**
 * A preset for model loading parameters.
 * Stored in SQLite and associated with a model path.
 */
export interface LoadPreset {
  id: string;
  name: string;
  modelPath: string;
  isDefault: boolean;
  isReadonly: boolean;  // true for auto-generated "Default from GGUF" preset
  config: ModelLoadConfig;
  /** Optional Jinja template override string. Stored and used on load. */
  chatTemplateOverride?: string;
  /** Optional thinking tag config override. */
  thinkingTagOverride?: ThinkingTagConfig;
  createdAt: number;
  updatedAt: number;
}

/**
 * A preset for inference (sampling) parameters.
 * Not tied to a model — switchable without unloading.
 */
export interface InferencePreset {
  id: string;
  name: string;
  /** If set, this preset is the auto-generated default for the given model path. */
  sourceModelPath?: string;
  isDefault: boolean;
  temperature: number;
  topK: number;
  topP: number;
  minP: number;
  repeatPenalty: number;
  repeatLastN: number;
  tfsZ: number;
  typicalP: number;
  presencePenalty: number;
  frequencyPenalty: number;
  mirostat: 0 | 1 | 2;
  mirostatTau: number;
  mirostatEta: number;
  dynaTempRange: number;
  dynaTempExponent: number;
  seed: number;
  maxTokens: number;
  stopStrings: string[];
  toolCallsEnabled: boolean;
  tools: ToolDefinition[];
  structuredOutput: StructuredOutputConfig | undefined;
  createdAt: number;
  updatedAt: number;
}

/**
 * A preset for the system prompt.
 * Switchable without model unload.
 */
export interface SystemPromptPreset {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}
```

### Default preset initialisation on first model load

When a model is loaded for the first time (no existing presets for its path):
1. The GGUF metadata is read from the database.
2. A `LoadPreset` named `"Default (from GGUF)"` is created with:
   - `contextSize` = `metadata.contextLength ?? 4096`
   - `gpuLayers` = result of hardware optimisation (§24) or `0` if not run yet
   - `kvCacheTypeK` = `"f16"`, `kvCacheTypeV` = `"f16"`
   - `chatTemplateOverride` = `metadata.chatTemplate ?? undefined`
   - `thinkingTagOverride` = auto-detected based on architecture
   - All other fields = safe defaults
3. An `InferencePreset` named `"Default (from GGUF)"` is created with:
   - `temperature` = `metadata.defaultTemperature ?? 0.8`
   - `topK` = `metadata.defaultTopK ?? 40`
   - `topP` = `metadata.defaultTopP ?? 0.95`
   - `minP` = `metadata.defaultMinP ?? 0.05`
   - `repeatPenalty` = `metadata.defaultRepeatPenalty ?? 1.1`
   - All other fields = documented llama-server defaults

These presets have `isDefault: true` and `isReadonly: true` and cannot be deleted or directly edited (only duplicated). The duplicate is then editable.

### Preset editors

Each preset type has a dedicated editor component in the right panel.

**Load Preset Editor:**
- Accordion sections: Core (context, GPU layers), Batching, Memory (mlock, no-mmap), RoPE, KV Cache, Advanced (NUMA, main GPU, tensor split).
- Binary path fields at top: llama-server binary path, mmproj path (auto-detected or manual).
- Jinja template override: CodeMirror editor (auto mode based on detected template, markdown-like for Jinja), with "Reset to GGUF default" and "Reset to built-in default" buttons.
- VIR budget: Select the model-wide image token budget for dynamic image resolution, which is mapped to `--image-min-tokens 70` and `--image-max-tokens <value>` at model load time.
- Thinking tag override: Two text inputs for open/close tag strings, one text input for enable token, plus a "Detect from architecture" button.
- Preset name, save, duplicate, delete actions.

**Inference Preset Editor:**
- Sections: Sampling (temp, top-k, top-p, min-p, dynamic temperature), Repetition (repeat penalty, repeat-last-n, TFS-Z, typical-p, presence/frequency penalty), Mirostat, Generation Limits (max tokens, stop strings), Tools (see §13), Structured Output.
- All numeric fields are sliders with adjacent numeric inputs for precision.
- Switching inference presets while a model is loaded: the new preset is applied immediately to all subsequent requests; no restart required.

**System Prompt Preset Editor:**
- A single large text area with an `@uiw/react-codemirror` markdown editor.
- Preset name, save, duplicate, delete.
- A "Use this preset" button in the header sets it as the active system prompt for the current chat.
- The active system prompt is stored per-chat and can be overridden per-chat independently.

---

## 20. Chat View

### Layout

```
┌─ [Chat name] ──────────────────────────────────────────────────────┐
│  [ModelChip: gemma4-E4B 🔵🟣] [InfPresetChip: Default] [SysChip: None] │
│  [SwitchModel ▾]                                                   │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌── user ──────────────────────────────────────────┐            │
│  │  Hello, can you describe this image?  [🖼️ img]   │  [✏️][🌿]  │
│  └──────────────────────────────────────────────────┘            │
│                                                                   │
│  ┌── gemma4-E4B ─────────────────────────────────────┐           │
│  │  ▸ [thinking...] (collapsed by default, click=expand)         │
│  │  The image shows a mountain range at dusk...      │           │
│  │                                          [✏️][🌿][🔄][→]    │
│  └──────────────────────────────────────────────────┘            │
│                                                                   │
│  [streaming... █]                                                 │
│                                                                   │
├───────────────────────────────────────────────────────────────────┤
│  [📎] [🖼️] [🎵]   [                   message input             ]  │
│                                             [Send]             │
└───────────────────────────────────────────────────────────────────┘
```

### Model chip & switching

The top toolbar of the chat view shows three chips:
1. **Model chip:** Name of the loaded model. Clicking it opens the Model Library panel.
2. **Inference preset chip:** Name of the active inference preset. Clicking opens the Inference Preset Editor.
3. **System prompt chip:** Name of the active system prompt preset (or "None"). Clicking opens the System Prompt Preset Editor.

**Switching models mid-conversation:**
1. User clicks the model chip and selects a different model from the library.
2. The multimodal guard runs (§12) — if blocked, an explanatory modal is shown.
3. If permitted, the Bun backend calls `switchModel()` (§6), which kills the current llama-server process and spawns a new one with the new model.
4. During transition, the chat input is disabled and a full-page `WsServerStatusFrame`-driven loader reads "Loading [model name]...".
5. On success, the chat state is unchanged — all previous messages remain. Subsequent messages are sent to the new model.
6. The model chip updates to show the new model.

**Inference preset switching:** Clicking the inference preset chip and selecting a different preset updates `serverStore.activeInferencePresetId`. The next inference request uses the new preset. No model restart required.

**System prompt switching:** Same pattern as inference preset. The selected preset updates the system prompt rendered in the next prompt compilation. No model restart required. A toast notification confirms the switch.

### Thinking block rendering

When the stream includes `thinkingDelta` content, it is accumulated into a `<ThinkingBlock>` component that renders above the main response:
- Collapsed by default with a `▸ Thinking (N tokens)` summary row.
- Expandable on click to reveal the full reasoning trace.
- Rendered in the `--font-mono` face at reduced opacity.
- Stored separately in the database from the final content.

### Markdown rendering

Assistant messages are rendered using `react-markdown` with `remark-gfm` and `rehype-highlight`. Code blocks display language label + copy button. Tables, blockquotes, and strikethrough are all supported.

### Streaming rendering

During generation, tokens are appended to the `pendingContentBuffer` in the `uiStore`. The `ChatView` renders this buffer directly using a `StreamingMessage` component that updates on each frame via a Zustand subscription. A blinking cursor `█` is shown at the insertion point. After the `WsStopFrame` is received, the final message replaces the streaming buffer from the React Query cache (which is invalidated by the stop event).

### Context & generation stats

The chat input area shows live generation statistics when available:
- `Context: <used> / <contextSize>` token usage summary.
- `Predicted: <N> tokens` prediction estimate for the current response.
- `Tokens Cached: <N>` when the model reused prompt tokens from the cache.
- A red `Context Window Exceeded` warning appears if the model stops due to context limit.

### Attachment previews

Chat messages render file attachments inline:
- image attachments show thumbnail previews via `/api/attachments/<path>`;
- audio attachments render native HTML audio controls;
- other attachments render as filename pills with document icons.

---

## 21. Message Actions: Edit, Branch, Regen, Continue

### Per-message action toolbar

Each message has an action toolbar that appears on hover (or is always visible on mobile):

| Action | User messages | Assistant messages |
|---|---|---|
| Edit (✏️) | ✓ | ✓ |
| Branch (🌿) | ✓ | ✓ |
| Regenerate (🔄) | ✗ | ✓ |
| Continue (→) | ✗ | ✓ |

### Edit

- Inline editing: clicking Edit replaces the message content with a `<textarea>` pre-filled with the current content.
- On confirm: the message is updated in the database. All messages **after** this one in the conversation are deleted. The edited message becomes the new tail.
- For user messages: if the new content differs, a new assistant response is generated automatically (equivalent to regen after edit).
- For assistant messages: the edited content is saved as-is; no auto-regeneration.

### Branch

- Creates a new `ChatSession` record in the database, copying the conversation up to and including the selected message.
- The user is navigated to the new branch chat.
- The branch appears in the history sidebar with a `🌿` indicator and a link back to the parent chat.

### Regenerate

- Deletes the selected assistant message and all subsequent messages.
- Sends the last user message (now the tail) to the model for a new response.
- The streaming pipeline runs normally.

### Continue

- Appends to the existing assistant message by sending a special prompt where the last assistant turn is open (no EOS appended to the generation prompt).
- The Jinja template is rendered with `add_generation_prompt: false` and the partial assistant content appended after the last assistant token sequence.
- Streaming proceeds and new tokens are appended to the existing assistant message in the database.

---

## 22. Autonaming

### Behaviour

Autonaming runs on chats that:
1. Have not yet been renamed (name is the default `"New Chat"` or timestamp-based initial name).
2. Have at least one complete assistant response in their history.
3. The user is navigating **away** from this chat to any other chat (new or existing).

The autonaming request is triggered client-side: the `useChatNavigation` hook intercepts navigation and, if conditions are met, blocks navigation with a modal overlay reading **"Running Autonaming…"**.

During this block:
- The Bun backend sends a special non-streaming prompt to the currently-loaded llama-server.
- The prompt is constructed as: `[first user message + first assistant response] → "Summarise this conversation in 5 words or fewer as a chat title. Respond with only the title, no punctuation."`.
- The response is trimmed and stored as the chat name.
- A `WsAutonameFrame` is broadcast to the client.
- The navigation blocker resolves and navigation proceeds.

If no model is currently loaded, autonaming is skipped silently and navigation proceeds.

Autonaming can be disabled globally in Settings. When disabled, the "Running Autonaming…" step never occurs.

The inference preset for autonaming is hardcoded: temperature 0.3, top-k 10, max_tokens 20, no stop strings override. This ensures deterministic, short names.

---

## 23. Chat History Sidebar

```
┌─ Chats ──────────────────────────┐
│ [+ New Chat]   [⟳] [Import]      │
│ [🔍 Search...]                   │
├──────────────────────────────────┤
│ ● Today                          │
│   Mountain Image Chat      [⋯]   │
│   🌿 Branch: Mountain (2)  [⋯]   │
│ ● Yesterday                      │
│   TypeScript Help          [⋯]   │
│   Rust vs Go               [⋯]   │
│ ● April 10                       │
│   ...                            │
└──────────────────────────────────┘
```

### Features

- **Search:** Real-time name search via `GET /api/chats?q=...`.
- **Group by date:** Chats are grouped into Today, Yesterday, and previous calendar dates.
- **New Chat:** Prominent `New Chat` button creates a new session and navigates to it immediately.
- **Import:** `Import` button opens a file picker for `.json` exports and POSTs to `/api/chats/import`.
- **Inline actions:** On hover, each chat row reveals buttons for Rename, Export, and Delete.
- **Rename:** Inline text input replaces the chat name on row hover.
- **Export:** Exports the chat as JSON only.
- **Branch indicator:** Branch chats show a `🌿` prefix and render as branches in the list.
- **Active indicator:** The current chat is highlighted with the accent color.
- **Unread badge:** `New` badge appears on chats with unread content.

---

## 24. Settings Panel

The settings panel is a right-panel view with sections:

### Binary Paths
- **llama-server binary path:** Text input for the path to the runnable binary.
- **Models root directory:** Text input for the path to the local GGUF model root.

### Appearance
- Theme: Dark / Light / System.
- Accent color: Color picker (maps to `--color-accent` token).
- Font size: Slider (12px–18px base).
- Chat bubble style: Bubble / Flat / Compact.

### Behaviour
- Autonaming: Toggle on/off.
- Preset management quick links: buttons that open the inference, load, and system prompt preset editors.
- Autoload last model on startup: Toggle.

### Server
- Bun server port: Number input (default 11435).
- llama-server port range: Min/max number inputs for automatic port selection.
- Request timeout: Number input (seconds).

### Debug
- Log level: Dropdown (off, error, warn, info, debug, verbose). Controls both Bun server log verbosity and the `--log-verbosity` flag passed to llama-server.
- Show console on startup: Toggle.

All settings are persisted immediately on change to the SQLite `settings` table and synced via `PUT /api/settings`.

---

## 25. Model Load Optimization Feature

Accessible via the "Optimize for my hardware" button in the Load Preset Editor.

### Hardware probe (`src/server/hardwareProbe.ts`)

The Bun backend queries hardware info at startup:

- **System RAM:** Reads `/proc/meminfo` on Linux; `sysctl hw.memsize` on macOS; WMI via PowerShell on Windows.
- **CPU thread count:** `navigator.hardwareConcurrency` equivalent via Bun's `os.cpus().length`.
- **GPU / VRAM:** On Linux/Windows with NVIDIA: parses `nvidia-smi --query-gpu=memory.total,name --format=csv,noheader`. On macOS: parses `system_profiler SPDisplaysDataType` for Metal GPU info. AMD: parses `rocm-smi` if available.

The binary paths for `nvidia-smi` and `rocm-smi` (and all other probe binaries) are fully exposed and configurable in Settings with strengthened fallbacks (graceful degradation to safe CPU defaults when binaries are unavailable or return errors).

```typescript
export interface HardwareInfo {
  totalRamBytes: number;
  cpuThreads: number;
  gpus: GpuInfo[];
}

export interface GpuInfo {
  name: string;
  vramBytes: number;
  backend: "cuda" | "metal" | "rocm" | "vulkan" | "cpu";
}
```

### Optimization algorithm

Given `HardwareInfo` and a target `GgufDisplayMetadata`, the optimizer computes:

1. **`n-gpu-layers`:** Estimates the VRAM cost per layer from file size / block count. Calculates the max layers that fit in available VRAM minus a configurable overhead margin (default 512 MB). Clamps to `[0, blockCount]`.
2. **`threads`:** Sets to `min(cpuThreads - 1, 8)` to leave one thread for the OS and Bun.
3. **`ctx-size`:** Estimates KV cache VRAM cost as `2 × contextLength × blockCount × headDim × kvElementSize`. Suggests the largest context that fits in remaining VRAM after layer offload. Falls back to 4096 if VRAM-insufficient.
4. **`batch-size`:** Suggests 512 for GPU-accelerated runs, 128 for CPU-only.
5. **`mlock`:** Suggests `true` only if total model file size < available system RAM × 0.5.
6. **`kv cache types`:** Suggests `q8_0` for both K and V when GPU layers > 50% of total, to save VRAM.

The result is displayed as a preview diff against the current preset before the user applies it. The user can apply it as-is, or apply then further customise before saving.

---

## 26. Debug & Server Log Console

A toggleable overlay panel anchored to the bottom of the viewport (hotkey: `` Ctrl+` `` / `` Cmd+` ``).

### Layout

```
┌─ Console ─────────────────────────────────── [Clear] [Copy] [✕] ─┐
│ Filter: [All ▾]   [🔍 Search logs...]                             │
├────────────────────────────────────────────────────────────────────┤
│ 14:23:01 [SERVER] llama_model_loader: loaded meta data with 24... │
│ 14:23:01 [SERVER] llm_load_tensors: VRAM used = 3721.25 MiB       │
│ 14:23:02 [INFO]   Model loaded: gemma-4-E4B-Q4_K_M.gguf          │
│ 14:23:15 [INFO]   Inference started: chat abc123                  │
│ 14:23:15 [SERVER] slot 0 : in-flight tokens: 1 / 32768            │
│ 14:23:16 [DEBUG]  tokens_cached=2847 tokens_evaluated=12          │
└────────────────────────────────────────────────────────────────────┘
```

All `WsLogFrame` messages are appended to a circular buffer in the `uiStore` (max 5000 lines). The console renders only the visible lines using a virtualised list for performance (React 19 built-in `useDeferredValue` + manual virtualisation via `position: absolute` row rendering — no additional virtualisation library required for 5000 items).

Filter dropdown: All, INFO, WARN, ERROR, DEBUG, SERVER.

The log level set in Settings controls which log levels are broadcast by the Bun backend. The console filter only filters already-received logs client-side.

---

## 27. Persistence Layer

### `src/server/persistence/db.ts`

Uses `bun:sqlite` — the native SQLite binding bundled with Bun. No additional SQLite npm packages are needed.

```typescript
/**
 * @module db
 * Initialises the SQLite database used for persisting all application state.
 * Uses bun:sqlite for zero-dependency, high-performance SQLite access.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";

let _db: Database | null = null;

/**
 * Returns the singleton Database instance, creating it if necessary.
 * The database file is stored at {APP_DATA}/llamaforge.db.
 */
export function getDb(): Database { ... }

/**
 * Initialises all database tables with IF NOT EXISTS guards.
 * Safe to call on every startup.
 */
export async function initDb(): Promise<void> { ... }
```

### Schema

```sql
-- Chat sessions
CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT 'New Chat',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  parent_id   TEXT REFERENCES chats(id),  -- for branches
  is_branch   INTEGER NOT NULL DEFAULT 0,
  model_path  TEXT,
  system_preset_id TEXT,
  inference_preset_id TEXT
);

-- Messages within a chat
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  chat_id         TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
  content         TEXT NOT NULL,     -- final display content (thinking stripped)
  raw_content     TEXT NOT NULL,     -- full model output including thinking tags
  thinking_content TEXT,             -- extracted thinking trace only
  position        INTEGER NOT NULL,  -- ordering index within chat
  created_at      INTEGER NOT NULL,
  tool_call_id    TEXT,              -- for tool role messages
  tool_calls_json TEXT              -- serialised tool call array for assistant messages
);

-- Attachments (images, audio, text files)
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mime_type   TEXT NOT NULL,
  file_path   TEXT NOT NULL,  -- relative to APP_DATA/attachments/
  file_name   TEXT NOT NULL,
  vir_budget  INTEGER,        -- legacy attachment column preserved for compatibility; active VIR is configured at model load time
  created_at  INTEGER NOT NULL
);

-- Load presets
CREATE TABLE IF NOT EXISTS load_presets (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  model_path    TEXT NOT NULL,
  is_default    INTEGER NOT NULL DEFAULT 0,
  is_readonly   INTEGER NOT NULL DEFAULT 0,
  config_json   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Inference presets
CREATE TABLE IF NOT EXISTS inference_presets (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  source_model_path TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0,
  config_json   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- System prompt presets
CREATE TABLE IF NOT EXISTS system_presets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- GGUF metadata cache
CREATE TABLE IF NOT EXISTS model_cache (
  file_path   TEXT NOT NULL,
  mtime       INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (file_path, mtime)
);

-- Application settings (single row)
CREATE TABLE IF NOT EXISTS settings (
  id            INTEGER PRIMARY KEY CHECK(id = 1),
  settings_json TEXT NOT NULL
);
```

All queries use prepared statements. All repository functions are typed end-to-end with the shared types. All `SELECT` results are validated against expected shape before being returned (using simple runtime type-narrowing functions, not a full schema validation library).

---

## 28. TypeDoc Documentation Standards

Every file must begin with a `@packageDocumentation` comment. Every exported symbol must have a full JSDoc / TypeDoc comment with:
- One-line summary sentence.
- `@param` for each parameter.
- `@returns` describing the return value.
- `@throws` for documented error conditions.
- `@example` for complex functions.

```typescript
/**
 * @packageDocumentation
 * Chat repository — CRUD operations for chat sessions and messages.
 */

/**
 * Creates a new chat session with default metadata.
 *
 * @param name - Initial display name for the chat. Defaults to `"New Chat"`.
 * @param modelPath - Absolute path to the model that will be used for this chat.
 * @returns The newly created {@link ChatSession} object.
 * @throws {DatabaseError} If the insert fails due to a constraint violation.
 * @example
 * ```typescript
 * const chat = await createChat("My first chat", "/models/llama/llama.gguf");
 * console.log(chat.id); // "a1b2c3d4-..."
 * ```
 */
export async function createChat(
  name: string = "New Chat",
  modelPath: string,
): Promise<ChatSession> { ... }
```

TypeDoc is configured to output to `docs/` with Markdown output (for embedding in README / GitHub wiki). The `typedoc.json` references both `tsconfig.json` and `tsconfig.server.json` entry points so all public symbols are documented in one site.

---

## 29. Implementation Phases with Tests

### Phase 1 — Foundation: Repository, Toolchain, Shared Types, DB

**Deliverables:**
- `package.json`, `tsconfig.json`, `tsconfig.server.json`, `.prettierrc`, `biome.json`, `bunfig.toml`
- `src/shared/types.ts` — all shared interfaces (no implementations)
- `src/server/persistence/db.ts` — `getDb()`, `initDb()`, schema migrations
- `src/server/persistence/settingsRepo.ts` — `loadSettings()`, `saveSettings()`
- `src/server/index.ts` — bare `Bun.serve()` that returns 200 on `GET /health`
- Vite config with Tailwind v4 plugin, path aliases

**Tests (`tests/server/db.test.ts`, `tests/server/settingsRepo.test.ts`):**
```typescript
// Example — all tests must use real SQLite in-memory database, no mocks
import { describe, it, expect, beforeEach } from "bun:test";
import { initDb } from "../../src/server/persistence/db.js";
import { loadSettings, saveSettings } from "../../src/server/persistence/settingsRepo.js";

describe("settingsRepo", () => {
  beforeEach(async () => {
    await initDb(":memory:");
  });

  it("returns default settings when none saved", async () => {
    const s = await loadSettings();
    expect(s.serverPort).toBe(11435);
    expect(s.modelsPath).toBeDefined();
  });

  it("persists and retrieves settings round-trip", async () => {
    await saveSettings({ serverPort: 12345 });
    const s = await loadSettings();
    expect(s.serverPort).toBe(12345);
  });
});
```

Tests for schema: verify all tables are created, foreign key constraints are enforced, the model_cache composite primary key works, and chat `ON DELETE CASCADE` removes child messages.

**Additional Acceptance Criteria (applied across all phases):**
- Full thinking tag support (DeepSeek `<think>` and Gemma 4 formats supported).
- Multi-turn context overflow management (TruncateMiddle, RollingWindow).
- 100% test coverage on thinking and overflow logic.
- Zero non-TypeScript runtime code in the application (strict enforcement of TypeScript-only policy).

**Version pinning constant** (added to `src/server/hardwareProbe.ts` and referenced in tests):
```typescript
export const LLAMA_SERVER_MIN_VERSION = "0.0.0" as const; // updated per release
```

### Phase 2 — Model Scanner & GGUF Parser

**Deliverables:**
- `src/server/modelScanner.ts` — directory walk, MMPROJ association logic
- `src/server/ggufReader.ts` — `parseGgufMetadata()` wrapping `@huggingface/gguf`
- `src/server/persistence/chatRepo.ts` — model cache read/write
- `GET /api/models` endpoint wired

**Tests (`tests/server/modelScanner.test.ts`):**
- Uses a real temporary directory tree created by the test.
- Verifies: sole MMPROJ folder yields no models; primary + MMPROJ in same folder yields one model with `mmProjPath` set; multiple GGUFs in one `MODELNAME` folder yield one entry per GGUF; publisher/model folder structure is correctly parsed.
- `ggufReader.test.ts`: given a small real GGUF file (included in `tests/fixtures/`), verify all metadata keys parse correctly and the `clip.has_vision_encoder` boolean is correctly read.

### Phase 3 — llama-server Lifecycle & Backend API

**Deliverables:**
- `src/server/llamaServer.ts` — full spawn/unload/switch state machine
- `src/server/utils/network.ts` — `findFreePort()`
- `src/server/wsHub.ts` — WebSocket connection registry, broadcast helpers
- `POST /api/server/load`, `POST /api/server/unload`, `GET /api/server/status`
- `GET /api/hardware` + `src/server/hardwareProbe.ts`

**Tests (`tests/server/llamaServer.test.ts`):**
- Integration tests: actually spawns a real `llama-server` binary (path configured via environment variable `TEST_LLAMA_SERVER_BIN`). Tests are skipped if env var is unset.
- Tests: load a small real GGUF, verify health endpoint becomes reachable, verify unload kills the process, verify switch replaces the process.
- Unit tests (no binary): `buildArgs()` is exported as internal for testing and verified to produce correct flag arrays for all `ModelLoadConfig` combinations using snapshot assertions.
- `hardwareProbe.test.ts`: Verifies the probe returns a valid `HardwareInfo` shape with numeric VRAM and thread counts > 0 on the test machine.

### Phase 4 — Chat Template Engine & Prompt Caching

**Deliverables:**
- `src/server/chatTemplateEngine.ts` — `renderPrompt()`, `prepareHistoryForRender()`, `detectThinkingConfig()`
- `src/server/promptCache.ts` — `cache_prompt` accounting, `tokens_cached` tracking
- Full thinking-tag parsing for Gemma 4 and default `<think>`/`</think>` models

**Tests (`tests/server/chatTemplateEngine.test.ts`):**
- Uses `@huggingface/jinja` to render known templates (Llama 3, Gemma 4, ChatML, Mistral) against fixture message arrays and compares output strings to expected snapshots.
- Tests `prepareHistoryForRender()` with Gemma 4 thinking config: verifies `<|channel>thought\n...<channel|>` is stripped from assistant history messages and only the final answer survives.
- Tests the multi-turn stripping: 3-turn conversation with thinking in each assistant turn; verifies all thinking is stripped from turns 1 and 2 while the current turn is left intact.
- Tests `detectThinkingConfig()` for `general.architecture === "gemma4"` returning the correct `GEMMA4_THINKING_CONFIG`.

### Phase 5 — Streaming Inference Pipeline

**Deliverables:**
- `src/server/streamProxy.ts` — full streaming state machine, `cache_prompt` request, thinking-tag splitter, WS broadcast, context overflow application, cancellation
- `POST /api/chats/:id/messages` endpoint
- `src/server/autoname.ts` — autonaming prompt construction + non-streaming call
- `POST /api/autoname` endpoint

**Tests (`tests/server/streamProxy.test.ts`):**
- Integration tests (require `TEST_LLAMA_SERVER_BIN`): send a short user message to a loaded tiny model, verify WS frames arrive in the correct sequence: one or more `WsTokenFrame`, then exactly one `WsStopFrame`.
- Verify `tokens_cached` in `WsStopFrame.timings` is a non-negative integer.
- Verify `thinkingDelta` is populated for a Gemma 4 model when thinking is active, and `delta` contains only post-thinking content.
- Cancellation test: send a message, send a `WsCancelFrame` after the first token, verify the stream stops and the partial message is persisted.
- `autoname.test.ts`: Given a mock WS broadcast (the only place mocking is allowed here — the broadcast sink is the test boundary, not the inference), verify the autonaming prompt is well-formed and the result is stored.

### Phase 6 — Chat CRUD, Presets, History

**Deliverables:**
- `src/server/persistence/chatRepo.ts` — full CRUD for chats, messages, attachments, branches, export/import
- `src/server/persistence/presetRepo.ts` — full CRUD for all three preset types, default-preset initialisation
- `POST /api/chats`, `GET /api/chats`, `GET /api/chats/:id`, `PUT /api/chats/:id`, `DELETE /api/chats/:id`
- `POST /api/chats/:id/branch`, `POST /api/chats/:id/export`, `POST /api/chats/import`
- `GET/POST/PUT/DELETE /api/presets/load|inference|system`

**Tests (`tests/server/chatRepo.test.ts`, `tests/server/presetRepo.test.ts`):**
- Full CRUD coverage for all entities using real in-memory SQLite.
- Branch: verify the branched chat contains the correct subset of messages and `parent_id` is set.
- Export/import round-trip: export a chat to JSON, import it, verify all messages and attachments are identical.
- Default preset initialisation: given GGUF metadata with `defaultTemperature: 0.7`, verify the created `InferencePreset` has `temperature: 0.7`.
- Inference preset switch without model reload: verify the new preset ID is applied to the next request without any llama-server restart.

### Phase 7 — Multimodal Upload & Tool Calling

**Deliverables:**
- `src/server/multimodal.ts` — file storage, local file URL `image_url` construction, content-part construction, multimodal guard
- `src/server/tools.ts` — tool call detection, GBNF grammar generation from JSON Schema
- Attachment upload endpoint integrated into `POST /api/chats/:id/messages`
- `GET/POST /api/presets/inference` updated to include tool definitions

**Tests (`tests/server/multimodal.test.ts`):**
- File storage: verify image, audio, and text files are stored on disk and the relative path is recorded in DB.
- Multimodal guard: verify a model with `hasVisionEncoder: false` rejects a message containing an image attachment.
- VIR load configuration: verify a Gemma 4 load preset with a 560 budget results in llama-server launch flags `--image-min-tokens 70 --image-max-tokens 560`.
- Model switch guard: verify a chat with image history blocks switching to a vision-incapable model.
- `tools.test.ts`: given a JSON Schema for a weather function, verify the GBNF grammar string is a non-empty string and that the `/completion` request body includes it when structured output is enabled.

### Phase 8 — React SPA: Core Shell, Routing, State

**Deliverables:**
- `src/client/main.tsx` — React 19 `createRoot`, `RouterProvider`
- `src/client/App.tsx` — `QueryClientProvider`, WebSocket singleton setup
- `src/client/routes/` — TanStack Router file-based routes: `/` (chat list), `/chat/$chatId`, `/settings`
- `src/client/stores/uiStore.ts`, `src/client/stores/serverStore.ts`
- `src/client/lib/ws.ts` — WebSocket singleton, frame dispatch to Zustand stores
- `src/client/lib/api.ts` — fully typed `fetch` wrappers for all API endpoints
- Tailwind v4 base styles, font imports, global CSS vars

**Tests (`tests/client/stores.test.ts`):**
- Using `happy-dom`: mount the root component, verify initial route renders without errors.
- `uiStore`: verify `appendTokenDelta` correctly accumulates deltas in `pendingContentBuffer` and `pendingThinkingBuffer`.
- `ws.ts`: using a mock WebSocket (allowed in test context), verify frame dispatch calls the correct Zustand actions for each frame type.

### Phase 9 — React SPA: Model Library, Preset Editors, Settings

**Deliverables:**
- `src/client/ModelSelector.tsx` — model registry page, model loading UI, preset selector, multimodal guard modal
- `src/client/components/sidebar/ModelLibraryPanel.tsx` — full tree with publisher/model/file hierarchy, metadata display, load button
- `src/client/components/preset/LoadPresetEditor.tsx` — all accordion sections, Jinja editor (CodeMirror), thinking tag editor
- `src/client/components/preset/InferencePresetEditor.tsx` — all sampling parameters, tool editor, structured output editor
- `src/client/components/preset/SystemPresetEditor.tsx` — CodeMirror markdown editor
- `src/client/SettingsPanel.tsx` — all settings sections
- `src/client/ConsoleLog.tsx` — live server log panel with filter, search, clear, and close controls

**Console Log features:**
- Filter logs by level (`ALL`, `INFO`, `WARN`, `ERROR`, `DEBUG`, `SERVER`).
- Search log text with live filtering.
- Clear log buffer with one click.
- Close button toggles the console panel off.
- Displays prompt cache stats and recent generation cache statistics in the header.
- Uses `useDeferredValue` to keep log rendering smooth without external virtualization libraries.

**Tests (`tests/client/presetEditors.test.ts`):**
- `happy-dom`: render `InferencePresetEditor` with a fixture preset, verify all sliders render with correct initial values.
- Verify that changing the temperature slider triggers a debounced `PUT /api/presets/inference/:id` call (using a `fetch` mock in test context only).
- Verify the "Reset to GGUF default" button in `LoadPresetEditor` resets the Jinja template to the fixture metadata value.

### Phase 10 — React SPA: Chat View, Streaming, Message Actions

**Deliverables:**
- `src/client/components/chat/ChatView.tsx` — full message list, model/preset chips, switch logic
- `src/client/components/chat/MessageBubble.tsx` — role-based styling, markdown rendering, thinking block, attachment display
- `src/client/components/chat/ThinkingBlock.tsx` — collapsible thinking trace
- `src/client/components/chat/StreamingMessage.tsx` — real-time token append
- `src/client/components/chat/MessageActions.tsx` — edit, branch, regen, continue buttons + inline edit textarea
- `src/client/components/chat/InputBar.tsx` — text input, file attach (react-dropzone), send button
- `src/client/components/chat/ModelChip.tsx`, `InferenceChip.tsx`, `SystemChip.tsx`
- `src/client/components/sidebar/ChatSidebar.tsx` — full list, search, inline actions, date groups

**Tests (`tests/client/chatView.test.ts`):**
- `happy-dom`: render `ChatView` with a fixture chat containing user + assistant + thinking messages. Verify:
  - The thinking block is rendered and collapsed by default.
  - Expanding it reveals the thinking content.
  - The assistant message renders the post-thinking content as markdown.
  - The model chip displays the correct model name.
- `InputBar` tests: verify that dropping an image file renders a thumbnail preview. Verify that sending with no loaded model shows an error toast (not a crash).
- `MessageActions` tests: verify Edit button shows textarea with correct content; confirm triggers `PUT /api/chats/:id/messages/:msgId`; cancel restores original content.
- `ChatSidebar` tests: verify search input filters the chat list by name.

### Phase 11 — Hardware Optimization UI, Debug Console, Autonaming UI

**Deliverables:**
- `src/client/components/preset/HardwareOptimizationModal.tsx` — diff preview, apply button
- `src/client/ConsoleLog.tsx` — live log panel with filter, search, clear, and close controls
- `src/client/hooks/useChatNavigation.ts` — autonaming blocker logic
- Autonaming "Running…" modal overlay

**Tests (`tests/client/debugConsole.test.ts`):**
- Render `ConsoleLog` with 200 fixture log entries. Verify filter dropdown reduces visible rows to only entries of the selected level.
- Verify the search input filters by body text.
- `useChatNavigation.test.ts`: mock the `WsAutonameFrame` dispatch; verify that navigating away from a non-named chat with content triggers the blocking overlay and resolves only after the frame arrives.

### Phase 12 — End-to-End Integration Tests

**Tests (`tests/e2e/`):**

All E2E tests require `TEST_LLAMA_SERVER_BIN` and a small real GGUF (`TEST_GGUF_PATH`) set in the environment.

- **Full conversation cycle:** Start server → load model → send 3 messages → verify responses arrive → verify `tokens_cached` > 0 on message 3 → unload model.
- **Model switch mid-chat:** Load model A → send 1 message → switch to model B → send 1 message → verify both messages present in DB with correct model association.
- **System prompt switch:** Load model → set system prompt preset A → send message → switch to preset B → send message → verify prompt B was rendered in second request (inspect stored rawContent).
- **Inference preset switch:** Load model → apply high-temperature preset → regenerate → apply low-temperature preset → regenerate again → verify no server restarts occurred (PID check).
- **Branch:** Create chat, 4 messages → branch at message 2 → verify branch has 2 messages and `parent_id`.
- **Edit + auto-regen:** Edit user message 2 → verify messages 3+ are deleted → verify assistant response auto-generated.
- **Continue:** Generate short response with low `maxTokens` → continue → verify total response length in DB is greater than original.
- **Autonaming:** Create chat → send 1 exchange → navigate away → verify chat name changes from "New Chat".
- **Export/Import round-trip:** Export chat as JSON → delete chat → import → verify all messages and attachments restored.
- **Multimodal guard:** Load non-vision model → attempt to send image attachment → verify 400 error with descriptive message.