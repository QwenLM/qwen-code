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

import {
  a1,
  a1JsonOnce,
  a1Once,
  a1VersionAtLeast,
  A1_MIN_VERSION,
  ensureAoneAuthenticated,
  parseA1Version,
} from './aone-client.js';

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

describe('parseA1Version / a1VersionAtLeast', () => {
  it('parses the `a1 --version` line', () => {
    expect(parseA1Version('a1 version 0.2.51 (2026-08-20)')).toEqual([
      0, 2, 51,
    ]);
    // The tag URL a1 prints beside the version carries the same triple —
    // the `version` anchor keeps the parse on the real version either way.
    expect(
      parseA1Version(
        'a1 version 0.1.90\nhttps://code.alibaba-inc.com/aone/a1/tags/v0.1.90',
      ),
    ).toEqual([0, 1, 90]);
  });

  it('returns undefined when no triple is present', () => {
    expect(parseA1Version('a1, the Aone CLI')).toBeUndefined();
    expect(parseA1Version('')).toBeUndefined();
  });

  it('anchors at the `version` token — a dotted build date before it does not supply the triple', () => {
    expect(
      parseA1Version('built 2026.08.20\na1 version 0.2.51 (2026-08-20)'),
    ).toEqual([0, 2, 51]);
    // The bare-triple fallback serves a variant that dropped the token.
    expect(parseA1Version('a1 0.1.90')).toEqual([0, 1, 90]);
  });

  it('the floor constant itself parses', () => {
    expect(parseA1Version(A1_MIN_VERSION)).toEqual([0, 1, 90]);
  });

  it('compares component-wise NUMERICALLY, not lexicographically', () => {
    const floor = parseA1Version(A1_MIN_VERSION)!;
    expect(a1VersionAtLeast([0, 1, 90], floor)).toBe(true); // the floor itself
    expect(a1VersionAtLeast([0, 1, 89], floor)).toBe(false);
    expect(a1VersionAtLeast([0, 1, 9], floor)).toBe(false); // lexicographic would say 9 > 90
    expect(a1VersionAtLeast([0, 2, 0], floor)).toBe(true);
    expect(a1VersionAtLeast([1, 0, 0], floor)).toBe(true);
    expect(a1VersionAtLeast([0, 10, 0], [0, 9, 0])).toBe(true); // lexicographic would say 10 < 9
  });
});

describe('ensureAoneAuthenticated — presence, version floor, auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses a version below the floor BEFORE any auth call, with an actionable upgrade message', () => {
    // The stale-install class the floor exists for: an a1 that runs and
    // answers whoami fine but lacks the comment-create flags — without the
    // floor it fails obscurely deep in a review. The refusal names the
    // found version, the floor, and where to upgrade; and it fires before
    // the login check (upgrading is the remedy for both).
    mockExecFileSync.mockReturnValueOnce('a1 version 0.1.89 (2026-07-01)\n');
    let message = '';
    try {
      ensureAoneAuthenticated();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/a1 0\.1\.89 is older than the 0\.1\.90/);
    expect(message).toMatch(/Upgrade the a1 CLI/);
    expect(message).toContain('code.alibaba-inc.com/aone/a1');
    // The probe is `a1 --version`, and the whoami call never ran.
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync.mock.calls[0][1]).toEqual(['--version']);
  });

  it('accepts the floor version itself and proceeds to the auth check', () => {
    mockExecFileSync
      .mockReturnValueOnce(`a1 version ${A1_MIN_VERSION} (2026-07-15)\n`)
      .mockReturnValueOnce('account: someone\n');
    expect(() => ensureAoneAuthenticated()).not.toThrow();
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(mockExecFileSync.mock.calls[1][1]).toEqual(['auth', 'whoami']);
  });

  it('accepts a newer version', () => {
    mockExecFileSync
      .mockReturnValueOnce('a1 version 0.2.51 (2026-08-20)\n')
      .mockReturnValueOnce('account: someone\n');
    expect(() => ensureAoneAuthenticated()).not.toThrow();
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it('an unreadable version warns and fails OPEN — the auth check still runs', () => {
    // A variant output format is not a stale install; refusing it would
    // brick a possibly-fine a1 this check merely cannot read.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    mockExecFileSync
      .mockReturnValueOnce('a1, the Aone CLI\n')
      .mockReturnValueOnce('account: someone\n');
    expect(() => ensureAoneAuthenticated()).not.toThrow();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('WARNING: could not read the a1 version'),
    );
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    stderrSpy.mockRestore();
  });

  it('a FAILED version probe (non-ENOENT) warns and fails OPEN too — the auth check still runs', () => {
    // Same fail-open class as an unparseable output, disclosed the same
    // way: an a1 whose --version crashed is not disproven, and the floor
    // must not brick it.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw new Error('Command failed: a1 --version\nsegfault\n');
      })
      .mockReturnValueOnce('account: someone\n');
    expect(() => ensureAoneAuthenticated()).not.toThrow();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('WARNING: the a1 version probe failed'),
    );
    // The CAUSE rides the warning, not the execFileSync preamble: a
    // `.split('\n')[0]` extraction would disclose the constant
    // "Command failed: a1 --version" and drop "segfault" — the pitfall
    // the whoami catch's comment documents.
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('segfault'));
    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Command failed: a1 --version'),
    );
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    stderrSpy.mockRestore();
  });

  it('a missing binary keeps the install message (the probe hits ENOENT first)', () => {
    const enoent = new Error('spawn a1 ENOENT') as NodeJS.ErrnoException;
    enoent.code = 'ENOENT';
    mockExecFileSync.mockImplementation(() => {
      throw enoent;
    });
    expect(() => ensureAoneAuthenticated()).toThrow(/a1 CLI not found on PATH/);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('a fresh-enough a1 that is not logged in still gets the login remedy', () => {
    mockExecFileSync
      .mockReturnValueOnce('a1 version 0.2.51 (2026-08-20)\n')
      .mockImplementationOnce(() => {
        throw new Error('Command failed: a1 auth whoami\nnot logged in\n');
      });
    expect(() => ensureAoneAuthenticated()).toThrow(/a1 auth login/);
  });
});
