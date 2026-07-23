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

import type Parser from 'web-tree-sitter';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isShellCommandReadOnly } from './shellReadOnlyChecker.js';
import {
  classifyAwkCommandSafety,
  classifySedCommandSafety,
  hasShellPatternExpansion,
} from './shell-safety-rules.js';

export type ShellCommandSafety = 'read-only' | 'write' | 'unknown';
type Safety = ShellCommandSafety;
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

const WRITE_ROOT_COMMAND =
  /^(chgrp|chmod|chown|cp|install|ln|mkdir|mkfifo|mknod|mv|rename|rm|rmdir|shred|touch|truncate|unlink)$/;
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
const WRITE_GIT_SUBCOMMAND =
  /^(add|am|checkout|cherry-pick|clean|clone|commit|fetch|gc|init|merge|mv|pull|push|rebase|reset|restore|revert|rm|stash|switch)$/;
/** git remote actions that mutate state. */
const WRITE_GIT_REMOTE_ACTION =
  /^(add|remove|rm|rename|set-branches|set-head|set-url|update)$/;
const GIT_EXTERNAL_HELPER_OPTION =
  /^--(?:ext-diff|filters|show-signature|textconv|open-files-in-pager)(?:=|$)/;
const GIT_COMMIT_VALUE_OPTION =
  /^(?:-[CcFmt]|--(?:author|cleanup|date|file|fixup|message|pathspec-from-file|reedit-message|reuse-message|squash|template|trailer))$/;
/** git branch flags that mutate state. */
const WRITE_GIT_BRANCH_FLAG =
  /^(?:-[cCdDmMu](?:.|$)|--(?:delete|move|copy|set-upstream(?:-to)?|unset-upstream|create-reflog|edit-description)(?:=|$))/;
const GIT_BRANCH_LIST_FLAG =
  /^(?:-[alr]|--(?:all|list|remotes|show-current|contains|no-contains|merged|no-merged|points-at))(?:=|$)/;

const BLOCKED_FIND_PREFIXES = ['-fls', '-fprint', '-fprintf'];
const FIND_VALUE_PREDICATE =
  /^-(?:[ac]?newer|newer[a-z]{2}|[acm](?:min|time)|context|fstype|gid|group|i?(?:lname|name|path|regex)|inum|links|maxdepth|mindepth|path|perm|printf|regextype|samefile|size|type|uid|used|user|wholename|xtype)$/;

