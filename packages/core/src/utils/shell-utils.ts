/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyDeclarativeTool, AnyToolInvocation } from '../tools/tools.js';
import type { Config } from '../config/config.js';
import os from 'node:os';
import path from 'node:path';
import { parse, quote } from 'shell-quote';
import { isTool } from './is-tool.js';
import { isShellCommandReadOnly } from './shellReadOnlyChecker.js';
import {
  execFile,
  execFileSync,
  type ExecFileOptions,
} from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { resolveWorkspacePath } from './workspaceContext.js';

const SHELL_TOOL_NAMES = ['run_shell_command', 'ShellTool'];

/**
 * Checks if a tool invocation matches any of a list of patterns.
 *
 * @param toolOrToolName The tool object or the name of the tool being invoked.
 * @param invocation The invocation object for the tool.
 * @param patterns A list of patterns to match against.
 *   Patterns can be:
 *   - A tool name (e.g., "ReadFileTool") to match any invocation of that tool.
 *   - A tool name with a prefix (e.g., "ShellTool(git status)") to match
 *     invocations where the arguments start with that prefix.
 * @returns True if the invocation matches any pattern, false otherwise.
 */
export function doesToolInvocationMatch(
  toolOrToolName: AnyDeclarativeTool | string,
  invocation: AnyToolInvocation,
  patterns: string[],
): boolean {
  let toolNames: string[];
  if (isTool(toolOrToolName)) {
    toolNames = [toolOrToolName.name, toolOrToolName.constructor.name];
  } else {
    toolNames = [toolOrToolName as string];
  }

  if (toolNames.some((name) => SHELL_TOOL_NAMES.includes(name))) {
    toolNames = [...new Set([...toolNames, ...SHELL_TOOL_NAMES])];
  }

  for (const pattern of patterns) {
    const openParen = pattern.indexOf('(');

    if (openParen === -1) {
      // No arguments, just a tool name
      if (toolNames.includes(pattern)) {
        return true;
      }
      continue;
    }

    const patternToolName = pattern.substring(0, openParen);
    if (!toolNames.includes(patternToolName)) {
      continue;
    }

    if (!pattern.endsWith(')')) {
      continue;
    }

    const argPattern = pattern.substring(openParen + 1, pattern.length - 1);

    if (
      'command' in invocation.params &&
      toolNames.includes('run_shell_command')
    ) {
      const argValue = String(
        (invocation.params as { command: string }).command,
      );
      if (argValue === argPattern || argValue.startsWith(argPattern + ' ')) {
        return true;
      }
    }
  }

  return false;
}

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
 * The name the model should see for a shell: the executable a command
 * actually runs under, not the platform's usual shell. PowerShell is named by
 * its real executable so `pwsh` is not described as Windows PowerShell 5.1.
 */
export function getShellDisplayName({
  executable,
  shell,
}: ShellConfiguration): string {
  switch (shell) {
    case 'cmd':
      return 'cmd.exe';
    case 'powershell': {
      const basename = path.win32.basename(executable).toLowerCase();
      return basename === 'pwsh.exe' ? 'pwsh.exe' : 'powershell.exe';
    }
    case 'bash':
      return 'bash';
    default: {
      const _exhaustive: never = shell;
      return _exhaustive;
    }
  }
}

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
  let inBackticks = false;
  let substitutionDepth = 0;
  // Quote state of each enclosing level, saved on `$(` and restored on the
  // matching `)`, so a substitution body's quotes cannot leak outwards and the
  // surrounding quotes cannot mask the body's closing paren.
  const quoteStack: Array<{ single: boolean; double: boolean }> = [];
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

    // Inside single quotes the shell treats a backslash as a literal
    // character — it escapes nothing, so `'a\'` closes the quote. Consuming
    // the following character here would keep the parser "inside" the quote
    // and swallow every separator to the end of the line, hiding whole
    // commands from the permission checks that consume these segments.
    if (!inSingleQuotes && char === '\\' && i < command.length - 1) {
      currentCommand += char + command[i + 1];
      i += 2;
      continue;
    }

    if (!inSingleQuotes && char === '`') {
      inBackticks = !inBackticks;
    } else if (
      !inSingleQuotes &&
      !inBackticks &&
      char === '$' &&
      nextChar === '('
    ) {
      // A substitution body is quoted independently of its surroundings, so
      // save the enclosing quote state and start the body unquoted. `"$(...)"`
      // is the common case: the double quote belongs to the outer command and
      // must not make the body's `)` look quoted.
      quoteStack.push({ single: inSingleQuotes, double: inDoubleQuotes });
      inSingleQuotes = false;
      inDoubleQuotes = false;
      substitutionDepth++;
      currentCommand += '$(';
      i += 2;
      continue;
    } else if (
      !inBackticks &&
      substitutionDepth > 0 &&
      char === ')' &&
      !inSingleQuotes &&
      !inDoubleQuotes
    ) {
      // A quoted `)` inside the body is data, not the closing paren. Closing
      // on it ended the substitution early and left the body's closing quote
      // to flip the parser into "in quote" state, which then swallowed every
      // separator to the end of the line -- so `echo $(echo ')') ; rm -rf x`
      // came back as one segment with `rm` nowhere in it.
      const enclosing = quoteStack.pop();
      inSingleQuotes = enclosing?.single ?? false;
      inDoubleQuotes = enclosing?.double ?? false;
      substitutionDepth--;
    } else if (!inBackticks && char === "'" && !inDoubleQuotes) {
      // Tracked at every depth, not just the top level: without this the
      // quotes inside a substitution body are invisible and the `)` guard
      // above has nothing to test.
      inSingleQuotes = !inSingleQuotes;
    } else if (!inBackticks && char === '"' && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes;
    }

    if (
      !inSingleQuotes &&
      !inDoubleQuotes &&
      !inBackticks &&
      substitutionDepth === 0
    ) {
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
 * A parameter expansion standing in command position — `$VAR`, `"$VAR"`,
 * `${VAR}`, `"${VAR:-default}"`, `${VAR-default}` — resolved the way the shell
 * will resolve it at execution time.
 *
 * Without this, such a command had NO identifiable root: the tokenizer turns
 * the expansion into a non-string (or empty) token, `getCommandRoot` returns
 * undefined, and the shell tool hard-refuses the command before any approval
 * mode is consulted — including YOLO. Dogfooded live: the bundled /review
 * skill invokes every command as `"${QWEN_CODE_CLI:-qwen}" review …`, and each
 * run opened with "Could not identify command root to obtain permission from
 * user" until the model hand-resolved the variable itself.
 *
 * Resolution mirrors POSIX: `:-` substitutes the default when the variable is
 * unset OR empty; `-` only when unset. Quoting then decides what happens,
 * exactly as it does in the shell. A QUOTED expansion is one word: empty means
 * an empty command name, which has nothing to name and stays refusable. An
 * UNQUOTED expansion field-splits: an empty result is REMOVED and the next
 * token is the command (`$VAR printf OK` with VAR unset runs `printf`), and a
 * multi-word value's FIRST field is the command (`$VAR OK` with
 * VAR='/usr/bin/env printf' runs `env`). The environment consulted is this
 * process's own, which is what the spawned shell inherits.
 */
