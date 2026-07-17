/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Config,
  ToolCallRequestInfo,
  ExecutingToolCall,
  ScheduledToolCall,
  ValidatingToolCall,
  WaitingToolCall,
  CompletedToolCall,
  CancelledToolCall,
  OutputUpdateHandler,
  AllToolCallsCompleteHandler,
  ToolCallsUpdateHandler,
  ToolCall,
  Status as CoreStatus,
  EditorType,
} from '@qwen-code/qwen-code-core';
import {
  CoreToolScheduler,
  compactToolResultDisplayForHistory,
  convertToFunctionErrorResponse,
  createDebugLogger,
  getToolResponseDisplayText,
  isAnyAutoMemPath,
  isShellProgressData,
  ToolErrorType,
} from '@qwen-code/qwen-code-core';
import * as path from 'node:path';
import { useCallback, useState, useMemo } from 'react';
import type {
  HistoryItemToolGroup,
  IndividualToolCallDisplay,
} from '../types.js';
import { ToolCallStatus } from '../types.js';
import { isCollapsibleTool } from '../components/messages/CompactToolGroupDisplay.js';

const debugLogger = createDebugLogger('REACT_TOOL_SCHEDULER');

export type ScheduleFn = (
  request: ToolCallRequestInfo | ToolCallRequestInfo[],
  signal: AbortSignal,
  modelOverride?: string,
) => void;
export type MarkToolsAsSubmittedFn = (callIds: string[]) => void;

export type TrackedScheduledToolCall = ScheduledToolCall & {
  responseSubmittedToGemini?: boolean;
};
export type TrackedValidatingToolCall = ValidatingToolCall & {
  responseSubmittedToGemini?: boolean;
};
export type TrackedWaitingToolCall = WaitingToolCall & {
  responseSubmittedToGemini?: boolean;
};
/**
 * NOTE on inherited fields: `pid?` and `promoteAbortController?` come
 * from the core `ExecutingToolCall` type via the `&` intersection —
 * we do NOT redeclare them here. `promoteAbortController` is set by
 * `coreToolScheduler` when the shell tool's
 * `setPromoteAbortControllerCallback` fires, and is read by the
 * Ctrl+B keybind handler in `AppContainer.handleGlobalKeypress`.
 * Aborting with reason `{ kind: 'background' }` triggers the
 * `ShellExecutionService` promote handoff; `shell.ts` then registers
 * a `BackgroundShellEntry` and the child keeps running. The optional
 * `shellId` field on the abort reason is generated downstream by
 * `handlePromotedForeground` — callers leave it unset.
 *
 * The compile-time assertions below pin the inheritance: if a future
 * core change renames or removes `pid` / `promoteAbortController` from
 * `ExecutingToolCall`, these assertions break the React-side build
 * (loud + local) instead of silently breaking the Ctrl+B handler at
 * runtime. Cheaper than re-declaring the fields here (which the
 * earlier review flagged as redundant noise on top of the
 * intersection).
 */
type _AssertExecutingHasPid = 'pid' extends keyof ExecutingToolCall
  ? true
  : never;
type _AssertExecutingHasPromoteAc =
  'promoteAbortController' extends keyof ExecutingToolCall ? true : never;
// Construct so the type-only assertion above isn't dead code.
const _ASSERT_INHERITED_FIELDS_PRESENT: _AssertExecutingHasPid &
  _AssertExecutingHasPromoteAc = true;
void _ASSERT_INHERITED_FIELDS_PRESENT;

export type TrackedExecutingToolCall = ExecutingToolCall & {
  responseSubmittedToGemini?: boolean;
};
export type TrackedCompletedToolCall = CompletedToolCall & {
  responseSubmittedToGemini?: boolean;
};
export type TrackedCancelledToolCall = CancelledToolCall & {
  responseSubmittedToGemini?: boolean;
};

export type TrackedToolCall =
  | TrackedScheduledToolCall
  | TrackedValidatingToolCall
  | TrackedWaitingToolCall
  | TrackedExecutingToolCall
  | TrackedCompletedToolCall
  | TrackedCancelledToolCall;

