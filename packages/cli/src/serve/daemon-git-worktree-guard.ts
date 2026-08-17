/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'shell-quote';
import {
  GitWorktreeService,
  isWithinRoot,
  realpathNearestExistingAsync,
  splitCommands,
} from '@qwen-code/qwen-code-core';
import {
  EXTERNAL_TOOL_GUARD_MAX_DENIAL_REASON_CHARS,
  SHELL_EXECUTING_TOOL_NAMES as SHELL_EXECUTING_TOOLS,
} from '@qwen-code/acp-bridge/externalToolGuard';
import type {
  ExternalToolGuardHandler,
  ExternalToolGuardPrepareRequest,
  ExternalToolGuardPrepareResult,
} from '@qwen-code/acp-bridge/bridgeOptions';

// Git subcommands allowed even when relocated outside the session working
// directory. Limited to subcommands verified to neither write files nor
// execute programs configured by the target repository on the managed
// (non-tty) output path. `diff`/`log`/`show`/`blame` are excluded: `--output`
// writes files and textconv drivers run commands from target-repository
// config. `grep` takes the same `--textconv` path; `status` and `ls-files`
// both run the target repository's core.fsmonitor (measured on git 2.47.3 —
// `ls-files` executes the hook even though it writes no index); and
// `describe --dirty`/`--broken` rewrite the target index whenever its stat
// cache is stale (a plain `describe` does not, but the flag is one token
// away), so none of them is read-only here.
const RELOCATED_READ_ONLY_GIT_SUBCOMMANDS = new Set(['cat-file', 'rev-parse']);

// Flags that break the invariant above wherever they appear: `--output`
// writes a file, and `--textconv`/`--filters` run the *target* repository's
// configured drivers (`git -C <outside> cat-file --textconv --path=f HEAD:f`
// executes its `diff.<driver>.textconv` command). A subcommand from the set
// above carrying one of these is treated as any other relocated command.
const RELOCATED_READ_ONLY_DISQUALIFYING_FLAGS = new Set([
  '--filters',
  '--output',
  '--textconv',
]);

// Git global options whose next argv entry is consumed as a value.
// `--exec-path` and `--list-cmds` are deliberately absent: real git only
// accepts their `=<value>` form (a bare `--exec-path` prints and exits), so
// modelling them as value-taking would swallow the token that follows them.
// An unmodelled value-taking option is not merely ignored: its value is read
// as the subcommand, which ends option parsing and hides every relocation
// after it (`git --shallow-file <p> -C <outside> reset --hard`).
const GIT_GLOBAL_OPTIONS_WITH_VALUES = new Set([
  '--attr-source',
  '--namespace',
  '--shallow-file',
  '--super-prefix',
]);

// `-c`/`--config-env` keys whose values git executes through a shell. A
// relocated mutation can be embedded in such a value with no relocation in
// the outer argv, so these mark a mutating invocation unresolved. Git config
// keys are case-insensitive, so these are matched against a lowercased key.
const GIT_COMMAND_CONFIG_KEY_PATTERNS = [
  /^alias\./,
  /^core\.(askpass|editor|fsmonitor|pager|sshcommand)$/,
  /^credential\.helper$/,
  /^diff\..+\.(command|textconv)$/,
  /^difftool\./,
  /^filter\./,
  /^core\.hookspath$/,
  /^gpg\.(.+\.)?program$/,
  /^merge\..+\.driver$/,
  /^mergetool\./,
  /^pager\./,
  /^sequence\.editor$/,
  /^uploadpack\.packobjectshook$/,
  /^browser\..+\.cmd$/,
  /^core\.gitproxy$/,
  /^credential\..+\.helper$/,
  /^diff\.external$/,
  /^gc\.recentobjectshook$/,
  /^help\.browser$/,
  /^interactive\.difffilter$/,
  /^remote\..+\.(proxy|receivepack|uploadpack)$/,
  /^ssh\.variant$/,
  /^tar\..+\.command$/,
  /^trailer\..+\.command$/,
  /^man\..+\.cmd$/,
  /^sendemail\.(sendmailcmd|tocmd|cccmd)$/,
  /^web\.browser$/,
  // Pulls in a config file the guard cannot read: it can carry a
  // `core.worktree` redirect or any command-executing key, so it is
  // undecidable and fails closed.
  /^include\.path$/,
  /^includeif\..+\.path$/,
  /^imap\.tunnel$/,
  /^instaweb\.httpd$/,
];

// Environment assignments that redirect git's repository selection (mirrors
// core shell.ts GIT_ENV_SHIFTS_REPO).
const GIT_DIR_ENV_KEYS = new Set(['GIT_COMMON_DIR', 'GIT_DIR']);
const GIT_WORK_TREE_ENV_KEYS = new Set(['GIT_INDEX_FILE', 'GIT_WORK_TREE']);
// Keys that redirect where git writes or which config it reads without
// naming a repository the containment check can resolve. Measured on git
// 2.47.3: `GIT_OBJECT_DIRECTORY=<outside>/.git/objects git add` writes the
// blob there, and `GIT_CONFIG_GLOBAL=<outside>/cfg` makes git read that
// file — enough to point `core.hooksPath` outside.
const GIT_UNRESOLVABLE_ENV_KEYS = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_ASKPASS',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_SYSTEM',
  'GIT_EDITOR',
  'GIT_DIFFTOOL_EXTCMD',
  'GIT_EXTERNAL_DIFF',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PAGER',
  'GIT_SEQUENCE_EDITOR',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
]);

// `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` are the numbered half of git's
// environment config channel — equivalent to `-c <key>=<value>`.
const GIT_NUMBERED_CONFIG_ENV_PATTERN = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

const SHELL_WRAPPER_PROGRAMS = new Set(['bash', 'dash', 'ksh', 'sh', 'zsh']);
const SHELL_WRAPPER_VALUE_FLAGS = new Set(['-o', '-O']);

// `-c` bundled inside short flags (`bash -lc 'cmd'`) still consumes the next
// argv entry as the payload. `-o`/`-O` take values, so either one earlier in
// the bundle consumes the rest of it and `-c` is not present.
function shellBundleRequestsCommand(flag: string): boolean {
  if (!flag.startsWith('-') || flag.startsWith('--')) return false;
  return flag.slice(1).includes('c');
}

/** How many argv entries the value-taking flags before `c` consume. */
function shellBundleValueFlagsBeforeCommand(flag: string): number {
  let consumed = 0;
  for (const character of flag.slice(1)) {
    if (character === 'c') return consumed;
    if (character === 'o' || character === 'O') consumed++;
  }
  return consumed;
}

const ENV_CHDIR_FLAGS = new Set(['-C', '--chdir']);
const ENV_VALUE_FLAGS = new Set(['-S', '--split-string', '-u', '--unset']);
const ENV_KNOWN_FLAG_ONLY = new Set([
  '-',
  '-0',
  '-i',
  '-v',
  '--null',
  '--ignore-environment',
  '--debug',
]);

// The subset of the flag-only options that start the child from an empty
// environment. `-` is GNU env's shorthand for `-i`. Bundled forms (`-iv`) are
// not exact members and already fail closed as unrecognized options.
const ENV_CLEARS_ENVIRONMENT = new Set(['-', '-i', '--ignore-environment']);

// Union of core shell-utils/shell.ts value-taking sudo options.
const SUDO_VALUE_FLAGS = new Set([
  '-C',
  '-D',
  '-T',
  '-g',
  '-h',
  '-p',
  '-r',
  '-t',
  '-u',
  '--chdir',
  '--close-from',
  '--command-timeout',
  '--group',
  '--host',
  '--prompt',
  '--role',
  '--type',
  '--user',
]);
const SUDO_CHDIR_FLAGS = new Set(['-D', '--chdir']);
// `sudo -R <rootfs>` runs the command under a different filesystem root, so
// no path the daemon resolves means what git will see.
const SUDO_CHROOT_FLAGS = new Set(['-R', '--chroot']);

const TIMEOUT_VALUE_FLAGS = new Set(['-k', '-s', '--kill-after', '--signal']);

// Programs that can point an existing in-boundary path at somewhere else.
// Running one earlier in the same command invalidates any containment the
// guard proves afterwards: `ln -s <outside> bait && git -C bait reset --hard`
// is checked while `bait` is still the original directory.
const PATH_RELINKING_PROGRAMS = new Set(['cp', 'ln', 'mv']);

// Archive extractors do not name the paths they write: the archive decides.
// Everything under their extraction directory is therefore suspect, which is
// the directory itself rather than any operand.
const PATH_EXTRACTING_PROGRAMS = new Set(['cpio', 'rsync', 'tar', 'unzip']);

// Programs whose own `-C` means something else entirely (`grep -C 5`,
// `tar -C dir`), so it must not read as a git relocation marker.
const PROGRAMS_WITH_OWN_C_FLAG = new Set([
  'cmake',
  'curl',
  'cpio',
  'diff',
  'grep',
  'install',
  'make',
  'patch',
  'rsync',
  'tar',
  'unzip',
]);

// Pinned to ToolNames.AGENT/WORKFLOW/CREATE_SUB_SESSION/SEND_MESSAGE in
// @qwen-code/qwen-code-core. The literals keep this module free of a core
// barrel import for this one set; daemon-git-worktree-guard.test.ts asserts
// the values match so a rename cannot silently desync this set.
const EXTERNAL_GUARD_UNSUPPORTED_TOOLS = new Set([
  'agent',
  'workflow',
  'create_sub_session',
  'send_message',
]);

const DYNAMIC_RELOCATION_DENIAL =
  'Daemon shell guard denied a mutating Git command with a dynamic repository location.';
const UNPARSEABLE_COMMAND_DENIAL =
  'Daemon shell guard denied a shell command that could not be parsed before execution.';
const UNRESOLVED_TARGET_DENIAL_PREFIX =
  'Daemon shell guard denied a mutating Git command with an unresolvable repository location: ';
const OUTSIDE_TARGET_DENIAL_PREFIX =
  'Daemon shell guard denied a mutating Git command outside the session working directory: ';
const UNDECIDABLE_PAYLOAD_DENIAL =
  'Daemon shell guard denied a shell command whose payload could not be resolved before execution.';
const UNRECOGNIZED_PROGRAM_DENIAL =
  'Daemon shell guard denied a shell command that may run a relocated Git command through an unrecognized program.';
const SHADOW_REMOVAL_DENIAL =
  'Daemon shell guard denied a shell command that removes a tracked shell definition in a way it cannot model.';
const PROMPTLESS_PROVIDER_DENIAL =
  'Managed external tool guard cannot consult an external provider without an active prompt binding.';

const MAX_PAYLOAD_RECURSION_DEPTH = 3;

interface TrustedDaemonToolGuardRequest
  extends ExternalToolGuardPrepareRequest {
  readonly effectiveCwd: string;
}

const UNVERIFIABLE_SCOPE_DENIAL_PREFIX =
  'Daemon shell guard could not establish the execution directory of this call: ';

interface GuardToken {
  readonly text: string;
  readonly dynamic: boolean;
  // Operand of a redirection (`> out`, `<<< payload`). It is scanned for
  // relocation markers — a here-string carries a whole command — but it is
  // never argv, so payload joins (`eval …`, `env -S …`) must skip it.
  readonly redirect?: boolean;
  // A bare digit before a redirection: a file descriptor or an argv word,
  // indistinguishable here.
  readonly ambiguousFd?: boolean;
}

interface GitEnvRelocation {
  readonly target: string;
  readonly kind: 'cwd' | 'git-dir' | 'work-tree';
}

interface PrefixState {
  readonly relocations: GitEnvRelocation[];
  unresolved: boolean;
  // `env -i` / `--ignore-environment` wipe the inherited environment, so a
  // later shell child receives none of the parent's `export -f` functions.
  clearsEnvironment?: boolean;
  // Environment names removed by `env -u` / `--unset`. A bash `export -f foo`
  // travels as a `BASH_FUNC_foo%%` entry, so unsetting it strips the function
  // from the child even though the environment is otherwise intact.
  unsetEnvKeys?: Set<string>;
}

// Bash exports a function `foo` as a `BASH_FUNC_foo%%` (4.3+) or
// `BASH_FUNC_foo()` (older) environment entry; an `env -u` of that entry drops
// the function from the child even though `-u` names an ordinary key.
function envUnsetRemovesFunction(name: string, state: PrefixState): boolean {
  const keys = state.unsetEnvKeys;
  return (
    keys !== undefined &&
    (keys.has(`BASH_FUNC_${name}%%`) || keys.has(`BASH_FUNC_${name}()`))
  );
}

type GuardDenial = { allowed: false; reason: string };

