/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The Aone backing of `presubmit`: the handler routes an Aone target at the
// a1 reads (mr view / mr status / mr comment list / auth whoami), reusing
// the SAME pure classification core the GitHub path pins — so the dedup
// buckets, the downgrade flags, and the report schema stay one contract.
// The Aone-specific semantics pinned here: threads ride parentNoteId, a
// resolved (`closed`) thread is engaged-not-blocking, an `outdated` thread
// takes the stale bucket (its line was rewritten — a new finding there
// posts), comments carry no commit anchor (nothing is stale by commit),
// and drift has no compare API (anchorsAtRisk fails safe).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureAoneAuthenticated: vi.fn((): string => 'reviewer'),
  getMrAuthorAndHead: vi.fn(),
  listMrComments: vi.fn((): unknown[] => []),
  getMrStatusChecks: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn((..._a: unknown[]): string => {
    throw new Error('no findings file');
  }),
  writeStdoutLine: vi.fn(),
}));

vi.mock('./lib/platform/aone-client.js', () => ({
  ensureAoneAuthenticated: mocks.ensureAoneAuthenticated,
}));

vi.mock('./lib/platform/aone.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./lib/platform/aone.js')>();
  return {
    ...actual,
    getMrAuthorAndHead: mocks.getMrAuthorAndHead,
    listMrComments: mocks.listMrComments,
    getMrStatusChecks: mocks.getMrStatusChecks,
  };
});

vi.mock('./lib/gh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/gh.js')>();
  return {
    ...actual,
    gh: vi.fn(),
    ghApiAll: vi.fn(() => []),
    ghApiAllNested: vi.fn(() => []),
    currentUser: vi.fn(() => 'reviewer'),
    ensureAuthenticated: vi.fn(),
    setGhHost: vi.fn(),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: mocks.writeFileSync,
      readFileSync: mocks.readFileSync,
    },
    writeFileSync: mocks.writeFileSync,
    readFileSync: mocks.readFileSync,
  };
});

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mocks.writeStdoutLine,
}));

const { presubmitCommand, classifyAoneChecks, aoneCommentToPresubmitComment } =
  await import('./presubmit.js');

const FOOTER = '_— qwen-max via Qwen Code /review (v0.1.0)_';

async function run(args?: Record<string, unknown>) {
  const handler = presubmitCommand.handler;
  if (!handler) throw new Error('handler missing');
  await handler({
    _: [],
    $0: 'qwen',
    pr_number: '29295886',
    commit_sha: 'sha-reviewed',
    owner_repo: 'maxcompute/odps_src',
    out_path: '/repo/.qwen/tmp/qwen-review-pr-29295886-presubmit.json',
    host: 'gitlab.alibaba-inc.com',
    ...args,
  } as unknown as Parameters<typeof handler>[0]);
}

function reportWritten() {
  const call = mocks.writeFileSync.mock.calls.find(([p]) =>
    String(p).endsWith('presubmit.json'),
  );
  if (!call) throw new Error('report not written');
  return JSON.parse(String(call[1]));
}

