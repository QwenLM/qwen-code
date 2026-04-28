/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shell AST Parser — powered by web-tree-sitter + tree-sitter-bash.
 *
 * Provides:
 *   1. `initParser()`                    – lazy singleton Parser initialisation
 *   2. `parseShellCommand()`             – parse a command string into a tree-sitter Tree
 *   3. `isShellCommandReadOnlyAST()`     – AST-based read-only command detection
 *   4. `extractCommandRules()`           – extract minimum-scope wildcard permission rules
 *   5. `isParserReady()`                 – check if the parser singleton is initialised
 *   6. `splitCommandsAST()`              – AST-based compound command splitting
 *   7. `getCommandRootAST()`             – AST-based root command name extraction
 *   8. `getCommandRootsAST()`            – AST-based root command names extraction
 *   9. `detectCommandSubstitutionAST()`  – AST-based command-substitution detection (sync)
 *  10. `tokenizeCommandAST()`            – AST-based command tokenization for shell-semantics
 *  11. `extractRedirectsAST()`           – AST-based I/O redirect extraction
 */

import Parser from 'web-tree-sitter';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Load a WASM file as a Uint8Array.
 *
 * In bundle mode (esbuild with wasmBinaryPlugin), the `?binary` import is
 * transformed at build-time to embed the WASM bytes inline, so `dynamicImport`
 * succeeds and returns the bytes immediately — no external vendor files needed.
 *
 * In source / transpiled mode (Vitest, tsx, etc.), the `?binary` specifier is
 * unknown to Node's module resolver and the import throws.  The catch block
 * falls back to reading the file directly from node_modules.
 */
async function loadWasmBinary(
  dynamicImport: () => Promise<unknown>,
  fallbackSpecifier: string,
): Promise<Uint8Array> {
  const nativeFs =
    (process.getBuiltinModule?.('fs') as
      | typeof import('node:fs')
      | undefined) ?? fs;
  const moduleFilePath = fileURLToPath(import.meta.url);
  const isBundleMode =
    !moduleFilePath.includes(path.join('src', '')) &&
    !moduleFilePath.includes(path.join('dist', 'src', ''));

  try {
    if (isBundleMode) {
      // Bundle mode: esbuild replaces `?binary` imports with inline Uint8Array.
      const mod = await dynamicImport();
      const wasmBinary = (mod as { default?: unknown }).default;
      if (wasmBinary instanceof Uint8Array && wasmBinary.byteLength > 0) {
        return wasmBinary;
      }
    }
  } catch {
    // Fall through to node_modules lookup below.
  }

  // Source / dev mode: read the file directly from node_modules.
  const require = createRequire(import.meta.url);
  const filePath = require.resolve(fallbackSpecifier);
  return new Uint8Array(nativeFs.readFileSync(filePath));
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
/** Set to true permanently once WASM initialisation fails. */
let parserInitFailed = false;

/**
 * Initialise the tree-sitter Parser singleton.
 * Safe to call multiple times – only the first call does real work.
 */
export async function initParser(): Promise<void> {
  if (parserInstance) return;
  // Once init has permanently failed, skip retrying to prevent hangs.
  if (parserInitFailed)
    throw new Error(
      'tree-sitter WASM failed to initialise; using regex-based fallback',
    );
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const treeSitterWasm = await loadWasmBinary(
      () => import('web-tree-sitter/tree-sitter.wasm?binary' as string),
      'web-tree-sitter/tree-sitter.wasm',
    );
    await Parser.init({ wasmBinary: treeSitterWasm });
    parserInstance = new Parser();
    const bashWasm = await loadWasmBinary(
      () =>
        import('tree-sitter-wasms/out/tree-sitter-bash.wasm?binary' as string),
      'tree-sitter-wasms/out/tree-sitter-bash.wasm',
    );
    bashLanguage = await Parser.Language.load(bashWasm);
    parserInstance.setLanguage(bashLanguage);
  })().catch((err: unknown) => {
    // Mark as permanently failed so callers can use the regex fallback
    // instead of retrying (which could cause the agent to hang).
    parserInitFailed = true;
    initPromise = null;
    throw err;
  });

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

  // If the WASM parser is permanently unavailable (e.g. WASM file missing
  // after a symlinked install), return false (conservative: requires permission)
  // so the agent remains functional instead of hanging or crashing.
  if (parserInitFailed) {
    return false;
  }

  try {
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
  } catch {
    // Unexpected runtime failure (e.g. WASM init error on first call) –
    // conservatively return false (requires permission) rather than propagating.
    return false;
  }
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
// Public API: isParserReady / ensureParserInitStarted / parseShellCommandSync
// ---------------------------------------------------------------------------

/**
 * Check whether the tree-sitter parser singleton has been initialised.
 * Useful for callers that want to try sync AST functions before falling back.
 */
export function isParserReady(): boolean {
  return parserInstance !== null;
}

/**
 * Trigger parser initialisation in a fire-and-forget manner.
 *
 * This is called automatically by all sync AST functions when the parser is
 * not yet ready.  The current call will still fall back to the legacy
 * implementation, but the parser will be initialising in the background so
 * that subsequent calls can use the AST path.
 *
 * Safe to call multiple times — `initParser()` is idempotent.
 */
