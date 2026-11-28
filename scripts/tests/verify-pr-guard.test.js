/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GUARD_VERDICT_SCHEMA,
  buildGuardVerdict,
  compareSnapshots,
  fetchSnapshot,
  isSnapshot,
} from '../../scripts/verify-pr-guard.mjs';

const SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-guard.mjs', import.meta.url),
);
const HEAD = 'a'.repeat(40);

function snapshot(overrides = {}) {
  return {
    pr: 7,
    repo: 'owner/repo',
    headRefOid: HEAD,
    state: 'OPEN',
    reviews: [
      { id: 1, stamp: '2026-10-28T00:00:00Z', body: '', state: 'COMMENTED' },
    ],
    reviewComments: [{ id: 2, stamp: '2026-10-28T00:01:00Z', body: '' }],
    issueComments: [],
    ...overrides,
  };
}

/** A gh stand-in: `responses` maps a label to a spawnSync-shaped result. */
function fakeRun(responses) {
  return (args) => {
    const key = args[0] === 'api' ? args[2] : 'pr view';
    const response = responses[key];
    if (response === undefined) {
      return { status: 1, stdout: '', stderr: `no stub for ${key}` };
    }
    return response;
  };
}

function ok(body) {
  return { status: 0, stdout: JSON.stringify(body), stderr: '' };
}

function allLists() {
  return {
    'pr view': ok({ headRefOid: HEAD, state: 'OPEN' }),
    'repos/owner/repo/pulls/7/reviews': ok([
      {
        id: 1,
        submitted_at: '2026-10-28T00:00:00Z',
        body: '',
        state: 'COMMENTED',
      },
    ]),
    'repos/owner/repo/pulls/7/comments': ok([
      { id: 2, updated_at: '2026-10-28T00:01:00Z', body: '' },
    ]),
    'repos/owner/repo/issues/7/comments': ok([]),
  };
}

let tmpDirs = [];
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-pr-guard-'));
  tmpDirs.push(dir);
  return dir;
}