describe('classifyAoneChecks (a1 merge-gate states)', () => {
  it('classifies satisfied gates as all_pass', () => {
    expect(
      classifyAoneChecks([
        { name: 'test', state: 'success' },
        { name: 'discussion', state: 'satisfied' },
      ]),
    ).toMatchObject({
      class: 'all_pass',
      failedCheckNames: [],
      totalChecks: 2,
    });
  });

  it('a failing gate is any_failure and names it', () => {
    expect(
      classifyAoneChecks([
        { name: 'test', state: 'failed' },
        { name: 'discussion', state: 'satisfied' },
      ]),
    ).toMatchObject({
      class: 'any_failure',
      failedCheckNames: ['test'],
    });
  });

  it('a pending gate (or an unrecognized state) is never a pass', () => {
    expect(
      classifyAoneChecks([{ name: 'test', state: 'running' }]),
    ).toMatchObject({ class: 'all_pending' });
    expect(
      classifyAoneChecks([{ name: 'test', state: 'some-future-state' }]),
    ).toMatchObject({ class: 'all_pending' });
    expect(classifyAoneChecks([{ name: 'test' }])).toMatchObject({
      class: 'all_pending',
    });
  });

  it('only-skipped gates are no_checks (with the names disclosed)', () => {
    expect(
      classifyAoneChecks([{ name: 'test', state: 'skipped' }]),
    ).toMatchObject({
      class: 'no_checks',
      skippedCheckNames: ['test'],
      totalChecks: 1,
    });
  });

  it('an empty gate list is no_checks with zero totals', () => {
    expect(classifyAoneChecks([])).toMatchObject({
      class: 'no_checks',
      totalChecks: 0,
    });
  });

  it('reads tolerant key spellings for name and state', () => {
    expect(
      classifyAoneChecks([{ context: 'test', status: 'SUCCESS' }]),
    ).toMatchObject({ class: 'all_pass', totalChecks: 1 });
    // The passing gate above never collects a NAME, so pin the `context`
    // read on a FAILED one too — a regression that stops reading `context`
    // otherwise degrades the operator log to check-N placeholders.
    expect(
      classifyAoneChecks([{ context: 'lint', state: 'failed' }]),
    ).toMatchObject({
      class: 'any_failure',
      failedCheckNames: ['lint'],
    });
    // The same placeholder degradation waits on the remaining tolerant
    // name keys — pin each, or deleting them from the loop ships green.
    expect(
      classifyAoneChecks([{ check: 'typecheck', state: 'failed' }]),
    ).toMatchObject({
      class: 'any_failure',
      failedCheckNames: ['typecheck'],
    });
    expect(
      classifyAoneChecks([{ title: 'e2e', state: 'failed' }]),
    ).toMatchObject({ class: 'any_failure', failedCheckNames: ['e2e'] });
    // A nameless entry still classifies — under a placeholder, never lost.
    expect(classifyAoneChecks([{ state: 'failed' }])).toMatchObject({
      class: 'any_failure',
      failedCheckNames: ['check-1'],
    });
  });

  it('a recognized verdict beats an unrecognized lifecycle word in another key', () => {
    // The canonical check-run shape carries both a lifecycle word and a
    // verdict word; `completed` is in no word set, so it must not shadow
    // the verdict — otherwise every finished gate reads as still running.
    expect(
      classifyAoneChecks([
        { name: 'test', status: 'completed', conclusion: 'success' },
      ]),
    ).toMatchObject({ class: 'all_pass', totalChecks: 1 });
    expect(
      classifyAoneChecks([
        { name: 'test', status: 'completed', conclusion: 'failed' },
      ]),
    ).toMatchObject({ class: 'any_failure', failedCheckNames: ['test'] });
    // Nothing recognized anywhere still reads as pending (fail-closed).
    expect(
      classifyAoneChecks([{ name: 'test', status: 'completed' }]),
    ).toMatchObject({ class: 'all_pending' });
  });

  it('keeps scanning past an unrecognized value in an EARLIER key', () => {
    // The scan order is conclusion, result, state, status: an unrecognized
    // word in an EARLIER key must not shadow a recognized verdict in a
    // LATER one — a first-PRESENT-key reading would silently degrade a
    // gate whose only readable verdict sits in a later key to pending.
    expect(
      classifyAoneChecks([
        { name: 'test', result: 'inconclusive', status: 'passed' },
      ]),
    ).toMatchObject({ class: 'all_pass' });
    // Recognized values in `result` itself too — the case above resolves
    // via `status`, so deleting `result` from the scan otherwise ships
    // green, and a gate reporting its verdict ONLY under `result` would
    // read as pending and cap an otherwise all-green Approve.
    expect(
      classifyAoneChecks([{ name: 'test', result: 'passed' }]),
    ).toMatchObject({ class: 'all_pass' });
    expect(
      classifyAoneChecks([{ name: 'test', result: 'failed' }]),
    ).toMatchObject({ class: 'any_failure', failedCheckNames: ['test'] });
  });
});

