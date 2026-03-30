/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shell AST Parser — powered by web-tree-sitter + tree-sitter-bash.
 *
 * Provides:
 *   1. `initParser()`           – lazy singleton Parser initialisation
 *   2. `parseShellCommand()`    – parse a command string into a tree-sitter Tree
 *   3. `isShellCommandReadOnlyAST()` – AST-based read-only command detection
 *   4. `extractCommandRules()`  – extract minimum-scope wildcard permission rules
 */

import Parser from 'web-tree-sitter';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename_ = resolveModuleFilePath(fileURLToPath(import.meta.url));

function resolveModuleFilePath(moduleFilePath: string): string {
  try {
    return fs.realpathSync(moduleFilePath);
  } catch {
    return moduleFilePath;
  }
}

/**
 * Root commands considered read-only by default (no sub-command analysis needed
 * unless explicitly listed in COMMANDS_WITH_SUBCOMMANDS).
 */
const READ_ONLY_ROOT_COMMANDS = new Set([
  'awk',
  'basename',
  'cat',
  'cd',
  'column',
  'cut',
  'df',
  'dirname',
  'du',
  'echo',
  'env',
  'find',
  'git',
  'grep',
  'head',
  'less',
  'ls',
  'more',
  'printenv',
  'printf',
  'ps',
  'pwd',
  'rg',
  'ripgrep',
  'sed',
  'sort',
  'stat',
  'tail',
  'tree',
  'uniq',
  'wc',
  'which',
  'where',
  'whoami',
]);

/** Git sub-commands considered read-only. */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'blame',
  'branch',
  'cat-file',
  'diff',
  'grep',
  'log',
  'ls-files',
  'remote',
  'rev-parse',
  'show',
  'status',
  'describe',
]);

/** git remote actions that mutate state. */
const BLOCKED_GIT_REMOTE_ACTIONS = new Set([
  'add',
  'remove',
  'rename',
  'set-url',
  'prune',
  'update',
]);

/** git branch flags that mutate state. */
const BLOCKED_GIT_BRANCH_FLAGS = new Set([
  '-d',
  '-D',
  '--delete',
  '--move',
  '-m',
]);

/** find flags that have side-effects. */
const BLOCKED_FIND_FLAGS = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
]);

const BLOCKED_FIND_PREFIXES = ['-fprint', '-fprintf'];

/** sed flags that cause in-place editing. */
const BLOCKED_SED_PREFIXES = ['-i'];

/** AWK side-effect patterns that can execute commands or write files. */
const AWK_SIDE_EFFECT_PATTERNS = [
  /system\s*\(/,
  /print\s+[^>|]*>\s*"[^"]*"/,
  /printf\s+[^>|]*>\s*"[^"]*"/,
  /print\s+[^>|]*>>\s*"[^"]*"/,
  /printf\s+[^>|]*>>\s*"[^"]*"/,
  /print\s+[^|]*\|\s*"[^"]*"/,
  /printf\s+[^|]*\|\s*"[^"]*"/,
  /getline\s*<\s*"[^"]*"/,
  /"[^"]*"\s*\|\s*getline/,
  /close\s*\(/,
];

/** SED side-effect patterns. */
const SED_SIDE_EFFECT_PATTERNS = [
  /[^\\]e\s/,
  /^e\s/,
  /[^\\]w\s/,
  /^w\s/,
  /[^\\]r\s/,
  /^r\s/,
];

/**
 * Write-redirection operators in file_redirect nodes.
 * Input-only redirections (`<`, `<<`, `<<<`) are safe.
 */
const WRITE_REDIRECT_OPERATORS = new Set(['>', '>>', '&>', '&>>', '>|']);

/**
 * Map of root command → known sub-command sets.
 * Used by `extractCommandRules()` to identify sub-commands vs arguments.
 */
