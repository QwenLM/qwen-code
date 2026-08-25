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
import { getLocalGitConfigRisk } from './git-config-safety.js';
import type { LocalGitConfigRisk } from './git-config-safety.js';
import { isShellCommandReadOnly } from './shellReadOnlyChecker.js';
import {
  classifyAwkCommandSafety,
  classifySedCommandSafety,
  hasShellPatternExpansion,
} from './shell-safety-rules.js';

export type ShellCommandSafety = 'read-only' | 'write' | 'unknown';
type Safety = ShellCommandSafety;

/** Caller-supplied extensions to the classifier's built-in knowledge. */
export interface ShellSafetyOptions {
  /**
   * Extra root command names the user vouched for as read-only.
   *
   * Consulted in exactly two places, both of which must stay:
   *
   * 1. the terminal fallback branch of `evaluateCommandSafety`, so roots the
   *    classifier already understands (`rm`, `git`, `tee`, …) keep their
   *    built-in classification and cannot be vouched away; and
   * 2. `localGitConfigMakesCommandUnsafe`, where the entire planted-config
   *    gate for vouched wrappers hangs off it. Dropping that arm silently
   *    removes planted-config protection for every vouched git frontend.
   */
  extraReadOnlyRoots?: ReadonlySet<string>;
}

const NO_EXTRA_ROOTS: ReadonlySet<string> = new Set();

function extraRoots(options?: ShellSafetyOptions): ReadonlySet<string> {
  return options?.extraReadOnlyRoots ?? NO_EXTRA_ROOTS;
}
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
  /^(chattr|chgrp|chmod|chown|cp|csplit|fallocate|install|ln|mkdir|mkfifo|mknod|mktemp|mv|patch|rename|rm|rmdir|shred|split|touch|truncate|unlink)$/;

/**
 * Roots that never classify read-only, whatever a caller vouches for.
 *
 * Two families, both of which make the analysis below meaningless rather than
 * merely uncertain:
 *
 * - Launchers — shell and language interpreters, multi-call binaries, and
 *   wrappers whose whole job is to execute a command taken from their
 *   arguments. Trusting one is not a statement about that binary, it is a
 *   statement about whatever it is handed (`time rm -rf build`).
 * - State planters — builtins that rebind how a *later* command resolves.
 *   The classifier evaluates statements independently, so it cannot see that
 *   `hash -p ./evil/git git && git status` turns a trusted root into an
 *   attacker-chosen binary.
 *
 * Neither list closes its family on its own. A launcher can always be named
 * something this file has never heard of, and an interpreter takes its payload
 * as a code string or a script path rather than as a command name, so nothing
 * in the argument text identifies it. What bounds the exposure is
 * `vouchedRootIsSafe` below: it accepts a vouch only for an invocation whose
 * shape the classifier can actually read. These lists are the floor under
 * that rule, not a substitute for it.
 */
export const NEVER_READ_ONLY_ROOT_COMMANDS: ReadonlySet<string> = new Set([
  // Shell interpreters and multi-call binaries.
  'ash',
  'bash',
  'busybox',
  'cmd',
  'cmd.exe',
  'csh',
  'dash',
  'fish',
  'ksh',
  'mksh',
  'osh',
  'posh',
  'powershell',
  'pwsh',
  'sh',
  'tcsh',
  'toybox',
  'yash',
  'zsh',
  // Language interpreters. The payload is a code string or a script path, so
  // no argument inspection can tell a read from a write.
  'bun',
  'bunx',
  'clojure',
  'crystal',
  'dart',
  'deno',
  'dmd',
  'elixir',
  'escript',
  'expect',
  'ghc',
  'groovy',
  'lua',
  'luajit',
  'java',
  'jshell',
  'julia',
  'kotlin',
  'nim',
  'node',
  'nodejs',
  'ocaml',
  'osascript',
  'perl',
  'pnpx',
  'php',
  'python',
  'python3',
  'racket',
  'rscript',
  'ruby',
  'runghc',
  'scala',
  'swift',
  'tclsh',
  'ts-node',
  'tsx',
  'wish',
  'zig',
  // Build and package tools. The payload is a Makefile recipe, a package
  // script, or a downloaded package — never argv — so no argument inspection
  // can see it either.
  'ant',
  'bazel',
  'buck',
  'buck2',
  'bundle',
  'bundler',
  'cargo',
  'cc',
  'c++',
  'clang',
  'guile',
  'tcc',
  'clang++',
  'cmake',
  'conda',
  'go',
  'g++',
  'gcc',
  'composer',
  'dotnet',
  'gem',
  'gradle',
  'grunt',
  'gulp',
  'hatch',
  'javac',
  'just',
  'lein',
  'make',
  'meson',
  'mvn',
  'ninja',
  'nix',
  'nix-build',
  'nix-shell',
  'nox',
  'nx',
  'pants',
  'pdm',
  'pip',
  'pip3',
  'pipenv',
  'pipx',
  'poetry',
  'rake',
  'rustc',
  'rye',
  'sbt',
  'scons',
  'task',
  'tox',
  'turbo',
  'uv',
  'uvx',
  // Container runtimes: the payload can live entirely inside the image.
  'docker',
  'podman',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  // Privilege, namespace, scheduling, and process launchers.
  'at',
  'batch',
  'bwrap',
  'crontab',
  'caffeinate',
  'chroot',
  'doas',
  'env',
  'fakeroot',
  'flock',
  'ionice',
  'linux32',
  'linux64',
  'newgrp',
  'nice',
  'nohup',
  'nsenter',
  'parallel',
  'pkexec',
  'run0',
  'runuser',
  'setarch',
  'script',
  'rsh',
  'setsid',
  'sg',
  'ssh',
  'stdbuf',
  'su',
  'sudo',
  'sudoedit',
  'systemd-nspawn',
  'systemd-run',
  'time',
  'timeout',
  'unshare',
  'watch',
  'wine',
  'wsl',
  'wsl.exe',
  'xargs',
  // Launchers whose payload is a path argument, added alongside the families
  // above: `run-parts <dir>` executes every script in the directory,
  // `setpriv --reset-env <prog>`, `schroot -- <prog>` and `proot <prog>` each
  // exec an argument the analysis reads as an ordinary literal.
  'proot',
  'run-parts',
  'schroot',
  'setpriv',
  // Siblings of the interpreter, shell and tracer families above, added
  // after review found each one vouchable while its family member was not.
  'bpython',
  'ccl',
  'clisp',
  'ecl',
  'elvish',
  'erl',
  'es',
  'gdb',
  'ipython',
  'jruby',
  'jython',
  'ksh88',
  'ksh93',
  'lldb',
  'ltrace',
  'micropython',
  'mruby',
  'nu',
  'oil',
  'py',
  'pypy',
  'pypy3',
  'pythonw',
  'raku',
  'rakudo',
  'rbash',
  'rc',
  'rksh',
  'rzsh',
  'sbcl',
  'strace',
  'truffleruby',
  'valgrind',
  'xonsh',
  // Builtins that execute or re-resolve another command.
  'alias',
  'bind',
  'builtin',
  'command',
  'compgen',
  'complete',
  'coproc',
  'enable',
  'eval',
  'exec',
  'fc',
  'hash',
  'history',
  'getopts',
  'let',
  'mapfile',
  'read',
  'readarray',
  'set',
  'shopt',
  'source',
  // `.` is the POSIX spelling of `source`; tree-sitter parses `. ./evil.sh`
  // as an ordinary command node.
  '.',
  'trap',
  'unalias',
]);

