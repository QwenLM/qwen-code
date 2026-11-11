/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import type { Config } from '../config/config.js';
import type {
  PrepareShellEnvironment,
  ShellEnvironmentInvocation,
} from './shell-environment.js';
import type {
  ShellEnvironmentPreparation,
  ShellSpawnPreparationConfig,
} from '../services/shellSpawnPreparation.js';
import { createLocalBashTaskId } from '../tasks/task-id.js';
import {
  snapshotKnownShellFileState,
  shellChangedFilesHint,
} from './shell-file-state.js';
import {
  interpretKnownShellExitStatus,
  shellStatusText,
  type ShellExitStatusFields,
} from './shell-exit-status.js';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { AgentLoopContext } from '../config/agent-loop-context.js';
import {
  isPowerShellAutoBackgroundAllowed,
  isPowerShellReadOnlyCached,
} from './shell-permissions/powerShellPermissions.js';
import {
  ShellExecutionService,
  type ShellExecutionResult,
  type ShellOutputEvent,
} from '../services/shellExecutionService.js';
import type { BackgroundReason } from '../services/executionLifecycleService.js';
import { getCwd } from '../utils/Shell.js';
import {
  resetCwdIfOutsideWorkspace,
  stdErrAppendShellResetMessage,
} from '../utils/cwd-reset.js';
import {
  formatFileSize,
  sanitizeFilenamePart,
  TOOL_OUTPUTS_DIR,
} from '../utils/fileUtils.js';
import { runLogger } from '../utils/runLogger.js';
import type { PowerShellEdition } from '../utils/shell/powerShell.js';
import { ToolErrorType } from './tool-error.js';
import type { InterruptBehavior, ToolUseContext } from './tool-types.js';
import {
  POWERSHELL_TOOL_NAME,
  SHELL_TOOL_NAME,
  MONITOR_TOOL_NAME,
} from './tool-names.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ExecuteOptions,
  type ToolInvocation,
  type ToolLiveOutput,
  type ToolResult,
} from './tools.js';
import {
  defaultTimeoutMs,
  maxTimeoutMs,
} from './definitions/dynamic-declaration-helpers.js';
import {
  SHELL_PERSISTED_OUTPUT_MAX_BYTES,
  SHELL_PROGRESS_THRESHOLD_MS,
} from '../utils/shellOutputPolicy.js';

function getDefaultShellTimeoutMs(): number {
  const value = Number(process.env['BASH_DEFAULT_TIMEOUT_MS']);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : defaultTimeoutMs;
}

function getMaxShellTimeoutMs(): number {
  const value = Number(process.env['BASH_MAX_TIMEOUT_MS']);
  return Math.max(
    Number.isFinite(value) && value > 0 ? Math.floor(value) : maxTimeoutMs,
    getDefaultShellTimeoutMs(),
  );
}

export interface PowerShellToolParams {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
}