const KNOWN_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set([
    'add',
    'am',
    'archive',
    'bisect',
    'blame',
    'branch',
    'bundle',
    'cat-file',
    'checkout',
    'cherry-pick',
    'clean',
    'clone',
    'commit',
    'config',
    'describe',
    'diff',
    'fetch',
    'format-patch',
    'gc',
    'grep',
    'init',
    'log',
    'ls-files',
    'ls-remote',
    'merge',
    'mv',
    'notes',
    'pull',
    'push',
    'range-diff',
    'rebase',
    'reflog',
    'remote',
    'reset',
    'restore',
    'revert',
    'rev-parse',
    'rm',
    'shortlog',
    'show',
    'stash',
    'status',
    'submodule',
    'switch',
    'tag',
    'worktree',
  ]),
  npm: new Set([
    'access',
    'adduser',
    'audit',
    'bugs',
    'cache',
    'ci',
    'completion',
    'config',
    'create',
    'dedupe',
    'deprecate',
    'diff',
    'dist-tag',
    'docs',
    'doctor',
    'edit',
    'exec',
    'explain',
    'explore',
    'find-dupes',
    'fund',
    'help',
    'hook',
    'init',
    'install',
    'install-ci-test',
    'install-test',
    'link',
    'login',
    'logout',
    'ls',
    'org',
    'outdated',
    'owner',
    'pack',
    'ping',
    'pkg',
    'prefix',
    'profile',
    'prune',
    'publish',
    'query',
    'rebuild',
    'repo',
    'restart',
    'root',
    'run',
    'run-script',
    'search',
    'set-script',
    'shrinkwrap',
    'star',
    'stars',
    'start',
    'stop',
    'team',
    'test',
    'token',
    'uninstall',
    'unpublish',
    'unstar',
    'update',
    'version',
    'view',
    'whoami',
  ]),
  yarn: new Set([
    'add',
    'autoclean',
    'bin',
    'cache',
    'check',
    'config',
    'create',
    'generate-lock-entry',
    'global',
    'help',
    'import',
    'info',
    'init',
    'install',
    'licenses',
    'link',
    'list',
    'login',
    'logout',
    'outdated',
    'owner',
    'pack',
    'policies',
    'publish',
    'remove',
    'run',
    'tag',
    'team',
    'test',
    'unlink',
    'unplug',
    'upgrade',
    'upgrade-interactive',
    'version',
    'versions',
    'why',
    'workspace',
    'workspaces',
  ]),
  pnpm: new Set([
    'add',
    'audit',
    'create',
    'dedupe',
    'deploy',
    'dlx',
    'env',
    'exec',
    'fetch',
    'import',
    'init',
    'install',
    'install-test',
    'licenses',
    'link',
    'list',
    'ls',
    'outdated',
    'pack',
    'patch',
    'patch-commit',
    'prune',
    'publish',
    'rebuild',
    'remove',
    'root',
    'run',
    'server',
    'setup',
    'store',
    'test',
    'uninstall',
    'unlink',
    'update',
    'why',
  ]),
  docker: new Set([
    'attach',
    'build',
    'commit',
    'compose',
    'container',
    'context',
    'cp',
    'create',
    'diff',
    'events',
    'exec',
    'export',
    'history',
    'image',
    'images',
    'import',
    'info',
    'inspect',
    'kill',
    'load',
    'login',
    'logout',
    'logs',
    'manifest',
    'network',
    'node',
    'pause',
    'plugin',
    'port',
    'ps',
    'pull',
    'push',
    'rename',
    'restart',
    'rm',
    'rmi',
    'run',
    'save',
    'search',
    'secret',
    'service',
    'stack',
    'start',
    'stats',
    'stop',
    'swarm',
    'system',
    'tag',
    'top',
    'trust',
    'unpause',
    'update',
    'version',
    'volume',
    'wait',
  ]),
  pip: new Set([
    'install',
    'download',
    'uninstall',
    'freeze',
    'inspect',
    'list',
    'show',
    'check',
    'config',
    'search',
    'cache',
    'index',
    'wheel',
    'hash',
    'completion',
    'debug',
    'help',
  ]),
  pip3: new Set([
    'install',
    'download',
    'uninstall',
    'freeze',
    'inspect',
    'list',
    'show',
    'check',
    'config',
    'search',
    'cache',
    'index',
    'wheel',
    'hash',
    'completion',
    'debug',
    'help',
  ]),
  cargo: new Set([
    'add',
    'bench',
    'build',
    'check',
    'clean',
    'clippy',
    'doc',
    'fetch',
    'fix',
    'fmt',
    'generate-lockfile',
    'init',
    'install',
    'locate-project',
    'login',
    'metadata',
    'new',
    'owner',
    'package',
    'pkgid',
    'publish',
    'read-manifest',
    'remove',
    'report',
    'run',
    'rustc',
    'rustdoc',
    'search',
    'test',
    'tree',
    'uninstall',
    'update',
    'vendor',
    'verify-project',
    'version',
    'yank',
  ]),
  kubectl: new Set([
    'annotate',
    'api-resources',
    'api-versions',
    'apply',
    'attach',
    'auth',
    'autoscale',
    'certificate',
    'cluster-info',
    'completion',
    'config',
    'cordon',
    'cp',
    'create',
    'debug',
    'delete',
    'describe',
    'diff',
    'drain',
    'edit',
    'events',
    'exec',
    'explain',
    'expose',
    'get',
    'kustomize',
    'label',
    'logs',
    'patch',
    'plugin',
    'port-forward',
    'proxy',
    'replace',
    'rollout',
    'run',
    'scale',
    'set',
    'taint',
    'top',
    'uncordon',
    'version',
    'wait',
  ]),
  make: new Set([]), // make targets are positional, not subcommands
};