/**
 * Whether a root is a versioned spelling of a name on the refusal floor —
 * `python3.12`, `lua5.4`, the free-threaded `python3.13t`, Debian's hyphenated
 * `gcc-13` and `clang-15`, the historical ABI suffix `python3.7m`, upstream
 * tarball spellings such as `luajit-2.1.0-beta3`, and distro spellings such as
 * `guile-3.0`, `ghc-9.6.6`, `lldb-18`, `ksh93`.
 *
 * Derived from `NEVER_READ_ONLY_ROOT_COMMANDS` rather than restating its
 * families in a second alternation. The second list had drifted from the first
 * within one round of adding to it: review swept every floor name with a
 * `<name>-9.9` shape and found 183 of them vouchable, because the alternation
 * named only the families someone had thought to copy across. Deriving the
 * answer means a name added to the floor is versioned-refused the same day,
 * with nothing to keep in sync.
 *
 * Listing every release of every interpreter is not a finite job, so
 * everything from the first digit of the suffix onward is accepted as a
 * version.
 */
function namesAVersionedRefusedRoot(root: string): boolean {
  // Every split point is tried rather than stripping greedily from the first
  // digit, because a floor name may end in a digit that is part of its
  // identity: greedy stripping turns `linux32-9.9` into `linux`, which is not
  // on the floor, and `run09` into `run`.
  for (let i = root.length - 1; i > 0; i--) {
    const suffix = root.slice(i);
    if (!/^-?[0-9][0-9a-z.-]*$/.test(suffix)) continue;
    if (NEVER_READ_ONLY_ROOT_COMMANDS.has(root.slice(0, i))) return true;
  }
  return false;
}

/**
 * Node types inside a redirect that carry no statement of their own: the
 * heredoc's own delimiters and body, and the words and expansions naming a
 * redirect's destination, which `evaluateRedirectionSafety` already owns.
 *
 * Deliberately a skip-list rather than an allow-list. tree-sitter-bash nests
 * whatever follows `&&`, `||` or `;` on the opener line *inside* the redirect
 * node, and that is an open set — `pipeline`, `negated_command`,
 * `if_statement`, `for_statement`, `c_style_for_statement`,
 * `select_statement`, `declaration_command` and more all appear there.
 * Enumerating them has been wrong twice. Anything not listed here is handed to
 * `evaluateStatementSafety`, whose default arm floors an unrecognised type at
 * `unknown`, so a shape nobody anticipated prompts instead of vanishing.
 */
const INERT_REDIRECT_CHILD: ReadonlySet<string> = new Set([
  'command_substitution',
  'concatenation',
  'expansion',
  'file_descriptor',
  'heredoc_body',
  'heredoc_end',
  'heredoc_start',
  'number',
  'process_substitution',
  'raw_string',
  'simple_expansion',
  'string',
  'word',
]);

/** Roots with a dedicated evaluator in `evaluateCommandSafety`. */
const SPECIAL_ROOT_COMMAND = /^(dd|kill|killall|pkill|tee)$/;

/**
 * Whether a word names a command this file decides the safety of. Each
 * `=`-separated part contributes its basename, with and without a trailing
 * `.exe`, so `/bin/rm`, `rm.exe` and `--exec=/bin/rm` all name `rm` while an
 * ordinary path argument does not — `./report.json` names `report.json`, not
 * the `.` that is the POSIX spelling of `source`.
 *
 * `.` and `..` contribute nothing: as a whole word they are the directory a
 * read-only CLI is routinely pointed at (`ib list .`), and they can never
 * name an executable in argument position. The POSIX `source` spelling is
 * refused as a *root* by the dispatch chain, which reaches
 * `NEVER_READ_ONLY_ROOT_COMMANDS` before any vouch is consulted.
 */
