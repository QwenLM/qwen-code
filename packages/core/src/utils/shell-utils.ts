/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyToolInvocation } from '../index.js';
import type { Config } from '../config/config.js';
import os from 'node:os';
import { quote } from 'shell-quote';
import { doesToolInvocationMatch } from './tool-utils.js';
import { isShellCommandReadOnly } from './shellReadOnlyChecker.js';
import {
  execFile,
  execFileSync,
  type ExecFileOptions,
} from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';

const SHELL_TOOL_NAMES = ['run_shell_command', 'ShellTool'];

/**
 * An identifier for the shell type.
 */
export type ShellType = 'cmd' | 'powershell' | 'bash';

/**
 * Defines the configuration required to execute a command string within a specific shell.
 */
export interface ShellConfiguration {
  /** The path or name of the shell executable (e.g., 'bash', 'cmd.exe'). */
  executable: string;
  /**
   * The arguments required by the shell to execute a subsequent string argument.
   */
  argsPrefix: string[];
  /** An identifier for the shell type. */
  shell: ShellType;
}

/**
 * Determines the appropriate shell configuration for the current platform.
 *
 * This ensures we can execute command strings predictably and securely across platforms
 * using the `spawn(executable, [...argsPrefix, commandString], { shell: false })` pattern.
 *
 * @returns The ShellConfiguration for the current environment.
 */
export function getShellConfiguration(): ShellConfiguration {
  if (isWindows()) {
    const comSpec = process.env['ComSpec'] || 'cmd.exe';
    const executable = comSpec.toLowerCase();

    if (
      executable.endsWith('powershell.exe') ||
      executable.endsWith('pwsh.exe')
    ) {
      // For PowerShell, the arguments are different.
      // -NoProfile: Speeds up startup.
      // -Command: Executes the following command.
      return {
        executable: comSpec,
        argsPrefix: ['-NoProfile', '-Command'],
        shell: 'powershell',
      };
    }

    // Default to cmd.exe for anything else on Windows.
    // Flags for CMD:
    // /d: Skip execution of AutoRun commands.
    // /s: Modifies the treatment of the command string (important for quoting).
    // /c: Carries out the command specified by the string and then terminates.
    return {
      executable: comSpec,
      argsPrefix: ['/d', '/s', '/c'],
      shell: 'cmd',
    };
  }

  // Unix-like systems (Linux, macOS)
  return { executable: 'bash', argsPrefix: ['-c'], shell: 'bash' };
}

/**
 * Export the platform detection constant for use in process management (e.g., killing processes).
 */
export const isWindows = () => os.platform() === 'win32';

/**
 * Escapes a string so that it can be safely used as a single argument
 * in a shell command, preventing command injection.
 *
 * @param arg The argument string to escape.
 * @param shell The type of shell the argument is for.
 * @returns The shell-escaped string.
 */
export function escapeShellArg(arg: string, shell: ShellType): string {
  if (!arg) {
    return '';
  }

  switch (shell) {
    case 'powershell':
      // For PowerShell, wrap in single quotes and escape internal single quotes by doubling them.
      return `'${arg.replace(/'/g, "''")}'`;
    case 'cmd':
      // Simple Windows escaping for cmd.exe: wrap in double quotes and escape inner double quotes.
      return `"${arg.replace(/"/g, '""')}"`;
    case 'bash':
    default:
      // POSIX shell escaping using shell-quote.
      return quote([arg]);
  }
}

/**
 * Splits a shell command into a list of individual commands, respecting quotes.
 * This is used to separate chained commands (e.g., using &&, ||, ;).
 * @param command The shell command string to parse
 * @returns An array of individual command strings
 */
export function splitCommands(command: string): string[] {
  const commands: string[] = [];
  let currentCommand = '';
  let inSingleQuotes = false;
  let inDoubleQuotes = false;
  let i = 0;

  while (i < command.length) {
    const char = command[i];
    const nextChar = command[i + 1];

    if (char === '\\' && i < command.length - 1) {
      currentCommand += char + command[i + 1];
      i += 2;
      continue;
    }

    if (char === "'" && !inDoubleQuotes) {
      inSingleQuotes = !inSingleQuotes;
    } else if (char === '"' && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes;
    }

    if (!inSingleQuotes && !inDoubleQuotes) {
      if (
        (char === '&' && nextChar === '&') ||
        (char === '|' && nextChar === '|')
      ) {
        commands.push(currentCommand.trim());
        currentCommand = '';
        i++; // Skip the next character
      } else if (char === ';' || char === '&' || char === '|') {
        commands.push(currentCommand.trim());
        currentCommand = '';
      } else if (char === '\r' && nextChar === '\n') {
        // Windows-style \r\n newline - treat as command separator
        commands.push(currentCommand.trim());
        currentCommand = '';
        i++; // Skip the \n
      } else if (char === '\n') {
        // Unix-style \n newline - treat as command separator
        commands.push(currentCommand.trim());
        currentCommand = '';
      } else {
        currentCommand += char;
      }
    } else {
      currentCommand += char;
    }
    i++;
  }

  if (currentCommand.trim()) {
    commands.push(currentCommand.trim());
  }

  return commands.filter(Boolean); // Filter out any empty strings
}

