/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ToolCallRequestInfo,
  ToolCallResponseInfo,
  ToolCallConfirmationDetails,
  ToolResult,
  ToolResultDisplay,
  ToolRegistry,
  EditorType,
  Config,
  ToolConfirmationPayload,
  AnyDeclarativeTool,
  AnyToolInvocation,
  ChatRecordingService,
} from '../index.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  generateToolUseId,
  firePreToolUseHook,
  firePostToolUseHook,
  firePostToolUseFailureHook,
  firePostToolBatchHook,
  fireNotificationHook,
  firePermissionRequestHook,
  appendAdditionalContext,
} from './toolHookTriggers.js';
import { NotificationType } from '../hooks/types.js';
import type { PostToolBatchToolCall } from '../hooks/types.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  truncateLlmContent,
  truncateToolOutput,
  TOOL_OUTPUT_TRUNCATED_PREFIX,
} from '../utils/truncation.js';
import {
  ToolConfirmationOutcome,
  ApprovalMode,
  logToolCall,
  ToolErrorType,
  ToolCallEvent,
  InputFormat,
  Kind,
} from '../index.js';
import type {
  FunctionResponse,
  FunctionResponsePart,
  Part,
  PartListUnion,
} from '@google/genai';
import { fileURLToPath } from 'node:url';
import { ToolNames, ToolNamesMigration } from '../tools/tool-names.js';
import {
  collectAvailableSkillEntries,
  renderAvailableSkillsBlock,
  type AvailableSkillEntry,
} from '../tools/skill-utils.js';
import { escapeSystemReminderTags } from '../utils/xml.js';
import { unescapePath, PATH_ARG_KEYS } from '../utils/paths.js';
import type { MemoryPressureMonitor } from '../services/memoryPressureMonitor.js';
import { CONCURRENCY_SAFE_KINDS } from '../tools/tools.js';
import { isShellCommandReadOnly } from '../utils/shellReadOnlyChecker.js';
import { stripShellWrapper } from '../utils/shell-utils.js';
import {
  isAlreadyTruncated,
  persistAndTruncateToolResult,
} from '../utils/truncation.js';
import {
  injectPermissionRulesIfMissing,
  persistPermissionOutcome,
} from './permission-helpers.js';
import {
  evaluatePermissionFlow,
  getEffectivePermissionForConfirmation,
  needsConfirmation,
  isPlanModeBlocked,
  isAutoEditApproved,
} from './permissionFlow.js';
import {
  applyAutoModeDecision,
  evaluateAutoMode,
  getAutoModePermissionDeniedReason,
  shouldForceAutoModeReviewForAllow,
  shouldFirePermissionDeniedForAutoMode,
  shouldRunAutoModeForCall,
} from '../permissions/autoMode.js';
import { MAX_TRANSCRIPT_MESSAGES } from '../permissions/classifier-transcript.js';
import {
  formatDenialStateLog,
  isApproveOutcome,
  isDenialFallbackReason,
  recordAllow,
  recordFallbackApprove,
  shouldFallback,
} from '../permissions/denialTracking.js';
import { getResponseTextFromParts } from '../utils/generateContentResponseUtilities.js';
import type { ModifyContext } from '../tools/modifiable-tool.js';
import {
  isModifiableDeclarativeTool,
  modifyWithEditor,
} from '../tools/modifiable-tool.js';
import * as Diff from 'diff';
import levenshtein from 'fast-levenshtein';
import { getPlanModeSystemReminder } from './prompts.js';
import { ShellToolInvocation } from '../tools/shell.js';
import { IdeClient } from '../ide/ide-client.js';
import { safeSetStatus } from '../telemetry/tracer.js';
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import {
  startToolSpan,
  endToolSpan,
  runInToolSpanContext,
  startToolExecutionSpan,
  endToolExecutionSpan,
  startToolBlockedOnUserSpan,
  endToolBlockedOnUserSpan,
  startHookSpan,
  endHookSpan,
  addToolInputAttributes,
  addToolResultAttributes,
  truncateSpanError,
  type ToolBlockedDecision,
  type ToolBlockedSource,
  type StartHookSpanOptions,
  type HookSpanMetadata,
} from '../telemetry/index.js';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';
import { acquireSleepInhibitor } from '../services/sleepInhibitor.js';

const debugLogger = createDebugLogger('TOOL_SCHEDULER');

function dedupeRequestsByCallId(
  requests: ToolCallRequestInfo[],
): ToolCallRequestInfo[] {
  const seenCallIds = new Set<string>();
  const deduped: ToolCallRequestInfo[] = [];
  for (const request of requests) {
    if (seenCallIds.has(request.callId)) {
      continue;
    }
    seenCallIds.add(request.callId);
    deduped.push(request);
  }
  return deduped;
}

// Gap between the persistence gate and per-tool truncation thresholds.
// Tools that self-truncate to ~25K add headers bringing output to ~25.4K;
// the headroom ensures the gate only fires for genuinely un-truncated output
// and must exceed the stub size (~2.3K) to avoid cascading re-persistence.
const GATE_HEADROOM = 3000;
const GATE_EXEMPT_TOOLS = new Set(['read_file']);


function extractTextFromPartListUnion(c: PartListUnion): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts = toParts(c);
    return parts.map((p) => p.text ?? '').join('\n');
  }
  if (c && typeof c === 'object') {
    if ('text' in c) {
      const text = (c as { text?: string }).text;
      if (typeof text === 'string') return text;
    }
    if ('functionResponse' in c) {
      const fr = (
        c as {
          functionResponse?: { response?: Record<string, unknown> };
        }
      ).functionResponse;
      const resp = fr?.response;
      if (resp) {
        if (typeof resp['output'] === 'string') return resp['output'];
        if (typeof resp['content'] === 'string') return resp['content'];
      }
    }
  }
  return '';
}

const TOOL_FAILURE_KIND_ATTRIBUTE = 'tool.failure_kind';
const TOOL_FAILURE_KIND_PRE_HOOK_BLOCKED = 'pre_hook_blocked';
const TOOL_FAILURE_KIND_POST_HOOK_STOPPED = 'post_hook_stopped';
const TOOL_FAILURE_KIND_TOOL_ERROR = 'tool_error';
const TOOL_FAILURE_KIND_TOOL_EXCEPTION = 'tool_exception';
const TOOL_FAILURE_KIND_CANCELLED = 'cancelled';
// Approval-flow failure kinds — distinct from `pre_hook_blocked` (which
// only applies to actual PreToolUse hook denials in `_executeToolCallBody`)
// so dashboards can attribute denies to their real cause (#4321 review).
const TOOL_FAILURE_KIND_PERMISSION_DENIED = 'permission_denied';
const TOOL_FAILURE_KIND_PERMISSION_HOOK_DENIED = 'permission_hook_denied';
const TOOL_FAILURE_KIND_PLAN_MODE_BLOCKED = 'plan_mode_blocked';
const TOOL_FAILURE_KIND_NON_INTERACTIVE_DENIED = 'non_interactive_denied';
const TOOL_FAILURE_KIND_BACKGROUND_AGENT_DENIED = 'background_agent_denied';

const TOOL_SPAN_STATUS_PRE_HOOK_BLOCKED = 'Tool execution blocked by hook';
const TOOL_SPAN_STATUS_POST_HOOK_STOPPED = 'Tool execution stopped by hook';
const TOOL_SPAN_STATUS_PERMISSION_DENIED = 'Permission denied for tool';
const TOOL_SPAN_STATUS_PERMISSION_HOOK_DENIED =
  'Permission denied by permission_request hook';
const TOOL_SPAN_STATUS_PLAN_MODE_BLOCKED =
  'Plan mode blocked a non-read-only tool call';
const TOOL_SPAN_STATUS_NON_INTERACTIVE_DENIED =
  'Non-interactive mode declined permission';
const TOOL_SPAN_STATUS_BACKGROUND_AGENT_DENIED =
  'Background agent cannot prompt for confirmation';
const TOOL_SPAN_STATUS_TOOL_ERROR = 'Tool execution failed';
const TOOL_SPAN_STATUS_TOOL_EXCEPTION = 'Tool execution failed with exception';
const TOOL_SPAN_STATUS_TOOL_CANCELLED = 'Tool execution cancelled by user';

const TRUNCATION_PARAM_GUIDANCE =
  'Note: Your previous response was truncated due to max_tokens limit, ' +
  'which caused incomplete tool call parameters. ' +
  'Please retry the tool call with complete parameters. ' +
  'If the content is too large for a single response, ' +
  'you MUST split it into smaller parts: ' +
  'first write_file with a skeleton/partial content, ' +
  'then use edit to add the remaining sections incrementally.';

const TRUNCATION_EDIT_REJECTION =
  'Your previous response was truncated due to max_tokens limit, ' +
  'which produced incomplete file content. ' +
  'The tool call has been rejected to prevent writing ' +
  'truncated content to the file. ' +
  'You MUST split the content into smaller parts: ' +
  'first write_file with a skeleton/partial content, ' +
  'then use edit to add the remaining sections incrementally. ' +
  'Do NOT retry with the same large content.';

function setToolSpanFailure(
  span: Span,
  failureKind: string,
  message: string,
): void {
  try {
    span.setAttribute(TOOL_FAILURE_KIND_ATTRIBUTE, failureKind);
    // Always write `success: false` so trace backends can filter tool
    // failures with the same query they use for llm_request spans —
    // mirrors the unconditional `success` attribute on llm_request.
    span.setAttribute('success', false);
  } catch {
    // OTel errors must not block the failure status update.
  }
  // Bound the status message size at this single ingress point so every
  // setToolSpanFailure caller is protected — multiple call sites pass
  // raw error.message which can be unbounded (#4321 review-5 wenshao
  // Suggestion). Static-constant callers see no change since their
  // messages are well under 1024 chars.
  safeSetStatus(span, {
    code: SpanStatusCode.ERROR,
    message: truncateSpanError(message),
  });
}

function setToolSpanCancelled(span: Span): void {
  try {
    span.setAttribute(TOOL_FAILURE_KIND_ATTRIBUTE, TOOL_FAILURE_KIND_CANCELLED);
    span.setAttribute('success', false);
  } catch {
    // OTel errors must not block the cancellation status update.
  }
  safeSetStatus(span, {
    code: SpanStatusCode.UNSET,
  });
}

async function safelyFirePostToolUseFailureHook(
  messageBus: MessageBus | undefined,
  toolUseId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  errorMessage: string,
  isInterrupt: boolean,
  permissionMode?: string,
): ReturnType<typeof firePostToolUseFailureHook> {
  try {
    return await firePostToolUseFailureHook(
      messageBus,
      toolUseId,
      toolName,
      toolInput,
      errorMessage,
      isInterrupt,
      permissionMode,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLogger.warn(
      `PostToolUseFailure hook failed for ${toolName}: ${message}`,
    );
    return { hookError: message };
  }
}

export type ValidatingToolCall = {
  status: 'validating';
  request: ToolCallRequestInfo;
  tool: AnyDeclarativeTool;
  invocation: AnyToolInvocation;
  startTime?: number;
  outcome?: ToolConfirmationOutcome;
};

export type ScheduledToolCall = {
  status: 'scheduled';
  request: ToolCallRequestInfo;
  tool: AnyDeclarativeTool;
  invocation: AnyToolInvocation;
  startTime?: number;
  outcome?: ToolConfirmationOutcome;
};

export type ErroredToolCall = {
  status: 'error';
  request: ToolCallRequestInfo;
  response: ToolCallResponseInfo;
  tool?: AnyDeclarativeTool;
  durationMs?: number;
  outcome?: ToolConfirmationOutcome;
};

export type SuccessfulToolCall = {
  status: 'success';
  request: ToolCallRequestInfo;
  tool: AnyDeclarativeTool;
  response: ToolCallResponseInfo;
  invocation: AnyToolInvocation;
  durationMs?: number;
  outcome?: ToolConfirmationOutcome;
};

export type ExecutingToolCall = {
  status: 'executing';
  request: ToolCallRequestInfo;
  tool: AnyDeclarativeTool;
  invocation: AnyToolInvocation;
  liveOutput?: ToolResultDisplay;
  /** Timestamp when the tool was first scheduled (validating). */
  startTime?: number;
  /**
   * Timestamp when the tool actually began executing (after any
   * approval/scheduling wait). Use this for "how long has this been
   * running" displays; prefer it over startTime to exclude approval time.
   */
  executionStartTime?: number;
  outcome?: ToolConfirmationOutcome;
  pid?: number;
  /**
   * Set during a foreground shell-tool invocation: the AbortController
   * the user/UI can fire (with `signal.reason = { kind: 'background' }`)
   * to promote the running command to a background entry. Set right
   * after `setPidCallback` fires (see ShellTool.execute), cleared
   * implicitly when the tool transitions to a terminal status. Only
   * meaningful for the shell tool's foreground path; absent on every
   * other tool kind.
   */
  promoteAbortController?: AbortController;
};

export type CancelledToolCall = {
  status: 'cancelled';
  request: ToolCallRequestInfo;
  response: ToolCallResponseInfo;
  tool: AnyDeclarativeTool;
  invocation: AnyToolInvocation;
  durationMs?: number;
  outcome?: ToolConfirmationOutcome;
};

export type WaitingToolCall = {
  status: 'awaiting_approval';
  request: ToolCallRequestInfo;
  tool: AnyDeclarativeTool;
  invocation: AnyToolInvocation;
  confirmationDetails: ToolCallConfirmationDetails;
  startTime?: number;
  outcome?: ToolConfirmationOutcome;
};

export type Status = ToolCall['status'];

export type ToolCall =
  | ValidatingToolCall
  | ScheduledToolCall
  | ErroredToolCall
  | SuccessfulToolCall
  | ExecutingToolCall
  | CancelledToolCall
  | WaitingToolCall;

export type CompletedToolCall =
  | SuccessfulToolCall
  | CancelledToolCall
  | ErroredToolCall;

/**
 * Closed allowlist of tool names whose inputs name actual filesystem
 * paths under the project root. Restricting `extractToolFilePaths` to
 * this set prevents MCP tools (where `Record<string, unknown>` input
 * conventions reuse `path` / `paths` for HTTP routes, JSON keys, search
 * queries, etc.) from feeding non-filesystem strings into
 * ConditionalRulesRegistry / SkillActivationRegistry — which would
 * resolve them under projectRoot, normalize, and false-match against
 * skill globs (e.g. `paths: ['**']` would activate on every MCP call).
 *
 * Custom FS tools added later need to opt in here. A future enhancement
 * could replace this with a per-tool `pathFields?: string[]` annotation
 * on tool declarations; the allowlist is the minimum-surface fix.
 */
const FS_PATH_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ToolNames.READ_FILE,
  ToolNames.EDIT,
  ToolNames.WRITE_FILE,
  ToolNames.GREP,
  ToolNames.GLOB,
  ToolNames.LS,
  ToolNames.LSP,
  ToolNames.NOTEBOOK_EDIT,
]);

function canonicalToolName(toolName: string): string {
  return (ToolNamesMigration as Record<string, string>)[toolName] ?? toolName;
}

function isFilesystemPathTool(toolName: string): boolean {
  return FS_PATH_TOOL_NAMES.has(canonicalToolName(toolName));
}

/**
 * Trim trailing forward / back slashes from a path-shaped string without
 * a regex. The regex form `s.replace(/[\\/]+$/, '')` is functionally
 * equivalent but CodeQL #145 flags `+` on uncontrolled input as a
 * polynomial ReDoS candidate; the loop is O(n) on the trailing
 * separator run, no different from the regex engine, but quieter.
 */
