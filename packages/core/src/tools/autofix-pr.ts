/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * autofix_pr — runs one `qwen autofix-pr` helper from typed parameters,
 * without a shell, so that a permission rule can name the helper (design
 * doc `docs/design/2026-10-21-autofix-pr-command.md`, Sections 6.12 and
 * 6.13). Its `unattended` command lets the fix agent of a watch the user
 * confirmed run its commands without asking.
 */

import { accessSync, constants, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/approval-mode.js';
import {
  buildPermissionCheckContext,
  evaluatePermissionRules,
} from '../core/permission-helpers.js';
import type { PermissionDecision } from '../permissions/types.js';
import { getShellContextEnvVars } from '../services/shellContextEnv.js';
import {
  ShellExecutionService,
  type ShellOutputEvent,
} from '../services/shellExecutionService.js';
import { resolveInteractionMode } from '../core/prompts.js';
import { getErrorMessage } from '../utils/errors.js';
import { execCommand } from '../utils/shell-utils.js';
import { getJsInterpreterCommand } from '../utils/runtime-info.js';
import { sanitizeChildEnv } from '../utils/sanitize-child-env.js';
import { sessionIdContext } from '../utils/sessionIdContext.js';
import { normalizePathEnvForWindows } from '../utils/windowsPath.js';
import { ToolErrorType } from './tool-error.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import type {
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
  ToolExecuteConfirmationDetails,
  ToolInfoConfirmationDetails,
  ToolInvocation,
  ToolResult,
} from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import {
  backgroundFixOf,
  canonicalWorktreePath,
  settleBackgroundFix,
  confirmedWatch,
  forgetConfirmedWatch,
  grantUnattendedFixes,
  recordConfirmedWatch,
  recordWatchTask,
  revokeUnattendedFixes,
  unattendedFixGranted,
  type BackgroundFix,
  type ConfirmedWatch,
} from './autofix-pr-grants.js';

export const AUTOFIX_PR_COMMANDS = [
  'prepare',
  'snapshot',
  'ci-log',
  'push',
  'sync',
  'reply',
  'rerun',
  'schedule',
  'fix-end',
  'status',
  'cleanup',
  'unattended',
  'attended',
] as const;

export type AutofixPrCommand = (typeof AUTOFIX_PR_COMMANDS)[number];

export interface AutofixPrParams {
  command: AutofixPrCommand;
  pr?: number;
  repo?: string;
  host?: string;
  take_over?: boolean;
  in_place?: boolean;
  task?: string;
  run_id?: string;
  lines?: number;
  plan?: string;
  no_post?: boolean;
  discard?: boolean;
  every?: number;
  no_reply?: boolean;
  instructions?: boolean;
  again?: boolean;
  attempt?: string;
}

type OptionName = Exclude<keyof AutofixPrParams, 'command' | 'pr'>;

/** The options each command takes; any other is a refusal. */
const OPTIONS: Readonly<Record<AutofixPrCommand, readonly OptionName[]>> = {
  prepare: ['repo', 'host', 'take_over', 'in_place'],
  snapshot: ['repo', 'host', 'task'],
  'ci-log': ['run_id', 'lines', 'task'],
  push: ['task'],
  sync: ['discard', 'task'],
  reply: ['plan', 'no_post', 'task'],
  rerun: ['run_id', 'task'],
  schedule: ['every', 'no_reply', 'instructions', 'again'],
  'fix-end': ['attempt', 'task'],
  status: [],
  cleanup: ['take_over'],
  unattended: [],
  attended: [],
};

const REQUIRED: Partial<Record<AutofixPrCommand, readonly OptionName[]>> = {
  prepare: ['repo'],
  'ci-log': ['run_id'],
  reply: ['plan'],
  rerun: ['run_id'],
  'fix-end': ['attempt'],
};

const BOOLEAN_OPTIONS = new Set<OptionName>([
  'take_over',
  'in_place',
  'no_post',
  'discard',
  'no_reply',
  'instructions',
  'again',
]);

const INTEGER_OPTIONS = new Set<OptionName>(['lines', 'every']);

// Shapes a helper would accept anyway; checked here so that no value can
// read as an option of its own.
const STRING_SHAPES: Readonly<Partial<Record<OptionName, RegExp>>> = {
  repo: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  host: /^[A-Za-z0-9][A-Za-z0-9.-]*(?::\d+)?$/,
  task: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
  // A safe integer: the helper reads it as a number.
  run_id: /^\d{1,15}$/,
  // The id the session opened a background fix's attempt with.
  attempt: /^[0-9a-f]{12}$/,
};

/** Every helper finishes well within this; `push` gives hooks nine minutes. */
export const AUTOFIX_PR_TIMEOUT_MS = 600_000;

const OUTPUT_CAP_BYTES = 8 * 1024 * 1024;
const STDERR_CAP_CHARS = 16 * 1024;

/**
 * The reply plan the skill writes beside the PR's worktree, and nothing in
 * it: a file the PR's own tree carries must not speak on the PR.
 */
function isPlanPath(plan: string, pr: number | undefined): boolean {
  if (pr === undefined || plan.includes('\0')) return false;
  const parts = plan.split(/[\\/]+/);
  const n = parts.length;
  return (
    path.isAbsolute(plan) &&
    n >= 3 &&
    parts[n - 1] === `autofix-pr-${pr}-plan.json` &&
    parts[n - 2] === 'tmp' &&
    parts[n - 3] === '.qwen' &&
    // Case-folding file systems read AUTOFIX-PR-<n> as the worktree too.
    !parts.some((part) => part.toLowerCase() === `autofix-pr-${pr}`)
  );
}