/** Docker multi-level sub-command support (e.g., `docker compose up`). */
const DOCKER_COMPOSE_SUBCOMMANDS = new Set([
  'build',
  'config',
  'cp',
  'create',
  'down',
  'events',
  'exec',
  'images',
  'kill',
  'logs',
  'ls',
  'pause',
  'port',
  'ps',
  'pull',
  'push',
  'restart',
  'rm',
  'run',
  'start',
  'stop',
  'top',
  'unpause',
  'up',
  'version',
  'wait',
  'watch',
]);

// ---------------------------------------------------------------------------
// Parser Singleton
// ---------------------------------------------------------------------------

let parserInstance: Parser | null = null;
let bashLanguage: Parser.Language | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Resolve the path to a WASM file inside vendor/tree-sitter/.
 * Handles three deployment scenarios:
 *   - Source (src/utils/*.ts): 2 levels up to package root
 *   - Transpiled (dist/src/utils/*.js): 3 levels up
 *   - Bundle (dist/cli.js): vendor at same level (0 levels)
 */
function resolveWasmPath(filename: string): string {
  return resolveWasmPathForModule(filename, __filename_);
}

function resolveWasmPathForModule(
  filename: string,
  moduleFilePath: string,
  resolvePath: (moduleFilePath: string) => string = resolveModuleFilePath,
): string {
  const resolvedModuleFilePath = resolvePath(moduleFilePath);
  const moduleDir = path.dirname(resolvedModuleFilePath);
  const inSrcUtils = resolvedModuleFilePath.includes(path.join('src', 'utils'));
  const levelsUp = !inSrcUtils
    ? 0
    : resolvedModuleFilePath.endsWith('.ts')
      ? 2
      : 3;
  return path.join(
    moduleDir,
    ...Array<string>(levelsUp).fill('..'),
    'vendor',
    'tree-sitter',
    filename,
  );
}

/**
 * Initialise the tree-sitter Parser singleton.
 * Safe to call multiple times – only the first call does real work.
 */
export async function initParser(): Promise<void> {
  if (parserInstance) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const treeSitterWasm = resolveWasmPath('tree-sitter.wasm');
    await Parser.init({
      locateFile: () => treeSitterWasm,
    });
    parserInstance = new Parser();
    bashLanguage = await Parser.Language.load(
      resolveWasmPath('tree-sitter-bash.wasm'),
    );
    parserInstance.setLanguage(bashLanguage);
  })();

  return initPromise;
}

/**
 * Parse a shell command string into a tree-sitter Tree.
 * Initialises the parser lazily if needed.
 */
export async function parseShellCommand(command: string): Promise<Parser.Tree> {
  await initParser();
  return parserInstance!.parse(command);
}

// ---------------------------------------------------------------------------
// AST Helpers
// ---------------------------------------------------------------------------

type SyntaxNode = Parser.SyntaxNode;

/** Collect all descendant nodes of given types. */
function collectDescendants(
  node: SyntaxNode,
  types: Set<string>,
): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (types.has(current.type)) {
      result.push(current);
    }
    for (let i = current.childCount - 1; i >= 0; i--) {
      stack.push(current.child(i)!);
    }
  }
  return result;
}

/** Check if a tree contains any command_substitution or process_substitution node. */
function containsCommandSubstitutionAST(node: SyntaxNode): boolean {
  return (
    collectDescendants(
      node,
      new Set(['command_substitution', 'process_substitution']),
    ).length > 0
  );
}

