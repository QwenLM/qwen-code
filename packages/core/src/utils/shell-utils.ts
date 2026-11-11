/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { quote, type ParseEntry } from 'shell-quote';
import {
  spawn,
  spawnSync,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';

/**
 * Extracts the primary command name from a potentially wrapped shell command.
 * Strips shell wrappers and handles shopt/set/etc.
 *
 * @param command - The full command string.
 * @param args - The arguments for the command.
 * @returns The primary command name.
 */
export async function getCommandName(
  command: string,
  args: string[],
): Promise<string> {
  await initializeShellParsers();
  const fullCmd = [command, ...args].join(' ');
  const stripped = stripShellWrapper(fullCmd);
  const roots = getCommandRoots(stripped, 'bash').filter(
    (r) => r !== 'shopt' && r !== 'set',
  );
  if (roots.length > 0) {
    return roots[0];
  }
  return path.basename(command);
}

/**
 * Extracts a string representation from a shell-quote ParseEntry.
 */
export function extractStringFromParseEntry(entry: ParseEntry): string {
  if (typeof entry === 'string') return entry;
  if ('pattern' in entry) return entry.pattern;
  if ('op' in entry) return entry.op;
  if ('comment' in entry) return ''; // We can typically ignore comments for safety checks
  return '';
}
import * as readline from 'node:readline';
import { Language, Parser, Query, type Node, type Tree } from 'web-tree-sitter';
import { loadWasmBinary } from './fileUtils.js';
import { runLogger } from './runLogger.js';
import {
  sanitizeEnvironment,
  getSecureSanitizationConfig,
} from '../services/environmentSanitization.js';
import { SHELL_TOOL_NAME } from '../tools/tool-names.js';



import { isSpecialDeviceTarget } from './specialDevicePaths.js';

export const SHELL_TOOL_NAMES = [SHELL_TOOL_NAME, 'ShellTool'];

/**
 * An identifier for the shell type.
 */
export type ShellType = 'cmd' | 'powershell' | 'bash';

/** Shell grammar used when parsing a command for safety and permissions. */
export type ShellCommandParser = Extract<ShellType, 'powershell' | 'bash'>;

/**
 * Defines the configuration required to execute a command string within a specific shell.
 */
export interface ShellConfiguration {
  /** The path or name of the shell executable (e.g., 'bash', 'powershell.exe'). */
  executable: string;
  /**
   * The arguments required by the shell to execute a subsequent string argument.
   */
  argsPrefix: string[];
  /** An identifier for the shell type. */
  shell: ShellType;
}

export async function resolveExecutable(
  exe: string,
): Promise<string | undefined> {
  if (path.isAbsolute(exe)) {
    try {
      await fs.promises.access(exe, fs.constants.X_OK);
      return exe;
    } catch {
      return undefined;
    }
  }
  const paths = (process.env['PATH'] || '').split(path.delimiter);
  const extensions =
    os.platform() === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

  for (const p of paths) {
    for (const ext of extensions) {
      const fullPath = path.join(p, exe + ext);
      try {
        await fs.promises.access(fullPath, fs.constants.X_OK);
        return fullPath;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

let bashLanguage: Language | null = null;
let treeSitterInitialization: Promise<void> | null = null;
let treeSitterInitializationError: Error | null = null;

class ShellParserInitializationError extends Error {
  constructor(cause: Error) {
    super(`Failed to initialize bash parser: ${cause.message}`, { cause });
    this.name = 'ShellParserInitializationError';
  }
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === 'string') {
    return new Error(value);
  }
  return new Error('Unknown tree-sitter initialization error', {
    cause: value,
  });
}

async function loadBashLanguage(): Promise<void> {
  try {
    treeSitterInitializationError = null;
    const [treeSitterBinary, bashBinary] = await Promise.all([
      loadWasmBinary(
        () =>
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore resolved by esbuild-plugin-wasm during bundling
          import('web-tree-sitter/tree-sitter.wasm?binary'),
        'web-tree-sitter/tree-sitter.wasm',
      ),
      loadWasmBinary(
        () =>
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore resolved by esbuild-plugin-wasm during bundling
          import('tree-sitter-bash/tree-sitter-bash.wasm?binary'),
        'tree-sitter-bash/tree-sitter-bash.wasm',
      ),
    ]);

    await Parser.init({ wasmBinary: treeSitterBinary });
    bashLanguage = await Language.load(bashBinary);
  } catch (error) {
    bashLanguage = null;
    const normalized = toError(error);
    const initializationError =
      normalized instanceof ShellParserInitializationError
        ? normalized
        : new ShellParserInitializationError(normalized);
    treeSitterInitializationError = initializationError;
    throw initializationError;
  }
}

export async function initializeShellParsers(): Promise<void> {
  if (!treeSitterInitialization) {
    treeSitterInitialization = loadBashLanguage().catch((error) => {
      treeSitterInitialization = null;
      // Log the error but don't throw, allowing the application to fall back to safe defaults (ASK_USER)
      // or regex checks where appropriate.
      runLogger.debug('Failed to initialize shell parsers:', error);
    });
  }

  await treeSitterInitialization;
}

export interface ParsedCommandDetail {
  name: string;
  text: string;
  startIndex: number;
  args?: string[];
}

interface CommandParseResult {
  details: ParsedCommandDetail[];
  hasError: boolean;
  hasRedirection?: boolean;
}

const POWERSHELL_COMMAND_ENV = '__GCLI_POWERSHELL_COMMAND__';
const PARSE_TIMEOUT_MICROS = 1000 * 1000; // 1 second

// Encode the parser script as UTF-16LE base64 so we can pass it via PowerShell's -EncodedCommand flag;
// this avoids brittle quoting/escaping when spawning PowerShell and ensures the script is received byte-for-byte.
const POWERSHELL_PARSER_SCRIPT = Buffer.from(
  `
$ErrorActionPreference = 'Stop'
$commandText = $env:${POWERSHELL_COMMAND_ENV}
if ([string]::IsNullOrEmpty($commandText)) {
  Write-Output '{"success":false}'
  exit 0
}
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($commandText, [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) {
  Write-Output '{"success":false}'
  exit 0
}
$commandAsts = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true)
$commandObjects = @()
$hasRedirection = $false
foreach ($commandAst in $commandAsts) {
  if ($commandAst.Redirections.Count -gt 0) {
    $hasRedirection = $true
  }
  $name = $commandAst.GetCommandName()
  if ([string]::IsNullOrWhiteSpace($name)) {
    continue
  }
  $args = @()
  if ($commandAst.CommandElements.Count -gt 1) {
    for ($i = 1; $i -lt $commandAst.CommandElements.Count; $i++) {
      $args += $commandAst.CommandElements[$i].Extent.Text.Trim()
    }
  }
  $commandObjects += [PSCustomObject]@{
    name = $name
    text = $commandAst.Extent.Text.Trim()
    args = $args
  }
}
[PSCustomObject]@{
  success = $true
  commands = $commandObjects
  hasRedirection = $hasRedirection
} | ConvertTo-Json -Compress
`,
  'utf16le',
).toString('base64');

const REDIRECTION_NAMES = new Set([
  'redirection (<)',
  'redirection (>)',
  'heredoc (<<)',
  'herestring (<<<)',
]);

function createParser(): Parser | null {
  if (!bashLanguage) {
    if (treeSitterInitializationError) {
      throw treeSitterInitializationError;
    }
    return null;
  }

  try {
    const parser = new Parser();
    parser.setLanguage(bashLanguage);
    return parser;
  } catch {
    return null;
  }
}

function parseCommandTree(
  command: string,
  timeoutMicros: number = PARSE_TIMEOUT_MICROS,
): Tree | null {
  const parser = createParser();
  if (!parser || !command.trim()) {
    return null;
  }

  const deadline = performance.now() + timeoutMicros / 1000;
  let timedOut = false;

  try {
    const tree = parser.parse(command, null, {
      progressCallback: () => {
        if (performance.now() > deadline) {
          timedOut = true;
          return true as unknown as void; // Returning true cancels parsing, but type says void
        }
      },
    });

    if (timedOut) {
      runLogger.error('Bash command parsing timed out for command:', command);
      // Returning a partial tree could be risky so we return null to be safe.
      return null;
    }

    return tree;
  } catch {
    return null;
  }
}

/** Read Bash nodes while the tree is alive; return null if the parser is not ready or syntax is invalid. */
export function withBashSyntaxTree<T>(
  command: string,
  read: (root: Node) => T,
): T | null {
  if (!bashLanguage) {
    void initializeShellParsers();
    return null;
  }
  const tree = parseCommandTree(command);
  if (!tree) return null;
  try {
    if (tree.rootNode.hasError || hasPromptCommandTransform(tree.rootNode))
      return null;
    return read(tree.rootNode);
  } finally {
    tree.delete();
  }
}

function normalizeCommandName(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  return raw.trim();
}

/**
 * Normalizes a command name for command matching.
 * Converts to lowercase and removes the .exe extension for cross-platform consistency.
 *
 * @param commandName - The command name to normalize.
 * @returns The normalized command name.
 */
export function normalizeCommand(commandName: string): string {
  // Split by both separators and get the last non-empty part
  const parts = commandName.split(/[\\/]/).filter(Boolean);
  const base = parts.length > 0 ? parts[parts.length - 1] : '';
  return base.toLowerCase().replace(/\.exe$/, '');
}

function extractNameFromNode(node: Node): string | null {
  switch (node.type) {
    case 'command': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) {
        return null;
      }
      return normalizeCommandName(nameNode.text);
    }
    case 'declaration_command':
    case 'unset_command':
    case 'test_command': {
      const firstChild = node.child(0);
      if (!firstChild) {
        return null;
      }
      return normalizeCommandName(firstChild.text);
    }
    case 'file_redirect': {
      // The first child might be a file descriptor (e.g., '2>').
      // We iterate to find the actual operator token.
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.text.includes('<')) {
          return 'redirection (<)';
        }
        if (child && child.text.includes('>')) {
          return 'redirection (>)';
        }
      }
      return 'redirection (>)';
    }
    case 'heredoc_redirect':
      return 'heredoc (<<)';
    case 'herestring_redirect':
      return 'herestring (<<<)';
    default:
      return null;
  }
}