export function validateAutofixPrParams(
  params: AutofixPrParams,
): string | null {
  if (!AUTOFIX_PR_COMMANDS.includes(params.command)) {
    return `"command" must be one of: ${AUTOFIX_PR_COMMANDS.join(', ')}.`;
  }
  const command = params.command;
  if (params.pr !== undefined) {
    if (!Number.isSafeInteger(params.pr) || params.pr < 1) {
      return '"pr" must be a positive integer.';
    }
  } else if (command !== 'status') {
    return `"${command}" needs "pr".`;
  }
  const allowed = OPTIONS[command];
  for (const [key, value] of Object.entries(params)) {
    if (key === 'command' || key === 'pr' || value === undefined) continue;
    const option = key as OptionName;
    // An option left at its default says nothing, whichever command it is.
    if (value === false && BOOLEAN_OPTIONS.has(option)) continue;
    if (!allowed.includes(option)) {
      return allowed.length === 0
        ? `"${command}" takes no option but "pr"; got "${key}".`
        : `"${command}" does not take "${key}" (it takes ${allowed.map((o) => `"${o}"`).join(', ')}).`;
    }
    if (BOOLEAN_OPTIONS.has(option)) {
      if (typeof value !== 'boolean') return `"${key}" must be a boolean.`;
    } else if (INTEGER_OPTIONS.has(option)) {
      if (!Number.isSafeInteger(value) || (value as number) < 1) {
        return `"${key}" must be a positive integer.`;
      }
    } else {
      if (typeof value !== 'string' || value === '') {
        return `"${key}" must be a non-empty string.`;
      }
      const shape = STRING_SHAPES[option];
      if (shape && !shape.test(value)) {
        return `"${key}" is not a valid value: ${JSON.stringify(value)}.`;
      }
      if (option === 'plan' && !isPlanPath(value, params.pr)) {
        return `"plan" must be the absolute path of the reply plan the skill writes, <clone>/.qwen/tmp/autofix-pr-${params.pr ?? '<pr>'}-plan.json beside the worktree.`;
      }
    }
  }
  for (const option of REQUIRED[command] ?? []) {
    if (params[option] === undefined) {
      return `"${command}" needs "${option}".`;
    }
  }
  return null;
}

/**
 * The helper's arguments, after `autofix-pr`. Options are passed as
 * `--name=value`, so no value is ever read as an option.
 */
export function autofixPrArgs(params: AutofixPrParams): string[] {
  const args: string[] = [params.command];
  if (params.pr !== undefined) args.push(String(params.pr));
  // The positionals are validated before this (`run_id` is digits, `plan`
  // an absolute path to the plan file); refused here as well, so that no
  // caller can hand the helper a value it would read as an option.
  for (const positional of [params.run_id, params.plan]) {
    if (positional === undefined) continue;
    if (positional.startsWith('-')) {
      throw new TypeError(
        `autofix-pr: ${JSON.stringify(positional)} would read as an option`,
      );
    }
    args.push(positional);
  }
  const value = (name: string, v: string | number | undefined) => {
    if (v !== undefined) args.push(`--${name}=${v}`);
  };
  const flag = (name: string, on: boolean | undefined) => {
    if (on === true) args.push(`--${name}`);
  };
  value('repo', params.repo);
  value('host', params.host);
  value('lines', params.lines);
  value('every', params.every);
  value('task', params.task);
  value('attempt', params.attempt);
  flag('take-over', params.take_over);
  flag('in-place', params.in_place);
  flag('no-post', params.no_post);
  flag('discard', params.discard);
  flag('no-reply', params.no_reply);
  flag('instructions', params.instructions);
  flag('again', params.again);
  return args;
}

/** The helpers that act on a watch once it is prepared. */
const WATCH_COMMANDS = new Set<AutofixPrCommand>([
  'snapshot',
  'ci-log',
  'sync',
  'push',
  'reply',
  'rerun',
  'schedule',
  'fix-end',
  'cleanup',
]);

export type AutofixPrWatchMatch =
  | 'take-over'
  | 'confirmed'
  | 'unconfirmed'
  | 'none';

/**
 * The `watch` rules match besides `command`, derived, never the model's: a
 * take-over is `take-over`; a helper of a watch this session prepared
 * through the tool, from this clone, and `status` still lists as that one
 * is `confirmed`, of any other `unconfirmed`. The skill's rules name
 * `watch:confirmed`, so they let through only the watches the user started
 * or resumed here, while a rule naming `command` alone — a deny rule above
 * all — covers every call of that helper.
 */
export function autofixPrWatchMatch(
  params: AutofixPrParams,
  watchConfirmed: boolean,
): AutofixPrWatchMatch {
  if (params.take_over === true) return 'take-over';
  if (!WATCH_COMMANDS.has(params.command)) return 'none';
  return watchConfirmed ? 'confirmed' : 'unconfirmed';
}

const SCRIPT_ENTRY = /\.(?:mjs|cjs|js)$/i;

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The CLI running this session, as `{ executable, args }`. `QWEN_CODE_CLI`
 * comes first, as for every re-invocation of the app; a script entry runs
 * through the JavaScript interpreter, so it needs no execute bit and no
 * shebang, and a Windows `.cmd` shim, which only a shell can run, is
 * skipped. The fallback is the entry this process was started from.
 */
export function resolveAutofixPrLaunch(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): { executable: string; args: string[] } {
  const interpreter = () => getJsInterpreterCommand(import.meta.url).command;
  const entry = env['QWEN_CODE_CLI'];
  if (entry && path.isAbsolute(entry) && !/\.(?:cmd|bat)$/i.test(entry)) {
    if (SCRIPT_ENTRY.test(entry)) {
      try {
        if (statSync(entry).isFile()) {
          return { executable: interpreter(), args: [entry] };
        }
      } catch {
        // Missing: fall back below.
      }
    } else if (isExecutableFile(entry)) {
      return { executable: entry, args: [] };
    }
  }
  const script = argv[1];
  if (script && path.isAbsolute(script)) {
    return { executable: interpreter(), args: [script] };
  }
  throw new Error(
    'cannot find the Qwen Code CLI to run: QWEN_CODE_CLI is not usable and this process was not started from a script',
  );
}

let launch: { executable: string; args: string[] } | undefined;

/**
 * The CLI to run, found once per process: a later change of the
 * environment (a reloaded `.env`) does not move it.
 */
function autofixPrLaunch(): { executable: string; args: string[] } {
  return (launch ??= resolveAutofixPrLaunch());
}

/** Test-only: finds the CLI again on the next call. */
export function resetAutofixPrLaunchForTests(): void {
  launch = undefined;
}

export interface AutofixPrRun {
  exitCode: number | null;
  stdout: string;
  /** stdout went past the cap; what is kept is its start. */
  truncated?: boolean;
  stderr: string;
  /** Why it did not finish on its own: cancelled, timed out, or failed to start. */
  failure?: string;
}