/**
 * Extracts the root command from a given shell command string.
 * This is used to identify the base command for permission checks.
 * @param command The shell command string to parse
 * @returns The root command name, or undefined if it cannot be determined
 * @example getCommandRoot("ls -la /tmp") returns "ls"
 * @example getCommandRoot("git status && npm test") returns "git"
 */
export function getCommandRoot(command: string): string | undefined {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return undefined;
  }

  // This regex is designed to find the first "word" of a command,
  // while respecting quotes. It looks for a sequence of non-whitespace
  // characters that are not inside quotes.
  const match = trimmedCommand.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  if (match) {
    // The first element in the match array is the full match.
    // The subsequent elements are the capture groups.
    // We prefer a captured group because it will be unquoted.
    const commandRoot = match[1] || match[2] || match[3];
    if (commandRoot) {
      // If the command is a path, return the last component.
      return commandRoot.split(/[\\/]/).pop();
    }
  }

  return undefined;
}

export function getCommandRoots(command: string): string[] {
  if (!command) {
    return [];
  }
  return splitCommands(command)
    .map((c) => getCommandRoot(c))
    .filter((c): c is string => !!c);
}

export function stripShellWrapper(command: string): string {
  const pattern = /^\s*(?:sh|bash|zsh|cmd.exe)\s+(?:\/c|-c)\s+/;
  const match = command.match(pattern);
  if (match) {
    let newCommand = command.substring(match[0].length).trim();
    if (
      (newCommand.startsWith('"') && newCommand.endsWith('"')) ||
      (newCommand.startsWith("'") && newCommand.endsWith("'"))
    ) {
      newCommand = newCommand.substring(1, newCommand.length - 1);
    }
    return newCommand;
  }
  return command.trim();
}

/**
 * Detects command substitution patterns in a shell command, following bash quoting rules:
 * - Single quotes ('): Everything literal, no substitution possible
 * - Double quotes ("): Command substitution with $() and backticks unless escaped with \
 * - No quotes: Command substitution with $(), <(), and backticks
 *
 * This function also understands heredocs:
 * - If a heredoc delimiter is quoted (e.g. `<<'EOF'`), bash will not perform
 *   expansions in the heredoc body, so substitution-like text is allowed.
 * - If a heredoc delimiter is unquoted (e.g. `<<EOF`), bash will perform
 *   expansions in the heredoc body, so command substitution is blocked there too.
 * @param command The shell command string to check
 * @returns true if command substitution would be executed by bash
 */
