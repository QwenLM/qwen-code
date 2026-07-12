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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ghMock = vi.hoisted(() => vi.fn(() => ''));
vi.mock('./lib/gh.js', () => ({
  gh: ghMock,
  setGhHost: vi.fn(),
}));

const { runSubmit } = await import('./submit.js');

let dir: string;

const REVIEW = {
  commit_id: 'abc123',
  event: 'COMMENT',
  body: 'Reviewed — no blockers.',
  comments: [],
};

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
    userAuthorized: false,
    dryRun: false,
    ...over,
  } as never;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'review-submit-'));
  ghMock.mockClear();
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
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
    const verdict = file('parse.json', {
      target: { type: 'pr-number', number: 6771 },
      comment: { requested: false, effective: false },
    });

    runSubmit(args({ parseArgs: verdict }));

    expect(ghMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it('refuses when the parse-args report cannot be read', () => {
    // Fail closed. A missing authorisation record is not an absent objection.
    runSubmit(args({ parseArgs: join(dir, 'no-such.json') }));

    expect(ghMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it('refuses on `requested` alone — only `effective` authorises', () => {
    // `--comment` on a non-PR target is requested but not effective. Posting on
    // the strength of the request would post to a PR the user never named.
    const verdict = file('parse.json', {
      comment: { requested: true, effective: false },
    });

    runSubmit(args({ parseArgs: verdict }));

    expect(ghMock).not.toHaveBeenCalled();
  });

  it('posts when `--comment` made it effective', () => {
    const verdict = file('parse.json', {
      comment: { requested: true, effective: true },
    });

    runSubmit(args({ parseArgs: verdict }));

    expect(ghMock).toHaveBeenCalledOnce();
    const call = ghMock.mock.calls[0] as unknown as string[];
    expect(call).toContain('api');
    expect(call).toContain('repos/QwenLM/qwen-code/pulls/6771/reviews');
    // `--input`, never `-f body=` — the latter re-escapes the newlines and the
    // footer arrives in the posted text as a literal `\n`.
    expect(call).toContain('--input');
  });

  it('posts when the user asked for it in so many words', () => {
    runSubmit(args({ userAuthorized: true }));
    expect(ghMock).toHaveBeenCalledOnce();
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

  it('rejects a body that promises inline comments it does not carry', () => {
    // The same breaching run posted "Reviewed. Suggestions are inline." with an
    // empty `comments` array, and closed by reporting `0 Suggestion inline`.
    // Every count disagreed with every other, and GitHub accepted all of it —
    // none of it is invalid to the API, so this is the only place it can be
    // caught.
    const review = file('bad-0.json', {
      ...REVIEW,
      body: 'Reviewed. Suggestions are inline.',
      comments: [],
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(
      /body says findings are inline, but `comments` is empty/,
    );
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('rejects a literal `\\n` smuggled into the body', () => {
    const review = file('bad-1.json', {
      ...REVIEW,
      body: 'Reviewed.\\n\\n_— model via Qwen Code /review_',
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(/literal/);
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
      body: '',
      event: 'REQUEST_CHANGES',
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

    expect(() => runSubmit(authorized({ review }))).toThrow(/no `line`/);
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('rejects the one combination GitHub itself rejects', () => {
    // A COMMENT with neither a body nor comments loses the review entirely.
    const review = file('bad-5.json', {
      commit_id: 'abc123',
      event: 'COMMENT',
      body: '',
      comments: [],
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(
      /rejected by GitHub/,
    );
    expect(ghMock).not.toHaveBeenCalled();
  });
});