// One helper at a time per directory: they share a lock, and one refused
// for it did nothing.
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(
  key: string,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  // A call cancelled while it waits returns at once; `run` sees the signal.
  const turn = new Promise<void>((resolve) => {
    const go = () => {
      signal.removeEventListener('abort', go);
      resolve();
    };
    if (signal.aborted) return go();
    signal.addEventListener('abort', go, { once: true });
    previous.then(go, go);
  });
  const next = turn.then(run);
  // The next call waits for this one and, if this one was cancelled while
  // it waited, for the one still running before it.
  const settled = Promise.allSettled([previous, next]).then(() => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return next;
}

export async function runAutofixPrHelper(
  config: Config,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs: number = AUTOFIX_PR_TIMEOUT_MS,
): Promise<AutofixPrRun> {
  const cwd = config.getTargetDir();
  // `status` takes no lock and writes nothing, so it waits for no one: the
  // check before a fix agent starts is not held up by a push.
  const queue =
    args[0] === 'status'
      ? (run: () => Promise<AutofixPrRun>) => run()
      : (run: () => Promise<AutofixPrRun>) => serialized(cwd, signal, run);
  return queue(async () => {
    if (signal.aborted) {
      return { exitCode: null, stdout: '', stderr: '', failure: 'cancelled' };
    }
    const sessionId = config.getSessionId();
    const env = Object.fromEntries(
      Object.entries({
        ...normalizePathEnvForWindows(sanitizeChildEnv(process.env)),
        QWEN_CODE: '1',
        ...sessionIdContext.run(sessionId, getShellContextEnvVars),
        QWEN_CODE_SESSION_ID: sessionId,
      }).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let stdout = '';
    let stdoutBytes = 0;
    let truncated = false;
    let stderr = '';
    const onOutput = (event: ShellOutputEvent) => {
      if (event.type !== 'data' || typeof event.chunk !== 'string') return;
      if (event.stream === 'stderr') {
        stderr = (stderr + event.chunk).slice(-STDERR_CAP_CHARS);
        return;
      }
      if (stdoutBytes >= OUTPUT_CAP_BYTES) {
        truncated = true;
        return;
      }
      stdoutBytes += Buffer.byteLength(event.chunk, 'utf8');
      stdout += event.chunk;
    };
    try {
      const cli = autofixPrLaunch();
      const handle = await ShellExecutionService.executeLaunch(
        {
          executable: cli.executable,
          args: [...cli.args, 'autofix-pr', ...args],
          cwd,
          env,
        },
        onOutput,
        combined,
        false,
        {
          ...config.getShellExecutionConfig(),
          maxBufferedOutputBytes: OUTPUT_CAP_BYTES,
        },
        { streamStdout: true },
      );
      const result = await handle.result;
      if (result.error && !result.aborted) {
        return {
          exitCode: null,
          stdout,
          stderr,
          failure: `could not start: ${result.error.message}`,
        };
      }
      const diagnostic = result.error ? `: ${result.error.message}` : '';
      if (timeout.aborted) {
        return {
          exitCode: result.exitCode,
          stdout,
          stderr,
          failure: `timed out after ${timeoutMs / 60_000} minutes${diagnostic}`,
        };
      }
      if (result.aborted) {
        return {
          exitCode: result.exitCode,
          stdout,
          stderr,
          failure: `cancelled${diagnostic}`,
        };
      }
      return {
        exitCode: result.exitCode,
        stdout,
        stderr,
        ...(truncated ? { truncated } : {}),
      };
    } catch (error) {
      return {
        exitCode: null,
        stdout,
        stderr,
        failure: `could not start: ${getErrorMessage(error)}`,
      };
    }
  });
}

/**
 * The watch of `pr` this session prepared through the tool from the
 * directory it is in now: after `/cd` to another clone, a watch of that
 * number there is another one.
 */
function preparedWatch(config: Config, pr: number): ConfirmedWatch | undefined {
  const watch = confirmedWatch(config.getSessionId(), pr);
  return watch?.targetDir === config.getTargetDir() ? watch : undefined;
}

interface WatchStatusLike {
  pr?: unknown;
  repo?: unknown;
  host?: unknown;
  preparedAt?: unknown;
  thisSession?: unknown;
  ended?: unknown;
  worktreePath?: unknown;
  worktreeExists?: unknown;
  gitTrusted?: unknown;
  inPlace?: unknown;
}

/** Whether `status` lists `watch` as the one `prepared` recorded. */
function listsPrepared(
  prepared: ConfirmedWatch,
  watch: WatchStatusLike,
): boolean {
  return (
    watch.pr === prepared.pr &&
    typeof watch.repo === 'string' &&
    watch.repo.toLowerCase() === prepared.repo.toLowerCase() &&
    (prepared.host === null ||
      (typeof watch.host === 'string' &&
        watch.host.toLowerCase() === prepared.host.toLowerCase())) &&
    (watch.preparedAt ?? null) === prepared.preparedAt &&
    typeof watch.worktreePath === 'string' &&
    canonicalWorktreePath(watch.worktreePath) === prepared.worktree
  );
}

async function listedWatches(
  config: Config,
  pr: number,
  signal: AbortSignal,
): Promise<WatchStatusLike[] | { refused: string }> {
  // Ownership only: `--no-work` skips the git scan of the worktree.
  const run = await runAutofixPrHelper(
    config,
    ['status', String(pr), '--no-work'],
    signal,
  );
  if (run.failure || run.exitCode !== 0) {
    return {
      refused: `\`autofix-pr status ${pr}\` failed: ${run.failure ?? (run.stderr.trim() || `exit ${run.exitCode}`)}`,
    };
  }
  const parsed = lastJsonLine(run.stdout) as { watches?: unknown } | undefined;
  if (!parsed || !Array.isArray(parsed.watches)) {
    return { refused: `\`autofix-pr status ${pr}\` printed no status` };
  }
  return parsed.watches as WatchStatusLike[];
}

/**
 * Whether a helper call acts on the watch this session prepared: the state
 * file the helper reads sits in reach of a round's code, so it must still
 * name that watch — the repository, `preparedAt`, the worktree — and this
 * session, not ended.
 */
async function stillPrepared(
  config: Config,
  command: AutofixPrCommand,
  pr: number,
  signal: AbortSignal,
): Promise<'confirmed' | 'unconfirmed' | 'hooks'> {
  const prepared = preparedWatch(config, pr);
  if (!prepared) return 'unconfirmed';
  const watches = await listedWatches(config, pr, signal);
  if (!Array.isArray(watches)) return 'unconfirmed';
  const watch = watches.find((w) => w.pr === pr);
  if (
    watch === undefined ||
    !listsPrepared(prepared, watch) ||
    watch.thisSession !== true ||
    watch.ended !== null ||
    // A git directory the tree can write — a submodule's embedded one, say
    // — hands the helper's git commands a config the PR controls.
    watch.gitTrusted !== true
  ) {
    return 'unconfirmed';
  }
  // These run git hooks in the worktree. When a hook may run what the PR's
  // tree holds, a watch whose fixes ask must ask for them too. A grant of
  // unattended fixes answers for the hooks as well: its fix agent already
  // runs the PR's code without asking, so asking for its hooks protects
  // nothing — the one flag means both.
  return !HOOK_COMMANDS.has(command) ||
    unattendedFixGranted(config.getSessionId(), prepared.worktree) ||
    !(await hooksMayRunPrCode(prepared.worktree, signal))
    ? 'confirmed'
    : 'hooks';
}

/** The helpers that run git commands with hooks in the worktree. */
const HOOK_COMMANDS = new Set<AutofixPrCommand>(['sync', 'push']);

/** The hooks a `push` or a `sync` (fetch, merge, switch) makes git run. */
const PUSH_SYNC_HOOKS = [
  'pre-push',
  'post-checkout',
  'post-merge',
  'reference-transaction',
];

/**
 * Whether a `push` or `sync` may run code the PR's tree controls through a
 * git hook. A relative `core.hooksPath` (husky's `.husky`) resolves inside
 * the worktree, so the tree supplies the hooks; and a hook installed in the
 * clone's own hooks directory may be a dispatcher (pre-commit, lefthook,
 * husky 4) that runs what a config file in the tree says. So any such hook
 * counts, wherever it lives. Unknown counts as yes.
 */
async function hooksMayRunPrCode(
  worktree: string,
  signal: AbortSignal,
): Promise<boolean> {
  const git = (...args: string[]) =>
    execCommand('git', ['-C', worktree, ...args], {
      preserveOutputOnError: true,
      signal,
      timeout: 10_000,
      windowsHide: true,
    });
  try {
    const configured = await git('config', '--get', 'core.hooksPath');
    let dir: string;
    if (configured.code === 1 && configured.stdout.trim() === '') {
      const common = await git('rev-parse', '--git-common-dir');
      if (common.code !== 0) return true;
      dir = path.join(path.resolve(worktree, common.stdout.trim()), 'hooks');
    } else if (configured.code === 0) {
      const value = configured.stdout.trim();
      const expanded =
        value === '~' || value.startsWith('~/')
          ? path.join(os.homedir(), value.slice(1))
          : value;
      dir = path.resolve(worktree, expanded);
      const inside = path.relative(worktree, canonicalWorktreePath(dir));
      if (
        inside !== '..' &&
        !inside.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(inside)
      ) {
        return true;
      }
    } else {
      return true;
    }
    return PUSH_SYNC_HOOKS.some((hook) => {
      try {
        return statSync(path.join(dir, hook)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return true;
  }
}

/**
 * Whether the fixes of a watch may run unattended: this session prepared
 * it through the tool, GitHub then said its author can push, and `status`
 * still lists it as this session's, not ended, with that worktree. The
 * state file `status` reads is in reach of a round's code, so it only ever
 * narrows what the confirmed watch allows.
 */
export async function checkUnattendedWatch(
  config: Config,
  pr: number,
  signal: AbortSignal,
): Promise<{ watch: ConfirmedWatch } | { refused: string }> {
  const prepared = preparedWatch(config, pr);
  if (!prepared) {
    return {
      refused: `this session did not start or resume the watch of PR #${pr}`,
    };
  }
  if (!prepared.authorCanPush) {
    return {
      refused: `the author of PR #${pr} cannot push to the repository, so its code is never run unattended`,
    };
  }
  const watches = await listedWatches(config, pr, signal);
  if (!Array.isArray(watches)) return watches;
  const watch = watches.find(
    (w) =>
      w.pr === pr &&
      typeof w.repo === 'string' &&
      w.repo.toLowerCase() === prepared.repo.toLowerCase(),
  );
  if (!watch) {
    return {
      refused: `PR #${pr} of ${prepared.repo} has no watch in this clone`,
    };
  }
  if (
    prepared.host !== null &&
    (typeof watch.host !== 'string' ||
      watch.host.toLowerCase() !== prepared.host.toLowerCase())
  ) {
    return { refused: `PR #${pr} here is a watch of another host` };
  }
  if (watch.thisSession !== true) {
    return { refused: `PR #${pr} is watched by another session` };
  }
  if ((watch.preparedAt ?? null) !== prepared.preparedAt) {
    return {
      refused: `the watch of PR #${pr} was prepared again elsewhere since`,
    };
  }
  if (watch.ended !== null) {
    return { refused: `the watch of PR #${pr} was ended` };
  }
  if (watch.inPlace === true) {
    return {
      refused: `PR #${pr} is an in-place watch: its fixes run in the user's own checkout, always attended`,
    };
  }
  if (
    watch.worktreeExists !== true ||
    typeof watch.worktreePath !== 'string' ||
    canonicalWorktreePath(watch.worktreePath) !== prepared.worktree
  ) {
    return { refused: `the worktree of PR #${pr} is not the one prepared` };
  }
  return { watch: prepared };
}

interface PreparedLike {
  worktreePath?: unknown;
  host?: unknown;
  preparedAt?: unknown;
  authorCanPush?: unknown;
  tookOver?: unknown;
  inPlace?: unknown;
}

/** How long `cleanup` waits for a stopped fix agent to end. */
const FIX_STOP_WAIT_MS = 15_000;

/** A helper's refusal in one line: its last line on stderr, or why it did
 * not finish. */
function helperRefusal(command: string, run: AutofixPrRun): string {
  // The CLI prints a helper's error with its stack: the reason is the line
  // that names the error — the last such, as what `gh` or git printed
  // before the helper threw comes first.
  const lines = run.stderr.split('\n').map((line) => line.trim());
  const named = lines
    .filter((line) => /^(?:[A-Z]\w*)?Error: /.test(line))
    .pop()
    ?.replace(/^(?:[A-Z]\w*)?Error: /, '');
  const said = named ?? lines.filter(Boolean).pop();
  return `autofix-pr ${command} refused: ${said || run.failure || `exit ${run.exitCode}`}`;
}

function lastJsonLine(out: string): unknown {
  try {
    return JSON.parse(out.trim().split('\n').at(-1) ?? '');
  } catch {
    return undefined;
  }
}

class AutofixPrInvocation extends BaseToolInvocation<
  AutofixPrParams,
  ToolResult
> {
  /** The `unattended` dialog was answered with a proceed outcome. */
  private confirmed = false;
  /** The watch that dialog named; the grant is made for it alone. */
  private shownWatch: ConfirmedWatch | undefined;
  /** Found when the permission was: the call acts on a watch prepared here. */
  private watchConfirmed = false;
  /** Found when the permission was: the shell route's rules deny it. */
  private shellDenial: string | null = null;
  /** Found when the permission was: an ask rule of the shell route names it. */
  private shellAsks = false;
  /** Found when the permission was: the PR's own git hooks would run. */
  private prHooks = false;

  constructor(
    private readonly config: Config,
    params: AutofixPrParams,
  ) {
    super(params);
  }

  private get isUnattended(): boolean {
    return this.params.command === 'unattended';
  }

  /** `attended` only takes a grant away, so it runs nothing and asks nothing. */
  private get isAttended(): boolean {
    return this.params.command === 'attended';
  }

  private yolo(): boolean {
    return this.config.getApprovalMode() === ApprovalMode.YOLO;
  }

  getDescription(): string {
    return `autofix-pr ${autofixPrArgs(this.params).join(' ')}`;
  }

  /**
   * Why `unattended` cannot grant anything here, known before any dialog;
   * null when only the user's answer and the watch's status remain.
   */
  private unattendedBlocker(): string | null {
    if (this.yolo()) return null;
    if (this.config.getApprovalMode() === ApprovalMode.PLAN) {
      return 'plan mode changes nothing';
    }
    if (
      !this.config.isInteractive() &&
      this.config.getInputFormat?.() === 'stream-json'
    ) {
      // A program answers there; one that wants this runs in YOLO mode.
      return 'a stream-json host answers for no user';
    }
    if (this.config.getInputFile?.()) {
      return 'a program answers this session through --input-file';
    }
    if (!this.config.isTrustedFolder()) return 'this folder is not trusted';
    if (this.config.isSessionAgentSession?.() === true) {
      return 'a session-agents session always asks';
    }
    const watch = preparedWatch(this.config, this.params.pr!);
    if (!watch) {
      return `this session did not start or resume the watch of PR #${this.params.pr}`;
    }
    if (!watch.authorCanPush) {
      return `the author of PR #${this.params.pr} cannot push to the repository, so its code is never run unattended`;
    }
    return null;
  }

  /**
   * A rule that denies the shell route of this helper — `Bash`, or one
   * naming `qwen autofix-pr` — denies this call too: it runs the same
   * program, with the repository's git hooks.
   */
  private async asShell(): Promise<{ denial: string | null; asks: boolean }> {
    const pm = this.config.getPermissionManager?.();
    if (!pm) return { denial: null, asks: false };
    const command = `qwen ${this.getDescription()}`;
    const ctx = buildPermissionCheckContext(
      ToolNames.SHELL,
      { command },
      this.config.getTargetDir(),
    );
    const { finalPermission, pmForcedAsk } = await evaluatePermissionRules(
      pm,
      'ask',
      ctx,
    );
    return {
      denial:
        finalPermission === 'deny'
          ? `a permission rule denies \`${command}\` as a shell command, so the tool does not run it either`
          : null,
      // An ask rule for it there asks here too: no skill rule overrides it.
      asks: pmForcedAsk,
    };
  }

  override async getDefaultPermission(
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    if (this.isAttended) return 'allow';
    if (!this.isUnattended) {
      const shell = await this.asShell();
      this.shellDenial = shell.denial;
      this.shellAsks = shell.asks;
    }
    // Nothing to ask: execute() gives the refusal.
    if (this.shellDenial) return 'allow';
    if (this.params.command === 'status') return 'allow';
    // Nothing to ask: YOLO needs no grant, and a refusal needs no answer.
    if (this.isUnattended && (this.yolo() || this.unattendedBlocker())) {
      return 'allow';
    }
    const mode = this.config.getApprovalMode();
    if (
      WATCH_COMMANDS.has(this.params.command) &&
      this.params.take_over !== true &&
      !this.shellAsks &&
      // YOLO asks nothing, and plan mode runs no helper: nothing to find.
      mode !== ApprovalMode.YOLO &&
      mode !== ApprovalMode.PLAN
    ) {
      const found = await stillPrepared(
        this.config,
        this.params.command,
        this.params.pr!,
        signal ?? new AbortController().signal,
      );
      this.watchConfirmed = found === 'confirmed';
      this.prHooks = found === 'hooks';
    }
    return 'ask';
  }

  /**
   * `unattended` is confirmed by the user whenever it could grant anything:
   * no rule, no classifier and no host decision stands in for that answer.
   */
  override requiresUserInteraction(): boolean {
    // An ask rule for the shell route asks here too, past any allow rule
    // for the tool and the auto-mode classifier; YOLO ignores ask rules,
    // as it does for the shell.
    if (this.shellAsks && !this.yolo()) return true;
    // A start lets the watch's rounds push and reply without asking, so in
    // auto mode the classifier does not stand in for the user there — where
    // a user can answer: a headless run keeps its rules, as in default mode.
    if (
      this.params.command === 'prepare' &&
      this.config.getApprovalMode() === ApprovalMode.AUTO &&
      resolveInteractionMode(this.config) !== 'headless'
    ) {
      return true;
    }
    return this.isUnattended && !this.yolo() && !this.unattendedBlocker();
  }

  getPermissionMatchParams(): Record<string, unknown> {
    return {
      ...this.params,
      watch: autofixPrWatchMatch(this.params, this.watchConfirmed),
    };
  }

  override async getConfirmationDetails(): Promise<ToolCallConfirmationDetails> {
    if (this.isUnattended) {
      const pr = this.params.pr!;
      const watch = preparedWatch(this.config, pr);
      this.shownWatch = watch;
      const which = watch
        ? `${watch.repo}#${pr}, worktree ${watch.worktree}`
        : `PR #${pr}`;
      const details: ToolInfoConfirmationDetails = {
        type: 'info',
        title: `Let the fixes of PR #${pr} run without asking`,
        prompt: [
          `Every command the fix agent of this session's watch of ${which} runs — builds, tests, commits — runs without asking, until the watch ends or this session does.`,
          'The agent runs as an agent of a YOLO session would: with your git and gh credentials, able to reach files outside the worktree, past your ask rules; deny rules still apply.',
          'Only for a PR by you or a collaborator. Declined, each command asks first.',
        ].join('\n\n'),
        renderPromptAsPlainText: true,
        hideAlwaysAllow: true,
        // Nothing to save: no rule may stand in for this answer.
        permissionRules: [],
        onConfirm: async (outcome: ToolConfirmationOutcome) => {
          if (String(outcome).startsWith('proceed_')) this.confirmed = true;
        },
      };
      return details;
    }
    const watch = autofixPrWatchMatch(this.params, this.watchConfirmed);
    // A start, a new schedule, a take-over and a helper of a watch not
    // started here are asked each time: a saved rule would let any later
    // one through.
    const askedEachTime =
      this.shellAsks ||
      this.params.command === 'prepare' ||
      this.params.command === 'schedule' ||
      watch === 'take-over' ||
      watch === 'unconfirmed';
    const details: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: `Run autofix-pr ${this.params.command}`,
      command: `qwen ${this.getDescription()}`,
      rootCommand: 'autofix-pr',
      permissionRules: [
        `${ToolDisplayNames.AUTOFIX_PR}(command:${this.params.command}${watch === 'none' ? '' : `,watch:${watch}`})`,
      ],
      ...(askedEachTime
        ? {
            hideAlwaysAllow: true,
            warnings: [this.startsWatchWarning(watch)],
          }
        : {}),
      onConfirm: async () => {},
    };
    return details;
  }

  private startsWatchWarning(watch: AutofixPrWatchMatch): string {
    const pr = this.params.pr;
    if (this.shellAsks) {
      return `An ask rule for \`qwen ${this.getDescription()}\` as a shell command asks for it here too.`;
    }
    if (this.params.command === 'prepare') {
      if (this.params.in_place) {
        return `Starts an in-place watch of PR #${pr}: the fix agent works in your own checkout of the PR branch, in the foreground; the round pushes what the branch holds — your commits included — and replies on the PR.`;
      }
      return this.params.take_over
        ? `Takes the watch of PR #${pr} over from any other session that holds it: from now on its rounds push to the PR branch and reply on the PR without asking.`
        : `Starts or resumes this session's watch of PR #${pr}: from now on its rounds push to the PR branch and reply on the PR without asking.`;
    }
    if (this.params.command === 'cleanup' && this.params.take_over) {
      return `Stops the watch of PR #${pr}, taking it from any other session that holds it.`;
    }
    if (this.params.command === 'schedule' && watch === 'confirmed') {
      return `Records the scheduled task of the watch of PR #${pr}, replacing any it has.`;
    }
    if (this.prHooks) {
      return `${this.params.command} runs git hooks that may run what the PR's tree holds (a hooks path inside the worktree, or a hook that reads its config there), so it asks unless the watch's fixes run without asking.`;
    }
    return `PR #${pr} is not a watch this session started or resumed.`;
  }

  /**
   * `status` as the helper printed it, each watch with `preparedHere`:
   * whether this session prepared it through the tool, from this clone, so
   * a round's helpers run on it without asking — and `unattended`: whether
   * its fixes run without asking too, and so in the background.
   */
  private annotateStatus(out: string): string {
    const parsed = lastJsonLine(out) as { watches?: unknown } | undefined;
    if (!parsed || !Array.isArray(parsed.watches)) return out;
    for (const watch of parsed.watches as Array<Record<string, unknown>>) {
      if (watch === null || typeof watch !== 'object') continue;
      const prepared =
        typeof watch['pr'] === 'number'
          ? preparedWatch(this.config, watch['pr'])
          : undefined;
      const here = prepared !== undefined && listsPrepared(prepared, watch);
      watch['preparedHere'] = here;
      // Its fix agent runs without asking, so in the background.
      watch['unattended'] =
        here &&
        unattendedFixGranted(this.config.getSessionId(), prepared.worktree);
    }
    return JSON.stringify(parsed);
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    if (this.isUnattended) return this.grant(signal);
    if (this.isAttended) {
      revokeUnattendedFixes(this.config.getSessionId(), this.params.pr!);
      const message = `The fix agent of PR #${this.params.pr} asks before its commands, as the approval mode says.`;
      return { llmContent: message, returnDisplay: message };
    }
    const denial = this.shellDenial ?? (await this.asShell()).denial;
    if (denial) {
      return {
        llmContent: denial,
        returnDisplay: denial,
        error: { message: denial, type: ToolErrorType.EXECUTION_DENIED },
      };
    }
    if (
      this.params.command !== 'status' &&
      this.config.getApprovalMode() === ApprovalMode.PLAN
    ) {
      // A rule lets a round's helpers through without the dialog plan mode
      // would block, and each of them writes somewhere.
      const message = `autofix-pr ${this.params.command} changes the PR or the worktree: not in plan mode.`;
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: ToolErrorType.EXECUTION_DENIED },
      };
    }
    const sessionId = this.config.getSessionId();
    if (this.params.pr !== undefined && this.params.command !== 'status') {
      await settleBackgroundFix({ pr: this.params.pr });
    }
    // By the PR: the session's directory may be a linked worktree of the
    // clone, whose helpers keep the watch beside its main one.
    const fix =
      this.params.pr === undefined || this.params.command === 'status'
        ? undefined
        : backgroundFixOf(sessionId, this.params.pr);
    if (this.params.command === 'fix-end') return this.claim(fix, signal);
    if (fix && this.params.command === 'cleanup') {
      const refused = await this.stopFix(fix, signal);
      if (refused) return refused;
    } else if (fix && !fix.ended) {
      // Its agent works in the worktree: whatever the marker says.
      const message = `A fix agent of PR #${this.params.pr} is working in its worktree (attempt ${fix.attempt}); its round goes on from its completion notification. Nothing but status runs meanwhile.`;
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: ToolErrorType.EXECUTION_DENIED },
      };
    }
    const misplaced = this.misplacedPlan();
    if (misplaced) {
      return {
        llmContent: misplaced,
        returnDisplay: misplaced,
        error: { message: misplaced, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }
    const run = await runAutofixPrHelper(
      this.config,
      autofixPrArgs(this.params),
      signal,
    );
    const out =
      run.stdout.trim() +
      (run.truncated
        ? `\n[autofix-pr ${this.params.command}: output cut at ${OUTPUT_CAP_BYTES / (1024 * 1024)} MiB]`
        : '');
    if (run.failure || run.exitCode !== 0) {
      const why =
        run.failure ??
        (run.exitCode === null ? 'killed' : `exit ${run.exitCode}`);
      const message = [
        `autofix-pr ${this.params.command} refused (${why}).`,
        run.stderr.trim(),
        out,
      ]
        .filter(Boolean)
        .join('\n');
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: ToolErrorType.EXECUTION_FAILED },
      };
    }
    if (this.params.command === 'prepare') this.recordPrepared(sessionId, out);
    if (this.params.command === 'schedule') this.recordTask(sessionId, out);
    if (this.params.command === 'status' && !run.truncated) {
      const annotated = this.annotateStatus(out);
      return { llmContent: annotated, returnDisplay: annotated };
    }
    if (this.params.command === 'cleanup') {
      forgetConfirmedWatch(sessionId, this.params.pr!);
    }
    return { llmContent: out, returnDisplay: out };
  }

  /**
   * The round claims its background fix's attempt: the agent has ended, and
   * this session holds the attempt. The report adds how the agent ended and
   * what it said, from memory, to what `fix-end` printed.
   */
  private async claim(
    fix: BackgroundFix | undefined,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const pr = this.params.pr!;
    const refuse = (message: string): ToolResult => ({
      llmContent: message,
      returnDisplay: message,
      error: { message, type: ToolErrorType.EXECUTION_DENIED },
    });
    if (!fix || fix.attempt !== this.params.attempt) {
      return refuse(
        `Attempt ${this.params.attempt} of PR #${pr} is not this session's to claim: it was dropped, or a round discarded it.`,
      );
    }
    if (!fix.ended) {
      return refuse(
        `The fix agent of PR #${pr} is still working; its round goes on from its completion notification.`,
      );
    }
    // A stopped agent ends when its grace runs out; what its tools were
    // doing gets a little longer to settle before the round acts.
    await fix.waitSettled(FIX_STOP_WAIT_MS);
    const ended = fix.ended;
    // Under the task this session scheduled, whatever the turn copied.
    const run = await runAutofixPrHelper(
      this.config,
      autofixPrArgs({ ...this.params, task: fix.task.task }),
      signal,
    );
    // A refusal leaves the attempt to claim again (a helper busy with the
    // lock), until its deadline.
    if (run.failure || run.exitCode !== 0) {
      return refuse(helperRefusal('fix-end', run));
    }
    const printed = lastJsonLine(run.stdout);
    // Its round's snapshot is gone: no claim will ever take it, so it goes
    // stale now, for the next round to discard and redo.
    if (
      printed !== null &&
      typeof printed === 'object' &&
      (printed as { lostSnapshot?: unknown }).lostSnapshot === true
    ) {
      fix.drop();
      return refuse(
        `Attempt ${fix.attempt} of PR #${pr} has lost its round's snapshot: a later round discards and redoes the fix.`,
      );
    }
    fix.claim();
    // The watch's options as this session's `schedule` printed them: the
    // turn goes on with these, whatever the follow-up it read said.
    const { task, reply, instructions } = fix.task;
    const out = JSON.stringify({
      ...(printed !== null && typeof printed === 'object' ? printed : {}),
      agent: ended,
      watch: { task, reply, instructions },
    });
    return { llmContent: out, returnDisplay: out };
  }

  /**
   * `cleanup` of a PR whose fix runs in the background here: its agent is
   * stopped, with no notification, and its attempt ended before anything is
   * removed — once its body settled, or at most `FIX_STOP_WAIT_MS` after the
   * stop, as a stopped agent's grace runs out.
   */
  private async stopFix(
    fix: BackgroundFix,
    signal: AbortSignal,
  ): Promise<ToolResult | null> {
    const refuse = (message: string): ToolResult => ({
      llmContent: message,
      returnDisplay: message,
      error: { message, type: ToolErrorType.EXECUTION_FAILED },
    });
    if (!fix.ended) {
      if (fix.agentId === null) {
        // Stopped as it launches, with no round to go on: as below, with no
        // notification.
        await fix.abandon({ notify: false });
        return refuse(
          `The fix agent of PR #${this.params.pr} was starting; it stops as it launches: run cleanup again.`,
        );
      }
      this.config
        .getBackgroundTaskRegistry()
        .cancel(fix.agentId, { notify: false });
    }
    // Ended need not be settled: a stopped agent's grace may have run out.
    await fix.waitSettled(FIX_STOP_WAIT_MS);
    fix.end({ status: 'cancelled', report: '' });
    // The marker goes before the watch: `cleanup` refuses a fresh one. A
    // refusal keeps the attempt, refreshed, for the next stop.
    const run = await runAutofixPrHelper(
      this.config,
      [
        'fix-end',
        String(this.params.pr),
        `--attempt=${fix.attempt}`,
        '--abandon',
      ],
      signal,
    );
    if (run.failure || run.exitCode !== 0) {
      return refuse(helperRefusal('fix-end', run));
    }
    fix.claim();
    return null;
  }

  /** The watch's task as `schedule` printed it: a background fix's round
   * goes on with these options, whatever the state file says later. */
  private recordTask(sessionId: string, out: string): void {
    const printed = lastJsonLine(out) as
      | { task?: unknown; reply?: unknown; instructions?: unknown }
      | undefined;
    if (
      typeof printed?.task === 'string' &&
      typeof printed.reply === 'boolean' &&
      typeof printed.instructions === 'string'
    ) {
      recordWatchTask(sessionId, this.params.pr!, {
        task: printed.task,
        reply: printed.reply,
        instructions: printed.instructions,
      });
    }
  }

  /**
   * For a watch this session prepared, the plan must sit in the watch's
   * `.qwen/tmp`, as the skill writes it; null when it does. A worktree
   * watch's tmp is the worktree's parent; an in-place watch's worktree IS
   * the user's checkout, so its tmp is inside it.
   */
  private misplacedPlan(): string | null {
    if (this.params.plan === undefined) return null;
    const pr = this.params.pr!;
    const watch = preparedWatch(this.config, pr);
    if (!watch) return null;
    const planDir = watch.inPlace
      ? path.join(watch.worktree, '.qwen', 'tmp')
      : path.dirname(watch.worktree);
    const expected = path.join(planDir, `autofix-pr-${pr}-plan.json`);
    const given = path.join(
      canonicalWorktreePath(path.dirname(this.params.plan)),
      path.basename(this.params.plan),
    );
    return given === expected
      ? null
      : `"plan" must be ${expected}, the reply plan beside the worktree of PR #${pr}.`;
  }

  /**
   * Records the watch `prepare` just reported, its author's right to push
   * as GitHub gave it moments ago. A grant for the PR survives only a
   * prepare that reports the watch it was made for: one recreated, taken
   * from another session, or of another repository asks again.
   */
  private recordPrepared(sessionId: string, out: string): void {
    const pr = this.params.pr!;
    const reported = lastJsonLine(out) as PreparedLike | undefined;
    if (!reported || typeof reported.worktreePath !== 'string') {
      forgetConfirmedWatch(sessionId, pr);
      return;
    }
    const before = preparedWatch(this.config, pr);
    const preparedAt =
      typeof reported.preparedAt === 'string' ? reported.preparedAt : null;
    if (
      !before ||
      reported.tookOver === true ||
      before.preparedAt !== preparedAt ||
      before.repo.toLowerCase() !== this.params.repo!.toLowerCase() ||
      before.worktree !== canonicalWorktreePath(reported.worktreePath) ||
      before.authorCanPush !== (reported.authorCanPush === true)
    ) {
      revokeUnattendedFixes(sessionId, pr);
    }
    recordConfirmedWatch(sessionId, {
      pr,
      repo: this.params.repo!,
      host: typeof reported.host === 'string' ? reported.host : null,
      targetDir: this.config.getTargetDir(),
      preparedAt,
      worktree: canonicalWorktreePath(reported.worktreePath),
      inPlace: reported.inPlace === true,
      authorCanPush: reported.authorCanPush === true,
    });
  }

  private async grant(signal: AbortSignal): Promise<ToolResult> {
    const pr = this.params.pr!;
    const refuse = (reason: string): ToolResult => {
      const message = `Fixes of PR #${pr} keep asking: ${reason}.`;
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: ToolErrorType.EXECUTION_DENIED },
      };
    };
    if (this.yolo()) {
      const message = `Nothing recorded: YOLO mode already runs every command without asking.`;
      return { llmContent: message, returnDisplay: message };
    }
    const blocker = this.unattendedBlocker();
    if (blocker) return refuse(blocker);
    if (!this.confirmed) return refuse('the user did not confirm it');
    if (
      this.shownWatch === undefined ||
      preparedWatch(this.config, pr) !== this.shownWatch
    ) {
      return refuse('the watch changed after the dialog named it');
    }
    const checked = await checkUnattendedWatch(this.config, pr, signal);
    if ('refused' in checked) return refuse(checked.refused);
    const { worktree } = checked.watch;
    grantUnattendedFixes(this.config.getSessionId(), {
      pr,
      worktree,
      check: async (s) => {
        if (!this.config.isTrustedFolder()) return false;
        const again = await checkUnattendedWatch(this.config, pr, s);
        return !('refused' in again) && again.watch.worktree === worktree;
      },
      open: async (attempt, s) => {
        const run = await runAutofixPrHelper(
          this.config,
          ['fix-start', String(pr), `--attempt=${attempt}`],
          s,
        );
        const printed =
          run.failure || run.exitCode !== 0
            ? undefined
            : (lastJsonLine(run.stdout) as { task?: unknown } | undefined);
        if (typeof printed?.task !== 'string') {
          throw new Error(helperRefusal('fix-start', run));
        }
        return { task: printed.task };
      },
      close: async (attempt) => {
        await runAutofixPrHelper(
          this.config,
          ['fix-end', String(pr), `--attempt=${attempt}`, '--abandon'],
          new AbortController().signal,
        );
      },
    });
    const message = `The fix agent of PR #${pr} runs its commands without asking in ${worktree}, while this session runs the watch.`;
    return { llmContent: message, returnDisplay: message };
  }
}

