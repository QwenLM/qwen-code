/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Config } from '../config/config.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';
import type {
  ToolInvocation,
  ToolResult,
  ToolResultDisplay,
  ToolCallConfirmationDetails,
  ToolExecuteConfirmationDetails,
  ToolConfirmationPayload,
  ToolConfirmationOutcome,
} from './tools.js';
import type { PermissionDecision } from '../permissions/types.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { getErrorMessage } from '../utils/errors.js';
import { truncateToolOutput } from '../utils/truncation.js';
import type {
  ShellExecutionConfig,
  ShellOutputEvent,
} from '../services/shellExecutionService.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import type { BackgroundShellEntry } from '../services/backgroundShellRegistry.js';
import stripAnsi from 'strip-ansi';
import { formatMemoryUsage } from '../utils/formatters.js';
import type { AnsiOutput } from '../utils/terminalSerializer.js';
import { isSubpaths } from '../utils/paths.js';
import {
  getCommandRoot,
  getCommandRoots,
  splitCommands,
  stripShellWrapper,
} from '../utils/shell-utils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  isShellCommandReadOnlyAST,
  extractCommandRules,
} from '../utils/shellAstParser.js';

const debugLogger = createDebugLogger('SHELL');

export const OUTPUT_UPDATE_INTERVAL_MS = 1000;
const DEFAULT_FOREGROUND_TIMEOUT_MS = 120000;

function trimTrailingShellComment(command: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let escapeNext = false;
  let commandSubstitutionDepth = 0;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (inSingleQuote) {
      if (ch === "'") inSingleQuote = false;
      continue;
    }

    if (inBacktick) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        escapeNext = true;
        continue;
      }
      if (ch === '`') inBacktick = false;
      continue;
    }

    if (inDoubleQuote) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        escapeNext = true;
        continue;
      }
      if (ch === '"') {
        inDoubleQuote = false;
        continue;
      }
      if (ch === '$' && command[i + 1] === '(') {
        commandSubstitutionDepth++;
        i++;
        continue;
      }
      if (ch === ')' && commandSubstitutionDepth > 0) {
        commandSubstitutionDepth--;
      }
      continue;
    }

    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\') {
      escapeNext = true;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (ch === '$' && command[i + 1] === '(') {
      commandSubstitutionDepth++;
      i++;
      continue;
    }
    if (ch === ')' && commandSubstitutionDepth > 0) {
      commandSubstitutionDepth--;
      continue;
    }
    if (
      ch === '#' &&
      commandSubstitutionDepth === 0 &&
      (i === 0 || /\s/.test(command[i - 1]!))
    ) {
      return command.slice(0, i);
    }
  }

  return command;
}

function hasTopLevelTrailingBackgroundOperator(command: string): boolean {
  const commentTrimmed = trimTrailingShellComment(command);
  const trimmed = commentTrimmed.trimEnd();
  if (!trimmed.endsWith('&')) return false;

  const trailingAmpIndex = trimmed.length - 1;
  const previousNonWhitespaceIndex = (() => {
    for (let i = trailingAmpIndex - 1; i >= 0; i--) {
      if (!/\s/.test(trimmed[i]!)) return i;
    }
    return -1;
  })();

  if (previousNonWhitespaceIndex >= 0) {
    const previous = trimmed[previousNonWhitespaceIndex]!;
    if (previous === '&' || previous === '|' || previous === '\\') {
      return false;
    }
  }

  let backslashCount = 0;
  for (let i = trailingAmpIndex - 1; i >= 0 && trimmed[i] === '\\'; i--) {
    backslashCount++;
  }
  if (backslashCount % 2 === 1) return false;

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let escapeNext = false;
  let commandSubstitutionDepth = 0;

  for (let i = 0; i <= trailingAmpIndex; i++) {
    const ch = trimmed[i]!;

    if (inSingleQuote) {
      if (ch === "'") inSingleQuote = false;
      continue;
    }

    if (inBacktick) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        escapeNext = true;
        continue;
      }
      if (ch === '`') inBacktick = false;
      continue;
    }

    if (inDoubleQuote) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        escapeNext = true;
        continue;
      }
      if (ch === '"') {
        inDoubleQuote = false;
        continue;
      }
      if (ch === '$' && trimmed[i + 1] === '(') {
        commandSubstitutionDepth++;
        i++;
        continue;
      }
      if (ch === ')' && commandSubstitutionDepth > 0) {
        commandSubstitutionDepth--;
      }
      continue;
    }

    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\') {
      escapeNext = true;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (ch === '$' && trimmed[i + 1] === '(') {
      commandSubstitutionDepth++;
      i++;
      continue;
    }
    if (ch === ')' && commandSubstitutionDepth > 0) {
      commandSubstitutionDepth--;
      continue;
    }
    if (i === trailingAmpIndex) {
      return commandSubstitutionDepth === 0;
    }
  }

  return false;
}