function namesAKnownCommand(word: string): boolean {
  return word
    .toLowerCase()
    .split('=')
    .flatMap((part) => {
      if (part === '.' || part === '..') return [];
      const basename = part.split(/[\\/]/).pop() ?? '';
      return [basename, basename.replace(/\.exe$/, '')];
    })
    .some(
      (name) =>
        READ_ONLY_ROOT_COMMANDS.has(name) ||
        NEVER_READ_ONLY_ROOT_COMMANDS.has(name) ||
        namesAVersionedRefusedRoot(name) ||
        WRITE_ROOT_COMMAND.test(name) ||
        SPECIAL_ROOT_COMMAND.test(name),
    );
}

/**
 * Characters an argument may contain and still mean, at run time, exactly what
 * it says here. Deliberately a whitelist: quoting, escaping, expansion and
 * globbing are each an open-ended way to spell a word the shell rewrites
 * before the binary sees it (`r\m`, `r'm'`, `$cmd`, `*` all reach argv as
 * `rm`), and matching those forms one at a time never terminates.
 *
 * Letters, digits and marks are matched by Unicode property, not by `\w`:
 * every shell metacharacter is ASCII, so a bare non-ASCII word is literal by
 * construction and refusing it would only cost a prompt on ordinary paths.
 */
const LITERAL_ARGUMENT = /^[\p{L}\p{N}\p{M}_@%+=:,./-]+$/u;

/**
 * Whether a caller-vouched root may classify read-only for this invocation.
 *
 * A vouch says "this binary only reads"; it can never say "and so does
 * whatever I pass it". The classifier cannot recognise every launcher by name
 * — an unknown binary may be one, and an interpreter's payload is a code
 * string, not a command name — so the vouch is honoured only for invocations
 * it can actually read:
 *
 * - every argument is a plain literal word, so its text is what the binary
 *   receives, and
 * - no argument names a command this file knows, so a launcher we have never
 *   heard of cannot use the vouch to smuggle one past the analysis, and
 * - the root itself is not a known command under another spelling
 *   (`git.exe`), which would otherwise skip the dispatch chain above, and
 * - no argument is one of git's redirecting global options or an option that
 *   makes a git read verb run a helper program. A vouched wrapper is treated
 *   as a possible git frontend elsewhere in this file; these options change
 *   which repository, which config, or which executables git uses, so a
 *   wrapper carrying one escapes that treatment entirely — `gitw -c
 *   core.fsmonitor=./evil.sh status` needs no hostile checkout at all.
 *
 * The cost of the last rule is a prompt for a vouched CLI that spells its own
 * config flag `-c` or `-C`. Refusing costs a confirmation prompt; accepting
 * wrongly costs the write.
 */
function vouchedRootIsSafe(root: string, argNodes: SyntaxNode[]): boolean {
  if (namesAKnownCommand(root)) return false;
  const argTexts = argNodes.map((node) => stripOuterQuotes(node.text));
  const shapeIsLiteral = argNodes.every((node, index) => {
    const arg = argTexts[index]!;
    return (
      LITERAL_ARGUMENT.test(node.text) &&
      !hasShellExpansion(node) &&
      !namesAKnownCommand(node.text) &&
      !GIT_REDIRECTING_GLOBAL_OPTION.test(arg) &&
      !ATTACHED_CONFIG_OR_PATH_OPTION.test(arg) &&
      !GIT_EXTERNAL_HELPER_OPTION.test(arg)
    );
  });
  return shapeIsLiteral && vouchedGitShapeIsSafe(argTexts);
}
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

/**
 * git's global options that redirect which repository it reads, which config
 * it applies, or where it resolves its sub-command executables.
 *
 * `evaluateGitSafety` screens literal git by refusing any leading-dash first
 * argument. A vouched wrapper cannot be screened that broadly — most CLIs take
 * flags, and refusing all of them would retract the feature — so the specific
 * redirecting options are named instead. Unlike the open set of binaries that
 * `NEVER_READ_ONLY_ROOT_COMMANDS` chases, this one is finite and
 * authoritative: it is git's own documented global option list.
 */
const GIT_REDIRECTING_GLOBAL_OPTION =
  /^(?:-[Cc]|--(?:git-dir|work-tree|namespace|config-env|exec-path|bare))(?:=|$)/;

/**
 * A single-dash argument that could carry git's `-C <path>` or
 * `-c <key>=<value>` payload attached to the option letter instead of spaced.
 *
 * Real git refuses the attached form — `handle_options` in `git.c` compares
 * with `!strcmp(cmd, "-c")` / `"-C"`, so `git -C. status` and
 * `git -ccore.fsmonitor=./evil.sh status` both exit 129 with `unknown option`
 * (verified against git 2.50.1; pinned in the test suite). A vouched wrapper
 * is not git, though, and one that normalises its own argv before forwarding
 * hands git back the spaced form that plants the config. Screened for every
 * vouched invocation, not only git-shaped ones, because planting an alias
 * through the option makes the first word a non-git verb
 * (`gitw -calias.z=config z core.fsmonitor ./evil.sh`) and a wrapper invoked
 * with flags alone has no verb to shape-match at all.
 *
 * Deliberately narrower than "any attached `-c`/`-C`": config injection needs
 * a `key=value`, and `-C` needs a path. That keeps `-cp` and `-classpath`
 * working; it costs a prompt for `-Cdir` and for a single-dash `-flag=value`
 * spelling such as `-count=5`, which is the spelling git's own `-c` uses.
 */
const ATTACHED_CONFIG_OR_PATH_OPTION = /^-(?!-)(?:C.+|[^-]*=)/;

/**
 * A single-dash cluster carrying a `c`/`C` somewhere other than the front —
 * `-pcCORE.fsmonitor=x`, `-pC/hostile`. Real git accepts no clustered global
 * options at all, so refusing these costs a genuine frontend nothing. Applied
 * only where the invocation is git-shaped (or carries no verb to shape-match),
 * so an unrelated CLI's `-cp`/`-classpath` is untouched. All-digit arguments
 * are exempt: `-10` is git's own `git log -<n>` shortcut.
 */