export function detectCommandSubstitution(command: string): boolean {
  type PendingHeredoc = {
    delimiter: string;
    isQuotedDelimiter: boolean;
    stripLeadingTabs: boolean;
  };

  const isCommentStart = (index: number): boolean => {
    if (command[index] !== '#') return false;
    if (index === 0) return true;

    const prev = command[index - 1]!;
    if (prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r') {
      return true;
    }

    // `#` starts a comment when it begins a word. In practice this includes
    // common command separators/operators where a new word can begin.
    return [';', '&', '|', '(', ')', '<', '>'].includes(prev);
  };

  const isWordBoundary = (char: string): boolean => {
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      return true;
    }
    // Shell metacharacters that would terminate a WORD token in this context.
    // This helps correctly parse heredoc delimiters in cases like `<<EOF;`.
    return [';', '&', '|', '<', '>', '(', ')'].includes(char);
  };

  const parseHeredocOperator = (
    startIndex: number,
  ): { nextIndex: number; heredoc: PendingHeredoc } | null => {
    // startIndex points at the first '<' of the `<<` operator.
    if (command[startIndex] !== '<' || command[startIndex + 1] !== '<') {
      return null;
    }

    let i = startIndex + 2;
    const stripLeadingTabs = command[i] === '-';
    if (stripLeadingTabs) i++;

    // Skip whitespace between operator and delimiter word.
    while (i < command.length && (command[i] === ' ' || command[i] === '\t')) {
      i++;
    }

    // Parse the delimiter WORD token. If any quoting is used in the delimiter,
    // bash disables expansions in the heredoc body.
    let delimiter = '';
    let isQuotedDelimiter = false;
    let inSingleQuotes = false;
    let inDoubleQuotes = false;

    while (i < command.length) {
      const char = command[i]!;
      if (!inSingleQuotes && !inDoubleQuotes && isWordBoundary(char)) {
        break;
      }

      if (!inSingleQuotes && !inDoubleQuotes) {
        if (char === "'") {
          isQuotedDelimiter = true;
          inSingleQuotes = true;
          i++;
          continue;
        }
        if (char === '"') {
          isQuotedDelimiter = true;
          inDoubleQuotes = true;
          i++;
          continue;
        }
        if (char === '\\') {
          isQuotedDelimiter = true;
          i++;
          if (i >= command.length) break;
          delimiter += command[i]!;
          i++;
          continue;
        }
        delimiter += char;
        i++;
        continue;
      }

      if (inSingleQuotes) {
        if (char === "'") {
          inSingleQuotes = false;
          i++;
          continue;
        }
        delimiter += char;
        i++;
        continue;
      }

      // inDoubleQuotes
      if (char === '"') {
        inDoubleQuotes = false;
        i++;
        continue;
      }
      if (char === '\\') {
        // Backslash quoting is supported in double-quoted words. For our
        // purposes, treat it as quoting and include the escaped char as-is.
        isQuotedDelimiter = true;
        i++;
        if (i >= command.length) break;
        delimiter += command[i]!;
        i++;
        continue;
      }
      delimiter += char;
      i++;
    }

    // If we couldn't parse a delimiter WORD, this isn't a supported heredoc
    // operator for our purposes (e.g. a here-string like `<<<`).
    if (delimiter.length === 0) {
      return null;
    }

    return {
      nextIndex: i,
      heredoc: {
        delimiter,
        isQuotedDelimiter,
        stripLeadingTabs,
      },
    };
  };

  const lineHasCommandSubstitution = (line: string): boolean => {
    for (let i = 0; i < line.length; i++) {
      const char = line[i]!;
      const nextChar = line[i + 1];

      // In unquoted heredocs, backslash can be used to escape `$` and backticks.
      if (char === '\\') {
        i++; // Skip the escaped char (if any)
        continue;
      }

      if (char === '$' && nextChar === '(') {
        return true;
      }

      if (char === '`') {
        return true;
      }
    }
    return false;
  };

  const consumeHeredocBodies = (
    startIndex: number,
    pending: PendingHeredoc[],
  ): { nextIndex: number; hasSubstitution: boolean } => {
    let i = startIndex;

    for (const heredoc of pending) {
      // Track `$\<newline>` line continuations in unquoted heredocs, since
      // bash ignores `\<newline>` during heredoc expansions and this can join
      // `$` and `(` across lines to form `$(`.
      let pendingDollarLineContinuation = false;

      while (i <= command.length) {
        const lineStart = i;
        while (
          i < command.length &&
          command[i] !== '\n' &&
          command[i] !== '\r'
        ) {
          i++;
        }
        const lineEnd = i;

        let newlineLength = 0;
        if (
          i < command.length &&
          command[i] === '\r' &&
          command[i + 1] === '\n'
        ) {
          newlineLength = 2;
        } else if (
          i < command.length &&
          (command[i] === '\n' || command[i] === '\r')
        ) {
          newlineLength = 1;
        }

        const rawLine = command.slice(lineStart, lineEnd);
        const effectiveLine = heredoc.stripLeadingTabs
          ? rawLine.replace(/^\t+/, '')
          : rawLine;

        if (effectiveLine === heredoc.delimiter) {
          i = lineEnd + newlineLength;
          break;
        }

        if (!heredoc.isQuotedDelimiter) {
          if (pendingDollarLineContinuation && effectiveLine.startsWith('(')) {
            return { nextIndex: i, hasSubstitution: true };
          }

          if (lineHasCommandSubstitution(effectiveLine)) {
            return { nextIndex: i, hasSubstitution: true };
          }

          pendingDollarLineContinuation = false;
          if (
            newlineLength > 0 &&
            rawLine.length >= 2 &&
            rawLine.endsWith('\\') &&
            rawLine[rawLine.length - 2] === '$'
          ) {
            let backslashCount = 0;
            for (
              let j = rawLine.length - 3;
              j >= 0 && rawLine[j] === '\\';
              j--
            ) {
              backslashCount++;
            }
            const isEscapedDollar = backslashCount % 2 === 1;
            pendingDollarLineContinuation = !isEscapedDollar;
          }
        }

        // Advance to the next line (or end).
        i = lineEnd + newlineLength;
        if (newlineLength === 0) {
          break;
        }
      }
    }

    return { nextIndex: i, hasSubstitution: false };
  };

  let inSingleQuotes = false;
  let inDoubleQuotes = false;
  let inBackticks = false;
  let inComment = false;
  const pendingHeredocs: PendingHeredoc[] = [];
  let i = 0;

  while (i < command.length) {
    const char = command[i]!;
    const nextChar = command[i + 1];

    // If we just finished parsing a heredoc operator, the heredoc body begins
    // after the command line ends (a newline). Once we hit that newline,
    // consume heredoc bodies sequentially before continuing.
    if (!inSingleQuotes && !inDoubleQuotes && !inBackticks) {
      if (char === '\r' && nextChar === '\n') {
        inComment = false;
        if (pendingHeredocs.length > 0) {
          const result = consumeHeredocBodies(i + 2, pendingHeredocs);
          if (result.hasSubstitution) return true;
          pendingHeredocs.length = 0;
          i = result.nextIndex;
          continue;
        }
      } else if (char === '\n' || char === '\r') {
        inComment = false;
        if (pendingHeredocs.length > 0) {
          const result = consumeHeredocBodies(i + 1, pendingHeredocs);
          if (result.hasSubstitution) return true;
          pendingHeredocs.length = 0;
          i = result.nextIndex;
          continue;
        }
      }
    }

    if (!inSingleQuotes && !inDoubleQuotes && !inBackticks) {
      if (!inComment && isCommentStart(i)) {
        inComment = true;
        i++;
        continue;
      }

      if (inComment) {
        i++;
        continue;
      }
    }

    // Handle escaping - only works outside single quotes
    if (char === '\\' && !inSingleQuotes) {
      i += 2; // Skip the escaped character
      continue;
    }

    // Handle quote state changes
    if (char === "'" && !inDoubleQuotes && !inBackticks) {
      inSingleQuotes = !inSingleQuotes;
    } else if (char === '"' && !inSingleQuotes && !inBackticks) {
      inDoubleQuotes = !inDoubleQuotes;
    } else if (char === '`' && !inSingleQuotes) {
      // Backticks work outside single quotes (including in double quotes)
      inBackticks = !inBackticks;
    }

    // Detect heredoc operators (`<<` / `<<-`) only in command-line context.
    if (
      !inSingleQuotes &&
      !inDoubleQuotes &&
      !inBackticks &&
      char === '<' &&
      nextChar === '<'
    ) {
      const parsed = parseHeredocOperator(i);
      if (parsed) {
        pendingHeredocs.push(parsed.heredoc);
        i = parsed.nextIndex;
        continue;
      }
    }

    // Check for command substitution patterns that would be executed.
    // Note: heredoc body content is handled separately via consumeHeredocBodies.
    if (!inSingleQuotes) {
      // $(...) command substitution - works in double quotes and unquoted
      if (char === '$' && nextChar === '(') {
        return true;
      }

      // <(...) process substitution - works unquoted only (not in double quotes)
      if (char === '<' && nextChar === '(' && !inDoubleQuotes && !inBackticks) {
        return true;
      }

      // >(...) process substitution - works unquoted only (not in double quotes)
      if (char === '>' && nextChar === '(' && !inDoubleQuotes && !inBackticks) {
        return true;
      }

      // Backtick command substitution.
      // We treat any unescaped backtick outside single quotes as substitution.
      if (char === '`') {
        return true;
      }
    }

    i++;
  }

  // If there are pending heredocs but no newline/body, there is nothing left to
  // scan for heredoc-body substitutions.
  return false;
}

