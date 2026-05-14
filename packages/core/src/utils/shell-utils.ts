/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyToolInvocation } from '../index.js';
import type { Config } from '../config/config.js';
import os from 'node:os';
import path from 'node:path';
import { parse, quote } from 'shell-quote';
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

let cachedBashPath: string | undefined;
const ENV_ASSIGNMENT_REGEX = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Attempts to find the Git Bash executable path on Windows.
 * Checks common installation locations and PATH.
 * @returns The path to bash.exe if found, or 'bash' as fallback.
 */
function findGitBashPath(): string {
  // Return cached result if available
  if (cachedBashPath) {
    return cachedBashPath;
  }

  // Search in PATH directories
  const pathEnv = process.env['PATH'] || '';
  const pathDirs = pathEnv.split(path.delimiter).filter(Boolean);

  for (const dir of pathDirs) {
    const bashPath = path.join(dir, 'bash.exe');
    try {
      accessSync(bashPath, fsConstants.X_OK);
      cachedBashPath = bashPath;
      return bashPath;
    } catch {
      // Continue searching
    }
  }

  // Check common Git Bash installation locations
  const commonPaths = [
    path.join('C:', 'Program Files', 'Git', 'bin', 'bash.exe'),
    path.join('C:', 'Program Files', 'Git', 'usr', 'bin', 'bash.exe'),
    path.join('C:', 'Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join('C:', 'Program Files (x86)', 'Git', 'usr', 'bin', 'bash.exe'),
    path.join(
      process.env['ProgramFiles'] || path.join('C:', 'Program Files'),
      'Git',
      'bin',
      'bash.exe',
    ),
    path.join(
      process.env['ProgramFiles(x86)'] ||
        path.join('C:', 'Program Files (x86)'),
      'Git',
      'bin',
      'bash.exe',
    ),
  ];

  for (const bashPath of commonPaths) {
    try {
      accessSync(bashPath, fsConstants.X_OK);
      cachedBashPath = bashPath;
      return bashPath;
    } catch {
      // Continue searching
    }
  }

  // Fallback to 'bash' and let the system handle it
  cachedBashPath = 'bash';
  return 'bash';
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
    // Detect Git Bash / MSYS2 / MinTTY environments
    // These environments should use bash instead of cmd/PowerShell
    const msystem = process.env['MSYSTEM'];
    const term = process.env['TERM'] || '';
    const isGitBash =
      msystem?.startsWith('MINGW') ||
      msystem?.startsWith('MSYS') ||
      term.includes('msys') ||
      term.includes('cygwin');

    if (isGitBash) {
      return {
        executable: findGitBashPath(),
        argsPrefix: ['-c'],
        shell: 'bash',
      };
    }

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

  const previousNonWhitespaceChar = (index: number): string | undefined => {
    for (let j = index - 1; j >= 0; j--) {
      const ch = command[j];
      if (ch && !/\s/.test(ch)) {
        return ch;
      }
    }
    return undefined;
  };

  while (i < command.length) {
    const char = command[i];
    const nextChar = command[i + 1];

    if (!inSingleQuotes && char === '\\' && nextChar === '\n') {
      i += 2;
      continue;
    }

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
        (char === '|' && (nextChar === '|' || nextChar === '&'))
      ) {
        commands.push(currentCommand.trim());
        currentCommand = '';
        i++; // Skip the next character
      } else if (char === ';') {
        commands.push(currentCommand.trim());
        currentCommand = '';
      } else if (char === '&') {
        const prevChar = previousNonWhitespaceChar(i);
        if (prevChar === '>' || prevChar === '<') {
          currentCommand += char;
        } else {
          commands.push(currentCommand.trim());
          currentCommand = '';
        }
      } else if (char === '|') {
        const prevChar = previousNonWhitespaceChar(i);
        if (prevChar === '>') {
          currentCommand += char;
        } else {
          commands.push(currentCommand.trim());
          currentCommand = '';
        }
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
 * Skips leading env var assignments (VAR=value) so that
 * `PYTHONPATH=/tmp python3 -c "..."` returns `python3`.
 */
export function getCommandRoot(command: string): string | undefined {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return undefined;
  }

  try {
    const tokens = parse(trimmedCommand).filter(
      (token): token is string => typeof token === 'string',
    );

    let idx = 0;
    while (idx < tokens.length && ENV_ASSIGNMENT_REGEX.test(tokens[idx]!)) {
      idx++;
    }

    const firstToken = tokens[idx];
    return firstToken ? firstToken.split(/[\\/]/).pop() : undefined;
  } catch {
    const match = trimmedCommand.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
    if (match) {
      const commandRoot = match[1] || match[2] || match[3];
      if (commandRoot) {
        return commandRoot.split(/[\\/]/).pop();
      }
    }

    return undefined;
  }
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
  const trimmed = command.trim();
  let rest = trimmed;

  // Skip leading env assignments (e.g. `FOO=bar bash -c '...'`)
  while (true) {
    const token = takeLeadingToken(rest);
    if (!token || !isEnvAssignmentToken(token.token)) break;
    rest = token.rest;
  }

  // Check for a known shell wrapper (bash, sh, zsh, cmd.exe — with or
  // without absolute path like /bin/bash or /usr/bin/zsh).
  const wrapperToken = takeLeadingToken(rest);
  if (!wrapperToken || !isKnownMonitorWrapperToken(wrapperToken.token)) {
    return trimmed;
  }
  rest = wrapperToken.rest;

  // Consume wrapper flags (e.g. -e, -x, -o pipefail, -lc) until we
  // hit the -c / /c command marker.
  while (true) {
    const token = takeLeadingToken(rest);
    if (!token) return trimmed;

    if (isMonitorCommandMarker(wrapperToken.token, token.token)) {
      const commandToken = takeLeadingToken(token.rest);
      if (!commandToken) return trimmed;
      const { value: innerCommand } = stripSymmetricQuotes(commandToken.token);
      return innerCommand || trimmed;
    }

    // Non-wrapper-option token — not a wrapper.
    const normalized = getNormalizedShellToken(token.token);
    if (!isShellWrapperFlagToken(normalized)) {
      return trimmed;
    }

    rest = token.rest;
    if (shellWrapperFlagConsumesOperand(token.token)) {
      const operandToken = takeLeadingToken(rest);
      if (!operandToken) return trimmed;
      rest = operandToken.rest;
    }
  }
}

/**
 * Strip a single bare trailing `&` (bash background operator) from a
 * command string. Returns the input unchanged if the trailing form is
 * `&&` (logical AND), `\&` (escaped literal `&`), or there is no `&`
 * at the end at all.
 */
export function stripTrailingBackgroundAmp(command: string): string {
  const trimmed = command.trimEnd();
  if (!trimmed.endsWith('&')) return command;
  if (trimmed.endsWith('&&')) return command;
  if (trimmed.endsWith('\\&')) return command;
  return trimmed.slice(0, -1).trimEnd();
}

export function hasNonFinalTopLevelBackgroundOperator(
  command: string,
): boolean {
  let quote: '"' | "'" | '' = '';
  let escaped = false;
  let inBackticks = false;
  let commandSubstitutionDepth = 0;

  const previousNonWhitespace = (index: number): string | undefined => {
    for (let i = index - 1; i >= 0; i--) {
      const char = command[i];
      if (char !== undefined && !/\s/.test(char)) return char;
    }
    return undefined;
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;

    if (quote === "'") {
      if (char === "'") quote = '';
      continue;
    }

    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quote = '';
      }
      continue;
    }

    if (inBackticks) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '`') {
        inBackticks = false;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '`') {
      inBackticks = true;
      continue;
    }

    if (
      (char === '$' || char === '<' || char === '>') &&
      command[i + 1] === '('
    ) {
      commandSubstitutionDepth++;
      i++;
      continue;
    }

    if (char === ')' && commandSubstitutionDepth > 0) {
      commandSubstitutionDepth--;
      continue;
    }

    if (char !== '&' || commandSubstitutionDepth > 0) {
      continue;
    }

    const next = command[i + 1];
    const previous = previousNonWhitespace(i);
    if (
      next === '&' ||
      next === '>' ||
      previous === '&' ||
      previous === '>' ||
      previous === '<' ||
      previous === '|'
    ) {
      continue;
    }

    return command.slice(i + 1).trim().length > 0;
  }

  return false;
}