const CLUSTERED_GIT_REDIRECTING_OPTION = /^-(?!-)(?!\d+$)[^-]*[Cc]/;

/**
 * git's complete command vocabulary, as reported by
 * `git --list-cmds=builtins,main,others` (git 2.50.1).
 *
 * `vouchedGitShapeIsSafe` used to recognise a git invocation from the read-verb
 * list plus two write-verb regexes, which meant every verb outside those three
 * sets — `config`, `bisect`, `submodule`, `difftool`, `prune`, `update-index`,
 * `notes`, `maintenance`, `hook`, `repack` — was not recognised as git-shaped
 * at all and sailed past unscreened, giving a vouched wrapper *less* scrutiny
 * than literal git for exactly the verbs that run programs. Git's vocabulary
 * is finite and authoritative, so the recognition is done against all of it and
 * every real verb is handed to `evaluateGitSafety`, whose floor is `unknown`.
 *
 * `--list-cmds` is structurally blind to git's exec-fallback porcelains — the
 * dashed scripts git finds on PATH as `git-<verb>` — so `svn`, `cvsserver`,
 * `citool`, `gui` and `instaweb` are appended by hand below. That is also why
 * the list is a snapshot rather than a complete enumeration: a verb added by a
 * future git, or a third-party `git-<verb>` on PATH, is simply unrecognised,
 * which is the pre-existing behaviour, and the floor still refuses it for
 * literal git.
 */
const GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  // Exec-fallback porcelains: `git <verb>` runs `git-<verb>` from PATH, so
  // these never appear under any `--list-cmds` category even where installed.
  'citool',
  'cvsserver',
  'gui',
  'instaweb',
  'svn',
  'add',
  'am',
  'annotate',
  'apply',
  'archive',
  'backfill',
  'bisect',
  'blame',
  'branch',
  'bugreport',
  'bundle',
  'cat-file',
  'check-attr',
  'check-ignore',
  'check-mailmap',
  'check-ref-format',
  'checkout',
  'checkout--worker',
  'checkout-index',
  'cherry',
  'cherry-pick',
  'clean',
  'clone',
  'column',
  'commit',
  'commit-graph',
  'commit-tree',
  'config',
  'count-objects',
  'credential',
  'credential-cache',
  'credential-cache--daemon',
  'credential-osxkeychain',
  'credential-store',
  'daemon',
  'describe',
  'diagnose',
  'diff',
  'diff-files',
  'diff-index',
  'diff-pairs',
  'diff-tree',
  'difftool',
  'difftool--helper',
  'fast-export',
  'fast-import',
  'fetch',
  'fetch-pack',
  'filter-branch',
  'fmt-merge-msg',
  'for-each-ref',
  'for-each-repo',
  'format-patch',
  'fsck',
  'fsck-objects',
  'fsmonitor--daemon',
  'gc',
  'get-tar-commit-id',
  'grep',
  'gui--askpass',
  'hash-object',
  'help',
  'hook',
  'http-backend',
  'http-fetch',
  'http-push',
  'imap-send',
  'index-pack',
  'init',
  'init-db',
  'interpret-trailers',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'mailinfo',
  'mailsplit',
  'maintenance',
  'merge',
  'merge-base',
  'merge-file',
  'merge-index',
  'merge-octopus',
  'merge-one-file',
  'merge-ours',
  'merge-recursive',
  'merge-recursive-ours',
  'merge-recursive-theirs',
  'merge-resolve',
  'merge-subtree',
  'merge-tree',
  'mergetool',
  'mktag',
  'mktree',
  'multi-pack-index',
  'mv',
  'name-rev',
  'notes',
  'p4',
  'pack-objects',
  'pack-redundant',
  'pack-refs',
  'patch-id',
  'pickaxe',
  'prune',
  'prune-packed',
  'pull',
  'push',
  'quiltimport',
  'range-diff',
  'read-tree',
  'rebase',
  'receive-pack',
  'reflog',
  'refs',
  'remote',
  'remote-ext',
  'remote-fd',
  'remote-ftp',
  'remote-ftps',
  'remote-http',
  'remote-https',
  'repack',
  'replace',
  'replay',
  'request-pull',
  'rerere',
  'reset',
  'restore',
  'rev-list',
  'rev-parse',
  'revert',
  'rm',
  'send-email',
  'send-pack',
  'sh-i18n--envsubst',
  'shell',
  'shortlog',
  'show',
  'show-branch',
  'show-index',
  'show-ref',
  'sparse-checkout',
  'stage',
  'stash',
  'status',
  'stripspace',
  'submodule',
  'submodule--helper',
  'subtree',
  'switch',
  'symbolic-ref',
  'tag',
  'unpack-file',
  'unpack-objects',
  'update-index',
  'update-ref',
  'update-server-info',
  'upload-archive',
  'upload-archive--writer',
  'upload-pack',
  'var',
  'verify-commit',
  'verify-pack',
  'verify-tag',
  'version',
  'web--browse',
  'whatchanged',
  'worktree',
  'write-tree',
]);

/**
 * Whether a vouched-root set covers the root as spelled.
 *
 * `.exe` is stripped only on Windows, where PATHEXT makes `mytool` and
 * `mytool.exe` the same file. On POSIX they are two different files, and the
 * one nobody legitimately ships is the one an attacker can create in any
 * writable PATH directory without winning a shadowing race — so extending a
 * vouch for `mytool` to `mytool.exe` there would hand a planted binary the
 * vouch. The *refusal* side still strips `.exe` everywhere: recognising
 * `git.exe` as git is fail-closed, and the asymmetry is deliberate.
 */
