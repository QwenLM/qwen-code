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

const ghMock = vi.hoisted(() =>
  vi.fn((_payload: string, ..._rest: string[]) => ''),
);
vi.mock('./lib/gh.js', () => ({
  ghWithInput: ghMock,
  gh: vi.fn(() => ''),
  setGhHost: vi.fn(),
}));

const { runSubmit } = await import('./submit.js');

let dir: string;

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

  it('posts when the user typed `--comment`', () => {
    runSubmit(args({ skillArgs: file('skill-args.txt', '6771 --comment') }));

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

  it('counts the blockers it is actually carrying, not the ones it was told about', () => {
    // A Critical attached inline is a Critical, whatever the state says. There is
    // no `criticalsInline` field to under-report it with — and one supplied
    // anyway is refused.
    const review = file('c1.json', {
      ...REVIEW,
      comments: [
        { path: 'a.ts', line: 12, body: '**[Critical]** boom' },
        { path: 'b.ts', line: 3, body: '**[Suggestion]** tidy' },
      ],
    });

    runSubmit(authorized({ review }));
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

  it('writes the body as JSON, so a finding that quotes `\\n` survives intact', () => {
    // Finding text quotes code: `/\n/` in a regex, an escaped string in a snippet.
    // The body used to be built by the caller — sometimes with `-f body=`, which
    // posted the newlines as the two literal characters. It is built here now, in
    // JS, and the finding's own text is carried through untouched.
    const review = file('good-1.json', {
      ...REVIEW,
      state: {
        ...REVIEW.state,
        bodyCriticals: [
          'the splitter uses `/\\n/` where the input is CRLF, so every line ' +
            'keeps a trailing `\\r`',
        ],
      },
    });

    runSubmit(authorized({ review }));
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
        bodyCriticals: ['the inline cache is stale after a rebase'],
      },
      comments: [],
    });

    runSubmit(authorized({ review }));
    expect(ghMock).toHaveBeenCalledOnce();
    const sent = JSON.parse(ghMock.mock.calls[0][0] as string);
    expect(sent.event).toBe('REQUEST_CHANGES');
    expect(sent.body).toContain('the inline cache is stale after a rebase');
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