function trimTrailingSlash(s: string): string {
  let trimmed = s;
  while (trimmed.endsWith('/') || trimmed.endsWith('\\')) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

/**
 * Combine a search-root path and a path-shaped glob into the effective
 * selector that the tool actually walks. Used by GLOB (`path` + `pattern`)
 * and GREP (`path` + `glob`). Plain string concat (rather than
 * `path.join`) so we don't (1) emit OS-specific backslashes on Windows
 * and silently diverge from the forward-slash form the activation
 * registry matches against, or (2) collapse `..` segments and lose
 * information about which directory the call escaped from.
 */
function joinSearchRootAndGlob(
  searchRoot: string | undefined,
  globField: string,
): string {
  if (!searchRoot || searchRoot.length === 0) return globField;
  return `${trimTrailingSlash(searchRoot)}/${globField}`;
}

/**
 * For LSP-shaped inputs, normalize `filePath`-style strings into project
 * candidates. Accepts a plain absolute/relative path or a `file://` URI;
 * silently drops other URI schemes (`http://`, `git://`, etc.) so an
 * LSP call against a non-file resource cannot reach the activation
 * registry as if it had touched a project file.
 */
function pushLspPathCandidate(out: string[], v: unknown): void {
  if (typeof v !== 'string' || v.length === 0) return;
  if (v.startsWith('file://')) {
    try {
      out.push(fileURLToPath(v));
    } catch {
      // Malformed file URI — drop silently rather than corrupt the
      // activation pipeline.
    }
    return;
  }
  if (v.includes('://')) return; // non-file URI scheme: ignore
  out.push(v);
}

/**
 * Pull the filesystem path-bearing fields out of a tool's input.
 * Per-tool dispatcher because the field name and shape differ:
 *
 *  - read_file / edit / write_file → `file_path`
 *  - notebook_edit → `notebook_path`
 *  - list_directory → `path` (search root)
 *  - glob → `path` (search root, optional) + `pattern` (path-shaped
 *    selector); `<path>/<pattern>` is the effective glob walked
 *  - grep_search → `path` (search root, optional) + `glob` (path-shaped
 *    file filter); `pattern` is a regex on contents, NOT a path
 *  - lsp → `filePath` (URI-aware: `file://` accepted, others dropped)
 *    plus `callHierarchyItem.uri` for incomingCalls / outgoingCalls
 *
 * Used by ConditionalRulesRegistry / SkillActivationRegistry hooks to
 * route every project-relative path the tool actually touched through
 * the same activation pipeline. Returns `[]` for tool names outside
 * `FS_PATH_TOOL_NAMES` — see that set's docstring for why this is gated.
 */
export function extractToolFilePaths(
  toolName: string,
  toolInput: unknown,
): string[] {
  // Canonicalize legacy aliases (e.g. `replace` → `edit`,
  // `search_file_content` → `grep_search`) before the allowlist check.
  // The tool registry resolves these at execution time, so a tool call
  // like `replace({ file_path: 'src/App.tsx' })` actually runs EditTool;
  // gating only on the canonical name closes the alias-bypass hole.
  const canonical = canonicalToolName(toolName);
  if (!FS_PATH_TOOL_NAMES.has(canonical)) {
    // Surface allowlist gaps at debug level when a non-FS tool's input
    // *looks* path-shaped: we silently skip path activation for it, but
    // the field naming suggests it might be a real FS tool that just
    // hasn't been added to FS_PATH_TOOL_NAMES yet (or an MCP tool whose
    // input convention legitimately reuses these field names — both are
    // worth the debug breadcrumb when chasing "why didn't my path-gated
    // skill activate?"). Cheap object-property reads, only fires when
    // the user has DEBUG=tool-scheduler enabled, no production noise.
    if (toolInput && typeof toolInput === 'object') {
      const obj = toolInput as Record<string, unknown>;
      if (
        typeof obj['file_path'] === 'string' ||
        typeof obj['filePath'] === 'string' ||
        typeof obj['path'] === 'string' ||
        Array.isArray(obj['paths'])
      ) {
        debugLogger.debug(
          `Tool "${toolName}" (canonical "${canonical}") has path-like input fields ` +
            `but is not in FS_PATH_TOOL_NAMES — path-gated skills / conditional rules ` +
            `will not see its paths. If this is a filesystem tool, add it to the allowlist.`,
        );
      }
    }
    return [];
  }
  if (!toolInput || typeof toolInput !== 'object') return [];
  const obj = toolInput as Record<string, unknown>;
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) out.push(v);
  };

  switch (canonical) {
    case ToolNames.LSP: {
      // `filePath` may be a plain path, a `file://` URI, or a non-file
      // URI (`http://`, `git://`, etc.). Only the first two correspond
      // to project files — everything else must be ignored, otherwise
      // an LSP call on a non-file resource could activate path-gated
      // skills without the model having touched the project.
      pushLspPathCandidate(out, obj['filePath']);
      // incomingCalls / outgoingCalls operate on `callHierarchyItem.uri`,
      // not the top-level `filePath`. Without this, the model can follow
      // a call hierarchy through a project file and never trigger
      // activation for a skill scoped to that file.
      const item = obj['callHierarchyItem'];
      if (item && typeof item === 'object') {
        pushLspPathCandidate(out, (item as Record<string, unknown>)['uri']);
      }
      return out;
    }

    case ToolNames.GLOB: {
      const pathField = obj['path'];
      const patternField = obj['pattern'];
      // The standalone search-root candidate (so a broad skill keyed on
      // `paths: ['src/**']` still activates from `glob({ path: 'src' })`).
      push(pathField);
      // `pattern` is the actual selector. Combine with `path` to form
      // the effective walked glob.
      if (typeof patternField === 'string' && patternField.length > 0) {
        push(
          joinSearchRootAndGlob(
            typeof pathField === 'string' ? pathField : undefined,
            patternField,
          ),
        );
      }
      return out;
    }

    case ToolNames.GREP: {
      const pathField = obj['path'];
      const globField = obj['glob'];
      push(pathField);
      // `glob` is the path-shaped file filter (NOT `pattern`, which is a
      // regex on contents). Combine with `path` for the effective
      // filter selector.
      if (typeof globField === 'string' && globField.length > 0) {
        push(
          joinSearchRootAndGlob(
            typeof pathField === 'string' ? pathField : undefined,
            globField,
          ),
        );
      }
      return out;
    }

    case ToolNames.LS:
      push(obj['path']);
      return out;

    case ToolNames.READ_FILE:
    case ToolNames.EDIT:
    case ToolNames.WRITE_FILE:
      push(obj['file_path']);
      return out;

    case ToolNames.NOTEBOOK_EDIT:
      push(obj['notebook_path']);
      return out;

    default:
      push(obj['file_path']);
      return out;
  }
}

export type ConfirmHandler = (
  toolCall: WaitingToolCall,
) => Promise<ToolConfirmationOutcome>;

export type OutputUpdateHandler = (
  toolCallId: string,
  outputChunk: ToolResultDisplay,
) => void;

export type AllToolCallsCompleteHandler = (
  completedToolCalls: CompletedToolCall[],
) => Promise<void>;

export type ToolCallsUpdateHandler = (toolCalls: ToolCall[]) => void;

/**
 * Formats tool output for a Gemini FunctionResponse.
 */
function createFunctionResponsePart(
  callId: string,
  toolName: string,
  output: string,
  mediaParts?: FunctionResponsePart[],
): Part {
  const functionResponse: FunctionResponse = {
    id: callId,
    name: toolName,
    response: { output },
    ...(mediaParts && mediaParts.length > 0 ? { parts: mediaParts } : {}),
  };

  return {
    functionResponse,
  };
}

export function convertToFunctionResponse(
  toolName: string,
  callId: string,
  llmContent: PartListUnion,
): Part[] {
  const contentToProcess =
    Array.isArray(llmContent) && llmContent.length === 1
      ? llmContent[0]
      : llmContent;

  if (typeof contentToProcess === 'string') {
    return [createFunctionResponsePart(callId, toolName, contentToProcess)];
  }

  if (Array.isArray(contentToProcess)) {
    // Extract text and media from all parts so that EVERYTHING is inside
    // the FunctionResponse.
    const textParts: string[] = [];
    const mediaParts: FunctionResponsePart[] = [];

    for (const part of toParts(contentToProcess)) {
      if (part.text !== undefined) {
        textParts.push(part.text);
      } else if (part.inlineData) {
        mediaParts.push({ inlineData: part.inlineData });
      } else if (part.fileData) {
        mediaParts.push({ fileData: part.fileData });
      }
      // Other exotic part types (e.g. functionCall) are intentionally
      // dropped here – they should not appear inside tool results.
    }

    const output =
      textParts.length > 0 ? textParts.join('\n') : 'Tool execution succeeded.';
    return [createFunctionResponsePart(callId, toolName, output, mediaParts)];
  }

  // After this point, contentToProcess is a single Part object.
  if (contentToProcess.functionResponse) {
    if (contentToProcess.functionResponse.response?.['content']) {
      const stringifiedOutput =
        getResponseTextFromParts(
          contentToProcess.functionResponse.response['content'] as Part[],
        ) || '';
      return [createFunctionResponsePart(callId, toolName, stringifiedOutput)];
    }
    // It's a functionResponse that we should pass through as is.
    return [contentToProcess];
  }

  if (contentToProcess.inlineData || contentToProcess.fileData) {
    const mediaParts: FunctionResponsePart[] = [];
    if (contentToProcess.inlineData) {
      mediaParts.push({ inlineData: contentToProcess.inlineData });
    }
    if (contentToProcess.fileData) {
      mediaParts.push({ fileData: contentToProcess.fileData });
    }

    const functionResponse = createFunctionResponsePart(
      callId,
      toolName,
      '',
      mediaParts,
    );
    return [functionResponse];
  }

  if (contentToProcess.text !== undefined) {
    return [
      createFunctionResponsePart(callId, toolName, contentToProcess.text),
    ];
  }

  // Default case for other kinds of parts.
  return [
    createFunctionResponsePart(callId, toolName, 'Tool execution succeeded.'),
  ];
}

function toParts(input: PartListUnion): Part[] {
  const parts: Part[] = [];
  for (const part of Array.isArray(input) ? input : [input]) {
    if (typeof part === 'string') {
      parts.push({ text: part });
    } else if (part) {
      parts.push(part);
    }
  }
  return parts;
}

/**
 * Per-message offload: when a batch of tool results collectively exceeds the
 * budget, the largest results are spilled to disk and replaced with a small
 * preview + recoverable pointer. This is the preview size used for that spill.
 */
const BATCH_OFFLOAD_PREVIEW_CHARS = 2000;

/** Total model-facing string output across a completed call's responseParts. */
function batchResponseOutputSize(call: CompletedToolCall): number {
  if (call.status !== 'success') return 0;
  let size = 0;
  for (const part of call.response.responseParts) {
    const output = part.functionResponse?.response?.['output'];
    if (typeof output === 'string') size += output.length;
  }
  return size;
}

const VALIDATION_RETRY_LOOP_THRESHOLD = 3;

/** Directive injected when a tool call repeatedly fails validation. */
const RETRY_LOOP_STOP_DIRECTIVE =
  '\n\n⚠️ RETRY LOOP DETECTED: This tool call has failed validation multiple times with the same error. ' +
  'STOP retrying the same approach. Re-examine the tool schema and parameter requirements, then try a ' +
  'fundamentally different approach. If you cannot resolve the validation error, explain the issue to the user ' +
  'instead of retrying.';

const createErrorResponse = (
  request: ToolCallRequestInfo,
  error: Error,
  errorType: ToolErrorType | undefined,
): ToolCallResponseInfo => ({
  callId: request.callId,
  error,
  responseParts: [
    {
      functionResponse: {
        id: request.callId,
        name: request.name,
        response: { error: error.message },
      },
    },
  ],
  resultDisplay: error.message,
  errorType,
  contentLength: error.message.length,
});

function serializeToolResponse(
  response: ToolCallResponseInfo,
): Record<string, unknown> {
  // Keep this payload aligned with the persisted ToolCallResponseInfo fields
  // hook authors need for batch-level auditing.
  return {
    response_parts: response.responseParts.map(summarizeBatchResponsePart),
    result_display: response.resultDisplay,
    error: response.error?.message,
    error_type: response.errorType,
    content_length: response.contentLength,
  };
}

function summarizeBatchResponsePart(part: Part): Part {
  const summarized = part.inlineData
    ? {
        ...part,
        inlineData: {
          mimeType: part.inlineData.mimeType,
          data: '<binary omitted>',
        },
      }
    : part;

  if (!summarized.functionResponse?.parts) {
    return summarized;
  }

  return {
    ...summarized,
    functionResponse: {
      ...summarized.functionResponse,
      parts: summarized.functionResponse.parts.map(summarizeBatchResponsePart),
    },
  };
}

function toPostToolBatchToolCall(
  call: CompletedToolCall,
): PostToolBatchToolCall {
  return {
    tool_name: call.request.name,
    tool_input: call.request.args,
    tool_use_id: call.request.callId,
    status: call.status,
    tool_response: serializeToolResponse(call.response),
  };
}

function appendContextToResponsePart(
  part: Part,
  additionalContext: string,
): Part {
  if (!part.functionResponse) {
    debugLogger.warn(
      'appendContextToResponsePart: no functionResponse on part, additionalContext dropped',
    );
    return part;
  }

  const response = part.functionResponse.response ?? {};
  const output = response['output'];
  const error = response['error'];
  const hasOutput = Object.prototype.hasOwnProperty.call(response, 'output');
  const useOutputKey =
    typeof output === 'string' || (hasOutput && typeof error !== 'string');
  const key = useOutputKey ? 'output' : 'error';
  const currentText = useOutputKey
    ? typeof output === 'string'
      ? output
      : JSON.stringify(output)
    : typeof error === 'string'
      ? error
      : JSON.stringify(response);

  return {
    ...part,
    functionResponse: {
      ...part.functionResponse,
      response: {
        ...response,
        [key]: `${currentText}\n\n${additionalContext}`,
      },
    },
  };
}

function appendContextToToolResponse(
  response: ToolCallResponseInfo,
  additionalContext: string | undefined,
): ToolCallResponseInfo {
  if (!additionalContext || response.responseParts.length === 0) {
    return response;
  }

  const responseParts = [...response.responseParts];
  const lastIndex = responseParts.length - 1;
  const appendedPart = appendContextToResponsePart(
    responseParts[lastIndex],
    additionalContext,
  );
  if (appendedPart === responseParts[lastIndex]) {
    return response;
  }
  responseParts[lastIndex] = appendedPart;

  return {
    ...response,
    responseParts,
    contentLength:
      response.contentLength !== undefined
        ? response.contentLength + additionalContext.length + 2
        : undefined,
  };
}

function withPostToolBatchAdditionalContext(
  completedCalls: CompletedToolCall[],
  additionalContext: string | undefined,
): CompletedToolCall[] {
  if (!additionalContext || completedCalls.length === 0) {
    return completedCalls;
  }

  const calls = [...completedCalls];
  const lastIndex = calls.length - 1;
  calls[lastIndex] = {
    ...calls[lastIndex],
    response: appendContextToToolResponse(
      calls[lastIndex].response,
      additionalContext,
    ),
  } as CompletedToolCall;
  return calls;
}

function withPostToolBatchStop(
  completedCalls: CompletedToolCall[],
  stopReason: string,
): CompletedToolCall[] {
  if (completedCalls.length === 0) {
    return completedCalls;
  }

  const calls = [...completedCalls];
  const lastCall = calls[calls.length - 1];
  calls[calls.length - 1] = {
    status: 'error',
    request: lastCall.request,
    tool: lastCall.tool,
    response: createErrorResponse(
      lastCall.request,
      new Error(stopReason),
      ToolErrorType.EXECUTION_DENIED,
    ),
    durationMs: lastCall.durationMs,
    outcome: undefined,
  } as ErroredToolCall;
  return calls;
}

interface CoreToolSchedulerOptions {
  config: Config;
  outputUpdateHandler?: OutputUpdateHandler;
  onAllToolCallsComplete?: AllToolCallsCompleteHandler;
  onToolCallsUpdate?: ToolCallsUpdateHandler;
  getPreferredEditor: () => EditorType | undefined;
  onEditorClose: () => void;
  /**
   * Optional recording service. If provided, tool results will be recorded.
   */
  chatRecordingService?: ChatRecordingService;
}

// ─── Tool Concurrency Helpers ────────────────────────────────

interface ToolBatch {
  concurrent: boolean;
  calls: ScheduledToolCall[];
}

/**
 * State for the per-batch signal.abort listener registered in
 * `_schedule`. Shared by every callId in the batch so finalize hooks
 * can remove the listener once the last live entry drains, regardless
 * of whether finalization happens synchronously inside `_schedule`,
 * later via `handleConfirmationResponse`, or via `executeSingleToolCall`.
 */
interface BatchAbortState {
  signal: AbortSignal;
  onAbort: () => void;
  callIds: Set<string>;
}

/**
 * Returns true if a scheduled tool call can safely execute concurrently
 * with other safe tools (no side effects, no shared mutable state).
 */
function isConcurrencySafe(call: ScheduledToolCall): boolean {
  // Agent tools spawn independent sub-agents with no shared state.
  if (canonicalToolName(call.request.name) === ToolNames.AGENT) return true;
  // Shell commands: check if the command is read-only (e.g., git log, cat).
  // Uses the synchronous regex+shell-quote checker (not the async AST-based
  // one) because partitioning runs synchronously. The sync checker covers
  // the same command whitelist and is fail-closed — unknown commands remain
  // sequential. The AST version is used separately for permission decisions.
  if (call.tool.kind === Kind.Execute) {
    const command = (call.request.args as { command?: string }).command;
    if (typeof command !== 'string') return false;
    try {
      return isShellCommandReadOnly(stripShellWrapper(command));
    } catch {
      return false; // fail-closed
    }
  }
  return CONCURRENCY_SAFE_KINDS.has(call.tool.kind);
}

/**
 * Partition tool calls into consecutive batches by concurrency safety.
 *
 * Consecutive safe tools are merged into a single parallel batch.
 * Each unsafe tool forms its own sequential batch.
 *
 * Example: [Read, Read, Edit, Read] → [[Read,Read](parallel), [Edit](seq), [Read](seq)]
 */
function partitionToolCalls(calls: ScheduledToolCall[]): ToolBatch[] {
  return calls.reduce<ToolBatch[]>((batches, call) => {
    const safe = isConcurrencySafe(call);
    const lastBatch = batches[batches.length - 1];
    if (safe && lastBatch?.concurrent) {
      lastBatch.calls.push(call);
    } else {
      batches.push({ concurrent: safe, calls: [call] });
    }
    return batches;
  }, []);
}