const UNIQ_VALUE_OPTIONS = new Set(
  '-f --skip-fields -s --skip-chars -w --check-chars'.split(' '),
);
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
let parserClass: typeof Parser;
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
    // Dynamically import the web-tree-sitter runtime to minimize synchronous bundle size.
    const { default: ParserClass } = (await import(
      'web-tree-sitter'
    )) as unknown as { default: typeof Parser };

    const treeSitterWasm = await loadWasmBinary(
      () => import('web-tree-sitter/tree-sitter.wasm?binary' as string),
      'web-tree-sitter/tree-sitter.wasm',
    );
    await ParserClass.init({ wasmBinary: treeSitterWasm });
    const bashWasm = await loadWasmBinary(
      () =>
        import('tree-sitter-wasms/out/tree-sitter-bash.wasm?binary' as string),
      'tree-sitter-wasms/out/tree-sitter-bash.wasm',
    );
    bashLanguage = await ParserClass.Language.load(bashWasm);
    parserClass = ParserClass;
    parserInstance = new ParserClass();
    parserInstance.setLanguage(bashLanguage);
  })().catch((err: unknown) => {
    const failedParser = parserInstance;
    parserInstance = null;
    bashLanguage = null;
    // Mark as permanently failed so callers can use the regex fallback
    // instead of retrying (which could cause the agent to hang).
    parserInitFailed = true;
    initPromise = null;
    try {
      failedParser?.delete();
    } catch {
      // Preserve the initialization error.
    }
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
  const parser = parserInstance!;
  try {
    return parser.parse(command);
  } catch (error) {
    parserInstance = null;
    let replacement: Parser | null = null;
    try {
      replacement = new parserClass();
      replacement.setLanguage(bashLanguage);
      parserInstance = replacement;
    } catch {
      try {
        replacement?.delete();
      } catch {
        // Preserve the parse error.
      }
      bashLanguage = null;
      parserInitFailed = true;
      initPromise = null;
    } finally {
      parser.delete();
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// AST Helpers
// ---------------------------------------------------------------------------

type SyntaxNode = Parser.SyntaxNode;

const SHELL_EXPANSION_TYPES = new Set(
  'simple_expansion expansion arithmetic_expansion'.split(' '),
);
const CHILD_STATEMENT =
  /^(?:pipeline|list|subshell|compound_statement|negated_command)$/;
/** Collect all descendant nodes of given types. */
function collectDescendants(
  node: SyntaxNode,
  types: Set<string>,
  outermostOnly = false,
): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (types.has(current.type)) {
      result.push(current);
      if (outermostOnly) continue;
    }
    for (let i = current.childCount - 1; i >= 0; i--) {
      stack.push(current.child(i)!);
    }
  }
  return result;
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

function hasShellExpansion(node: SyntaxNode): boolean {
  return (
    collectDescendants(node, SHELL_EXPANSION_TYPES).length > 0 ||
    (['word', 'concatenation'].includes(node.type) &&
      hasShellPatternExpansion(node.text))
  );
}

function mergeSafety(...results: ShellCommandSafety[]): ShellCommandSafety {
  if (results.includes('write')) return 'write';
  if (results.includes('unknown')) return 'unknown';
  return 'read-only';
}

function beforeTerminator(args: string[]): string[] {
  const end = args.indexOf('--');
  return args.slice(0, end < 0 ? args.length : end);
}

function hasHelp(args: string[], valueOptions: string[] = []): boolean {
  return beforeTerminator(args).some(
    (arg, index, options) =>
      /^(?:--help|--version)$/i.test(arg) &&
      !valueOptions.includes(options[index - 1]!),
  );
}

function withoutOptionValues(args: string[], valueOption: RegExp): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    result.push(args[i]!);
    if (valueOption.test(args[i]!)) i++;
  }
  return result;
}

function evaluateOutputOption(args: string[], long = true, short = true) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') break;
    if ((short && arg === '-o') || (long && arg === '--output')) {
      return args[i + 1] ? 'write' : 'unknown';
    }
    if (short && arg.startsWith('-o') && arg.length > 2) return 'write';
    if (long && arg.startsWith('--output=')) {
      return arg.length > 9 ? 'write' : 'unknown';
    }
  }
  return null;
}

