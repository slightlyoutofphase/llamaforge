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
  /** Number of threads to use during batch and prompt processing. Defaults to threads. */
  threadsBatch?: number;
  /** RoPE scaling strategy for extended context. */
  ropeScaling: "none" | "linear" | "yarn";
  /** Base frequency for RoPE. */
  ropeFreqBase: number;
  /** Frequency scale for RoPE. */
  ropeFreqScale: number;
  /** Quantization format for Key cache. */
  kvCacheTypeK: "f16" | "f32" | "bf16" | "q8_0" | "q4_0" | "q4_1" | "iq4_nl" | "q5_0" | "q5_1";
  /** Quantization format for Value cache. */
  kvCacheTypeV: "f16" | "f32" | "bf16" | "q8_0" | "q4_0" | "q4_1" | "iq4_nl" | "q5_0" | "q5_1";
  /** Whether to use unified KV cache shared across sequences. */
  kvUnified?: boolean;
  /** Enable memory locking to prevent swapping. */
  mlock: boolean;
  /** Disable memory mapping (mmap). */
  noMmap: boolean;
  /** Enable continuous batching. */
  contBatching: boolean;
  /** Flash Attention configuration. */
  flashAttn: "on" | "off" | "auto";
  /** Full-size SWA cache. */
  swaFull: boolean;
  /** Disable KV offload. */
  noKvOffload: boolean;
  /** Cache reuse. */
  cacheReuse: number;
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
  /** Path to a file containing a chat template. */
  chatTemplateFile?: string;
  /** Maximum number of image tokens for dynamic image resolution at model load time. */
  imageMaxTokens?: number;
  /** ID of the preset used to generate this config. */
  presetId?: string;
}

/**
 * Metadata extracted from a GGUF file for display and optimization purposes.
 */
export interface GgufDisplayMetadata {
  /** The model architecture, such as "llama" or "mistral". */
  architecture: string;
  /** Canonical model name or display title extracted from GGUF metadata. */
  name: string;
  /** GGUF file size in bytes. */
  fileSizeBytes: number;
  /** Maximum supported token context length for this model. */
  contextLength: number | undefined;
  /** Embedding dimension length, if supported by the model. */
  embeddingLength: number | undefined;
  /** Total number of attention heads in the transformer. */
  attentionHeadCount: number | undefined;
  /** Number of key/value attention heads, if separate from the main attention heads. */
  attentionHeadCountKv: number | undefined;
  /** Number of transformer blocks or layers. */
  blockCount: number | undefined;
  /** Size of the feed-forward network layer. */
  feedForwardLength: number | undefined;
  /** Quantization type string from GGUF metadata. */
  quantType: string | undefined;
  /** Whether the model contains a vision encoder. */
  hasVisionEncoder: boolean;
  /** Whether the model contains an audio encoder. */
  hasAudioEncoder: boolean;
  /** Recommended temperature default from the model metadata. */
  defaultTemperature: number | undefined;
  /** Recommended top-k default. */
  defaultTopK: number | undefined;
  /** Recommended top-p default. */
  defaultTopP: number | undefined;
  /** Recommended minimum top-p default. */
  defaultMinP: number | undefined;
  /** Recommended repeat penalty default. */
  defaultRepeatPenalty: number | undefined;
  /** Optional default chat template from the model metadata. */
  chatTemplate: string | undefined;
  /** Optional beginning-of-sequence token. */
  bosToken: string | undefined;
  /** Optional end-of-sequence token. */
  eosToken: string | undefined;
}

/**
 * Represents a single model file entry in the model library tree.
 */
export interface ModelEntry {
  /** Publisher or namespace for the model. */
  publisher: string;
  /** Model display name. */
  modelName: string;
  /** Absolute path to the primary GGUF model file. */
  primaryPath: string;
  /** Optional path to an associated multimodal projection file. */
  mmProjPath?: string | undefined;
  /** Optional metadata extracted from the GGUF file. */
  metadata?: GgufDisplayMetadata | undefined;
}

