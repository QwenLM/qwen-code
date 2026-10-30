/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/approval-mode.js';
import { matchesRule, parseRule } from '../permissions/rule-parser.js';
import { PermissionManager } from '../permissions/permission-manager.js';
import { evaluatePermissionFlow } from '../core/permissionFlow.js';
import {
  AutofixPrTool,
  autofixPrArgs,
  resetAutofixPrLaunchForTests,
  resolveAutofixPrLaunch,
  runAutofixPrHelper,
  validateAutofixPrParams,
  type AutofixPrParams,
} from './autofix-pr.js';
import {
  backgroundFixHolding,
  backgroundFixOf,
  canonicalWorktreePath,
  settleBackgroundFix,
  confirmedWatch,
  FIX_CLAIM_DEADLINE_MS,
  FIX_HEARTBEAT_MS,
  FIX_TIME_LIMIT_MS,
  forgetAutofixPrSession,
  hasUnattendedFixGrant,
  isUnattendedFixConfig,
  markUnattendedFixConfig,
  BackgroundFix,
  openBackgroundFix,
  resetUnattendedFixGrantsForTests,
  watchTask,
} from './autofix-pr-grants.js';
import { ToolConfirmationOutcome } from './tools.js';

// Stands in for the CLI: `prepare` reports FAKE_WORKTREE and
// FAKE_CAN_PUSH, `status` prints FAKE_STATUS, it refuses or hangs on
// request, and otherwise prints what it was started with.
const FAKE_CLI = `
const [, , sub, command, ...rest] = process.argv;
const mode = process.env.FAKE_AUTOFIX_MODE;
if (process.env.FAKE_LOG) require('node:fs').appendFileSync(process.env.FAKE_LOG, [command, ...rest].join(' ') + '\\n');
if (sub !== 'autofix-pr') { process.stderr.write('not autofix-pr'); process.exit(2); }
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'refuse') { process.stderr.write('another session watches PR #12\\n'); process.exit(1); }
else if (mode === 'lost' && command === 'fix-end') { process.stdout.write(JSON.stringify({ attempt: 'x', lostSnapshot: true }) + '\\n'); }
else if (mode === 'refuse-stack') { process.stderr.write('Error: gh said something first\\nAn unexpected critical error occurred:\\nError: no round of PR #12 has a fix to start\\n    at runFixStart (fix.js:1:1)\\n    at handler (fix.js:2:2)\\n'); process.exit(1); }
else if (command === 'prepare') process.stdout.write(JSON.stringify({ worktreePath: process.env.FAKE_WORKTREE, preparedAt: process.env.FAKE_PREPARED_AT, host: process.env.FAKE_HOST || undefined, authorCanPush: process.env.FAKE_CAN_PUSH === '1', tookOver: process.env.FAKE_TOOK_OVER === '1' }) + '\\n');
else if (command === 'status') process.stdout.write(process.env.FAKE_STATUS + '\\n');
else if (command === 'fix-start') process.stdout.write(JSON.stringify({ attempt: (rest.find((a) => a.startsWith('--attempt=')) || '').slice(10), task: process.env.FAKE_TASK || 'feedc0ffee12' }) + '\\n');
else if (command === 'fix-end') process.stdout.write(JSON.stringify({ attempt: (rest.find((a) => a.startsWith('--attempt=')) || '').slice(10), snapshot: 'snap.json', brief: 'brief.md', head: 'abc' }) + '\\n');
else if (command === 'schedule') process.stdout.write(JSON.stringify({ task: process.env.FAKE_TASK || 'feedc0ffee12', reply: process.env.FAKE_REPLY !== '0', instructions: process.env.FAKE_INSTRUCTIONS || '' }) + '\\n');
else process.stdout.write(JSON.stringify({ command, rest, session: process.env.QWEN_CODE_SESSION_ID, cwd: process.cwd() }) + '\\n');
`;

const PREPARED_AT = '2026-10-25T10:00:00.000Z';
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
    getExperimentalZedIntegration: () => false,
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
        preparedAt: PREPARED_AT,
        thisSession: true,
        ended: null,
        worktreePath: worktree,
        worktreeExists: true,
        gitTrusted: true,
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
  // A repository of its own, with git's sample hooks only, and none of this
  // machine's global settings.
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  execFileSync('git', ['init', '-q', worktree], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  const cli = path.join(dir, 'fake-cli.cjs');
  fs.writeFileSync(cli, FAKE_CLI);
  vi.stubEnv('QWEN_CODE_CLI', cli);
  resetAutofixPrLaunchForTests();
  vi.stubEnv('FAKE_STATUS', status());
  vi.stubEnv('FAKE_WORKTREE', worktree);
  vi.stubEnv('FAKE_CAN_PUSH', '1');
  vi.stubEnv('FAKE_PREPARED_AT', PREPARED_AT);
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
    [
      {
        command: 'reply',
        pr: 1,
        plan: '/repo/.qwen/tmp/AUTOFIX-PR-1/.qwen/tmp/autofix-pr-1-plan.json',
      },
      /reply plan the skill writes/,
    ],
  ])('refuses %j', (params, error) => {
    expect(validateAutofixPrParams(params)).toMatch(error);
  });

  it('ignores a boolean option left false, whichever command it is', () => {
    expect(
      validateAutofixPrParams({ command: 'push', pr: 1, take_over: false }),
    ).toBeNull();
    expect(
      validateAutofixPrParams({ command: 'push', pr: 1, take_over: true }),
    ).toMatch(/does not take "take_over"/);
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

  it('never passes a positional the helper would read as an option, validated or not', () => {
    for (const params of [
      { command: 'rerun', pr: 5, run_id: '--force' },
      { command: 'reply', pr: 5, plan: '--force' },
      { command: 'cleanup', pr: 5, plan: '-f' },
    ] as AutofixPrParams[]) {
      expect(validateAutofixPrParams(params)).not.toBeNull();
      expect(() => autofixPrArgs(params)).toThrow(/would read as an option/);
    }
  });
});

