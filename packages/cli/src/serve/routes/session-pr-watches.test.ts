/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAutofixPrWatches: vi.fn(),
  readCronTasks: vi.fn(),
}));

vi.mock('./autofix-pr-watches.js', () => ({
  listAutofixPrWatches: mocks.listAutofixPrWatches,
}));

vi.mock(
  '@qwen-code/qwen-code-core/services/cronTasksFile.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/services/cronTasksFile.js')
      >();
    return { ...actual, readCronTasks: mocks.readCronTasks };
  },
);

import {
  collectActivePrWatches,
  parseVerifyPrWatchGate,
  prWatchKey,
} from './session-pr-watches.js';

const SESSION = '00000000-0000-4000-8000-00000000000a';

function autofixWatch(overrides: Record<string, unknown> = {}) {
  const pr = (overrides['pr'] as number | undefined) ?? 42;
  const host = (overrides['host'] as string | undefined) ?? 'github.com';
  const repo = (overrides['repo'] as string | undefined) ?? 'acme/widgets';
  return {
    pr,
    repo,
    host,
    url: `https://${host}/${repo}/pull/${pr}`,
    session: SESSION,
    stopped: null,
    ended: null,
    ...overrides,
  };
}

function cronTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    cron: '*/2 * * * *',
    prompt: 'verify-pr watch contract',
    recurring: true,
    createdAt: 0,
    lastFiredAt: null,
    sessionId: SESSION,
    gate: 'node /clone/scripts/verify-pr-watch-gate.mjs 42 --repo acme/widgets --cli /bin/qwen',
    ...overrides,
  };
}

beforeEach(() => {
  mocks.listAutofixPrWatches.mockReset();
  mocks.readCronTasks.mockReset();
  mocks.listAutofixPrWatches.mockResolvedValue({
    v: 1,
    available: true,
    watches: [],
  });
  mocks.readCronTasks.mockResolvedValue([]);
});

describe('prWatchKey', () => {
  it('normalizes host spellings the same way as the binding URL key', () => {
    // Hardcoded expected forms (repoKeyFromWebUrl semantics): a non-default
    // port is dropped, a leading www is stripped. Recomputing the expectation
    // with prWatchKey itself would be self-referential and survive a
    // consistent normalization change on both sides.
    expect(prWatchKey('https://ghe.corp:8443/o/r/pull/42', 42)).toBe(
      'ghe.corp/o/r#42',
    );
    expect(prWatchKey('https://www.github.com/o/r/pull/42', 42)).toBe(
      'github.com/o/r#42',
    );
    expect(prWatchKey('not a url', 42)).toBeUndefined();
  });
});

describe('parseVerifyPrWatchGate', () => {
  it('reads the PR and repo from the skill-contract gate', () => {
    expect(
      parseVerifyPrWatchGate(
        'node /clone/scripts/verify-pr-watch-gate.mjs 42 --repo acme/widgets --cli /bin/qwen',
      ),
    ).toEqual({ repo: 'acme/widgets', pr: 42 });
  });

  it('accepts a quoted script path and varied flag order', () => {
    expect(
      parseVerifyPrWatchGate(
        'node "/path with space/scripts/verify-pr-watch-gate.mjs" --cli /bin/qwen --repo acme/widgets 42',
      ),
    ).toEqual({ repo: 'acme/widgets', pr: 42 });
  });

  it('consumes value flags like the gate script parseArgs', () => {
    // --state-root eats the numeric value; the PR is the positional 42.
    expect(
      parseVerifyPrWatchGate(
        'node /clone/scripts/verify-pr-watch-gate.mjs --state-root 2026 42 --repo acme/widgets --cli /bin/qwen',
      ),
    ).toEqual({ repo: 'acme/widgets', pr: 42 });
  });

  it('rejects a gate whose first positional is not a positive integer', () => {
    // The script throws on 'foo' (NaN) — the gate never runs, so it is no
    // watch; detection must not skip ahead to the later 42.
    expect(
      parseVerifyPrWatchGate(
        'node /clone/scripts/verify-pr-watch-gate.mjs foo 42 --repo acme/widgets',
      ),
    ).toBeUndefined();
  });

  it('rejects one-shot probe invocations (check/claim/release)', () => {
    for (const flag of ['--check', '--claim', '--release']) {
      expect(
        parseVerifyPrWatchGate(
          `node /clone/scripts/verify-pr-watch-gate.mjs 42 ${flag} --repo acme/widgets`,
        ),
      ).toBeUndefined();
    }
  });

  it('rejects gates without the script, the number, or the repo', () => {
    expect(parseVerifyPrWatchGate(undefined)).toBeUndefined();
    expect(
      parseVerifyPrWatchGate('node /clone/scripts/other.mjs 42 --repo a/b'),
    ).toBeUndefined();
    expect(
      parseVerifyPrWatchGate(
        'node /clone/scripts/verify-pr-watch-gate.mjs --repo acme/widgets',
      ),
    ).toBeUndefined();
    expect(
      parseVerifyPrWatchGate(
        'node /clone/scripts/verify-pr-watch-gate.mjs 42 --cli /bin/qwen',
      ),
    ).toBeUndefined();
    expect(
      parseVerifyPrWatchGate(
        'node /clone/scripts/verify-pr-watch-gate.mjs 42 --repo not-a-repo',
      ),
    ).toBeUndefined();
  });

  it('does not read an autofix-pr snapshot gate as a verify-pr watch', () => {
    expect(
      parseVerifyPrWatchGate(
        '"${QWEN_CODE_CLI:-qwen}" autofix-pr snapshot 42 --gate --repo acme/widgets --host github.com --session s',
      ),
    ).toBeUndefined();
  });
});

