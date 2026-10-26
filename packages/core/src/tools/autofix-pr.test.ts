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
  canonicalWorktreePath,
  confirmedWatch,
  hasUnattendedFixGrant,
  isUnattendedFixConfig,
  markUnattendedFixConfig,
  resetUnattendedFixGrantsForTests,
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
else if (command === 'prepare') process.stdout.write(JSON.stringify({ worktreePath: process.env.FAKE_WORKTREE, preparedAt: process.env.FAKE_PREPARED_AT, host: process.env.FAKE_HOST || undefined, authorCanPush: process.env.FAKE_CAN_PUSH === '1', tookOver: process.env.FAKE_TOOK_OVER === '1' }) + '\\n');
else if (command === 'status') process.stdout.write(process.env.FAKE_STATUS + '\\n');
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