interface ParsedMonitorShellWrapper {
  wrapperTokens?: string[];
  innerCommand: string;
  innerQuote: '"' | "'" | '';
  innerArgsSuffix?: string;
}

export interface NormalizedMonitorCommand {
  analysisCommand: string;
  safetyCommand: string;
  spawnCommand: string;
  strippedTrailingAmp: boolean;
}

function takeLeadingToken(
  input: string,
): { token: string; rest: string } | null {
  const trimmed = input.trimStart();
  if (!trimmed) {
    return null;
  }

  let quote: '"' | "'" | '' = '';
  let escaped = false;
  let inBackticks = false;
  let commandSubstitutionDepth = 0;
  let idx = 0;

  while (idx < trimmed.length) {
    const char = trimmed[idx];
    if (!char) {
      break;
    }

    if (quote === "'") {
      if (char === "'") {
        quote = '';
      }
      idx++;
      continue;
    }

    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quote = '';
      }
      idx++;
      continue;
    }

    if (inBackticks) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '`') {
        inBackticks = false;
      }
      idx++;
      continue;
    }

    if (escaped) {
      escaped = false;
      idx++;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      idx++;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      idx++;
      continue;
    }

    if (char === '`') {
      inBackticks = true;
      idx++;
      continue;
    }

    if (
      (char === '$' || char === '<' || char === '>') &&
      trimmed[idx + 1] === '('
    ) {
      commandSubstitutionDepth++;
      idx += 2;
      continue;
    }

    if (char === ')' && commandSubstitutionDepth > 0) {
      commandSubstitutionDepth--;
      idx++;
      continue;
    }

    if (/\s/.test(char) && commandSubstitutionDepth === 0) {
      break;
    }

    idx++;
  }

  if (
    idx === 0 ||
    quote ||
    escaped ||
    inBackticks ||
    commandSubstitutionDepth
  ) {
    return null;
  }

  return {
    token: trimmed.slice(0, idx),
    rest: trimmed.slice(idx),
  };
}

