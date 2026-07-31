/**
 * Read Pattern Detection for Shell Commands
 *
 * Uses bash-parser to properly parse shell commands and detect file-reading
 * operations (sed, cat, head, tail). This handles shell wrappers, quoting,
 * and escaping correctly.
 *
 * Used by event adapters to emit these as "Read" tool events for better UI display.
 */

import bashParser from 'bash-parser';
import { looksLikePowerShell, extractPowerShellReadTarget } from '../powershell-validator.ts';

// ============================================================
// Types
// ============================================================

export interface ReadCommandInfo {
  /** Path to the file being read */
  filePath: string;
  /** Starting line number (1-indexed) */
  startLine?: number;
  /** Ending line number (1-indexed, inclusive) */
  endLine?: number;
  /** Original shell command for display in overlay */
  originalCommand: string;
}

// AST node types (subset from bash-parser)
interface ASTNode {
  type: string;
}

interface WordNode extends ASTNode {
  type: 'Word';
  text: string;
}

interface CommandNode extends ASTNode {
  type: 'Command';
  name?: WordNode;
  suffix?: ASTNode[];
}

interface ScriptNode extends ASTNode {
  type: 'Script';
  commands: ASTNode[];
}

// Commands that read files
const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'sed']);

// Shell executables that wrap other commands
const SHELL_EXECUTABLES = new Set([
  '/bin/zsh',
  '/bin/bash',
  '/bin/sh',
  'zsh',
  'bash',
  'sh',
]);

// ============================================================
// Main Parser
// ============================================================

/**
 * Parse a shell command to detect if it's a file read operation.
 *
 * Supported patterns:
 * - cat file.ts
 * - sed -n '1,260p' file.ts
 * - head -n 50 file.ts
 * - tail -n 50 file.ts
 * - Shell wrappers: /bin/zsh -lc 'cat file.ts'
 *
 * @returns ReadCommandInfo if detected as a read, null otherwise
 */
export function parseReadCommand(command: string): ReadCommandInfo | null {
  // PowerShell read detection (bash-parser can't handle PS syntax)
  if (looksLikePowerShell(command)) {
    const filePath = extractPowerShellReadTarget(command);
    if (filePath) return { filePath, originalCommand: command };
  }

  try {
    const ast = bashParser(command) as ScriptNode;
    const cmd = extractSimpleCommand(ast);
    if (!cmd) return null;

    // Handle shell wrappers: /bin/zsh -lc 'inner command'
    if (isShellWrapper(cmd)) {
      const innerCommand = getInnerCommand(cmd);
      if (innerCommand) {
        // Recursively parse the inner command
        const innerResult = parseReadCommand(innerCommand);
        if (innerResult) {
          // Keep the original full command for display
          return { ...innerResult, originalCommand: command };
        }
      }
      return null;
    }

    // Direct read command
    return parseDirectReadCommand(cmd, command);
  } catch {
    // Parse error = not a simple read command
    return null;
  }
}

// ============================================================
// AST Helpers
// ============================================================

/**
 * Extract a simple Command node from the AST.
 * Returns null if the script contains multiple commands or complex constructs.
 */
function extractSimpleCommand(ast: ScriptNode): CommandNode | null {
  if (ast.type !== 'Script' || ast.commands.length !== 1) {
    return null;
  }

  const firstCmd = ast.commands[0];
  if (firstCmd && firstCmd.type === 'Command') {
    return firstCmd as CommandNode;
  }

  return null;
}

/**
 * Get arguments from a command's suffix as string array.
 */
function getArgs(cmd: CommandNode): string[] {
  if (!cmd.suffix) return [];

  return cmd.suffix
    .filter((node): node is WordNode => node.type === 'Word')
    .map((word) => word.text);
}

/**
 * Check if command is a shell wrapper (zsh, bash, sh).
 */
function isShellWrapper(cmd: CommandNode): boolean {
  const name = cmd.name?.text;
  return name !== undefined && SHELL_EXECUTABLES.has(name);
}

/**
 * Extract the inner command string from a shell wrapper.
 * Looks for -c or flags ending in 'c' (like -lc) followed by the command.
 */
function getInnerCommand(cmd: CommandNode): string | null {
  const args = getArgs(cmd);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    // Look for -c flag or combined flags like -lc
    if (arg === '-c' || (arg.startsWith('-') && arg.endsWith('c') && arg.length > 1)) {
      // The next argument is the command string
      const nextArg = args[i + 1];
      if (nextArg) {
        return nextArg;
      }
    }
  }

  return null;
}

