/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
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
  it('normalizes each list and reads the review stamp from submitted_at', () => {
    const result = fetchSnapshot({
      pr: 7,
      repo: 'owner/repo',
      run: fakeRun(allLists()),
    });
    expect(result.ok).toBe(true);
    expect(result.snapshot).toEqual(snapshot());
  });

  it('asks for every page, not the first 30', () => {
    const calls = [];
    const run = (args) => {
      calls.push(args);
      return fakeRun(allLists())(args);
    };
    fetchSnapshot({ pr: 7, repo: 'owner/repo', run });
    const apiCalls = calls.filter((args) => args[0] === 'api');
    expect(apiCalls).toHaveLength(3);
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
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(snapshot());
    expect(result.stdout).toContain(
      'reviews 1, reviewComments 1, issueComments 0',
    );
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
});