export interface ShellToolParams {
  command: string;
  is_background: boolean;
  timeout?: number;
  description?: string;
  directory?: string;
}

export class ShellToolInvocation extends BaseToolInvocation<
  ShellToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: ShellToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    let description = `${this.params.command}`;
    // append optional [in directory]
    // note description is needed even if validation fails due to absolute path
    if (this.params.directory) {
      description += ` [in ${this.params.directory}]`;
    }
    // append background indicator
    if (this.params.is_background) {
      description += ` [background]`;
    } else if (this.params.timeout) {
      // append timeout for foreground commands
      description += ` [timeout: ${this.params.timeout}ms]`;
    }
    // append optional (description), replacing any line breaks with spaces
    if (this.params.description) {
      description += ` (${this.params.description.replace(/\n/g, ' ')})`;
    }
    return description;
  }

  /**
   * AST-based permission check for the shell command.
   * - Read-only commands (via AST analysis) → 'allow'
   * - All other commands → 'ask'
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    const command = stripShellWrapper(this.params.command);

    // AST-based read-only detection
    try {
      const isReadOnly = await isShellCommandReadOnlyAST(command);
      if (isReadOnly) {
        return 'allow';
      }
    } catch (e) {
      debugLogger.warn('AST read-only check failed, falling back to ask:', e);
    }

    return 'ask';
  }

  /**
   * Constructs confirmation dialog details for a shell command that needs
   * user approval.  For compound commands (e.g. `cd foo && npm run build`),
   * sub-commands that are already allowed (read-only) are excluded from both
   * the displayed root-command list and the suggested permission rules.
   */
  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    const command = stripShellWrapper(this.params.command);
    const pm = this.config.getPermissionManager?.();

    // Split compound command and filter out already-allowed (read-only) sub-commands
    const subCommands = splitCommands(command);
    const confirmableSubCommands: string[] = [];
    for (const sub of subCommands) {
      let isReadOnly = false;
      try {
        isReadOnly = await isShellCommandReadOnlyAST(sub);
      } catch {
        // conservative: treat unknown commands as requiring confirmation
      }

      if (isReadOnly) {
        continue;
      }

      if (pm) {
        try {
          if ((await pm.isCommandAllowed(sub)) === 'allow') {
            continue;
          }
        } catch (e) {
          debugLogger.warn('PermissionManager command check failed:', e);
        }
      }

      confirmableSubCommands.push(sub);
    }

    // Fallback to all sub-commands if everything was filtered out (shouldn't
    // normally happen since getDefaultPermission already returned 'ask').
    const effectiveSubCommands =
      confirmableSubCommands.length > 0 ? confirmableSubCommands : subCommands;

    const rootCommands = [
      ...new Set(
        effectiveSubCommands
          .map((c) => getCommandRoot(c))
          .filter((c): c is string => !!c),
      ),
    ];

    // Extract minimum-scope permission rules only for sub-commands that
    // actually need confirmation.
    let permissionRules: string[] = [];
    try {
      const allRules: string[] = [];
      for (const sub of effectiveSubCommands) {
        const rules = await extractCommandRules(sub);
        allRules.push(...rules);
      }
      permissionRules = [...new Set(allRules)].map((rule) => `Bash(${rule})`);
    } catch (e) {
      debugLogger.warn('Failed to extract command rules:', e);
    }

    const confirmationDetails: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Shell Command',
      command: this.params.command,
      rootCommand: rootCommands.join(', '),
      permissionRules,
      onConfirm: async (
        _outcome: ToolConfirmationOutcome,
        _payload?: ToolConfirmationPayload,
      ) => {
        // No-op: persistence is handled by coreToolScheduler via PM rules
      },
    };
    return confirmationDetails;
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
    shellExecutionConfig?: ShellExecutionConfig,
    setPidCallback?: (pid: number) => void,
  ): Promise<ToolResult> {
    const strippedCommand = stripShellWrapper(this.params.command);

    if (signal.aborted) {
      return {
        llmContent: 'Command was cancelled by user before it could start.',
        returnDisplay: 'Command cancelled by user.',
      };
    }

    if (this.params.is_background) {
      return this.executeBackground(signal, shellExecutionConfig);
    }

    const effectiveTimeout =
      this.params.timeout ?? DEFAULT_FOREGROUND_TIMEOUT_MS;

    // Create combined signal with timeout for foreground execution
    let combinedSignal = signal;
    if (effectiveTimeout) {
      const timeoutSignal = AbortSignal.timeout(effectiveTimeout);
      combinedSignal = AbortSignal.any([signal, timeoutSignal]);
    }

    // Add co-author to git commit commands
    const processedCommand = this.addCoAuthorToGitCommit(strippedCommand);
    const commandToExecute = processedCommand;
    const cwd = this.params.directory || this.config.getTargetDir();

    let cumulativeOutput: string | AnsiOutput = '';
    let lastUpdateTime = Date.now();
    let isBinaryStream = false;
    let totalLines = 0;
    let totalBytes = 0;

    const { result: resultPromise, pid } = await ShellExecutionService.execute(
      commandToExecute,
      cwd,
      (event: ShellOutputEvent) => {
        let shouldUpdate = false;

        switch (event.type) {
          case 'data':
            if (isBinaryStream) break;
            cumulativeOutput = event.chunk;
            // Stats are only consumed by the ANSI-output branch below,
            // so skip the per-chunk accounting for plain string chunks.
            if (Array.isArray(event.chunk)) {
              totalLines = event.chunk.length;
              totalBytes = event.chunk.reduce(
                (sum, line) =>
                  sum +
                  line.reduce(
                    (ls, token) => ls + Buffer.byteLength(token.text, 'utf-8'),
                    0,
                  ),
                0,
              );
            }
            shouldUpdate = true;
            break;
          case 'binary_detected':
            isBinaryStream = true;
            cumulativeOutput = '[Binary output detected. Halting stream...]';
            shouldUpdate = true;
            break;
          case 'binary_progress':
            isBinaryStream = true;
            cumulativeOutput = `[Receiving binary output... ${formatMemoryUsage(
              event.bytesReceived,
            )} received]`;
            if (Date.now() - lastUpdateTime > OUTPUT_UPDATE_INTERVAL_MS) {
              shouldUpdate = true;
            }
            break;
          default: {
            throw new Error('An unhandled ShellOutputEvent was found.');
          }
        }

        if (shouldUpdate && updateOutput) {
          if (typeof cumulativeOutput === 'string') {
            updateOutput(cumulativeOutput);
          } else {
            updateOutput({
              ansiOutput: cumulativeOutput,
              totalLines,
              totalBytes,
              // Only include timeout when user explicitly set it
              ...(this.params.timeout != null && {
                timeoutMs: this.params.timeout,
              }),
            });
          }
          lastUpdateTime = Date.now();
        }
      },
      combinedSignal,
      this.config.getShouldUseNodePtyShell(),
      shellExecutionConfig ?? {},
    );

    if (pid && setPidCallback) {
      setPidCallback(pid);
    }

    const result = await resultPromise;

    let llmContent = '';
    if (result.aborted) {
      // Check if it was a timeout or user cancellation
      const wasTimeout =
        effectiveTimeout && combinedSignal.aborted && !signal.aborted;

      if (wasTimeout) {
        llmContent = `Command timed out after ${effectiveTimeout}ms before it could complete.`;
        if (result.output.trim()) {
          llmContent += ` Below is the output before it timed out:\n${result.output}`;
        } else {
          llmContent += ' There was no output before it timed out.';
        }
      } else {
        llmContent = 'Command was cancelled by user before it could complete.';
        if (result.output.trim()) {
          llmContent += ` Below is the output before it was cancelled:\n${result.output}`;
        } else {
          llmContent += ' There was no output before it was cancelled.';
        }
      }
    } else {
      // Create a formatted error string for display, replacing the wrapper command
      // with the user-facing command.
      const finalError = result.error
        ? result.error.message.replace(commandToExecute, this.params.command)
        : '(none)';

      llmContent = [
        `Command: ${this.params.command}`,
        `Directory: ${this.params.directory || '(root)'}`,
        `Output: ${result.output || '(empty)'}`,
        `Error: ${finalError}`, // Use the cleaned error string.
        `Exit Code: ${result.exitCode ?? '(none)'}`,
        `Signal: ${result.signal ?? '(none)'}`,
        `Process Group PGID: ${result.pid ?? '(none)'}`,
      ].join('\n');
    }

    let returnDisplayMessage = '';
    if (this.config.getDebugMode()) {
      returnDisplayMessage = llmContent;
    } else {
      if (result.output.trim()) {
        returnDisplayMessage = result.output;
      } else {
        if (result.aborted) {
          // Check if it was a timeout or user cancellation
          const wasTimeout =
            effectiveTimeout && combinedSignal.aborted && !signal.aborted;

          returnDisplayMessage = wasTimeout
            ? `Command timed out after ${effectiveTimeout}ms.`
            : 'Command cancelled by user.';
        } else if (result.signal) {
          returnDisplayMessage = `Command terminated by signal: ${result.signal}`;
        } else if (result.error) {
          returnDisplayMessage = `Command failed: ${getErrorMessage(
            result.error,
          )}`;
        } else if (result.exitCode !== null && result.exitCode !== 0) {
          returnDisplayMessage = `Command exited with code: ${result.exitCode}`;
        }
        // If output is empty and command succeeded (code 0, no error/signal/abort),
        // returnDisplayMessage will remain empty, which is fine.
      }
    }

    // Truncate large output and save full content to a temp file.
    if (typeof llmContent === 'string') {
      const truncatedResult = await truncateToolOutput(
        this.config,
        ShellTool.Name,
        llmContent,
      );

      if (truncatedResult.outputFile) {
        llmContent = truncatedResult.content;
        returnDisplayMessage +=
          (returnDisplayMessage ? '\n' : '') +
          `Output too long and was saved to: ${truncatedResult.outputFile}`;
      }
    }

    const executionError = result.error
      ? {
          error: {
            message: result.error.message,
            type: ToolErrorType.SHELL_EXECUTE_ERROR,
          },
        }
      : {};

    return {
      llmContent,
      returnDisplay: returnDisplayMessage,
      ...executionError,
    };
  }

  /**
   * Background-execution path: spawn the command into a managed registry
   * entry instead of detaching with `&`. Output streams to a per-shell file
   * the agent can `Read`; cancellation flows through the entry's
   * AbortController; the registry's terminal status is set when the process
   * exits. Returns immediately so the agent's turn isn't blocked.
   */
  private async executeBackground(
    signal: AbortSignal,
    shellExecutionConfig?: ShellExecutionConfig,
  ): Promise<ToolResult> {
    const strippedCommand = stripShellWrapper(this.params.command);
    const processedCommand = this.addCoAuthorToGitCommit(strippedCommand);
    const cwd = this.params.directory || this.config.getTargetDir();

    // Output goes under the project temp dir (which `ReadFileTool`
    // auto-allows by default), so the LLM can `Read` the captured output
    // without bouncing off a permission prompt — important because
    // background-agent contexts can't surface interactive prompts.
    const outputDir = path.join(
      this.config.storage.getProjectTempDir(),
      'background-shells',
      this.config.getSessionId(),
    );
    fs.mkdirSync(outputDir, { recursive: true });

    const shellId = `bg_${crypto.randomBytes(4).toString('hex')}`;
    const outputPath = path.join(outputDir, `shell-${shellId}.output`);

    // Background shells are explicitly independent of the current turn:
    // the user pressing Ctrl+C on a turn (which aborts `signal`) should
    // NOT kill a long-running dev server / watcher they intentionally
    // backgrounded. Cancellation flows only through the entry's own
    // AbortController, driven by future `task_stop` integration (#3471).
    // The `signal` parameter is still honored for the synchronous early
    // return below (don't even spawn if the agent already aborted), but
    // we deliberately do not forward it.
    const entryAc = new AbortController();

    const outputStream = fs.createWriteStream(outputPath, { flags: 'w' });
    // Without an 'error' listener, a write failure (disk full, permission
    // change, fs going away) would surface as an uncaught exception and
    // kill the entire CLI session. Log + drop is the sane default — the
    // process keeps running, the registry still settles via resultPromise.
    outputStream.on('error', (err) => {
      debugLogger.warn(
        `background shell ${shellId} output write error: ${err.message}`,
      );
    });

    const startTime = Date.now();
    const entry: BackgroundShellEntry = {
      shellId,
      command: processedCommand,
      cwd,
      status: 'running',
      startTime,
      outputPath,
      abortController: entryAc,
    };

    const { result: resultPromise, pid } = await ShellExecutionService.execute(
      processedCommand,
      cwd,
      (event: ShellOutputEvent) => {
        if (event.type === 'data' && typeof event.chunk === 'string') {
          // Strip ANSI escape codes (color, cursor-move, clear-screen) before
          // writing — agents read the file as plain text, and dev servers /
          // build tools spam plenty of escape sequences that would render as
          // garbage. Costs ~one regex per chunk; cheap relative to disk I/O.
          outputStream.write(stripAnsi(event.chunk));
        }
        // ANSI array chunks and binary streams are not written to the output
        // file: agents read the file as plain text and binary spam would be
        // unhelpful.
      },
      entryAc.signal,
      // Background shells are non-interactive by design — no terminal to
      // attach a PTY to, no human to type at it. Force the child_process
      // path so we don't pull in node-pty for fire-and-forget commands.
      false,
      shellExecutionConfig ?? {},
      // Stream stdout/stderr through to the output file as chunks arrive.
      // Default child_process mode buffers until exit, which would leave
      // dev-server / watcher output files empty until the process dies.
      { streamStdout: true },
    );

    if (pid !== undefined) entry.pid = pid;
    const registry = this.config.getBackgroundShellRegistry();
    registry.register(entry);

    // Settle in the background — do NOT await here, the agent should be
    // unblocked immediately.
    void resultPromise.then(
      (result) => {
        outputStream.end();
        const endTime = Date.now();
        if (entryAc.signal.aborted) {
          if (registry.get(shellId)?.status === 'running') {
            registry.cancel(shellId, endTime);
          }
        } else if (
          result.error ||
          (result.exitCode !== null && result.exitCode !== 0) ||
          result.signal !== null
        ) {
          // Non-zero exit / killed by signal / spawn error all count as failed.
          // Treating them as `completed` would let `/tasks` (and any future
          // model-facing notification) misreport a failed `npm test` or
          // `false` command as a success.
          const reason = result.error
            ? result.error.message
            : result.signal !== null
              ? `terminated by signal ${result.signal}`
              : `exited with code ${result.exitCode}`;
          registry.fail(shellId, reason, endTime);
        } else {
          registry.complete(shellId, result.exitCode ?? 0, endTime);
        }
      },
      (err) => {
        outputStream.end();
        registry.fail(shellId, getErrorMessage(err), Date.now());
      },
    );

    const pidLine = pid !== undefined ? `pid: ${pid}\n` : '';
    return {
      llmContent:
        `Background shell started.\n` +
        `id: ${shellId}\n` +
        pidLine +
        `output file: ${outputPath}\n` +
        `Use the /tasks command to list and inspect background shells, or Read the output file directly.`,
      returnDisplay: `Background shell ${shellId} started${pid !== undefined ? ` (pid ${pid})` : ''}.`,
    };
  }

  private addCoAuthorToGitCommit(command: string): string {
    // Check if co-author feature is enabled
    const gitCoAuthorSettings = this.config.getGitCoAuthor();

    if (!gitCoAuthorSettings.enabled) {
      return command;
    }

    // Check if this is a git commit command (anywhere in the command, e.g., after "cd /path &&")
    const gitCommitPattern = /\bgit\s+commit\b/;
    if (!gitCommitPattern.test(command)) {
      return command;
    }

    // Define the co-author line using configuration
    const coAuthor = `

Co-authored-by: ${gitCoAuthorSettings.name} <${gitCoAuthorSettings.email}>`;

    // Handle different git commit patterns:
    // Match -m "message" or -m 'message', including combined flags like -am
    // Use separate patterns to avoid ReDoS (catastrophic backtracking)
    //
    // Pattern breakdown:
    //   -[a-zA-Z]*m  matches -m, -am, -nm, etc. (combined short flags)
    //   \s+          matches whitespace after the flag
    //   [^"\\]       matches any char except double-quote and backslash
    //   \\.          matches escape sequences like \" or \\
    //   (?:...|...)* matches normal chars or escapes, repeated
    const doubleQuotePattern = /(-[a-zA-Z]*m\s+)"((?:[^"\\]|\\.)*)"/;
    const singleQuotePattern = /(-[a-zA-Z]*m\s+)'((?:[^'\\]|\\.)*)'/;
    const doubleMatch = command.match(doubleQuotePattern);
    const singleMatch = command.match(singleQuotePattern);
    const match = doubleMatch ?? singleMatch;
    const quote = doubleMatch ? '"' : "'";

    if (match) {
      const [fullMatch, prefix, existingMessage] = match;
      const newMessage = existingMessage + coAuthor;
      const replacement = prefix + quote + newMessage + quote;

      return command.replace(fullMatch, replacement);
    }

    // If no -m flag found, the command might open an editor
    // In this case, we can't easily modify it, so return as-is
    return command;
  }
}