function collectCommandDetails(
  root: Node,
  source: string,
): ParsedCommandDetail[] {
  const stack: Node[] = [root];
  const details: ParsedCommandDetail[] = [];

  while (stack.length > 0) {
    const current = stack.pop()!;

    const name = extractNameFromNode(current);
    if (name) {
      const detail: ParsedCommandDetail = {
        name,
        text: source.slice(current.startIndex, current.endIndex).trim(),
        startIndex: current.startIndex,
      };

      if (current.type === 'command') {
        const args: string[] = [];
        const nameNode = current.childForFieldName('name');
        for (let i = 0; i < current.childCount; i += 1) {
          const child = current.child(i);
          if (
            child &&
            child.type === 'word' &&
            child.startIndex !== nameNode?.startIndex
          ) {
            args.push(child.text);
          }
        }
        if (args.length > 0) {
          detail.args = args;
        }
      }

      details.push(detail);
    }

    // Traverse all children to find all sub-components (commands, redirections, etc.)
    for (let i = current.childCount - 1; i >= 0; i -= 1) {
      const child = current.child(i);
      if (child) {
        stack.push(child);
      }
    }
  }

  return details;
}

function hasPromptCommandTransform(root: Node): boolean {
  const stack: Node[] = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    if (current.type === 'expansion') {
      for (let i = 0; i < current.childCount - 1; i += 1) {
        const operatorNode = current.child(i);
        const transformNode = current.child(i + 1);

        if (
          operatorNode?.text === '@' &&
          transformNode?.text?.toLowerCase() === 'p'
        ) {
          return true;
        }
      }
    }

    for (let i = current.namedChildCount - 1; i >= 0; i -= 1) {
      const child = current.namedChild(i);
      if (child) {
        stack.push(child);
      }
    }
  }

  return false;
}

