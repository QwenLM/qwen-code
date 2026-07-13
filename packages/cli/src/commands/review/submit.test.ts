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

  it('posts when the user typed `--comment`', () => {
    runSubmit(args({ skillArgs: file('skill-args.txt', '6771 --comment') }));

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

  it('rejects an escaped footer — the fingerprint of a shell-built body', () => {
    // Verbatim from the breaching dogfood run.
    const review = file('bad-1.json', {
      ...REVIEW,
      body: 'Reviewed.\\n\\n_— qwen3-coder-plus via Qwen Code /review_',
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(/literal/);
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('does not refuse a body whose finding text legitimately contains `\\n`', () => {
    // An unmappable Critical's description is finding text, and finding text
    // quotes code: `/\n/` in a regex, an escaped string in a snippet. A check
    // that searched the whole body for the two characters would fire here — and
    // a false positive does not warn, it REFUSES the post, losing a review that
    // had a real blocker in it. The bug's signature is the escaped footer, not
    // the character.
    const review = file('good-1.json', {
      ...REVIEW,
      body:
        '**[Critical]** the splitter uses `/\\n/` where the input is CRLF, so ' +
        'every line keeps a trailing `\\r`.\n\n_— model via Qwen Code /review_',
    });

    runSubmit(authorized({ review }));
    expect(ghMock).toHaveBeenCalledOnce();
  });

  it('rejects a payload with no commit_id', () => {
    const review = file('bad-6.json', { ...REVIEW, commit_id: undefined });
    expect(() => runSubmit(authorized({ review }))).toThrow(/`commit_id`/);
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('rejects a payload with no event', () => {
    const review = file('bad-7.json', { ...REVIEW, event: undefined });
    expect(() => runSubmit(authorized({ review }))).toThrow(/`event`/);
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

    expect(() => runSubmit(authorized({ review }))).toThrow(/usable `line`/);
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('does not refuse a blocker that merely says the word "inline"', () => {
    // A body IS finding text. An unmappable Critical reading "the inline cache
    // is stale" is a real blocker, and a `/\binline\b/` search refused to post
    // it. The check is for a body that *promises* comments it did not bring — so
    // look for the promise, not for the word.
    const review = file('good-2.json', {
      ...REVIEW,
      body: '**[Critical]** the inline cache is stale after a rebase.',
      comments: [],
    });

    runSubmit(authorized({ review }));
    expect(ghMock).toHaveBeenCalledOnce();
  });

  it('rejects an event GitHub does not accept', () => {
    const review = file('bad-8.json', { ...REVIEW, event: 'LGTM' });
    expect(() => runSubmit(authorized({ review }))).toThrow(
      /GitHub accepts only/,
    );
    expect(ghMock).not.toHaveBeenCalled();
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