describe('fetchSnapshot', () => {
  it('normalizes each list, reads the review stamp from submitted_at, and records capturedAt', () => {
    const fixedNow = () => new Date('2026-11-27T12:00:00.000Z');
    const result = fetchSnapshot({
      pr: 7,
      repo: 'owner/repo',
      run: fakeRun(allLists()),
      now: fixedNow,
    });
    expect(result.ok).toBe(true);
    expect(result.snapshot).toEqual(
      snapshot({ capturedAt: '2026-11-27T12:00:00.000Z' }),
    );
  });

  it('asks for every page, not the first 30', () => {
    const calls = [];
    const run = (args) => {
      calls.push(args);
      return fakeRun(allLists())(args);
    };
    fetchSnapshot({ pr: 7, repo: 'owner/repo', run });
    const apiCalls = calls.filter((args) => args[0] === 'api');
    // 3 initial paginated list fetches + 2 closing confirmations (reviews, reviewComments).
    expect(apiCalls).toHaveLength(5);
    for (const args of apiCalls) expect(args).toContain('--paginate');
  });

  // The hole this script exists to close: a failed call must not become an
  // empty list, because an empty list compares clean.
  it('refuses the whole snapshot when one list fails, and names it', () => {
    const responses = allLists();
    responses['repos/owner/repo/pulls/7/comments'] = {
      status: 1,
      stdout: '',
      stderr: 'dial tcp: i/o timeout\n',
    };
    const result = fetchSnapshot({
      pr: 7,
      repo: 'owner/repo',
      run: fakeRun(responses),
    });
    expect(result.ok).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(result.errors.join('\n')).toMatch(/reviewComments: gh exited 1/);
    expect(result.errors.join('\n')).toMatch(/i\/o timeout/);
  });

  it('refuses a response that is not JSON, or is not a list', () => {
    const notJson = allLists();
    notJson['repos/owner/repo/issues/7/comments'] = {
      status: 0,
      stdout: '<html>',
      stderr: '',
    };
    expect(
      fetchSnapshot({
        pr: 7,
        repo: 'owner/repo',
        run: fakeRun(notJson),
      }).errors.join('\n'),
    ).toMatch(/issueComments: response was not JSON/);

    const notList = allLists();
    notList['repos/owner/repo/issues/7/comments'] = ok({
      message: 'Not Found',
    });
    expect(
      fetchSnapshot({
        pr: 7,
        repo: 'owner/repo',
        run: fakeRun(notList),
      }).errors.join('\n'),
    ).toMatch(/issueComments: expected an array, got object/);
  });

  it('refuses a snapshot whose head or state never arrived', () => {
    const responses = allLists();
    responses['pr view'] = ok({ headRefOid: null, state: null });
    const result = fetchSnapshot({
      pr: 7,
      repo: 'owner/repo',
      run: fakeRun(responses),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/failed validation/);
  });

  // The refusal has to name what actually failed: a list item without an id is
  // not a missing head, and the old wording sent the reader to the wrong field.
  it('refuses a list item with no id, without blaming the head', () => {
    const responses = allLists();
    responses['repos/owner/repo/pulls/7/reviews'] = ok([
      { submitted_at: 'x', body: '', state: 'COMMENTED' },
    ]);
    const result = fetchSnapshot({
      pr: 7,
      repo: 'owner/repo',
      run: fakeRun(responses),
    });
    expect(result.ok).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(result.errors.join('\n')).toMatch(
      /an id, body or review state in one of the lists/,
    );
  });

  // Without bodies the guard cannot answer "was anything edited?" for a review,
  // whose timestamp never moves. A list that cannot answer is refused, not
  // compared as though the answer were "no".
  it('refuses a list whose items carry no body', () => {
    const responses = allLists();
    responses['repos/owner/repo/pulls/7/reviews'] = ok([
      { id: 1, submitted_at: '2026-10-28T00:00:00Z', state: 'COMMENTED' },
    ]);
    const result = fetchSnapshot({
      pr: 7,
      repo: 'owner/repo',
      run: fakeRun(responses),
    });
    expect(result.ok).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(result.errors.join('\n')).toMatch(
      /an id, body or review state in one of the lists/,
    );
  });

  // A dismissal moves only the state, so a review list without it cannot
  // answer "was a review dismissed?" and is refused for the same reason.
  it('refuses a review list whose items carry no state', () => {
    const responses = allLists();
    responses['repos/owner/repo/pulls/7/reviews'] = ok([
      { id: 1, submitted_at: '2026-10-28T00:00:00Z', body: '' },
    ]);
    const result = fetchSnapshot({
      pr: 7,
      repo: 'owner/repo',
      run: fakeRun(responses),
    });
    expect(result.ok).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(result.errors.join('\n')).toMatch(
      /an id, body or review state in one of the lists/,
    );
  });
  it('rejects a snapshot when PR head or state changes during paginated comment fetches, or when the closing pr view fails', () => {
    const HEAD_B = 'b'.repeat(40);
    const makeSequencedRun = (closingMeta) => {
      let prViews = 0;
      const base = allLists();
      return (args) => {
        if (args[0] !== 'api') {
          prViews += 1;
          return prViews === 1 ? base['pr view'] : closingMeta;
        }
        return base[args[2]];
      };
    };

    const moved = fetchSnapshot({
      pr: 7,
      repo: 'owner/repo',
      run: makeSequencedRun(ok({ headRefOid: HEAD_B, state: 'OPEN' })),
    });
    expect(moved.ok).toBe(false);
    expect(moved.snapshot).toBeNull();
    expect(moved.errors.join('\n')).toMatch(
      /PR head moved during snapshot fetch/,
    );

    const merged = fetchSnapshot({
      pr: 7,
      repo: 'owner/repo',
      run: makeSequencedRun(ok({ headRefOid: HEAD, state: 'MERGED' })),
    });
    expect(merged.ok).toBe(false);
    expect(merged.snapshot).toBeNull();
    expect(merged.errors.join('\n')).toMatch(
      /PR state changed during snapshot fetch/,
    );

    const confirmFailed = fetchSnapshot({
      pr: 7,
      repo: 'owner/repo',
      run: makeSequencedRun({
        status: 1,
        stdout: '',
        stderr: 'connection reset',
      }),
    });
    expect(confirmFailed.ok).toBe(false);
    expect(confirmFailed.snapshot).toBeNull();
    expect(confirmFailed.errors.join('\n')).toMatch(
      /pr view \(confirm\): gh exited 1/,
    );

    // Non-object JSON literals (`null`, `[]`) from either opening or closing
    // `pr view` fail closed without skipping confirmation or throwing.
    const nullMeta = fetchSnapshot({
      pr: 7,
      repo: 'owner/repo',
      run: fakeRun({ ...allLists(), 'pr view': ok(null) }),
    });
    expect(nullMeta.ok).toBe(false);
    expect(nullMeta.snapshot).toBeNull();
    expect(nullMeta.errors.join('\n')).toMatch(
      /pr view: expected an object, got null/,
    );

    const nullConfirm = fetchSnapshot({
      pr: 7,
      repo: 'owner/repo',
      run: makeSequencedRun(ok(null)),
    });
    expect(nullConfirm.ok).toBe(false);
    expect(nullConfirm.snapshot).toBeNull();
    expect(nullConfirm.errors.join('\n')).toMatch(
      /pr view \(confirm\): expected an object, got null/,
    );

    const arrayConfirm = fetchSnapshot({
      pr: 7,
      repo: 'owner/repo',
      run: makeSequencedRun(ok([])),
    });
    expect(arrayConfirm.ok).toBe(false);
    expect(arrayConfirm.errors.join('\n')).toMatch(
      /pr view \(confirm\): expected an object, got array/,
    );
  });

  it('rejects a snapshot when a CHANGES_REQUESTED review or inline review comment lands during pagination, or when list confirmation returns null', () => {
    const base = allLists();
    const runWithMidListChange = (targetPath, secondResponse) => {
      const counts = new Map();
      return (args) => {
        const key = args[0] === 'api' ? args[2] : 'pr view';
        const seen = (counts.get(key) ?? 0) + 1;
        counts.set(key, seen);
        if (key === targetPath && seen === 2) return secondResponse;
        return base[key];
      };
    };

    // Head and state remain unchanged, but a body-only CHANGES_REQUESTED
    // review lands after the initial `reviews` read while later lists paginate.
    const reviewLanded = fetchSnapshot({
      pr: 7,
      repo: 'owner/repo',
      run: runWithMidListChange(
        'repos/owner/repo/pulls/7/reviews',
        ok([
          {
            id: 1,
            submitted_at: '2026-10-28T00:00:00Z',
            body: '',
            state: 'COMMENTED',
          },
          {
            id: 55,
            submitted_at: '2026-10-28T00:02:00Z',
            body: 'Blocking change request with no inline comments',
            state: 'CHANGES_REQUESTED',
          },
        ]),
      ),
    });
    expect(reviewLanded.ok).toBe(false);
    expect(reviewLanded.snapshot).toBeNull();
    expect(reviewLanded.errors.join('\n')).toMatch(
      /reviews changed during snapshot fetch/,
    );

    // Inline review comment lands while `issueComments` is paginating.
    const commentLanded = fetchSnapshot({
      pr: 7,
      repo: 'owner/repo',
      run: runWithMidListChange(
        'repos/owner/repo/pulls/7/comments',
        ok([
          { id: 2, updated_at: '2026-10-28T00:01:00Z', body: '' },
          { id: 56, updated_at: '2026-10-28T00:02:00Z', body: 'P1 inline' },
        ]),
      ),
    });
    expect(commentLanded.ok).toBe(false);
    expect(commentLanded.snapshot).toBeNull();
    expect(commentLanded.errors.join('\n')).toMatch(
      /reviewComments changed during snapshot fetch/,
    );

    // JSON `null` or non-object array entries on list fetch or confirmation fail closed without throwing.
    const nullReviewConfirm = fetchSnapshot({
      pr: 7,
      repo: 'owner/repo',
      run: runWithMidListChange('repos/owner/repo/pulls/7/reviews', ok(null)),
    });
    expect(nullReviewConfirm.ok).toBe(false);
    expect(nullReviewConfirm.errors.join('\n')).toMatch(
      /reviews \(confirm\): expected an array, got null/,
    );

    const nullElemConfirm = fetchSnapshot({
      pr: 7,
      repo: 'owner/repo',
      run: runWithMidListChange('repos/owner/repo/pulls/7/reviews', ok([null])),
    });
    expect(nullElemConfirm.ok).toBe(false);
    expect(nullElemConfirm.errors.join('\n')).toMatch(
      /reviews \(confirm\): expected an array of objects/,
    );

    const nullElemInitial = fetchSnapshot({
      pr: 7,
      repo: 'owner/repo',
      run: fakeRun({
        ...base,
        'repos/owner/repo/issues/7/comments': ok([null]),
      }),
    });
    expect(nullElemInitial.ok).toBe(false);
    expect(nullElemInitial.errors.join('\n')).toMatch(
      /issueComments: expected an array of objects/,
    );
  });
});

describe('isSnapshot', () => {
  it('accepts a PR with no comments at all', () => {
    expect(
      isSnapshot(
        snapshot({ reviews: [], reviewComments: [], issueComments: [] }),
      ),
    ).toBe(true);
  });

  it('rejects a snapshot missing a list, so a partial fetch cannot pass', () => {
    const partial = snapshot();
    delete partial.reviewComments;
    expect(isSnapshot(partial)).toBe(false);
    expect(isSnapshot(null)).toBe(false);
    expect(isSnapshot([])).toBe(false);
    expect(isSnapshot(snapshot({ headRefOid: 'short' }))).toBe(false);
    expect(
      isSnapshot(
        snapshot({
          reviews: [{ id: 'x', stamp: null, body: '', state: 'COMMENTED' }],
        }),
      ),
    ).toBe(false);
    expect(isSnapshot(snapshot({ capturedAt: 'not-a-timestamp' }))).toBe(false);
    expect(
      isSnapshot(snapshot({ capturedAt: '2026-11-27T12:00:00.000Z' })),
    ).toBe(true);
  });
});

describe('buildGuardVerdict', () => {
  it('captures PR coordinates, heads, states, timestamps, and dirty reasons', () => {
    const start = snapshot({ capturedAt: '2026-11-27T12:00:00.000Z' });
    const now = snapshot({
      capturedAt: '2026-11-27T12:15:00.000Z',
      issueComments: [{ id: 9, stamp: '2026-11-27T12:10:00Z', body: 'P1' }],
    });
    const result = compareSnapshots(start, now);
    expect(
      buildGuardVerdict({
        start,
        now,
        result,
        comparedAt: '2026-11-27T12:15:02.000Z',
      }),
    ).toEqual({
      schema: GUARD_VERDICT_SCHEMA,
      clean: false,
      repo: 'owner/repo',
      pr: 7,
      startHeadRefOid: HEAD,
      nowHeadRefOid: HEAD,
      startState: 'OPEN',
      nowState: 'OPEN',
      startCapturedAt: '2026-11-27T12:00:00.000Z',
      nowCapturedAt: '2026-11-27T12:15:00.000Z',
      comparedAt: '2026-11-27T12:15:02.000Z',
      reasons: ['issueComments: 9 is new'],
    });
  });
});

describe('compareSnapshots', () => {
  it('reports clean when nothing moved', () => {
    expect(compareSnapshots(snapshot(), snapshot())).toEqual({
      clean: true,
      reasons: [],
    });
  });

  // The measured incident: 324 review comments at round start, 0 on the
  // re-fetch. Nothing was "new", so the hand-run guard read clean.
  it('treats a short list as a failed fetch, not a quiet PR', () => {
    const result = compareSnapshots(
      snapshot({
        reviewComments: Array.from({ length: 324 }, (_, i) => ({
          id: i,
          stamp: null,
          body: '',
        })),
      }),
      snapshot({ reviewComments: [] }),
    );
    expect(result.clean).toBe(false);
    expect(result.reasons.join('\n')).toMatch(
      /reviewComments: re-fetch returned 0 of 324 items — a short list is a failed fetch, not a quiet PR/,
    );
  });

  // Measured on the live PR: a truncated re-fetch printed the short-list reason
  // and then 321 "disappeared" lines, burying the one actionable line. The ids
  // are a consequence of the truncation, not independent reasons.
  it('summarizes the ids a short list lost instead of naming every one', () => {
    const before = Array.from({ length: 324 }, (_, i) => ({
      id: i,
      stamp: null,
      body: '',
    }));
    const result = compareSnapshots(
      snapshot({ reviewComments: before }),
      snapshot({ reviewComments: before.slice(0, 3) }),
    );
    expect(result.clean).toBe(false);
    const listReasons = result.reasons.filter((r) =>
      r.startsWith('reviewComments:'),
    );
    expect(listReasons).toEqual([
      'reviewComments: re-fetch returned 3 of 324 items — a short list is a failed fetch, not a quiet PR',
      'reviewComments: 321 ids absent from the re-fetch (implied by the short list)',
    ]);
    expect(result.reasons.some((r) => /disappeared$/.test(r))).toBe(false);
  });

  // The suppression must not swallow a genuine deletion: at equal length the
  // missing id is the whole signal, so it is still named.
  it('still names a vanished id when the list did not come back short', () => {
    const result = compareSnapshots(
      snapshot({
        reviewComments: [
          { id: 1, stamp: null, body: '' },
          { id: 2, stamp: null, body: '' },
        ],
      }),
      snapshot({
        reviewComments: [
          { id: 1, stamp: null, body: '' },
          { id: 3, stamp: null, body: '' },
        ],
      }),
    );
    expect(result.reasons).toContain('reviewComments: 2 disappeared');
    expect(result.reasons).toContain('reviewComments: 3 is new');
    expect(
      result.reasons.some((r) => /implied by the short list/.test(r)),
    ).toBe(false);
  });

  it('treats a malformed or absent snapshot as dirty', () => {
    expect(compareSnapshots(snapshot(), null).reasons).toContain(
      'now snapshot is missing or malformed',
    );
    expect(compareSnapshots(undefined, snapshot()).reasons).toContain(
      'start snapshot is missing or malformed',
    );
  });

  it('catches a new item, an edited item and a vanished one', () => {
    const added = compareSnapshots(
      snapshot(),
      snapshot({
        issueComments: [{ id: 9, stamp: '2026-10-28T01:00:00Z', body: '' }],
      }),
    );
    expect(added.clean).toBe(false);
    expect(added.reasons).toContain('issueComments: 9 is new');

    const edited = compareSnapshots(
      snapshot(),
      snapshot({
        reviews: [
          {
            id: 1,
            stamp: '2026-10-28T02:00:00Z',
            body: '',
            state: 'COMMENTED',
          },
        ],
      }),
    );
    expect(edited.reasons.join('\n')).toMatch(/reviews: 1 was edited/);

    // Same length, different id: a count-only comparison would call this clean.
    const swapped = compareSnapshots(
      snapshot(),
      snapshot({
        reviewComments: [{ id: 3, stamp: '2026-10-28T00:01:00Z', body: '' }],
      }),
    );
    expect(swapped.reasons).toContain('reviewComments: 2 disappeared');
    expect(swapped.reasons).toContain('reviewComments: 3 is new');
  });

  // Measured on this repo's API: a review object carries submitted_at and no
  // updated_at, and editing its body moves neither. A CHANGES_REQUESTED review
  // rewritten to LGTM is the most consequential edit a round can miss, and a
  // timestamp-only comparison calls it clean.
  it('catches a review edited without its timestamp moving', () => {
    const start = snapshot({
      reviews: [
        {
          id: 1,
          stamp: '2026-10-28T00:00:00Z',
          body: 'needs work',
          state: 'CHANGES_REQUESTED',
        },
      ],
    });
    const now = snapshot({
      reviews: [
        {
          id: 1,
          stamp: '2026-10-28T00:00:00Z',
          body: 'lgtm',
          state: 'CHANGES_REQUESTED',
        },
      ],
    });
    expect(compareSnapshots(start, start).clean).toBe(true);
    const result = compareSnapshots(start, now);
    expect(result.clean).toBe(false);
    expect(result.reasons).toEqual(['reviews: 1 was edited (body changed)']);
  });

  // Measured on PR 15388: review 5673309455 carries submitted_at 19:47:16Z and
  // was dismissed at 01:22:57Z five and a half hours later. The stamp still
  // reads the earlier time, so the dismissal did not move it, and the payload
  // it reports is a 4838-character body — nothing but state records the
  // dismissal. Whether the body was also edited is unobservable, which is why
  // the state is compared: that dismissal is what unblocked the merge gate,
  // and id+stamp+body alone reads clean.
  it('catches a dismissed review, which no timestamp records', () => {
    const start = snapshot({
      reviews: [
        {
          id: 1,
          stamp: '2026-10-27T19:47:16Z',
          body: 'needs work',
          state: 'CHANGES_REQUESTED',
        },
      ],
    });
    const now = snapshot({
      reviews: [
        {
          id: 1,
          stamp: '2026-10-27T19:47:16Z',
          body: 'needs work',
          state: 'DISMISSED',
        },
      ],
    });
    const result = compareSnapshots(start, now);
    expect(result.clean).toBe(false);
    expect(result.reasons).toEqual([
      'reviews: 1 changed state (CHANGES_REQUESTED -> DISMISSED)',
    ]);
  });

  it('catches a moved head, a changed state and a different PR', () => {
    const moved = compareSnapshots(
      snapshot(),
      snapshot({ headRefOid: 'b'.repeat(40) }),
    );
    expect(moved.reasons.join('\n')).toMatch(/head moved/);

    const closed = compareSnapshots(snapshot(), snapshot({ state: 'MERGED' }));
    expect(closed.reasons).toContain('PR state changed OPEN -> MERGED');

    const other = compareSnapshots(snapshot(), snapshot({ pr: 8 }));
    expect(other.reasons.join('\n')).toMatch(
      /snapshots describe different PRs/,
    );

    const inverted = compareSnapshots(
      snapshot({ capturedAt: '2026-11-27T12:10:00.000Z' }),
      snapshot({ capturedAt: '2026-11-27T12:05:00.000Z' }),
    );
    expect(inverted.clean).toBe(false);
    expect(inverted.reasons).toContain(
      'now snapshot (2026-11-27T12:05:00.000Z) is older than start snapshot (2026-11-27T12:10:00.000Z)',
    );
  });

  it('reports every reason, so one fetch is enough to fold in', () => {
    const result = compareSnapshots(
      snapshot(),
      snapshot({
        headRefOid: 'b'.repeat(40),
        issueComments: [{ id: 9, stamp: null, body: '' }],
      }),
    );
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe.skipIf(process.platform === 'win32')('guard (CLI)', () => {
  const run = (args, env = {}) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

  function writeSnapshots(dir, start, now) {
    writeFileSync(join(dir, 'start.json'), JSON.stringify(start));
    writeFileSync(join(dir, 'now.json'), JSON.stringify(now));
    return [
      '--compare',
      '--start',
      join(dir, 'start.json'),
      '--now',
      join(dir, 'now.json'),
    ];
  }

  it('exits 0 when clean and 1 when dirty', () => {
    const dir = tmpDir();
    const clean = run(writeSnapshots(dir, snapshot(), snapshot()));
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain('verify-pr guard: clean');

    const dirty = run(
      writeSnapshots(
        dir,
        snapshot(),
        snapshot({ issueComments: [{ id: 9, stamp: null, body: '' }] }),
      ),
    );
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).toContain('verify-pr guard: dirty');
    expect(dirty.stdout).toContain('issueComments: 9 is new');
    expect(dirty.stdout).toContain('fold it into the report');
  });

  it('exits 1 when a snapshot file is unreadable rather than assuming clean', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'start.json'), JSON.stringify(snapshot()));
    const result = run([
      '--compare',
      '--start',
      join(dir, 'start.json'),
      '--now',
      join(dir, 'missing.json'),
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('now snapshot is missing or malformed');
  });

  it('exits 2 on incomplete arguments', () => {
    expect(run(['--compare']).status).toBe(2);
    expect(run(['--pr', '7']).status).toBe(2);
    expect(run(['--help']).status).toBe(0);
  });

  // A snapshot compared with itself is the cleanest possible round and says
  // nothing about what landed, so a copy-pasted path must not read as clean.
  it('refuses to compare a snapshot with itself', () => {
    const dir = tmpDir();
    const path = join(dir, 'start.json');
    writeFileSync(path, JSON.stringify(snapshot()));
    const result = run(['--compare', '--start', path, '--now', path]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('are the same file');
    expect(result.stdout).not.toContain('clean');
  });

  // A gh stand-in on PATH drives the real CLI, so the refusal to write is
  // observed rather than inferred from the pure function.
  function withGh(dir, body) {
    const bin = join(dir, 'bin');
    spawnSync('mkdir', ['-p', bin]);
    const gh = join(bin, 'gh');
    writeFileSync(gh, `#!/bin/sh\n${body}\n`);
    chmodSync(gh, 0o755);
    return { PATH: `${bin}:${process.env.PATH}` };
  }

  const GH_OK = `case "$*" in
  *"pr view"*) echo '{"headRefOid":"${HEAD}","state":"OPEN"}' ;;
  *reviews*) echo '[{"id":1,"submitted_at":"2026-10-28T00:00:00Z","body":"","state":"COMMENTED"}]' ;;
  *pulls/7/comments*) echo '[{"id":2,"updated_at":"2026-10-28T00:01:00Z","body":""}]' ;;
  *issues/7/comments*) echo '[]' ;;
esac`;

  it('writes a snapshot when every call succeeds', () => {
    const dir = tmpDir();
    const out = join(dir, 'start.json');
    const result = run(
      ['--pr', '7', '--repo', 'owner/repo', '--snapshot', out],
      withGh(dir, GH_OK),
    );
    expect(result.status).toBe(0);
    const written = JSON.parse(readFileSync(out, 'utf8'));
    expect(written.capturedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
    );
    const { capturedAt: _capturedAt, ...rest } = written;
    expect(rest).toEqual(snapshot());
    expect(result.stdout).toContain(
      'reviews 1, reviewComments 1, issueComments 0',
    );
  });

  it('refuses comparing a snapshot with a symlink or hardlink alias to itself', () => {
    const dir = tmpDir();
    const orig = join(dir, 'start.json');
    const sym = join(dir, 'sym.json');
    const hard = join(dir, 'hard.json');
    writeFileSync(orig, JSON.stringify(snapshot()));
    symlinkSync(orig, sym);
    linkSync(orig, hard);

    for (const alias of [sym, hard]) {
      const result = run(['--compare', '--start', orig, '--now', alias]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('are the same file');
      expect(result.stdout).not.toContain('clean');
    }
  });

  it('writes a digest-bound verdict with --compare --out and overwrites stale clean records on dirty', () => {
    const dir = tmpDir();
    const verdictPath = join(dir, 'guard-verdict.json');
    const startSnap = snapshot({ capturedAt: '2026-11-27T12:00:00.000Z' });
    const nowSnap = snapshot({ capturedAt: '2026-11-27T12:05:00.000Z' });

    const clean = run([
      ...writeSnapshots(dir, startSnap, nowSnap),
      '--out',
      verdictPath,
    ]);
    expect(clean.status).toBe(0);
    const rawClean = readFileSync(verdictPath, 'utf8');
    const cleanSha = createHash('sha256')
      .update(rawClean, 'utf8')
      .digest('hex');
    expect(clean.stdout).toContain(`  guard-verdict  ${verdictPath}`);
    expect(clean.stdout).toContain(`  guard-sha256  ${cleanSha}`);
    const parsedClean = JSON.parse(rawClean);
    expect(parsedClean.schema).toBe(GUARD_VERDICT_SCHEMA);
    expect(parsedClean.clean).toBe(true);
    expect(parsedClean.reasons).toEqual([]);
    expect(parsedClean.startCapturedAt).toBe('2026-11-27T12:00:00.000Z');
    expect(parsedClean.nowCapturedAt).toBe('2026-11-27T12:05:00.000Z');

    // A later dirty comparison at the same --out path overwrites clean=true
    // with clean=false so a stale clean verdict cannot survive.
    const dirtyNow = snapshot({
      capturedAt: '2026-11-27T12:10:00.000Z',
      issueComments: [{ id: 9, stamp: '2026-11-27T12:09:00Z', body: 'P1' }],
    });
    const dirty = run([
      ...writeSnapshots(dir, startSnap, dirtyNow),
      '--out',
      verdictPath,
    ]);
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).not.toContain('guard-sha256');
    const parsedDirty = JSON.parse(readFileSync(verdictPath, 'utf8'));
    expect(parsedDirty.clean).toBe(false);
    expect(parsedDirty.reasons).toContain('issueComments: 9 is new');
  });

  it('refuses unsafe --out targets, missing flag values, and unknown options', () => {
    const dir = tmpDir();
    const startSnap = snapshot({ capturedAt: '2026-11-27T12:00:00.000Z' });
    const nowSnap = snapshot({ capturedAt: '2026-11-27T12:05:00.000Z' });
    const baseArgs = writeSnapshots(dir, startSnap, nowSnap);

    // --out aliasing --start or --now (directly or via symlinked parent dir)
    // is a usage error.
    expect(run([...baseArgs, '--out', join(dir, 'start.json')]).status).toBe(2);
    expect(run([...baseArgs, '--out', join(dir, 'now.json')]).status).toBe(2);
    const parentAlias = join(dir, 'dir-alias');
    symlinkSync(dir, parentAlias);
    expect(
      run([...baseArgs, '--out', join(parentAlias, 'start.json')]).status,
    ).toBe(2);
    expect(
      isSnapshot(snapshot({ capturedAt: '2026-02-31T12:00:00.000Z' })),
    ).toBe(false);

    // --out through a symlink, hardlink, or directory is refused.
    const target = join(dir, 'real.json');
    writeFileSync(target, 'keep');
    const symOut = join(dir, 'sym-out.json');
    symlinkSync(target, symOut);
    const symRes = run([...baseArgs, '--out', symOut]);
    expect(symRes.status).toBe(1);
    expect(symRes.stderr).toContain('symbolic link');
    expect(readFileSync(target, 'utf8')).toBe('keep');

    const hardOut = join(dir, 'hard-out.json');
    linkSync(target, hardOut);
    const hardRes = run([...baseArgs, '--out', hardOut]);
    expect(hardRes.status).toBe(1);
    expect(hardRes.stderr).toContain('hard link');

    const dirOut = join(dir, 'dir-out');
    mkdirSync(dirOut);
    expect(run([...baseArgs, '--out', dirOut]).status).toBe(1);

    // Usage errors for missing/empty value, misplaced --out, and unknown flag.
    expect(run([...baseArgs, '--out']).status).toBe(2);
    expect(run([...baseArgs, '--out', '']).status).toBe(2);
    expect(
      run([
        '--pr',
        '7',
        '--repo',
        'owner/repo',
        '--snapshot',
        join(dir, 's.json'),
        '--out',
        join(dir, 'v.json'),
      ]).status,
    ).toBe(2);
    expect(run(['--unknown-flag']).status).toBe(2);
    expect(run([...baseArgs, 'stray-positional']).status).toBe(2);
    expect(
      run([
        '--pr',
        '7',
        '--repo',
        'bad/repo/slug',
        '--snapshot',
        join(dir, 'bad-repo.json'),
      ]).status,
    ).toBe(2);
    expect(isSnapshot(snapshot({ repo: 'bad/repo/slug' }))).toBe(false);
    expect(isSnapshot(snapshot({ repo: 'owner/' }))).toBe(false);
  });

  it('leaves no file behind when a call fails, so a retry cannot read as a snapshot', () => {
    const dir = tmpDir();
    const out = join(dir, 'start.json');
    const failing = GH_OK.replace(
      `  *pulls/7/comments*) echo '[{"id":2,"updated_at":"2026-10-28T00:01:00Z","body":""}]' ;;`,
      `  *pulls/7/comments*) echo 'dial tcp: i/o timeout' >&2; exit 1 ;;`,
    );
    const result = run(
      ['--pr', '7', '--repo', 'owner/repo', '--snapshot', out],
      withGh(dir, failing),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('snapshot refused, nothing written');
    expect(result.stderr).toContain('reviewComments: gh exited 1');
    expect(existsSync(out)).toBe(false);
  });

  it('removes a stale regular snapshot when a refresh fails so a retry cannot pass with old data, without touching symlinks or hardlinks', () => {
    const dir = tmpDir();
    const startPath = join(dir, 'guard-start.json');
    const nowPath = join(dir, 'guard-now.json');
    const verdictPath = join(dir, 'guard-verdict.json');

    // First capture succeeds and writes both start and now snapshots.
    const okEnv = withGh(dir, GH_OK);
    expect(
      run(['--pr', '7', '--repo', 'owner/repo', '--snapshot', startPath], okEnv)
        .status,
    ).toBe(0);
    expect(
      run(['--pr', '7', '--repo', 'owner/repo', '--snapshot', nowPath], okEnv)
        .status,
    ).toBe(0);
    expect(existsSync(nowPath)).toBe(true);

    // Next refresh fails because gh is unavailable: the stale regular
    // guard-now.json is removed so a subsequent compare cannot silently reuse it.
    const failing = GH_OK.replace(
      `  *pulls/7/comments*) echo '[{"id":2,"updated_at":"2026-10-28T00:01:00Z","body":""}]' ;;`,
      `  *pulls/7/comments*) echo 'dial tcp: i/o timeout' >&2; exit 1 ;;`,
    );
    const refreshFail = run(
      ['--pr', '7', '--repo', 'owner/repo', '--snapshot', nowPath],
      withGh(dir, failing),
    );
    expect(refreshFail.status).toBe(1);
    expect(refreshFail.stderr).toContain(`removed stale ${nowPath}`);
    expect(existsSync(nowPath)).toBe(false);

    const compareAfterFail = run([
      '--compare',
      '--start',
      startPath,
      '--now',
      nowPath,
      '--out',
      verdictPath,
    ]);
    expect(compareAfterFail.status).toBe(1);
    expect(compareAfterFail.stdout).toContain(
      'now snapshot is missing or malformed',
    );
    expect(JSON.parse(readFileSync(verdictPath, 'utf8')).clean).toBe(false);

    // Safety negative control: symlinks and hardlinks are refused before
    // fetching and are never unlinked on failure.
    const protectedTarget = join(dir, 'protected.json');
    writeFileSync(protectedTarget, 'do-not-delete');
    const symSnap = join(dir, 'sym-snap.json');
    symlinkSync(protectedTarget, symSnap);
    const symRes = run(
      ['--pr', '7', '--repo', 'owner/repo', '--snapshot', symSnap],
      withGh(dir, failing),
    );
    expect(symRes.status).toBe(1);
    expect(symRes.stderr).toContain('symbolic link');
    expect(existsSync(symSnap)).toBe(true);
    expect(readFileSync(protectedTarget, 'utf8')).toBe('do-not-delete');

    const hardSnap = join(dir, 'hard-snap.json');
    linkSync(protectedTarget, hardSnap);
    const hardRes = run(
      ['--pr', '7', '--repo', 'owner/repo', '--snapshot', hardSnap],
      withGh(dir, failing),
    );
    expect(hardRes.status).toBe(1);
    expect(hardRes.stderr).toContain('hard link');
    expect(existsSync(hardSnap)).toBe(true);
    expect(readFileSync(protectedTarget, 'utf8')).toBe('do-not-delete');
  });

  it('refuses overwriting an existing start snapshot with --no-clobber and isolates concurrent rounds in per-round directories', () => {
    const dir = tmpDir();
    const roundADir = join(dir, 'round-a');
    const roundBDir = join(dir, 'round-b');
    mkdirSync(roundADir, { recursive: true });
    mkdirSync(roundBDir, { recursive: true });
    const startA = join(roundADir, 'guard-start.json');
    const nowA = join(roundADir, 'guard-now.json');
    const verdictA = join(roundADir, 'guard-verdict.json');
    const startB = join(roundBDir, 'guard-start.json');
    const nowB = join(roundBDir, 'guard-now.json');
    const verdictB = join(roundBDir, 'guard-verdict.json');

    // Round A captures its start snapshot exclusively before a new P1 lands.
    const envBeforeP1 = withGh(dir, GH_OK);
    expect(
      run(
        [
          '--pr',
          '7',
          '--repo',
          'owner/repo',
          '--snapshot',
          startA,
          '--no-clobber',
        ],
        envBeforeP1,
      ).status,
    ).toBe(0);
    const originalA = readFileSync(startA, 'utf8');

    // A second round pointing at Round A's path with --no-clobber is refused
    // without touching or deleting Round A's start snapshot.
    const ghAfterP1 = GH_OK.replace(
      `  *issues/7/comments*) echo '[]' ;;`,
      `  *issues/7/comments*) echo '[{"id":99,"updated_at":"2026-10-28T00:05:00Z","body":"[P1] new finding"}]' ;;`,
    );
    const envAfterP1 = withGh(join(dir, 'gh-p1'), ghAfterP1);
    const clobberAttempt = run(
      [
        '--pr',
        '7',
        '--repo',
        'owner/repo',
        '--snapshot',
        startA,
        '--no-clobber',
      ],
      envAfterP1,
    );
    expect(clobberAttempt.status).toBe(1);
    expect(clobberAttempt.stderr).toContain('--no-clobber');
    expect(readFileSync(startA, 'utf8')).toBe(originalA);

    // Round B captures its own start snapshot in round-b/ (including P1 #99).
    expect(
      run(
        [
          '--pr',
          '7',
          '--repo',
          'owner/repo',
          '--snapshot',
          startB,
          '--no-clobber',
        ],
        envAfterP1,
      ).status,
    ).toBe(0);

    // Round A's publish check still detects P1 #99 as new and exits 1, while
    // Round B (which started after P1 #99) sees a clean round.
    expect(
      run(['--pr', '7', '--repo', 'owner/repo', '--snapshot', nowA], envAfterP1)
        .status,
    ).toBe(0);
    const cmpA = run([
      '--compare',
      '--start',
      startA,
      '--now',
      nowA,
      '--out',
      verdictA,
    ]);
    expect(cmpA.status).toBe(1);
    expect(cmpA.stdout).toContain('issueComments: 99 is new');
    expect(JSON.parse(readFileSync(verdictA, 'utf8')).clean).toBe(false);

    expect(
      run(['--pr', '7', '--repo', 'owner/repo', '--snapshot', nowB], envAfterP1)
        .status,
    ).toBe(0);
    const cmpB = run([
      '--compare',
      '--start',
      startB,
      '--now',
      nowB,
      '--out',
      verdictB,
    ]);
    expect(cmpB.status).toBe(0);
    expect(JSON.parse(readFileSync(verdictB, 'utf8')).clean).toBe(true);

    // --no-clobber is rejected with --compare.
    expect(
      run(['--compare', '--start', startB, '--now', nowB, '--no-clobber'])
        .status,
    ).toBe(2);
  });

  it('rejects a mid-fetch push arriving while comment pages are returned and removes any stale now snapshot', () => {
    const dir = tmpDir();
    const startPath = join(dir, 'guard-start.json');
    const nowPath = join(dir, 'guard-now.json');
    const stateFile = join(dir, 'push-marker');
    const HEAD_B = 'b'.repeat(40);

    const okEnv = withGh(dir, GH_OK);
    expect(
      run(['--pr', '7', '--repo', 'owner/repo', '--snapshot', startPath], okEnv)
        .status,
    ).toBe(0);
    expect(
      run(['--pr', '7', '--repo', 'owner/repo', '--snapshot', nowPath], okEnv)
        .status,
    ).toBe(0);

    // Simulate a push landing right as the first comment list returns: the
    // opening `pr view` sees HEAD, reviews marks stateFile, and the closing
    // `pr view` observes HEAD_B.
    const midPushGh = `#!/bin/sh
case "$*" in
  *'pr view'*)
    if [ -f "${stateFile}" ]; then
      echo '{"headRefOid":"${HEAD_B}","state":"OPEN"}'
    else
      echo '{"headRefOid":"${HEAD}","state":"OPEN"}'
    fi ;;
  *pulls/7/reviews*)
    touch "${stateFile}"
    echo '[{"id":1,"submitted_at":"2026-10-28T00:00:00Z","body":"","state":"COMMENTED"}]' ;;
  *pulls/7/comments*) echo '[{"id":2,"updated_at":"2026-10-28T00:01:00Z","body":""}]' ;;
  *issues/7/comments*) echo '[]' ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
`;
    const midPushEnv = withGh(join(dir, 'gh-midpush'), midPushGh);
    const res = run(
      ['--pr', '7', '--repo', 'owner/repo', '--snapshot', nowPath],
      midPushEnv,
    );
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('PR head moved during snapshot fetch');
    expect(res.stderr).toContain(`removed stale ${nowPath}`);
    expect(existsSync(nowPath)).toBe(false);
  });

  it('rejects a mid-fetch CHANGES_REQUESTED review and a closing null pr view via CLI', () => {
    const dir = tmpDir();
    const startPath = join(dir, 'guard-start.json');
    const nowPath = join(dir, 'guard-now.json');
    const reviewMarker = join(dir, 'review-arrived');
    const nullMarker = join(dir, 'null-confirm');

    const okEnv = withGh(dir, GH_OK);
    expect(
      run(['--pr', '7', '--repo', 'owner/repo', '--snapshot', startPath], okEnv)
        .status,
    ).toBe(0);
    expect(
      run(['--pr', '7', '--repo', 'owner/repo', '--snapshot', nowPath], okEnv)
        .status,
    ).toBe(0);

    // Head and state stay identical, while a CHANGES_REQUESTED review with no
    // inline comments arrives while `pulls/7/comments` is being read.
    const midReviewGh = `#!/bin/sh
case "$*" in
  *'pr view'*) echo '{"headRefOid":"${HEAD}","state":"OPEN"}' ;;
  *pulls/7/reviews*)
    if [ -f "${reviewMarker}" ]; then
      echo '[{"id":1,"submitted_at":"2026-10-28T00:00:00Z","body":"","state":"COMMENTED"},{"id":90,"submitted_at":"2026-10-28T00:03:00Z","body":"please fix","state":"CHANGES_REQUESTED"}]'
    else
      echo '[{"id":1,"submitted_at":"2026-10-28T00:00:00Z","body":"","state":"COMMENTED"}]'
    fi ;;
  *pulls/7/comments*)
    touch "${reviewMarker}"
    echo '[{"id":2,"updated_at":"2026-10-28T00:01:00Z","body":""}]' ;;
  *issues/7/comments*) echo '[]' ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
`;
    const midReviewRes = run(
      ['--pr', '7', '--repo', 'owner/repo', '--snapshot', nowPath],
      withGh(join(dir, 'gh-midreview'), midReviewGh),
    );
    expect(midReviewRes.status).toBe(1);
    expect(midReviewRes.stderr).toContain(
      'reviews changed during snapshot fetch',
    );
    expect(midReviewRes.stderr).toContain(`removed stale ${nowPath}`);
    expect(existsSync(nowPath)).toBe(false);

    // Opening pr view succeeds, closing pr view returns exit 0 with JSON `null`.
    expect(
      run(['--pr', '7', '--repo', 'owner/repo', '--snapshot', nowPath], okEnv)
        .status,
    ).toBe(0);
    const nullConfirmGh = `#!/bin/sh
case "$*" in
  *'pr view'*)
    if [ -f "${nullMarker}" ]; then
      echo 'null'
    else
      touch "${nullMarker}"
      echo '{"headRefOid":"${HEAD}","state":"OPEN"}'
    fi ;;
  *pulls/7/reviews*) echo '[{"id":1,"submitted_at":"2026-10-28T00:00:00Z","body":"","state":"COMMENTED"}]' ;;
  *pulls/7/comments*) echo '[{"id":2,"updated_at":"2026-10-28T00:01:00Z","body":""}]' ;;
  *issues/7/comments*) echo '[]' ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
`;
    const nullConfirmRes = run(
      ['--pr', '7', '--repo', 'owner/repo', '--snapshot', nowPath],
      withGh(join(dir, 'gh-nullconfirm'), nullConfirmGh),
    );
    expect(nullConfirmRes.status).toBe(1);
    expect(nullConfirmRes.stderr).toContain(
      'pr view (confirm): expected an object, got null',
    );
    expect(nullConfirmRes.stderr).toContain(`removed stale ${nowPath}`);
    expect(existsSync(nowPath)).toBe(false);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'invalidates a read-only stale snapshot or verdict when overwriting fails with EACCES',
    () => {
      const dir = tmpDir();
      const startPath = join(dir, 'guard-start.json');
      const nowPath = join(dir, 'guard-now.json');
      const verdictPath = join(dir, 'guard-verdict.json');
      const okEnv = withGh(dir, GH_OK);

      expect(
        run(
          ['--pr', '7', '--repo', 'owner/repo', '--snapshot', startPath],
          okEnv,
        ).status,
      ).toBe(0);
      expect(
        run(['--pr', '7', '--repo', 'owner/repo', '--snapshot', nowPath], okEnv)
          .status,
      ).toBe(0);

      // Make the stale guard-now.json read-only inside the writable directory.
      // Refresh fetches successfully, write fails with EACCES, and the stale
      // read-only snapshot is unlinked so a subsequent compare fails closed.
      chmodSync(nowPath, 0o444);
      const writeFail = run(
        ['--pr', '7', '--repo', 'owner/repo', '--snapshot', nowPath],
        okEnv,
      );
      expect(writeFail.status).toBe(1);
      expect(writeFail.stderr).toContain('cannot write');
      expect(writeFail.stderr).toContain(`removed stale ${nowPath}`);
      expect(existsSync(nowPath)).toBe(false);

      const cmpAfterWriteFail = run([
        '--compare',
        '--start',
        startPath,
        '--now',
        nowPath,
        '--out',
        verdictPath,
      ]);
      expect(cmpAfterWriteFail.status).toBe(1);
      expect(cmpAfterWriteFail.stdout).toContain(
        'now snapshot is missing or malformed',
      );

      // Same invariant for a read-only clean guard-verdict.json: a failing
      // --compare --out write invalidates the old clean verdict.
      expect(
        run(['--pr', '7', '--repo', 'owner/repo', '--snapshot', nowPath], okEnv)
          .status,
      ).toBe(0);
      expect(
        run([
          '--compare',
          '--start',
          startPath,
          '--now',
          nowPath,
          '--out',
          verdictPath,
        ]).status,
      ).toBe(0);
      chmodSync(verdictPath, 0o444);
      const verdictWriteFail = run([
        '--compare',
        '--start',
        startPath,
        '--now',
        nowPath,
        '--out',
        verdictPath,
      ]);
      expect(verdictWriteFail.status).toBe(1);
      expect(verdictWriteFail.stderr).toContain(`removed stale ${verdictPath}`);
      expect(existsSync(verdictPath)).toBe(false);
    },
  );
});
