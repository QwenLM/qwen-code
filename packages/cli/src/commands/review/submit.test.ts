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
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { reviewWriteAuthorization } from './lib/authorization.js';
import { join } from 'node:path';
import { promptRecordDir, briefPath } from './lib/prompt-record.js';
import { parseLedger } from './lib/ledger.js';

const ghMock = vi.hoisted(() =>
  vi.fn((_payload: string, ..._rest: string[]) => ''),
);
const ghViewMock = vi.hoisted(() => vi.fn((..._args: string[]) => ''));
vi.mock('./lib/gh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/gh.js')>();
  return {
    ...actual,
    ghWithInput: ghMock,
    gh: ghViewMock,
    setGhHost: vi.fn(),
  };
});

const writeStdoutSpy = vi.hoisted(() => vi.fn((_line: string) => {}));
const writeStderrSpy = vi.hoisted(() => vi.fn((_line: string) => {}));
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: writeStdoutSpy,
  writeStderrLine: writeStderrSpy,
}));
vi.mock('../../utils/version.js', () => ({
  getCliVersion: vi.fn().mockResolvedValue('0.21.2'),
}));

// The handler reads `review.attribution` / `review.comment` from the
// operator's real settings.json — a developer running with either set would
// watch the assertions below redden through no fault of the code. Pin the
// values these tests read; the attribution-off path is covered by calling
// runSubmit directly.
const reviewSettingsMock = vi.hoisted(() =>
  vi.fn((): Record<string, unknown> => ({ attribution: true })),
);
vi.mock('../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settings.js')>();
  return {
    ...actual,
    // The production call carries `{ skipWorkspaceSettings: true }` — these
    // policy keys resolve from operator scopes only. A caller that forgets
    // the flag reads the workspace-polluted view below instead, and the
    // assertions redden: a repository's `.qwen/settings.json` must not
    // control them.
    loadSettings: vi.fn((...callArgs: unknown[]) => {
      const opts = callArgs[1] as
        | { skipWorkspaceSettings?: boolean }
        | undefined;
      return {
        merged: {
          review: opts?.skipWorkspaceSettings
            ? reviewSettingsMock()
            : { attribution: false, comment: true, effort: 'low' },
        },
      };
    }),
  };
});

const { runSubmit, submitCommand } = await import('./submit.js');

let dir: string;
let savedSessionId: string | undefined;

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
  ghViewMock.mockClear();
  writeStdoutSpy.mockClear();
  writeStderrSpy.mockClear();
  reviewSettingsMock.mockReturnValue({ attribution: true });
  process.exitCode = undefined;
  savedSessionId = process.env['QWEN_CODE_SESSION_ID'];
  delete process.env['QWEN_CODE_SESSION_ID'];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
  if (savedSessionId === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
  else process.env['QWEN_CODE_SESSION_ID'] = savedSessionId;
});