function stripSymmetricQuotes(command: string): {
  value: string;
  quote: '"' | "'" | '';
} {
  const trimmed = command.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return {
      value: trimmed.substring(1, trimmed.length - 1),
      quote: trimmed[0] as '"' | "'",
    };
  }

  return { value: trimmed, quote: '' };
}

function getNormalizedShellToken(token: string): string {
  return stripSymmetricQuotes(token).value.replace(/\\/g, '/').toLowerCase();
}

function isEnvAssignmentToken(token: string): boolean {
  return ENV_ASSIGNMENT_REGEX.test(stripSymmetricQuotes(token).value);
}

function getShellWrapperBase(token: string): string | undefined {
  return getNormalizedShellToken(token).split('/').pop();
}

function isKnownMonitorWrapperToken(token: string): boolean {
  const base = getShellWrapperBase(token);
  return (
    base === 'sh' ||
    base === 'sh.exe' ||
    base === 'bash' ||
    base === 'bash.exe' ||
    base === 'zsh' ||
    base === 'zsh.exe' ||
    base === 'cmd' ||
    base === 'cmd.exe'
  );
}

function isShellWrapperFlagToken(normalizedToken: string): boolean {
  return (
    normalizedToken.startsWith('-') ||
    normalizedToken.startsWith('/') ||
    normalizedToken === '+o'
  );
}

function shellWrapperFlagConsumesOperand(token: string): boolean {
  const normalized = getNormalizedShellToken(token);
  return normalized === '-o' || normalized === '+o';
}

function isMonitorCommandMarker(wrapperToken: string, token: string): boolean {
  const base = getShellWrapperBase(wrapperToken);
  const normalized = getNormalizedShellToken(token);

  if (base === 'cmd' || base === 'cmd.exe') {
    return normalized === '/c';
  }

  return normalized === '-c' || /^-[a-z]*c[a-z]*$/i.test(normalized);
}

function parseMonitorShellWrapper(command: string): ParsedMonitorShellWrapper {
  const trimmed = command.trim();
  let rest = trimmed;
  const leadingEnvTokens: string[] = [];

  while (true) {
    const token = takeLeadingToken(rest);
    if (!token || !isEnvAssignmentToken(token.token)) {
      break;
    }
    leadingEnvTokens.push(token.token);
    rest = token.rest;
  }

  const wrapperToken = takeLeadingToken(rest);
  if (!wrapperToken || !isKnownMonitorWrapperToken(wrapperToken.token)) {
    return {
      innerCommand: trimmed,
      innerQuote: '',
    };
  }

  rest = wrapperToken.rest;
  const wrapperTokens = [...leadingEnvTokens, wrapperToken.token];

  while (true) {
    const token = takeLeadingToken(rest);
    if (!token) {
      return {
        innerCommand: trimmed,
        innerQuote: '',
      };
    }

    if (isMonitorCommandMarker(wrapperToken.token, token.token)) {
      wrapperTokens.push(token.token);
      const commandToken = takeLeadingToken(token.rest);
      if (!commandToken) {
        return {
          innerCommand: trimmed,
          innerQuote: '',
        };
      }
      const { value: innerCommand, quote: innerQuote } = stripSymmetricQuotes(
        commandToken.token,
      );
      return {
        wrapperTokens,
        innerCommand,
        innerQuote,
        innerArgsSuffix: commandToken.rest.trimStart(),
      };
    }

    const normalized = getNormalizedShellToken(token.token);
    if (!isShellWrapperFlagToken(normalized)) {
      return {
        innerCommand: trimmed,
        innerQuote: '',
      };
    }

    wrapperTokens.push(token.token);
    rest = token.rest;
    if (shellWrapperFlagConsumesOperand(token.token)) {
      const operandToken = takeLeadingToken(rest);
      if (!operandToken) {
        return {
          innerCommand: trimmed,
          innerQuote: '',
        };
      }
      wrapperTokens.push(operandToken.token);
      rest = operandToken.rest;
    }
  }
}

