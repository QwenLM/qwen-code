/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The refusal is the feature. Every test here that matters is a test that the
// command did NOT write to GitHub — so `gh` is mocked and asserted against
// rather than merely stubbed, and a call to it is a failure unless the test
// says otherwise.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  recordedSeverityFloor,
  reviewWriteAuthorization,
} from './lib/authorization.js';
import { join } from 'node:path';
import { promptRecordDir, briefPath } from './lib/prompt-record.js';
import { parseLedger } from './lib/ledger.js';

const ghMock = vi.hoisted(() =>
  vi.fn((_payload: string, ..._rest: string[]) => ''),
);
const ghViewMock = vi.hoisted(() => vi.fn((..._args: string[]) => ''));
// The Aone write seam — an Aone-routed post must reach THIS, never a real
// `a1` (a platform write is never a test fixture), and never gh.
const aoneSubmitMock = vi.hoisted(() => vi.fn());
vi.mock('./lib/gh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/gh.js')>();
  return {
    ...actual,
    ghWithInput: ghMock,
    gh: ghViewMock,
    setGhHost: vi.fn(),
  };
});
vi.mock('./lib/platform/aone.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./lib/platform/aone.js')>();
  return {
    ...actual,
    submitAoneReview: aoneSubmitMock,
  };
});

// The Aone detection probes the platform (cwd origin via
// node:child_process) when no host is passed; pin it to GitHub so these
// GitHub tests neither spawn a real `git` in the vitest cwd nor couple to the
// machine's actual clone origin. importOriginal keeps the real exports
// (isAoneHost, now imported by parse-args) available.
vi.mock('./lib/platform/registry.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./lib/platform/registry.js')>();
  return { ...actual, getPlatformReader: () => ({ kind: 'github' }) };
});

// The routing's cwd probe is a direct gitOpt('remote','get-url','origin')
// from ./lib/git.js — the registry reader above is NOT consulted by
// submit. Pin the probe to "no origin" so these tests spawn no real
// `git` in the vitest cwd and never couple to the machine's actual clone
// origin (on a checkout whose origin is a canonical Aone host the
// unpinned probe would flip `aoneWrite` under tests whose code under
// test is correct). Cells that need a live probe steer this mock.
const gitOptMock = vi.hoisted(() => vi.fn(() => null));
vi.mock('./lib/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/git.js')>();
  return { ...actual, gitOpt: gitOptMock };
});

const writeStdoutSpy = vi.hoisted(() => vi.fn((_line: string) => {}));
const writeStderrSpy = vi.hoisted(() => vi.fn((_line: string) => {}));
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: writeStdoutSpy,
  writeStderrLine: writeStderrSpy,
}));
vi.mock('../../utils/version.js', () => ({
  getCliVersion: vi.fn().mockResolvedValue('0.21.2'),
}));

// The handler reads `review.attribution` / `review.comment` from the
// operator's real settings.json — a developer running with either set would
// watch the assertions below redden through no fault of the code. Pin the
// values these tests read; the attribution-off path is covered by calling
// runSubmit directly.
const reviewSettingsMock = vi.hoisted(() =>
  vi.fn((): Record<string, unknown> => ({ attribution: true })),
);
vi.mock('../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settings.js')>();
  return {
    ...actual,
    // The production call carries `{ skipWorkspaceSettings: true }` — these
    // policy keys resolve from operator scopes only. A caller that forgets
    // the flag reads the workspace-polluted view below instead, and the
    // assertions redden: a repository's `.qwen/settings.json` must not
    // control them.
    loadSettings: vi.fn((...callArgs: unknown[]) => {
      const opts = callArgs[1] as
        | { skipWorkspaceSettings?: boolean }
        | undefined;
      return {
        merged: {
          review: opts?.skipWorkspaceSettings
            ? reviewSettingsMock()
            : { attribution: false, comment: true, effort: 'low' },
        },
      };
    }),
  };
});

const { runSubmit, submitCommand } = await import('./submit.js');

let dir: string;
let savedCwd: string;
let savedSessionId: string | undefined;
let savedGhHost: string | undefined;

/**
 * The payload as it is now: findings and states. No verdict.
 *
 * `event` and `body` used to be here, transcribed by the model out of
 * `compose-review`'s output — a decision the CLI had already made, copied into a
 * document the model writes. `submit` composes them itself now, so there is
 * nothing to copy and nothing to forge. A payload that still carries them is
 * refused, and the test for that is below.
 */
const REVIEW = {
  commit_id: 'abc123',
  comments: [] as unknown[],
  state: { suggestionsDiscarded: 1, modelId: 'qwen3.7-max' },
};

/**
 * The Aone anchor gate refuses an Aone post whose captured diff is absent
 * (the platform validates nothing, so the write path must hold the diff —
 * docs/design/2026-08-21-review-aone-removed-line-anchoring.md). Routing
 * tests below post through the gate, so each supplies the convention file
 * for its target number. The content is minimal — these payloads carry no
 * comments — but real, so the gate parses it.
 */
const CAPTURED_DIFF_FIXTURE = [
  'diff --git a/src/route.ts b/src/route.ts',
  'index 1111111..2222222 100644',
  '--- a/src/route.ts',
  '+++ b/src/route.ts',
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+c',
  ' d',
  '',
].join('\n');

function writeCapturedDiff(pr: number): string {
  const dirPath = join('.qwen', 'tmp');
  mkdirSync(dirPath, { recursive: true });
  const p = join(dirPath, `qwen-review-pr-${pr}-diff.txt`);
  writeFileSync(p, CAPTURED_DIFF_FIXTURE, 'utf8');
  return p;
}

/** Write a file under the fixture dir and return its path. */
function file(name: string, content: unknown): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    typeof content === 'string' ? content : JSON.stringify(content),
  );
  return p;
}