export function parseBashCommandDetails(
  command: string,
): CommandParseResult | null {
  if (treeSitterInitializationError) {
    runLogger.debug(
      'Bash parser not initialized:',
      treeSitterInitializationError,
    );
    return null;
  }

  if (!bashLanguage) {
    initializeShellParsers().catch(() => {
      // The failure path is surfaced via treeSitterInitializationError.
    });
    return null;
  }

  const tree = parseCommandTree(command);
  if (!tree) {
    return null;
  }

  const details = collectCommandDetails(tree.rootNode, command);

  const hasError =
    tree.rootNode.hasError ||
    details.length === 0 ||
    hasPromptCommandTransform(tree.rootNode);

  if (hasError) {
    let query = null;
    try {
      query = new Query(bashLanguage, '(ERROR) @error (MISSING) @missing');
      const captures = query.captures(tree.rootNode);
      const syntaxErrors = captures.map((capture) => {
        const { node, name } = capture;
        const type = name === 'missing' ? 'Missing' : 'Error';
        return `${type} node: "${node.text}" at ${node.startPosition.row}:${node.startPosition.column}`;
      });

      runLogger.log(
        'Bash command parsing error detected for command:',
        command,
        'Syntax Errors:',
        syntaxErrors,
      );
    } catch {
      // Ignore query errors
    } finally {
      query?.delete();
    }
  }
  return {
    details: details.sort((a, b) => a.startIndex - b.startIndex),
    hasError,
  };
}