/** Check if a redirected_statement contains a write-redirection. */
function hasWriteRedirection(node: SyntaxNode): boolean {
  if (node.type !== 'redirected_statement') return false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'file_redirect') {
      // The operator is the first non-descriptor child
      for (let j = 0; j < child.childCount; j++) {
        const op = child.child(j)!;
        if (op.type === 'file_descriptor') continue;
        // operator token
        if (WRITE_REDIRECT_OPERATORS.has(op.type)) return true;
        break; // only check the operator position
      }
    }
  }
  return false;
}

/**
 * Extract the command_name text from a `command` node.
 * Handles leading variable_assignment(s) gracefully.
 */
function getCommandName(commandNode: SyntaxNode): string | null {
  const nameNode = commandNode.childForFieldName('name');
  if (!nameNode) return null;
  return nameNode.text.toLowerCase();
}

/**
 * Argument node extraction using field name iteration.
 */
function getArgumentNodes(commandNode: SyntaxNode): SyntaxNode[] {
  const args: SyntaxNode[] = [];
  for (let i = 0; i < commandNode.childCount; i++) {
    const fieldName = commandNode.fieldNameForChild(i);
    if (fieldName === 'argument') {
      args.push(commandNode.child(i)!);
    }
  }
  return args;
}

/**
 * Strip outer quotes from a token text.
 * tree-sitter preserves quotes in argument text (e.g., `'s/foo/bar/e'`),
 * but for pattern matching we need the unquoted content.
 */