let seq = 0;
/** A fresh file per call: the default must never clobber a payload a test wrote. */
function args(over: Record<string, unknown> = {}) {
  return {
    pr: 6771,
    repo: 'QwenLM/qwen-code',
    review: file(`review-${seq++}.json`, REVIEW),
    // Real runs always carry a recording (writeSkillArgs at /review start),
    // and it is the platform evidence the write gate binds. Give the
    // default one a github.com host WITHOUT --comment: the fast path then
    // has host evidence (posts proceed), while slow-path refusal tests
    // still refuse (no --comment). Tests that override `skillArgs` or
    // `userAuthorized` steer their own shape.
    skillArgs: file(
      `skill-args-${seq++}.txt`,
      'https://github.com/QwenLM/qwen-code/pull/6771',
    ),
    userAuthorized: false,
    dryRun: false,
    ...over,
  } as never;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'review-submit-'));
  // Run from the per-test fixture dir: the anchor gate's captured diff
  // and the slow-path recordings are seeded at cwd-relative convention
  // paths, and seeding them in the REAL vitest cwd would overwrite (and
  // cleanup-delete) a same-numbered live capture sitting there.
  savedCwd = process.cwd();
  process.chdir(dir);
  ghMock.mockClear();
  ghViewMock.mockClear();
  aoneSubmitMock.mockClear();
  aoneSubmitMock.mockReturnValue({
    inlineCommentIds: [],
    postedInline: 0,
    summaryPosted: true,
    approved: false,
    // Verified stable — the ordinary success shape (undefined would mean
    // "re-read failed" and trip the could-not-re-verify disclosure).
    headMovedDuringPost: false,
    webUrl: '',
  });
  writeStdoutSpy.mockClear();
  writeStderrSpy.mockClear();
  reviewSettingsMock.mockReturnValue({ attribution: true });
  process.exitCode = undefined;
  savedSessionId = process.env['QWEN_CODE_SESSION_ID'];
  delete process.env['QWEN_CODE_SESSION_ID'];
  // Belt and braces: the write routing never consults the ambient GH_HOST
  // (submit's platform gate documents this, and the registry reader above
  // is pinned to github) — but the platform gate's ambient-env arm still
  // reads it (refusing a flagless gh post when it names a canonical Aone
  // host), so keep the org's standard Aone-family intranet export out of
  // these tests anyway.
  savedGhHost = process.env['GH_HOST'];
  delete process.env['GH_HOST'];
});
afterEach(() => {
  process.chdir(savedCwd);
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
  if (savedSessionId === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
  else process.env['QWEN_CODE_SESSION_ID'] = savedSessionId;
  if (savedGhHost === undefined) delete process.env['GH_HOST'];
  else process.env['GH_HOST'] = savedGhHost;
});

describe('authorization — URL-shaped host and repo binding at the submit call site', () => {
  // The pr-url binding (repo + bidirectional host) was, until now, exercised
  // only through publish-assets' suite; the gate is shared, and submit is the
  // caller that always binds the repo. Pin it here too.
  let dir: string;
  let savedGhHost: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'submit-auth-'));
    savedGhHost = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedGhHost !== undefined) process.env['GH_HOST'] = savedGhHost;
    else delete process.env['GH_HOST'];
  });

  function authFor(rawArgs: string, over: Record<string, unknown> = {}) {
    const argsFile = join(dir, 'args.txt');
    writeFileSync(argsFile, `${rawArgs}\n`);
    return reviewWriteAuthorization({
      userAuthorized: false,
      skillArgs: argsFile,
      pr: 123,
      repo: 'o/r',
      host: undefined,
      ...over,
    } as never);
  }

  let floorSeq = 0;
  /** A fresh record + optional plan, driven through the shared recovery. */
  function recoverFloor(line: string, opts: Record<string, unknown> = {}) {
    const argsFile = join(dir, `floor-args-${floorSeq++}.txt`);
    writeFileSync(argsFile, `${line}\n`);
    return recordedSeverityFloor({
      callerPr: 123,
      skillArgs: argsFile,
      ...opts,
    } as never);
  }
  function floorPlan(contents: Record<string, unknown>): string {
    const p = join(dir, `floor-plan-${floorSeq++}.json`);
    writeFileSync(p, JSON.stringify(contents));
    return p;
  }

  it('recovers the recorded floor only when the record DECIDED one', () => {
    // A default-resolved `auto` is not an operator decision — letting it
    // outrank the state's floor would stand enforcement down over a record
    // that recorded no floor at all. An invalid configured value is
    // discarded by the parser and must read the same way. An explicit
    // `--severity-floor auto` IS a decision (parse-args pins its source as
    // explicit) — conflating it with the default-resolved auto would let a
    // drifted state floor stand over the operator's recorded posture.
    expect(recoverFloor('123 --comment --severity-floor critical')).toEqual({
      floor: 'critical',
      source: 'explicit',
    });
    expect(recoverFloor('123 --comment')).toBeUndefined();
    expect(
      recoverFloor('123 --comment', { defaultSeverityFloor: 'critical' }),
    ).toEqual({ floor: 'critical', source: 'configured' });
    expect(
      recoverFloor('123 --comment', { defaultSeverityFloor: 'crtical' }),
    ).toBeUndefined();
    expect(recoverFloor('123 --severity-floor auto')).toEqual({
      floor: 'auto',
      source: 'explicit',
    });
  });

  it('binds the recovery to the full recorded identity — number, repo, host', () => {
    // The record is last-writer-wins across /review invocations, so another
    // PR's — or the same number in another repo, or on another host —
    // recovers nothing; the bar is the one the --comment authorisation
    // applies to the same record.
    expect(recoverFloor('999 --severity-floor critical')).toBeUndefined();
    expect(
      recoverFloor(
        'https://github.com/o/r/pull/123 --severity-floor critical',
        {
          callerRepo: 'o/r',
        },
      ),
    ).toEqual({ floor: 'critical', source: 'explicit' });
    expect(
      recoverFloor(
        'https://github.com/other/repo/pull/123 --severity-floor critical',
        { callerRepo: 'o/r' },
      ),
    ).toBeUndefined();
    // An UNKNOWN identity repo cannot check a URL record's repo bar, so it
    // recovers nothing — skipping the comparison let another repo's record
    // bind on number and host alone.
    expect(
      recoverFloor(
        'https://github.com/other/repo/pull/123 --severity-floor critical',
        {},
      ),
    ).toBeUndefined();
    expect(
      recoverFloor(
        'https://ghe.corp.example/o/r/pull/123 --severity-floor critical',
        { callerRepo: 'o/r' },
      ),
    ).toBeUndefined();
    // The caller's CLI-typed pr outranks the plan's — the plan's path is
    // model-written, and a parseable-but-wrong plan must not choose which
    // identity the operator's record is tested against.
    expect(
      recoverFloor('456 --severity-floor critical', {
        planPath: floorPlan({ prNumber: 123 }),
        callerPr: 456,
      }),
    ).toEqual({ floor: 'critical', source: 'explicit' });
    expect(
      recoverFloor('123 --severity-floor critical', {
        planPath: floorPlan({ prNumber: 123 }),
        callerPr: 456,
      }),
    ).toBeUndefined();
    // Digit-string plan numbers fill a caller-less identity like their
    // numeric siblings — the shape every other plan reader tolerates.
    expect(
      recoverFloor('123 --severity-floor critical', {
        planPath: floorPlan({ prNumber: '123' }),
        callerPr: undefined,
      }),
    ).toEqual({ floor: 'critical', source: 'explicit' });
    // The plan's ownerRepo binds a URL record even without a caller repo.
    expect(
      recoverFloor(
        'https://github.com/other/repo/pull/123 --severity-floor critical',
        { planPath: floorPlan({ prNumber: 123, ownerRepo: 'o/r' }) },
      ),
    ).toBeUndefined();
    // Absent record and plan-less caller both fail open, never throw.
    expect(
      recordedSeverityFloor({
        callerPr: 123,
        skillArgs: join(dir, 'no-such-record.txt'),
      }),
    ).toBeUndefined();
    expect(
      recordedSeverityFloor({ skillArgs: join(dir, 'no-such-record.txt') }),
    ).toBeUndefined();
    // The URL branch's OWN number check: a URL record of another PR in the
    // right repo must not bind — the number bar exists per target shape.
    expect(
      recoverFloor(
        'https://github.com/o/r/pull/999 --severity-floor critical',
        {
          callerRepo: 'o/r',
        },
      ),
    ).toBeUndefined();
    // The caller's host recovers a matching Enterprise record…
    expect(
      recoverFloor(
        'https://ghe.corp.example/o/r/pull/123 --severity-floor critical',
        { callerRepo: 'o/r', callerHost: 'ghe.corp.example' },
      ),
    ).toEqual({ floor: 'critical', source: 'explicit' });
    // …and it recovers an Aone record across the web/git host ALIAS: the
    // CR-URL record carries the web host (code.) while the submission
    // carries the git host (gitlab.). Raw equality silently discarded the
    // operator's floor exactly on this shape (the --comment gate above
    // binds through the same hostsEquivalent).
    expect(
      recoverFloor(
        'https://code.alibaba-inc.com/o/r/codereview/123 --severity-floor critical',
        { callerRepo: 'o/r', callerHost: 'gitlab.alibaba-inc.com' },
      ),
    ).toEqual({ floor: 'critical', source: 'explicit' });
    // A genuinely different host still recovers nothing.
    expect(
      recoverFloor(
        'https://code.alibaba-inc.com/o/r/codereview/123 --severity-floor critical',
        { callerRepo: 'o/r', callerHost: 'github.com' },
      ),
    ).toBeUndefined();
    // …and the CALLER's identity outranks the plan's on every axis — repo:
    // a mis-transcribed planPath naming another repo must not stand the
    // CLI-typed repo's bar down…
    expect(
      recoverFloor(
        'https://github.com/other/repo/pull/123 --severity-floor critical',
        {
          planPath: floorPlan({ prNumber: 123, ownerRepo: 'o/r' }),
          callerRepo: 'other/repo',
        },
      ),
    ).toEqual({ floor: 'critical', source: 'explicit' });
    // …and host: NEVER plan-filled. An absent caller host IS github.com by
    // the gate's own rule, so there is no gap for the plan to fill — with
    // mandatory caller pr/repo flags, a gap-read here handed the
    // model-pathed plan the one identity axis nothing else pinned, and a
    // plan carrying a foreign host silently stood the recovery down on the
    // common no---host github.com invocation.
    expect(
      recoverFloor(
        'https://ghe.corp.example/o/r/pull/123 --severity-floor critical',
        {
          planPath: floorPlan({
            prNumber: 123,
            ownerRepo: 'o/r',
            host: 'ghe.corp.example',
          }),
          callerRepo: 'o/r',
          callerHost: 'github.com',
        },
      ),
    ).toBeUndefined();
    expect(
      recoverFloor(
        'https://ghe.corp.example/o/r/pull/123 --severity-floor critical',
        {
          planPath: floorPlan({
            prNumber: 123,
            ownerRepo: 'o/r',
            host: 'ghe.corp.example',
          }),
          callerRepo: 'o/r',
        },
      ),
    ).toBeUndefined();
    // And the inverse of the reported hole: a github.com record binds on
    // the no---host invocation even when a foreign plan host tries to
    // stand it down.
    expect(
      recoverFloor(
        'https://github.com/o/r/pull/123 --severity-floor critical',
        {
          planPath: floorPlan({
            prNumber: 123,
            ownerRepo: 'o/r',
            host: 'ghe.corp.example',
          }),
          callerRepo: 'o/r',
        },
      ),
    ).toEqual({ floor: 'critical', source: 'explicit' });
    // A plan that parses but names no PR falls back to the caller's pr —
    // the diff-only/local plan shape must not suppress the fallback.
    expect(
      recoverFloor('123 --severity-floor critical', {
        planPath: floorPlan({}),
        callerPr: 123,
      }),
    ).toEqual({ floor: 'critical', source: 'explicit' });
    // A corrupt plan file reads as no plan (the catch's documented
    // contract) — never a throw out of the recovery.
    const corrupt = join(dir, 'floor-plan-corrupt.json');
    writeFileSync(corrupt, '{"prNumber": 123, ');
    expect(
      recoverFloor('123 --severity-floor critical', {
        planPath: corrupt,
        callerPr: 123,
      }),
    ).toEqual({ floor: 'critical', source: 'explicit' });
  });

  it('ignores the skillArgs seam whenever a session id is present', () => {
    // The seam is the tests' door only; in a real run (session id exported)
    // a model-visible --skill-args must not point the recovery at a
    // model-writable record — a forged same-number record carrying
    // --severity-floor suggestion would override the operator's verbatim
    // posture on the write itself.
    const argsFile = join(dir, 'seam-args.txt');
    writeFileSync(argsFile, '123 --severity-floor critical\n');
    const prev = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_SESSION_ID'] = 'floor-sess';
    try {
      expect(
        recordedSeverityFloor({ callerPr: 123, skillArgs: argsFile }),
      ).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
      else process.env['QWEN_CODE_SESSION_ID'] = prev;
    }
  });

  it('binds the repo of a URL-shaped authorisation', () => {
    expect(authFor('https://github.com/o/r/pull/123 --comment').ok).toBe(true);
    const wrong = authFor('https://github.com/other/repo/pull/123 --comment');
    expect(wrong.ok).toBe(false);
    expect(wrong.why).toContain('other/repo');
  });

  it('binds the host in both directions, defaulting an absent host to github.com', () => {
    // Enterprise authorisation, host-less write → refused.
    const up = authFor('https://ghe.corp.example/o/r/pull/123 --comment');
    expect(up.ok).toBe(false);
    expect(up.why).toContain('ghe.corp.example');
    // github.com authorisation, Enterprise write → refused.
    const down = authFor('https://github.com/o/r/pull/123 --comment', {
      host: 'ghe.corp.example',
    });
    expect(down.ok).toBe(false);
    // Matching Enterprise pair → passes.
    expect(
      authFor('https://ghe.corp.example/o/r/pull/123 --comment', {
        host: 'ghe.corp.example',
      }).ok,
    ).toBe(true);
  });

  it('the audit text names the source that authorised — flag and setting stay distinguishable', () => {
    // `why` rides the success line and the persisted refusal record. Swapping
    // the gate's two ternary branches attributes a setting-authorised post to
    // a flag the operator never typed — and survives every other test, so pin
    // both branches here.
    const bySetting = authFor('123', { defaultComment: true });
    expect(bySetting.ok).toBe(true);
    expect(bySetting.why).toContain('`review.comment` is enabled in settings');
    expect(bySetting.why).toContain('#123');

    const byFlag = authFor('123 --comment');
    expect(byFlag.ok).toBe(true);
    expect(byFlag.why).toContain('`--comment` was in the review arguments');
  });

  it('a requested-but-unbindable comment names the missing PR, not a missing flag', () => {
    // When comment was requested — by the flag or the standing setting — but
    // the arguments name no PR, the refusal must say THAT. Blaming a missing
    // `--comment` flag the operator never typed (and implying one would fix
    // it) misdirects; the request itself is on record.
    const bySetting = authFor('src/foo.ts', { defaultComment: true });
    expect(bySetting.ok).toBe(false);
    expect(bySetting.why).toContain('do not name a');
    expect(bySetting.why).not.toContain(
      '`--comment` was not in the review arguments',
    );
    expect(bySetting.cls).toBe('unbound');

    const byFlag = authFor('src/foo.ts --comment');
    expect(byFlag.ok).toBe(false);
    expect(byFlag.why).toContain('do not name a');
    expect(byFlag.cls).toBe('unbound');

    // Neither source requested it: the original wording stands.
    const neither = authFor('src/foo.ts');
    expect(neither.ok).toBe(false);
    expect(neither.why).toContain(
      '`--comment` was not in the review arguments',
    );
    expect(neither.cls).toBe('comment-not-requested');
  });

  it('a minimal-topology record names the topology, not a missing PR', () => {
    // `--topology minimal` is a third cause of `comment.effective === false`
    // beside the two the refusal wording knew about. The record names its PR
    // perfectly, so the target-shape message is factually wrong and sends the
    // operator to fix a target problem that does not exist — re-running with
    // identical arguments refuses again for the unnamed reason. The topology
    // is the REAL blocker; name it.
    const byFlag = authFor('123 --topology minimal --comment');
    expect(byFlag.ok).toBe(false);
    expect(byFlag.why).toContain('`--topology minimal`');
    expect(byFlag.why).not.toContain('do not name a');
    expect(byFlag.cls).toBe('topology');

    const bySetting = authFor('123 --topology minimal', {
      defaultComment: true,
    });
    expect(bySetting.ok).toBe(false);
    expect(bySetting.why).toContain('`--topology minimal`');
    expect(bySetting.why).not.toContain('do not name a');
    expect(bySetting.cls).toBe('topology');

    // No comment source at all: the topology is STILL the blocker to name —
    // even a typed --comment would not lift the refusal, so the missing-flag
    // wording would bury the fact that the topology bars every post.
    const neither = authFor('123 --topology minimal');
    expect(neither.ok).toBe(false);
    expect(neither.why).toContain('`--topology minimal`');
    expect(neither.cls).toBe('topology');
  });

  it('a minimal record names the topology only when it is the sole blocker', () => {
    // The topology refusal's remedy is "re-run the review without it" — a
    // remedy that cannot lift the refusal while the record ALSO fails to
    // bind this write. Lead with the binding refusal there: a non-PR record
    // falls through to the target-shape wording, and a PR record naming
    // another number, repo, or host leads with the binding mismatch — the
    // topology refusal still fires, correctly, once the binding stops
    // being a blocker.
    const fileTarget = authFor('src/foo.ts --topology minimal --comment');
    expect(fileTarget.ok).toBe(false);
    expect(fileTarget.why).toContain('do not name a');
    expect(fileTarget.why).not.toContain('`--topology minimal`');
    expect(fileTarget.cls).toBe('unbound');

    const wrongPr = authFor('456 --topology minimal --comment');
    expect(wrongPr.ok).toBe(false);
    expect(wrongPr.why).toContain('authorise pull request #456');
    expect(wrongPr.why).toContain('targets #123');
    expect(wrongPr.why).not.toContain('`--topology minimal`');
    expect(wrongPr.cls).toBe('unbound');

    const wrongHost = authFor(
      'https://ghe.corp.example/o/r/pull/123 --topology minimal --comment',
    );
    expect(wrongHost.ok).toBe(false);
    expect(wrongHost.why).toContain('authorise ghe.corp.example');
    expect(wrongHost.why).toContain('targets github.com');
    expect(wrongHost.why).not.toContain('`--topology minimal`');
    expect(wrongHost.cls).toBe('unbound');

    const wrongRepo = authFor(
      'https://github.com/x/y/pull/123 --topology minimal --comment',
    );
    expect(wrongRepo.ok).toBe(false);
    expect(wrongRepo.why).toContain('authorise x/y');
    expect(wrongRepo.why).toContain('targets o/r');
    expect(wrongRepo.why).not.toContain('`--topology minimal`');
    expect(wrongRepo.cls).toBe('unbound');
  });

  it('the fast path honours the user ask even under minimal (documented layering)', () => {
    // posting.md documents the slow/fast contrast this PR's topology refusal
    // makes observable on the identical record: the slow path refuses
    // ("…ran with `--topology minimal`…"), while the `--user-authorized`
    // fast path never consults the topology — the skill's Step 7 rule, not
    // the gate, is the layer that catches a minimal run whose decline was
    // missed. Pin the fast side here (the slow side is pinned above), so a
    // drift in either direction reddens instead of silently rewriting the
    // documented layering.
    const auth = authFor('123 --topology minimal --comment', {
      userAuthorized: true,
    });
    expect(auth.ok).toBe(true);
  });

  it('a missing args file names the missing invocation, not a missing flag, when the setting authorises', () => {
    // With `review.comment` on, telling the operator to re-run with
    // `--comment` misdirects: the blocker is that no recorded invocation
    // names a PR, and a plain re-run fixes it. Flag-driven operators keep
    // the flag wording — for them the flag IS the missing piece.
    const missing = join(dir, 'no-such-args.txt');
    const base = {
      userAuthorized: false,
      skillArgs: missing,
      pr: 123,
      repo: 'o/r',
    };

    const bySetting = reviewWriteAuthorization({
      ...base,
      defaultComment: true,
    });
    expect(bySetting.ok).toBe(false);
    expect(bySetting.why).toContain(
      'no recorded invocation names a pull request',
    );
    expect(bySetting.why).not.toContain('`--comment`');
    expect(bySetting.cls).toBe('unbound');

    const byFlag = reviewWriteAuthorization(base);
    expect(byFlag.ok).toBe(false);
    expect(byFlag.why).toContain('cannot show that `--comment` was requested');
    expect(byFlag.cls).toBe('comment-not-requested');

    // Both production callers pass a strict boolean (destructured default /
    // the resolved setting), so pin the flag branch with the explicit false
    // they actually send — a presence-check mutation of the ternary must not
    // survive.
    const byFlagExplicit = reviewWriteAuthorization({
      ...base,
      defaultComment: false,
    });
    expect(byFlagExplicit.ok).toBe(false);
    expect(byFlagExplicit.why).toContain(
      'cannot show that `--comment` was requested',
    );
    expect(byFlagExplicit.cls).toBe('comment-not-requested');
  });

  it('surfaces the recorded host on the --user-authorized fast path too', () => {
    // The fast path publishes because the user asked, but it must not drop
    // the recorded target's host: submit's platform binding keys on it, and
    // a fast path that binds none re-opens the leak — a recorded Aone
    // codereview review, user-authorised from a non-Aone cwd with no
    // --host/GH_HOST, would post at github.com's same-named repo. The
    // binding carries the repo check: only a recording naming the SAME
    // repo supplies the host (round-12 hardening).
    const auth = authFor(
      'https://code.alibaba-inc.com/g/p/codereview/123 --comment',
      { userAuthorized: true, repo: 'g/p' },
    );
    expect(auth.ok).toBe(true);
    expect(auth.recordedHost).toBe('code.alibaba-inc.com');
    // A different-repo recording of the same number binds nothing.
    expect(
      authFor('https://code.alibaba-inc.com/g/p/codereview/123 --comment', {
        userAuthorized: true,
      }).recordedHost,
    ).toBeUndefined();
    // A bare pr-number binds the recorded --host flag when present, and
    // nothing without it (the unbound fail-closed then rides the write
    // gate).
    expect(
      authFor('123 --host code.alibaba-inc.com --comment', {
        userAuthorized: true,
      }).recordedHost,
    ).toBe('code.alibaba-inc.com');
    // The NON-Aone recorded host pins too — a gate regression keeping only
    // Aone-family hosts would drop this binding and leave the cwd probe to
    // select the platform (a github-recorded review, published from an
    // Aone-origin clone, posts at Aone's same-named repo).
    expect(
      authFor('123 --host github.com --comment', { userAuthorized: true })
        .recordedHost,
    ).toBe('github.com');
    // The repo axis binds case-INSENSITIVELY — GitHub resolves owner/repo
    // case-insensitively server-side, so any casing variant is a valid
    // target; a case-sensitive comparison silently dropped the recording
    // out of platform selection (the slow path and the floor recovery both
    // lowercase both sides).
    expect(
      authFor('https://code.alibaba-inc.com/O/R/codereview/123 --comment', {
        userAuthorized: true,
        repo: 'o/r',
      }).recordedHost,
    ).toBe('code.alibaba-inc.com');
    expect(
      authFor('https://code.alibaba-inc.com/o/r/codereview/123 --comment', {
        userAuthorized: true,
        repo: 'O/R',
      }).recordedHost,
    ).toBe('code.alibaba-inc.com');
    const bare = authFor('123 --comment', { userAuthorized: true });
    expect(bare.recordedHost).toBeUndefined();
    expect(bare.recordedUnbound).toBe(true);
    // A missing args file degrades to undefined without blocking the
    // user-authorised publish (best effort by design).
    expect(
      reviewWriteAuthorization({
        userAuthorized: true,
        skillArgs: join(dir, 'no-such-fast-path.txt'),
        pr: 123,
        repo: 'o/r',
      }).recordedHost,
    ).toBeUndefined();
  });
});