/** Simple executable spans for a fixed per-agent Bash clamp. No control flow. */
export function getBashClampCommandSegments(command: string): string[] | null {
  const tree = parseCommandTree(command);
  if (!tree) return null;
  try {
    if (tree.rootNode.hasError) return null;
    const unsupported = new Set([
      'if_statement', 'for_statement', 'c_style_for_statement', 'while_statement',
      'case_statement', 'function_definition', 'compound_statement', 'subshell',
      'command_substitution', 'process_substitution', 'heredoc_redirect',
    ]);
    const pending = [tree.rootNode];
    while (pending.length) {
      const node = pending.pop()!;
      if (unsupported.has(node.type)) return null;
      for (const child of node.namedChildren) if (child) pending.push(child);
    }
    const details = collectCommandDetails(tree.rootNode, command);
    return details.length ? details.map((detail) => detail.text) : null;
  } finally {
    tree.delete();
  }
}

function parsePowerShellCommandDetails(
  command: string,
  executable: string,
): CommandParseResult | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      details: [],
      hasError: true,
    };
  }

  try {
    const result = spawnSync(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        POWERSHELL_PARSER_SCRIPT,
      ],
      {
        env: {
          ...process.env,
          [POWERSHELL_COMMAND_ENV]: command,
        },
        encoding: 'utf-8',
      },
    );

    if (result.error || result.status !== 0) {
      return null;
    }

    const output = (result.stdout ?? '').toString().trim();
    if (!output) {
      return { details: [], hasError: true };
    }

    let parsed: {
      success?: boolean;
      commands?: Array<{ name?: string; text?: string; args?: string[] }>;
      hasRedirection?: boolean;
    } | null = null;
    try {
      parsed = JSON.parse(output);
    } catch {
      return { details: [], hasError: true };
    }

    if (!parsed?.success) {
      return { details: [], hasError: true };
    }

    const details = (parsed.commands ?? [])
      .map((commandDetail): ParsedCommandDetail | null => {
        if (!commandDetail || typeof commandDetail.name !== 'string') {
          return null;
        }

        const name = normalizeCommandName(commandDetail.name);
        const text =
          typeof commandDetail.text === 'string'
            ? commandDetail.text.trim()
            : command;

        return {
          name,
          text,
          startIndex: 0,
          args: Array.isArray(commandDetail.args)
            ? commandDetail.args
            : undefined,
        };
      })
      .filter((detail): detail is ParsedCommandDetail => detail !== null);

    return {
      details,
      hasError: details.length === 0,
      hasRedirection: parsed.hasRedirection,
    };
  } catch {
    return null;
  }
}

