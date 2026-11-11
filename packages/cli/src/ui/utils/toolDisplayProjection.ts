/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CODE_MODE_RESULT_TYPE,
  CODE_MODE_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  type CodeModeDisplay,
  codeModeChildStatus,
  CoreToolCallStatus,
  isCodeModeDisplay,
  isCodeModeDisplayStatus,
  getToolUseDisplayMetadata,
  Kind,
  EDIT_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  type McpInfo,
  type SerializableConfirmationDetails,
  type SubagentActivityItem,
  type FileDiff,
  type Todo,
  type TodoList,
  ASK_USER_TOOL_NAME,
  AGENT_TOOL_NAME,
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  SKILL_TOOL_NAME,
  type ToolLiveOutput,
  type ToolResultDisplayContent,
  type ToolResultDisplay,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
  IMAGE_GEN_TOOL_NAME,
  IMAGE_SEARCH_TOOL_NAME,
  VIDEO_GEN_TOOL_NAME,
  VIDEO_GEN_RETRIEVE_TOOL_NAME,
  isVideoGenResult,
  WORKFLOW_TOOL_NAME,
  WORKFLOW_LAUNCH_DISPLAY,
  BASH_PTY_TOOL_NAMES,
  isFileDiff,
  isCompactFileToolResult,
  isEnterPlanModeResult,
  isExitPlanModeResult,
  isFileEditResult,
  isFileWriteResult,
  isFileReadResult,
  isGlobResult,
  isGrepResult,
  isImageGenResult,
  isMcpToolName,
  isImageSearchResult,
  isPayloadResult,
  isRecord,
  isSkillResult,
  isSubagentProgress,
  isTodoWriteResult,
  isToolStatusResult,
  isAgentToolCompletionResult,
  isWebFetchResult,
  isWebSearchResult,
  isShellLiveOutput,
  formatShellTerminationReason,
  normalizeToolInput,
  ToolErrorType,
} from '@qwen-code/core';
import type { IndividualToolCallDisplay } from '../types.js';
import * as Diff from 'diff';
import {
  isAgentBackgroundLaunchDisplay,
  isAgentTeammateSpawnDisplay,
} from './agentToolResultDisplay.js';

export interface ToolUseDisplaySource {
  mcpInfo?: McpInfo;
  id: string;
  name: string;
  input: unknown;
  parentCallId?: string;
  originalRequestName?: string;
}

export interface ToolResultDisplaySource {
  /** Raw protocol content retained for transport/history shape; display is projected from toolUseResult. */
  content?: ToolResultDisplayContent;
  isError: boolean;
  toolUseResult?: unknown;
  outputFile?: string;
}

export interface RuntimeToolDisplaySource {
  status?: CoreToolCallStatus;
  targetDir?: string;
  renderOutputAsMarkdown?: boolean;
  isClientInitiated?: boolean;
  kind?: Kind;
  confirmationDetails?: SerializableConfirmationDetails;
  liveOutput?: ToolLiveOutput;
  startedAt?: number;
  executionId?: number;
  correlationId?: string;
  planModeActive?: boolean;
  progressMessage?: string;
  progress?: number;
  progressTotal?: number;
  subagentHistory?: SubagentActivityItem[];
}

export interface ProjectToolDisplayInput {
  toolUse: ToolUseDisplaySource;
  toolResult?: ToolResultDisplaySource;
  runtime?: RuntimeToolDisplaySource;
}

function projectShellLiveProgress(
  output: ToolLiveOutput | undefined,
): IndividualToolCallDisplay['shellProgress'] {
  return isShellLiveOutput(output)
    ? {
        totalLines: output.totalLines,
        totalBytes: output.totalBytes,
      }
    : undefined;
}

function isTerminalToolName(toolName: string): boolean {
  return BASH_PTY_TOOL_NAMES.has(toolName);
}

function isBashTerminalResult(toolUseResult: unknown): boolean {
  return (
    isRecord(toolUseResult) &&
    (getString(toolUseResult, 'kind') === 'bash_pty' ||
      getString(toolUseResult, 'kind') === 'bash_output')
  );
}

