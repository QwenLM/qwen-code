/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/approval-mode.js';
import { matchesRule, parseRule } from '../permissions/rule-parser.js';
import {
  AutofixPrTool,
  autofixPrArgs,
  resolveAutofixPrLaunch,
  runAutofixPrHelper,
  validateAutofixPrParams,
  type AutofixPrParams,
} from './autofix-pr.js';
import {
  canonicalWorktreePath,
  confirmedWatch,
  hasUnattendedFixGrant,
  resetUnattendedFixGrantsForTests,
} from './autofix-pr-grants.js';
import { ToolConfirmationOutcome } from './tools.js';

// Stands in for the CLI: `prepare` reports FAKE_WORKTREE and
// FAKE_CAN_PUSH, `status` prints FAKE_STATUS, it refuses or hangs on
// request, and otherwise prints what it was started with.
const FAKE_CLI = `
const [, , sub, command, ...rest] = process.argv;
const mode = process.env.FAKE_AUTOFIX_MODE;
if (sub !== 'autofix-pr') { process.stderr.write('not autofix-pr'); process.exit(2); }
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'refuse') { process.stderr.write('another session watches PR #12\\n'); process.exit(1); }
else if (command === 'prepare') process.stdout.write(JSON.stringify({ worktreePath: process.env.FAKE_WORKTREE, authorCanPush: process.env.FAKE_CAN_PUSH === '1' }) + '\\n');
else if (command === 'status') process.stdout.write(process.env.FAKE_STATUS + '\\n');
else process.stdout.write(JSON.stringify({ command, rest, session: process.env.QWEN_CODE_SESSION_ID, cwd: process.cwd() }) + '\\n');
`;

let dir: string;
let worktree: string;
const signal = () => new AbortController().signal;

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): Config {
  return {
    getTargetDir: () => dir,
    getSessionId: () => 'session-a',
    getShellExecutionConfig: () => ({}),
    getApprovalMode: () => ApprovalMode.DEFAULT,
    isTrustedFolder: () => true,
    isSessionAgentSession: () => false,
    isInteractive: () => true,
    getInputFormat: () => 'text',
    ...overrides,
  } as unknown as Config;
}

function status(watch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    now: new Date().toISOString(),
    watches: [
      {
        pr: 12,
        repo: 'o/r',
        host: 'github.com',
        thisSession: true,
        ended: null,
        worktreePath: worktree,
        worktreeExists: true,
        ...watch,
      },
    ],
  });
}

function invocation(params: AutofixPrParams, config = makeConfig()) {
  return new AutofixPrTool(config).build(params);
}

