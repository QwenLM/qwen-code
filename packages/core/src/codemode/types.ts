/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolResult } from '../tools/tools.js';
import type { ToolSettlement } from '../tool-executor/types.js';
import type { FirstMcpSuccess } from '../tools/discovery-stats.js';
import { SUPPORTED_IMAGE_MEDIA_TYPES } from '../utils/supportedImageTypes.js';

export interface ProgrammaticContract {
  outputSchema: Record<string, unknown>;
  /** Script-only constraint shown beside the signature, e.g. what the projection rejects. */
  note?: string;
  /** Domain failures such as a process exit code can be useful structured results. */
  acceptsErrorResult?(result: ToolResult): boolean;
  /** A concise domain failure description from the final, post-hook result. */
  errorMessage?(result: ToolResult): string | undefined;
  /** Essential outcome/completeness context, derived from the validated result and the call's arguments. */
  notice?(value: JsonValue, args: JsonObject): string | undefined;
  project(result: ToolResult): JsonValue;
}

/** How a tool is presented to the model, kept apart from how its result is projected. */
export interface ToolExposureHints {
  /** MCP tools: excluded from the inline catalog, reached through tools[name] or mcp_call. */
  namespace?: { kind: 'mcp'; server: string };
  /** mcp_list / mcp_get / mcp_call: discovery for agents that cannot use CodeMode. */
  metaTool?: 'mcp';
  /** Hidden from agents that have CodeMode unless settings say otherwise. */
  defaultDeferred?: boolean;
  /** Always declared, even when a pattern or mode would defer it. */
  pinned?: boolean;
  /** May run for minutes; deferred listings tell the model to expect a running cell. */
  longRunning?: boolean;
  /** Registered, removed and declared only together with the named tool. */
  companionOf?: string;
  /** Declared to the model only; scripts cannot call it, e.g. interactive or orchestrating tools. */
  modelOnly?: boolean;
}

export const MODEL_ONLY_HINTS: ToolExposureHints = Object.freeze({
  modelOnly: true,
});

export const DEFAULT_DEFERRED_HINTS: ToolExposureHints = Object.freeze({
  defaultDeferred: true,
});

/** JSON is the only value boundary between the VM and its host. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const SCRIPT_LIMITS = Object.freeze({
  codeBytes: 128 * 1024,
  memoryBytes: 128 * 1024 * 1024,
  /** Shared runtime's total live workers, including its one idle spare. */
  workers: 4,
  /** FIFO admission wait; also consumes the script's execution budget. */
  workerWaitMs: 60_000,
  calls: 128,
  concurrency: 4,
  argumentBytes: 256 * 1024,
  summaryArgumentBytes: 4 * 1024,
  resultBytes: 1024 * 1024,
  totalResultBytes: 8 * 1024 * 1024,
  outputBytes: 1024 * 1024,
  outputItems: 1000,
  images: 8,
  /** Base64 characters across every image() call of one script. */
  imageBytes: 8 * 1024 * 1024,
  /** Reserve recovery/control information even for a tiny requested report. */
  minOutputTokens: 200,
  defaultOutputTokens: 10000,
  maxOutputTokens: 16000,
  /** Execution budget of every script, separate from polling. */
  cellTimeoutMs: 30 * 60_000,
  defaultYieldMs: 10_000,
  maxYieldMs: 60_000,
  /** Longest uninterrupted stretch of guest execution; catches loops that never await a tool call while the budget is paused. */
  maxSyncMs: 60_000,
  /** searchTools ranks on the host thread, so scripts get a bounded number of searches. */
  searches: 256,
  cleanupMs: 5_000,
});
export const STORE_LIMITS = Object.freeze({
  keys: 256,
  keyChars: 200,
  totalBytes: 4 * 1024 * 1024,
});
/** `toolUseResult.type` of a CodeMode result. */
export const CODE_MODE_RESULT_TYPE = 'code_mode';
export const SCRIPT_STATUSES = [
  'completed',
  'error',
  'incomplete',
  'cancelled',
  'timeout',
  'limit',
] as const;
export type ScriptStatus = (typeof SCRIPT_STATUSES)[number];
export function isFailedScriptStatus(status: ScriptStatus | 'running'): boolean {
  return status !== 'completed' && status !== 'running';
}
export const WORKER_DONE_STATUSES: readonly ScriptStatus[] = [
  'completed',
  'error',
  'incomplete',
  'limit',
  'timeout',
];
export interface ScriptImage {
  mimeType: string;
  /** Base64 without a data: URL prefix. */
  data: string;
}
export const SCRIPT_IMAGE_TYPES: readonly string[] = SUPPORTED_IMAGE_MEDIA_TYPES;
/** Which budget a `limit` status exhausted; selects the report's repair advice. */
export type ScriptLimitKind =
  | 'calls'
  | 'result'
  | 'output'
  | 'images'
  | 'searches';
export const SCRIPT_LIMIT_ERRORS: Record<ScriptLimitKind, string> = {
  calls: 'Tool call limit exceeded',
  result: 'Cumulative tool result limit exceeded',
  output: 'Script output limit exceeded',
  images: 'Script image limit exceeded',
  searches: 'Tool search limit exceeded',
};
export interface ScriptResult {
  status: ScriptStatus;
  output: string[];
  /** image() calls in order; each also leaves a marker line in output. */
  images?: ScriptImage[];
  error?: string;
  errorKind?: ScriptErrorKind;
  limitKind?: ScriptLimitKind;
  /** Transactional scratchpad delta; applied only after successful scope cleanup. */
  storeWrites?: StoreWrite[];
  /** Calls still unsettled at the stop boundary. */
  pendingCalls?: ScriptPendingCall[];
  /** Carried apart from `output` so a poll boundary cannot detach it from the completion. */
  returnValue?: string;
}
/** searchTools usage of one script, for evaluating discovery quality. */
export interface ScriptSearchStats {
  calls: number;
  /** Result-count bucket of each search, as mcp_list reports it. */
  resultBuckets: string[];
  /** Searches restricted to one MCP server. */
  namespaceCalls: number;
  /** Rank of each distinct called tool in the session's earliest search that returned it. */
  calledRanks: number[];
  /** Discovery effort before the session's first successful MCP call, when this script made it. */
  firstMcpSuccess?: FirstMcpSuccess;
}
export type ScriptErrorKind =
  | 'syntax'
  | 'script_exception'
  | 'unhandled_rejection'
  | 'tool_call'
  | 'runtime_start'
  | 'store_restore'
  | 'runtime_transport';