describe('aoneCommentToPresubmitComment (a1 → GitHub-shaped input)', () => {
  it('falls back to `body` when `note` is absent (shape-drift tolerance)', () => {
    const mapped = aoneCommentToPresubmitComment(
      {
        id: 1,
        body: `**[Critical]** null deref\n\n${FOOTER}`,
        path: 'a.ts',
        line: 42,
        author: { username: 'reviewer' },
      },
      'sha-reviewed',
    );
    expect(mapped.body).toContain('**[Critical]** null deref');
    expect(mapped.body).toContain('via Qwen Code /review');
  });

  it('an OUTDATED thread rides an empty commit_id (the stale bucket)', () => {
    const mapped = aoneCommentToPresubmitComment(
      { id: 2, note: 'old', path: 'a.ts', line: 42, outdated: true },
      'sha-reviewed',
    );
    expect(mapped.commit_id).toBe('');
    const live = aoneCommentToPresubmitComment(
      { id: 3, note: 'live', path: 'a.ts', line: 42 },
      'sha-reviewed',
    );
    expect(live.commit_id).toBe('sha-reviewed');
  });

  it('prefers `note` over `body` when BOTH keys are present', () => {
    // If a1 ever serializes the tolerated empty `body` as `body: ''`, an
    // inverted `c.body ?? c.note` reads '' for every comment (`??` does
    // not coalesce empty strings) — blanking the recognition signals and
    // re-posting every finding already on the MR.
    const mapped = aoneCommentToPresubmitComment(
      {
        id: 5,
        note: `**[Critical]** both keys\n\n${FOOTER}`,
        body: '',
        path: 'a.ts',
        line: 42,
        author: { username: 'reviewer' },
      },
      'sha-reviewed',
    );
    expect(mapped.body).toContain('**[Critical]** both keys');
  });

  it('maps parentNoteId onto in_reply_to_id (absent stays unset)', () => {
    // The mapping that keeps a finding-shaped own REPLY out of the dedup:
    // without it the reply is misread as a posted finding at the location
    // and a genuinely new finding there is silently withheld.
    expect(
      aoneCommentToPresubmitComment(
        {
          id: 4,
          note: '**[Critical]** confirmed',
          path: 'a.ts',
          line: 42,
          parentNoteId: 1,
          author: { username: 'reviewer' },
        },
        'sha-reviewed',
      ).in_reply_to_id,
    ).toBe(1);
    expect(
      aoneCommentToPresubmitComment(
        { id: 6, note: 'top-level', path: 'a.ts', line: 42 },
        'sha-reviewed',
      ).in_reply_to_id,
    ).toBeUndefined();
  });
});

