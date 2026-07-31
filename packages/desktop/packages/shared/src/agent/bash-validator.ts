/**
 * Bash Command Validator
 *
 * Uses bash-parser to create a proper AST and validate commands in Plan mode.
 * This enables compound commands like `git status && git log` to be allowed
 * when all parts are safe, while still blocking dangerous constructs.
 *
 * AST Node Types:
 * - Command: Simple command with name and args
 * - LogicalExpression: && (and) or || (or) chains
 * - Pipeline: Piped commands (|)
 * - Subshell: Commands in parentheses (...)
 * - Redirect: File redirections (>, >>, <)
 * - CommandExpansion: $(...) substitution
 */

import bashParser from 'bash-parser';
import { debug } from '../utils/debug.ts';
import type { CompiledBashPattern } from './mode-types.ts';

// ============================================================
// Types
// ============================================================

/**
 * Result of validating a bash command AST.
 * Tracks which subcommands passed/failed for detailed error messages.
 */
export interface BashValidationResult {
  allowed: boolean;
  /** Primary reason for rejection (if not allowed) */
  reason?: BashValidationReason;
  /** Individual results for compound commands */
  subcommandResults?: SubcommandResult[];
}

export interface SubcommandResult {
  /** The command text that was validated */
  command: string;
  allowed: boolean;
  reason?: string;
}

/**
 * Detailed reason why validation failed.
 * Used to generate helpful error messages.
 */
export type BashValidationReason =
  | { type: 'pipeline'; explanation: string }
  | { type: 'redirect'; op: string; explanation: string }
  | { type: 'command_expansion'; explanation: string }
  | { type: 'process_substitution'; explanation: string }
  | { type: 'parameter_expansion'; explanation: string }
  | { type: 'env_assignment'; explanation: string }
  | { type: 'unsafe_command'; command: string; explanation: string }
  | { type: 'parse_error'; error: string }
  | { type: 'compound_partial_fail'; failedCommands: string[]; passedCommands: string[] }
  | { type: 'background_execution'; explanation: string };

// ============================================================
// AST Node Types (from bash-parser)
// ============================================================

interface ASTNode {
  type: string;
}

interface WordNode extends ASTNode {
  type: 'Word';
  text: string;
  expansion?: ExpansionNode[];
}

interface CommandNode extends ASTNode {
  type: 'Command';
  name?: WordNode;
  prefix?: ASTNode[];
  suffix?: ASTNode[];
  /** True if command runs in background with & operator */
  async?: boolean;
}

interface LogicalExpressionNode extends ASTNode {
  type: 'LogicalExpression';
  op: 'and' | 'or';
  left: ASTNode;
  right: ASTNode;
}

interface PipelineNode extends ASTNode {
  type: 'Pipeline';
  commands: ASTNode[];
}

interface SubshellNode extends ASTNode {
  type: 'Subshell';
  list: CompoundListNode;
}

interface CompoundListNode extends ASTNode {
  type: 'CompoundList';
  commands: ASTNode[];
}

interface RedirectNode extends ASTNode {
  type: 'Redirect';
  op: { text: string; type: string };
  file: WordNode;
}

interface ExpansionNode {
  type: string;
  command?: string;
  commandAST?: ScriptNode;
}

interface ScriptNode extends ASTNode {
  type: 'Script';
  commands: ASTNode[];
}

// ============================================================
// Dangerous Argument Patterns
// ============================================================

/**
 * Command arguments that execute subcommands or perform writes.
 * These are program-level features (not shell constructs) that the AST parser
 * cannot detect — e.g., `find -exec` runs arbitrary commands despite `find`
 * being a read-only search tool.
 *
 * Checked BEFORE the regex allowlist pattern match in validateCommand().
 */
const DANGEROUS_COMMAND_ARGS: Record<string, Set<string>> = {
  find: new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete']),
};

const AWK_COMMANDS = new Set(['awk', 'gawk', 'mawk', 'nawk']);

