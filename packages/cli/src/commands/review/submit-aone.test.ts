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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  anchorsRelocated?: number;
  anchorsDiscarded?: number;
}

function postedJson(): PostedJson {
  const call = stdoutMock.mock.calls.map((c) => String(c[0])).join('');
  return JSON.parse(call) as PostedJson;
}

/**
 * The refusal shape every gate in the command speaks (#9940 review): a
 * stderr line naming the offence, the `{"posted": false}` JSON on
 * stdout, exit 3.
 */
function expectRefusal(run: () => void, message: RegExp): void {
  run();
  expect(process.exitCode).toBe(3);
  const stderr = stderrMock.mock.calls.map((c) => String(c[0])).join('\n');
  expect(stderr).toMatch(message);
  expect(postedJson()).toEqual({
    posted: false,
    reason: 'payload-contradicts-itself',
  });
}

/**
 * The captured diff the Aone anchor gate validates against — submit reads
 * it at the fetch-pr convention path, cwd-relative, so the suite chdirs
 * into its temp dir. One hunk of `src/foo.ts` covering new-side lines
 * 9-15: the standing REVIEW payload's line 12 sits inside it; anything
 * outside is the gate's relocate/discard class.
 */
const CAPTURED_DIFF = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index 1111111..2222222 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -9,7 +9,7 @@',
  ' ctx',
  ' ctx',
  ' ctx',
  '-old',
  '+new',
  ' ctx',
  ' ctx',
  ' ctx',
  '',
].join('\n');

let savedCwd: string;
let diffPath: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'submit-aone-'));
  mkdirSync(join(tmp, '.qwen', 'tmp'), { recursive: true });
  diffPath = join(tmp, '.qwen', 'tmp', 'qwen-review-pr-1-diff.txt');
  writeFileSync(diffPath, CAPTURED_DIFF, 'utf8');
  savedCwd = process.cwd();
  process.chdir(tmp);
});

