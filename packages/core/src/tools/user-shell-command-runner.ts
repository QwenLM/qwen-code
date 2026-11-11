/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import { POWERSHELL_TOOL_NAME, SHELL_TOOL_NAME } from './tool-names.js';
import { PowerShellTool } from './powerShell.js';
import type { ShellType } from '../utils/shell/shellProvider.js';
import { ShellTool } from './shell.js';
import {
  formatShellExecutionOutput,
  isBoolean,
  isNumber,
  isString,
  isShellToolExecutionData,
  type ShellProgressMetrics,
  type ShellToolExecutionData,
  type UserShellCommandOutcome,
  type UserShellProgress,
} from './shell-result.js';
import {
  isShellLiveOutput,
  type ToolLiveOutput,
  type ToolResult,
} from './tools.js';
import { MAX_TASK_OUTPUT_BYTES_DISPLAY } from '../utils/task/diskOutput.js';
import { shellStatusText } from './shell-exit-status.js';

export interface RunUserShellCommandOptions {
  config: Config;
  command: string;
  signal: AbortSignal;
  callId: string;
  onProgress?: (progress: UserShellProgress) => void;
  onExecutionId?: (executionId: number) => void;
}

export function normalizeUserShellProgress(
  output: ToolLiveOutput,
): UserShellProgress {
  if (typeof output === 'string') {
    return { output };
  }
  if (isShellLiveOutput(output)) {
    return {
      output: output.output,
      totalLines: output.totalLines,
      totalBytes: output.totalBytes,
    };
  }
  return { output: '' };
}

function progressFromData(
  data: ShellProgressMetrics,
): ShellProgressMetrics | undefined {
  if (data.totalLines === undefined && data.totalBytes === undefined) {
    return undefined;
  }
  return {
    ...(data.totalLines === undefined ? {} : { totalLines: data.totalLines }),
    ...(data.totalBytes === undefined ? {} : { totalBytes: data.totalBytes }),
  };
}

/** Status line for the TUI transcript. */
function completedStatusMessage(
  data: Extract<ShellToolExecutionData, { kind: 'completed' }>,
): string {
  if (data.errorMessage) return data.errorMessage;
  if (data.signal !== null) {
    return `Command terminated by signal: ${data.signal}.`;
  }
  if (data.exitCode !== null && data.exitCode !== 0) {
    return `Command exited with code ${data.exitCode}.`;
  }
  return '';
}

/**
 * Status the model sees, in the same wording every other shell-family tool
 * uses — so an expected non-zero exit (a `grep` no-match) reads as its
 * interpretation rather than as a failure.
 */
function modelStatusForCompleted(
  data: Extract<ShellToolExecutionData, { kind: 'completed' }>,
): string {
  return (
    data.errorMessage || shellStatusText(data, data.exitCode, data.signal) || ''
  );
}

function modelStderrForCompleted(
  data: Extract<ShellToolExecutionData, { kind: 'completed' }>,
): string {
  const status = modelStatusForCompleted(data);
  if (!status || data.stderr.includes(status)) return data.stderr;
  return data.stderr ? `${status}\n${data.stderr}` : status;
}

function mapExecutionDataToOutcome(
  command: string,
  data: ShellToolExecutionData,
): UserShellCommandOutcome {
  const output = formatShellExecutionOutput(data);
  const progress = progressFromData(data);

  if (data.kind === 'backgrounded') {
    return {
      kind: 'backgrounded',
      command,
      pid: data.pid,
      displayOutput: `Command moved to background (PID: ${data.pid}). Output hidden. Use /tasks to view.`,
      modelOutput: {
        stdout: data.initialOutput,
        stderr: '',
      },
      ...(progress ? { progress } : {}),
    };
  }

  if (data.kind === 'cancelled') {
    const cancelMessage = data.outputLimitExceeded
      ? `Command was killed because its output file exceeded ${MAX_TASK_OUTPUT_BYTES_DISPLAY}.`
      : data.timedOut
        ? 'Command was cancelled after reaching its timeout.'
        : 'Command was cancelled.';
    return {
      kind: 'cancelled',
      command,
      timedOut: data.timedOut,
      displayOutput: `${cancelMessage}\n${output}`,
      modelOutput: {
        stdout: output,
        stderr: data.outputLimitExceeded ? cancelMessage : data.stderr,
      },
      ...(progress ? { progress } : {}),
    };
  }

  const status = completedStatusMessage(data);
  return {
    kind: 'completed',
    command,
    displayOutput: status ? `${status}\n${output}` : output,
    modelOutput: {
      stdout: output,
      stderr: modelStderrForCompleted(data),
    },
    exitCode: data.exitCode,
    signal: data.signal,
    ...(data.errorMessage ? { errorMessage: data.errorMessage } : {}),
    ...(progress ? { progress } : {}),
  };
}

interface PowerShellToolExecutionData extends Record<string, unknown> {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  timedOut?: boolean;
  isError?: boolean;
  returnCodeInterpretation?: string;
  exitCode?: number;
  backgroundTaskId?: string;
  timedOutAfterMs?: number;
  pid?: number;
  initialOutput?: string;
  totalLines?: number;
  totalBytes?: number;
  persistedOutputPath?: string;
  persistedOutputSize?: number;
}

