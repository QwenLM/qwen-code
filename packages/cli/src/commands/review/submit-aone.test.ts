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
  mkdtempSync,
  readFileSync,
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
// vitest. `recordedSeverityFloor` yields nothing: the state's floor stands.
vi.mock('./lib/authorization.js', () => ({
  reviewWriteAuthorization: authMock,
  recordedSeverityFloor: vi.fn(() => undefined),
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

// A successful Aone post writes its bypass-audit receipt under
// `.qwen/tmp` of the CWD — run from the fixture dir so the relative path
// lands there instead of polluting the repository checkout.
let savedCwd: string;
beforeEach(() => {
  savedCwd = process.cwd();
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(savedCwd);
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
    const out = postedJson();
    expect(out.posted).toBe(true);
    expect(out.event).toBe('REQUEST_CHANGES');
    // The success JSON reads `postedInline` (2), NOT the id list (1) —
    // the fixture diverges the two on purpose.
    expect(out.inlineComments).toBe(2);
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
    // Aone-origin clone must still post to GitHub.
    authMock.mockReturnValue({
      ok: true,
      why: '`--comment` was in the review arguments for #1',
      recordedHost: 'github.com',
    });
    getPlatformReaderMock.mockReturnValue({ kind: 'aone' });
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
    // the platform of an irreversible write — fail closed instead.
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
    });
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
    // The gate disclosure fires only when inline Criticals actually
    // posted — the zero-Critical shape discloses no gate at all.
    expect(stderrMock).not.toHaveBeenCalledWith(
      expect.stringContaining('does not track them'),
    );
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
    // read a prior test's ids.
    rmSync(join(tmp, '.qwen'), { recursive: true, force: true });
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
});