/**
 * Configuration for parsing and displaying thinking tokens/tags in model responses.
 */
export interface ThinkingTagConfig {
  /** Opening tag string used to delimit thinking content. */
  openTag: string;
  /** Closing tag string used to delimit thinking content. */
  closeTag: string;
  /** Optional token used to enable thinking tag processing. */
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
  /** Total predicted generation time in milliseconds. */
  predicted_ms: number;
  /** Total predicted token count. */
  predicted_n: number;
  /** Predicted tokens generated per second. */
  predicted_per_second: number;
  /** Average milliseconds per predicted token. */
  predicted_per_token_ms: number;
  /** Time spent evaluating the prompt in milliseconds. */
  prompt_ms: number;
  /** Number of prompt tokens evaluated. */
  prompt_n: number;
  /** Prompt throughput in tokens per second. */
  prompt_per_second: number;
  /** Average milliseconds per prompt token. */
  prompt_per_token_ms: number;
  /** Number of tokens served from cache. */
  tokens_cached: number;
  /** Number of tokens evaluated by the model. */
  tokens_evaluated: number;
}

/**
 * Websocket packet representation for an incremental generation delta token.
 */
export interface WsTokenFrame {
  /** Packet type identifier for a token stream message. */
  type: "token";
  /** Chat session identifier. */
  chatId: string;
  /** Message identifier for the assistant response. */
  messageId: string;
  /** Optional generation session identifier. */
  generationId?: string | undefined;
  /** Delta text emitted by the model. */
  delta: string;
  /** Optional thinking trace delta content. */
  thinkingDelta?: string | undefined;
  /** Optional number of cached tokens in this delta. */
  tokensCached?: number;
  /** Optional prompt token count associated with this packet. */
  promptTokens?: number;
  /** Optional current context size in tokens. */
  contextSize?: number;
}

/**
 * Websocket packet boundary describing generation completion and final timings.
 */
export interface WsStopFrame {
  /** Packet type identifier for a generation stop event. */
  type: "stop";
  /** Chat session identifier. */
  chatId: string;
  /** Message identifier for the completed assistant message. */
  messageId: string;
  /** Optional generation session identifier. */
  generationId?: string | undefined;
  /** Reason the generation stopped. */
  stopReason:
    | "eos"
    | "max_tokens"
    | "stop_string"
    | "error"
    | "contextLengthReached"
    | "tool_calls";
  /** Timing metrics for the completed generation. */
  timings: LlamaTimings;
  /** Optional total prompt tokens used. */
  promptTokens?: number;
  /** Optional context size at stop time. */
  contextSize?: number;
  /** Optional full assembled assistant content. */
  fullContent?: string;
  /** Optional raw content before any normalization. */
  fullRawContent?: string;
  /** Optional thinking trace content captured during generation. */
  fullThinking?: string;
}

/**
 * Event-driven error packet propagating backend generation context failures explicitly to clients.
 */
export interface WsErrorFrame {
  /** Packet type identifier for an error event. */
  type: "error";
  /** Chat session identifier. */
  chatId: string;
  /** Optional message identifier associated with the error. */
  messageId?: string | undefined;
  /** Optional generation session identifier associated with the error. */
  generationId?: string | undefined;
  /** Error message describing the failure. */
  message: string;
}

/**
 * Raw streaming context output payload tracking `stdout/stderr` natively from the target server process.
 */
export interface WsLogFrame {
  /** Packet type identifier for a log event. */
  type: "log";
  /** Severity level for this log entry. */
  level: "info" | "warn" | "error" | "debug" | "server";
  /** Log message body. */
  body: string;
  /** Timestamp when the log was emitted. */
  ts: number;
}

/**
 * Dedicated boundary for UI clients monitoring if a model needs explicit hardware-loading contexts.
 */
export interface WsServerStatusFrame {
  /** Packet type identifier for server-status events. */
  type: "server_status";
  /** Current server status. */
  status: LlamaServerStatus;
}

