/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import path from 'node:path';
import { getErrorMessage } from '../utils/errors.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ExecuteOptions,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import type { Config } from '../config/config.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { InternalExecutionOwner } from './tool-types.js';
import { ToolErrorType } from './tool-error.js';
import { getCwd } from '../utils/Shell.js';
import { tailFile } from '../utils/fsOperations.js';
import {
  BASH_INPUT_TOOL_NAME,
  BASH_OUTPUT_TOOL_NAME,
  BASH_RESIZE_TOOL_NAME,
} from './tool-names.js';
import {
  ExecutionLifecycleService,
  type ExecutionResult,
} from '../services/executionLifecycleService.js';
import {
  decodePtyInputEscapes,
  isPtyError,
  PtySessionService,
  type PtyErrorCode,
  type PtySnapshotResult,
} from '../services/pty/ptySessionService.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import {
  getCustomContextFromContext,
  snapshotCustomContext,
} from '../utils/sessionIdContext.js';
import {
  interpretShellExitStatus,
  shellStatusText,
  type ShellExitStatusFields,
} from './shell-exit-status.js';

interface BashPtyToolUseResult
  extends Record<string, unknown>,
    ShellExitStatusFields {
  kind: 'bash_pty';
  action: 'open' | 'input' | 'output' | 'resize' | 'error';
  pty: true;
  pid?: number;
  output_path?: string;
  command?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  alive?: boolean;
  exit_code?: number;
  signal?: number;
  input_preview?: string;
  input_events?: string[];
  input_warnings?: string[];
  screen_hash?: string;
  changed_since_input?: boolean;
  settled?: boolean;
  screen?: string;
  stdout?: string;
  stderr?: string;
  model_output?: string;
  backgroundReason?: 'model';
  error_code?: PtyErrorCode | 'bash_pty_unknown';
  error_message?: string;
  timestamp: number;
}

interface BashOutputFileToolUseResult extends Record<string, unknown> {
  kind: 'bash_output';
  action: 'output' | 'error';
  pty: false;
  pid: number;
  output_path?: string;
  stdout?: string;
  model_output?: string;
  error_code?: 'bash_output_not_found' | 'bash_output_not_a_pty';
  error_message?: string;
  timestamp: number;
}

export interface BashPtyLaunchParams {
  command: string;
  dir_path?: string;
  cols?: number;
  rows?: number;
  wait_ms?: number;
  idle_ms?: number;
}

export interface BashInputParams {
  pid: number;
  chars: string;
  submit?: boolean;
  wait_ms?: number;
  idle_ms?: number;
}

export interface BashOutputParams {
  pid: number;
  lines?: number;
  wait_ms?: number;
  idle_ms?: number;
}

export interface BashResizeParams {
  pid: number;
  cols: number;
  rows: number;
  wait_ms?: number;
  idle_ms?: number;
}

const service = PtySessionService.getInstance();

function previewInput(chars: string, submit?: boolean): string {
  const decodedChars = decodePtyInputEscapes(chars);
  const withSubmit = submit ? `${decodedChars}\r` : decodedChars;
  return withSubmit
    .replaceAll('\u0003', '<Ctrl+C>')
    .replaceAll('\u0004', '<Ctrl+D>')
    .replaceAll('\u001b', '<Esc>')
    .replaceAll('\r', '<Enter>')
    .replaceAll('\n', '<LF>')
    .replaceAll('\t', '<Tab>');
}

/** Cap for the input summary embedded in the BashInput permission message. */
const PERMISSION_MESSAGE_PREVIEW_LIMIT = 120;

/**
 * Display-safe, length-bounded summary of a BashInput payload for the
 * permission dialog. The dialog renders only the decision message, so the
 * user must see what will be written to the PTY session.
 */
export function summarizeInputForPermissionMessage(
  chars: string,
  submit?: boolean,
): string {
  const preview = previewInput(chars, submit);
  if (preview.length <= PERMISSION_MESSAGE_PREVIEW_LIMIT) {
    return preview;
  }
  return `${preview.slice(0, PERMISSION_MESSAGE_PREVIEW_LIMIT)}...`;
}