describe('the user-authorized fast path binds a recorded Aone target (round-6 witness)', () => {
  // End to end through the REAL gate: a review recorded against an Aone
  // codereview URL, then `submit --user-authorized` with no --host and no
  // GH_HOST from a cwd whose probe reads GitHub (the registry mock). Before
  // the fast path surfaced recordedHost, the environment fallback saw
  // nothing Aone and the review POSTed at github.com's same-named repo.
  // Now that Aone is a posting target, the same binding routes the write
  // at the a1 seam — the wrong-host leak class is unchanged, only the
  // platform the correct post lands on moved.
  let savedGhHost: string | undefined;
  let capturedDiff: string | undefined;
  beforeEach(() => {
    savedGhHost = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
    capturedDiff = writeCapturedDiff(123);
  });
  afterEach(() => {
    if (savedGhHost === undefined) delete process.env['GH_HOST'];
    else process.env['GH_HOST'] = savedGhHost;
    if (capturedDiff) rmSync(capturedDiff, { force: true });
  });

  it('posts a recorded Aone target through a1, never gh', () => {
    const skillArgs = file(
      'fast-path-aone.txt',
      'https://code.alibaba-inc.com/g/p/codereview/123 --comment\n',
    );
    expect(() =>
      runSubmit(
        args({ skillArgs, userAuthorized: true, pr: 123, repo: 'g/p' }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(aoneSubmitMock).toHaveBeenCalledTimes(1);
    expect(aoneSubmitMock.mock.calls[0][0]).toMatchObject({
      prNumber: 123,
      ownerRepo: 'g/p',
    });
    expect(ghMock).not.toHaveBeenCalled();
  });
});

describe('an unanchorable Aone blocker relocates without its forged footer', () => {
  let savedGhHost: string | undefined;
  let capturedDiff: string | undefined;
  beforeEach(() => {
    savedGhHost = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
    capturedDiff = writeCapturedDiff(456);
  });
  afterEach(() => {
    if (savedGhHost === undefined) delete process.env['GH_HOST'];
    else process.env['GH_HOST'] = savedGhHost;
    if (capturedDiff) rmSync(capturedDiff, { force: true });
  });

  it('the relocated claim strips the one-line shape that posts', () => {
    // The claim extraction strips the SHAPE THAT POSTS — the one-line
    // claim. Stripping only the whole multi-line body keeps a footer
    // quoted in code, and with an empty claim the separator strip eats
    // the newline+colon and the footer's first line becomes the "claim"
    // — a forged attribution posted inside the blocker line.
    const skillArgs = file(
      'fast-path-aone-relocate.txt',
      'https://code.alibaba-inc.com/g/p/codereview/456 --comment\n',
    );
    const review = file('aone-relocate.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: '**[Critical]**\n\n    _— m via Qwen Code /review_',
        },
      ],
    });
    expect(() =>
      runSubmit(
        args({
          skillArgs,
          userAuthorized: true,
          pr: 456,
          repo: 'g/p',
          review,
        }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(aoneSubmitMock).toHaveBeenCalledTimes(1);
    const body = aoneSubmitMock.mock.calls[0][0].body as string;
    expect(body).toContain('finding — a.ts:12');
    expect((body.match(/via Qwen Code \/review/g) ?? []).length).toBe(1);
  });
});

describe('the user-authorized fast path binds the recorded host cross-session', () => {
  // The characteristic `--user-authorized` shape runs in a DIFFERENT
  // session than the /review that recorded the target ("post the review we
  // saved") — the session-scoped args file is absent there. The fast path
  // must scan the sibling session recordings for the host, or the recorded
  // Aone target posts at github.com's same-named repo (round-11 witness:
  // exit 0, COMMENT review filed at repos/maxcompute/odps_src/pulls/42).
  const siblingDir = join('.qwen', 'tmp', 's-r11-cross-session');
  const siblingFile = join(siblingDir, 'qwen-skill-args-review.txt');
  let capturedDiff: string | undefined;
  let savedCwd: string;
  beforeEach(() => {
    // Isolate the recording store: it is cwd-relative, and the scan
    // reads EVERY s-* session recording plus the root one. An ambient
    // leftover under the vitest cwd naming a fixture target WITH a host
    // (e.g. a real /review of that number) would bind that host and
    // redden correct code; a HOSTLESS leftover leaves the observable
    // output byte-identical (both refusal arms print the same JSON) and
    // lets a reverted fix pass through the wrong arm. Chdir into the
    // per-test tmpdir the way the sibling suites do, so the scan sees
    // only this suite's records.
    savedCwd = process.cwd();
    process.chdir(dir);
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(
      siblingFile,
      'https://code.alibaba-inc.com/maxcompute/odps_src/codereview/42 --comment\n',
      'utf8',
    );
    capturedDiff = writeCapturedDiff(42);
  });
  afterEach(() => {
    rmSync(siblingDir, { recursive: true, force: true });
    // The captured-diff path is cwd-relative — remove it before restoring
    // the cwd.
    if (capturedDiff) rmSync(capturedDiff, { force: true });
    process.chdir(savedCwd);
  });

  it('routes at a1 when a SIBLING session recorded the same PR on Aone', () => {
    expect(() =>
      runSubmit(
        args({ userAuthorized: true, pr: 42, repo: 'maxcompute/odps_src' }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(aoneSubmitMock).toHaveBeenCalledTimes(1);
    expect(aoneSubmitMock.mock.calls[0][0]).toMatchObject({
      prNumber: 42,
      ownerRepo: 'maxcompute/odps_src',
    });
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('does not bind a sibling recording of a DIFFERENT PR', () => {
    // A stale recording of another PR must not supply a host. Under the
    // fail-closed gate, a write whose number no recording names is refused
    // as unbound — which is itself the proof the stale host was NOT used:
    // if it had been, the recorded Aone host would bind and the review
    // would post at Aone instead of refusing.
    expect(() =>
      runSubmit(
        args({ userAuthorized: true, pr: 999, repo: 'maxcompute/odps_src' }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(
      JSON.parse(writeStdoutSpy.mock.calls.map((c) => String(c[0])).join('')),
    ).toEqual({ posted: false, reason: 'target-platform-unbound' });
    expect(aoneSubmitMock).not.toHaveBeenCalled();
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('binds the repo too — a different-repo same-number recording supplies nothing', () => {
    // The recording names PR 42 of ANOTHER repo; the write targets
    // maxcompute/odps_src — the host must not cross the repo boundary. The
    // unbound refusal is the proof: had the other repo's host bound, this
    // would post at Aone instead of refusing.
    writeFileSync(
      siblingFile,
      'https://code.alibaba-inc.com/other/repo/codereview/42 --comment\n',
      'utf8',
    );
    expect(() =>
      runSubmit(
        args({ userAuthorized: true, pr: 42, repo: 'maxcompute/odps_src' }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(
      JSON.parse(writeStdoutSpy.mock.calls.map((c) => String(c[0])).join('')),
    ).toEqual({ posted: false, reason: 'target-platform-unbound' });
    expect(aoneSubmitMock).not.toHaveBeenCalled();
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED on a bare-number recording with no host evidence', () => {
    // The canonical Aone invocation shape (`/review <global-MR-id>`)
    // records a bare number — no URL, no host. A cross-session publish of
    // it cannot prove WHERE the target lives, and the runtime environment
    // (cwd pinned non-Aone here, no --host, no GH_HOST) cannot either.
    // Both platforms are writable now, so the guess would land the review
    // on the wrong one's same-named repo — the write refuses and names
    // the remedy (the round-12 witness: this once exited 0 and POSTed).
    writeFileSync(siblingFile, '42 --comment\n', 'utf8');
    expect(() =>
      runSubmit(
        args({ userAuthorized: true, pr: 42, repo: 'maxcompute/odps_src' }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    const out = JSON.parse(
      writeStdoutSpy.mock.calls.map((c) => String(c[0])).join(''),
    ) as { posted?: boolean; reason?: string };
    expect(out).toEqual({ posted: false, reason: 'target-platform-unbound' });
    expect(ghMock).not.toHaveBeenCalled();
    expect(aoneSubmitMock).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when NO recording exists at all (fast path, no host evidence)', () => {
    // recordedUnbound is only set when a recording EXISTS but carries no
    // host. When there is NO recording (writeSkillArgs never throws,
    // recordings are cwd-relative — a publish invoked from another
    // directory finds nothing), the lookup returns unbound: false. Before
    // this fix the refusal keyed on recordedUnbound alone, so the no-
    // recording case fell through to the cwd probe picking the platform of
    // an irreversible write. It must fail closed the same way.
    // (skillArgs points at a missing file — overriding args()'s default
    // recording — and no sibling session names #6771.)
    rmSync(siblingFile, { force: true });
    expect(() =>
      runSubmit(
        args({
          userAuthorized: true,
          skillArgs: join(dir, 'no-recording-anywhere.txt'),
        }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    const out = JSON.parse(
      writeStdoutSpy.mock.calls.map((c) => String(c[0])).join(''),
    ) as { posted?: boolean; reason?: string };
    expect(out).toEqual({ posted: false, reason: 'target-platform-unbound' });
    expect(ghMock).not.toHaveBeenCalled();
    expect(aoneSubmitMock).not.toHaveBeenCalled();
  });

  it('a bare-number recording WITH a recorded --host binds the platform', () => {
    // The remedy the refusal names: the host flag recorded beside the
    // bare number is the platform evidence, and it now SELECTS the
    // platform the write lands on — a github-recorded host posts via gh,
    // an Aone-recorded host via the a1 seam.
    writeFileSync(siblingFile, '42 --host github.com --comment\n', 'utf8');
    expect(() =>
      runSubmit(
        args({ userAuthorized: true, pr: 42, repo: 'maxcompute/odps_src' }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(ghMock).toHaveBeenCalled();
    expect(aoneSubmitMock).not.toHaveBeenCalled();

    ghMock.mockClear();
    aoneSubmitMock.mockClear();
    writeStdoutSpy.mockClear();
    writeFileSync(
      siblingFile,
      '42 --host gitlab.alibaba-inc.com --comment\n',
      'utf8',
    );
    expect(() =>
      runSubmit(
        args({ userAuthorized: true, pr: 42, repo: 'maxcompute/odps_src' }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(ghMock).not.toHaveBeenCalled();
    expect(aoneSubmitMock).toHaveBeenCalledTimes(1);
  });

  it('the --host remedy LIFTS the unbound refusal — the re-run posts', () => {
    // The refusal names `--host` as the remedy; an explicit flag on the
    // re-run is platform proof, so it must post, not refuse again (the
    // futile retry loop the refusal wording exists to prevent).
    writeFileSync(siblingFile, '42 --comment\n', 'utf8');
    expect(() =>
      runSubmit(
        args({
          userAuthorized: true,
          pr: 42,
          repo: 'maxcompute/odps_src',
          host: 'gitlab.alibaba-inc.com',
        }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(aoneSubmitMock).toHaveBeenCalledTimes(1);
    expect(ghMock).not.toHaveBeenCalled();

    aoneSubmitMock.mockClear();
    ghMock.mockClear();
    writeStdoutSpy.mockClear();
    expect(() =>
      runSubmit(
        args({
          userAuthorized: true,
          pr: 42,
          repo: 'maxcompute/odps_src',
          host: 'github.com',
        }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(aoneSubmitMock).not.toHaveBeenCalled();
    expect(ghMock).toHaveBeenCalled();
  });

  it('a codereview-URL recording posts with the ALIASED git host (web vs git name of one platform)', () => {
    // parse-args records the CR URL's WEB host (code.alibaba-inc.com);
    // the skill's own --host rule for Aone targets carries the GIT host
    // (gitlab.alibaba-inc.com). The SLOW path binds hosts through
    // hostsEquivalent — raw equality refused this after the whole review
    // already ran. (userAuthorized stays OFF: the fast path never runs
    // the host binding this test pins.)
    const rec = file(
      'aone-url-slow.txt',
      'https://code.alibaba-inc.com/maxcompute/odps_src/codereview/42 --comment',
    );
    expect(() =>
      runSubmit(
        args({
          skillArgs: rec,
          userAuthorized: false,
          pr: 42,
          repo: 'maxcompute/odps_src',
          host: 'gitlab.alibaba-inc.com',
        }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(aoneSubmitMock).toHaveBeenCalledTimes(1);
    expect(ghMock).not.toHaveBeenCalled();

    // A genuinely DIFFERENT host still refuses — the alias is not a
    // blanket exemption.
    aoneSubmitMock.mockClear();
    writeStdoutSpy.mockClear();
    expect(() =>
      runSubmit(
        args({
          skillArgs: rec,
          userAuthorized: false,
          pr: 42,
          repo: 'maxcompute/odps_src',
          host: 'github.com',
        }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(aoneSubmitMock).not.toHaveBeenCalled();
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('a contradicting --host beside a recorded host refuses — the flag does not retarget the recorded review', () => {
    // The explicit flag FILLS a gap in the recorded evidence; it does
    // not override the recording's answer. A bare-number recording with
    // a recorded Aone host, submitted with an explicit github.com,
    // would retarget the irreversible write at github.com's same-named
    // repo — the fast path performs no gate host comparison of its own,
    // so the platform gate must refuse the contradiction itself.
    writeFileSync(siblingFile, '42 --host code.alibaba-inc.com --comment\n');
    expect(() =>
      runSubmit(
        args({
          userAuthorized: true,
          pr: 42,
          repo: 'maxcompute/odps_src',
          host: 'github.com',
        }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(
      JSON.parse(writeStdoutSpy.mock.calls.map((c) => String(c[0])).join('')),
    ).toEqual({ posted: false, reason: 'target-platform-conflict' });
    expect(aoneSubmitMock).not.toHaveBeenCalled();
    expect(ghMock).not.toHaveBeenCalled();

    // The ALIASED spelling is one platform, not a contradiction: the
    // canonical Aone post shape (CR-URL record + git-host flag) passes.
    process.exitCode = undefined;
    writeStdoutSpy.mockClear();
    expect(() =>
      runSubmit(
        args({
          userAuthorized: true,
          pr: 42,
          repo: 'maxcompute/odps_src',
          host: 'gitlab.alibaba-inc.com',
        }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(aoneSubmitMock).toHaveBeenCalledTimes(1);
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('the cross-session scan is last-writer-wins by the FILE mtime, not name order and not the directory mtime', () => {
    // Session ids are arbitrary strings, so name order is a coin flip. The
    // record itself is last-writer-wins; the scan must read it the same
    // way, or an OLDER session's same-number recording supplies a stale
    // host that masks the newest recording's hostlessness. Aone's small
    // global MR ids collide with GitHub PR numbers easily, so the stale
    // host routes an irreversible write at the wrong platform.
    //
    // The sort key is the recording FILE's mtime — writeSkillArgs
    // rewrites the file in place (O_WRONLY|O_CREAT|O_TRUNC, no
    // unlink/rename), which advances the file's mtime and never the
    // parent directory's. The directory mtimes below are stamped
    // BACKWARDS on purpose: a scan keyed on them would decide the
    // opposite way in both arms.
    const oldDir = join('.qwen', 'tmp', 's-mtime-old');
    const newDir = join('.qwen', 'tmp', 's-mtime-new');
    const oldFile = join(oldDir, 'qwen-skill-args-review.txt');
    const newFile = join(newDir, 'qwen-skill-args-review.txt');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    // The reversed arm posts this target through the anchor gate.
    const capturedDiff = writeCapturedDiff(7);
    try {
      const now = Math.floor(Date.now() / 1000);
      // OLDER session carried a host; NEWER session recorded a bare number.
      writeFileSync(oldFile, '7 --host gitlab.alibaba-inc.com --comment\n');
      writeFileSync(newFile, '7 --comment\n');
      utimesSync(oldFile, now - 3600, now - 3600);
      utimesSync(newFile, now, now);
      utimesSync(oldDir, now, now);
      utimesSync(newDir, now - 3600, now - 3600);
      // The newest same-PR recording (hostless) decides → unbound refusal,
      // NOT a post at the stale session's Aone host — even though the
      // stale session's DIRECTORY is the newer one.
      expect(() =>
        runSubmit(
          args({ userAuthorized: true, pr: 7, repo: 'maxcompute/odps_src' }),
          'unknown',
          { defaultComment: false },
        ),
      ).not.toThrow();
      expect(process.exitCode).toBe(3);
      expect(
        JSON.parse(writeStdoutSpy.mock.calls.map((c) => String(c[0])).join('')),
      ).toEqual({ posted: false, reason: 'target-platform-unbound' });
      expect(aoneSubmitMock).not.toHaveBeenCalled();
      expect(ghMock).not.toHaveBeenCalled();

      // Reverse the FILE mtimes: the host-carrying recording is now the
      // newest, so it binds and the write posts at its Aone host — even
      // though its directory is now the older one.
      process.exitCode = undefined;
      aoneSubmitMock.mockClear();
      writeStdoutSpy.mockClear();
      utimesSync(oldFile, now, now);
      utimesSync(newFile, now - 3600, now - 3600);
      expect(() =>
        runSubmit(
          args({ userAuthorized: true, pr: 7, repo: 'maxcompute/odps_src' }),
          'unknown',
          { defaultComment: false },
        ),
      ).not.toThrow();
      expect(process.exitCode).toBeUndefined();
      expect(aoneSubmitMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(oldDir, { recursive: true, force: true });
      rmSync(newDir, { recursive: true, force: true });
      rmSync(capturedDiff, { force: true });
    }
  });

  it('the sessionless root recording joins the mtime ordering — newest decides', () => {
    // writeSkillArgs records at the ROOT level when no session id is
    // present. That recording is a candidate like any other — pinned
    // last, it could never win, and a newer hostless root record (the
    // ordinary headless re-run) would let an older session's stale host
    // bind the write. Under vitest the session-scoped candidate IS the
    // root file, so this also pins that the publishing session's own
    // recording joins the ordering instead of preceding it.
    const rootFile = join('.qwen', 'tmp', 'qwen-skill-args-review.txt');
    const siblingDir = join('.qwen', 'tmp', 's-root-mtime-sibling');
    const siblingFile = join(siblingDir, 'qwen-skill-args-review.txt');
    mkdirSync(siblingDir, { recursive: true });
    try {
      // The describe's beforeEach plants a sibling recording of this same
      // target with a fresh mtime; the stamps below reach past it in BOTH
      // directions so the ordering under test is the one under test.
      const now = Math.floor(Date.now() / 1000);
      // Older sibling carries a host; NEWER root recording is hostless.
      writeFileSync(
        siblingFile,
        'https://code.alibaba-inc.com/maxcompute/odps_src/codereview/42 --comment\n',
      );
      writeFileSync(rootFile, '42 --comment\n');
      utimesSync(siblingFile, now - 3600, now - 3600);
      utimesSync(rootFile, now + 3600, now + 3600);
      expect(() =>
        runSubmit(
          args({ userAuthorized: true, pr: 42, repo: 'maxcompute/odps_src' }),
          'unknown',
          { defaultComment: false },
        ),
      ).not.toThrow();
      expect(process.exitCode).toBe(3);
      expect(
        JSON.parse(writeStdoutSpy.mock.calls.map((c) => String(c[0])).join('')),
      ).toEqual({ posted: false, reason: 'target-platform-unbound' });
      expect(aoneSubmitMock).not.toHaveBeenCalled();
      expect(ghMock).not.toHaveBeenCalled();

      // Reverse: the hosted recording is newest, the hostless root
      // record must not veto it from a pinned-first position.
      process.exitCode = undefined;
      aoneSubmitMock.mockClear();
      writeStdoutSpy.mockClear();
      utimesSync(siblingFile, now + 3600, now + 3600);
      utimesSync(rootFile, now - 3600, now - 3600);
      expect(() =>
        runSubmit(
          args({ userAuthorized: true, pr: 42, repo: 'maxcompute/odps_src' }),
          'unknown',
          { defaultComment: false },
        ),
      ).not.toThrow();
      expect(process.exitCode).toBeUndefined();
      expect(aoneSubmitMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(rootFile, { force: true });
      rmSync(siblingDir, { recursive: true, force: true });
    }
  });

  it('two recordings of the SAME PR with DIFFERENT hosts — the newest decides, whichever session it lives in', () => {
    // A session-scoped-first scan binds the publishing session's STALE
    // host when a sibling recorded the same number more recently; a
    // root-pinned-last scan loses the other way. Newest-wins is the
    // only ordering that reads the record the way writeSkillArgs
    // writes it (last-writer-wins), or a stale host routes an
    // irreversible write at the wrong platform's same-named repo.
    const rootFile = join('.qwen', 'tmp', 'qwen-skill-args-review.txt');
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(rootFile, '42 --host github.com --comment\n');
    writeFileSync(
      siblingFile,
      'https://code.alibaba-inc.com/maxcompute/odps_src/codereview/42 --comment\n',
    );
    try {
      // Root (github) OLDER, sibling (Aone) NEWER → the Aone recording
      // decides; the stale github host must not bind.
      utimesSync(rootFile, now - 3600, now - 3600);
      utimesSync(siblingFile, now, now);
      expect(() =>
        runSubmit(
          args({ userAuthorized: true, pr: 42, repo: 'maxcompute/odps_src' }),
          'unknown',
          { defaultComment: false },
        ),
      ).not.toThrow();
      expect(process.exitCode).toBeUndefined();
      expect(aoneSubmitMock).toHaveBeenCalledTimes(1);
      expect(ghMock).not.toHaveBeenCalled();

      // Reverse: the github recording is newest, so it decides — the
      // root record must not veto from a pinned position.
      process.exitCode = undefined;
      aoneSubmitMock.mockClear();
      ghMock.mockClear();
      utimesSync(rootFile, now, now);
      utimesSync(siblingFile, now - 3600, now - 3600);
      expect(() =>
        runSubmit(
          args({ userAuthorized: true, pr: 42, repo: 'maxcompute/odps_src' }),
          'unknown',
          { defaultComment: false },
        ),
      ).not.toThrow();
      expect(process.exitCode).toBeUndefined();
      expect(aoneSubmitMock).not.toHaveBeenCalled();
      expect(ghMock).toHaveBeenCalled();
    } finally {
      rmSync(rootFile, { force: true });
    }
  });

  it('a FLAGLESS publish of a GHE-recorded review posts where the review ran — absence is not a github.com claim', () => {
    // submit routes an un-flagged write at the recorded binding, so the
    // recording cannot contradict the routing it supplies. The gate's
    // host check used to read an absent --host as "targets github.com"
    // and refuse `authorise ghe.corp.example, but this submission
    // targets github.com` — an over-refusal of the ordinary hand-run
    // publish after the whole review ran.
    const rec = file(
      'ghe-flagless.txt',
      'https://ghe.corp.example/o/r/pull/123 --comment',
    );
    expect(() =>
      runSubmit(args({ skillArgs: rec, pr: 123, repo: 'o/r' }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(ghMock).toHaveBeenCalled();
    expect(aoneSubmitMock).not.toHaveBeenCalled();

    // A CONTRADICTING explicit flag still refuses — the exemption is
    // for ABSENCE, not a blanket waiver of the host binding.
    process.exitCode = undefined;
    ghMock.mockClear();
    writeStdoutSpy.mockClear();
    expect(() =>
      runSubmit(
        args({ skillArgs: rec, pr: 123, repo: 'o/r', host: 'github.com' }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(ghMock).not.toHaveBeenCalled();
    expect(aoneSubmitMock).not.toHaveBeenCalled();
  });

  it('a HOSTLESS recording read via the --skill-args seam refuses — the cwd probe must not stand in for the record of another cwd', () => {
    // Under vitest there is no session id, so the slow path reads the
    // caller-supplied seam file — the cross-cwd shape: the recording
    // belongs to another cwd, and the submission cwd's origin probe is
    // not platform evidence for it. A bare-number hostless recording
    // fails closed (the platform is unprovable); the --host remedy
    // lifts the refusal.
    const rec = file('override-hostless.txt', '7 --comment');
    expect(() =>
      runSubmit(
        args({ skillArgs: rec, pr: 7, repo: 'maxcompute/odps_src' }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(
      JSON.parse(writeStdoutSpy.mock.calls.map((c) => String(c[0])).join('')),
    ).toEqual({ posted: false, reason: 'target-platform-unbound' });
    expect(
      writeStderrSpy.mock.calls.some((c) =>
        String(c[0]).includes('--skill-args'),
      ),
    ).toBe(true);
    expect(aoneSubmitMock).not.toHaveBeenCalled();
    expect(ghMock).not.toHaveBeenCalled();

    // The remedy works: the explicit flag is platform proof.
    process.exitCode = undefined;
    writeStdoutSpy.mockClear();
    ghMock.mockClear();
    expect(() =>
      runSubmit(
        args({
          skillArgs: rec,
          pr: 7,
          repo: 'maxcompute/odps_src',
          host: 'github.com',
        }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(ghMock).toHaveBeenCalled();
    expect(aoneSubmitMock).not.toHaveBeenCalled();
  });

  it('never reads recordings planted OUTSIDE session dirs (worktree vector)', () => {
    // `.qwen/tmp/` also holds review worktrees checked out from the PR's
    // own tree — a malicious PR can plant a root-level args file that a
    // review materializes at a scanned path. Only `s-*` session
    // directories are scanned, so the planted host never reaches the
    // binding. With the legit session recording removed, NO recording
    // names #42 — the write gate fails closed (the planted host must not
    // be the evidence that saves it): if the planted file were scanned,
    // its Aone host would bind and the review would post at Aone.
    const plantedDir = join('.qwen', 'tmp', 'review-pr-42');
    mkdirSync(plantedDir, { recursive: true });
    writeFileSync(
      join(plantedDir, 'qwen-skill-args-review.txt'),
      'https://code.alibaba-inc.com/maxcompute/odps_src/codereview/42 --comment\n',
      'utf8',
    );
    // Remove the legit session recording so only the planted one names 42.
    rmSync(siblingFile, { force: true });
    try {
      expect(() =>
        runSubmit(
          args({
            userAuthorized: true,
            pr: 42,
            repo: 'maxcompute/odps_src',
          }),
          'unknown',
          { defaultComment: false },
        ),
      ).not.toThrow();
      // Refused as unbound — and, the proof the planted host never
      // reached the binding: no Aone post happened.
      expect(process.exitCode).toBe(3);
      expect(
        JSON.parse(writeStdoutSpy.mock.calls.map((c) => String(c[0])).join('')),
      ).toEqual({ posted: false, reason: 'target-platform-unbound' });
      expect(aoneSubmitMock).not.toHaveBeenCalled();
      expect(ghMock).not.toHaveBeenCalled();
    } finally {
      rmSync(plantedDir, { recursive: true, force: true });
    }
  });
});

describe('the posting gate', () => {
  it('refuses when the run has no authorisation at all', () => {
    // The exact shape of the dogfood breach: `/review 6771`, no `--comment`, no
    // publish request — and a public COMMENT review filed anyway. The gate used
    // to be a paragraph of prose in the prompt, and prose is not a gate.
    runSubmit(args());

    expect(ghMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it('refuses when `--comment` was not in the review arguments', () => {
    runSubmit(args({ skillArgs: file('skill-args.txt', '6771') }));

    expect(ghMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it('refuses when no arguments were recorded at all', () => {
    // Fail closed. A missing authorisation record is not an absent objection.
    runSubmit(args({ skillArgs: join(dir, 'no-such.txt') }));

    expect(ghMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it('refuses `--comment` on a non-PR target — requested is not effective', () => {
    // `--comment` on a local review is requested but has no PR to post to.
    // Posting on the strength of the request would post to a PR nobody named.
    runSubmit(args({ skillArgs: file('skill-args.txt', '--comment') }));

    expect(ghMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it('ignores a caller-supplied --skill-args when a session id is present', () => {
    // `--skill-args` was the last forgeable seam: a model could point the gate at
    // a file it wrote. In a real run a session id is exported to the environment,
    // and both the loader (write) and submit (read) derive the path from it — so
    // a caller-supplied path is honoured only when there is no session (tests),
    // and ignored otherwise.
    const forged = file('forged.txt', '6771 --comment'); // says yes
    const realArgs = join('.qwen', 'tmp', 'qwen-skill-args-sess1-review.txt');
    const prev = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_SESSION_ID'] = 'sess1';
    try {
      // The session-scoped file does not exist, so the gate refuses — it did NOT
      // read `forged`, which would have authorised the post.
      runSubmit(args({ skillArgs: forged }));
      expect(ghMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(3);
      expect(realArgs).toBeTruthy();
    } finally {
      if (prev === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
      else process.env['QWEN_CODE_SESSION_ID'] = prev;
    }
  });

  it('does not open on a hand-written verdict — the gate reads the user, not the caller', () => {
    // The obvious design reads `comment.effective` out of the parser's JSON
    // *output*. That is a document the caller wrote: a model that wants to post
    // can write `{"comment":{"effective":true}}` and point the gate at it, and
    // it opens. (Confirmed against the built CLI before this test existed.)
    //
    // So the gate reads the CLI's verbatim record of what the **user typed** and
    // runs the parser itself. A forged JSON verdict is now just a file with no
    // `--comment` in it.
    const forged = file('forged.json', { comment: { effective: true } });

    runSubmit(args({ skillArgs: forged }));

    expect(ghMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it('refuses to post to a pull request the arguments did not name', () => {
    // Authorisation is for a target, not a mood. Without this the flag is a
    // bearer token: a dry run confirmed that `6771 --comment` authorised a
    // submission to `--pr 9999 --repo other/repo`.
    runSubmit(
      args({
        pr: 9999,
        repo: 'other/repo',
        skillArgs: file('skill-args.txt', '6771 --comment'),
      }),
    );

    expect(ghMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it('refuses when the arguments name no pull request at all', () => {
    // `--comment` on a local review is not authorisation to post anywhere.
    runSubmit(args({ skillArgs: file('skill-args.txt', '--comment') }));
    expect(ghMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it('matches the refusal advice to the refusal class', () => {
    // The advice is the prose the reviewing model reads to choose its retry.
    // An unconditional "Re-run with --comment" is wrong for the target-
    // binding refusals the review.comment setting path reaches: the flag
    // cannot bind a target (and the setting already stood in for it), so
    // advising it there buys a futile retry loop. Pin both branches: a
    // wording edit to the gate that breaks the class split reddens here.
    const advice = () =>
      (writeStderrSpy.mock.calls.map((c) => c[0]) as string[]).join(' ');

    // A post that was never requested: the remedy names the flag.
    runSubmit(args({ skillArgs: file('advice-flag.txt', '6771') }));
    expect(advice()).toContain('Re-run with `--comment`');
    writeStderrSpy.mockClear();

    // A request the recorded arguments do not bind — they name no PR...
    runSubmit(
      args({ skillArgs: file('advice-nopr.txt', 'src/foo.ts') }),
      'unknown',
      { defaultComment: true },
    );
    expect(advice()).not.toContain('Re-run with `--comment`');
    expect(advice()).toContain('invoked naming it');
    expect(advice()).toContain('Nothing recorded authorises binding');
    writeStderrSpy.mockClear();

    // ...or a different PR than this submission targets.
    runSubmit(
      args({ skillArgs: file('advice-otherpr.txt', '9999') }),
      'unknown',
      { defaultComment: true },
    );
    expect(advice()).not.toContain('Re-run with `--comment`');
    expect(advice()).toContain('invoked naming it');
    writeStderrSpy.mockClear();

    // A minimal-topology run: the record bound this target on every axis,
    // so the binding arm's "Nothing recorded" preamble is false for it and
    // its remedies misdirect — "a review invoked naming it" re-refuses
    // while the topology stands, and `--user-authorized` mechanically
    // posts what the topology bars. The advice restates the refusal's own
    // remedy and nothing else.
    runSubmit(
      args({
        skillArgs: file(
          'advice-minimal.txt',
          '6771 --topology minimal --comment',
        ),
      }),
    );
    expect(advice()).toContain('posts nothing at any effort');
    expect(advice()).toContain('without `--topology minimal`');
    expect(advice()).not.toContain('Nothing recorded authorises binding');
    expect(advice()).not.toContain('--user-authorized');
    writeStderrSpy.mockClear();

    // Nothing recorded at all, with the setting authorising: the refusal
    // names the missing invocation, and the advice preamble must not
    // contradict it by presupposing recorded arguments exist.
    runSubmit(args({ skillArgs: join(dir, 'advice-missing.txt') }), 'unknown', {
      defaultComment: true,
    });
    expect(advice()).toContain('no recorded invocation names a pull request');
    expect(advice()).toContain('Nothing recorded authorises binding');
    expect(advice()).not.toContain('The recorded arguments');
    expect(ghMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it('classifies the advice on the refusal class, never on quoted operator text', () => {
    // The gate's `why` embeds the operator's verbatim recorded arguments via
    // JSON.stringify, and writeSkillArgs records the invocation byte-for-byte
    // while tokenizeArgs strips only single/double quotes — so a
    // markdown-backticked mention of the topology phrase never parses as the
    // flag yet still reaches `why`. Substring-matching it steered this
    // missing-`--comment` refusal into the topology arm: claiming the run
    // "ran under `--topology minimal`" when it did not, and prescribing a
    // re-run without a flag that was never in effect while the real blocker
    // stayed unnamed (probe: exit 3, `gh` never called — the write stays
    // fail-closed, only the advice class was wrong). The advice keys on the
    // gate's structural refusal class instead.
    const advice = () =>
      (writeStderrSpy.mock.calls.map((c) => c[0]) as string[]).join(' ');

    runSubmit(
      args({
        skillArgs: file('advice-backtick.txt', '6771 `--topology minimal`'),
      }),
    );
    expect(advice()).toContain('`--comment` was not in the review arguments');
    expect(advice()).toContain('Re-run with `--comment`');
    expect(advice()).not.toContain('posts nothing at any effort');
    expect(advice()).not.toContain('Nothing recorded authorises binding');
    expect(ghMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it('a minimal refusal names the remedies that actually authorise posting', () => {
    // The canonical minimal invocation records NO comment source, and the
    // refusal's own remedy — "re-run the review without it" — makes no
    // sufficiency promise. Advice promising posting on the bare re-run alone
    // would send the operator straight into the missing-`--comment` refusal:
    // the futile retry loop the gate's wording exists to prevent. The arm
    // must name what actually authorises the post — `--comment` or the
    // `review.comment` setting — whatever comment shape the record carried.
    const advice = () =>
      (writeStderrSpy.mock.calls.map((c) => c[0]) as string[]).join(' ');

    runSubmit(
      args({
        skillArgs: file(
          'advice-minimal-nocomment.txt',
          '6771 --topology minimal',
        ),
      }),
    );
    expect(advice()).toContain('posts nothing at any effort');
    expect(advice()).toContain('without `--topology minimal`');
    expect(advice()).toContain('`--comment`');
    expect(advice()).toContain('`review.comment`');
    expect(advice()).not.toContain('Nothing recorded authorises binding');
    expect(advice()).not.toContain('--user-authorized');
    expect(ghMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it('posts when the user typed `--comment`', () => {
    // The bare-number recording carries no host, and this test runs
    // through the session-less --skill-args seam — the submission cwd's
    // platform must not stand in for the recording's missing evidence
    // (it refuses without the flag; the explicit host is the remedy).
    runSubmit(
      args({
        skillArgs: file('skill-args.txt', '6771 --comment'),
        host: 'github.com',
      }),
    );

    expect(ghMock).toHaveBeenCalledOnce();
    const call = ghMock.mock.calls[0] as unknown as string[];
    // First arg is the JSON payload sent over stdin — the validated bytes, not a
    // pathname `gh` would re-open (the TOCTOU a review found).
    expect(JSON.parse(call[0]).event).toBe('COMMENT');
    expect(call).toContain('api');
    expect(call).toContain('repos/QwenLM/qwen-code/pulls/6771/reviews');
    // `--input -` (stdin), never `-f body=` which re-escapes newlines.
    expect(call).toContain('--input');
    expect(call).toContain('-');
  });

  it('refuses a malformed contextUnavailable on the GitHub path — the claim passes through raw', () => {
    // The gh path hands the state's context claim through RAW so
    // compose-review's deliberate shape check still refuses a
    // stringified boolean. Coercing the claim to a boolean first
    // (`=== true`) silently dropped the context-unavailable cap the
    // malformed value was asking for — a payload the archived
    // compose-review boundary refuses must not compose here.
    const review = file('ctx-malformed.json', {
      ...REVIEW,
      state: { ...REVIEW.state, contextUnavailable: 'true' },
    });
    expect(() => runSubmit(args({ review, userAuthorized: true }))).toThrow(
      /does not compose into a verdict/,
    );
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('posts when the user asked for it in so many words', () => {
    runSubmit(args({ userAuthorized: true }));
    expect(ghMock).toHaveBeenCalledOnce();
  });

  it('refuses a malformed --repo before building an API path from it', () => {
    // It goes straight into the URL. A bad value does not fail safely — it fails
    // as a confusing 404 from a path nobody meant to build. `.` and `..` are made
    // of legal characters and mean something else entirely once they get there,
    // so a character class alone is not the check it looks like.
    for (const repo of [
      'not-a-repo',
      'a/b/../../etc',
      '../repo',
      'owner/..',
      './repo',
      'owner/.',
      '',
    ]) {
      expect(() => runSubmit(args({ userAuthorized: true, repo }))).toThrow(
        /<owner>\/<repo>/,
      );
    }
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('refuses a --pr that is not a pull request number', () => {
    // yargs' `type: 'number'` hands through every one of these.
    for (const pr of [0, -1, 3.5, NaN, Infinity]) {
      expect(() => runSubmit(args({ userAuthorized: true, pr }))).toThrow(
        /not a pull request number/,
      );
    }
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('checks and reports without writing under --dry-run', () => {
    runSubmit(args({ userAuthorized: true, dryRun: true }));
    expect(ghMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});

describe('payload consistency — refuse before GitHub sees it', () => {
  const authorized = (over: Record<string, unknown>) =>
    args({ userAuthorized: true, ...over });

  /** What was actually sent to GitHub. */
  const posted = () => JSON.parse(ghMock.mock.calls[0][0] as string);

  /**
   * A plan whose Step 4 verification is provably delivered — recorded prompt,
   * brief, and a transcript that ran it verbatim and opened the brief.
   *
   * The tests below post Criticals, and a Critical nobody verified no longer
   * blocks: composeReview softens the Request changes and says so. These
   * tests are about OTHER properties of a blocking submission (count
   * derivation, body escaping, unanchorable carriage), so they carry the
   * verification that keeps the Request changes standing.
   */
  function verifiedPlan(): string {
    const diffPath = join(dir, 'verified-diff.txt');
    writeFileSync(diffPath, 'diff');
    const plan = join(dir, 'verified-plan.json');
    writeFileSync(
      plan,
      JSON.stringify({
        diffPathAbsolute: diffPath,
        srcDiffLines: 10,
        diffLines: 10,
        files: [],
        chunks: [{ id: 1, startLine: 1, endLine: 1 }],
      }),
    );
    const d = promptRecordDir(plan);
    mkdirSync(d, { recursive: true });
    const brief = briefPath(plan, 'verify');
    writeFileSync(brief, 'The verify brief.');
    const launch =
      `You are review agent \`verify\`.\n` + `read_file(file_path="${brief}")`;
    writeFileSync(join(d, 'verify.txt'), launch);
    // Transcripts newer than the plan, as in a real run.
    const old = new Date(2020, 0, 1);
    utimesSync(plan, old, old);
    const sub = join(dir, 'subagents', 'SUBV');
    mkdirSync(sub, { recursive: true });
    const base = {
      agentId: 'v1',
      agentName: 'general-purpose',
      sessionId: 'SUBV',
    };
    writeFileSync(
      join(sub, 'agent-v1.jsonl'),
      [
        {
          ...base,
          type: 'user',
          message: { role: 'user', parts: [{ text: launch }] },
        },
        {
          ...base,
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: { name: 'read_file', args: { file_path: brief } },
              },
            ],
          },
        },
        {
          ...base,
          type: 'tool_result',
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'read_file',
                  response: { output: 'ok' },
                },
              },
            ],
          },
        },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n') + '\n',
    );
    return plan;
  }

  /** Run with the transcript env the stripped-`env` compose path reads.
   *  Also seeds the session-scoped recording the write gate binds when a
   *  session id is present (the caller-supplied skillArgs is ignored by
   *  design then) — a github.com pr-url record, the platform evidence. */
  function withVerifyEnv(fn: () => void): void {
    const prevDir = process.env['QWEN_CODE_PROJECT_DIR'];
    const prevSession = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_PROJECT_DIR'] = dir;
    process.env['QWEN_CODE_SESSION_ID'] = 'SUBV';
    const sessionRecDir = join('.qwen', 'tmp', 's-SUBV');
    mkdirSync(sessionRecDir, { recursive: true });
    const sessionRec = join(sessionRecDir, 'qwen-skill-args-review.txt');
    writeFileSync(
      sessionRec,
      'https://github.com/QwenLM/qwen-code/pull/6771\n',
    );
    try {
      fn();
    } finally {
      rmSync(sessionRecDir, { recursive: true, force: true });
      if (prevDir === undefined) delete process.env['QWEN_CODE_PROJECT_DIR'];
      else process.env['QWEN_CODE_PROJECT_DIR'] = prevDir;
      if (prevSession === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
      else process.env['QWEN_CODE_SESSION_ID'] = prevSession;
    }
  }

  it("refuses a payload that carries a verdict — that is not the caller's to write", () => {
    // The failure this replaces. Dogfooded, a run read the coverage check's
    // refusal, decided "the agents clearly did their job", skipped
    // `compose-review` altogether, and printed an Approve it had written itself.
    // The event and body used to be fields in a JSON the model wrote, transcribed
    // out of a decision the CLI had already made — so a run that skipped the
    // computation could still submit its own conclusion. There is nothing to
    // transcribe now, and a payload that still tries is refused rather than
    // silently overruled.
    const review = file('bad-0.json', {
      ...REVIEW,
      event: 'APPROVE',
      body: 'LGTM',
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(
      /carries `event`\/`body`.*computed here/s,
    );
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('cannot promise inline comments it does not carry — the count IS the comments', () => {
    // The breaching run posted "Reviewed. Suggestions are inline." beside an
    // EMPTY `comments` array, and closed by reporting `0 Suggestion inline`. Every
    // count disagreed with every other. It was caught, then, by a check on the
    // body. It cannot happen now: the count is not a number handed over beside the
    // comments, it is the comments.
    runSubmit(authorized({}));

    expect(posted().body).not.toMatch(/\b(are|is) inline\b/i);
    expect(posted().comments).toEqual([]);
  });

  it('carries duplicate-dropped Suggestions through the state seam', () => {
    // The seam strips keys by a destructuring exclusion list, then spreads
    // the rest into composeReview. The field rides the spread today; if it
    // ever joins the exclusion list, the posted body loses the duplicate
    // paragraph — the exact incident shape #9204 fixes — while every direct
    // composeReview test stays green, because each one bypasses this seam.
    // The body is the observable here: this fixture brings no plan, so the
    // missing-plan cap posts COMMENT whatever the counts, and the verdict
    // side of a duplicates-only run is pinned by the cap-free fixtures in
    // compose-review.test.ts, which own the transcript scaffolding.
    const review = file('duplicates.json', {
      commit_id: 'abc123',
      comments: [],
      state: {
        suggestionsDroppedAsDuplicates: [
          'R1-1 pin gap — already reported (comment 1)',
        ],
        modelId: 'qwen3.7-max',
      },
    });
    runSubmit(authorized({ review }));
    expect(posted().body).toContain(
      '1 Suggestion-level finding(s) this review confirmed',
    );
  });

  it('posts the injected CLI version in the review footer', () => {
    runSubmit(authorized({}), '0.21.2');

    expect(posted().body).toContain('via Qwen Code /review');
    expect(
      posted().body.endsWith('_— qwen3.7-max via Qwen Code /review (v0.21.2)_'),
    ).toBe(true);
  });

  it('uses the inherited startup version instead of the resolved CLI version', async () => {
    // Driven through the handler — the one production call site — with the
    // stamp set: reverting the handler to a bare `getCliVersion()` reddens
    // this, which is the exact regression the PR closes.
    const inherited = process.env['QWEN_CODE_STARTUP_VERSION'];
    process.env['QWEN_CODE_STARTUP_VERSION'] = '0.21.3';
    try {
      await submitCommand.handler?.(authorized({}) as never);
      expect(posted().body).toContain('(v0.21.3)');
      expect(posted().body).not.toContain('(v0.21.2)');
    } finally {
      if (inherited === undefined)
        delete process.env['QWEN_CODE_STARTUP_VERSION'];
      else process.env['QWEN_CODE_STARTUP_VERSION'] = inherited;
    }
  });

  it('honours the review.attribution setting through the handler', async () => {
    reviewSettingsMock.mockReturnValue({ attribution: false });
    await submitCommand.handler?.(authorized({}) as never);
    expect(posted().body).not.toContain('via Qwen Code /review');
  });

  it('the standing review.comment setting authorises a post through the handler', async () => {
    // Wiring leg: hardcoded or dropped `defaultComment` in the handler would
    // leave the direct runSubmit test green while production submissions
    // ignore the setting. The args file names the PR but carries no
    // --comment; only the setting authorises. The explicit host is the
    // platform evidence the hostless seam recording lacks (see the
    // session-less override refusal).
    reviewSettingsMock.mockReturnValue({ attribution: true, comment: true });
    await submitCommand.handler?.(
      args({
        skillArgs: file('handler-comment-args.txt', '6771'),
        host: 'github.com',
      }) as never,
    );
    expect(ghMock).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('the review.severityFloor setting reaches enforcement through the handler', async () => {
    // The setting→opts hop is the residual wiring leg: the end-to-end floor
    // test drives runSubmit directly with the opt, so dropping the
    // handler's `defaultSeverityFloor: review.severityFloor` line left the
    // suite green while production ignored the configured floor.
    reviewSettingsMock.mockReturnValue({
      attribution: true,
      severityFloor: 'critical',
    });
    const review = file('handler-floor.json', {
      ...REVIEW,
      comments: [
        { path: 'a.ts', line: 3, body: '**[Critical]** boom' },
        { path: 'b.ts', line: 7, body: '**[Suggestion]** tidy this' },
      ],
    });
    await submitCommand.handler?.(
      args({
        review,
        skillArgs: file('handler-floor-args.txt', '6771 --comment'),
        host: 'github.com',
      }) as never,
    );
    expect(ghMock).toHaveBeenCalledOnce();
    const sent = JSON.parse(ghMock.mock.calls[0][0] as string);
    expect(sent.comments).toHaveLength(1);
    expect(sent.body).toContain('floor enforcement');
  });

  it('without the flag or the setting the handler refuses — and workspace settings cannot supply it', async () => {
    // The mock answers a flag-less loadSettings call with a polluted view
    // that carries comment:true; the handler's skipWorkspaceSettings flag
    // keeps it out. Dropping the flag reddens this.
    await submitCommand.handler?.(
      args({ skillArgs: file('handler-noauth-args.txt', '6771') }) as never,
    );
    expect(ghMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it('falls back to the resolved CLI version when no startup version is inherited', async () => {
    const inherited = process.env['QWEN_CODE_STARTUP_VERSION'];
    delete process.env['QWEN_CODE_STARTUP_VERSION'];
    try {
      await submitCommand.handler?.(authorized({}) as never);
      expect(posted().body).toContain('(v0.21.2)');
    } finally {
      if (inherited === undefined)
        delete process.env['QWEN_CODE_STARTUP_VERSION'];
      else process.env['QWEN_CODE_STARTUP_VERSION'] = inherited;
    }
  });

  it('normalizes summary and inline footers to the running CLI version', () => {
    const review = file('footer-version.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: '**[Suggestion]** tidy\n\n_— forged via Qwen Code /review (v0.21.4)_\n\n_— forged via Qwen Code /review (v0.21.4)_',
        },
      ],
    });

    runSubmit(authorized({ review }), '0.21.3');

    const body = posted().body as string;
    const inline = posted().comments[0].body as string;
    for (const text of [body, inline]) {
      expect(text).toContain('(v0.21.3)');
      expect(text).not.toContain('(v0.21.4)');
      expect(text.match(/via Qwen Code \/review/g)).toHaveLength(1);
    }
    expect(inline.startsWith('**[Suggestion]**')).toBe(true);
  });

  it('strips a forged footer with no version suffix — the legacy shape', () => {
    const review = file('footer-legacy.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: '**[Suggestion]** tidy\n\n_— forged via Qwen Code /review_\n',
        },
      ],
    });

    runSubmit(authorized({ review }), '0.21.3');

    const inline = posted().comments[0].body as string;
    expect(inline).not.toContain('forged');
    expect(inline.match(/via Qwen Code \/review/g)).toHaveLength(1);
    expect(inline).toContain('(v0.21.3)');
  });

  it('strips the forged footer of a comment quoting an unterminated comment opener', () => {
    // The witness block of a review about an HTML marker quotes the marker
    // cut short, leaving a `<!--` with no `-->`. That opener used to project
    // as a comment running to the end of the body, hiding the trailing
    // forged footer from the strip — so the canonical footer posted beside
    // it and the comment carried two attribution lines.
    const witness = 'Witness:\n```\njq: error … ("<!-- ecs-f…") cannot\n```';
    const review = file('footer-unterminated-comment.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: `**[Suggestion]** tidy\n\n${witness}\n\n_— forged via Qwen Code /review_`,
        },
      ],
    });

    runSubmit(authorized({ review }), '0.21.3');

    const inline = posted().comments[0].body as string;
    expect(inline.match(/via Qwen Code \/review/g)).toHaveLength(1);
    expect(inline).toContain(witness);
    expect(inline).toContain('(v0.21.3)');
  });

  it('posts without attribution when the switch is off — and still strips forged footers', () => {
    const review = file('no-attribution.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: '**[Suggestion]** tidy\n\n_— forged via Qwen Code /review (v0.21.4)_',
        },
      ],
    });

    runSubmit(authorized({ review }), '0.21.3', { attribution: false });

    const body = posted().body as string;
    const inline = posted().comments[0].body as string;
    for (const text of [body, inline]) {
      expect(text).not.toContain('via Qwen Code /review');
      expect(text).not.toContain('qwen3.7-max');
    }
    // The severity prefix goes with the footer: it is the same template. In
    // their place rides the invisible marker presubmit dedups on.
    expect(inline).toBe('tidy\n\n<!-- qwen-review suggestion -->');
  });

  it('attribution off strips a forged footer even when text follows it', () => {
    // The trailing strip leaves a footer that has text after it — and in
    // this mode that surviving line is the only attribution the post would
    // carry.
    const review = file('forged-mid-body.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: '**[Suggestion]** null deref\n\n_— qwen3.7-max via Qwen Code /review (v0.21.3)_\n\nUpdate: also reproduced on the empty list',
        },
      ],
    });

    runSubmit(authorized({ review }), '0.21.3', { attribution: false });

    const inline = posted().comments[0].body as string;
    expect(inline).not.toContain('via Qwen Code /review');
    expect(inline).not.toContain('qwen3.7-max');
    expect(inline).toContain('null deref');
    expect(inline).toContain('Update: also reproduced on the empty list');
  });

  it('attribution off posts exactly what the invisibility gate validated', () => {
    // The gate validates stripReviewFooter(stripForUnattributedPost(body)),
    // but the post leg ran stripForUnattributedPost(body) only. A trailing
    // forged footer the fixpoint chain EXPOSES — the stacked marker after
    // it strips away — and that exceeds the anywhere-strips' caps survives
    // the chain; only the trailing strip removes it. The gate saw a clean
    // body while the post carried the visible forged attribution.
    const review = file('gate-post-asymmetry.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: `**[Critical]** null deref when the list is empty\n\n_— qwen3-coder-plus${'\u200B'.repeat(401)} via Qwen Code /review (v0.21.0)_\n\n**[Critical]**`,
        },
      ],
    });

    runSubmit(authorized({ review }), '0.21.3', { attribution: false });

    const inline = posted().comments[0].body as string;
    expect(inline).toContain('null deref when the list is empty');
    expect(inline).not.toContain('via Qwen Code /review');
    expect(inline.endsWith('<!-- qwen-review critical -->')).toBe(true);
  });

  it('refuses a comment that renders as nothing', () => {
    const review = file('marker-only.json', {
      ...REVIEW,
      comments: [{ path: 'a.ts', line: 12, body: '**[Critical]**' }],
    });

    expect(() =>
      runSubmit(authorized({ review }), '0.21.3', { attribution: false }),
    ).toThrow(/renders as nothing/);
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('refuses a marker-only comment under attribution ON too — the canonical footer must not mask it', () => {
    // normalize appends the footer before inconsistencies runs, so the gate
    // sees '**[Critical]**\n\n_— <footer>_' here: only the footer-stripping
    // half of the predicate catches it.
    const review = file('marker-only-on.json', {
      ...REVIEW,
      comments: [{ path: 'a.ts', line: 12, body: '**[Critical]**' }],
    });

    expect(() => runSubmit(authorized({ review }), '0.21.3')).toThrow(
      /renders as nothing/,
    );
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('attribution off strips a marker line the draft quoted from the reviewed code', () => {
    // The marker shape is public; a finding legitimately quoting it must not
    // leave a second, planted marker next to the canonical one.
    const review = file('planted-marker.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: '**[Critical]** the sample posts <!-- qwen-review suggestion --> verbatim\n\n<!-- qwen-review suggestion -->\n\nthat is what the guard dereferences',
        },
      ],
    });

    runSubmit(authorized({ review }), '0.21.3', { attribution: false });

    const inline = posted().comments[0].body as string;
    // The bare quoted marker LINE is stripped; only the canonical trailing
    // marker remains at line level…
    expect(inline).not.toContain('\n<!-- qwen-review suggestion -->\n');
    expect(inline.endsWith('<!-- qwen-review critical -->')).toBe(true);
    // …while the inline prose mention is text, not a bare marker — kept.
    expect(inline).toContain('posts <!-- qwen-review suggestion --> verbatim');
  });

  it('refuses a prefix over a bare marker line — the gate sees through the whole chain', () => {
    // Probe shape from review: prefix + bare marker line would otherwise
    // pass the gate (the marker line is non-empty) and post an empty
    // visible comment carrying a live marker.
    const review = file('prefix-over-marker.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: '**[Critical]**\n\n<!-- qwen-review critical -->',
        },
      ],
    });

    expect(() =>
      runSubmit(authorized({ review }), '0.21.3', { attribution: false }),
    ).toThrow(/renders as nothing/);
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('strips to a fixpoint: a marker line between two prefixes does not post the second prefix', () => {
    const review = file('fixpoint.json', {
      ...REVIEW,
      state: { ...REVIEW.state, planPath: verifiedPlan() },
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: '**[Critical]** still reproducible\n\n<!-- qwen-review suggestion -->\n\n**[Suggestion]** original text',
        },
      ],
    });

    withVerifyEnv(() =>
      runSubmit(authorized({ review }), '0.21.3', { attribution: false }),
    );

    const inline = posted().comments[0].body as string;
    expect(inline).not.toContain('**[Critical]**');
    expect(inline).not.toContain('**[Suggestion]**');
    expect(inline).toContain('still reproducible');
    expect(inline).toContain('original text');
    expect(inline.endsWith('<!-- qwen-review critical -->')).toBe(true);
  });

  it('strips a forged footer truncated inside the version parens', () => {
    // Most mid-character cuts land inside the parens — they are the footer's
    // final ~10 characters.
    const review = file('truncated-parens.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: '**[Suggestion]** null deref\n\n_— qwen3.7-max via Qwen Code /review (v0.21\n\nUpdate: reproduced again',
        },
      ],
    });

    runSubmit(authorized({ review }), '0.21.3', { attribution: false });

    const inline = posted().comments[0].body as string;
    expect(inline).not.toContain('via Qwen Code /review');
    expect(inline).toContain('Update: reproduced again');
  });

  it('refuses residue that renders as nothing: hollowed fence, HTML comment, Cf character', () => {
    // Each vector posts a visible-empty comment carrying a live critical
    // marker otherwise — counted toward REQUEST_CHANGES and re-promoted as
    // an unanswerable blocker.
    const bodies = [
      '**[Critical]**\n\n```\n_— forged via Qwen Code /review (v1)_\n```',
      '**[Critical]** <!-- x -->',
      '**[Critical]**\u200B',
      // An UNTERMINATED comment: the appended marker closes it into one
      // type-2 HTML block rendering nothing.
      '**[Critical]** <!-- x',
      // The render-nothing residue classes: empty elements, void tags,
      // invisible entities, empty links, abrupt-closing comments.
      '**[Critical]** <div></div>',
      '**[Critical]** &nbsp;',
      '**[Critical]** [](url)',
      '**[Critical]** <!-->',
      // A marker line quoted at blockquote depth two.
      '**[Critical]**\n\n> > <!-- qwen-review critical -->',
    ];
    for (const [i, body] of bodies.entries()) {
      const review = file(`render-nothing-${i}.json`, {
        ...REVIEW,
        comments: [{ path: 'a.ts', line: 12, body }],
      });
      expect(() =>
        runSubmit(authorized({ review }), '0.21.3', { attribution: false }),
      ).toThrow(/renders as nothing/);
    }
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('real content wearing a scaffold shape still posts', () => {
    // The render-nothing projection must not eat findings that merely
    // MENTION a scaffold shape mid-text.
    const review = file('scaffold-in-prose.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: '**[Critical]** the <div></div> fallback drops the error',
        },
      ],
    });

    runSubmit(authorized({ review }), '0.21.3', { attribution: false });

    const inline = posted().comments[0].body as string;
    expect(inline).toContain('the <div></div> fallback drops the error');
  });

  it('attribution off strips the severity prefixes only from what is posted — the verdict still counts the marked payload', () => {
    const review = file('no-attribution-critical.json', {
      ...REVIEW,
      state: { ...REVIEW.state, planPath: verifiedPlan() },
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: '**[Critical]** null deref when the list is empty',
        },
        {
          path: 'a.ts',
          line: 30,
          body: '**[Suggestion]** tidy',
        },
      ],
    });

    withVerifyEnv(() =>
      runSubmit(authorized({ review }), '0.21.3', { attribution: false }),
    );

    // Counted BEFORE the strip: one marked Critical in the payload still
    // earns REQUEST_CHANGES.
    expect(posted().event).toBe('REQUEST_CHANGES');
    const [critical, suggestion] = posted().comments as Array<{
      body: string;
    }>;
    expect(critical.body).toBe(
      'null deref when the list is empty\n\n<!-- qwen-review critical -->',
    );
    expect(suggestion.body).toBe('tidy\n\n<!-- qwen-review suggestion -->');
  });

  it('attribution on keeps the severity prefixes in the posted bodies', () => {
    const review = file('attribution-critical.json', {
      ...REVIEW,
      state: { ...REVIEW.state, planPath: verifiedPlan() },
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: '**[Critical]** null deref when the list is empty',
        },
      ],
    });

    withVerifyEnv(() => runSubmit(authorized({ review }), '0.21.3'));

    const inline = (posted().comments as Array<{ body: string }>)[0].body;
    expect(inline.startsWith('**[Critical]**')).toBe(true);
    expect(posted().event).toBe('REQUEST_CHANGES');
  });

  it('attribution off refuses a draft whose post-strip shape opens a fence', () => {
    // The prefix strip moves the delimiter to line-leading position; the
    // unclosed fence swallows the appended invisible marker as visible
    // code and the claim into its info string — the marker this mode
    // exists to keep invisible, posted by the very transform that creates
    // the exposure. The draft carries no line-leading delimiter, so only
    // a check on the POST-strip shape catches it.
    const bodies = [
      '**[Critical]** ~~~ leaked.log shows the token',
      '**[Critical]** ``` leaked',
      '**[Critical]** claim\n~~~\nfoo',
    ];
    for (const [i, body] of bodies.entries()) {
      const review = file(`fence-open-${i}.json`, {
        ...REVIEW,
        comments: [{ path: 'a.ts', line: 12, body }],
      });
      expect(() =>
        runSubmit(authorized({ review }), '0.21.3', { attribution: false }),
      ).toThrow(/leaves a code fence open/);
    }
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('attribution off still posts a paired fence — the marker lands after the closer', () => {
    const review = file('paired-fence.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: '**[Critical]** leaked:\n\n```\nconst token = 1;\n```',
        },
      ],
    });

    runSubmit(authorized({ review }), '0.21.3', { attribution: false });

    const inline = posted().comments[0].body as string;
    expect(inline).toContain('const token = 1;');
    expect(inline.endsWith('<!-- qwen-review critical -->')).toBe(true);
  });

  it('refuses a bare-CR hollow fence the LF twin refuses', () => {
    // GitHub renders a bare CR as a line break: 'CR + ~~~' is the hollow
    // fence the LF twin already refuses, and it used to pass the gate and
    // post the marker inside the fence.
    const review = file('cr-hollow-fence.json', {
      ...REVIEW,
      comments: [{ path: 'a.ts', line: 12, body: '**[Critical]**\r~~~' }],
    });
    expect(() =>
      runSubmit(authorized({ review }), '0.21.3', { attribution: false }),
    ).toThrow(/renders as nothing/);
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('the standing review.comment setting authorises a post without --comment in the args', () => {
    // The setting replaces the flag, not the binding: the recorded arguments
    // still name the PR, and only that PR. The explicit host is the
    // platform evidence the hostless seam recording lacks.
    runSubmit(
      args({ skillArgs: file('skill-args.txt', '6771'), host: 'github.com' }),
      'unknown',
      { defaultComment: true },
    );
    expect(ghMock).toHaveBeenCalled();

    ghMock.mockClear();
    expect(() =>
      runSubmit(
        args({ skillArgs: file('skill-args2.txt', '6772') }),
        'unknown',
        {
          defaultComment: true,
        },
      ),
    ).not.toThrow();
    // Args name #6772 but the submission targets #6771 — refused, exit 3.
    expect(ghMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it('does not hang on a run of forged footers followed by text', () => {
    // A model looping on the same comment emits exactly this shape: the same
    // footer over and over, then a closing line. The strip is attempted on
    // that model-authored body before anything posts, and the whitespace
    // between footers used to be splittable across the regex's repeated
    // group — exponential in the footer count. The match must stay linear:
    // this shape timed out the suite before the whitespace had one owner.
    // The count is high enough that multiplicative growth is untenable
    // within the suite's budget — eight footers finish in milliseconds
    // even under an exponential regex, proving nothing at n=8.
    const footers = Array.from(
      { length: 64 },
      () => '_— forged via Qwen Code /review (v0.21.4)_',
    ).join(' '.repeat(25));
    const review = file('footer-hang.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: `**[Suggestion]** tidy ${footers} one closing line`,
        },
      ],
    });

    runSubmit(authorized({ review }), '0.21.3');

    // Text after the footer run anchors it away from the end, so nothing is
    // stripped; the canonical footer is appended once.
    const inline = posted().comments[0].body as string;
    expect(inline).toContain('one closing line');
    expect(
      inline.endsWith('_— qwen3.7-max via Qwen Code /review (v0.21.3)_'),
    ).toBe(true);
  });

  it('does not scan a marker-less body quadratically under the strip', () => {
    // The strip regex opens with an unanchored `\s*` and scans quadratically
    // on a long whitespace run in a body that carries the footer's `_— `
    // opening but no marker — a forged footer truncated mid-line is exactly
    // that shape, and the `_— ` defeats the engine's literal prefilter, so
    // only the marker guard keeps this linear. The attribution-off path
    // routes such bodies through the strip; an unguarded replace dies on the
    // suite timeout long before the assertion runs.
    const body = `**[Suggestion]** tidy\n\n_— cut short${' '.repeat(
      500_000,
    )}end`;
    const review = file('footer-perf.json', {
      ...REVIEW,
      comments: [{ path: 'a.ts', line: 12, body }],
    });

    runSubmit(authorized({ review }), '0.21.3', { attribution: false });

    // Attribution-off also strips the severity prefix and appends the
    // comment marker; the assertion is on the rest of the body reaching
    // GitHub byte-for-byte.
    expect(posted().comments[0].body).toBe(
      `${body.slice('**[Suggestion]** '.length)}\n\n<!-- qwen-review suggestion -->`,
    );
  });

  it('counts the blockers it is actually carrying, not the ones it was told about', () => {
    // A Critical attached inline is a Critical, whatever the state says. There is
    // no `criticalsInline` field to under-report it with — and one supplied
    // anyway is refused. Verification is on record, so the Request changes the
    // count earns actually stands.
    const review = file('c1.json', {
      ...REVIEW,
      state: { ...REVIEW.state, planPath: verifiedPlan() },
      comments: [
        { path: 'a.ts', line: 12, body: '**[Critical]** boom' },
        { path: 'b.ts', line: 3, body: '**[Suggestion]** tidy' },
      ],
    });

    withVerifyEnv(() => runSubmit(authorized({ review })));
    expect(posted().event).toBe('REQUEST_CHANGES');
  });

  it('refuses an inline count supplied beside the comments', () => {
    const review = file('c2.json', {
      ...REVIEW,
      state: { ...REVIEW.state, criticalsInline: 0 },
      comments: [{ path: 'a.ts', line: 12, body: '**[Critical]** boom' }],
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(
      /counted from the `comments` you attached/,
    );
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('refuses an inline comment with no severity marker — it would weigh nothing', () => {
    // Step 6 refuses unmarked drafts, but the skill's re-compose instruction
    // expects the comment set to churn after Step 6 — and a marker lost in
    // that churn reaches exactly this boundary, the one that posts. The
    // verdict is counted from the markers, so an unmarked blocker weighs
    // zero: beside a clean state it composes an APPROVE that posts the very
    // comment it never weighed.
    const review = file('c3.json', {
      ...REVIEW,
      comments: [
        { path: 'a.ts', line: 12, body: '**[Critical]** boom' },
        { path: 'b.ts', line: 3, body: 'this blocker lost its marker' },
      ],
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(
      /comments\[1\] opens with neither/,
    );
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('writes the body as JSON, so a finding that quotes `\\n` survives intact', () => {
    // Finding text quotes code: `/\n/` in a regex, an escaped string in a snippet.
    // The body used to be built by the caller — sometimes with `-f body=`, which
    // posted the newlines as the two literal characters. It is built here now, in
    // JS, and the finding's own text is carried through untouched.
    const review = file('good-1.json', {
      ...REVIEW,
      state: {
        ...REVIEW.state,
        planPath: verifiedPlan(),
        bodyCriticals: [
          'the splitter uses `/\\n/` where the input is CRLF, so every line ' +
            'keeps a trailing `\\r`',
        ],
      },
    });

    withVerifyEnv(() => runSubmit(authorized({ review })));
    expect(posted().event).toBe('REQUEST_CHANGES');
    expect(posted().body).toContain('`/\\n/`');
    // Real newlines, not the two characters.
    expect(posted().body).toContain('\n');
    expect(posted().body).not.toMatch(/\\n\s*_—/);
  });

  it('rejects a payload with no commit_id', () => {
    const review = file('bad-6.json', { ...REVIEW, commit_id: undefined });
    expect(() => runSubmit(authorized({ review }))).toThrow(/`commit_id`/);
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('rejects a payload with no state — there is nothing to compose from', () => {
    const review = file('bad-7.json', { ...REVIEW, state: undefined });
    expect(() => runSubmit(authorized({ review }))).toThrow(
      /`state` is missing/,
    );
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('rejects a multi-line comment missing its side fields', () => {
    // GitHub 422s the whole review for this, taking every blocker with it.
    const review = file('bad-2.json', {
      ...REVIEW,
      comments: [
        { path: 'a.ts', line: 12, start_line: 10, body: '**[Critical]** x' },
      ],
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(
      /start_line.*without.*side/s,
    );
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('accepts a multi-line comment that carries both side fields', () => {
    const review = file('bad-3.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 12,
          start_line: 10,
          side: 'RIGHT',
          start_side: 'RIGHT',
          body: '**[Critical]** x',
        },
      ],
    });

    runSubmit(authorized({ review }));
    expect(ghMock).toHaveBeenCalledOnce();
  });

  it('rejects an unanchored comment', () => {
    const review = file('bad-4.json', {
      ...REVIEW,
      comments: [{ path: 'a.ts', body: '**[Critical]** x' }],
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(/usable `line`/);
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('posts an unanchorable blocker as body text, and blocks on it', () => {
    // A finding whose anchor could not be resolved has no line to hang on, and its
    // only copy is the review body. It is still a blocker: `bodyCriticals` counts
    // toward `C` exactly like an anchored one, so the verdict cannot drift to
    // Comment just because the arithmetic failed.
    const review = file('good-2.json', {
      ...REVIEW,
      state: {
        ...REVIEW.state,
        planPath: verifiedPlan(),
        bodyCriticals: ['the inline cache is stale after a rebase'],
      },
      comments: [],
    });

    withVerifyEnv(() => runSubmit(authorized({ review })));
    expect(ghMock).toHaveBeenCalledOnce();
    const sent = JSON.parse(ghMock.mock.calls[0][0] as string);
    expect(sent.event).toBe('REQUEST_CHANGES');
    expect(sent.body).toContain('the inline cache is stale after a rebase');
  });

  it('carries a posture deferral through the submit seam into the posted body', () => {
    // submit's compose() destructures-and-drops distrusted state fields
    // (env, prBodyFetcher, draftedComments); a future hardening that adds
    // deferredSuggestions to that drop would post every review without its
    // deferral disclosure — "a deferral silently dropped is a finding lost"
    // — while the compose-review unit tests, which call the function
    // directly, stay green. This is the only production path from the
    // model-written state to a posted body.
    const review = file('deferral-seam.json', {
      ...REVIEW,
      state: {
        ...REVIEW.state,
        planPath: verifiedPlan(),
        severityFloor: 'critical',
        deferredSuggestions: [
          {
            file: 'a.ts',
            line: 1,
            source: 'review',
            severity: 'Suggestion',
            title: 'tighten the retry backoff',
          },
        ],
      },
      comments: [],
    });

    withVerifyEnv(() => runSubmit(authorized({ review })));
    expect(ghMock).toHaveBeenCalledOnce();
    const sent = JSON.parse(ghMock.mock.calls[0][0] as string);
    expect(sent.body).toContain('Deferred under the convergence posture');
    expect(sent.body).toContain(
      '- `a.ts:1 — [review] tighten the retry backoff`',
    );
  });

  it('floor enforcement removes drafted Suggestions from the posted set', () => {
    // The posture SKILL Step 6 resolves in prose, enforced in code: under a
    // resolved critical floor, a Suggestion the drafted set did NOT defer is
    // moved into the body's deferral list by compose-review, and this — the
    // one boundary that posts — must remove it from what GitHub receives, or
    // the review would post inline comments its own body says were deferred.
    const review = file('floor-enforced.json', {
      ...REVIEW,
      state: {
        ...REVIEW.state,
        planPath: verifiedPlan(),
        severityFloor: 'critical',
      },
      comments: [
        { path: 'a.ts', line: 3, body: '**[Critical]** boom' },
        { path: 'b.ts', line: 7, body: '**[Suggestion]** tidy this' },
      ],
    });

    withVerifyEnv(() => runSubmit(authorized({ review })));
    expect(ghMock).toHaveBeenCalledOnce();
    const sent = JSON.parse(ghMock.mock.calls[0][0] as string);
    // The Suggestion did not post inline; the Critical did, and still blocks.
    expect(sent.comments).toHaveLength(1);
    expect(sent.comments[0].path).toBe('a.ts');
    expect(sent.event).toBe('REQUEST_CHANGES');
    // The finding is not lost: the body carries the disclosure and the entry.
    expect(sent.body).toContain('floor enforcement');
    expect(sent.body).toContain('- `b.ts:7 — [review] tidy this`');
    // Both operator channels say the override happened.
    expect(
      writeStderrSpy.mock.calls.some((c) =>
        String(c[0]).includes('Floor enforcement'),
      ),
    ).toBe(true);
    const out = JSON.parse(writeStdoutSpy.mock.calls.at(-1)![0] as string) as {
      inlineComments: number;
      floorEnforced: number;
    };
    expect(out.inlineComments).toBe(1);
    expect(out.floorEnforced).toBe(1);
  });

  it('reports floor enforcement in the dry run, not only after the write', () => {
    // The sibling field cappedBy has exactly this seam test; the dry run is
    // the operator's preview, and a preview that omits the override invites
    // posting a set the operator never saw described.
    const review = file('floor-dry.json', {
      ...REVIEW,
      state: {
        ...REVIEW.state,
        planPath: verifiedPlan(),
        severityFloor: 'critical',
      },
      comments: [
        { path: 'a.ts', line: 3, body: '**[Critical]** boom' },
        { path: 'b.ts', line: 7, body: '**[Suggestion]** tidy this' },
      ],
    });

    withVerifyEnv(() => runSubmit(authorized({ review, dryRun: true })));
    expect(ghMock).not.toHaveBeenCalled();
    const out = JSON.parse(writeStdoutSpy.mock.calls.at(-1)![0] as string) as {
      posted: boolean;
      wouldPost: boolean;
      floorEnforced: number;
    };
    expect(out.posted).toBe(false);
    expect(out.wouldPost).toBe(true);
    expect(out.floorEnforced).toBe(1);
    expect(
      writeStderrSpy.mock.calls.some((c) =>
        String(c[0]).includes('Floor enforcement'),
      ),
    ).toBe(true);
  });

  it("the recorded floor outranks the state's transcription", () => {
    // The state's severityFloor is a model-written copy of the operator's
    // policy; the gate's args re-parse recovers the verbatim one. A state
    // claiming `suggestion` (posture off) while the record says
    // `--severity-floor critical` must enforce — the copy does not get to
    // stand enforcement down.
    // No withVerifyEnv: it exports a session id, which (correctly) disables
    // the skillArgs test seam this test authorises through. The explicit
    // recorded floor needs no plan or round either — enforcement at
    // `critical` fires at any round, and the missing-plan caps only soften
    // the event, which this test does not assert.
    const review = file('floor-recorded.json', {
      ...REVIEW,
      state: {
        ...REVIEW.state,
        severityFloor: 'suggestion',
      },
      comments: [
        { path: 'a.ts', line: 3, body: '**[Critical]** boom' },
        { path: 'b.ts', line: 7, body: '**[Suggestion]** tidy this' },
      ],
    });

    runSubmit(
      args({
        review,
        skillArgs: file(
          'floor-args.txt',
          '6771 --comment --severity-floor critical',
        ),
        host: 'github.com',
      }),
    );
    expect(ghMock).toHaveBeenCalledOnce();
    const sent = JSON.parse(ghMock.mock.calls[0][0] as string);
    expect(sent.comments).toHaveLength(1);
    expect(sent.body).toContain('floor enforcement');
    expect(
      writeStderrSpy.mock.calls.some((c) =>
        String(c[0]).includes('verbatim record outranks'),
      ),
    ).toBe(true);
    // The note names its TRUE source: this one came from the flag.
    expect(
      writeStderrSpy.mock.calls.some((c) =>
        String(c[0]).includes('the recorded `--severity-floor` flag'),
      ),
    ).toBe(true);
  });

  it('does not fire the override note when the recovered floor equals the state', () => {
    // The equality guard is the only thing keeping a recovered-but-identical
    // floor from emitting the "record outranks state" note on every
    // non-drifted enforced post — a wrong claim on exactly the operator
    // audit channel this feature builds. The comparison is NORMALISED: a
    // case-drifted transcription of the same floor is agreement too.
    for (const stateFloor of ['critical', 'CRITICAL']) {
      ghMock.mockClear();
      writeStderrSpy.mockClear();
      const review = file(`floor-equal-${stateFloor}.json`, {
        ...REVIEW,
        state: { ...REVIEW.state, severityFloor: stateFloor },
        comments: [
          { path: 'a.ts', line: 3, body: '**[Critical]** boom' },
          { path: 'b.ts', line: 7, body: '**[Suggestion]** tidy this' },
        ],
      });

      runSubmit(
        args({
          review,
          skillArgs: file(
            `floor-equal-args-${stateFloor}.txt`,
            '6771 --comment --severity-floor critical',
          ),
          host: 'github.com',
        }),
      );
      expect(ghMock).toHaveBeenCalledOnce();
      expect(
        JSON.parse(ghMock.mock.calls[0][0] as string).comments,
      ).toHaveLength(1);
      expect(
        writeStderrSpy.mock.calls.some((c) =>
          String(c[0]).includes('verbatim record outranks'),
        ),
      ).toBe(false);
    }
  });

  it('a recorded explicit auto outranks a drifted critical — and does not enforce at round 1', () => {
    // An explicit `--severity-floor auto` is a real operator decision; a
    // maintainer conflating it with the default-resolved auto would let the
    // drifted state 'critical' stand and withhold findings the operator's
    // recorded policy posts at rounds ≤ 5.
    const review = file('floor-auto.json', {
      ...REVIEW,
      state: { ...REVIEW.state, severityFloor: 'critical' },
      comments: [
        { path: 'a.ts', line: 3, body: '**[Critical]** boom' },
        { path: 'b.ts', line: 7, body: '**[Suggestion]** tidy this' },
      ],
    });

    runSubmit(
      args({
        review,
        skillArgs: file(
          'floor-auto-args.txt',
          '6771 --comment --severity-floor auto',
        ),
        host: 'github.com',
      }),
    );
    expect(ghMock).toHaveBeenCalledOnce();
    expect(JSON.parse(ghMock.mock.calls[0][0] as string).comments).toHaveLength(
      2,
    );
    expect(
      writeStderrSpy.mock.calls.some((c) =>
        String(c[0]).includes('verbatim record outranks'),
      ),
    ).toBe(true);
  });

  it('the recovery also runs under --user-authorized — the report-first flow', () => {
    // The sanctioned report-first → user-publishes flow carries a parseable
    // record on disk; skipping recovery there left that flow's enforcement
    // decided by exactly the transcription enforcement distrusts.
    const review = file('floor-ua.json', {
      ...REVIEW,
      state: { ...REVIEW.state, severityFloor: 'suggestion' },
      comments: [
        { path: 'a.ts', line: 3, body: '**[Critical]** boom' },
        { path: 'b.ts', line: 7, body: '**[Suggestion]** tidy this' },
      ],
    });

    runSubmit(
      authorized({
        review,
        // The recorded host rides along: a bare-number recording carries no
        // platform evidence, and the user-authorized fast path now refuses
        // one outright (it cannot prove the target is not Aone). The floor
        // recovery under test is unchanged by it — the record still names
        // this PR and carries the operator's explicit floor.
        skillArgs: file(
          'floor-ua-args.txt',
          '6771 --host github.com --severity-floor critical',
        ),
      }),
    );
    expect(ghMock).toHaveBeenCalledOnce();
    const sent = JSON.parse(ghMock.mock.calls[0][0] as string);
    expect(sent.comments).toHaveLength(1);
    expect(sent.body).toContain('floor enforcement');
  });

  it('overrides in BOTH directions — a recorded posture-off outranks a drifted critical', () => {
    // Direction-independence: an enforcement-direction-only condition would
    // let a drifted state 'critical' stand over the operator's recorded
    // `--severity-floor suggestion`, silently inverting a posture-off
    // decision — findings the operator explicitly chose to post inline
    // would be withheld.
    const review = file('floor-reverse.json', {
      ...REVIEW,
      state: { ...REVIEW.state, severityFloor: 'critical' },
      comments: [
        { path: 'a.ts', line: 3, body: '**[Critical]** boom' },
        { path: 'b.ts', line: 7, body: '**[Suggestion]** tidy this' },
      ],
    });

    runSubmit(
      args({
        review,
        skillArgs: file(
          'floor-reverse-args.txt',
          '6771 --comment --severity-floor suggestion',
        ),
        host: 'github.com',
      }),
    );
    expect(ghMock).toHaveBeenCalledOnce();
    const sent = JSON.parse(ghMock.mock.calls[0][0] as string);
    expect(sent.comments).toHaveLength(2);
    expect(sent.body).not.toContain('floor enforcement');
    expect(
      writeStderrSpy.mock.calls.some((c) =>
        String(c[0]).includes('verbatim record outranks'),
      ),
    ).toBe(true);
  });

  it('the configured-setting floor leg reaches enforcement end to end', () => {
    // The `review.severityFloor` setting travels runSubmit opts →
    // authorization gate → parseReviewArgs defaults → recordedSeverityFloor.
    // The sibling defaultComment leg has exactly this wiring-regression test;
    // deleting any link in the new chain must fail here.
    const review = file('floor-configured.json', {
      ...REVIEW,
      state: { ...REVIEW.state },
      comments: [
        { path: 'a.ts', line: 3, body: '**[Critical]** boom' },
        { path: 'b.ts', line: 7, body: '**[Suggestion]** tidy this' },
      ],
    });

    runSubmit(
      args({
        review,
        skillArgs: file('floor-configured-args.txt', '6771 --comment'),
        host: 'github.com',
      }),
      'unknown',
      { defaultSeverityFloor: 'critical' },
    );
    expect(ghMock).toHaveBeenCalledOnce();
    const sent = JSON.parse(ghMock.mock.calls[0][0] as string);
    expect(sent.comments).toHaveLength(1);
    expect(sent.body).toContain('floor enforcement');
    // Setting-sourced: the note must name the setting, never a flag the
    // operator did not type.
    expect(
      writeStderrSpy.mock.calls.some((c) =>
        String(c[0]).includes(
          'setting resolved against the recorded invocation',
        ),
      ),
    ).toBe(true);
    expect(
      writeStderrSpy.mock.calls.some((c) =>
        String(c[0]).includes('the recorded `--severity-floor` flag'),
      ),
    ).toBe(false);
  });

  it('reroutes an unusable-line Suggestion instead of refusing the whole post', () => {
    // The removal runs BEFORE the consistency gate on purpose: a rerouted
    // comment is no longer posting, so its unusable line is no longer the
    // gate's business. Ordered the other way, the gate's wholesale refusal
    // would take the Critical down with it — the all-or-nothing harm the
    // 422 doctrine exists to prevent.
    const review = file('floor-bad-lines.json', {
      ...REVIEW,
      state: { ...REVIEW.state, severityFloor: 'critical' },
      comments: [
        { path: 'a.ts', line: 3, body: '**[Critical]** boom' },
        { path: 'b.ts', line: 0, body: '**[Suggestion]** zero-line anchor' },
        { path: 'c.ts', body: '**[Suggestion]** no line at all' },
      ],
    });

    runSubmit(authorized({ review }));
    expect(ghMock).toHaveBeenCalledOnce();
    const sent = JSON.parse(ghMock.mock.calls[0][0] as string);
    expect(sent.comments).toHaveLength(1);
    expect(sent.comments[0].path).toBe('a.ts');
    expect(sent.body).toContain('zero-line anchor');
    expect(sent.body).toContain('no line at all');
    expect(sent.body).toContain('floor enforcement');
    // The report channels count the MOVED comments, not the post-removal
    // remainder — the only shape where the two differ (2 moved, 1 remains),
    // so a count-source regression is visible only here.
    expect(
      writeStderrSpy.mock.calls.some((c) =>
        String(c[0]).includes('2 Suggestion comment(s)'),
      ),
    ).toBe(true);
    const out = JSON.parse(writeStdoutSpy.mock.calls.at(-1)![0] as string) as {
      floorEnforced: number;
    };
    expect(out.floorEnforced).toBe(2);
  });

  it('names a moved Critical by its axes — the move an operator would not expect from a floor (#10291)', () => {
    const review = file('floor-critical-axes.json', {
      ...REVIEW,
      state: { ...REVIEW.state, severityFloor: 'critical' },
      comments: [
        {
          path: 'a.ts',
          line: 3,
          body: '**[Critical]** [certifies-falsely] [new-surface] a decided stop over unread bytes',
        },
        {
          path: 'b.ts',
          line: 7,
          body: '**[Critical]** [fails-closed] [new-surface] sparse checkout wedges the round',
        },
        { path: 'c.ts', line: 9, body: '**[Suggestion]** tidy this' },
      ],
    });

    runSubmit(authorized({ review }));
    expect(ghMock).toHaveBeenCalledOnce();
    const sent = JSON.parse(ghMock.mock.calls[0][0] as string);
    // The wrong-result Critical posts; the fails-closed, new-surface one
    // and the Suggestion move into the body's deferral list.
    expect(sent.comments.map((c: { path: string }) => c.path)).toEqual([
      'a.ts',
    ]);
    expect(sent.body).toContain(
      'b.ts:7 — [review] Critical [fails-closed] [new-surface] sparse checkout wedges the round',
    );
    expect(
      writeStderrSpy.mock.calls.some((c) =>
        String(c[0]).includes(
          'Floor enforcement: 1 Suggestion comment(s) and 1 fails-closed, new-surface Critical comment(s) drafted past',
        ),
      ),
    ).toBe(true);
    const out = JSON.parse(writeStdoutSpy.mock.calls.at(-1)![0] as string) as {
      floorEnforced: number;
    };
    expect(out.floorEnforced).toBe(2);
  });

  it('rejects a line that is not a positive whole number', () => {
    // Every one of these 422s, and a 422 discards every blocker in the review.
    for (const [i, line] of [-1, 0, 2.5, NaN, Infinity].entries()) {
      const review = file(`bad-line-${i}.json`, {
        ...REVIEW,
        comments: [{ path: 'a.ts', line, body: '**[Critical]** x' }],
      });
      expect(() => runSubmit(authorized({ review }))).toThrow(/usable `line`/);
    }
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('refuses an empty-string body as empty, not as unmarked', () => {
    // Normalisation runs before the consistency check; a footer pasted onto
    // '' would turn the precise 'empty comment' refusal into a misleading
    // 'missing severity marker' one.
    const review = file('empty-body.json', {
      ...REVIEW,
      comments: [{ path: 'a.ts', line: 12, body: '' }],
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(/empty comment/);
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('refuses a `comments` field that is present but not an array', () => {
    // `"comments": {}` used to escape normalisation — which runs outside
    // `compose`'s try/catch — as a bare TypeError instead of the structured
    // refusal the re-compose loop parses.
    const review = file('comments-not-array.json', {
      ...REVIEW,
      comments: {},
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(
      /`comments` is not an array/,
    );
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('refuses a `comments` entry that is not an object', () => {
    // `"comments": [null]` cleared the arrayness check and threw a bare
    // TypeError in the normalisation `.map` — outside `compose`'s try/catch
    // — instead of the structured refusal the re-compose loop parses.
    const review = file('comments-null-entry.json', {
      ...REVIEW,
      comments: [null],
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(
      /entries must each be an object/,
    );
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('rejects a comment with no body', () => {
    const review = file('bad-9.json', {
      ...REVIEW,
      comments: [{ path: 'a.ts', line: 12 }],
    });
    expect(() => runSubmit(authorized({ review }))).toThrow(/empty comment/);
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('rejects a range that ends before it begins', () => {
    const review = file('bad-10.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 10,
          start_line: 12,
          side: 'RIGHT',
          start_side: 'RIGHT',
          body: '**[Critical]** x',
        },
      ],
    });
    expect(() => runSubmit(authorized({ review }))).toThrow(
      /cannot end before/,
    );
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('never produces the one combination GitHub itself rejects', () => {
    // A COMMENT with neither a body nor comments loses the review entirely. It used
    // to be a shape the caller could hand over, and this refused it. The caller
    // cannot hand over a body at all now — so the guarantee moves from a refusal to
    // a property: whatever the state, compose-review's COMMENT always carries text.
    const review = file('bad-5.json', {
      commit_id: 'abc123',
      comments: [],
      state: { suggestionsDiscarded: 1, modelId: 'm' },
    });

    runSubmit(authorized({ review }));
    const sent = JSON.parse(ghMock.mock.calls[0][0] as string);
    expect(sent.event).toBe('COMMENT');
    expect(sent.body.length).toBeGreaterThan(0);
  });
});

// The failure this whole change exists for.
describe('the verdict is computed, not carried', () => {
  const authorized = (over: Record<string, unknown> = {}) =>
    args({ userAuthorized: true, ...over });
  const posted = () => JSON.parse(ghMock.mock.calls[0][0] as string);

  it('cannot be told to Approve a review whose diff was never read', () => {
    // Dogfooded: a run read the coverage check's refusal, decided "the agents
    // clearly did their job", skipped compose-review, and reported an Approve.
    // Under the old shape it could then have posted one, because `event` was a
    // field in a JSON it wrote. Now the caps are recomputed from the harness's
    // transcripts on the way to the wire, and the Approve is simply not available.
    const review = file('cap.json', {
      commit_id: 'abc',
      comments: [],
      state: {
        modelId: 'm',
        unreviewedDimensions: ['security — the agent returned nothing twice'],
      },
    });

    runSubmit(authorized({ review }));

    expect(posted().event).toBe('COMMENT');
    expect(posted().body).toContain('security');
  });

  it('cannot approve a submission that brought no plan — it can show it read nothing', () => {
    // `planPath` is what coverage is recomputed from. Without it there is no
    // evidence any of the diff was opened, and a review that cannot show what it
    // read must not certify it. Fail-closed, at the wire.
    //
    // (The positive path — a clean state over a plan whose transcripts show the
    // chunks were read — is pinned in compose-review.test.ts, which owns the
    // transcript fixtures.)
    const review = file('noplan.json', {
      commit_id: 'abc',
      comments: [],
      state: { modelId: 'm' },
    });

    runSubmit(authorized({ review }));
    expect(posted().event).toBe('COMMENT');
    expect(posted().body).toMatch(/no plan was given/i);
  });

  it('does not let a hand-written Approve reach GitHub even once', () => {
    const review = file('forged.json', {
      commit_id: 'abc',
      event: 'APPROVE',
      body: 'LGTM — no blockers.',
      comments: [],
      state: { modelId: 'm', uncoverableChunks: ['chunk 5 (src/big.min.js)'] },
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(/not inputs/);
    expect(ghMock).not.toHaveBeenCalled();
  });
});

// The ledger's whole premise is that the marker rides the body GITHUB receives.
// It was once appended one layer above this path and reached only a file on
// disk, so the assertions that matter are the ones made on the posted payload —
// compose-review.test.ts owns the composition, this owns the wire.
describe('the ledger marker on the body that reaches GitHub', () => {
  const authorized = (over: Record<string, unknown> = {}) =>
    args({ userAuthorized: true, ...over });
  const posted = () => JSON.parse(ghMock.mock.calls[0][0] as string);

  it('carries the findings of this round, numbered off the recovered one', () => {
    const planPath = file('plan.json', { prNumber: 6771 });
    file('qwen-review-pr-6771-prev-ledger.json', {
      v: 1,
      round: 2,
      findings: [],
    });
    const review = file('ledger.json', {
      commit_id: 'abc',
      comments: [
        { path: 'src/a.ts', line: 12, body: '**[Critical]** double free' },
      ],
      state: { modelId: 'm', planPath },
    });

    runSubmit(authorized({ review }));

    const ledger = parseLedger(posted().body);
    expect(ledger?.round).toBe(3);
    expect(ledger?.findings).toEqual([
      {
        id: 'R3-1',
        sev: 'C',
        file: 'src/a.ts',
        line: 12,
        title: 'double free',
      },
    ]);
  });

  it('takes its contents from the comments posted, not from `state`', () => {
    // `draftedComments` is stripped off `state` here for the same reason `env`
    // and `prBodyFetcher` are: what the review carries is not a claim the
    // caller's JSON gets to make about what it reviewed.
    const planPath = file('plan2.json', { prNumber: 6771 });
    const review = file('forged-ledger.json', {
      commit_id: 'abc',
      comments: [
        { path: 'real.ts', line: 1, body: '**[Suggestion]** the real one' },
      ],
      state: {
        modelId: 'm',
        planPath,
        draftedComments: [
          { path: 'forged.ts', line: 9, body: '**[Critical]** never drafted' },
        ],
      },
    });

    runSubmit(authorized({ review }));

    const ledger = parseLedger(posted().body);
    expect(ledger?.findings).toEqual([
      { id: 'R1-1', sev: 'S', file: 'real.ts', line: 1, title: 'the real one' },
    ]);
  });

  // The anchor pair (`sha` + `model`) rides only on a CLEAN round — any cap
  // withholds it — and "clean" is recomputed here from the harness's
  // transcripts. Asserting the posted anchor therefore needs the covered
  // fixture compose-review.test.ts owns: chunks read by agents launched with
  // the CLI's recorded prompts, the test-matrix roster entry, Steps 4/5 on
  // record. Kept local so this suite's wire assertion stands on its own.
  const SESSION = 'SUBM';

  function coveredPlanAt(prNumber: number, fetchedSha: string): string {
    const diffPath = join(dir, 'covered-diff.diff');
    writeFileSync(diffPath, 'diff --git a/a.ts b/a.ts\n@@ -0,0 +1 @@\n+x\n');
    const planPath = join(dir, 'covered-plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        diffPathAbsolute: diffPath,
        fetchedSha,
        prNumber,
        srcDiffLines: 5000,
        diffLines: 5000,
        files: [
          { path: 'a.ts', kind: 'source', removedLines: 0, heavy: false },
        ],
        chunks: [
          {
            id: 1,
            startLine: 1,
            endLine: 100,
            files: [{ path: 'src/a.ts', newStart: 1, newEnd: 80 }],
          },
          {
            id: 2,
            startLine: 101,
            endLine: 200,
            files: [{ path: 'src/b.ts', newStart: 1, newEnd: 90 }],
          },
        ],
      }),
    );
    const sub = join(dir, 'subagents', SESSION);
    mkdirSync(sub, { recursive: true });
    const transcript = (id: string, launch: string, reads: string[]) => {
      const base = {
        agentId: id,
        agentName: 'general-purpose',
        sessionId: SESSION,
      };
      const lines: object[] = [
        {
          ...base,
          type: 'user',
          message: { role: 'user', parts: [{ text: launch }] },
        },
      ];
      for (const readPath of reads) {
        lines.push(
          {
            ...base,
            type: 'assistant',
            message: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'read_file',
                    args: { file_path: readPath },
                  },
                },
              ],
            },
          },
          {
            ...base,
            type: 'tool_result',
            message: {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    name: 'read_file',
                    response: { output: 'ok' },
                  },
                },
              ],
            },
          },
        );
      }
      lines.push({
        ...base,
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'No issues found.' }] },
      });
      writeFileSync(
        join(sub, `agent-${id}.jsonl`),
        lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      );
    };
    const d = promptRecordDir(planPath);
    mkdirSync(d, { recursive: true });
    const build = (
      key: string,
      id: string,
      launch: string,
      reads: string[],
    ) => {
      // Match production (`prompt-record.ts`): the record filename is the
      // percent-encoded key — a no-op for today's role keys, but a future
      // one `encodeURIComponent` transforms would otherwise be written to a
      // name the reader never looks for.
      writeFileSync(join(d, `${encodeURIComponent(key)}.txt`), launch);
      const brief = briefPath(planPath, key);
      writeFileSync(brief, `The ${key} brief.`);
      transcript(id, launch, [...reads, brief]);
    };
    const chunkPrompt = (chunk: number) =>
      `You are reviewing chunk ${chunk} of 2.\n` +
      `read_file(file_path="${briefPath(planPath, `chunk-${chunk}`)}")\n` +
      `read_file(file_path="${diffPath}", offset=${(chunk - 1) * 100}, limit=100)`;
    build('chunk-1', 'a1', chunkPrompt(1), [diffPath, diffPath]);
    build('chunk-2', 'a2', chunkPrompt(2), [diffPath, diffPath]);
    build(
      'test-matrix',
      'tm',
      `You are the test-coverage matrix agent.\n` +
        `read_file(file_path="${briefPath(planPath, 'test-matrix')}")\n` +
        `read_file(file_path="${diffPath}")`,
      [diffPath, diffPath],
    );
    build(
      'verify',
      'v1',
      `You are review agent \`verify\`.\n` +
        `read_file(file_path="${briefPath(planPath, 'verify')}")\n` +
        `read_file(file_path="${diffPath}")`,
      [diffPath, diffPath],
    );
    build(
      'reverse-audit',
      'r1',
      `You are review agent \`reverse-audit\`.\n` +
        `read_file(file_path="${briefPath(planPath, 'reverse-audit')}")\n` +
        `read_file(file_path="${diffPath}")`,
      [diffPath, diffPath],
    );
    // Transcripts must postdate the plan — the stale filter is the plan's mtime.
    const old = new Date(2020, 0, 1);
    utimesSync(planPath, old, old);
    return planPath;
  }

  it('injects the session model into the posted marker — QWEN_CODE_MODEL reaches the wire (wiring)', () => {
    // The certifying identity must be the model the runtime published for
    // the session — Config publishes it per session, the shell tool injects
    // it into this subprocess — superseding the id the state JSON typed.
    // Dropping the runtime argument from runSubmit's compose call keeps
    // every other suite green while the POSTED marker's `model` silently
    // falls back to the typed id: the exact silent substitution this wiring
    // exists to catch. Mirrors the
    // compose-review handler's wiring test at the one boundary whose body
    // reaches GitHub.
    const planPath = coveredPlanAt(6771, 'deadbeef00112233');
    const review = file('wire-model.json', {
      commit_id: 'abc',
      comments: [],
      state: { modelId: 'typed-by-the-model', planPath },
    });
    const prevDir = process.env['QWEN_CODE_PROJECT_DIR'];
    const prevSession = process.env['QWEN_CODE_SESSION_ID'];
    const prevModel = process.env['QWEN_CODE_MODEL'];
    // Cleared, not just saved: the boundary PREFERS the qualified identity
    // over the bare id, so an ambient one — which this PR's own Config now
    // publishes, and the shell tool injects into every subprocess — would
    // override the model this test sets. Running the suite inside a Qwen
    // Code session is the dogfooding path, so the ambient value is the
    // normal case, not the exotic one.
    const prevIdentity = process.env['QWEN_CODE_MODEL_IDENTITY'];
    delete process.env['QWEN_CODE_MODEL_IDENTITY'];
    process.env['QWEN_CODE_PROJECT_DIR'] = dir;
    process.env['QWEN_CODE_SESSION_ID'] = SESSION;
    process.env['QWEN_CODE_MODEL'] = 'the-session-model';
    // Seed the session-scoped recording the write gate binds when a
    // session id is present — the platform evidence.
    const sessionRecDir = join('.qwen', 'tmp', `s-${SESSION}`);
    mkdirSync(sessionRecDir, { recursive: true });
    writeFileSync(
      join(sessionRecDir, 'qwen-skill-args-review.txt'),
      'https://github.com/QwenLM/qwen-code/pull/6771\n',
    );
    try {
      runSubmit(authorized({ review }));
      const ledger = parseLedger(posted().body);
      expect(ledger?.sha).toBe('deadbeef00112233');
      expect(ledger?.model).toBe('the-session-model');
    } finally {
      rmSync(sessionRecDir, { recursive: true, force: true });
      for (const [key, prev] of [
        ['QWEN_CODE_PROJECT_DIR', prevDir],
        ['QWEN_CODE_SESSION_ID', prevSession],
        ['QWEN_CODE_MODEL', prevModel],
        ['QWEN_CODE_MODEL_IDENTITY', prevIdentity],
      ] as const) {
        if (prev === undefined) delete process.env[key];
        else process.env[key] = prev;
      }
    }
  });
});

// Six findings from the repo's own `/review` bot on this pull request. These are its.
describe('what the reviewer caught in this change', () => {
  const authorized = (over: Record<string, unknown> = {}) =>
    args({ userAuthorized: true, ...over });

  it('refuses `state: null`, which slipped past a `=== undefined` guard', () => {
    // `null` is not `undefined`, so the structural check passed it; `compose`'s
    // `?? {}` then collapsed it to an empty state and posted a review whose footer
    // named no model and whose caps came from nowhere.
    const review = file('null-state.json', {
      commit_id: 'abc',
      comments: [],
      state: null,
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(
      /`state` is missing/,
    );
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('shows `cappedBy` in the dry run, not only after the write', () => {
    // The point of `--dry-run` is to see what would be posted. Reporting
    // `"event": "COMMENT"` with no reason leaves the reader to guess why the Approve
    // went away.
    const review = file('capped.json', {
      commit_id: 'abc',
      comments: [],
      state: { modelId: 'm', uncoverableChunks: ['chunk 5 (src/big.min.js)'] },
    });

    runSubmit(authorized({ review, dryRun: true }));
    const out = JSON.parse(
      (writeStdoutSpy.mock.calls.at(-1)?.[0] as string) ?? '{}',
    );
    expect(out.event).toBe('COMMENT');
    expect(out.cappedBy).toContain('uncoverable-chunk');
  });

  it('strips a caller-supplied prBodyFetcher — a state JSON cannot suppress the Chinese fold', () => {
    // submit is the only boundary that posts, and its strip is the one with no
    // test. Deleting `prBodyFetcher: _droppedFetcher` from the destructure
    // leaves every other test green. Without the strip, `null` is invoked as
    // a function, throws, and the fail-safe catch drops the fold — the exact
    // regression this PR closes, through the door that publishes.
    ghViewMock.mockReturnValue('{"body":"这个 PR 修复了双语渲染。"}');
    const planPath = file('plan.json', {
      chunks: [],
      ownerRepo: 'QwenLM/qwen-code',
      prNumber: '6771',
    });
    runSubmit(
      authorized({
        review: file('fetcher-strip.json', {
          commit_id: 'abc123',
          comments: [],
          state: { modelId: 'm', planPath, prBodyFetcher: null },
        }),
      }),
    );
    const body = (
      JSON.parse(ghMock.mock.calls[0][0] as string) as { body: string }
    ).body;
    expect(body).toContain('中文说明');
  });
});

// The submit receipt is the WRITE half of cleanup's bypass-audit contract:
// cleanup reads the review ids it records to tell a sanctioned review from a
// bypass. Every other test here leaves ghMock returning '' (so JSON.parse of
// the response throws and the receipt block hits its catch), which means the
// happy path where a receipt is actually written was never exercised. These
// run the command from inside the fixture dir so the relative .qwen/tmp
// receipt lands there.
describe('submit receipt (producer half of the audit contract)', () => {
  const receiptPath = () =>
    join(dir, '.qwen', 'tmp', 'qwen-review-pr-6771-submit-receipt.json');

  const authorizedPost = (over: Record<string, unknown> = {}) =>
    args({ userAuthorized: true, ...over });

  let savedCwd: string;
  beforeEach(() => {
    savedCwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => process.chdir(savedCwd));

  it('writes the posted review id, event and a timestamp', () => {
    ghMock.mockImplementationOnce(() => JSON.stringify({ id: 42 }));
    runSubmit(authorizedPost());
    const receipt = JSON.parse(readFileSync(receiptPath(), 'utf8'));
    expect(receipt.reviewIds).toEqual([42]);
    expect(receipt.event).toBe('COMMENT');
    expect(typeof receipt.postedAt).toBe('string');
  });

  it('accumulates ids across two submits in the same window (drift restart)', () => {
    ghMock.mockImplementationOnce(() => JSON.stringify({ id: 42 }));
    runSubmit(authorizedPost());
    ghMock.mockImplementationOnce(() => JSON.stringify({ id: 43 }));
    runSubmit(authorizedPost());
    const receipt = JSON.parse(readFileSync(receiptPath(), 'utf8'));
    expect(receipt.reviewIds).toEqual([42, 43]);
  });

  it('migrates a legacy single-id receipt on the next submit', () => {
    mkdirSync(join(dir, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      receiptPath(),
      JSON.stringify({ reviewId: 7, event: 'COMMENT', postedAt: 'x' }),
    );
    ghMock.mockImplementationOnce(() => JSON.stringify({ id: 8 }));
    runSubmit(authorizedPost());
    const receipt = JSON.parse(readFileSync(receiptPath(), 'utf8'));
    expect(receipt.reviewIds).toEqual([7, 8]);
  });

  it('preserves the comment-id axis an Aone submit vouched for the same PR number', () => {
    // The receipt file is keyed by PR number alone but carries an axis per
    // platform; a gh rewrite that kept only its own axis would un-vouch a
    // same-numbered Aone submit's own comments — the audit would then flag
    // submit's sanctioned writes as bypasses.
    mkdirSync(join(dir, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      receiptPath(),
      JSON.stringify({ commentIds: [31], event: 'COMMENT', postedAt: 'x' }),
    );
    ghMock.mockImplementationOnce(() => JSON.stringify({ id: 44 }));
    runSubmit(authorizedPost());
    const receipt = JSON.parse(readFileSync(receiptPath(), 'utf8'));
    expect(receipt.reviewIds).toEqual([44]);
    expect(receipt.commentIds).toEqual([31]);
  });

  it('writes atomically, leaving no .tmp sibling behind', () => {
    ghMock.mockImplementationOnce(() => JSON.stringify({ id: 42 }));
    runSubmit(authorizedPost());
    expect(readFileSync(receiptPath(), 'utf8')).toContain('"reviewIds"');
    const tmpDir = join(dir, '.qwen', 'tmp');
    const leftovers = readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

// The link back to what was just written. GitHub's Create Review response
// carries `html_url` — the deep link to the review — and submit relays it in
// both channels, because a summary without it leaves the user to reassemble
// the PR address by hand. Best-effort like the receipt: a response without it
// (or an unparseable one) must never fail a review that DID post — the
// provider composes the PR-page URL instead when the routing host is
// knowable; when it is NOT (gh's own hosts.yml default is not visible here),
// the receipt stays linkless rather than affirm a host the write may not
// have taken.
describe('the posted-review link', () => {
  const authorizedPost = (over: Record<string, unknown> = {}) =>
    args({ userAuthorized: true, ...over });
  const stdoutJson = () =>
    JSON.parse(writeStdoutSpy.mock.calls.at(-1)![0] as string);

  let savedCwd: string;
  beforeEach(() => {
    savedCwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => process.chdir(savedCwd));

  it('relays html_url in the stdout JSON and the Posted line', () => {
    const url =
      'https://github.com/QwenLM/qwen-code/pull/6771#pullrequestreview-42';
    ghMock.mockImplementationOnce(() =>
      JSON.stringify({ id: 42, html_url: url }),
    );
    runSubmit(authorizedPost());
    expect(stdoutJson()).toMatchObject({ posted: true, url });
    const postedLine = writeStderrSpy.mock.calls
      .map((c) => c[0] as string)
      .find((l) => l.startsWith('Posted '));
    expect(postedLine).toContain(url);
  });

  it('composes the PR-page url when the response carries no deep link', () => {
    // A response without html_url used to leave the receipt linkless and the
    // skill prose assembled the URL by hand. That assembly is code now: the
    // provider composes the PR page from the knowable host and the target
    // the post took. The exported GH_HOST supplies it here — setGhHost is
    // mocked out, so the routing bind at submit time cannot.
    process.env['GH_HOST'] = 'github.com';
    ghMock.mockImplementationOnce(() => JSON.stringify({ id: 42 }));
    runSubmit(authorizedPost());
    expect(stdoutJson()).toMatchObject({
      posted: true,
      url: 'https://github.com/QwenLM/qwen-code/pull/6771',
    });
    const postedLine = writeStderrSpy.mock.calls
      .map((c) => c[0] as string)
      .find((l) => l.startsWith('Posted '));
    expect(postedLine).toContain(
      'https://github.com/QwenLM/qwen-code/pull/6771',
    );
  });

  it('still reports posted:true when the response is unparseable', () => {
    // ghMock's default return is '' — JSON.parse throws, and the receipt and
    // the link ride the same best-effort read of a post that succeeded; the
    // composed fallback still lands in the JSON.
    process.env['GH_HOST'] = 'github.com';
    runSubmit(authorizedPost());
    expect(stdoutJson().posted).toBe(true);
    expect(stdoutJson().url).toBe(
      'https://github.com/QwenLM/qwen-code/pull/6771',
    );
  });

  it('keeps the receipt linkless when the routing host is not knowable', () => {
    // No routed host (setGhHost is a no-op here) and no exported GH_HOST (the
    // file-level beforeEach deletes it): gh's own third fallback — hosts.yml's
    // authenticated default — decides where the write lands, and a composed
    // github.com link could resolve to a real, unrelated PR of a same-named
    // repo. The post still stands; only the link is dropped.
    ghMock.mockImplementationOnce(() => JSON.stringify({ id: 42 }));
    runSubmit(authorizedPost());
    const out = stdoutJson();
    expect(out.posted).toBe(true);
    expect(out.url).toBeUndefined();
    const postedLine = writeStderrSpy.mock.calls
      .map((c) => c[0] as string)
      .find((l) => l.startsWith('Posted '));
    expect(postedLine).toBeDefined();
    expect(postedLine).not.toContain('https://');
  });
});
