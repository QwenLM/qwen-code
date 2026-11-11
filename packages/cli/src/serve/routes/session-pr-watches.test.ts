/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAutofixPrWatches: vi.fn(),
  readCronTasks: vi.fn(),
  fetchRemoteWebUrl: vi.fn(),
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

vi.mock(
  '@qwen-code/qwen-code-core/utils/github-prs.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/utils/github-prs.js')
      >();
    return { ...actual, fetchRemoteWebUrl: mocks.fetchRemoteWebUrl };
  },
);

import {
  collectActivePrWatches,
  parseVerifyPrWatchGate,
  prWatchKey,
  shellWords,
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
  mocks.fetchRemoteWebUrl.mockReset();
  mocks.listAutofixPrWatches.mockResolvedValue({
    v: 1,
    available: true,
    watches: [],
  });
  mocks.readCronTasks.mockResolvedValue([]);
  mocks.fetchRemoteWebUrl.mockResolvedValue('https://github.com/acme/widgets');
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

describe('shellWords', () => {
  it('keeps quoted whitespace as one word', () => {
    expect(shellWords("node x.mjs --state-root '/tmp/pr 16772' 42")).toEqual([
      'node',
      'x.mjs',
      '--state-root',
      '/tmp/pr 16772',
      '42',
    ]);
  });

  it('honors double-quote escapes and backslash-newline continuations', () => {
    expect(shellWords('node "a\\"b" c')).toEqual(['node', 'a"b', 'c']);
    expect(shellWords('node \\\n42 --repo a/b')).toEqual([
      'node',
      '42',
      '--repo',
      'a/b',
    ]);
    expect(shellWords('node a\\ b')).toEqual(['node', 'a b']);
  });

  it('drops continuation characters without starting an empty word', () => {
    // Indentation on the continued line is a word separator, not an empty
    // argv element between --repo and its value.
    expect(shellWords('node x.mjs --repo \\\n  acme/widgets')).toEqual([
      'node',
      'x.mjs',
      '--repo',
      'acme/widgets',
    ]);
    expect(shellWords('node ac\\\nme/widgets')).toEqual([
      'node',
      'acme/widgets',
    ]);
  });

  it('ends argv at a word-start comment and keeps mid-word # literal', () => {
    expect(
      shellWords('node x.mjs 42 # omit --check for the standing watch'),
    ).toEqual(['node', 'x.mjs', '42']);
    expect(shellWords('node x.mjs a#b')).toEqual(['node', 'x.mjs', 'a#b']);
    expect(shellWords("node x.mjs '#check'")).toEqual([
      'node',
      'x.mjs',
      '#check',
    ]);
  });

  it('returns undefined for unquoted glob and brace expansion characters', () => {
    expect(shellWords('node x.mjs --repo acme/*')).toBeUndefined();
    expect(shellWords('node x.mjs 4?')).toBeUndefined();
    expect(shellWords('node x.mjs [ab]')).toBeUndefined();
    expect(shellWords('node x.mjs {a,b}')).toBeUndefined();
    expect(shellWords("node x.mjs 'acme/*'")).toEqual([
      'node',
      'x.mjs',
      'acme/*',
    ]);
  });

  it('splits only on shell IFS, keeping other Unicode whitespace literal', () => {
    // NBSP / CR are not shell word separators: splitting on them would invent
    // an argv the real gate never sees (a false live watch).
    expect(shellWords('node x.mjs --repo acme/widgets\u00A042')).toEqual([
      'node',
      'x.mjs',
      '--repo',
      'acme/widgets\u00A042',
    ]);
    expect(shellWords('node x.mjs\ra/b')).toEqual(['node', 'x.mjs\ra/b']);
    expect(shellWords('node\tx.mjs 42')).toEqual(['node', 'x.mjs', '42']);
  });

  it('returns undefined when argv cannot be determined', () => {
    expect(shellWords("node 'unterminated")).toBeUndefined();
    expect(shellWords('node "unterminated')).toBeUndefined();
    expect(shellWords('node $HOME/x.mjs')).toBeUndefined();
    expect(shellWords('node `which x`')).toBeUndefined();
    expect(shellWords('node "a$HOME"')).toBeUndefined();
    expect(shellWords('node x.mjs | tee log')).toBeUndefined();
    expect(shellWords('node x.mjs > out')).toBeUndefined();
    expect(shellWords('node x.mjs\nnode y.mjs')).toBeUndefined();
    expect(shellWords('node trailing\\')).toBeUndefined();
  });
});

describe('parseVerifyPrWatchGate', () => {
  it('reads the PR and repo from the skill-contract gate', () => {
    expect(
      parseVerifyPrWatchGate(
        'node /clone/scripts/verify-pr-watch-gate.mjs 42 --repo acme/widgets --cli /bin/qwen',
      ),
    ).toEqual({ kind: 'watch', repo: 'acme/widgets', pr: 42 });
  });

  it('accepts a quoted script path and varied flag order', () => {
    expect(
      parseVerifyPrWatchGate(
        'node "/path with space/scripts/verify-pr-watch-gate.mjs" --cli /bin/qwen --repo acme/widgets 42',
      ),
    ).toEqual({ kind: 'watch', repo: 'acme/widgets', pr: 42 });
  });

  it('consumes value flags like the gate script parseArgs', () => {
    // --state-root eats the numeric value; the PR is the positional 42.
    expect(
      parseVerifyPrWatchGate(
        'node /clone/scripts/verify-pr-watch-gate.mjs --state-root 2026 42 --repo acme/widgets --cli /bin/qwen',
      ),
    ).toEqual({ kind: 'watch', repo: 'acme/widgets', pr: 42 });
  });

  it('reads the real PR when a quoted flag value contains digits and spaces', () => {
    // The shell passes '/tmp/pr 16772' as ONE argument; a whitespace split
    // would misread 16772 as the PR and stamp the real PR watching:false.
    expect(
      parseVerifyPrWatchGate(
        "node scripts/verify-pr-watch-gate.mjs --state-root '/tmp/pr 16772' 42 --repo acme/widgets --cli /bin/echo",
      ),
    ).toEqual({ kind: 'watch', repo: 'acme/widgets', pr: 42 });
  });

  it('reads a gate written with backslash-newline continuations', () => {
    expect(
      parseVerifyPrWatchGate(
        'node scripts/verify-pr-watch-gate.mjs \\\n42 --repo acme/widgets',
      ),
    ).toEqual({ kind: 'watch', repo: 'acme/widgets', pr: 42 });
  });

  it('reads a continued --repo value with indentation on the next line', () => {
    // Reviewer repro: the continuation must not push an empty word that
    // --repo then consumes, turning a live watch into a known "no watch".
    expect(
      parseVerifyPrWatchGate(
        'node scripts/verify-pr-watch-gate.mjs 42 --cli /bin/echo --repo \\\n  acme/widgets',
      ),
    ).toEqual({ kind: 'watch', repo: 'acme/widgets', pr: 42 });
  });

  it('ignores a trailing comment, including one that names --check', () => {
    // Reviewer repro: the shell never passes the comment to the script, so
    // a --check inside it must not read as a one-shot probe invocation.
    expect(
      parseVerifyPrWatchGate(
        'node scripts/verify-pr-watch-gate.mjs 42 --repo acme/widgets --cli /bin/echo # omit --check for the standing watch',
      ),
    ).toEqual({ kind: 'watch', repo: 'acme/widgets', pr: 42 });
  });

  it('mirrors the script rejecting an empty first positional', () => {
    // Number('') is 0 — the script throws on it, so the gate never fires
    // and detection must not skip ahead to the later 42.
    expect(
      parseVerifyPrWatchGate(
        'node scripts/verify-pr-watch-gate.mjs "" 42 --repo acme/widgets',
      ),
    ).toEqual({ kind: 'none' });
  });

  it('returns unknown for a gate whose repo is a glob', () => {
    // The shell could expand acme/* to the real repo — a literal read
    // would confirm "no watch" on a gate that actually fires.
    expect(
      parseVerifyPrWatchGate(
        'node scripts/verify-pr-watch-gate.mjs 42 --repo acme/*',
      ),
    ).toEqual({ kind: 'unknown' });
  });

  it('confirms no watch for a gate that only names the script in a comment', () => {
    // The shell runs nothing here; a whole-workspace fail-open on this
    // determinable none would silently disable the gate for every session.
    expect(
      parseVerifyPrWatchGate(
        '# node /clone/scripts/verify-pr-watch-gate.mjs 42 --repo acme/widgets',
      ),
    ).toEqual({ kind: 'none' });
    expect(
      parseVerifyPrWatchGate(
        'node /clone/scripts/other.mjs 42 # verify-pr-watch-gate.mjs',
      ),
    ).toEqual({ kind: 'none' });
  });

  it('does not read a lookalike or embedded script name as the executed probe', () => {
    // suffix-lookalike: a different script whose name ends with the probe's.
    expect(
      parseVerifyPrWatchGate(
        'node /tmp/not-verify-pr-watch-gate.mjs 42 --repo acme/widgets',
      ),
    ).toEqual({ kind: 'unknown' });
    // script-in-quoted-other: the name is another command's argument.
    expect(
      parseVerifyPrWatchGate(
        'node /tmp/other.mjs "verify-pr-watch-gate.mjs" 42 --repo acme/widgets',
      ),
    ).toEqual({ kind: 'unknown' });
    // A quoted interpreter payload could still execute the probe.
    expect(
      parseVerifyPrWatchGate(
        "bash -c 'node scripts/verify-pr-watch-gate.mjs 42 --repo acme/widgets'",
      ),
    ).toEqual({ kind: 'unknown' });
  });

  it('reads the executed script word in direct and assignment-prefixed gates', () => {
    expect(
      parseVerifyPrWatchGate(
        './scripts/verify-pr-watch-gate.mjs 42 --repo acme/widgets',
      ),
    ).toEqual({ kind: 'watch', repo: 'acme/widgets', pr: 42 });
    expect(
      parseVerifyPrWatchGate(
        'GH_HOST=ghe.corp node scripts/verify-pr-watch-gate.mjs 42 --repo acme/widgets',
      ),
    ).toEqual({ kind: 'watch', repo: 'acme/widgets', pr: 42 });
    // A node flag before the script is a shape we do not model: fail open.
    expect(
      parseVerifyPrWatchGate(
        'node --inspect scripts/verify-pr-watch-gate.mjs 42 --repo acme/widgets',
      ),
    ).toEqual({ kind: 'unknown' });
  });

  it('reads a probe name assembled by a continuation or across a quote boundary', () => {
    // The raw text does not contain the contiguous script name, but the
    // shell joins it into the executed word — a raw-text pre-check would
    // misread these live watches as a confirmed none.
    expect(
      parseVerifyPrWatchGate(
        'node /clone/scripts/verify-pr-watch-\\\ngate.mjs 42 --repo acme/widgets --cli /bin/qwen',
      ),
    ).toEqual({ kind: 'watch', repo: 'acme/widgets', pr: 42 });
    expect(
      parseVerifyPrWatchGate(
        'node "/clone/scripts/verify-pr-watch-"gate.mjs 42 --repo acme/widgets',
      ),
    ).toEqual({ kind: 'watch', repo: 'acme/widgets', pr: 42 });
  });

  it('reads an absolute interpreter path and an in-quote continued value', () => {
    expect(
      parseVerifyPrWatchGate(
        '/usr/local/bin/node scripts/verify-pr-watch-gate.mjs 42 --repo acme/widgets',
      ),
    ).toEqual({ kind: 'watch', repo: 'acme/widgets', pr: 42 });
    expect(
      parseVerifyPrWatchGate(
        'node scripts/verify-pr-watch-gate.mjs 42 --repo "acme/\\\nwidgets"',
      ),
    ).toEqual({ kind: 'watch', repo: 'acme/widgets', pr: 42 });
  });

  it('returns unknown when the gate names the script but argv is undeterminable', () => {
    expect(
      parseVerifyPrWatchGate(
        "node scripts/verify-pr-watch-gate.mjs '/tmp/pr 16772 42 --repo acme/widgets",
      ),
    ).toEqual({ kind: 'unknown' });
    expect(
      parseVerifyPrWatchGate(
        'node scripts/verify-pr-watch-gate.mjs "$PR" --repo acme/widgets',
      ),
    ).toEqual({ kind: 'unknown' });
    expect(
      parseVerifyPrWatchGate(
        'node scripts/verify-pr-watch-gate.mjs 42 --repo acme/widgets | tee log',
      ),
    ).toEqual({ kind: 'unknown' });
  });

  it('confirms no watch for a gate whose first positional is not a positive integer', () => {
    // The script throws on 'foo' (NaN) — the gate never runs, so it is no
    // watch; detection must not skip ahead to the later 42.
    expect(
      parseVerifyPrWatchGate(
        'node /clone/scripts/verify-pr-watch-gate.mjs foo 42 --repo acme/widgets',
      ),
    ).toEqual({ kind: 'none' });
  });

  it('confirms no watch for one-shot probe invocations (check/claim/release)', () => {
    for (const flag of ['--check', '--claim', '--release']) {
      expect(
        parseVerifyPrWatchGate(
          `node /clone/scripts/verify-pr-watch-gate.mjs 42 ${flag} --repo acme/widgets`,
        ),
      ).toEqual({ kind: 'none' });
    }
  });

  it('confirms no watch for gates without the script, the number, or the repo', () => {
    expect(parseVerifyPrWatchGate(undefined)).toEqual({ kind: 'none' });
    expect(
      parseVerifyPrWatchGate('node /clone/scripts/other.mjs 42 --repo a/b'),
    ).toEqual({ kind: 'none' });
    expect(
      parseVerifyPrWatchGate(
        'node /clone/scripts/verify-pr-watch-gate.mjs --repo acme/widgets',
      ),
    ).toEqual({ kind: 'none' });
    expect(
      parseVerifyPrWatchGate(
        'node /clone/scripts/verify-pr-watch-gate.mjs 42 --cli /bin/qwen',
      ),
    ).toEqual({ kind: 'none' });
    expect(
      parseVerifyPrWatchGate(
        'node /clone/scripts/verify-pr-watch-gate.mjs 42 --repo not-a-repo',
      ),
    ).toEqual({ kind: 'none' });
  });

  it('does not read an autofix-pr snapshot gate as a verify-pr watch', () => {
    expect(
      parseVerifyPrWatchGate(
        '"${QWEN_CODE_CLI:-qwen}" autofix-pr snapshot 42 --gate --repo acme/widgets --host github.com --session s',
      ),
    ).toEqual({ kind: 'none' });
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

  it('keys each session only its own watches (per-session attribution)', async () => {
    // Swapping the session attribution would hand one session's watch to the
    // other and gate the wrong bindings.
    const OTHER = '00000000-0000-4000-8000-00000000000b';
    mocks.readCronTasks.mockResolvedValue([
      cronTask({ id: 't-a', sessionId: SESSION }),
      cronTask({
        id: 't-b',
        sessionId: OTHER,
        gate: 'node scripts/verify-pr-watch-gate.mjs 7 --repo acme/gadgets --cli /bin/qwen',
      }),
    ]);
    const watches = await collectActivePrWatches('/ws');
    expect(watches?.get(SESSION)).toEqual(
      new Set(['github.com/acme/widgets#42']),
    );
    expect(watches?.get(OTHER)).toEqual(new Set(['github.com/acme/gadgets#7']));
  });

  it('collects a watch whose gate ends in a comment naming --check', async () => {
    // The reviewer repro end to end: a known-empty map here would stamp
    // watching:false on the live watch and drop its events under the gate.
    mocks.readCronTasks.mockResolvedValue([
      cronTask({
        gate: 'node scripts/verify-pr-watch-gate.mjs 42 --repo acme/widgets --cli /bin/echo # omit --check for the standing watch',
      }),
    ]);
    const watches = await collectActivePrWatches('/ws');
    expect(watches?.get(SESSION)).toEqual(
      new Set(['github.com/acme/widgets#42']),
    );
  });

  it('keys a verify-pr watch with the workspace remote host (GHE)', async () => {
    // A hardcoded github.com key would never match the ghe.corp binding:
    // watching:false on a live watch is a delivery ban, not fail-open.
    mocks.fetchRemoteWebUrl.mockResolvedValue('https://ghe.corp/acme/widgets');
    mocks.readCronTasks.mockResolvedValue([cronTask()]);
    const watches = await collectActivePrWatches('/ws');
    expect(watches?.get(SESSION)).toEqual(
      new Set(['ghe.corp/acme/widgets#42']),
    );
  });

  it('fails open when a verify-pr watch needs keying but the remote is unresolvable', async () => {
    mocks.fetchRemoteWebUrl.mockResolvedValue(undefined);
    mocks.readCronTasks.mockResolvedValue([cronTask()]);
    expect(await collectActivePrWatches('/ws')).toBeUndefined();
  });

  it('does not resolve the remote when no verify-pr watch needs keying', async () => {
    mocks.readCronTasks.mockResolvedValue([cronTask({ gate: 'echo hello' })]);
    const watches = await collectActivePrWatches('/ws');
    expect(watches?.size).toBe(0);
    expect(mocks.fetchRemoteWebUrl).not.toHaveBeenCalled();
  });

  it('keeps a defined map when a task gate only names the script in a comment', async () => {
    // unknown here would fail the WHOLE workspace open and silently disable
    // the gate for every review/verify session in the clone.
    mocks.readCronTasks.mockResolvedValue([
      cronTask(),
      cronTask({
        id: 't-commented',
        gate: '# node scripts/verify-pr-watch-gate.mjs 7 --repo acme/other',
      }),
    ]);
    const watches = await collectActivePrWatches('/ws');
    expect(watches?.get(SESSION)).toEqual(
      new Set(['github.com/acme/widgets#42']),
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

  it('fails open when any task gate names the script but is unparseable', async () => {
    // An undeterminable argv must not become a known "no watch" map: the
    // real PR would be stamped watching:false and lose its events.
    mocks.readCronTasks.mockResolvedValue([
      cronTask(),
      cronTask({
        id: 't-unknown',
        gate: 'node scripts/verify-pr-watch-gate.mjs "$PR" --repo acme/widgets',
      }),
    ]);
    expect(await collectActivePrWatches('/ws')).toBeUndefined();
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
