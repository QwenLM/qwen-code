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
import path from 'node:path';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/approval-mode.js';
import type { PermissionDecision } from '../permissions/types.js';
import { getShellContextEnvVars } from '../services/shellContextEnv.js';
import {
  ShellExecutionService,
  type ShellOutputEvent,
} from '../services/shellExecutionService.js';
import { getErrorMessage } from '../utils/errors.js';
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
  canonicalWorktreePath,
  confirmedWatch,
  forgetConfirmedWatch,
  grantUnattendedFixes,
  recordConfirmedWatch,
  revokeUnattendedFixes,
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
  'status',
  'cleanup',
  'unattended',
] as const;

export type AutofixPrCommand = (typeof AUTOFIX_PR_COMMANDS)[number];

export interface AutofixPrParams {
  command: AutofixPrCommand;
  pr?: number;
  repo?: string;
  host?: string;
  take_over?: boolean;
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
}

type OptionName = Exclude<keyof AutofixPrParams, 'command' | 'pr'>;

/** The options each command takes; any other is a refusal. */
const OPTIONS: Readonly<Record<AutofixPrCommand, readonly OptionName[]>> = {
  prepare: ['repo', 'host', 'take_over'],
  snapshot: ['repo', 'host', 'task'],
  'ci-log': ['run_id', 'lines', 'task'],
  push: ['task'],
  sync: ['discard', 'task'],
  reply: ['plan', 'no_post', 'task'],
  rerun: ['run_id', 'task'],
  schedule: ['every', 'no_reply', 'instructions', 'again'],
  status: [],
  cleanup: ['take_over'],
  unattended: [],
};

const REQUIRED: Partial<Record<AutofixPrCommand, readonly OptionName[]>> = {
  prepare: ['repo'],
  'ci-log': ['run_id'],
  reply: ['plan'],
  rerun: ['run_id'],
};

const BOOLEAN_OPTIONS = new Set<OptionName>([
  'take_over',
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
  run_id: /^\d{1,20}$/,
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
    !parts.includes(`autofix-pr-${pr}`)
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
        return `"plan" must be the reply plan the skill writes, .qwen/tmp/autofix-pr-${params.pr ?? '<pr>'}-plan.json beside the worktree.`;
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
  if (params.run_id !== undefined) args.push(params.run_id);
  if (params.plan !== undefined) args.push(params.plan);
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
  flag('take-over', params.take_over);
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
  'cleanup',
]);

/**
 * What rules match `command` against. A take-over is a command of its own
 * (`take-over prepare`, `take-over cleanup`), so no rule for `prepare` or
 * `cleanup` covers taking a watch from another session; and a helper of a
 * watch this session did not prepare through the tool is `unconfirmed
 * <command>`, so the skill's rules let through only the watches the user
 * started or resumed here.
 */
export function autofixPrRuleCommand(
  params: AutofixPrParams,
  watchConfirmed: boolean,
): string {
  if (params.take_over === true) return `take-over ${params.command}`;
  if (WATCH_COMMANDS.has(params.command) && !watchConfirmed) {
    return `unconfirmed ${params.command}`;
  }
  return params.command;
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

export interface AutofixPrRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Why it did not finish on its own: cancelled, timed out, or failed to start. */
  failure?: string;
}