export class AutofixPrTool extends BaseDeclarativeTool<
  AutofixPrParams,
  ToolResult
> {
  static readonly Name = ToolNames.AUTOFIX_PR;

  constructor(private readonly config: Config) {
    super(
      AutofixPrTool.Name,
      ToolDisplayNames.AUTOFIX_PR,
      [
        'Runs one `qwen autofix-pr` helper of the /autofix-pr skill and returns the JSON line it prints. Use it only as that skill says; outside it, never.',
        'A failed call is the helper refusing, with its message: report it, do not work around it. Run calls one at a time.',
        '`command: "unattended"` asks the user whether the fix agent of a watch this session runs may run its commands without asking; `command: "attended"` takes that back, asking nothing.',
      ].join(' '),
      Kind.Execute,
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            enum: [...AUTOFIX_PR_COMMANDS],
            description: 'The helper to run.',
          },
          pr: {
            type: 'integer',
            description: 'The pull request number (optional for status).',
          },
          repo: {
            type: 'string',
            description: '<owner>/<repo> (prepare, snapshot): --repo.',
          },
          host: {
            type: 'string',
            description: 'GitHub host (prepare, snapshot): --host.',
          },
          take_over: {
            type: 'boolean',
            description: '--take-over (prepare, cleanup).',
          },
          in_place: {
            type: 'boolean',
            description:
              "--in-place (prepare): fix in the user's own checkout of the PR head branch — attended, one round per start, nothing ever discarded.",
          },
          task: {
            type: 'string',
            description:
              "The round's task id (snapshot, ci-log, push, sync, reply, rerun): --task.",
          },
          run_id: {
            type: 'string',
            description: 'The workflow run id (ci-log, rerun).',
          },
          lines: {
            type: 'integer',
            description: 'ci-log --lines.',
          },
          plan: {
            type: 'string',
            description: 'Path of the reply plan (reply).',
          },
          no_post: {
            type: 'boolean',
            description: 'reply --no-post.',
          },
          discard: {
            type: 'boolean',
            description: 'sync --discard.',
          },
          every: {
            type: 'integer',
            description: 'schedule --every <minutes>.',
          },
          no_reply: {
            type: 'boolean',
            description: 'schedule --no-reply.',
          },
          instructions: {
            type: 'boolean',
            description: 'schedule --instructions.',
          },
          again: {
            type: 'boolean',
            description: 'schedule --again.',
          },
          attempt: {
            type: 'string',
            description:
              "The background fix's attempt, from its completion notification (fix-end): --attempt.",
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
      false, // isOutputMarkdown — a helper prints JSON
      false, // canUpdateOutput
      true, // shouldDefer — only the /autofix-pr skill calls it
      false, // alwaysLoad
      'autofix pr pull request watch helper push reply',
    );
  }

  protected override validateToolParamValues(
    params: AutofixPrParams,
  ): string | null {
    return validateAutofixPrParams(params);
  }

  protected createInvocation(
    params: AutofixPrParams,
  ): ToolInvocation<AutofixPrParams, ToolResult> {
    return new AutofixPrInvocation(this.config, params);
  }
}
