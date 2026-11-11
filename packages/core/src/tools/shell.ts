/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { shellContract } from '../codemode/contracts.js';
import type { Config } from '../config/config.js';
import { parse as parseShell } from 'shell-quote';
import type {
  PrepareShellEnvironment,
  ShellEnvironmentInvocation,
} from './shell-environment.js';
import type {
  ShellEnvironmentPreparation,
  ShellSpawnPreparationConfig,
} from '../services/shellSpawnPreparation.js';
import {
  normalizeFileStateContent,
  trackFileStateResult,
  type FileStateCache,
} from '../utils/fileStateCache.js';
import fs from 'node:fs';
import path from 'node:path';
import { runLogger } from '../utils/runLogger.js';
import { truncateString } from '../utils/textUtils.js';
import { ToolErrorType } from './tool-error.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type ToolLiveOutput,
  type ExecuteOptions,
  isShellLiveOutput,
} from './tools.js';

import { getErrorMessage } from '../utils/errors.js';
import { summarizeToolOutput } from '../utils/summarizer.js';
import {
  ShellExecutionService,
  type ShellExecutionConfig,
  type ShellOutputEvent,
} from '../services/shellExecutionService.js';
import {
  getCwd,
  runWithShellSession,
  getOriginalCwd,
  resolveShellCwd,
  setCwdAndNotify,
} from '../utils/Shell.js';
import {
  resetCwdIfOutsideWorkspace,
  stdErrAppendShellResetMessage,
} from '../utils/cwd-reset.js';
import type { BackgroundReason } from '../services/executionLifecycleService.js';
import {
  getCommandRoots,
  getBashClampCommandSegments,
  initializeShellParsers,
  stripShellWrapper,
} from '../utils/shell-utils.js';
import { SHELL_TOOL_NAME } from './tool-names.js';
import type { InterruptBehavior, ToolUseContext } from './tool-types.js';
import {
  getShellDeclaration,
  defaultTimeoutMs,
  maxTimeoutMs,
} from './definitions/dynamic-declaration-helpers.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import { checkReadOnlyShellCommand } from './shell-permissions/shellReadOnlyValidation.js';
import { executeBashPtyCommand } from './bash-pty.js';
import {
  isBashPtyToolsEnabled,
  ENV_ENABLE_BASH_PTY_TOOLS,
} from './bash-pty-feature-gate.js';
import {
  formatCompletedShellModelContent,
  formatShellExecutionOutput,
  formatShellTerminationReason,
  persistShellOutput,
  prependCompletedShellFailureStatus,
  SHELL_INLINE_OUTPUT_MAX_BYTES,
  SHELL_PROGRESS_THRESHOLD_MS,
  shellOutputBody,
  type PersistedShellOutput,
  type ShellToolExecutionData,
} from './shell-result.js';
import { interpretShellExitStatus } from './shell-exit-status.js';
import {
  getCustomContextFromContext,
  getSessionIdFromContext,
  snapshotCustomContext,
} from '../utils/sessionIdContext.js';
import { createLocalBashTaskId } from '../tasks/task-id.js';
import { getToolCallContext } from '../utils/toolCallContext.js';
import { resolvePromptBundleForModel } from '../prompts/bundle-resolver.js';
import {
  shellChangedFilesHint,
  snapshotShellFileState,
} from './shell-file-state.js';

export const OUTPUT_UPDATE_INTERVAL_MS = 1000;

/**
 * Initial wait before showing progress UI for foreground commands.
 * Commands completing within this window skip progress display entirely,
 * avoiding UI flicker for short commands.
 */
export { SHELL_PROGRESS_THRESHOLD_MS } from './shell-result.js';
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = new Set(['sleep']);

function formatOutputInfo(pid: number | undefined): string {
  if (!pid) return '';
  const outputPath = ShellExecutionService.getOutputFilePath(pid);
  return outputPath ? ` Output is being written to: ${outputPath}` : '';
}