/**
 * Asynchronous response payload for automatically determining short display names for active conversations.
 */
export interface WsAutonameFrame {
  /** Packet type identifier for an autoname result. */
  type: "autoname_result";
  /** Chat session identifier. */
  chatId: string;
  /** Suggested display name for the chat. */
  name: string;
}

/**
 * Trigger packet demanding client-side explicitly verify or populate tool calls asynchronously.
 */
export interface WsToolCallFrame {
  /** Packet type identifier for a tool call request. */
  type: "tool_call";
  /** Chat session identifier. */
  chatId: string;
  /** Message identifier for the tool call. */
  messageId: string;
  /** Optional generation session identifier. */
  generationId?: string | undefined;
  /** Tool calls included in this request. */
  toolCalls: {
    /** Unique tool call identifier. */
    id: string;
    /** Tool call payload type, always "function". */
    type: "function";
    /** Metadata for invoking the tool function. */
    function: {
      /** Function name to invoke. */
      name: string;
      /** JSON string of tool arguments. */
      arguments: string;
    };
  }[];
}

/**
 * Broadcast wrapper directly sending standard explicitly populated ChatMessage models safely over websocket tunnels.
 */
export interface WsMessageFrame {
  /** Packet type identifier for a chat message event. */
  type: "message";
  /** Chat session identifier. */
  chatId: string;
  /** Chat message payload. */
  message: ChatMessage;
}

/**
 * Unified type representing all potential messages a server may emit natively across connected websocket channels.
 */
export interface WsPresetsUpdatedFrame {
  type: "presets_updated";
}

export type WsFrame =
  | WsTokenFrame
  | WsStopFrame
  | WsErrorFrame
  | WsLogFrame
  | WsServerStatusFrame
  | WsAutonameFrame
  | WsToolCallFrame
  | WsMessageFrame
  | WsPresetsUpdatedFrame;

/**
 * Upstream message representation where clients explicitly demand a stop to an actively executing generation session.
 */
export interface WsCancelFrame {
  /** Packet type identifier for a cancel request. */
  type: "cancel";
  /** Chat session identifier. */
  chatId: string;
  /** Optional message identifier to cancel. */
  messageId?: string | undefined;
  /** Optional generation session identifier to cancel. */
  generationId?: string | undefined;
}

/**
 * Client submission to explicit interactive tool call queries responding synchronously.
 */
export interface WsToolApprovalFrame {
  /** Packet type identifier for tool approval. */
  type: "tool_approval";
  /** Chat session identifier. */
  chatId: string;
  /** Message identifier associated with the approval. */
  messageId: string;
  /** Tool call identifier that is being approved or rejected. */
  toolCallId: string;
  /** Whether the tool call is approved. */
  approved: boolean;
  /** Optional edited tool arguments supplied by the user. */
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
  /** Unique name of the tool. */
  name: string;
  /** Human-readable description of the tool. */
  description: string;
  /** JSON schema parameters for the tool payload. */
  parameters: Record<string, unknown>;
}

/**
 * Specific configuration dictating format compliance boundaries like nested strict object hierarchies via JSON forms.
 */
export interface StructuredOutputConfig {
  /** Whether structured output generation is enabled. */
  enabled: boolean;
  /** Schema used to validate structured output. */
  schema: Record<string, unknown>;
  /** Optional grammar string guiding the structured output format. */
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
  /** Unique preset ID. */
  id: string;
  /** Human-readable inference preset name. */
  name: string;
  /** Optional source model path for this preset. */
  sourceModelPath?: string | undefined;
  /** Whether this preset is the default preset. */
  isDefault: boolean;
  /** Sampling temperature for generation. */
  temperature: number;
  /** Top-k sampling parameter. */
  topK: number;
  /** Top-p sampling parameter. */
  topP: number;
  /** Minimum top-p value for nucleus sampling. */
  minP: number;
  /** Repetition penalty applied during generation. */
  repeatPenalty: number;
  /** Number of tokens to use for repeat penalty history. */
  repeatLastN: number;