// ============================================================
// Command-Specific Parsers
// ============================================================

/**
 * Parse a direct read command (not wrapped in shell).
 */
function parseDirectReadCommand(cmd: CommandNode, original: string): ReadCommandInfo | null {
  const name = cmd.name?.text;
  if (!name || !READ_COMMANDS.has(name)) return null;

  const args = getArgs(cmd);

  switch (name) {
    case 'cat':
      return parseCatCommand(args, original);
    case 'sed':
      return parseSedCommand(args, original);
    case 'head':
      return parseHeadCommand(args, original);
    case 'tail':
      return parseTailCommand(args, original);
    default:
      return null;
  }
}

/**
 * Parse cat command: cat file.ts
 * Only matches simple single-file cat (no flags, no multiple files).
 */
function parseCatCommand(args: string[], original: string): ReadCommandInfo | null {
  const firstArg = args[0];
  // Simple cat with one file
  if (args.length === 1 && firstArg && !firstArg.startsWith('-')) {
    return {
      filePath: firstArg,
      originalCommand: original,
    };
  }
  return null;
}

/**
 * Parse sed command for line reading patterns:
 * - sed -n '1,100p' file.ts (line range)
 * - sed -n '50p' file.ts (single line)
 */
function parseSedCommand(args: string[], original: string): ReadCommandInfo | null {
  const flag = args[0];
  const pattern = args[1];
  const filePath = args[2];

  // Must have -n flag for print mode and at least 3 args
  if (flag !== '-n' || !pattern || !filePath) {
    return null;
  }

  // Range pattern: '1,100p' or 1,100p
  const rangeMatch = pattern.match(/^'?(\d+),(\d+)p'?$/);
  if (rangeMatch) {
    const start = rangeMatch[1];
    const end = rangeMatch[2];
    if (start && end) {
      return {
        filePath,
        startLine: parseInt(start, 10),
        endLine: parseInt(end, 10),
        originalCommand: original,
      };
    }
  }

  // Single line pattern: '50p' or 50p
  const singleMatch = pattern.match(/^'?(\d+)p'?$/);
  if (singleMatch) {
    const lineStr = singleMatch[1];
    if (lineStr) {
      const line = parseInt(lineStr, 10);
      return {
        filePath,
        startLine: line,
        endLine: line,
        originalCommand: original,
      };
    }
  }

  return null;
}

/**
 * Parse head command:
 * - head -n 50 file.ts
 * - head -50 file.ts
 */
function parseHeadCommand(args: string[], original: string): ReadCommandInfo | null {
  const firstArg = args[0];
  const secondArg = args[1];
  const thirdArg = args[2];

  // head -n 50 file.ts
  if (firstArg === '-n' && secondArg && thirdArg) {
    const n = parseInt(secondArg, 10);
    if (!isNaN(n)) {
      return {
        filePath: thirdArg,
        startLine: 1,
        endLine: n,
        originalCommand: original,
      };
    }
  }

  // head -50 file.ts (short form)
  if (args.length === 2 && firstArg && firstArg.startsWith('-') && secondArg) {
    const n = parseInt(firstArg.slice(1), 10);
    if (!isNaN(n)) {
      return {
        filePath: secondArg,
        startLine: 1,
        endLine: n,
        originalCommand: original,
      };
    }
  }

  return null;
}

/**
 * Parse tail command:
 * - tail -n 50 file.ts
 *
 * Note: We don't know exact line numbers for tail since we don't know file length.
 */
function parseTailCommand(args: string[], original: string): ReadCommandInfo | null {
  const firstArg = args[0];
  const secondArg = args[1];
  const thirdArg = args[2];

  // tail -n 50 file.ts
  if (firstArg === '-n' && secondArg && thirdArg) {
    const n = parseInt(secondArg, 10);
    if (!isNaN(n)) {
      return {
        filePath: thirdArg,
        // Don't set startLine/endLine for tail
        originalCommand: original,
      };
    }
  }

  // tail -50 file.ts (short form)
  if (args.length === 2 && firstArg && firstArg.startsWith('-') && secondArg) {
    const n = parseInt(firstArg.slice(1), 10);
    if (!isNaN(n)) {
      return {
        filePath: secondArg,
        originalCommand: original,
      };
    }
  }

  return null;
}