function getShellToolDescription(): string {
  const isWindows = os.platform() === 'win32';
  const executionWrapper = isWindows
    ? 'cmd.exe /c <command>'
    : 'bash -c <command>';
  const processGroupNote = isWindows
    ? ''
    : '\n  - Command is executed as a subprocess that leads its own process group. Command process group can be terminated as `kill -- -PGID` or signaled as `kill -s SIGNAL -- -PGID`.';

  return `Executes a given shell command (as \`${executionWrapper}\`) in a persistent shell session with optional timeout, ensuring proper handling and security measures.

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

**Usage notes**:
- The command argument is required.
- You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 120000ms (2 minutes).
- It is very helpful if you write a clear, concise description of what this command does in 5-10 words.

- Avoid using run_shell_command with the \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:
  - File search: Use ${ToolNames.GLOB} (NOT find or ls)
  - Content search: Use ${ToolNames.GREP} (NOT grep or rg)
  - Read files: Use ${ToolNames.READ_FILE} (NOT cat/head/tail)
  - Edit files: Use ${ToolNames.EDIT} (NOT sed/awk)
  - Write files: Use ${ToolNames.WRITE_FILE} (NOT echo >/cat <<EOF)
  - Communication: Output text directly (NOT echo/printf)
- **Shell argument quoting and special characters**: When passing arguments that contain special characters (parentheses \`()\`, backticks \`\`\`\`, dollar signs \`$\`, backslashes \`\\\`, semicolons \`;\`, pipes \`|\`, angle brackets \`<>\`, ampersands \`&\`, exclamation marks \`!\`, etc.), you MUST ensure they are properly quoted to prevent the shell from misinterpreting them as shell syntax:
  - **Single quotes** \`'...'\` pass everything literally, but cannot contain a literal single quote.
  - **ANSI-C quoting** \`$'...'\` supports escape sequences (e.g. \`\\n\` for newline, \`\\'\` for single quote) and is the safest approach for multi-line strings or strings with single quotes.
  - **Heredoc** is the most robust approach for large, multi-line text with mixed quotes:
    \`\`\`bash
    gh pr create --title "My Title" --body "$(cat <<'HEREDOC'
    Multi-line body with (parentheses), \`backticks\`, and 'single-quotes'.
    HEREDOC
    )"
    \`\`\`
  - NEVER use unescaped single quotes inside single-quoted strings (e.g. \`'it\\'s'\` is wrong; use \`$'it\\'s'\` or \`"it's"\` instead).
  - If unsure, prefer double-quoting arguments and escape inner double-quotes as \`\\"\`.
- When issuing multiple commands:
  - If the commands are independent and can run in parallel, make multiple run_shell_command tool calls in a single message. For example, if you need to run "git status" and "git diff", send a single message with two run_shell_command tool calls in parallel.
  - If the commands depend on each other and must run sequentially, use a single run_shell_command call with '&&' to chain them together (e.g., \`git add . && git commit -m "message" && git push\`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before run_shell_command for git operations, or git add before git commit), run these operations sequentially instead.
  - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail
  - DO NOT use newlines to separate commands (newlines are ok in quoted strings)
- Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of \`cd\`. You may use \`cd\` if the User explicitly requests it.
  <good-example>
  pytest /foo/bar/tests
  </good-example>
  <bad-example>
  cd /foo/bar && pytest tests
  </bad-example>

**Background vs Foreground Execution:**
- You should decide whether commands should run in background or foreground based on their nature:
- Use background execution (is_background: true) for:
  - Long-running development servers: \`npm run start\`, \`npm run dev\`, \`yarn dev\`, \`bun run start\`
  - Build watchers: \`npm run watch\`, \`webpack --watch\`
  - Database servers: \`mongod\`, \`mysql\`, \`redis-server\`
  - Web servers: \`python -m http.server\`, \`php -S localhost:8000\`
  - Any command expected to run indefinitely until manually stopped
${processGroupNote}
- Use foreground execution (is_background: false) for:
  - One-time commands: \`ls\`, \`cat\`, \`grep\`
  - Build commands: \`npm run build\`, \`make\`
  - Installation commands: \`npm install\`, \`pip install\`
  - Git operations: \`git commit\`, \`git push\`
  - Test runs: \`npm test\`, \`pytest\`
`;
}