function snapshotOutput(snapshot: PtySnapshotResult): string {
  return snapshot.screen;
}

function emptyScreenNote(snapshot: PtySnapshotResult): string {
  if (snapshot.alive && snapshot.pid !== undefined) {
    return `(screen is empty so far; the PTY is still running. Use BashOutput({ pid: ${snapshot.pid}, wait_ms: 15000, idle_ms: 1000 }) to wait for the TUI render before deciding the launch failed.)`;
  }
  return '(empty screen)';
}

function modelOutputFromSnapshot(
  action: BashPtyToolUseResult['action'],
  snapshot: PtySnapshotResult,
  output: string,
  status: string | undefined,
): string {
  const lines: string[] = [];
  if (status) lines.push(status, '');
  lines.push(
    displayHeader(action, snapshot),
    `command: ${snapshot.command}`,
    `cwd: ${snapshot.cwd}`,
    '',
    output.trim() || emptyScreenNote(snapshot),
  );
  if (snapshot.input_warnings?.length) {
    lines.push('', `input warnings: ${snapshot.input_warnings.join('; ')}`);
  }
  return lines.join('\n');
}

function toToolUseResult(
  config: Config,
  action: BashPtyToolUseResult['action'],
  snapshot: PtySnapshotResult,
  options?: {
    inputPreview?: string;
    backgroundReason?: 'model';
  },
): BashPtyToolUseResult {
  const stdout = snapshotOutput(snapshot);
  // A live session carries no exit status yet, which reads as a non-error.
  const exitCode = snapshot.exit_code ?? null;
  const signal = snapshot.signal ?? null;
  const exitStatus = interpretShellExitStatus(snapshot.command, exitCode, signal);
  const modelOutput = modelOutputFromSnapshot(
    action,
    snapshot,
    stdout,
    shellStatusText(exitStatus, exitCode, signal),
  );
  if (snapshot.pid !== undefined) {
    config.getPtyLastOutputs().set(snapshot.pid, stdout);
  }
  return {
    kind: 'bash_pty',
    action,
    pty: true,
    pid: snapshot.pid,
    output_path: snapshot.output_path,
    command: snapshot.command,
    cwd: snapshot.cwd,
    cols: snapshot.cols,
    rows: snapshot.rows,
    alive: snapshot.alive,
    exit_code: snapshot.exit_code,
    signal: snapshot.signal,
    input_preview: options?.inputPreview,
    input_events: snapshot.input_events,
    input_warnings: snapshot.input_warnings,
    screen_hash: snapshot.screen_hash,
    changed_since_input: snapshot.changed_since_input,
    settled: snapshot.settled,
    screen: snapshot.screen,
    stdout: stdout || undefined,
    model_output: modelOutput,
    ...exitStatus,
    backgroundReason: options?.backgroundReason,
    timestamp: Date.now(),
  };
}

function displayHeader(action: string, snapshot: PtySnapshotResult): string {
  return `Bash PTY ${action}: PID ${snapshot.pid ?? 'unknown'} (${
    snapshot.cols
  }x${snapshot.rows}, ${snapshot.alive ? 'running' : 'exited'})`;
}

function toolResultFromSnapshot(
  config: Config,
  action: BashPtyToolUseResult['action'],
  snapshot: PtySnapshotResult,
  options?: {
    inputPreview?: string;
    backgroundReason?: 'model';
  },
): ToolResult {
  const toolUseResult = toToolUseResult(config, action, snapshot, options);
  const output = toolUseResult.stdout || '(empty screen)';
  return {
    llmContent: toolUseResult.model_output ?? output,
    returnDisplay: output,
    data: toolUseResult,
    toolUseResult,
    ...(toolUseResult.isError ? { isError: true as const } : {}),
  };
}