function sanitizeDenialPath(value: string, prefix: string): string {
  // Mirror containsUnsafeExternalToolGuardControlCharacter: control
  // characters would convert a clean denial into an invalid guard result.
  const stripped = [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (
        code >= 0x20 &&
        !(code >= 0x7f && code <= 0x9f) &&
        code !== 0x2028 &&
        code !== 0x2029
      );
    })
    .join('');
  const budget = EXTERNAL_TOOL_GUARD_MAX_DENIAL_REASON_CHARS - prefix.length;
  if (stripped.length <= budget) return stripped;
  return `${stripped.slice(0, Math.max(1, budget - 1))}…`;
}

function denyDynamicRelocation(): GuardDenial {
  return { allowed: false, reason: DYNAMIC_RELOCATION_DENIAL };
}

function denyTarget(prefix: string, target: string): GuardDenial {
  return {
    allowed: false,
    reason: `${prefix}${sanitizeDenialPath(target, prefix)}`,
  };
}

// `{a,b}` is expanded by the shell after this parse, so `git {-C,<outside>}
// reset --hard` reaches git as a relocation the token scan never saw.
const BRACE_EXPANSION_PATTERN = /\{[^{}]*,[^{}]*\}/;

function isDynamicPathValue(token: GuardToken | undefined): boolean {
  return (
    token === undefined ||
    token.dynamic ||
    token.text.includes('`') ||
    token.text.startsWith('~') ||
    BRACE_EXPANSION_PATTERN.test(token.text)
  );
}

// `+=` appends to whatever the variable already holds, so the resulting value
// cannot be resolved from this token alone; it is reported like any other
// assignment and `recordEnvAssignment` marks it unresolved.
function leadingEnvAssignmentKey(token: string): string | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(token);
  return match ? match[1]! : null;
}

function isAppendAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*\+=/.test(token);
}

function executableBaseName(token: GuardToken): string {
  const base = token.text.split(/[\\/]/).pop() ?? token.text;
  return base.toLowerCase().replace(/\.exe$/i, '');
}

// `(` opens a subshell; `<(`/`>(` open a process substitution. All three are
// closed by a `)` that arrives on its own, so all three must raise the depth
// or that `)` pops a scope that was never opened.
const SUBSHELL_OPENING_OPERATORS: ReadonlySet<string> = new Set([
  '(',
  '<(',
  '>(',
]);

const REDIRECT_OPERATORS = new Set([
  '<',
  '>',
  '>>',
  '<<',
  '<<<',
  '<>',
  '>&',
  '<&',
  '>|',
  '&>',
  '&>>',
]);

interface GuardRun {
  readonly tokens: GuardToken[];
  // `( … )` nesting level. A subshell's `cd` does not outlive its parentheses.
  readonly depth: number;
}

interface TokenizedSegment {
  readonly runs: GuardRun[];
  // `splitCommands` cuts on `&&`/`;` without regard for parentheses, so the
  // paren nesting has to be carried from one segment to the next.
  readonly endDepth: number;
}

function tokenizeSegment(
  segment: string,
  startDepth: number,
): TokenizedSegment | null {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(segment, (key) => `$${key}`);
  } catch {
    return null;
  }
  let depth = startDepth;
  const runs: GuardRun[] = [{ tokens: [], depth }];
  let redirectOperand = false;
  for (let index = 0; index < parsed.length; index++) {
    const token = parsed[index];
    if (typeof token === 'string') {
      const isRedirectOperand = redirectOperand;
      redirectOperand = false;
      // A `$(...)` substitution arrives as a string ending in `$` followed
      // by an `(` operator. Consume the whole body as one opaque dynamic
      // token so the assignment/flag it belongs to keeps its place instead
      // of being severed into a separate run.
      if (token.endsWith('$')) {
        const next = parsed[index + 1];
        if (
          next !== null &&
          typeof next === 'object' &&
          'op' in next &&
          next.op === '('
        ) {
          let depth = 0;
          index++;
          for (; index < parsed.length; index++) {
            const inner = parsed[index];
            if (inner !== null && typeof inner === 'object' && 'op' in inner) {
              if (inner.op === '(') depth++;
              else if (inner.op === ')') {
                depth--;
                if (depth === 0) break;
              }
            }
          }
          runs.at(-1)!.tokens.push({
            text: token,
            dynamic: true,
            ...(isRedirectOperand ? { redirect: true } : {}),
          });
          continue;
        }
      }
      runs.at(-1)!.tokens.push({
        text: token,
        dynamic: token.includes('$') || token.includes('`'),
        ...(isRedirectOperand ? { redirect: true } : {}),
      });
      continue;
    }
    if (token === null || typeof token !== 'object') return null;
    if ('comment' in token) break;
    if (!('op' in token)) return null;
    const op = token.op;
    if (op === 'glob') {
      // Glob expansion is resolved by the shell at runtime; the daemon
      // cannot evaluate it statically.
      const pattern =
        'pattern' in token && typeof token.pattern === 'string'
          ? token.pattern
          : '';
      runs.at(-1)!.tokens.push({ text: pattern, dynamic: true });
      continue;
    }
    if (SUBSHELL_OPENING_OPERATORS.has(op)) {
      depth++;
      runs.push({ tokens: [], depth });
      continue;
    }
    if (op === ')') {
      depth = Math.max(0, depth - 1);
      runs.push({ tokens: [], depth });
      continue;
    }
    if (REDIRECT_OPERATORS.has(op)) {
      // The operand stays in the run — a here-string (`sh <<< 'git -C … reset
      // --hard'`) carries an executable payload — but it is flagged so no
      // payload join mistakes it for argv. An `N>` file descriptor prefix is
      // part of the redirection too, never a word of the command.
      const tokens = runs.at(-1)!.tokens;
      const previous = tokens.at(-1);
      if (previous && !previous.redirect && /^\d+$/.test(previous.text)) {
        // `2>file` makes it a file descriptor, `git -C 2 > file` makes it a
        // real argv word, and the token stream cannot tell them apart — so
        // it is marked ambiguous and the analysis fails closed.
        tokens[tokens.length - 1] = { ...previous, ambiguousFd: true };
      }
      redirectOperand = true;
      continue;
    }
    runs.push({ tokens: [], depth });
  }
  return { runs: runs.filter((run) => run.tokens.length > 0), endDepth: depth };
}

/**
 * Substitute `$NAME`/`${NAME}` from assignments made earlier in this same
 * command. `X=git; Y='-C <outside> reset --hard'; $X $Y` is a relocation the
 * literal token scan cannot see, but the values are right there.
 */
function expandShellLocals(
  token: GuardToken,
  shellLocals: ReadonlyMap<string, GuardToken>,
): GuardToken {
  if (!token.dynamic || shellLocals.size === 0) return token;
  let resolved = true;
  const text = token.text.replace(
    /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
    (match, name: string) => {
      const local = shellLocals.get(name);
      if (local === undefined || local.dynamic) {
        resolved = false;
        return match;
      }
      return local.text.slice(local.text.indexOf('=') + 1);
    },
  );
  if (text === token.text) return token;
  return { text, dynamic: !resolved };
}