function vouchCovers(extra: ReadonlySet<string>, root: string): boolean {
  if (extra.has(root)) return true;
  if (process.platform !== 'win32') return false;
  // Both directions there, since the two spellings are one file: an entry
  // written `mytool.exe` — the natural spelling on Windows, and one
  // `BARE_COMMAND_NAME` accepts — otherwise fails to cover `mytool` and the
  // user is prompted for exactly the command they vouched.
  return extra.has(root.replace(/\.exe$/, '')) || extra.has(`${root}.exe`);
}

/**
 * Whether an invocation of a vouched root looks like a git invocation, and if
 * so whether git's own evaluator calls it read-only.
 *
 * A vouch cannot say which binary it names — this file already treats one as a
 * possible git frontend for the planted-config gate, and the e2e plan's own
 * example wrapper is `exec git "$@"`. Screening every vouched root through
 * `evaluateGitSafety` would refuse every CLI whose verbs are not git's, so the
 * screen is applied only when the first non-flag argument is a git command.
 * Then the wrapper gets exactly what literal git gets: the write-verb list, the
 * `branch -D` flag arm, `--output`, and the `%G` gpg-helper arm.
 *
 * The cost is a prompt for a vouched CLI whose own verb collides with one of
 * git's 170 — `ib add`, `ib tag`, `ib config`, `ib init`. Read verbs collide
 * harmlessly (`ib status`, `ib log` stay read-only); the rest cost a keystroke.
 */
function vouchedGitShapeIsSafe(argTexts: string[]): boolean {
  // Everything after `--` is a pathspec, not an option or a verb.
  const terminator = argTexts.indexOf('--');
  const scanned = terminator < 0 ? argTexts : argTexts.slice(0, terminator);
  // Screened before the verb lookup and independently of it: an option can sit
  // on either side of the verb, and an invocation of flags alone has no verb.
  const clustered = scanned.some((arg) =>
    CLUSTERED_GIT_REDIRECTING_OPTION.test(arg),
  );
  const verbIndex = scanned.findIndex((arg) => !arg.startsWith('-'));
  if (verbIndex < 0) return !clustered;
  if (!GIT_SUBCOMMANDS.has(scanned[verbIndex]!.toLowerCase())) return true;
  if (clustered) return false;
  // Sliced at the verb, but out of the *untruncated* list: the `--` cut above
  // exists to find the verb and screen the options, and everything after `--`
  // is still a positional git reads. Passing the truncated tail hid them from
  // the write arms — `gitw branch -- newbranch` reached `evaluateGitSafety` as
  // a bare `['branch']`, which is a read. The evaluator handles `--` itself.
  return evaluateGitSafety(argTexts.slice(verbIndex)) === 'read-only';
}

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
 * The subset that runs inside a heredoc body, where expansion follows
 * double-quote rules. `<(…)` is not expanded there, so including it would only
 * refuse a body that quotes the text.
 */
