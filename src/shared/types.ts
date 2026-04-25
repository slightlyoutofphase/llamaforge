/**
 * @packageDocumentation
 * Shared data structures and WebSocket frame definitions.
 * Provides a unified type system for both server (Bun) and client (Vite).
 */

/**
 * Configuration parameters for loading a GGUF model into llama-server.
 * Maps mostly to CLI flags for fine-tuned control over the inference engine.
 */
export interface ModelLoadConfig {
  /** Absolute path to the main .gguf model file. */
  modelPath: string;
  /** Optional path to a multimodal projection file (for vision/audio). */
  mmProjPath?: string | undefined;
  /** Size of the context window in tokens. */
  contextSize: number;
  /** Whether to enable context shifting (KV cache reuse). */
  contextShift: boolean;
  /** Number of model layers to offload to the GPU. */
  gpuLayers: number;
  /** Number of compute threads. */
  threads: number;
  /** Physical batch size for input processing. */
  batchSize: number;
  /** Logical batch size. */
  microBatchSize: number;
  /** RoPE scaling strategy for extended context. */
  ropeScaling: "none" | "linear" | "yarn";
  /** Base frequency for RoPE. */
  ropeFreqBase: number;
  /** Frequency scale for RoPE. */
  ropeFreqScale: number;
  /** Quantization format for Key cache. */
  kvCacheTypeK: "f16" | "f32" | "q8_0" | "q4_0";
  /** Quantization format for Value cache. */
  kvCacheTypeV: "f16" | "f32" | "q8_0" | "q4_0";
  /** Enable memory locking to prevent swapping. */
  mlock: boolean;
  /** Disable memory mapping (mmap). */
  noMmap: boolean;
  /** Enable Flash Attention if supported by backend. */
  flashAttention: boolean;
  /** ID of the main GPU to use. */
  mainGpu?: number;
  /** Tensor split ratios across multiple GPUs. */
  tensorSplit?: number[];
  /** NUMA (Non-Uniform Memory Access) optimization strategy. */
  numa?: "distribute" | "isolate" | "numactl";
  /** Server log verbosity level. */
  logLevel?: number;
  /** Fixed seed override for reproducibility. */
  seedOverride?: number;
  /** Jinja2 chat template string. */
  chatTemplate?: string;
  /** Path to a file containing a chat template. */
  chatTemplateFile?: string;
  /** Maximum number of image tokens for dynamic image resolution at model load time. */
  imageMaxTokens?: number;
  /** Custom configuration for parsing thinking tags. */
  thinkingTagOverride?: ThinkingTagConfig;
  /** ID of the preset used to generate this config. */
  presetId?: string;
}

/**
 * Metadata extracted from a GGUF file for display and optimization purposes.
 */
export interface GgufDisplayMetadata {
  architecture: string;
  name: string;
  fileSizeBytes: number;
  contextLength: number | undefined;
  embeddingLength: number | undefined;
  attentionHeadCount: number | undefined;
  attentionHeadCountKv: number | undefined;
  blockCount: number | undefined;
  feedForwardLength: number | undefined;
  quantType: string | undefined;
  hasVisionEncoder: boolean;
  hasAudioEncoder: boolean;
  defaultTemperature: number | undefined;
  defaultTopK: number | undefined;
  defaultTopP: number | undefined;
  defaultMinP: number | undefined;
  defaultRepeatPenalty: number | undefined;
  chatTemplate: string | undefined;
  bosToken: string | undefined;
  eosToken: string | undefined;
}

/**
 * Represents a single model file entry in the model library tree.
 */
export interface ModelEntry {
  publisher: string;
  modelName: string;
  primaryPath: string;
  mmProjPath?: string | undefined;
  metadata?: GgufDisplayMetadata | undefined;
}

/**
 * Configuration for parsing and displaying thinking tokens/tags in model responses.
 */
export interface ThinkingTagConfig {
  openTag: string;
  closeTag: string;
  enableToken: string | undefined;
}