describe('collectActivePrWatches', () => {
  it('collects autofix-pr watches owned by a session', async () => {
    mocks.listAutofixPrWatches.mockResolvedValue({
      v: 1,
      available: true,
      watches: [autofixWatch()],
    });
    const watches = await collectActivePrWatches('/ws');
    expect(watches?.get(SESSION)).toEqual(
      new Set([prWatchKey('https://github.com/acme/widgets/pull/42', 42)]),
    );
  });

  it('matches an enterprise-port watch against the binding URL key', async () => {
    mocks.listAutofixPrWatches.mockResolvedValue({
      v: 1,
      available: true,
      watches: [autofixWatch({ host: 'ghe.corp:8443' })],
    });
    const watches = await collectActivePrWatches('/ws');
    // The bindings route looks up with prWatchKey(bindingUrl, number),
    // which drops the port — the watch must land on that exact key.
    expect(watches?.get(SESSION)?.has('ghe.corp/acme/widgets#42')).toBe(true);
  });

  it('excludes stopped, ended, and unowned autofix-pr states', async () => {
    mocks.listAutofixPrWatches.mockResolvedValue({
      v: 1,
      available: true,
      watches: [
        autofixWatch({ pr: 1, stopped: 'merged' }),
        autofixWatch({ pr: 2, ended: { at: 'x', reason: 'cleanup' } }),
        autofixWatch({ pr: 3, session: '' }),
      ],
    });
    const watches = await collectActivePrWatches('/ws');
    expect(watches?.size).toBe(0);
  });

  it('collects verify-pr watch tasks bound to a session', async () => {
    mocks.readCronTasks.mockResolvedValue([cronTask()]);
    const watches = await collectActivePrWatches('/ws');
    expect(watches?.get(SESSION)).toEqual(
      new Set([prWatchKey('https://github.com/acme/widgets/pull/42', 42)]),
    );
  });

  it('excludes disabled, non-recurring, unbound, and malformed-gate tasks', async () => {
    mocks.readCronTasks.mockResolvedValue([
      cronTask({ id: 't1', enabled: false }),
      cronTask({ id: 't2', recurring: false }),
      cronTask({ id: 't3', sessionId: undefined }),
      cronTask({ id: 't4', gate: 'echo hello' }),
    ]);
    const watches = await collectActivePrWatches('/ws');
    expect(watches?.size).toBe(0);
  });

  it('unions both sources per session and lowercases the repo key', async () => {
    mocks.listAutofixPrWatches.mockResolvedValue({
      v: 1,
      available: true,
      watches: [autofixWatch({ pr: 7, repo: 'Acme/Widgets' })],
    });
    mocks.readCronTasks.mockResolvedValue([cronTask()]);
    const watches = await collectActivePrWatches('/ws');
    expect(watches?.get(SESSION)).toEqual(
      new Set([
        prWatchKey('https://github.com/acme/widgets/pull/7', 7),
        prWatchKey('https://github.com/acme/widgets/pull/42', 42),
      ]),
    );
  });

  it('returns undefined when the autofix-pr listing fails (fail-open)', async () => {
    mocks.listAutofixPrWatches.mockRejectedValue(new Error('git stalled'));
    mocks.readCronTasks.mockResolvedValue([cronTask()]);
    expect(await collectActivePrWatches('/ws')).toBeUndefined();
  });

  it('returns undefined when the worktree enumeration is unavailable', async () => {
    // cloneWorktreesOf swallows git failures into available:false — a
    // non-throwing detection failure must not read as "no watches".
    mocks.listAutofixPrWatches.mockResolvedValue({
      v: 1,
      available: false,
      watches: [],
    });
    mocks.readCronTasks.mockResolvedValue([cronTask()]);
    expect(await collectActivePrWatches('/ws')).toBeUndefined();
  });

  it('returns undefined when any state file is unreadable', async () => {
    // runStatus reports per-file read failures in unreadable[] without
    // throwing; a partial listing must not stamp watching:false on the
    // failed PR's active watch.
    mocks.listAutofixPrWatches.mockResolvedValue({
      v: 1,
      available: true,
      watches: [autofixWatch()],
      unreadable: [{ pr: 99, error: 'corrupt' }],
    });
    expect(await collectActivePrWatches('/ws')).toBeUndefined();
  });

  it('returns undefined when the cron file is unreadable (fail-open)', async () => {
    mocks.readCronTasks.mockRejectedValue(new Error('Malformed JSON'));
    expect(await collectActivePrWatches('/ws')).toBeUndefined();
  });
});