  /** Typical p parameter for generation. */
  typicalP: number;
  /** Presence penalty for token selection. */
  presencePenalty: number;
  /** Frequency penalty for token selection. */
  frequencyPenalty: number;
  /** Mirostat algorithm mode. */
  mirostat: 0 | 1 | 2;
  /** Mirostat tau setting. */
  mirostatTau: number;
  /** Mirostat eta setting. */
  mirostatEta: number;
  /** Dynamic temperature range for adaptive sampling. */
  dynaTempRange: number;
  /** Exponent controlling dynamic temperature scaling. */
  dynaTempExponent: number;
  /** DRY sampling multiplier. */
  dryMultiplier?: number;
  /** DRY sampling base value. */
  dryBase?: number;
  /** DRY sampling allowed length. */
  dryAllowedLength?: number;
  /** DRY sampling penalty last N tokens. */
  dryPenaltyLastN?: number;
  /** DRY sampling sequence breakers. */
  drySequenceBreakers?: string[];
  /** XTC token removal probability. */
  xtcProbability?: number;
  /** XTC token removal probability threshold. */
  xtcThreshold?: number;
  /** Random seed for deterministic generation. */
  seed: number;
  /** Maximum token generation length. */
  maxTokens: number;
  /** Strings used to stop generation. */
  stopStrings: string[];
  /** Whether tool calls are enabled for this preset. */
  toolCallsEnabled: boolean;
  /** Available tool definitions for this preset. */
  tools: ToolDefinition[];
  /** Optional structured output configuration. */
  structuredOutput: StructuredOutputConfig | undefined;
  /** Optional policy for context overflow behavior. */
  contextOverflowPolicy?: ContextOverflowPolicy;
  /** Whether thinking tags are enabled. */
  thinkingEnabled?: boolean;
  /** Optional thinking tag override configuration. */
  thinkingTagOverride?: ThinkingTagConfig;
  /** Preset creation timestamp. */
  createdAt: number;
  /** Preset last update timestamp. */
  updatedAt: number;
}

/**
 * Database record detailing hardware bounds directly mapping physical hardware allocations towards explicit target loaded inference engines natively.
 */
export interface LoadPreset {
  /** Unique preset identifier. */
  id: string;
  /** Human-readable load preset name. */
  name: string;
  /** Absolute model path used by this preset. */
  modelPath: string;
  /** Whether this load preset is the default. */
  isDefault: boolean;
  /** Whether this preset is read-only. */
  isReadonly: boolean;
  /** Model load configuration associated with the preset. */
  config: ModelLoadConfig;
  /** Optional custom chat template override. */
  chatTemplateOverride?: string | undefined;
  /** Preset creation timestamp. */
  createdAt: number;
  /** Preset last update timestamp. */
  updatedAt: number;
}

/**
 * Parameter mapping binding internal templates wrapping specifically how initial system configurations set context for initial chat nodes natively.
 */
export interface SystemPromptPreset {
  /** Unique system prompt preset identifier. */
  id: string;
  /** Display name of the system prompt preset. */
  name: string;
  /** System prompt content used for new chats. */
  content: string;
  /** Preset creation timestamp. */
  createdAt: number;
  /** Preset last update timestamp. */
  updatedAt: number;
}

/**
 * A single message entry within a chat session.
 */
export interface ChatMessage {
  /** Unique message identifier. */
  id: string;
  /** Chat session identifier containing the message. */
  chatId: string;
  /** Role of the author for this message. */
  role: "system" | "user" | "assistant" | "tool";
  /** Normalized message content displayed to the client. */
  content: string;
  /** Original raw message content prior to normalization. */
  rawContent: string;
  /** Optional extracted internal thinking content. */
  thinkingContent?: string | undefined;
  /** Position index of the message within the chat history. */
  position: number;
  /** Creation timestamp for the message. */
  createdAt: number;
  /** Optional tool call identifier if the message was generated by a tool. */
  toolCallId?: string | undefined;
  /** Optional raw JSON payload for tool call arguments. */
  toolCallsJson?: string | undefined;
  /** Optional attachments included with this message. */
  attachments?: Attachment[] | undefined;
}

