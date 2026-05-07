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
  fireNotificationHook,
  firePermissionRequestHook,
  appendAdditionalContext,
} from './toolHookTriggers.js';
import { NotificationType } from '../hooks/types.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';

const debugLogger = createDebugLogger('TOOL_SCHEDULER');
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
import { escapeXml } from '../utils/xml.js';
import { unescapePath, PATH_ARG_KEYS } from '../utils/paths.js';
import { CONCURRENCY_SAFE_KINDS } from '../tools/tools.js';
import { isShellCommandReadOnly } from '../utils/shellReadOnlyChecker.js';
import { stripShellWrapper } from '../utils/shell-utils.js';
import {
  injectPermissionRulesIfMissing,
  persistPermissionOutcome,
} from './permission-helpers.js';
import {
  evaluatePermissionFlow,
  needsConfirmation,
  isPlanModeBlocked,
  isAutoEditApproved,
} from './permissionFlow.js';
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
 * Returns true if a scheduled tool call can safely execute concurrently
 * with other safe tools (no side effects, no shared mutable state).
 */
function isConcurrencySafe(call: ScheduledToolCall): boolean {
  // Agent tools spawn independent sub-agents with no shared state.
  if (call.request.name === ToolNames.AGENT) return true;
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
    this.checkAndNotifyCompletion();
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

  private buildInvocation(
    tool: AnyDeclarativeTool,
    args: object,
    callId?: string,
  ): AnyToolInvocation | Error {
    try {
      const invocation = tool.build(structuredClone(args));
      if (callId) {
        const maybeAware = invocation as { setCallId?: (id: string) => void };
        if (typeof maybeAware.setCallId === 'function') {
          maybeAware.setCallId(callId);
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
      const requestsToProcess = Array.isArray(request) ? request : [request];

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
        // Check if the tool is excluded due to permissions/environment restrictions
        // This check should happen before registry lookup to provide a clear permission error
        const pm = this.config.getPermissionManager?.();
        if (pm && !(await pm.isToolEnabled(reqInfo.name))) {
          const matchingRule = pm.findMatchingDenyRule({
            toolName: reqInfo.name,
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
            const normalizedToolName = reqInfo.name.toLowerCase().trim();
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

        const toolInstance = await this.toolRegistry.ensureTool(reqInfo.name);
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
        );
        if (invocationOrError instanceof Error) {
          const baseError = reqInfo.wasOutputTruncated
            ? new Error(
                `${invocationOrError.message} ${TRUNCATION_PARAM_GUIDANCE}`,
              )
            : invocationOrError;

          // Track validation retry for loop detection. Counts accumulate per
          // (tool, error message) pair so a different validation mistake on
          // the same tool starts fresh rather than tripping the threshold.
          const errorKey = `${reqInfo.name}:${baseError.message}`;
          const count = (this.validationRetryCounts.get(errorKey) ?? 0) + 1;
          for (const key of this.validationRetryCounts.keys()) {
            if (key.startsWith(`${reqInfo.name}:`) && key !== errorKey) {
              this.validationRetryCounts.delete(key);
            }
          }
          this.validationRetryCounts.set(errorKey, count);

          const finalError =
            count >= VALIDATION_RETRY_LOOP_THRESHOLD
              ? new Error(`${baseError.message}${RETRY_LOOP_STOP_DIRECTIVE}`)
              : baseError;

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

      for (const toolCall of newToolCalls) {
        if (toolCall.status !== 'validating') {
          continue;
        }

        const { request: reqInfo, invocation } = toolCall;

        try {
          if (signal.aborted) {
            this.setStatusInternal(
              reqInfo.callId,
              'cancelled',
              'Tool call cancelled by user.',
            );
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
            reqInfo.name,
            toolParams,
          );
          const { finalPermission, pmForcedAsk, pmCtx, denyMessage } =
            flowResult;

          // ---- L5: Final decision based on permission + ApprovalMode ----
          const approvalMode = this.config.getApprovalMode();
          const isPlanMode = approvalMode === ApprovalMode.PLAN;
          const isExitPlanModeTool = reqInfo.name === 'exit_plan_mode';

          if (finalPermission === 'allow') {
            // Auto-approve: tool is inherently safe (read-only) or PM allows
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
            continue;
          }

          // finalPermission === 'ask' (or 'default' from PM → treat as ask)
          // apply ApprovalMode overrides.
          // ask_user_question always needs confirmation so the user can answer;
          // it must bypass both YOLO auto-approve and plan-mode blocking.
          const isAskUserQuestionTool =
            reqInfo.name === ToolNames.ASK_USER_QUESTION;
          let confirmationDetails: ToolCallConfirmationDetails | undefined;

          if (!needsConfirmation(finalPermission, approvalMode, reqInfo.name)) {
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
                reqInfo.name,
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
        }
      }
      await this.attemptExecutionOfScheduledCalls(signal);
      void this.checkAndNotifyCompletion();
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

    if (outcome === ToolConfirmationOutcome.Cancel || signal.aborted) {
      // Use custom cancel message from payload if provided, otherwise use default
      const cancelMessage =
        payload?.cancelMessage || 'User did not allow tool call';
      this.setStatusInternal(callId, 'cancelled', cancelMessage);
    } else if (outcome === ToolConfirmationOutcome.ModifyWithEditor) {
      const waitingToolCall = toolCall as WaitingToolCall;
      if (isModifiableDeclarativeTool(waitingToolCall.tool)) {
        const modifyContext = waitingToolCall.tool.getModifyContext(signal);
        const editorType = this.getPreferredEditor();
        if (!editorType) {
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
    }
    await this.attemptExecutionOfScheduledCalls(signal);
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
    const invocation = scheduledCall.invocation;
    const toolInput = scheduledCall.request.args as Record<string, unknown>;

    // Normalize shell-escaped path params so hooks operate on actual filesystem
    // paths, matching the normalization done in tool validation.
    for (const key of PATH_ARG_KEYS) {
      if (typeof toolInput[key] === 'string') {
        toolInput[key] = unescapePath(String(toolInput[key]).trim());
      }
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
      const preHookResult = await firePreToolUseHook(
        messageBus,
        toolName,
        toolInput,
        toolUseId,
        permissionMode,
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
        this.setStatusInternal(callId, 'error', errorResponse);
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
      promise = invocation.execute(
        signal,
        liveOutputCallback,
        shellExecutionConfig,
        setPidCallback,
      );
    } else {
      promise = invocation.execute(
        signal,
        liveOutputCallback,
        shellExecutionConfig,
      );
    }

    try {
      const toolResult: ToolResult = await promise;
      if (signal.aborted) {
        // PostToolUseFailure Hook
        if (hooksEnabled && messageBus) {
          const failureHookResult = await firePostToolUseFailureHook(
            messageBus,
            toolUseId,
            toolName,
            toolInput,
            'User cancelled tool execution.',
            true,
            this.config.getApprovalMode(),
          );

          // Append additional context from hook if provided
          let cancelMessage = 'User cancelled tool execution.';
          if (failureHookResult.additionalContext) {
            cancelMessage += `\n\n${failureHookResult.additionalContext}`;
          }
          this.setStatusInternal(callId, 'cancelled', cancelMessage);
        } else {
          this.setStatusInternal(
            callId,
            'cancelled',
            'User cancelled tool execution.',
          );
        }
        return; // Both code paths should return here
      }

      if (toolResult.error === undefined) {
        let content = toolResult.llmContent;
        const contentLength =
          typeof content === 'string' ? content.length : undefined;

        // PostToolUse Hook
        if (hooksEnabled && messageBus) {
          const toolResponse = {
            llmContent: content,
            returnDisplay: toolResult.returnDisplay,
          };
          const permissionMode = this.config.getApprovalMode();
          const postHookResult = await firePostToolUseHook(
            messageBus,
            toolName,
            toolInput,
            toolResponse,
            toolUseId,
            permissionMode,
          );

          // Append additional context from hook if provided
          if (postHookResult.additionalContext) {
            content = appendAdditionalContext(
              content,
              postHookResult.additionalContext,
            );
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
            this.setStatusInternal(callId, 'error', errorResponse);
            return;
          }
        }

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

          // Skill activation runs in a single batch over all candidate
          // paths so `notifyChangeListeners` (and therefore
          // `SkillTool.refreshSkills` / `geminiClient.setTools()`) fires
          // exactly once for this tool call, regardless of how many
          // paths produced new activations. The await is load-bearing:
          // matchAndActivateByPaths only resolves after the listener
          // chain settles, so the activation reminder we append below
          // never lands in a turn where <available_skills> is still
          // stale.
          const activatedSkills =
            await skillManager?.matchAndActivateByPaths(candidatePaths);
          if (activatedSkills && activatedSkills.length > 0) {
            // Subagents share the parent's SkillManager but may have a
            // restricted toolsList that excludes SkillTool entirely.
            // Telling such a context "skill X is now available via the
            // Skill tool" is misleading — the subagent can't invoke it
            // and would waste a turn trying. Gate the reminder on
            // whether the active tool registry actually exposes
            // SkillTool to the model.
            const hasSkillTool = !!this.toolRegistry.getTool(ToolNames.SKILL);
            if (hasSkillTool) {
              // Escape skill names defensively: validateSkillName already
              // excludes `<>&` for parsed file-based skills, but
              // extension skills (extension.skills array) bypass that
              // validator. A crafted extension name would otherwise
              // close the <system-reminder> envelope early.
              const names = activatedSkills.map(escapeXml).join(', ');
              reminderBlocks.push(
                `The following skill(s) are now available via the Skill tool based on the file you just accessed: ${names}. Use them if relevant to the task.`,
              );
            }
          }

          if (reminderBlocks.length > 0) {
            // Final closing-tag scrub on the joined body — defense in
            // depth against rules whose markdown body contains a
            // literal `</system-reminder>` sequence (which would
            // otherwise close our envelope mid-content). Full XML
            // escaping would mangle code blocks in rule bodies; the
            // targeted scrub is the minimum needed to keep the
            // envelope intact.
            const body = reminderBlocks
              .join('\n\n')
              .replace(/<\/system-reminder>/gi, '<\\/system-reminder>');
            content = appendAdditionalContext(
              content,
              `<system-reminder>\n${body}\n</system-reminder>`,
            );
          }
        }

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
      } else {
        // It is a failure
        // PostToolUseFailure Hook
        let errorMessage = toolResult.error.message;
        if (hooksEnabled && messageBus) {
          const failureHookResult = await firePostToolUseFailureHook(
            messageBus,
            toolUseId,
            toolName,
            toolInput,
            toolResult.error.message,
            false,
            this.config.getApprovalMode(),
          );

          // Append additional context from hook if provided
          if (failureHookResult.additionalContext) {
            errorMessage += `\n\n${failureHookResult.additionalContext}`;
          }
        }

        const error = new Error(errorMessage);
        const errorResponse = createErrorResponse(
          scheduledCall.request,
          error,
          toolResult.error.type,
        );
        this.setStatusInternal(callId, 'error', errorResponse);
      }
    } catch (executionError: unknown) {
      const errorMessage =
        executionError instanceof Error
          ? executionError.message
          : String(executionError);

      if (signal.aborted) {
        // PostToolUseFailure Hook (user interrupt)
        if (hooksEnabled && messageBus) {
          const failureHookResult = await firePostToolUseFailureHook(
            messageBus,
            toolUseId,
            toolName,
            toolInput,
            'User cancelled tool execution.',
            true,
            this.config.getApprovalMode(),
          );

          // Append additional context from hook if provided
          let cancelMessage = 'User cancelled tool execution.';
          if (failureHookResult.additionalContext) {
            cancelMessage += `\n\n${failureHookResult.additionalContext}`;
          }
          this.setStatusInternal(callId, 'cancelled', cancelMessage);
        } else {
          this.setStatusInternal(
            callId,
            'cancelled',
            'User cancelled tool execution.',
          );
        }
        return;
      } else {
        // PostToolUseFailure Hook
        let exceptionErrorMessage = errorMessage;
        if (hooksEnabled && messageBus) {
          const failureHookResult = await firePostToolUseFailureHook(
            messageBus,
            toolUseId,
            toolName,
            toolInput,
            errorMessage,
            false,
            this.config.getApprovalMode(),
          );

          // Append additional context from hook if provided
          if (failureHookResult.additionalContext) {
            exceptionErrorMessage += `\n\n${failureHookResult.additionalContext}`;
          }
        }
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
      }
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
      const completedCalls = [...this.toolCalls] as CompletedToolCall[];
      this.toolCalls = [];

      for (const call of completedCalls) {
        logToolCall(this.config, new ToolCallEvent(call));
      }

      // Record tool results before notifying completion
      this.recordToolResults(completedCalls);

      if (this.onAllToolCallsComplete) {
        this.isFinalizingToolCalls = true;
        await this.onAllToolCallsComplete(completedCalls);
        this.isFinalizingToolCalls = false;
      }
      this.notifyToolCallsUpdate();
      // After completion, process the next item in the queue.
      if (this.requestQueue.length > 0) {
        const next = this.requestQueue.shift()!;
        this._schedule(next.request, next.signal)
          .then(next.resolve)
          .catch(next.reject);
      }
    }
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
        const { finalPermission } = flowResult;

        if (finalPermission === 'allow') {
          this.setToolCallOutcome(
            pendingTool.request.callId,
            ToolConfirmationOutcome.ProceedAlways,
          );
          this.setStatusInternal(pendingTool.request.callId, 'scheduled');
        }
      } catch (error) {
        debugLogger.error(
          `Error checking confirmation for tool ${pendingTool.request.callId}:`,
          error,
        );
      }
    }
  }
}