const HEREDOC_SUBSTITUTION = /\$\(|`/;

/**
 * `${v@P}` prompt expansion, which runs any `$(…)` held in the variable's
 * value. In a pattern word it is a leaf, so the `@`/`P` child-adjacency check
 * never sees it.
 *
 * Deliberately not anchored to a brace-free span: `${a[${b}]@P}` nests a brace
 * inside the expansion, and a `[^{}]*` bridge stops at it — so the computed
 * subscript form escaped while bash still ran the expansion. This is a leaf
 * fallback for sites the node walk cannot reach, so treating any `@P` that
 * co-occurs with a `${` as unsafe costs at most a prompt.
 */
const PROMPT_EXPANSION = /\$\{[\s\S]*@P/;

/**
 * A command or process substitution that survived the substitution-node walk.
 * Both openers count: bash runs `<(…)` and `>(…)` wherever it runs `$(…)` —
 * in a pattern word, that is. See `HEREDOC_SUBSTITUTION` for the one place it
 * does not.
 */
const HIDDEN_SUBSTITUTION = /\$\(|`|<\(|>\(/;

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

function evaluateSubstitutions(
  node: SyntaxNode,
  extra: ReadonlySet<string>,
): ShellCommandSafety {
  const substitutions = collectDescendants(
    node,
    new Set(['command_substitution', 'process_substitution']),
    true,
  );
  if (substitutions.length === 0) {
    for (const expansion of collectDescendants(node, new Set(['expansion']))) {
      for (let i = 0; i < expansion.childCount - 1; i++) {
        if (
          expansion.child(i)?.type === '@' &&
          expansion.child(i + 1)?.type === 'P'
        ) {
          return 'unknown';
        }
      }
      // tree-sitter-bash parses the pattern word of `${v%%…}`, `${v%…}`,
      // `${v##…}` and `${v#…}` as a single leaf, so a substitution inside it
      // yields no node of its own even though bash runs it while expanding.
      // Nothing was collected above, so an opener still present in an
      // expansion is exactly that hidden channel.
      if (
        HIDDEN_SUBSTITUTION.test(expansion.text) ||
        PROMPT_EXPANSION.test(expansion.text)
      ) {
        return 'unknown';
      }
    }
    // A heredoc body is one leaf too (`<<-` bodies always, `<<` bodies when
    // nothing inside them parsed), and bash expands it before feeding it to
    // stdin — unless the delimiter is quoted, which makes the body inert.
    // Expansion there follows double-quote rules: `$(…)`, backticks and `@P`
    // run, `<(…)` does not.
    for (const body of collectDescendants(node, new Set(['heredoc_body']))) {
      if (
        !HEREDOC_SUBSTITUTION.test(body.text) &&
        !PROMPT_EXPANSION.test(body.text)
      ) {
        continue;
      }
      const delimiter = body.parent?.namedChildren.find(
        (child) => child.type === 'heredoc_start',
      );
      // `<<\EOF` quotes the delimiter as surely as `<<'EOF'` does.
      if (delimiter && /['"\\]/.test(delimiter.text)) continue;
      return 'unknown';
    }
    return 'read-only';
  }
  return mergeSafety(
    'unknown',
    ...substitutions
      .flatMap((substitution) => substitution.namedChildren)
      .map((child) => evaluateStatementSafety(child, extra)),
  );
}

function evaluateCommandSafety(
  commandNode: SyntaxNode,
  extra: ReadonlySet<string>,
): ShellCommandSafety {
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
  } else if (
    NEVER_READ_ONLY_ROOT_COMMANDS.has(root) ||
    namesAVersionedRefusedRoot(root)
  ) {
    // Decided here rather than by filtering the caller's set, so no caller can
    // vouch a launcher or a state planter back in.
    result = 'unknown';
  } else if (READ_ONLY_ROOT_COMMANDS.has(root)) {
    result = 'read-only';
  } else if (vouchCovers(extra, root)) {
    // Terminal fallback: every root the classifier understands specially is
    // handled above, so a caller-supplied root can only ever add to the
    // built-in read-only set — never override a write classification.
    result = vouchedRootIsSafe(root, argNodes) ? 'read-only' : 'unknown';
  } else {
    result = 'unknown';
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
    evaluateRedirectionSafety(commandNode, extra),
    ...commandNode.namedChildren
      .filter((child) => !child.type.endsWith('_redirect'))
      .map((child) => evaluateSubstitutions(child, extra)),
  );
}

function evaluateRedirectionSafety(
  node: SyntaxNode,
  extra: ReadonlySet<string>,
): ShellCommandSafety {
  let result: ShellCommandSafety = 'read-only';
  for (const redirect of node.namedChildren) {
    if (!redirect.type.endsWith('_redirect')) continue;
    result = mergeSafety(result, evaluateSubstitutions(redirect, extra));
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

function childrenSafety(
  node: SyntaxNode,
  extra: ReadonlySet<string>,
  floor: Safety = 'read-only',
): Safety {
  return mergeSafety(
    floor,
    ...node.namedChildren.map((child) => evaluateStatementSafety(child, extra)),
  );
}

function evaluateStatementSafety(
  node: SyntaxNode,
  extra: ReadonlySet<string>,
): ShellCommandSafety {
  if (node.type === 'command') return evaluateCommandSafety(node, extra);
  if (CHILD_STATEMENT.test(node.type)) return childrenSafety(node, extra);
  if (node.type === 'redirected_statement')
    return mergeSafety(
      ...node.namedChildren
        .filter((child) => !child.type.endsWith('_redirect'))
        .map((child) => evaluateStatementSafety(child, extra)),
      // Whatever follows the heredoc opener on the same line is parsed
      // *inside* the redirect node — `vtool <<EOF && rm -rf build` puts the
      // `rm` beside the heredoc body, and `cat <<EOF >out.txt` puts the write
      // redirect there — so filtering the redirect out above dropped both
      // from the analysis entirely.
      ...node.namedChildren
        .filter((child) => child.type.endsWith('_redirect'))
        .flatMap((redirect) => [
          // A redirect nested in a redirect is a redirect, not a statement:
          // it belongs to the redirection axis, which never reached inside
          // the heredoc node because it only walks direct children.
          evaluateRedirectionSafety(redirect, extra),
          ...redirect.namedChildren
            .filter(
              (child) =>
                !INERT_REDIRECT_CHILD.has(child.type) &&
                !child.type.endsWith('_redirect'),
            )
            .map((child) => evaluateStatementSafety(child, extra)),
        ]),
      evaluateRedirectionSafety(node, extra),
    );
  if (/^variable_assignments?$/.test(node.type))
    return mergeSafety(
      node.parent?.namedChildCount === 1 ? 'read-only' : 'unknown',
      evaluateSubstitutions(node, extra),
    );
  if (node.type === 'function_definition') return 'unknown';
  return childrenSafety(node, extra, 'unknown');
}

/**
 * Whether a repository's own `.git/config` turns this command into a write.
 *
 * A hostile checkout can set `diff.external` or `core.fsmonitor` to a script
 * of its choosing, so `git diff` and `git status` run attacker code without
 * either word appearing in the command.
 *
 * A caller-vouched root gets the same treatment as literal `git`, and without
 * the sub-command filter: the vouch exists for wrapper CLIs, a wrapper is
 * free to spell its verb anywhere in argv (the reporting issue's own CLI puts
 * it in the *second* argument), and this file cannot know which of a private
 * binary's verbs reach git. Repositories that plant nothing are unaffected —
 * `getLocalGitConfigRisk` reports no risk and the command stays read-only.
 */
function localGitConfigMakesCommandUnsafe(
  root: SyntaxNode,
  cwd: string,
  extra: ReadonlySet<string>,
): boolean {
  let changedDirectory = false;
  let usesDiff = false;
  let usesStatus = false;
  // Probed at most once per classification. The probe is a synchronous
  // `spawnSync` with a 1s timeout; running it inside the loop cost one
  // blocking git launch per vouched-wrapper command node — N+1 per
  // classification of a compound — on the event loop, for a value that cannot
  // change between nodes.
  let cachedRisk: LocalGitConfigRisk | undefined;
  const risk = () => (cachedRisk ??= getLocalGitConfigRisk(cwd));

  for (const command of collectDescendants(root, new Set(['command']))) {
    const name = getCommandName(command);
    if (name === 'cd' || name === 'pushd') {
      changedDirectory = true;
      continue;
    }
    if (name === null) continue;
    if (name !== 'git') {
      if (!vouchCovers(extra, name)) continue;
      // A wrapper has no sub-command filter, so a repository-local key that
      // makes *any* read verb run a program reaches it — a planted textconv
      // driver through `.gitattributes`, a clean/smudge filter, the gpg
      // program behind a signature display, or a `!` shell alias, which git
      // runs for a verb it does not recognise. Literal `git` is screened from
      // these by `evaluateGitSafety`'s read-only verb list; the wrapper is not.
      // Ordered so the free check runs first: a `cd` already decides the
      // answer and makes the probe pointless.
      if (changedDirectory) return true;
      if (risk().helperProgram) return true;
      usesDiff = true;
      usesStatus = true;
      continue;
    }
    const subcommand = stripOuterQuotes(
      getArgumentNodes(command)[0]?.text ?? '',
    ).toLowerCase();
    if (subcommand !== 'diff' && subcommand !== 'status') continue;
    if (changedDirectory) return true;
    usesDiff ||= subcommand === 'diff';
    usesStatus ||= subcommand === 'status';
  }

  if (!usesDiff && !usesStatus) return false;
  const { diffExternal, fsmonitor } = risk();
  return (usesDiff && diffExternal) || (usesStatus && fsmonitor);
}

function fallbackGitConfigMakesCommandUnsafe(
  command: string,
  cwd: string,
): boolean {
  if (/\b(?:cd|pushd)\b[\s\S]*\bgit\b/i.test(command)) return true;
  if (!/\bgit\b/i.test(command)) return false;
  const risk = getLocalGitConfigRisk(cwd);
  return risk.diffExternal || risk.fsmonitor;
}

async function classifyInternal(
  command: string,
  extra: ReadonlySet<string>,
  cwd?: string,
): Promise<Safety> {
  const tree = await parseShellCommand(command);
  try {
    const root = tree.rootNode;
    if (root.namedChildCount === 0 || root.hasError) return 'unknown';
    const safety = mergeSafety(
      ...root.namedChildren.map((child) =>
        evaluateStatementSafety(child, extra),
      ),
    );
    if (safety === 'read-only' && command.includes('\\\n')) {
      const normalizedSafety = await classifyInternal(
        command.replaceAll('\\\n', ''),
        extra,
        cwd,
      );
      if (normalizedSafety !== 'read-only') return 'unknown';
    }
    if (safety !== 'read-only' || !cwd) return safety;
    return localGitConfigMakesCommandUnsafe(root, cwd, extra)
      ? 'unknown'
      : 'read-only';
  } finally {
    tree.delete();
  }
}
/**
 * Builtins that rebind how a *later* command resolves or what it reads.
 *
 * `read`/`mapfile`/`readarray`/`getopts` are here alongside the obvious
 * `cd`/`export` family because they assign variables from stdin or argv —
 * `read PATH <<< ./evil` plants exactly what `export PATH=./evil` does — and
 * `let PATH=a` assigns arithmetically. `trap`, `enable`, `fc`, `alias`,
 * `unalias`, `hash` and `shopt` rebind what a later *name* resolves to, which
 * is the same unsoundness reached from the other side: a `DEBUG` trap runs
 * before every later command without appearing in any of them. `exec` is here
 * rather than among the resolution prefixes below because `exec > file`
 * carries no command at all and redirects the current shell.
 */
const STATE_PLANTING_BUILTIN =
  /^(?:cd|pushd|popd|export|unset|declare|readonly|typeset|local|set|shopt|alias|unalias|hash|trap|enable|fc|let|eval|exec|source|\.|read|mapfile|readarray|getopts)$/;

/**
 * Words that only choose *how* the next word is resolved, so the planter may
 * be hiding behind one: `command cd /hostile`, `builtin cd /hostile`,
 * `time cd /hostile` (bash's `time` keyword does not fork, so the `cd` lands
 * on the current shell).
 */
const RESOLUTION_ORDER_PREFIX = /^(?:command|builtin|time)$/;

/** Shapes that are a list of statements rather than a statement themselves. */
const TRANSPARENT_STATEMENT_WRAPPER: ReadonlySet<string> = new Set([
  'list',
  'pipeline',
  'redirected_statement',
]);

/** Substitutions bash evaluates while expanding a redirect target. */
const REDIRECT_TARGET_SUBSTITUTION: Set<string> = new Set([
  'command_substitution',
  'process_substitution',
]);

/**
 * The literal text a word carries after bash strips its quoting, or `null`
 * when the word is not a plain literal at all.
 *
 * `\\cd` and `"cd"` are the same command as `cd` to bash but different text to
 * a regex, which is one of the ways an enumerated planter used to hide.
 */
function literalWordText(node: SyntaxNode): string | null {
  if (hasShellExpansion(node)) return null;
  const stripped = stripOuterQuotes(node.text).replace(/\\(.)/g, '$1');
  return /^[A-Za-z0-9_.-]+$/.test(stripped) ? stripped : null;
}

/**
 * Whether one parsed statement plants state for whatever follows it.
 *
 * Fails closed by shape: only a plain `command` node can be cleared, and only
 * once its resolved name is read and found not to be a planter. Every other
 * shape — a bare `variable_assignment`, a `declaration_command`, an
 * `unset_command`, a `function_definition`, a `negated_command`, a block, a
 * keyword statement, a subshell — is treated as planting, because each is
 * either a planter itself or a container the enumeration cannot see into.
 *
 * Inside a `command` node the same discipline applies to the parts that are
 * not the name: a resolution-order prefix followed by anything this function
 * cannot read is assumed to hide a planter rather than assumed not to, and
 * `printf -v VAR` assigns despite `printf` being an ordinary name.
 */
function statementPlantsState(node: SyntaxNode): boolean {
  if (node.type === 'comment') return false;
  if (TRANSPARENT_STATEMENT_WRAPPER.has(node.type)) {
    // Mirrors the classifier's own `redirected_statement` arm: the redirect
    // operator itself plants nothing, but whatever follows a heredoc opener on
    // the same line is parsed *inside* the redirect node, so its non-inert
    // children are still real statements.
    return node.namedChildren.some((child) =>
      child.type.endsWith('_redirect')
        ? redirectPlantsState(child)
        : statementPlantsState(child),
    );
  }
  if (node.type !== 'command') return true;

  let sawResolutionPrefix = false;
  let name: string | null = null;
  for (const child of node.namedChildren) {
    // A `VAR=VALUE` prefix on a command is scoped to that command, so it is
    // not itself a planter — but the command it prefixes may be.
    if (child.type === 'variable_assignment') continue;
    // Redirects attach to the enclosing `redirected_statement`, not to the
    // `command` itself, so they are screened in the wrapper arm above; this
    // only guards against a grammar that starts attaching them here.
    if (child.type.endsWith('_redirect')) continue;
    if (name !== null) {
      // Past the command name: only `printf -v VAR` still assigns.
      if (name === 'printf' && /^-v/.test(stripOuterQuotes(child.text)))
        return true;
      continue;
    }
    const text = literalWordText(child);
    if (text === null) return true;
    if (STATE_PLANTING_BUILTIN.test(text)) return true;
    if (RESOLUTION_ORDER_PREFIX.test(text)) {
      sawResolutionPrefix = true;
      continue;
    }
    // `command -p cd /hostile` and `command -- cd /hostile` put the planter
    // behind a flag. The flags a resolution prefix takes are its own small
    // vocabulary, but reading past one to find the real name is the kind of
    // enumeration this predicate exists to stop doing — so a dash-leading word
    // after a prefix plants.
    if (sawResolutionPrefix && text.startsWith('-')) return true;
    name = text;
  }
  return false;
}

/** Whether a redirect node runs something while its target is expanded. */
function redirectPlantsState(node: SyntaxNode): boolean {
  // `INERT_REDIRECT_CHILD` treats substitutions as inert because the safety
  // axis evaluates them separately. The plant axis has no such second pass:
  // `echo x < $(./evil.sh)` runs the script before anything after it is
  // classified.
  return collectDescendants(node, REDIRECT_TARGET_SUBSTITUTION).length > 0;
}

/**
 * Whether a sub-command plants state that makes classifying the sub-commands
 * after it in isolation unsound.
 *
 * A confirmation dialog is built by splitting a compound command and dropping
 * the parts that classify read-only, so the user approves only what needs
 * approving. That is sound only while each part means the same thing alone as
 * it does in sequence. `cd /hostile && wrapper status` moves the directory the
 * planted-config gate probes; `export GIT_DIR=/hostile/.git && wrapper status`
 * moves it with no `cd` at all; `hash -p ./evil/git git && git status` rewrites
 * which binary the name `git` resolves to. Either way the later part is probed
 * against the wrong world, classifies read-only, and vanishes from the scope
 * the user is shown — while approval still runs the original compound.
 *
 * Decided on the parse rather than on the raw text, because the text form
 * cannot be enumerated: a planter hides behind a block (`{ cd /hostile; }`), a
 * keyword (`if true; then cd /hostile; fi`), an assignment prefix
 * (`FOO=1 cd /hostile`), a resolution-order prefix (`command cd /hostile`), a
 * respelling (`\\cd`, `"cd"`), a negation (`! cd /hostile`), or a function
 * definition that rebinds a trusted name (`git() { rm -rf $HOME; }`), and a
 * bare `PATH=evil` assignment statement carries no command word at all.
 *
 * Fails closed: an unparseable or unrecognised segment plants, which costs a
 * larger confirmation dialog rather than a silently narrowed one.
 */
export async function plantsStateForLaterCommands(
  command: string,
): Promise<boolean> {
  if (typeof command !== 'string' || !command.trim()) return true;
  let tree: Parser.Tree;
  try {
    tree = await parseShellCommand(command);
  } catch {
    return true;
  }
  try {
    const root = tree.rootNode;
    if (root.hasError || root.namedChildCount === 0) return true;
    return root.namedChildren.some(statementPlantsState);
  } finally {
    tree.delete();
  }
}

export async function classifyShellCommandSafety(
  command: string,
  options?: ShellSafetyOptions,
): Promise<ShellCommandSafety> {
  if (typeof command !== 'string' || !command.trim()) return 'unknown';
  return classifyInternal(command, extraRoots(options)).catch(() => 'unknown');
}

export async function classifyShellCommandSafetyInDirectory(
  command: string,
  cwd: string,
  options?: ShellSafetyOptions,
): Promise<ShellCommandSafety> {
  if (typeof command !== 'string' || !command.trim()) return 'unknown';
  return classifyInternal(command, extraRoots(options), cwd).catch(
    () => 'unknown',
  );
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
  options?: ShellSafetyOptions,
): Promise<boolean> {
  return isShellCommandReadOnlyInternal(command, extraRoots(options));
}

export async function isShellCommandReadOnlyASTInDirectory(
  command: string,
  cwd: string,
  options?: ShellSafetyOptions,
): Promise<boolean> {
  return isShellCommandReadOnlyInternal(command, extraRoots(options), cwd);
}

async function isShellCommandReadOnlyInternal(
  command: string,
  extra: ReadonlySet<string>,
  cwd?: string,
): Promise<boolean> {
  if (typeof command !== 'string' || !command.trim()) return false;

  // If the WASM parser is permanently unavailable (e.g. WASM file missing
  // after a symlinked install), fall back to the regex-based checker so the
  // agent remains functional instead of hanging or crashing.
  if (parserInitFailed) {
    return (
      isShellCommandReadOnly(command) &&
      !(cwd && fallbackGitConfigMakesCommandUnsafe(command, cwd))
    );
  }

  try {
    return (await classifyInternal(command, extra, cwd)) === 'read-only';
  } catch {
    // Unexpected runtime failure (e.g. WASM init error on first call) –
    // fall back to the regex-based checker rather than propagating the error.
    return (
      isShellCommandReadOnly(command) &&
      !(cwd && fallbackGitConfigMakesCommandUnsafe(command, cwd))
    );
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