function formatBackgroundMessage(
  taskId: string,
  reason: BackgroundReason | undefined,
  outputInfo = '',
): string {
  switch (reason) {
    case 'user':
      return `Command was manually moved to background by the user (ID: ${taskId}).${outputInfo} Use /tasks to view.`;
    case 'model':
      return `Command running in background with ID: ${taskId}.${outputInfo} You will be notified when it completes.${outputInfo ? ' To check interim output, use Read on that file path.' : ''}`;
    case 'timeout':
      return `Command exceeded its timeout and was moved to background (ID: ${taskId}).${outputInfo} Use /tasks to view.`;
    case 'auto':
      return `Command was automatically moved to background (ID: ${taskId}).${outputInfo} Use /tasks to view.`;
    default:
      return `Command moved to background (ID: ${taskId}).${outputInfo} Use /tasks to view.`;
  }
}

function extractLiveOutputMetrics(
  output: ToolLiveOutput,
): { totalLines?: number; totalBytes: number } | Record<string, never> {
  return isShellLiveOutput(output)
    ? { totalLines: output.totalLines, totalBytes: output.totalBytes }
    : {};
}

function shouldAutoBackgroundOnTimeout(command: string): boolean {
  const rootCommand = getCommandRoots(command, 'bash')[0];
  if (!rootCommand) {
    return true;
  }
  return !DISALLOWED_AUTO_BACKGROUND_COMMANDS.has(rootCommand);
}

function workingDirectoryError(requestedPath: string): ToolResult {
  const message = `Working directory does not exist or is not a directory: ${requestedPath}`;
  return {
    llmContent: message,
    returnDisplay: message,
    error: {
      message,
      type: ToolErrorType.EXECUTION_FAILED,
    },
  };
}

// ============================================================================

export interface ShellToolParams {
  command: string;
  description?: string;
  dir_path?: string;
  run_in_background?: boolean;
  timeout?: number;
  pty?: boolean;
  cols?: number;
  rows?: number;
  wait_ms?: number;
  idle_ms?: number;
}

export class ShellToolInvocation extends BaseToolInvocation<
  ShellToolParams,
  ToolResult