/**
 * Status representation tracking the underlying target `llama-server`.
 */
export type LlamaServerStatus = "idle" | "loading" | "running";

/**
 * Performance metrics returned by llama-server after a completion request.
 */
export interface LlamaTimings {
  predicted_ms: number;
  predicted_n: number;
  predicted_per_second: number;
  predicted_per_token_ms: number;
  prompt_ms: number;
  prompt_n: number;
  prompt_per_second: number;
  prompt_per_token_ms: number;
  tokens_cached: number;
  tokens_evaluated: number;
}

/**
 * Websocket packet representation for an incremental generation delta token.
 */
export interface WsTokenFrame {
  type: "token";
  chatId: string;
  messageId: string;
  generationId?: string | undefined;
  delta: string;
  thinkingDelta?: string | undefined;
  tokensCached?: number;
  promptTokens?: number;
  contextSize?: number;
}

/**
 * Websocket packet boundary describing generation completion and final timings.
 */
export interface WsStopFrame {
  type: "stop";
  chatId: string;
  messageId: string;
  generationId?: string | undefined;
  stopReason:
    | "eos"
    | "max_tokens"
    | "stop_string"
    | "error"
    | "contextLengthReached"
    | "tool_calls";
  timings: LlamaTimings;
  promptTokens?: number;
  contextSize?: number;
  fullContent?: string;
  fullRawContent?: string;
  fullThinking?: string;
}

/**
 * Event-driven error packet propagating backend generation context failures explicitly to clients.
 */
export interface WsErrorFrame {
  type: "error";
  chatId: string;
  messageId?: string | undefined;
  generationId?: string | undefined;
  message: string;
}

/**
 * Raw streaming context output payload tracking `stdout/stderr` natively from the target server process.
 */
export interface WsLogFrame {
  type: "log";
  level: "info" | "warn" | "error" | "debug" | "server";
  body: string;
  ts: number;
}

/**
 * Dedicated boundary for UI clients monitoring if a model needs explicit hardware-loading contexts.
 */
export interface WsServerStatusFrame {
  type: "server_status";
  status: LlamaServerStatus;
}

/**
 * Asynchronous response payload for automatically determining short display names for active conversations.
 */
export interface WsAutonameFrame {
  type: "autoname_result";
  chatId: string;
  name: string;
}

/**
 * Trigger packet demanding client-side explicitly verify or populate tool calls asynchronously.
 */
export interface WsToolCallFrame {
  type: "tool_call";
  chatId: string;
  messageId: string;
  generationId?: string | undefined;
  toolCalls: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
}

/**
 * Broadcast wrapper directly sending standard explicitly populated ChatMessage models safely over websocket tunnels.
 */
export interface WsMessageFrame {
  type: "message";
  chatId: string;
  message: ChatMessage;
}

/**
 * Unified type representing all potential messages a server may emit natively across connected websocket channels.
 */
export type WsFrame =
  | WsTokenFrame
  | WsStopFrame
  | WsErrorFrame
  | WsLogFrame
  | WsServerStatusFrame
  | WsAutonameFrame
  | WsToolCallFrame
  | WsMessageFrame;

/**
 * Upstream message representation where clients explicitly demand a stop to an actively executing generation session.
 */
export interface WsCancelFrame {
  type: "cancel";
  chatId: string;
  messageId?: string | undefined;
  generationId?: string | undefined;
}

/**
 * Client submission to explicit interactive tool call queries responding synchronously.
 */
export interface WsToolApprovalFrame {
  type: "tool_approval";
  chatId: string;
  messageId: string;
  toolCallId: string;
  approved: boolean;
  editedArguments?: string | undefined;
}

/**
 * Unified type representing structural inputs parsed over websockets directly to backend servers.
 */
export type WsClientFrame = WsCancelFrame | WsToolApprovalFrame;