afterAll(() => {
  process.chdir(savedCwd);
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
      fixedFindings: [],
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
    // The Aone path hands the state's contextUnavailable claim through
    // UNCHANGED — parity with GitHub, now that pr-context is Aone-backed
    // and a run's claim means what it says there. The REVIEW state carries
    // no claim, so nothing is forced either way. Reintroducing the old
    // force must fail this pin.
    expect(
      (composeMock.mock.calls[0][0] as Record<string, unknown>)[
        'contextUnavailable'
      ],
    ).toBeUndefined();
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
    // The Q4 probe outcome (issue #9614) is disclosed in the same note:
    // a1 cannot mark a comment as AI, so the posted Criticals join the
    // discussion gate only — the repo's ai_comment gate never sees them.
    // One contiguous fragment from the blocking clause to the end of the
    // disclosure pins subject-to-predicate and clause-to-call — inverted
    // gate attribution, split calls, and a disclosure moved onto the
    // unconditional `Posted …` line each break it.
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "block the merge while their discussions stay unresolved. They are NOT marked as AI comments — `a1 repo mr comment create` cannot set the flag — so they join the generic discussion gate only; a repo's dedicated ai_comment merge gate does not track them",
      ),
    );
  });

  it('a fixed ruling on an Aone target is NAMED as GitHub-only — no thread read, no resolve', () => {
    // The thread lifecycle is GitHub-only: an Aone submit carrying Step 6
    // `fixed` rulings must not fire a GitHub GraphQL read at the wrong
    // platform, and must say the rulings were not applied.
    composeMock.mockReturnValue({
      event: 'REQUEST_CHANGES',
      body: 'One confirmed blocker blocks the merge.',
      cappedBy: [],
      floorEnforced: [],
      fixedFindings: [{ id: 'R1-2', by: 'the guard rewrite' }],
    });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(submitAoneMock).toHaveBeenCalledTimes(1);
    expect(ghMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).not.toHaveBeenCalled();
    const stderr = stderrMock.mock.calls.map((c) => String(c[0])).join('');
    expect(stderr).toContain('thread lifecycle is GitHub-only');
    expect(stderr).toContain('1 fixed ruling(s)');
  });

  it('a carried finding on an Aone target posts inline — no thread read on the wrong platform (#9940 review)', () => {
    // The thread-read trigger has TWO legs — carried comments as well as
    // fixed rulings. Both live inside the GitHub arm: an Aone submit
    // carrying a carried re-post must post it inline, never fire a
    // GitHub GraphQL read on a host where GitHub is not the platform.
    const review = writeReview({
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 12,
          body: '**[Suggestion]** R1-2: still stands at HEAD',
        },
      ],
      state: { suggestionsDiscarded: 1, modelId: 'test-model' },
    });
    expect(() =>
      runSubmit(base({ review }), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(submitAoneMock).toHaveBeenCalledTimes(1);
    const req = submitAoneMock.mock.calls[0][0] as AoneSubmitRequest;
    expect(req.comments).toEqual([
      {
        path: 'src/foo.ts',
        line: 12,
        body: expect.stringContaining('R1-2: still stands at HEAD'),
      },
    ]);
    expect(ghMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('an Aone submit never stamps ledger ids into the posted bodies', () => {
    // The stamp exists for the GitHub review-thread graph; the Aone
    // write path has none, so the `!aoneWrite` half of the stamp guard
    // must hold even when compose minted ids (#9940 review).
    composeMock.mockReturnValue({
      event: 'REQUEST_CHANGES',
      body: 'One confirmed blocker blocks the merge.',
      cappedBy: [],
      floorEnforced: [],
      fixedFindings: [],
      draftedIds: ['R1-1'],
    });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(submitAoneMock).toHaveBeenCalledTimes(1);
    const req = submitAoneMock.mock.calls[0][0] as AoneSubmitRequest;
    // The marker and claim stay adjacent — a stamp would splice its id
    // between them — and no id prefix rides the body anywhere.
    expect(req.comments).toEqual([
      {
        path: 'src/foo.ts',
        line: 12,
        body: expect.stringContaining(
          '**[Critical]** Off-by-one in the loop bound.',
        ),
      },
    ]);
    expect((req.comments as Array<{ body: string }>)[0].body).not.toMatch(
      /R\d+-\d+:/,
    );
    expect(ghMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('the contextUnavailable claim crosses the Aone seam unchanged, in BOTH directions', () => {
    // true stays true — a run that never read the MR keeps its cap.
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
    vi.clearAllMocks();
    composeMock.mockReturnValue({
      event: 'REQUEST_CHANGES',
      body: 'One confirmed blocker blocks the merge.',
      cappedBy: [],
      floorEnforced: [],
      fixedFindings: [],
    });
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
      recordedHost: 'gitlab.alibaba-inc.com',
    });
    getPlatformReaderMock.mockReturnValue({ kind: 'aone' });
    submitAoneMock.mockReturnValue({ ...AONE_RESULT });
    // false stays false — a run that READ the MR is no longer force-capped:
    // the wired approval is reachable on a clean verdict.
    expect(() =>
      runSubmit(
        base({
          review: writeReview({
            ...REVIEW,
            state: { modelId: 'test-model', contextUnavailable: false },
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
    ).toBe(false);
  });

  it('an UNAUTHORISED Aone run takes the normal auth-refusal path first', () => {
    authMock.mockReturnValue({
      ok: false,
      cls: 'comment-not-requested',
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
    // No path forces the claim anymore — a GitHub write hands the
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
    // The flag arm has NO recorded host — its remedy is the re-run with a
    // valid flag. Pin it positively: a mutant collapsing the remedy
    // ternary to the recorded arm's re-record text ships green against
    // the offender naming alone.
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('Re-run with a valid'),
    );
  });

  it('a whitespace-PADDED recorded host posts — the gate trims like setGhHost', () => {
    // parse-args records --host VERBATIM, but every read path trims —
    // padded hosts are a known-good input class (registry.ts) because
    // setGhHost trims internally before its own HOSTNAME_RE check. The
    // pre-validation must test the TRIMMED value, or a padded recorded
    // host that posted fine pre-PR refuses as invalid-host with the
    // re-record remedy — the costliest fix for stray whitespace.
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
      recordedHost: ' ghe.alibaba-inc.com ',
    });
    getPlatformReaderMock.mockReturnValue({ kind: 'github' });
    ghWithInputMock.mockReturnValue('');
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).toHaveBeenCalledTimes(1);
    expect(setGhHostMock).toHaveBeenCalledTimes(1);
    expect(postedJson().posted).toBe(true);

    // All-whitespace is NOT a padded host: it trims to '' which fails
    // HOSTNAME_RE, so the structured refusal stands. Pin it so the trim
    // fix cannot go further and normalize this shape into an absent
    // host (which would restore setGhHost's raw TypeError exit-1, or
    // worse, post unbound).
    process.exitCode = undefined;
    stdoutMock.mockClear();
    stderrMock.mockClear();
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
      recordedHost: '   ',
    });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({ posted: false, reason: 'invalid-host' });
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).toHaveBeenCalledTimes(1);
  });

  it('a padded RECORDED canonical Aone host still selects the a1 path', () => {
    // The platform selector reads the recorded host through the same
    // one-time trim as the gh arm: parse-args records verbatim, and a
    // padded canonical host the gh arm accepts as a known-good input
    // class must also be RECOGNISED as Aone — read untrimmed, the
    // selector misses it and routes the authorised Aone write down the
    // gh path at a host gh cannot post to.
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
      recordedHost: ' code.alibaba-inc.com ',
    });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(submitAoneMock).toHaveBeenCalledTimes(1);
    expect(ghWithInputMock).not.toHaveBeenCalled();
    expect(setGhHostMock).not.toHaveBeenCalled();
  });

  it('a padded recorded host and its trim-equivalent --host post — one platform', () => {
    // The conflict gate compares the trimmed flag against the recorded
    // host through hostsEquivalent; the recorded side must reach that
    // comparison trimmed, or two spellings of ONE platform refuse as
    // target-platform-conflict while the same recording posts fine the
    // moment the flag is dropped.
    authMock.mockReturnValue({
      ok: true,
      why: '`--comment` was in the review arguments for #1',
      recordedHost: ' gitlab.alibaba-inc.com ',
    });
    expect(() =>
      runSubmit(base({ host: 'gitlab.alibaba-inc.com' }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(process.exitCode).toBeUndefined();
    expect(postedJson().posted).toBe(true);
    expect(submitAoneMock).toHaveBeenCalledTimes(1);
    expect(ghWithInputMock).not.toHaveBeenCalled();
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
    // The same positive remedy pin as the flag arm: the origin arm has no
    // recorded host either — a ternary-collapse mutant would print the
    // re-record text here.
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('Re-run with a valid'),
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
    // The refusal speaks the same prefix as the other refusal paths — the
    // earlier "REFUSED to post the review to" broke the uniform shape.
    expect(stderr).toContain('REFUSED to post to ');
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
      fixedFindings: [],
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
      fixedFindings: [],
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
    // The note counts off the MARKED pre-post payload, not the stripped
    // bodies pinned above (severityOf is a leading-marker classifier and
    // reads null on them): attribution-OFF still names the posted
    // Critical and the gate disclosure.
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('1 inline Critical(s) block the merge'),
    );
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('ai_comment merge gate does not track them'),
    );
  });

  it('the Aone success JSON carries NO url key when the pre-write read served no detailUrl — and pays no re-query', () => {
    // The receipt's webUrl IS the pre-write drift-gate read's detailUrl, a
    // stable MR attribute — a re-fetch through the reader could not return
    // a link that read lacked, so submit takes the receipt as-is (it would
    // only pay a blocking a1 call on the flaky state that lost the field).
    // The url-ABSENCE arm is what SKILL.md Step 7's coordinates-relay keys
    // on — emitting `"url": ""` would not satisfy "has no url".
    submitAoneMock.mockReturnValue({ ...AONE_RESULT, webUrl: '' });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(postedJson().posted).toBe(true);
    expect('url' in postedJson()).toBe(false);
    // The pre-write read happened inside submitAoneReview (mocked here);
    // submit itself made no further platform call for the link.
    expect(submitAoneMock).toHaveBeenCalledTimes(1);
  });

  it('relays the receipt webUrl in the stdout JSON and the Posted line', () => {
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(postedJson().url).toBe(AONE_RESULT.webUrl);
    const postedLine = stderrMock.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.startsWith('Posted '));
    expect(postedLine).toContain(AONE_RESULT.webUrl);
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
    // The gate disclosure fires only when inline Criticals actually
    // posted — the zero-Critical shape discloses no gate at all.
    expect(stderrMock).not.toHaveBeenCalledWith(
      expect.stringContaining('does not track them'),
    );
  });
});