/**
 * Checks a shell command against security policies and allowlists.
 *
 * This function operates in one of two modes depending on the presence of
 * the `sessionAllowlist` parameter:
 *
 * 1.  **"Default Deny" Mode (sessionAllowlist is provided):** This is the
 *     strictest mode, used for user-defined scripts like custom commands.
 *     A command is only permitted if it is found on the global `coreTools`
 *     allowlist OR the provided `sessionAllowlist`. It must not be on the
 *     global `excludeTools` blocklist.
 *
 * 2.  **"Default Allow" Mode (sessionAllowlist is NOT provided):** This mode
 *     is used for direct tool invocations (e.g., by the model). If a strict
 *     global `coreTools` allowlist exists, commands must be on it. Otherwise,
 *     any command is permitted as long as it is not on the `excludeTools`
 *     blocklist.
 *
 * @param command The shell command string to validate.
 * @param config The application configuration.
 * @param sessionAllowlist A session-level list of approved commands. Its
 *   presence activates "Default Deny" mode.
 * @returns An object detailing which commands are not allowed.
 */
export function checkCommandPermissions(
  command: string,
  config: Config,
  sessionAllowlist?: Set<string>,
): {
  allAllowed: boolean;
  disallowedCommands: string[];
  blockReason?: string;
  isHardDenial?: boolean;
} {
  // Disallow command substitution for security.
  if (detectCommandSubstitution(command)) {
    return {
      allAllowed: false,
      disallowedCommands: [command],
      blockReason:
        'Command substitution using $(), `` ` ``, <(), or >() is not allowed for security reasons',
      isHardDenial: true,
    };
  }

  const normalize = (cmd: string): string => cmd.trim().replace(/\s+/g, ' ');
  const commandsToValidate = splitCommands(command).map(normalize);
  const invocation: AnyToolInvocation & { params: { command: string } } = {
    params: { command: '' },
  } as AnyToolInvocation & { params: { command: string } };

  // 1. Blocklist Check (Highest Priority)
  const excludeTools = config.getExcludeTools() || [];
  const isWildcardBlocked = SHELL_TOOL_NAMES.some((name) =>
    excludeTools.includes(name),
  );

  if (isWildcardBlocked) {
    return {
      allAllowed: false,
      disallowedCommands: commandsToValidate,
      blockReason: 'Shell tool is globally disabled in configuration',
      isHardDenial: true,
    };
  }

  for (const cmd of commandsToValidate) {
    invocation.params['command'] = cmd;
    if (
      doesToolInvocationMatch('run_shell_command', invocation, excludeTools)
    ) {
      return {
        allAllowed: false,
        disallowedCommands: [cmd],
        blockReason: `Command '${cmd}' is blocked by configuration`,
        isHardDenial: true,
      };
    }
  }

  const coreTools = config.getCoreTools() || [];
  const isWildcardAllowed = SHELL_TOOL_NAMES.some((name) =>
    coreTools.includes(name),
  );

  // If there's a global wildcard, all commands are allowed at this point
  // because they have already passed the blocklist check.
  if (isWildcardAllowed) {
    return { allAllowed: true, disallowedCommands: [] };
  }

  const disallowedCommands: string[] = [];

  if (sessionAllowlist) {
    // "DEFAULT DENY" MODE: A session allowlist is provided.
    // All commands must be in either the session or global allowlist.
    const normalizedSessionAllowlist = new Set(
      [...sessionAllowlist].flatMap((cmd) =>
        SHELL_TOOL_NAMES.map((name) => `${name}(${cmd})`),
      ),
    );

    for (const cmd of commandsToValidate) {
      invocation.params['command'] = cmd;
      const isSessionAllowed = doesToolInvocationMatch(
        'run_shell_command',
        invocation,
        [...normalizedSessionAllowlist],
      );
      if (isSessionAllowed) continue;

      const isGloballyAllowed = doesToolInvocationMatch(
        'run_shell_command',
        invocation,
        coreTools,
      );
      if (isGloballyAllowed) continue;

      disallowedCommands.push(cmd);
    }

    if (disallowedCommands.length > 0) {
      return {
        allAllowed: false,
        disallowedCommands,
        blockReason: `Command(s) not on the global or session allowlist. Disallowed commands: ${disallowedCommands
          .map((c) => JSON.stringify(c))
          .join(', ')}`,
        isHardDenial: false, // This is a soft denial; confirmation is possible.
      };
    }
  } else {
    // "DEFAULT ALLOW" MODE: No session allowlist.
    const hasSpecificAllowedCommands =
      coreTools.filter((tool) =>
        SHELL_TOOL_NAMES.some((name) => tool.startsWith(`${name}(`)),
      ).length > 0;

    if (hasSpecificAllowedCommands) {
      for (const cmd of commandsToValidate) {
        invocation.params['command'] = cmd;
        const isGloballyAllowed = doesToolInvocationMatch(
          'run_shell_command',
          invocation,
          coreTools,
        );
        if (!isGloballyAllowed) {
          disallowedCommands.push(cmd);
        }
      }
      if (disallowedCommands.length > 0) {
        return {
          allAllowed: false,
          disallowedCommands,
          blockReason: `Command(s) not in the allowed commands list. Disallowed commands: ${disallowedCommands
            .map((c) => JSON.stringify(c))
            .join(', ')}`,
          isHardDenial: false, // This is a soft denial.
        };
      }
    }
    // If no specific global allowlist exists, and it passed the blocklist,
    // the command is allowed by default.
  }

  // If all checks for the current mode pass, the command is allowed.
  return { allAllowed: true, disallowedCommands: [] };
}