// Rebuilding a payload from tokens loses the quoting that made a value one
// argv word, so a path with a space would re-parse as several words and the
// `-C` value would silently shrink. Re-quote anything that would split.
function quoteForRejoin(text: string): string {
  if (text.length === 0) return "''";
  if (!/[\s"'`$\\|&;<>()*?[\]{}!#~]/.test(text)) return text;
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

// `eval` concatenates its arguments and re-parses the result as shell text,
// so its payload must be joined verbatim.
function joinTokenTexts(tokens: GuardToken[]): string {
  return tokens
    .filter((token) => !token.redirect)
    .map((token) => token.text)
    .join(' ');
}

// Rebuilding a command line out of separate argv words is the opposite case:
// a value that was one word only because it was quoted has to stay one word,
// or a path with a space re-parses as several and a `-C` value silently
// shrinks.
function joinArgvTexts(tokens: GuardToken[]): string {
  return tokens
    .filter((token) => !token.redirect)
    .map((token) => quoteForRejoin(token.text))
    .join(' ');
}

function hasGitRelocationMarker(tokens: GuardToken[]): boolean {
  return tokens.some((token) => {
    if (token.text === '-C' || token.text.startsWith('-C')) return true;
    if (/^--(?:git-dir|work-tree)(?:=|$)/.test(token.text)) return true;
    const key = leadingEnvAssignmentKey(token.text);
    return (
      key !== null &&
      (GIT_DIR_ENV_KEYS.has(key) ||
        GIT_WORK_TREE_ENV_KEYS.has(key) ||
        // `PATH=`/`GIT_EXEC_PATH=` choose which git binary runs — a relocation
        // the direct path already denies, so the wrapper backstop must too.
        GIT_PROGRAM_ENV_KEYS.has(key))
    );
  });
}

// A static token scan cannot prove what an unrecognized program executes.
// When the run still references git and carries a relocation marker —
// possibly inside a quoted payload such as `su -c 'git -C ...'` — fail
// closed instead of letting the program word short-circuit the analysis.
// Case-insensitive because `executableBaseName` lowercases too, so on a
// case-insensitive filesystem `nice GIT …` runs the same binary.
const GIT_WORD_PATTERN = /\bgit\b/i;
// A `cd`/`pushd` inside such a payload relocates the git that follows it just
// as effectively as a `-C` flag (`su -c 'cd <outside> && git reset --hard'`).
const TEXT_RELOCATION_MARKER_WITHOUT_C_PATTERN =
  /(^|\s)(--git-dir=?|--work-tree=?|-execdir)|(^|[\s;&|(){}])(cd|pushd)([\s;&|]|$)|(^|[\s;&|(){}])(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_EXEC_PATH|PATH)\+?=/;
const TEXT_RELOCATION_MARKER_PATTERN =
  /(^|\s)(-C|--git-dir=?|--work-tree=?|-execdir)|(^|[\s;&|(){}])(cd|pushd)([\s;&|]|$)|(^|[\s;&|(){}])(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_EXEC_PATH|PATH)\+?=/;

// Assignments that decide WHICH git binary the run executes. The guard
// classifies the program word `git` and then reasons about paths; if the
// binary itself is chosen by the command, that reasoning proves nothing.
const GIT_PROGRAM_ENV_KEYS = new Set(['GIT_EXEC_PATH', 'PATH']);

function recordEnvAssignment(token: GuardToken, state: PrefixState): void {
  const key = leadingEnvAssignmentKey(token.text);
  if (key === null) return;
  if (
    GIT_PROGRAM_ENV_KEYS.has(key) ||
    GIT_UNRESOLVABLE_ENV_KEYS.has(key) ||
    GIT_NUMBERED_CONFIG_ENV_PATTERN.test(key)
  ) {
    state.unresolved = true;
    return;
  }
  if (!GIT_DIR_ENV_KEYS.has(key) && !GIT_WORK_TREE_ENV_KEYS.has(key)) return;
  const value = token.text.slice(token.text.indexOf('=') + 1);
  if (
    token.dynamic ||
    isAppendAssignment(token.text) ||
    isDynamicPathValue({ text: value, dynamic: false })
  ) {
    state.unresolved = true;
    return;
  }
  state.relocations.push({
    target: value,
    // GIT_COMMON_DIR and GIT_INDEX_FILE cannot be mapped onto a repository
    // root the way `--git-dir` targets are; checking the concrete path they
    // name is the conservative approximation.
    kind: GIT_WORK_TREE_ENV_KEYS.has(key) ? 'work-tree' : 'git-dir',
  });
}

function attachedChdirValue(
  flag: string,
  set: ReadonlySet<string>,
): string | undefined {
  for (const candidate of set) {
    if (candidate.startsWith('--') && flag.startsWith(`${candidate}=`)) {
      return flag.slice(candidate.length + 1);
    }
    if (
      candidate.length === 2 &&
      flag.startsWith(candidate) &&
      flag.length > candidate.length
    ) {
      return flag.slice(candidate.length);
    }
  }
  return undefined;
}

function recordChdirValue(
  value: GuardToken | undefined,
  state: PrefixState,
): void {
  if (isDynamicPathValue(value)) {
    state.unresolved = true;
    return;
  }
  state.relocations.push({ target: value!.text, kind: 'cwd' });
}

interface WrapperScan {
  next: number;
  payload?: string;
  undecidable?: boolean;
}

function consumeEnvWrapper(
  run: GuardToken[],
  start: number,
  state: PrefixState,
): WrapperScan {
  let index = start + 1;
  while (index < run.length) {
    const token = run[index]!;
    if (token.dynamic) {
      state.unresolved = true;
      index++;
      continue;
    }
    if (token.text === '--') {
      index++;
      break;
    }
    if (ENV_KNOWN_FLAG_ONLY.has(token.text)) {
      if (ENV_CLEARS_ENVIRONMENT.has(token.text)) {
        state.clearsEnvironment = true;
      }
      index++;
      continue;
    }
    if (ENV_CHDIR_FLAGS.has(token.text)) {
      recordChdirValue(run[index + 1], state);
      index += 2;
      continue;
    }
    const attached = attachedChdirValue(token.text, ENV_CHDIR_FLAGS);
    if (attached !== undefined) {
      recordChdirValue({ text: attached, dynamic: false }, state);
      index++;
      continue;
    }
    if (token.text === '-S' || token.text === '--split-string') {
      const payloadToken = run[index + 1];
      if (payloadToken === undefined) return { next: run.length };
      // Mirrors the `-c` payload rule: a payload the daemon cannot read is
      // undecidable, not absent.
      if (payloadToken.dynamic) return { next: run.length, undecidable: true };
      const rest = joinArgvTexts(run.slice(index + 2));
      return {
        next: run.length,
        payload: rest ? `${payloadToken.text} ${rest}` : payloadToken.text,
      };
    }
    // `env -S'cmd'` / `env -iS'cmd'`: the payload is fused into the flag
    // token after the `S`, exactly as `sh -c'cmd'` fuses its own.
    if (/^-[A-Za-z]*S/.test(token.text) && !token.text.startsWith('--')) {
      const fused = token.text.slice(token.text.indexOf('S') + 1);
      if (fused.length > 0) {
        const rest = joinArgvTexts(run.slice(index + 1));
        return {
          next: run.length,
          payload: rest ? `${fused} ${rest}` : fused,
        };
      }
      // `env -iS 'cmd'`: the bundle ends at `S`, so the payload is the next
      // argv entry — the same rule `sh -lc 'cmd'` follows.
      const payloadToken = run[index + 1];
      if (payloadToken === undefined) return { next: run.length };
      if (payloadToken.dynamic) return { next: run.length, undecidable: true };
      const rest = joinArgvTexts(run.slice(index + 2));
      return {
        next: run.length,
        payload: rest ? `${payloadToken.text} ${rest}` : payloadToken.text,
      };
    }
    if (ENV_VALUE_FLAGS.has(token.text)) {
      // Only `-u`/`--unset` reach here (`-S`/`--split-string` returned above);
      // remember the removed key so a stripped `BASH_FUNC_*` is honoured.
      const removed = run[index + 1];
      if (removed !== undefined && !removed.dynamic) {
        (state.unsetEnvKeys ??= new Set()).add(removed.text);
      }
      index += 2;
      continue;
    }
    // `env -uNAME` / `--unset=NAME` carry their value in the same token, so
    // they consume nothing further and must not look unrecognized.
    if (
      /^-u./.test(token.text) ||
      token.text.startsWith('--unset=') ||
      token.text.startsWith('--split-string=')
    ) {
      if (token.text.startsWith('--split-string=')) {
        const fused = token.text.slice('--split-string='.length);
        const rest = joinArgvTexts(run.slice(index + 1));
        return { next: run.length, payload: rest ? `${fused} ${rest}` : fused };
      }
      const removedName = token.text.startsWith('--unset=')
        ? token.text.slice('--unset='.length)
        : token.text.slice(2);
      (state.unsetEnvKeys ??= new Set()).add(removedName);
      index++;
      continue;
    }
    if (leadingEnvAssignmentKey(token.text) !== null) {
      recordEnvAssignment(token, state);
      index++;
      continue;
    }
    if (token.text.startsWith('-')) {
      // Unrecognized env option before the program: fail closed rather than
      // guess whether it consumes the next token.
      state.unresolved = true;
      index++;
      continue;
    }
    break;
  }
  return { next: index };
}

function consumeSudoWrapper(
  run: GuardToken[],
  start: number,
  state: PrefixState,
): WrapperScan {
  let index = start + 1;
  while (index < run.length) {
    const token = run[index]!;
    if (token.dynamic) {
      state.unresolved = true;
      index++;
      continue;
    }
    if (leadingEnvAssignmentKey(token.text) !== null) {
      recordEnvAssignment(token, state);
      index++;
      continue;
    }
    if (!token.text.startsWith('-')) break;
    if (SUDO_CHDIR_FLAGS.has(token.text)) {
      recordChdirValue(run[index + 1], state);
      index += 2;
      continue;
    }
    if (
      SUDO_CHROOT_FLAGS.has(token.text) ||
      token.text.startsWith('--chroot=') ||
      /^-R./.test(token.text)
    ) {
      state.unresolved = true;
      index += SUDO_CHROOT_FLAGS.has(token.text) ? 2 : 1;
      continue;
    }
    const attached = attachedChdirValue(token.text, SUDO_CHDIR_FLAGS);
    if (attached !== undefined) {
      recordChdirValue({ text: attached, dynamic: false }, state);
      index++;
      continue;
    }
    if (SUDO_VALUE_FLAGS.has(token.text)) {
      index += 2;
      continue;
    }
    index++;
  }
  return { next: index };
}

function consumeTimeoutWrapper(run: GuardToken[], start: number): number {
  let index = start + 1;
  while (index < run.length) {
    const token = run[index]!;
    if (!token.text.startsWith('-')) break;
    if (TIMEOUT_VALUE_FLAGS.has(token.text) && !token.text.includes('=')) {
      index += 2;
      continue;
    }
    index++;
  }
  // The duration operand.
  if (index < run.length) index++;
  return index;
}

type ShellWrapperScan =
  | { kind: 'none' }
  | { kind: 'static'; payload: string }
  | { kind: 'dynamic' };

// The next real argv entry: a redirection between the flag and its payload
// (`sh -c > /dev/null 'cmd'`) is not the payload.
function nextArgvIndex(run: GuardToken[], from: number): number {
  let index = from;
  while (
    index < run.length &&
    (run[index]!.redirect || run[index]!.ambiguousFd)
  ) {
    index++;
  }
  return index;
}

function consumeShellWrapper(
  run: GuardToken[],
  start: number,
): ShellWrapperScan {
  let index = start + 1;
  while (index < run.length) {
    const token = run[index]!;
    if (token.text === '-c') {
      const payloadToken = run[nextArgvIndex(run, index + 1)];
      if (payloadToken === undefined) {
        // `sh -c` with no payload executes nothing.
        return { kind: 'static', payload: '' };
      }
      if (payloadToken.dynamic) return { kind: 'dynamic' };
      return { kind: 'static', payload: payloadToken.text };
    }
    if (token.dynamic) {
      // `bash -c$CMD`, `bash $A "$P"`: any unreadable word in a shell's argv
      // can be the `-c` that carries the command, so the wrapper as a whole
      // is undecidable rather than absent.
      return { kind: 'dynamic' };
    }
    if (shellBundleRequestsCommand(token.text)) {
      const remainder = token.text.slice(token.text.indexOf('c') + 1);
      // A remainder of nothing but letters is more short options (`-cx`,
      // `-co`), which POSIX shells parse as flags and then take the payload
      // from a later argv entry — `-o`/`-O` among them consumes one first.
      // Anything else is a payload fused into the token (`bash -c'cmd'`); a
      // pure-letter remainder cannot hide a relocation either way.
      if (remainder.length > 0 && !/^[A-Za-z]+$/.test(remainder)) {
        return { kind: 'static', payload: remainder };
      }
      let payloadIndex = nextArgvIndex(run, index + 1);
      // `-o`/`-O` on either side of the `c` each consume one argv entry
      // before the command string.
      let toSkip =
        shellBundleValueFlagsBeforeCommand(token.text) +
        (remainder.match(/[oO]/g)?.length ?? 0);
      while (toSkip-- > 0) {
        payloadIndex = nextArgvIndex(run, payloadIndex + 1);
      }
      const payloadToken = run[payloadIndex];
      if (payloadToken === undefined) {
        return { kind: 'static', payload: '' };
      }
      if (payloadToken.dynamic) return { kind: 'dynamic' };
      return { kind: 'static', payload: payloadToken.text };
    }
    if (token.text.startsWith('+')) {
      index++;
      continue;
    }
    if (!token.text.startsWith('-')) return { kind: 'none' };
    if (token.text === '--') return { kind: 'none' };
    index += SHELL_WRAPPER_VALUE_FLAGS.has(token.text) ? 2 : 1;
  }
  return { kind: 'none' };
}

type RunAnalysis =
  | { kind: 'git'; tokens: GuardToken[]; state: PrefixState }
  | {
      kind: 'payload';
      payload: string;
      state: PrefixState;
      propagatesCwd: boolean;
      // Only bash imports functions marked with `export -f`; dash/sh/zsh/ksh
      // resolve the external program instead.
      importsExportedFunctions?: boolean;
    }
  | {
      kind: 'cd';
      variant: 'cd' | 'popd' | 'pushd';
      target?: GuardToken;
      physical?: boolean;
    }
  | { kind: 'dynamic-program'; rest: GuardToken[]; state: PrefixState }
  | { kind: 'export'; state: PrefixState; operands: GuardToken[] }
  | { kind: 'all-export'; state: PrefixState }
  | { kind: 'all-export-off'; state: PrefixState }
  | { kind: 'undecidable' }
  | { kind: 'other'; state: PrefixState; assignmentsOnly: boolean };

// Shell keywords that can lead a split segment without changing what
// executes: `if true; then git ...` arrives as a `then git ...` segment
// because the split happens on `;`/`&&`. Skipping them keeps the real
// program under analysis; bare terminators (`fi`, `done`, ...) leave an
// empty run that classifies as safe.
const LEADING_SHELL_KEYWORDS = new Set([
  '{',
  '}',
  '!',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'do',
  'done',
  'while',
  'until',
  'in',
  'case',
  'esac',
  'time',
  'coproc',
]);

// Builtins that declare variables. `export`/`declare -x`/`typeset -x` put the
// assignment in the environment of every later command in this shell, so a
// GIT_* relocation declared here outlives its own run. `readonly`/`local` are
// treated the same way: over-approximating an assignment as exported can only
// deny, never allow.
const EXPORT_BUILTINS = new Set([
  'declare',
  'export',
  'local',
  'readonly',
  'typeset',
]);

// `cd`/`pushd` options that precede the directory operand. Consuming one as
// the target would resolve containment against `<cwd>/-P` instead of the
// directory the shell actually enters.
const CHDIR_OPTION_PATTERN = /^-[LPe@qs]+$/;

function findChdirTarget(
  run: GuardToken[],
  start: number,
  variant: 'cd' | 'popd' | 'pushd',
): GuardToken | undefined {
  let index = start;
  while (index < run.length) {
    const token = run[index]!;
    if (token.text === '--') return run[index + 1];
    if (variant === 'cd' && CHDIR_OPTION_PATTERN.test(token.text)) {
      index++;
      continue;
    }
    // `cd -` (previous directory), `pushd +N`/`-N` (stack rotation) and any
    // unrecognized option land somewhere unresolvable: report no target so
    // the caller drops the tracked cwd.
    if (/^[-+]/.test(token.text)) return undefined;
    return token;
  }
  return undefined;
}

// `set -a` / `set -o allexport` puts every later assignment in the
// environment, so plain `GIT_DIR=…` runs stop being shell-local.
function requestsAllExport(run: GuardToken[], start: number): boolean {
  for (let index = start; index < run.length; index++) {
    const token = run[index]!;
    const text = token.text;
    // `set -o $OPT` can request allexport without naming it.
    if (token.dynamic) return true;
    if (text === '-o' || text === '--') {
      if (run[index + 1]?.text === 'allexport') return true;
      continue;
    }
    if (text === 'allexport' || text === '--allexport') return true;
    if (/^-[a-zA-Z]*a/.test(text)) return true;
  }
  return false;
}

// `set +a` / `set +o allexport` turn it back off.
function disablesAllExport(run: GuardToken[], start: number): boolean {
  for (let index = start; index < run.length; index++) {
    const text = run[index]!.text;
    if (text === '+o' && run[index + 1]?.text === 'allexport') return true;
    if (/^\+[a-zA-Z]*a/.test(text)) return true;
  }
  return false;
}

/**
 * `alias name='body'` and `name() { body; }` both defer a command: the body
 * runs where the *later* bare word appears, not where it was written.
 */
/**
 * The word that actually names the program, i.e. the first token that is not
 * a leading assignment or a shell keyword. `X=1 g` runs `g`.
 */
function readProgramWord(run: GuardToken[]): string | undefined {
  for (const token of run) {
    if (token.redirect || token.ambiguousFd) continue;
    if (leadingEnvAssignmentKey(token.text) !== null) continue;
    if (LEADING_SHELL_KEYWORDS.has(token.text)) continue;
    return token.text;
  }
  return undefined;
}

// The tokens from the program word onward — past leading keywords,
// assignments and redirect/fd operands — so a definition or a call is
// recognised even behind `if …; then`, `X=1`, or `2>/dev/null`.
function runFromProgramWord(run: GuardToken[]): GuardToken[] {
  let index = 0;
  while (index < run.length) {
    const token = run[index]!;
    if (
      token.redirect ||
      token.ambiguousFd ||
      leadingEnvAssignmentKey(token.text) !== null ||
      LEADING_SHELL_KEYWORDS.has(token.text)
    ) {
      index++;
      continue;
    }
    break;
  }
  return run.slice(index);
}

/** `f()` / `f ()` — the header of a function definition, if this is one. */
function readFunctionName(run: GuardToken[]): string | undefined {
  const body = runFromProgramWord(run);
  if (body.length === 0) return undefined;
  const first = body[0]!.text;
  if (first.endsWith('()') && first.length > 2) return first.slice(0, -2);
  if (body[1]?.text === '()') return first;
  return undefined;
}

// R6-5: a single `alias a=1 b=2` statement defines every pair, not just the
// first. Returns all of them.
function readAliasDefinitions(
  run: GuardToken[],
): Array<{ name: string; body: string }> {
  const body = runFromProgramWord(run);
  if (body.length === 0 || executableBaseName(body[0]!) !== 'alias') return [];
  const definitions: Array<{ name: string; body: string }> = [];
  for (const token of body.slice(1)) {
    const separator = token.text.indexOf('=');
    if (separator <= 0) continue;
    definitions.push({
      name: token.text.slice(0, separator),
      body: token.text.slice(separator + 1),
    });
  }
  return definitions;
}

function readDefinition(
  run: GuardToken[],
): { name: string; body: string } | undefined {
  const body = runFromProgramWord(run);
  if (body.length === 0) return undefined;
  // shell-quote yields `f()` (or `f` `()`), then the braced body tokens.
  const first = body[0]!.text;
  const name = first.endsWith('()')
    ? first.slice(0, -2)
    : body[1]?.text === '()'
      ? first
      : undefined;
  if (!name) return undefined;
  const bodyTokens = body
    .slice(first.endsWith('()') ? 1 : 2)
    .filter((token) => token.text !== '{' && token.text !== '}');
  if (bodyTokens.length === 0) return undefined;
  return { name, body: joinArgvTexts(bodyTokens) };
}

function analyzeRun(run: GuardToken[]): RunAnalysis {
  const state: PrefixState = { relocations: [], unresolved: false };
  let index = 0;
  let assignments = 0;
  while (index < run.length && LEADING_SHELL_KEYWORDS.has(run[index]!.text)) {
    index++;
  }
  while (index < run.length) {
    const token = run[index]!;
    if (leadingEnvAssignmentKey(token.text) !== null) {
      recordEnvAssignment(token, state);
      assignments++;
      index++;
      continue;
    }
    if (token.dynamic) {
      return { kind: 'dynamic-program', rest: run.slice(index), state };
    }
    const program = executableBaseName(token);
    // `command git …` and `builtin cd …` run the following word with the
    // function/alias lookup suppressed; neither changes what executes.
    if (program === 'command' || program === 'builtin') {
      index++;
      while (index < run.length && run[index]!.text.startsWith('-')) index++;
      continue;
    }
    if (EXPORT_BUILTINS.has(program)) {
      const operands = run.slice(index + 1);
      for (const operand of operands) recordEnvAssignment(operand, state);
      return { kind: 'export', state, operands };
    }
    if (program === 'set') {
      if (requestsAllExport(run, index + 1)) {
        return { kind: 'all-export', state };
      }
      if (disablesAllExport(run, index + 1)) {
        return { kind: 'all-export-off', state };
      }
    }
    if (program === 'env') {
      const scan = consumeEnvWrapper(run, index, state);
      if (scan.undecidable) return { kind: 'undecidable' };
      if (scan.payload !== undefined) {
        return {
          kind: 'payload',
          payload: scan.payload,
          state,
          propagatesCwd: false,
        };
      }
      index = scan.next;
      continue;
    }
    if (program === 'sudo') {
      index = consumeSudoWrapper(run, index, state).next;
      continue;
    }
    if (program === 'timeout') {
      index = consumeTimeoutWrapper(run, index);
      continue;
    }
    if (program === 'eval') {
      const payloadTokens = run.slice(index + 1);
      if (
        payloadTokens.some(
          (payloadToken) => payloadToken.dynamic || payloadToken.ambiguousFd,
        )
      ) {
        return { kind: 'undecidable' };
      }
      return {
        kind: 'payload',
        payload: joinTokenTexts(payloadTokens),
        state,
        // `eval` runs in the current shell, so a `cd` inside the payload
        // relocates subsequent commands in this run's scope.
        propagatesCwd: true,
      };
    }
    if (SHELL_WRAPPER_PROGRAMS.has(program)) {
      const scan = consumeShellWrapper(run, index);
      if (scan.kind === 'none') {
        return { kind: 'other', state, assignmentsOnly: false };
      }
      if (scan.kind === 'dynamic') return { kind: 'undecidable' };
      return {
        kind: 'payload',
        payload: scan.payload,
        state,
        propagatesCwd: false,
        // Only bash imports `export -f` functions, and only when it inherits
        // the environment carrying them — `env -i bash -c` wipes them first.
        importsExportedFunctions:
          program === 'bash' && !state.clearsEnvironment,
      };
    }
    if (program === 'nohup' || program === 'exec') {
      index++;
      continue;
    }
    if (program === 'git') {
      return { kind: 'git', tokens: run.slice(index), state };
    }
    if (program === 'cd' || program === 'pushd' || program === 'popd') {
      return {
        kind: 'cd',
        variant: program,
        target: findChdirTarget(run, index + 1, program),
        // `cd -P` resolves each component through its symlinks before
        // applying `..`, which a lexical resolve cannot reproduce.
        physical: run
          .slice(index + 1)
          .some((token) => /^-[A-Za-z]*P/.test(token.text)),
      };
    }
    return { kind: 'other', state, assignmentsOnly: false };
  }
  return { kind: 'other', state, assignmentsOnly: assignments > 0 };
}

interface GitInvocation {
  readonly cwdTargets: GuardToken[];
  readonly gitDirTargets: GuardToken[];
  readonly workTreeTargets: GuardToken[];
  readonly subcommand?: string;
  readonly unresolved: boolean;
  readonly dangerousConfig: boolean;
  readonly hasDisqualifyingFlag: boolean;
}

function readGitInvocation(tokens: GuardToken[]): GitInvocation {
  const cwdTargets: GuardToken[] = [];
  const gitDirTargets: GuardToken[] = [];
  const workTreeTargets: GuardToken[] = [];
  let subcommand: string | undefined;
  let unresolved = false;
  let dangerousConfig = false;

  const recordConfigAssignment = (value: string): void => {
    const separator = value.indexOf('=');
    const key = (
      separator >= 0 ? value.slice(0, separator) : value
    ).toLowerCase();
    const assignment = separator >= 0 ? value.slice(separator + 1) : '';
    if (
      GIT_COMMAND_CONFIG_KEY_PATTERNS.some((pattern) => pattern.test(key)) ||
      assignment.trimStart().startsWith('!')
    ) {
      dangerousConfig = true;
    }
  };
  const pushRelocation = (
    kind: 'cwd' | 'git-dir' | 'work-tree',
    value: GuardToken | undefined,
    emptyIsNoop: boolean,
  ): boolean => {
    if (value === undefined) {
      unresolved = true;
      return false;
    }
    if (value.text === '' && !value.dynamic) {
      if (emptyIsNoop) return true;
      unresolved = true;
      return false;
    }
    if (isDynamicPathValue(value)) {
      unresolved = true;
      return true;
    }
    if (kind === 'cwd') cwdTargets.push(value);
    else if (kind === 'git-dir') gitDirTargets.push(value);
    else workTreeTargets.push(value);
    return true;
  };

  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.redirect || token.ambiguousFd) {
      // A redirection operand among the args (`git 2>/dev/null -C <p> …`) is
      // not part of argv and must not terminate option parsing.
      index++;
      continue;
    }
    if (token.dynamic || BRACE_EXPANSION_PATTERN.test(token.text)) {
      unresolved = true;
      index++;
      continue;
    }
    if (token.text === '-C') {
      // Git treats an empty `-C` value as a no-op chdir.
      if (!pushRelocation('cwd', tokens[index + 1], true)) break;
      index += 2;
      continue;
    }
    if (token.text === '--git-dir' || token.text === '--work-tree') {
      const kind = token.text === '--git-dir' ? 'git-dir' : 'work-tree';
      if (!pushRelocation(kind, tokens[index + 1], false)) break;
      index += 2;
      continue;
    }
    if (token.text.length > 2 && token.text.startsWith('-C')) {
      if (
        !pushRelocation(
          'cwd',
          { text: token.text.slice(2), dynamic: false },
          false,
        )
      ) {
        break;
      }
      index++;
      continue;
    }
    if (
      token.text.startsWith('--git-dir=') ||
      token.text.startsWith('--work-tree=')
    ) {
      const kind = token.text.startsWith('--git-dir=')
        ? 'git-dir'
        : 'work-tree';
      const value = token.text.slice(token.text.indexOf('=') + 1);
      if (!pushRelocation(kind, { text: value, dynamic: false }, false)) {
        break;
      }
      index++;
      continue;
    }
    if (token.text === '-c' || token.text === '--config-env') {
      const value = tokens[index + 1];
      if (value === undefined) break;
      if (value.dynamic) dangerousConfig = true;
      else recordConfigAssignment(value.text);
      index += 2;
      continue;
    }
    if (token.text.startsWith('--config-env=')) {
      recordConfigAssignment(token.text.slice('--config-env='.length));
      index++;
      continue;
    }
    if (
      token.text.length > 2 &&
      token.text.startsWith('-c') &&
      !token.text.startsWith('--')
    ) {
      recordConfigAssignment(token.text.slice(2));
      index++;
      continue;
    }
    if (GIT_GLOBAL_OPTIONS_WITH_VALUES.has(token.text)) {
      if (tokens[index + 1] === undefined) break;
      index += 2;
      continue;
    }
    if (token.text.startsWith('-')) {
      index++;
      continue;
    }
    subcommand = token.text;
    break;
  }

  const hasDisqualifyingFlag = tokens.some((token) => {
    const separator = token.text.indexOf('=');
    const flag = separator >= 0 ? token.text.slice(0, separator) : token.text;
    return RELOCATED_READ_ONLY_DISQUALIFYING_FLAGS.has(flag);
  });
  return {
    cwdTargets,
    gitDirTargets,
    workTreeTargets,
    subcommand,
    unresolved,
    dangerousConfig,
    hasDisqualifyingFlag,
  };
}

/**
 * Resolve a `--git-dir`/`GIT_DIR` target to the repository git operates on,
 * following git's own indirections: a `.git` gitfile redirect (`gitdir:`
 * line) and per-worktree administrative directories (their `gitdir` file
 * points at the linked worktree checkout). Canonicalization happens BEFORE
 * any basename handling so a symlink named `.git` resolves to its real
 * target. Throws when an indirection cannot be resolved.
 */
async function resolveGitDirRepository(
  canonicalGitDir: string,
): Promise<string> {
  let current = canonicalGitDir;
  for (let depth = 0; depth < 3; depth++) {
    const stats = await stat(current);
    if (stats.isFile()) {
      const [firstLine] = (await readFile(current, 'utf8')).split(/\r?\n/);
      const match = /^gitdir:\s*(.+)$/.exec(firstLine ?? '');
      if (!match) throw new Error('unrecognized gitfile');
      current = path.resolve(path.dirname(current), match[1]!.trim());
      continue;
    }
    if (path.basename(current) === '.git') {
      return path.dirname(current);
    }
    if (/[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/.test(current)) {
      const worktreeGitPointer = (
        await readFile(path.join(current, 'gitdir'), 'utf8')
      ).trim();
      if (!worktreeGitPointer) throw new Error('empty worktree gitdir file');
      return path.dirname(path.resolve(current, worktreeGitPointer));
    }
    return current;
  }
  throw new Error('gitdir indirection too deep');
}

/**
 * Resolve a directory change the way `chdir(2)` does — following each
 * component's symlinks before applying the next one. `git -C` and `cd -P` use
 * it, so `-C <symlink>/..` lands in the parent of the symlink's real target,
 * while a lexical `path.resolve` would collapse it back to the starting
 * directory. Bash's default `cd` is logical and keeps the lexical behavior.
 */
async function resolvePhysicalPath(
  base: string,
  target: string,
): Promise<string> {
  let current = path.isAbsolute(target) ? path.parse(target).root : base;
  const separators = path.sep === '\\' ? /[\\/]+/ : /\/+/;
  for (const segment of target.split(separators)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      current = path.dirname(await realpathNearestExistingAsync(current));
      continue;
    }
    current = await realpathNearestExistingAsync(path.join(current, segment));
  }
  return current;
}

/**
 * Git discovers its repository by walking up from the working directory, so a
 * directory that is itself inside the boundary can still hand git an outside
 * repository through a `.git` gitfile (`gitdir: <outside>/.git`). Resolve the
 * first `.git` between the target and the boundary the same way `--git-dir`
 * targets are resolved — which keeps a linked worktree working, because its
 * own gitfile resolves back to that worktree's checkout. Returns undefined
 * when nothing is discovered inside the boundary; throws when an indirection
 * cannot be read.
 */
async function resolveDiscoveredRepository(
  startDirectory: string,
  boundary: string,
): Promise<string | undefined> {
  let current = startDirectory;
  for (let depth = 0; depth < 64; depth++) {
    const candidate = path.join(current, '.git');
    let exists = true;
    try {
      await stat(candidate);
    } catch {
      exists = false;
    }
    if (exists) {
      return resolveGitDirRepository(
        await realpathNearestExistingAsync(candidate),
      );
    }
    if (current === boundary) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

interface GuardEvaluationContext {
  readonly canonicalEffectiveCwd: string;
  readonly ambientRelocations: readonly GitEnvRelocation[];
  readonly ambientUnresolved: boolean;
}

async function evaluateGitInvocation(
  invocation: GitInvocation,
  state: PrefixState,
  basisCwd: string | undefined,
  entryCwd: string | undefined,
  context: GuardEvaluationContext,
): Promise<GuardDenial | undefined> {
  // Command-executing `-c` config and unresolvable relocations are checked
  // BEFORE the read-only allowance: `git status` still runs the target
  // repository's core.fsmonitor, so a read-only subcommand does not make an
  // undecidable invocation safe.
  if (
    invocation.unresolved ||
    invocation.dangerousConfig ||
    state.unresolved ||
    context.ambientUnresolved
  ) {
    return denyDynamicRelocation();
  }
  if (
    RELOCATED_READ_ONLY_GIT_SUBCOMMANDS.has(invocation.subcommand ?? '') &&
    !invocation.hasDisqualifyingFlag
  ) {
    return undefined;
  }

  const cwdRelocations: GitEnvRelocation[] = [];
  const repositoryRelocations: GitEnvRelocation[] = [];
  for (const relocation of [
    ...context.ambientRelocations,
    ...state.relocations,
  ]) {
    if (relocation.kind === 'cwd') cwdRelocations.push(relocation);
    else repositoryRelocations.push(relocation);
  }
  for (const target of invocation.cwdTargets) {
    cwdRelocations.push({ target: target.text, kind: 'cwd' });
  }
  for (const target of invocation.gitDirTargets) {
    repositoryRelocations.push({ target: target.text, kind: 'git-dir' });
  }
  for (const target of invocation.workTreeTargets) {
    repositoryRelocations.push({ target: target.text, kind: 'work-tree' });
  }

  // Ambient relocations recorded here are git-level relocations from an
  // enclosing wrapper (e.g. `GIT_DIR=… sh -c '…'`); they make the payload
  // invocation relocated even when the payload itself carries no flags.
  const relocated =
    basisCwd === undefined ||
    basisCwd !== entryCwd ||
    cwdRelocations.length > 0 ||
    repositoryRelocations.length > 0;
  if (!relocated) {
    // Even with no relocation git still discovers its repository by walking
    // up from here, and a planted `.git` gitfile can point that walk outside.
    // A session bound to a subdirectory of a repository is unaffected: its
    // `.git` lives above the boundary and the walk stops at the boundary.
    return basisCwd === undefined
      ? undefined
      : denyOutsideDiscoveredRepository(basisCwd, context);
  }

  // `-C`, `env -C` and `sudo -D` all reach the kernel as a chdir, so each
  // component resolves through its symlinks before the next one applies.
  let gitCwd = basisCwd;
  for (const relocation of cwdRelocations) {
    if (gitCwd === undefined && !path.isAbsolute(relocation.target)) break;
    gitCwd = await resolvePhysicalPath(gitCwd ?? '', relocation.target);
  }
  if (gitCwd === undefined) {
    return denyDynamicRelocation();
  }

  // Git applies `-C` during option parsing and resolves relative
  // `--git-dir`/`--work-tree` against the post-`-C` cwd, so every relative
  // target resolves against the final cwd regardless of argv order.
  const checkedTargets: Array<{
    target: string;
    kind: 'cwd' | 'git-dir' | 'work-tree';
  }> = [];
  for (const relocation of repositoryRelocations) {
    checkedTargets.push({
      target: path.isAbsolute(relocation.target)
        ? relocation.target
        : path.resolve(gitCwd, relocation.target),
      kind: relocation.kind,
    });
  }
  if (
    basisCwd === undefined ||
    basisCwd !== entryCwd ||
    cwdRelocations.length > 0
  ) {
    checkedTargets.push({ target: gitCwd, kind: 'cwd' });
  }

  for (const { target, kind } of checkedTargets) {
    const canonicalTarget = await realpathNearestExistingAsync(target);
    let repositoryTarget: string;
    if (kind === 'git-dir') {
      try {
        repositoryTarget = await resolveGitDirRepository(canonicalTarget);
      } catch {
        // Missing or unreadable indirection: containment cannot be proven
        // before execution.
        return denyTarget(UNRESOLVED_TARGET_DENIAL_PREFIX, canonicalTarget);
      }
    } else {
      try {
        // A target that does not fully exist at decision time may still be
        // created as an outward symlink before git runs.
        await realpath(canonicalTarget);
        repositoryTarget = canonicalTarget;
      } catch {
        return denyTarget(UNRESOLVED_TARGET_DENIAL_PREFIX, canonicalTarget);
      }
    }
    repositoryTarget = await realpathNearestExistingAsync(repositoryTarget);
    if (!isWithinRoot(repositoryTarget, context.canonicalEffectiveCwd)) {
      return denyTarget(OUTSIDE_TARGET_DENIAL_PREFIX, repositoryTarget);
    }
  }
  // Unless a `--git-dir`/`GIT_DIR` names the repository outright, git finds it
  // by walking up from its working directory — which can hand it a repository
  // outside the boundary even when the directory itself is inside.
  if (
    repositoryRelocations.every((relocation) => relocation.kind !== 'git-dir')
  ) {
    const denial = await denyOutsideDiscoveredRepository(gitCwd, context);
    if (denial) return denial;
  }
  return undefined;
}

async function denyOutsideDiscoveredRepository(
  startDirectory: string,
  context: GuardEvaluationContext,
): Promise<GuardDenial | undefined> {
  const canonicalStart = await realpathNearestExistingAsync(startDirectory);
  let discovered: string | undefined;
  try {
    discovered = await resolveDiscoveredRepository(
      canonicalStart,
      context.canonicalEffectiveCwd,
    );
  } catch {
    return denyTarget(UNRESOLVED_TARGET_DENIAL_PREFIX, canonicalStart);
  }
  if (discovered === undefined) return undefined;
  const canonicalDiscovered = await realpathNearestExistingAsync(discovered);
  if (!isWithinRoot(canonicalDiscovered, context.canonicalEffectiveCwd)) {
    return denyTarget(OUTSIDE_TARGET_DENIAL_PREFIX, canonicalDiscovered);
  }
  return undefined;
}

/**
 * Extract the bodies of `$(…)` and backtick command substitutions from one
 * segment. They execute before the command they are embedded in, so a
 * relocated mutation hidden inside one (`echo $(git -C <outside> reset
 * --hard)`) has to be analysed rather than folded into an opaque token.
 * Returns null when a substitution is left unterminated.
 */
// `$'…'` is ANSI-C quoting: unlike a plain single-quoted string, a backslash
// escapes inside it, so `$'a\'b'` does not end at the middle quote. Treating
// it as a plain quote leaves the scanner one quote out of phase and a later
// `$(…)` invisible. Returns the index just past the closing quote.
function skipAnsiCQuote(segment: string, start: number): number {
  let index = start + 2;
  while (index < segment.length && segment[index] !== "'") {
    if (segment[index] === '\\') index++;
    index++;
  }
  return index + 1;
}

function extractCommandSubstitutions(segment: string): string[] | null {
  const bodies: string[] = [];
  let single = false;
  let double = false;
  let index = 0;
  while (index < segment.length) {
    const character = segment[index]!;
    if (!single && character === '\\' && index + 1 < segment.length) {
      index += 2;
      continue;
    }
    if (!single && !double && character === '$' && segment[index + 1] === "'") {
      index = skipAnsiCQuote(segment, index);
      continue;
    }
    if (!single && character === '$' && segment[index + 1] === '(') {
      // `$((…))` is arithmetic, not a command. Stepping over the opening
      // punctuation keeps any real substitution nested inside it visible.
      if (segment[index + 2] === '(') {
        index += 3;
        continue;
      }
      const end = findSubstitutionEnd(segment, index + 2);
      if (end === -1) return null;
      bodies.push(segment.slice(index + 2, end));
      index = end + 1;
      continue;
    }
    if (!single && character === '`') {
      let end = index + 1;
      while (end < segment.length && segment[end] !== '`') {
        if (segment[end] === '\\') end++;
        end++;
      }
      if (end >= segment.length) return null;
      bodies.push(segment.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    if (character === "'" && !double) single = !single;
    else if (character === '"' && !single) double = !double;
    index++;
  }
  return bodies;
}

/** Index of the `)` closing a `$(` body opened at `start`, or -1. */
function findSubstitutionEnd(segment: string, start: number): number {
  let single = false;
  let double = false;
  let depth = 0;
  for (let index = start; index < segment.length; index++) {
    const character = segment[index]!;
    if (!single && character === '\\') {
      index++;
      continue;
    }
    if (!single && !double && character === '$' && segment[index + 1] === "'") {
      index = skipAnsiCQuote(segment, index) - 1;
      continue;
    }
    if (character === "'" && !double) {
      single = !single;
      continue;
    }
    if (character === '"' && !single) {
      double = !double;
      continue;
    }
    if (single || double) continue;
    if (character === '(') depth++;
    else if (character === ')') {
      if (depth === 0) return index;
      depth--;
    }
  }
  return -1;
}

/**
 * A run whose program word the daemon does not recognize can still run git:
 * `nice git reset --hard`, `xargs git …`, `find -exec git …`. The static scan
 * cannot prove what it executes, so deny whenever the run mentions git and the
 * repository it would act on is not provably the session's own — either
 * because a relocation is in play or because the shell has been moved out of
 * the boundary by an earlier `cd`.
 */
async function evaluateUnrecognizedRun(
  run: GuardToken[],
  state: PrefixState,
  basisCwd: string | undefined,
  context: GuardEvaluationContext,
  relink?: RelinkState,
): Promise<GuardDenial | undefined> {
  if (!run.some((token) => GIT_WORD_PATTERN.test(token.text))) return undefined;
  // A relinked `.git` redirects discovery for whatever git this run executes,
  // exactly as it would for a recognized one.
  if (relink?.gitDir) {
    return { allowed: false, reason: UNRECOGNIZED_PROGRAM_DENIAL };
  }
  // `nice git -c alias.pwn='!…' pwn`: the wrapper hides the invocation from
  // the git analysis, but the config it carries executes just the same.
  const gitIndex = run.findIndex(
    (token) => executableBaseName(token) === 'git',
  );
  if (gitIndex >= 0 && readGitInvocation(run.slice(gitIndex)).dangerousConfig) {
    return { allowed: false, reason: UNRECOGNIZED_PROGRAM_DENIAL };
  }
  // `grep -C 5 git CHANGELOG.md` carries a `-C` that has nothing to do with
  // git, so the program's own flag vocabulary decides whether it is a marker.
  const ownsCFlag =
    run.length > 0 && PROGRAMS_WITH_OWN_C_FLAG.has(executableBaseName(run[0]!));
  if (
    (!ownsCFlag && hasGitRelocationMarker(run)) ||
    run.some((token) =>
      (ownsCFlag
        ? TEXT_RELOCATION_MARKER_WITHOUT_C_PATTERN
        : TEXT_RELOCATION_MARKER_PATTERN
      ).test(token.text),
    ) ||
    state.relocations.length > 0 ||
    state.unresolved ||
    context.ambientRelocations.length > 0 ||
    context.ambientUnresolved
  ) {
    return { allowed: false, reason: UNRECOGNIZED_PROGRAM_DENIAL };
  }
  if (basisCwd === undefined) {
    return { allowed: false, reason: UNRECOGNIZED_PROGRAM_DENIAL };
  }
  const canonicalBasis = await realpathNearestExistingAsync(basisCwd);
  if (!isWithinRoot(canonicalBasis, context.canonicalEffectiveCwd)) {
    return denyTarget(OUTSIDE_TARGET_DENIAL_PREFIX, canonicalBasis);
  }
  // Same discovery rule as a recognized git run: being in an in-boundary
  // directory says nothing about which repository git finds from it.
  return denyOutsideDiscoveredRepository(canonicalBasis, context);
}

/**
 * State that outlives the scope it was created in. A relink performed inside
 * `sh -c '…'` still changes the real filesystem, and a relink performed in
 * the parent still misleads a nested run — so this is shared by reference in
 * both directions rather than merged after the fact.
 */
interface RelinkState {
  readonly targets: string[];
  gitDir: boolean;
}

interface EvaluationScope {
  readonly relink: RelinkState;
  // Shell variables the nested command can see: `eval` and subshells inherit
  // them, a `sh -c` subprocess does not.
  readonly locals?: Map<string, GuardToken>;
  // Names carrying the export attribute, shared with `eval` for the same
  // reason its locals are.
  readonly exportedNames?: Set<string>;
  // `set -a` state from the enclosing shell — a body run in the current shell
  // (`eval`, alias, function) inherits it, so a plain assignment there is
  // exported just as the real shell would.
  readonly allExport?: boolean;
  // Alias/function bodies and their Git-shaped names, shared with a
  // same-shell body so `outer() { inner; }` can see `inner`.
  readonly definedBodies?: Map<string, { body: string; alias: boolean }>;
  readonly gitShapedNames?: Set<string>;
  // Names carried by `export -f`, which a child shell (`bash -c`) imports.
  readonly exportedFunctions?: Set<string>;
}

/**
 * The top-level separators `splitCommands` cut on, in order — mirroring its
 * quote and substitution rules. `separators[i]` follows segment `i`. Both
 * sides of a `|` run in subshells, so a `cd` there must not move the shell.
 */
/**
 * A heredoc body is stdin data delivered to the command, not shell commands,
 * yet `splitCommands` has no heredoc state and would parse each body line as
 * its own segment — letting a body `cd` launder the tracked directory. Strip
 * `<<[-]WORD … WORD` bodies (quoted or not) before splitting. This is
 * best-effort: only the first heredoc on a line is handled, which is the
 * shape a model emits, and anything unrecognised is left untouched.
 */
function stripHeredocBodies(command: string): string {
  const lines = command.split('\n');
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    out.push(line);
    const match = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (!match) continue;
    const delimiter = match[2]!;
    const stripTabs = line.includes('<<-');
    // Consume the body up to the delimiter line, dropping it from the output.
    while (index + 1 < lines.length) {
      index++;
      const body = lines[index]!;
      const trimmed = stripTabs ? body.replace(/^\t+/, '') : body;
      if (trimmed === delimiter) break;
    }
  }
  return out.join('\n');
}

function readTopLevelSeparators(command: string): string[] {
  const separators: string[] = [];
  let single = false;
  let double = false;
  let backtick = false;
  let substitution = 0;
  const quoteStack: Array<[boolean, boolean]> = [];
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    const next = command[index + 1];
    if (!single && character === '\\' && index + 1 < command.length) {
      index++;
      continue;
    }
    if (!single && character === '`') {
      backtick = !backtick;
      continue;
    }
    if (!single && !backtick && character === '$' && next === '(') {
      quoteStack.push([single, double]);
      single = false;
      double = false;
      substitution++;
      index++;
      continue;
    }
    if (
      !backtick &&
      substitution > 0 &&
      character === ')' &&
      !single &&
      !double
    ) {
      const enclosing = quoteStack.pop();
      single = enclosing?.[0] ?? false;
      double = enclosing?.[1] ?? false;
      substitution--;
      continue;
    }
    if (!backtick && character === "'" && !double) {
      single = !single;
      continue;
    }
    if (!backtick && character === '"' && !single) {
      double = !double;
      continue;
    }
    if (single || double || backtick || substitution > 0) continue;
    if (character === '&' && next === '&') {
      separators.push('&&');
      index++;
    } else if (character === '&' && next === '>') {
      // `&>` / `&>>` redirects stdout+stderr; the `&` is not a separator.
      index += command[index + 2] === '>' ? 2 : 1;
    } else if (
      character === '&' &&
      (command[index - 1] === '>' || command[index - 1] === '<')
    ) {
      // `>&2` / `<&fd` — the `&` is part of a file-descriptor redirect.
    } else if (character === '&') {
      // A lone `&` backgrounds the command in its own subshell.
      separators.push('&');
    } else if (character === '|' && next === '|') {
      separators.push('||');
      index++;
    } else if (character === '|') {
      // `>|` is the clobber redirect, not a pipe.
      separators.push(command[index - 1] === '>' ? '>|' : '|');
    } else if (character === ';') {
      separators.push(';');
    } else if (character === '\n') {
      separators.push('\n');
    }
  }
  return separators;
}

interface CommandEvaluation {
  readonly denial?: GuardDenial;
  readonly cwdAfter: string | undefined;
  // Environment state the payload leaves behind. Only a construct that runs
  // in the current shell (`eval`) propagates it back to the caller.
  readonly exportedAfter?: PrefixState;
  readonly allExportAfter?: boolean;
  readonly shellLocalsAfter?: ReadonlyMap<string, GuardToken>;
}

async function evaluateCommandWithCwd(
  command: string,
  startCwd: string | undefined,
  entryCwd: string | undefined,
  context: GuardEvaluationContext,
  depth: number,
  scope: EvaluationScope = { relink: { targets: [], gitDir: false } },
): Promise<CommandEvaluation> {
  let trackedCwd = startCwd;
  // Assignments this command exported into the environment of everything that
  // runs after them, and whether `set -a` made plain assignments exported.
  const exported: PrefixState = { relocations: [], unresolved: false };
  let allExport = scope.allExport ?? false;
  // GIT_* assignments made without `export`. They stay shell-local until a
  // name-only `export GIT_DIR` promotes them into the environment.
  const shellLocals = scope.locals ?? new Map<string, GuardToken>();
  // `alias g='git …'` and `f() { git …; }` both make a later bare word run a
  // body defined earlier; without them that word is an opaque `other` run.
  const definedBodies =
    scope.definedBodies ?? new Map<string, { body: string; alias: boolean }>();
  // Names carrying the export attribute from a name-only `export KEY`; a
  // later assignment to one of them reaches the git subprocess.
  const exportedNames = scope.exportedNames ?? new Set<string>();
  // Function bodies that `splitCommands` cut across segments cannot be
  // replayed verbatim, so the name is recorded as Git-shaped instead and the
  // later bare word answers to the unrecognized-program containment rule.
  const gitShapedNames = scope.gitShapedNames ?? new Set<string>();
  const exportedFunctions = scope.exportedFunctions ?? new Set<string>();
  let insideDefinition: string | undefined;
  let definitionBody = '';
  // Paths a run in this command may have re-pointed. Any containment the
  // guard proves for one of them afterwards is proved against the old target.
  // Shared with every nested evaluation, in both directions.
  const relinkedTargets = scope.relink.targets;
  // Exported relocations reach every later command, including the ones nested
  // inside a wrapper payload or a substitution body.
  const activeContext = (): GuardEvaluationContext =>
    exported.relocations.length > 0 || exported.unresolved
      ? {
          canonicalEffectiveCwd: context.canonicalEffectiveCwd,
          ambientRelocations: [
            ...context.ambientRelocations,
            ...exported.relocations,
          ],
          ambientUnresolved: context.ambientUnresolved || exported.unresolved,
        }
      : context;
  let subshellDepth = 0;
  interface ShellStateSnapshot {
    readonly cwd: string | undefined;
    readonly relocations: GitEnvRelocation[];
    readonly unresolved: boolean;
    readonly allExport: boolean;
    readonly locals: Array<[string, GuardToken]>;
  }
  const snapshotShellState = (): ShellStateSnapshot => ({
    cwd: trackedCwd,
    relocations: [...exported.relocations],
    unresolved: exported.unresolved,
    allExport,
    locals: [...shellLocals],
  });
  const restoreShellState = (
    snapshot: ShellStateSnapshot | undefined,
  ): void => {
    if (snapshot === undefined) return;
    trackedCwd = snapshot.cwd;
    exported.relocations.length = 0;
    exported.relocations.push(...snapshot.relocations);
    exported.unresolved = snapshot.unresolved;
    allExport = snapshot.allExport;
    shellLocals.clear();
    for (const [key, token] of snapshot.locals) shellLocals.set(key, token);
  };
  const subshellCwds: ShellStateSnapshot[] = [];
  // Replay a recorded alias/function body in the current shell, propagating
  // its cwd and shell state back — an alias keeps the invocation's trailing
  // argv, a function receives args through `$@`.
  const invokeDefinedBody = async (
    programToken: string,
    run: GuardToken[],
  ): Promise<GuardDenial | undefined> => {
    const defined = definedBodies.get(programToken)!;
    if (depth >= MAX_PAYLOAD_RECURSION_DEPTH) return denyDynamicRelocation();
    let replay = defined.body;
    // Skip redirect/fd operands the way `readProgramWord` does, so a decoy
    // `> name` before the call does not truncate the prefix-assignment scan and
    // drop the call's leading `VAR=val` relocations.
    const programIndex = run.findIndex(
      (token) =>
        !token.redirect && !token.ambiguousFd && token.text === programToken,
    );
    if (defined.alias) {
      const args = joinArgvTexts(run.slice(programIndex + 1));
      if (args.length > 0) replay = `${replay} ${args}`;
    }
    // `VAR=val name` puts the assignment in the call's environment, so the
    // body's git sees it — record the leading assignments as ambient.
    const prefix: PrefixState = { relocations: [], unresolved: false };
    for (const token of run.slice(0, programIndex)) {
      if (leadingEnvAssignmentKey(token.text) !== null) {
        recordEnvAssignment(token, prefix);
      }
    }
    const base = activeContext();
    const bodyContext: GuardEvaluationContext =
      prefix.relocations.length > 0 || prefix.unresolved
        ? {
            canonicalEffectiveCwd: base.canonicalEffectiveCwd,
            ambientRelocations: [
              ...base.ambientRelocations,
              ...prefix.relocations,
            ],
            ambientUnresolved: base.ambientUnresolved || prefix.unresolved,
          }
        : base;
    const nested = await evaluateCommandWithCwd(
      replay,
      trackedCwd,
      entryCwd,
      bodyContext,
      depth + 1,
      {
        relink: scope.relink,
        locals: shellLocals,
        exportedNames,
        allExport,
        definedBodies,
        gitShapedNames,
        exportedFunctions,
      },
    );
    if (nested.denial) return nested.denial;
    trackedCwd = nested.cwdAfter;
    if (nested.exportedAfter) {
      exported.relocations.push(...nested.exportedAfter.relocations);
      if (nested.exportedAfter.unresolved) exported.unresolved = true;
    }
    if (nested.allExportAfter !== undefined) allExport = nested.allExportAfter;
    for (const [key, token] of nested.shellLocalsAfter ?? []) {
      shellLocals.set(key, token);
    }
    return undefined;
  };

  const segments = splitCommands(stripHeredocBodies(command));
  const separators = readTopLevelSeparators(stripHeredocBodies(command));
  // On any disagreement with `splitCommands`, treat every segment of a piped
  // command as a pipeline component rather than guessing.
  const separatorsMatch = separators.length === segments.length - 1;
  const isPipeComponent = (index: number): boolean =>
    separatorsMatch
      ? // Both sides of a pipe run in subshells; for `&` only the segment it
        // follows (the backgrounded one) does — the next segment is
        // foreground.
        separators[index - 1] === '|' ||
        separators[index] === '|' ||
        separators[index] === '&'
      : // Structural disagreement with `splitCommands`: scope every segment
        // rather than guess which ones ran in a subshell.
        separators.some((separator) => separator === '|' || separator === '&');
  for (const [segmentIndex, segment] of segments.entries()) {
    const pipeComponent = isPipeComponent(segmentIndex);
    const cwdBeforeSegment = trackedCwd;
    const definedBodiesBefore = pipeComponent
      ? new Map(definedBodies)
      : undefined;
    const gitShapedNamesBefore = pipeComponent
      ? new Set(gitShapedNames)
      : undefined;
    const exportedNamesBefore = pipeComponent
      ? new Set(exportedNames)
      : undefined;
    const exportedFunctionsBefore = pipeComponent
      ? new Set(exportedFunctions)
      : undefined;
    const shellLocalsBefore = pipeComponent ? new Map(shellLocals) : undefined;
    const exportedBefore = pipeComponent
      ? {
          relocations: [...exported.relocations],
          unresolved: exported.unresolved,
        }
      : undefined;
    const allExportBefore = allExport;
    const substitutions = extractCommandSubstitutions(segment);
    const tokenized =
      substitutions === null ? null : tokenizeSegment(segment, subshellDepth);
    const runs = tokenized?.runs ?? null;
    if (runs === null) {
      return {
        denial: { allowed: false, reason: UNPARSEABLE_COMMAND_DENIAL },
        cwdAfter: trackedCwd,
      };
    }
    // `name() { … }` — shell-quote reports the parentheses as operators, so
    // the header is recognised on the raw segment. The body runs wherever the
    // name is later used, which is what the recorded shape stands in for.
    const functionHeader =
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)/.exec(segment) ??
      // The `function NAME` keyword form, with the `()` optional.
      /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(segment);
    if (functionHeader) {
      insideDefinition = functionHeader[1]!;
      // Start the body at the first `{`; the header before it is not code.
      const braceAt = segment.indexOf('{');
      definitionBody = braceAt >= 0 ? segment.slice(braceAt + 1) : '';
    } else if (insideDefinition !== undefined) {
      definitionBody += `\n${segment}`;
    }
    if (insideDefinition !== undefined) {
      if (segment.includes('}')) {
        // Record the whole body so a later call replays it — a `-C <outside>`
        // or a `cd` inside it is then seen, not just the name.
        const closeAt = definitionBody.lastIndexOf('}');
        const body = (
          closeAt >= 0 ? definitionBody.slice(0, closeAt) : definitionBody
        ).trim();
        if (body.length > 0 && !pipeComponent) {
          definedBodies.set(insideDefinition, { body, alias: false });
        }
        insideDefinition = undefined;
      }
      continue;
    }

    // A substitution body executes before the command it is embedded in, in a
    // subshell of the current directory, so its cwd changes do not escape it.
    for (const body of substitutions!) {
      if (depth >= MAX_PAYLOAD_RECURSION_DEPTH) {
        return { denial: denyDynamicRelocation(), cwdAfter: trackedCwd };
      }
      const nested = await evaluateCommandWithCwd(
        body,
        trackedCwd,
        entryCwd,
        activeContext(),
        depth + 1,
        // A substitution runs in a subshell: it inherits the variables, the
        // option state and the definitions, but its own changes die with it,
        // so it gets copies and nothing is merged back.
        {
          relink: scope.relink,
          locals: new Map(shellLocals),
          exportedNames: new Set(exportedNames),
          allExport,
          definedBodies: new Map(definedBodies),
          gitShapedNames: new Set(gitShapedNames),
          // A subshell inherits `export -f` functions too; copy so its own
          // definitions and removals die with it.
          exportedFunctions: new Set(exportedFunctions),
        },
      );
      if (nested.denial) {
        return { denial: nested.denial, cwdAfter: trackedCwd };
      }
    }
    for (const { tokens: run, depth: runDepth } of runs) {
      while (runDepth > subshellDepth) {
        subshellCwds.push(snapshotShellState());
        subshellDepth++;
      }
      while (runDepth < subshellDepth) {
        // Leaving `( … )`: everything the subshell changed dies with it —
        // its cwd, its exports and its shell-local variables.
        restoreShellState(subshellCwds.pop());
        subshellDepth--;
      }
      // A removal builtin (`unset`/`unalias`/`export -n`) retracts a shadow,
      // but deciding exactly which name it drops is general shell semantics
      // this guard does not model: `unset NAME` removes a same-name variable
      // before the function, `enable -n unset` turns the builtin into a no-op,
      // a `command`/`builtin` prefix or a `( … )` subshell changes what runs,
      // and fused flag clusters (`-nf`) hide the mode. Whenever a removal
      // could retract a name we track as a shadow, fail closed rather than
      // trust a now-doubtful replay of the harmless body.
      // Bash strips redirections from argv, so skip redirect/fd operands the
      // same way `readProgramWord` does before (and between) `command`/
      // `builtin` prefixes — otherwise a leading `2>/dev/null` hides the
      // `command unset` that really removes the shadow.
      let removalStart = 0;
      const skipRedirectOperands = (): void => {
        while (
          removalStart < run.length &&
          (run[removalStart]!.redirect || run[removalStart]!.ambiguousFd)
        ) {
          removalStart++;
        }
      };
      skipRedirectOperands();
      let hasCommandPrefix = false;
      while (
        removalStart < run.length &&
        (run[removalStart]!.text === 'command' ||
          run[removalStart]!.text === 'builtin')
      ) {
        // Bash resolves a function before the `command`/`builtin` builtin, so
        // a shadowed prefix word runs its own body — leave it for the shadow
        // dispatch rather than treating it as a bypass to the real builtin.
        if (definedBodies.has(run[removalStart]!.text)) break;
        hasCommandPrefix = true;
        removalStart++;
        while (
          removalStart < run.length &&
          (run[removalStart]!.text.startsWith('-') ||
            run[removalStart]!.redirect ||
            run[removalStart]!.ambiguousFd)
        ) {
          removalStart++;
        }
      }
      const removalTokens = run.slice(removalStart);
      const removalProgram = readProgramWord(removalTokens);
      // A function shadowing `unset`/`unalias`/`export` runs its body instead
      // of the builtin (unless `command`/`builtin` bypassed the lookup), so
      // let the normal shadow dispatch replay it rather than treating the run
      // as a builtin removal that changes nothing.
      const shadowedBuiltin =
        !hasCommandPrefix &&
        removalProgram !== undefined &&
        definedBodies.has(removalProgram);
      const isRemoval =
        !shadowedBuiltin &&
        (removalProgram === 'unset' ||
          removalProgram === 'unalias' ||
          (removalProgram === 'export' &&
            removalTokens.some((token) => /^-[A-Za-z]*n/.test(token.text))));
      if (isRemoval) {
        const clearsAll = removalTokens.some((token) =>
          /^-[A-Za-z]*a/.test(token.text),
        );
        const touchesShadow = (name: string): boolean =>
          definedBodies.has(name) ||
          gitShapedNames.has(name) ||
          exportedFunctions.has(name);
        const anyShadow =
          definedBodies.size > 0 ||
          gitShapedNames.size > 0 ||
          exportedFunctions.size > 0;
        const retractsShadow =
          (clearsAll && anyShadow) ||
          removalTokens
            .slice(1)
            .some(
              (token) =>
                !token.text.startsWith('-') &&
                (token.dynamic || touchesShadow(token.text)),
            );
        if (retractsShadow) {
          return {
            denial: { allowed: false, reason: SHADOW_REMOVAL_DENIAL },
            cwdAfter: trackedCwd,
          };
        }
        // `unset NAME` / `unset -v NAME` drops a tracked variable, so a later
        // `$NAME` must stop expanding to its stale value — bash leaves it empty
        // (an unresolved reference the guard then fails closed on). `unset -f`
        // is functions-only and leaves variables intact.
        if (
          removalProgram === 'unset' &&
          !removalTokens.some((token) => token.text === '-f')
        ) {
          for (const token of removalTokens.slice(1)) {
            if (!token.text.startsWith('-')) shellLocals.delete(token.text);
          }
        }
        // Any other removal that names only untracked state is a genuine no-op.
        continue;
      }
      // A recorded function shadows a builtin or the git program, and bash
      // resolves it before either. `command`/`builtin` name a different
      // program word, so they bypass this naturally.
      const invoked = readProgramWord(run);
      if (
        invoked !== undefined &&
        definedBodies.has(invoked) &&
        readFunctionName(run) === undefined &&
        readAliasDefinitions(run).length === 0
      ) {
        const denial = await invokeDefinedBody(invoked, run);
        if (denial) return { denial, cwdAfter: trackedCwd };
        continue;
      }
      const analysis = analyzeRun(run);
      switch (analysis.kind) {
        case 'cd': {
          const target =
            analysis.target === undefined
              ? undefined
              : expandShellLocals(analysis.target, shellLocals);
          if (analysis.variant === 'popd' || target === undefined) {
            // `popd`, bare `cd` ($HOME), and dir-stack rotations land the
            // shell somewhere the daemon cannot resolve statically.
            trackedCwd = undefined;
            break;
          }
          if (isDynamicPathValue(target)) {
            trackedCwd = undefined;
            break;
          }
          if (analysis.physical) {
            // `cd -P` resolves each component through its symlinks, so
            // `link/..` is the parent of the symlink's real target rather
            // than the directory the link sits in.
            trackedCwd =
              trackedCwd === undefined && !path.isAbsolute(target.text)
                ? undefined
                : await resolvePhysicalPath(trackedCwd ?? '', target.text);
            break;
          }
          if (path.isAbsolute(target.text)) {
            trackedCwd = target.text;
            break;
          }
          trackedCwd =
            trackedCwd === undefined
              ? undefined
              : path.resolve(trackedCwd, target.text);
          break;
        }
        case 'payload': {
          if (depth >= MAX_PAYLOAD_RECURSION_DEPTH) {
            return { denial: denyDynamicRelocation(), cwdAfter: trackedCwd };
          }
          const inherited = activeContext();
          const ambient: GuardEvaluationContext = {
            canonicalEffectiveCwd: inherited.canonicalEffectiveCwd,
            ambientRelocations: [
              ...inherited.ambientRelocations,
              ...analysis.state.relocations,
            ],
            ambientUnresolved:
              inherited.ambientUnresolved || analysis.state.unresolved,
          };
          // The payload keeps the outermost run's entry cwd as its
          // containment basis: re-basing it to the tracked cwd would let a
          // preceding `cd` disappear inside the wrapper.
          const nested = await evaluateCommandWithCwd(
            analysis.payload,
            trackedCwd,
            entryCwd,
            ambient,
            depth + 1,
            {
              relink: scope.relink,
              // `eval` runs in this very shell, so it sees these variables
              // and the export attributes; a `sh -c` subprocess inherits only
              // exported ones.
              ...(analysis.propagatesCwd
                ? {
                    locals: shellLocals,
                    exportedNames,
                    allExport,
                    definedBodies,
                    gitShapedNames,
                    exportedFunctions,
                  }
                : analysis.importsExportedFunctions
                  ? {
                      // Only bash imports `export -f` functions. A `-c`
                      // subprocess is a separate process: copy the set so a
                      // child `unset -f` cannot retract the parent's exports,
                      // and drop any function whose `BASH_FUNC_*` entry an
                      // `env -u` stripped before the child started.
                      definedBodies: new Map(
                        [...definedBodies].filter(
                          ([name]) =>
                            exportedFunctions.has(name) &&
                            !envUnsetRemovesFunction(name, analysis.state),
                        ),
                      ),
                      exportedFunctions: new Set(
                        [...exportedFunctions].filter(
                          (name) =>
                            !envUnsetRemovesFunction(name, analysis.state),
                        ),
                      ),
                    }
                  : {}),
            },
          );
          if (nested.denial) {
            return { denial: nested.denial, cwdAfter: trackedCwd };
          }
          if (analysis.propagatesCwd) {
            // `eval` runs in the current shell, so everything it changed —
            // the cwd, exported relocations and `set -a` — outlives it.
            trackedCwd = nested.cwdAfter;
            if (nested.exportedAfter) {
              exported.relocations.push(...nested.exportedAfter.relocations);
              if (nested.exportedAfter.unresolved) exported.unresolved = true;
            }
            if (nested.allExportAfter !== undefined) {
              allExport = nested.allExportAfter;
            }
            for (const [key, token] of nested.shellLocalsAfter ?? []) {
              shellLocals.set(key, token);
            }
          }
          break;
        }
        case 'git': {
          const invocation = readGitInvocation(analysis.tokens);
          // A path this command relinked defeats a containment check made
          // afterwards. A relinked `.git` redirects discovery for every later
          // command; otherwise only a run that resolves one of those very
          // paths is affected, so `mv old new && git add -A` stays allowed.
          const resolvedRelocations = [
            ...invocation.cwdTargets,
            ...invocation.gitDirTargets,
            ...invocation.workTreeTargets,
          ].map((target) =>
            trackedCwd === undefined
              ? target.text
              : path.resolve(trackedCwd, target.text),
          );
          if (trackedCwd !== undefined && trackedCwd !== entryCwd) {
            resolvedRelocations.push(trackedCwd);
          }
          if (
            scope.relink.gitDir ||
            resolvedRelocations.some((target) =>
              relinkedTargets.some(
                (relinked) =>
                  target === relinked ||
                  isWithinRoot(target, relinked) ||
                  isWithinRoot(relinked, target),
              ),
            )
          ) {
            return {
              denial: denyDynamicRelocation(),
              cwdAfter: trackedCwd,
            };
          }
          const denial = await evaluateGitInvocation(
            invocation,
            analysis.state,
            trackedCwd,
            entryCwd,
            activeContext(),
          );
          if (denial) return { denial, cwdAfter: trackedCwd };
          break;
        }
        case 'dynamic-program': {
          const inherited = activeContext();
          const expanded = analysis.rest.map((token) =>
            expandShellLocals(token, shellLocals),
          );
          // The program word is unreadable, so it may be `ln`: record its
          // operands as possibly re-pointed. A `.git` among them redirects
          // discovery for everything after it; an ordinary one still has to
          // be recorded, or a later `git -C <that path>` is validated against
          // what the path pointed at before the command replaced it.
          for (const operand of expanded) {
            if (operand.text.startsWith('-') || operand.dynamic) continue;
            if (trackedCwd === undefined) {
              scope.relink.gitDir = true;
              continue;
            }
            const resolved = path.resolve(trackedCwd, operand.text);
            if (path.basename(resolved) === '.git') scope.relink.gitDir = true;
            else relinkedTargets.push(resolved);
          }
          if (
            analysis.state.unresolved ||
            analysis.state.relocations.length > 0 ||
            inherited.ambientUnresolved ||
            inherited.ambientRelocations.length > 0 ||
            hasGitRelocationMarker(expanded) ||
            expanded.some((token) =>
              TEXT_RELOCATION_MARKER_PATTERN.test(token.text),
            )
          ) {
            return { denial: denyDynamicRelocation(), cwdAfter: trackedCwd };
          }
          // A program word the daemon cannot read is at least as opaque as an
          // unrecognized one, so it answers to the same containment rule —
          // and when the shell has already left the boundary, an unreadable
          // program word is undecidable rather than harmless.
          if (
            trackedCwd === undefined ||
            !isWithinRoot(
              await realpathNearestExistingAsync(trackedCwd),
              inherited.canonicalEffectiveCwd,
            )
          ) {
            return { denial: denyDynamicRelocation(), cwdAfter: trackedCwd };
          }
          const denial = await evaluateUnrecognizedRun(
            expanded,
            analysis.state,
            trackedCwd,
            inherited,
            scope.relink,
          );
          if (denial) return { denial, cwdAfter: trackedCwd };
          break;
        }
        case 'undecidable':
          return {
            denial: { allowed: false, reason: UNDECIDABLE_PAYLOAD_DENIAL },
            cwdAfter: trackedCwd,
          };
        case 'export': {
          exported.relocations.push(...analysis.state.relocations);
          if (analysis.state.unresolved) exported.unresolved = true;
          if (analysis.operands.some((op) => op.text === '-f')) {
            for (const op of analysis.operands) {
              if (!op.text.startsWith('-') && !op.dynamic) {
                exportedFunctions.add(op.text);
              }
            }
          }
          // `export GIT_DIR` with no `=` exports whatever an earlier
          // shell-local assignment left in that name — and, because the
          // export *attribute* sticks to the name, whatever a later one puts
          // there as well.
          for (const operand of analysis.operands) {
            if (leadingEnvAssignmentKey(operand.text) !== null) continue;
            if (operand.dynamic) {
              // `export $NAME` can promote any assignment made earlier.
              exported.unresolved = true;
              continue;
            }
            const pending = shellLocals.get(operand.text);
            if (pending) recordEnvAssignment(pending, exported);
            if (
              GIT_DIR_ENV_KEYS.has(operand.text) ||
              GIT_WORK_TREE_ENV_KEYS.has(operand.text) ||
              GIT_UNRESOLVABLE_ENV_KEYS.has(operand.text) ||
              GIT_PROGRAM_ENV_KEYS.has(operand.text)
            ) {
              exportedNames.add(operand.text);
            }
          }
          const denial = await evaluateUnrecognizedRun(
            run,
            analysis.state,
            trackedCwd,
            activeContext(),
            scope.relink,
          );
          if (denial) return { denial, cwdAfter: trackedCwd };
          break;
        }
        case 'all-export':
          allExport = true;
          // A leading `GIT_DIR=… set -a` still made that assignment; it is
          // shell-local for now, promoted the moment allexport is on.
          exported.relocations.push(...analysis.state.relocations);
          if (analysis.state.unresolved) exported.unresolved = true;
          break;
        case 'all-export-off':
          allExport = false;
          break;
        case 'other': {
          // `alias name=body …` / `name() { body }` — record, don't execute.
          const aliasDefinitions = readAliasDefinitions(run);
          if (aliasDefinitions.length > 0) {
            for (const definition of aliasDefinitions) {
              definedBodies.set(definition.name, {
                body: definition.body,
                alias: true,
              });
            }
            break;
          }
          const definition = readDefinition(run);
          if (definition) {
            definedBodies.set(definition.name, {
              body: definition.body,
              alias: false,
            });
            break;
          }
          const programToken = readProgramWord(run);
          const definitionName = readFunctionName(run);
          if (definitionName) {
            if (run.some((token) => GIT_WORD_PATTERN.test(token.text))) {
              gitShapedNames.add(definitionName);
            }
            break;
          }
          if (programToken !== undefined && gitShapedNames.has(programToken)) {
            const denial = await evaluateUnrecognizedRun(
              [
                { text: programToken, dynamic: false },
                { text: 'git', dynamic: false },
              ],
              analysis.state,
              trackedCwd,
              activeContext(),
              scope.relink,
            );
            if (denial) return { denial, cwdAfter: trackedCwd };
            break;
          }
          if (programToken !== undefined && definedBodies.has(programToken)) {
            const denial = await invokeDefinedBody(programToken, run);
            if (denial) return { denial, cwdAfter: trackedCwd };
            break;
          }
          if (
            run.some((t) => PATH_EXTRACTING_PROGRAMS.has(executableBaseName(t)))
          ) {
            // An archive can place a symlink anywhere below the extraction
            // directory, so a later relocation resolving into it is suspect.
            // A path-less run that merely discovers a repository from an
            // extracted `.git` is a TOCTOU (the archive is unpacked after
            // this decision) and is left to the same limitation as the
            // symlink race rather than denying every `tar && git commit`.
            if (trackedCwd !== undefined) relinkedTargets.push(trackedCwd);
          }
          if (
            run.some((t) => PATH_RELINKING_PROGRAMS.has(executableBaseName(t)))
          ) {
            // Wrappers and leading assignments (`env ln …`, `X=1 ln …`) keep
            // the relinking program out of run[0], so scan the whole run.
            for (const operand of run) {
              if (operand.text.startsWith('-')) continue;
              if (PATH_RELINKING_PROGRAMS.has(executableBaseName(operand))) {
                continue;
              }
              if (operand.dynamic || trackedCwd === undefined) {
                scope.relink.gitDir = true;
                continue;
              }
              const resolved = path.resolve(trackedCwd, operand.text);
              relinkedTargets.push(resolved);
              if (path.basename(resolved) === '.git')
                scope.relink.gitDir = true;
            }
          }
          if (analysis.assignmentsOnly) {
            if (allExport) {
              // `set -a` turned this shell-local assignment into an exported
              // one straight away.
              exported.relocations.push(...analysis.state.relocations);
              if (analysis.state.unresolved) exported.unresolved = true;
            } else {
              for (const token of run) {
                const key = leadingEnvAssignmentKey(token.text);
                if (key === null) continue;
                if (exportedNames.has(key)) {
                  recordEnvAssignment(token, exported);
                  continue;
                }
                const previous = shellLocals.get(key);
                if (!isAppendAssignment(token.text) || previous === undefined) {
                  shellLocals.set(key, token);
                  continue;
                }
                // `X+=…` appends: keep the accumulated value so a later `$X`
                // expands to what the shell would run.
                shellLocals.set(key, {
                  text:
                    previous.text +
                    token.text.slice(token.text.indexOf('=') + 1),
                  dynamic: previous.dynamic || token.dynamic,
                });
              }
            }
          }
          const denial = await evaluateUnrecognizedRun(
            run,
            analysis.state,
            trackedCwd,
            activeContext(),
            scope.relink,
          );
          if (denial) return { denial, cwdAfter: trackedCwd };
          break;
        }
        default: {
          const exhaustive: never = analysis;
          void exhaustive;
          break;
        }
      }
    }
    // The tokenizer's closing depth is authoritative for what this segment
    // did with parentheses: `(cd <outside>)` opens and closes within it, so
    // the subshell's cwd must not survive into the next segment.
    while (tokenized!.endDepth < subshellDepth) {
      restoreShellState(subshellCwds.pop());
      subshellDepth--;
    }
    while (tokenized!.endDepth > subshellDepth) {
      subshellCwds.push(snapshotShellState());
      subshellDepth++;
    }
    // Both sides of a pipe run in their own subshell, so whatever this
    // segment did to the shell's directory dies with it.
    if (pipeComponent) {
      // A subshell keeps nothing: its cwd, option state, definitions,
      // exports and variables all die with it.
      trackedCwd = cwdBeforeSegment;
      allExport = allExportBefore;
      definedBodies.clear();
      for (const [k, v] of definedBodiesBefore!) definedBodies.set(k, v);
      gitShapedNames.clear();
      for (const k of gitShapedNamesBefore!) gitShapedNames.add(k);
      exportedNames.clear();
      for (const k of exportedNamesBefore!) exportedNames.add(k);
      exportedFunctions.clear();
      for (const k of exportedFunctionsBefore!) exportedFunctions.add(k);
      shellLocals.clear();
      for (const [k, v] of shellLocalsBefore!) shellLocals.set(k, v);
      exported.relocations.length = 0;
      exported.relocations.push(...exportedBefore!.relocations);
      exported.unresolved = exportedBefore!.unresolved;
    }
  }
  return {
    cwdAfter: trackedCwd,
    exportedAfter: exported,
    allExportAfter: allExport,
    shellLocalsAfter: shellLocals,
  };
}

async function evaluateBuiltInGuard(
  request: TrustedDaemonToolGuardRequest,
): Promise<ExternalToolGuardPrepareResult> {
  if (!SHELL_EXECUTING_TOOLS.has(request.toolName)) return { allowed: true };
  const command = request.arguments['command'];
  if (typeof command !== 'string') return { allowed: true };

  const sessionCwd = await realpathNearestExistingAsync(request.effectiveCwd);

  // A sub-agent pinned to a worktree (`working_dir`, or `isolation`, which
  // rebinds the child Config's cwd surfaces) executes there while reporting
  // the parent session id, so the session's own directory is not where the
  // command runs. The child reports that directory; it is untrusted, so it is
  // only accepted where the daemon can verify it from state it owns: inside
  // the session's effective working directory, or inside the worktree tree
  // this very session owns (`GitWorktreeService.getWorktreesDir(sessionId)`).
  // Anywhere else the scope cannot be established and the call fails closed —
  // and the accepted directory becomes the boundary, so an isolated sub-agent
  // is contained to its own worktree rather than to its parent's checkout.
  let canonicalEffectiveCwd = sessionCwd;
  const reportedCwd = request.invocationCwd;
  if (typeof reportedCwd === 'string' && reportedCwd.length > 0) {
    const canonicalReported = await realpathNearestExistingAsync(reportedCwd);
    if (isWithinRoot(canonicalReported, sessionCwd)) {
      // `AgentTool` with `isolation: 'worktree'` provisions under
      // `<projectRoot>/.qwen/worktrees/`, which is inside the session — so
      // "inside" is not enough to leave the boundary alone. A reported
      // directory that is a checkout root in its own right is the sub-agent's
      // worktree, and containing it there is what stops one sub-agent from
      // reaching into a sibling's. An ordinary subdirectory resolves to the
      // session's own repository and changes nothing.
      if (canonicalReported !== sessionCwd) {
        let discovered: string | undefined;
        try {
          discovered = await resolveDiscoveredRepository(
            canonicalReported,
            sessionCwd,
          );
        } catch {
          return denyTarget(
            UNVERIFIABLE_SCOPE_DENIAL_PREFIX,
            canonicalReported,
          );
        }
        if (
          discovered !== undefined &&
          (await realpathNearestExistingAsync(discovered)) === canonicalReported
        ) {
          canonicalEffectiveCwd = canonicalReported;
        }
      }
    } else {
      const ownedWorktrees = await realpathNearestExistingAsync(
        GitWorktreeService.getWorktreesDir(request.sessionId),
      );
      if (!isWithinRoot(canonicalReported, ownedWorktrees)) {
        return denyTarget(UNVERIFIABLE_SCOPE_DENIAL_PREFIX, canonicalReported);
      }
      canonicalEffectiveCwd = canonicalReported;
    }
  }

  // A model-supplied `directory` becomes the containment basis, so it must
  // itself stay inside the effective working directory before it is trusted.
  let startDirectory = canonicalEffectiveCwd;
  const startDirectoryValue = request.arguments['directory'];
  if (typeof startDirectoryValue === 'string') {
    startDirectory = await realpathNearestExistingAsync(
      path.resolve(canonicalEffectiveCwd, startDirectoryValue),
    );
    if (!isWithinRoot(startDirectory, canonicalEffectiveCwd)) {
      return denyTarget(OUTSIDE_TARGET_DENIAL_PREFIX, startDirectory);
    }
  }

  const { denial } = await evaluateCommandWithCwd(
    command,
    startDirectory,
    startDirectory,
    {
      canonicalEffectiveCwd,
      ambientRelocations: [],
      ambientUnresolved: false,
    },
    0,
  );
  return denial ?? { allowed: true };
}

export function createDaemonToolGuard(
  externalGuard?: ExternalToolGuardHandler,
): ExternalToolGuardHandler {
  return async (request) => {
    const trusted = request as TrustedDaemonToolGuardRequest;
    if (typeof trusted.effectiveCwd !== 'string') {
      throw new Error('Daemon tool guard requires trusted workspace context.');
    }
    const builtInDecision = await evaluateBuiltInGuard(trusted);
    if (!builtInDecision.allowed || !externalGuard) return builtInDecision;
    if (trusted.promptId === undefined) {
      // Context-less shell checks carry only the built-in policy; the
      // external provider is contracted to a live prompt.
      return { allowed: false, reason: PROMPTLESS_PROVIDER_DENIAL };
    }
    if (EXTERNAL_GUARD_UNSUPPORTED_TOOLS.has(request.toolName)) {
      return {
        allowed: false,
        reason:
          'Managed external tool guard v1 does not support nested or delegated agent execution.',
      };
    }
    return externalGuard(request);
  };
}
