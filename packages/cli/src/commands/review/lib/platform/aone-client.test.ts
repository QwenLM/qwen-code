/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

// Mock execFileSync before aone-client.ts is loaded — same shape as
// gh.test.ts: vi.mock is hoisted above all imports.
const mockExecFileSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  default: { execFileSync: mockExecFileSync },
  execFileSync: mockExecFileSync,
}));

import { a1, a1JsonOnce, a1Once, aoneWhoamiAccount } from './aone-client.js';

function transientError(): Error {
  // The message shape execFileSync produces, carrying a transient marker
  // the retry policy recognises.
  return new Error(
    'Command failed: a1 repo mr comment create\nHTTP 502 Bad Gateway\n',
  );
}

describe('aone-client write discipline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a1Once NEVER retries — a transient failure after an accepted write must not double-post', () => {
    // The read path retries this exact error class; a write must surface
    // the first failure instead, or a retry behind a swallowed 502 posts
    // the same comment twice.
    mockExecFileSync.mockImplementation(() => {
      throw transientError();
    });
    expect(() =>
      a1Once('repo', 'mr', 'comment', 'create', '--mr', '7'),
    ).toThrow();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('a1JsonOnce parses the write result and appends --format json', () => {
    mockExecFileSync.mockReturnValue('{"id": 42}\n');
    const out = a1JsonOnce<{ id: number }>(
      'repo',
      'mr',
      'comment',
      'create',
      '--mr',
      '7',
    );
    expect(out).toEqual({ id: 42 });
    // Pin the FULL argv — the caller args AND the appended --format tail.
    // A botched rest-parameter spread would exec `a1` with no
    // --mr/--message and die only at the irreversible write itself; no
    // other test observes this passthrough (aone.test.ts mocks the module
    // wholesale).
    const args = mockExecFileSync.mock.calls[0][1] as string[];
    expect(args).toEqual([
      'repo',
      'mr',
      'comment',
      'create',
      '--mr',
      '7',
      '--format',
      'json',
    ]);
  });

  it('a1JsonOnce returns undefined (not a throw) when an ACCEPTED write answers unparseably', () => {
    // The exec SUCCEEDED, so the write is accepted. A result that fails to
    // parse is a platform anomaly, not a failed post — throwing would let a
    // caller count the accepted comment as unposted and re-run it into a
    // duplicate. undefined = "landed, result unreadable".
    mockExecFileSync.mockReturnValue('this is not json\n');
    const out = a1JsonOnce<{ id: number }>(
      'repo',
      'mr',
      'comment',
      'create',
      '--mr',
      '7',
    );
    expect(out).toBeUndefined();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('a1JsonOnce still PROPAGATES an exec failure (the write genuinely failed)', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('Command failed: a1 repo mr comment create\nboom\n');
    });
    expect(() =>
      a1JsonOnce('repo', 'mr', 'comment', 'create', '--mr', '7'),
    ).toThrow();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('a1JsonOnce NEVER retries a TRANSIENT error either — the comment-write invariant', () => {
    // a1JsonOnce is the helper every comment write rides (createMrComment).
    // The "a write is never retried" invariant must hold for IT, not only
    // for a1Once: routing it through the retrying path would survive every
    // other test while double-posting a finding after a 502 that arrived
    // once the server had accepted the create.
    mockExecFileSync.mockImplementation(() => {
      throw new Error(
        'Command failed: a1 repo mr comment create\nHTTP 502 Bad Gateway\n',
      );
    });
    expect(() =>
      a1JsonOnce('repo', 'mr', 'comment', 'create', '--mr', '7'),
    ).toThrow();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('a1 (the read path) surfaces a NON-transient error at once', () => {
    // Only the transient class retries; anything else must not pay the
    // delay (and this exercises the shared exec path without its sleep).
    mockExecFileSync.mockImplementation(() => {
      throw new Error('Command failed: a1 repo mr view 7\nnot found\n');
    });
    expect(() => a1('repo', 'mr', 'view', '7')).toThrow();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });
});

describe('a1 (the read path) transient-error retry — the POSITIVE side', () => {
  // Without a succeed-after-retry test, deleting the retry entirely
  // (execA1(args, false), or dropping the `retry &&` conjunct) leaves the
  // suite green — silently stripping the read path's 502/reset absorption.
  // Mirrors the four-test transient block in gh.test.ts, Atomics.wait
  // spied so the delay is skipped.
  let atomsWaitSpy: MockInstance<typeof Atomics.wait>;

  beforeEach(() => {
    vi.clearAllMocks();
    atomsWaitSpy = vi.spyOn(Atomics, 'wait').mockReturnValue('ok');
  });

  afterEach(() => {
    atomsWaitSpy.mockRestore();
  });

  it('retries a transient HTTP 502 and succeeds on the second attempt', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw transientError();
      })
      .mockReturnValueOnce('{"ok":true}\n');

    const result = a1('repo', 'mr', 'view', '7');
    expect(result).toBe('{"ok":true}');
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('retrying in 3000ms'),
    );
    stderrSpy.mockRestore();
  });

  it('exhausts MAX_RETRIES on a persistent transient error, then throws', () => {
    mockExecFileSync.mockImplementation(() => {
      throw transientError();
    });
    expect(() => a1('repo', 'mr', 'view', '7')).toThrow();
    expect(mockExecFileSync).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});

describe('aoneWhoamiAccount', () => {
  // cleanup's Aone audit filters the comment list by this account. The
  // tripwire invariant: an unreadable account THROWS — returning a blank
  // would match no comment, and an audit that matches nothing reads
  // exactly like a clean window (off state indistinguishable from
  // all-clear). Every caller mock in cleanup.test.ts stubs this module, so
  // the throw semantics are pinned HERE, at the seam that owns them.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the account field and rides the shared JSON seam', () => {
    mockExecFileSync.mockReturnValue('{"account": "bob"}\n');
    expect(aoneWhoamiAccount()).toBe('bob');
    const args = mockExecFileSync.mock.calls[0][1] as string[];
    expect(args).toEqual(['auth', 'whoami', '--format', 'json']);
  });

  it.each([
    ['{}', 'no account field'],
    ['{"account": ""}', 'empty account'],
    ['{"account": "  "}', 'blank account'],
    ['{"account": 5}', 'non-string account'],
  ])('throws the named error on %s (%s)', (raw) => {
    mockExecFileSync.mockReturnValue(raw);
    expect(() => aoneWhoamiAccount()).toThrow(
      'a1 auth whoami returned no account',
    );
  });

  it('throws the command-tagged shape error when the answer is unparseable', () => {
    // The raw SyntaxError named no command; the skip note must say WHAT
    // failed, mirroring a1CommentList's unexpected-shape standard.
    mockExecFileSync.mockReturnValue('not json');
    expect(() => aoneWhoamiAccount()).toThrow(
      'a1 auth whoami returned an unexpected shape',
    );
  });
});
