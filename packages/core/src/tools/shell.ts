/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import os, { EOL } from 'node:os';
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
} from './tools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  ToolConfirmationOutcome,
  Kind,
} from './tools.js';
import { getErrorMessage } from '../utils/errors.js';
import { summarizeToolOutput } from '../utils/summarizer.js';
import type {
  ShellExecutionConfig,
  ShellOutputEvent,
} from '../services/shellExecutionService.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import { formatMemoryUsage } from '../utils/formatters.js';
import type { AnsiOutput } from '../utils/terminalSerializer.js';
import { isSubpath } from '../utils/paths.js';
import {
  getCommandRoots,
  isCommandAllowed,
  isCommandNeedsPermission,
  stripShellWrapper,
} from '../utils/shell-utils.js';

export const OUTPUT_UPDATE_INTERVAL_MS = 1000;
const DEFAULT_FOREGROUND_TIMEOUT_MS = 120000;

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
    private readonly allowlist: Set<string>,
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

  override async shouldConfirmExecute(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    const command = stripShellWrapper(this.params.command);
    const rootCommands = [...new Set(getCommandRoots(command))];
    const commandsToConfirm = rootCommands.filter(
      (command) => !this.allowlist.has(command),
    );

    if (commandsToConfirm.length === 0) {
      return false; // already approved and allowlisted
    }

    const permissionCheck = isCommandNeedsPermission(command);
    if (!permissionCheck.requiresPermission) {
      return false;
    }

    const confirmationDetails: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Shell Command',
      command: this.params.command,
      rootCommand: commandsToConfirm.join(', '),
      onConfirm: async (
        outcome: ToolConfirmationOutcome,
        _payload?: ToolConfirmationPayload,
      ) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          commandsToConfirm.forEach((command) => this.allowlist.add(command));
        }
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

    const effectiveTimeout = this.params.is_background
      ? undefined
      : (this.params.timeout ?? DEFAULT_FOREGROUND_TIMEOUT_MS);

    // Create combined signal with timeout for foreground execution
    let combinedSignal = signal;
    if (effectiveTimeout) {
      const timeoutSignal = AbortSignal.timeout(effectiveTimeout);
      combinedSignal = AbortSignal.any([signal, timeoutSignal]);
    }

    const isWindows = os.platform() === 'win32';
    const tempFileName = `shell_pgrep_${crypto
      .randomBytes(6)
      .toString('hex')}.tmp`;
    const tempFilePath = path.join(os.tmpdir(), tempFileName);

    try {
      // Add co-author to git commit commands
      const processedCommand = this.addCoAuthorToGitCommit(strippedCommand);

      const shouldRunInBackground = this.params.is_background;
      let finalCommand = processedCommand;

      // On non-Windows, use & to run in background.
      // On Windows, we don't use start /B because it creates a detached process that
      // doesn't die when the parent dies. Instead, we rely on the race logic below
      // to return early while keeping the process attached (detached: false).
      if (
        !isWindows &&
        shouldRunInBackground &&
        !finalCommand.trim().endsWith('&')
      ) {
        finalCommand = finalCommand.trim() + ' &';
      }

      // On Windows, we rely on the race logic below to handle background tasks.
      // We just ensure the command string is clean.
      if (isWindows && shouldRunInBackground) {
        finalCommand = finalCommand.trim().replace(/&+$/, '').trim();
      }

      // pgrep is not available on Windows, so we can't get background PIDs
      const commandToExecute = isWindows
        ? finalCommand
        : (() => {
            // wrap command to append subprocess pids (via pgrep) to temporary file
            let command = finalCommand.trim();
            if (!command.endsWith('&')) command += ';';
            return `{ ${command} }; __code=$?; pgrep -g 0 >${tempFilePath} 2>&1; exit $__code;`;
          })();

      const cwd = this.params.directory || this.config.getTargetDir();

      let cumulativeOutput: string | AnsiOutput = '';
      let lastUpdateTime = Date.now();
      let isBinaryStream = false;

      const { result: resultPromise, pid } =
        await ShellExecutionService.execute(
          commandToExecute,
          cwd,
          (event: ShellOutputEvent) => {
            let shouldUpdate = false;

            switch (event.type) {
              case 'data':
                if (isBinaryStream) break;
                cumulativeOutput = event.chunk;
                shouldUpdate = true;
                break;
              case 'binary_detected':
                isBinaryStream = true;
                cumulativeOutput =
                  '[Binary output detected. Halting stream...]';
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
              updateOutput(
                typeof cumulativeOutput === 'string'
                  ? cumulativeOutput
                  : { ansiOutput: cumulativeOutput },
              );
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

      if (shouldRunInBackground) {
        // For background tasks, return immediately with PID info
        // Note: We cannot reliably detect startup errors for background processes
        // since their stdio is typically detached/ignored
        const pidMsg = pid ? ` PID: ${pid}` : '';
        const killHint = isWindows
          ? ' (Use taskkill /F /T /PID <pid> to stop)'
          : ' (Use kill <pid> to stop)';

        return {
          llmContent: `Background command started.${pidMsg}${killHint}`,
          returnDisplay: `Background command started.${pidMsg}${killHint}`,
        };
      }

      const result = await resultPromise;

      const backgroundPIDs: number[] = [];
      if (os.platform() !== 'win32') {
        if (fs.existsSync(tempFilePath)) {
          const pgrepLines = fs
            .readFileSync(tempFilePath, 'utf8')
            .split(EOL)
            .filter(Boolean);
          for (const line of pgrepLines) {
            if (!/^\d+$/.test(line)) {
              console.error(`pgrep: ${line}`);
            }
            const pid = Number(line);
            if (pid !== result.pid) {
              backgroundPIDs.push(pid);
            }
          }
        } else {
          if (!signal.aborted) {
            console.error('missing pgrep output');
          }
        }
      }

      let llmContent = '';
      if (result.aborted) {
        // Check if it was a timeout or user cancellation
        const wasTimeout =
          !this.params.is_background &&
          effectiveTimeout &&
          combinedSignal.aborted &&
          !signal.aborted;

        if (wasTimeout) {
          llmContent = `Command timed out after ${effectiveTimeout}ms before it could complete.`;
          if (result.output.trim()) {
            llmContent += ` Below is the output before it timed out:\n${result.output}`;
          } else {
            llmContent += ' There was no output before it timed out.';
          }
        } else {
          llmContent =
            'Command was cancelled by user before it could complete.';
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
          `Background PIDs: ${
            backgroundPIDs.length ? backgroundPIDs.join(', ') : '(none)'
          }`,
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
              !this.params.is_background &&
              effectiveTimeout &&
              combinedSignal.aborted &&
              !signal.aborted;

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

      const summarizeConfig = this.config.getSummarizeToolOutputConfig();
      const executionError = result.error
        ? {
            error: {
              message: result.error.message,
              type: ToolErrorType.SHELL_EXECUTE_ERROR,
            },
          }
        : {};
      if (summarizeConfig && summarizeConfig[ShellTool.Name]) {
        const summary = await summarizeToolOutput(
          llmContent,
          this.config.getGeminiClient(),
          signal,
          summarizeConfig[ShellTool.Name].tokenBudget,
        );
        return {
          llmContent: summary,
          returnDisplay: returnDisplayMessage,
          ...executionError,
        };
      }

      return {
        llmContent,
        returnDisplay: returnDisplayMessage,
        ...executionError,
      };
    } finally {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }
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
  const cmd_substitution_warning =
    '\n*** WARNING: Command substitution using $(), `` ` ``, <(), or >() is not allowed for security reasons.';
  if (os.platform() === 'win32') {
    return (
      'Exact command to execute as `cmd.exe /c <command>`' +
      cmd_substitution_warning
    );
  } else {
    return (
      'Exact bash command to execute as `bash -c <command>`' +
      cmd_substitution_warning
    );
  }
}

export class ShellTool extends BaseDeclarativeTool<
  ShellToolParams,
  ToolResult
> {
  static Name: string = ToolNames.SHELL;
  private allowlist: Set<string> = new Set();

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
              'Whether to run the command in background. Default is false. Set to true for long-running processes like development servers, watchers, or daemons that should continue running without blocking further commands.',
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
        required: ['command', 'is_background'],
      },
      false, // output is not markdown
      true, // output can be updated
    );
  }

  protected override validateToolParamValues(
    params: ShellToolParams,
  ): string | null {
    const commandCheck = isCommandAllowed(params.command, this.config);
    if (!commandCheck.allowed) {
      if (!commandCheck.reason) {
        console.error(
          'Unexpected: isCommandAllowed returned false without a reason',
        );
        return `Command is not allowed: ${params.command}`;
      }
      return commandCheck.reason;
    }
    if (!params.command.trim()) {
      return 'Command cannot be empty.';
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

      const userSkillsDir = this.config.storage.getUserSkillsDir();
      const resolvedDirectoryPath = path.resolve(params.directory);
      const isWithinUserSkills = isSubpath(
        userSkillsDir,
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
    return new ShellToolInvocation(this.config, params, this.allowlist);
  }
}