> {
  constructor(
    private readonly context: AgentLoopContext,
    params: ShellToolParams,
    _toolName?: string,
    _toolDisplayName?: string,
    private readonly prepareEnvironment?: PrepareShellEnvironment,
  ) {
    super(params, _toolName, _toolDisplayName);
  }

  private getContextualDetails(): string {
    let details = '';
    // append optional [in directory]
    // note explanation is needed even if validation fails due to absolute path
    if (this.params.dir_path) {
      details += `[in ${this.params.dir_path}]`;
    } else {
      details += `[current working directory ${runWithShellSession(this.context.config, getCwd)}]`;
    }
    // append optional (description), replacing any line breaks with spaces
    if (this.params.description) {
      details += ` (${this.params.description.replace(/\n/g, ' ')})`;
    }
    if (this.params.run_in_background) {
      details += ' [background]';
    }
    if (this.params.pty) {
      details += ' [pty]';
    }
    return details;
  }

  getDescription(): string {
    return this.params.description?.trim()
      ? this.params.description
      : this.params.command;
  }

  override getDisplayTitle(): string {
    return this.params.command;
  }

  override getExplanation(): string {
    return this.getContextualDetails().trim();
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
    options?: ExecuteOptions,
  ): Promise<ToolResult> {
    return runWithShellSession(this.context.config, () =>
      this._executeInternal(signal, updateOutput, options),
    );
  }

  override executeWithContext(ctx: ToolUseContext): Promise<ToolResult> {
    if (
      ctx.resultConsumption === 'programmatic' &&
      (this.params.pty || this.params.run_in_background)
    ) {
      const message =
        'CodeMode Bash supports foreground commands only; pty and run_in_background are unavailable.';
      return Promise.resolve({
        llmContent: message,
        returnDisplay: message,
        error: { type: ToolErrorType.EXECUTION_FAILED, message },
      });
    }
    return runWithShellSession(this.context.config, () =>
      this._executeInternal(
        ctx.signal,
        ctx.updateOutput,
        ctx.options,
        ctx.internalExecutionOwner,
        ctx,
      ),
    );
  }

  private async _executeInternal(
    signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
    options?: ExecuteOptions,
    internalExecutionOwner?: ToolUseContext['internalExecutionOwner'],
    toolUseContext?: ToolUseContext,
  ): Promise<ToolResult> {
    if (signal.aborted) {
      return this._executeInDirectory(
        getCwd(),
        signal,
        updateOutput,
        options,
        internalExecutionOwner,
        toolUseContext,
      );
    }
    const requestedCwd = this.params.dir_path
      ? path.resolve(this.context.config.getTargetDir(), this.params.dir_path)
      : getCwd();
    let resolved: ReturnType<typeof resolveShellCwd>;
    try {
      resolved = resolveShellCwd(
        requestedCwd,
        this.params.dir_path === undefined &&
          !options?.shellExecutionConfig?.preventCwdChanges
          ? getOriginalCwd()
          : undefined,
      );
    } catch {
      return workingDirectoryError(requestedCwd);
    }
    if (resolved.recoveredFrom) setCwdAndNotify(resolved.cwd);
    const result = await this._executeInDirectory(
      resolved.cwd,
      signal,
      updateOutput,
      options,
      internalExecutionOwner,
      toolUseContext,
    );
    if (!resolved.recoveredFrom) return result;
    const notice = `Shell cwd was recovered from ${resolved.recoveredFrom} to ${resolved.cwd}.`;
    return {
      ...result,
      llmContent:
        typeof result.llmContent === 'string'
          ? `${notice}\n${result.llmContent}`
          : [
              { text: notice },
              ...(Array.isArray(result.llmContent)
                ? result.llmContent
                : [result.llmContent]),
            ],
      returnDisplay:
        typeof result.returnDisplay === 'string'
          ? `${notice}\n${result.returnDisplay}`
          : result.returnDisplay,
    };
  }

  private async _executeInDirectory(
    cwd: string,
    signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
    options?: ExecuteOptions,
    internalExecutionOwner?: ToolUseContext['internalExecutionOwner'],
    toolUseContext?: ToolUseContext,
  ): Promise<ToolResult> {
    const { shellExecutionConfig, setExecutionIdCallback } = options ?? {};
    const strippedCommand = stripShellWrapper(this.params.command);
    const suppressBackground =
      toolUseContext?.resultConsumption === 'programmatic' ||
      (internalExecutionOwner?.kind === 'workflow-agent' &&
        internalExecutionOwner.disableShellAutoBackground);
    const requestedBackground =
      this.params.run_in_background === true && !suppressBackground;
    const taskId = createLocalBashTaskId();
    const callContext = getToolCallContext();

    runLogger.debug(
      `[ShellTool] _executeInternal: command=${truncateString(strippedCommand, 120, '...')}, ` +
        `run_in_background=${requestedBackground}`,
    );

    if (signal.aborted) {
      const data: ShellToolExecutionData = {
        kind: 'cancelled',
        processStarted: false,
        stdout: '',
        stderr: '',
        timedOut: false,
      };
      return {
        llmContent: 'Command was cancelled by user before it could start.',
        returnDisplay: 'Command cancelled by user.',
        data,
        toolUseResult: data,
      };
    }

    const sessionId =
      getSessionIdFromContext() ??
      toolUseContext?.sessionId ??
      this.context.config?.getSessionId?.() ??
      'default';
    const contextualShellExecutionConfig: ShellExecutionConfig = {
      ...shellExecutionConfig,
      pager: shellExecutionConfig?.pager ?? 'cat',
      sanitizationConfig:
        shellExecutionConfig?.sanitizationConfig ??
        this.context.config.sanitizationConfig,
      // 调度器之外的调用路径不会带 shellExecutionConfig，兜底用本工具自己的
      // Config，保证插件 bin 目录始终按当前会话解析。
      sessionContext:
        shellExecutionConfig?.sessionContext ?? this.context.config,
    };
    const effectiveShellExecutionConfig: ShellExecutionConfig = {
      ...contextualShellExecutionConfig,
      // Tool preparation replaces the session default; do not run both.
      environmentPreparation: await this.prepareEnvironment?.(
        { ...contextualShellExecutionConfig, sessionId },
        { command: strippedCommand, pty: this.params.pty, context: toolUseContext },
      ) ?? contextualShellExecutionConfig.environmentPreparation,
    };

    if (this.params.pty) {
      if (!isBashPtyToolsEnabled()) {
        const message = `Bash PTY tools are disabled. Set ${ENV_ENABLE_BASH_PTY_TOOLS}=1 to enable pty=true, BashInput, BashOutput, and BashResize.`;
        return {
          llmContent: message,
          returnDisplay: message,
          error: {
            message,
            type: ToolErrorType.EXECUTION_FAILED,
          },
        };
      }

      return executeBashPtyCommand(
        this.context,
        {
          command: strippedCommand,
          dir_path: this.params.dir_path,
          cols: this.params.cols,
          rows: this.params.rows,
          wait_ms: this.params.wait_ms,
          idle_ms: this.params.idle_ms,
        },
        signal,
        { ...options, shellExecutionConfig: effectiveShellExecutionConfig },
        internalExecutionOwner,
      );
    }

    // Absolute timeout: from model's timeout param, clamped to [0, maxTimeoutMs]
    const absoluteTimeoutMs = Math.min(
      Math.max(this.params.timeout ?? defaultTimeoutMs, 0),
      maxTimeoutMs,
    );

    const commandToExecute = strippedCommand;

    let cumulativeOutput = '';
    let progressEnabled = false;
    let latestLiveOutput: ToolLiveOutput = '';

    // A `!command` user-shell run is not a model tool call: no read tracking.
    const fileStateCache =
      toolUseContext?.invocationOrigin === 'user-shell'
        ? undefined
        : (toolUseContext?.fileReadState ?? this.context.fileReadState);
    const watchedFiles =
      fileStateCache &&
      !requestedBackground &&
      this.context.config.isInteractive() &&
      !this.context.config.getAcpMode()
        ? await snapshotShellFileState(strippedCommand, fileStateCache, {
            cwd,
            signal,
          })
        : [];
    const { result: resultPromise, pid } = await ShellExecutionService.execute(
      commandToExecute,
      cwd,
      (event: ShellOutputEvent) => {
        switch (event.type) {
          case 'data':
            cumulativeOutput = event.chunk;
            latestLiveOutput =
              event.totalLines != null || event.totalBytes != null
                ? {
                    isShellLiveOutput: true,
                    output: cumulativeOutput,
                    totalLines: event.totalLines,
                    totalBytes: event.totalBytes ?? 0,
                  }
                : cumulativeOutput;
            if (updateOutput && !requestedBackground && progressEnabled) {
              updateOutput(latestLiveOutput);
            }
            break;
          case 'exit':
            break;
          default: {
            throw new Error('An unhandled ShellOutputEvent was found.');
          }
        }
      },
      signal,
      {
        ...effectiveShellExecutionConfig,
        // Invocation-local/background/subagent commands never advance the
        // main session CWD.
        preventCwdChanges:
          shellExecutionConfig?.preventCwdChanges === true ||
          requestedBackground ||
          this.params.dir_path !== undefined,
        absoluteTimeout: absoluteTimeoutMs,
        autoBackgroundOnTimeout:
          !requestedBackground &&
          !suppressBackground &&
          shouldAutoBackgroundOnTimeout(strippedCommand),
        startInBackground: requestedBackground
          ? { reason: 'model' }
          : undefined,
        sessionId,
        pager: 'cat',
        sanitizationConfig: effectiveShellExecutionConfig.sanitizationConfig,
        originalCommand: strippedCommand,
        completionBehavior: suppressBackground
          ? 'silent'
          : shellExecutionConfig?.completionBehavior,
        taskId,
        taskKind: 'bash',
        taskDescription: this.params.description,
        ownerAgentId: toolUseContext?.agentId,
        toolUseId: toolUseContext?.callId ?? callContext?.callId,
        customContext: snapshotCustomContext(
          toolUseContext?.customContext ?? getCustomContextFromContext(),
        ),
      },
    );
    if (pid) {
      if (setExecutionIdCallback) {
        setExecutionIdCallback(pid);
      }

      if (requestedBackground) {
        const outputInfo = formatOutputInfo(pid);
        const toolUseResult: ShellToolExecutionData = {
          kind: 'backgrounded',
          taskId,
          outputFile: ShellExecutionService.getOutputFilePath(pid),
          command: this.params.command,
          stdout: `Background process started with ID ${taskId}.`,
          initialOutput: cumulativeOutput,
          pid,
          backgroundReason: 'model' as const,
          ...extractLiveOutputMetrics(latestLiveOutput),
        };
        return {
          llmContent: `${formatBackgroundMessage(taskId, 'model', outputInfo)}${cumulativeOutput ? ` Initial output:\n${cumulativeOutput}` : ''}`,
          returnDisplay: `Background process started with ID ${taskId}.`,
          data: toolUseResult,
          toolUseResult,
        };
      }
    }

    if (!requestedBackground) {
      let thresholdTimer: ReturnType<typeof setTimeout> | undefined;
      const earlyResult = await Promise.race([
        resultPromise,
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
          updateOutput(latestLiveOutput);
        }
      }
    }

    const result = await resultPromise;
    // Lifecycle-generated background results carry the execution ID in
    // result.pid. Fall back to the ID returned by the execution handle so a
    // structurally valid but partially populated result cannot leak an
    // undefined PID into ShellToolExecutionData.
    const backgroundPid = result.pid ?? pid;

    runLogger.debug(
      `[ShellTool] result: exitCode=${result.exitCode}, signal=${result.signal ?? 'none'}, ` +
        `aborted=${result.aborted}, backgrounded=${result.backgrounded ?? false}, ` +
        `outputLen=${result.output?.length ?? 0}`,
    );

    // Promote large foreground output into the session-managed tool-output
    // directory. A persistence failure must not turn a completed command
    // into a failed command.
    let persistedOutput: PersistedShellOutput | undefined;
    if (
      !result.backgrounded &&
      result.outputFilePath &&
      result.outputFileSize
    ) {
      try {
        const projectTempDir = this.context.config?.storage.getProjectTempDir();
        if (projectTempDir) {
          persistedOutput = await persistShellOutput({
            sourcePath: result.outputFilePath,
            output: result.output,
            originalSizeBytes: result.outputFileSize,
            projectTempDir,
            sessionId,
          });
          runLogger.debug(
            `[ShellTool] persisted large output (${result.outputFileSize} bytes) to ${persistedOutput.path}`,
          );
        }
      } catch (err) {
        runLogger.warn(
          `[ShellTool] failed to persist large output file: ${getErrorMessage(err)}`,
        );
      }
    }

    // A timeout may terminate via a signal without setting the explicit-abort
    // flag. Keep that outcome distinct from a command that exited normally.
    const terminatedByLimit =
      result.timedOut === true || result.outputLimitExceeded === true;
    const cancelled = result.aborted || terminatedByLimit;
    let data: ShellToolExecutionData;

    let llmContent = '';
    let terminationReason = '';
    // Set when a foreground command escaped the workspace and we reset the
    // shell CWD back to the project. Surfaced in stderr and returnDisplay so
    // the model and the user both know the next command will start from the
    // project root again.
    let cwdResetMessage = '';
    if (cancelled) {
      terminationReason = formatShellTerminationReason({
        timedOut: result.timedOut,
        timeoutMs: absoluteTimeoutMs,
        outputLimitExceeded: result.outputLimitExceeded,
      });
      if (result.timedOut) {
        runLogger.warn(
          `[ShellTool] command timed out after ${absoluteTimeoutMs}ms`,
        );
      }
      llmContent =
        terminationReason ||
        'Command was cancelled by user before it could complete.';
      data = {
        kind: 'cancelled',
        stdout: result.output ?? '',
        stderr: result.error?.message ?? '',
        timedOut: result.timedOut ?? false,
        ...(result.timedOut ? { timeoutMs: absoluteTimeoutMs } : {}),
        outputLimitExceeded: result.outputLimitExceeded,
        ...(terminatedByLimit ? { isError: true as const } : {}),
        persistedOutput,
        ...extractLiveOutputMetrics(latestLiveOutput),
      };
      const cancelledBody = shellOutputBody(data).trim();
      llmContent += cancelledBody
        ? ` Below is the output before it was cancelled:\n${cancelledBody}`
        : ' There was no output before it was cancelled.';
    } else if (result.backgrounded && backgroundPid !== undefined) {
      const outputInfo = formatOutputInfo(backgroundPid);
      llmContent = formatBackgroundMessage(
        taskId,
        result.backgroundReason,
        outputInfo,
      );
      data = {
        kind: 'backgrounded',
        pid: backgroundPid,
        taskId,
        outputFile: ShellExecutionService.getOutputFilePath(backgroundPid),
        command: this.params.command,
        stdout: formatBackgroundMessage(taskId, result.backgroundReason),
        initialOutput: result.output,
        backgroundReason: result.backgroundReason,
        ...extractLiveOutputMetrics(latestLiveOutput),
      };
    } else {
      const finalError = result.error
        ? result.error.message.replaceAll(commandToExecute, this.params.command)
        : '';

      const exitStatus = interpretShellExitStatus(
        this.params.command,
        result.exitCode,
        result.signal,
      );

      data = {
        kind: 'completed',
        stdout: result.output ?? '',
        stderr: finalError,
        exitCode: result.exitCode,
        signal: result.signal,
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
        ...exitStatus,
        ...(finalError ? { errorMessage: finalError } : {}),
        persistedOutput,
        ...extractLiveOutputMetrics(latestLiveOutput),
      };
    }

    data['processStarted'] = pid !== undefined;

    // Reset CWD if a foreground (non-subagent) command escaped the
    // workspace, so subsequent commands don't keep operating outside it.
    // Subagents pass `preventCwdChanges: true` and have their own ALS
    // overlay — skip the reset for them. Backgrounded commands are still
    // running so we leave their CWD alone.
    if (
      !shellExecutionConfig?.preventCwdChanges &&
      this.params.dir_path === undefined &&
      !requestedBackground &&
      !result.backgrounded &&
      resetCwdIfOutsideWorkspace(this.context.config.getWorkspaceContext())
    ) {
      cwdResetMessage = stdErrAppendShellResetMessage('');
      // Fold reset notice into the model-facing stderr when data was built
      if (data.kind !== 'backgrounded') {
        data.stderr = `${data.stderr}${cwdResetMessage}`;
      }
    }

    // Narrow once: the completed payload is the only kind that carries a
    // process status, and three later steps need it.
    const completed = data.kind === 'completed' ? data : undefined;
    if (completed) {
      llmContent = formatCompletedShellModelContent(completed);
    }

    let returnDisplay = '';
    if (this.context.config.getDebugMode()) {
      returnDisplay = llmContent;
    } else {
      if (result.backgrounded) {
        returnDisplay = formatBackgroundMessage(
          taskId,
          result.backgroundReason,
        );
      } else if (cancelled) {
        const cancelMsg = terminationReason || 'Command cancelled by user.';
        if (persistedOutput || result.output.trim()) {
          returnDisplay = `${cancelMsg}\n\nOutput before cancellation:\n${formatShellExecutionOutput(data)}`;
        } else {
          returnDisplay = cancelMsg;
        }
      } else if (persistedOutput) {
        returnDisplay = formatShellExecutionOutput(data);
      } else if (result.output.trim()) {
        returnDisplay = result.output;
      } else {
        if (result.signal) {
          returnDisplay = `Command terminated by signal: ${result.signal}`;
        } else if (result.error) {
          returnDisplay = `Command failed: ${getErrorMessage(result.error)}`;
        } else if (result.exitCode !== null && result.exitCode !== 0) {
          returnDisplay = `Command exited with code: ${result.exitCode}`;
        }
        // If output is empty and command succeeded (code 0, no error/signal/abort),
        // returnDisplay will remain empty, which is fine.
      }
    }

    // Append the CWD-reset notice so the user/model sees it in tool output
    if (cwdResetMessage) {
      returnDisplay = returnDisplay
        ? `${returnDisplay}${cwdResetMessage}`
        : cwdResetMessage.trimStart();
    }

    let recordedFile: string | undefined;
    if (
      completed &&
      completed.exitCode === 0 &&
      !completed.signal &&
      !signal.aborted &&
      fileStateCache
    ) {
      recordedFile = await recordShellFileReads(
        this.params.command,
        cwd,
        fileStateCache,
        completed.exitCode,
        signal,
        Boolean(
          completed.persistedOutput ||
            (toolUseContext?.resultConsumption !== 'programmatic' &&
              this.context.config.getSummarizeToolOutputConfig()?.[
                SHELL_TOOL_NAME
              ]),
        ),
      );
    }

    const summarizeConfig = this.context.config.getSummarizeToolOutputConfig();
    const executionError = result.error
      ? {
          error: {
            message: result.error.message,
            type: ToolErrorType.SHELL_EXECUTE_ERROR,
          },
        }
      : {};
    if (
      toolUseContext?.invocationOrigin !== 'user-shell' &&
      toolUseContext?.resultConsumption !== 'programmatic' &&
      summarizeConfig &&
      summarizeConfig[SHELL_TOOL_NAME]
    ) {
      const summary = await summarizeToolOutput(
        this.context.config,
        llmContent,
        signal,
      );
      // Summarization is lossy, so restore the deterministic process status.
      llmContent = completed
        ? prependCompletedShellFailureStatus(summary, completed)
        : summary;
      if (terminationReason && !llmContent.startsWith(terminationReason)) {
        llmContent = `${terminationReason}\n${llmContent}`;
      }
    }

    if (completed && fileStateCache && !signal.aborted) {
      const hint = await shellChangedFilesHint(
        watchedFiles,
        fileStateCache,
        this.context.config,
        {
          ...toolUseContext,
          signal,
          agentLoopContext: toolUseContext?.agentLoopContext ?? this.context,
        },
      );
      if (hint) {
        // Append after summarization so a lossy summary cannot hide the notice.
        completed.staleReadFileStateHint = hint;
        llmContent = `${llmContent}\n${hint}`;
      }
    }

    const toolResult = {
      llmContent,
      returnDisplay,
      data,
      toolUseResult: data,
      ...(data.isError === true ? { isError: true as const } : {}),
      ...executionError,
    };
    return recordedFile && fileStateCache
      ? trackFileStateResult(toolResult, fileStateCache, recordedFile)
      : toolResult;
  }
}