describe('permission rules', () => {
  /** The params rules see, once the permission check ran. */
  const presented = async (params: AutofixPrParams, config = makeConfig()) => {
    const inv = invocation(params, config);
    await inv.getDefaultPermission(signal());
    return inv.getPermissionMatchParams!();
  };
  const matches = async (
    rule: string,
    params: AutofixPrParams,
    config = makeConfig(),
  ) =>
    matchesRule(
      parseRule(rule),
      'autofix_pr',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      await presented(params, config),
    );
  const confirmedPush = 'AutofixPr(command:push,watch:confirmed)';
  const confirmAndRunHere = async () => {
    const inv = invocation({ command: 'unattended', pr: 12 });
    await (
      await inv.getConfirmationDetails(signal())
    ).onConfirm(ToolConfirmationOutcome.ProceedOnce);
    expect((await inv.execute(signal())).error).toBeUndefined();
  };

  it('let a rule name the helpers of a watch this session prepared, and a take-over only as its own', async () => {
    const push: AutofixPrParams = { command: 'push', pr: 12 };
    // Not prepared here: the skill's rule does not cover it.
    expect(await matches(confirmedPush, push)).toBe(false);
    await prepare();
    expect(await matches(confirmedPush, push)).toBe(true);
    expect(
      await matches('AutofixPr(command:push,watch:confirmed)', {
        command: 'sync',
        pr: 12,
      }),
    ).toBe(false);
    const takeOver: AutofixPrParams = {
      command: 'cleanup',
      pr: 12,
      take_over: true,
    };
    expect(
      await matches('AutofixPr(command:cleanup,watch:confirmed)', takeOver),
    ).toBe(false);
    expect(
      await matches('AutofixPr(command:cleanup,watch:take-over)', takeOver),
    ).toBe(true);
  });

  it('let a rule naming the command alone, a deny above all, cover every call of it', async () => {
    const deny = 'AutofixPr(command:push)';
    expect(await matches(deny, { command: 'push', pr: 12 })).toBe(true);
    await prepare();
    expect(await matches(deny, { command: 'push', pr: 12 })).toBe(true);
    expect(
      await matches('AutofixPr(command:prepare)', {
        command: 'prepare',
        pr: 12,
        repo: 'o/r',
        take_over: true,
      }),
    ).toBe(true);
  });

  it('treat a watch the state file moved to another host as unconfirmed', async () => {
    vi.stubEnv('FAKE_HOST', 'github.com');
    await prepare();
    const plan = '/x/.qwen/tmp/autofix-pr-12-plan.json';
    expect((await presented({ command: 'reply', pr: 12, plan }))['watch']).toBe(
      'confirmed',
    );
    vi.stubEnv('FAKE_STATUS', status({ host: 'ghe.corp' }));
    expect((await presented({ command: 'reply', pr: 12, plan }))['watch']).toBe(
      'unconfirmed',
    );
  });

  it('asks the user for a start in auto mode, whatever the classifier says, where a user can answer', async () => {
    const start = (mode: ApprovalMode, interactive = true) =>
      invocation(
        { command: 'prepare', pr: 12, repo: 'o/r' },
        makeConfig({
          getApprovalMode: () => mode,
          isInteractive: () => interactive,
          getExperimentalZedIntegration: () => false,
        }),
      ).requiresUserInteraction!();
    expect(start(ApprovalMode.AUTO)).toBe(true);
    expect(start(ApprovalMode.DEFAULT)).toBe(false);
    expect(start(ApprovalMode.YOLO)).toBe(false);
    // Headless: its rules decide, as in default mode.
    expect(start(ApprovalMode.AUTO, false)).toBe(false);
  });

  it('treat a prepared watch the state file now names otherwise as unconfirmed', async () => {
    await prepare();
    for (const watch of [
      { repo: 'fork/r' },
      { preparedAt: '2026-10-25T11:00:00.000Z' },
      { thisSession: false },
      { ended: { at: 'x', reason: 'stop' } },
      { worktreePath: path.join(os.tmpdir(), 'elsewhere') },
    ]) {
      vi.stubEnv('FAKE_STATUS', status(watch));
      expect(
        (
          await presented({
            command: 'reply',
            pr: 12,
            plan: '/x/.qwen/tmp/autofix-pr-12-plan.json',
          })
        )['watch'],
      ).toBe('unconfirmed');
    }
  });

  it('asks for a push, not for status, offering a rule only for a helper of a watch prepared here', async () => {
    const asked = async () => {
      const inv = invocation({ command: 'push', pr: 12, task: 't1' });
      const permission = await inv.getDefaultPermission(signal());
      return {
        permission,
        details: await inv.getConfirmationDetails(signal()),
      };
    };
    const before = await asked();
    expect(before.permission).toBe('ask');
    expect(before.details).toMatchObject({
      type: 'exec',
      command: 'qwen autofix-pr push 12 --task=t1',
      permissionRules: ['AutofixPr(command:push,watch:unconfirmed)'],
      hideAlwaysAllow: true,
    });
    await prepare();
    const after = (await asked()).details;
    expect(after).toMatchObject({ permissionRules: [confirmedPush] });
    expect(after).not.toHaveProperty('hideAlwaysAllow');
    expect(await invocation({ command: 'status' }).getDefaultPermission()).toBe(
      'allow',
    );
  });

  it('treats a watch prepared from another clone as unconfirmed after /cd', async () => {
    await prepare();
    const elsewhere = makeConfig({ getTargetDir: () => os.tmpdir() });
    expect(
      (await presented({ command: 'push', pr: 12 }, elsewhere))['watch'],
    ).toBe('unconfirmed');
  });

  it('checks ownership without the git scan, and not at all in YOLO or plan mode', async () => {
    await prepare();
    const log = path.join(dir, 'calls.log');
    vi.stubEnv('FAKE_LOG', log);
    await presented({ command: 'push', pr: 12 });
    expect(fs.readFileSync(log, 'utf8')).toContain('status 12 --no-work');
    fs.rmSync(log);
    for (const mode of [ApprovalMode.YOLO, ApprovalMode.PLAN]) {
      await presented(
        { command: 'push', pr: 12 },
        makeConfig({ getApprovalMode: () => mode }),
      );
    }
    expect(fs.existsSync(log)).toBe(false);
  });

  it("asks for a push or sync that would run the PR's own git hooks, unless its fixes run unattended", async () => {
    const repo = path.join(dir, 'clone');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', '.githooks']);
    vi.stubEnv('FAKE_WORKTREE', repo);
    vi.stubEnv('FAKE_STATUS', status({ worktreePath: repo }));
    await prepare();
    for (const command of ['push', 'sync'] as const) {
      expect((await presented({ command, pr: 12 }))['watch']).toBe(
        'unconfirmed',
      );
    }
    const plan = '/x/.qwen/tmp/autofix-pr-12-plan.json';
    expect((await presented({ command: 'reply', pr: 12, plan }))['watch']).toBe(
      'confirmed',
    );
    // Its dialog says why it asks.
    const push = invocation({ command: 'push', pr: 12 });
    await push.getDefaultPermission(signal());
    expect(
      (
        (await push.getConfirmationDetails(signal())) as { warnings?: string[] }
      ).warnings?.join(' '),
    ).toMatch(/runs git hooks that may run what the PR's tree holds/);
    await confirmAndRunHere();
    expect((await presented({ command: 'push', pr: 12 }))['watch']).toBe(
      'confirmed',
    );
    // A hooks directory outside the worktree with no hook a push or sync
    // runs asks nothing; one with a pre-push hook asks, as it may dispatch
    // to a config file in the tree.
    const hooks = path.join(dir, 'hooks');
    fs.mkdirSync(hooks);
    execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', hooks]);
    resetUnattendedFixGrantsForTests();
    await prepare();
    expect((await presented({ command: 'push', pr: 12 }))['watch']).toBe(
      'confirmed',
    );
    fs.writeFileSync(path.join(hooks, 'pre-push'), '#!/bin/sh\n', {
      mode: 0o755,
    });
    expect((await presented({ command: 'push', pr: 12 }))['watch']).toBe(
      'unconfirmed',
    );
    fs.rmSync(path.join(hooks, 'pre-push'));
    execFileSync('git', ['-C', repo, 'config', '--unset', 'core.hooksPath']);
    fs.writeFileSync(
      path.join(repo, '.git', 'hooks', 'post-merge'),
      '#!/bin/sh\n',
      {
        mode: 0o755,
      },
    );
    expect((await presented({ command: 'sync', pr: 12 }))['watch']).toBe(
      'unconfirmed',
    );
  });

  it('treats a watch whose worktree hands git a config the tree controls as unconfirmed', async () => {
    await prepare();
    vi.stubEnv('FAKE_STATUS', status({ gitTrusted: false }));
    expect((await presented({ command: 'sync', pr: 12 }))['watch']).toBe(
      'unconfirmed',
    );
  });

  it('asks, through the whole permission flow, where an ask rule names the shell command, past an allow rule for the tool', async () => {
    await prepare();
    const pm = new PermissionManager({
      getPermissionsAllow: () => ['AutofixPr(command:push)', 'AutofixPr'],
      getPermissionsAsk: () => ['Bash(qwen autofix-pr *)'],
      getPermissionsDeny: () => undefined,
      getProjectRoot: () => dir,
      getCwd: () => dir,
    });
    pm.initialize();
    for (const mode of [ApprovalMode.DEFAULT, ApprovalMode.AUTO]) {
      const config = makeConfig({
        getPermissionManager: () => pm,
        getApprovalMode: () => mode,
      });
      for (const params of [
        { command: 'push', pr: 12 },
        { command: 'status' },
      ] as AutofixPrParams[]) {
        const inv = invocation(params, config);
        const flow = await evaluatePermissionFlow(
          config,
          inv,
          'autofix_pr',
          params as unknown as Record<string, unknown>,
          signal(),
        );
        expect(flow.finalPermission).toBe('ask');
        expect(flow.requiresUserInteraction).toBe(true);
      }
    }
    // YOLO ignores ask rules, for the shell as here.
    const yolo = invocation(
      { command: 'push', pr: 12 },
      makeConfig({
        getPermissionManager: () => pm,
        getApprovalMode: () => ApprovalMode.YOLO,
      }),
    );
    await yolo.getDefaultPermission(signal());
    expect(yolo.requiresUserInteraction!()).toBe(false);
  });

  it('keeps asking where an ask rule names the shell command', async () => {
    await prepare();
    const pm = new PermissionManager({
      getPermissionsAllow: () => undefined,
      getPermissionsAsk: () => ['Bash(qwen autofix-pr push *)'],
      getPermissionsDeny: () => undefined,
      getProjectRoot: () => dir,
      getCwd: () => dir,
    });
    pm.initialize();
    const config = makeConfig({ getPermissionManager: () => pm });
    expect(
      (await presented({ command: 'push', pr: 12 }, config))['watch'],
    ).toBe('unconfirmed');
  });

  it('refuses what a rule denies as the shell command it stands for', async () => {
    const pm = new PermissionManager({
      getPermissionsAllow: () => undefined,
      getPermissionsAsk: () => undefined,
      getPermissionsDeny: () => ['Bash(qwen autofix-pr *)'],
      getProjectRoot: () => dir,
      getCwd: () => dir,
    });
    pm.initialize();
    const config = makeConfig({ getPermissionManager: () => pm });
    const inv = invocation({ command: 'status' }, config);
    expect(await inv.getDefaultPermission(signal())).toBe('allow');
    expect((await inv.execute(signal())).error?.message).toMatch(
      /denies `qwen autofix-pr status` as a shell command/,
    );
  });

  it('runs no helper but status in plan mode, whatever a rule allows', async () => {
    await prepare();
    const plan = makeConfig({ getApprovalMode: () => ApprovalMode.PLAN });
    const push = await invocation({ command: 'push', pr: 12 }, plan).execute(
      signal(),
    );
    expect(push.error?.message).toMatch(/not in plan mode/);
    const status = await invocation({ command: 'status' }, plan).execute(
      signal(),
    );
    expect(status.error).toBeUndefined();
    const unattended = invocation({ command: 'unattended', pr: 12 }, plan);
    expect(unattended.requiresUserInteraction!()).toBe(false);
    expect((await unattended.execute(signal())).error?.message).toMatch(
      /plan mode/,
    );
  });

  it('asks for a new schedule each time', async () => {
    await prepare();
    const schedule = invocation({ command: 'schedule', pr: 12, again: true });
    await schedule.getDefaultPermission(signal());
    const details = await schedule.getConfirmationDetails(signal());
    expect(details).toMatchObject({ hideAlwaysAllow: true });
    expect((details as { warnings?: string[] }).warnings?.join(' ')).toMatch(
      /Records the scheduled task of the watch of PR #12, replacing any it has/,
    );
  });

  it('says what a take-over does', async () => {
    const warning = async (params: AutofixPrParams) =>
      (
        (await invocation(params).getConfirmationDetails(signal())) as {
          warnings?: string[];
        }
      ).warnings?.join(' ');
    expect(
      await warning({ command: 'cleanup', pr: 12, take_over: true }),
    ).toMatch(/Stops the watch of PR #12, taking it from any other session/);
    expect(
      await warning({
        command: 'prepare',
        pr: 12,
        repo: 'o/r',
        take_over: true,
      }),
    ).toMatch(/Takes the watch of PR #12 over/);
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
    // Nothing to answer before a prepare: no dialog, just the refusal.
    const early = invocation({ command: 'unattended', pr: 12 });
    expect(early.requiresUserInteraction!()).toBe(false);
    expect(await early.getDefaultPermission()).toBe('allow');
    await prepare();
    const asked = invocation({ command: 'unattended', pr: 12 });
    expect(asked.requiresUserInteraction!()).toBe(true);
    expect(await asked.getConfirmationDetails(signal())).toMatchObject({
      type: 'info',
      hideAlwaysAllow: true,
      permissionRules: [],
    });
    const yolo = invocation(
      { command: 'unattended', pr: 12 },
      makeConfig({ getApprovalMode: () => ApprovalMode.YOLO }),
    );
    expect(yolo.requiresUserInteraction!()).toBe(false);
    expect(await yolo.getDefaultPermission()).toBe('allow');
  });
});

describe('the Configs of granted agents', () => {
  it('include one derived from them, as a rebuilt registry binds to', () => {
    const granted = {};
    markUnattendedFixConfig(granted);
    expect(isUnattendedFixConfig(Object.create(granted))).toBe(true);
    expect(isUnattendedFixConfig({})).toBe(false);
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

  it('passes a path with shell syntax through as one argument', async () => {
    const clone = path.join(dir, 'a $(touch pwned); b');
    const tmp = path.join(clone, '.qwen', 'tmp');
    fs.mkdirSync(path.join(tmp, 'autofix-pr-12'), { recursive: true });
    vi.stubEnv('FAKE_WORKTREE', path.join(tmp, 'autofix-pr-12'));
    await prepare();
    const plan = path.join(tmp, 'autofix-pr-12-plan.json');
    const result = await invocation({ command: 'reply', pr: 12, plan }).execute(
      signal(),
    );
    expect(JSON.parse(String(result.llmContent)).rest).toEqual(['12', plan]);
    expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false);
  });

  it('takes the plan of a watch prepared here only from beside its worktree', async () => {
    await prepare();
    const elsewhere = path.join(
      os.tmpdir(),
      'other',
      '.qwen',
      'tmp',
      'autofix-pr-12-plan.json',
    );
    const result = await invocation({
      command: 'reply',
      pr: 12,
      plan: elsewhere,
    }).execute(signal());
    expect(result.error?.message).toContain(
      path.join(dir, '.qwen', 'tmp', 'autofix-pr-12-plan.json'),
    );
  });

  it('takes a run id the model gives as a number', () => {
    const tool = new AutofixPrTool(makeConfig());
    expect(
      autofixPrArgs(
        tool.build({ command: 'rerun', pr: 12, run_id: 99 as never }).params,
      ),
    ).toEqual(['rerun', '12', '99']);
  });

  it('keeps to the CLI it found first when the environment changes later', async () => {
    await runAutofixPrHelper(makeConfig(), ['push', '12'], signal());
    const other = path.join(dir, 'other-cli.mjs');
    fs.writeFileSync(other, "process.stdout.write('other\\n');");
    vi.stubEnv('QWEN_CODE_CLI', other);
    const again = await runAutofixPrHelper(
      makeConfig(),
      ['push', '12'],
      signal(),
    );
    expect(JSON.parse(again.stdout).command).toBe('push');
    resetAutofixPrLaunchForTests();
    const moved = await runAutofixPrHelper(
      makeConfig(),
      ['push', '12'],
      signal(),
    );
    expect(moved.stdout.trim()).toBe('other');
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
      targetDir: dir,
      preparedAt: PREPARED_AT,
      worktree,
      authorCanPush: true,
    });
    expect(confirmedWatch('session-b', 12)).toBeUndefined();
    await invocation({ command: 'cleanup', pr: 12 }).execute(signal());
    expect(confirmedWatch('session-a', 12)).toBeUndefined();
  });

  it('marks in status the watches this session prepared here', async () => {
    const listed = async (config = makeConfig()) =>
      JSON.parse(
        String(
          (await invocation({ command: 'status' }, config).execute(signal()))
            .llmContent,
        ),
      ).watches[0].preparedHere;
    expect(await listed()).toBe(false);
    await prepare();
    expect(await listed()).toBe(true);
    expect(await listed(makeConfig({ getSessionId: () => 'session-b' }))).toBe(
      false,
    );
  });

  it('lets status and a cancelled call past a helper still running', async () => {
    vi.stubEnv('FAKE_AUTOFIX_MODE', 'hang');
    const running = new AbortController();
    const first = runAutofixPrHelper(
      makeConfig(),
      ['push', '12'],
      running.signal,
    );
    const waiting = new AbortController();
    const second = runAutofixPrHelper(
      makeConfig(),
      ['sync', '12'],
      waiting.signal,
    );
    setTimeout(() => waiting.abort(), 100);
    expect((await second).failure).toBe('cancelled');
    vi.stubEnv('FAKE_AUTOFIX_MODE', '');
    const status = await runAutofixPrHelper(makeConfig(), ['status'], signal());
    expect(status.exitCode).toBe(0);
    running.abort();
    expect((await first).failure).toBe('cancelled');
  }, 20_000);

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

  it('compares the repository without case', async () => {
    await prepare();
    vi.stubEnv('FAKE_STATUS', status({ repo: 'O/R' }));
    expect((await confirmAndRun()).error).toBeUndefined();
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

  it('grants only the watch its dialog named', async () => {
    await prepare();
    const inv = invocation({ command: 'unattended', pr: 12 });
    const details = await inv.getConfirmationDetails(signal());
    // Prepared again, of another repository, between the dialog and the grant.
    await invocation({ command: 'prepare', pr: 12, repo: 'other/x' }).execute(
      signal(),
    );
    await details.onConfirm(ToolConfirmationOutcome.ProceedOnce);
    expect((await inv.execute(signal())).error?.message).toMatch(
      /changed after the dialog/,
    );
    expect(await granted()).toBe(false);
  });

  it('ends when the watch was prepared again in another process', async () => {
    await prepare();
    await confirmAndRun();
    vi.stubEnv(
      'FAKE_STATUS',
      status({ preparedAt: '2026-10-25T11:00:00.000Z' }),
    );
    expect(await granted()).toBe(false);
  });

  it('matches the worktree by its real path', async () => {
    await prepare();
    await confirmAndRun();
    const link = path.join(dir, 'link');
    fs.symlinkSync(worktree, link, 'dir');
    expect(await granted('session-a', link)).toBe(true);
    expect(canonicalWorktreePath(link)).toBe(worktree);
  });

  it('survives a prepare of the same watch, a refused one included, and ends with another watch or its cleanup', async () => {
    await prepare();
    await confirmAndRun();
    // A start over a running watch, or a refused one, leaves it as it is.
    vi.stubEnv('FAKE_AUTOFIX_MODE', 'refuse');
    await invocation({ command: 'prepare', pr: 12, repo: 'o/r' }).execute(
      signal(),
    );
    vi.stubEnv('FAKE_AUTOFIX_MODE', '');
    await prepare();
    expect(await granted()).toBe(true);
    // Recreated: another watch, which asks again.
    vi.stubEnv('FAKE_PREPARED_AT', '2026-10-25T11:00:00.000Z');
    vi.stubEnv(
      'FAKE_STATUS',
      status({ preparedAt: '2026-10-25T11:00:00.000Z' }),
    );
    await prepare();
    // Revoked by the prepare itself, though status now lists the new watch.
    expect(await granted()).toBe(false);
    await confirmAndRun();
    expect(await granted()).toBe(true);
    // Taken from another session: asks again.
    vi.stubEnv('FAKE_TOOK_OVER', '1');
    await invocation({
      command: 'prepare',
      pr: 12,
      repo: 'o/r',
      take_over: true,
    }).execute(signal());
    expect(await granted()).toBe(false);
    vi.stubEnv('FAKE_TOOK_OVER', '');
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
      'a program answers through --input-file',
      makeConfig({ getInputFile: () => '/tmp/in.jsonl' }),
      ToolConfirmationOutcome.ProceedOnce,
      /--input-file/,
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
    if (outcome === ToolConfirmationOutcome.ProceedOnce) {
      // Known before any dialog: none is shown.
      expect(
        invocation({ command: 'unattended', pr: 12 }, config)
          .requiresUserInteraction!(),
      ).toBe(false);
    }
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

  it('is taken back by attended, which asks nothing, in any mode', async () => {
    await prepare();
    await confirmAndRun();
    const plan = makeConfig({ getApprovalMode: () => ApprovalMode.PLAN });
    const attended = invocation({ command: 'attended', pr: 12 }, plan);
    expect(await attended.getDefaultPermission(signal())).toBe('allow');
    expect(attended.requiresUserInteraction!()).toBe(false);
    expect((await attended.execute(signal())).error).toBeUndefined();
    expect(await granted()).toBe(false);
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

describe('background fixes', () => {
  const log = () =>
    fs.existsSync(path.join(dir, 'log'))
      ? fs.readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n')
      : [];
  const cancel = vi.fn();
  const registryConfig = (overrides: Partial<Record<string, unknown>> = {}) =>
    makeConfig({
      getBackgroundTaskRegistry: () => ({ cancel }),
      ...overrides,
    });
  /** A watch this session prepared, granted and scheduled, as a start does. */
  const granted = async (config = registryConfig()) => {
    await prepare(config);
    const inv = invocation({ command: 'unattended', pr: 12 }, config);
    await (
      await inv.getConfirmationDetails(signal())
    ).onConfirm(ToolConfirmationOutcome.ProceedOnce);
    expect((await inv.execute(signal())).error).toBeUndefined();
    vi.stubEnv('FAKE_REPLY', '0');
    vi.stubEnv('FAKE_INSTRUCTIONS', 'keep the API');
    expect(
      (
        await invocation({ command: 'schedule', pr: 12 }, config).execute(
          signal(),
        )
      ).error,
    ).toBeUndefined();
  };
  /** The launch's part: open the attempt, then attach the agent. */
  const launched = async (agentId = 'agent-1') => {
    const fix = await openBackgroundFix('session-a', worktree, signal());
    // As the registry is asked: with no options, or told not to notify.
    fix.attach(agentId, (notify) =>
      notify ? cancel(agentId) : cancel(agentId, { notify: false }),
    );
    return fix;
  };
  const run = (params: AutofixPrParams, config = registryConfig()) =>
    invocation(params, config).execute(signal());

  beforeEach(() => {
    cancel.mockReset();
    vi.stubEnv('FAKE_LOG', path.join(dir, 'log'));
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-26T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it("records the task the session's own schedule printed", async () => {
    await granted();
    expect(watchTask('session-a', 12)).toEqual({
      task: 'feedc0ffee12',
      reply: false,
      instructions: 'keep the API',
    });
  });

  it('opens an attempt through fix-start, once per worktree, on the task this session scheduled', async () => {
    await granted();
    const fix = await launched();
    expect(fix.attempt).toMatch(/^[0-9a-f]{12}$/);
    expect(log()).toContain(`fix-start 12 --attempt=${fix.attempt}`);
    await expect(
      openBackgroundFix('session-a', worktree, signal()),
    ).rejects.toThrow(/already working/);
    fix.drop();
    // A state file naming another task: not the watch this session runs.
    vi.stubEnv('FAKE_TASK', 'aaaaaaaaaaaa');
    await expect(
      openBackgroundFix('session-a', worktree, signal()),
    ).rejects.toThrow(/no longer driven by the task this session scheduled/);
    expect(log().at(-1)).toMatch(/^fix-end 12 --attempt=/);
    expect(backgroundFixOf('session-a', 12)).toBeUndefined();
  });

  it("reads the helper's reason from the line that names the error, not the stack after it", async () => {
    await granted();
    vi.stubEnv('FAKE_AUTOFIX_MODE', 'refuse-stack');
    await expect(
      openBackgroundFix('session-a', worktree, signal()),
    ).rejects.toThrow(
      // The last line naming an error: what `gh` printed first is not it.
      /^autofix-pr fix-start refused: no round of PR #12 has a fix to start$/,
    );
  });

  it('refuses as no longer unattended an attempt the session ended while it opened', async () => {
    await granted();
    const opening = openBackgroundFix('session-a', worktree, signal());
    forgetAutofixPrSession('session-a');
    await expect(opening).rejects.toThrow(/runs without asking$/);
    expect(log().at(-1)).toMatch(/^fix-end 12 --attempt=.* --abandon$/);
  });

  it("refuses with the helper's reason, and with no grant or no task", async () => {
    await expect(
      openBackgroundFix('session-a', worktree, signal()),
    ).rejects.toThrow(/runs without asking/);
    // Granted, but no task scheduled: no round could claim it.
    const config = registryConfig();
    await prepare(config);
    const inv = invocation({ command: 'unattended', pr: 12 }, config);
    await (
      await inv.getConfirmationDetails(signal())
    ).onConfirm(ToolConfirmationOutcome.ProceedOnce);
    expect((await inv.execute(signal())).error).toBeUndefined();
    await expect(
      openBackgroundFix('session-a', worktree, signal()),
    ).rejects.toThrow(/has no task this session scheduled/);
    expect(backgroundFixOf('session-a', 12)).toBeUndefined();
    expect(log().filter((line) => line.startsWith('fix-start'))).toEqual([]);
    await granted();
    vi.stubEnv('FAKE_AUTOFIX_MODE', 'refuse');
    await expect(
      openBackgroundFix('session-a', worktree, signal()),
    ).rejects.toThrow(/fix-start refused: another session watches PR #12/);
    expect(backgroundFixOf('session-a', 12)).toBeUndefined();
  });

  it('refuses every helper but status while the agent runs, and lets the round claim it once it ended', async () => {
    await granted();
    const fix = await launched();
    for (const params of [
      { command: 'push', pr: 12 },
      { command: 'sync', pr: 12 },
      { command: 'prepare', pr: 12, repo: 'o/r' },
    ] as AutofixPrParams[]) {
      expect((await run(params)).error?.message).toMatch(
        /A fix agent of PR #12 is working in its worktree/,
      );
    }
    expect((await run({ command: 'status', pr: 12 })).error).toBeUndefined();
    const claim = { command: 'fix-end', pr: 12, attempt: fix.attempt } as const;
    expect((await run(claim)).error?.message).toMatch(/still working/);
    expect(
      (await run({ ...claim, attempt: 'ba9876543210' })).error?.message,
    ).toMatch(/not this session's to claim/);
    fix.end({ status: 'completed', report: 'fixed "Test"' });
    // The claim waits for the body to settle, at most 15 seconds.
    const claiming = run({ ...claim, task: 'feedc0ffee12' });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(log().at(-1)).not.toMatch(/^fix-end/);
    expect(backgroundFixOf('session-a', 12)).toBe(fix);
    await vi.advanceTimersByTimeAsync(1_000);
    const claimed = await claiming;
    expect(JSON.parse(String(claimed.llmContent))).toEqual({
      attempt: fix.attempt,
      snapshot: 'snap.json',
      brief: 'brief.md',
      head: 'abc',
      agent: { status: 'completed', report: 'fixed "Test"' },
      // The options this session scheduled, whatever the follow-up said.
      watch: {
        task: 'feedc0ffee12',
        reply: false,
        instructions: 'keep the API',
      },
    });
    expect(log().at(-1)).toBe(
      `fix-end 12 --task=feedc0ffee12 --attempt=${fix.attempt}`,
    );
    expect(backgroundFixOf('session-a', 12)).toBeUndefined();
    expect((await run(claim)).error?.message).toMatch(
      /not this session's to claim/,
    );
  });

  it('claims nothing in plan mode', async () => {
    await granted();
    const fix = await launched();
    fix.end({ status: 'completed', report: '' });
    fix.bodySettled();
    const plan = registryConfig({ getApprovalMode: () => ApprovalMode.PLAN });
    expect(
      (await run({ command: 'fix-end', pr: 12, attempt: fix.attempt }, plan))
        .error?.message,
    ).toMatch(/not in plan mode/);
    expect(backgroundFixOf('session-a', 12)).toBe(fix);
  });

  it('stops the agent quietly before a cleanup, ending the attempt first', async () => {
    await granted();
    const fix = await launched();
    cancel.mockImplementation(() => {
      fix.end({ status: 'cancelled', report: '' });
      fix.bodySettled();
    });
    const registry = {
      cancel: vi.fn((id: string, options: unknown) => {
        expect(options).toEqual({ notify: false });
        cancel(id);
      }),
    };
    const config = registryConfig({
      getBackgroundTaskRegistry: () => registry,
    });
    const result = await run({ command: 'cleanup', pr: 12 }, config);
    expect(result.error).toBeUndefined();
    expect(registry.cancel).toHaveBeenCalledWith('agent-1', { notify: false });
    expect(log().slice(-2)).toEqual([
      `fix-end 12 --attempt=${fix.attempt} --abandon`,
      'cleanup 12',
    ]);
    expect(backgroundFixOf('session-a', 12)).toBeUndefined();
  });

  it("goes on with the cleanup once a stopped agent's grace ran out", async () => {
    await granted();
    const fix = await launched();
    const pending = run({ command: 'cleanup', pr: 12 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending).error).toBeUndefined();
    expect(fix.ended).toEqual({ status: 'cancelled', report: '' });
    expect(log().slice(-2)).toEqual([
      `fix-end 12 --attempt=${fix.attempt} --abandon`,
      'cleanup 12',
    ]);
  });

  it('stops an agent as it launches when a stop or a drop came first', async () => {
    await granted();
    const first = await openBackgroundFix('session-a', worktree, signal());
    first.stop();
    first.attach('agent-1', () => cancel('agent-1'));
    expect(cancel).toHaveBeenCalledWith('agent-1');
    // Still the round's to claim, as an agent that was stopped.
    expect(first.done).toBe(false);
    first.drop();
    const second = await openBackgroundFix('session-a', worktree, signal());
    forgetAutofixPrSession('session-a');
    second.attach('agent-2', () => cancel('agent-2'));
    expect(cancel).toHaveBeenCalledWith('agent-2');
  });

  it('ends an attempt whose opening failed, its marker with it', async () => {
    await granted();
    vi.stubEnv('FAKE_AUTOFIX_MODE', 'refuse');
    await expect(
      openBackgroundFix('session-a', worktree, signal()),
    ).rejects.toThrow(/fix-start refused/);
    vi.stubEnv('FAKE_AUTOFIX_MODE', '');
    expect(log().slice(-2)).toEqual([
      expect.stringMatching(/^fix-start 12 --attempt=/),
      expect.stringMatching(/^fix-end 12 --attempt=/),
    ]);
    expect(backgroundFixOf('session-a', 12)).toBeUndefined();
  });

  it('waits for an ended agent whose body has not settled before a cleanup, and keeps the attempt when its helper refuses', async () => {
    await granted();
    const fix = await launched();
    // Ended by its grace's notification, its body still running.
    fix.end({ status: 'cancelled', report: '' });
    const pending = run({ command: 'cleanup', pr: 12 });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(log().at(-1)).not.toMatch(/^fix-end/);
    vi.stubEnv('FAKE_AUTOFIX_MODE', 'refuse');
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).error?.message).toMatch(/fix-end refused/);
    expect(backgroundFixOf('session-a', 12)).toBe(fix);
  });

  it('stops the agent and drops its attempt when the fixes ask again', async () => {
    await granted();
    const fix = await launched();
    await run({ command: 'attended', pr: 12 });
    expect(cancel).toHaveBeenCalledWith('agent-1');
    // Its marker goes stale: the next round redoes it in the foreground.
    expect(fix.done).toBe(true);
    expect(fix.followUp()).toBeUndefined();
    expect(backgroundFixOf('session-a', 12)).toBeUndefined();
  });

  it("drops an attempt whose round's snapshot is gone: it is never claimed", async () => {
    await granted();
    const fix = await launched();
    fix.end({ status: 'completed', report: '' });
    fix.bodySettled();
    vi.stubEnv('FAKE_AUTOFIX_MODE', 'lost');
    expect(
      (await run({ command: 'fix-end', pr: 12, attempt: fix.attempt })).error
        ?.message,
    ).toMatch(/has lost its round's snapshot/);
    expect(fix.done).toBe(true);
    expect(backgroundFixOf('session-a', 12)).toBeUndefined();
  });

  it('drops an attempt whose refresh is late as soon as anything looks it up, before its timer runs', async () => {
    await granted();
    const fix = await launched();
    // Asleep past the marker's freshness: the gate's round arrives first.
    vi.setSystemTime(Date.now() + 3 * 60_000);
    const syncing = run({ command: 'sync', pr: 12 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fix.done).toBe(true);
    expect(cancel).toHaveBeenCalledWith('agent-1');
    // The helper waits for the stopped agent to settle, at most 15 seconds:
    // given a real second to start, it has not.
    await vi.advanceTimersByTimeAsync(14_000);
    // A real second, on every platform.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    expect(log().at(-1)).not.toMatch(/^sync/);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await syncing).error).toBeUndefined();
    expect(log().at(-1)).toBe('sync 12');
  });

  it('waits for the agent of an attempt its heartbeat dropped, before a helper acts on its worktree', async () => {
    await granted();
    const fix = await launched();
    // The heartbeat runs first after a sleep, and drops it.
    fix.beat(Date.now() + 3 * 60_000);
    expect(fix.done).toBe(true);
    const syncing = run({ command: 'sync', pr: 12 });
    await vi.advanceTimersByTimeAsync(14_000);
    // A real second, on every platform.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    expect(log().at(-1)).not.toMatch(/^sync/);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await syncing).error).toBeUndefined();
    expect(log().at(-1)).toBe('sync 12');
    // Settled, or waited for once: the next helper goes on at once.
    fix.bodySettled();
    expect((await run({ command: 'push', pr: 12 })).error).toBeUndefined();
  });

  it("holds a dropped fix's worktree until its stopped agent settles, for writes and for launches in it", async () => {
    await granted();
    const fix = await launched();
    // Its grant ends: dropped, its agent stopped but not settled yet.
    await run({ command: 'attended', pr: 12 });
    expect(fix.done).toBe(true);
    const inside = path.join(worktree, 'src', 'a.ts');
    expect(backgroundFixHolding(inside, null)).toBe(fix);
    expect(backgroundFixHolding(inside, 'agent-1')).toBeUndefined();
    // A launch in its directory waits for it, at most 15 seconds.
    let waited = false;
    const settling = settleBackgroundFix({
      within: path.join(worktree, 'src'),
    }).then(() => (waited = true));
    await vi.advanceTimersByTimeAsync(14_000);
    expect(waited).toBe(false);
    fix.bodySettled();
    await settling;
    expect(waited).toBe(true);
    expect(backgroundFixHolding(inside, null)).toBeUndefined();
  });

  it('holds the worktree on the very lookup that finds a fix late, its stopped agent not settled', async () => {
    await granted();
    const fix = await launched();
    // Suspended past its refresh: no timer has run yet.
    vi.setSystemTime(Date.now() + 3 * 60_000);
    const inside = path.join(worktree, 'src', 'a.ts');
    expect(backgroundFixHolding(inside, null)).toBe(fix);
    expect(fix.done).toBe(true);
    expect(cancel).toHaveBeenCalledWith('agent-1');
    fix.bodySettled();
  });

  it('is never late before its heartbeat starts: its helper may wait its turn', async () => {
    await granted();
    const fix = new BackgroundFix(
      'session-a',
      12,
      'o/r',
      worktree,
      { task: 't', reply: true, instructions: '' },
      {
        pr: 12,
        worktree,
        check: async () => true,
        open: async () => ({ task: 't' }),
        close: async () => {},
      },
    );
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect(fix.isLate()).toBe(false);
    fix.startHeartbeat();
    expect(fix.isLate()).toBe(false);
    fix.drop();
  });

  it('claims under the task this session scheduled, whatever the turn copied', async () => {
    await granted();
    const fix = await launched();
    fix.end({ status: 'completed', report: '' });
    fix.bodySettled();
    expect(
      (
        await run({
          command: 'fix-end',
          pr: 12,
          attempt: fix.attempt,
          task: 'aaaaaaaaaaaa',
        })
      ).error,
    ).toBeUndefined();
    expect(log().at(-1)).toBe(
      `fix-end 12 --task=feedc0ffee12 --attempt=${fix.attempt}`,
    );
  });

  it('leaves the attempt to claim again when the helper refuses', async () => {
    await granted();
    const fix = await launched();
    fix.end({ status: 'completed', report: '' });
    fix.bodySettled();
    const claim = { command: 'fix-end', pr: 12, attempt: fix.attempt } as const;
    vi.stubEnv('FAKE_AUTOFIX_MODE', 'refuse');
    expect((await run(claim)).error?.message).toMatch(/fix-end refused/);
    expect(backgroundFixOf('session-a', 12)).toBe(fix);
    vi.stubEnv('FAKE_AUTOFIX_MODE', '');
    expect((await run(claim)).error).toBeUndefined();
    expect(backgroundFixOf('session-a', 12)).toBeUndefined();
  });

  it('abandons an attempt a cleanup finds still launching', async () => {
    await granted();
    const fix = await openBackgroundFix('session-a', worktree, signal());
    expect((await run({ command: 'cleanup', pr: 12 })).error?.message).toMatch(
      /was starting; it stops as it launches: run cleanup again/,
    );
    expect(log().at(-1)).toBe(`fix-end 12 --attempt=${fix.attempt} --abandon`);
    expect(fix.done).toBe(true);
    // It launches anyway: stopped at once, with no round to go on, and no
    // notification, as a stop of a running one.
    const stopped = vi.fn();
    fix.attach('agent-1', stopped);
    expect(stopped).toHaveBeenCalledWith(false);
    expect(fix.followUp()).toBeUndefined();
  });

  it("finds a path in a running fix's worktree as the kernel resolves it, for anyone but its agent", async () => {
    await granted();
    const fix = await openBackgroundFix('session-a', worktree, signal());
    // Before its agent attaches, no caller is it.
    expect(backgroundFixHolding(path.join(worktree, 'a.ts'), null)).toBe(fix);
    fix.attach('agent-1', () => cancel('agent-1'));
    const held = (p: string, caller: string | null = null) =>
      backgroundFixHolding(p, caller) === fix;
    expect(held(worktree)).toBe(true);
    expect(held(path.join(worktree, 'src', 'new', 'a.ts'))).toBe(true);
    expect(held(path.join(worktree, '..foo', 'x'))).toBe(true);
    expect(held(path.join(worktree, 'a.ts'), 'agent-1')).toBe(false);
    expect(
      held(path.join(path.dirname(worktree), 'autofix-pr-12-plan.json')),
    ).toBe(false);
    expect(held(path.join(worktree, '..', 'autofix-pr-1'))).toBe(false);
    // Links need privileges on Windows.
    if (process.platform === 'win32') return;
    // Through a link, and a `..` after it, as the kernel goes.
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-out-'));
    try {
      fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
      fs.symlinkSync(path.join(worktree, 'src'), path.join(out, 'link'));
      expect(held(path.join(out, 'link', 'a.ts'))).toBe(true);
      expect(
        held(`${path.join(out, 'link')}${path.sep}..${path.sep}package.json`),
      ).toBe(true);
      // A link to a file not made yet.
      fs.symlinkSync(path.join(worktree, 'new.sh'), path.join(out, 'dangling'));
      expect(held(path.join(out, 'dangling'))).toBe(true);
      expect(held(path.join(out, 'other.ts'))).toBe(false);
      // A link whose own target goes through a link and `..`, followed as
      // written, not folded as text.
      fs.mkdirSync(path.join(worktree, 'a', 'b'), { recursive: true });
      fs.symlinkSync('a/b', path.join(worktree, 'S'));
      fs.symlinkSync('S/../../src', path.join(worktree, 'LD'));
      fs.symlinkSync(path.join(worktree, 'LD'), path.join(out, 'via'));
      expect(held(path.join(out, 'via', 'index.ts'))).toBe(true);
      // Inside as Windows reads it, which folds `escape\..` as text.
      fs.symlinkSync(out, path.join(worktree, 'escape'));
      expect(
        held(`${path.join(worktree, 'escape')}${path.sep}..${path.sep}x.json`),
      ).toBe(true);
      // A backslash is a character of a name outside Windows.
      expect(held(`${worktree}/a\\..\\..\\..\\b/conftest.py`)).toBe(true);
      // Links that go round, as `node_modules` trees can: the walk ends.
      fs.symlinkSync('self', path.join(out, 'self'));
      fs.symlinkSync('ring-b', path.join(out, 'ring-a'));
      fs.symlinkSync('ring-a', path.join(out, 'ring-b'));
      fs.symlinkSync(path.join(out, 'ring-a'), path.join(worktree, 'ring'));
      expect(held(path.join(out, 'self', 'x.ts'))).toBe(false);
      expect(held(path.join(out, 'ring-a', 'x.ts'))).toBe(false);
      // Into the ring from the worktree: a write there fails (ELOOP).
      expect(held(path.join(worktree, 'ring', 'x.ts'))).toBe(false);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  it('says in status which watches run their fixes unattended', async () => {
    const unattended = async () =>
      JSON.parse(String((await run({ command: 'status' })).llmContent))
        .watches[0].unattended;
    await prepare(registryConfig());
    expect(await unattended()).toBe(false);
    await granted();
    expect(await unattended()).toBe(true);
    await run({ command: 'attended', pr: 12 });
    expect(await unattended()).toBe(false);
  });

  describe('the attempt', () => {
    const marker = () =>
      path.join(dir, '.qwen', 'tmp', 'autofix-pr-12-fix.json');
    const writeMarker = (attempt: string) =>
      fs.writeFileSync(
        marker(),
        JSON.stringify({
          version: 1,
          attempt,
          startedAt: new Date().toISOString(),
        }),
      );
    const mtime = () => fs.lstatSync(marker()).mtimeMs;
    let fix: BackgroundFix;
    beforeEach(async () => {
      await granted();
      fix = await launched();
      writeMarker(fix.attempt);
      const old = new Date('2026-10-26T09:00:00Z');
      fs.utimesSync(marker(), old, old);
    });

    it('refreshes its marker every 30 seconds while the marker names it', async () => {
      await vi.advanceTimersByTimeAsync(FIX_HEARTBEAT_MS);
      expect(mtime()).toBe(Date.now());
      expect(fix.done).toBe(false);
    });

    it('stops the agent and lets go when the marker is another attempt, gone, or a link', async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-link-'));
      /** A link at the marker to a file naming this attempt, dated `old`. */
      const linkTo = (target: string) => () => {
        writeMarker(fix.attempt);
        fs.renameSync(marker(), target);
        const old = new Date('2026-10-01T00:00:00Z');
        fs.utimesSync(target, old, old);
        fs.symlinkSync(target, marker());
        return target;
      };
      try {
        for (const plant of [
          () => void writeMarker('ba9876543210'),
          () => void fs.rmSync(marker()),
          // Links need privileges on Windows.
          ...(process.platform === 'win32'
            ? []
            : [
                linkTo(path.join(dir, 'target')),
                linkTo(path.join(outside, 'target')),
              ]),
        ] as Array<() => string | undefined>) {
          resetUnattendedFixGrantsForTests();
          cancel.mockReset();
          await granted();
          fix = await launched();
          writeMarker(fix.attempt);
          const target = plant();
          await vi.advanceTimersByTimeAsync(FIX_HEARTBEAT_MS);
          expect(fix.done).toBe(true);
          expect(cancel).toHaveBeenCalledWith('agent-1');
          expect(fix.followUp()).toBeUndefined();
          // Its stopped agent settles, and the marker is expired: never
          // what a link there names.
          fix.bodySettled();
          await vi.advanceTimersByTimeAsync(0);
          if (target) {
            expect(fs.statSync(target).mtimeMs).toBe(
              new Date('2026-10-01T00:00:00Z').getTime(),
            );
          }
          fs.rmSync(marker(), { force: true });
        }
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it.skipIf(process.platform === 'win32')(
      'never blocks on a FIFO planted at the marker',
      async () => {
        fs.rmSync(marker());
        execFileSync('mkfifo', [marker()]);
        await vi.advanceTimersByTimeAsync(FIX_HEARTBEAT_MS);
        expect(fix.done).toBe(true);
        expect(cancel).toHaveBeenCalledWith('agent-1');
      },
    );

    it('counts the first refresh from when the attempt opened', async () => {
      const grant = {
        pr: 12,
        worktree,
        check: async () => true,
        open: async () => ({ task: 't' }),
        close: async () => {},
      };
      const waited = new BackgroundFix(
        'session-a',
        12,
        'o/r',
        worktree,
        { task: 't', reply: true, instructions: '' },
        grant,
      );
      // Its helper waited its turn, long, before the heartbeat started.
      vi.setSystemTime(Date.now() + 5 * 60_000);
      waited.startHeartbeat();
      const json = JSON.parse(fs.readFileSync(marker(), 'utf8'));
      fs.writeFileSync(
        marker(),
        JSON.stringify({ ...json, attempt: waited.attempt }),
      );
      await vi.advanceTimersByTimeAsync(FIX_HEARTBEAT_MS);
      expect(waited.done).toBe(false);
      waited.drop();
    });

    it('expires its marker once its stopped agent settles when the fixes ask again', async () => {
      writeMarker(fix.attempt);
      await run({ command: 'attended', pr: 12 });
      // Still fresh while the agent may write.
      expect(mtime()).not.toBe(0);
      fix.bodySettled();
      await vi.advanceTimersByTimeAsync(0);
      expect(mtime()).toBe(0);
    });

    it("leaves another attempt's marker alone when it drops", async () => {
      writeMarker('ba9876543210');
      const before = mtime();
      fix.bodySettled();
      fix.drop();
      await vi.advanceTimersByTimeAsync(0);
      expect(mtime()).toBe(before);
    });

    it('lets go when a refresh comes late: the process was suspended', () => {
      vi.setSystemTime(Date.now() + FIX_HEARTBEAT_MS + 61_000);
      fix.beat();
      expect(fix.done).toBe(true);
      expect(cancel).toHaveBeenCalledWith('agent-1');
    });

    it('stops the agent at the time limit, its attempt still claimable', async () => {
      writeMarker(fix.attempt);
      await vi.advanceTimersByTimeAsync(FIX_TIME_LIMIT_MS - 1000);
      expect(cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(cancel).toHaveBeenCalledWith('agent-1');
      expect(fix.done).toBe(false);
    });

    it('waits for a claim until 40 minutes after it opened, however late the agent ended', async () => {
      writeMarker(fix.attempt);
      await vi.advanceTimersByTimeAsync(FIX_CLAIM_DEADLINE_MS - 60_000);
      fix.end({ status: 'completed', report: 'done' });
      // Once: a later end changes nothing.
      fix.end({ status: 'failed', report: 'late' });
      expect(fix.ended).toEqual({ status: 'completed', report: 'done' });
      expect(fix.done).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fix.done).toBe(true);
      expect(backgroundFixOf('session-a', 12)).toBeUndefined();
    });

    it('keeps an attempt whose agent ended early claimable while its notification waits', async () => {
      writeMarker(fix.attempt);
      fix.end({ status: 'completed', report: 'done' });
      // A long turn of the user's holds the notification back.
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(fix.done).toBe(false);
      expect(fix.followUp()).toContain(`--attempt ${fix.attempt}`);
    });

    it('lets go when the clock was set back past when the attempt started', async () => {
      fs.writeFileSync(
        marker(),
        JSON.stringify({
          version: 1,
          attempt: fix.attempt,
          startedAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        }),
      );
      await vi.advanceTimersByTimeAsync(FIX_HEARTBEAT_MS);
      expect(fix.done).toBe(true);
    });

    it('lets go of a marker too large to be one', async () => {
      fs.writeFileSync(
        marker(),
        JSON.stringify({
          version: 1,
          attempt: fix.attempt,
          pad: 'x'.repeat(5000),
        }),
      );
      await vi.advanceTimersByTimeAsync(FIX_HEARTBEAT_MS);
      expect(fix.done).toBe(true);
    });

    it('ends with its session', () => {
      forgetAutofixPrSession('session-b');
      expect(fix.done).toBe(false);
      forgetAutofixPrSession('session-a');
      expect(fix.done).toBe(true);
      // Its notification would reach the session's next conversation.
      expect(cancel).toHaveBeenCalledWith('agent-1', { notify: false });
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it("stops an agent that launches after a stop with the stop's notification", () => {
      const bare = (task: { reply: boolean; instructions: string }) =>
        new BackgroundFix(
          'session-c',
          12,
          'o/r',
          worktree,
          { task: 'feedc0ffee12', ...task },
          {
            pr: 12,
            worktree,
            check: async () => true,
            open: async () => ({ task: 'feedc0ffee12' }),
            close: async () => {},
          },
        );
      for (const notify of [false, true]) {
        const early = bare({ reply: true, instructions: '' });
        early.stop({ notify });
        const stopped = vi.fn();
        early.attach('agent-2', stopped);
        expect(stopped).toHaveBeenCalledWith(notify);
      }
      // Once a stop said not to, none tells: a later one, or a reset after
      // a drop, keeps it quiet.
      const quiet = bare({ reply: true, instructions: '' });
      quiet.stop({ notify: false });
      quiet.stop();
      const first = vi.fn();
      quiet.attach('agent-3', first);
      expect(first).toHaveBeenCalledWith(false);
      const dropped = bare({ reply: true, instructions: '' });
      dropped.drop();
      dropped.drop({ notify: false });
      const second = vi.fn();
      dropped.attach('agent-4', second);
      expect(second).toHaveBeenCalledWith(false);
    });

    it('tells the round to go on with the options the session scheduled', () => {
      expect(fix.followUp()).toBe(
        'Written by Qwen Code, not by the agent: this agent was the background ' +
          'fix of /autofix-pr for o/r#12. Go on with its round now: invoke the ' +
          'autofix-pr skill with these arguments:\n' +
          `after-fix o/r#12 --task feedc0ffee12 --attempt ${fix.attempt} --no-reply -- keep the API`,
      );
      fix.claim();
      expect(fix.followUp()).toBeUndefined();
    });

    it('says nothing of replies or instructions a watch was scheduled without', () => {
      const bare = (task: { reply: boolean; instructions: string }) =>
        new BackgroundFix(
          'session-c',
          12,
          'o/r',
          worktree,
          { task: 'feedc0ffee12', ...task },
          {
            pr: 12,
            worktree,
            check: async () => true,
            open: async () => ({ task: 'feedc0ffee12' }),
            close: async () => {},
          },
        );
      const argsOf = (f: BackgroundFix) => f.followUp()!.split('\n').at(-1);
      const replying = bare({ reply: true, instructions: '' });
      expect(argsOf(replying)).toBe(
        `after-fix o/r#12 --task feedc0ffee12 --attempt ${replying.attempt}`,
      );
      const instructed = bare({ reply: true, instructions: 'keep the API' });
      expect(argsOf(instructed)).toBe(
        `after-fix o/r#12 --task feedc0ffee12 --attempt ${instructed.attempt} -- keep the API`,
      );
    });
  });
});