function bashPtyError(error: unknown): ToolResult {
  const message = getErrorMessage(error);
  const code = isPtyError(error) ? error.code : 'bash_pty_unknown';
  const toolUseResult: BashPtyToolUseResult = {
    kind: 'bash_pty',
    action: 'error',
    pty: true,
    error_code: code,
    error_message: message,
    stderr: message,
    timestamp: Date.now(),
  };
  return {
    llmContent: `Bash PTY failed (${code}): ${message}`,
    returnDisplay: `Bash PTY failed (${code}): ${message}`,
    error: {
      message,
      type: ToolErrorType.EXECUTION_FAILED,
    },
    data: toolUseResult,
    toolUseResult,
  };
}

function bashOutputFileError(
  pid: number,
  code: BashOutputFileToolUseResult['error_code'],
  message: string,
): ToolResult {
  const toolUseResult: BashOutputFileToolUseResult = {
    kind: 'bash_output',
    action: 'error',
    pty: false,
    pid,
    error_code: code,
    error_message: message,
    timestamp: Date.now(),
  };
  return {
    llmContent: `Bash output failed (${code}): ${message}`,
    returnDisplay: `Bash output failed (${code}): ${message}`,
    error: {
      message,
      type: ToolErrorType.EXECUTION_FAILED,
    },
    data: toolUseResult,
    toolUseResult,
  };
}

async function bashOutputFileResult(
  params: BashOutputParams,
): Promise<ToolResult> {
  const outputPath = ShellExecutionService.getOutputFilePath(params.pid);
  if (!outputPath) {
    return bashOutputFileError(
      params.pid,
      'bash_output_not_found',
      `No Bash output file found for PID ${params.pid}.`,
    );
  }

  const maxBytes = 30_000;
  let content: string;
  let bytesRead: number;
  let bytesTotal: number;
  try {
    const result = await tailFile(outputPath, maxBytes);
    content = result.content;
    bytesRead = result.bytesRead;
    bytesTotal = result.bytesTotal;
  } catch (error) {
    return bashOutputFileError(
      params.pid,
      'bash_output_not_found',
      `Could not read Bash output file for PID ${params.pid}: ${getErrorMessage(
        error,
      )}`,
    );
  }
  const stdout =
    bytesTotal > bytesRead
      ? `[${bytesTotal - bytesRead} bytes of earlier output omitted]\n${content}`
      : content;
  const toolUseResult: BashOutputFileToolUseResult = {
    kind: 'bash_output',
    action: 'output',
    pty: false,
    pid: params.pid,
    output_path: outputPath,
    stdout,
    model_output: `Bash output: PID ${params.pid}\noutput: ${outputPath}\n\n${stdout}`,
    timestamp: Date.now(),
  };
  return {
    llmContent: toolUseResult.model_output ?? stdout,
    returnDisplay: stdout,
    data: toolUseResult,
    toolUseResult,
  };
}

function completionResult(
  lastOutputs: Map<number, string>,
  pid: number,
  snapshot: PtySnapshotResult,
  error: Error | null,
): ExecutionResult {
  const output = snapshotOutput(snapshot);
  lastOutputs.set(pid, output);
  return {
    rawOutput: Buffer.from(snapshot.raw_tail ?? output, 'utf8'),
    output,
    exitCode: snapshot.exit_code ?? 0,
    signal: snapshot.signal ?? null,
    error,
    aborted: false,
    pid,
    executionMethod: 'child_process',
    outputFilePath: snapshot.output_path,
  };
}