/**
 * Executes a command with the given arguments without using a shell.
 *
 * This is a wrapper around Node.js's `execFile`, which spawns a process
 * directly without invoking a shell, making it safer than `exec`.
 * It's suitable for short-running commands with limited output.
 *
 * @param command The command to execute (e.g., 'git', 'osascript').
 * @param args Array of arguments to pass to the command.
 * @param options Optional spawn options including:
 *   - preserveOutputOnError: If false (default), rejects on error.
 *                           If true, resolves with output and error code.
 *   - Other standard spawn options (e.g., cwd, env).
 * @returns A promise that resolves with stdout, stderr strings, and exit code.
 * @throws Rejects with an error if the command fails (unless preserveOutputOnError is true).
 */
export function execCommand(
  command: string,
  args: string[],
  options: { preserveOutputOnError?: boolean } & ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { encoding: 'utf8', ...options },
      (error, stdout, stderr) => {
        if (error) {
          if (!options.preserveOutputOnError) {
            reject(error);
          } else {
            resolve({
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? ''),
              code: typeof error.code === 'number' ? error.code : 1,
            });
          }
          return;
        }
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: 0,
        });
      },
    );
    child.on('error', reject);
  });
}

/**
 * Resolves the path of a command in the system's PATH.
 * @param {string} command The command name (e.g., 'git', 'grep').
 * @returns {path: string | null; error?: Error} The path of the command, or null if it is not found and any error that occurred.
 */