describe('authorization — URL-shaped host and repo binding at the submit call site', () => {
  // The pr-url binding (repo + bidirectional host) was, until now, exercised
  // only through publish-assets' suite; the gate is shared, and submit is the
  // caller that always binds the repo. Pin it here too.
  let dir: string;
  let savedGhHost: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'submit-auth-'));
    savedGhHost = process.env['GH_HOST'];
    delete process.env['GH_HOST'];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedGhHost !== undefined) process.env['GH_HOST'] = savedGhHost;
    else delete process.env['GH_HOST'];
  });

  function authFor(rawArgs: string, over: Record<string, unknown> = {}) {
    const argsFile = join(dir, 'args.txt');
    writeFileSync(argsFile, `${rawArgs}\n`);
    return reviewWriteAuthorization({
      userAuthorized: false,
      skillArgs: argsFile,
      pr: 123,
      repo: 'o/r',
      host: undefined,
      ...over,
    } as never);
  }

  it('binds the repo of a URL-shaped authorisation', () => {
    expect(authFor('https://github.com/o/r/pull/123 --comment').ok).toBe(true);
    const wrong = authFor('https://github.com/other/repo/pull/123 --comment');
    expect(wrong.ok).toBe(false);
    expect(wrong.why).toContain('other/repo');
  });

  it('binds the host in both directions, defaulting an absent host to github.com', () => {
    // Enterprise authorisation, host-less write → refused.
    const up = authFor('https://ghe.corp.example/o/r/pull/123 --comment');
    expect(up.ok).toBe(false);
    expect(up.why).toContain('ghe.corp.example');
    // github.com authorisation, Enterprise write → refused.
    const down = authFor('https://github.com/o/r/pull/123 --comment', {
      host: 'ghe.corp.example',
    });
    expect(down.ok).toBe(false);
    // Matching Enterprise pair → passes.
    expect(
      authFor('https://ghe.corp.example/o/r/pull/123 --comment', {
        host: 'ghe.corp.example',
      }).ok,
    ).toBe(true);
  });

  it('the audit text names the source that authorised — flag and setting stay distinguishable', () => {
    // `why` rides the success line and the persisted refusal record. Swapping
    // the gate's two ternary branches attributes a setting-authorised post to
    // a flag the operator never typed — and survives every other test, so pin
    // both branches here.
    const bySetting = authFor('123', { defaultComment: true });
    expect(bySetting.ok).toBe(true);
    expect(bySetting.why).toContain('`review.comment` is enabled in settings');
    expect(bySetting.why).toContain('#123');

    const byFlag = authFor('123 --comment');
    expect(byFlag.ok).toBe(true);
    expect(byFlag.why).toContain('`--comment` was in the review arguments');
  });

  it('a requested-but-unbindable comment names the missing PR, not a missing flag', () => {
    // When comment was requested — by the flag or the standing setting — but
    // the arguments name no PR, the refusal must say THAT. Blaming a missing
    // `--comment` flag the operator never typed (and implying one would fix
    // it) misdirects; the request itself is on record.
    const bySetting = authFor('src/foo.ts', { defaultComment: true });
    expect(bySetting.ok).toBe(false);
    expect(bySetting.why).toContain('do not name a');
    expect(bySetting.why).not.toContain(
      '`--comment` was not in the review arguments',
    );

    const byFlag = authFor('src/foo.ts --comment');
    expect(byFlag.ok).toBe(false);
    expect(byFlag.why).toContain('do not name a');

    // Neither source requested it: the original wording stands.
    const neither = authFor('src/foo.ts');
    expect(neither.ok).toBe(false);
    expect(neither.why).toContain(
      '`--comment` was not in the review arguments',
    );
  });

  it('a missing args file names the missing invocation, not a missing flag, when the setting authorises', () => {
    // With `review.comment` on, telling the operator to re-run with
    // `--comment` misdirects: the blocker is that no recorded invocation
    // names a PR, and a plain re-run fixes it. Flag-driven operators keep
    // the flag wording — for them the flag IS the missing piece.
    const missing = join(dir, 'no-such-args.txt');
    const base = {
      userAuthorized: false,
      skillArgs: missing,
      pr: 123,
      repo: 'o/r',
    };

    const bySetting = reviewWriteAuthorization({
      ...base,
      defaultComment: true,
    });
    expect(bySetting.ok).toBe(false);
    expect(bySetting.why).toContain(
      'no recorded invocation names a pull request',
    );
    expect(bySetting.why).not.toContain('`--comment`');

    const byFlag = reviewWriteAuthorization(base);
    expect(byFlag.ok).toBe(false);
    expect(byFlag.why).toContain('cannot show that `--comment` was requested');

    // Both production callers pass a strict boolean (destructured default /
    // the resolved setting), so pin the flag branch with the explicit false
    // they actually send — a presence-check mutation of the ternary must not
    // survive.
    const byFlagExplicit = reviewWriteAuthorization({
      ...base,
      defaultComment: false,
    });
    expect(byFlagExplicit.ok).toBe(false);
    expect(byFlagExplicit.why).toContain(
      'cannot show that `--comment` was requested',
    );
  });
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

  it('matches the refusal advice to the refusal class', () => {
    // The advice is the prose the reviewing model reads to choose its retry.
    // An unconditional "Re-run with --comment" is wrong for the target-
    // binding refusals the review.comment setting path reaches: the flag
    // cannot bind a target (and the setting already stood in for it), so
    // advising it there buys a futile retry loop. Pin both branches: a
    // wording edit to the gate that breaks the class split reddens here.
    const advice = () =>
      (writeStderrSpy.mock.calls.map((c) => c[0]) as string[]).join(' ');

    // A post that was never requested: the remedy names the flag.
    runSubmit(args({ skillArgs: file('advice-flag.txt', '6771') }));
    expect(advice()).toContain('Re-run with `--comment`');
    writeStderrSpy.mockClear();

    // A request the recorded arguments do not bind — they name no PR...
    runSubmit(
      args({ skillArgs: file('advice-nopr.txt', 'src/foo.ts') }),
      'unknown',
      { defaultComment: true },
    );
    expect(advice()).not.toContain('Re-run with `--comment`');
    expect(advice()).toContain('invoked naming it');
    expect(advice()).toContain('Nothing recorded authorises binding');
    writeStderrSpy.mockClear();

    // ...or a different PR than this submission targets.
    runSubmit(
      args({ skillArgs: file('advice-otherpr.txt', '9999') }),
      'unknown',
      { defaultComment: true },
    );
    expect(advice()).not.toContain('Re-run with `--comment`');
    expect(advice()).toContain('invoked naming it');
    writeStderrSpy.mockClear();

    // Nothing recorded at all, with the setting authorising: the refusal
    // names the missing invocation, and the advice preamble must not
    // contradict it by presupposing recorded arguments exist.
    runSubmit(args({ skillArgs: join(dir, 'advice-missing.txt') }), 'unknown', {
      defaultComment: true,
    });
    expect(advice()).toContain('no recorded invocation names a pull request');
    expect(advice()).toContain('Nothing recorded authorises binding');
    expect(advice()).not.toContain('The recorded arguments');
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

  /**
   * A plan whose Step 4 verification is provably delivered — recorded prompt,
   * brief, and a transcript that ran it verbatim and opened the brief.
   *
   * The tests below post Criticals, and a Critical nobody verified no longer
   * blocks: composeReview softens the Request changes and says so. These
   * tests are about OTHER properties of a blocking submission (count
   * derivation, body escaping, unanchorable carriage), so they carry the
   * verification that keeps the Request changes standing.
   */
  function verifiedPlan(): string {
    const diffPath = join(dir, 'verified-diff.txt');
    writeFileSync(diffPath, 'diff');
    const plan = join(dir, 'verified-plan.json');
    writeFileSync(
      plan,
      JSON.stringify({
        diffPathAbsolute: diffPath,
        srcDiffLines: 10,
        diffLines: 10,
        files: [],
        chunks: [{ id: 1, startLine: 1, endLine: 1 }],
      }),
    );
    const d = promptRecordDir(plan);
    mkdirSync(d, { recursive: true });
    const brief = briefPath(plan, 'verify');
    writeFileSync(brief, 'The verify brief.');
    const launch =
      `You are review agent \`verify\`.\n` + `read_file(file_path="${brief}")`;
    writeFileSync(join(d, 'verify.txt'), launch);
    // Transcripts newer than the plan, as in a real run.
    const old = new Date(2020, 0, 1);
    utimesSync(plan, old, old);
    const sub = join(dir, 'subagents', 'SUBV');
    mkdirSync(sub, { recursive: true });
    const base = {
      agentId: 'v1',
      agentName: 'general-purpose',
      sessionId: 'SUBV',
    };
    writeFileSync(
      join(sub, 'agent-v1.jsonl'),
      [
        {
          ...base,
          type: 'user',
          message: { role: 'user', parts: [{ text: launch }] },
        },
        {
          ...base,
          type: 'assistant',
          message: {
            role: 'model',
            parts: [
              {
                functionCall: { name: 'read_file', args: { file_path: brief } },
              },
            ],
          },
        },
        {
          ...base,
          type: 'tool_result',
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'read_file',
                  response: { output: 'ok' },
                },
              },
            ],
          },
        },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n') + '\n',
    );
    return plan;
  }

  /** Run with the transcript env the stripped-`env` compose path reads. */
  function withVerifyEnv(fn: () => void): void {
    const prevDir = process.env['QWEN_CODE_PROJECT_DIR'];
    const prevSession = process.env['QWEN_CODE_SESSION_ID'];
    process.env['QWEN_CODE_PROJECT_DIR'] = dir;
    process.env['QWEN_CODE_SESSION_ID'] = 'SUBV';
    try {
      fn();
    } finally {
      if (prevDir === undefined) delete process.env['QWEN_CODE_PROJECT_DIR'];
      else process.env['QWEN_CODE_PROJECT_DIR'] = prevDir;
      if (prevSession === undefined) delete process.env['QWEN_CODE_SESSION_ID'];
      else process.env['QWEN_CODE_SESSION_ID'] = prevSession;
    }
  }

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

  it('posts the injected CLI version in the review footer', () => {
    runSubmit(authorized({}), '0.21.2');

    expect(posted().body).toContain('via Qwen Code /review');
    expect(
      posted().body.endsWith('_— qwen3.7-max via Qwen Code /review (v0.21.2)_'),
    ).toBe(true);
  });

  it('uses the inherited startup version instead of the resolved CLI version', async () => {
    // Driven through the handler — the one production call site — with the
    // stamp set: reverting the handler to a bare `getCliVersion()` reddens
    // this, which is the exact regression the PR closes.
    const inherited = process.env['QWEN_CODE_STARTUP_VERSION'];
    process.env['QWEN_CODE_STARTUP_VERSION'] = '0.21.3';
    try {
      await submitCommand.handler?.(authorized({}) as never);
      expect(posted().body).toContain('(v0.21.3)');
      expect(posted().body).not.toContain('(v0.21.2)');
    } finally {
      if (inherited === undefined)
        delete process.env['QWEN_CODE_STARTUP_VERSION'];
      else process.env['QWEN_CODE_STARTUP_VERSION'] = inherited;
    }
  });

  it('honours the review.attribution setting through the handler', async () => {
    reviewSettingsMock.mockReturnValue({ attribution: false });
    await submitCommand.handler?.(authorized({}) as never);
    expect(posted().body).not.toContain('via Qwen Code /review');
  });

  it('the standing review.comment setting authorises a post through the handler', async () => {
    // Wiring leg: hardcoded or dropped `defaultComment` in the handler would
    // leave the direct runSubmit test green while production submissions
    // ignore the setting. The args file names the PR but carries no
    // --comment; only the setting authorises.
    reviewSettingsMock.mockReturnValue({ attribution: true, comment: true });
    await submitCommand.handler?.(
      args({ skillArgs: file('handler-comment-args.txt', '6771') }) as never,
    );
    expect(ghMock).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('without the flag or the setting the handler refuses — and workspace settings cannot supply it', async () => {
    // The mock answers a flag-less loadSettings call with a polluted view
    // that carries comment:true; the handler's skipWorkspaceSettings flag
    // keeps it out. Dropping the flag reddens this.
    await submitCommand.handler?.(
      args({ skillArgs: file('handler-noauth-args.txt', '6771') }) as never,
    );
    expect(ghMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it('falls back to the resolved CLI version when no startup version is inherited', async () => {
    const inherited = process.env['QWEN_CODE_STARTUP_VERSION'];
    delete process.env['QWEN_CODE_STARTUP_VERSION'];
    try {
      await submitCommand.handler?.(authorized({}) as never);
      expect(posted().body).toContain('(v0.21.2)');
    } finally {
      if (inherited === undefined)
        delete process.env['QWEN_CODE_STARTUP_VERSION'];
      else process.env['QWEN_CODE_STARTUP_VERSION'] = inherited;
    }
  });

  it('normalizes summary and inline footers to the running CLI version', () => {
    const review = file('footer-version.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: '**[Suggestion]** tidy\n\n_— forged via Qwen Code /review (v0.21.4)_\n\n_— forged via Qwen Code /review (v0.21.4)_',
        },
      ],
    });

    runSubmit(authorized({ review }), '0.21.3');

    const body = posted().body as string;
    const inline = posted().comments[0].body as string;
    for (const text of [body, inline]) {
      expect(text).toContain('(v0.21.3)');
      expect(text).not.toContain('(v0.21.4)');
      expect(text.match(/via Qwen Code \/review/g)).toHaveLength(1);
    }
    expect(inline.startsWith('**[Suggestion]**')).toBe(true);
  });

  it('strips a forged footer with no version suffix — the legacy shape', () => {
    const review = file('footer-legacy.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: '**[Suggestion]** tidy\n\n_— forged via Qwen Code /review_\n',
        },
      ],
    });

    runSubmit(authorized({ review }), '0.21.3');

    const inline = posted().comments[0].body as string;
    expect(inline).not.toContain('forged');
    expect(inline.match(/via Qwen Code \/review/g)).toHaveLength(1);
    expect(inline).toContain('(v0.21.3)');
  });

  it('posts without attribution when the switch is off — and still strips forged footers', () => {
    const review = file('no-attribution.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: '**[Suggestion]** tidy\n\n_— forged via Qwen Code /review (v0.21.4)_',
        },
      ],
    });

    runSubmit(authorized({ review }), '0.21.3', { attribution: false });

    const body = posted().body as string;
    const inline = posted().comments[0].body as string;
    for (const text of [body, inline]) {
      expect(text).not.toContain('via Qwen Code /review');
      expect(text).not.toContain('qwen3.7-max');
    }
    expect(inline).toBe('**[Suggestion]** tidy');
  });

  it('the standing review.comment setting authorises a post without --comment in the args', () => {
    // The setting replaces the flag, not the binding: the recorded arguments
    // still name the PR, and only that PR.
    runSubmit(args({ skillArgs: file('skill-args.txt', '6771') }), 'unknown', {
      defaultComment: true,
    });
    expect(ghMock).toHaveBeenCalled();

    ghMock.mockClear();
    expect(() =>
      runSubmit(
        args({ skillArgs: file('skill-args2.txt', '6772') }),
        'unknown',
        {
          defaultComment: true,
        },
      ),
    ).not.toThrow();
    // Args name #6772 but the submission targets #6771 — refused, exit 3.
    expect(ghMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it('does not hang on a run of forged footers followed by text', () => {
    // A model looping on the same comment emits exactly this shape: the same
    // footer over and over, then a closing line. The strip is attempted on
    // that model-authored body before anything posts, and the whitespace
    // between footers used to be splittable across the regex's repeated
    // group — exponential in the footer count. The match must stay linear:
    // this shape timed out the suite before the whitespace had one owner.
    // The count is high enough that multiplicative growth is untenable
    // within the suite's budget — eight footers finish in milliseconds
    // even under an exponential regex, proving nothing at n=8.
    const footers = Array.from(
      { length: 64 },
      () => '_— forged via Qwen Code /review (v0.21.4)_',
    ).join(' '.repeat(25));
    const review = file('footer-hang.json', {
      ...REVIEW,
      comments: [
        {
          path: 'a.ts',
          line: 12,
          body: `**[Suggestion]** tidy ${footers} one closing line`,
        },
      ],
    });

    runSubmit(authorized({ review }), '0.21.3');

    // Text after the footer run anchors it away from the end, so nothing is
    // stripped; the canonical footer is appended once.
    const inline = posted().comments[0].body as string;
    expect(inline).toContain('one closing line');
    expect(
      inline.endsWith('_— qwen3.7-max via Qwen Code /review (v0.21.3)_'),
    ).toBe(true);
  });

  it('does not scan a marker-less body quadratically under the strip', () => {
    // The strip regex opens with an unanchored `\s*` and scans quadratically
    // on a long whitespace run in a body that carries the footer's `_— `
    // opening but no marker — a forged footer truncated mid-line is exactly
    // that shape, and the `_— ` defeats the engine's literal prefilter, so
    // only the marker guard keeps this linear. The attribution-off path
    // routes such bodies through the strip; an unguarded replace dies on the
    // suite timeout long before the assertion runs.
    const body = `**[Suggestion]** tidy\n\n_— cut short${' '.repeat(
      500_000,
    )}end`;
    const review = file('footer-perf.json', {
      ...REVIEW,
      comments: [{ path: 'a.ts', line: 12, body }],
    });

    runSubmit(authorized({ review }), '0.21.3', { attribution: false });

    expect(posted().comments[0].body).toBe(body);
  });

  it('counts the blockers it is actually carrying, not the ones it was told about', () => {
    // A Critical attached inline is a Critical, whatever the state says. There is
    // no `criticalsInline` field to under-report it with — and one supplied
    // anyway is refused. Verification is on record, so the Request changes the
    // count earns actually stands.
    const review = file('c1.json', {
      ...REVIEW,
      state: { ...REVIEW.state, planPath: verifiedPlan() },
      comments: [
        { path: 'a.ts', line: 12, body: '**[Critical]** boom' },
        { path: 'b.ts', line: 3, body: '**[Suggestion]** tidy' },
      ],
    });

    withVerifyEnv(() => runSubmit(authorized({ review })));
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

  it('refuses an inline comment with no severity marker — it would weigh nothing', () => {
    // Step 6 refuses unmarked drafts, but the skill's re-compose instruction
    // expects the comment set to churn after Step 6 — and a marker lost in
    // that churn reaches exactly this boundary, the one that posts. The
    // verdict is counted from the markers, so an unmarked blocker weighs
    // zero: beside a clean state it composes an APPROVE that posts the very
    // comment it never weighed.
    const review = file('c3.json', {
      ...REVIEW,
      comments: [
        { path: 'a.ts', line: 12, body: '**[Critical]** boom' },
        { path: 'b.ts', line: 3, body: 'this blocker lost its marker' },
      ],
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(
      /comments\[1\] opens with neither/,
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
        planPath: verifiedPlan(),
        bodyCriticals: [
          'the splitter uses `/\\n/` where the input is CRLF, so every line ' +
            'keeps a trailing `\\r`',
        ],
      },
    });

    withVerifyEnv(() => runSubmit(authorized({ review })));
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
        planPath: verifiedPlan(),
        bodyCriticals: ['the inline cache is stale after a rebase'],
      },
      comments: [],
    });

    withVerifyEnv(() => runSubmit(authorized({ review })));
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

  it('refuses an empty-string body as empty, not as unmarked', () => {
    // Normalisation runs before the consistency check; a footer pasted onto
    // '' would turn the precise 'empty comment' refusal into a misleading
    // 'missing severity marker' one.
    const review = file('empty-body.json', {
      ...REVIEW,
      comments: [{ path: 'a.ts', line: 12, body: '' }],
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(/empty comment/);
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('refuses a `comments` field that is present but not an array', () => {
    // `"comments": {}` used to escape normalisation — which runs outside
    // `compose`'s try/catch — as a bare TypeError instead of the structured
    // refusal the re-compose loop parses.
    const review = file('comments-not-array.json', {
      ...REVIEW,
      comments: {},
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(
      /`comments` is not an array/,
    );
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('refuses a `comments` entry that is not an object', () => {
    // `"comments": [null]` cleared the arrayness check and threw a bare
    // TypeError in the normalisation `.map` — outside `compose`'s try/catch
    // — instead of the structured refusal the re-compose loop parses.
    const review = file('comments-null-entry.json', {
      ...REVIEW,
      comments: [null],
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(
      /entries must each be an object/,
    );
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

// The ledger's whole premise is that the marker rides the body GITHUB receives.
// It was once appended one layer above this path and reached only a file on
// disk, so the assertions that matter are the ones made on the posted payload —
// compose-review.test.ts owns the composition, this owns the wire.
describe('the ledger marker on the body that reaches GitHub', () => {
  const authorized = (over: Record<string, unknown> = {}) =>
    args({ userAuthorized: true, ...over });
  const posted = () => JSON.parse(ghMock.mock.calls[0][0] as string);

  it('carries the findings of this round, numbered off the recovered one', () => {
    const planPath = file('plan.json', { prNumber: 6771 });
    file('qwen-review-pr-6771-prev-ledger.json', {
      v: 1,
      round: 2,
      findings: [],
    });
    const review = file('ledger.json', {
      commit_id: 'abc',
      comments: [
        { path: 'src/a.ts', line: 12, body: '**[Critical]** double free' },
      ],
      state: { modelId: 'm', planPath },
    });

    runSubmit(authorized({ review }));

    const ledger = parseLedger(posted().body);
    expect(ledger?.round).toBe(3);
    expect(ledger?.findings).toEqual([
      {
        id: 'R3-1',
        sev: 'C',
        file: 'src/a.ts',
        line: 12,
        title: 'double free',
      },
    ]);
  });

  it('takes its contents from the comments posted, not from `state`', () => {
    // `draftedComments` is stripped off `state` here for the same reason `env`
    // and `prBodyFetcher` are: what the review carries is not a claim the
    // caller's JSON gets to make about what it reviewed.
    const planPath = file('plan2.json', { prNumber: 6771 });
    const review = file('forged-ledger.json', {
      commit_id: 'abc',
      comments: [
        { path: 'real.ts', line: 1, body: '**[Suggestion]** the real one' },
      ],
      state: {
        modelId: 'm',
        planPath,
        draftedComments: [
          { path: 'forged.ts', line: 9, body: '**[Critical]** never drafted' },
        ],
      },
    });

    runSubmit(authorized({ review }));

    const ledger = parseLedger(posted().body);
    expect(ledger?.findings).toEqual([
      { id: 'R1-1', sev: 'S', file: 'real.ts', line: 1, title: 'the real one' },
    ]);
  });
});

// Six findings from the repo's own `/review` bot on this pull request. These are its.
describe('what the reviewer caught in this change', () => {
  const authorized = (over: Record<string, unknown> = {}) =>
    args({ userAuthorized: true, ...over });

  it('refuses `state: null`, which slipped past a `=== undefined` guard', () => {
    // `null` is not `undefined`, so the structural check passed it; `compose`'s
    // `?? {}` then collapsed it to an empty state and posted a review whose footer
    // named no model and whose caps came from nowhere.
    const review = file('null-state.json', {
      commit_id: 'abc',
      comments: [],
      state: null,
    });

    expect(() => runSubmit(authorized({ review }))).toThrow(
      /`state` is missing/,
    );
    expect(ghMock).not.toHaveBeenCalled();
  });

  it('shows `cappedBy` in the dry run, not only after the write', () => {
    // The point of `--dry-run` is to see what would be posted. Reporting
    // `"event": "COMMENT"` with no reason leaves the reader to guess why the Approve
    // went away.
    const review = file('capped.json', {
      commit_id: 'abc',
      comments: [],
      state: { modelId: 'm', uncoverableChunks: ['chunk 5 (src/big.min.js)'] },
    });

    runSubmit(authorized({ review, dryRun: true }));
    const out = JSON.parse(
      (writeStdoutSpy.mock.calls.at(-1)?.[0] as string) ?? '{}',
    );
    expect(out.event).toBe('COMMENT');
    expect(out.cappedBy).toContain('uncoverable-chunk');
  });

  it('strips a caller-supplied prBodyFetcher — a state JSON cannot suppress the Chinese fold', () => {
    // submit is the only boundary that posts, and its strip is the one with no
    // test. Deleting `prBodyFetcher: _droppedFetcher` from the destructure
    // leaves every other test green. Without the strip, `null` is invoked as
    // a function, throws, and the fail-safe catch drops the fold — the exact
    // regression this PR closes, through the door that publishes.
    ghViewMock.mockReturnValue('{"body":"这个 PR 修复了双语渲染。"}');
    const planPath = file('plan.json', {
      chunks: [],
      ownerRepo: 'QwenLM/qwen-code',
      prNumber: '6771',
    });
    runSubmit(
      authorized({
        review: file('fetcher-strip.json', {
          commit_id: 'abc123',
          comments: [],
          state: { modelId: 'm', planPath, prBodyFetcher: null },
        }),
      }),
    );
    const body = (
      JSON.parse(ghMock.mock.calls[0][0] as string) as { body: string }
    ).body;
    expect(body).toContain('中文说明');
  });
});

// The submit receipt is the WRITE half of cleanup's bypass-audit contract:
// cleanup reads the review ids it records to tell a sanctioned review from a
// bypass. Every other test here leaves ghMock returning '' (so JSON.parse of
// the response throws and the receipt block hits its catch), which means the
// happy path where a receipt is actually written was never exercised. These
// run the command from inside the fixture dir so the relative .qwen/tmp
// receipt lands there.
describe('submit receipt (producer half of the audit contract)', () => {
  const receiptPath = () =>
    join(dir, '.qwen', 'tmp', 'qwen-review-pr-6771-submit-receipt.json');

  const authorizedPost = (over: Record<string, unknown> = {}) =>
    args({ userAuthorized: true, ...over });

  let savedCwd: string;
  beforeEach(() => {
    savedCwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => process.chdir(savedCwd));

  it('writes the posted review id, event and a timestamp', () => {
    ghMock.mockImplementationOnce(() => JSON.stringify({ id: 42 }));
    runSubmit(authorizedPost());
    const receipt = JSON.parse(readFileSync(receiptPath(), 'utf8'));
    expect(receipt.reviewIds).toEqual([42]);
    expect(receipt.event).toBe('COMMENT');
    expect(typeof receipt.postedAt).toBe('string');
  });

  it('accumulates ids across two submits in the same window (drift restart)', () => {
    ghMock.mockImplementationOnce(() => JSON.stringify({ id: 42 }));
    runSubmit(authorizedPost());
    ghMock.mockImplementationOnce(() => JSON.stringify({ id: 43 }));
    runSubmit(authorizedPost());
    const receipt = JSON.parse(readFileSync(receiptPath(), 'utf8'));
    expect(receipt.reviewIds).toEqual([42, 43]);
  });

  it('migrates a legacy single-id receipt on the next submit', () => {
    mkdirSync(join(dir, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      receiptPath(),
      JSON.stringify({ reviewId: 7, event: 'COMMENT', postedAt: 'x' }),
    );
    ghMock.mockImplementationOnce(() => JSON.stringify({ id: 8 }));
    runSubmit(authorizedPost());
    const receipt = JSON.parse(readFileSync(receiptPath(), 'utf8'));
    expect(receipt.reviewIds).toEqual([7, 8]);
  });

  it('writes atomically, leaving no .tmp sibling behind', () => {
    ghMock.mockImplementationOnce(() => JSON.stringify({ id: 42 }));
    runSubmit(authorizedPost());
    expect(readFileSync(receiptPath(), 'utf8')).toContain('"reviewIds"');
    const tmpDir = join(dir, '.qwen', 'tmp');
    const leftovers = readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

// The link back to what was just written. GitHub's Create Review response
// carries `html_url` — the deep link to the review — and submit relays it in
// both channels, because a summary without it leaves the user to reassemble
// the PR address by hand. Best-effort like the receipt: a response without it
// (or an unparseable one) must never fail a review that DID post, and never
// invents a link either.
describe('the posted-review link', () => {
  const authorizedPost = (over: Record<string, unknown> = {}) =>
    args({ userAuthorized: true, ...over });
  const stdoutJson = () =>
    JSON.parse(writeStdoutSpy.mock.calls.at(-1)![0] as string);

  let savedCwd: string;
  beforeEach(() => {
    savedCwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => process.chdir(savedCwd));

  it('relays html_url in the stdout JSON and the Posted line', () => {
    const url =
      'https://github.com/QwenLM/qwen-code/pull/6771#pullrequestreview-42';
    ghMock.mockImplementationOnce(() =>
      JSON.stringify({ id: 42, html_url: url }),
    );
    runSubmit(authorizedPost());
    expect(stdoutJson()).toMatchObject({ posted: true, url });
    const postedLine = writeStderrSpy.mock.calls
      .map((c) => c[0] as string)
      .find((l) => l.startsWith('Posted '));
    expect(postedLine).toContain(url);
  });

  it('omits url when the response carries none — a link is relayed, never built', () => {
    ghMock.mockImplementationOnce(() => JSON.stringify({ id: 42 }));
    runSubmit(authorizedPost());
    expect(stdoutJson().posted).toBe(true);
    expect('url' in stdoutJson()).toBe(false);
  });

  it('still reports posted:true when the response is unparseable', () => {
    // ghMock's default return is '' — JSON.parse throws, and both the receipt
    // and the link ride the same best-effort read of a post that succeeded.
    runSubmit(authorizedPost());
    expect(stdoutJson().posted).toBe(true);
    expect('url' in stdoutJson()).toBe(false);
  });
});