export function useReactToolScheduler(
  onComplete: (tools: CompletedToolCall[]) => Promise<void>,
  config: Config,
  getPreferredEditor: () => EditorType | undefined,
  onEditorClose: () => void,
): [TrackedToolCall[], ScheduleFn, MarkToolsAsSubmittedFn] {
  const [toolCallsForDisplay, setToolCallsForDisplay] = useState<
    TrackedToolCall[]
  >([]);

  const outputUpdateHandler: OutputUpdateHandler = useCallback(
    (toolCallId, outputChunk) => {
      // Shell liveness heartbeats are for headless consumers; the TUI
      // already shows a spinner and must not replace accumulated live
      // output with a stats object.
      if (isShellProgressData(outputChunk)) {
        return;
      }
      const compactOutput = compactToolResultDisplayForHistory(outputChunk);
      setToolCallsForDisplay((prevCalls) =>
        prevCalls.map((tc) => {
          if (tc.request.callId === toolCallId && tc.status === 'executing') {
            const executingTc = tc as TrackedExecutingToolCall;
            return { ...executingTc, liveOutput: compactOutput };
          }
          return tc;
        }),
      );
    },
    [],
  );

  const allToolCallsCompleteHandler: AllToolCallsCompleteHandler = useCallback(
    async (completedToolCalls) => {
      await onComplete(completedToolCalls);
    },
    [onComplete],
  );

  const toolCallsUpdateHandler: ToolCallsUpdateHandler = useCallback(
    (updatedCoreToolCalls: ToolCall[]) => {
      setToolCallsForDisplay((prevTrackedCalls) =>
        updatedCoreToolCalls.map((coreTc) => {
          const existingTrackedCall = prevTrackedCalls.find(
            (ptc) => ptc.request.callId === coreTc.request.callId,
          );
          // Start with the new core state, then layer on the existing UI state
          // to ensure UI-only properties like pid are preserved.
          const responseSubmittedToGemini =
            existingTrackedCall?.responseSubmittedToGemini ?? false;

          if (coreTc.status === 'executing') {
            // `...coreTc` already spreads `pid` and
            // `promoteAbortController` from the core `ExecutingToolCall`
            // — no need to re-project. `liveOutput` is the only React-
            // side state we need to carry over from the previous tracked
            // version of this call.
            return {
              ...coreTc,
              responseSubmittedToGemini,
              liveOutput: (existingTrackedCall as TrackedExecutingToolCall)
                ?.liveOutput,
            };
          }

          // For non-executing statuses, explicitly clear liveOutput so
          // it doesn't leak across an executing → completed transition.
          // `pid` / `promoteAbortController` are also explicitly set to
          // `undefined` here as defense-in-depth: today they're not on
          // `coreTc` for non-executing statuses so `...coreTc` doesn't
          // carry them, but if a future core change adds either field
          // to a non-executing status type the explicit clearing
          // prevents stale executing-state leakage into the React tree
          // (which would surface as a stuck PID display or a Ctrl+B
          // handler that incorrectly matches a no-longer-executing
          // tool call).
          return {
            ...coreTc,
            responseSubmittedToGemini,
            liveOutput: undefined,
            pid: undefined,
            promoteAbortController: undefined,
          };
        }),
      );
    },
    [setToolCallsForDisplay],
  );

  const scheduler = useMemo(
    () =>
      new CoreToolScheduler({
        config,
        chatRecordingService: config.getChatRecordingService(),
        outputUpdateHandler,
        onAllToolCallsComplete: allToolCallsCompleteHandler,
        onToolCallsUpdate: toolCallsUpdateHandler,
        getPreferredEditor,
        onEditorClose,
      }),
    [
      config,
      outputUpdateHandler,
      allToolCallsCompleteHandler,
      toolCallsUpdateHandler,
      getPreferredEditor,
      onEditorClose,
    ],
  );

  const schedule: ScheduleFn = useCallback(
    (
      request: ToolCallRequestInfo | ToolCallRequestInfo[],
      signal: AbortSignal,
      modelOverride?: string,
    ) => {
      if (!modelOverride?.endsWith('\0')) {
        void scheduler.schedule(request, signal);
        return;
      }
      void (async () => {
        let runtimeView;
        try {
          runtimeView = await config
            .getBaseLlmClient()
            .resolveForModel(modelOverride.slice(0, -1), {
              failClosed: true,
            });
        } catch (error) {
          debugLogger.error(
            `Failed to resolve full-turn tool runtime: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          const message =
            'Full-turn model route could not be resolved. The tool was not executed.';
          const requests = Array.isArray(request) ? request : [request];
          const completedCalls: CompletedToolCall[] = requests.map(
            (toolRequest) => {
              const toolError = new Error(message);
              const responseParts = convertToFunctionErrorResponse(
                toolRequest.name,
                toolRequest.callId,
                message,
                message,
              );
              config
                .getChatRecordingService()
                ?.recordToolResult(responseParts, {
                  callId: toolRequest.callId,
                  status: 'error',
                  resultDisplay: message,
                  error: toolError,
                  errorType: ToolErrorType.UNHANDLED_EXCEPTION,
                });
              return {
                status: 'error',
                request: toolRequest,
                response: {
                  callId: toolRequest.callId,
                  responseParts,
                  resultDisplay: message,
                  error: toolError,
                  errorType: ToolErrorType.UNHANDLED_EXCEPTION,
                  contentLength: message.length,
                },
              };
            },
          );
          setToolCallsForDisplay((prev) => [...prev, ...completedCalls]);
          await allToolCallsCompleteHandler(completedCalls);
          return;
        }
        await scheduler.schedule(request, signal, runtimeView);
      })().catch((error) => {
        debugLogger.error(
          `Full-turn tool scheduling failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    },
    [allToolCallsCompleteHandler, config, scheduler],
  );

  const markToolsAsSubmitted: MarkToolsAsSubmittedFn = useCallback(
    (callIdsToMark: string[]) => {
      setToolCallsForDisplay((prevCalls) =>
        prevCalls.map((tc) =>
          callIdsToMark.includes(tc.request.callId)
            ? { ...tc, responseSubmittedToGemini: true }
            : tc,
        ),
      );
    },
    [],
  );

  return [toolCallsForDisplay, schedule, markToolsAsSubmitted];
}

/**
 * Maps a CoreToolScheduler status to the UI's ToolCallStatus enum.
 */
function mapCoreStatusToDisplayStatus(coreStatus: CoreStatus): ToolCallStatus {
  switch (coreStatus) {
    case 'validating':
      return ToolCallStatus.Executing;
    case 'awaiting_approval':
      return ToolCallStatus.Confirming;
    case 'executing':
      return ToolCallStatus.Executing;
    case 'success':
      return ToolCallStatus.Success;
    case 'cancelled':
      return ToolCallStatus.Canceled;
    case 'error':
      return ToolCallStatus.Error;
    case 'scheduled':
      return ToolCallStatus.Pending;
    default: {
      const exhaustiveCheck: never = coreStatus;
      debugLogger.warn(`Unknown core status encountered: ${exhaustiveCheck}`);
      return ToolCallStatus.Error;
    }
  }
}

/**
 * Returns 'read' or 'write' if the tool call operates on a managed-auto-memory
 * file; returns undefined otherwise.
 */
function detectMemoryOp(
  toolName: string,
  args: Record<string, unknown>,
  projectRoot: string,
): 'read' | 'write' | undefined {
  const WRITE_TOOLS = new Set(['write_file', 'edit']);
  const READ_TOOLS = new Set(['read_file']);
  const filePath = args?.['file_path'] as string | undefined;
  if (!filePath) return undefined;
  const resolved = path.resolve(filePath);
  if (!isAnyAutoMemPath(resolved, projectRoot)) return undefined;
  if (WRITE_TOOLS.has(toolName)) return 'write';
  if (READ_TOOLS.has(toolName)) return 'read';
  return undefined;
}

/**
 * Transforms `TrackedToolCall` objects into `HistoryItemToolGroup` objects for UI display.
 */
export function mapToDisplay(
  toolOrTools: TrackedToolCall[] | TrackedToolCall,
  projectRoot?: string,
): HistoryItemToolGroup {
  const toolCalls = Array.isArray(toolOrTools) ? toolOrTools : [toolOrTools];

  const toolDisplays = toolCalls.map(
    (trackedCall): IndividualToolCallDisplay => {
      let displayName: string;
      let description: string;
      let renderOutputAsMarkdown = false;

      if (trackedCall.status === 'error') {
        displayName =
          trackedCall.tool === undefined
            ? trackedCall.request.name
            : trackedCall.tool.displayName;
        description = JSON.stringify(trackedCall.request.args);
      } else {
        displayName = trackedCall.tool.displayName;
        description = trackedCall.invocation.getDescription();
        renderOutputAsMarkdown = trackedCall.tool.isOutputMarkdown;
      }

      const baseDisplayProperties: Omit<
        IndividualToolCallDisplay,
        'status' | 'resultDisplay' | 'confirmationDetails'
      > = {
        callId: trackedCall.request.callId,
        name: displayName,
        description,
        renderOutputAsMarkdown,
        isMemoryOp:
          projectRoot && trackedCall.status !== 'error'
            ? detectMemoryOp(
                trackedCall.request.name,
                trackedCall.request.args as Record<string, unknown>,
                projectRoot,
              )
            : undefined,
      };

      switch (trackedCall.status) {
        case 'success':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay: compactToolResultDisplayForHistory(
              trackedCall.response.resultDisplay,
            ),
            // Full detail for the Ctrl+O transcript (§4.9): derived from the
            // already-persisted functionResponse parts; NOT char-capped (the
            // bound is whatever core already applied). Consumed ONLY by the
            // transcript's fullDetail render for collapsible (read/search/list)
            // tools whose summary resultDisplay is just a count — so gate the
            // extraction on `isCollapsibleTool(displayName)` to avoid storing a
            // large (~25K char) string on every edit/write/command/agent call
            // that the renderer would never use. Mirrors ToolMessage's
            // `usingDetailedDisplay` gate, which also keys off the display name.
            detailedDisplay: isCollapsibleTool(displayName)
              ? getToolResponseDisplayText(trackedCall.response.responseParts)
              : undefined,
            confirmationDetails: undefined,
          };
        case 'error':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay: compactToolResultDisplayForHistory(
              trackedCall.response.resultDisplay,
            ),
            confirmationDetails: undefined,
          };
        case 'cancelled':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay: compactToolResultDisplayForHistory(
              trackedCall.response.resultDisplay,
            ),
            confirmationDetails: undefined,
          };
        case 'awaiting_approval':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay: undefined,
            confirmationDetails: trackedCall.confirmationDetails,
          };
        case 'executing':
          // React stores compacted live output when handling raw update chunks.
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay:
              (trackedCall as TrackedExecutingToolCall).liveOutput ?? undefined,
            confirmationDetails: undefined,
            ptyId: (trackedCall as TrackedExecutingToolCall).pid,
            executionStartTime: (trackedCall as TrackedExecutingToolCall)
              .executionStartTime,
          };
        case 'validating': // Fallthrough
        case 'scheduled':
          return {
            ...baseDisplayProperties,
            status: mapCoreStatusToDisplayStatus(trackedCall.status),
            resultDisplay: undefined,
            confirmationDetails: undefined,
          };
        default: {
          const exhaustiveCheck: never = trackedCall;
          return {
            callId: (exhaustiveCheck as TrackedToolCall).request.callId,
            name: 'Unknown Tool',
            description: 'Encountered an unknown tool call state.',
            status: ToolCallStatus.Error,
            resultDisplay: 'Unknown tool call state',
            confirmationDetails: undefined,
            renderOutputAsMarkdown: false,
          };
        }
      }
    },
  );

  return {
    type: 'tool_group',
    tools: toolDisplays,
    memoryWriteCount:
      toolDisplays.filter((t) => t.isMemoryOp === 'write').length || undefined,
    memoryReadCount:
      toolDisplays.filter((t) => t.isMemoryOp === 'read').length || undefined,
  };
}
