/**
 * Qwen Code transcript entry types extracted from JSONL session files.
 *
 * Qwen transcripts use telemetry-style events:
 * - `qwen-code.api_response` — successful API call with token usage
 * - `qwen-code.api_error` — failed API call
 * - `qwen-code.tool_call` — tool invocation with duration
 * - Regular messages (user/assistant/system) for conversation context
 */

// ---------------------------------------------------------------------------
// Raw transcript entry shapes (as written to JSONL)
// ---------------------------------------------------------------------------

/** A telemetry event embedded in a transcript line. */
export interface TelemetryEvent {
  'event.name': string;
  'event.timestamp': string;
  [key: string]: unknown;
}

/** System payload wrapping a UI telemetry event. */
export interface SystemPayload {
  uiEvent?: Record<string, unknown>;
}

/** Token usage metadata on assistant message entries. */
export interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

/** A single JSONL line in a qwen transcript. */
export interface TranscriptEntry {
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  type?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  model?: string;
  subtype?: string;
  message?: {
    role?: string;
    parts?: Array<{
      text?: string;
      thought?: boolean;
      functionCall?: { id?: string; name?: string; args?: unknown };
      functionResponse?: { id?: string; name?: string; response?: unknown };
    }>;
  };
  usageMetadata?: UsageMetadata;
  systemPayload?: SystemPayload;
}

// ---------------------------------------------------------------------------
// Parsed stats records (what goes into SQLite)
// ---------------------------------------------------------------------------

/** A parsed API request record. */
export interface ApiRequestRecord {
  /** Unique ID: `<sessionId>:<lineIndex>`. */
  id: string;
  /** Absolute path to the source JSONL file. */
  sessionFile: string;
  /** Session UUID. */
  sessionId: string;
  /** Folder/project path derived from session file location. */
  folder: string;
  /** Model name used for this request. */
  model: string;
  /** Provider name derived from model. */
  provider: string;
  /** Unix timestamp in milliseconds. */
  timestamp: number;
  /** Request duration in ms (from telemetry). */
  durationMs: number | null;
  /** Time to first token in ms (from telemetry). */
  ttftMs: number | null;
  /** Input/prompt tokens. */
  inputTokens: number;
  /** Output/candidate tokens. */
  outputTokens: number;
  /** Cached content tokens. */
  cachedTokens: number;
  /** Thoughts/reasoning tokens. */
  thoughtsTokens: number;
  /** Total tokens. */
  totalTokens: number;
  /** Whether this was an error. */
  isError: boolean;
  /** Error type if isError. */
  errorType: string | null;
  /** HTTP status code if error. */
  errorStatus: number | null;
  /** Response ID from the API. */
  responseId: string | null;
  /** Prompt ID linking request to user turn. */
  promptId: string | null;
}

/** A parsed tool call record. */
export interface ToolCallRecord {
  /** Unique ID: `<sessionId>:<lineIndex>`. */
  id: string;
  /** Absolute path to the source JSONL file. */
  sessionFile: string;
  /** Session UUID. */
  sessionId: string;
  /** Folder/project path. */
  folder: string;
  /** Tool/function name. */
  toolName: string;
  /** Model that was active when tool was called. */
  model: string;
  /** Unix timestamp in milliseconds. */
  timestamp: number;
  /** Tool execution duration in ms. */
  durationMs: number | null;
  /** Whether the tool call succeeded. */
  success: boolean;
  /** Decision type (auto_accept, etc.). */
  decision: string | null;
  /** Prompt ID. */
  promptId: string | null;
}

/** Result of parsing a single session file. */
export interface ParseSessionResult {
  apiRequests: ApiRequestRecord[];
  toolCalls: ToolCallRecord[];
  /** The last byte offset processed (for incremental sync). */
  lastOffset: number;
  /** Number of lines processed. */
  linesProcessed: number;
}
