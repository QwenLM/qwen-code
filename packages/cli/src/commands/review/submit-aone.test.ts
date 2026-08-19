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
  getPlatformReaderMock,
  authMock,
  submitAoneMock,
  composeMock,
  stdoutMock,
  stderrMock,
} = vi.hoisted(() => ({
  ghMock: vi.fn(),
  ghWithInputMock: vi.fn(),
  getPlatformReaderMock: vi.fn(),
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
    setGhHost: vi.fn(),
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
  inlineCommentIds: [11],
  postedInline: 1,
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

describe('submit posts an authorised Aone target through a1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    savedGhHost = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
    // Default: authorised, no recorded host (the `--user-authorized` fast
    // path / bare pr-number target shape), cwd probe reads Aone.
    authMock.mockReturnValue({
      ok: true,
      why: 'the user asked for this review to be published',
    });
    getPlatformReaderMock.mockReturnValue({ kind: 'aone' });
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
    expect(out.inlineComments).toBe(1);
    expect(out.summaryPosted).toBe(true);
    expect(out.url).toBe(AONE_RESULT.webUrl);
    // The D6 semantic difference is named in the terminal.
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('no native request-changes state'),
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

  it('a padded Aone --host still routes to a1', () => {
    getPlatformReaderMock.mockImplementation(({ host }: { host?: string }) => ({
      kind: host === 'gitlab.alibaba-inc.com' ? 'aone' : 'github',
    }));
    expect(() =>
      runSubmit(base({ host: ' gitlab.alibaba-inc.com ' }), 'unknown', {
        defaultComment: false,
      }),
    ).not.toThrow();
    expect(submitAoneMock).toHaveBeenCalledTimes(1);
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('detects from GH_HOST too — an Aone-pointing env export posts via a1', () => {
    getPlatformReaderMock.mockReturnValue({ kind: 'github' });
    process.env['GH_HOST'] = 'gitlab.alibaba-inc.com';
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
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
    ghWithInputMock.mockReturnValue('{"id": 77}');
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(submitAoneMock).not.toHaveBeenCalled();
    expect(ghWithInputMock).toHaveBeenCalledTimes(1);
    expect(postedJson().posted).toBe(true);
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

  it('a mid-batch a1 failure exits 3 and warns against a re-run', () => {
    // A retry would double-post every comment that already landed; the
    // exit-3 shape is what Step 7 accepts as terminal.
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
    expect(postedJson()).toEqual({ posted: false, reason: 'aone-post-failed' });
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('do NOT re-run submit'),
    );
    expect(ghWithInputMock).not.toHaveBeenCalled();
  });

  it('a pre-write failure (head drift) exits 3 without the partial-post warning', () => {
    submitAoneMock.mockImplementation(() => {
      throw new Error('refusing to post: the MR head moved …');
    });
    expect(() =>
      runSubmit(base(), 'unknown', { defaultComment: false }),
    ).not.toThrow();
    expect(process.exitCode).toBe(3);
    expect(postedJson()).toEqual({ posted: false, reason: 'aone-post-failed' });
    const stderr = stderrMock.mock.calls.map((c) => String(c[0])).join('');
    expect(stderr).toContain('the MR head moved');
    expect(stderr).not.toContain('do NOT re-run submit');
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
    expect(stderrMock).toHaveBeenCalledWith(
      expect.stringContaining('a1 repo mr approve'),
    );
  });
});