export function normalizeMonitorCommand(
  command: string,
): NormalizedMonitorCommand {
  const { wrapperTokens, innerCommand, innerQuote, innerArgsSuffix } =
    parseMonitorShellWrapper(command);
  const leadingEnvTokens =
    wrapperTokens?.filter((token) => isEnvAssignmentToken(token)) ?? [];
  const analysisCommand = stripTrailingBackgroundAmp(innerCommand);
  const rawInnerArgsSuffix = innerArgsSuffix?.trim() ?? '';
  const normalizedInnerArgsSuffix =
    stripTrailingBackgroundAmp(rawInnerArgsSuffix);
  // Permission safety focuses on command text that the shell may expand or
  // execute: leading env assignments, the -c script, and argv suffixes. Wrapper
  // flags are preserved in spawnCommand, but are not converted into Bash(...)
  // command-rule surface.
  const safetyParts = [
    ...(wrapperTokens ? leadingEnvTokens : []),
    analysisCommand,
    ...(normalizedInnerArgsSuffix ? [normalizedInnerArgsSuffix] : []),
  ];
  const safetyCommand =
    wrapperTokens && safetyParts.length > 0
      ? safetyParts.join(' ').trim()
      : analysisCommand;
  const strippedTrailingAmp =
    analysisCommand !== innerCommand ||
    normalizedInnerArgsSuffix !== rawInnerArgsSuffix;
  const spawnCommand = wrapperTokens
    ? [
        wrapperTokens.join(' '),
        innerQuote
          ? `${innerQuote}${analysisCommand}${innerQuote}`
          : analysisCommand,
        normalizedInnerArgsSuffix,
      ]
        .filter(Boolean)
        .join(' ')
    : analysisCommand;

  return {
    analysisCommand,
    safetyCommand,
    spawnCommand,
    strippedTrailingAmp,
  };
}