export class CoreToolScheduler {
  private toolRegistry: ToolRegistry;
  private toolCalls: ToolCall[] = [];
  private outputUpdateHandler?: OutputUpdateHandler;
  private onAllToolCallsComplete?: AllToolCallsCompleteHandler;
  private onToolCallsUpdate?: ToolCallsUpdateHandler;
  private getPreferredEditor: () => EditorType | undefined;
  private config: Config;
  private onEditorClose: () => void;
  private chatRecordingService?: ChatRecordingService;
  private isFinalizingToolCalls = false;
  private isScheduling = false;
  private validationRetryCounts = new Map<string, number>();
  private autoModeFallbackCallIds = new Set<string>();
  // Tool span lifecycle now spans validating → awaiting_approval → executing
  // → terminal, so we hold the span across method boundaries by callId.
  // Decoupling from ToolCall identity is intentional — setStatusInternal
  // rebuilds the ToolCall on every status change, so a field on the
  // discriminated union would require threading on every transition.
  private toolSpans = new Map<string, Span>();
  // blocked_on_user span — child of the corresponding tool span — covers the
  // awaiting_approval phase. ModifyWithEditor stays inside one span until
  // the user makes a final decision (#3731 Phase 2).
  //
  // Map drain on signal.abort: see drainSpansForBatch — without it,
  // entries leaked across awaiting-approval-then-abort would persist for
  // the scheduler's lifetime (the 30-min TTL ends the underlying spans
  // but cannot reach these scheduler-local Maps; #4321 review).
  private blockedSpans = new Map<string, Span>();
  // Per-batch abort-listener state. callIdToBatch maps each callId added
  // during a `_schedule` invocation to its shared BatchAbortState; when
  // `finalize{Tool,Blocked}Span` removes the last live callId of a
  // batch, we strip the abort listener off the signal so long-lived
  // sessions reusing the same AbortSignal don't accumulate listeners
  // and trip Node's MaxListenersExceededWarning (#4321 review-3).
  private callIdToBatch = new Map<string, BatchAbortState>();
  // Keep the scheduling signal until the all-calls-complete hook fires.
  // callIdToBatch is drained earlier when spans end, so it cannot be used
  // to recover the PostToolBatch AbortSignal reliably.
  private callIdToPostToolBatchSignal = new Map<string, AbortSignal>();
  private requestQueue: Array<{
    request: ToolCallRequestInfo | ToolCallRequestInfo[];
    signal: AbortSignal;
    resolve: () => void;
    reject: (reason?: Error) => void;
  }> = [];

  constructor(options: CoreToolSchedulerOptions) {
    this.config = options.config;
    this.toolRegistry = options.config.getToolRegistry();
    this.outputUpdateHandler = options.outputUpdateHandler;
    this.onAllToolCallsComplete = options.onAllToolCallsComplete;
    this.onToolCallsUpdate = options.onToolCallsUpdate;
    this.getPreferredEditor = options.getPreferredEditor;
    this.onEditorClose = options.onEditorClose;
    this.chatRecordingService = options.chatRecordingService;
  }

  private get memoryMonitor(): MemoryPressureMonitor | undefined {
    return this.config.getMemoryPressureMonitor?.();
  }

