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
  aoneWhoamiAccount,
  ensureAoneAuthenticated,
  execErrorCause,
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

describe('parseA1Version / a1VersionAtLeast (the version-floor helpers)', () => {
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

describe("execErrorCause — the transport's ONE cause extraction", () => {
  // Four catches pasted this extraction and the fallbacks drifted at copy
  // time (the two this PR added fell back to the preamble itself). The
  // shape knowledge lives here now: line zero is execFileSync's fixed
  // "Command failed: …" preamble, never the cause.
  it('returns the first non-empty line after the preamble', () => {
    expect(
      execErrorCause(new Error('Command failed: a1 --version\nsegfault\n')),
    ).toBe('segfault');
    // Blank lines between preamble and cause are skipped; the cause is
    // trimmed.
    expect(
      execErrorCause(new Error('Command failed: a1 x\n\n  the cause  \n')),
    ).toBe('the cause');
  });

  it('returns empty when no cause line exists — the preamble is never the cause', () => {
    // A killed child with no stderr leaves a single-line message; a
    // lines[0] fallback would disclose the fixed preamble AS the cause.
    expect(execErrorCause(new Error('Command failed: a1 --version'))).toBe('');
    expect(execErrorCause(new Error('spawnSync a1 ETIMEDOUT'))).toBe('');
  });

  it('tolerates a non-Error throw', () => {
    expect(execErrorCause('Command failed: a1 x\nboom')).toBe('boom');
  });

  it('a message WITHOUT the exec preamble IS the cause — the provider-throw shapes', () => {
    // mrView's no-mergeRequest refusal and a1Json's JSON.parse SyntaxError
    // are single-line diagnostics with no exec preamble; a slice(1) on them
    // discards the one line composeUrl's warning exists to surface. The
    // preamble-less message itself is the diagnostic.
    expect(
      execErrorCause(new Error('a1 returned no mergeRequest for #7 of g/p')),
    ).toBe('a1 returned no mergeRequest for #7 of g/p');
    const syntax = new SyntaxError(
      'Unexpected token \'<\', "<html>502 "... is not valid JSON',
    );
    expect(execErrorCause(syntax)).toBe(syntax.message);
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
    // A literal null PARSES, so it clears the SyntaxError arm; property
    // access on it then threw an untagged TypeError outside the shape
    // check — every accountless answer must throw the command-tagged
    // error, or the skip note names no command.
    ['null', 'a literal null answer'],
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

describe('ensureAoneAuthenticated — presence, version floor, and the account', () => {
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
      .mockReturnValueOnce('{"account":"someone"}\n');
    expect(() => ensureAoneAuthenticated()).not.toThrow();
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(mockExecFileSync.mock.calls[1][1]).toEqual([
      'auth',
      'whoami',
      '--format',
      'json',
    ]);
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

  it('a deadline-KILLED version probe gets the classified warning, not a raw extraction', () => {
    // The 120 s deadline kills the child: signal set, usually no stderr —
    // a single-line message no cause extraction can read. The whoami
    // catch classifies the identical anomaly ("timed out or was killed —
    // check the network / a1 install"); the probe arm must too, or the
    // one fail-open arm whose purpose is disclosure emits a raw
    // spawnSync line on exactly the degraded-machine state the gate
    // exists to diagnose.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const killed = Object.assign(new Error('spawnSync a1 ETIMEDOUT'), {
      signal: 'SIGTERM',
    });
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw killed;
      })
      .mockReturnValueOnce('account: someone\n');
    expect(() => ensureAoneAuthenticated()).not.toThrow();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('timed out or was killed'),
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('check the network / a1 install'),
    );
    // Fail-open: the auth check still ran.
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    stderrSpy.mockRestore();
  });

  it('a single-line probe failure warns without disclosing the preamble as the cause', () => {
    // No signal, no stderr cause line — the fallback must NOT be the
    // preamble itself (the copy-time drift round 3 found): the warning
    // names the failure class and nothing else.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw new Error('Command failed: a1 --version');
      })
      .mockReturnValueOnce('account: someone\n');
    expect(() => ensureAoneAuthenticated()).not.toThrow();
    expect(stderrSpy).toHaveBeenCalledWith(
      `WARNING: the a1 version probe failed — the review provider ` +
        `requires a1 >= ${A1_MIN_VERSION}; continuing without a floor ` +
        `ruling.\n`,
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

  it('a present-but-unexecutable a1 (EACCES/ENOEXEC) gets the install remedy, not the login blame', () => {
    // chmod a-x / corrupt install: `a1 --version` throws single-line
    // `spawnSync a1 EACCES`. Not ENOENT — before the presence arm widened
    // it fell open into whoami, which blamed the login: the one remedy a
    // permissions problem cannot be fixed by, against the "three failure
    // states, three distinct remedies" contract.
    for (const code of ['EACCES', 'ENOEXEC']) {
      mockExecFileSync.mockClear();
      const notRunnable = Object.assign(new Error(`spawnSync a1 ${code}`), {
        code,
      });
      mockExecFileSync.mockImplementation(() => {
        throw notRunnable;
      });
      expect(() => ensureAoneAuthenticated()).toThrow(
        /a1 CLI not found on PATH/,
      );
      // One spawn: the presence arm rules BEFORE any whoami blame.
      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    }
  });

  it('a fresh-enough a1 that is not logged in still gets the login remedy', () => {
    mockExecFileSync
      .mockReturnValueOnce('a1 version 0.2.51 (2026-08-20)\n')
      .mockImplementationOnce(() => {
        throw new Error(
          'Command failed: a1 auth whoami --format json\nnot logged in\n',
        );
      });
    expect(() => ensureAoneAuthenticated()).toThrow(/a1 auth login/);
  });

  // The account contract #9629 added — the gate returns the authenticated
  // account for presubmit's self-MR comparison. Each dispatches the
  // version probe and the whoami by argv, so the floor and the account
  // read stay one gate.
  const versionThen = (whoamiOut: string) =>
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) =>
      args[0] === '--version' ? 'a1 version 0.2.51 (2026-08-20)\n' : whoamiOut,
    );

  it('returns the account field of ONE `a1 auth whoami --format json`', () => {
    versionThen('{"account":"wenshao"}\n');
    expect(ensureAoneAuthenticated()).toBe('wenshao');
    // Pin the FULL argv and the spawn COUNT: presubmit's self-PR comparison
    // reads this account off the gate, so a botched spread here would exec
    // a different whoami shape — and a restored plain-whoami gate beside
    // the JSON read would double the spawn — without any other test
    // noticing (aone.test.ts mocks the module wholesale). The version
    // probe precedes the whoami (the floor), hence calls[1].
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    const args = mockExecFileSync.mock.calls[1][1] as string[];
    expect(args).toEqual(['auth', 'whoami', '--format', 'json']);
  });

  it('returns empty (fail-soft) when whoami names no account', () => {
    // An empty account makes presubmit's self-PR comparison fail soft —
    // isSelfPr false — exactly like the GitHub path's empty login; a throw
    // here would kill the whole presubmit over a shape quirk.
    versionThen('{}\n');
    expect(ensureAoneAuthenticated()).toBe('');
    versionThen('{"account":42}\n');
    expect(ensureAoneAuthenticated()).toBe('');
  });

  it('trims the account — parity with gh.ts currentUser().trim()', () => {
    // A padded account would silently miss the self-PR comparison against a
    // clean MR author (fail-open on exactly the protection this exists for).
    versionThen('{"account":"  wenshao\\n"}\n');
    expect(ensureAoneAuthenticated()).toBe('wenshao');
  });

  it('returns empty when an EXEC-successful answer does not parse', () => {
    // The exec's success IS the auth proof; an unreadable account degrades
    // the self-PR comparison to fail-soft instead of throwing the run with
    // no report — the pre-merge second whoami detonated on exactly this
    // anomaly class, after the plain-format gate had waved it through.
    versionThen('user: wenshao\n');
    expect(ensureAoneAuthenticated()).toBe('');
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });
});