export function hasUnsafeMonitorBackgroundOperator(command: string): boolean {
  const { innerCommand, innerArgsSuffix } = parseMonitorShellWrapper(command);
  return (
    hasNonFinalTopLevelBackgroundOperator(innerCommand) ||
    hasNonFinalTopLevelBackgroundOperator(innerArgsSuffix ?? '')
  );
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
 * Checks a shell command against security policies and permission rules.
 *
 * Uses PermissionManager (via config.getPermissionManager()) to evaluate each
 * sub-command.  The function operates in two modes:
 *
 * 1.  **"Default Deny" Mode (sessionAllowlist is provided):** Used for
 *     user-defined scripts / custom commands. A command is only permitted if
 *     it is found in the allow rules OR the provided `sessionAllowlist`.
 *     Commands not explicitly allowed are treated as a soft denial.
 *
 * 2.  **"Default Allow" Mode (sessionAllowlist is NOT provided):** Used for
 *     direct tool invocations by the model. Commands with a 'deny' decision
 *     are hard-blocked; 'ask' requires confirmation; all others are allowed.
 *
 * @param command The shell command string to validate.
 * @param config The application configuration.
 * @param sessionAllowlist A session-level list of approved commands. Its
 *   presence activates "Default Deny" mode.
 * @returns An object detailing which commands are not allowed.
 */
export async function checkCommandPermissions(
  command: string,
  config: Config,
  sessionAllowlist?: Set<string>,
): Promise<{
  allAllowed: boolean;
  disallowedCommands: string[];
  blockReason?: string;
  isHardDenial?: boolean;
}> {
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

  const pm = config.getPermissionManager?.();

  // When PermissionManager is available, use PM-based evaluation.
  if (pm) {
    const disallowedCommands: string[] = [];

    for (const cmd of commandsToValidate) {
      // 1. Session allowlist always wins (checked first regardless of PM rules)
      if (sessionAllowlist) {
        invocation.params['command'] = cmd;
        const isSessionAllowed = doesToolInvocationMatch(
          'run_shell_command',
          invocation,
          [...sessionAllowlist].flatMap((c) =>
            SHELL_TOOL_NAMES.map((name) => `${name}(${c})`),
          ),
        );
        if (isSessionAllowed) continue;
      }

      const decision = await pm.isCommandAllowed(cmd);

      if (decision === 'deny') {
        return {
          allAllowed: false,
          disallowedCommands: [cmd],
          blockReason: `Command '${cmd}' is blocked by permission rules`,
          isHardDenial: true,
        };
      }

      if (decision === 'allow') continue;

      // 'ask' → always requires confirmation
      if (decision === 'ask') {
        disallowedCommands.push(cmd);
        continue;
      }

      // 'default': behaviour depends on mode
      if (sessionAllowlist !== undefined) {
        // Default Deny mode: unrecognised commands require confirmation
        disallowedCommands.push(cmd);
      }
      // Default Allow mode: not matched by any rule → allowed
    }

    if (disallowedCommands.length > 0) {
      return {
        allAllowed: false,
        disallowedCommands,
        blockReason: `Command(s) require confirmation. Disallowed commands: ${disallowedCommands.map((c) => JSON.stringify(c)).join(', ')}`,
        isHardDenial: false,
      };
    }

    return { allAllowed: true, disallowedCommands: [] };
  }

  // ── Legacy fallback (no PermissionManager) ──────────────────────────────
  // Used by SDK consumers that have not yet migrated to the permissions system,
  // or in unit tests that mock only getCoreTools/getPermissionsDeny.

  // 1. Blocklist Check (Highest Priority)
  const excludeTools = config.getPermissionsDeny() || [];
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

export async function isCommandAllowed(
  command: string,
  config: Config,
): Promise<{ allowed: boolean; reason?: string }> {
  // By not providing a sessionAllowlist, we invoke "default allow" behavior.
  const { allAllowed, blockReason } = await checkCommandPermissions(
    command,
    config,
  );
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

/**
 * Checks user arguments for potentially dangerous shell characters.
 * This is used to validate arguments before they are substituted into
 * shell command templates (e.g., $ARGUMENTS placeholder).
 *
 * Note: This does NOT remove outer quotes - it validates the raw input.
 * Use escapeShellArg() for safe shell argument escaping.
 *
 * @param args - The raw user arguments string
 * @returns Object with isSafe flag and list of dangerous patterns found
 */
export function checkArgumentSafety(args: string): {
  isSafe: boolean;
  dangerousPatterns: string[];
} {
  const dangerousPatterns: string[] = [];

  // Command substitution patterns
  if (args.includes('$(')) dangerousPatterns.push('$() command substitution');
  if (args.includes('`'))
    dangerousPatterns.push('backtick command substitution');
  if (args.includes('<(')) dangerousPatterns.push('<() process substitution');
  if (args.includes('>(')) dangerousPatterns.push('>() process substitution');

  // Command separators (outside of quotes)
  if (args.includes(';')) dangerousPatterns.push('; command separator');
  if (args.includes('|')) dangerousPatterns.push('| pipe');
  if (args.includes('&&')) dangerousPatterns.push('&& AND operator');
  if (args.includes('||')) dangerousPatterns.push('|| OR operator');

  // Background execution (space + &, with optional surrounding)
  if (args.includes(' &') || args.includes('& '))
    dangerousPatterns.push('& background operator');

  // Input/Output redirection
  if (args.includes('>') || args.includes('<')) {
    if (/>\s|\d>/.test(args)) dangerousPatterns.push('> output redirection');
    if (/<\s|\d</.test(args)) dangerousPatterns.push('< input redirection');
  }

  return {
    isSafe: dangerousPatterns.length === 0,
    dangerousPatterns,
  };
}

// ConPTY on Windows builds <= 19041 has known reliability issues (missing
// output, hangs). VS Code uses the same cutoff: microsoft/vscode#123725.
const CONPTY_MIN_WINDOWS_BUILD = 19042;

export function shouldDefaultToNodePty(): boolean {
  if (os.platform() !== 'win32') return true;
  const build = parseInt(os.release().split('.')[2] ?? '', 10);
  return !isNaN(build) && build >= CONPTY_MIN_WINDOWS_BUILD;
}