export function ensureParserInitStarted(): void {
  if (!parserInstance && !initPromise) {
    initParser().catch(() => {
      // Swallow errors — the sync fallback path will continue to work.
    });
  }
}

/**
 * Synchronously parse a shell command string.
 * Requires the parser to have been initialised via `initParser()` — throws if not.
 */
function parseShellCommandSync(command: string): Parser.Tree {
  if (!parserInstance) {
    throw new Error(
      'Shell AST parser not initialized. Call initParser() first.',
    );
  }
  return parserInstance.parse(command);
}

// ---------------------------------------------------------------------------
// Public API: splitCommandsAST
// ---------------------------------------------------------------------------

/**
 * Collect individual simple commands (leaf-level) from an AST node.
 *
 * Recursively descends into `program`, `list`, and `pipeline` nodes to
 * extract each leaf `command` / `redirected_statement` as its text.
 * This mirrors the behaviour of the string-based `splitCommands()`: every
 * sub-command separated by `&&`, `||`, `;`, `|`, or `&` is returned as
 * a separate string.
 */
function collectLeafCommands(node: SyntaxNode, commands: string[]): void {
  switch (node.type) {
    case 'program':
    case 'list':
    case 'pipeline':
      for (const child of node.namedChildren) {
        collectLeafCommands(child, commands);
      }
      break;

    case 'command':
    case 'redirected_statement':
      commands.push(node.text.trim());
      break;

    case 'negated_command': {
      // `! cmd` — include the whole text as a single command
      commands.push(node.text.trim());
      break;
    }

    case 'subshell':
    case 'compound_statement':
      // Include the whole construct as-is
      commands.push(node.text.trim());
      break;

    case 'variable_assignment':
    case 'variable_assignments':
      // Pure assignments — skip
      break;

    default:
      // For other node types (if/while/for/case/function_definition),
      // include the whole text as a single "command".
      if (node.text.trim()) {
        commands.push(node.text.trim());
      }
      break;
  }
}

/**
 * Split a compound shell command into individual simple commands using AST.
 *
 * Unlike the string-based `splitCommands()`, this correctly handles all
 * quoting contexts, heredocs, and nested constructs because parsing is
 * delegated to tree-sitter-bash.
 *
 * Returns `null` if the parser has not been initialised yet.
 */
export function splitCommandsAST(command: string): string[] | null {
  if (!parserInstance) {
    ensureParserInitStarted();
    return null;
  }

  const tree = parseShellCommandSync(command);
  const commands: string[] = [];
  collectLeafCommands(tree.rootNode, commands);
  tree.delete();
  return commands.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Public API: getCommandRootAST / getCommandRootsAST
// ---------------------------------------------------------------------------

/**
 * Find the first `command` node in the AST by depth-first traversal.
 * Descends through `program`, `list`, `pipeline`, `redirected_statement`,
 * `negated_command`, `subshell`, and `compound_statement`.
 */
function findFirstCommandNode(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'command') return node;
  if (node.type === 'redirected_statement') {
    const body = node.namedChildren[0];
    return body ? findFirstCommandNode(body) : null;
  }
  if (node.type === 'negated_command') {
    const inner = node.namedChildren[0];
    return inner ? findFirstCommandNode(inner) : null;
  }
  for (const child of node.namedChildren) {
    const found = findFirstCommandNode(child);
    if (found) return found;
  }
  return null;
}

/**
 * Extract the root command name from a shell command using AST.
 * Returns `null` if the parser is not ready.
 *
 * @example getCommandRootAST('ls -la /tmp')   // 'ls'
 * @example getCommandRootAST('git status')     // 'git'
 * @example getCommandRootAST('/usr/bin/grep foo bar')  // 'grep'
 */
export function getCommandRootAST(command: string): string | undefined | null {
  if (!parserInstance) {
    ensureParserInitStarted();
    return null; // null = parser not ready
  }

  const tree = parseShellCommandSync(command);
  const firstCmd = findFirstCommandNode(tree.rootNode);
  if (!firstCmd) {
    tree.delete();
    return undefined;
  }
  const name = getCommandName(firstCmd);
  tree.delete();
  if (!name) return undefined;
  // If the command is a path, return the last component
  return name.split(/[\\/]/).pop();
}

/**
 * Extract root command names from ALL sub-commands in a compound command.
 * Returns `null` if the parser is not ready.
 */
export function getCommandRootsAST(command: string): string[] | null {
  if (!parserInstance) {
    ensureParserInitStarted();
    return null;
  }

  const subCommands = splitCommandsAST(command);
  if (!subCommands) return null;
  return subCommands
    .map((c) => getCommandRootAST(c))
    .filter((c): c is string => !!c);
}

// ---------------------------------------------------------------------------
// Public API: detectCommandSubstitutionAST (sync)
// ---------------------------------------------------------------------------