/**
 * Upload records capturing standard multi-modal structures physically copied and retained via local `.llamaforge` storage.
 *
 * Attachments are persisted by reference to a relative `filePath`; binary content is not stored in the DB.
 */
export interface Attachment {
  /** Unique attachment identifier. */
  id: string;
  /** Message identifier that owns this attachment. */
  messageId: string;
  /** Attachment MIME type. */
  mimeType: string;
  /** Local relative file path of the stored attachment. */
  filePath: string;
  /** Original name of the uploaded file. */
  fileName: string;
  /** Optional visible resource budget for the attachment. */
  virBudget?: number | undefined;
  /** Creation timestamp for the attachment record. */
  createdAt: number;
}

/**
 * A logical chat session containing a sequence of messages.
 */
export interface ChatSession {
  /** Unique chat session identifier. */
  id: string;
  /** Display name of the chat session. */
  name: string;
  /** Chat creation timestamp. */
  createdAt: number;
  /** Last update timestamp for the chat. */
  updatedAt: number;
  /** Optional parent chat identifier for branch sessions. */
  parentId?: string | undefined;
  /** Whether this chat is a branch of another chat. */
  isBranch: boolean;
  /** Optional selected model path for the chat. */
  modelPath?: string | undefined;
  /** Optional selected system prompt preset identifier. */
  systemPresetId?: string | undefined;
  /** Optional selected inference preset identifier. */
  inferencePresetId?: string | undefined;
  /** Optional messages stored in this chat session. */
  messages?: ChatMessage[] | undefined;
}

/**
 * System probe target defining limits and identities of external hardware accelerators globally mapped to explicitly support GPU bounds parsing natively.
 */
export interface GpuInfo {
  /** GPU device name. */
  name: string;
  /** Video memory size in bytes. */
  vramBytes: number;
  /** GPU backend platform. */
  backend: "cuda" | "metal" | "rocm" | "vulkan" | "cpu";
}

/**
 * Overall configuration determining available memory, processing boundaries, and target devices explicitly queried at server boot explicitly.
 */
export interface HardwareInfo {
  /** Total system RAM in bytes. */
  totalRamBytes: number;
  /** Number of CPU threads available on the host. */
  cpuThreads: number;
  /** Detected GPU devices. */
  gpus: GpuInfo[];
}

/**
 * Globally applicable application configuration and UI preferences.
 */
export interface AppSettings {
  /** Optional HTTP port for the local server. */
  serverPort?: number;
  /** Absolute path to the model storage directory. */
  modelsPath: string;
  /** Optional path to the llama-server executable. */
  llamaServerPath?: string;
  /** Preferred UI theme. */
  theme: "dark" | "light" | "system";
  /** Accent color used by the application UI. */
  accentColor: string;
  /** Base font size for the UI. */
  fontSize: number;
  /** Chat bubble display style. */
  chatBubbleStyle: "bubble" | "flat" | "compact";
  /** Whether to automatically name new chats. */
  autonameEnabled: boolean;
  /** Default inference preset ID for new chats. */
  defaultInferencePresetId?: string;
  /** Default system prompt preset ID for new chats. */
  defaultSystemPromptPresetId?: string;
  /** Whether the last loaded model should be automatically restored. */
  autoloadLastModel: boolean;
  /** Minimum allowed port for llama-server. */
  llamaPortRangeMin: number;
  /** Maximum allowed port for llama-server. */
  llamaPortRangeMax: number;
  /** Request timeout in seconds for server calls. */
  requestTimeoutSeconds: number;
  /** Application log level. */
  logLevel: "off" | "error" | "warn" | "info" | "debug" | "verbose";
  /** Whether to show the diagnostic console on startup. */
  showConsoleOnStartup: boolean;
  /** Optional last used model load configuration. */
  lastLoadConfig?: ModelLoadConfig;
}