export function projectToolCallDisplay({
  toolUse,
  toolResult,
  runtime,
}: ProjectToolDisplayInput): IndividualToolCallDisplay {
  const input = normalizeToolInput(toolUse.input);
  const metadata = getToolUseDisplayMetadata(toolUse.name, input, {
    targetDir: runtime?.targetDir,
    mcpInfo: toolUse.mcpInfo,
  });
  let status =
    runtime?.status ??
    (toolResult?.isError
      ? CoreToolCallStatus.Error
      : CoreToolCallStatus.Success);
  // A completed handler can still report failure while preserving its payload.
  if (status === CoreToolCallStatus.Success && toolResult?.isError) {
    status = CoreToolCallStatus.Error;
  }

  const resultDisplay = projectResultDisplay(toolUse.name, toolResult, runtime);
  const shellProgress = projectShellLiveProgress(runtime?.liveOutput);

  return {
    callId: toolUse.id,
    parentCallId: toolUse.parentCallId,
    name: metadata.displayName,
    args: input,
    description: metadata.description,
    displayTitle: metadata.displayTitle,
    renderOutputAsMarkdown:
      runtime?.renderOutputAsMarkdown ??
      (!isTerminalToolName(toolUse.name) &&
        !isBashTerminalResult(toolResult?.toolUseResult)),
    status,
    isClientInitiated: runtime?.isClientInitiated,
    kind: runtime?.kind,
    resultDisplay,
    confirmationDetails: runtime?.confirmationDetails,
    startedAt: runtime?.startedAt,
    executionId: runtime?.executionId,
    outputFile: toolResult?.outputFile,
    correlationId: runtime?.correlationId,
    planModeActive: runtime?.planModeActive,
    progressMessage: runtime?.progressMessage,
    originalRequestName: toolUse.originalRequestName,
    progress: runtime?.progress,
    progressTotal: runtime?.progressTotal,
    shellProgress,
    subagentHistory: runtime?.subagentHistory,
  };
}

function projectResultDisplay(
  toolName: string,
  toolResult: ToolResultDisplaySource | undefined,
  runtime: RuntimeToolDisplaySource | undefined,
): ToolResultDisplay | undefined {
  if (runtime?.status === CoreToolCallStatus.Executing) {
    if (isShellLiveOutput(runtime.liveOutput)) {
      return runtime.liveOutput.output;
    }
    return runtime.liveOutput;
  }

  if (!toolResult) {
    return undefined;
  }

  const structured = projectStructuredToolResultDisplay(
    toolName,
    toolResult.toolUseResult,
  );
  if (structured !== undefined) {
    return structured;
  }

  if (toolResult.isError) {
    return toolResultContentToString(toolResult.content);
  }

  return undefined;
}