function stripOuterQuotes(text: string): string {
  if (text.length >= 2) {
    if (
      (text.startsWith("'") && text.endsWith("'")) ||
      (text.startsWith('"') && text.endsWith('"'))
    ) {
      return text.slice(1, -1);
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Read-Only Analysis (per-command)
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a single `command` node (simple command) is read-only.
 */
function evaluateCommandReadOnly(commandNode: SyntaxNode): boolean {
  const root = getCommandName(commandNode);
  if (!root) return true; // pure variable assignment
  const argNodes = getArgumentNodes(commandNode);
  const argTexts = argNodes.map((n) => stripOuterQuotes(n.text));

  if (!READ_ONLY_ROOT_COMMANDS.has(root)) return false;

  // Command-specific analysis
  if (root === 'git') return evaluateGitReadOnly(argTexts);
  if (root === 'find') return evaluateFindReadOnly(argTexts);
  if (root === 'sed') return evaluateSedReadOnly(argTexts);
  if (root === 'awk') return evaluateAwkReadOnly(argTexts);

  return true;
}

function evaluateGitReadOnly(args: string[]): boolean {
  // Skip global flags to find subcommand
  let idx = 0;
  while (idx < args.length && args[idx]!.startsWith('-')) {
    const flag = args[idx]!.toLowerCase();
    if (flag === '--version' || flag === '--help') return true;
    idx++;
  }
  if (idx >= args.length) return true; // `git` with only flags

  const subcommand = args[idx]!.toLowerCase();
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false;

  const rest = args.slice(idx + 1);
  if (subcommand === 'remote') {
    return !rest.some((a) => BLOCKED_GIT_REMOTE_ACTIONS.has(a.toLowerCase()));
  }
  if (subcommand === 'branch') {
    return !rest.some((a) => BLOCKED_GIT_BRANCH_FLAGS.has(a));
  }
  return true;
}

function evaluateFindReadOnly(args: string[]): boolean {
  for (const arg of args) {
    const lower = arg.toLowerCase();
    if (BLOCKED_FIND_FLAGS.has(lower)) return false;
    if (BLOCKED_FIND_PREFIXES.some((p) => lower.startsWith(p))) return false;
  }
  return true;
}

function evaluateSedReadOnly(args: string[]): boolean {
  for (const arg of args) {
    if (
      BLOCKED_SED_PREFIXES.some((p) => arg.startsWith(p)) ||
      arg === '--in-place'
    ) {
      return false;
    }
  }
  const scriptContent = args.join(' ');
  return !SED_SIDE_EFFECT_PATTERNS.some((p) => p.test(scriptContent));
}

function evaluateAwkReadOnly(args: string[]): boolean {
  const scriptContent = args.join(' ');
  return !AWK_SIDE_EFFECT_PATTERNS.some((p) => p.test(scriptContent));
}

// ---------------------------------------------------------------------------
// Statement-level read-only analysis
// ---------------------------------------------------------------------------

/**
 * Recursively evaluate whether a statement AST node is read-only.
 *
 * Handles: command, pipeline, list, redirected_statement, subshell,
 * variable_assignment, negated_command, and compound statements.
 */
function evaluateStatementReadOnly(node: SyntaxNode): boolean {
  switch (node.type) {
    case 'command':
      // Check for command substitution anywhere inside the command
      if (containsCommandSubstitutionAST(node)) return false;
      return evaluateCommandReadOnly(node);

    case 'pipeline': {
      // All commands in the pipeline must be read-only
      for (const child of node.namedChildren) {
        if (!evaluateStatementReadOnly(child)) return false;
      }
      return true;
    }

    case 'list': {
      // All commands joined by && / || must be read-only
      for (const child of node.namedChildren) {
        if (!evaluateStatementReadOnly(child)) return false;
      }
      return true;
    }

    case 'redirected_statement': {
      // Write redirections make it non-read-only
      if (hasWriteRedirection(node)) return false;
      // Evaluate the body statement
      const body = node.namedChildren[0];
      return body ? evaluateStatementReadOnly(body) : true;
    }

    case 'subshell': {
      // Evaluate all statements inside the subshell
      for (const child of node.namedChildren) {
        if (!evaluateStatementReadOnly(child)) return false;
      }
      return true;
    }

    case 'compound_statement': {
      // { cmd1; cmd2; } – evaluate each inner statement
      for (const child of node.namedChildren) {
        if (!evaluateStatementReadOnly(child)) return false;
      }
      return true;
    }

    case 'variable_assignment':
    case 'variable_assignments':
      // Pure assignments without a command – read-only (just sets env)
      return true;

    case 'negated_command': {
      const inner = node.namedChildren[0];
      return inner ? evaluateStatementReadOnly(inner) : true;
    }

    case 'function_definition':
      // Function definitions are not read-only operations per se
      return false;

    case 'if_statement':
    case 'while_statement':
    case 'for_statement':
    case 'case_statement':
    case 'c_style_for_statement':
      // Control flow constructs – conservatively non-read-only
      return false;

    case 'declaration_command':
      // export/declare/local/readonly/typeset – can modify env
      return false;

    default:
      // Unknown node types – conservatively non-read-only
      return false;
  }
}

// ---------------------------------------------------------------------------
// Public API: isShellCommandReadOnlyAST
// ---------------------------------------------------------------------------

/**
 * AST-based check whether a shell command is read-only.
 *
 * Replaces the regex-based `isShellCommandReadOnly()` from shellReadOnlyChecker.ts.
 * This version uses tree-sitter-bash for accurate parsing of:
 *   - Compound commands (&&, ||, ;, |)
 *   - Redirections (>, >>)
 *   - Command substitution ($(), ``)
 *   - Sub-shells, heredocs, etc.
 *
 * @param command - The shell command string to evaluate.
 * @returns `true` if the command only performs read-only operations.
 */
export async function isShellCommandReadOnlyAST(
  command: string,
): Promise<boolean> {
  if (typeof command !== 'string' || !command.trim()) return false;

  const tree = await parseShellCommand(command);
  const root = tree.rootNode;

  // Empty program
  if (root.namedChildCount === 0) return false;

  // Evaluate every top-level statement
  for (const stmt of root.namedChildren) {
    if (!evaluateStatementReadOnly(stmt)) {
      tree.delete();
      return false;
    }
  }

  tree.delete();
  return true;
}

// ---------------------------------------------------------------------------
// Public API: extractCommandRules
// ---------------------------------------------------------------------------

/**
 * Extract a simple command's root + subcommand from a `command` AST node.
 *
 * Returns a rule string following the minimum-scope principle:
 *   - root + known subcommand + `*` if there are remaining args
 *   - root + `*` if no known subcommand but has args
 *   - root only if the command has no args at all
 */
function extractRuleFromCommand(commandNode: SyntaxNode): string | null {
  const rootName = getCommandName(commandNode);
  if (!rootName) return null;

  const argNodes = getArgumentNodes(commandNode);
  const argTexts = argNodes.map((n) => n.text);

  // Skip leading flags to find potential subcommand
  let idx = 0;
  while (idx < argTexts.length && argTexts[idx]!.startsWith('-')) {
    idx++;
  }

  const knownSubs = KNOWN_SUBCOMMANDS[rootName];
  let rule = rootName;

  if (knownSubs && knownSubs.size > 0 && idx < argTexts.length) {
    const potentialSub = argTexts[idx]!.toLowerCase();
    if (knownSubs.has(potentialSub)) {
      rule = `${rootName} ${argTexts[idx]!}`;

      // Docker multi-level: docker compose <sub>
      if (
        rootName === 'docker' &&
        potentialSub === 'compose' &&
        idx + 1 < argTexts.length
      ) {
        const composeSub = argTexts[idx + 1]!.toLowerCase();
        if (DOCKER_COMPOSE_SUBCOMMANDS.has(composeSub)) {
          rule = `${rootName} compose ${argTexts[idx + 1]!}`;
          // Remaining args after compose sub
          if (idx + 2 < argTexts.length) {
            rule += ' *';
          }
          return rule;
        }
      }

      // Remaining args after subcommand
      if (idx + 1 < argTexts.length) {
        rule += ' *';
      }
      return rule;
    }
  }

  // No known subcommand – if there are any args, append *
  if (argTexts.length > 0) {
    rule += ' *';
  }

  return rule;
}

/**
 * Recursively extract rules from a statement node.
 * Handles pipeline, list, redirected_statement, etc.
 */
function extractRulesFromStatement(node: SyntaxNode): string[] {
  switch (node.type) {
    case 'command':
      return [extractRuleFromCommand(node)].filter(Boolean) as string[];

    case 'pipeline':
    case 'list':
    case 'compound_statement':
    case 'subshell': {
      const rules: string[] = [];
      for (const child of node.namedChildren) {
        rules.push(...extractRulesFromStatement(child));
      }
      return rules;
    }

    case 'redirected_statement': {
      const body = node.namedChildren[0];
      return body ? extractRulesFromStatement(body) : [];
    }

    case 'negated_command': {
      const inner = node.namedChildren[0];
      return inner ? extractRulesFromStatement(inner) : [];
    }

    case 'variable_assignment':
    case 'variable_assignments':
      // Pure assignments – no rule needed
      return [];

    default:
      // For complex constructs (if/while/for/case), try to extract from
      // named children conservatively
      return [];
  }
}

/**
 * Extract minimum-scope wildcard permission rules from a shell command.
 *
 * Rules follow the minimum-scope principle:
 *   - Preserve root command + sub-command, replace arguments with `*`
 *   - Compound commands are split → separate rules for each part
 *   - No arguments → no wildcard suffix
 *
 * @param command - The full shell command string.
 * @returns Deduplicated list of permission rule strings.
 *
 * @example
 * extractCommandRules('git clone https://github.com/foo/bar.git')
 * // → ['git clone *']
 *
 * extractCommandRules('npm install express')
 * // → ['npm install *']
 *
 * extractCommandRules('npm outdated')
 * // → ['npm outdated']
 *
 * extractCommandRules('cat /etc/passwd')
 * // → ['cat *']
 *
 * extractCommandRules('git clone foo && npm install')
 * // → ['git clone *', 'npm install']
 *
 * extractCommandRules('ls -la /tmp')
 * // → ['ls *']
 *
 * extractCommandRules('docker compose up -d')
 * // → ['docker compose up *']
 */
export async function extractCommandRules(command: string): Promise<string[]> {
  if (typeof command !== 'string' || !command.trim()) return [];

  const tree = await parseShellCommand(command);
  const root = tree.rootNode;
  const rules: string[] = [];

  for (const stmt of root.namedChildren) {
    rules.push(...extractRulesFromStatement(stmt));
  }

  tree.delete();

  // Deduplicate while preserving order
  return [...new Set(rules)];
}

// ---------------------------------------------------------------------------
// Reset (for testing)
// ---------------------------------------------------------------------------

/**
 * Reset the parser singleton. Only intended for testing.
 * @internal
 */
export function _resetParser(): void {
  if (parserInstance) {
    parserInstance.delete();
    parserInstance = null;
  }
  bashLanguage = null;
  initPromise = null;
}

/**
 * Internal helper exposed for tests.
 * @internal
 */
export function _resolveWasmPathForTesting(
  filename: string,
  moduleFilePath: string,
  resolvePath?: (moduleFilePath: string) => string,
): string {
  return resolveWasmPathForModule(filename, moduleFilePath, resolvePath);
}