function registerPtyLifecycle(
  config: Config,
  pid: number,
  command: string,
  internalExecutionOwner?: InternalExecutionOwner,
  customContext?: Readonly<Record<string, string>>,
): void {
  // 会话自己的 PTY 输出缓存：全局 Map 会让持有 pid 的任一会话读到别人的终端输出。
  const lastOutputs = config.getPtyLastOutputs();
  const suppressNotification =
    internalExecutionOwner?.kind === 'workflow-agent' &&
    internalExecutionOwner.suppressMainSessionNotification;
  ExecutionLifecycleService.attachExecution(pid, {
    executionMethod: 'child_process',
    label: command,
    initialOutput: lastOutputs.get(pid) ?? '',
    outputPath: service.findByPid(config, pid)?.output_path,
    getBackgroundOutput: () => lastOutputs.get(pid) ?? '',
    getSubscriptionSnapshot: () => lastOutputs.get(pid) || undefined,
    customContext,
    writeInput: (input) => {
      void service
        .writeByPid({ pid, chars: input }, config)
        .then((snapshot) => {
          lastOutputs.set(pid, snapshotOutput(snapshot));
        });
    },
    kill: async () => {
      await service.closeByPid({ pid, force: true }, config);
    },
    isActive: () => service.findByPid(config, pid)?.alive ?? false,
    formatInjection: () => '[Background PTY command completed]',
    completionBehavior: suppressNotification ? 'silent' : 'notify',
  });
  ExecutionLifecycleService.background(pid, 'model');
  service.onDataByPid(config, pid, (data) => {
    ExecutionLifecycleService.appendOutput(pid, data);
  });
  service.onExitByPid(config, pid, (exitCode, signal) => {
    void service
      .snapshotByPid(
        { pid, include_raw_tail: true, include_metadata: true },
        config,
      )
      .then((snapshot) => {
        snapshot.exit_code = exitCode;
        snapshot.signal = signal;
        ExecutionLifecycleService.completeWithResult(
          pid,
          completionResult(lastOutputs, pid, snapshot, null),
        );
      })
      .catch((error) => {
        ExecutionLifecycleService.completeWithResult(pid, {
          rawOutput: Buffer.from(lastOutputs.get(pid) ?? '', 'utf8'),
          output: lastOutputs.get(pid) ?? '',
          exitCode: 1,
          signal: null,
          error: error instanceof Error ? error : new Error(String(error)),
          aborted: false,
          pid,
          executionMethod: 'child_process',
        });
      })
      .finally(() => {
        lastOutputs.delete(pid);
      });
  });
}

export async function executeBashPtyCommand(
  context: AgentLoopContext,
  params: BashPtyLaunchParams,
  signal: AbortSignal,
  options?: ExecuteOptions,
  internalExecutionOwner?: InternalExecutionOwner,
): Promise<ToolResult> {
  try {
    const cwd = params.dir_path
      ? path.resolve(context.config.getTargetDir(), params.dir_path)
      : getCwd();
    const snapshot = await service.open(
      {
        command: params.command,
        cwd,
        cols: params.cols,
        rows: params.rows,
        wait_ms: params.wait_ms,
        idle_ms: params.idle_ms,
      },
      context.config,
      options?.shellExecutionConfig,
      signal,
    );
    const pid = snapshot.pid;
    const result = toolResultFromSnapshot(context.config, 'open', snapshot, {
      backgroundReason: snapshot.alive ? 'model' : undefined,
    });

    if (pid !== undefined) {
      options?.setExecutionIdCallback?.(pid);
      if (snapshot.alive) {
        registerPtyLifecycle(
          context.config,
          pid,
          params.command,
          internalExecutionOwner,
          snapshotCustomContext(
            options?.shellExecutionConfig?.customContext ??
              getCustomContextFromContext(),
          ),
        );
      }
    }

    return result;
  } catch (error) {
    return bashPtyError(error);
  }
}

abstract class BashPtyInvocation<
  TParams extends object,
> extends BaseToolInvocation<TParams, ToolResult> {
  constructor(
    params: TParams,
    toolName: string | undefined,
    toolDisplayName: string | undefined,
    protected readonly config: Config,
  ) {
    super(params, toolName, toolDisplayName);
  }
}

class BashInputInvocation extends BashPtyInvocation<BashInputParams> {
  getDescription(): string {
    return `Write to Bash PTY ${this.params.pid}: ${previewInput(
      this.params.chars,
      this.params.submit,
    )}`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    try {
      const inputPreview = previewInput(this.params.chars, this.params.submit);
      const snapshot = await service.writeByPid(
        this.params,
        this.config,
        signal,
      );
      return toolResultFromSnapshot(this.config, 'input', snapshot, {
        inputPreview,
      });
    } catch (error) {
      return bashPtyError(error);
    }
  }
}