export interface StoreWrite {
  key: string;
  /** Omitted value deletes the key. Null is a stored JSON value. */
  value?: JsonValue;
}
export interface ScriptCallSummary {
  callId: string;
  name: string;
  /** Bounded parameter snapshot for display, not a replayable tool input. */
  args?: JsonObject;
  argsTruncated?: boolean;
  status: 'pending' | 'completed' | 'error' | 'cancelled';
  settlement: ToolSettlement;
  /** False when the call may change files or external state. */
  readOnly: boolean;
  /** Failure category, matching the ToolCallError seen by the script. */
  kind?: string;
  durationMs?: number;
  error?: string;
  /** Informational domain outcome accepted by the programmatic contract. */
  notice?: string;
  filePath?: string;
  /** Image blocks in the result the script received; image() decides whether they are shown. */
  images?: number;
}
export interface ScriptPendingCall {
  id: number;
  name: string;
  phase: 'executing' | 'awaiting_delivery';
}
export interface ScriptToolDescription {
  name: string;
  description: string;
  /** Host-only text searchTools ranks against; defaults to the name and description. */
  searchText?: string;
  /** Owning MCP server; searchTools filters and ranks by it. */
  namespace?: string;
}
/** An MCP server as describeNamespace() returns it. */
export interface ScriptNamespace {
  name: string;
  description?: string;
  instructions?: string;
  tools: string[];
}
/** Code size is validated by CodeModeTool parameter validation. */
export interface ScriptToolSet {
  tools: readonly string[];
  /** Model-visible direct tools, used only for repair hints, never dispatch. */
  directTools?: readonly string[];
  /** Descriptions for the current callable tool snapshot; host functions are excluded. */
  toolCatalog?: readonly ScriptToolDescription[];
  namespaces?: readonly ScriptNamespace[];
}
export interface ScriptRequest extends ScriptToolSet {
  code: string;
  signal: AbortSignal;
  /** Execution budget, at most SCRIPT_LIMITS.cellTimeoutMs. */
  timeoutMs: number;
  onOutput?(text: string): void;
  onImage?(image: ScriptImage): void;
}
export interface ScriptSearchRequest {
  query: string;
  limit: number;
  namespace?: string;
}
export interface ScriptHost {
  call(name: string, args: JsonObject): Promise<JsonValue>;
  /** Reads a local image for image({path}) through the Read tool, so its permissions and hooks apply. */
  readImage?(path: string): Promise<ScriptImage>;
  /** Ranked names for searchTools; the host owns and caches the index. */
  search?(request: ScriptSearchRequest): readonly string[];
  /** Restore state inside the runtime's execution budget and cancellation boundary. */
  storeSnapshot?(): Promise<JsonObject>;
  /** Host-only invalidation when a value never reaches the VM. */
  discardResult?(value: JsonValue): void;
  /** Reports whether a child call is in its permission check, which may wait for a human. */
  subscribeApprovalWait?(listener: (waiting: boolean) => void): () => void;
}
export interface ToolCallFailure {
  kind: string;
  toolName: string;
  callId?: string;
  message: string;
}
export class ScriptToolError extends Error {
  constructor(readonly failure: ToolCallFailure) {
    super(failure.message);
    this.name = 'ToolCallError';
  }
}

/** Control data originates exclusively in the host, never in the guest VM. */
export interface ScriptWorkerData {
  wasm: WebAssembly.Module;
  /** Overrides SCRIPT_LIMITS.maxSyncMs; tests use it to trigger the guard quickly. */
  maxSyncMs?: number;
}
/** Sent once; a prewarmed worker has already created its VM when it arrives. */
export interface ScriptStartMessage extends ScriptToolSet {
  type: 'start';
  code: string;
  storeSnapshot?: JsonObject;
  /** A failed restore disables synchronous load/store without blocking other work. */
  storeError?: string;
  interrupt: SharedArrayBuffer;
}
export type WorkerMessage =
  | {
      type: 'call';
      id: number;
      name: string;
      args: string;
      argumentError?: string;
    }
  | ({ type: 'search'; id: number } & ScriptSearchRequest)
  /** image({path}): settled like a call, but the image goes to the result, not the script. */
  | { type: 'imageFile'; id: number; path: string }
  | { type: 'output'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'received'; id: number }
  | {
      type: 'done';
      status: ScriptStatus;
      error?: string;
      errorKind?: ScriptErrorKind;
      limitKind?: ScriptLimitKind;
      storeWrites?: StoreWrite[];
      pendingCallIds?: number[];
      /** Rendered return value, already counted against the output budget. */
      returnValue?: string;
    };
export interface SettleMessage {
  type: 'settle';
  id: number;
  ok: boolean;
  payload: string;
}
export interface SearchResultMessage {
  type: 'searched';
  id: number;
  names: readonly string[];
}
export type HostMessage = ScriptStartMessage | SettleMessage | SearchResultMessage;
