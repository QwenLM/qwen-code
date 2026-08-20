/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Aone is a POSTING target now (Phase 3): `submit` routes an Aone-bound
// review at `submitAoneReview` (the a1 write path), never at gh. The
// routing arms the old read-only refusal tested still decide the platform
// — they now decide WHICH PLATFORM receives the write.

import {
  afterAll,
  afterEach,
  beforeEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  ghMock,
  ghWithInputMock,
  setGhHostMock,
  getPlatformReaderMock,
  gitOptMock,
  authMock,
  floorMock,
  submitAoneMock,
  composeMock,
  stdoutMock,
  stderrMock,
} = vi.hoisted(() => ({
  ghMock: vi.fn(),
  ghWithInputMock: vi.fn(),
  setGhHostMock: vi.fn(),
  getPlatformReaderMock: vi.fn(),
  gitOptMock: vi.fn(),
  authMock: vi.fn(),
  floorMock: vi.fn(() => undefined),
  submitAoneMock: vi.fn(),
  composeMock: vi.fn(),
  stdoutMock: vi.fn(),
  stderrMock: vi.fn(),
}));

vi.mock('./lib/gh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/gh.js')>();
  return {
    ...actual,
    gh: ghMock,
    ghWithInput: ghWithInputMock,
    setGhHost: setGhHostMock,
    currentUser: vi.fn(() => 'someone-else'),
  };
});

// Steer detection so the routing's environment arms fire regardless of cwd.
vi.mock('./lib/platform/registry.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./lib/platform/registry.js')>();
  return {
    ...actual,
    getPlatformReader: getPlatformReaderMock,
  };
});

// The cwd arm of the write gate reads the origin URL through gitOpt —
// steer it so the cwd-probe cells fire regardless of the vitest cwd.
vi.mock('./lib/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/git.js')>();
  return {
    ...actual,
    gitOpt: gitOptMock,
  };
});

// The a1 write seam — mocked so no test reaches a real `a1` (a write to a
// platform is never a test fixture). importOriginal keeps the real
// AonePartialPostError class, so submit's `instanceof` check reads the
// same constructor the test throws.
vi.mock('./lib/platform/aone.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./lib/platform/aone.js')>();
  return {
    ...actual,
    submitAoneReview: submitAoneMock,
  };
});

// Steer the authorisation gate (incl. the recordedHost it surfaces) — the
// real gate needs a session-scoped args file that does not exist under
// vitest. `recordedSeverityFloor` yields nothing by default (the state's
// floor stands); a named mock so the floor's callerHost wiring can be
// pinned (an anonymous vi.fn left it unobservable).
vi.mock('./lib/authorization.js', () => ({
  reviewWriteAuthorization: authMock,
  recordedSeverityFloor: floorMock,
}));

// The verdict event is compose-review's business (its decision table is
// tested there, gated on harness transcripts this file does not fabricate).
// Mock it so these tests can drive submit's event-dependent branches — the
// Aone routing, the request-changes note, the approve handling — with a
// deterministic event.
vi.mock('./compose-review.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./compose-review.js')>();
  return {
    ...actual,
    composeReview: composeMock,
  };
});

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: stdoutMock,
  writeStderrLine: stderrMock,
}));

import { runSubmit } from './submit.js';
import {
  AonePartialPostError,
  type AoneSubmitRequest,
} from './lib/platform/aone.js';

let tmp: string;
let savedGhHost: string | undefined;
let seq = 0;

/** A payload with one marked Critical — composes into REQUEST_CHANGES. */
const REVIEW = {
  commit_id: 'abc123',
  comments: [
    {
      path: 'src/foo.ts',
      line: 12,
      body: '**[Critical]** Off-by-one in the loop bound.',
    },
  ],
  state: { modelId: 'test-model' },
};

/** A zero-finding payload — composes into an APPROVE. */
const CLEAN_REVIEW = {
  commit_id: 'abc123',
  comments: [],
  state: { suggestionsDiscarded: 1, modelId: 'test-model' },
};

function writeReview(payload: unknown): string {
  const p = join(tmp, `review-${seq++}.json`);
  writeFileSync(p, JSON.stringify(payload), 'utf8');
  return p;
}

function base(over: Record<string, unknown> = {}) {
  return {
    pr: 1,
    repo: 'maxcompute/odps_src',
    review: writeReview(REVIEW),
    userAuthorized: true,
    dryRun: false,
    ...over,
  };
}

const AONE_RESULT = {
  // postedInline and inlineCommentIds DIVERGE on purpose: an
  // accepted-but-unreadable comment counts as posted but carries no id.
  // submit's success JSON must read `postedInline`, not the id list —
  // pinning the divergence pins the source.
  inlineCommentIds: [11],
  postedInline: 2,
  summaryCommentId: 12,
  summaryPosted: true,
  approved: false,
  // Verified stable — the ordinary success shape. The re-read-failure
  // (undefined) and moved (true) states have their own tests below.
  headMovedDuringPost: false,
  webUrl: 'https://code.alibaba-inc.com/maxcompute/odps_src/codereview/1',
};