export function parseCommandDetails(
  command: string,
  parser?: ShellCommandParser,
): CommandParseResult | null {
  // Parse with the grammar of the tool that will execute the command, not the
  // host OS. On Windows, the shell tool executes Git Bash commands even though
  // the platform default below is PowerShell.
  if (parser === 'bash') {
    return parseBashCommandDetails(command);
  }

  const configuration = getShellConfiguration();

  if (
    parser === 'powershell' ||
    (parser === undefined && configuration.shell === 'powershell')
  ) {
    const result = parsePowerShellCommandDetails(
      command,
      configuration.shell === 'powershell'
        ? configuration.executable
        : isWindows()
          ? 'powershell.exe'
          : 'pwsh',
    );
    if (!result || result.hasError) {
      // Fallback to bash parser which is usually good enough for simple commands
      // and doesn't rely on the host PowerShell environment restrictions (e.g., ConstrainedLanguage)
      const bashResult = parseBashCommandDetails(command);
      if (bashResult && !bashResult.hasError) {
        return bashResult;
      }
    }
    return result;
  }

  if (configuration.shell === 'bash') {
    return parseBashCommandDetails(command);
  }

  return null;
}

// Module-level cache for bash resolution.
// undefined = not yet probed; null = probed and not found; string = absolute path.
let cachedBashPath: string | null | undefined;
let bashFallbackLogged = false;

/**
 * Resolve an executable `bash` to an absolute path by walking PATH.
 *
 * Only absolute PATH entries are considered — relative entries (e.g. `.`) would
 * resolve against the spawned process's cwd, which is not the CLI's cwd and
 * could pick an unexpected binary. Each candidate is validated as a regular file
 * (`statSync().isFile()`) that the current process can execute
 * (`accessSync(X_OK)`, which honors ownership/ACL/mount context, unlike a raw
 * mode-bit check).
 *
 * @returns Absolute path to bash, or null if none is found.
 */
export function resolveBashPath(): string | null {
  if (cachedBashPath !== undefined) return cachedBashPath;
  const pathEnv = process.env['PATH'] ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'bash');
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      cachedBashPath = candidate;
      return candidate;
    } catch {
      // Missing or not executable — keep looking.
    }
  }
  cachedBashPath = null;
  return null;
}

/**
 * Resolve the shell executable for running command strings on Unix.
 *
 * Prefers bash (via {@link resolveBashPath}); when bash is unavailable (e.g.
 * minimal Alpine/BusyBox images) falls back to `/bin/sh` so POSIX-compatible
 * commands still run instead of failing with ENOENT. The fallback is logged
 * once per process.
 *
 * @returns Absolute path to bash, or `/bin/sh` when bash is unavailable.
 */
export function resolveUnixCommandShell(): string {
  const bashPath = resolveBashPath();
  if (bashPath) return bashPath;
  if (!bashFallbackLogged) {
    bashFallbackLogged = true;
    runLogger.warn(
      '[shell-utils] bash not found in PATH; falling back to /bin/sh. ' +
        'Hook/statusline commands using bash-specific syntax may fail.',
    );
  }
  return '/bin/sh';
}

/** Test-only: reset the memoized shell resolution state. */
export function _resetShellResolutionCacheForTests(): void {
  cachedBashPath = undefined;
  bashFallbackLogged = false;
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
    const comSpec = process.env['ComSpec'];
    if (comSpec) {
      const executable = comSpec.toLowerCase();
      if (
        executable.endsWith('powershell.exe') ||
        executable.endsWith('pwsh.exe')
      ) {
        return {
          executable: comSpec,
          argsPrefix: ['-NoProfile', '-Command'],
          shell: 'powershell',
        };
      }
    }

    // Default to PowerShell for all other Windows configurations.
    return {
      executable: 'powershell.exe',
      argsPrefix: ['-NoProfile', '-Command'],
      shell: 'powershell',
    };
  }

  // Unix-like systems (Linux, macOS): prefer bash, fall back to /bin/sh.
  return {
    executable: resolveUnixCommandShell(),
    argsPrefix: ['-c'],
    shell: 'bash',
  };
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
/**
 * Strip redirections to special devices (e.g. `2>/dev/null`, `> NUL`)
 * from a command string. These targets don't write to the real filesystem
 * and should not trigger read-only classification or UI redirection warnings.
 *
 * The device list is kept in sync with `isSpecialDeviceTarget()` in
 * filesystem.ts — both cover the same set of POSIX devices and Windows NUL.
 */