/** Projects transcript call summaries for live agent views and resumed sessions. */
function projectCodeModeResultDisplay(
  toolUseResult: unknown,
): CodeModeDisplay | undefined {
  if (!isRecord(toolUseResult) || toolUseResult['type'] !== CODE_MODE_RESULT_TYPE)
    return undefined;
  const calls = Array.isArray(toolUseResult['calls'])
    ? toolUseResult['calls'].filter(isRecord)
    : [];
  const status = getString(toolUseResult, 'status');
  const totalCalls = getNumber(toolUseResult, 'totalCalls');
  return {
    isCodeModeDisplay: true,
    status: isCodeModeDisplayStatus(status) ? status : undefined,
    ...(totalCalls !== undefined ? { totalCalls } : {}),
    children: calls.map((call, index) => {
      const filePath = getString(call, 'filePath');
      const business = call['kind'] === 'business';
      const error = business ? undefined : getString(call, 'error');
      const notice =
        getString(call, 'notice') ??
        (business ? getString(call, 'error') : undefined);
      const displayStatus = call['displayStatus'];
      return {
        callId: getString(call, 'callId') ?? String(index),
        name: getString(call, 'name') ?? 'Tool',
        args: isRecord(call['args'])
          ? call['args']
          : filePath
            ? { file_path: filePath }
            : {},
        ...(call['argsTruncated'] === true ? { argsTruncated: true } : {}),
        status: business
          ? CoreToolCallStatus.Success
          : Object.values(CoreToolCallStatus).includes(
                displayStatus as CoreToolCallStatus,
              )
            ? (displayStatus as CoreToolCallStatus)
            : codeModeChildStatus(getString(call, 'status')),
        ...(error ? { error } : {}),
        ...(notice ? { notice } : {}),
      };
    }),
    summary: [
      getString(toolUseResult, 'error'),
      getString(toolUseResult, 'storeError')
        ? `Store unavailable: ${getString(toolUseResult, 'storeError')}`
        : undefined,
      getString(toolUseResult, 'output'),
      toolUseResult['truncated'] === true ? '[Output truncated]' : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function toolResultContentToString(
  content: ToolResultDisplaySource['content'],
): string | undefined {
  if (typeof content === 'string') {
    return content.trim() ? content : undefined;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
  return text.trim() ? text : undefined;
}

function projectStructuredToolResultDisplay(
  toolName: string,
  toolUseResult: unknown,
): ToolResultDisplay | undefined {
  if (isToolStatusResult(toolUseResult)) {
    return toolUseResult.summary;
  }

  if (isCodeModeDisplay(toolUseResult)) {
    return toolUseResult;
  }

  if (toolName === WORKFLOW_TOOL_NAME) {
    return projectWorkflowResultDisplay(toolUseResult);
  }

  if (isPayloadResult(toolUseResult)) {
    return toolUseResult;
  }

  if (isMcpToolName(toolName)) {
    return projectMcpResultDisplay(toolUseResult);
  }

  if (BASH_PTY_TOOL_NAMES.has(toolName)) {
    return projectBashTerminalResultDisplay(toolUseResult);
  }

  switch (toolName) {
    case CODE_MODE_TOOL_NAME:
    case CODE_MODE_WAIT_TOOL_NAME:
      return projectCodeModeResultDisplay(toolUseResult);
    case AGENT_TOOL_NAME:
      return projectAgentResultDisplay(toolUseResult);

    case POWERSHELL_TOOL_NAME: {
      if (isRecord(toolUseResult)) {
        const stdout = getString(toolUseResult, 'stdout');
        const stderr = getString(toolUseResult, 'stderr');
        if (getString(toolUseResult, 'backgroundTaskId')) {
          const status = projectShellResultDisplay({
            ...toolUseResult,
            stdout: '',
            stderr: '',
          });
          return [status, stdout, stderr].filter(Boolean).join('\n');
        }
        if (stdout?.trim() && stderr?.trim()) return `${stdout}\n${stderr}`;
      }
      return projectShellResultDisplay(toolUseResult);
    }

    case SHELL_TOOL_NAME:
      return (
        projectBashTerminalResultDisplay(toolUseResult) ??
        projectShellResultDisplay(toolUseResult)
      );

    case TASK_STOP_TOOL_NAME: {
      if (!isRecord(toolUseResult)) return undefined;
      const taskId = getString(toolUseResult, 'task_id')?.trim();
      const taskType = getString(toolUseResult, 'task_type')?.trim();
      return taskId && taskType ? 'Task stopped successfully' : undefined;
    }

    case READ_FILE_TOOL_NAME:
      return projectReadFileResultDisplay(toolUseResult);

    case WRITE_FILE_TOOL_NAME:
      return projectWriteResultDisplay(toolUseResult);

    case EDIT_TOOL_NAME:
      return projectEditResultDisplay(toolUseResult);

    case NOTEBOOK_EDIT_TOOL_NAME:
      return isFileDiff(toolUseResult) ? toolUseResult : undefined;

    case GREP_TOOL_NAME:
      return isGrepResult(toolUseResult) ? toolUseResult : undefined;

    case GLOB_TOOL_NAME:
      return isGlobResult(toolUseResult) ? toolUseResult : undefined;

    case WEB_FETCH_TOOL_NAME:
      return isWebFetchResult(toolUseResult)
        ? `Content processed`
        : isPayloadResult(toolUseResult)
          ? toolUseResult
          : undefined;

    case WEB_SEARCH_TOOL_NAME:
      return isWebSearchResult(toolUseResult)
        ? `Search results for "${toolUseResult.query}" returned (${toolUseResult.results.length} results).`
        : isPayloadResult(toolUseResult)
          ? toolUseResult
          : undefined;

    case IMAGE_SEARCH_TOOL_NAME:
      return isImageSearchResult(toolUseResult)
        ? `Image search for "${toolUseResult.query}" returned (${toolUseResult.results.length} results).`
        : isPayloadResult(toolUseResult)
          ? toolUseResult
          : undefined;

    case IMAGE_GEN_TOOL_NAME:
      return isImageGenResult(toolUseResult)
        ? `Image saved to ${toolUseResult.filePath}`
        : isPayloadResult(toolUseResult)
          ? toolUseResult
          : undefined;

    case VIDEO_GEN_TOOL_NAME:
    case VIDEO_GEN_RETRIEVE_TOOL_NAME:
      if (isVideoGenResult(toolUseResult)) {
        if (toolUseResult.status === 'completed' && toolUseResult.filePath) {
          return `Video saved to ${toolUseResult.filePath}`;
        }
        if (toolUseResult.status === 'failed') {
          const errMsg = toolUseResult.error
            ? `${toolUseResult.error.code}: ${toolUseResult.error.message}`
            : 'unknown error';
          return `Video generation failed: ${errMsg}`;
        }
        return `Video task ${toolUseResult.taskId}: ${toolUseResult.status}`;
      }
      return isPayloadResult(toolUseResult) ? toolUseResult : undefined;

    case WRITE_TODOS_TOOL_NAME:
      if (isTodoWriteResult(toolUseResult)) {
        return { todos: toolUseResult.newTodos };
      }
      return isTodoListResult(toolUseResult) ? toolUseResult : undefined;

    case ASK_USER_TOOL_NAME:
      return projectAskUserResultDisplay(toolUseResult);

    case ENTER_PLAN_MODE_TOOL_NAME:
      return isEnterPlanModeResult(toolUseResult)
        ? toolUseResult.message
        : isPayloadResult(toolUseResult)
          ? toolUseResult
          : undefined;

    case EXIT_PLAN_MODE_TOOL_NAME:
      if (isExitPlanModeResult(toolUseResult)) {
        if (toolUseResult.status === 'rejected') {
          const feedback = toolUseResult.feedback?.trim();
          return feedback ? `Feedback: ${feedback}` : 'Rejected (no feedback)';
        }
        return `Plan approved: ${toolUseResult.filePath ?? ''}`.trim();
      }
      return isPayloadResult(toolUseResult) ? toolUseResult : undefined;

    case SKILL_TOOL_NAME:
      if (isSkillResult(toolUseResult)) {
        return toolUseResult.status === 'forked'
          ? `Skill **${toolUseResult.commandName}** completed (forked execution).`
          : `Skill **${toolUseResult.commandName}** activated.`;
      }
      return isPayloadResult(toolUseResult) ? toolUseResult : undefined;

    default:
      if (typeof toolUseResult === 'string') {
        return toolUseResult;
      }
      if (isSubagentProgress(toolUseResult)) {
        return toolUseResult;
      }
      return isPayloadResult(toolUseResult) ? toolUseResult : undefined;
  }
}

function projectMcpResultDisplay(
  toolUseResult: unknown,
): ToolResultDisplay | undefined {
  if (typeof toolUseResult === 'string') {
    return toolUseResult.trim() ? toolUseResult : undefined;
  }
  if (Array.isArray(toolUseResult)) {
    const text = toolUseResult
      .map((block) => {
        if (!isRecord(block)) return '';
        const blockText = getString(block, 'text');
        if (block['type'] === 'text' && blockText !== undefined) {
          return blockText;
        }
        if (block['type'] === 'image') return '[Image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
    return text.trim() ? text : undefined;
  }
  return isPayloadResult(toolUseResult) ? toolUseResult : undefined;
}

function projectWorkflowResultDisplay(
  toolUseResult: unknown,
): ToolResultDisplay | undefined {
  if (typeof toolUseResult === 'string') {
    return toolUseResult;
  }

  if (isWorkflowLaunchResult(toolUseResult)) {
    return WORKFLOW_LAUNCH_DISPLAY;
  }

  if (isPayloadResult(toolUseResult)) {
    return tryParseWorkflowLaunchPayload(toolUseResult.payload)
      ? WORKFLOW_LAUNCH_DISPLAY
      : toolUseResult;
  }

  return undefined;
}

function isWorkflowLaunchResult(value: unknown): boolean {
  return isRecord(value) && getString(value, 'status') === 'async_launched';
}

function tryParseWorkflowLaunchPayload(payload: unknown): boolean {
  if (typeof payload !== 'string') return false;
  try {
    return isWorkflowLaunchResult(JSON.parse(payload));
  } catch {
    return false;
  }
}

function projectAgentResultDisplay(
  toolUseResult: unknown,
): ToolResultDisplay | undefined {
  if (typeof toolUseResult === 'string') {
    return toolUseResult;
  }

  if (isSubagentProgress(toolUseResult)) {
    return toolUseResult;
  }

  if (isAgentBackgroundLaunchDisplay(toolUseResult)) {
    return toolUseResult;
  }
  if (isAgentTeammateSpawnDisplay(toolUseResult)) {
    return toolUseResult;
  }

  if (isAgentToolCompletionResult(toolUseResult)) {
    return toolUseResult.content;
  }

  if (isPayloadResult(toolUseResult)) {
    return toolUseResult;
  }

  return undefined;
}

function projectBashTerminalResultDisplay(
  toolUseResult: unknown,
): ToolResultDisplay | undefined {
  if (
    !isRecord(toolUseResult) ||
    !isBashTerminalResult(toolUseResult)
  ) {
    return undefined;
  }

  const kind = getString(toolUseResult, 'kind');
  const action = getString(toolUseResult, 'action') ?? 'unknown';
  if (action === 'error') {
    const code =
      getString(toolUseResult, 'error_code') ??
      (kind === 'bash_output' ? 'bash_output_unknown' : 'bash_pty_unknown');
    const message = getString(toolUseResult, 'error_message') ?? 'Unknown error';
    return `Bash ${kind === 'bash_output' ? 'output' : 'PTY'} failed (${code}): ${message}`;
  }

  const pid = getNumber(toolUseResult, 'pid');
  const command = getString(toolUseResult, 'command');
  const cwd = getString(toolUseResult, 'cwd');
  const cols = getNumber(toolUseResult, 'cols');
  const rows = getNumber(toolUseResult, 'rows');
  const alive = getBoolean(toolUseResult, 'alive');
  const exitCode = getNumber(toolUseResult, 'exit_code');
  const signal = getNumber(toolUseResult, 'signal');
  const inputPreview = getString(toolUseResult, 'input_preview');
  const screen = getString(toolUseResult, 'screen');
  const rawTail = getString(toolUseResult, 'raw_tail');
  const stdout = getString(toolUseResult, 'stdout');
  const outputPath = getString(toolUseResult, 'output_path');

  const details: string[] = [];
  if (pid !== undefined) details.push(`pid=${pid}`);
  if (cols !== undefined && rows !== undefined) details.push(`${cols}x${rows}`);
  if (alive !== undefined) details.push(alive ? 'running' : 'exited');
  if (exitCode !== undefined) details.push(`exit_code=${exitCode}`);
  if (signal !== undefined) details.push(`signal=${signal}`);

  const label =
    kind === 'bash_output'
      ? action === 'output'
        ? 'Bash output'
        : `Bash output ${action}`
      : `Bash PTY ${action}`;
  const lines = [`${label}${details.length ? ` (${details.join(', ')})` : ''}`];
  if (command) lines.push(`command: ${command}`);
  if (cwd) lines.push(`cwd: ${cwd}`);
  if (outputPath) lines.push(`output: ${outputPath}`);
  if (inputPreview) lines.push(`input: ${inputPreview}`);

  const output = terminalDisplayOutput(screen, rawTail ?? stdout);
  if (output) {
    lines.push('', output);
  }

  return lines.join('\n');
}

function terminalDisplayOutput(
  screen: string | undefined,
  rawTail: string | undefined,
): string | undefined {
  const content = screen?.trimEnd() || rawTail?.trimEnd();
  if (!content) {
    return undefined;
  }
  return content;
}

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function projectWriteResultDisplay(
  toolUseResult: unknown,
): FileDiff | undefined {
  if (isFileDiff(toolUseResult)) return toolUseResult;
  if (isCompactFileToolResult(toolUseResult) && toolUseResult.diff) {
    return projectCompactFileResultDisplay({
      file_path: toolUseResult.file_path,
      diff: toolUseResult.diff,
      additions: toolUseResult.additions,
      deletions: toolUseResult.deletions,
    });
  }
  if (!isFileWriteResult(toolUseResult)) return undefined;

  const fileName = basename(toolUseResult.filePath);
  const originalContent = toolUseResult.originalFile;
  const oldContent = originalContent ?? '';
  return {
    fileDiff: Diff.createPatch(
      fileName,
      oldContent,
      toolUseResult.content,
      'Original',
      'Written',
    ),
    fileName,
    filePath: toolUseResult.filePath,
    originalContent,
    newContent: toolUseResult.content,
    isNewFile: toolUseResult.type === 'create',
  };
}

function projectEditResultDisplay(
  toolUseResult: unknown,
): FileDiff | undefined {
  if (isFileDiff(toolUseResult)) return toolUseResult;
  if (isCompactFileToolResult(toolUseResult) && toolUseResult.diff) {
    return projectCompactFileResultDisplay({
      file_path: toolUseResult.file_path,
      diff: toolUseResult.diff,
      additions: toolUseResult.additions,
      deletions: toolUseResult.deletions,
    });
  }
  if (!isFileEditResult(toolUseResult)) return undefined;

  const newContent = toolUseResult.replaceAll
    ? toolUseResult.originalFile
        .split(toolUseResult.oldString)
        .join(toolUseResult.newString)
    : toolUseResult.originalFile.replace(
        toolUseResult.oldString,
        toolUseResult.newString,
      );
  const fileName = basename(toolUseResult.filePath);
  return {
    fileDiff: Diff.createPatch(
      fileName,
      toolUseResult.originalFile,
      newContent,
      'Original',
      'Modified',
    ),
    fileName,
    filePath: toolUseResult.filePath,
    originalContent: toolUseResult.originalFile,
    newContent,
  };
}

function projectCompactFileResultDisplay(toolUseResult: {
  file_path: string;
  diff: string;
  additions: number;
  deletions: number;
}): FileDiff {
  return {
    fileDiff: toolUseResult.diff,
    fileName: basename(toolUseResult.file_path),
    filePath: toolUseResult.file_path,
    contentOmitted: true,
    diffStat: {
      model_added_lines: toolUseResult.additions,
      model_removed_lines: toolUseResult.deletions,
      model_added_chars: 0,
      model_removed_chars: 0,
      user_added_lines: 0,
      user_removed_lines: 0,
      user_added_chars: 0,
      user_removed_chars: 0,
    },
    // FileDiff predates compact transcript results and requires both fields.
    // Consumers must check contentOmitted before treating them as file bodies.
    originalContent: null,
    newContent: '',
  };
}

function projectReadFileResultDisplay(
  toolUseResult: unknown,
): ToolResultDisplay | undefined {
  if (isFileReadResult(toolUseResult)) {
    switch (toolUseResult.type) {
      case 'text': {
        const { startLine, numLines, totalLines } = toolUseResult.file;
        const endLine = startLine + numLines - 1;
        return startLine > 1 || endLine < totalLines
          ? `Read lines ${startLine}-${endLine} of ${totalLines}`
          : `Read ${totalLines} ${totalLines === 1 ? 'line' : 'lines'}`;
      }
      case 'image':
        return `Read image (${Math.round(toolUseResult.file.originalSize / 1024)}KB)`;
      case 'notebook':
        return `Read notebook (${toolUseResult.file.cells.length} cells)`;
      case 'parts':
        return `Read PDF as images (${toolUseResult.file.count} pages, ${Math.round(toolUseResult.file.originalSize / 1024)}KB)`;
      case 'pdf':
        return `Read PDF (${Math.round(toolUseResult.file.originalSize / 1024)}KB)`;
      case 'file_unchanged':
        return '';
      default:
        return undefined;
    }
  }

  if (
    isRecord(toolUseResult) &&
    toolUseResult['errorType'] === ToolErrorType.FILE_NOT_FOUND
  ) {
    return 'File not found.';
  }

  return isPayloadResult(toolUseResult) ? toolUseResult : undefined;
}

function projectAskUserResultDisplay(
  toolUseResult: unknown,
): ToolResultDisplay | undefined {
  if (!isRecord(toolUseResult)) {
    return undefined;
  }

  const answers = toolUseResult['answers'];
  if (!isRecord(answers)) {
    return undefined;
  }

  const answerEntries = Object.keys(answers).flatMap((questionText) => {
    const answer = getString(answers, questionText);
    return answer === undefined ? [] : ([[questionText, answer]] as const);
  });
  if (answerEntries.length === 0) {
    return 'User dismissed dialog';
  }

  const questions = Array.isArray(toolUseResult['questions'])
    ? toolUseResult['questions']
    : [];

  const blocks = answerEntries.map(([questionText, answer]) => {
    const question = questions.find(
      (candidate) =>
        isRecord(candidate) &&
        getString(candidate, 'question') === questionText,
    );
    const category = isRecord(question)
      ? (getString(question, 'header') ?? questionText)
      : questionText;
    const prefix = `  ${category} → `;
    const indent = ' '.repeat(prefix.length);
    const lines = answer.split('\n');
    const answerLine = prefix + lines.join('\n' + indent);
    return `  Q: ${questionText}\n${answerLine}`;
  });

  return `**User answered:**\n${blocks.join('\n\n')}`;
}

function projectShellResultDisplay(
  toolUseResult: unknown,
): ToolResultDisplay | undefined {
  if (!isRecord(toolUseResult)) {
    return undefined;
  }

  const stdout = getString(toolUseResult, 'stdout');
  if (getString(toolUseResult, 'kind') === 'cancelled') {
    const reason = formatShellTerminationReason({
      timedOut: getBoolean(toolUseResult, 'timedOut'),
      timeoutMs: getNumber(toolUseResult, 'timeoutMs'),
      outputLimitExceeded: getBoolean(toolUseResult, 'outputLimitExceeded'),
    });
    if (reason) {
      const stderr = getString(toolUseResult, 'stderr');
      return [reason, stdout, stderr].filter((text) => text?.trim()).join('\n');
    }
  }

  if (stdout?.trim()) {
    return stdout;
  }

  const stderr = getString(toolUseResult, 'stderr');
  if (stderr?.trim()) {
    return stderr;
  }

  const pid = getNumber(toolUseResult, 'pid');
  const backgroundTaskId = getString(toolUseResult, 'backgroundTaskId');
  if (pid !== undefined || backgroundTaskId) {
    const backgroundReason =
      getString(toolUseResult, 'backgroundReason') ??
      (backgroundTaskId
        ? getBoolean(toolUseResult, 'backgroundedByUser')
          ? 'user'
          : getNumber(toolUseResult, 'timedOutAfterMs') !== undefined
            ? 'timeout'
            : 'model'
        : undefined);
    const taskId = getString(toolUseResult, 'taskId') ?? backgroundTaskId;
    const taskLabel = taskId ? `ID: ${taskId}` : `PID: ${pid}`;
    if (backgroundReason === 'user') {
      return `Command was manually moved to background by the user (${taskLabel}). Use /tasks to view.`;
    }
    if (backgroundReason === 'model') {
      return `Command is running in background (${taskLabel}). Use /tasks to view.`;
    }
    if (backgroundReason === 'timeout') {
      return `Command exceeded its timeout and was moved to background (${taskLabel}). Use /tasks to view.`;
    }
    if (backgroundReason === 'auto') {
      return `Command was automatically moved to background (${taskLabel}). Use /tasks to view.`;
    }
    return `Command moved to background (${taskLabel}). Use /tasks to view.`;
  }

  const initialOutput = getString(toolUseResult, 'initialOutput');
  if (initialOutput?.trim()) {
    return initialOutput;
  }

  const interpretation = getString(toolUseResult, 'returnCodeInterpretation');
  if (interpretation) return interpretation;

  const exitCode = getNumber(toolUseResult, 'exitCode');
  if (exitCode !== undefined && exitCode !== 0) {
    return `Command exited with code: ${exitCode}`;
  }

  const signal = getString(toolUseResult, 'signal');
  if (signal) {
    return `Command terminated by signal: ${signal}`;
  }

  return undefined;
}

function isTodoListResult(value: unknown): value is TodoList {
  if (!isRecord(value) || !Array.isArray(value['todos'])) {
    return false;
  }

  return value['todos'].every(isTodoResult);
}

function isTodoResult(value: unknown): value is Todo {
  if (!isRecord(value)) {
    return false;
  }

  const description = getString(value, 'description');
  const status = getString(value, 'status');
  return description !== undefined && status !== undefined;
}

function getString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const nested = value[key];
  return typeof nested === 'string' ? nested : undefined;
}

function getNumber(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const nested = value[key];
  return typeof nested === 'number' ? nested : undefined;
}

function getBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const nested = value[key];
  return typeof nested === 'boolean' ? nested : undefined;
}

export function projectSubagentToolCallDisplay(args: {
  callId: string;
  agentName: string;
  progress: Extract<ToolResultDisplay, { isSubagentProgress: true }>;
  status: CoreToolCallStatus;
}): IndividualToolCallDisplay {
  return projectToolCallDisplay({
    toolUse: {
      id: args.callId,
      name: args.agentName,
      input: {},
    },
    toolResult: {
      isError: args.status === CoreToolCallStatus.Error,
      toolUseResult: args.progress,
    },
    runtime: {
      kind: Kind.Agent,
      status: args.status,
      subagentHistory: args.progress.recentActivity,
    },
  });
}