// One helper at a time per directory: they share a lock, and one refused
// for it did nothing.
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
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
  return serialized(cwd, async () => {
    if (signal.aborted) {
      return { exitCode: null, stdout: '', stderr: '', failure: 'cancelled' };
    }
    const launch = resolveAutofixPrLaunch();
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
    let stderr = '';
    const onOutput = (event: ShellOutputEvent) => {
      if (event.type !== 'data' || typeof event.chunk !== 'string') return;
      if (event.stream === 'stderr') {
        stderr = (stderr + event.chunk).slice(-STDERR_CAP_CHARS);
        return;
      }
      if (stdoutBytes >= OUTPUT_CAP_BYTES) return;
      stdoutBytes += Buffer.byteLength(event.chunk, 'utf8');
      stdout += event.chunk;
    };
    try {
      const handle = await ShellExecutionService.executeLaunch(
        {
          executable: launch.executable,
          args: [...launch.args, 'autofix-pr', ...args],
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
      if (result.error) {
        return {
          exitCode: null,
          stdout,
          stderr,
          failure: `could not start: ${result.error.message}`,
        };
      }
      if (timeout.aborted) {
        return {
          exitCode: result.exitCode,
          stdout,
          stderr,
          failure: `timed out after ${timeoutMs / 60_000} minutes`,
        };
      }
      if (result.aborted) {
        return {
          exitCode: result.exitCode,
          stdout,
          stderr,
          failure: 'cancelled',
        };
      }
      return { exitCode: result.exitCode, stdout, stderr };
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

interface WatchStatusLike {
  pr?: unknown;
  repo?: unknown;
  host?: unknown;
  thisSession?: unknown;
  ended?: unknown;
  worktreePath?: unknown;
  worktreeExists?: unknown;
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
  const prepared = confirmedWatch(config.getSessionId(), pr);
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
  const run = await runAutofixPrHelper(config, ['status', String(pr)], signal);
  if (run.failure || run.exitCode !== 0) {
    return {
      refused: `\`autofix-pr status ${pr}\` failed: ${run.failure ?? (run.stderr.trim() || `exit ${run.exitCode}`)}`,
    };
  }
  const parsed = lastJsonLine(run.stdout) as { watches?: unknown } | undefined;
  if (!parsed || !Array.isArray(parsed.watches)) {
    return { refused: `\`autofix-pr status ${pr}\` printed no status` };
  }
  const watches = parsed.watches as WatchStatusLike[];
  const watch = watches.find(
    (w) =>
      w.pr === pr &&
      typeof w.repo === 'string' &&
      w.repo.toLowerCase() === prepared.repo.toLowerCase() &&
      (prepared.host === null ||
        (typeof w.host === 'string' &&
          w.host.toLowerCase() === prepared.host.toLowerCase())),
  );
  if (!watch) {
    return {
      refused: `PR #${pr} of ${prepared.repo} has no watch in this clone`,
    };
  }
  if (watch.thisSession !== true) {
    return { refused: `PR #${pr} is watched by another session` };
  }
  if (watch.ended !== null) {
    return { refused: `the watch of PR #${pr} was ended` };
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
  authorCanPush?: unknown;
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

  constructor(
    private readonly config: Config,
    params: AutofixPrParams,
  ) {
    super(params);
  }

  private get isUnattended(): boolean {
    return this.params.command === 'unattended';
  }

  private yolo(): boolean {
    return this.config.getApprovalMode() === ApprovalMode.YOLO;
  }

  getDescription(): string {
    return `autofix-pr ${autofixPrArgs(this.params).join(' ')}`;
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    if (this.params.command === 'status') return 'allow';
    if (this.isUnattended && this.yolo()) return 'allow';
    return 'ask';
  }

  /**
   * `unattended` is confirmed by the user in every mode but YOLO, where it
   * records nothing: no rule, no classifier and no host decision stands in
   * for that answer.
   */
  override requiresUserInteraction(): boolean {
    return this.isUnattended && !this.yolo();
  }

  private watchConfirmed(): boolean {
    return (
      this.params.pr !== undefined &&
      confirmedWatch(this.config.getSessionId(), this.params.pr) !== undefined
    );
  }

  getPermissionMatchParams(): Record<string, unknown> {
    return {
      ...this.params,
      command: autofixPrRuleCommand(this.params, this.watchConfirmed()),
    };
  }

  override async getConfirmationDetails(): Promise<ToolCallConfirmationDetails> {
    if (this.isUnattended) {
      const pr = this.params.pr!;
      const watch = confirmedWatch(this.config.getSessionId(), pr);
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
        onConfirm: async (outcome: ToolConfirmationOutcome) => {
          if (String(outcome).startsWith('proceed_')) this.confirmed = true;
        },
      };
      return details;
    }
    const ruleCommand = autofixPrRuleCommand(
      this.params,
      this.watchConfirmed(),
    );
    // A start, a take-over and a helper of a watch not started here are
    // asked each time: a saved rule would let any later one through.
    const startsWatch =
      this.params.command === 'prepare' || ruleCommand !== this.params.command;
    const details: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: `Run autofix-pr ${this.params.command}`,
      command: `qwen ${this.getDescription()}`,
      rootCommand: 'autofix-pr',
      permissionRules: [
        `${ToolDisplayNames.AUTOFIX_PR}(command:${ruleCommand})`,
      ],
      ...(startsWatch
        ? {
            hideAlwaysAllow: true,
            warnings: [
              this.params.command === 'prepare'
                ? `Starts or resumes this session's watch of PR #${this.params.pr}: from now on its rounds push to the PR branch and reply on the PR without asking.`
                : `PR #${this.params.pr} is not a watch this session started or resumed.`,
            ],
          }
        : {}),
      onConfirm: async () => {},
    };
    return details;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    if (this.isUnattended) return this.grant(signal);
    const run = await runAutofixPrHelper(
      this.config,
      autofixPrArgs(this.params),
      signal,
    );
    const out = run.stdout.trim();
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
    const sessionId = this.config.getSessionId();
    if (this.params.command === 'prepare') this.recordPrepared(sessionId, out);
    if (this.params.command === 'cleanup') {
      forgetConfirmedWatch(sessionId, this.params.pr!);
    }
    return { llmContent: out, returnDisplay: out };
  }

  /**
   * Records the watch `prepare` just reported, its author's right to push
   * as GitHub gave it moments ago; a grant made for an earlier start of the
   * PR ends, so this one asks again.
   */
  private recordPrepared(sessionId: string, out: string): void {
    const pr = this.params.pr!;
    revokeUnattendedFixes(sessionId, pr);
    const reported = lastJsonLine(out) as PreparedLike | undefined;
    if (!reported || typeof reported.worktreePath !== 'string') {
      forgetConfirmedWatch(sessionId, pr);
      return;
    }
    recordConfirmedWatch(sessionId, {
      pr,
      repo: this.params.repo!,
      host: this.params.host ?? null,
      worktree: canonicalWorktreePath(reported.worktreePath),
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
    if (!this.confirmed) return refuse('the user did not confirm it');
    if (
      !this.config.isInteractive() &&
      this.config.getInputFormat?.() === 'stream-json'
    ) {
      // A program answers there; one that wants this runs in YOLO mode.
      return refuse('a stream-json host answers for no user');
    }
    if (!this.config.isTrustedFolder()) {
      return refuse('this folder is not trusted');
    }
    if (this.config.isSessionAgentSession?.() === true) {
      return refuse('a session-agents session always asks');
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
        '`command: "unattended"` asks the user whether the fix agent of a watch this session runs may run its commands without asking.',
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

  override validateToolParams(params: AutofixPrParams): string | null {
    return validateAutofixPrParams(params);
  }

  protected createInvocation(
    params: AutofixPrParams,
  ): ToolInvocation<AutofixPrParams, ToolResult> {
    return new AutofixPrInvocation(this.config, params);
  }
}