/**
 * Synchronous AST-based detection of command substitution ($(), ``, <(), >()).
 *
 * Returns `null` if the parser is not ready — callers should fall back to
 * the string-based implementation in that case.
 *
 * This is more accurate than the string-based implementation because
 * tree-sitter correctly handles quoting contexts, heredocs, and nested
 * constructs.
 */
export function detectCommandSubstitutionAST(command: string): boolean | null {
  if (!parserInstance) {
    ensureParserInitStarted();
    return null;
  }

  const tree = parseShellCommandSync(command);
  const result = containsCommandSubstitutionAST(tree.rootNode);
  tree.delete();
  return result;
}

// ---------------------------------------------------------------------------
// Public API: tokenizeCommandAST
// ---------------------------------------------------------------------------

/**
 * Result of AST-based command tokenization for shell-semantics analysis.
 */
export interface ASTTokenizeResult {
  /** The command name (lowercase, basename only). */
  commandName: string;
  /** Arguments (outer quotes stripped, redirects excluded). */
  args: string[];
  /** Read-redirect target paths (e.g. `< file`). */
  redirectReads: string[];
  /** Write-redirect target paths (e.g. `> file`, `>> file`). */
  redirectWrites: string[];
}

/**
 * Input-only redirection operators.
 */
const READ_REDIRECT_OPERATORS = new Set(['<']);

/**
 * Tokenize a single simple command using AST, extracting:
 *   - command name
 *   - argument list (quotes stripped, redirects removed)
 *   - read/write redirect targets
 *
 * Returns `null` if the parser is not ready or the input is empty/invalid.
 */
export function tokenizeCommandAST(
  simpleCommand: string,
): ASTTokenizeResult | null {
  if (!parserInstance) {
    ensureParserInitStarted();
    return null;
  }
  if (!simpleCommand.trim()) return null;

  const tree = parseShellCommandSync(simpleCommand);
  const root = tree.rootNode;

  // Find the actual command node — it may be wrapped in redirected_statement
  let commandNode: SyntaxNode | null = null;
  let redirectParent: SyntaxNode | null = null;

  const firstChild = root.namedChildCount > 0 ? root.namedChildren[0]! : null;
  if (!firstChild) {
    tree.delete();
    return null;
  }

  if (firstChild.type === 'redirected_statement') {
    redirectParent = firstChild;
    commandNode = findFirstCommandNode(firstChild);
  } else if (firstChild.type === 'command') {
    commandNode = firstChild;
  } else {
    // Not a simple command
    tree.delete();
    return null;
  }

  if (!commandNode) {
    tree.delete();
    return null;
  }

  const cmdName = getCommandName(commandNode);
  if (!cmdName) {
    // Pure variable assignment, check if = is present
    tree.delete();
    return null;
  }

  const argNodes = getArgumentNodes(commandNode);
  const args = argNodes.map((n) => stripOuterQuotes(n.text));

  // Extract redirects
  const redirectReads: string[] = [];
  const redirectWrites: string[] = [];

  const redirectSource = redirectParent ?? commandNode.parent;
  if (redirectSource && redirectSource.type === 'redirected_statement') {
    for (let i = 0; i < redirectSource.childCount; i++) {
      const child = redirectSource.child(i)!;
      if (child.type === 'file_redirect') {
        const { op, target } = extractFileRedirect(child);
        if (target) {
          if (READ_REDIRECT_OPERATORS.has(op)) {
            redirectReads.push(target);
          } else if (WRITE_REDIRECT_OPERATORS.has(op)) {
            redirectWrites.push(target);
          }
        }
      } else if (child.type === 'heredoc_redirect') {
        // heredoc redirects are input — skip (no path target)
      } else if (child.type === 'herestring_redirect') {
        // herestring redirects are input — skip
      }
    }
  }

  tree.delete();

  return {
    commandName: cmdName,
    args,
    redirectReads,
    redirectWrites,
  };
}

/**
 * Extract the operator and target path from a `file_redirect` node.
 */
function extractFileRedirect(node: SyntaxNode): {
  op: string;
  target: string;
} {
  let op = '>';
  let target = '';

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === 'file_descriptor') continue;
    // First non-descriptor child is the operator
    if (!target && WRITE_REDIRECT_OPERATORS.has(child.type)) {
      op = child.type;
      continue;
    }
    if (!target && READ_REDIRECT_OPERATORS.has(child.type)) {
      op = child.type;
      continue;
    }
    // The target word
    if (
      child.type === 'word' ||
      child.type === 'string' ||
      child.type === 'raw_string' ||
      child.type === 'concatenation' ||
      child.type === 'simple_expansion' ||
      child.type === 'expansion'
    ) {
      target = stripOuterQuotes(child.text);
    }
  }

  return { op, target };
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
  parserInitFailed = false;
}

/**
 * Force the parser into the "init failed" state. Only intended for testing
 * fallback behaviour without actually breaking WASM loading.
 * @internal
 */
export function _setParserFailedForTesting(): void {
  parserInitFailed = true;
  initPromise = null;
  if (parserInstance) {
    parserInstance.delete();
    parserInstance = null;
  }
  bashLanguage = null;
}