/** Register only literal read commands whose output has finished. */
export async function recordShellFileReads(
  command: string,
  cwd: string,
  cache: FileStateCache,
  exitCode: number | null,
  signal: AbortSignal,
  outputHidden = false,
): Promise<string | undefined> {
  if (signal.aborted || /[|<>`$\n]/.test(command)) return;
  await initializeShellParsers();
  const segments = getBashClampCommandSegments(command);
  if (!segments || segments.length !== 1) return;
  const entries = parseShell(command);
  if (!entries.every((entry): entry is string => typeof entry === 'string'))
    return;
  const [name, ...args] = entries;
  let file: string | undefined;
  let offset: number | undefined;
  let limit: number | undefined;
  let tail = false;
  let search = false;
  const plainFlags: Record<string, string[]> = {
    cat: ['-n', '--number'],
    nl: [],
    bat: ['-n', '--number', '-p', '--plain'],
    batcat: ['-n', '--number', '-p', '--plain'],
  };
  if (name in plainFlags) {
    for (const arg of args) {
      if (plainFlags[name].includes(arg)) continue;
      if (arg.startsWith('-') || file) return;
      file = arg;
    }
  } else if (name === 'sed') {
    if (args.length !== 3 || !['-n', '--quiet', '--silent'].includes(args[0]))
      return;
    const range = /^(\d+)(?:,(\d+))?p$/.exec(args[1]);
    if (!range) return;
    offset = Number(range[1]);
    limit = Number(range[2] ?? range[1]) - offset + 1;
    file = args[2];
  } else if (name === 'head' || name === 'tail') {
    limit = 10;
    tail = name === 'tail';
    offset = 1;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-n' || arg === '--lines') {
        if (!/^\d+$/.test(args[i + 1] ?? '')) return;
        limit = Number(args[++i]);
      } else if (/^(?:-n?\d+|--lines=\d+)$/.test(arg))
        limit = Number(arg.replace(/^(?:--lines=|-n?)/, ''));
      else {
        if (arg.startsWith('-') || file) return;
        file = arg;
      }
    }
  } else if (['rg', 'grep', 'egrep', 'fgrep'].includes(name)) {
    search = true;
    if (exitCode !== 0) return;
    let pattern: string | undefined;
    const flags = name === 'rg' ? /^-[iSswxFnNHUP]+$/ : /^-[niwxEFGPHh]+$/;
    const long = new Set([
      '--line-number',
      '--no-line-number',
      '--ignore-case',
      '--smart-case',
      '--case-sensitive',
      '--word-regexp',
      '--line-regexp',
      '--fixed-strings',
      '--with-filename',
      '--no-filename',
      '--multiline',
      '--pcre2',
      '--extended-regexp',
      '--basic-regexp',
      '--perl-regexp',
      '--color=never',
      '--color=auto',
    ]);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (
        [
          '-A',
          '-B',
          '-C',
          '--after-context',
          '--before-context',
          '--context',
        ].includes(arg)
      ) {
        if (!/^\d+$/.test(args[++i] ?? '')) return;
        continue;
      }
      if (
        /^-[ABC]\d+$/.test(arg) ||
        /^--(?:after-context|before-context|context)=\d+$/.test(arg) ||
        flags.test(arg) ||
        long.has(arg)
      )
        continue;
      if (arg.startsWith('-')) return;
      if (pattern === undefined) pattern = arg;
      else if (!file) file = arg;
      else return;
    }
  } else return;
  if (
    !file ||
    file === '-' ||
    /[*?[{]/.test(file) ||
    (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) ||
    (offset !== undefined && offset < 1)
  )
    return;
  const filePath = path.resolve(cwd, file);
  if (cache.has(filePath)) return;
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024 || signal.aborted)
      return;
    let content = normalizeFileStateContent(
      await fs.promises.readFile(filePath, 'utf8'),
    );
    if (limit !== undefined) {
      const lines = content.split('\n');
      if (tail) {
        if (lines.at(-1) === '') lines.pop();
        if (!lines.length) return;
        limit = Math.min(limit, lines.length);
        offset = lines.length - limit + 1;
      }
      if ((offset ?? 1) > lines.length) return;
      content = lines
        .slice((offset ?? 1) - 1, (offset ?? 1) - 1 + limit)
        .join('\n');
    }
    if (signal.aborted || cache.has(filePath)) return;
    cache.set(filePath, {
      content,
      timestamp: Math.floor(stat.mtimeMs),
      offset,
      limit,
      contentNotInModelContext: search || outputHidden,
    });
    return filePath;
  } catch {
    /* Shell success is independent of optional baseline registration. */
  }
  return undefined;
}

export class ShellTool extends BaseDeclarativeTool<
  ShellToolParams,
  ToolResult
> {
  static readonly Name = SHELL_TOOL_NAME;
  override readonly configurationName = 'ShellTool';

  override get programmatic() {
    return shellContract;
  }

  override get maxResultSizeChars(): number {
    return SHELL_INLINE_OUTPUT_MAX_BYTES;
  }

  constructor(protected readonly context?: AgentLoopContext) {
    void initializeShellParsers().catch(() => {
      // Errors are surfaced when parsing commands.
    });
    const declaration = getShellDeclaration(isBashPtyToolsEnabled());
    super(
      ShellTool.Name,
      ShellTool.Name,
      declaration.description!,
      Kind.Execute,
      declaration.parametersJsonSchema,
      false, // output is not markdown
      true, // output can be updated
    );
  }

  get isBoundToConfig(): boolean {
    return this.context !== undefined;
  }

  bindToConfig(config: Config): ShellTool {
    return new ShellTool(config);
  }

  override build(
    params: ShellToolParams,
    context?: ToolUseContext,
  ): ToolInvocation<ShellToolParams, ToolResult> {
    if (context?.config && this.context?.config !== context.config) {
      return this.bindToConfig(context.config).build(params, context);
    }
    return super.build(params, context);
  }

  /** Overridden by product tools; also supplies defaults for non-tool spawns. */
  async prepareEnvironment(
    _config: ShellSpawnPreparationConfig,
    _invocation?: ShellEnvironmentInvocation,
  ): Promise<ShellEnvironmentPreparation | undefined> {
    return undefined;
  }

  override isConcurrencySafe(input?: ShellToolParams): boolean {
    try {
      if (
        !this.context?.config.isParallelReadOnlyShellEnabled() ||
        !input?.command ||
        input.pty
      ) {
        return false;
      }
      return checkReadOnlyShellCommand(input.command, undefined, {
        cwd: input.dir_path
          ? path.resolve(this.context.config.getTargetDir(), input.dir_path)
          : getCwd(),
      }).readonly;
    } catch {
      return false;
    }
  }

  override isDestructive(_input?: ShellToolParams): boolean {
    return true;
  }

  override interruptBehavior(): InterruptBehavior {
    return 'background';
  }

  protected override validateToolParamValues(
    params: ShellToolParams,
  ): string | null {
    if (!params.command.trim()) {
      return 'Command cannot be empty.';
    }

    return null;
  }

  protected createInvocation(
    params: ShellToolParams,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<ShellToolParams, ToolResult> {
    if (!this.context) {
      throw new Error('ShellTool requires a tool context with a session config');
    }
    return new ShellToolInvocation(
      this.context,
      params,
      _toolName,
      _toolDisplayName,
      this.prepareEnvironment.bind(this),
    );
  }

  override getSchema(modelId?: string) {
    return getShellDeclaration(
      isBashPtyToolsEnabled(),
      resolvePromptBundleForModel(modelId),
    );
  }

  // === Permission Pipeline methods ===

  override toClassifierInput(input: ShellToolParams): unknown {
    return input.command;
  }
}