/**
 * Configuration payload enabling explicitly formatted JSON definitions mapping functions for standard LLM tool calling contexts.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Specific configuration dictating format compliance boundaries like nested strict object hierarchies via JSON forms.
 */
export interface StructuredOutputConfig {
  enabled: boolean;
  schema: Record<string, unknown>;
  grammar: string | undefined;
}

/**
 * Enumerated strategies for evaluating the context length boundaries explicitly handling model overflow contexts natively.
 */
export type ContextOverflowPolicy = "StopAtLimit" | "TruncateMiddle" | "RollingWindow";

/**
 * Database representation natively governing settings for text completion API parameter bindings natively mapping onto the target inference server.
 */
export interface InferencePreset {
  id: string;
  name: string;
  sourceModelPath?: string | undefined;
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
  contextOverflowPolicy?: ContextOverflowPolicy;
  thinkingEnabled?: boolean;
  thinkingTagOverride?: ThinkingTagConfig;
  createdAt: number;
  updatedAt: number;
}

/**
 * Database record detailing hardware bounds directly mapping physical hardware allocations towards explicit target loaded inference engines natively.
 */
export interface LoadPreset {
  id: string;
  name: string;
  modelPath: string;
  isDefault: boolean;
  isReadonly: boolean;
  config: ModelLoadConfig;
  chatTemplateOverride?: string | undefined;
  createdAt: number;
  updatedAt: number;
}

/**
 * Parameter mapping binding internal templates wrapping specifically how initial system configurations set context for initial chat nodes natively.
 */
export interface SystemPromptPreset {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * A single message entry within a chat session.
 */
export interface ChatMessage {
  id: string;
  chatId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  rawContent: string;
  thinkingContent?: string | undefined;
  position: number;
  createdAt: number;
  toolCallId?: string | undefined;
  toolCallsJson?: string | undefined;
  attachments?: Attachment[] | undefined;
}

/**
 * Upload records capturing standard multi-modal structures physically copied and retained via local `.llamaforge` storage.
 *
 * Attachments are persisted by reference to a relative `filePath`; binary content is not stored in the DB.
 */
export interface Attachment {
  id: string;
  messageId: string;
  mimeType: string;
  filePath: string;
  fileName: string;
  virBudget?: number | undefined;
  createdAt: number;
}

/**
 * A logical chat session containing a sequence of messages.
 */
export interface ChatSession {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  parentId?: string | undefined;
  isBranch: boolean;
  modelPath?: string | undefined;
  systemPresetId?: string | undefined;
  inferencePresetId?: string | undefined;
  messages?: ChatMessage[] | undefined;
}

/**
 * System probe target defining limits and identities of external hardware accelerators globally mapped to explicitly support GPU bounds parsing natively.
 */
export interface GpuInfo {
  name: string;
  vramBytes: number;
  backend: "cuda" | "metal" | "rocm" | "vulkan" | "cpu";
}

/**
 * Overall configuration determining available memory, processing boundaries, and target devices explicitly queried at server boot explicitly.
 */
export interface HardwareInfo {
  totalRamBytes: number;
  cpuThreads: number;
  gpus: GpuInfo[];
}

/**
 * Globally applicable application configuration and UI preferences.
 */
export interface AppSettings {
  serverPort?: number;
  modelsPath: string;
  llamaServerPath?: string;
  theme: "dark" | "light" | "system";
  accentColor: string;
  fontSize: number;
  chatBubbleStyle: "bubble" | "flat" | "compact";
  autonameEnabled: boolean;
  defaultInferencePresetId?: string;
  defaultSystemPromptPresetId?: string;
  autoloadLastModel: boolean;
  llamaPortRangeMin: number;
  llamaPortRangeMax: number;
  requestTimeoutSeconds: number;
  logLevel: "off" | "error" | "warn" | "info" | "debug" | "verbose";
  showConsoleOnStartup: boolean;
  lastLoadConfig?: ModelLoadConfig;
}