export function resolveCommandPath(command: string): {
  path: string | null;
  error?: Error;
} {
  try {
    const isWin = process.platform === 'win32';

    if (isWin) {
      const checkCommand = 'where.exe';
      const checkArgs = [command];

      let result: string | null = null;
      try {
        result = execFileSync(checkCommand, checkArgs, {
          encoding: 'utf8',
          shell: false,
        }).trim();
      } catch {
        return { path: null, error: undefined };
      }

      return result ? { path: result } : { path: null };
    } else {
      const shell = '/bin/sh';
      const checkArgs = ['-c', `command -v ${escapeShellArg(command, 'bash')}`];

      let result: string | null = null;
      try {
        result = execFileSync(shell, checkArgs, {
          encoding: 'utf8',
          shell: false,
        }).trim();
      } catch {
        return { path: null, error: undefined };
      }

      if (!result) return { path: null, error: undefined };
      accessSync(result, fsConstants.X_OK);
      return { path: result, error: undefined };
    }
  } catch (error) {
    return {
      path: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Checks if a command is available in the system's PATH.
 * @param {string} command The command name (e.g., 'git', 'grep').
 * @returns {available: boolean; error?: Error} The availability of the command and any error that occurred.
 */
export function isCommandAvailable(command: string): {
  available: boolean;
  error?: Error;
} {
  const { path, error } = resolveCommandPath(command);
  return { available: path !== null, error };
}

export function isCommandAllowed(
  command: string,
  config: Config,
): { allowed: boolean; reason?: string } {
  // By not providing a sessionAllowlist, we invoke "default allow" behavior.
  const { allAllowed, blockReason } = checkCommandPermissions(command, config);
  if (allAllowed) {
    return { allowed: true };
  }
  return { allowed: false, reason: blockReason };
}

export function isCommandNeedsPermission(command: string): {
  requiresPermission: boolean;
  reason?: string;
} {
  const isAllowed = isShellCommandReadOnly(command);

  if (isAllowed) {
    return { requiresPermission: false };
  }

  return {
    requiresPermission: true,
    reason: 'Command requires permission to execute.',
  };
}