function getPowerShellDescription(edition: PowerShellEdition): string {
  const defaultTimeoutMs = getDefaultShellTimeoutMs();
  const maxTimeoutMs = getMaxShellTimeoutMs();
  const editionGuidance =
    edition === 'core'
      ? `This tool uses PowerShell 7+. Use && and || when commands depend on the previous command's success. Ternary expressions, ??, and ?. are supported. The default file encoding is UTF-8 without a BOM.`
      : `This tool uses Windows PowerShell 5.1. Do not use &&, ||, ternary expressions, ??, or ?.. For conditional chaining use \`A; if ($?) { B }\`; for unconditional chaining use \`A; B\`. Avoid \`2>&1\` with native executables because 5.1 can wrap stderr as NativeCommandError and set $? to false even when the executable exits successfully. Specify \`-Encoding utf8\` for files shared with other tools; ordinary tool commands default Out-File and redirection to UTF-8 with a BOM. Other cmdlets and scripts starting with declarations retain their own defaults. ConvertFrom-Json does not support -AsHashtable.`;

  return `Executes PowerShell commands with an optional timeout.

The working directory persists between calls, but PowerShell variables, functions, aliases, imported modules, and environment changes made inside a command do not. Use this tool for terminal operations such as git, npm, docker, native programs, and PowerShell cmdlets. Prefer the dedicated Read, Write, Edit, Grep, and Glob tools for file content and file discovery operations.

${editionGuidance}

Command rules:
- The tool already starts in the current working directory. Do not prepend Set-Location to every command.
- Verify a parent directory with Get-ChildItem before creating files or directories in it. Quote paths containing spaces.
- Make independent PowerShell calls in parallel. Chain dependent operations in one call.
- Outside quoted strings and here-strings, use semicolons rather than newlines to separate commands.
- Capture command output. Do not start interactive prompts or interfaces such as Read-Host, Get-Credential, Out-GridView, PromptForChoice, pause, or an editor-opening git command.
- For destructive cmdlets that would prompt, add -Confirm:$false only when the destructive operation was requested.

PowerShell syntax reminders:
- Variables use $, and the escape character is the backtick.
- Single-quoted strings are literal. Double-quoted strings expand variables and subexpressions; use \${name} when text immediately follows a variable name.
- Cmdlets use Verb-Noun names. Common aliases include ls/Get-ChildItem, cd/Set-Location, cat/Get-Content, and rm/Remove-Item.
- Pipelines pass objects. Use Select-Object, Where-Object, and ForEach-Object instead of assuming text-only pipelines.
- Environment variables use $env:NAME. Registry paths use Registry:: or HKLM:/HKCU: drives.
- Invoke a native executable whose path contains spaces with the call operator: & "C:\\Program Files\\tool.exe".

Common command translations:
- head/tail: Get-Content -Head/-Tail
- which: Get-Command
- touch an existing file: (Get-Item path).LastWriteTime = Get-Date; do not use New-Item -Force because it can truncate an existing file
- wc -l: Measure-Object -Line
- mkdir -p: New-Item -ItemType Directory -Force
- rm -rf: Remove-Item -Recurse -Force
- ln -s: New-Item -ItemType SymbolicLink -Path link -Target target
- chmod/chown: inspect and update the access control list with Get-Acl and Set-Acl
- /dev/null: $null
- inline environment variable: $env:NAME='value'; command
- shell control flow: use if/elseif/else, foreach, and try/catch/finally instead of Bash test, for, or trap syntax

For native programs with multiline arguments, prefer a single-quoted here-string. Its closing '@ marker must begin in column zero. Use a double-quoted here-string only when interpolation is required. Use --% only when PowerShell must stop parsing the remaining native arguments.

MSVC tools may only be available after initializing a Visual Studio developer shell. Run the developer-shell initialization and the dependent build command in the same PowerShell call because environment changes do not persist between calls.

-ErrorAction SilentlyContinue hides error output but does not guarantee a successful tool exit. To intentionally ignore a cmdlet error, use try { ... -ErrorAction Stop } catch {}.

The default timeout is ${Math.round(defaultTimeoutMs / 1000)} seconds and the maximum is ${Math.round(maxTimeoutMs / 1000)} seconds. Provide a short active-voice description. Large outputs may be truncated or saved to a file. Set run_in_background to start a long-running command in the background; completion is reported automatically, so do not poll. Avoid unnecessary sleep commands and sleep-based retry loops.

For git, create a new commit by default instead of amending. Before destructive git operations, consider a safer alternative. Do not bypass hooks or signing unless the user explicitly requests it.`;
}

function getPowerShellSchema(edition: PowerShellEdition) {
  const maxTimeoutMs = getMaxShellTimeoutMs();
  return {
    name: POWERSHELL_TOOL_NAME,
    description: getPowerShellDescription(edition),
    parametersJsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: {
          type: 'string',
          description: 'The PowerShell command to execute',
        },
        timeout: {
          type: 'number',
          minimum: 0,
          maximum: maxTimeoutMs,
          description: `Optional timeout in milliseconds. Maximum ${maxTimeoutMs}ms.`,
        },
        description: {
          type: 'string',
          description:
            'Clear, concise description of what this command does in active voice.',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Set to true to run this command in the background.',
        },
      },
      required: ['command'],
    },
  };
}