/** Runs `prepare` for PR #12 of o/r through the tool, as a start does. */
async function prepare(config = makeConfig()) {
  const result = await invocation(
    { command: 'prepare', pr: 12, repo: 'o/r' },
    config,
  ).execute(signal());
  expect(result.error).toBeUndefined();
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-pr-')));
  worktree = path.join(dir, '.qwen', 'tmp', 'autofix-pr-12');
  fs.mkdirSync(worktree, { recursive: true });
  const cli = path.join(dir, 'fake-cli.mjs');
  fs.writeFileSync(cli, FAKE_CLI);
  vi.stubEnv('QWEN_CODE_CLI', cli);
  vi.stubEnv('FAKE_STATUS', status());
  vi.stubEnv('FAKE_WORKTREE', worktree);
  vi.stubEnv('FAKE_CAN_PUSH', '1');
  vi.stubEnv('FAKE_AUTOFIX_MODE', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetUnattendedFixGrantsForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('validateAutofixPrParams', () => {
  const plan = '/repo/.qwen/tmp/autofix-pr-1-plan.json';

  it.each<[AutofixPrParams, RegExp]>([
    [{ command: 'rm' as never, pr: 1 }, /must be one of/],
    [{ command: 'push' }, /needs "pr"/],
    [{ command: 'push', pr: 0 }, /positive integer/],
    [{ command: 'push', pr: 1, discard: true }, /does not take "discard"/],
    [{ command: 'status', task: 'abc' }, /takes no option but "pr"/],
    [{ command: 'prepare', pr: 1 }, /needs "repo"/],
    [{ command: 'reply', pr: 1 }, /needs "plan"/],
    [{ command: 'rerun', pr: 1 }, /needs "run_id"/],
    [{ command: 'push', pr: 1, task: '--force' }, /not a valid value/],
    [{ command: 'rerun', pr: 1, run_id: '12;rm' }, /not a valid value/],
    [{ command: 'prepare', pr: 1, repo: 'a/b c' }, /not a valid value/],
    [{ command: 'sync', pr: 1, discard: 'yes' as never }, /must be a boolean/],
    [{ command: 'schedule', pr: 1, every: 2.5 }, /positive integer/],
    // The plan is the one the skill writes beside the worktree, never a file
    // of another PR, a relative path, or one the PR's own tree carries.
    [
      { command: 'reply', pr: 1, plan: '--post' },
      /reply plan the skill writes/,
    ],
    [{ command: 'reply', pr: 2, plan }, /reply plan the skill writes/],
    [
      { command: 'reply', pr: 1, plan: '.qwen/tmp/autofix-pr-1-plan.json' },
      /reply plan the skill writes/,
    ],
    [
      {
        command: 'reply',
        pr: 1,
        plan: '/repo/.qwen/tmp/autofix-pr-1/.qwen/tmp/autofix-pr-1-plan.json',
      },
      /reply plan the skill writes/,
    ],
    [
      { command: 'reply', pr: 1, plan: '/home/me/.ssh/id_rsa' },
      /reply plan the skill writes/,
    ],
  ])('refuses %j', (params, error) => {
    expect(validateAutofixPrParams(params)).toMatch(error);
  });

  it('accepts what the skill runs', () => {
    for (const params of [
      { command: 'prepare', pr: 1, repo: 'o/r', host: 'github.com' },
      { command: 'snapshot', pr: 1, task: '0123456789ab' },
      { command: 'reply', pr: 1, plan, task: 't1' },
      { command: 'status' },
      { command: 'cleanup', pr: 1, take_over: true },
      { command: 'unattended', pr: 1 },
    ] as AutofixPrParams[]) {
      expect(validateAutofixPrParams(params)).toBeNull();
    }
  });
});

describe('autofixPrArgs', () => {
  it.each<[AutofixPrParams, string[]]>([
    [
      { command: 'prepare', pr: 5, repo: 'o/r', host: 'h.io', take_over: true },
      ['prepare', '5', '--repo=o/r', '--host=h.io', '--take-over'],
    ],
    [
      { command: 'ci-log', pr: 5, run_id: '99', lines: 300, task: 't1' },
      ['ci-log', '5', '99', '--lines=300', '--task=t1'],
    ],
    [
      {
        command: 'reply',
        pr: 5,
        plan: '/x/.qwen/tmp/autofix-pr-5-plan.json',
        no_post: true,
      },
      ['reply', '5', '/x/.qwen/tmp/autofix-pr-5-plan.json', '--no-post'],
    ],
    [
      { command: 'sync', pr: 5, discard: true, task: 't1' },
      ['sync', '5', '--task=t1', '--discard'],
    ],
    [
      {
        command: 'schedule',
        pr: 5,
        every: 5,
        no_reply: true,
        instructions: true,
      },
      ['schedule', '5', '--every=5', '--no-reply', '--instructions'],
    ],
    [{ command: 'schedule', pr: 5, again: true }, ['schedule', '5', '--again']],
    [{ command: 'sync', pr: 5, discard: false }, ['sync', '5']],
    [{ command: 'status' }, ['status']],
  ])('builds %j', (params, args) => {
    expect(autofixPrArgs(params)).toEqual(args);
  });
});

describe('permission rules', () => {
  const matches = (rule: string, params: AutofixPrParams) =>
    matchesRule(
      parseRule(rule),
      'autofix_pr',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      invocation(params).getPermissionMatchParams!(),
    );

  it('name one command of a watch this session prepared, and a take-over only as its own', async () => {
    const push: AutofixPrParams = { command: 'push', pr: 12 };
    // Not prepared here: no rule for `push` covers it.
    expect(matches('AutofixPr(command:push)', push)).toBe(false);
    expect(matches('AutofixPr(command:push*)', push)).toBe(false);
    await prepare();
    expect(matches('AutofixPr(command:push)', push)).toBe(true);
    expect(
      matches('autofix_pr(command:push)', { command: 'sync', pr: 12 }),
    ).toBe(false);
    const takeOver: AutofixPrParams = {
      command: 'cleanup',
      pr: 12,
      take_over: true,
    };
    expect(matches('AutofixPr(command:cleanup)', takeOver)).toBe(false);
    expect(matches('AutofixPr(command:cleanup*)', takeOver)).toBe(false);
    expect(matches('AutofixPr(command:take-over cleanup)', takeOver)).toBe(
      true,
    );
    expect(
      matches('AutofixPr(command:prepare*)', {
        command: 'prepare',
        pr: 12,
        repo: 'o/r',
        take_over: true,
      }),
    ).toBe(false);
  });

  it('asks for every command but status, offering a rule only for a helper of a watch prepared here', async () => {
    const push = () => invocation({ command: 'push', pr: 12, task: 't1' });
    expect(await push().getDefaultPermission()).toBe('ask');
    expect(push().requiresUserInteraction!()).toBe(false);
    expect(await push().getConfirmationDetails(signal())).toMatchObject({
      type: 'exec',
      command: 'qwen autofix-pr push 12 --task=t1',
      permissionRules: ['AutofixPr(command:unconfirmed push)'],
      hideAlwaysAllow: true,
    });
    await prepare();
    const confirmed = await push().getConfirmationDetails(signal());
    expect(confirmed).toMatchObject({
      permissionRules: ['AutofixPr(command:push)'],
    });
    expect(confirmed).not.toHaveProperty('hideAlwaysAllow');
    expect(await invocation({ command: 'status' }).getDefaultPermission()).toBe(
      'allow',
    );
  });

  it('asks for a start each time, saying what it lets through', async () => {
    const details = await invocation({
      command: 'prepare',
      pr: 12,
      repo: 'o/r',
    }).getConfirmationDetails(signal());
    expect(details).toMatchObject({ type: 'exec', hideAlwaysAllow: true });
    expect((details as { warnings?: string[] }).warnings?.join(' ')).toMatch(
      /push to the PR branch and reply on the PR without asking/,
    );
  });

  it('always asks the user for unattended, with no "always allow", except in YOLO mode', async () => {
    const asked = invocation({ command: 'unattended', pr: 12 });
    expect(asked.requiresUserInteraction!()).toBe(true);
    expect(await asked.getConfirmationDetails(signal())).toMatchObject({
      type: 'info',
      hideAlwaysAllow: true,
    });
    const yolo = invocation(
      { command: 'unattended', pr: 12 },
      makeConfig({ getApprovalMode: () => ApprovalMode.YOLO }),
    );
    expect(yolo.requiresUserInteraction!()).toBe(false);
    expect(await yolo.getDefaultPermission()).toBe('allow');
  });
});

describe('resolveAutofixPrLaunch', () => {
  const argv = ['/usr/bin/node', '/opt/qwen/dist/index.js'];

  it('runs a script entry through the interpreter, needing no execute bit', () => {
    const entry = path.join(dir, 'cli.js');
    fs.writeFileSync(entry, '', { mode: 0o644 });
    expect(resolveAutofixPrLaunch({ QWEN_CODE_CLI: entry }, argv)).toEqual({
      executable: process.execPath,
      args: [entry],
    });
  });

  it.skipIf(process.platform === 'win32')(
    'runs an executable entry directly',
    () => {
      const entry = path.join(dir, 'qwen');
      fs.writeFileSync(entry, '#!/bin/sh\n', { mode: 0o755 });
      expect(resolveAutofixPrLaunch({ QWEN_CODE_CLI: entry }, argv)).toEqual({
        executable: entry,
        args: [],
      });
    },
  );

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['relative', 'dist/index.js'],
    ['a .cmd shim', 'C:\\qwen\\qwen.cmd'],
    ['missing', '/nowhere/cli.js'],
  ])(
    'falls back to the entry this process started from when %s',
    (_, entry) => {
      expect(resolveAutofixPrLaunch({ QWEN_CODE_CLI: entry }, argv)).toEqual({
        executable: process.execPath,
        args: ['/opt/qwen/dist/index.js'],
      });
    },
  );

  it('refuses when there is nothing to run', () => {
    expect(() => resolveAutofixPrLaunch({}, ['/usr/bin/node'])).toThrow(
      /cannot find the Qwen Code CLI/,
    );
  });
});

