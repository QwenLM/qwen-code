/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type ToolCall,
  runLogger,
  CoreToolCallStatus,
  isCodeModeDisplay,
  Kind,
  type SubagentActivityItem,
} from '@qwen-code/core';
import {
  type HistoryItemToolGroup,
  type IndividualToolCallDisplay,
} from '../types.js';
import {
  projectToolCallDisplay,
  type ToolResultDisplaySource,
} from '../utils/toolDisplayProjection.js';

function hasSubagentHistory(
  call: ToolCall,
): call is ToolCall & { subagentHistory: SubagentActivityItem[] } {
  return 'subagentHistory' in call && call.subagentHistory !== undefined;
}

/**
 * For background-style tools, prefer the live TUI resultDisplay over the
 * persisted toolUseResult so launch templates render correctly.
 */
function resolvePreferredDisplayResult(call: ToolCall): unknown | undefined {
  if (
    'response' in call &&
    (call.tool?.kind === Kind.Agent ||
      call.tool?.kind === Kind.Workflow ||
      isCodeModeDisplay(call.response.resultDisplay)) &&
    call.response.resultDisplay !== undefined
  ) {
    return call.response.resultDisplay;
  }
  return 'response' in call ? call.response.toolUseResult : undefined;
}

/**
 * Transforms `ToolCall` objects into `HistoryItemToolGroup` objects for UI
 * display. This is a pure projection layer and does not track interaction
 * state.
 */
export function mapToDisplay(
  toolOrTools: ToolCall[] | ToolCall,
  options: {
    borderTop?: boolean;
    borderBottom?: boolean;
    borderColor?: string;
    borderDimColor?: boolean;
  } = {},
): HistoryItemToolGroup {
  const toolCalls = Array.isArray(toolOrTools) ? toolOrTools : [toolOrTools];
  const { borderTop, borderBottom, borderColor, borderDimColor } = options;

  const toolDisplays = toolCalls.map((call): IndividualToolCallDisplay => {
    let renderOutputAsMarkdown = false;

    if (call.status === CoreToolCallStatus.Error) {
      renderOutputAsMarkdown = false;
    } else {
      renderOutputAsMarkdown = call.tool?.isOutputMarkdown ?? false;
    }

    let toolResult: ToolResultDisplaySource | undefined;
    let liveOutput;
    let confirmationDetails;
    let executionId: number | undefined = undefined;
    let correlationId: string | undefined = undefined;
    let progressMessage: string | undefined = undefined;
    let progress: number | undefined = undefined;
    let progressTotal: number | undefined = undefined;

    switch (call.status) {
      case CoreToolCallStatus.Success:
        toolResult = {
          isError: call.response.isError === true,
          toolUseResult: resolvePreferredDisplayResult(call),
          outputFile: call.response.outputFile,
        };
        break;
      case CoreToolCallStatus.Error:
      case CoreToolCallStatus.Cancelled:
        toolResult = {
          isError: call.status === CoreToolCallStatus.Error,
          toolUseResult:
            resolvePreferredDisplayResult(call) ?? call.response.data,
          outputFile: call.response.outputFile,
          content:
            call.status === CoreToolCallStatus.Error && 'tool' in call
              ? call.response.error?.message
              : undefined,
        };
        break;
      case CoreToolCallStatus.AwaitingApproval:
        correlationId = call.correlationId;
        // Pass through details. Context handles dispatch (callback vs bus).
        confirmationDetails = call.confirmationDetails;
        break;
      case CoreToolCallStatus.Executing:
        liveOutput = call.liveOutput;
        executionId = call.pid;
        progressMessage = call.progressMessage;
        progress = call.progress;
        progressTotal = call.progressTotal;
        break;
      case CoreToolCallStatus.Scheduled:
      case CoreToolCallStatus.Validating:
        break;
      default: {
        const exhaustiveCheck: never = call;
        runLogger.warn(
          `Unhandled tool call status in mapper: ${
            (exhaustiveCheck as ToolCall).status
          }`,
        );
        break;
      }
    }

    return projectToolCallDisplay({
      toolUse: {
        id: call.request.callId,
        name: call.request.name,
        mcpInfo: call.request.mcpInfo,
        input: call.request.args ?? {},
        parentCallId: call.request.parentCallId,
        originalRequestName: call.request.originalRequestName,
      },
      toolResult,
      runtime: {
        status: call.status,
        renderOutputAsMarkdown,
        kind: call.tool?.kind,
        confirmationDetails,
        liveOutput,
        startedAt:
          call.status === CoreToolCallStatus.Executing
            ? call.executionStartedAt
            : undefined,
        executionId,
        correlationId,
        planModeActive: call.planModeActive,
        progressMessage,
        progress,
        progressTotal,
        subagentHistory: hasSubagentHistory(call)
          ? call.subagentHistory
          : undefined,
      },
    });
  });

  return {
    type: 'tool_group',
    tools: toolDisplays,
    borderTop,
    borderBottom,
    borderColor,
    borderDimColor,
  };
}