class BashOutputInvocation extends BashPtyInvocation<BashOutputParams> {
  getDescription(): string {
    return `Read Bash PTY output ${this.params.pid}`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    try {
      const snapshot = await service.snapshotByPid(
        {
          pid: this.params.pid,
          wait_ms: this.params.wait_ms,
          idle_ms: this.params.idle_ms,
          lines: this.params.lines,
          include_metadata: true,
        },
        this.config,
        signal,
      );
      return toolResultFromSnapshot(this.config, 'output', snapshot);
    } catch (error) {
      if (isPtyError(error) && error.code === 'pty_session_not_found') {
        return bashOutputFileResult(this.params);
      }
      return bashPtyError(error);
    }
  }
}

class BashResizeInvocation extends BashPtyInvocation<BashResizeParams> {
  getDescription(): string {
    return `Resize Bash PTY ${this.params.pid} to ${this.params.cols}x${this.params.rows}`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    try {
      const snapshot = await service.resizeByPid(
        this.params,
        this.config,
        signal,
      );
      return toolResultFromSnapshot(this.config, 'resize', snapshot);
    } catch (error) {
      return bashPtyError(error);
    }
  }
}

abstract class BashPtyTool<TParams extends object> extends BaseDeclarativeTool<
  TParams,
  ToolResult
> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  constructor(
    name: string,
    description: string,
    schema: unknown,
    kind: Kind,
    protected readonly config: Config,
  ) {
    super(name, name, description, kind, schema, false);
  }

  override isConcurrencySafe(_input?: TParams): boolean {
    return false;
  }
}

const bashInputSchema = {
  type: 'object',
  properties: {
    pid: {
      type: 'number',
      description:
        'PID returned by Bash when pty=true was used. This identifies the running interactive PTY session.',
    },
    chars: {
      type: 'string',
      description:
        'Characters or key sequences to write to the PTY stdin. Common escaped control sequences are decoded before writing. Text examples: "hello", "/about". For ordinary text submission, do not append "\\r" manually; use submit=true. Common keys: "\\r" Enter, "\\t" Tab, "\\u001b[Z" Shift+Tab, "\\u001b" or "\\e" Esc, "\\u0003" Ctrl+C, "\\u0004" Ctrl+D, "\\u001b[A" Up, "\\u001b[B" Down, "\\u001b[C" Right, "\\u001b[D" Left, "\\u001b[H" Home, "\\u001b[F" End, "\\u001b[3~" Delete, "\\u007f" Backspace, "\\u001b[5~" PageUp, "\\u001b[6~" PageDown, "\\u001bOP" F1, "\\u001bOQ" F2. Consecutive recognized keys are sent sequentially with internal settling; unrecognized control sequences are sent raw. Empty string writes nothing and only waits before returning output.',
    },
    submit: {
      type: 'boolean',
      description:
        'If true, sends a real Enter/carriage return after chars within the same input transaction, after waiting for the typed text to render or settle. Use submit=true whenever typed text should be executed or sent after input. Leave false for partial typing, cursor/focus movement, menu navigation, function keys, or observing intermediate UI state.',
    },
    wait_ms: {
      type: 'number',
      description:
        'Maximum time to wait for terminal output after writing input before returning.',
    },
    idle_ms: {
      type: 'number',
      description:
        'Consider the rendered screen stable after this many milliseconds without new output.',
    },
  },
  required: ['pid', 'chars'],
};

const bashOutputSchema = {
  type: 'object',
  properties: {
    pid: {
      type: 'number',
      description:
        'PID returned by Bash when pty=true was used. This identifies the running interactive PTY session.',
    },
    lines: {
      type: 'number',
      description:
        'Maximum number of rendered screen lines to return. Omit to return the full current screen.',
    },
    wait_ms: {
      type: 'number',
      description: 'Maximum time to wait for output before returning.',
    },
    idle_ms: {
      type: 'number',
      description:
        'Consider the rendered screen stable after this many milliseconds without new output.',
    },
  },
  required: ['pid'],
};