describe('running a helper', () => {
  it("runs it in the session's directory under the session's id, without a shell", async () => {
    const result = await invocation({
      command: 'push',
      pr: 12,
      task: 't1',
    }).execute(signal());
    expect(result.error).toBeUndefined();
    expect(JSON.parse(String(result.llmContent))).toEqual({
      command: 'push',
      rest: ['12', '--task=t1'],
      session: 'session-a',
      cwd: dir,
    });
  });

  it("returns a refusal with the helper's message", async () => {
    vi.stubEnv('FAKE_AUTOFIX_MODE', 'refuse');
    const result = await invocation({ command: 'sync', pr: 12 }).execute(
      signal(),
    );
    expect(result.error?.message).toMatch(
      /autofix-pr sync refused \(exit 1\)\.\nanother session watches PR #12/,
    );
  });

  it('stops a helper that runs too long, and one the turn cancels', async () => {
    vi.stubEnv('FAKE_AUTOFIX_MODE', 'hang');
    const timedOut = await runAutofixPrHelper(
      makeConfig(),
      ['push', '12'],
      signal(),
      300,
    );
    expect(timedOut.failure).toMatch(/timed out/);
    const controller = new AbortController();
    const cancelled = runAutofixPrHelper(
      makeConfig(),
      ['push', '12'],
      controller.signal,
    );
    setTimeout(() => controller.abort(), 200);
    expect((await cancelled).failure).toBe('cancelled');
  }, 20_000);

  it('records the watch a prepare reported, and forgets it at cleanup', async () => {
    await prepare();
    expect(confirmedWatch('session-a', 12)).toEqual({
      pr: 12,
      repo: 'o/r',
      host: null,
      worktree,
      authorCanPush: true,
    });
    expect(confirmedWatch('session-b', 12)).toBeUndefined();
    await invocation({ command: 'cleanup', pr: 12 }).execute(signal());
    expect(confirmedWatch('session-a', 12)).toBeUndefined();
  });

  it('records nothing from a refused prepare', async () => {
    vi.stubEnv('FAKE_AUTOFIX_MODE', 'refuse');
    await invocation(
      { command: 'prepare', pr: 12, repo: 'o/r' },
      makeConfig(),
    ).execute(signal());
    expect(confirmedWatch('session-a', 12)).toBeUndefined();
  });
});