function formatBackgroundMessage(
  id: string,
  reason: BackgroundReason | undefined,
  outputPath?: string,
): string {
  const output = outputPath
    ? ` Output is being written to: ${outputPath}.`
    : '';
  switch (reason) {
    case 'model':
      return `PowerShell command is running in the background (task ${id}).${output}`;
    case 'timeout':
      return `PowerShell command exceeded its timeout and was moved to the background (task ${id}).${output}`;
    case 'user':
      return `PowerShell command was moved to the background by the user (task ${id}).${output}`;
    default:
      return `PowerShell command moved to the background (task ${id}).${output}`;
  }
}

export async function interpretPowerShellExitStatus(
  command: string,
  exitCode: number | null,
  signal: number | null,
  stdout = '',
  stderr = '',
): Promise<ShellExitStatusFields> {
  if (signal !== null || exitCode === null || exitCode === 0)
    return interpretKnownShellExitStatus(undefined, exitCode, signal);
  // Result interpretation is independent of permission analysis. In particular,
  // a restricted host may execute an approved command but prohibit AST parsing.
  const lastCommand = lastPowerShellCommand(command)
    .trim()
    .replace(/^[&.]\s+/u, '');
  const token = /^(?:"[^"]*"|'[^']*'|\S+)/u.exec(lastCommand)?.[0] ?? '';
  const executableName = path.win32
    .basename(token.replace(/^["']|["']$/gu, ''))
    .toLowerCase();
  let key: string | undefined = executableName.replace(
    /\.(?:exe|cmd|bat)$/u,
    '',
  );
  if (
    exitCode === 1 &&
    executableName.endsWith('.exe') &&
    ['where', 'fc', 'diff'].includes(key)
  ) {
    if (!stdout.trim() && !stderr.trim()) return { isError: true };
    return {
      returnCodeInterpretation:
        key === 'where' ? 'No matching files found' : 'Files differ',
    };
  }
  // Bare fc/diff/where are PowerShell aliases, not the native executables.
  if (['where', 'fc', 'diff'].includes(key)) key = undefined;
  if (key === 'git') {
    const args = lastCommand.slice(token.length).trim().split(/\s+/u);
    key = undefined;
    for (let index = 0; index < args.length; index++) {
      const argument = args[index];
      if (argument === '-C' || argument === '-c') {
        index++;
        continue;
      }
      if (argument.startsWith('-')) continue;
      if (argument === 'diff' || argument === 'grep') key = `git ${argument}`;
      break;
    }
  }
  return interpretKnownShellExitStatus(key, exitCode, signal);
}

/** Lightweight result attribution only; never use this to authorize a command. */
function lastPowerShellCommand(source: string): string {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (quote === '"' && char === '`') index++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '#' && (index === 0 || /[ \t\r\n]/u.test(source[index - 1]))) {
      segments.push(source.slice(start, index));
      while (index + 1 < source.length && !/[\r\n]/u.test(source[index + 1]))
        index++;
      start = index + 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (
      /[;|\r\n]/u.test(char) ||
      (char === '&' &&
        (source[index + 1] === '&' ||
          (/[ \t]/u.test(source[index - 1] ?? '') &&
            source.slice(start, index).trim() !== '')))
    ) {
      segments.push(source.slice(start, index));
      if (char === '&' && source[index + 1] === '&') index++;
      start = index + 1;
    }
  }
  segments.push(source.slice(start));
  return segments.findLast((segment) => segment.trim()) ?? source;
}

async function persistLargeOutput(
  context: AgentLoopContext,
  sessionId: string,
  result: ShellExecutionResult,
): Promise<{ path?: string; size?: number }> {
  if (!result.outputFilePath || !result.outputFileSize) return {};
  try {
    const projectTempDir = context.config.storage.getProjectTempDir();
    if (!projectTempDir) return {};
    const outputDirectory = path.join(
      projectTempDir,
      TOOL_OUTPUTS_DIR,
      `session-${sanitizeFilenamePart(sessionId)}`,
    );
    await fs.mkdir(outputDirectory, { recursive: true });
    const destination = path.join(
      outputDirectory,
      path.basename(result.outputFilePath),
    );
    try {
      await fs.rename(result.outputFilePath, destination);
    } catch {
      await fs.copyFile(result.outputFilePath, destination);
      await fs.unlink(result.outputFilePath).catch(() => undefined);
    }
    if (result.outputFileSize > SHELL_PERSISTED_OUTPUT_MAX_BYTES) {
      await fs.truncate(destination, SHELL_PERSISTED_OUTPUT_MAX_BYTES);
    }
    return {
      path: destination,
      size: Math.min(result.outputFileSize, SHELL_PERSISTED_OUTPUT_MAX_BYTES),
    };
  } catch (error) {
    runLogger.warn('[PowerShellTool] Failed to persist large output', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

class PowerShellToolInvocation extends BaseToolInvocation<
  PowerShellToolParams,
  ToolResult
> {
  constructor(
    private readonly context: AgentLoopContext,
    params: PowerShellToolParams,
    private readonly edition: PowerShellEdition,
    toolName?: string,
    toolDisplayName?: string,
    private readonly prepareEnvironment?: PrepareShellEnvironment,
  ) {
    super(params, toolName, toolDisplayName);
  }

  getDescription(): string {
    return this.params.description?.trim() || this.params.command;
  }

  override getDisplayTitle(): string {
    return this.params.command;
  }

  override getExplanation(): string {
    const description = this.params.description
      ?.replace(/[\r\n]+/gu, ' ')
      .trim();
    return `${description ? `(${description}) ` : ''}[current working directory ${getCwd()}]${this.params.run_in_background ? ' [background]' : ''}`;
  }

  execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
    options?: ExecuteOptions,
  ): Promise<ToolResult> {
    return this.executeInternal(signal, updateOutput, options);
  }

  override executeWithContext(context: ToolUseContext): Promise<ToolResult> {
    return this.executeInternal(
      context.signal,
      context.updateOutput,
      context.options,
      context,
    );
  }

  private async executeInternal(
    signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
    options?: ExecuteOptions,
    toolUseContext?: ToolUseContext,
  ): Promise<ToolResult> {
    if (signal.aborted) {
      const data = {
        stdout: '',
        stderr: '',
        interrupted: true,
        isError: true,
        isImage: false,
      };
      return {
        llmContent: 'PowerShell command was cancelled before it could start.',
        returnDisplay: 'PowerShell command cancelled.',
        data,
        toolUseResult: data,
        isError: true,
      };
    }

    const originalConfig = options?.shellExecutionConfig;
    const preparationConfig = {
      ...originalConfig,
      sessionContext: originalConfig?.sessionContext ?? this.context.config,
      sanitizationConfig: originalConfig?.sanitizationConfig ?? this.context.config.sanitizationConfig,
    };
    const shellExecutionConfig = {
      ...originalConfig,
      // Tool preparation replaces the session default; do not run both.
      environmentPreparation: await this.prepareEnvironment?.(preparationConfig, {
        command: this.params.command,
        context: toolUseContext,
      }) ?? originalConfig?.environmentPreparation,
    };
    const sessionId =
      toolUseContext?.sessionId ??
      this.context.config.getSessionId() ??
      'default';
    const suppressBackground =
      toolUseContext?.internalExecutionOwner?.disableShellAutoBackground ===
      true;
    const requestedBackground =
      this.params.run_in_background === true && !suppressBackground;
    const registry = (toolUseContext?.agentLoopContext ?? this.context)
      .toolRegistry;
    const firstStatement = this.params.command
      .trim()
      .split(/[;|&\r\n]/u)[0]
      .trim();
    const sleep =
      /^(?:start-sleep|sleep)(?:\s+-s(?:econds)?)?\s+(\d+(?:\.\d*)?)\s*$/iu.exec(
        firstStatement,
      );
    if (
      toolUseContext?.invocationOrigin !== 'user-shell' &&
      !suppressBackground &&
      !this.params.run_in_background &&
      registry?.hasToolEnabled(SHELL_TOOL_NAME) &&
      registry.hasToolEnabled(MONITOR_TOOL_NAME) &&
      sleep &&
      Number(sleep[1]) >= 25
    ) {
      const message =
        'Long foreground sleeps are not supported when Monitor is available. Use Monitor to watch a condition, or run_in_background to wait for a command. Do not chain shorter sleeps to bypass this check.';
      return {
        llmContent: message,
        returnDisplay: message,
        isError: true,
        error: { message, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }
    const defaultTimeoutMs = getDefaultShellTimeoutMs();
    const maxTimeoutMs = getMaxShellTimeoutMs();
    const timeoutMs = Math.min(
      Math.max(this.params.timeout || defaultTimeoutMs, 0),
      maxTimeoutMs,
    );
    const autoBackground =
      !requestedBackground &&
      !suppressBackground &&
      (await isPowerShellAutoBackgroundAllowed(this.params.command));

    let cumulativeOutput = '';
    let latestLines = 0;
    let latestBytes = 0;
    let progressEnabled = false;

    const fileStateCache =
      toolUseContext?.invocationOrigin === 'user-shell'
        ? undefined
        : (toolUseContext?.fileReadState ?? this.context.fileReadState);
    const watchedFiles =
      fileStateCache &&
      !requestedBackground &&
      this.context.config.isInteractive() &&
      !this.context.config.getAcpMode() &&
      !isPowerShellReadOnlyCached(this.params.command, { cwd: getCwd() })
        ? await snapshotKnownShellFileState(fileStateCache, signal)
        : [];

    const taskId = createLocalBashTaskId();
    const handle = await ShellExecutionService.execute(
      this.params.command,
      getCwd(),
      (event: ShellOutputEvent) => {
        if (event.type !== 'data') return;
        cumulativeOutput = event.chunk;
        latestLines = event.totalLines ?? latestLines;
        latestBytes = event.totalBytes ?? latestBytes;
        if (progressEnabled && updateOutput) {
          updateOutput({
            isShellLiveOutput: true,
            output: cumulativeOutput,
            totalLines: latestLines,
            totalBytes: latestBytes,
          });
        }
      },
      signal,
      {
        ...shellExecutionConfig,
        shellType: 'powershell',
        taskId,
        taskKind: 'bash',
        taskDescription: this.params.description,
        ownerAgentId: toolUseContext?.agentId,
        toolUseId: toolUseContext?.callId,
        startInBackground: requestedBackground
          ? { reason: 'model' }
          : undefined,
        preventCwdChanges:
          requestedBackground ||
          shellExecutionConfig?.preventCwdChanges === true,
        absoluteTimeout: timeoutMs,
        autoBackgroundOnTimeout: autoBackground,
        originalCommand: this.params.command,
        sessionId,
        sanitizationConfig:
          shellExecutionConfig?.sanitizationConfig ??
          this.context.config.sanitizationConfig,
        preserveStdoutAndStderr: true,
        completionBehavior: suppressBackground
          ? 'silent'
          : shellExecutionConfig?.completionBehavior,
      },
    );

    if (handle.pid !== undefined) {
      options?.setExecutionIdCallback?.(handle.pid);
    }

    const executionId = handle.pid;
    const onInterrupt = (): void => {
      if (
        signal.reason !== 'interrupt' ||
        executionId === undefined ||
        !ShellExecutionService.isActive(executionId)
      ) {
        return;
      }
      if (autoBackground) {
        ShellExecutionService.background(
          executionId,
          sessionId,
          this.params.command,
          'user',
          taskId,
        );
      } else {
        void ShellExecutionService.kill(executionId).catch((error: unknown) => {
          runLogger.warn('[PowerShellTool] Interrupt kill failed', {
            executionId,
            error: String(error),
          });
        });
      }
    };
    if (!requestedBackground) {
      signal.addEventListener('abort', onInterrupt, { once: true });
    }

    if (!requestedBackground) {
      let thresholdTimer: ReturnType<typeof setTimeout> | undefined;
      const earlyResult = await Promise.race([
        handle.result,
        new Promise<null>((resolve) => {
          thresholdTimer = setTimeout(
            () => resolve(null),
            SHELL_PROGRESS_THRESHOLD_MS,
          );
          thresholdTimer.unref();
        }),
      ]);
      if (earlyResult !== null) {
        clearTimeout(thresholdTimer);
      } else {
        progressEnabled = true;
        if (updateOutput && cumulativeOutput) {
          updateOutput({
            isShellLiveOutput: true,
            output: cumulativeOutput,
            totalLines: latestLines,
            totalBytes: latestBytes,
          });
        }
      }
    }

    const result = await handle.result;
    signal.removeEventListener('abort', onInterrupt);
    if (result.backgrounded) {
      const outputPath = result.pid
        ? ShellExecutionService.getOutputFilePath(result.pid)
        : undefined;
      const message = formatBackgroundMessage(
        taskId,
        result.backgroundReason,
        outputPath,
      );
      const data = {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        interrupted: false,
        backgroundTaskId: taskId,
        backgroundReason: result.backgroundReason,
        ...(result.backgroundReason === 'user'
          ? { backgroundedByUser: true }
          : {}),
        ...(result.backgroundReason === 'timeout'
          ? { timedOutAfterMs: timeoutMs }
          : {}),
        pid: result.pid,
        command: this.params.command,
        initialOutput: result.output,
        totalLines: latestLines,
        totalBytes: latestBytes,
      };
      return {
        llmContent: `${message}${result.output ? `\nInitial output:\n${result.output}` : ''}`,
        returnDisplay: message,
        data,
        toolUseResult: data,
      };
    }

    const stdout = (result.stdout ?? '').replace(/^\r?\n/u, '').trimEnd();
    const executionFailure = result.error
      ? `PowerShell ${result.pid === undefined ? 'could not start' : 'execution failed'}: ${result.error.message}`
      : undefined;
    let stderr = [result.stderr?.trim(), executionFailure]
      .filter(Boolean)
      .join('\n');
    if (
      !shellExecutionConfig?.preventCwdChanges &&
      resetCwdIfOutsideWorkspace(this.context.config.getWorkspaceContext())
    ) {
      stderr = stdErrAppendShellResetMessage(stderr);
    }

    const persisted = await persistLargeOutput(this.context, sessionId, result);
    const exitStatus: ShellExitStatusFields =
      result.error || result.aborted
        ? { isError: true }
        : await interpretPowerShellExitStatus(
            this.params.command,
            result.exitCode,
            result.signal,
            stdout,
            stderr,
          );
    const interrupted = result.aborted;
    const data = {
      stdout,
      stderr,
      interrupted,
      ...(result.timedOut ? { timedOut: true } : {}),
      ...exitStatus,
      isImage: false,
      ...(persisted.path ? { persistedOutputPath: persisted.path } : {}),
      ...(persisted.size ? { persistedOutputSize: persisted.size } : {}),
      ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
    };

    const fileChangeHint =
      fileStateCache && !signal.aborted
        ? await shellChangedFilesHint(
            watchedFiles,
            fileStateCache,
            this.context.config,
            {
              ...toolUseContext,
              signal,
              agentLoopContext:
                toolUseContext?.agentLoopContext ?? this.context,
            },
          )
        : undefined;
    const content = [
      fileChangeHint,
      `stdout:\n${stdout || '(empty)'}`,
      `stderr:\n${stderr || '(empty)'}`,
      shellStatusText(exitStatus, result.exitCode, result.signal),
      interrupted ? '[Command was interrupted]' : '',
      persisted.path && persisted.size
        ? `Full output (${formatFileSize(persisted.size)}) saved to: ${persisted.path}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    const failed = exitStatus.isError === true;
    if (failed) {
      runLogger.warn('[PowerShellTool] Execution failed', {
        taskId,
        toolUseId: toolUseContext?.callId,
        edition: this.edition,
        phase:
          result.error && result.pid === undefined
            ? 'startup'
            : result.timedOut
              ? 'timeout'
              : result.aborted
                ? 'cancelled'
                : 'execution',
        exitCode: result.exitCode,
        signal: result.signal,
        errorCode: (result.error as NodeJS.ErrnoException | null)?.code,
      });
    }
    const display = [stdout, stderr].filter(Boolean).join('\n') || content;

    return {
      llmContent: content,
      returnDisplay: display,
      data,
      toolUseResult: data,
      ...(failed
        ? {
            isError: true,
            error: {
              message:
                executionFailure ??
                (result.aborted
                  ? 'PowerShell command was interrupted.'
                  : `PowerShell command exited with code ${String(result.exitCode)}.`),
              type: ToolErrorType.SHELL_EXECUTE_ERROR,
            },
          }
        : {}),
    };
  }
}

export class PowerShellTool extends BaseDeclarativeTool<
  PowerShellToolParams,
  ToolResult
> {
  static readonly Name = POWERSHELL_TOOL_NAME;
  override readonly configurationName = 'PowerShellTool';

  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }

  private readonly cachedSchema: ReturnType<typeof getPowerShellSchema>;

  constructor(
    protected readonly context?: AgentLoopContext,
    readonly edition: PowerShellEdition = 'core',
  ) {
    const schema = getPowerShellSchema(edition);
    super(
      schema.name,
      schema.name,
      schema.description,
      Kind.Execute,
      schema.parametersJsonSchema,
      false,
      true,
    );
    this.cachedSchema = schema;
  }

  get isBoundToConfig(): boolean {
    return this.context !== undefined;
  }

  bindToConfig(
    config: Config,
    edition: PowerShellEdition = this.edition,
  ): PowerShellTool {
    return new PowerShellTool(config, edition);
  }

  override build(
    params: PowerShellToolParams,
    context?: ToolUseContext,
  ): ToolInvocation<PowerShellToolParams, ToolResult> {
    if (context?.config && this.context?.config !== context.config) {
      return this.bindToConfig(context.config).build(params, context);
    }
    return super.build(params, context);
  }

  async prepareEnvironment(
    _config: ShellSpawnPreparationConfig,
    _invocation?: ShellEnvironmentInvocation,
  ): Promise<ShellEnvironmentPreparation | undefined> {
    return undefined;
  }

  override get maxResultSizeChars(): number {
    return 30_000;
  }

  override isConcurrencySafe(input?: PowerShellToolParams): boolean {
    if (!input) return false;
    return isPowerShellReadOnlyCached(input.command, { cwd: getCwd() });
  }

  override isDestructive(input?: PowerShellToolParams): boolean {
    return input
      ? !isPowerShellReadOnlyCached(input.command, { cwd: getCwd() })
      : true;
  }

  override interruptBehavior(): InterruptBehavior {
    return 'background';
  }

  protected override validateToolParamValues(
    params: PowerShellToolParams,
  ): string | null {
    if (!params.command.trim()) return 'Command cannot be empty.';
    if (
      params.timeout !== undefined &&
      (!Number.isFinite(params.timeout) || params.timeout < 0)
    ) {
      return 'Timeout must be a finite, non-negative number.';
    }
    // CRLF is a visible line break; a lone CR can conceal text in the dialog.
    for (const character of params.command.replaceAll('\r\n', '\n')) {
      const codePoint = character.codePointAt(0)!;
      if (
        (codePoint < 32 && codePoint !== 9 && codePoint !== 10) ||
        (codePoint >= 127 && codePoint <= 159)
      ) {
        return `Command contains control character U+${codePoint
          .toString(16)
          .toUpperCase()
          .padStart(4, '0')}, which may be invisible in the permission dialog.`;
      }
    }
    return null;
  }

  protected createInvocation(
    params: PowerShellToolParams,
    toolName?: string,
    toolDisplayName?: string,
  ): ToolInvocation<PowerShellToolParams, ToolResult> {
    if (!this.context) {
      throw new Error('PowerShellTool requires a tool context with a session config');
    }
    return new PowerShellToolInvocation(
      this.context,
      params,
      this.edition,
      toolName,
      toolDisplayName,
      this.prepareEnvironment.bind(this),
    );
  }

  override getSchema() {
    return this.cachedSchema;
  }

  override toClassifierInput(input: PowerShellToolParams): unknown {
    return input.command;
  }
}