function evaluateGitSafety(args: string[]): ShellCommandSafety {
  const first = args[0];
  if (!first || first === '--version') return 'read-only';
  if (first === '--help') return args.length === 1 ? 'read-only' : 'unknown';
  if (first.startsWith('-')) return 'unknown';
  const subcommand = first.toLowerCase();
  const rest = args.slice(1);
  const options = beforeTerminator(rest);
  const invokesHelper =
    options.some((arg) => GIT_EXTERNAL_HELPER_OPTION.test(arg)) ||
    (subcommand === 'grep' && options.some((arg) => arg.startsWith('-O'))) ||
    (['log', 'show'].includes(subcommand) &&
      options.some((arg) => /%G[?GKFPST]/.test(arg)));
  if (WRITE_GIT_SUBCOMMAND.test(subcommand)) {
    const effectiveArgs =
      subcommand === 'commit'
        ? withoutOptionValues(rest, GIT_COMMIT_VALUE_OPTION)
        : rest;
    const effectiveOptions = beforeTerminator(effectiveArgs);
    const help = hasHelp(effectiveArgs);
    const dryRun =
      effectiveOptions.includes('--dry-run') ||
      (effectiveOptions.includes('-n') &&
        ['add', 'clean', 'mv', 'push', 'rm'].includes(subcommand));
    return help || dryRun ? 'unknown' : 'write';
  }
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return 'unknown';
  if (['diff', 'log', 'show'].includes(subcommand)) {
    const output = evaluateOutputOption(rest, true, false);
    if (output) return output;
  }
  if (
    subcommand === 'blame' &&
    beforeTerminator(rest).some((arg) => /^--output(?:=|$)/.test(arg))
  )
    return 'unknown';
  if (subcommand !== 'branch' && hasHelp(rest)) return 'unknown';
  if (subcommand === 'remote') {
    const action = rest.find((arg) => !arg.startsWith('-'))?.toLowerCase();
    if (!action) return invokesHelper ? 'unknown' : 'read-only';
    if (['show', 'get-url'].includes(action))
      return rest.some((arg) =>
        /^(?:add|remove|rm|rename|set-branches|set-head|set-url|update|prune)$/i.test(
          arg,
        ),
      ) || invokesHelper
        ? 'unknown'
        : 'read-only';
    if (WRITE_GIT_REMOTE_ACTION.test(action)) return 'write';
    if (action === 'prune')
      return rest.some((arg) => ['-n', '--dry-run'].includes(arg))
        ? 'unknown'
        : 'write';
    return 'unknown';
  }
  if (subcommand === 'branch') {
    const actions = withoutOptionValues(rest, /^--(?:format|sort)$/);
    const actionOptions = beforeTerminator(actions);
    if (hasHelp(actions)) return 'unknown';
    if (actions.some((arg) => WRITE_GIT_BRANCH_FLAG.test(arg)))
      return actionOptions.some((arg) => WRITE_GIT_BRANCH_FLAG.test(arg))
        ? 'write'
        : 'unknown';
    if (actions.length !== rest.length) return 'unknown';
    const lists = actionOptions.some((arg) => GIT_BRANCH_LIST_FLAG.test(arg));
    if (lists) return 'read-only';
    if (rest.some((arg) => !arg.startsWith('-'))) return 'write';
    if (rest.includes('--')) return 'unknown';
    if (invokesHelper) return 'unknown';
    return rest.length === 0 ? 'read-only' : 'unknown';
  }
  if (invokesHelper) return 'unknown';
  return 'read-only';
}

function evaluateFindSafety(args: string[]): ShellCommandSafety {
  let result: ShellCommandSafety = 'read-only';
  for (let i = 0; i < args.length; i++) {
    const lower = args[i]!.toLowerCase();
    if (lower === '--') return mergeSafety(result, 'unknown');
    if (/^--(?:help|version)$/.test(lower)) return 'unknown';
    if (FIND_VALUE_PREDICATE.test(lower)) {
      if (!args[++i]?.match(/^[^-]/)) result = mergeSafety(result, 'unknown');
      continue;
    }
    if (lower === '-delete') {
      result = 'write';
      continue;
    }
    if (BLOCKED_FIND_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      result = 'write';
      i += lower.startsWith('-fprintf') ? 2 : 1;
      continue;
    }
    if (['-exec', '-execdir', '-ok', '-okdir'].includes(lower)) {
      const invoked = args[i + 1]?.toLowerCase();
      let end = -1;
      for (let index = i + 2; index < args.length; index++) {
        if ([';', '\\;', '+'].includes(args[index]!)) {
          end = index;
          break;
        }
      }
      const invokedArgs = args.slice(i + 2, end < 0 ? undefined : end);
      let nested: Safety = 'unknown';
      if (invoked && WRITE_ROOT_COMMAND.test(invoked))
        nested = hasHelp(invokedArgs) ? 'unknown' : 'write';
      else if (invoked && /^(kill|killall|pkill)$/.test(invoked))
        nested = processSafety(invoked, invokedArgs);
      result = mergeSafety(result, nested);
      i = end < 0 ? args.length : end;
    }
  }
  return result;
}

function evaluateSedSafety(args: string[]): ShellCommandSafety {
  return classifySedCommandSafety(args);
}

function evaluateAwkSafety(args: string[]): ShellCommandSafety {
  return classifyAwkCommandSafety(args);
}

function evaluateUniqSafety(args: string[]): ShellCommandSafety {
  let positional = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      return args.length - i + positional > 2 ? 'write' : 'read-only';
    } else if (UNIQ_VALUE_OPTIONS.has(arg)) {
      if (!args[++i]) return 'unknown';
    } else if (arg === '-' || !arg.startsWith('-')) positional++;
  }
  return positional >= 2 ? 'write' : 'read-only';
}