export function stripSpecialDeviceRedirections(command: string): string {
  const devicePattern =
    /\s*(?:\d+|&)?>>?\s*(?:\/dev\/null|\/dev\/stdout|\/dev\/stderr|\/dev\/stdin|\/dev\/tty|\/dev\/fd\/\d+|NUL)/gi;
  return command.replace(devicePattern, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Checks if a command contains redirection operators.
 * Uses shell-specific parsers where possible, falling back to a broad regex check.
 */
export function hasRedirection(command: string): boolean {
  // Strip special-device redirections (e.g. 2>/dev/null, > NUL) before
  // checking. These don't write to the real filesystem and should not
  // trigger the "Redirection detected" UI warning.
  const stripped = stripSpecialDeviceRedirections(command);

  const fallbackCheck = () => /[><]/.test(stripped);

  // If there are no redirection characters at all, we can skip parsing.
  if (!fallbackCheck()) {
    return false;
  }

  const configuration = getShellConfiguration();

  if (configuration.shell === 'powershell') {
    const parsed = parsePowerShellCommandDetails(
      stripped,
      configuration.executable,
    );
    return parsed && !parsed.hasError
      ? !!parsed.hasRedirection
      : fallbackCheck();
  }

  if (configuration.shell === 'bash' && bashLanguage) {
    const tree = parseCommandTree(command);
    if (!tree) {
      // AST unavailable — use regex strip as fallback.
      return /[><]/.test(stripSpecialDeviceRedirections(command));
    }

    // Walk the AST and find all redirection nodes.
    // For file_redirect nodes, extract the target and check if it's
    // a special device. If ALL redirects target special devices,
    // there is no real redirection.
    const stack: Node[] = [tree.rootNode];
    let hasRealRedirect = false;
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (
        current.type === 'heredoc_redirect' ||
        current.type === 'herestring_redirect'
      ) {
        // heredoc/herestring always count as real redirections.
        hasRealRedirect = true;
        break;
      }
      if (current.type === 'file_redirect') {
        // Extract the redirect target (the child after the operator).
        // tree-sitter structures file_redirect as: [fd] '>' destination
        const destNode = current.childForFieldName('destination') ??
          current.child(current.childCount - 1);
        const destText = destNode?.text ?? '';
        if (!isSpecialDeviceTarget(destText)) {
          hasRealRedirect = true;
          break;
        }
      }
      for (let i = current.childCount - 1; i >= 0; i -= 1) {
        const child = current.child(i);
        if (child) stack.push(child);
      }
    }
    return hasRealRedirect;
  }

  return fallbackCheck();
}

export function splitCommands(
  command: string,
  parser?: ShellCommandParser,
): string[] {
  const parsed = parseCommandDetails(command, parser);
  if (!parsed || parsed.hasError) {
    return [];
  }

  return parsed.details
    .filter((detail) => !REDIRECTION_NAMES.has(detail.name))
    .map((detail) => detail.text)
    .filter(Boolean);
}

/**
 * Extracts the root command from a given shell command string.
 * This is used to identify the base command for permission checks.
 * @param command The shell command string to parse
 * @returns The root command name, or undefined if it cannot be determined
 * @example getCommandRoot("ls -la /tmp") returns "ls"
 * @example getCommandRoot("git status && npm test") returns "git"
 */
export function getCommandRoot(
  command: string,
  parser?: ShellCommandParser,
): string | undefined {
  const parsed = parseCommandDetails(command, parser);
  if (!parsed || parsed.hasError || parsed.details.length === 0) {
    return undefined;
  }

  return parsed.details[0]?.name;
}

export function getCommandRoots(
  command: string,
  parser?: ShellCommandParser,
): string[] {
  if (!command) {
    return [];
  }

  const parsed = parseCommandDetails(command, parser);
  if (!parsed || parsed.hasError) {
    return [];
  }

  return parsed.details
    .map((detail) => detail.name)
    .filter((name) => !REDIRECTION_NAMES.has(name))
    .filter(Boolean);
}

/**
 * The command whose status the shell reports — the last real command in the
 * string, skipping the redirection pseudo-details the parser emits. `grep x
 * 2>&1` resolves to `grep`, and `a | b` resolves to `b`, matching how the
 * shell's own `$?` behaves without `pipefail`.
 *
 * @param parser - Grammar to parse with. Pass the grammar of the shell that
 *   actually ran the command, as every other caller in this file does; leaving
 *   it unset falls back to the host default, which spawns PowerShell on Windows.
 * @returns The detail with its name normalized, or undefined if unparseable.
 */
export function getEffectiveCommandDetail(
  command: string,
  parser?: ShellCommandParser,
): ParsedCommandDetail | undefined {
  const parsed = parseCommandDetails(command, parser);
  if (!parsed || parsed.hasError) {
    return undefined;
  }
  const detail = parsed.details.findLast(
    (entry) => !REDIRECTION_NAMES.has(entry.name),
  );
  return detail ? { ...detail, name: normalizeCommand(detail.name) } : undefined;
}

/**
 * Finds the first positional argument of a `git` invocation, skipping git's
 * global options and the values they consume.
 *
 * @param args - Full argument list, including `git` itself at index 0.
 * @param subcommands - Subcommands to look for.
 * @returns The index and name of the subcommand, or `{ idx: -1, subcommand: null }`.
 */
export function findGitSubcommand(
  args: string[],
  subcommands: string[],
): { idx: number; subcommand: string | null } {
  let skipNext = false;

  for (let idx = 1; idx < args.length; idx++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    const arg = args[idx];

    if (
      arg.startsWith('--config-env=') ||
      arg.startsWith('--exec-path=') ||
      arg.startsWith('--git-dir=') ||
      arg.startsWith('--namespace=') ||
      arg.startsWith('--super-prefix=') ||
      arg.startsWith('--work-tree=') ||
      ((arg.startsWith('-C') || arg.startsWith('-c')) && arg.length > 2)
    ) {
      continue;
    }

    if (
      arg === '-C' ||
      arg === '-c' ||
      arg === '--config-env' ||
      arg === '--exec-path' ||
      arg === '--git-dir' ||
      arg === '--namespace' ||
      arg === '--super-prefix' ||
      arg === '--work-tree'
    ) {
      skipNext = true;
      continue;
    }

    if (arg === '--' || arg.startsWith('-')) {
      continue;
    }

    if (subcommands.includes(arg)) {
      return { idx, subcommand: arg };
    }

    return { idx: -1, subcommand: null };
  }

  return { idx: -1, subcommand: null };
}

export function stripShellWrapper(command: string): string {
  const pattern =
    /^\s*(?:\S+\/)?(?:sh|bash|zsh)\s+-c\s+/i;
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
 * @param command The shell command string to check
 * @returns true if command substitution would be executed by bash
 */
/**
 * Determines whether a given shell command is allowed to execute based on
 * the tool's configuration including allowlists and blocklists.
 *
 * This function operates in "default allow" mode. It is a wrapper around
 * `checkCommandPermissions`.
 *
 * @param command The shell command string to validate.
 * @param config The application configuration.
 * @returns An object with 'allowed' boolean and optional 'reason' string if not allowed.
 */
export const spawnAsync = async (
  command: string,
  args: string[],
  options?: SpawnOptionsWithoutStdio,
): Promise<{ stdout: string; stderr: string }> =>
  spawnAsyncImpl(command, args, options);

const spawnAsyncImpl = async (
  command: string,
  args: string[],
  options?: SpawnOptionsWithoutStdio,
): Promise<{ stdout: string; stderr: string }> => {
  const finalEnv = sanitizeEnvironment(
    options?.env ?? process.env,
    getSecureSanitizationConfig(),
  );

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      env: finalEnv,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with exit code ${code}:\n${stderr}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
};

/**
 * Executes a command and yields lines of output as they appear.
 * Use for large outputs where buffering is not feasible.
 *
 * @param command The executable to run
 * @param args Arguments for the executable
 * @param options Spawn options (cwd, env, etc.)
 */
export async function* execStreaming(
  command: string,
  args: string[],
  options?: SpawnOptionsWithoutStdio & {
    signal?: AbortSignal;
    allowedExitCodes?: number[];
  },
): AsyncGenerator<string, void, void> {
  const stream = await execStreamingImpl(command, args, options);
  yield* stream;
}

async function* execStreamingImpl(
  command: string,
  args: string[],
  options?: SpawnOptionsWithoutStdio & {
    signal?: AbortSignal;
    allowedExitCodes?: number[];
  },
): AsyncGenerator<string, void, void> {
  const finalEnv = sanitizeEnvironment(
    options?.env ?? process.env,
    getSecureSanitizationConfig(),
  );

  const child = spawn(command, args, {
    ...options,
    env: finalEnv,
    // ensure we don't open a window on windows if possible/relevant
    windowsHide: true,
  });

  const rl = readline.createInterface({
    input: child.stdout,
    terminal: false,
  });

  const errorChunks: Buffer[] = [];
  let stderrTotalBytes = 0;
  const MAX_STDERR_BYTES = 20 * 1024; // 20KB limit

  child.stderr.on('data', (chunk) => {
    if (stderrTotalBytes < MAX_STDERR_BYTES) {
      errorChunks.push(chunk);
      stderrTotalBytes += chunk.length;
    }
  });

  let error: Error | null = null;
  child.on('error', (err) => {
    error = err;
  });

  const onAbort = () => {
    // If manually aborted by signal, we kill immediately.
    if (!child.killed) child.kill();
  };

  if (options?.signal?.aborted) {
    onAbort();
  } else {
    options?.signal?.addEventListener('abort', onAbort);
  }

  let finished = false;
  let lineCount = 0;
  try {
    for await (const line of rl) {
      if (options?.signal?.aborted) break;
      lineCount++;
      yield line;
    }
    finished = true;
  } finally {
    rl.close();
    options?.signal?.removeEventListener('abort', onAbort);

    // Ensure process is killed when the generator is closed (consumer breaks loop)
    let killedByGenerator = false;
    if (!finished && child.exitCode === null && !child.killed) {
      try {
        child.kill();
      } catch {
        // ignore error if process is already dead
      }
      killedByGenerator = true;
    }

    // Ensure we wait for the process to exit to check codes
    await new Promise<void>((resolve, reject) => {
      // If an error occurred before we got here (e.g. spawn failure), reject immediately.
      if (error) {
        reject(error);
        return;
      }

      function checkExit(code: number | null) {
        // If we aborted or killed it manually, we treat it as success (stop waiting)
        if (options?.signal?.aborted || killedByGenerator) {
          resolve();
          return;
        }

        const allowed = options?.allowedExitCodes ?? [0];
        if (code !== null && allowed.includes(code)) {
          resolve();
        } else {
          // If we have an accumulated error or explicit error event
          if (error) reject(error);
          else {
            const stderr = Buffer.concat(errorChunks).toString('utf8');
            const truncatedMsg =
              stderrTotalBytes >= MAX_STDERR_BYTES ? '...[truncated]' : '';
            reject(
              new Error(
                `Process exited with code ${code}: ${stderr}${truncatedMsg}`,
              ),
            );
          }
        }
      }

      if (child.exitCode !== null) {
        checkExit(child.exitCode);
      } else {
        child.on('close', (code) => checkExit(code));
        child.on('error', (err) => reject(err));
      }
    });
  }
}