const bashResizeSchema = {
  type: 'object',
  properties: {
    pid: {
      type: 'number',
      description:
        'PID returned by Bash when pty=true was used. This identifies the running interactive PTY session.',
    },
    cols: {
      type: 'number',
      description: 'New PTY width in character cells, not pixels.',
    },
    rows: {
      type: 'number',
      description: 'New PTY height in character cells, not pixels.',
    },
    wait_ms: {
      type: 'number',
      description:
        'Maximum time to wait for output after resizing before returning.',
    },
    idle_ms: {
      type: 'number',
      description:
        'Consider the rendered screen stable after this many milliseconds without new output.',
    },
  },
  required: ['pid', 'cols', 'rows'],
};

export class BashInputTool extends BashPtyTool<BashInputParams> {
  static readonly Name = BASH_INPUT_TOOL_NAME;

  constructor(config: Config) {
    super(
      BashInputTool.Name,
      'Write input to a running Bash PTY session started with Bash pty=true. Use this for typing text, submitting commands, navigating menus, or sending control/function keys. For normal text that should be executed or sent, use one call with submit=true; BashInput sends text and Enter as one ordered transaction and returns the settled rendered screen.',
      bashInputSchema,
      Kind.Execute,
      config,
    );
  }

  override isDestructive(_input?: BashInputParams): boolean {
    return true;
  }

  protected override validateToolParamValues(
    params: BashInputParams,
  ): string | null {
    if (!Number.isFinite(params.pid) || params.pid <= 0) {
      return 'pid must be a positive number.';
    }
    return null;
  }

  protected createInvocation(
    params: BashInputParams,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<BashInputParams, ToolResult> {
    return new BashInputInvocation(
      params,
      toolName,
      toolDisplayName,
      this.config,
    );
  }
}

export class BashOutputTool extends BashPtyTool<BashOutputParams> {
  static readonly Name = BASH_OUTPUT_TOOL_NAME;

  constructor(config: Config) {
    super(
      BashOutputTool.Name,
      'Wait for and read the current rendered screen from a running Bash PTY session. Use this when you need extra waiting or observation, such as an empty/loading screen, long asynchronous output, a previous BashInput with settled=false or input_warnings, or an explicit need to re-read the current screen. It is usually unnecessary immediately after a successful BashInput because BashInput already returns the rendered screen.',
      bashOutputSchema,
      Kind.Read,
      config,
    );
  }

  override isConcurrencySafe(_input?: BashOutputParams): boolean {
    return true;
  }

  protected override validateToolParamValues(
    params: BashOutputParams,
  ): string | null {
    if (!Number.isFinite(params.pid) || params.pid <= 0) {
      return 'pid must be a positive number.';
    }
    return null;
  }

  protected createInvocation(
    params: BashOutputParams,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<BashOutputParams, ToolResult> {
    return new BashOutputInvocation(
      params,
      toolName,
      toolDisplayName,
      this.config,
    );
  }
}

export class BashResizeTool extends BashPtyTool<BashResizeParams> {
  static readonly Name = BASH_RESIZE_TOOL_NAME;

  constructor(config: Config) {
    super(
      BashResizeTool.Name,
      'Resize a running Bash PTY session and return the rendered screen after resizing. Use this when a TUI layout is too narrow, clipped, wrapped unexpectedly, or needs a fixed test viewport.',
      bashResizeSchema,
      Kind.Execute,
      config,
    );
  }

  override isDestructive(_input?: BashResizeParams): boolean {
    return true;
  }

  protected override validateToolParamValues(
    params: BashResizeParams,
  ): string | null {
    if (!Number.isFinite(params.pid) || params.pid <= 0) {
      return 'pid must be a positive number.';
    }
    if (params.cols <= 0 || params.rows <= 0) {
      return 'cols and rows must be positive.';
    }
    return null;
  }

  protected createInvocation(
    params: BashResizeParams,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<BashResizeParams, ToolResult> {
    return new BashResizeInvocation(
      params,
      toolName,
      toolDisplayName,
      this.config,
    );
  }
}