function processSafety(root: string, args: string[]): Safety {
  const options = beforeTerminator(args);
  const signalZero = /^(?:SIG)?0+$/i;
  const signalValueOptions = [
    '--signal',
    ...(root === 'pkill' ? [] : ['-s']),
    ...(root === 'kill' ? ['-n'] : []),
  ];
  if (
    args.length === 0 ||
    hasHelp(args) ||
    options.some((arg) => ['-h', '-V', '-help', '-version'].includes(arg))
  )
    return 'unknown';
  if (
    options.some(
      (arg, index) =>
        (/[$`*?()[\]{}]/.test(arg) &&
          (arg.startsWith('-') ||
            signalValueOptions.includes(options[index - 1]!))) ||
        /^-(?:[lL0]|-(?:.*list|table)(?:=|$))/.test(arg) ||
        (/^--signal=/.test(arg) && signalZero.test(arg.slice(9))) ||
        /^-(?:SIG)?0+$/i.test(arg) ||
        (root === 'kill' && /^-[sn](?:SIG)?0+$/i.test(arg)) ||
        (root === 'killall' && /^-s(?:SIG)?0+$/i.test(arg)) ||
        (index > 0 &&
          signalValueOptions.includes(options[index - 1]!) &&
          signalZero.test(arg)),
    )
  )
    return 'unknown';
  return 'write';
}

function evaluateSubstitutions(node: SyntaxNode): ShellCommandSafety {
  const substitutions = collectDescendants(
    node,
    new Set(['command_substitution', 'process_substitution']),
    true,
  );
  if (substitutions.length === 0) return 'read-only';
  return mergeSafety(
    'unknown',
    ...substitutions
      .flatMap((substitution) => substitution.namedChildren)
      .map(evaluateStatementSafety),
  );
}

function evaluateCommandSafety(commandNode: SyntaxNode): ShellCommandSafety {
  const rawRoot = commandNode.childForFieldName('name')?.text;
  const root = getCommandName(commandNode);
  const argNodes = getArgumentNodes(commandNode);
  const args = argNodes.map((node) => stripOuterQuotes(node.text));
  let result: ShellCommandSafety;
  if (!root) result = 'read-only';
  else if (rawRoot !== root) result = 'unknown';
  else if (WRITE_ROOT_COMMAND.test(root)) {
    result = hasHelp(args) ? 'unknown' : 'write';
  } else if (/^(kill|killall|pkill)$/.test(root)) {
    result = processSafety(root, args);
  } else if (root === 'git') result = evaluateGitSafety(args);
  else if (root === 'find') result = evaluateFindSafety(args);
  else if (root === 'sed') result = evaluateSedSafety(args);
  else if (root === 'awk') result = evaluateAwkSafety(args);
  else if (root === 'sort' || root === 'tree') {
    result = evaluateOutputOption(args, root === 'sort') ?? 'read-only';
    if (hasHelp(args, ['-o', '--output'])) result = 'unknown';
    if (
      beforeTerminator(args).some(
        (arg) =>
          /^(?:--o|-[^-]+o)/.test(arg) ||
          (root === 'sort' && arg.startsWith('--co')),
      )
    ) {
      result = mergeSafety(result, 'unknown');
    }
  } else if (root === 'uniq') {
    result = hasHelp(args) ? 'unknown' : evaluateUniqSafety(args);
  } else if (root === 'tee') {
    const writesFile = args.some(
      (arg, index) => !arg.startsWith('-') || args[index - 1] === '--',
    );
    result = writesFile ? 'write' : 'unknown';
  } else if (root === 'dd') {
    result = args.some((arg) => arg.startsWith('of=')) ? 'write' : 'unknown';
  } else if (
    (root === 'printf' &&
      beforeTerminator(args).some((arg) => /^-[^-]*v/.test(arg))) ||
    ['less', 'more'].includes(root) ||
    (['rg', 'ripgrep'].includes(root) &&
      beforeTerminator(args).some((arg) =>
        /^(?:--(?:hostname-bin|pre)(?:=|$)|--search-zip$|-[^-]*z)/.test(arg),
      ))
  ) {
    result = 'unknown';
  } else {
    result = READ_ONLY_ROOT_COMMANDS.has(root) ? 'read-only' : 'unknown';
  }
  if (
    result === 'read-only' &&
    root &&
    /^(awk|find|git|printf|rg|ripgrep|sed|sort|tree|uniq)$/.test(root) &&
    argNodes.some((node) => hasShellExpansion(node))
  ) {
    result = 'unknown';
  }
  if (
    result === 'write' &&
    !['find', 'git', 'sed', 'sort', 'tree'].includes(root ?? '') &&
    hasHelp(args)
  )
    result = 'unknown';
  const hasEnvironment = commandNode.namedChildren.some(
    (child) => child.type === 'variable_assignment',
  );
  if (root && hasEnvironment) result = mergeSafety(result, 'unknown');
  return mergeSafety(
    result,
    evaluateRedirectionSafety(commandNode),
    ...commandNode.namedChildren
      .filter((child) => !child.type.endsWith('_redirect'))
      .map(evaluateSubstitutions),
  );
}

function evaluateRedirectionSafety(node: SyntaxNode): ShellCommandSafety {
  let result: ShellCommandSafety = 'read-only';
  for (const redirect of node.namedChildren) {
    if (!redirect.type.endsWith('_redirect')) continue;
    result = mergeSafety(result, evaluateSubstitutions(redirect));
    if (redirect.type !== 'file_redirect') continue;
    const operator = redirect.children.find(
      (child) => child.type !== 'file_descriptor',
    );
    if (!operator) return 'unknown';
    if (WRITE_REDIRECT_OPERATORS.has(operator.type)) return 'write';
    if (operator.type === '>&') {
      const destination = redirect.childForFieldName('destination');
      if (!destination) return 'unknown';
      const target = stripOuterQuotes(destination.text);
      if (/^(?:\d+|-)$/.test(target)) continue;
      result = mergeSafety(
        result,
        /[$`*?()[\]{}]/.test(target) ? 'unknown' : 'write',
      );
    }
  }
  return result;
}