  private setStatusInternal(
    targetCallId: string,
    status: 'success',
    response: ToolCallResponseInfo,
  ): void;
  private setStatusInternal(
    targetCallId: string,
    status: 'awaiting_approval',
    confirmationDetails: ToolCallConfirmationDetails,
  ): void;
  private setStatusInternal(
    targetCallId: string,
    status: 'error',
    response: ToolCallResponseInfo,
  ): void;
  private setStatusInternal(
    targetCallId: string,
    status: 'cancelled',
    reason: string,
  ): void;
  private setStatusInternal(
    targetCallId: string,
    status: 'executing' | 'scheduled' | 'validating',
  ): void;
  private setStatusInternal(
    targetCallId: string,
    newStatus: Status,
    auxiliaryData?: unknown,
  ): void {
    this.toolCalls = this.toolCalls.map((currentCall) => {
      if (
        currentCall.request.callId !== targetCallId ||
        currentCall.status === 'success' ||
        currentCall.status === 'error' ||
        currentCall.status === 'cancelled'
      ) {
        return currentCall;
      }

      // currentCall is a non-terminal state here and should have startTime and tool.
      const existingStartTime = currentCall.startTime;
      const toolInstance = currentCall.tool;
      const invocation = currentCall.invocation;

      const outcome = currentCall.outcome;

      switch (newStatus) {
        case 'success': {
          // Successful execution only resets retry state for this tool
          this.clearRetryCountsForTool(currentCall.request.name);
          const durationMs = existingStartTime
            ? Date.now() - existingStartTime
            : undefined;
          return {
            request: currentCall.request,
            tool: toolInstance,
            invocation,
            status: 'success',
            response: auxiliaryData as ToolCallResponseInfo,
            durationMs,
            outcome,
          } as SuccessfulToolCall;
        }
        case 'error': {
          const durationMs = existingStartTime
            ? Date.now() - existingStartTime
            : undefined;
          return {
            request: currentCall.request,
            status: 'error',
            tool: toolInstance,
            response: auxiliaryData as ToolCallResponseInfo,
            durationMs,
            outcome,
          } as ErroredToolCall;
        }
        case 'awaiting_approval':
          return {
            request: currentCall.request,
            tool: toolInstance,
            status: 'awaiting_approval',
            confirmationDetails: auxiliaryData as ToolCallConfirmationDetails,
            startTime: existingStartTime,
            outcome,
            invocation,
          } as WaitingToolCall;
        case 'scheduled':
          return {
            request: currentCall.request,
            tool: toolInstance,
            status: 'scheduled',
            startTime: existingStartTime,
            outcome,
            invocation,
          } as ScheduledToolCall;
        case 'cancelled': {
          const durationMs = existingStartTime
            ? Date.now() - existingStartTime
            : undefined;

          // Preserve diff for cancelled edit operations
          // Preserve plan content for cancelled plan operations
          let resultDisplay: ToolResultDisplay | undefined = undefined;
          if (currentCall.status === 'awaiting_approval') {
            const waitingCall = currentCall as WaitingToolCall;
            if (waitingCall.confirmationDetails.type === 'edit') {
              resultDisplay = {
                fileDiff: waitingCall.confirmationDetails.fileDiff,
                fileName: waitingCall.confirmationDetails.fileName,
                originalContent:
                  waitingCall.confirmationDetails.originalContent,
                newContent: waitingCall.confirmationDetails.newContent,
              };
            } else if (waitingCall.confirmationDetails.type === 'plan') {
              resultDisplay = {
                type: 'plan_summary',
                message: 'Plan was rejected. Remaining in plan mode.',
                plan: waitingCall.confirmationDetails.plan,
                rejected: true,
              };
            }
          } else if (currentCall.status === 'executing') {
            // If the tool was streaming live output, preserve the latest
            // output so the UI can continue to show it after cancellation.
            const executingCall = currentCall as ExecutingToolCall;
            if (executingCall.liveOutput !== undefined) {
              resultDisplay = executingCall.liveOutput;
            }
          }

          const errorMessage = `[Operation Cancelled] Reason: ${auxiliaryData}`;
          return {
            request: currentCall.request,
            tool: toolInstance,
            invocation,
            status: 'cancelled',
            response: {
              callId: currentCall.request.callId,
              responseParts: [
                {
                  functionResponse: {
                    id: currentCall.request.callId,
                    name: currentCall.request.name,
                    response: {
                      error: errorMessage,
                    },
                  },
                },
              ],
              resultDisplay,
              error: undefined,
              errorType: undefined,
              contentLength: errorMessage.length,
            },
            durationMs,
            outcome,
          } as CancelledToolCall;
        }
        case 'validating':
          return {
            request: currentCall.request,
            tool: toolInstance,
            status: 'validating',
            startTime: existingStartTime,
            outcome,
            invocation,
          } as ValidatingToolCall;
        case 'executing':
          return {
            request: currentCall.request,
            tool: toolInstance,
            status: 'executing',
            startTime: existingStartTime,
            executionStartTime: Date.now(),
            outcome,
            invocation,
          } as ExecutingToolCall;
        default: {
          const exhaustiveCheck: never = newStatus;
          return exhaustiveCheck;
        }
      }
    });
    this.notifyToolCallsUpdate();
    void this.checkAndNotifyCompletion().catch((error: unknown) => {
      debugLogger.warn(
        `setStatusInternal completion notification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private setArgsInternal(targetCallId: string, args: unknown): void {
    this.toolCalls = this.toolCalls.map((call) => {
      // We should never be asked to set args on an ErroredToolCall, but
      // we guard for the case anyways.
      if (call.request.callId !== targetCallId || call.status === 'error') {
        return call;
      }

      const invocationOrError = this.buildInvocation(
        call.tool,
        args as Record<string, unknown>,
        targetCallId,
        call.request.prompt_id,
      );
      if (invocationOrError instanceof Error) {
        const response = createErrorResponse(
          call.request,
          invocationOrError,
          ToolErrorType.INVALID_TOOL_PARAMS,
        );
        return {
          request: { ...call.request, args: args as Record<string, unknown> },
          status: 'error',
          tool: call.tool,
          response,
        } as ErroredToolCall;
      }

      return {
        ...call,
        request: { ...call.request, args: args as Record<string, unknown> },
        invocation: invocationOrError,
      };
    });
  }

  private isRunning(): boolean {
    return (
      this.isFinalizingToolCalls ||
      this.toolCalls.some(
        (call) =>
          call.status === 'executing' || call.status === 'awaiting_approval',
      )
    );
  }

  /**
   * End the tool span for `callId` (if any) and remove it from the map.
   * Centralizes terminal-state cleanup so every cancel/error/success path
   * goes through one place — easier to audit for leaks. Idempotent:
   * second call for the same callId is a no-op.
   *
   * No `metadata` parameter: every caller pre-sets span status via
   * `setToolSpan{Failure,Cancelled,Ok}` before this call (#4321 review).
   */
  private finalizeToolSpan(callId: string): void {
    const span = this.toolSpans.get(callId);
    if (!span) return;
    this.toolSpans.delete(callId);
    endToolSpan(span);
    this.releaseBatchListenerIfDrained(callId);
  }

  /**
   * End the blocked_on_user span for `callId` (if any) and remove it from
   * the map. Idempotent. ModifyWithEditor must NOT call this — the same
   * blocked span covers the entire awaiting period including editor side
   * trips.
   */
  private finalizeBlockedSpan(
    callId: string,
    decision: ToolBlockedDecision,
    source: ToolBlockedSource,
  ): void {
    const span = this.blockedSpans.get(callId);
    if (!span) return;
    this.blockedSpans.delete(callId);
    endToolBlockedOnUserSpan(span, { decision, source });
    // Don't release the batch listener here — the tool span often
    // outlives the blocked span (proceed → execute), so finalizeToolSpan
    // is the canonical drain point. The blocked span's release runs
    // through the same path on terminal states (cancel/error finalize
    // both spans together).
  }

  /**
   * Hook called by finalizeToolSpan when a callId drains from the
   * scheduler-local maps. If this was the last live callId of its batch,
   * remove the abort listener so the AbortSignal doesn't accumulate
   * listeners across many `_schedule` calls in a long-lived session
   * (#4321 review-3 wenshao Critical).
   */
  private releaseBatchListenerIfDrained(callId: string): void {
    const batch = this.callIdToBatch.get(callId);
    if (!batch) return;
    this.callIdToBatch.delete(callId);
    batch.callIds.delete(callId);

    // Any other callId in the batch still in toolSpans/blockedSpans?
    // If yes, the listener still has work to do. If no, drop it.
    for (const id of batch.callIds) {
      if (this.toolSpans.has(id) || this.blockedSpans.has(id)) return;
    }
    batch.signal.removeEventListener('abort', batch.onAbort);
  }

  /**
   * Best-effort attribution of the surface that resolved the blocked
   * decision. When IDE mode is on, confirmations are most often resolved
   * via the IDE diff flow (`openIdeDiffIfEnabled`) — but a CLI-fallback
   * confirmation in IDE mode is also reported as 'ide' here. Operators
   * can drill into the trace if they need finer-grained attribution.
   */
  private getBlockedSource(): ToolBlockedSource {
    return this.config.getIdeMode?.() ? 'ide' : 'cli';
  }

  /**
   * Drain any tool/blocked spans associated with `callIds` that are still
   * live in the scheduler-local maps. Called on signal.abort for spans
   * that no other code path will finalize (e.g. user walks away from
   * awaiting_approval and the session aborts).
   *
   * Deferred to a macrotask so existing finalize paths that await on the
   * SAME aborted signal — explicit user Cancel via
   * `handleConfirmationResponse`, mid-execution `setToolSpanCancelled`
   * inside `_executeToolCallBody` — win the race and set the canonical
   * decision/status before this safety-net drain runs. By the time the
   * timer fires, those paths have removed the entries from the Maps and
   * the drain is a no-op for the common cases. Only the genuine
   * walk-away-then-abort case survives to be drained here.
   *
   * Idempotent for callIds whose spans were already finalized by a normal
   * path — `finalizeBlockedSpan` / `finalizeToolSpan` are no-ops on
   * missing entries.
   */
  private drainSpansForBatch(callIds: Iterable<string>): void {
    const ids = Array.from(callIds);
    setTimeout(() => {
      for (const callId of ids) {
        // Per-callId try/catch so one bad finalize doesn't silently skip
        // remaining entries — the timer callback would otherwise surface
        // an unhandled exception (#4321 review-3 wenshao Suggestion).
        try {
          if (this.blockedSpans.has(callId)) {
            this.finalizeBlockedSpan(callId, 'aborted', 'system');
          }
          const span = this.toolSpans.get(callId);
          if (span) {
            setToolSpanCancelled(span);
            this.finalizeToolSpan(callId);
          }
          this.callIdToPostToolBatchSignal.delete(callId);
          this.autoModeFallbackCallIds.delete(callId);
        } catch (e) {
          debugLogger.warn(
            `drainSpansForBatch: failed to drain ${callId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }, 0);
  }

  /**
   * Shared toEndMeta callback for the 4 PostToolUseFailure hook fire
   * sites. Each was previously inlined as a byte-identical lambda; the
   * helper avoids drift between cancel-vs-error and abort-vs-non-abort
   * branches and keeps protocol changes (e.g. new metadata fields) in
   * one place (#4321 review-3 wenshao Suggestion).
   */
  private postToolUseFailureEndMeta = (
    r: Awaited<ReturnType<typeof safelyFirePostToolUseFailureHook>>,
  ): HookSpanMetadata =>
    r.hookError
      ? { success: false, error: r.hookError }
      : {
          success: true,
          hasAdditionalContext: !!r.additionalContext,
        };

  /**
   * Wrap a hook fire site with span lifecycle management. Centralizes the
   * try/finally pattern across the 6 hook fire sites (PreToolUse,
   * PostToolUse, 4× PostToolUseFailure) so future protocol changes
   * (e.g. new metadata fields) can be made in one place instead of in
   * lockstep across each site (#4321 review wenshao Suggestion).
   *
   * On the happy path `toEndMeta(result)` builds the metadata recorded on
   * the span. On a throw, the default `endMeta = { success: false }`
   * survives — today's hook helpers in `toolHookTriggers.ts` swallow
   * throws internally so this branch is unreachable, but the pattern
   * future-proofs the lifecycle if that contract changes.
   */
  private async withHookSpan<T>(
    opts: StartHookSpanOptions,
    fn: () => Promise<T>,
    toEndMeta: (result: T) => HookSpanMetadata,
  ): Promise<T> {
    const hookSpan = startHookSpan(opts);
    // Default endMeta carries an `error` so OTel maps the span to ERROR
    // status if `fn()` ever throws (today unreachable — hook helpers
    // catch internally — but kept as a defensive contract). Without
    // an `error` field, the span would record `success: false` as an
    // attribute but `code: UNSET` as status, which trace backends
    // filtering on ERROR would miss (#4321 review code-reviewer).
    let endMeta: HookSpanMetadata = { success: false };
    try {
      const result = await fn();
      endMeta = toEndMeta(result);
      return result;
    } catch (err) {
      // Capture the actual thrown message instead of a hardcoded
      // sentinel so the hook span surfaces the real failure for
      // operators (#4321 review DeepSeek Suggestion). This branch is
      // unreachable on the current hook-helper contract (each fire*
      // helper catches internally) but kept defensively in case the
      // contract evolves.
      endMeta = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
      throw err;
    } finally {
      endHookSpan(hookSpan, endMeta);
    }
  }

  /**
   * Builds a tool invocation and threads optional context (callId,
   * promptId) into it via duck-typed setters when the invocation
   * exposes them. Both setters are intentionally optional:
   * - Existing tools whose invocations do not implement these setters
   *   stay compatible without any change.
   * - Future contexts (subagent / direct buildAndExecute / non-scheduler
   *   callers) may invoke this with fewer arguments and still get a
   *   valid invocation back.
   * Production call sites in this scheduler always pass both — see
   * the setArgs path at L1036 and the schedule path at L1497.
   */
  private buildInvocation(
    tool: AnyDeclarativeTool,
    args: object,
    callId?: string,
    promptId?: string,
  ): AnyToolInvocation | Error {
    try {
      const invocation = tool.build(structuredClone(args));
      if (callId) {
        const maybeAware = invocation as { setCallId?: (id: string) => void };
        if (typeof maybeAware.setCallId === 'function') {
          maybeAware.setCallId(callId);
        }
      }
      if (promptId) {
        const maybeAware = invocation as {
          setPromptId?: (id: string) => void;
        };
        if (typeof maybeAware.setPromptId === 'function') {
          maybeAware.setPromptId(promptId);
        }
      }
      return invocation;
    } catch (e) {
      if (e instanceof Error) {
        return e;
      }
      return new Error(String(e));
    }
  }

  /**
   * Generates error message for unknown tool. Returns early with skill-specific
   * message if the name matches a skill, otherwise uses Levenshtein suggestions.
   */
  private async getToolNotFoundMessage(
    unknownToolName: string,
    topN = 3,
  ): Promise<string> {
    // Check if the unknown tool name matches an available skill name.
    // This handles the case where the model tries to invoke a skill as a tool
    // (e.g., Tool: "pdf" instead of Tool: "Skill" with skill: "pdf")
    const skillTool = await this.toolRegistry.ensureTool(ToolNames.SKILL);
    if (skillTool && 'getAvailableSkillNames' in skillTool) {
      const availableSkillNames = (
        skillTool as { getAvailableSkillNames(): string[] }
      ).getAvailableSkillNames();
      if (availableSkillNames.includes(unknownToolName)) {
        return `"${unknownToolName}" is a skill name, not a tool name. To use this skill, invoke the "${ToolNames.SKILL}" tool with parameter: skill: "${unknownToolName}"`;
      }
    }

    // Standard "not found" message with Levenshtein suggestions
    const suggestion = this.getToolSuggestion(unknownToolName, topN);
    return `Tool "${unknownToolName}" not found in registry. Tools must use the exact names that are registered.${suggestion}`;
  }

  /** Suggests similar tool names using Levenshtein distance. */
  private getToolSuggestion(unknownToolName: string, topN = 3): string {
    const allToolNames = this.toolRegistry.getAllToolNames();

    const matches = allToolNames.map((toolName) => ({
      name: toolName,
      distance: levenshtein.get(unknownToolName, toolName),
    }));

    matches.sort((a, b) => a.distance - b.distance);

    const topNResults = matches.slice(0, topN);

    if (topNResults.length === 0) {
      return '';
    }

    const suggestedNames = topNResults
      .map((match) => `"${match.name}"`)
      .join(', ');

    if (topNResults.length > 1) {
      return ` Did you mean one of: ${suggestedNames}?`;
    } else {
      return ` Did you mean ${suggestedNames}?`;
    }
  }

  schedule(
    request: ToolCallRequestInfo | ToolCallRequestInfo[],
    signal: AbortSignal,
  ): Promise<void> {
    if (this.isRunning() || this.isScheduling) {
      return new Promise((resolve, reject) => {
        const abortHandler = () => {
          // Find and remove the request from the queue
          const index = this.requestQueue.findIndex(
            (item) => item.request === request,
          );
          if (index > -1) {
            this.requestQueue.splice(index, 1);
            reject(new Error('Tool call cancelled while in queue.'));
          }
        };

        signal.addEventListener('abort', abortHandler, { once: true });

        this.requestQueue.push({
          request,
          signal,
          resolve: () => {
            signal.removeEventListener('abort', abortHandler);
            resolve();
          },
          reject: (reason?: Error) => {
            signal.removeEventListener('abort', abortHandler);
            reject(reason);
          },
        });
      });
    }
    return this._schedule(request, signal);
  }

  /**
   * Removes all validation retry counters for the given tool. Keys are
   * "<toolName>:<errorMessage>", so a plain `Map.delete(toolName)` would not
   * match anything.
   */
  private clearRetryCountsForTool(toolName: string): void {
    const prefix = `${toolName}:`;
    for (const key of this.validationRetryCounts.keys()) {
      if (key.startsWith(prefix)) {
        this.validationRetryCounts.delete(key);
      }
    }
  }

  private async _schedule(
    request: ToolCallRequestInfo | ToolCallRequestInfo[],
    signal: AbortSignal,
  ): Promise<void> {
    this.isScheduling = true;
    try {
      if (this.isRunning()) {
        throw new Error(
          'Cannot schedule new tool calls while other tool calls are actively running (executing or awaiting approval).',
        );
      }
      const requestsToProcess = dedupeRequestsByCallId(
        Array.isArray(request) ? request : [request],
      );

      // Prune validation retry state per-tool, not wholesale. Keys are
      // "<toolName>:<errorMessage>"; retain counters only for tools actually
      // present in the current batch. Keeping every tracked tool's counters
      // whenever any current request matched caused stale counts for
      // unrelated tools to survive and fire RETRY LOOP DETECTED prematurely
      // the next time those tools were used.
      if (this.validationRetryCounts.size > 0) {
        const currentToolNames = new Set(requestsToProcess.map((r) => r.name));
        for (const key of [...this.validationRetryCounts.keys()]) {
          const sep = key.indexOf(':');
          const toolName = sep === -1 ? key : key.slice(0, sep);
          if (!currentToolNames.has(toolName)) {
            this.validationRetryCounts.delete(key);
          }
        }
      }

      const newToolCalls: ToolCall[] = [];
      for (const reqInfo of requestsToProcess) {
        const canonicalName = canonicalToolName(reqInfo.name);

        // Check if the tool is excluded due to permissions/environment restrictions
        // This check should happen before registry lookup to provide a clear permission error
        const pm = this.config.getPermissionManager?.();
        if (pm && !(await pm.isToolEnabled(canonicalName))) {
          const matchingRule = pm.findMatchingDenyRule({
            toolName: canonicalName,
          });
          const ruleInfo = matchingRule
            ? ` Matching deny rule: "${matchingRule}".`
            : '';
          const permissionErrorMessage = `Qwen Code requires permission to use "${reqInfo.name}", but that permission was declined.${ruleInfo}`;
          newToolCalls.push({
            status: 'error',
            request: reqInfo,
            response: createErrorResponse(
              reqInfo,
              new Error(permissionErrorMessage),
              ToolErrorType.EXECUTION_DENIED,
            ),
            durationMs: 0,
          });
          continue;
        }

        // Legacy fallback: check getPermissionsDeny() when PM is not available
        if (!pm) {
          const excludeTools = this.config.getPermissionsDeny?.() ?? undefined;
          if (excludeTools && excludeTools.length > 0) {
            const normalizedToolName = canonicalName.toLowerCase().trim();
            const excludedMatch = excludeTools.find(
              (excludedTool) =>
                excludedTool.toLowerCase().trim() === normalizedToolName,
            );
            if (excludedMatch) {
              const permissionErrorMessage = `Qwen Code requires permission to use ${excludedMatch}, but that permission was declined.`;
              newToolCalls.push({
                status: 'error',
                request: reqInfo,
                response: createErrorResponse(
                  reqInfo,
                  new Error(permissionErrorMessage),
                  ToolErrorType.EXECUTION_DENIED,
                ),
                durationMs: 0,
              });
              continue;
            }
          }
        }

        const toolInstance = await this.toolRegistry.ensureTool(canonicalName);
        if (!toolInstance) {
          // Tool is not in registry and not excluded - likely hallucinated or typo
          const errorMessage = await this.getToolNotFoundMessage(reqInfo.name);
          newToolCalls.push({
            status: 'error',
            request: reqInfo,
            response: createErrorResponse(
              reqInfo,
              new Error(errorMessage),
              ToolErrorType.TOOL_NOT_REGISTERED,
            ),
            durationMs: 0,
          });
          continue;
        }

        // Reject file-modifying calls when truncated to prevent
        // writing incomplete content, even if params failed schema validation.
        if (reqInfo.wasOutputTruncated && toolInstance.kind === Kind.Edit) {
          const truncationError = new Error(TRUNCATION_EDIT_REJECTION);
          newToolCalls.push({
            status: 'error',
            request: reqInfo,
            tool: toolInstance,
            response: createErrorResponse(
              reqInfo,
              truncationError,
              ToolErrorType.OUTPUT_TRUNCATED,
            ),
            durationMs: 0,
          });
          continue;
        }

        const invocationOrError = this.buildInvocation(
          toolInstance,
          reqInfo.args,
          reqInfo.callId,
          reqInfo.prompt_id,
        );
        if (invocationOrError instanceof Error) {
          const displayError = reqInfo.wasOutputTruncated
            ? new Error(
                `${invocationOrError.message} ${TRUNCATION_PARAM_GUIDANCE}`,
              )
            : invocationOrError;

          // Track validation retry for loop detection. Counts accumulate per
          // (tool, error message) pair so a different validation mistake on
          // the same tool starts fresh rather than tripping the threshold.
          const errorKey = `${reqInfo.name}:${invocationOrError.message}`;
          const count = (this.validationRetryCounts.get(errorKey) ?? 0) + 1;
          for (const key of this.validationRetryCounts.keys()) {
            if (key.startsWith(`${reqInfo.name}:`) && key !== errorKey) {
              this.validationRetryCounts.delete(key);
            }
          }
          this.validationRetryCounts.set(errorKey, count);

          const finalError =
            count >= VALIDATION_RETRY_LOOP_THRESHOLD
              ? new Error(
                  `${invocationOrError.message}${RETRY_LOOP_STOP_DIRECTIVE}`,
                )
              : displayError;

          newToolCalls.push({
            status: 'error',
            request: reqInfo,
            tool: toolInstance,
            response: createErrorResponse(
              reqInfo,
              finalError,
              ToolErrorType.INVALID_TOOL_PARAMS,
            ),
            durationMs: 0,
          });
          continue;
        }

        // Reset all validation retry counters for this tool since it passed validation
        this.clearRetryCountsForTool(reqInfo.name);

        newToolCalls.push({
          status: 'validating',
          request: reqInfo,
          tool: toolInstance,
          invocation: invocationOrError,
          startTime: Date.now(),
        });
      }

      this.toolCalls = this.toolCalls.concat(newToolCalls);
      this.notifyToolCallsUpdate();

      // Per-batch abort-listener state. Shared by every callId added in
      // this `_schedule` invocation. The listener drains scheduler-local
      // Maps on a real abort (walk-away-during-awaiting_approval), and is
      // automatically released by `releaseBatchListenerIfDrained` from
      // inside `finalizeToolSpan` when the batch's last live callId
      // drains — keeping listener growth bounded across long sessions
      // even when batches mix synchronous and awaiting_approval flows
      // (#4321 review-3 wenshao Critical).
      const batchState: BatchAbortState = {
        signal,
        onAbort: () => this.drainSpansForBatch(batchState.callIds),
        callIds: new Set<string>(),
      };
      signal.addEventListener('abort', batchState.onAbort, { once: true });

      for (const toolCall of newToolCalls) {
        if (toolCall.status !== 'validating') {
          continue;
        }

        const { request: reqInfo, invocation } = toolCall;
        const canonicalName = canonicalToolName(reqInfo.name);

        // Open the tool span as soon as the call is validated. This covers
        // validating → awaiting_approval → executing in one span (#3731
        // Phase 2). Every cancel/error path below — and the existing
        // success path in executeSingleToolCall — must call
        // finalizeToolSpan(callId, ...) to avoid leaking spans.
        // `tool.name` is set automatically by startToolSpan from the first
        // arg; only namespaced extras go in attrs. `call_id` (non-namespaced)
        // is dual-emitted for one release as a backwards-compat shim for
        // pre-Phase-2 dashboards/alerts that grep the old key — drop after
        // operators migrate (#4321 review). `tool_name` is dual-emitted on
        // the same migration window (review-2 DeepSeek Suggestion) so
        // pre-Phase-2 dashboards filtering on it don't silently stop
        // matching during the rollout.
        const toolSpan = startToolSpan(canonicalName, {
          'tool.call_id': reqInfo.callId,
          call_id: reqInfo.callId,
          tool_name: canonicalName,
        });
        this.toolSpans.set(reqInfo.callId, toolSpan);
        batchState.callIds.add(reqInfo.callId);
        this.callIdToBatch.set(reqInfo.callId, batchState);
        this.callIdToPostToolBatchSignal.set(reqInfo.callId, signal);

        try {
          if (signal.aborted) {
            this.setStatusInternal(
              reqInfo.callId,
              'cancelled',
              'Tool call cancelled by user.',
            );
            setToolSpanCancelled(toolSpan);
            this.finalizeToolSpan(reqInfo.callId);
            continue;
          }

          // =================================================================
          // L3→L4→L5 Permission Flow
          // =================================================================

          // ---- L3→L4: Shared permission flow ----
          const toolParams = invocation.params as Record<string, unknown>;
          const flowResult = await evaluatePermissionFlow(
            this.config,
            invocation,
            canonicalName,
            toolParams,
          );
          const { finalPermission, pmForcedAsk, pmCtx, denyMessage } =
            flowResult;

          // ---- L5: Final decision based on permission + ApprovalMode ----
          const approvalMode = this.config.getApprovalMode();
          const isPlanMode = approvalMode === ApprovalMode.PLAN;
          const isExitPlanModeTool = canonicalName === ToolNames.EXIT_PLAN_MODE;
          const isEnterPlanModeTool =
            canonicalName === ToolNames.ENTER_PLAN_MODE;

          const forceAutoReviewForAllow =
            approvalMode === ApprovalMode.AUTO &&
            shouldForceAutoModeReviewForAllow(pmCtx, this.config.getCwd());
          const confirmationPermission = getEffectivePermissionForConfirmation(
            finalPermission,
            forceAutoReviewForAllow,
          );

          if (finalPermission === 'allow' && forceAutoReviewForAllow) {
            debugLogger.info(
              `Auto mode: L4 allow overridden by protected-write guard for ${canonicalName}`,
            );
          }

          if (finalPermission === 'allow' && !forceAutoReviewForAllow) {
            // Auto-approve: tool is inherently safe (read-only) or PM allows.
            // In AUTO mode, also reset denialTracking so an L4 allow-rule
            // match counts as a successful call and clears any in-flight
            // block streak. Without this, a session sitting at
            // consecutiveBlock=3 would keep auto-approving the allow-ruled
            // call (correct), but the very next call that needed the
            // classifier would still see shouldFallback==='true' and force
            // manual approval — confusing UX given the previous allow-rule
            // call just worked silently.
            if (approvalMode === ApprovalMode.AUTO) {
              this.config.setAutoModeDenialState(
                recordAllow(this.config.getAutoModeDenialState()),
              );
            }
            this.setToolCallOutcome(
              reqInfo.callId,
              ToolConfirmationOutcome.ProceedAlways,
            );
            this.setStatusInternal(reqInfo.callId, 'scheduled');
            continue;
          }

          if (finalPermission === 'deny') {
            // Hard deny: security violation or PM explicit deny
            this.setStatusInternal(
              reqInfo.callId,
              'error',
              createErrorResponse(
                reqInfo,
                new Error(denyMessage ?? `Tool "${reqInfo.name}" is denied.`),
                ToolErrorType.EXECUTION_DENIED,
              ),
            );
            setToolSpanFailure(
              toolSpan,
              TOOL_FAILURE_KIND_PERMISSION_DENIED,
              TOOL_SPAN_STATUS_PERMISSION_DENIED,
            );
            this.finalizeToolSpan(reqInfo.callId);
            continue;
          }

          // ── L5: AUTO mode three-layer filter ──────────────────────────
          // Fast-paths run BEFORE the fallback check so safe tools (Read,
          // Grep, LS, in-cwd Edit, …) short-circuit even in a denial-streak
          // fallback state — otherwise every trivially safe tool would
          // force manual approval until the user toggles modes.
          if (shouldRunAutoModeForCall(approvalMode, canonicalName)) {
            const denialState = this.config.getAutoModeDenialState();
            const fallback = shouldFallback(denialState);
            // `buildClassifierContents` retains only the most recent
            // MAX_TRANSCRIPT_MESSAGES messages; ask the chat client for
            // exactly that tail rather than triggering a
            // `structuredClone` of the whole session on every non-
            // fast-path AUTO call.
            const messages =
              this.config
                .getGeminiClient?.()
                ?.getHistoryTail(MAX_TRANSCRIPT_MESSAGES, false) ?? [];
            const decision = await evaluateAutoMode({
              ctx: pmCtx,
              pmForcedAsk,
              toolParams,
              messages,
              config: this.config,
              signal,
              skipClassifierReason: fallback.fallback
                ? fallback.reason
                : undefined,
            });

            const outcome = applyAutoModeDecision(
              decision,
              this.config,
              denialState,
            );
            if (
              !this.config.getDisableAllHooks() &&
              shouldFirePermissionDeniedForAutoMode(decision, outcome)
            ) {
              try {
                await this.config
                  .getHookSystem?.()
                  ?.firePermissionDeniedEvent(
                    canonicalName,
                    toolParams,
                    reqInfo.callId,
                    getAutoModePermissionDeniedReason(decision),
                    signal,
                  );
              } catch (hookError) {
                debugLogger.warn(
                  `PermissionDenied hook failed for tool ${reqInfo.callId}: ${hookError instanceof Error ? hookError.message : String(hookError)}`,
                );
              }
            }
            switch (outcome.kind) {
              case 'approved':
                this.setToolCallOutcome(
                  reqInfo.callId,
                  ToolConfirmationOutcome.ProceedAlways,
                );
                this.setStatusInternal(reqInfo.callId, 'scheduled');
                continue;
              case 'blocked':
                debugLogger.warn(
                  `Auto mode blocked (${outcome.reason}): tool=${canonicalName}, ` +
                    formatDenialStateLog(denialState),
                );
                this.setStatusInternal(
                  reqInfo.callId,
                  'error',
                  createErrorResponse(
                    reqInfo,
                    new Error(outcome.errorMessage),
                    ToolErrorType.EXECUTION_DENIED,
                  ),
                );
                continue;
              case 'fallback':
                // Drop through to the manual-approval flow below. The
                // pending dialog tells the user what's being asked;
                // operators see the cause in the debug log (only when
                // fallback was specifically armed by denialTracking —
                // a pmForcedAsk fallback isn't an audit-worthy event).
                if (isDenialFallbackReason(outcome.reason)) {
                  this.autoModeFallbackCallIds.add(reqInfo.callId);
                  debugLogger.warn(
                    `Auto mode fallback to manual approval (${outcome.reason}): ` +
                      formatDenialStateLog(denialState),
                  );
                }
                break;
              default: {
                const _exhaustive: never = outcome;
                void _exhaustive;
              }
            }
          }

          // finalPermission === 'ask' (or 'default' from PM → treat as ask)
          // apply ApprovalMode overrides.
          // ask_user_question always needs confirmation so the user can answer;
          // it must bypass both YOLO auto-approve and plan-mode blocking.
          const isAskUserQuestionTool =
            canonicalName === ToolNames.ASK_USER_QUESTION;
          let confirmationDetails: ToolCallConfirmationDetails | undefined;

          if (
            !needsConfirmation(
              confirmationPermission,
              approvalMode,
              canonicalName,
            )
          ) {
            this.setToolCallOutcome(
              reqInfo.callId,
              ToolConfirmationOutcome.ProceedAlways,
            );
            this.setStatusInternal(reqInfo.callId, 'scheduled');
          } else {
            confirmationDetails =
              await invocation.getConfirmationDetails(signal);

            // ── Centralised rule injection ──────────────────────────────────
            injectPermissionRulesIfMissing(confirmationDetails, pmCtx);

            if (
              isPlanModeBlocked(
                isPlanMode,
                isExitPlanModeTool,
                isAskUserQuestionTool,
                confirmationDetails,
                isEnterPlanModeTool,
              )
            ) {
              this.setStatusInternal(reqInfo.callId, 'error', {
                callId: reqInfo.callId,
                responseParts: convertToFunctionResponse(
                  reqInfo.name,
                  reqInfo.callId,
                  getPlanModeSystemReminder(),
                ),
                resultDisplay: 'Plan mode blocked a non-read-only tool call.',
                error: undefined,
                errorType: undefined,
              });
              setToolSpanFailure(
                toolSpan,
                TOOL_FAILURE_KIND_PLAN_MODE_BLOCKED,
                TOOL_SPAN_STATUS_PLAN_MODE_BLOCKED,
              );
              this.finalizeToolSpan(reqInfo.callId);
              continue;
            }

            // AUTO_EDIT mode: auto-approve edit-like and info tools
            if (isAutoEditApproved(approvalMode, confirmationDetails)) {
              this.setToolCallOutcome(
                reqInfo.callId,
                ToolConfirmationOutcome.ProceedAlways,
              );
              this.setStatusInternal(reqInfo.callId, 'scheduled');
              continue;
            }

            /**
             * In non-interactive mode, automatically deny.
             */
            const isNonInteractiveDeny =
              !this.config.isInteractive() &&
              !this.config.getExperimentalZedIntegration() &&
              this.config.getInputFormat() !== InputFormat.STREAM_JSON;

            if (isNonInteractiveDeny) {
              const errorMessage = `Qwen Code requires permission to use "${reqInfo.name}", but that permission was declined (non-interactive mode cannot prompt for confirmation).`;
              this.setStatusInternal(
                reqInfo.callId,
                'error',
                createErrorResponse(
                  reqInfo,
                  new Error(errorMessage),
                  ToolErrorType.EXECUTION_DENIED,
                ),
              );
              setToolSpanFailure(
                toolSpan,
                TOOL_FAILURE_KIND_NON_INTERACTIVE_DENIED,
                TOOL_SPAN_STATUS_NON_INTERACTIVE_DENIED,
              );
              this.finalizeToolSpan(reqInfo.callId);
              continue;
            }

            // Fire PermissionRequest hook before showing the permission dialog.
            // Hooks run before the background-agent auto-deny so they can
            // override the denial with policy-based decisions.
            const messageBus = this.config.getMessageBus() as
              | MessageBus
              | undefined;
            const hooksEnabled = !this.config.getDisableAllHooks();

            if (hooksEnabled && messageBus) {
              const permissionMode = String(this.config.getApprovalMode());
              const hookResult = await firePermissionRequestHook(
                messageBus,
                canonicalName,
                (reqInfo.args as Record<string, unknown>) || {},
                permissionMode,
              );

              if (hookResult.hasDecision) {
                if (hookResult.shouldAllow) {
                  // Hook granted permission - apply updated input if provided and proceed
                  if (
                    hookResult.updatedInput &&
                    typeof reqInfo.args === 'object'
                  ) {
                    this.setArgsInternal(
                      reqInfo.callId,
                      hookResult.updatedInput,
                    );
                  }
                  await confirmationDetails.onConfirm(
                    ToolConfirmationOutcome.ProceedOnce,
                  );
                  this.recordAutoModeFallbackResolution(
                    reqInfo.callId,
                    ToolConfirmationOutcome.ProceedOnce,
                  );
                  this.setToolCallOutcome(
                    reqInfo.callId,
                    ToolConfirmationOutcome.ProceedOnce,
                  );
                  this.setStatusInternal(reqInfo.callId, 'scheduled');
                } else {
                  // Hook denied permission - cancel with optional message
                  const cancelPayload = hookResult.denyMessage
                    ? { cancelMessage: hookResult.denyMessage }
                    : undefined;
                  await confirmationDetails.onConfirm(
                    ToolConfirmationOutcome.Cancel,
                    cancelPayload,
                  );
                  this.recordAutoModeFallbackResolution(
                    reqInfo.callId,
                    ToolConfirmationOutcome.Cancel,
                  );
                  this.setToolCallOutcome(
                    reqInfo.callId,
                    ToolConfirmationOutcome.Cancel,
                  );
                  this.setStatusInternal(
                    reqInfo.callId,
                    'error',
                    createErrorResponse(
                      reqInfo,
                      new Error(
                        hookResult.denyMessage ||
                          `Permission denied by hook for "${reqInfo.name}"`,
                      ),
                      ToolErrorType.EXECUTION_DENIED,
                    ),
                  );
                  setToolSpanFailure(
                    toolSpan,
                    TOOL_FAILURE_KIND_PERMISSION_HOOK_DENIED,
                    TOOL_SPAN_STATUS_PERMISSION_HOOK_DENIED,
                  );
                  this.finalizeToolSpan(reqInfo.callId);
                }
                continue;
              }
            }

            // Background agents can't show interactive prompts.
            // Auto-deny after hooks have had a chance to decide.
            if (this.config.getShouldAvoidPermissionPrompts?.()) {
              const errorMessage = `Tool "${reqInfo.name}" requires permission, but background agents cannot prompt for confirmation. The tool call was denied.`;
              this.setStatusInternal(
                reqInfo.callId,
                'error',
                createErrorResponse(
                  reqInfo,
                  new Error(errorMessage),
                  ToolErrorType.EXECUTION_DENIED,
                ),
              );
              setToolSpanFailure(
                toolSpan,
                TOOL_FAILURE_KIND_BACKGROUND_AGENT_DENIED,
                TOOL_SPAN_STATUS_BACKGROUND_AGENT_DENIED,
              );
              this.finalizeToolSpan(reqInfo.callId);
              continue;
            }

            // Re-check signal.aborted between the for-loop entry guard and
            // here: `evaluatePermissionFlow`, `getConfirmationDetails`, and
            // `firePermissionRequestHook` are all `await` points that can
            // resolve normally even after the signal aborted. Without this
            // re-check we'd open `awaiting_approval` + a blocked span on
            // an already-aborted signal — drainSpansForBatch (deferred via
            // setTimeout(0)) may have already fired by then, so the new
            // entries would never be drained (#4321 review-3 wenshao
            // Critical).
            if (signal.aborted) {
              this.setStatusInternal(
                reqInfo.callId,
                'cancelled',
                'Tool call cancelled by user.',
              );
              setToolSpanCancelled(toolSpan);
              this.finalizeToolSpan(reqInfo.callId);
              continue;
            }

            // Allow IDE to resolve confirmation
            this.openIdeDiffIfEnabled(
              confirmationDetails,
              reqInfo.callId,
              signal,
            );

            const originalOnConfirm = confirmationDetails.onConfirm;
            const wrappedConfirmationDetails: ToolCallConfirmationDetails = {
              ...confirmationDetails,
              // When PM has an explicit 'ask' rule, 'always allow' would be
              // ineffective because ask takes priority over allow.
              // Hide the option so users aren't misled.
              ...(pmForcedAsk ? { hideAlwaysAllow: true } : {}),
              onConfirm: (
                outcome: ToolConfirmationOutcome,
                payload?: ToolConfirmationPayload,
              ) =>
                this.handleConfirmationResponse(
                  reqInfo.callId,
                  originalOnConfirm,
                  outcome,
                  signal,
                  payload,
                ),
            };
            this.setStatusInternal(
              reqInfo.callId,
              'awaiting_approval',
              wrappedConfirmationDetails,
            );

            // Open blocked_on_user span as a child of the tool span — covers
            // the entire awaiting_approval phase, including any
            // ModifyWithEditor side trip (#3731 Phase 2). Finalized in
            // handleConfirmationResponse / autoApproveCompatiblePendingTools
            // / the global-abort catch block above.
            const blockedSpan = startToolBlockedOnUserSpan(toolSpan, {
              tool_name: canonicalName,
              call_id: reqInfo.callId,
            });
            this.blockedSpans.set(reqInfo.callId, blockedSpan);

            // Fire permission_prompt notification hook
            if (hooksEnabled && messageBus) {
              fireNotificationHook(
                messageBus,
                `Qwen Code needs your permission to use ${reqInfo.name}`,
                NotificationType.PermissionPrompt,
                'Permission needed',
              ).catch((error) => {
                debugLogger.warn(
                  `Permission prompt notification hook failed: ${error instanceof Error ? error.message : String(error)}`,
                );
              });
            }
          }
        } catch (error) {
          if (signal.aborted) {
            this.setStatusInternal(
              reqInfo.callId,
              'cancelled',
              'Tool call cancelled by user.',
            );
            // If this tool was waiting on the user, end the blocked span
            // as aborted before the tool span itself.
            this.finalizeBlockedSpan(reqInfo.callId, 'aborted', 'system');
            setToolSpanCancelled(toolSpan);
            this.finalizeToolSpan(reqInfo.callId);
            continue;
          }

          // Errors thrown from getConfirmationDetails() may carry a
          // structured ToolErrorType via an `errorType` instance
          // field (see StructuredToolError in
          // tools/priorReadEnforcement.ts). When present, surface
          // that code instead of collapsing every confirmation-time
          // failure into UNHANDLED_EXCEPTION.
          const explicitErrorType = (
            error as { errorType?: ToolErrorType } | undefined
          )?.errorType;
          this.setStatusInternal(
            reqInfo.callId,
            'error',
            createErrorResponse(
              reqInfo,
              error instanceof Error ? error : new Error(String(error)),
              explicitErrorType ?? ToolErrorType.UNHANDLED_EXCEPTION,
            ),
          );
          // Non-aborted catch is a system error (e.g. getConfirmationDetails
          // threw). 'error' decision keeps it distinct from user 'cancel'
          // counts in dashboards.
          this.finalizeBlockedSpan(reqInfo.callId, 'error', 'system');
          setToolSpanFailure(
            toolSpan,
            TOOL_FAILURE_KIND_TOOL_EXCEPTION,
            error instanceof Error ? error.message : String(error),
          );
          this.finalizeToolSpan(reqInfo.callId);
        }
      }
      await this.attemptExecutionOfScheduledCalls(signal);
      void this.checkAndNotifyCompletion().catch((error: unknown) => {
        debugLogger.warn(
          `_schedule completion notification failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
      // Listener removal happens inside `finalizeToolSpan` →
      // `releaseBatchListenerIfDrained` for every callId, so we don't
      // need a duplicate cleanup here. That path also covers the
      // exception case (this method's outer try/catch finalizes spans
      // before re-throwing), satisfying the
      // "stillLive cleanup not in finally" concern from review-3.
      //
      // Edge case: if every newToolCall was non-validating (all failed
      // pre-validation — invalid params, tool not registered, etc.),
      // batchState.callIds stays empty and no finalizeToolSpan call
      // ever fires for this batch. Drop the listener here so the
      // signal doesn't accumulate dead listeners across many such
      // batches in a daemon session (#4321 review-5 wenshao
      // Suggestion).
      if (batchState.callIds.size === 0) {
        signal.removeEventListener('abort', batchState.onAbort);
      }
    } finally {
      this.isScheduling = false;
    }
  }

  async handleConfirmationResponse(
    callId: string,
    originalOnConfirm: (
      outcome: ToolConfirmationOutcome,
      payload?: ToolConfirmationPayload,
    ) => Promise<void>,
    outcome: ToolConfirmationOutcome,
    signal: AbortSignal,
    payload?: ToolConfirmationPayload,
  ): Promise<void> {
    const toolCall = this.toolCalls.find(
      (c) => c.request.callId === callId && c.status === 'awaiting_approval',
    );

    // Guard: if the tool is no longer awaiting approval (already handled by
    // another confirmation path, e.g. IDE vs CLI race), skip to avoid double
    // processing and potential re-execution.
    if (!toolCall) return;

    try {
      await this._handleConfirmationResponseInner(
        callId,
        toolCall,
        originalOnConfirm,
        outcome,
        signal,
        payload,
      );
    } catch (error) {
      // Defensive: a throw from the confirmation flow (originalOnConfirm,
      // persistPermissionOutcome, autoApproveCompatiblePendingTools,
      // modifyWithEditor, _applyInlineModify, status transitions) would
      // otherwise leave A's blocked + tool spans open until the 30-min
      // TTL fires. Finalize both so the trace shows a deterministic
      // close. finalizeXSpan are idempotent — if the success/cancel
      // path already closed them, these are no-ops.
      //
      // attemptExecutionOfScheduledCalls is NOT covered by this catch
      // (see below). A sister tool's prelude throw escaping through
      // attemptExecutionOfScheduledCalls would otherwise corrupt A's
      // span — each executeSingleToolCall handles its own span
      // lifecycle via its own catch (#4321 review-9 wenshao Critical).
      //
      // Branch on signal.aborted so a throw caused by the abort signal
      // (e.g. ModifyWithEditor child interrupted by Ctrl+C) lands as
      // 'aborted'/'system' + UNSET status — matching the sister catch
      // in `_schedule:1797` and the dashboard intent of separating
      // user/system aborts from real exceptions (#4321 review-2 wenshao).
      const aborted = signal.aborted;
      this.finalizeBlockedSpan(callId, aborted ? 'aborted' : 'error', 'system');
      const toolSpan = this.toolSpans.get(callId);
      if (toolSpan) {
        if (aborted) {
          setToolSpanCancelled(toolSpan);
        } else {
          setToolSpanFailure(
            toolSpan,
            TOOL_FAILURE_KIND_TOOL_EXCEPTION,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      this.finalizeToolSpan(callId);
      // Surface the failure in application logs even though we re-throw.
      // The trace backend captures it via the span, but operators
      // grepping logs by callId would otherwise see nothing if the
      // caller doesn't log the rejection itself (#4321 review-5
      // wenshao Suggestion).
      debugLogger.warn(
        `handleConfirmationResponse failed for ${callId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    // Execution phase runs OUTSIDE the catch above so a sister tool's
    // prelude throw (re-thrown by executeSingleToolCall after SF-H2)
    // can't be mis-attributed to A's span. Each executeSingleToolCall
    // handles its own span lifecycle; failures propagate to the caller
    // as-is. (#4321 review-9 wenshao Critical refines review-2
    // pushback which became live after SF-H2 added the prelude
    // re-throw.)
    await this.attemptExecutionOfScheduledCalls(signal);
  }

  private async _handleConfirmationResponseInner(
    callId: string,
    toolCall: ToolCall,
    originalOnConfirm: (
      outcome: ToolConfirmationOutcome,
      payload?: ToolConfirmationPayload,
    ) => Promise<void>,
    outcome: ToolConfirmationOutcome,
    signal: AbortSignal,
    payload?: ToolConfirmationPayload,
  ): Promise<void> {
    await originalOnConfirm(outcome, payload);

    if (
      outcome === ToolConfirmationOutcome.ProceedAlways ||
      outcome === ToolConfirmationOutcome.ProceedAlwaysProject ||
      outcome === ToolConfirmationOutcome.ProceedAlwaysUser
    ) {
      // Persist permission rules for Project/User scope outcomes
      await persistPermissionOutcome(
        outcome,
        (toolCall as WaitingToolCall).confirmationDetails,
        this.config.getOnPersistPermissionRule?.(),
        this.config.getPermissionManager?.(),
        payload,
      );
      await this.autoApproveCompatiblePendingTools(signal, callId);
    }

    this.setToolCallOutcome(callId, outcome);

    this.recordAutoModeFallbackResolution(callId, outcome);

    if (outcome === ToolConfirmationOutcome.Cancel || signal.aborted) {
      // Use custom cancel message from payload if provided, otherwise use default
      const cancelMessage =
        payload?.cancelMessage || 'User did not allow tool call';
      this.setStatusInternal(callId, 'cancelled', cancelMessage);
      // Tool span is cancelled too — finalize it via setToolSpanCancelled
      // before pulling it out of the map so the status survives end().
      const toolSpan = this.toolSpans.get(callId);
      if (toolSpan) {
        setToolSpanCancelled(toolSpan);
      }
      // Explicit user Cancel takes precedence over a concurrent global
      // abort: when both are true, treat it as an explicit cancel so
      // dashboards counting `decision: 'aborted'` aren't polluted by
      // benign user actions that race with shutdown.
      const explicitCancel = outcome === ToolConfirmationOutcome.Cancel;
      this.finalizeBlockedSpan(
        callId,
        explicitCancel ? 'cancel' : 'aborted',
        explicitCancel ? this.getBlockedSource() : 'system',
      );
      this.finalizeToolSpan(callId);
    } else if (outcome === ToolConfirmationOutcome.ModifyWithEditor) {
      const waitingToolCall = toolCall as WaitingToolCall;
      if (isModifiableDeclarativeTool(waitingToolCall.tool)) {
        const modifyContext = waitingToolCall.tool.getModifyContext(signal);
        const editorType = this.getPreferredEditor();
        if (!editorType) {
          // No editor configured: ModifyWithEditor cannot proceed. Log so
          // the silent failure is at least visible in debug telemetry.
          // Do NOT finalize spans here — the tool stays in awaiting_approval
          // and the user can still recover with Cancel or Proceed; their
          // eventual decision closes the spans correctly. Closing them
          // here would make the user's eventual finalize a no-op (Map
          // already cleared) and lose the actual decision/source — same
          // pattern as the autoApprove catch (#4321 review codex P3).
          // The 30-min TTL is the safety net if the user walks away.
          debugLogger.warn(
            `ModifyWithEditor requested for ${callId} but no editor available — tool stays in awaiting_approval; user can recover via Cancel/Proceed`,
          );
          // Tag the tool span so operators can detect this state in
          // production traces without enabling debug logging
          // (#4321 review-2 DeepSeek Critical).
          const toolSpan = this.toolSpans.get(callId);
          if (toolSpan) {
            try {
              toolSpan.setAttributes({
                'qwen-code.tool.modify_with_editor_unavailable': true,
              });
            } catch {
              // OTel errors must not block API behavior.
            }
          }
          return;
        }

        this.setStatusInternal(callId, 'awaiting_approval', {
          ...waitingToolCall.confirmationDetails,
          isModifying: true,
        } as ToolCallConfirmationDetails);

        // Normalize shell-escaped paths so the editor receives actual
        // filesystem paths (request.args may still hold escaped values
        // since buildInvocation normalizes a structuredClone).
        const normalizedArgs = {
          ...waitingToolCall.request.args,
        } as typeof waitingToolCall.request.args;
        for (const key of PATH_ARG_KEYS) {
          if (typeof normalizedArgs[key] === 'string') {
            (normalizedArgs as Record<string, unknown>)[key] = unescapePath(
              String(normalizedArgs[key]).trim(),
            );
          }
        }
        const { updatedParams, updatedDiff } = await modifyWithEditor<
          typeof waitingToolCall.request.args
        >(
          normalizedArgs,
          modifyContext as ModifyContext<typeof waitingToolCall.request.args>,
          editorType,
          signal,
          this.onEditorClose,
        );
        this.setArgsInternal(callId, updatedParams);
        this.setStatusInternal(callId, 'awaiting_approval', {
          ...waitingToolCall.confirmationDetails,
          fileDiff: updatedDiff,
          isModifying: false,
        } as ToolCallConfirmationDetails);
      }
    } else {
      // If the client provided new content, apply it before scheduling.
      if (payload?.newContent && toolCall) {
        await this._applyInlineModify(
          toolCall as WaitingToolCall,
          payload,
          signal,
        );
      }
      this.setStatusInternal(callId, 'scheduled');
      // Proceed: end the blocked span before execution begins. ProceedOnce
      // and the three ProceedAlways* variants all close the awaiting phase.
      // The tool span itself stays open and is finalized in
      // executeSingleToolCall.
      const decision: ToolBlockedDecision =
        outcome === ToolConfirmationOutcome.ProceedOnce
          ? 'proceed_once'
          : 'proceed_always';
      this.finalizeBlockedSpan(callId, decision, this.getBlockedSource());
    }
    // attemptExecutionOfScheduledCalls is invoked by the caller
    // (handleConfirmationResponse, outside its catch) so a sister
    // tool's prelude throw can't be mis-attributed to this callId
    // (#4321 review-9 wenshao Critical).
  }

  private recordAutoModeFallbackResolution(
    callId: string,
    outcome: ToolConfirmationOutcome,
  ): void {
    const wasAutoModeFallback = this.autoModeFallbackCallIds.delete(callId);

    // AUTO-mode denialTracking recovery: when the user manually approves a
    // call that fell back because denialTracking was armed, clear the armed
    // counters so subsequent calls return to classifier flow. Ordinary AUTO
    // approvals for ask rules must not clear cumulative denial totals.
    // Cancel / abort do NOT reset — spec §9.1.4 treats rejection as a
    // signal that the classifier was correct to block.
    if (
      this.config.getApprovalMode() === ApprovalMode.AUTO &&
      wasAutoModeFallback &&
      isApproveOutcome(outcome)
    ) {
      const before = this.config.getAutoModeDenialState();
      const after = recordFallbackApprove(before);
      if (after === before) {
        debugLogger.warn(
          `Auto mode denial counters already clear after fallback approval: ` +
            formatDenialStateLog(before),
        );
        return;
      }
      debugLogger.warn(
        `Auto mode denial counters reset after fallback approval: ` +
          `${formatDenialStateLog(before)} -> ${formatDenialStateLog(after)}`,
      );
      this.config.setAutoModeDenialState(after);
    }
  }

  /**
   * Opens an IDE diff view for edit-type tools when IDE mode is active.
   * The IDE resolution is handled asynchronously — if the user accepts or
   * rejects from the IDE, it triggers handleConfirmationResponse.
   *
   * Uses confirmationDetails.filePath / newContent (the same data shown in
   * CLI diff) rather than ModifyContext so that the IDE diff is always
   * consistent with the CLI and with resolveDiffFromCli.
   */
  private async openIdeDiffIfEnabled(
    confirmationDetails: ToolCallConfirmationDetails,
    callId: string,
    signal: AbortSignal,
  ) {
    if (confirmationDetails.type !== 'edit' || !this.config.getIdeMode()) {
      return;
    }

    let resolution: Awaited<ReturnType<IdeClient['openDiff']>>;
    try {
      const ideClient = await IdeClient.getInstance();
      if (!ideClient.isDiffingEnabled()) return;

      resolution = await ideClient.openDiff(
        confirmationDetails.filePath,
        confirmationDetails.newContent,
      );
    } catch (error) {
      if (!signal.aborted) {
        debugLogger.warn(
          `IDE diff open failed for ${callId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }

    // Guard: skip if the tool was already handled (e.g. by CLI
    // confirmation).  Without this check, resolveDiffFromCli
    // triggers this handler AND the CLI's onConfirm, causing a
    // race where ProceedOnce overwrites ProceedAlways.
    const still = this.toolCalls.find(
      (c) => c.request.callId === callId && c.status === 'awaiting_approval',
    );
    if (!still) return;

    if (resolution.status === 'accepted') {
      // When content is unchanged, skip the inline modify path so that
      // the original tool params (e.g. partial old_string for edit tool)
      // are preserved. Mitigate the multi-edit-on-same-file issue (#2702)
      // for the common accept-without-edit case.
      const userEdited =
        resolution.content != null &&
        resolution.content !== confirmationDetails.newContent;
      await this.handleConfirmationResponse(
        callId,
        confirmationDetails.onConfirm,
        ToolConfirmationOutcome.ProceedOnce,
        signal,
        userEdited ? { newContent: resolution.content } : undefined,
      );
    } else {
      await this.handleConfirmationResponse(
        callId,
        confirmationDetails.onConfirm,
        ToolConfirmationOutcome.Cancel,
        signal,
      );
    }
  }

  /**
   * Applies user-provided content changes to a tool call that is awaiting confirmation.
   * This method updates the tool's arguments and refreshes the confirmation prompt with a new diff
   * before the tool is scheduled for execution.
   * @private
   */
  private async _applyInlineModify(
    toolCall: WaitingToolCall,
    payload: ToolConfirmationPayload,
    signal: AbortSignal,
  ): Promise<void> {
    const confirmDetails = toolCall.confirmationDetails;
    if (
      confirmDetails.type !== 'edit' ||
      !isModifiableDeclarativeTool(toolCall.tool) ||
      !payload.newContent
    ) {
      return;
    }

    const currentContent = confirmDetails.originalContent ?? '';
    const modifyContext = toolCall.tool.getModifyContext(signal);

    const updatedParams = modifyContext.createUpdatedParams(
      currentContent,
      payload.newContent,
      toolCall.request.args,
    );
    const updatedDiff = Diff.createPatch(
      confirmDetails.filePath,
      currentContent,
      payload.newContent,
      'Current',
      'Proposed',
    );

    this.setArgsInternal(toolCall.request.callId, updatedParams);
    this.setStatusInternal(toolCall.request.callId, 'awaiting_approval', {
      ...confirmDetails,
      fileDiff: updatedDiff,
    });
  }

  private async attemptExecutionOfScheduledCalls(
    signal: AbortSignal,
  ): Promise<void> {
    const allCallsFinalOrScheduled = this.toolCalls.every(
      (call) =>
        call.status === 'scheduled' ||
        call.status === 'cancelled' ||
        call.status === 'success' ||
        call.status === 'error',
    );

    if (allCallsFinalOrScheduled) {
      const callsToExecute = this.toolCalls.filter(
        (call): call is ScheduledToolCall => call.status === 'scheduled',
      );

      // Partition tool calls into consecutive batches by concurrency safety.
      // Consecutive safe tools are grouped into parallel batches; unsafe
      // tools each form their own sequential batch. Execute (shell) is safe
      // only when isShellCommandReadOnly() returns true; otherwise sequential.
      const batches = partitionToolCalls(callsToExecute);

      for (const batch of batches) {
        if (batch.concurrent && batch.calls.length > 1) {
          await this.runConcurrently(batch.calls, signal);
        } else {
          for (const call of batch.calls) {
            await this.executeSingleToolCall(call, signal);
          }
        }
      }
    }
  }

  /**
   * Execute multiple tool calls concurrently with a concurrency cap.
   */
  private async runConcurrently(
    calls: ScheduledToolCall[],
    signal: AbortSignal,
  ): Promise<void> {
    const parsed = parseInt(
      process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'] || '',
      10,
    );
    const maxConcurrency = Number.isFinite(parsed) && parsed >= 1 ? parsed : 10;
    const executing = new Set<Promise<void>>();

    for (const call of calls) {
      const p = this.executeSingleToolCall(call, signal).finally(() => {
        executing.delete(p);
      });
      executing.add(p);
      if (executing.size >= maxConcurrency) {
        await Promise.race(executing);
      }
    }
    await Promise.all(executing);
  }

  private async executeSingleToolCall(
    toolCall: ToolCall,
    signal: AbortSignal,
  ): Promise<void> {
    if (toolCall.status !== 'scheduled') return;

    const scheduledCall = toolCall;
    const { callId, name: toolName } = scheduledCall.request;

    // The tool span is opened in `_schedule` so it covers validating →
    // awaiting_approval → executing in one span. Reuse it here. If it's
    // missing (defensive — shouldn't happen on the happy path), create one
    // so the success path still produces telemetry.
    let toolSpan = this.toolSpans.get(callId);
    if (!toolSpan) {
      // canonicalToolName matches the _schedule path so dashboards
      // grouping by span name don't see two entries for migrated/MCP tools
      // when this defensive fallback fires (#4321 review).
      const canonical = canonicalToolName(toolName);
      toolSpan = startToolSpan(canonical, {
        'tool.call_id': callId,
        call_id: callId, // legacy alias — see _schedule for context
        tool_name: canonical, // legacy alias — see _schedule for context
      });
      this.toolSpans.set(callId, toolSpan);
    }
    try {
      await runInToolSpanContext(toolSpan, () =>
        this._executeToolCallBody(scheduledCall, signal, toolSpan),
      );
    } catch (error) {
      // _executeToolCallBody pre-sets span status (OK / FAILURE /
      // CANCELLED) only AFTER its main try/catch is entered. Throws
      // from the prelude — addToolInputAttributes, getMessageBus,
      // startToolExecutionSpan, etc. — happen BEFORE the
      // `scheduled → executing` transition, so the span would end
      // UNSET with no failure_kind AND the tool call would stay in
      // `scheduled` forever (checkAndNotifyCompletion never sees a
      // terminal state). Set failure status + error response here so
      // the finalizeToolSpan in `finally` produces meaningful
      // telemetry and the scheduler can complete (#4321 review-7
      // silent-failure-hunter HIGH-2; review-8 wenshao Critical
      // dropped the `status === 'executing'` guard the previous
      // attempt used — `setStatusInternal` already no-ops on
      // terminal states, so the unconditional call covers both
      // `scheduled` and `executing` prelude-throw paths).
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      setToolSpanFailure(
        toolSpan,
        TOOL_FAILURE_KIND_TOOL_EXCEPTION,
        errorMessage,
      );
      this.setStatusInternal(
        callId,
        'error',
        createErrorResponse(
          scheduledCall.request,
          error instanceof Error ? error : new Error(errorMessage),
          ToolErrorType.UNHANDLED_EXCEPTION,
        ),
      );
      throw error;
    } finally {
      // _executeToolCallBody pre-sets status (OK / FAILURE / CANCELLED) via
      // setToolSpan*; finalize without metadata to preserve that.
      this.finalizeToolSpan(callId);
      this.memoryMonitor?.scheduleCheck();
    }
  }

  private async _executeToolCallBody(
    scheduledCall: ScheduledToolCall,
    signal: AbortSignal,
    span: Span,
  ): Promise<void> {
    const { callId, name: toolName } = scheduledCall.request;
    const canonicalName = canonicalToolName(toolName);
    const invocation = scheduledCall.invocation;
    const toolInput = scheduledCall.request.args as Record<string, unknown>;

    // Normalize shell-escaped path params so hooks operate on actual filesystem
    // paths, matching the normalization done in tool validation.
    for (const key of PATH_ARG_KEYS) {
      if (typeof toolInput[key] === 'string') {
        toolInput[key] = unescapePath(String(toolInput[key]).trim());
      }
    }

    // Guard the JSON serialization — addToolInputAttributes early-returns
    // when sensitive attributes are off, but the argument is computed
    // before the call.
    if (this.config.getTelemetryIncludeSensitiveSpanAttributes?.()) {
      addToolInputAttributes(
        this.config,
        span,
        toolName,
        safeJsonStringify(toolInput) ?? '{}',
      );
    }

    // Generate unique tool_use_id for hook tracking
    const toolUseId = generateToolUseId();

    // Get MessageBus for hook execution
    const messageBus = this.config.getMessageBus() as MessageBus | undefined;
    const hooksEnabled = !this.config.getDisableAllHooks();

    // PreToolUse Hook
    if (hooksEnabled && messageBus) {
      // Convert ApprovalMode to permission_mode string for hooks
      const permissionMode = this.config.getApprovalMode();
      const preHookResult = await this.withHookSpan(
        { hookEvent: 'PreToolUse', toolName: canonicalName, toolUseId },
        () =>
          firePreToolUseHook(
            messageBus,
            canonicalName,
            toolInput,
            toolUseId,
            permissionMode,
          ),
        (r) =>
          r.hookError
            ? {
                success: false,
                error: r.hookError,
                // Hook transport failures do NOT block tool execution
                // (firePreToolUseHook returns shouldProceed:true with a
                // hookError). Surface that on the span too so operators
                // see the same allow-on-failure semantics the runtime
                // applies (#4321 review-2 DeepSeek Suggestion).
                shouldProceed: true,
              }
            : {
                success: true,
                shouldProceed: r.shouldProceed,
                // Propagate the actual blockType ('denied' / 'ask' / 'stop')
                // instead of collapsing every block to 'denied'.
                blockType: r.shouldProceed ? undefined : r.blockType,
                hasAdditionalContext: !!r.additionalContext,
              },
      );
      if (!preHookResult.shouldProceed) {
        // Hook blocked the execution
        const blockMessage =
          preHookResult.blockReason || 'Tool execution blocked by hook';
        const errorResponse = createErrorResponse(
          scheduledCall.request,
          new Error(blockMessage),
          ToolErrorType.EXECUTION_DENIED,
        );
        addToolResultAttributes(
          this.config,
          span,
          toolName,
          `BLOCKED: ${blockMessage}`,
        );
        this.setStatusInternal(callId, 'error', errorResponse);
        setToolSpanFailure(
          span,
          TOOL_FAILURE_KIND_PRE_HOOK_BLOCKED,
          TOOL_SPAN_STATUS_PRE_HOOK_BLOCKED,
        );
        return;
      }
    }

    this.setStatusInternal(callId, 'executing');

    const liveOutputCallback = scheduledCall.tool.canUpdateOutput
      ? (outputChunk: ToolResultDisplay) => {
          if (this.outputUpdateHandler) {
            this.outputUpdateHandler(callId, outputChunk);
          }
          this.toolCalls = this.toolCalls.map((tc) =>
            tc.request.callId === callId && tc.status === 'executing'
              ? { ...tc, liveOutput: outputChunk }
              : tc,
          );
          this.notifyToolCallsUpdate();
        }
      : undefined;

    const shellExecutionConfig = this.config.getShellExecutionConfig();

    // TODO: Refactor to remove special casing for ShellToolInvocation.
    // Introduce a generic callbacks object for the execute method to handle
    // things like `onPid` and `onLiveOutput`. This will make the scheduler
    // agnostic to the invocation type.
    //
    // Start the execution sub-span BEFORE invocation.execute() so its
    // synchronous setup (shell command preprocessing, child_process.spawn,
    // etc.) is bracketed by the span. We don't manually activate the span
    // as OTel context here because the surrounding tool span is already
    // active via runInToolSpanContext, and tool implementations don't
    // currently emit nested OTel spans of their own — the span boundary
    // is purely for timing/attribution.
    const execSpan = startToolExecutionSpan();
    // try wraps both invocation.execute() and the await so synchronous
    // throws (e.g. shell setup failure) flow into the same catch as async
    // rejections — otherwise execSpan leaks unended and failure hooks
    // are skipped.
    const sleepInhibitorHandle = acquireSleepInhibitor(
      this.config,
      `Qwen Code is executing tool ${canonicalName}`,
    );
    try {
      let promise: Promise<ToolResult>;
      if (invocation instanceof ShellToolInvocation) {
        const setPidCallback = (pid: number) => {
          this.toolCalls = this.toolCalls.map((tc) =>
            tc.request.callId === callId && tc.status === 'executing'
              ? { ...tc, pid }
              : tc,
          );
          this.notifyToolCallsUpdate();
        };
        // Stash the promote AbortController on the executing tool call so
        // a UI surface (Ctrl+B keybind) can find the foreground shell's
        // promote trigger by callId.
        const setPromoteAbortControllerCallback = (ac: AbortController) => {
          this.toolCalls = this.toolCalls.map((tc) =>
            tc.request.callId === callId && tc.status === 'executing'
              ? { ...tc, promoteAbortController: ac }
              : tc,
          );
          this.notifyToolCallsUpdate();
        };
        promise = invocation.execute(
          signal,
          liveOutputCallback,
          shellExecutionConfig,
          setPidCallback,
          setPromoteAbortControllerCallback,
        );
      } else {
        promise = invocation.execute(
          signal,
          liveOutputCallback,
          shellExecutionConfig,
        );
      }

      const toolResult: ToolResult = await promise;
      // A tool that observes signal.aborted and resolves with a normal
      // ToolResult (no .error field) would otherwise close the execution
      // sub-span as success while the parent tool span ends as cancelled.
      // Mirror the abort signal here — and pass `cancelled: true` so the
      // exec sub-span ends UNSET, matching setToolSpanCancelled on the
      // parent (#4212, #4302 review).
      const aborted = signal.aborted;
      endToolExecutionSpan(execSpan, {
        success: toolResult.error === undefined && !aborted,
        error: aborted
          ? TOOL_SPAN_STATUS_TOOL_CANCELLED
          : toolResult.error
            ? TOOL_SPAN_STATUS_TOOL_ERROR
            : undefined,
        cancelled: aborted,
      });
      if (aborted) {
        // PostToolUseFailure Hook
        let cancelMessage = 'User cancelled tool execution.';
        if (hooksEnabled && messageBus) {
          const failureHookResult = await this.withHookSpan(
            {
              hookEvent: 'PostToolUseFailure',
              toolName: canonicalName,
              toolUseId,
              isInterrupt: true,
            },
            () =>
              safelyFirePostToolUseFailureHook(
                messageBus,
                toolUseId,
                canonicalName,
                toolInput,
                cancelMessage,
                true,
                this.config.getApprovalMode(),
              ),
            this.postToolUseFailureEndMeta,
          );

          // Append additional context from hook if provided
          if (failureHookResult.additionalContext) {
            cancelMessage += `\n\n${failureHookResult.additionalContext}`;
          }
        }
        addToolResultAttributes(
          this.config,
          span,
          toolName,
          `CANCELLED: ${cancelMessage}`,
        );
        this.setStatusInternal(callId, 'cancelled', cancelMessage);
        setToolSpanCancelled(span);
        return; // Both code paths should return here
      }

      if (toolResult.error === undefined) {
        let content = toolResult.llmContent;
        let contentLength: number | undefined =
          typeof content === 'string' ? content.length : undefined;

        // Deferred metadata: PostToolUse hook context and skill/rule reminders
        // are captured here and appended AFTER the model-facing truncation
        // below, so the head/tail truncator never bisects a <system-reminder>
        // envelope or hook-injected context.
        let postToolUseAdditionalContext: string | undefined;
        let reminderEnvelope: string | undefined;

        // PostToolUse Hook
        if (hooksEnabled && messageBus) {
          const toolResponse = {
            llmContent: content,
            returnDisplay: toolResult.returnDisplay,
          };
          const permissionMode = this.config.getApprovalMode();
          const postHookResult = await this.withHookSpan(
            { hookEvent: 'PostToolUse', toolName: canonicalName, toolUseId },
            () =>
              firePostToolUseHook(
                messageBus,
                canonicalName,
                toolInput,
                toolResponse,
                toolUseId,
                permissionMode,
              ),
            (r) =>
              r.hookError
                ? {
                    success: false,
                    error: r.hookError,
                    // Hook transport failures do NOT halt the post-execution
                    // flow (firePostToolUseHook returns shouldStop:false with
                    // a hookError). Mirror the PreToolUse fix so the span
                    // matches runtime semantics (#4321 review-2 DeepSeek
                    // Suggestion).
                    shouldStop: false,
                  }
                : {
                    success: true,
                    shouldStop: r.shouldStop,
                    hasAdditionalContext: !!r.additionalContext,
                    blockType: r.shouldStop ? 'stop' : undefined,
                  },
          );

          // Capture additional context from hook; appended after the
          // model-facing truncation below.
          if (postHookResult.additionalContext) {
            postToolUseAdditionalContext = postHookResult.additionalContext;
          }

          // Check if hook requested to stop execution
          if (postHookResult.shouldStop) {
            const stopMessage =
              postHookResult.stopReason || 'Execution stopped by hook';
            const errorResponse = createErrorResponse(
              scheduledCall.request,
              new Error(stopMessage),
              ToolErrorType.EXECUTION_DENIED,
            );
            addToolResultAttributes(
              this.config,
              span,
              toolName,
              `STOPPED: ${stopMessage}`,
            );
            this.setStatusInternal(callId, 'error', errorResponse);
            setToolSpanFailure(
              span,
              TOOL_FAILURE_KIND_POST_HOOK_STOPPED,
              TOOL_SPAN_STATUS_POST_HOOK_STOPPED,
            );
            return;
          }
        }

        // Universal post-execution truncation gate — persists oversized
        // tool results to disk before system-reminders are appended.
        content = await this.maybePersistLargeToolResult(
          callId,
          toolName,
          content,
        );

        // Collect filesystem paths the tool just touched. Different tools
        // use different parameter names: `file_path` (read/edit/write),
        // `path` (ls, glob), `filePath` (grep, lsp), and `paths`
        // (ripGrep array form). Conditional rules and skill activation
        // both key off the same path set, so inspect the union — and
        // gate the inspection on a tool-name allowlist (see
        // FS_PATH_TOOL_NAMES) so MCP / non-FS tools that reuse those
        // parameter names with different semantics never enter the
        // activation pipeline.
        const inputPaths = extractToolFilePaths(toolName, toolInput);
        const resultPaths =
          isFilesystemPathTool(toolName) &&
          Array.isArray(toolResult.resultFilePaths)
            ? toolResult.resultFilePaths
            : [];
        const candidatePaths = Array.from(
          new Set([...inputPaths.map((p) => unescapePath(p)), ...resultPaths]),
        );

        if (candidatePaths.length > 0) {
          const rulesRegistry = this.config.getConditionalRulesRegistry();
          const skillManager = this.config.getSkillManager();

          // Collect every reminder block produced by this tool call, then
          // emit them as a single `<system-reminder>` envelope at the end.
          // The previous version emitted one envelope per matching rule
          // PLUS one for skill activation — a multi-path tool could
          // produce N+1 envelopes, diluting the model's attention. One
          // wrapper / one append also lets us share the breakout-prevention
          // sanitization step (closing-tag scrub) in one place.
          const reminderBlocks: string[] = [];

          for (const candidatePath of candidatePaths) {
            // Inject conditional rules at most once per session per rule
            // file. The registry tracks dedup internally.
            const rulesCtx = rulesRegistry?.matchAndConsume(candidatePath);
            if (rulesCtx) reminderBlocks.push(rulesCtx);
          }

          // Skill activation runs in a single batch over all candidate paths so
          // the SkillManager change listener (`SkillTool.refreshSkills`) fires
          // once for this tool call. The await is load-bearing:
          // matchAndActivateByPaths resolves only after the listener chain
          // settles, so by the time we append the reminder below the runtime sets
          // already accept the newly activated skill (validateToolParams).
          // Visibility comes from THIS tail reminder (and the startup snapshot),
          // NOT from the tool description — which is now static and never
          // re-rendered. refreshSkills no longer calls setTools(), so activation
          // does not mutate the prompt-cache prefix.
          const activatedSkills =
            await skillManager?.matchAndActivateByPaths(candidatePaths);
          if (activatedSkills && activatedSkills.length > 0 && skillManager) {
            // Subagents share the parent's SkillManager but may run with a
            // restricted toolsList that excludes SkillTool. Announcing a skill
            // such a context can't invoke wastes a turn, so gate on whether the
            // active registry actually exposes SkillTool to the model.
            const hasSkillTool = !!this.toolRegistry.getTool(ToolNames.SKILL);
            if (hasSkillTool) {
              // Render the just-activated skills with their description/whenToUse
              // (the full listing is no longer in the tool description, so the
              // model needs enough here to decide whether to invoke them). Source
              // entries from the shared collector — which applies the same
              // disabled / disable-model-invocation filtering — and keep only the
              // file-based ones that were just activated.
              // renderAvailableSkillsBlock XML-escapes every untrusted field, so
              // a crafted extension name cannot break out of the reminder.
              let activatedEntries: AvailableSkillEntry[] = [];
              try {
                const collected = await collectAvailableSkillEntries(
                  skillManager,
                  this.config,
                );
                const activatedSet = new Set(activatedSkills);
                activatedEntries = collected.entries.filter(
                  (e) => e.level !== undefined && activatedSet.has(e.name),
                );
              } catch (error) {
                debugLogger.warn(
                  'coreToolScheduler: collectAvailableSkillEntries failed in activation path',
                  error,
                );
                activatedEntries = activatedSkills.map((name) => ({
                  name,
                  description: '',
                  level: 'project' as const,
                }));
              }
              if (activatedEntries.length > 0) {
                reminderBlocks.push(
                  `The following skill(s) became available via the Skill tool based on the file you just accessed; invoke a skill by passing its name to the Skill tool:\n<available_skills>\n${renderAvailableSkillsBlock(
                    activatedEntries,
                  )}\n</available_skills>`,
                );
                // Record the announced keys so the client's per-turn drain
                // (drainSkillAndCommandReminders) marks them as announced and
                // does not re-announce them in the same turn's tail reminder.
                // Without this, a subagent activation on a shared SkillManager
                // would land in the subagent's discarded transcript while the
                // parent's drain sees a genuinely-new key and duplicates.
                this.config.addInlineAnnouncedSkillKeys(
                  activatedEntries.map((e) => `skill:${e.name}`),
                );
              }
            }
          }

          if (reminderBlocks.length > 0) {
            const body = escapeSystemReminderTags(reminderBlocks.join('\n\n'));
            // Capture; appended after the model-facing truncation below.
            reminderEnvelope = `<system-reminder>\n${body}\n</system-reminder>`;
          }
        }

        // --- Model-facing output truncation ---
        // 1) Truncate the raw tool output FIRST (per-tool budget if the tool
        //    declares one, else the global threshold), so the head/tail
        //    truncator never bisects the hook/skill metadata appended below.
        // Read the per-tool budget from the already-resolved tool instance.
        // schedule() resolved scheduledCall.tool from the CANONICAL name, so
        // this also covers legacy aliases (e.g. 'task' → agent) that
        // getTool(toolName) — keyed by the raw request name — would miss,
        // silently dropping maxOutputChars / truncateKeep.
        const limitsTool = scheduledCall.tool;
        const perToolMax = limitsTool.maxOutputChars;
        const perToolKeep = limitsTool.truncateKeep;
        // Per-tool budgets are char-only (mirror CC's maxResultSizeChars): when
        // a tool declares its own char budget, the global LINE cap must not
        // undercut it — otherwise read-file's Infinity exemption (self-managed
        // paging) and grep's char budget get silently capped at 1000 lines.
        const perToolLines =
          perToolMax !== undefined ? Number.POSITIVE_INFINITY : undefined;
        const promptIdForTruncation = scheduledCall.request.prompt_id;
        try {
          const truncated = await truncateLlmContent(
            this.config,
            toolName,
            content,
            { threshold: perToolMax, lines: perToolLines, keep: perToolKeep },
            promptIdForTruncation,
          );
          content = truncated.content;
        } catch (truncErr) {
          // A truncation/IO failure must never demote a successful tool call
          // to an error — keep the content and warn.
          debugLogger.warn(
            `TRUNCATION failed for ${toolName}: ${
              truncErr instanceof Error ? truncErr.message : String(truncErr)
            }`,
          );
        }

        // 2) Append the deferred metadata now that the body is bounded.
        if (postToolUseAdditionalContext) {
          content = appendAdditionalContext(
            content,
            postToolUseAdditionalContext,
          );
        }
        if (reminderEnvelope) {
          content = appendAdditionalContext(content, reminderEnvelope);
        }

        // 3) Combined second pass: if metadata was appended and the assembled
        //    string blew past a doubled budget, bound it once more. Skip when
        //    the body was already persisted (contains the sentinel) to avoid
        //    nesting truncation headers. Only the string path is bounded here;
        //    Part[] outputs (e.g. MCP) rely on the per-message batch budget as
        //    their second-level bound — re-truncating a Part[] would mean
        //    re-merging text parts, not worth it for the rare large-metadata case.
        if (
          (postToolUseAdditionalContext || reminderEnvelope) &&
          typeof content === 'string' &&
          !content.startsWith(TOOL_OUTPUT_TRUNCATED_PREFIX)
        ) {
          const baseThreshold =
            perToolMax ?? this.config.getTruncateToolOutputThreshold();
          // Match the first pass's char-only semantics for per-tool budgets;
          // only the global path keeps a (doubled) line cap.
          const combinedLines =
            perToolMax !== undefined
              ? Number.POSITIVE_INFINITY
              : this.config.getTruncateToolOutputLines() * 2;
          if (content.length > baseThreshold * 2) {
            try {
              const recombined = await truncateToolOutput(
                this.config,
                toolName,
                content,
                {
                  threshold: baseThreshold * 2,
                  lines: combinedLines,
                  keep: perToolKeep,
                },
                promptIdForTruncation,
              );
              content = recombined.content;
            } catch (truncErr) {
              debugLogger.warn(
                `TRUNCATION (combined) failed for ${toolName}: ${
                  truncErr instanceof Error
                    ? truncErr.message
                    : String(truncErr)
                }`,
              );
            }
          }
        }

        // Guard the JSON serialization for non-string content. Tool
        // results can contain Part[] with large inlineData/media payloads
        // that we don't want to serialize when telemetry is off.
        if (this.config.getTelemetryIncludeSensitiveSpanAttributes?.()) {
          addToolResultAttributes(
            this.config,
            span,
            toolName,
            typeof content === 'string'
              ? content
              : (safeJsonStringify(content) ?? ''),
          );
        }

        // Recompute AFTER truncation so it reflects the model-facing length,
        // consistent with the batch-offload path (which also updates it).
        contentLength =
          typeof content === 'string' ? content.length : undefined;

        const response = convertToFunctionResponse(toolName, callId, content);
        const successResponse: ToolCallResponseInfo = {
          callId,
          responseParts: response,
          resultDisplay: toolResult.returnDisplay,
          error: undefined,
          errorType: undefined,
          contentLength,
          // Propagate modelOverride from skill tools. Use `in` to distinguish
          // "skill returned undefined (inherit)" from "non-skill tool (no field)".
          ...('modelOverride' in toolResult
            ? { modelOverride: toolResult.modelOverride }
            : {}),
        };
        this.setStatusInternal(callId, 'success', successResponse);
        safeSetStatus(span, { code: SpanStatusCode.OK });
        // Mirrors setToolSpanFailure/setToolSpanCancelled — every tool span
        // ends with an explicit `success` attribute so backends can filter
        // failures the same way they filter llm_request failures.
        try {
          span.setAttribute('success', true);
        } catch {
          // OTel errors must not block API behavior.
        }
      } else {
        // It is a failure
        // PostToolUseFailure Hook
        let errorMessage = toolResult.error.message;
        if (hooksEnabled && messageBus) {
          const failureHookResult = await this.withHookSpan(
            {
              hookEvent: 'PostToolUseFailure',
              toolName: canonicalName,
              toolUseId,
              isInterrupt: false,
            },
            () =>
              safelyFirePostToolUseFailureHook(
                messageBus,
                toolUseId,
                canonicalName,
                toolInput,
                toolResult.error!.message,
                false,
                this.config.getApprovalMode(),
              ),
            this.postToolUseFailureEndMeta,
          );

          // Append additional context from hook if provided
          if (failureHookResult.additionalContext) {
            errorMessage += `\n\n${failureHookResult.additionalContext}`;
          }
        }

        // Truncate oversized error messages (e.g., large stderr)
        const errorGateThreshold =
          this.config.getTruncateToolOutputThreshold() + GATE_HEADROOM;
        if (
          errorMessage.length > errorGateThreshold &&
          !isAlreadyTruncated(errorMessage)
        ) {
          const persistResult = await persistAndTruncateToolResult(
            callId,
            toolName,
            errorMessage,
            this.config,
          );
          errorMessage = persistResult.content;
        }

        addToolResultAttributes(
          this.config,
          span,
          toolName,
          `ERROR: ${errorMessage}`,
        );

        const error = new Error(errorMessage);
        const errorResponse = createErrorResponse(
          scheduledCall.request,
          error,
          toolResult.error.type,
        );
        this.setStatusInternal(callId, 'error', errorResponse);
        setToolSpanFailure(
          span,
          TOOL_FAILURE_KIND_TOOL_ERROR,
          TOOL_SPAN_STATUS_TOOL_ERROR,
        );
      }
    } catch (executionError: unknown) {
      const errorMessage =
        executionError instanceof Error
          ? executionError.message
          : String(executionError);
      // Distinguish user cancellation from real tool exceptions on the
      // execution sub-span so trace backends filtering for errors do not
      // see false positives. Both are still success: false; only the
      // sanitized error message and (for cancellation) the UNSET status
      // differ.
      const aborted = signal.aborted;
      endToolExecutionSpan(execSpan, {
        success: false,
        error: aborted
          ? TOOL_SPAN_STATUS_TOOL_CANCELLED
          : TOOL_SPAN_STATUS_TOOL_EXCEPTION,
        cancelled: aborted,
      });

      if (aborted) {
        // PostToolUseFailure Hook (user interrupt)
        let cancelMessage = 'User cancelled tool execution.';
        if (hooksEnabled && messageBus) {
          const failureHookResult = await this.withHookSpan(
            {
              hookEvent: 'PostToolUseFailure',
              toolName: canonicalName,
              toolUseId,
              isInterrupt: true,
            },
            () =>
              safelyFirePostToolUseFailureHook(
                messageBus,
                toolUseId,
                canonicalName,
                toolInput,
                cancelMessage,
                true,
                this.config.getApprovalMode(),
              ),
            this.postToolUseFailureEndMeta,
          );

          // Append additional context from hook if provided
          if (failureHookResult.additionalContext) {
            cancelMessage += `\n\n${failureHookResult.additionalContext}`;
          }
        }
        addToolResultAttributes(
          this.config,
          span,
          toolName,
          `CANCELLED: ${cancelMessage}`,
        );
        this.setStatusInternal(callId, 'cancelled', cancelMessage);
        setToolSpanCancelled(span);
        return;
      } else {
        // PostToolUseFailure Hook
        let exceptionErrorMessage = errorMessage;
        if (hooksEnabled && messageBus) {
          const failureHookResult = await this.withHookSpan(
            {
              hookEvent: 'PostToolUseFailure',
              toolName: canonicalName,
              toolUseId,
              isInterrupt: false,
            },
            () =>
              safelyFirePostToolUseFailureHook(
                messageBus,
                toolUseId,
                canonicalName,
                toolInput,
                errorMessage,
                false,
                this.config.getApprovalMode(),
              ),
            this.postToolUseFailureEndMeta,
          );

          // Append additional context from hook if provided
          if (failureHookResult.additionalContext) {
            exceptionErrorMessage += `\n\n${failureHookResult.additionalContext}`;
          }
        }
        addToolResultAttributes(
          this.config,
          span,
          toolName,
          `EXCEPTION: ${exceptionErrorMessage}`,
        );
        this.setStatusInternal(
          callId,
          'error',
          createErrorResponse(
            scheduledCall.request,
            executionError instanceof Error
              ? new Error(exceptionErrorMessage)
              : new Error(String(executionError)),
            ToolErrorType.UNHANDLED_EXCEPTION,
          ),
        );
        setToolSpanFailure(
          span,
          TOOL_FAILURE_KIND_TOOL_EXCEPTION,
          TOOL_SPAN_STATUS_TOOL_EXCEPTION,
        );
      }
    } finally {
      sleepInhibitorHandle.release();
    }
  }

  private async checkAndNotifyCompletion(): Promise<void> {
    const allCallsAreTerminal = this.toolCalls.every(
      (call) =>
        call.status === 'success' ||
        call.status === 'error' ||
        call.status === 'cancelled',
    );

    if (this.toolCalls.length > 0 && allCallsAreTerminal) {
      let completedCalls = [...this.toolCalls] as CompletedToolCall[];
      this.toolCalls = [];
      this.isFinalizingToolCalls = true;
      const batchSignal = completedCalls
        .map((call) =>
          this.callIdToPostToolBatchSignal.get(call.request.callId),
        )
        .find((candidate): candidate is AbortSignal => !!candidate);
      for (const call of completedCalls) {
        this.callIdToPostToolBatchSignal.delete(call.request.callId);
      }

      let messageBus: MessageBus | undefined;
      try {
        const shouldFirePostToolBatch =
          !this.config.getDisableAllHooks() &&
          (this.config.hasHooksForEvent?.('PostToolBatch') ?? false);
        messageBus = shouldFirePostToolBatch
          ? this.config.getMessageBus()
          : undefined;
      } catch (error) {
        debugLogger.warn(
          `PostToolBatch hook setup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      try {
        if (messageBus) {
          const batchToolCalls = completedCalls.map(toPostToolBatchToolCall);
          const permissionMode = this.config.getApprovalMode();
          const batchHookResult = await this.withHookSpan(
            { hookEvent: 'PostToolBatch', toolName: 'batch' },
            () =>
              firePostToolBatchHook(
                messageBus,
                batchToolCalls,
                permissionMode,
                batchSignal,
              ),
            (r) =>
              r.hookError
                ? {
                    success: false,
                    error: r.hookError,
                    shouldStop: false,
                    postBatchStop: false,
                  }
                : {
                    success: true,
                    shouldStop: r.shouldStop,
                    hasAdditionalContext: !!r.additionalContext,
                    blockType: r.shouldStop ? 'stop' : undefined,
                    postBatchStop: r.shouldStop,
                    postBatchStopReason: r.shouldStop
                      ? r.stopReason || 'no reason given'
                      : undefined,
                  },
          );

          // Order matters: stop replaces the last response, so append
          // additionalContext only after the stop decision is applied.
          if (batchHookResult.shouldStop) {
            debugLogger.info(
              `PostToolBatch hook stopped batch (${completedCalls.length} calls): ${
                batchHookResult.stopReason || 'no reason given'
              }`,
            );
            completedCalls = withPostToolBatchStop(
              completedCalls,
              batchHookResult.stopReason ||
                'Execution stopped by PostToolBatch hook',
            );
          }

          completedCalls = withPostToolBatchAdditionalContext(
            completedCalls,
            batchHookResult.additionalContext,
          );
        }

        // Per-message budget: offload the largest results if the batch's
        // combined model-facing output exceeds the budget, before recording
        // and notifying so both consumers see the same (bounded) version.
        completedCalls = await this.applyBatchOutputBudget(completedCalls);

        for (const call of completedCalls) {
          logToolCall(this.config, new ToolCallEvent(call));
        }

        // Record tool results before notifying completion
        this.recordToolResults(completedCalls);

        if (this.onAllToolCallsComplete) {
          await this.onAllToolCallsComplete(completedCalls);
        }
        this.notifyToolCallsUpdate();
      } finally {
        this.isFinalizingToolCalls = false;
        // Always drain the queue, even if completion callbacks throw.
        if (this.requestQueue.length > 0) {
          const next = this.requestQueue.shift()!;
          this._schedule(next.request, next.signal)
            .then(next.resolve)
            .catch(next.reject);
        }
      }
    }
  }

  private async maybePersistLargeToolResult(
    callId: string,
    toolName: string,
    content: PartListUnion,
  ): Promise<PartListUnion> {
    if (GATE_EXEMPT_TOOLS.has(toolName)) return content;

    const text = extractTextFromPartListUnion(content);
    if (!text || isAlreadyTruncated(text)) return content;

    const gateThreshold =
      this.config.getTruncateToolOutputThreshold() + GATE_HEADROOM;
    if (text.length <= gateThreshold) return content;

    const result = await persistAndTruncateToolResult(
      callId,
      toolName,
      text,
      this.config,
    );

    if (result.outputFile) {
      debugLogger.debug(
        `Persisted ${toolName} result (${result.bytesWritten} bytes) to ${result.outputFile}`,
      );
    }

    // Preserve non-text parts (media) when content is Part[]
    if (Array.isArray(content)) {
      const mediaParts = content.filter(
        (p) =>
          (p as { inlineData?: unknown }).inlineData ||
          (p as { fileData?: unknown }).fileData,
      );
      const stubPart: Part = { text: result.content };
      return mediaParts.length > 0 ? [stubPart, ...mediaParts] : [stubPart];
    }

    return result.content;
  }

  /**
   * Records tool results to the chat recording service.
   * This captures both the raw Content (for API reconstruction) and
   * enriched metadata (for UI recovery).
   */
  private recordToolResults(completedCalls: CompletedToolCall[]): void {
    if (!this.chatRecordingService) return;

    // Collect all response parts from completed calls
    const responseParts: Part[] = completedCalls.flatMap(
      (call) => call.response.responseParts,
    );

    if (responseParts.length === 0) return;

    // Record each tool result individually
    for (const call of completedCalls) {
      this.chatRecordingService.recordToolResult(call.response.responseParts, {
        callId: call.request.callId,
        status: call.status,
        resultDisplay: call.response.resultDisplay,
        error: call.response.error,
        errorType: call.response.errorType,
      });
    }
  }

  /**
   * Per-message tool-result budget. When the combined model-facing output of a
   * completed batch exceeds `toolOutputBatchBudget`, the largest results are
   * offloaded to disk (greedily, largest first) until the batch is back under
   * budget. Idempotent: already-persisted / media-bearing results are skipped.
   */
  private async applyBatchOutputBudget(
    completedCalls: CompletedToolCall[],
  ): Promise<CompletedToolCall[]> {
    const budget =
      this.config.getToolOutputBatchBudget?.() ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(budget)) return completedCalls;

    const sizes = completedCalls.map(batchResponseOutputSize);
    let total = sizes.reduce((sum, size) => sum + size, 0);
    if (total <= budget) return completedCalls;

    // Offload the largest results first until back under budget.
    const order = completedCalls
      .map((_, i) => i)
      .sort((a, b) => sizes[b] - sizes[a]);

    const result = [...completedCalls];
    let offloaded = 0;
    for (const i of order) {
      if (total <= budget) break;
      const replaced = await this.offloadCallOutput(result[i]);
      if (!replaced) continue;
      total -= sizes[i] - batchResponseOutputSize(replaced);
      result[i] = replaced;
      offloaded++;
    }
    if (offloaded > 0) {
      debugLogger.info(
        `Batch output budget (${budget} chars): offloaded ${offloaded} largest result(s) to disk.`,
      );
    }
    if (total > budget) {
      // Could not get under budget — e.g. a single per-tool result whose
      // ceiling (MCP's 500k) exceeds the 200k batch budget, or results already
      // persisted (sentinel-bearing) and therefore skipped. Surface it instead
      // of silently exceeding the per-message budget.
      debugLogger.warn(
        `Batch output budget (${budget} chars) still exceeded after offloading ${offloaded}: ${total} chars across ${completedCalls.length} result(s).`,
      );
    }
    return result;
  }

  /**
   * Spill a single completed call's text output to disk, replacing it with a
   * small preview + recoverable pointer. Returns null (skip) for non-success,
   * multi-part, media-bearing, or already-persisted results.
   */
  private async offloadCallOutput(
    call: CompletedToolCall,
  ): Promise<CompletedToolCall | null> {
    if (call.status !== 'success') return null;
    const parts = call.response.responseParts;
    if (parts.length !== 1) return null;
    const fr = parts[0]?.functionResponse;
    if (!fr) return null;
    const output = fr.response?.['output'];
    if (typeof output !== 'string') return null;
    if (fr.parts && fr.parts.length > 0) return null; // media present
    if (output.startsWith(TOOL_OUTPUT_TRUNCATED_PREFIX)) return null; // already
    if (output.startsWith('<persisted-output>')) return null;

    let truncated: { content: string; outputFile?: string };
    try {
      truncated = await truncateToolOutput(
        this.config,
        call.request.name,
        output,
        { threshold: BATCH_OFFLOAD_PREVIEW_CHARS },
        call.request.prompt_id,
      );
    } catch {
      return null; // offload failure must not break the batch
    }
    if (!truncated.outputFile) return null;

    return {
      ...call,
      response: {
        ...call.response,
        responseParts: [
          {
            functionResponse: {
              id: fr.id,
              name: fr.name,
              response: { output: truncated.content },
            },
          },
        ],
        contentLength: truncated.content.length,
      },
    };
  }

  private notifyToolCallsUpdate(): void {
    if (this.onToolCallsUpdate) {
      this.onToolCallsUpdate([...this.toolCalls]);
    }
  }

  private setToolCallOutcome(callId: string, outcome: ToolConfirmationOutcome) {
    this.toolCalls = this.toolCalls.map((call) => {
      if (call.request.callId !== callId) return call;
      return {
        ...call,
        outcome,
      };
    });
  }

  private async autoApproveCompatiblePendingTools(
    signal: AbortSignal,
    triggeringCallId: string,
  ): Promise<void> {
    const pendingTools = this.toolCalls.filter(
      (call) =>
        call.status === 'awaiting_approval' &&
        call.request.callId !== triggeringCallId,
    ) as WaitingToolCall[];

    for (const pendingTool of pendingTools) {
      try {
        // Re-run L3→L4 to see if the tool can now be auto-approved
        const toolParams = pendingTool.invocation.params as Record<
          string,
          unknown
        >;
        const flowResult = await evaluatePermissionFlow(
          this.config,
          pendingTool.invocation,
          pendingTool.request.name,
          toolParams,
        );
        const { finalPermission, pmForcedAsk, pmCtx } = flowResult;

        const forceAutoReviewForAllow =
          this.config.getApprovalMode() === ApprovalMode.AUTO &&
          shouldForceAutoModeReviewForAllow(pmCtx, this.config.getCwd());

        if (finalPermission === 'allow' && forceAutoReviewForAllow) {
          debugLogger.info(
            `Auto mode: pending L4 allow overridden by protected-write guard for ${pendingTool.request.name}`,
          );
          const denialState = this.config.getAutoModeDenialState();
          const fallback = shouldFallback(denialState);
          const messages =
            this.config
              .getGeminiClient?.()
              ?.getHistoryTail(MAX_TRANSCRIPT_MESSAGES, false) ?? [];
          const decision = await evaluateAutoMode({
            ctx: pmCtx,
            pmForcedAsk,
            toolParams,
            messages,
            config: this.config,
            signal,
            skipClassifierReason: fallback.fallback
              ? fallback.reason
              : undefined,
          });

          const outcome = applyAutoModeDecision(
            decision,
            this.config,
            denialState,
          );
          if (
            !this.config.getDisableAllHooks() &&
            shouldFirePermissionDeniedForAutoMode(decision, outcome)
          ) {
            try {
              await this.config
                .getHookSystem?.()
                ?.firePermissionDeniedEvent(
                  pendingTool.request.name,
                  toolParams,
                  pendingTool.request.callId,
                  getAutoModePermissionDeniedReason(decision),
                  signal,
                );
            } catch (hookError) {
              debugLogger.warn(
                `PermissionDenied hook failed for pending tool ${pendingTool.request.callId}: ${hookError instanceof Error ? hookError.message : String(hookError)}`,
              );
            }
          }
          switch (outcome.kind) {
            case 'approved':
              this.setToolCallOutcome(
                pendingTool.request.callId,
                ToolConfirmationOutcome.ProceedAlways,
              );
              this.setStatusInternal(pendingTool.request.callId, 'scheduled');
              this.finalizeBlockedSpan(
                pendingTool.request.callId,
                'auto_approved',
                'auto',
              );
              break;
            case 'blocked': {
              this.setStatusInternal(
                pendingTool.request.callId,
                'error',
                createErrorResponse(
                  pendingTool.request,
                  new Error(outcome.errorMessage),
                  ToolErrorType.EXECUTION_DENIED,
                ),
              );
              this.finalizeBlockedSpan(
                pendingTool.request.callId,
                'error',
                'auto',
              );
              const toolSpan = this.toolSpans.get(pendingTool.request.callId);
              if (toolSpan) {
                setToolSpanFailure(
                  toolSpan,
                  TOOL_FAILURE_KIND_PERMISSION_DENIED,
                  TOOL_SPAN_STATUS_PERMISSION_DENIED,
                );
                this.finalizeToolSpan(pendingTool.request.callId);
              }
              break;
            }
            case 'fallback':
              if (fallback.fallback) {
                this.autoModeFallbackCallIds.add(pendingTool.request.callId);
                debugLogger.warn(
                  `Auto mode fallback for pending tool (${fallback.reason}): consecutiveBlock=${denialState.consecutiveBlock}, consecutiveUnavailable=${denialState.consecutiveUnavailable}`,
                );
              }
              break;
            default: {
              const _exhaustive: never = outcome;
              void _exhaustive;
            }
          }
          if (
            outcome.kind === 'approved' ||
            outcome.kind === 'blocked' ||
            outcome.kind === 'fallback'
          ) {
            continue;
          }
        }

        if (finalPermission === 'allow') {
          this.setToolCallOutcome(
            pendingTool.request.callId,
            ToolConfirmationOutcome.ProceedAlways,
          );
          this.setStatusInternal(pendingTool.request.callId, 'scheduled');
          // Sister tool was waiting on the user but a sibling's
          // ProceedAlways* outcome auto-approved it. Close the blocked span
          // with auto_approved so the trace explains why this branch
          // skipped a manual decision (#3731 Phase 2).
          this.finalizeBlockedSpan(
            pendingTool.request.callId,
            'auto_approved',
            'auto',
          );
        }
      } catch (error) {
        debugLogger.error(
          `Error checking confirmation for tool ${pendingTool.request.callId}:`,
          error,
        );
        // Intentionally do NOT finalize the blocked span here: the tool
        // remains in `awaiting_approval` and the user can still respond.
        // Closing the span on a transient permission-flow error would
        // make the user's eventual decision a no-op (Map already cleared)
        // and the actual decision/source would be lost. If the user
        // never responds, the 30-min TTL in session-tracing.ts cleans
        // up the span (#4321 codex P3 review).
      }
    }
  }
}