function getDangerousAwkReason(commandParts: string[]): string | null {
  // commandParts[0] is awk/gawk/mawk/nawk - inspect script/args only
  const scriptText = commandParts.slice(1).join(' ');

  if (/\bsystem\s*\(/i.test(scriptText)) {
    return 'awk system() executes arbitrary shell commands';
  }

  // command | getline executes an external command and reads from it
  if (/\|\s*getline\b/i.test(scriptText)) {
    return 'awk command pipes to getline execute external commands';
  }

  // print ... | "cmd" (or with quoted command forms) executes external commands
  if (/\bprint\b[^\n]*\|\s*["'`]/i.test(scriptText)) {
    return 'awk print-to-command pipes execute external commands';
  }

  return null;
}

// ============================================================
// Validation Logic
// ============================================================

/**
 * Validate a bash command using AST analysis.
 *
 * @param command - The bash command string to validate
 * @param patterns - Compiled regex patterns for allowed commands
 * @returns Validation result with detailed reason if rejected
 */
export function validateBashCommand(
  command: string,
  patterns: CompiledBashPattern[]
): BashValidationResult {
  // Parse the command into an AST
  let ast: ScriptNode;
  try {
    ast = bashParser(command) as ScriptNode;
  } catch (error) {
    debug('[BashValidator] Parse error:', error);
    return {
      allowed: false,
      reason: {
        type: 'parse_error',
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }

  // Validate the AST recursively
  const subcommandResults: SubcommandResult[] = [];
  const result = validateNode(ast, patterns, subcommandResults);

  return {
    ...result,
    subcommandResults: subcommandResults.length > 0 ? subcommandResults : undefined,
  };
}

/**
 * Recursively validate an AST node.
 */
function validateNode(
  node: ASTNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  switch (node.type) {
    case 'Script':
      return validateScript(node as ScriptNode, patterns, results);

    case 'Command':
      return validateCommand(node as CommandNode, patterns, results);

    case 'LogicalExpression':
      return validateLogicalExpression(node as LogicalExpressionNode, patterns, results);

    case 'Pipeline':
      // Validate each command in the pipeline individually.
      // If all commands are in the allowlist, the pipeline is safe.
      // e.g., `git log | head` is allowed because both commands are read-only.
      return validatePipeline(node as PipelineNode, patterns, results);

    case 'Subshell':
      return validateSubshell(node as SubshellNode, patterns, results);

    case 'CompoundList':
      return validateCompoundList(node as CompoundListNode, patterns, results);

    default:
      // Unknown node type — fail closed. bash-parser may produce node types
      // we don't explicitly handle (If, While, For, Case, Function, etc.).
      // Block them rather than silently allowing arbitrary constructs.
      debug('[BashValidator] Unknown node type (blocked):', node.type);
      return {
        allowed: false,
        reason: {
          type: 'parse_error',
          error: `Unsupported shell construct: "${node.type}". Only simple commands, pipelines, logical expressions (&&/||), and subshells are supported in Plan mode`,
        },
      };
  }
}

/**
 * Validate a Script node (top-level).
 */
function validateScript(
  node: ScriptNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  for (const cmd of node.commands) {
    const result = validateNode(cmd, patterns, results);
    if (!result.allowed) {
      return result;
    }
  }
  return { allowed: true };
}

/**
 * Validate a simple Command node.
 * Checks for:
 * 1. Command name matches safe patterns
 * 2. No redirects in suffix
 * 3. No command expansions in any word
 */
function validateCommand(
  node: CommandNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  // Check for background execution (&) - always blocked as it allows
  // running commands asynchronously which could hide malicious activity
  if (node.async) {
    return {
      allowed: false,
      reason: {
        type: 'background_execution',
        explanation: 'Background execution (&) runs commands asynchronously which could hide malicious activity',
      },
    };
  }

  // Build the full command string for pattern matching
  const commandParts: string[] = [];

  // Add command name
  if (node.name) {
    // Check for expansions in command name
    const expansionCheck = checkWordForExpansions(node.name);
    if (expansionCheck) {
      return { allowed: false, reason: expansionCheck };
    }
    commandParts.push(node.name.text);
  }

  // Add prefix (assignments, redirects before command)
  if (node.prefix) {
    for (const item of node.prefix) {
      if (item.type === 'Redirect') {
        const redirect = item as RedirectNode;
        // Allow safe redirects (input redirects and output to /dev/null)
        if (!isRedirectSafe(redirect)) {
          return {
            allowed: false,
            reason: {
              type: 'redirect',
              op: redirect.op.text,
              explanation: getRedirectExplanation(redirect.op.text),
            },
          };
        }
      }

      // Block environment variable assignments in command prefix.
      // e.g., PATH=/evil ls, LD_PRELOAD=/evil/lib.so ls, FOO=bar cmd
      // These modify the command's environment, potentially enabling
      // PATH hijacking or library injection (LD_PRELOAD).
      if (item.type === 'AssignmentWord') {
        return {
          allowed: false,
          reason: {
            type: 'env_assignment',
            explanation: `Environment variable assignment "${(item as WordNode).text}" modifies command behavior (e.g., PATH hijacking, LD_PRELOAD injection)`,
          },
        };
      }
    }
  }

  // Add suffix (arguments, redirects after command)
  if (node.suffix) {
    for (const item of node.suffix) {
      if (item.type === 'Redirect') {
        const redirect = item as RedirectNode;
        // Allow safe redirects (input redirects and output to /dev/null)
        if (!isRedirectSafe(redirect)) {
          return {
            allowed: false,
            reason: {
              type: 'redirect',
              op: redirect.op.text,
              explanation: getRedirectExplanation(redirect.op.text),
            },
          };
        }
      } else if (item.type === 'Word') {
        const word = item as WordNode;

        // Check for command expansions in arguments
        const expansionCheck = checkWordForExpansions(word);
        if (expansionCheck) {
          return { allowed: false, reason: expansionCheck };
        }

        commandParts.push(word.text);
      }
    }
  }

  // Check for command arguments that enable sub-command execution or writes.
  // e.g., `find -exec touch file \;` — the `-exec` flag runs arbitrary commands.
  // These are program-level features invisible to the shell AST.
  const cmdName = node.name?.text;
  if (cmdName) {
    const normalizedCmd = cmdName.toLowerCase();

    if (AWK_COMMANDS.has(normalizedCmd)) {
      const awkReason = getDangerousAwkReason(commandParts);
      if (awkReason) {
        const subResult: SubcommandResult = {
          command: commandParts.join(' '),
          allowed: false,
          reason: awkReason,
        };
        results.push(subResult);
        return {
          allowed: false,
          reason: {
            type: 'unsafe_command',
            command: commandParts.join(' '),
            explanation: awkReason,
          },
        };
      }
    }

    if (DANGEROUS_COMMAND_ARGS[normalizedCmd]) {
      const dangerousArgs = DANGEROUS_COMMAND_ARGS[normalizedCmd];
      for (const part of commandParts) {
        if (dangerousArgs.has(part)) {
          const subResult: SubcommandResult = {
            command: commandParts.join(' '),
            allowed: false,
            reason: `Argument "${part}" executes subcommands or performs writes`,
          };
          results.push(subResult);
          return {
            allowed: false,
            reason: {
              type: 'unsafe_command',
              command: commandParts.join(' '),
              explanation: `"${part}" allows arbitrary command execution or file modification within "${normalizedCmd}"`,
            },
          };
        }
      }
    }
  }

  // Build the command string and check against patterns
  const commandStr = commandParts.join(' ');

  // Check if command matches any safe pattern
  const matchesPattern = patterns.some(pattern => pattern.regex.test(commandStr));

  const subResult: SubcommandResult = {
    command: commandStr,
    allowed: matchesPattern,
    reason: matchesPattern ? undefined : 'Not in read-only allowlist',
  };
  results.push(subResult);

  if (!matchesPattern) {
    return {
      allowed: false,
      reason: {
        type: 'unsafe_command',
        command: commandStr,
        explanation: 'Command is not in the read-only allowlist',
      },
    };
  }

  return { allowed: true };
}

/**
 * Validate a LogicalExpression (&&, ||).
 * Both sides must be valid for the expression to be allowed.
 */
function validateLogicalExpression(
  node: LogicalExpressionNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  // Validate left side
  const leftResult = validateNode(node.left, patterns, results);
  if (!leftResult.allowed) {
    return leftResult;
  }

  // Validate right side
  const rightResult = validateNode(node.right, patterns, results);
  if (!rightResult.allowed) {
    return rightResult;
  }

  return { allowed: true };
}

/**
 * Validate a Pipeline node (cmd1 | cmd2 | ...).
 * Each command in the pipeline must be valid for the whole pipeline to be allowed.
 */
function validatePipeline(
  node: PipelineNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  for (const cmd of node.commands) {
    const result = validateNode(cmd, patterns, results);
    if (!result.allowed) {
      return result;
    }
  }
  return { allowed: true };
}

/**
 * Validate a Subshell node (...).
 * The inner commands must all be valid.
 */
function validateSubshell(
  node: SubshellNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  return validateNode(node.list, patterns, results);
}

/**
 * Validate a CompoundList (list of commands in subshell or similar).
 */
function validateCompoundList(
  node: CompoundListNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  for (const cmd of node.commands) {
    const result = validateNode(cmd, patterns, results);
    if (!result.allowed) {
      return result;
    }
  }
  return { allowed: true };
}

/**
 * Check a Word node for dangerous expansions.
 * Returns a rejection reason if found, null if safe.
 */
function checkWordForExpansions(word: WordNode): BashValidationReason | null {
  if (!word.expansion) {
    return null;
  }

  for (const exp of word.expansion) {
    if (exp.type === 'CommandExpansion') {
      return {
        type: 'command_expansion',
        explanation: `Command substitution $(...) executes embedded commands (found in: ${word.text})`,
      };
    }

    // Process substitution <(...) or >(...)
    // bash-parser may represent these differently, check for common patterns
    if (exp.type === 'ProcessSubstitution') {
      return {
        type: 'process_substitution',
        explanation: `Process substitution executes commands (found in: ${word.text})`,
      };
    }

    // Parameter expansion ($VAR, ${VAR}, ${VAR:-default}) can make commands
    // behave unpredictably based on environment state.
    // e.g., `cat $HOME/.ssh/id_rsa` reads sensitive files via expansion.
    if (exp.type === 'ParameterExpansion') {
      return {
        type: 'parameter_expansion',
        explanation: `Variable expansion \${...} makes command behavior dependent on environment state (found in: ${word.text})`,
      };
    }
  }

  return null;
}

/**
 * Safe input redirect operators that don't write to files.
 */
const SAFE_INPUT_REDIRECTS = new Set([
  '<',    // Input redirect - read-only
  '<&',   // Duplicate input file descriptor
]);

/**
 * Check if a redirect is safe (read-only or to /dev/null).
 *
 * Safe redirects:
 * - Input redirects: <, <&
 * - Output redirects to /dev/null (e.g., >/dev/null, 2>/dev/null)
 * - File descriptor duplication (e.g., 2>&1) - just duplicates, doesn't write to file
 */
function isRedirectSafe(redirect: RedirectNode): boolean {
  const op = redirect.op.text;

  // Input redirects are always safe (read-only)
  if (SAFE_INPUT_REDIRECTS.has(op)) {
    return true;
  }

  const target = redirect.file?.text;

  // Output redirects to /dev/null are safe
  if (target === '/dev/null') {
    return true;
  }

  // File descriptor duplication (e.g., 2>&1) is safe - it just redirects to another fd
  // These have targets like "1", "2" (file descriptor numbers)
  if (op === '>&' && target && /^\d+$/.test(target)) {
    return true;
  }

  return false;
}

/**
 * Get explanation for a redirect operator.
 */
function getRedirectExplanation(op: string): string {
  const explanations: Record<string, string> = {
    '>': 'overwrites file contents',
    '>>': 'appends to file',
    '>&': 'redirects file descriptors',
    '>|': 'forces overwrite (clobber)',
    '<<': 'here-document could inject arbitrary content',
  };

  return explanations[op] || `redirect operator "${op}" modifies file I/O`;
}

/**
 * Check if the command string contains dangerous control characters.
 *
 * Note: Newlines and carriage returns are NOT blocked here because bash-parser
 * correctly parses them as command separators, and the AST validation will
 * check each command individually. Only null bytes are blocked as they could
 * cause issues at lower levels (C bindings, string handling).
 */
export function hasControlCharacters(command: string): { char: string; explanation: string } | null {
  const dangerous: Record<string, string> = {
    '\x00': 'Null byte can truncate strings unexpectedly',
  };

  for (const char of command) {
    if (dangerous[char]) {
      return { char: '\\0', explanation: dangerous[char] };
    }
  }

  return null;
}