function isPowerShellToolExecutionData(
  value: unknown,
): value is PowerShellToolExecutionData {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return (
    isString(data['stdout']) &&
    isString(data['stderr']) &&
    isBoolean(data['interrupted']) &&
    (data['exitCode'] === undefined || isNumber(data['exitCode'])) &&
    (data['pid'] === undefined || isNumber(data['pid'])) &&
    (data['initialOutput'] === undefined || isString(data['initialOutput']))
  );
}

function formatPowerShellDisplayOutput(
  data: PowerShellToolExecutionData,
): string {
  const output = [data.stdout.trim(), data.stderr.trim()]
    .filter(Boolean)
    .join('\n');
  const persisted = data.persistedOutputPath
    ? `Full output${data.persistedOutputSize ? ` (${data.persistedOutputSize} bytes)` : ''} saved to:\n${data.persistedOutputPath}`
    : '';
  return (
    [output, persisted].filter(Boolean).join('\n') ||
    '(Command produced no output)'
  );
}

function mapPowerShellDataToOutcome(
  command: string,
  data: PowerShellToolExecutionData,
  result: ToolResult,
): UserShellCommandOutcome {
  const progress = progressFromData(data);
  if (data.backgroundTaskId !== undefined && data.pid !== undefined) {
    return {
      kind: 'backgrounded',
      command,
      pid: data.pid,
      displayOutput: `Command moved to background (PID: ${data.pid}). Output hidden. Use /tasks to view.`,
      modelOutput: {
        stdout: data.initialOutput ?? data.stdout,
        stderr: data.stderr,
      },
      ...(progress ? { progress } : {}),
    };
  }

  const displayOutput = formatPowerShellDisplayOutput(data);
  if (data.interrupted || data.timedOut) {
    return {
      kind: 'cancelled',
      command,
      timedOut: data.timedOut === true,
      displayOutput: `${data.timedOut ? 'Command timed out.' : 'Command was cancelled.'}\n${displayOutput}`,
      modelOutput: { stdout: data.stdout, stderr: data.stderr },
      ...(progress ? { progress } : {}),
    };
  }

  const exitCode = data.exitCode ?? null;
  const error =
    result.error?.message ??
    (data.isError ? `Command exited with code ${exitCode}.` : '');
  const status = error || data.returnCodeInterpretation || '';
  return {
    kind: 'completed',
    command,
    displayOutput: status ? `${status}\n${displayOutput}` : displayOutput,
    modelOutput: {
      stdout: data.stdout,
      stderr:
        error && !data.stderr.includes(error)
          ? data.stderr
            ? `${error}\n${data.stderr}`
            : error
          : data.stderr,
    },
    exitCode,
    signal: null,
    ...(result.error ? { errorMessage: result.error.message } : {}),
    ...(progress ? { progress } : {}),
  };
}

/**
 * Runs a user-authored shell-mode command through the registered default shell
 * tool (Bash when available, otherwise PowerShell).
 * This deliberately bypasses the model Scheduler, permission prompt pipeline,
 * and tool hooks while retaining the tool's execution semantics.
 */
export async function runUserShellCommand(
  options: RunUserShellCommandOptions,
): Promise<UserShellCommandOutcome> {
  const { config, command, signal, callId, onProgress, onExecutionId } =
    options;
  const registry = config.getToolRegistry();
  const toolName =
    !registry.getKnownTool(SHELL_TOOL_NAME) &&
    registry.getKnownTool(POWERSHELL_TOOL_NAME)
      ? POWERSHELL_TOOL_NAME
      : SHELL_TOOL_NAME;
  const shellType: ShellType =
    toolName === POWERSHELL_TOOL_NAME ? 'powershell' : 'bash';
  const registeredTool = config.getToolRegistry().getKnownTool(toolName);
  if (
    !(registeredTool instanceof ShellTool) &&
    !(registeredTool instanceof PowerShellTool)
  ) {
    throw new Error(`Registered ${toolName} tool is unavailable.`);
  }

  const invocation = registeredTool.build({ command });
  if (!invocation.executeWithContext) {
    throw new Error(
      `Registered ${toolName} tool does not support contextual execution.`,
    );
  }

  const sessionId = config.getSessionId?.() ?? 'default';
  const result = await invocation.executeWithContext({
    signal,
    config,
    callId,
    sessionId,
    invocationOrigin: 'user-shell',
    updateOutput: onProgress
      ? (output) => onProgress(normalizeUserShellProgress(output))
      : undefined,
    options: {
      shellExecutionConfig: {
        ...config.getShellExecutionConfig(),
        shellType,
        sessionId,
        pager: 'cat',
        originalCommand: command,
      },
      setExecutionIdCallback: onExecutionId,
    },
  });

  if (toolName === SHELL_TOOL_NAME && isShellToolExecutionData(result.data)) {
    return mapExecutionDataToOutcome(command, result.data);
  }
  if (
    toolName === POWERSHELL_TOOL_NAME &&
    isPowerShellToolExecutionData(result.data)
  ) {
    return mapPowerShellDataToOutcome(command, result.data, result);
  }
  throw new Error(
    `${toolName} tool returned an invalid structured execution result.`,
  );
}

export function backgroundUserShellCommand(
  executionId: number,
  sessionId: string,
  command: string,
): void {
  ShellExecutionService.background(executionId, sessionId, command, 'user');
}