describe('presubmit handler (Aone backing)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The auth gate doubles as the account read (#9629) — ONE whoami per
    // run, before the MR fetch.
    mocks.ensureAoneAuthenticated.mockReturnValue('reviewer');
    mocks.getMrAuthorAndHead.mockReturnValue({
      author: 'mr-author',
      headSha: 'sha-reviewed',
    });
    mocks.listMrComments.mockReturnValue([]);
    mocks.getMrStatusChecks.mockReturnValue([
      { name: 'test', state: 'success' },
    ]);
    mocks.readFileSync.mockImplementation(() => {
      throw new Error('no findings file');
    });
  });

  it('routes an Aone --host at the a1 reads and writes the report', async () => {
    await run();
    const report = reportWritten();
    expect(report.prNumber).toBe('29295886');
    expect(report.commitSha).toBe('sha-reviewed');
    expect(report.isSelfPr).toBe(false);
    expect(report.downgradeApprove).toBe(false);
    expect(mocks.listMrComments).toHaveBeenCalledWith(
      29295886,
      'maxcompute/odps_src',
    );
    // ONE whoami per run (the auth gate doubles as the account read): a
    // second success-path lookup throws outside any try/catch on a
    // transient a1 blip and orphans the whole run without a report.
    expect(mocks.ensureAoneAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('drops a still-valid finding already on the MR at the same location', async () => {
    // The dedup this backing exists for: a prior-round finding whose line
    // still maps is an overlap, and blockOnExistingComments fires.
    mocks.listMrComments.mockReturnValue([
      {
        id: 100,
        note: `**[Critical]** null deref\n\n${FOOTER}`,
        path: 'a.ts',
        line: 42,
        author: { username: 'reviewer' },
      },
    ]);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify([{ path: 'a.ts', line: 42 }]),
    );
    await run({ 'new-findings': '/repo/.qwen/tmp/new-findings.json' });
    const report = reportWritten();
    expect(report.blockOnExistingComments).toBe(true);
    expect(report.existingComments.byBucket.overlap).toBe(1);
    expect(report.existingComments.overlap[0]).toMatchObject({
      id: 100,
      path: 'a.ts',
      line: 42,
      user: 'reviewer',
    });
  });

  it('matches the footer regardless of author; markers only for the own account', async () => {
    mocks.listMrComments.mockReturnValue([
      {
        // Another reviewer's attributed post — the long footer is qwen's
        // provenance string, recognized regardless of account.
        id: 110,
        note: `**[Suggestion]** something\n\n${FOOTER}`,
        path: 'b.ts',
        line: 7,
        author: { username: 'another-bot' },
      },
      {
        // Another account's marker-shaped comment — plantable, so NOT
        // recognized as a qwen finding.
        id: 111,
        note: '**[Critical]** planted',
        path: 'c.ts',
        line: 8,
        author: { username: 'someone-else' },
      },
    ]);
    await run();
    const report = reportWritten();
    expect(report.existingComments.total).toBe(1);
    expect(report.existingComments.noConflict[0].id).toBe(110);
  });

  it('recognizes a version-less footer variant from another CLI version', async () => {
    // The recognition regex is deliberately lenient on the footer shape —
    // a prior-round finding posted by any other CLI version must still
    // dedup, or the next round re-posts every finding already on the MR
    // (the duplicate storm this backing exists to prevent).
    mocks.listMrComments.mockReturnValue([
      {
        id: 205,
        note: '**[Critical]** prior\n\n_— qwen-max via Qwen Code /review_',
        path: 'a.ts',
        line: 42,
        author: { username: 'another-bot' },
      },
    ]);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify([{ path: 'a.ts', line: 42 }]),
    );
    await run({ 'new-findings': '/repo/.qwen/tmp/new-findings.json' });
    const report = reportWritten();
    expect(report.existingComments.byBucket.overlap).toBe(1);
    expect(report.blockOnExistingComments).toBe(true);
  });

  it('recognizes the own account case-insensitively in the dedup filter', async () => {
    // a1 usernames diverge in case from `a1 auth whoami` in the wild; the
    // filter lowercases BOTH sides — a strict comparison leaves the
    // location undeduped and re-posts the finding on the live thread.
    mocks.listMrComments.mockReturnValue([
      {
        id: 151,
        note: '**[Critical]** prior claim',
        path: 'a.ts',
        line: 42,
        author: { username: 'REVIEWER' },
      },
    ]);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify([{ path: 'a.ts', line: 42 }]),
    );
    await run({ 'new-findings': '/repo/.qwen/tmp/new-findings.json' });
    const report = reportWritten();
    expect(report.existingComments.byBucket.overlap).toBe(1);
    expect(report.blockOnExistingComments).toBe(true);
  });

  it('recognizes an attribution-off post by its marker alone', async () => {
    // `submit` posts attribution-off findings as the stripped body plus
    // `<!-- qwen-review <sev> -->` — no severity prefix, no footer — so
    // ONLY the marker disjunct recognizes them; dropping it leaves every
    // attribution-off post on the MR unrecognized and re-posted.
    mocks.listMrComments.mockReturnValue([
      {
        id: 152,
        note: 'null deref\n\n<!-- qwen-review critical -->',
        path: 'a.ts',
        line: 42,
        author: { username: 'reviewer' },
      },
    ]);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify([{ path: 'a.ts', line: 42 }]),
    );
    await run({ 'new-findings': '/repo/.qwen/tmp/new-findings.json' });
    const report = reportWritten();
    expect(report.existingComments.byBucket.overlap).toBe(1);
    expect(report.blockOnExistingComments).toBe(true);
  });

  it('an unreadable account never recognizes an author-less marker comment as own', async () => {
    // The `me !== ''` guard: a deleted-account or author-less payload maps
    // to '' on BOTH sides, and without it the own-account comparison
    // degenerates to '' === '' — a plantable marker comment is recognized
    // as qwen's own posted finding, and a genuinely new one at its
    // location is silently withheld.
    mocks.ensureAoneAuthenticated.mockReturnValue('');
    mocks.listMrComments.mockReturnValue([
      {
        id: 200,
        note: '**[Critical]** confirmed',
        path: 'a.ts',
        line: 42,
        author: {},
      },
    ]);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify([{ path: 'a.ts', line: 42 }]),
    );
    await run({ 'new-findings': '/repo/.qwen/tmp/new-findings.json' });
    const report = reportWritten();
    expect(report.existingComments.total).toBe(0);
    expect(report.existingComments.byBucket.overlap).toBe(0);
    expect(report.blockOnExistingComments).toBe(false);
  });

  it('an OUTDATED thread is stale — a new finding at its rewritten line posts', async () => {
    mocks.listMrComments.mockReturnValue([
      {
        id: 120,
        note: `**[Critical]** old code\n\n${FOOTER}`,
        path: 'a.ts',
        line: 42,
        outdated: true,
        author: { username: 'reviewer' },
      },
    ]);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify([{ path: 'a.ts', line: 42 }]),
    );
    await run({ 'new-findings': '/repo/.qwen/tmp/new-findings.json' });
    const report = reportWritten();
    expect(report.existingComments.byBucket.stale).toBe(1);
    expect(report.existingComments.byBucket.overlap).toBe(0);
    expect(report.blockOnExistingComments).toBe(false);
  });

  it('a CLOSED (resolved) thread is engaged, not a dedup block', async () => {
    mocks.listMrComments.mockReturnValue([
      {
        id: 130,
        note: `**[Critical]** resolved concern\n\n${FOOTER}`,
        path: 'a.ts',
        line: 42,
        // The MEASURED payload shape: a1 stamps the numeric 1 (cleanup's
        // RawAoneComment pins the same field on the same command); the
        // boolean arm below stays tolerated for shape drift.
        closed: 1,
        author: { username: 'reviewer' },
      },
      {
        id: 131,
        note: `**[Suggestion]** boolean shape\n\n${FOOTER}`,
        path: 'b.ts',
        line: 7,
        closed: true,
        author: { username: 'reviewer' },
      },
    ]);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify([{ path: 'a.ts', line: 42 }]),
    );
    await run({ 'new-findings': '/repo/.qwen/tmp/new-findings.json' });
    const report = reportWritten();
    expect(report.existingComments.byBucket.resolved).toBe(2);
    expect(report.existingComments.byBucket.overlap).toBe(0);
    expect(report.blockOnExistingComments).toBe(false);
  });

  it('replies are threaded off parentNoteId and do not block by themselves', async () => {
    mocks.listMrComments.mockReturnValue([
      {
        id: 140,
        note: `**[Critical]** a concern\n\n${FOOTER}`,
        path: 'a.ts',
        line: 42,
        author: { username: 'reviewer' },
      },
      {
        id: 141,
        note: 'we fixed it',
        parentNoteId: 140,
        author: { username: 'mr-author' },
      },
    ]);
    await run();
    const report = reportWritten();
    // The reply is not a qwen finding; the root is replied-to, so it
    // lands in resolved — the engaged-thread bucket, same as GitHub.
    expect(report.existingComments.total).toBe(1);
    expect(report.existingComments.byBucket.resolved).toBe(1);
    expect(report.blockOnExistingComments).toBe(false);
  });

  it('a finding-shaped own REPLY never enters the dedup set (recognition side)', async () => {
    // The `!c.in_reply_to_id` guard in the recognition filter: without it
    // a finding-shaped own reply reads as a posted finding, lands in
    // `overlap` at a carried location, and blockOnExistingComments
    // silently withholds a genuinely new finding.
    mocks.listMrComments.mockReturnValue([
      {
        id: 140,
        note: `**[Critical]** a concern\n\n${FOOTER}`,
        path: 'b.ts',
        line: 7,
        author: { username: 'reviewer' },
      },
      {
        id: 142,
        note: '**[Critical]** follow-up',
        path: 'a.ts',
        line: 42,
        parentNoteId: 140,
        author: { username: 'reviewer' },
      },
    ]);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify([{ path: 'a.ts', line: 42 }]),
    );
    await run({ 'new-findings': '/repo/.qwen/tmp/new-findings.json' });
    const report = reportWritten();
    expect(report.existingComments.total).toBe(1);
    expect(report.existingComments.byBucket.overlap).toBe(0);
    expect(report.blockOnExistingComments).toBe(false);
  });

  it('detects a self-MR from the MR author and the a1 identity', async () => {
    mocks.getMrAuthorAndHead.mockReturnValue({
      author: 'Reviewer', // case-insensitive match against whoami
      headSha: 'sha-reviewed',
    });
    await run();
    const report = reportWritten();
    expect(report.isSelfPr).toBe(true);
    expect(report.downgradeApprove).toBe(true);
    expect(report.downgradeRequestChanges).toBe(true);
    expect(report.downgradeReasons).toContain('self-PR');
  });

  it('flags head drift with compare null and anchorsAtRisk fail-safe', async () => {
    // The MR was amended mid-review: no compare API on Aone, so the drift
    // rides compare null and the anchor-risk ruling must fail safe.
    mocks.getMrAuthorAndHead.mockReturnValue({
      author: 'mr-author',
      headSha: 'sha-amended',
    });
    mocks.readFileSync.mockReturnValue(
      JSON.stringify([{ path: 'a.ts', line: 42 }]),
    );
    await run({ 'new-findings': '/repo/.qwen/tmp/new-findings.json' });
    const report = reportWritten();
    expect(report.headDrift).toMatchObject({
      reviewedSha: 'sha-reviewed',
      liveHeadSha: 'sha-amended',
      drifted: true,
      compare: null,
      anchorsAtRisk: true,
    });
    expect(report.downgradeApprove).toBe(true);
    expect(
      report.downgradeReasons.some((r: string) =>
        r.includes('head advanced during review'),
      ),
    ).toBe(true);
  });

  it('an unreadable mr view caps the verdict (metaUnavailable)', async () => {
    mocks.getMrAuthorAndHead.mockImplementation(() => {
      throw new Error('Command failed: a1 repo mr view — HTTP 500');
    });
    await run();
    const report = reportWritten();
    expect(report.downgradeApprove).toBe(true);
    expect(report.isSelfPr).toBe(false);
    expect(report.headDrift.drifted).toBe(false);
    expect(
      report.downgradeReasons.some((r: string) =>
        r.includes('metadata unavailable'),
      ),
    ).toBe(true);
  });

  it('classifies gate failures and downgrades with the gate names', async () => {
    mocks.getMrStatusChecks.mockReturnValue([
      { name: 'test', state: 'failed' },
      { name: 'discussion', state: 'satisfied' },
    ]);
    await run();
    const report = reportWritten();
    expect(report.ciStatus).toMatchObject({
      class: 'any_failure',
      failedCheckNames: ['test'],
    });
    expect(report.downgradeApprove).toBe(true);
    expect(report.downgradeReasons).toContain('CI failing: test');
  });

  it('an unrecognized gate payload reads as pending, never as an all-clear', async () => {
    mocks.getMrStatusChecks.mockReturnValue(undefined);
    await run();
    const report = reportWritten();
    expect(report.ciStatus.class).toBe('all_pending');
    expect(report.downgradeApprove).toBe(true);
    expect(report.downgradeReasons).toContain('CI still running');
  });

  it('a gateless MR (found-but-empty checks) is no_checks and NOT downgraded', async () => {
    // The GitHub contract the shared tail honors: no CI at all is not a
    // downgrade. Only an UNREADABLE gate payload reads as pending.
    mocks.getMrStatusChecks.mockReturnValue([]);
    await run();
    const report = reportWritten();
    expect(report.ciStatus).toMatchObject({
      class: 'no_checks',
      totalChecks: 0,
    });
    expect(report.downgradeApprove).toBe(false);
    expect(report.downgradeReasons).toEqual([]);
  });

  it('a carried-id re-post at the same location lands in the repost bucket', async () => {
    // The Step 6 re-post machinery rides the same id matching as GitHub:
    // an own-account original carrying the claim id exempts the re-post.
    mocks.listMrComments.mockReturnValue([
      {
        id: 150,
        note: '**[Critical]** R2-1 null deref',
        path: 'a.ts',
        line: 42,
        author: { username: 'reviewer' },
      },
    ]);
    mocks.readFileSync.mockReturnValue(
      JSON.stringify([{ path: 'a.ts', line: 42, id: 'R2-1' }]),
    );
    await run({ 'new-findings': '/repo/.qwen/tmp/new-findings.json' });
    const report = reportWritten();
    expect(report.existingComments.byBucket.repost).toBe(1);
    expect(report.existingComments.repost[0].matchedIds).toEqual(['R2-1']);
    // A re-post target is ALSO an overlap — the double count is deliberate.
    expect(report.existingComments.byBucket.overlap).toBe(1);
  });

  it('flags a malformed --new-findings file', async () => {
    mocks.readFileSync.mockReturnValue('not json');
    await run({ 'new-findings': '/repo/.qwen/tmp/new-findings.json' });
    const report = reportWritten();
    expect(report.findingsFileInvalid).toBe(true);
    expect(report.downgradeApprove).toBe(true);
    expect(
      report.downgradeReasons.some((r: string) =>
        r.includes('--new-findings file was malformed'),
      ),
    ).toBe(true);
  });

  it('rejects a non-integer MR id (caller error)', async () => {
    await expect(run({ pr_number: 'abc' })).rejects.toThrow(/positive integer/);
  });

  it('rejects pr_number tokens that coerce to a DIFFERENT MR id', async () => {
    // Number() alone accepts these, so presubmit would compute its dedup
    // state from one MR while the report carries the caller's label — the
    // divergence fetch-pr's /^[1-9]\d*$/ grammar refuses.
    for (const token of ['012', '1e3', '0x1f', ' 12', '12.0']) {
      await expect(run({ pr_number: token })).rejects.toThrow(
        /positive integer/,
      );
    }
  });
});