function getCommandDescription(): string {
  if (os.platform() === 'win32') {
    return 'Exact command to execute as `cmd.exe /c <command>`';
  } else {
    return 'Exact bash command to execute as `bash -c <command>`';
  }
}

export class ShellTool extends BaseDeclarativeTool<
  ShellToolParams,
  ToolResult
> {
  static Name: string = ToolNames.SHELL;

  constructor(private readonly config: Config) {
    super(
      ShellTool.Name,
      ToolDisplayNames.SHELL,
      getShellToolDescription(),
      Kind.Execute,
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: getCommandDescription(),
          },
          is_background: {
            type: 'boolean',
            description:
              'Optional: Whether to run the command in background. If not specified, defaults to false (foreground execution). Explicitly set to true for long-running processes like development servers, watchers, or daemons that should continue running without blocking further commands.',
          },
          timeout: {
            type: 'number',
            description: 'Optional timeout in milliseconds (max 600000)',
          },
          description: {
            type: 'string',
            description:
              'Brief description of the command for the user. Be specific and concise. Ideally a single sentence. Can be up to 3 sentences for clarity. No line breaks.',
          },
          directory: {
            type: 'string',
            description:
              '(OPTIONAL) The absolute path of the directory to run the command in. If not provided, the project root directory is used. Must be a directory within the workspace and must already exist.',
          },
        },
        required: ['command'],
      },
      false, // output is not markdown
      true, // output can be updated
    );
  }

  protected override validateToolParamValues(
    params: ShellToolParams,
  ): string | null {
    // NOTE: Permission checks (read-only detection, PM rules) are handled at
    // L3 (getDefaultPermission) and L4 (PM override) in coreToolScheduler.
    // This method only performs pure parameter validation.
    if (!params.command.trim()) {
      return 'Command cannot be empty.';
    }
    const strippedCommand = stripShellWrapper(params.command);
    if (
      params.is_background &&
      hasTopLevelTrailingBackgroundOperator(strippedCommand)
    ) {
      return 'Background shell commands must not end with a bare "&". Remove the trailing "&" and rely on is_background: true instead.';
    }
    if (getCommandRoots(params.command).length === 0) {
      return 'Could not identify command root to obtain permission from user.';
    }
    if (params.timeout !== undefined) {
      if (
        typeof params.timeout !== 'number' ||
        !Number.isInteger(params.timeout)
      ) {
        return 'Timeout must be an integer number of milliseconds.';
      }
      if (params.timeout <= 0) {
        return 'Timeout must be a positive number.';
      }
      if (params.timeout > 600000) {
        return 'Timeout cannot exceed 600000ms (10 minutes).';
      }
    }
    if (params.directory) {
      if (!path.isAbsolute(params.directory)) {
        return 'Directory must be an absolute path.';
      }

      const userSkillsDirs = this.config.storage.getUserSkillsDirs();
      const resolvedDirectoryPath = path.resolve(params.directory);
      const isWithinUserSkills = isSubpaths(
        userSkillsDirs,
        resolvedDirectoryPath,
      );
      if (isWithinUserSkills) {
        return `Explicitly running shell commands from within the user skills directory is not allowed. Please use absolute paths for command parameter instead.`;
      }

      const workspaceDirs = this.config.getWorkspaceContext().getDirectories();
      const isWithinWorkspace = workspaceDirs.some((wsDir) =>
        params.directory!.startsWith(wsDir),
      );

      if (!isWithinWorkspace) {
        return `Directory '${params.directory}' is not within any of the registered workspace directories.`;
      }
    }
    return null;
  }

  protected createInvocation(
    params: ShellToolParams,
  ): ToolInvocation<ShellToolParams, ToolResult> {
    return new ShellToolInvocation(this.config, params);
  }
}