interface PostedJson {
  posted?: boolean;
  reason?: string;
  wouldPost?: boolean;
  target?: string;
  event?: string;
  cappedBy?: string[];
  inlineComments?: number;
  postedCommentIds?: number[];
  summaryCommentId?: number;
  summaryPosted?: boolean;
  approved?: boolean;
  url?: string;
}

function postedJson(): PostedJson {
  const call = stdoutMock.mock.calls.map((c) => String(c[0])).join('');
  return JSON.parse(call) as PostedJson;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'submit-aone-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('submit posts an authorised Aone target through a1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    savedGhHost = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
    // Default: authorised via the fast path with a recording that names
    // the canonical Aone git host — the hostless fast path refuses (that
    // refusal has its own tests below), so the posting tests carry a
    // recorded host.
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
      recordedHost: 'gitlab.alibaba-inc.com',
    });
    getPlatformReaderMock.mockReturnValue({ kind: 'aone' });
    // Default cwd probe: no origin — the cwd arm yields nothing, so the
    // routing keys off the recorded/explicit host alone.
    gitOptMock.mockReturnValue(null);
    submitAoneMock.mockReturnValue({ ...AONE_RESULT });
    composeMock.mockReturnValue({
      event: 'REQUEST_CHANGES',
      body: 'One confirmed blocker blocks the merge.',
      cappedBy: [],
      floorEnforced: [],
    });
  });

  afterEach(() => {
    if (savedGhHost === undefined) delete process.env['GH_HOST'];
    else process.env['GH_HOST'] = savedGhHost;
    process.exitCode = undefined;
  });

  it('posts the findings via submitAoneReview, never gh', () => {
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(submitAoneMock).toHaveBeenCalledTimes(1);
    // The Aone path FORCES context-unavailable into the compose input —
    // the cap lives where `aoneWrite` is a fact, not in the model-written
    // state, so an omitted/forged field cannot buy a real platform
    // approval. Dropping the force must fail this pin.
    expect(
      (composeMock.mock.calls[0][0] as Record<string, unknown>)[
        'contextUnavailable'
      ],
    ).toBe(true);
    const req = submitAoneMock.mock.calls[0][0] as AoneSubmitRequest;
    expect(req.prNumber).toBe(1);
    expect(req.ownerRepo).toBe('maxcompute/odps_src');
    expect(req.commitId).toBe('abc123');
    expect(req.event).toBe('REQUEST_CHANGES');
    expect(req.body).toBe('One confirmed blocker blocks the merge.');
    expect(req.comments).toEqual([
      {
        path: 'src/foo.ts',
        line: 12,
        body: expect.stringContaining('**[Critical]**'),
      },
    ]);
    expect(ghMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).not.toHaveBeenCalled();
    // The a1 path never touches the gh host state — deleting the
    // `if (!aoneWrite)` guard around setGhHost would leave the gh
    // routing host set to an Aone hostname for any gh call added later.
    expect(setGhHostMock).not.toHaveBeenCalled();
    const out = postedJson();
    expect(out.posted).toBe(true);
    expect(out.event).toBe('REQUEST_CHANGES');
    // The success JSON reads `postedInline` (2), NOT the id list (1) —
    // the fixture diverges the two on purpose.
    expect(out.inlineComments).toBe(2);
    // ...but the id list still RIDES the JSON — the audit reconciling
    // "what did this run post" against the MR needs it on the success
    // path exactly as the partial shape carries it.
    expect(out.postedCommentIds).toEqual([11]);
    expect(out.summaryCommentId).toBe(12);
    expect(out.summaryPosted).toBe(true);
    expect(out.url).toBe(AONE_RESULT.webUrl);
    // The D6 semantic difference is named in the terminal — conditional
    // on what actually posted: this payload carries one inline Critical.
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('no native request-changes state'),
    );
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('1 inline Critical(s) block the merge'),
    );
    // The verified-stable success (headMovedDuringPost false) prints
    // NEITHER drift warning — a truthiness mutation of the tri-state
    // condition would print one of them for the ordinary success shape.
    expect(stderrMock).not.toHaveBeenCalledWith(
      expect.stringContaining('MOVED during posting'),
    );
    expect(stderrMock).not.toHaveBeenCalledWith(
      expect.stringContaining('could not re-verify the MR head'),
    );
  });

  it('an UNAUTHORISED Aone run takes the normal auth-refusal path first', () => {
    authMock.mockReturnValue({
      ok: false,
      why: '`--comment` was not in the review arguments',
    });
    expect(() =>
      runSubmit(base({ userAuthorized: false }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    const out = postedJson();
    expect(out.posted).toBe(false);
    expect(out.reason).not.toBe('aone-post-failed');
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('a padded Aone --host still routes to a1 (the flag is trimmed)', () => {
    getPlatformReaderMock.mockReturnValue({ kind: 'github' });
    expect(() =>
      runSubmit(base({ host: ' gitlab.alibaba-inc.com ' }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(submitAoneMock).toHaveBeenCalledTimes(1);
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('the AMBIENT GH_HOST never selects Aone for a write — even pointing at the canonical Aone git host', () => {
    // GH_HOST is a GitHub-ROUTING variable; the write gate never consults
    // it — the cwd probe (a github origin here) decides, not GH_HOST.
    // Slow-path shape (a same-session recording with `--comment`, no
    // host).
    authMock.mockReturnValue({
      ok: true,
      why: '`--comment` was in the review arguments for #1',
    });
    gitOptMock.mockReturnValue('git@github.com:acme/web.git');
    ghWithInputMock.mockReturnValue('');
    process.env['GH_HOST'] = 'gitlab.alibaba-inc.com';
    expect(() =>
      runSubmit(base({ userAuthorized: false }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).toHaveBeenCalledTimes(1);
    // The gh write binds the cwd probe's host instead of restoring env
    // inheritance — otherwise it would route at the very ambient Aone
    // host the title promises can never interfere.
    expect(setGhHostMock).toHaveBeenCalledWith('github.com');
  });

  it('a wildcard *.alibaba-inc.com GH_HOST (an org GHE, not Aone) never routes to a1', () => {
    // The family suffix also names GitHub Enterprise instances; an
    // irreversible write must not take the a1 path on a family
    // resemblance. Same slow-path shape as above.
    authMock.mockReturnValue({
      ok: true,
      why: '`--comment` was in the review arguments for #1',
    });
    gitOptMock.mockReturnValue('git@github.com:acme/web.git');
    ghWithInputMock.mockReturnValue('');
    process.env['GH_HOST'] = 'ghe.alibaba-inc.com';
    expect(() =>
      runSubmit(base({ userAuthorized: false }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).toHaveBeenCalledTimes(1);
    expect(setGhHostMock).toHaveBeenCalledWith('github.com');
  });

  it('an explicit wildcard-family --host (a GHE host) routes to gh, not a1, and binds gh at that host', () => {
    // The family suffix also names GitHub Enterprise instances; an
    // explicit GHE flag is platform proof for the gh path, and the gh
    // write must then ROUTE at the flag's host, not the ambient env.
    // No recorded host: a recorded Aone host beside this flag is a
    // contradiction and refuses (the conflict test above).
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
    });
    ghWithInputMock.mockReturnValue('');
    expect(() =>
      runSubmit(base({ host: 'ghe.alibaba-inc.com' }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).toHaveBeenCalledTimes(1);
    expect(setGhHostMock).toHaveBeenCalledWith('ghe.alibaba-inc.com');
    // Ordering is the point of the bind: a late-binding refactor moving
    // setGhHost below the gh write leaves toHaveBeenCalledWith green
    // while gh runs with the module host unset and inherits the ambient
    // env — posting past the host this test names.
    expect(setGhHostMock.mock.invocationCallOrder[0]).toBeLessThan(
      ghWithInputMock.mock.invocationCallOrder[0],
    );
  });

  it('a RECORDED family-but-non-canonical host binds the gh write at the recorded host', () => {
    // A recorded `--host ghe.alibaba-inc.com` is family-but-NOT-canonical,
    // so it routes at gh — and with no explicit flag the gh write must
    // bind at the RECORDED host, not wherever the ambient env points
    // (github.com's same-named repo otherwise).
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
      recordedHost: 'ghe.alibaba-inc.com',
    });
    getPlatformReaderMock.mockReturnValue({ kind: 'github' });
    ghWithInputMock.mockReturnValue('');
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).toHaveBeenCalledTimes(1);
    expect(setGhHostMock).toHaveBeenCalledWith('ghe.alibaba-inc.com');
    expect(setGhHostMock.mock.invocationCallOrder[0]).toBeLessThan(
      ghWithInputMock.mock.invocationCallOrder[0],
    );
  });

  it('an explicit --host that CONTRADICTS the recorded host refuses — in BOTH directions', () => {
    // The explicit flag FILLS a gap in the recorded evidence (the
    // unbound refusal's remedy); it does not override the recording's
    // answer. A recorded Aone target submitted with an explicit
    // github.com would retarget the irreversible write at github.com's
    // same-named repo — the recorded host is the user's own keystrokes,
    // and the review was composed for the platform it names. Refuse,
    // exit-3, naming both hosts.
    authMock.mockReturnValue({
      ok: true,
      why: '`--comment` was in the review arguments for #1',
      recordedHost: 'code.alibaba-inc.com',
    });
    expect(() =>
      runSubmit(base({ host: 'github.com' }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({
      posted: false,
      reason: 'target-platform-conflict',
    });
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).not.toHaveBeenCalled();
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('contradicts the host the recorded review'),
    );

    // The mirror direction: a recorded non-Aone host contradicts an
    // explicit canonical-Aone flag.
    process.exitCode = undefined;
    stdoutMock.mockClear();
    stderrMock.mockClear();
    authMock.mockReturnValue({
      ok: true,
      why: '`--comment` was in the review arguments for #1',
      recordedHost: 'github.com',
    });
    expect(() =>
      runSubmit(base({ host: 'gitlab.alibaba-inc.com' }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({
      posted: false,
      reason: 'target-platform-conflict',
    });
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('an ALIASED explicit --host still passes — the Aone web/git pair is one platform', () => {
    // The conflict check compares through hostsEquivalent: the CR URL
    // records the WEB host while the skill's --host rule for Aone
    // targets carries the GIT host. That is one platform under two
    // names, not a contradiction — refusing it would kill the canonical
    // Aone post shape.
    authMock.mockReturnValue({
      ok: true,
      why: '`--comment` was in the review arguments for #1',
      recordedHost: 'code.alibaba-inc.com',
    });
    expect(() =>
      runSubmit(base({ host: 'gitlab.alibaba-inc.com' }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(submitAoneMock).toHaveBeenCalledTimes(1);
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('a RECORDED Aone host routes to a1 even when the effective host is non-Aone', () => {
    // Fail-closed becomes route-correctly: a recorded codereview-URL target
    // names an Aone host; an ambient GH_HOST export (the Enterprise
    // pattern) must not steer the write past Aone to the wrong host's
    // same-named repo.
    authMock.mockReturnValue({
      ok: true,
      why: '`--comment` was in the review arguments for #1',
      recordedHost: 'code.alibaba-inc.com',
    });
    getPlatformReaderMock.mockReturnValue({ kind: 'github' });
    process.env['GH_HOST'] = 'ghe.example.com';
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(submitAoneMock).toHaveBeenCalledTimes(1);
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('a RECORDED non-Aone host is not vetoed by an Aone cwd probe', () => {
    // The recorded pr-url binding is the explicit signal the registry's
    // precedence documents — a github.com review run from inside an
    // Aone-origin clone must still post to GitHub. The probe is driven
    // through gitOpt (submit's real cwd seam — it no longer reads
    // getPlatformReader), so the conflict this test names is actually
    // exercised: a recorded-binding-outranks-probe regression routing
    // the github-recorded review at a1 reddens here.
    authMock.mockReturnValue({
      ok: true,
      why: '`--comment` was in the review arguments for #1',
      recordedHost: 'github.com',
    });
    gitOptMock.mockReturnValue('git@gitlab.alibaba-inc.com:g/p.git');
    ghWithInputMock.mockReturnValue('');
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).toHaveBeenCalledTimes(1);
    expect(postedJson().posted).toBe(true);
    // The force applies ONLY to the Aone path — a GitHub write hands the
    // state's own context claim through RAW (the reads are backed there):
    // this fixture state carries no claim, so undefined reaches compose —
    // coercing it to false here would also coerce a malformed non-boolean
    // claim past compose-review's deliberate shape refusal.
    expect(
      (composeMock.mock.calls[0][0] as Record<string, unknown>)[
        'contextUnavailable'
      ],
    ).toBeUndefined();
  });

  it('the FAST path with no recording at all refuses — the cwd probe must not guess the platform', () => {
    // No recording (recordedHost undefined, no recordedUnbound) is a
    // documented degraded state: writeSkillArgs never throws, recordings
    // are cwd-relative. With no `--host` the cwd probe alone would pick
    // the platform of an irreversible write — fail closed instead. The
    // probe is LIVE here (a canonical Aone origin): a null origin gives
    // the probe no opinion to override, and the override — refusal
    // preceding the probe — is exactly the property under test.
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
    });
    gitOptMock.mockReturnValue('git@gitlab.alibaba-inc.com:g/p.git');
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({
      posted: false,
      reason: 'target-platform-unbound',
    });
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('no recorded review names this target'),
    );
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('the SLOW path may still let the cwd probe decide (same-session recording)', () => {
    // The slow path reads the CURRENT session's own recording, so it is
    // same-session by construction — the cwd names the clone the review
    // ran in, sound evidence rather than a guess. A bare-number recording
    // with `--comment` and no host posts via the cwd-detected platform.
    authMock.mockReturnValue({
      ok: true,
      why: '`--comment` was in the review arguments for #1',
    });
    gitOptMock.mockReturnValue('git@gitlab.alibaba-inc.com:g/p.git');
    expect(() =>
      runSubmit(base({ userAuthorized: false }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(submitAoneMock).toHaveBeenCalledTimes(1);
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('an explicit --host OUTRANKS a live cwd probe pointing the other way', () => {
    // The probe must not veto the operator's platform proof: re-running
    // a publish with an explicit github.com from an Aone-origin clone
    // posts at GitHub — the documented precedence, and the remedy the
    // unbound refusal names. A mutant making the cwd arm additive
    // (probing beside the explicit flag instead of after it) routes the
    // irreversible write at a1 and leaves every prior test green.
    authMock.mockReturnValue({
      ok: true,
      why: '`--comment` was in the review arguments for #1',
    });
    gitOptMock.mockReturnValue('git@gitlab.alibaba-inc.com:g/p.git');
    ghWithInputMock.mockReturnValue('');
    expect(() =>
      runSubmit(
        base({ userAuthorized: false, host: 'github.com' }),
        'unknown',
        {
          defaultComment: false,
        },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).toHaveBeenCalledTimes(1);
  });

  it('the unbound refusal OUTRANKS a live canonical cwd probe', () => {
    // A recorded-but-hostless target refuses even when the probe could
    // name a platform: a mutant letting the probe lift the refusal
    // (`&& !isAoneCanonicalHost(cwdOriginHost)` on the guard) posts a
    // bare-MR target at whichever canonical-Aone clone submit happens
    // to run in — the probe names submit's cwd, not the review's.
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
      recordedUnbound: true,
    });
    gitOptMock.mockReturnValue('git@gitlab.alibaba-inc.com:g/p.git');
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({
      posted: false,
      reason: 'target-platform-unbound',
    });
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('a canonical-Aone ambient GH_HOST with NO other host evidence refuses — gh cannot post there', () => {
    // No origin (zip/bundle worktree, `git remote remove origin`), no
    // recorded host, no flag: the gh child would inherit the ambient
    // GH_HOST export. Pointing at a canonical Aone host that is a write
    // gh cannot perform — pre-PR this shape refused actionably, so
    // refuse actionably instead of failing opaquely after compose ran.
    authMock.mockReturnValue({
      ok: true,
      why: '`--comment` was in the review arguments for #1',
    });
    gitOptMock.mockReturnValue(null);
    process.env['GH_HOST'] = 'gitlab.alibaba-inc.com';
    expect(() =>
      runSubmit(base({ userAuthorized: false }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({
      posted: false,
      reason: 'ambient-gh-host-aone',
    });
    expect(stderrMock).toHaveBeenCalledWith(expect.stringContaining('GH_HOST'));
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).not.toHaveBeenCalled();

    // The family-wildcard twin is a GitHub Enterprise instance gh CAN
    // post to — no refusal there; the write proceeds.
    process.exitCode = undefined;
    stdoutMock.mockClear();
    ghWithInputMock.mockClear();
    process.env['GH_HOST'] = 'ghe.alibaba-inc.com';
    ghWithInputMock.mockReturnValue('');
    expect(() =>
      runSubmit(base({ userAuthorized: false }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).toHaveBeenCalledTimes(1);
  });

  it('a WELL-FORMED contextUnavailable: true passes through on the gh path', () => {
    // The gh path hands the state's claim through raw. A mutation
    // dropping the passthrough (forcing `aoneWrite` alone) ships green
    // against the sibling fixture that carries NO claim, and silently
    // loses the context-unavailable verdict cap on a GitHub submission
    // that legitimately earned it.
    authMock.mockReturnValue({
      ok: true,
      why: '`--comment` was in the review arguments for #1',
      recordedHost: 'github.com',
    });
    ghWithInputMock.mockReturnValue('');
    expect(() =>
      runSubmit(
        base({
          review: writeReview({
            ...REVIEW,
            state: { modelId: 'test-model', contextUnavailable: true },
          }),
        }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(
      (composeMock.mock.calls[0][0] as Record<string, unknown>)[
        'contextUnavailable'
      ],
    ).toBe(true);
  });

  it('the floor recovery binds the RECORDED Aone host, not the gh fallback', () => {
    // A flagless Aone post routed via the recorded binding must resolve
    // the operator's floor against the RECORDED host. Wiring callerHost
    // to resolveGhHost alone (github.com/ambient) would bind the floor
    // to github.com, hostsEquivalent would fail the Aone CR-URL record,
    // and the operator's recorded floor would be silently dropped — a
    // model-written lower floor composing the verdict instead.
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
      recordedHost: 'code.alibaba-inc.com',
    });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(floorMock).toHaveBeenCalledWith(
      expect.objectContaining({ callerHost: 'code.alibaba-inc.com' }),
    );
  });

  it('an EMPTY --host flag refuses distinctly — an empty flag is not an absent one', () => {
    // Agent-built commands interpolate the host (`--host "$REVIEW_HOST"`
    // with the variable unset/empty hands through ''); collapsing that
    // to "no flag" would fire the very refusal the flag was the remedy
    // for, byte-identically, and the re-runner loops. Refuse it with
    // its own shape.
    for (const host of ['', ' ']) {
      process.exitCode = undefined;
      stdoutMock.mockClear();
      stderrMock.mockClear();
      expect(() =>
        runSubmit(base({ host }), 'unknown', { defaultComment: false }),
      ).not.toThrow();
      expect(process.exitCode).toBe(3);
      expect(postedJson()).toEqual({
        posted: false,
        reason: 'host-flag-empty',
      });
      expect(stderrMock).toHaveBeenCalledWith(expect.stringContaining('EMPTY'));
    }
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('an INVALID recorded host refuses in the exit-3 shape, not a setGhHost TypeError', () => {
    // parse-args records --host VERBATIM; a recorded `https://ghe.corp`
    // used to throw setGhHost's TypeError straight out of runSubmit —
    // exit 1, stack text, no stdout JSON — instead of the refusal shape
    // Step 7 treats as a complete, correct outcome.
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
      recordedHost: 'https://ghe.corp',
    });
    ghWithInputMock.mockReturnValue('');
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({ posted: false, reason: 'invalid-host' });
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('the recorded review'),
    );
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('re-record the review with a valid'),
    );
    // The recorded arm gets NO flag remedy: a valid flag contradicts
    // the invalid recorded host (hostsEquivalent cannot match a value
    // that fails HOSTNAME_RE) and an equivalent flag fails HOSTNAME_RE
    // itself — "re-run with --host" ping-pongs between the two
    // refusals, so the refusal must lead with the re-recording escape.
    expect(
      stderrMock.mock.calls.map((c) => String(c[0])).join(''),
    ).not.toContain('Re-run with');
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).not.toHaveBeenCalled();

    // The explicit-flag arm names the flag as the offender.
    process.exitCode = undefined;
    stdoutMock.mockClear();
    stderrMock.mockClear();
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
    });
    expect(() =>
      runSubmit(base({ host: 'https://ghe.corp' }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({ posted: false, reason: 'invalid-host' });
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('`--host` flag'),
    );
  });

  it('an INVALID cwd-origin host refuses naming the origin arm', () => {
    // The third provenance arm: no flag, no recorded host — the bound
    // host is the origin of the clone the cwd probe ran on.
    // parseRemoteUrl does not validate the hostname (an underscore
    // host parses intact), so the refusal must happen here and name
    // THIS arm — a misattribution mutant passes every other cell.
    authMock.mockReturnValue({
      ok: true,
      why: '`--comment` was in the review arguments for #1',
    });
    gitOptMock.mockReturnValue('git@ghe_corp.example.com:o/r.git');
    expect(() =>
      runSubmit(base({ userAuthorized: false }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({ posted: false, reason: 'invalid-host' });
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining(`this clone's origin remote`),
    );
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('a mid-batch failure discloses a head that moved during posting', () => {
    // The drift disclosure rides the partial shape too — adding a write
    // failure must not silently remove the warning the success path
    // prints for the identical drift.
    submitAoneMock.mockImplementation(() => {
      throw new AonePartialPostError(
        'boom after 1 of 3 landed',
        1,
        [11],
        false,
        false,
        true,
      );
    });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('the MR head MOVED during posting'),
    );
    expect(stderrMock).not.toHaveBeenCalledWith(
      expect.stringContaining('could not re-verify the MR head'),
    );
  });

  it('a mid-batch failure whose head re-read VERIFIED STABLE prints neither drift warning', () => {
    // Absence pin for the false state: a truthiness mutation of the
    // disclosure condition (`!== undefined`, or `true`) prints MOVED —
    // or the re-read warning — for a partial post whose drift state is
    // verified stable, and only these absence assertions catch it.
    submitAoneMock.mockImplementation(() => {
      throw new AonePartialPostError(
        'boom after 1 of 3 landed',
        1,
        [11],
        false,
        false,
        false,
      );
    });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(stderrMock).not.toHaveBeenCalledWith(
      expect.stringContaining('MOVED during posting'),
    );
    expect(stderrMock).not.toHaveBeenCalledWith(
      expect.stringContaining('could not re-verify the MR head'),
    );
  });

  it('a successful post whose head re-read FAILED discloses the unknown state', () => {
    // "Could not verify" is not "verified stable": the tri-state field
    // stays undefined on a re-read failure and submit says so, instead
    // of the false all-clear a boolean fold would print.
    submitAoneMock.mockReturnValue({
      ...AONE_RESULT,
      headMovedDuringPost: undefined,
    });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('could not re-verify the MR head'),
    );
  });

  it('a HOSTLESS recording from the --skill-args override refuses — the submission cwd must not stand in for the record of another cwd', () => {
    // The slow path can authorise from a caller-supplied --skill-args
    // file when no session id is present — a recording that belongs to
    // ANOTHER cwd. The cwd probe names submit's clone, not the review's:
    // a bare-number recording from a github clone, published from an
    // Aone-origin cwd, must not flip the irreversible write to Aone on
    // the probe's say-so. Fail closed like the fast-path hostless shape;
    // the --host remedy lifts it.
    authMock.mockReturnValue({
      ok: true,
      why: '`--comment` was in the review arguments for #1',
      viaSkillArgsOverride: true,
    });
    gitOptMock.mockReturnValue('git@gitlab.alibaba-inc.com:g/p.git');
    expect(() =>
      runSubmit(base({ userAuthorized: false }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({
      posted: false,
      reason: 'target-platform-unbound',
    });
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('--skill-args'),
    );
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).not.toHaveBeenCalled();

    // The --host remedy lifts the refusal — the explicit flag is
    // platform proof, posted via a1 here.
    process.exitCode = undefined;
    stdoutMock.mockClear();
    expect(() =>
      runSubmit(
        base({ userAuthorized: false, host: 'gitlab.alibaba-inc.com' }),
        'unknown',
        { defaultComment: false },
      ),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(submitAoneMock).toHaveBeenCalledTimes(1);
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('a HOSTFUL override recording still routes at its recorded host', () => {
    // The override flag only fails closed the HOSTLESS form: a recording
    // from another cwd that names a host carries its own platform
    // evidence — the review ran where the recording says.
    authMock.mockReturnValue({
      ok: true,
      why: '`--comment` was in the review arguments for #1',
      recordedHost: 'gitlab.alibaba-inc.com',
      viaSkillArgsOverride: true,
    });
    gitOptMock.mockReturnValue('git@github.com:acme/web.git');
    expect(() =>
      runSubmit(base({ userAuthorized: false }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(submitAoneMock).toHaveBeenCalledTimes(1);
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('a cwd origin on a FAMILY-WILDCARD host (an org GHE) never takes the a1 path', () => {
    // The cwd arm probes the origin through the CANONICAL predicate, not
    // the registry's family-wildcard detection: `ghe.alibaba-inc.com`
    // matches `*.alibaba-inc.com` but is a GitHub Enterprise instance,
    // and an irreversible write must not ride a family resemblance. It
    // falls through to the gh path.
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
    });
    gitOptMock.mockReturnValue('git@ghe.alibaba-inc.com:ghe-org/ghe-repo.git');
    ghWithInputMock.mockReturnValue('');
    expect(() =>
      runSubmit(base({ userAuthorized: false }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).toHaveBeenCalledTimes(1);
    // The gh write binds the SAME evidence that selected it — the cwd
    // origin. Without the bind, setGhHost(undefined) restored ambient
    // env inheritance and the write routed past the very clone that
    // chose the platform (github.com's same-named repo, or the ambient
    // GH_HOST).
    expect(setGhHostMock).toHaveBeenCalledWith('ghe.alibaba-inc.com');
  });

  it('a recorded-but-hostless target still refuses — a write must not guess the platform', () => {
    // The canonical Aone invocation shape records a bare MR number; with
    // no `--host` the platform is unprovable. Both platforms are writable
    // now, which makes the guess WORSE, not better: it would land the
    // review on the wrong one's same-named repo.
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
      recordedUnbound: true,
    });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({
      posted: false,
      reason: 'target-platform-unbound',
    });
    expect(stderrMock).toHaveBeenCalledWith(expect.stringContaining('--host'));
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('the --host remedy the unbound refusal names actually WORKS — the re-run posts', () => {
    // The refusal tells the agent to re-run with `--host`; the re-run must
    // not meet the same refusal. An explicit flag is platform proof: an
    // Aone host routes at a1, a non-Aone host at gh.
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
      recordedUnbound: true,
    });
    expect(() =>
      runSubmit(base({ host: 'gitlab.alibaba-inc.com' }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(submitAoneMock).toHaveBeenCalledTimes(1);
    expect(ghWithInputMock).not.toHaveBeenCalled();

    submitAoneMock.mockClear();
    ghWithInputMock.mockClear();
    ghWithInputMock.mockReturnValue('');
    expect(() =>
      runSubmit(base({ host: 'github.com' }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).toHaveBeenCalledTimes(1);
  });

  it('dry-run validates and composes but never calls a1', () => {
    expect(() =>
      runSubmit(base({ dryRun: true }), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).not.toHaveBeenCalled();
    const out = postedJson();
    expect(out.posted).toBe(false);
    expect(out.wouldPost).toBe(true);
    expect(String(out.target)).toContain('a1 repo mr comment create');
    expect(out.event).toBe('REQUEST_CHANGES');
  });

  it('a mid-batch a1 failure exits 3, warns against a re-run, and carries the structured counts', () => {
    // A retry would double-post every comment that already landed; the
    // exit-3 shape is what Step 7 accepts as terminal. `posted: false`
    // alone would let a wrapper that retries on "not posted" double-post,
    // so the JSON carries `partial: true` (the do-not-retry signal) and
    // the landed ids (what "inspect the MR" reconciles against).
    submitAoneMock.mockImplementation(() => {
      throw new AonePartialPostError(
        'boom after 1 of 3 landed',
        1,
        [11],
        false,
      );
    });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({
      posted: false,
      reason: 'aone-post-failed',
      partial: true,
      postedInline: 1,
      postedCommentIds: [11],
      summaryPosted: false,
      ambiguous: false,
    });
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('do NOT re-run submit'),
    );
    // The undefined drift state is the ordinary partial shape — the
    // re-read dies in the same outage that killed the batch — so
    // disclose the unknown anchoring instead of letting silence read
    // as "the landed pins were verified", and never print MOVED for a
    // merely unknown state.
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('could not re-verify the MR head'),
    );
    expect(stderrMock).not.toHaveBeenCalledWith(
      expect.stringContaining('MOVED during posting'),
    );
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('an AMBIGUOUS failure warns against a re-run even when the count is zero', () => {
    // The failed write may have reached the server before the transport
    // died, so the MR can carry a comment the count never saw. Counting
    // it as NOT landed would suppress the advisory and a re-run would
    // double-post it — ambiguous counts as landed.
    submitAoneMock.mockImplementation(() => {
      throw new AonePartialPostError(
        'first create died mid-flight',
        0,
        [],
        false,
        true,
      );
    });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({
      posted: false,
      reason: 'aone-post-failed',
      partial: true,
      postedInline: 0,
      postedCommentIds: [],
      summaryPosted: false,
      // The flag rides the stdout JSON, not only stderr: all-zero counts
      // with a silent ambiguous flag read as a clean total failure, and
      // the user hand-posting the "remainder" double-posts the comment
      // the count never saw.
      ambiguous: true,
    });
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('do NOT re-run submit'),
    );
  });

  it('a deliberate pre-write refusal (head drift) exits 3 as a refusal, distinct from a failure', () => {
    submitAoneMock.mockImplementation(() => {
      throw new Error('refusing to post: the MR head moved …');
    });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({
      posted: false,
      reason: 'aone-post-refused',
    });
    const stderr = stderrMock.mock.calls.map((c) => String(c[0])).join('');
    expect(stderr).toContain('the MR head moved');
    expect(stderr).not.toContain('do NOT re-run submit');
  });

  it('an UNEXPECTED pre-write error rethrows — gh parity, retryable, nothing landed', () => {
    // Auth expiry, a DNS blip in the mr view read, the 120 s deadline:
    // provably nothing landed, so folding these into the exit-3 refusal
    // shape would lose an authorised review to a recoverable blip. The
    // gh path surfaces the same shape as an ordinary command failure.
    submitAoneMock.mockImplementation(() => {
      throw new Error('a1 auth check failed — token expired');
    });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).toThrow(/token expired/);
    expect(submitAoneMock).toHaveBeenCalledTimes(1);
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('an APPROVE runs the native approval and reports it', () => {
    composeMock.mockReturnValue({
      event: 'APPROVE',
      body: 'No issues found. LGTM!',
      cappedBy: [],
      floorEnforced: [],
    });
    submitAoneMock.mockReturnValue({
      ...AONE_RESULT,
      inlineCommentIds: [],
      postedInline: 0,
      approved: true,
    });
    expect(() =>
      runSubmit(base({ review: writeReview(CLEAN_REVIEW) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const req = submitAoneMock.mock.calls[0][0] as AoneSubmitRequest;
    expect(req.event).toBe('APPROVE');
    const out = postedJson();
    expect(out.posted).toBe(true);
    expect(out.approved).toBe(true);
    // A fully-successful native approval must NOT print the
    // approve-failure WARNING (that would tell the operator to re-run an
    // approval that already succeeded).
    const stderr = stderrMock.mock.calls.map((c) => String(c[0])).join('');
    expect(stderr).not.toContain('a1 repo mr approve');
  });

  it('an approve failure keeps the post but names the missing command', () => {
    composeMock.mockReturnValue({
      event: 'APPROVE',
      body: 'No issues found. LGTM!',
      cappedBy: [],
      floorEnforced: [],
    });
    submitAoneMock.mockReturnValue({
      ...AONE_RESULT,
      inlineCommentIds: [],
      postedInline: 0,
      approved: false,
      approveError: 'permission denied',
    });
    expect(() =>
      runSubmit(base({ review: writeReview(CLEAN_REVIEW) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(postedJson().posted).toBe(true);
    expect(postedJson().approved).toBe(false);
    // Pin the FULL hand-run remedy — the pr/repo interpolations included.
    // A transposed or --repo-less command fails by hand and the MR stays
    // silently unapproved. And the USER is named as the actor: Step 7
    // forbids the agent every `a1` write, and "run it by hand" without an
    // actor would hand the agent the exact call the rule exists to
    // prevent.
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'a1 repo mr approve 1 --repo maxcompute/odps_src',
      ),
    );
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('ask the USER to run that command'),
    );
  });

  it('a head that moved DURING posting discloses the orphaned pins', () => {
    // The drift gate is check-then-post; an amend pushed mid-batch slips
    // it. The post stands, but the success report must not claim the pins
    // held.
    submitAoneMock.mockReturnValue({
      ...AONE_RESULT,
      headMovedDuringPost: true,
    });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(postedJson().posted).toBe(true);
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('MR head MOVED during posting'),
    );
  });

  it('an attribution-OFF Aone post strips the severity prefix and appends the invisible marker', () => {
    // The Aone request consumes finalComments — the attribution-off
    // rewrite. Without this case, passing raw payload.comments stays
    // green and an attribution-off operator posts visible prefixes and
    // loses the marker presubmit/pr-context key on.
    expect(() =>
      runSubmit(base(), 'unknown', {
        defaultComment: false,
        attribution: false,
      }),
    ).not.toThrow();
    const req = submitAoneMock.mock.calls[0][0] as AoneSubmitRequest;
    expect(req.comments).toHaveLength(1);
    expect(req.comments[0].body).not.toContain('**[Critical]**');
    expect(req.comments[0].body).toContain('<!-- qwen-review critical -->');
    // The RC Note counts criticals off payload.comments (the MARKED
    // set), not the prefix-stripped finalComments: a mutant counting
    // the posted shape would read zero Criticals here — the prefix was
    // stripped by this very rewrite — and tell the operator nothing
    // mechanically blocks the merge at the exact moment an inline
    // Critical discussion IS blocking it.
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('1 inline Critical(s) block the merge'),
    );
  });

  it('the Aone success JSON carries NO url key when a1 answered without detailUrl', () => {
    // The url-ABSENCE arm is what SKILL.md Step 7's fallback keys on —
    // emitting `"url": ""` would not satisfy "has no url".
    submitAoneMock.mockReturnValue({ ...AONE_RESULT, webUrl: '' });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(postedJson().posted).toBe(true);
    expect('url' in postedJson()).toBe(false);
  });

  it('a REQUEST_CHANGES with zero inline Criticals says nothing mechanically blocks', () => {
    // All Criticals can be body-level (build/test gates, unmappable
    // whole-PR blockers): the RC posts with no Critical discussion
    // threads, so the Note must not claim the merge is blocked.
    const suggestionOnly = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 12,
          body: '**[Suggestion]** Prefer a named constant here.',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(suggestionOnly) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('NO inline Critical discussions'),
    );
  });
});