const PARAMETER_EXPANSION_COMMAND =
  /^("?)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))\1$/;

function resolveLeadingParameterExpansion(command: string): string | undefined {
  let rest = command;
  // Leading env assignments come first (`FOO=1 "${BAR:-baz}" …`), exactly as
  // the plain-token path below skips them.
  while (true) {
    const t = takeLeadingToken(rest);
    if (!t || !isEnvAssignmentToken(t.token)) break;
    rest = t.rest;
  }
  const head = takeLeadingToken(rest);
  if (!head) return undefined;
  const m = PARAMETER_EXPANSION_COMMAND.exec(head.token);
  if (!m) return undefined;
  const quoted = m[1] === '"';
  const name = (m[2] ?? m[5]) as string;
  const op = m[3];
  const value = process.env[name];
  const useDefault =
    op === undefined ? false : op === ':-' ? !value : value === undefined;
  const resolved = useDefault
    ? stripSymmetricQuotes(m[4] ?? '').value
    : (value ?? '');
  if (quoted) {
    // One word, splitting suppressed — empty is an empty command name.
    return resolved || undefined;
  }
  // Unquoted: the shell field-splits the expansion before command lookup.
  const fields = resolved.split(/[ \t\n]+/).filter(Boolean);
  if (fields.length === 0) {
    // The empty expansion is removed; the command is whatever follows it.
    const next = head.rest.trim();
    return next ? getCommandRoot(next) : undefined;
  }
  return fields[0];
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

  const expanded = resolveLeadingParameterExpansion(trimmedCommand);
  if (expanded !== undefined) {
    return expanded.split(/[\\/]/).pop();
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

/**
 * Trim the characters bash's lexer discards at a command edge — space, tab and
 * newline — plus a CR that is the first half of a CRLF pair. A lone CR is an
 * ordinary bash word character, as are VT, FF and NBSP, which
 * `String.prototype.trim` also strips; that deleted a redirection target before
 * op extraction (#11865).
 *
 * Two pointers rather than a `$`-anchored `g` regex: with the `g` flag the
 * engine retries the end-anchored alternative at every index, and inside an
 * interior whitespace run the greedy `+` unwinds one character at a time, so
 * the regex is quadratic there (~1.4 s at a 40 k run, ~3.2 s at 64 k) —
 * synchronously, on model-controlled input, inside the permission gate.
 */
function trimBashEdgeSeparators(command: string): string {
  let start = 0;
  let end = command.length;
  while (start < end) {
    const ch = command[start]!;
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      start++;
      continue;
    }
    if (ch === '\r' && command[start + 1] === '\n') {
      start++;
      continue;
    }
    break;
  }
  while (end > start) {
    const ch = command[end - 1]!;
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      end--;
      continue;
    }
    if (ch === '\r' && command[end] === '\n') {
      end--;
      continue;
    }
    break;
  }
  return command.slice(start, end);
}

/**
 * Decode the escapes an ANSI-C word (`$'…'`) applies, so a payload hidden
 * behind `\n` is analysed as the two commands bash runs.
 *
 * Bash decodes the simple escapes in `ANSI_C_SIMPLE`; an escape it does not
 * know keeps its backslash. Mapping
 * `\x3b` to `x` produced a word bash never runs (`--amendx3btrue`) while bash
 * ran `--amend; true`, so the numeric forms are decoded for real.
 *
 * Lives here rather than in `shell-semantics.ts` because the wrapper stripper
 * below needs the same decoder and shell-semantics already imports this module
 * (#16075 review, R11-2: importing back would create a cycle).
 */
const ANSI_C_SIMPLE: Record<string, string> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

export function decodeAnsiCEscape(
  body: string,
  index: number,
): { text: string; length: number; bytes?: number[] } | null {
  if (body[index] !== '\\' || index + 1 >= body.length) return null;
  const next = body[index + 1]!;
  const simple = ANSI_C_SIMPLE[next];
  if (simple !== undefined) {
    return { text: simple, bytes: [...Buffer.from(simple, 'utf8')], length: 2 };
  }
  if (next === 'x' || next === 'u' || next === 'U') {
    const max = next === 'x' ? 2 : next === 'u' ? 4 : 8;
    const digits = new RegExp(`^[0-9a-fA-F]{1,${max}}`).exec(
      body.slice(index + 2),
    )?.[0];
    if (digits) {
      const code = parseInt(digits, 16);
      const length = 2 + digits.length;
      // `String.fromCodePoint` throws above U+10FFFF, but bash does not reject
      // the word: it writes the four-byte encoding anyway (`printf %s
      // $'a\U00110000' | xxd -p` is `61f4908080`, exit 0, on bash 5.3.20). Emit
      // those bytes so the resolved word is the word the shell builds; above the
      // four-byte maximum there is nothing to encode, so the escape stays
      // literal rather than throwing out of the permission guard
      // (#16540 review, R3-3).
      if (next !== 'x' && code > 0x10ffff) {
        if (code > 0x1fffff) {
          return { text: body.slice(index, index + length), length };
        }
        return {
          text: body.slice(index, index + length),
          bytes: [
            0xf0 | (code >> 18),
            0x80 | ((code >> 12) & 0x3f),
            0x80 | ((code >> 6) & 0x3f),
            0x80 | (code & 0x3f),
          ],
          length,
        };
      }
      // bash writes BYTES for `\xHH` (and octal below); decoding each byte as
      // U+00xx turned a UTF-8 sequence into mojibake, so the byte is carried
      // alongside the legacy text form (#16540 review, R1-4).
      const bytes =
        next === 'x'
          ? [code & 0xff]
          : [...Buffer.from(String.fromCodePoint(code), 'utf8')];
      return {
        text:
          next === 'x' ? String.fromCharCode(code) : String.fromCodePoint(code),
        bytes,
        length,
      };
    }
  }
  // `\c` needs an operand letter. At the end of the word bash keeps `\c`
  // literal; when the tokenizer passes the raw command, the next character
  // is then the CLOSING quote, and consuming it as the operand left the
  // ANSI-C state open and swallowed the rest of the command line
  // (#16075 review, R8-2 / R10-1).
  if (next === 'c' && index + 2 < body.length && body[index + 2] !== "'") {
    const operand = body[index + 2]!;
    const code =
      operand === '?'
        ? 0x7f // `\c?` is DEL in bash, not the 0x1F mask (#16540 review, R1-6)
        : operand.toUpperCase().charCodeAt(0) & 0x1f;
    return { text: String.fromCharCode(code), bytes: [code], length: 3 };
  }
  if (next >= '0' && next <= '7') {
    const digits = /^[0-7]{1,3}/.exec(body.slice(index + 1))![0];
    const code = parseInt(digits, 8) & 0xff;
    return {
      text: String.fromCharCode(code),
      bytes: [code],
      length: 1 + digits.length,
    };
  }
  return null;
}

export function decodeAnsiCWord(body: string): string {
  // bash builds BYTES from an ANSI-C word and hands them to the program, so a
  // multi-byte UTF-8 sequence spelled `\xc3\xa9` is `é`, not `Ã©`
  // (#16540 review, R1-4). Literal characters and `\u`/`\U` code points are
  // encoded to bytes too, and the word is decoded as UTF-8 at the end.
  const bytes: number[] = [];
  const pushText = (text: string) => {
    for (const byte of Buffer.from(text, 'utf8')) bytes.push(byte);
  };
  for (let index = 0; index < body.length; index++) {
    const escape = decodeAnsiCEscape(body, index);
    if (!escape) {
      // Unknown escape: bash keeps the backslash and the letter. A literal
      // non-BMP character arrives as a surrogate pair, and encoding each UTF-16
      // unit on its own turns both halves into U+FFFD, so the decoded word is
      // not the word bash builds (#16540 review, R2-2).
      const codePoint = body.codePointAt(index)!;
      pushText(String.fromCodePoint(codePoint));
      if (codePoint > 0xffff) index++;
      continue;
    }
    // A NUL ends the word bash builds: `$'--\0x'` is the word `--`, so the
    // rest of THIS ANSI-C segment is dropped. The truncation stays inside the
    // segment — bash appends any following concatenation segment (`f $'a\0b'c`
    // is `ac`), and the caller decodes each segment separately (#16075 R11-2).
    if (escape.text === '\0') break;
    if (escape.bytes) bytes.push(...escape.bytes);
    else pushText(escape.text);
    // After `\c\` the operand backslash is consumed and the character it
    // escapes is LITERAL text, not a new escape: bash writes 61 1c 74 62 for
    // both `$'a\c\\tb'` and `$'a\c\tb'`, so the `t` is a `t` and not a TAB
    // (#16540 review, R3-3).
    if (
      escape.length === 3 &&
      body[index + 2] === '\\' &&
      index + 3 < body.length
    ) {
      let at = index + 3;
      // That literal character can itself be a backslash, which then escapes
      // the character after it: bash writes 61 1c 74 62 for BOTH `$'a\c\tb'`
      // and `$'a\c\\tb'`, so the extra backslash is consumed rather than
      // emitted (#16540 review, R3-3).
      if (body[at] === '\\' && at + 1 < body.length) at++;
      const codePoint = body.codePointAt(at)!;
      pushText(String.fromCodePoint(codePoint));
      index = at + (codePoint > 0xffff ? 1 : 0);
    } else {
      index += escape.length - 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The word a token denotes once the shell removes its quoting, so an option
 * terminator written `'--'`, `"--"`, `\--`, `$'--'`, `$"--"`, `$'\x2d\x2d'`
 * or the concatenation `-'-'` is the same word as `--` (#16075 review,
 * R6-1 / R8-11 / R11-2).
 *
 * Returns null when the word carries an expansion that cannot be resolved
 * statically (`$TERM`, `$(…)`, backticks) or an unterminated quote: the caller
 * must fail closed rather than hand the token on as a program word.
 *
 * Locale quoting `$"…"` does NOT decode ANSI-C escapes: bash translates the
 * body but keeps the backslashes, so `$"\x2d\x2d"` is the word `\x2d\x2d`
 * and never the terminator `--`. Witnessed on bash 5.3.20: `printf '%s'
 * $"\x2d\x2d"` prints `\x2d\x2d`, and `bash -c '$"\x2d\x2d"'` reports
 * `\x2d\x2d: command not found` — the program name keeps the backslashes, so
 * the word is treated like a double-quoted one (#16540 review, R3-12).
 */
interface QuoteRemovedWord {
  /** The word with quoting removed; expansion syntax is kept as literal text. */
  text: string;
  /** The word carries an expansion (`$…`, backtick) somewhere. */
  hasExpansion: boolean;
  /**
   * Every expansion introducer sits inside a quoted span, so the word is a
   * single fully quoted word (possibly a concatenation of quoted segments).
   * Such a word is still the `-c` payload even though its value is not static;
   * only an UNQUOTED expansion leaves the terminator position truly ambiguous
   * (#16075 review, R13-1).
   */
  fullyQuoted: boolean;
  /**
   * Reading the word needed a decode step — an ANSI-C `$'…'` / `$\<newline>'…'`
   * segment or a locale `$"…"` introducer — so `text` is a value the spelling
   * does not show. A plainly quoted word is false: its `text` is what quote
   * removal always gave, and callers that reconstruct a command from the
   * spelling must keep doing so (#16540 review, R4-6).
   */
  decoded: boolean;
}

/**
 * First index at or after `from` of `target` outside quotes and escapes, or -1.
 * A brace — or an operator — inside `'…'` / `"…"` / `$'…'` is data. Nested groups
 * are not matched (the first unquoted `}` wins), which only makes the callers
 * more conservative.
 */
function findUnquotedChar(token: string, from: number, target: string): number {
  let quote: '"' | "'" | '' = '';
  let ansiC = false;
  for (let i = from; i < token.length; i++) {
    const ch = token[i]!;
    if (quote === "'") {
      // Inside `$'…'` a backslash escapes the next character, so `\'` does not
      // close the word; in a plain `'…'` the backslash is literal. Reading both
      // the same way closed the word early and brace-expanded text that was
      // still quoted data (#16540 review, R3-5).
      if (ansiC && ch === '\\') {
        i++;
        continue;
      }
      if (ch === "'") {
        quote = '';
        ansiC = false;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') i++;
      else if (ch === '"') quote = '';
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      ansiC = ch === "'" && opensAnsiCQuote(token, i);
      continue;
    }
    if (ch === target) return i;
  }
  return -1;
}

/**
 * Whether the body of a brace group carries the separator bash needs to expand
 * it: an unquoted `,` (list) or `..` (sequence). A quoted separator is data.
 */
function hasBraceExpansionSeparator(braceBody: string): boolean {
  let quote: '"' | "'" | '' = '';
  for (let i = 0; i < braceBody.length; i++) {
    const ch = braceBody[i]!;
    if (quote === "'") {
      if (ch === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') i++;
      else if (ch === '"') quote = '';
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ',') return true;
    if (ch === '.' && braceBody[i + 1] === '.') return true;
  }
  return false;
}

/**
 * Quote removal that keeps expansion syntax as text and reports whether the
 * word is fully quoted. Returns null only on an unterminated quote/escape. The
 * option-terminator test reads the fail-closed projection (a word with any
 * expansion is not a resolved terminator); the wrapper unwrap also needs the
 * quoted-but-dynamic payload text so op extraction and the self-kill gate keep
 * seeing the script the shell runs (#16075 review, R13-1).
 */
function shellWordQuoteRemoval(token: string): QuoteRemovedWord | null {
  let out = '';
  let hasExpansion = false;
  let unquotedExpansion = false;
  let decoded = false;
  let i = 0;
  const n = token.length;
  while (i < n) {
    const ch = token[i]!;
    if (ch === "'") {
      // Single-quoted span: verbatim, no expansion, backslash is literal.
      const close = token.indexOf("'", i + 1);
      if (close === -1) return null;
      out += token.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (ch === '\\' && i + 1 < n) {
      // Unquoted escape: the next character is literal; a continuation
      // disappears outright.
      if (token[i + 1] === '\n') {
        i += 2;
        continue;
      }
      out += token[i + 1];
      i += 2;
      continue;
    }
    // `$\<newline>'…'` is still an ANSI-C word: the backslash-newline is
    // removed before the quote is read. Reading `token[i + 1]` directly missed
    // it, so the payload stayed a plain quoted word and the op extraction saw
    // nothing (#16540 review, R1-11).
    let ansiCStart = i + 1;
    while (
      ansiCStart + 1 < n &&
      token[ansiCStart] === '\\' &&
      token[ansiCStart + 1] === '\n'
    ) {
      ansiCStart += 2;
    }
    if (ch === '$' && ansiCStart < n && token[ansiCStart] === "'") {
      decoded = true;
      // ANSI-C word: escapes decode; find the first UNESCAPED closing quote.
      let j = ansiCStart + 1;
      let body = '';
      while (j < n) {
        if (token[j] === '\\' && j + 1 < n) {
          body += token.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (token[j] === "'") break;
        body += token[j];
        j++;
      }
      if (j >= n) return null; // unterminated
      out += decodeAnsiCWord(body);
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      // Double-quoted (or locale `$"…"`, whose introducer was consumed as an
      // expansion below) span: backslash is special only before $ ` " \ and
      // newline; everything else keeps both characters.
      i++;
      let closed = false;
      while (i < n) {
        const c = token[i]!;
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        if (c === '\\' && i + 1 < n) {
          const next = token[i + 1]!;
          if (next === '$' || next === '`' || next === '"' || next === '\\') {
            out += next;
            i += 2;
            continue;
          }
          if (next === '\n') {
            i += 2;
            continue;
          }
          out += c;
          i++;
          continue;
        }
        if (c === '$' || c === '`') hasExpansion = true;
        out += c;
        i++;
      }
      if (!closed) return null;
      continue;
    }
    if (ch === '$') {
      // Locale quoting: same escape rules as a double-quoted word, no ANSI-C
      // decoding. Re-enter the loop with the quote handled above. The introducer
      // can be split by a continuation — `$\<newline>"…"` is still locale
      // quoting, and reading `token[i + 1]` classified it as an unquoted
      // expansion, so the payload's writes were never analysed
      // (#16540 review, R3-4).
      if (ansiCStart < n && token[ansiCStart] === '"') {
        decoded = true;
        i = ansiCStart;
        continue;
      }
      // Parameter / command / arithmetic expansion: not statically resolvable.
      hasExpansion = true;
      unquotedExpansion = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '`') {
      hasExpansion = true;
      unquotedExpansion = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '{') {
      // Unquoted brace expansion turns ONE word into several: bash expands
      // `{--,'cat > /etc/motd'}` to `--` and the payload, so the token is not
      // the single literal word the static reading assumed. Treat it like an
      // unquoted `$X` and fail closed (#16540 review, R4-2). A QUOTED brace
      // word (`'{--,x}'`) is data and never reaches this branch.
      const close = findUnquotedChar(token, i + 1, '}');
      if (
        close !== -1 &&
        hasBraceExpansionSeparator(token.slice(i + 1, close))
      ) {
        hasExpansion = true;
        unquotedExpansion = true;
      }
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, hasExpansion, fullyQuoted: !unquotedExpansion, decoded };
}

/**
 * Expand a word carrying one unquoted brace group (`{a,b}`) into the words the
 * shell builds, each quote-removed. Prefix and suffix are re-attached to every
 * alternative, as bash expands the brace before quote removal — so
 * `{--,'cat > /etc/motd'}""` is still the option terminator plus the script.
 * Returns null when the group is not statically enumerable (nested group,
 * sequence range, dynamic alternative): the caller must then fail closed.
 *
 * Brace expansion runs before quote removal, so `{--,'cat > /etc/motd'}` is TWO
 * words (`--` and the script), not the single opaque word the static reading
 * used to hand back (#16540 review, R4-2).
 */
/** Whether a resolved word carries literal text besides its expansions. A word
 * that is nothing but expansion (`"$X"`, `"$(printf -- --)"`) can resolve to the
 * `--` terminator or to nothing, so it cannot be read as the script itself
 * (#16540 review, R4-4). */
function hasLiteralBeyondExpansions(text: string): boolean {
  const withoutExpansions = text.replace(
    /\$\{[^}]*\}|\$\([^)]*\)|\$[A-Za-z_@*#0-9?]+|`[^`]*`/g,
    '',
  );
  return withoutExpansions.trim().length > 0;
}

/** Widest brace product this scan enumerates before failing closed; only the
 * first word or two are ever read (#16540 review, R3-6). */
const BRACE_EXPANSION_WORD_LIMIT = 64;

function expandBraceWords(token: string): string[] | null {
  const trimmed = token.trim();
  // An unquoted operator ends the word before any expansion happens: bash reads
  // `{ls,cat>/tmp/p}` as the word `{ls,cat` plus a redirect, and truncates the
  // file. Modelled as a brace word the operator disappeared, `stripShellWrapper`
  // returned `ls`, and a write auto-allowed as read-only. Refuse to expand and
  // let the caller hand back the whole command (#16540 review, R4-3). Quoted
  // operators still expand: `{--,'cat > /etc/motd'}` is one word.
  for (const operator of ['>', '<', '|', ';', '&', '(', ')', '\n']) {
    if (findUnquotedChar(trimmed, 0, operator) !== -1) return null;
  }
  const open = findUnquotedChar(trimmed, 0, '{');
  if (open === -1) return null;
  const close = findUnquotedChar(trimmed, open + 1, '}');
  if (close === -1) return null;
  const body = trimmed.slice(open + 1, close);
  if (!hasBraceExpansionSeparator(body)) return null;
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | '' = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (quote !== '') {
      current += ch;
      if (ch === quote) quote = '';
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < body.length) {
      current += ch + body[i + 1]!;
      i += 2;
      continue;
    }
    if (ch === ',') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (quote !== '') return null;
  parts.push(current);
  if (parts.length < 2) return null;
  // Nested groups (cartesian expansion) are not enumerated.
  if (parts.some((part) => part.includes('{'))) return null;
  // Every group multiplies the word count, and only the first word (or the
  // second, behind a `--`) is ever read. Eighteen two-part groups in a
  // 98-character wrapper enumerated 2^18 words and blew the stack, so cap the
  // product and fail closed instead (#16540 review, R3-6).
  if (parts.length > BRACE_EXPANSION_WORD_LIMIT) return null;
  const prefix = trimmed.slice(0, open);
  const suffix = trimmed.slice(close + 1);
  const words: string[] = [];
  for (const part of parts) {
    const candidate = prefix + part + suffix;
    // A second group in the suffix expands too: `{a,b}{c,d}` is the cartesian
    // product in that order, and the first word is what the shell runs. Bailing
    // out here handed the whole command back unchanged, so the payload's
    // redirect stayed invisible (#16540 review, R3-6).
    const expanded = expandBraceWords(candidate);
    if (expanded !== null) {
      // One push at a time: spreading a large array passes it as arguments and
      // overflows the stack long before the work is done (#16540 review, R3-6).
      for (const word of expanded) {
        words.push(word);
        if (words.length > BRACE_EXPANSION_WORD_LIMIT) return null;
      }
      continue;
    }
    const removal = shellWordQuoteRemoval(candidate);
    if (removal === null || removal.hasExpansion) return null;
    // The recursion refused a candidate that still carries a group: that is the
    // cap above, not a leaf word, so the caller must fail closed rather than
    // analyse a literal brace word (#16540 review, R3-6).
    if (findUnquotedChar(candidate, 0, '{') !== -1) return null;
    words.push(removal.text);
    if (words.length > BRACE_EXPANSION_WORD_LIMIT) return null;
  }
  return words;
}

export function stripShellWrapper(command: string): string {
  const trimmed = trimBashEdgeSeparators(command);
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
      // `sh -c -- '…'` puts an option terminator before the command string;
      // reading it as the program handed the guard a lone `--`. Every quoting
      // of the same word (`'--'`, `"--"`, `\--`, `$'--'`, `$'\x2d\x2d'`,
      // `-'-'`) is still the terminator to the shell (#16075 review,
      // R6-1 / R11-2).
      let markerRest = token.rest;
      const terminator = takeLeadingToken(markerRest);
      const terminatorQuote = terminator
        ? shellWordQuoteRemoval(terminator.token)
        : null;
      const terminatorWord =
        terminatorQuote && !terminatorQuote.hasExpansion
          ? terminatorQuote.text
          : null;
      // A brace word expands into several words before the shell reads the
      // options: `bash -c {--,'cat > /etc/motd'}` is the option terminator
      // followed by the script, exactly like `bash -c -- 'cat > /etc/motd'`
      // (witnessed: `bash -c {--,'echo A-RAN'}` prints A-RAN). Handing the brace
      // word back as one literal word hid the payload's writes from op
      // extraction (#16540 review, R4-2). Brace expansion is POSIX-shell
      // syntax; cmd.exe / PowerShell only get their remaining tokens after /c
      // or -Command.
      const posixWrapper = !shellWrapperCommandConsumesRest(wrapperToken.token);
      const braceWords =
        posixWrapper && terminator ? expandBraceWords(terminator.token) : null;
      if (braceWords !== null) {
        const script = braceWords[0] === '--' ? braceWords[1] : braceWords[0];
        if (script) return script;
      }
      if (terminator && terminatorWord === '--') {
        markerRest = terminator.rest;
      } else if (terminator && terminatorWord === null) {
        // The word carries an expansion we cannot resolve (`sh -c $X 'cmd'`):
        // it may be the terminator (then 'cmd' is the payload) or the payload
        // itself (then 'cmd' is only $0). A single FULLY QUOTED word is still
        // the script the shell runs, so unwrap its quote-removed text — handing
        // back the whole command made every `stripShellWrapper(x) !== x`
        // consumer read the wrapper as wrapper-free and drop the payload's
        // writes / self-kill pattern (#16075 review, R13-1). An UNQUOTED
        // expansion (`sh -c $TERM 'ls -l'`) keeps handing back the whole
        // command; the monitor still scans it and the cron gate refuses it via
        // wrapperPayloadUnresolved.
        // …but only when the word carries literal content. A word that is
        // nothing but expansion (`"$X"`, `"$(printf -- --)"`) may itself resolve
        // to the terminator, and unwrapping it as the script dropped the real
        // payload — the write and the `pkill -f qwen` self-kill both vanished
        // (#16540 review, R4-4).
        if (
          terminatorQuote?.fullyQuoted &&
          hasLiteralBeyondExpansions(terminatorQuote.text)
        ) {
          return terminatorQuote.text || trimmed;
        }
        // The slot may be the terminator or may vanish, and in both readings the
        // word AFTER it is the script (`bash -c $(echo '--') 'cat > ~/.bashrc'`
        // writes the file; measured). Handing back the whole command left that
        // word inside quotes, so op extraction saw nothing and the self-kill gate
        // stayed silent (#16540 review, R4-5). The monitor path still marks the
        // wrapper unresolved, so the cron gate refuses it either way.
        const following = takeLeadingToken(terminator.rest);
        const followingQuote =
          following === null ? null : shellWordQuoteRemoval(following.token);
        if (followingQuote !== null && followingQuote.text !== '') {
          return followingQuote.text;
        }
        return trimmed;
      }
      const commandToken = takeLeadingToken(markerRest);
      if (!commandToken) return trimmed;
      // The same brace expansion can occupy the payload slot after an explicit
      // `--` (`bash -c -- {'cat > /etc/motd',x}` runs its first word): the
      // expansion's first word IS the script.
      const payloadBraceWords = posixWrapper
        ? expandBraceWords(commandToken.token)
        : null;
      if (payloadBraceWords !== null && payloadBraceWords[0]) {
        return payloadBraceWords[0];
      }
      const payloadQuote = shellWordQuoteRemoval(commandToken.token);
      const { value, quote } = stripSymmetricQuotes(commandToken.token);
      // An ANSI-C payload (`bash -c $'cat > /etc/motd'`) is the decoded text
      // the shell runs, not a quoted literal: handing back the `$'…'` spelling
      // made op extraction and the self-kill gate miss the payload
      // (#16540 review, R1-3).
      // Read the resolved word, not the spelling: a substring test on `$'`
      // missed both `$\<newline>'…'` and the locale form `$"…"`, so those
      // payloads came back raw and op extraction saw nothing (#16540 review,
      // R2-1).
      // Project the RESOLVED word whenever the token is fully quoted, expansion
      // or not: `-- "echo ${X}"' > /etc/motd'` resolves to a script whose `>`
      // sits outside every quoted span, and keeping the spelling meant op
      // extraction never saw the write. The terminator gate above keeps its own
      // `!hasExpansion` test, so an unresolvable `-c` slot still fails closed
      // (#16540 review, R4-6a).
      const innerCommand =
        payloadQuote !== null && payloadQuote.fullyQuoted
          ? payloadQuote.text
          : value;
      if (quote === '' && shellWrapperCommandConsumesRest(wrapperToken.token)) {
        return markerRest.trimStart() || trimmed;
      }
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

const SELF_KILL_PROCESS_PATTERN =
  /(^|[^a-z0-9_-])(node(?:\.exe)?|qwen(?:-code)?(?:\.exe)?)(?=$|[^a-z0-9_-])/i;
const QWEN_PROCESS_PATTERN =
  /(^|[^a-z0-9_-])qwen(?:-code)?(?:\.exe)?(?=$|[^a-z0-9_-])/i;
const TASKKILL_IMAGE_FILTER_PATTERN = /\bimagename\s+eq\s+(.+)$/i;

const SUDO_OPTIONS_WITH_VALUES = new Set([
  '-u',
  '--user',
  '-g',
  '--group',
  '-h',
  '--host',
  '-p',
  '--prompt',
  '-C',
  '--close-from',
  '-T',
  '--command-timeout',
]);

const COMMAND_OPTIONS_WITH_VALUES = new Set<string>();

const ENV_OPTIONS_WITH_VALUES = new Set([
  '-u',
  '--unset',
  '-S',
  '--split-string',
  '-C',
  '--chdir',
]);

const KILLALL_OPTIONS_WITH_VALUES = new Set([
  '-n',
  '--ns',
  '-o',
  '--older-than',
  '-s',
  '--signal',
  '-t',
  '--tty',
  '-u',
  '--user',
  '-y',
  '--younger-than',
  '-Z',
  '--context',
]);

const PKILL_OPTIONS_WITH_VALUES = new Set([
  '-F',
  '--pidfile',
  '-G',
  '--group',
  '-g',
  '--pgroup',
  '-P',
  '--parent',
  '-s',
  '--session',
  '-t',
  '--terminal',
  '-T',
  '--thread',
  '-U',
  '--uid',
  '-u',
  '--euid',
]);

const XARGS_OPTIONS_WITH_VALUES = new Set([
  '-I',
  '-n',
  '-P',
  '-s',
  '-E',
  '-d',
  '-L',
  '-l',
  '-a',
  '-J',
  '-R',
  '--replace',
  '--max-args',
  '--max-procs',
  '--max-chars',
  '--eof',
  '--delimiter',
  '--max-lines',
  '--arg-file',
]);

export const SHELL_SELF_KILL_REJECTION =
  'Blocked: this command may terminate the running qwen-code process because it targets all node/qwen-code processes. Use task_stop for managed background shells, or kill a specific PID instead.';

function parseShellSegment(segment: string): string[] | null {
  try {
    return parse(segment, (key) => '$' + key)
      .map((token) => {
        if (typeof token === 'string') {
          return token;
        }
        if (
          typeof token === 'object' &&
          token !== null &&
          'pattern' in token &&
          typeof token.pattern === 'string'
        ) {
          return token.pattern;
        }
        return null;
      })
      .filter((token): token is string => token !== null);
  } catch {
    return null;
  }
}

function normalizeExecutableName(token: string): string {
  const executable = token.split(/[\\/]/).pop() ?? token;
  return executable.toLowerCase().replace(/\.exe$/, '');
}

function isOptionToken(token: string): boolean {
  return token.startsWith('-');
}

function optionKey(token: string): string {
  return token.startsWith('--') ? token.toLowerCase() : token;
}

function optionHasInlineValue(token: string): boolean {
  return token.includes('=') || token.includes(':');
}

function shortOptionBundleHasFlag(token: string, flag: string): boolean {
  return (
    token.startsWith('-') &&
    !token.startsWith('--') &&
    token.length > 2 &&
    token.slice(1).toLowerCase().includes(flag.toLowerCase().slice(1))
  );
}

function matchesSelfProcessPattern(value: string): boolean {
  return SELF_KILL_PROCESS_PATTERN.test(value);
}

function matchesQwenProcessPattern(value: string): boolean {
  return QWEN_PROCESS_PATTERN.test(value);
}

function isBroadNodeFullPattern(value: string): boolean {
  const normalized = value
    .trim()
    .replace(/^(\^|\\b|\.\*)+/, '')
    .replace(/(\$|\\b|\.\*)+$/, '');
  const base = normalized.split(/[\\/]/).pop()?.toLowerCase();
  return (
    base === 'node' ||
    base === 'node.exe' ||
    /^node(?:\.exe)?[*?]+$/.test(base ?? '')
  );
}

function consumeOptionsWithValues(
  tokens: string[],
  startIndex: number,
  optionsWithValues: Set<string>,
): number {
  let index = startIndex;
  while (index < tokens.length) {
    const token = tokens[index]!;
    const normalized = optionKey(token);
    if (!isOptionToken(token)) {
      break;
    }

    index++;
    if (
      (optionsWithValues.has(normalized) ||
        [...optionsWithValues].some((option) =>
          shortOptionBundleHasFlag(token, option),
        )) &&
      !optionHasInlineValue(token)
    ) {
      index++;
    }
  }
  return index;
}

function unwrapExecutionPrefixes(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT_REGEX.test(tokens[index]!)) {
    index++;
  }

  while (index < tokens.length) {
    const root = normalizeExecutableName(tokens[index]!);
    if (root === 'sudo') {
      index = consumeOptionsWithValues(
        tokens,
        index + 1,
        SUDO_OPTIONS_WITH_VALUES,
      );
      continue;
    }

    if (root === 'command') {
      index = consumeOptionsWithValues(
        tokens,
        index + 1,
        COMMAND_OPTIONS_WITH_VALUES,
      );
      continue;
    }

    if (root === 'env') {
      index = consumeOptionsWithValues(
        tokens,
        index + 1,
        ENV_OPTIONS_WITH_VALUES,
      );
      while (
        index < tokens.length &&
        ENV_ASSIGNMENT_REGEX.test(tokens[index]!)
      ) {
        index++;
      }
      continue;
    }

    break;
  }

  return tokens.slice(index);
}

function getCommandSegments(command: string, depth = 0): string[] {
  const segments: string[] = [];
  for (const segment of splitCommands(command)) {
    const stripped = stripShellWrapper(segment);
    if (stripped !== segment && depth < 3) {
      segments.push(...getCommandSegments(stripped, depth + 1));
    } else if (stripped !== segment) {
      segments.push(stripped);
    } else {
      segments.push(segment);
    }
  }
  return segments;
}

function commandArguments(tokens: string[], optionsWithValues: Set<string>) {
  const args: string[] = [];
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '--') {
      args.push(...tokens.slice(index + 1));
      break;
    }

    const normalized = optionKey(token);
    if (isOptionToken(token)) {
      if (optionsWithValues.has(normalized) && !optionHasInlineValue(token)) {
        index++;
      }
      continue;
    }

    args.push(token);
  }
  return args;
}

function taskkillTargetsSelf(tokens: string[]): boolean {
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index]!;
    const normalized = token.toLowerCase();

    if (normalized === '/im' || normalized === '-im') {
      const imageName = tokens[index + 1];
      if (imageName && matchesSelfProcessPattern(imageName)) {
        return true;
      }
      index++;
      continue;
    }

    if (normalized.startsWith('/im:') || normalized.startsWith('-im:')) {
      if (matchesSelfProcessPattern(token.slice(4))) {
        return true;
      }
      continue;
    }

    if (normalized === '/fi' || normalized === '-fi') {
      const filter = tokens[index + 1];
      const imageName = filter?.match(TASKKILL_IMAGE_FILTER_PATTERN)?.[1];
      if (imageName && matchesSelfProcessPattern(imageName)) {
        return true;
      }
      index++;
      continue;
    }

    if (normalized.startsWith('/fi:') || normalized.startsWith('-fi:')) {
      const imageName = token
        .slice(4)
        .match(TASKKILL_IMAGE_FILTER_PATTERN)?.[1];
      if (imageName && matchesSelfProcessPattern(imageName)) {
        return true;
      }
    }
  }

  return false;
}

function killallTargetsSelf(tokens: string[]): boolean {
  return commandArguments(tokens, KILLALL_OPTIONS_WITH_VALUES).some((arg) =>
    matchesSelfProcessPattern(arg),
  );
}

function pkillTargetsSelf(tokens: string[]): boolean {
  let usesFullCommandLine = false;
  const args: string[] = [];
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '--') {
      args.push(...tokens.slice(index + 1));
      break;
    }

    const normalized = optionKey(token);
    if (
      normalized === '-f' ||
      normalized === '--full' ||
      shortOptionBundleHasFlag(token, '-f')
    ) {
      usesFullCommandLine = true;
      continue;
    }

    if (isOptionToken(token)) {
      if (
        PKILL_OPTIONS_WITH_VALUES.has(normalized) &&
        !optionHasInlineValue(token)
      ) {
        index++;
      }
      continue;
    }

    args.push(token);
  }

  if (usesFullCommandLine) {
    return args.some(
      (arg) => matchesQwenProcessPattern(arg) || isBroadNodeFullPattern(arg),
    );
  }

  return args.some((arg) => matchesSelfProcessPattern(arg));
}

function pgrepTargetsSelf(tokens: string[]): boolean {
  return pkillTargetsSelf(['pkill', ...tokens.slice(1)]);
}

function pgrepSubstitutionArgs(segment: string): string[] {
  let quote: '"' | "'" | '' = '';
  let escaped = false;
  const args: string[] = [];

  for (let index = 0; index < segment.length; index++) {
    const char = segment[index]!;

    if (quote === "'") {
      if (char === "'") quote = '';
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

    if (char === '"') {
      quote = quote === '"' ? '' : '"';
      continue;
    }

    if (char === "'" && quote === '') {
      quote = "'";
      continue;
    }

    if (char === '`') {
      let end = index + 1;
      let innerEscaped = false;
      for (; end < segment.length; end++) {
        const innerChar = segment[end]!;
        if (innerEscaped) {
          innerEscaped = false;
          continue;
        }
        if (innerChar === '\\') {
          innerEscaped = true;
          continue;
        }
        if (innerChar === '`') break;
      }
      if (end >= segment.length) {
        break;
      }

      const inner = segment.slice(index + 1, end).trim();
      const match = inner.match(/^pgrep\b(.*)$/i);
      if (match) {
        args.push(match[1] ?? '');
      }
      index = end;
      continue;
    }

    if (char !== '$' || segment[index + 1] !== '(') {
      continue;
    }

    const end = segment.indexOf(')', index + 2);
    if (end === -1) {
      break;
    }

    const inner = segment.slice(index + 2, end).trim();
    const match = inner.match(/^pgrep\b(.*)$/i);
    if (match) {
      args.push(match[1] ?? '');
    }
    index = end;
  }

  return args;
}

function killCommandTargetsSelf(segment: string): boolean {
  return pgrepSubstitutionArgs(segment).some((args) => {
    const parsed = parseShellSegment(`pgrep ${args}`);
    return parsed !== null && pgrepTargetsSelf(parsed);
  });
}

function xargsInvokesKill(segment: string | undefined): boolean {
  if (!segment) {
    return false;
  }
  const parsed = parseShellSegment(segment);
  if (!parsed) {
    return false;
  }
  const tokens = unwrapExecutionPrefixes(parsed);
  if (normalizeExecutableName(tokens[0] ?? '') !== 'xargs') {
    return false;
  }

  const commandTokens = unwrapExecutionPrefixes(
    commandArguments(tokens, XARGS_OPTIONS_WITH_VALUES),
  );
  const command = commandTokens.find((token) => !isOptionToken(token));
  return normalizeExecutableName(command ?? '') === 'kill';
}

export function detectSelfKillCommand(command: string): boolean {
  if (!/kill/i.test(command)) {
    return false;
  }

  const segments = getCommandSegments(command);
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    const parsed = parseShellSegment(segment);
    if (!parsed) {
      continue;
    }

    const tokens = unwrapExecutionPrefixes(parsed);
    if (tokens.length === 0) {
      continue;
    }

    const root = normalizeExecutableName(tokens[0]!);
    if (root === 'taskkill' && taskkillTargetsSelf(tokens)) {
      return true;
    }
    if (root === 'killall' && killallTargetsSelf(tokens)) {
      return true;
    }
    if (root === 'pkill' && pkillTargetsSelf(tokens)) {
      return true;
    }
    if (root === 'kill' && killCommandTargetsSelf(segment)) {
      return true;
    }
    if (root === 'pgrep' && pgrepTargetsSelf(tokens)) {
      for (let j = index + 1; j < segments.length; j++) {
        if (xargsInvokesKill(segments[j])) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Strip a single bare trailing `&` (bash background operator) from a
 * command string. Returns the input unchanged if the trailing form is
 * `&&` (logical AND), `\&` (escaped literal `&`), or there is no `&`
 * at the end at all.
 */
export function stripTrailingBackgroundAmp(command: string): string {
  // Escaped-ness is a parity question, not a one-character one: `x\\&` ends
  // with a literal backslash followed by a real operator, so only an ODD run of
  // backslashes escapes it (#16540 review, R3-7).
  if (!endsWithBackgroundAmp(command)) return command;
  return command.trimEnd().slice(0, -1).trimEnd();
}

/** The command the monitor spawns for a wrapper whose payload cannot be
 * resolved: the payload word verbatim, with the trailing background `&`
 * normalised away exactly as `stripTrailingBackgroundAmp` does above. Keeping
 * the `&` made the tracked shell fork the payload and exit before it, so
 * `settleFromExit(0)` completed the monitor and a failing payload read as
 * success (#16075 review, R13-1). */
function buildMonitorSpawnOverride(
  wrapperTokens: string[],
  payloadToken: string,
  rest: string,
): string {
  // Normalise the payload WORD, not the joined command: with a positional
  // argument after the payload (`bash -c "… &" arg0`) the `&` is no longer at
  // the end of the string, and the tracked shell still backgrounds the payload
  // (#16540 review, R1-1 second round).
  const suffix = stripTrailingBackgroundAmp(rest.replace(/^[ \t]+/, ''));
  return [
    wrapperTokens.join(' '),
    stripPayloadBackgroundAmp(payloadToken),
    suffix,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Strip the background `&` the monitored shell would run for the payload,
 * whether it sits just inside the payload's closing quote (`bash -c "tail -f
 * $LOG &"`), glued after it (`bash -c "$X"&`), or after the whole command.
 * `&&` and `\&` stay untouched, like `stripTrailingBackgroundAmp`
 * (#16540 review, R1-1). */
function stripPayloadBackgroundAmp(payloadToken: string): string {
  // Strip the payload's own background `&` from its script text: spaced before
  // the closing quote (`"… &"`), glued after it (`"…"&`), or behind an unquoted
  // prefix (`x"$Y &"`). `&&` and `\&` are not background operators, and an `&`
  // that ends a NESTED quoted word (`"echo $X '&'"`) is script data — the
  // trimming below only fires when the last non-space character of the script
  // text is the bare operator (#16540 review, R1-1 second round / R4-1).
  const trimmed = payloadToken.trimEnd();
  // Decide from the RESOLVED script text, never from the spelling. Inside `"…"`
  // a `\\` is one literal backslash, so `"echo a \\&"` resolves to `echo a \&`
  // whose `&` is escaped data; parity read off the raw token saw an even run,
  // stripped the `&` and handed the monitor a command the user never wrote
  // (#16540 review, R4-9).
  const removal = shellWordQuoteRemoval(trimmed);
  const text = removal === null ? trimmed : removal.text;
  if (!endsWithBackgroundAmp(text)) return trimmed;
  // And strip at most ONE operator. `$'cat /tmp/x & &'` is a script bash refuses
  // to parse (exit 2, loudly); trimming both turned it into a runnable command
  // that backgrounds and exits 0, i.e. a failure the monitor reports as success.
  // Leave such a payload exactly as the user wrote it and let the caller fail
  // closed (#16540 review, R4-8).
  if (endsWithBackgroundAmp(stripTrailingBackgroundAmp(text))) return trimmed;
  // Anchored at the END of the token, not at its start: an unquoted prefix
  // (`bash -c x"$Y &"`) still closes with a quoted span whose `&` is the
  // background operator the tracked shell runs. Leaving it in made the shell
  // fork the payload and exit before it, so the monitor saw rc 0 for a failing
  // payload (#16540 review, R4-1).
  const closing = /[ \t]*&[ \t]*(["'])$/.exec(trimmed);
  if (closing === null) return stripTrailingBackgroundAmp(trimmed);
  const ampIndex = closing.index + closing[0].indexOf('&');
  if (ampIndex > 0 && trimmed[ampIndex - 1] === '&') return trimmed;
  return `${trimmed.slice(0, closing.index).trimEnd()}${closing[1]}`;
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
  /**
   * A shell wrapper was recognized, but the word after `-c` carries an
   * expansion that cannot be resolved statically, so the whole command is
   * handed back for scanning instead of a payload (#16075 review, R11-2).
   * The monitor still scans everything; a consumer that reads "normalization
   * left this command unchanged" as "this is not a wrapper" (the cron gate)
   * must not: the shell runs the glued script while the rules read raw text.
   */
  wrapperPayloadUnresolved?: boolean;
  /**
   * Spawn this exact text instead of reconstructing it from the wrapper tokens
   * and the quote-removed payload. Set when the payload word is a fully quoted
   * word with a dynamic value: the analysis reads the quote-removed script, but
   * re-quoting a mixed concatenation faithfully is not possible, so the monitor
   * spawns the command exactly as written (#16075 review, R13-1).
   */
  spawnOverride?: string;
}

export interface NormalizedMonitorCommand {
  analysisCommand: string;
  safetyCommand: string;
  spawnCommand: string;
  strippedTrailingAmp: boolean;
  /** See {@link ParsedMonitorShellWrapper.wrapperPayloadUnresolved}. */
  wrapperPayloadUnresolved?: boolean;
}

/**
 * True when the quote at `quoteIndex` opens an ANSI-C word: `$'…'`, or
 * `$\<newline>'…'`, where the continuation is removed before the quote is read
 * (#16540 review, R1-11 spells the same shape for quote removal).
 */
function opensAnsiCQuote(token: string, quoteIndex: number): boolean {
  let j = quoteIndex - 1;
  while (j >= 1 && token[j] === '\n' && token[j - 1] === '\\') j -= 2;
  return j >= 0 && token[j] === '$';
}

function takeLeadingToken(
  input: string,
): { token: string; rest: string } | null {
  const trimmed = input.trimStart();
  if (!trimmed) {
    return null;
  }

  let quote: '"' | "'" | '' = '';
  // `$'…'` is not a plain single-quoted word: `\'` is an escaped quote rather
  // than the close, so scanning for the first `'` cut the token in half and the
  // payload never reached op extraction or the self-kill gate (#16540 review,
  // R2-3). A plain `'…'` still closes at its first quote.
  let ansiCQuote = false;
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
      if (ansiCQuote) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === "'") {
          quote = '';
          ansiCQuote = false;
        }
        idx++;
        continue;
      }
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
      ansiCQuote = char === "'" && opensAnsiCQuote(trimmed, idx);
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
    base === 'cmd.exe' ||
    base === 'powershell' ||
    base === 'powershell.exe' ||
    base === 'pwsh' ||
    base === 'pwsh.exe'
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
  if (optionHasInlineValue(token)) {
    return false;
  }
  return (
    normalized === '-o' ||
    normalized === '+o' ||
    normalized === '-executionpolicy' ||
    normalized === '-file' ||
    normalized === '-encodedcommand'
  );
}

function shellWrapperCommandConsumesRest(wrapperToken: string): boolean {
  const base = getShellWrapperBase(wrapperToken);
  // POSIX shells pass exactly one argument after -c as the command string.
  // cmd.exe and PowerShell treat the remaining tokens after /c or -Command as
  // the command, so unquoted inner commands need the full rest of the line.
  return (
    base === 'cmd' ||
    base === 'cmd.exe' ||
    base === 'powershell' ||
    base === 'powershell.exe' ||
    base === 'pwsh' ||
    base === 'pwsh.exe'
  );
}

function isMonitorCommandMarker(wrapperToken: string, token: string): boolean {
  const base = getShellWrapperBase(wrapperToken);
  const normalized = getNormalizedShellToken(token);

  if (base === 'cmd' || base === 'cmd.exe') {
    return normalized === '/c';
  }

  if (
    base === 'powershell' ||
    base === 'powershell.exe' ||
    base === 'pwsh' ||
    base === 'pwsh.exe'
  ) {
    return normalized === '-command' || normalized === '-c';
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
  const posixWrapper = !shellWrapperCommandConsumesRest(wrapperToken.token);

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
      // Same option-terminator reading as stripShellWrapper: every spelling
      // of `--` (quotes, ANSI-C escapes, concatenation) hands `-c` the NEXT
      // word (#16075 review, R6-1 / R11-2). An unresolvable expansion there
      // may be the terminator or the program itself; neither reading is
      // provable, so hand back the whole command rather than pick one.
      let markerRest = token.rest;
      const terminator = takeLeadingToken(markerRest);
      const terminatorQuote = terminator
        ? shellWordQuoteRemoval(terminator.token)
        : null;
      const terminatorWord =
        terminatorQuote && !terminatorQuote.hasExpansion
          ? terminatorQuote.text
          : null;
      if (terminator && terminatorWord === null) {
        // A fully quoted word with a dynamic value is still the script: expose
        // its quote-removed text for the safety scan and the monitor predicates
        // while keeping the unresolved flag so the cron gate refuses it, and
        // spawn the command exactly as written (#16075 review, R13-1). An
        // unquoted expansion keeps handing back the whole command.
        if (terminatorQuote?.fullyQuoted) {
          return {
            wrapperTokens,
            innerCommand: terminatorQuote.text,
            innerQuote: '',
            innerArgsSuffix: terminator.rest.replace(/^[ \t]+/, ''),
            wrapperPayloadUnresolved: true,
            spawnOverride: buildMonitorSpawnOverride(
              wrapperTokens,
              terminator.token,
              terminator.rest,
            ),
          };
        }
        return {
          innerCommand: trimmed,
          innerQuote: '',
          wrapperPayloadUnresolved: true,
        };
      }
      if (terminator && terminatorWord === '--') {
        wrapperTokens.push(terminator.token);
        markerRest = terminator.rest;
      }
      const commandToken = takeLeadingToken(markerRest);
      if (!commandToken) {
        // `sh -c --` with no script after it: the shell does not run an empty
        // program, it refuses outright — `bash -c --` and `sh -c --` both exit 2
        // with "option requires an argument" and run nothing (witnessed on bash
        // 5.3.20). There is still no payload this scan can read, so the cron gate
        // keeps refusing it (#16540 review, R1-7; rationale corrected by R3-11).
        return {
          innerCommand: trimmed,
          innerQuote: '',
          wrapperPayloadUnresolved: true,
        };
      }
      // The payload after `--` goes through the SAME resolution as the one
      // before it: an expansion may be the script or may assemble it, so it
      // fails closed instead of being analysed as literal text
      // (#16540 review, R1-2).
      const payloadRemoval = shellWordQuoteRemoval(commandToken.token);
      // Read the resolved word, not the spelling. `$"…"` (locale) and
      // `$\<newline>'…'` decode to the script bash runs exactly like `$'…'`, and
      // a substring test on `$'` left those two as raw text, so the writes bash
      // performs never reached analysisCommand / safetyCommand
      // (#16540 review, R2-4). Testing the FIRST CHARACTER for a quote is the
      // same mistake from the other side: `"echo x"$'\n'"rm -rf /tmp/target"`
      // starts with `"`, still needs decoding, and the raw fallback let
      // `stripSymmetricQuotes` delete only the outer characters — the decoded
      // newline vanished, `rm -rf` classified read-only and auto-allowed with no
      // prompt (#16540 review, R4-6b). `decoded` is the resolved-word property
      // both spellings share; a plainly quoted word keeps the path below, where
      // quote removal and stripSymmetricQuotes already agree.
      const payloadIsAnsiC =
        payloadRemoval !== null &&
        !payloadRemoval.hasExpansion &&
        payloadRemoval.fullyQuoted &&
        payloadRemoval.decoded;
      if (payloadRemoval?.hasExpansion) {
        if (payloadRemoval.fullyQuoted) {
          return {
            wrapperTokens,
            innerCommand: payloadRemoval.text,
            innerQuote: '',
            innerArgsSuffix: commandToken.rest.replace(/^[ \t]+/, ''),
            wrapperPayloadUnresolved: true,
            spawnOverride: buildMonitorSpawnOverride(
              wrapperTokens,
              commandToken.token,
              commandToken.rest,
            ),
          };
        }
        return {
          innerCommand: trimmed,
          innerQuote: '',
          wrapperPayloadUnresolved: true,
        };
      }
      const { value: innerCommand, quote: innerQuote } = stripSymmetricQuotes(
        commandToken.token,
      );
      // A trailing `&` inside a double-quoted payload is escaped DATA when the
      // resolved word says so: `"echo a \\&"` is the script `echo a \&`. The
      // analysis strip below reads the spelling, saw an even backslash run and
      // rewrote the monitored command into bytes the user never wrote
      // (#16540 review, R4-9). Hand analysis the resolved text and pin the spawn
      // to the command as written.
      if (
        innerQuote === '"' &&
        payloadRemoval !== null &&
        !payloadRemoval.hasExpansion &&
        payloadRemoval.text !== innerCommand &&
        endsWithBackgroundAmp(innerCommand) &&
        !endsWithBackgroundAmp(payloadRemoval.text)
      ) {
        return {
          wrapperTokens,
          innerCommand: payloadRemoval.text,
          innerQuote: '',
          innerArgsSuffix: commandToken.rest.replace(/^[ \t]+/, ''),
          spawnOverride: buildMonitorSpawnOverride(
            wrapperTokens,
            commandToken.token,
            commandToken.rest,
          ),
        };
      }
      // A payload with an UNQUOTED prefix (`x"exit 1 &"`) is not symmetric, so
      // the reconstruction below would keep it verbatim — including the
      // background `&` its closing quote holds. Build the spawn from the token
      // itself so the operator is normalised away while the user's quoting
      // stays (#16540 review, R4-1).
      const backgroundAmpBehindPrefix =
        posixWrapper &&
        payloadRemoval !== null &&
        innerQuote === '' &&
        !/^["']/.test(commandToken.token) &&
        stripPayloadBackgroundAmp(commandToken.token) !== commandToken.token;
      // Decide from the RESOLVED payload, not from the spelling: a payload whose
      // quote-removed text ends in a real operator backgrounds whatever the
      // token looks like (`"exit 1"' &'` is two quoted parts, so neither the
      // prefix rule nor the ANSI-C rule caught it) (#16540 review, R3-7).
      const payloadEndsInBackgroundOperator =
        posixWrapper &&
        payloadRemoval !== null &&
        !payloadRemoval.hasExpansion &&
        endsWithBackgroundAmp(payloadRemoval.text);
      // Some spellings cannot be trimmed at all: an encoded operator
      // (`$'exit 1 \x26'`) has no literal `&` in the token, and `"exit 1 &"&`
      // resolves to a trailing `&&`. Refuse to certify those instead of
      // reporting a strip that did not happen — the tracked shell would fork the
      // payload and exit 0, and settleFromExit(0) would call it success
      // (#16540 review, R3-7).
      const trimmedPayloadRemoval = shellWordQuoteRemoval(
        stripPayloadBackgroundAmp(commandToken.token),
      );
      const payloadAmpUnremovable =
        posixWrapper &&
        trimmedPayloadRemoval !== null &&
        !trimmedPayloadRemoval.hasExpansion &&
        resolvedTextBackgrounds(trimmedPayloadRemoval.text);
      // An ANSI-C payload is the decoded text for op extraction and the
      // self-kill gate, while the command still spawns as written
      // (#16540 review, R1-3).
      const decodedPayload =
        payloadIsAnsiC && payloadRemoval ? payloadRemoval.text : innerCommand;
      return {
        wrapperTokens,
        innerCommand:
          backgroundAmpBehindPrefix && payloadRemoval
            ? payloadRemoval.text
            : decodedPayload,
        innerQuote:
          payloadIsAnsiC || backgroundAmpBehindPrefix ? '' : innerQuote,
        // Blanks only: a newline right after the script separates the
        // next command, which the script's positional words are not.
        innerArgsSuffix: commandToken.rest.replace(/^[ \t]+/, ''),
        ...(payloadAmpUnremovable ? { wrapperPayloadUnresolved: true } : {}),
        ...(payloadIsAnsiC ||
        backgroundAmpBehindPrefix ||
        payloadEndsInBackgroundOperator
          ? {
              spawnOverride: buildMonitorSpawnOverride(
                wrapperTokens,
                commandToken.token,
                commandToken.rest,
              ),
            }
          : {}),
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
  const {
    wrapperTokens,
    innerCommand,
    innerQuote,
    innerArgsSuffix,
    wrapperPayloadUnresolved,
    spawnOverride,
  } = parseMonitorShellWrapper(command);
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
  const spawnCommand =
    spawnOverride ??
    (wrapperTokens
      ? [
          wrapperTokens.join(' '),
          innerQuote
            ? `${innerQuote}${analysisCommand}${innerQuote}`
            : analysisCommand,
          normalizedInnerArgsSuffix,
        ]
          .filter(Boolean)
          .join(' ')
      : analysisCommand);

  return {
    analysisCommand,
    safetyCommand,
    spawnCommand,
    strippedTrailingAmp,
    ...(wrapperPayloadUnresolved ? { wrapperPayloadUnresolved: true } : {}),
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
 * Whether `command` runs nothing but comments: every line blank or a `#`
 * comment, or a shell wrapper whose script does (checked the same way, so
 * nested wrappers too) with nothing after that script. Anything after the
 * script (`bash -c '# x' && echo hi`) may run, so it counts as a command;
 * plain words there are the script's positional parameters. Explicit no-ops
 * such as `true` and `:` are commands. Best-effort: a wrapper behind a
 * prefix (`nohup bash -c '# x'`) is not looked into.
 */
export function runsOnlyComments(command: string): boolean {
  const { wrapperTokens, innerCommand, innerArgsSuffix } =
    parseMonitorShellWrapper(command);
  if (wrapperTokens) {
    const suffix = innerArgsSuffix ?? '';
    // A newline right after the script starts the next command: both must
    // run only comments.
    if (/^\r?\n/.test(suffix)) {
      return (
        runsOnlyComments(innerCommand) &&
        runsOnlyComments(suffix.replace(/^\r?\n/, ''))
      );
    }
    // Words after the script are its positional parameters, which run
    // nothing; an operator there (`&& echo hi`, `; …`) runs more.
    return !/[;&|()\n`]|\$\(/.test(suffix) && runsOnlyComments(innerCommand);
  }
  return command.split('\n').every((line) => /^\s*(#|$)/.test(line));
}

/**
 * Whether a command backgrounds any part of itself with `&`: anywhere at its
 * top level, at its end, or inside a script it hands to a shell wrapper —
 * also a wrapper behind a prefix `normalizeMonitorCommand` does not unwrap
 * (`nohup bash -c './probe.sh &'`, `sudo -u ci bash -c …`, `env FOO=1 bash
 * -c …`). Nested scripts are checked the same way. An `&` inside a quoted
 * argument that is not a shell script (`gh api 'pulls?a=1&b=2'`) or escaped
 * at the end (`echo done \&`) does not count.
 *
 * The check is lexical and errs toward refusing. Each level is read twice,
 * with comments and without, and an `&` either reading finds counts: a
 * quote inside a comment cannot hide a later `&`, and neither can a `#` the
 * comment rule misreads inside `$(…)`, `$'…'` or an escaped wrapper quote.
 * So an `&` inside a comment, in a heredoc body, in `(( … ))`, or escaped
 * inside a double-quoted wrapper script is refused too.
 */
export function backgroundsAnyPart(command: string): boolean {
  return (
    backgroundsAtLevel(command, true) || backgroundsAtLevel(command, false)
  );
}

/** One reading of {@link backgroundsAnyPart} at this level; scripts it
 * hands to a wrapper are read both ways again. */
function backgroundsAtLevel(command: string, dropComments: boolean): boolean {
  const read = (text: string) =>
    dropComments ? stripShellComments(text) : text;
  const text = read(command);
  const { wrapperTokens, innerCommand, innerArgsSuffix } =
    parseMonitorShellWrapper(text);
  for (const part of [innerCommand, innerArgsSuffix ?? '']) {
    const code = read(part);
    if (
      hasNonFinalTopLevelBackgroundOperator(code) ||
      endsWithBackgroundAmp(code)
    ) {
      return true;
    }
  }
  if (wrapperTokens) return backgroundsAnyPart(innerCommand);
  // Not a wrapper at the head: look for one further along. Each recursion
  // only enters a wrapper's script, which is shorter than the command.
  let rest = takeLeadingToken(text)?.rest ?? '';
  for (
    let token = takeLeadingToken(rest);
    token;
    token = takeLeadingToken(rest)
  ) {
    if (
      parseMonitorShellWrapper(rest).wrapperTokens &&
      backgroundsAnyPart(rest)
    ) {
      return true;
    }
    rest = token.rest;
  }
  return false;
}

/**
 * Whether `command` ends with an `&` that backgrounds it: not the second half
 * of `&&`, and not escaped by an odd run of backslashes (`\&` is a literal
 * ampersand; `\\&` is a literal backslash, then a backgrounding `&`).
 */
/**
 * Whether the resolved script text ends in something that backgrounds the
 * payload: a real (parity-checked) `&`, or a trailing `&&` — which is either a
 * syntax error or two operators concatenated across a quote boundary
 * (`"exit 1 &"&` resolves to `exit 1 &&`). Both make the tracked shell exit
 * before the payload's own status is known (#16540 review, R3-7).
 */
function resolvedTextBackgrounds(text: string): boolean {
  const trimmed = text.trimEnd();
  return endsWithBackgroundAmp(trimmed) || trimmed.endsWith('&&');
}

function endsWithBackgroundAmp(command: string): boolean {
  const text = command.trimEnd();
  if (!text.endsWith('&') || text.endsWith('&&')) return false;
  let backslashes = 0;
  for (let at = text.length - 2; at >= 0 && text[at] === '\\'; at--) {
    backslashes++;
  }
  return backslashes % 2 === 0;
}

/**
 * `command` without its comments: a `#` that starts a word outside quotes
 * runs to the end of its line. Quotes and backslash escapes are tracked, so
 * `'#'`, `"a # b"`, `a\#b`, `$#` and `${#v}` stay.
 */
function stripShellComments(command: string): string {
  let out = '';
  let quote: "'" | '"' | '' = '';
  for (let at = 0; at < command.length; at++) {
    const char = command[at]!;
    if (quote === "'") {
      out += char;
      if (char === "'") quote = '';
      continue;
    }
    if (char === '\\') {
      out += char + (command[at + 1] ?? '');
      at++;
      continue;
    }
    if (quote === '"') {
      out += char;
      if (char === '"') quote = '';
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      continue;
    }
    if (char === '#' && (at === 0 || /[\s;&|()<>]/.test(command[at - 1]!))) {
      const end = command.indexOf('\n', at);
      if (end < 0) break;
      at = end - 1;
      continue;
    }
    out += char;
  }
  return out;
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
      if (nextChar === '\n' && command[i - 1] === '$') {
        let dollarStart = i - 1;
        while (dollarStart > 0 && command[dollarStart - 1] === '$') {
          dollarStart--;
        }
        let escapeStart = dollarStart;
        while (escapeStart > 0 && command[escapeStart - 1] === '\\') {
          escapeStart--;
        }
        if (
          (i - dollarStart) % 2 === 1 &&
          (dollarStart - escapeStart) % 2 === 0 &&
          command[i + 2] === '('
        ) {
          return true;
        }
      }
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

      if (
        char === '$' &&
        nextChar === '{' &&
        /^\$\{[A-Za-z_][A-Za-z0-9_]*@P\}/.test(command.slice(i))
      ) {
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
 * User-facing warning emitted when a shell-tool invocation contains
 * command substitution (`$(...)`, backticks, `<(...)`, `>(...)`, or
 * `${parameter@P}`).
 * Shared across the shell-tool and monitor-tool confirmation paths so
 * the wording can't drift between sites — see #4386 review (round 3).
 */
export const COMMAND_SUBSTITUTION_WARNING =
  'Contains command substitution ($(...), backticks, <(...), >(...), or ${parameter@P}).';

/**
 * Single dual-check predicate: does the command contain shell command
 * substitution either as written (raw) or after `stripShellWrapper`
 * unwraps it? The raw check catches substitution that lives inside
 * leading env-prefix tokens (e.g. `FOO=$(curl evil) bash -c 'echo ok'`,
 * where stripShellWrapper discards the env-prefix AND unwraps to
 * `echo ok`, leaving no trace of the substitution). The stripped
 * check catches substitution inside the wrapper's quoted body
 * (e.g. `bash -c 'echo $(cat secret)'`, where the raw `$(` sits inside
 * outer single quotes and is invisible to a raw-only check).
 *
 * Used by `buildShellExecWarnings` (UI warning surface),
 * `shouldAuditSubstitutionBypass` (audit log gate), and the
 * pre-AST gates in `ShellToolInvocation.getDefaultPermission`,
 * `MonitorToolInvocation.getDefaultPermission`, and
 * `PermissionManager.resolveDefaultPermission`. Centralising the
 * dual-check here keeps detection semantics in lockstep across all
 * surfaces (a change here propagates to every consumer). See PR #4386
 * round 6 for the env-prefix wrapper regression that motivated this.
 */
export function hasShellSubstitution(rawCommand: string): boolean {
  if (typeof rawCommand !== 'string' || rawCommand.length === 0) return false;
  if (detectCommandSubstitution(rawCommand)) return true;
  const stripped = stripShellWrapper(rawCommand);
  return stripped !== rawCommand && detectCommandSubstitution(stripped);
}

/**
 * Build the warnings array for a shell-like tool's exec confirmation.
 * Returns `undefined` when nothing to flag — callers should only assign
 * the `warnings` field when the result is truthy, mirroring the
 * existing `if (warnings.length > 0)` pattern at each call site.
 *
 * Delegates the detection logic to `hasShellSubstitution` so the
 * dual-check semantics stay in one place; the historical 2-arg
 * signature is kept for callers that already have both forms in scope.
 */
export function buildShellExecWarnings(
  strippedCommand: string,
  rawCommand: string,
): string[] | undefined {
  // Either input may carry the substitution. Use the dual-aware
  // predicate so the detection logic is identical to the audit-log path.
  if (
    hasShellSubstitution(rawCommand) ||
    detectCommandSubstitution(strippedCommand)
  ) {
    return [COMMAND_SUBSTITUTION_WARNING];
  }
  return undefined;
}

/**
 * The confirmation warning for a shell-like tool whose `directory` is outside
 * the workspace. The workspace check follows symlinks, so name the directory
 * it resolved to: a link inside the workspace that points out would otherwise
 * be shown by a path that looks internal.
 */
export function buildOutsideWorkspaceWarning(directory: string): string {
  let resolved: string;
  try {
    resolved = resolveWorkspacePath(directory);
  } catch {
    // Unresolvable: show the directory as given.
    resolved = path.resolve(directory);
  }
  return resolved === path.resolve(directory)
    ? `Runs outside the workspace in ${directory}`
    : `Runs outside the workspace in ${resolved} (via ${directory})`;
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
        'Command substitution using $(), `` ` ``, <(), >(), or ${parameter@P} is not allowed for security reasons',
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