describe('the Aone anchor gate — the validation the platform does not perform', () => {
  // Aone Code posts ANY `--line` without checking it against the diff
  // (probed on a scratch CR): an old-side number silently becomes the
  // same-numbered new-side line. The gate performs the check GitHub's
  // server does — against the captured diff — and degrades the failures
  // exactly like the GitHub 422 recovery: Critical into the body,
  // Suggestion discarded, each disclosed. See
  // docs/design/2026-08-21-review-aone-removed-line-anchoring.md.

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    savedGhHost = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
      recordedHost: 'gitlab.alibaba-inc.com',
    });
    getPlatformReaderMock.mockReturnValue({ kind: 'aone' });
    gitOptMock.mockReturnValue(null);
    submitAoneMock.mockReturnValue({ ...AONE_RESULT });
    composeMock.mockReturnValue({
      event: 'REQUEST_CHANGES',
      body: 'One confirmed blocker blocks the merge.',
      cappedBy: [],
      floorEnforced: [],
      fixedFindings: [],
    });
  });

  afterEach(() => {
    if (savedGhHost === undefined) delete process.env['GH_HOST'];
    else process.env['GH_HOST'] = savedGhHost;
    process.exitCode = undefined;
  });

  it('relocates an unanchorable Critical into the body and discards an unanchorable Suggestion, with disclosure', () => {
    // The captured-diff hunk covers src/foo.ts new-side lines 9-15: line
    // 12 anchors, line 4 and line 9999 are the silent-misanchor class.
    const mixed = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 12,
          body: '**[Suggestion]** Anchors fine — stays inline.',
        },
        {
          path: 'src/foo.ts',
          line: 4,
          body: '**[Critical]** Old-side number — would misanchor.',
        },
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Suggestion]** Beyond EOF — would misanchor.',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(mixed) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    // Only the valid anchor reaches the write batch.
    const req = submitAoneMock.mock.calls[0][0] as AoneSubmitRequest;
    expect(req.comments).toEqual([
      {
        path: 'src/foo.ts',
        line: 12,
        body: expect.stringContaining('Anchors fine'),
      },
    ]);
    // The verdict is composed over the CORRECTED set: the relocated
    // Critical rides the body channel (counted toward C there), the
    // discard counts toward S, and the inline counts reflect only what
    // posts.
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['bodyCriticals']).toEqual([
      'Old-side number — would misanchor. — src/foo.ts:4',
    ]);
    expect(input['suggestionsDiscarded']).toBe(1);
    expect(input['criticalsInline']).toBe(0);
    expect(input['suggestionsInline']).toBe(1);
    // Every degrade is named in the terminal.
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'Aone anchor check: 2 inline comment(s) cannot be anchored',
      ),
    );
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('relocated into the summary body: src/foo.ts:4'),
    );
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('discarded: src/foo.ts:9999'),
    );
    const out = postedJson();
    expect(out.posted).toBe(true);
    expect(out['anchorsRelocated']).toBe(1);
    expect(out['anchorsDiscarded']).toBe(1);
  });

  it('relocates a declared LEFT-side anchor even when the number sits inside a hunk', () => {
    // The platform cannot express the old side; a number that HAPPENS to
    // exist on the new side would post there silently. Declared LEFT is
    // unanchorable by construction.
    const leftSide = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 12,
          side: 'LEFT',
          body: '**[Critical]** About the deleted old-side line.',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(leftSide) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const req = submitAoneMock.mock.calls[0][0] as AoneSubmitRequest;
    expect(req.comments).toEqual([]);
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['bodyCriticals']).toEqual([
      'About the deleted old-side line. — src/foo.ts:12',
    ]);
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('relocated into the summary body: src/foo.ts:12'),
    );
  });

  it('relocates a multi-line range that spills past the hunk', () => {
    const spilled = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 40,
          start_line: 12,
          side: 'RIGHT',
          start_side: 'RIGHT',
          body: '**[Critical]** Range crosses out of the hunk.',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(spilled) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const req = submitAoneMock.mock.calls[0][0] as AoneSubmitRequest;
    expect(req.comments).toEqual([]);
    // The entry cites the CLAIMED line (`line`, the range's end), not the
    // start — an operator chasing the blocker must land on line 40
    // (outside the hunk, visibly wrong), not on line 12, which sits
    // inside the hunk and looks fine.
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['bodyCriticals']).toEqual([
      'Range crosses out of the hunk. — src/foo.ts:40',
    ]);
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('relocated into the summary body: src/foo.ts:40'),
    );
  });

  it('relocates a stacked-marker draft without leaking the second marker into the entry', () => {
    // A looping model drafts stacked markers, and every other strip
    // iterates to a fixpoint. Compose quotes the relocated entry as-is
    // behind the template marker — a carried second marker would post
    // inside the blocker line, visibly Suggestion-marked in the record.
    const stacked = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 4,
          body: '**[Critical]** **[Suggestion]** Off-by-one in the loop bound.',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(stacked) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['bodyCriticals']).toEqual([
      'Off-by-one in the loop bound. — src/foo.ts:4',
    ]);
  });

  it('relocates a marker-alone body leading into a fence as the placeholder — no raw delimiter in the entry', () => {
    // The claim line is the FIRST marker-stripped line — for a body whose
    // substance opens with a fence, that is the fence delimiter. Compose's
    // fence refusal is line-anchored and the entry always carries its
    // `path:line — ` prefix, so the delimiter would sail through and post
    // as junk; the placeholder replaces it.
    const fenced = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Critical]**\n```ts\nconst offByOne = 1;\n```\nThe claim hides behind the fence.',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(fenced) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['bodyCriticals']).toEqual(['finding — src/foo.ts:9999']);
  });

  it('a separator-only draft is marker-only — the renders-as-nothing refusal owns it, attribution off (#9940 review)', () => {
    // A marker whose ONLY follower is separator grammar (newline+colon)
    // carries no finding text: the post-time strip consumes the same
    // separator the readback always consumed, so the renders-as-nothing
    // projection sees nothing and the consistency gate refuses — the
    // marker-only policy the bare-marker arm below pins. The old `[ \t]`
    // colon stopped at the newline and let the separator survive as
    // false substance, relocating a claimless placeholder blocker
    // instead of the refusal the operator is owed (#9940 review).
    const separatorOnly = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Critical]**\n:\n',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expectRefusal(
      () =>
        runSubmit(base({ review: writeReview(separatorOnly) }), 'unknown', {
          defaultComment: false,
          attribution: false,
        }),
      /renders as nothing/,
    );
    expect(submitAoneMock).not.toHaveBeenCalled();
  });

  it('merges gate discards into an existing suggestionsDiscarded count', () => {
    const withPrior = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Suggestion]** Would misanchor.',
        },
      ],
      state: { modelId: 'test-model', suggestionsDiscarded: 2 },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(withPrior) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['suggestionsDiscarded']).toBe(3);
  });

  it('leaves an UNMARKED unanchorable comment to the consistency gate, unchanged', () => {
    // The gate disposes MARKED findings; an unmarked one is not a finding
    // it can dispose, and the downstream refusal stays the owner of that
    // shape — the gate must not swallow it into a silent discard.
    const unmarked = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: 'No severity marker at all.',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expectRefusal(
      () =>
        runSubmit(base({ review: writeReview(unmarked) }), 'unknown', {
          defaultComment: false,
        }),
      /neither \*\*\[Critical\]\*\* nor \*\*\[Suggestion\]\*\*/,
    );
    expect(submitAoneMock).not.toHaveBeenCalled();
  });

  it('leaves a MALFORMED marked comment to the consistency gate, unchanged', () => {
    // A marked finding with no usable line cannot be anchored, but it is
    // also not a well-formed anchor the gate may dispose: the consistency
    // gate owns that refusal. Relocating it instead would swallow a
    // payload defect the operator was owed a loud refusal for.
    const malformed = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          body: '**[Critical]** Marked, but the line is missing.',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expectRefusal(
      () =>
        runSubmit(base({ review: writeReview(malformed) }), 'unknown', {
          defaultComment: false,
        }),
      /has no usable `line`/,
    );
    expect(submitAoneMock).not.toHaveBeenCalled();
  });

  it('cites the MODEL-AUTHORED comment index in the refusal after the gate renumbers the array', () => {
    // The gate relocates comments[0] (well-formed, unanchorable), leaving
    // the malformed comments[1] at post-gate position 0. The refusal must
    // name index 1 — the re-compose loop fixes the comment the index names
    // in the model's JSON, and the renumbered index would point it at the
    // already-relocated Critical.
    const renumbered = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Critical]** Well-formed but unanchorable.',
        },
        {
          path: 'src/foo.ts',
          line: null,
          body: '**[Critical]** The malformed one.',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expectRefusal(
      () =>
        runSubmit(base({ review: writeReview(renumbered) }), 'unknown', {
          defaultComment: false,
        }),
      /comments\[1\] has no usable `line`/,
    );
    expect(submitAoneMock).not.toHaveBeenCalled();
  });

  it('leaves a REVERSED multi-line range to the consistency gate — a shape error, not an anchor one', () => {
    // Both numbers sit inside the hunk, but the range ends before it
    // begins: the operator is owed the shape refusal, not a silent
    // relocation of a malformed draft.
    const reversed = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 12,
          start_line: 15,
          side: 'RIGHT',
          start_side: 'RIGHT',
          body: '**[Critical]** Range runs backwards.',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expectRefusal(
      () =>
        runSubmit(base({ review: writeReview(reversed) }), 'unknown', {
          defaultComment: false,
        }),
      /cannot end before it begins/,
    );
    expect(submitAoneMock).not.toHaveBeenCalled();
  });

  it('stands the WHOLE gate down when bodyCriticals is garbage and a relocation needs it', () => {
    // A model-written `bodyCriticals` that is not an array is compose's
    // to refuse with a field-naming error (pinned in compose-review's own
    // suite). Spreading it for the relocation would shatter a string into
    // per-character junk entries — each counted toward C — or throw a bare
    // TypeError over a number. The stand-down leaves the payload untouched
    // so compose dies the pinned death; nothing posts either way.
    const garbageState = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Critical]** Real blocker on a bad anchor.',
        },
      ],
      state: { modelId: 'test-model', bodyCriticals: 'blocker' },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(garbageState) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    // Untouched: the garbage field and the unanchorable comment both
    // reach compose exactly as written — no shattered merge.
    expect(input['bodyCriticals']).toBe('blocker');
    expect((input['draftedComments'] as unknown[]).length).toBe(1);
    expect(stderrMock).not.toHaveBeenCalledWith(
      expect.stringContaining('Aone anchor check'),
    );
    const out = postedJson();
    expect(out['anchorsRelocated']).toBe(0);
    expect(out['anchorsDiscarded']).toBe(0);
  });

  it('stands the WHOLE gate down when bodyCriticals is an array carrying a NON-STRING', () => {
    // Array.isArray alone is not compose's acceptance: ingestEntryList
    // refuses an array carrying a non-string, and a relocation merged into
    // it would pollute compose's pinned refusal with the gate's own entry.
    // The stand-down leaves the payload untouched instead.
    const garbageArray = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Critical]** Real blocker on a bad anchor.',
        },
      ],
      state: { modelId: 'test-model', bodyCriticals: [42] },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(garbageArray) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    // Untouched: the garbage array reaches compose exactly as written —
    // no gate entry merged into it.
    expect(input['bodyCriticals']).toEqual([42]);
    expect((input['draftedComments'] as unknown[]).length).toBe(1);
    expect(stderrMock).not.toHaveBeenCalledWith(
      expect.stringContaining('Aone anchor check'),
    );
    const out = postedJson();
    expect(out['anchorsRelocated']).toBe(0);
    expect(out['anchorsDiscarded']).toBe(0);
  });

  it('stands the WHOLE gate down over garbage bodyCriticals even when ONLY a discard needs it', () => {
    // The stand-down keys on ANY degrade that touches the payload, not
    // only relocation: a discard-only gate would remove the comment and
    // announce the discard before compose throws over the garbage field —
    // a degrade that the refusal then unpublishes.
    const garbageBcDiscard = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Suggestion]** Would misanchor.',
        },
      ],
      state: { modelId: 'test-model', bodyCriticals: 'blocker' },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(garbageBcDiscard) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['bodyCriticals']).toBe('blocker');
    // Untouched: the unanchorable Suggestion was NOT discarded.
    expect((input['draftedComments'] as unknown[]).length).toBe(1);
    expect(stderrMock).not.toHaveBeenCalledWith(
      expect.stringContaining('Aone anchor check'),
    );
    expect(postedJson()['anchorsDiscarded']).toBe(0);
  });

  it('merges gate discards into an integer-but-not-SAFE suggestionsDiscarded — compose accepts it, so the gate must', () => {
    // The gate's merge and compose's counter read ONE acceptance table
    // (tryToCount): an integer past MAX_SAFE_INTEGER is not safe but IS an
    // integer compose's toCount accepts, so the gate merges into it —
    // leaving it untouched would drop the gate's discards from the posted
    // total while compose happily counts the raw number.
    const unsafeCount = Number.MAX_SAFE_INTEGER + 1;
    const unsafeState = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9998,
          body: '**[Suggestion]** Would misanchor.',
        },
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Suggestion]** Would misanchor too.',
        },
      ],
      state: { modelId: 'test-model', suggestionsDiscarded: unsafeCount },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(unsafeState) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['suggestionsDiscarded']).toBe(unsafeCount + 2);
  });

  it('merges gate discards from zero when suggestionsDiscarded is null', () => {
    // compose's counter reads null as absent/0, so the gate merges its
    // discards from zero — leaving the null alone would silently drop
    // the count and the posted review would read as zero-finding.
    const nullCount = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Suggestion]** Would misanchor.',
        },
      ],
      state: { modelId: 'test-model', suggestionsDiscarded: null },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(nullCount) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['suggestionsDiscarded']).toBe(1);
    expect(postedJson()['anchorsDiscarded']).toBe(1);
  });

  it('leaves a MARKER-ONLY unanchorable Critical to the renders-as-nothing refusal', () => {
    // The draft carries no finding text at all — the consistency gate's
    // renders-as-nothing refusal owns it (its projection includes the
    // appended footer). Relocating it would post a claimless placeholder
    // blocker instead of the refusal the operator is owed.
    const markerOnly = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Critical]**',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expectRefusal(
      () =>
        runSubmit(base({ review: writeReview(markerOnly) }), 'unknown', {
          defaultComment: false,
        }),
      /renders as nothing/,
    );
    expect(submitAoneMock).not.toHaveBeenCalled();
  });

  it('a contradiction refusal cites the AUTHORED comment index past the anchor degrade (#9940 review)', () => {
    // The degrade discards comments[1] and renumbers the posting set; the
    // fixed-vs-re-post gate reads the payload as authored, so the refusal
    // names comments[2] — the entry the re-compose loop can find in the
    // model's own JSON — never the reduced position 1.
    composeMock.mockReturnValue({
      event: 'REQUEST_CHANGES',
      body: 'One confirmed blocker blocks the merge.',
      cappedBy: [],
      floorEnforced: [],
      fixedFindings: [{ id: 'R1-2', by: 'the fix' }],
    });
    const review = writeReview({
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 12,
          body: '**[Critical]** Anchors fine — stays inline.',
        },
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Suggestion]** Beyond EOF — discarded.',
        },
        {
          path: 'src/foo.ts',
          line: 13,
          body: '**[Suggestion]** R1-2: still stands at HEAD',
        },
      ],
      state: { modelId: 'test-model' },
    });
    runSubmit(base({ review }), 'unknown', { defaultComment: false });
    expect(process.exitCode).toBe(3);
    const message = stderrMock.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/comments\[2\] re-posts R1-2/);
    expect(message).not.toMatch(/comments\[1\]/);
    expect(submitAoneMock).not.toHaveBeenCalled();
  });

  it('a relocated Critical re-posting a fixed id is refused at its comment index, never as a fabricated body entry (#9940 review)', () => {
    // The degrade relocates an unanchorable Critical into `bodyCriticals`
    // — an entry the authored state never had. The gate reads the
    // authored payload, so the refusal cites comments[0], the culprit the
    // model wrote, not a `state.bodyCriticals[0]` that exists only in the
    // degraded copy.
    composeMock.mockReturnValue({
      event: 'REQUEST_CHANGES',
      body: 'One confirmed blocker blocks the merge.',
      cappedBy: [],
      floorEnforced: [],
      fixedFindings: [{ id: 'R1-2', by: 'the fix' }],
    });
    const review = writeReview({
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 4,
          body: '**[Critical]** R1-2: still stands — old-side number.',
        },
      ],
      state: { modelId: 'test-model' },
    });
    runSubmit(base({ review }), 'unknown', { defaultComment: false });
    expect(process.exitCode).toBe(3);
    const message = stderrMock.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/comments\[0\] re-posts R1-2/);
    expect(message).not.toContain('bodyCriticals');
    expect(submitAoneMock).not.toHaveBeenCalled();
  });

  it('a stacked-marker carried re-post is refused — the gate reads the whole marker run the relocate leg strips (#9940 review)', () => {
    // The relocate leg strips markers to a fixpoint, so the relocated
    // entry leads with R1-2 and the ledger carries it standing; the gate
    // stopped at ONE marker and saw no id, posting a body that re-asserts
    // R1-2 as a blocker while the same pass resolves R1-2's thread fixed.
    composeMock.mockReturnValue({
      event: 'REQUEST_CHANGES',
      body: 'One confirmed blocker blocks the merge.',
      cappedBy: [],
      floorEnforced: [],
      fixedFindings: [{ id: 'R1-2', by: 'the fix' }],
    });
    const review = writeReview({
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 4,
          body: '**[Critical]** **[Suggestion]** R1-2: still stands',
        },
      ],
      state: { modelId: 'test-model' },
    });
    runSubmit(base({ review }), 'unknown', { defaultComment: false });
    expect(process.exitCode).toBe(3);
    const message = stderrMock.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toMatch(/comments\[0\] re-posts R1-2/);
    expect(submitAoneMock).not.toHaveBeenCalled();
  });

  it('discloses the anomalous shape when the captured diff parses to no files', () => {
    // A corrupt capture validates nothing: every anchor fails as "file is
    // not in the diff" and the degrade names the zero-file anomaly — safe,
    // and visibly wrong, without a second refusal shape.
    writeFileSync(diffPath, '', 'utf8');
    try {
      const mixed = {
        commit_id: 'abc123',
        comments: [
          {
            path: 'src/foo.ts',
            line: 12,
            body: '**[Critical]** Anchored against a diff that is gone.',
          },
        ],
        state: { modelId: 'test-model' },
      };
      expect(() =>
        runSubmit(base({ review: writeReview(mixed) }), 'unknown', {
          defaultComment: false,
        }),
      ).not.toThrow();
      const req = submitAoneMock.mock.calls[0][0] as AoneSubmitRequest;
      expect(req.comments).toEqual([]);
      const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
      expect(input['bodyCriticals']).toEqual([
        expect.stringContaining('— src/foo.ts:12'),
      ]);
      expect(stderrMock).toHaveBeenCalledWith(
        expect.stringContaining('file is not in the diff (0 file(s) changed)'),
      );
    } finally {
      writeFileSync(diffPath, CAPTURED_DIFF, 'utf8');
    }
  });

  it('refuses the WHOLE post when the captured diff is missing — no validation, no write', () => {
    const aside = `${diffPath}.aside`;
    renameSync(diffPath, aside);
    try {
      expect(() =>
        runSubmit(base(), 'unknown', { defaultComment: false }),
      ).not.toThrow();
      expect(process.exitCode).toBe(3);
      expect(submitAoneMock).not.toHaveBeenCalled();
      expect(postedJson().reason).toBe('aone-post-refused');
      expect(stderrMock).toHaveBeenCalledWith(
        expect.stringContaining('validates every one against the'),
      );
      expect(stderrMock).toHaveBeenCalledWith(
        expect.stringContaining('captured diff'),
      );
    } finally {
      renameSync(aside, diffPath);
    }
  });

  it('a dry run with a MISSING capture skips the gate, discloses, and reports it would NOT post', () => {
    // The missing-capture refusal exists to vouch for an irreversible
    // write; a dry run writes nothing, so it skips the gate instead of
    // refusing — and reports honestly that the real post would refuse.
    const aside = `${diffPath}.aside`;
    renameSync(diffPath, aside);
    try {
      expect(() =>
        runSubmit(base({ dryRun: true }), 'unknown', {
          defaultComment: false,
        }),
      ).not.toThrow();
      expect(submitAoneMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
      const out = postedJson();
      expect(out.wouldPost).toBe(false);
      expect(out.reason).toBe('aone-diff-missing');
      // The gate never ran: no counts...
      expect(out['anchorsRelocated']).toBeUndefined();
      expect(out['anchorsDiscarded']).toBeUndefined();
      // ...and the preview still composes the authored payload.
      expect(composeMock).toHaveBeenCalledTimes(1);
      expect(stderrMock).toHaveBeenCalledWith(
        expect.stringContaining('Aone anchor check: SKIPPED'),
      );
    } finally {
      renameSync(aside, diffPath);
    }
  });

  it('is silent and posts unchanged when every anchor validates', () => {
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(stderrMock).not.toHaveBeenCalledWith(
      expect.stringContaining('Aone anchor check'),
    );
    const out = postedJson();
    expect(out.posted).toBe(true);
    expect(out['anchorsRelocated']).toBe(0);
    expect(out['anchorsDiscarded']).toBe(0);
  });

  it('a dry run runs the gate too and reports its counts', () => {
    const mixed = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 12,
          body: '**[Suggestion]** Valid anchor.',
        },
        {
          path: 'src/foo.ts',
          line: 4,
          body: '**[Critical]** Would misanchor.',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(mixed), dryRun: true }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(submitAoneMock).not.toHaveBeenCalled();
    const out = postedJson();
    expect(out.wouldPost).toBe(true);
    expect(out['anchorsRelocated']).toBe(1);
    expect(out['anchorsDiscarded']).toBe(0);
    // The preview must compose from the gate-CORRECTED payload, exactly
    // what the real post composes — skipping the payload rewrite under
    // dry-run keeps the counters intact (assigned before the rewrite)
    // while diverging the preview verdict from the real post: the one
    // thing --dry-run exists to prevent.
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['bodyCriticals']).toEqual(['Would misanchor. — src/foo.ts:4']);
    expect(input['criticalsInline']).toBe(0);
    expect(input['suggestionsInline']).toBe(1);
  });

  it('refuses a truthy NON-STRING path loudly at the consistency gate — never the write seam', () => {
    // A number (or object) `path` is not postable. The gate leaves it to the
    // consistency gate as a shape problem, and that gate must refuse it by
    // TYPE: `!c.path` alone lets a truthy 42 through to a platform that
    // validates nothing, where execFileSync would stringify it into --file.
    const garbagePath = {
      commit_id: 'abc123',
      comments: [{ path: 42, line: 12, body: '**[Critical]** Garbage path.' }],
      state: { modelId: 'test-model' },
    };
    expectRefusal(
      () =>
        runSubmit(base({ review: writeReview(garbagePath) }), 'unknown', {
          defaultComment: false,
        }),
      /has no `path`/,
    );
    expect(submitAoneMock).not.toHaveBeenCalled();
  });

  it('leaves an open-fence body to the fence refusal even when unanchorable (attribution off)', () => {
    // The gate must not silently dispose a shape the consistency gate loudly
    // refuses. An attribution-off body that leaves a code fence open used to
    // be relocated/discarded when its anchor was out-of-hunk, while the same
    // body with a valid anchor got the loud fence refusal — one shape defect,
    // two outcomes keyed on anchor position. Both now refuse loudly.
    const fence = {
      commit_id: 'abc123',
      comments: [
        { path: 'src/foo.ts', line: 9999, body: '**[Critical]** ``` leaked' },
      ],
      state: { modelId: 'test-model' },
    };
    expectRefusal(
      () =>
        runSubmit(base({ review: writeReview(fence) }), 'unknown', {
          defaultComment: false,
          attribution: false,
        }),
      /leaves a code fence open/,
    );
    expect(submitAoneMock).not.toHaveBeenCalled();
  });

  it('leaves a start_line-without-side comment to the whole-post refusal even when unanchorable', () => {
    // A multi-line comment missing side/start_side is a GitHub-422 shape the
    // consistency gate refuses; the gate must not instead dispose it just
    // because its anchor is out-of-hunk. Same shape, same loud refusal,
    // regardless of anchor position.
    const noSide = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          start_line: 9998,
          body: '**[Critical]** Multi-line but no side fields.',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expectRefusal(
      () =>
        runSubmit(base({ review: writeReview(noSide) }), 'unknown', {
          defaultComment: false,
        }),
      /sets `start_line` without/,
    );
    expect(submitAoneMock).not.toHaveBeenCalled();
  });

  it('merges gate discards into an ARRAY suggestionsDiscarded (the list form older revisions write)', () => {
    // compose-review counts an array suggestionsDiscarded by length; the gate
    // must add its discards to that length, not replace or drop it. Mutating
    // `sd.length + anchorsDiscarded` to `sd.length` would silently lose the
    // gate's discards from the posted total.
    const arrayList = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Suggestion]** Would misanchor.',
        },
      ],
      state: { modelId: 'test-model', suggestionsDiscarded: ['x', 'y'] },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(arrayList) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['suggestionsDiscarded']).toBe(3);
  });

  it('stands the WHOLE gate down over a GARBAGE suggestionsDiscarded — compose owns the refusal', () => {
    // A shape compose's counter refuses is not a count the gate may merge
    // into — and stripping the comment ahead of compose's refusal would
    // announce a degrade that the refusal then unpublishes, over a payload
    // compose never saw unchanged. The stand-down leaves the WHOLE payload
    // untouched: the comment, the garbage field, and no disclosure.
    const garbageCount = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Suggestion]** Would misanchor.',
        },
      ],
      state: { modelId: 'test-model', suggestionsDiscarded: 'two' },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(garbageCount) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['suggestionsDiscarded']).toBe('two');
    // Untouched: the unanchorable Suggestion was NOT discarded.
    expect((input['draftedComments'] as unknown[]).length).toBe(1);
    expect(stderrMock).not.toHaveBeenCalledWith(
      expect.stringContaining('Aone anchor check'),
    );
    expect(postedJson()['anchorsDiscarded']).toBe(0);
  });

  it('merges a relocated Critical into an EXISTING bodyCriticals array, keeping order', () => {
    // The realistic double-degrade path: resolve-anchors already moved an
    // unanchorable Critical into bodyCriticals upstream, then the gate
    // relocates another. Both entries must survive — dropping the prior one
    // would silently lose an already-relocated blocker from the summary body.
    const withExisting = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Critical]** Would misanchor.',
        },
      ],
      state: { modelId: 'test-model', bodyCriticals: ['prior blocker'] },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(withExisting) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['bodyCriticals']).toEqual([
      'prior blocker',
      'Would misanchor. — src/foo.ts:9999',
    ]);
  });

  it('a separator-only draft is marker-only under attribution ON too — refused, never a footer-placeholder relocation (#9940 review)', () => {
    // The attribution-on arm of the separator-only refusal: the draft's
    // only follower past the marker is the newline+colon separator, and
    // a body the renders-as-nothing projection reduces to nothing is
    // the consistency gate's refusal — landing BEFORE the anchor gate's
    // relocation could fall back to the placeholder and post the
    // appended footer's first line as the claim (#9940 review).
    const separatorOnly = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Critical]**\n:\n',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expectRefusal(
      () =>
        runSubmit(base({ review: writeReview(separatorOnly) }), 'unknown', {
          defaultComment: false,
        }),
      /renders as nothing/,
    );
    expect(submitAoneMock).not.toHaveBeenCalled();
  });

  it('relocates a range whose START sits outside every hunk and END inside', () => {
    // The spill shape only `startLine` can catch: dropping the mapping of
    // `start_line` into the anchor check posts this inline with no
    // degrade or disclosure — the end line alone validates.
    const startOut = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 12,
          start_line: 4,
          side: 'RIGHT',
          start_side: 'RIGHT',
          body: '**[Critical]** Start outside, end inside.',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(startOut) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const req = submitAoneMock.mock.calls[0][0] as AoneSubmitRequest;
    expect(req.comments).toEqual([]);
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['bodyCriticals']).toEqual([
      'Start outside, end inside. — src/foo.ts:12',
    ]);
  });

  it('merges gate discards from zero when suggestionsDiscarded is 0 — the >= 0 boundary', () => {
    // Mutating `>= 0` to `> 0` falls through into the stand-down arm:
    // the posted body then names zero discarded suggestions while the
    // terminal and the JSON both say one — the permanent record
    // contradicts the disclosure.
    const zeroCount = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Suggestion]** Would misanchor.',
        },
      ],
      state: { modelId: 'test-model', suggestionsDiscarded: 0 },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(zeroCount) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['suggestionsDiscarded']).toBe(1);
  });

  it('refuses an EMPTY path loudly at the consistency gate — never a gate disposal', () => {
    // Guards the `|| c.path === ''` arm of the shape check: without it,
    // an empty path is not a shape problem, so the gate rules it
    // unanchorable (file '' is not in the diff) and relocates the
    // Critical as a pathless body entry — replacing the loud refusal the
    // pre-PR `!c.path` check already performed.
    const emptyPath = {
      commit_id: 'abc123',
      comments: [
        { path: '', line: 12, body: '**[Critical]** Pathless finding.' },
      ],
      state: { modelId: 'test-model' },
    };
    expectRefusal(
      () =>
        runSubmit(base({ review: writeReview(emptyPath) }), 'unknown', {
          defaultComment: false,
        }),
      /has no `path`/,
    );
    expect(submitAoneMock).not.toHaveBeenCalled();
  });

  it('relocates a declared LEFT start_side even without a start_line', () => {
    // Guards the mapping of `start_side` into the anchor check: dropped,
    // a comment with no start_line passes the shape checks and validates
    // on its line alone — the gate KEEPS an old-side finding and the
    // platform posts it at a new-side line, the silent-wrong-line class
    // this PR exists to prevent.
    const leftStartSide = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 12,
          start_side: 'LEFT',
          body: '**[Critical]** About the old side.',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(leftStartSide) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const req = submitAoneMock.mock.calls[0][0] as AoneSubmitRequest;
    expect(req.comments).toEqual([]);
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['bodyCriticals']).toEqual([
      'About the old side. — src/foo.ts:12',
    ]);
  });
  it('relocates a newline or fence-bearing path through the PATH PLACEHOLDER — the entry stays one postable line', () => {
    // The shape gate admits ANY non-empty string path, and the one-line
    // body channel cannot carry either hostile shape: a newline collapses
    // into a garbled attribution, a line-leading fence delimiter trips
    // compose's fence refusal AFTER the relocation is disclosed — and the
    // entry regenerates from the same path on every retry, so the
    // re-compose loop cannot escape. Both fall to the placeholder, the
    // same fallback the claim half uses.
    const hostilePaths = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/a.ts\n```',
          line: 9999,
          body: '**[Critical]** Newline path cannot ride the one-line channel.',
        },
        {
          path: '```ts',
          line: 9998,
          body: '**[Critical]** Fence-leading path cannot ride the one-line channel.',
        },
        {
          // The `\r` half of the guard: compose's ingestion normalizes a
          // bare `\r` to a line break, so a CR-bearing path splits the
          // entry into two lines — the same hostile shape as `\n`, and a
          // guard narrowed to `\n` alone ships green without this witness.
          path: 'src/a.ts\r```',
          line: 9997,
          body: '**[Critical]** CR path cannot ride the one-line channel.',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(hostilePaths) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['bodyCriticals']).toEqual([
      'Newline path cannot ride the one-line channel. — (no path):9999',
      'Fence-leading path cannot ride the one-line channel. — (no path):9998',
      'CR path cannot ride the one-line channel. — (no path):9997',
    ]);
  });

  it('degrades a built entry compose would refuse to the inert constant', () => {
    // The enumerated guards cannot cover the unbounded entrance space: a
    // lone CR inside the CLAIM passes them (the claim does not LEAD with
    // a fence delimiter), but compose's ingestion normalizes the CR to a
    // line break and the second line LEADS with a fence delimiter — the
    // fence refusal fires mid-degrade. The built entry is validated
    // against compose's OWN acceptance, and a refusal degrades the entry
    // to the inert constant instead of refusing the whole post.
    const crFenceClaim = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Critical]** leaked text\r```ts',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(crFenceClaim) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['bodyCriticals']).toEqual(['finding — (no path):9999']);
  });

  it('keeps a carried ledger id at position 0 of the relocated entry', () => {
    // buildLedger's body-Criticals leg reads a carried id off the entry
    // through the ^-anchored LEDGER_ID_READBACK — a carried finding
    // relocated on Aone must keep its id at position 0, or the ledger
    // silently renumbers it as a new finding and cross-round dedup
    // breaks. The claim leads the entry for exactly this reason.
    const carried = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Critical]** R2-3: the same claim, still standing',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(carried) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    const entry = (input['bodyCriticals'] as string[])[0];
    expect(entry).toBe(
      'R2-3: the same claim, still standing — src/foo.ts:9999',
    );
    expect(entry).toMatch(/^(R\d+-\d+)[:.)\]]?(?=\s|$)/);
  });

  it('floor enforcement drops the right comment AFTER the gate renumbers the array', () => {
    // The gate removes authored index 0 (relocate), renumbering the
    // posting array; compose then returns floorEnforced keyed on the
    // POST-GATE array. The remap through authoredIndices must drop the
    // comment floor enforcement names — authored index 1 ("B", post-gate
    // index 0) — and keep authored index 2 ("C"). A remap keyed on the
    // authored array (or no remap at all) drops the wrong comment; the
    // non-identity authoredIndices branch is exactly what this exercises.
    composeMock.mockReturnValue({
      event: 'REQUEST_CHANGES',
      body: 'One confirmed blocker blocks the merge.',
      cappedBy: [],
      floorEnforced: [0],
      floorEnforcedEntries: [
        {
          file: 'src/foo.ts',
          line: 12,
          source: 'review',
          severity: 'Suggestion',
          title: 'B — floor enforcement drops me.',
        },
      ],
      fixedFindings: [],
    });
    const renumbered = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Critical]** A — unanchorable, the gate relocates me.',
        },
        {
          path: 'src/foo.ts',
          line: 12,
          body: '**[Suggestion]** B — floor enforcement drops me.',
        },
        {
          path: 'src/foo.ts',
          line: 13,
          body: '**[Suggestion]** C — I post.',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(renumbered) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const req = submitAoneMock.mock.calls[0][0] as AoneSubmitRequest;
    expect(req.comments).toHaveLength(1);
    expect(req.comments[0].body).toContain('C — I post.');
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['bodyCriticals']).toEqual([
      expect.stringContaining('— src/foo.ts:9999'),
    ]);
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('Floor enforcement: 1 Suggestion comment(s)'),
    );
  });

  it('posts a single-line comment with an explicit null side inline — null is absent, not old-side', () => {
    // A JSON `null` side is the model's idiom for an ABSENT optional
    // field, not a declared old side: it defaults to RIGHT and validates
    // on its (in-hunk) line, instead of relocating as unanchorable.
    const nullSide = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 12,
          side: null,
          body: '**[Critical]** Null side means absent.',
        },
      ],
      state: { modelId: 'test-model' },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(nullSide) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const req = submitAoneMock.mock.calls[0][0] as AoneSubmitRequest;
    // NOT relocated — the comment posts inline.
    expect(req.comments).toHaveLength(1);
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['bodyCriticals']).toBeUndefined();
  });

  it('stands the WHOLE gate down over a renders-as-nothing bodyCriticals entry compose will refuse', () => {
    // A string array passes the SHAPE mirror, but compose refuses the
    // marker-only entry's CONTENT. Degrading over a field compose is
    // about to refuse announces a relocation the refusal then voids —
    // the outcome the stand-down exists to prevent.
    const rendersNothingBc = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Critical]** Real blocker on a bad anchor.',
        },
      ],
      state: { modelId: 'test-model', bodyCriticals: ['**[Critical]**'] },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(rendersNothingBc) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    // Untouched: the marker-only entry reaches compose exactly as
    // written, and the unanchorable comment was NOT relocated.
    expect(input['bodyCriticals']).toEqual(['**[Critical]**']);
    expect((input['draftedComments'] as unknown[]).length).toBe(1);
    expect(stderrMock).not.toHaveBeenCalledWith(
      expect.stringContaining('Aone anchor check'),
    );
    const out = postedJson();
    expect(out['anchorsRelocated']).toBe(0);
    expect(out['anchorsDiscarded']).toBe(0);
  });

  it('stands the WHOLE gate down over a fence-bearing bodyCriticals entry even when ONLY a discard needs it', () => {
    // The fence gate is compose's other content refusal: an entry with a
    // fence-delimiter line throws in ingestion. The stand-down reads the
    // TOTAL acceptance, so the discard arm stays home too.
    const fenceBc = {
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/foo.ts',
          line: 9999,
          body: '**[Suggestion]** Would misanchor.',
        },
      ],
      state: { modelId: 'test-model', bodyCriticals: ['```\nfoo\n```'] },
    };
    expect(() =>
      runSubmit(base({ review: writeReview(fenceBc) }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    const input = composeMock.mock.calls[0][0] as Record<string, unknown>;
    expect(input['bodyCriticals']).toEqual(['```\nfoo\n```']);
    // Untouched: the unanchorable Suggestion was NOT discarded.
    expect((input['draftedComments'] as unknown[]).length).toBe(1);
    expect(stderrMock).not.toHaveBeenCalledWith(
      expect.stringContaining('Aone anchor check'),
    );
    expect(postedJson()['anchorsDiscarded']).toBe(0);
  });
});

// The Aone receipt is the WRITE half of cleanup's Aone bypass-audit
// contract, the sibling of the gh receipt suite in submit.test.ts: on Aone
// submit posts COMMENTS (Aone has no review object), so the audit's
// sanctioned-vs-bypass ruling keys on the ids recorded here.
describe('the Aone submit receipt (producer half of the audit contract)', () => {
  const receiptPath = () =>
    join(tmp, '.qwen', 'tmp', 'qwen-review-pr-1-submit-receipt.json');

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    // EVERY successful Aone post writes the receipt — the posting tests
    // above all leave one behind in the shared per-file tmp dir. Start
    // each receipt test from no receipt, or the accumulation assertions
    // read a prior test's ids. Remove ONLY the receipt: the anchor gate
    // refuses a post whose captured diff is missing, and wiping the whole
    // `.qwen` tree deletes the diff the beforeAll seeded — the post then
    // dies at the gate and no receipt is ever written.
    rmSync(receiptPath(), { force: true });
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
      recordedHost: 'gitlab.alibaba-inc.com',
    });
    getPlatformReaderMock.mockReturnValue({ kind: 'aone' });
    gitOptMock.mockReturnValue(null);
    submitAoneMock.mockReturnValue({ ...AONE_RESULT });
    composeMock.mockReturnValue({
      event: 'REQUEST_CHANGES',
      body: 'One confirmed blocker blocks the merge.',
      cappedBy: [],
      floorEnforced: [],
      fixedFindings: [],
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('vouches for every posted comment id, including the summary', () => {
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    const receipt = JSON.parse(readFileSync(receiptPath(), 'utf8'));
    // AONE_RESULT carries inlineCommentIds [11] with postedInline 2 — the
    // second inline comment posted without a readable id has nothing to
    // vouch for it (fail-safe toward over-flagging), and the summary id
    // rides the receipt too.
    expect(receipt.commentIds).toEqual([11, 12]);
    expect(receipt.event).toBe('REQUEST_CHANGES');
    expect(typeof receipt.postedAt).toBe('string');
  });

  it('accumulates ids across two submits in the same window (drift restart)', () => {
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    submitAoneMock.mockReturnValue({
      ...AONE_RESULT,
      inlineCommentIds: [21],
      summaryCommentId: 22,
    });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    const receipt = JSON.parse(readFileSync(receiptPath(), 'utf8'));
    expect(receipt.commentIds).toEqual([11, 12, 21, 22]);
  });

  it('vouches for the LANDED ids on a mid-batch failure — cleanup audits that window too', () => {
    submitAoneMock.mockImplementation(() => {
      throw new AonePartialPostError('died mid-batch', 1, [31], false, true);
    });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    const receipt = JSON.parse(readFileSync(receiptPath(), 'utf8'));
    expect(receipt.commentIds).toEqual([31]);
  });

  it('writes no receipt when nothing has an id to vouch for', () => {
    // A first-write failure: zero landed ids, ambiguous or not. An empty
    // receipt vouches for nothing anyway — writing one would only claim a
    // submit happened where none is provable.
    submitAoneMock.mockImplementation(() => {
      throw new AonePartialPostError(
        'died on the first write',
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
    expect(existsSync(receiptPath())).toBe(false);
  });

  it('preserves the review-id axis a gh submit vouched for the same PR number', () => {
    // The receipt file is keyed by PR number alone but carries an axis per
    // platform; an Aone rewrite that kept only its own axis would un-vouch
    // a same-numbered gh submit's own reviews — the audit would then flag
    // submit's sanctioned writes as bypasses.
    mkdirSync(join(tmp, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      receiptPath(),
      JSON.stringify({ reviewIds: [500], event: 'COMMENT', postedAt: 'x' }),
    );
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    const receipt = JSON.parse(readFileSync(receiptPath(), 'utf8'));
    expect(receipt.commentIds).toEqual([11, 12]);
    expect(receipt.reviewIds).toEqual([500]);
  });
});