function childrenSafety(node: SyntaxNode, floor: Safety = 'read-only'): Safety {
  return mergeSafety(floor, ...node.namedChildren.map(evaluateStatementSafety));
}

function evaluateStatementSafety(node: SyntaxNode): ShellCommandSafety {
  if (node.type === 'command') return evaluateCommandSafety(node);
  if (CHILD_STATEMENT.test(node.type)) return childrenSafety(node);
  if (node.type === 'redirected_statement')
    return mergeSafety(
      ...node.namedChildren
        .filter((child) => !child.type.endsWith('_redirect'))
        .map((child) => evaluateStatementSafety(child)),
      evaluateRedirectionSafety(node),
    );
  if (/^variable_assignments?$/.test(node.type))
    return mergeSafety(
      node.parent?.namedChildCount === 1 ? 'read-only' : 'unknown',
      evaluateSubstitutions(node),
    );
  if (node.type === 'function_definition') return 'unknown';
  return childrenSafety(node, 'unknown');
}

async function classifyInternal(command: string): Promise<Safety> {
  const tree = await parseShellCommand(command);
  try {
    const root = tree.rootNode;
    if (root.namedChildCount === 0 || root.hasError) return 'unknown';
    return mergeSafety(...root.namedChildren.map(evaluateStatementSafety));
  } finally {
    tree.delete();
  }
}
export async function classifyShellCommandSafety(
  command: string,
): Promise<ShellCommandSafety> {
  if (typeof command !== 'string' || !command.trim()) return 'unknown';
  return classifyInternal(command).catch(() => 'unknown');
}

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
  // after a symlinked install), fall back to the regex-based checker so the
  // agent remains functional instead of hanging or crashing.
  if (parserInitFailed) {
    return isShellCommandReadOnly(command);
  }

  try {
    return (await classifyInternal(command)) === 'read-only';
  } catch {
    // Unexpected runtime failure (e.g. WASM init error on first call) –
    // fall back to the regex-based checker rather than propagating the error.
    return isShellCommandReadOnly(command);
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