describe('unattended', () => {
  const confirmAndRun = async (
    config = makeConfig(),
    outcome = ToolConfirmationOutcome.ProceedOnce,
  ) => {
    const inv = invocation({ command: 'unattended', pr: 12 }, config);
    const details = await inv.getConfirmationDetails(signal());
    await details.onConfirm(outcome);
    return inv.execute(signal());
  };
  const granted = (sessionId = 'session-a', at = worktree) =>
    hasUnattendedFixGrant(sessionId, at, signal());

  it("grants the prepared watch's worktree once the user confirms, checked again at launch", async () => {
    await prepare();
    const result = await confirmAndRun();
    expect(result.error).toBeUndefined();
    expect(await granted()).toBe(true);
    expect(await granted('session-b')).toBe(false);
    // Taken over meanwhile: the next launch asks, and so do the ones after.
    vi.stubEnv('FAKE_STATUS', status({ thisSession: false }));
    expect(await granted()).toBe(false);
    vi.stubEnv('FAKE_STATUS', status());
    expect(await granted()).toBe(false);
  });

  it('names the watch it grants in the dialog', async () => {
    await prepare();
    const details = await invocation({
      command: 'unattended',
      pr: 12,
    }).getConfirmationDetails(signal());
    expect((details as { prompt: string }).prompt).toContain(
      `o/r#12, worktree ${worktree}`,
    );
  });

  it('matches the worktree by its real path', async () => {
    await prepare();
    await confirmAndRun();
    const link = path.join(dir, 'link');
    fs.symlinkSync(worktree, link, 'dir');
    expect(await granted('session-a', link)).toBe(true);
    expect(canonicalWorktreePath(link)).toBe(worktree);
  });

  it('ends with a later prepare of the PR, which asks again, and with its cleanup', async () => {
    await prepare();
    await confirmAndRun();
    await prepare();
    expect(await granted()).toBe(false);
    await confirmAndRun();
    await invocation({ command: 'cleanup', pr: 12 }).execute(signal());
    expect(await granted()).toBe(false);
  });

  it('ends when the folder stops being trusted', async () => {
    let trusted = true;
    const config = makeConfig({ isTrustedFolder: () => trusted });
    await prepare(config);
    await confirmAndRun(config);
    trusted = false;
    expect(await granted()).toBe(false);
  });

  it('refuses a watch this session did not prepare, whatever its state file says', async () => {
    const result = await confirmAndRun();
    expect(result.error?.message).toMatch(/did not start or resume/);
    expect(await granted()).toBe(false);
  });

  it('refuses when GitHub said at prepare that the author cannot push', async () => {
    vi.stubEnv('FAKE_CAN_PUSH', '0');
    await prepare();
    const result = await confirmAndRun();
    expect(result.error?.message).toMatch(/cannot push/);
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['another session owns it', { thisSession: false }, /another session/],
    ['it was ended', { ended: { at: 'x', reason: 'stop' } }, /was ended/],
    ['its worktree is gone', { worktreeExists: false }, /not the one prepared/],
    [
      'its worktree moved',
      { worktreePath: path.join(os.tmpdir(), 'elsewhere') },
      /not the one prepared/,
    ],
    ['it is another PR', { pr: 13 }, /has no watch/],
    ['it is a PR of another repository', { repo: 'fork/r' }, /has no watch/],
  ])('refuses when %s', async (_, watch, reason) => {
    await prepare();
    vi.stubEnv('FAKE_STATUS', status(watch));
    const result = await confirmAndRun();
    expect(result.error?.message).toMatch(reason);
    expect(await granted()).toBe(false);
  });

  it.each<[string, Config, ToolConfirmationOutcome, RegExp]>([
    [
      'the dialog was not confirmed',
      makeConfig(),
      ToolConfirmationOutcome.Cancel,
      /did not confirm/,
    ],
    [
      'the folder is not trusted',
      makeConfig({ isTrustedFolder: () => false }),
      ToolConfirmationOutcome.ProceedOnce,
      /not trusted/,
    ],
    [
      'the session is a session-agents session',
      makeConfig({ isSessionAgentSession: () => true }),
      ToolConfirmationOutcome.ProceedOnce,
      /always asks/,
    ],
    [
      'a stream-json host answered',
      makeConfig({
        isInteractive: () => false,
        getInputFormat: () => 'stream-json',
      }),
      ToolConfirmationOutcome.ProceedOnce,
      /stream-json host/,
    ],
  ])('refuses when %s', async (_, config, outcome, reason) => {
    await prepare();
    const result = await confirmAndRun(config, outcome);
    expect(result.error?.message).toMatch(reason);
    expect(await granted()).toBe(false);
  });

  it('refuses without a dialog, as when a rule or the classifier allowed it', async () => {
    await prepare();
    const result = await invocation({ command: 'unattended', pr: 12 }).execute(
      signal(),
    );
    expect(result.error?.message).toMatch(/did not confirm/);
  });

  it('records nothing in YOLO mode', async () => {
    await prepare();
    const result = await invocation(
      { command: 'unattended', pr: 12 },
      makeConfig({ getApprovalMode: () => ApprovalMode.YOLO }),
    ).execute(signal());
    expect(result.error).toBeUndefined();
    expect(String(result.llmContent)).toMatch(/Nothing recorded/);
    expect(await granted()).toBe(false);
  });
});
