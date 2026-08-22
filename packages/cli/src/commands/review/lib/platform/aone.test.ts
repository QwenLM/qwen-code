/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  a1JsonMock,
  a1JsonOnceMock,
  a1OnceMock,
  ensureAuthMock,
  gitMock,
  gitRawMock,
} = vi.hoisted(() => ({
  a1JsonMock: vi.fn(),
  a1JsonOnceMock: vi.fn(),
  a1OnceMock: vi.fn(),
  ensureAuthMock: vi.fn(),
  gitMock: vi.fn(),
  gitRawMock: vi.fn(),
}));

vi.mock('./aone-client.js', () => ({
  a1Json: a1JsonMock,
  a1JsonOnce: a1JsonOnceMock,
  a1Once: a1OnceMock,
  a1: vi.fn(),
  ensureAoneAuthenticated: ensureAuthMock,
}));

vi.mock('../git.js', () => ({
  git: gitMock,
  gitRaw: gitRawMock,
}));

import {
  AonePartialPostError,
  aoneReader,
  mrPresubmitFacts,
  parseRemoteUrl,
  submitAoneReview,
} from './aone.js';
import { PINNED_DIFF_CONFIG, PINNED_DIFF_FLAGS } from '../diff-flags.js';

describe('parseRemoteUrl hardening', () => {
  it('discards an explicit port instead of folding it into the path', () => {
    expect(
      parseRemoteUrl('https://gitlab.alibaba-inc.com:8443/solo'),
    ).toBeNull();
    expect(
      parseRemoteUrl('https://gitlab.alibaba-inc.com:8443/g/p.git'),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'g',
      repo: 'p',
      groupPath: 'g/p',
    });
  });

  it('strips a query string / fragment (credential-bearing channel)', () => {
    expect(
      parseRemoteUrl('https://h.example/g/p?private_token=SECRET'),
    ).toEqual({ host: 'h.example', owner: 'g', repo: 'p', groupPath: 'g/p' });
    expect(parseRemoteUrl('https://h.example/g/p.git#frag')).toEqual({
      host: 'h.example',
      owner: 'g',
      repo: 'p',
      groupPath: 'g/p',
    });
  });

  it('strips TWO OR MORE trailing slashes after .git', () => {
    expect(parseRemoteUrl('https://h.example/g/p.git//')).toEqual({
      host: 'h.example',
      owner: 'g',
      repo: 'p',
      groupPath: 'g/p',
    });
  });

  it('consumes multi-@ userinfo whole (no cleartext residue)', () => {
    // Token-bearing CI origins arrive with several `@`; a single-chunk
    // match left the residue to fold into the parsed host or echo
    // unredacted into the refusal message.
    expect(
      parseRemoteUrl(
        'https://ci-user:SECRET1@SECRET2@code.alibaba-inc.com/g/p',
      ),
    ).toEqual({
      host: 'code.alibaba-inc.com',
      owner: 'g',
      repo: 'p',
      groupPath: 'g/p',
    });
    expect(
      parseRemoteUrl('https://ci-user:S1@S2@S3@code.alibaba-inc.com/g/p'),
    ).toEqual({
      host: 'code.alibaba-inc.com',
      owner: 'g',
      repo: 'p',
      groupPath: 'g/p',
    });
  });

  it('agrees with GIT on a `:`/`/`-bearing scp userinfo (fails closed)', () => {
    // GIT_TRACE-probed: git's scp grammar ends the hostinfo at the FIRST
    // `:`, so `git ls-remote 'ci-user:/tok@host:g/p.git'` connects to host
    // `ci-user` — the parser must agree, not parse the token's tail as the
    // identity. The `@` residue lands in the path and fails closed: the
    // earlier last-`@` consumption let fetchDiff's same-repo guard pass
    // while git fetched from a DIFFERENT server than the identity named.
    expect(
      parseRemoteUrl('ci-user:/token-with-slash@code.alibaba-inc.com:g/p.git'),
    ).toBeNull();
    // The plain token-bearing scp shape too: git reads host `oauth2`, so
    // the residue fails closed here as well.
    expect(
      parseRemoteUrl('oauth2:SECRET@code.alibaba-inc.com:g/p.git'),
    ).toBeNull();
    // The legitimate shape is untouched: `user@` with no colon/slash in
    // the user part.
    expect(parseRemoteUrl('ci-user@code.alibaba-inc.com:g/p.git')).toEqual({
      host: 'code.alibaba-inc.com',
      owner: 'g',
      repo: 'p',
      groupPath: 'g/p',
    });
  });

  it('fails closed on a single-segment multi-@ origin without leaking', () => {
    // The refusal message must not carry the residue — resolveRepo routes
    // the raw URL through redactUrl, which consumes the same greedy shape.
    expect(
      parseRemoteUrl(
        'https://ci-user:SECRET1@SECRET2@code.alibaba-inc.com/solo',
      ),
    ).toBeNull();
  });

  it('fails closed when a `/`-bearing secret leaves the @ in path territory', () => {
    // URL userinfo cannot contain `/` — the `@` belongs to the path, and
    // parsing it as host/owner would fabricate coordinates. The refusal
    // message side is covered by the redaction tests below.
    expect(
      parseRemoteUrl('https://user:sec/ret@code.example.com/g/p'),
    ).toBeNull();
    expect(
      parseRemoteUrl('https://user:S1/S2@host.example:8443/project'),
    ).toBeNull();
    expect(
      parseRemoteUrl('https://gitlab.alibaba-inc.com/x//y@g/p'),
    ).toBeNull();
  });

  it('keeps a query-borne @ from fabricating coordinates', () => {
    // `?private_token=ab@cd:8443/x/y` — the strip removes the query before
    // anything can parse `cd` as a host; the real path parses.
    expect(
      parseRemoteUrl(
        'https://gitlab.alibaba-inc.com/group/proj?private_token=ab@cd:8443/x/y',
      ),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'group',
      repo: 'proj',
      groupPath: 'group/proj',
    });
    // The scp form too — an insteadOf rewrite can turn a token-bearing
    // https origin into scp shape; the userinfo strip must not cross the
    // `?` and consume the path (round-10 fabrication witness).
    expect(
      parseRemoteUrl(
        'git@gitlab.alibaba-inc.com:group/proj?private_token=ab@cd:8443/x/y',
      ),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'group',
      repo: 'proj',
      groupPath: 'group/proj',
    });
    // A junk path segment carrying `@` fails closed instead of folding
    // into a host swap.
    expect(
      parseRemoteUrl(
        'https://gitlab.alibaba-inc.com/junk@gitlab.alibaba-inc.com:g/p',
      ),
    ).toBeNull();
  });
});

describe('aoneReader.resolveRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("quotes git's real error line, not the execFileSync preamble", () => {
    gitMock.mockImplementation(() => {
      throw new Error(
        'Command failed: git remote get-url origin\n' +
          "error: No such remote 'origin'\n",
      );
    });
    expect(() => aoneReader.resolveRepo()).toThrow(
      /no `origin` remote \(error: No such remote 'origin'\)/,
    );
  });

  it('redacts a query-string token even on the PARSE-FAILURE path', () => {
    // The success path strips `[?#].*$` so credentials cannot become the
    // repo coordinate; the refusal message must not undo that defense —
    // `?private_token=…` origins carry no `@` for the userinfo redaction.
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'remote')
        return 'https://code.alibaba-inc.com/solo?private_token=SECRET123';
      return '';
    });
    let message = '';
    try {
      aoneReader.resolveRepo();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('cannot parse the origin remote');
    expect(message).toContain('solo');
    expect(message).not.toContain('SECRET123');
    expect(message).not.toContain('private_token');
  });

  it('an embedded NEWLINE cannot smuggle the query token past the strip', () => {
    // git stores and re-emits newline-bearing remote URLs, and a plain `.`
    // in the `[?#]`-strip stops at the first `\n` — the token would survive
    // cleaning. `[\s\S]*` eats it: the URL then PARSES (the strip removed
    // the whole query), so there is no refusal message to leak through.
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'remote')
        return 'https://gitlab.alibaba-inc.com/g/p?private_token=SECRET\nx';
      return '';
    });
    expect(aoneReader.resolveRepo()).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'g',
      repo: 'p',
      groupPath: 'g/p',
    });
  });

  it('redacts a newline-smuggled token on the refusal path too', () => {
    // Same smuggle, but the origin is unparseable (single segment) — the
    // refusal message must not echo the token the strip removed.
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'remote')
        return 'https://code.alibaba-inc.com/solo?private_token=SECRET\nx';
      return '';
    });
    let message = '';
    try {
      aoneReader.resolveRepo();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('cannot parse the origin remote');
    expect(message).toContain('solo');
    expect(message).not.toContain('SECRET');
  });

  it('parses a userinfo that itself contains ? or # (strip order)', () => {
    // A query-first strip truncates `user:pa?ss@` mid-credential — no `@`
    // survives, the origin becomes unparseable, and the prefix leaks into
    // the refusal. Userinfo goes FIRST, so this origin parses.
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'remote')
        return 'https://user:pa?ss@gitlab.alibaba-inc.com/g/p.git';
      return '';
    });
    expect(aoneReader.resolveRepo()).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'g',
      repo: 'p',
      groupPath: 'g/p',
    });
  });

  it('never leaks a ?-bearing userinfo prefix through a refusal', () => {
    // Same shape, unparseable target (single segment): the refusal message
    // must not carry the username or secret prefix.
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'remote')
        return 'https://user:pa?ss@code.alibaba-inc.com/solo.git';
      return '';
    });
    let message = '';
    try {
      aoneReader.resolveRepo();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('cannot parse the origin remote');
    expect(message).not.toContain('user');
    expect(message).not.toContain('pa?ss');
  });

  it('redacts a `/`-bearing scp userinfo on the refusal path too', () => {
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'remote')
        return 'ci-user:/token-with-slash@code.alibaba-inc.com:solo';
      return '';
    });
    let message = '';
    try {
      aoneReader.resolveRepo();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('cannot parse the origin remote');
    expect(message).not.toContain('token-with-slash');
    expect(message).not.toContain('ci-user');
  });

  it('refuses an origin OUTSIDE the Aone host family (round-12 witness)', () => {
    // Detection can be steered onto this reader by an explicit `--host`
    // while the cwd clone is a GitHub mirror (the common dual-remote
    // Aone-migration setup). Without the guard the discovery branch emits
    // {platform:'aone', host:'github.com'} and queries a1 with the
    // mirror's coordinates — the same predicate fetchDiff's origin guard
    // applies.
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'remote')
        return 'git@github.com:MirrorOwner/mirror-repo.git';
      return '';
    });
    expect(() => aoneReader.resolveRepo()).toThrow(
      /not the Aone host family — run from inside an Aone clone/,
    );
  });

  it('redacts the shapes the per-regex redactions missed (round-9 class)', () => {
    // (1) URL-form userinfo whose secret contains `/` — no regex shape
    // matches, the split at the LAST `@` redacts by construction;
    // (2) scp-form userinfo carrying a NEWLINE; (3) a residue with no
    // `host:` shape at all. None may reach the message.
    for (const [origin, secret, user] of [
      ['https://user:sec/ret@code.example.com/solo', 'sec', 'user'],
      ['ci-user:sec\nret@code.alibaba-inc.com:solo', 'sec', 'ci-user'],
      ['user:token@weirdhost', 'token', 'user'],
    ]) {
      gitMock.mockImplementation((...args: string[]) => {
        if (args[0] === 'remote') return origin;
        return '';
      });
      let message = '';
      try {
        aoneReader.resolveRepo();
        throw new Error(`expected ${JSON.stringify(origin)} to refuse`);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('cannot parse the origin remote');
      expect(message).not.toContain(secret);
      expect(message).not.toContain(user);
    }
  });

  it('fails the display CLOSED when the last @ sits in a query/fragment value', () => {
    // An `@` inside a query or fragment VALUE is the credential's own
    // character — the split at the last `@` has no safe tail to keep
    // there, so the message becomes a constant. Round-10 witnesses: the
    // URL, scp, and fragment spellings all leaked the token tail before.
    for (const origin of [
      'https://code.alibaba-inc.com/solo?private_token=prefix@SECRET-TOKEN-TAIL',
      'ci-user:tok@code.alibaba-inc.com:solo?token=a@SECRET-SCP',
      'https://code.alibaba-inc.com/solo#frag@SECRET-FRAG',
    ]) {
      gitMock.mockImplementation((...args: string[]) => {
        if (args[0] === 'remote') return origin;
        return '';
      });
      let message = '';
      try {
        aoneReader.resolveRepo();
        throw new Error(`expected ${JSON.stringify(origin)} to refuse`);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('cannot parse the origin remote');
      expect(message).not.toContain('SECRET');
      expect(message).not.toContain('prefix');
    }
  });
});

describe('aoneReader.getCommentBody', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the `note` field of the matching comment', () => {
    a1JsonMock.mockReturnValue([
      { id: 1, note: 'first' },
      { id: 2, note: 'second' },
    ]);
    expect(aoneReader.getCommentBody('inline', 2, 'g/p', 5)).toBe('second');
  });

  it('throws on a missing id — not an empty string', () => {
    a1JsonMock.mockReturnValue([{ id: 1, note: 'first' }]);
    expect(() => aoneReader.getCommentBody('inline', 99, 'g/p', 5)).toThrow(
      /comment 99 not found in MR 5/,
    );
  });

  it('requires --pr for every kind (Aone addresses comments per-MR)', () => {
    expect(() =>
      aoneReader.getCommentBody('inline', 1, 'g/p', undefined),
    ).toThrow(/pass `--pr <mr id>`/);
  });
});

describe('aoneReader.getPrMeta — the live-head read behind meta.headSha', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps mr view onto PrMeta (head sha, web url)', () => {
    a1JsonMock.mockReturnValue({
      mergeRequest: {
        sourceBranch: 'sha123',
        detailUrl: 'https://code.alibaba-inc.com/g/p/codereview/7',
      },
    });
    expect(aoneReader.getPrMeta(7, 'g/p')).toEqual({
      number: 7,
      headSha: 'sha123',
      webUrl: 'https://code.alibaba-inc.com/g/p/codereview/7',
    });
  });

  it('trims a padded sourceBranch — one normalization for every head read', () => {
    // Step 7's reviewed-SHA fallback reads meta.headSha while presubmit's
    // drift check compares the TRIMMED live head; the pre-fix untrimmed
    // copy made a padded server value read as drift ("PR head advanced
    // during review") on an MR that never moved — and as a submit-time
    // refusal at the pre-write gate (#9629 review).
    a1JsonMock.mockReturnValue({
      mergeRequest: { sourceBranch: '  sha123\n', detailUrl: '' },
    });
    expect(aoneReader.getPrMeta(7, 'g/p').headSha).toBe('sha123');
  });
});

describe('aoneReader.getFetchMeta / fetchHeadRefSpec', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps mr view onto FetchMeta (head sha, base branch, never cross-repo)', () => {
    a1JsonMock.mockReturnValue({
      mergeRequest: {
        sourceBranch: 'sha123',
        targetBranch: 'master',
        description: 'desc',
        detailUrl: 'https://code.alibaba-inc.com/g/p/codereview/7',
      },
    });
    const meta = aoneReader.getFetchMeta(7, 'g/p');
    expect(meta.headRefOid).toBe('sha123');
    expect(meta.baseRefName).toBe('master');
    expect(meta.isCrossRepository).toBe(false);
    expect(meta.body).toBe('desc');
    // Aone does not advertise stats; fetch-pr computes them locally.
    expect(meta.additions).toBeUndefined();
    expect(meta.deletions).toBeUndefined();
    expect(meta.changedFiles).toBeUndefined();
  });

  it('trims a padded sourceBranch into headRefOid — one normalization for the head', () => {
    // fetch-pr compares headRefOid against the fetched SHA; the pre-fix
    // untrimmed copy read a padded server value as a different head
    // (#9629 review).
    a1JsonMock.mockReturnValue({
      mergeRequest: { sourceBranch: '  sha123\n', targetBranch: 'master' },
    });
    expect(aoneReader.getFetchMeta(7, 'g/p').headRefOid).toBe('sha123');
  });

  it('uses the merge-requests refspec with the global id', () => {
    expect(aoneReader.fetchHeadRefSpec(29295886)).toBe(
      'refs/merge-requests/29295886/head',
    );
  });

  it('throws when mr view returns no mergeRequest', () => {
    a1JsonMock.mockReturnValue({});
    expect(() => aoneReader.getFetchMeta(7, 'g/p')).toThrow(
      /no mergeRequest for #7/,
    );
  });
});

describe('aoneReader.getReviewContext / getCurrentUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** mr view answer first, comment list second — call order is fixed. */
  function mockContext(
    comments: Array<Record<string, unknown>>,
    view?: Record<string, unknown>,
  ): void {
    a1JsonMock
      .mockReturnValueOnce({
        mergeRequest: {
          sourceBranch: 'sha123',
          targetBranch: 'master',
          title: 'a CR',
          description: 'the description',
          author: { username: 'someone' },
          state: 'opened',
          detailUrl: 'https://code.alibaba-inc.com/g/p/codereview/7',
          ...view,
        },
      })
      .mockReturnValueOnce(comments);
  }

  it('splits one flat comment list into the inline and thread channels', () => {
    mockContext([
      { id: 1, note: 'inline finding', path: 'src/a.ts', line: 12 },
      { id: 2, note: 'global note' },
      {
        id: 3,
        note: 'reply',
        path: 'src/a.ts',
        line: 12,
        parentNoteId: 1,
      },
    ]);
    const ctx = aoneReader.getReviewContext(7, 'g/p');
    const inline = ctx.comments.filter((c) => c.path !== undefined);
    const thread = ctx.comments.filter((c) => c.path === undefined);
    expect(inline.map((c) => c.id)).toEqual([1, 3]);
    expect(inline[0]).toMatchObject({
      id: 1,
      body: 'inline finding',
      path: 'src/a.ts',
      line: 12,
    });
    // parentNoteId is the thread link.
    expect(inline[1].parentId).toBe(1);
    expect(thread.map((c) => c.id)).toEqual([2]);
    // No review object exists on Aone.
    expect(ctx.verdicts).toEqual([]);
  });

  it('maps the MR view onto the metadata (stats stay absent)', () => {
    mockContext([]);
    const ctx = aoneReader.getReviewContext(7, 'g/p');
    expect(ctx.title).toBe('a CR');
    expect(ctx.body).toBe('the description');
    expect(ctx.authorLogin).toBe('someone');
    expect(ctx.state).toBe('opened');
    expect(ctx.baseRefName).toBe('master');
    // Under AGit-Flow sourceBranch IS the head SHA — both fields read it.
    expect(ctx.headRefName).toBe('sha123');
    expect(ctx.headRefOid).toBe('sha123');
    expect(ctx.additions).toBeUndefined();
    expect(ctx.deletions).toBeUndefined();
    expect(ctx.changedFiles).toBeUndefined();
  });

  it('shapes the path-LESS comments as ledger carriers, chronologically', () => {
    mockContext([
      { id: 1, note: 'inline', path: 'src/a.ts', line: 3 },
      {
        id: 2,
        note: 'round-1 summary <!-- qwen-review-ledger {"v":1,"round":1,"findings":[]} -->',
        createdAt: '2026-08-19T10:00:00Z',
      },
      { id: 3, note: 'chatter', created_at: '2026-08-20T10:00:00Z' },
    ]);
    const ctx = aoneReader.getReviewContext(7, 'g/p');
    expect(ctx.ledgerCarriers.map((c) => c.id)).toEqual([2, 3]);
    expect(ctx.ledgerCarriers[0]).toMatchObject({
      author: '',
      body: expect.stringContaining('qwen-review-ledger'),
      state: 'COMMENTED',
      submittedAt: '2026-08-19T10:00:00Z',
    });
    // created_at is the tolerated timestamp spelling too.
    expect(ctx.ledgerCarriers[1].submittedAt).toBe('2026-08-20T10:00:00Z');
    // The inline comment is NOT a carrier.
    expect(ctx.ledgerCarriers.some((c) => c.id === 1)).toBe(false);
  });

  it('skips draft comments — an unposted note is neither discussion nor a round', () => {
    mockContext([
      { id: 1, note: 'posted' },
      { id: 2, note: 'draft', isDraft: true },
    ]);
    const ctx = aoneReader.getReviewContext(7, 'g/p');
    expect(ctx.comments.map((c) => c.id)).toEqual([1]);
  });

  it('reads the author across the shipped shapes, account first', () => {
    mockContext([
      { id: 1, note: 'a', author: { account: 'acc-1', name: '显示名' } },
      { id: 2, note: 'b', author: { username: 'user-2' } },
      { id: 3, note: 'c', author: 'string-author' },
      { id: 4, note: 'd' },
      // BOTH keys at once: the ordering is load-bearing (`account` is the
      // spelling `a1 auth whoami` answers in — the identity the own/foreign
      // split compares against). Without this fixture, swapping the first
      // two keys of aoneCommentAuthor leaves the suite green.
      { id: 5, note: 'e', author: { account: 'acc-2', username: 'user-9' } },
    ]);
    const ctx = aoneReader.getReviewContext(7, 'g/p');
    expect(ctx.comments.map((c) => c.author)).toEqual([
      'acc-1',
      'user-2',
      'string-author',
      '',
      'acc-2',
    ]);
  });

  it('fetches the comment list sorted ascending (chronological parity)', () => {
    mockContext([]);
    aoneReader.getReviewContext(7, 'g/p');
    expect(a1JsonMock).toHaveBeenNthCalledWith(
      2,
      'repo',
      'mr',
      'comment',
      'list',
      '--mr',
      '7',
      '--repo',
      'g/p',
      '--sort',
      'asc',
    );
  });

  it('throws when mr view returns no mergeRequest', () => {
    a1JsonMock.mockReturnValueOnce({});
    expect(() => aoneReader.getReviewContext(7, 'g/p')).toThrow(
      /no mergeRequest for #7/,
    );
  });

  it('getCurrentUser answers the whoami account (empty on absence)', () => {
    a1JsonMock.mockReturnValueOnce({ account: 'acc-1' });
    expect(aoneReader.getCurrentUser()).toBe('acc-1');
    a1JsonMock.mockReturnValueOnce({});
    expect(aoneReader.getCurrentUser()).toBe('');
  });

  it('getCurrentUser degrades to empty on the anomalous whoami shapes', () => {
    // The seam contract: '' on the empty-output shapes, never an untagged
    // throw or a non-string leak. A literal `null` payload PARSES; an
    // exit-0 empty stdout throws inside a1Json before any guard runs; a
    // non-string account reaching recoverLedger's `.toLowerCase()` would
    // throw into the conservative recovery strip and silently lose the
    // ledger anchor.
    a1JsonMock.mockReturnValueOnce(null);
    expect(aoneReader.getCurrentUser()).toBe('');
    a1JsonMock.mockReturnValueOnce({ account: 123 });
    expect(aoneReader.getCurrentUser()).toBe('');
    a1JsonMock.mockImplementationOnce(() => {
      throw new SyntaxError('Unexpected end of JSON input');
    });
    expect(aoneReader.getCurrentUser()).toBe('');
  });

  it('trims a padded sourceBranch into the context head — one normalization', () => {
    // Mirror of the getFetchMeta pin: the context file's HEAD SHA must not
    // diverge from the trimmed reads every other subcommand reports — a
    // consumer comparing the two would reproduce the phantom-drift bug the
    // aoneHeadSha consolidation closed (#9629 review).
    mockContext([], { sourceBranch: '  sha123\n' });
    const ctx = aoneReader.getReviewContext(7, 'g/p');
    expect(ctx.headRefOid).toBe('sha123');
    expect(ctx.headRefName).toBe('sha123');
  });

  it('tags the exit-0 a1.error/v1 envelope from the comment listing', () => {
    // a1 can answer `comment list` with a well-formed error OBJECT at
    // exit 0 (a backend auth failure or a client timeout — measured by
    // cleanup's a1CommentList, same payload). The guard surfaces the
    // envelope's actionable message instead of an untagged TypeError.
    a1JsonMock
      .mockReturnValueOnce({
        mergeRequest: { sourceBranch: 'sha123', targetBranch: 'master' },
      })
      .mockReturnValueOnce({
        schemaVersion: 'a1.error/v1',
        code: 'COMMAND_FAILED',
        message: 'listing MR comments: backend auth failure — token expired',
      });
    expect(() => aoneReader.getReviewContext(7, 'g/p')).toThrow(
      'a1 mr comment list returned an unexpected shape: listing MR comments: backend auth failure — token expired',
    );
  });

  it('tags the unexpected-shape refusal when the envelope has no message', () => {
    a1JsonMock
      .mockReturnValueOnce({
        mergeRequest: { sourceBranch: 'sha123', targetBranch: 'master' },
      })
      .mockReturnValueOnce({ schemaVersion: 'a1.error/v1' });
    expect(() => aoneReader.getReviewContext(7, 'g/p')).toThrow(
      'a1 mr comment list returned an unexpected shape',
    );
  });
});

describe("mrPresubmitFacts (the presubmit gate's Aone seam)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the author account and the live head from ONE mr view fetch', () => {
    a1JsonMock.mockReturnValue({
      mergeRequest: {
        sourceBranch: 'sha123',
        author: { username: 'wenshao' },
      },
    });
    expect(mrPresubmitFacts(29295886, 'maxcompute/odps_src')).toEqual({
      author: 'wenshao',
      headSha: 'sha123',
    });
    expect(a1JsonMock).toHaveBeenCalledTimes(1);
    expect(a1JsonMock).toHaveBeenCalledWith(
      'repo',
      'mr',
      'view',
      '29295886',
      '--repo',
      'maxcompute/odps_src',
    );
  });

  it('fails soft (empty author) when the author was deleted or is absent', () => {
    // The GitHub path's `author: null` parity: a readable MR with no author
    // must yield isSelfPr false, not a throw that kills the presubmit.
    a1JsonMock.mockReturnValue({
      mergeRequest: { sourceBranch: 'sha123' },
    });
    expect(mrPresubmitFacts(7, 'g/p')).toEqual({
      author: '',
      headSha: 'sha123',
    });
    a1JsonMock.mockReturnValue({
      mergeRequest: { sourceBranch: 'sha123', author: {} },
    });
    expect(mrPresubmitFacts(7, 'g/p').author).toBe('');
  });

  it('type-guards a non-string username instead of letting it crash presubmit', () => {
    // `username` is server-controlled; a non-string surviving `?? ''` would
    // reach `.toLowerCase()` outside presubmit's fetch try/catch and die
    // with no report. Parity with the gate's account read (`typeof === 'string'`).
    a1JsonMock.mockReturnValue({
      mergeRequest: { sourceBranch: 'sha123', author: { username: 42 } },
    });
    expect(mrPresubmitFacts(7, 'g/p').author).toBe('');
    a1JsonMock.mockReturnValue({
      mergeRequest: { sourceBranch: 'sha123', author: { username: null } },
    });
    expect(mrPresubmitFacts(7, 'g/p').author).toBe('');
  });

  it('trims a padded sourceBranch and username, tolerating their absence', () => {
    // A padded head must not manufacture drift against a clean commit sha,
    // and a padded username must not miss the self-PR comparison against a
    // clean whoami account (fail-open on exactly the protection this exists
    // for). Absent values report '' — drift stays off, isSelfPr false.
    a1JsonMock.mockReturnValue({
      mergeRequest: {
        sourceBranch: '  sha123\n',
        author: { username: '  wenshao\n' },
      },
    });
    expect(mrPresubmitFacts(7, 'g/p')).toEqual({
      author: 'wenshao',
      headSha: 'sha123',
    });
    a1JsonMock.mockReturnValue({ mergeRequest: { author: {} } });
    expect(mrPresubmitFacts(7, 'g/p').headSha).toBe('');
  });

  it('rejects a malformed owner/repo before any a1 call', () => {
    expect(() => mrPresubmitFacts(7, 'bogus')).toThrow(TypeError);
    expect(a1JsonMock).not.toHaveBeenCalled();
  });

  it('propagates a missing mergeRequest as a throw (fail-closed upstream)', () => {
    // presubmit catches this as metaUnavailable and caps the verdict; the
    // seam itself must not paper over it with empty facts.
    a1JsonMock.mockReturnValue({});
    expect(() => mrPresubmitFacts(7, 'g/p')).toThrow(/no mergeRequest for #7/);
  });
});

describe('aoneReader.fetchDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches the MR ref, merge-bases, and diffs via gitRaw (byte-faithful)', () => {
    a1JsonMock.mockReturnValue({
      mergeRequest: { sourceBranch: 'sha', targetBranch: 'master' },
    });
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'merge-base') return 'base-sha';
      if (args[0] === 'remote') return 'git@gitlab.alibaba-inc.com:g/p.git';
      return '';
    });
    gitRawMock.mockReturnValue(Buffer.from('diff --git a/x b/x\n', 'latin1'));
    const diff = aoneReader.fetchDiff(7, 'g/p');
    // The throwaway ref carries a pid suffix: concurrent fetchDiff runs for
    // the same MR in one clone must not share the name (one session's
    // finally-delete would kill the other mid-review).
    const refRe = /^__qwen-review-diff-7-\d+$/;
    // The diff capture spreads the pinned diff config/flags (an un-pinned
    // `color.diff=always` would make every `diff --git` unrecognisable).
    expect(gitRawMock).toHaveBeenCalledWith(
      ...PINNED_DIFF_CONFIG,
      'diff',
      ...PINNED_DIFF_FLAGS,
      expect.stringMatching(
        /^base-sha\.\.refs\/heads\/__qwen-review-diff-7-\d+$/,
      ),
    );
    expect(diff).toBe('diff --git a/x b/x\n');
    // The MR head is FORCE-fetched (a stale throwaway ref from an interrupted
    // run must not fail the fetch when the head was rewritten), and the target
    // branch is fetched so the merge-base is current.
    expect(gitMock).toHaveBeenCalledWith(
      'fetch',
      'origin',
      expect.stringMatching(
        /^\+refs\/merge-requests\/7\/head:__qwen-review-diff-7-\d+$/,
      ),
    );
    // The target fetch is an EXPLICIT BRANCH REFSPEC: a bare-name fetch
    // dwims onto a same-named tag (exit 0, tracking ref untouched — the
    // silent stale-base state). The head side of every read is qualified
    // (refs/heads/…) for the same shadow class.
    expect(gitMock).toHaveBeenCalledWith(
      'fetch',
      'origin',
      '+refs/heads/master:refs/remotes/origin/master',
    );
    // The throwaway ref is cleaned up.
    expect(gitMock).toHaveBeenCalledWith(
      'branch',
      '-D',
      expect.stringMatching(refRe),
    );
  });

  it('refuses a dash-leading target branch from the MR metadata', () => {
    a1JsonMock.mockReturnValue({
      mergeRequest: {
        sourceBranch: 'sha',
        targetBranch: '--upload-pack=/tmp/evil',
      },
    });
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'remote') return 'git@gitlab.alibaba-inc.com:g/p.git';
      return '';
    });
    expect(() => aoneReader.fetchDiff(7, 'g/p')).toThrow(
      /refusing target branch "--upload-pack=\/tmp\/evil"/,
    );
    expect(gitMock).not.toHaveBeenCalledWith(
      'fetch',
      'origin',
      expect.stringContaining('--upload-pack'),
    );
    expect(gitRawMock).not.toHaveBeenCalled();
  });

  it('refuses anything that is not a plain branch name (allowlist)', () => {
    // The guard validates allowlist-style: option spellings, refspec
    // shapes (`+` force, `src:dst` colon), rev-parse metasyntax, `HEAD`
    // (silent fetch + stale clone-time symref merge-base), ranges, and the
    // empty string all die at the metadata stage — each has a distinct
    // wrong outcome inside git.
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'remote') return 'git@gitlab.alibaba-inc.com:g/p.git';
      return '';
    });
    for (const target of [
      '+master',
      '+master:__qwen-review-diff-7',
      'a:b',
      'HEAD',
      'master^',
      'master~1',
      'master..other',
      '',
    ]) {
      a1JsonMock.mockReturnValue({
        mergeRequest: { sourceBranch: 'sha', targetBranch: target },
      });
      expect(() => aoneReader.fetchDiff(7, 'g/p')).toThrow(
        /not a plain branch name/,
      );
    }
    expect(gitRawMock).not.toHaveBeenCalled();
  });

  it('falls back to the head first-parent when merge-base fails', () => {
    a1JsonMock.mockReturnValue({
      mergeRequest: { sourceBranch: 'sha', targetBranch: 'master' },
    });
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'merge-base') throw new Error('no merge-base');
      if (args[0] === 'remote') return 'git@gitlab.alibaba-inc.com:g/p.git';
      return '';
    });
    gitRawMock.mockReturnValue(Buffer.from('d', 'latin1'));
    // NOTE: capture the calls BEFORE `mockRestore()` — vitest's restore
    // clears the recorded calls (it does mockReset's work), so a
    // restore-then-assert reads an empty spy.
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    let stderrCalls: unknown[][] = [];
    try {
      aoneReader.fetchDiff(7, 'g/p');
      stderrCalls = stderrSpy.mock.calls.slice();
    } finally {
      stderrSpy.mockRestore();
    }
    expect(gitRawMock).toHaveBeenCalledWith(
      ...PINNED_DIFF_CONFIG,
      'diff',
      ...PINNED_DIFF_FLAGS,
      expect.stringMatching(
        /^refs\/heads\/__qwen-review-diff-7-\d+~1\.\.refs\/heads\/__qwen-review-diff-7-\d+$/,
      ),
    );
    // The fallback is DISCLOSED: a multi-commit MR gets only its last
    // commit as the diff, and the skill must not review a silent fragment.
    expect(
      stderrCalls.some((c) =>
        String(c[0]).includes('no merge-base with origin/master'),
      ),
    ).toBe(true);
    expect(
      stderrCalls.some((c) =>
        String(c[0]).includes("a multi-commit MR's diff may be incomplete"),
      ),
    ).toBe(true);
  });

  it('refuses to diff from a clone of a DIFFERENT repo', () => {
    a1JsonMock.mockReturnValue({
      mergeRequest: { sourceBranch: 'sha', targetBranch: 'master' },
    });
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'remote')
        return 'git@gitlab.alibaba-inc.com:other/repo.git';
      return '';
    });
    expect(() => aoneReader.fetchDiff(7, 'g/p')).toThrow(
      /not g\/p — run from inside a clone of the target repo/,
    );
    expect(gitRawMock).not.toHaveBeenCalled();
  });

  it('refuses a same-named repo on a DIFFERENT platform (host in the guard)', () => {
    // owner/repo equality alone would let a github.com clone of the same
    // coordinate serve the ref-fetch; the guard carries the origin's host
    // (Aone host family only).
    a1JsonMock.mockReturnValue({
      mergeRequest: { sourceBranch: 'sha', targetBranch: 'master' },
    });
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'remote') return 'git@github.com:g/p.git';
      return '';
    });
    expect(() => aoneReader.fetchDiff(7, 'g/p')).toThrow(
      /not g\/p — run from inside a clone of the target repo/,
    );
    expect(gitRawMock).not.toHaveBeenCalled();
  });

  it('accepts the web/git host alias as the origin', () => {
    a1JsonMock.mockReturnValue({
      mergeRequest: { sourceBranch: 'sha', targetBranch: 'master' },
    });
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'merge-base') return 'base-sha';
      if (args[0] === 'remote') return 'https://code.alibaba-inc.com/g/p.git';
      return '';
    });
    gitRawMock.mockReturnValue(Buffer.from('d', 'latin1'));
    expect(() => aoneReader.fetchDiff(7, 'g/p')).not.toThrow();
  });

  it('refuses a different NESTED group via the MR detailUrl full path', () => {
    // The seam's ownerRepo is the collapsed last-two form; the MR's own
    // detailUrl carries the FULL path — a different group's same-tail
    // clone must not pass the guard and serve the ref-fetch.
    a1JsonMock.mockReturnValue({
      mergeRequest: {
        sourceBranch: 'sha',
        targetBranch: 'master',
        detailUrl: 'https://code.alibaba-inc.com/groupA/sub/app/codereview/7',
      },
    });
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'remote')
        return 'git@gitlab.alibaba-inc.com:groupB/sub/app.git';
      return '';
    });
    expect(() => aoneReader.fetchDiff(7, 'sub/app')).toThrow(
      /not sub\/app — run from inside a clone of the target repo/,
    );
    expect(gitRawMock).not.toHaveBeenCalled();
  });

  it('accepts the matching nested-group clone via the detailUrl full path', () => {
    a1JsonMock.mockReturnValue({
      mergeRequest: {
        sourceBranch: 'sha',
        targetBranch: 'master',
        detailUrl: 'https://code.alibaba-inc.com/groupA/sub/app/codereview/7',
      },
    });
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'merge-base') return 'base-sha';
      if (args[0] === 'remote')
        return 'git@gitlab.alibaba-inc.com:groupA/sub/app.git';
      return '';
    });
    gitRawMock.mockReturnValue(Buffer.from('d', 'latin1'));
    expect(() => aoneReader.fetchDiff(7, 'sub/app')).not.toThrow();
  });

  it('accepts a trailing-dot FQDN origin (detection and gate normalize alike)', () => {
    // Detection accepts the dotted spelling as Aone; the diff gate keyed on
    // a harder comparison refused the same genuine clone with a
    // misdirecting remedy. Both arms key on the canonical predicate now.
    a1JsonMock.mockReturnValue({
      mergeRequest: { sourceBranch: 'sha', targetBranch: 'master' },
    });
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'merge-base') return 'base-sha';
      if (args[0] === 'remote') return 'https://code.alibaba-inc.com./g/p.git';
      return '';
    });
    gitRawMock.mockReturnValue(Buffer.from('d', 'latin1'));
    expect(() => aoneReader.fetchDiff(7, 'g/p')).not.toThrow();
  });

  it('refuses git pseudo-refs as the target branch (allowlist)', () => {
    // FETCH_HEAD resolves to the just-fetched MR head (an empty diff under
    // full-range metadata); ORIG_HEAD to an arbitrary ancestor. Both are
    // shape-legal and silently wrong — the allowlist refuses the set.
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'remote') return 'git@gitlab.alibaba-inc.com:g/p.git';
      return '';
    });
    for (const target of [
      'FETCH_HEAD',
      'ORIG_HEAD',
      'MERGE_HEAD',
      // Case-insensitive: on case-insensitive filesystems (macOS/Windows
      // defaults) `.git/fetch_head` folds onto the `.git/FETCH_HEAD` the
      // immediately-preceding fetch wrote.
      'fetch_head',
      'orig_head',
      'head',
      // refs/-prefixed names are LEGAL branch names (check-ref-format
      // --branch accepts them), but as fetch/merge-base arguments they
      // resolve qualified refs the server controls — refused like the
      // pseudo-refs.
      'refs/heads/master',
      'refs/remotes/origin/HEAD',
    ]) {
      a1JsonMock.mockReturnValue({
        mergeRequest: { sourceBranch: 'sha', targetBranch: target },
      });
      expect(() => aoneReader.fetchDiff(7, 'g/p')).toThrow(
        /not a plain branch name/,
      );
    }
    expect(gitRawMock).not.toHaveBeenCalled();
  });

  it('merge-bases against the QUALIFIED tracking ref (no shadow tag)', () => {
    // A tag literally named `origin/master` is pushable by anyone with push
    // access (e.g. the MR author) and auto-carried at clone; git resolves
    // the UNQUALIFIED name in refs/tags before refs/remotes — the shadow
    // would silently move the merge base with no disclosure firing. The
    // merge-base must key on refs/remotes/origin/<target>.
    a1JsonMock.mockReturnValue({
      mergeRequest: { sourceBranch: 'sha', targetBranch: 'master' },
    });
    gitMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'merge-base') return 'base-sha';
      if (args[0] === 'remote') return 'git@gitlab.alibaba-inc.com:g/p.git';
      return '';
    });
    gitRawMock.mockReturnValue(Buffer.from('d', 'latin1'));
    aoneReader.fetchDiff(7, 'g/p');
    expect(gitMock).toHaveBeenCalledWith(
      'merge-base',
      'refs/remotes/origin/master',
      expect.stringMatching(/^refs\/heads\/__qwen-review-diff-7-\d+$/),
    );
    // The target fetch never dwims onto a same-named tag: explicit branch
    // refspec, both sides fully qualified.
    expect(gitMock).toHaveBeenCalledWith(
      'fetch',
      'origin',
      '+refs/heads/master:refs/remotes/origin/master',
    );
  });
});

describe('submitAoneReview (the a1 write path)', () => {
  function mrView(head: string | undefined) {
    // a1Json serves the READ calls (mr view); a1JsonOnce the writes.
    // `undefined` OMITS the sourceBranch key entirely — the shape
    // AoneMrView types as optional, which `mrView('')` structurally
    // could not express.
    a1JsonMock.mockImplementation((...args: string[]) => {
      if (args.includes('view')) {
        return {
          mergeRequest: {
            ...(head === undefined ? {} : { sourceBranch: head }),
            detailUrl: 'https://code.alibaba-inc.com/g/p/codereview/7',
          },
        };
      }
      throw new Error(`unexpected read call: ${args.join(' ')}`);
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mrView('sha-head');
    a1JsonOnceMock.mockReturnValue({ id: 100 });
  });

  const req = (over: Record<string, unknown> = {}) => ({
    prNumber: 7,
    ownerRepo: 'g/p',
    commitId: 'sha-head',
    event: 'COMMENT' as const,
    body: 'summary body',
    comments: [
      { path: 'a.ts', line: 3, body: '**[Critical]** one' },
      { path: 'b.ts', line: 9, body: '**[Suggestion]** two' },
    ],
    ...over,
  });

  it('posts inline first, summary last — one comment create per finding', () => {
    const result = submitAoneReview(req());
    // Two inline creates + one summary create, in that order.
    expect(a1JsonOnceMock).toHaveBeenCalledTimes(3);
    const calls = a1JsonOnceMock.mock.calls.map((c) => c as string[]);
    expect(calls[0]).toEqual([
      'repo',
      'mr',
      'comment',
      'create',
      '--mr',
      '7',
      '--repo',
      'g/p',
      '--file',
      'a.ts',
      '--line',
      '3',
      '--message',
      '**[Critical]** one',
    ]);
    // The MIDDLE create pinned exactly too — a loop regression pairing
    // comments[i] with the wrong body, or re-posting the first body, must
    // not pass while only the two ends are watched.
    expect(calls[1]).toEqual([
      'repo',
      'mr',
      'comment',
      'create',
      '--mr',
      '7',
      '--repo',
      'g/p',
      '--file',
      'b.ts',
      '--line',
      '9',
      '--message',
      '**[Suggestion]** two',
    ]);
    expect(calls[2]).toEqual([
      'repo',
      'mr',
      'comment',
      'create',
      '--mr',
      '7',
      '--repo',
      'g/p',
      '--message',
      'summary body',
    ]);
    // The `repo mr view` read is the SOLE input of the head-drift gate —
    // pin its argv exactly, or a transposed prNumber/ownerRepo anchors the
    // gate on the wrong MR and every test above stays green.
    expect(a1JsonMock).toHaveBeenCalledWith(
      'repo',
      'mr',
      'view',
      '7',
      '--repo',
      'g/p',
    );
    // COMMENT posts no approval.
    expect(a1OnceMock).not.toHaveBeenCalled();
    expect(result.postedInline).toBe(2);
    expect(result.summaryPosted).toBe(true);
    expect(result.approved).toBe(false);
    expect(result.webUrl).toBe('https://code.alibaba-inc.com/g/p/codereview/7');
    expect(ensureAuthMock).toHaveBeenCalledTimes(1);
  });

  it('APPROVE runs the native approve AFTER the summary lands', () => {
    a1JsonOnceMock
      .mockReturnValueOnce({ id: 101 })
      .mockReturnValueOnce({ id: 102 })
      .mockReturnValueOnce({ id: 103 });
    const result = submitAoneReview(req({ event: 'APPROVE' }));
    expect(a1OnceMock).toHaveBeenCalledTimes(1);
    expect(a1OnceMock).toHaveBeenCalledWith(
      'repo',
      'mr',
      'approve',
      '7',
      '--repo',
      'g/p',
    );
    // Ordering is the POINT: the approve must interleave AFTER every
    // comment create. An approve-before-writes mutation (MR approved but
    // carrying no review content if the summary create then fails) must
    // not pass — invocationCallOrder is comparable across the two mocks.
    expect(a1OnceMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...a1JsonOnceMock.mock.invocationCallOrder),
    );
    expect(result.approved).toBe(true);
    expect(result.approveError).toBeUndefined();
    expect(result.inlineCommentIds).toEqual([101, 102]);
    expect(result.summaryCommentId).toBe(103);
  });

  it('REQUEST_CHANGES prefixes the blocking header (no native reject on Aone)', () => {
    submitAoneReview(req({ event: 'REQUEST_CHANGES' }));
    const calls = a1JsonOnceMock.mock.calls.map((c) => c as string[]);
    const summaryMessage = calls[2][calls[2].length - 1];
    expect(summaryMessage).toBe('**Request changes**\n\nsummary body');
    expect(a1OnceMock).not.toHaveBeenCalled();
  });

  it('refuses BEFORE writing when the head drifted', () => {
    expect(() => submitAoneReview(req({ commitId: 'stale-sha' }))).toThrow(
      /the MR head moved/,
    );
    expect(a1JsonOnceMock).not.toHaveBeenCalled();
    expect(a1OnceMock).not.toHaveBeenCalled();
  });

  it('an empty sourceBranch cannot gate — the post proceeds unanchored', () => {
    mrView('');
    const result = submitAoneReview(req());
    expect(result.postedInline).toBe(2);
    expect(result.summaryPosted).toBe(true);
  });

  it('a MISSING sourceBranch key cannot gate either (the typed-optional shape)', () => {
    // AoneMrView types sourceBranch optional; the guard defends with
    // `(view.sourceBranch ?? '')`. A refactor to `view.sourceBranch.trim()`
    // would crash with a raw TypeError before any write on the answer
    // lacking the key, instead of the intended unanchored post.
    mrView(undefined);
    const result = submitAoneReview(req());
    expect(result.postedInline).toBe(2);
    expect(result.summaryPosted).toBe(true);
  });

  it('a mid-batch failure throws AonePartialPostError naming what landed', () => {
    a1JsonOnceMock
      .mockReturnValueOnce({ id: 101 })
      .mockImplementationOnce(() => {
        throw new Error('Command failed: boom');
      });
    let caught: unknown;
    try {
      submitAoneReview(req());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AonePartialPostError);
    const partial = caught as AonePartialPostError;
    expect(partial.postedInline).toBe(1);
    expect(partial.inlineCommentIds).toEqual([101]);
    expect(partial.summaryPosted).toBe(false);
    expect(partial.message).toContain('1 of 2');
    // An exec failure cannot tell "refused" from "accepted, then the
    // transport died" — the failing write may be live on the MR though
    // the count never saw it. Ambiguous, so submit's advisory fires.
    expect(partial.ambiguous).toBe(true);
    // The summary and any approve never ran.
    expect(a1JsonOnceMock).toHaveBeenCalledTimes(2);
    expect(a1OnceMock).not.toHaveBeenCalled();
  });

  it('refuses WHOLE, before any write, when a message overruns the a1 argv limit', () => {
    // Linux caps one argv element at 131072 BYTES. compose-review's cap
    // counts CHARACTERS (65536) — a CJK char is 3 bytes in UTF-8 — so a
    // long Chinese summary is inside the composer's cap and outside the
    // OS limit. Without this guard the summary create would die with
    // E2BIG only after every inline already landed.
    const huge = '中'.repeat(50000); // 150 000 bytes of UTF-8
    let caught: unknown;
    try {
      submitAoneReview(req({ body: huge }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(
      'over the 131072-byte single-argument limit',
    );
    // The remedy names the USER as the actor — Step 7 forbids the agent
    // every hand-run `a1` write, and an actorless "post them manually"
    // would hand the agent the exact call the rule exists to prevent.
    expect((caught as Error).message).toContain(
      'the USER can post them by hand',
    );
    // Nothing posted — neither a comment create nor an approve ran, and
    // the failure is NOT a partial post (nothing is ambiguous either).
    expect(caught).not.toBeInstanceOf(AonePartialPostError);
    expect(a1JsonOnceMock).not.toHaveBeenCalled();
    expect(a1OnceMock).not.toHaveBeenCalled();
  });

  it('guards an oversized INLINE comment too, naming it', () => {
    const huge = 'x'.repeat(140000);
    let caught: unknown;
    try {
      submitAoneReview(
        req({ comments: [{ path: 'big.ts', line: 1, body: huge }] }),
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain('inline comment 1');
    expect(a1JsonOnceMock).not.toHaveBeenCalled();
  });

  it('an approve failure alone does not fail the post', () => {
    a1OnceMock.mockImplementation(() => {
      throw Object.assign(new Error('Command failed: a1 repo mr approve'), {
        stderr: 'approval denied\n',
      });
    });
    const result = submitAoneReview(req({ event: 'APPROVE' }));
    expect(result.approved).toBe(false);
    expect(result.approveError).toContain('approval denied');
    expect(result.postedInline).toBe(2);
    expect(result.summaryPosted).toBe(true);
  });

  it('an empty-stderr failure reports EXIT FACTS, never the argv-bearing message', () => {
    // The 120 s deadline kill / SIGKILL / OOM shape: no stderr at all.
    // Parsing the message would quote a line of the operator's own review
    // body (Node embeds the full argv) as the "cause".
    a1JsonOnceMock.mockImplementationOnce(() => {
      throw Object.assign(
        new Error(
          'Command failed: a1 repo mr comment create --message the body text\nmore body',
        ),
        { status: undefined, signal: 'SIGTERM' },
      );
    });
    let caught: unknown;
    try {
      submitAoneReview(
        req({ comments: [{ path: 'a.ts', line: 3, body: 'b' }] }),
      );
    } catch (err) {
      caught = err;
    }
    const partial = caught as AonePartialPostError;
    expect(caught).toBeInstanceOf(AonePartialPostError);
    expect(partial.message).toContain('a1 failed without stderr');
    expect(partial.message).toContain('signal SIGTERM');
    expect(partial.message).not.toContain('more body');
  });

  it('an empty summary body posts no summary comment', () => {
    const result = submitAoneReview(req({ body: '   ' }));
    expect(result.summaryPosted).toBe(false);
    // Two inline creates only.
    expect(a1JsonOnceMock).toHaveBeenCalledTimes(2);
  });

  it('reads the created id back best-effort (nested shapes tolerated)', () => {
    a1JsonOnceMock
      .mockReturnValueOnce({ comment: { id: 201 } })
      .mockReturnValueOnce({ note: { id: 202 } })
      .mockReturnValueOnce({ unrelated: true });
    const result = submitAoneReview(req());
    expect(result.inlineCommentIds).toEqual([201, 202]);
    expect(result.postedInline).toBe(2);
    expect(result.summaryCommentId).toBeUndefined();
    // The summary's accepted-but-unreadable shape is still POSTED — the
    // first-class "accepted, id unknown" state. summaryPosted must not be
    // conditioned on the id reading back.
    expect(result.summaryPosted).toBe(true);
  });

  it('reads ids from the result/data nestings too — the tolerance is PINNED, not merely alive', () => {
    // createdCommentId tolerates {result:{id}} and {data:{id}} — but a
    // mutation dropping those keys from the loop survived the suite
    // (correct behavior, zero pins). This cell kills it.
    a1JsonOnceMock
      .mockReturnValueOnce({ result: { id: 301 } })
      .mockReturnValueOnce({ data: { id: 302 } })
      .mockReturnValueOnce({ result: { id: 303 } });
    const result = submitAoneReview(req());
    expect(result.inlineCommentIds).toEqual([301, 302]);
    expect(result.summaryCommentId).toBe(303);
  });

  it('counts an accepted-but-unreadable answer as POSTED — no undercount, no throw', () => {
    // a1JsonOnce yields undefined when an accepted write answers
    // unparseably. The first inline then reads back no id — but it LANDED,
    // so postedInline must still count it; only the id list drops it.
    // (Undercounting here is what would re-post the comment on a retry.)
    a1JsonOnceMock
      .mockReturnValueOnce(undefined) // inline #1: accepted, unreadable
      .mockReturnValueOnce({ id: 202 }) // inline #2
      .mockReturnValueOnce({ id: 203 }); // summary
    const result = submitAoneReview(req());
    expect(result.postedInline).toBe(2);
    expect(result.inlineCommentIds).toEqual([202]);
    expect(result.summaryCommentId).toBe(203);
    expect(result.summaryPosted).toBe(true);
  });

  it('a SUMMARY-create failure reports the inlines landed, not the summary', () => {
    // The last write dying must not read back as "and the summary landed"
    // (a summaryPosted-before-call mutation would) — the operator would be
    // told a verdict summary is on the MR when it is not, or re-post it.
    a1JsonOnceMock
      .mockReturnValueOnce({ id: 101 })
      .mockReturnValueOnce({ id: 102 })
      .mockImplementationOnce(() => {
        throw new Error('Command failed: summary died');
      });
    let caught: unknown;
    try {
      submitAoneReview(req());
    } catch (err) {
      caught = err;
    }
    const partial = caught as AonePartialPostError;
    expect(caught).toBeInstanceOf(AonePartialPostError);
    expect(partial.postedInline).toBe(2);
    expect(partial.summaryPosted).toBe(false);
    expect(partial.message).toContain('2 of 2');
    expect(partial.message).not.toContain('and the summary');
    // State the summary's fate explicitly: "2 of 2 landed" alone reads
    // as a complete review, but the verdict carrier is absent from the
    // MR — the one fact remainder-completion needs.
    expect(partial.message).toContain('the summary did NOT land');
    expect(partial.ambiguous).toBe(true);
  });

  it('counts an accepted-but-unreadable inline, THEN a failing write — count stays exact', () => {
    // The ambiguous count includes undefined ids: an earlier inline
    // accepted with an unparseable answer, then a later create dying,
    // must report BOTH in postedInline even though the id list holds only
    // the readable one (an ids.length mutation undercounts exactly here).
    a1JsonOnceMock
      .mockReturnValueOnce(undefined) // inline #1: accepted, unreadable
      .mockImplementationOnce(() => {
        throw new Error('Command failed: second died');
      });
    let caught: unknown;
    try {
      submitAoneReview(req());
    } catch (err) {
      caught = err;
    }
    const partial = caught as AonePartialPostError;
    expect(caught).toBeInstanceOf(AonePartialPostError);
    expect(partial.postedInline).toBe(1);
    expect(partial.inlineCommentIds).toEqual([]);
    expect(partial.message).toContain('1 of 2');
    expect(partial.ambiguous).toBe(true);
  });

  it('the size gate pins the boundary operator — 131072 refused, 131071 posts', () => {
    // Far-above-limit fixtures let a `>=`→`>` mutation survive: a summary
    // of EXACTLY 131072 bytes would pass the gate and die E2BIG at exec
    // time after every inline already landed.
    let caught: unknown;
    try {
      submitAoneReview(req({ body: 'x'.repeat(131072), comments: [] }));
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain(
      'over the 131072-byte single-argument limit',
    );
    expect(a1JsonOnceMock).not.toHaveBeenCalled();

    a1JsonOnceMock.mockClear();
    const result = submitAoneReview(req({ body: 'x'.repeat(131071) }));
    expect(result.summaryPosted).toBe(true);
  });

  it('the size gate measures the RC HEADER-PREFIXED summary, not the raw body', () => {
    // A REQUEST_CHANGES body just under the limit whose header-prefixed
    // summaryMessage crosses it must refuse whole — measuring req.body
    // instead would let the summary (deliberately LAST) die E2BIG after
    // every inline already landed.
    const header = '**Request changes**\n\n';
    const body = 'x'.repeat(131072 - header.length + 1);
    let caught: unknown;
    try {
      submitAoneReview(req({ event: 'REQUEST_CHANGES', body, comments: [] }));
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain(
      'over the 131072-byte single-argument limit',
    );
    expect(a1JsonOnceMock).not.toHaveBeenCalled();
  });

  it('an empty-body REQUEST_CHANGES still posts the blocking header', () => {
    // compose-review produces RC with an EMPTY body today (C≥1, all
    // Criticals inline). The header is the verdict's sole carrier on
    // Aone — the skip guard keys on the posted summaryMessage, so a
    // header-only summary posts instead of being dropped.
    const result = submitAoneReview(
      req({ event: 'REQUEST_CHANGES', body: '' }),
    );
    expect(result.summaryPosted).toBe(true);
    const calls = a1JsonOnceMock.mock.calls.map((c) => c as string[]);
    expect(calls).toHaveLength(3); // 2 inlines + header-only summary
    expect(calls[2][calls[2].length - 1]).toBe('**Request changes**\n\n');
  });

  it('reports a1 stderr as the cause, not a line of the comment body', () => {
    // Node embeds the FULL argv — multi-line comment body included — in
    // the "Command failed:" preamble, so parsing the message surfaces the
    // operator's own review text. The real error rides the captured
    // stderr property; the report must carry IT.
    a1JsonOnceMock.mockImplementationOnce(() => {
      const err = Object.assign(
        new Error(
          'Command failed: a1 repo mr comment create --message line one\nline two of the body',
        ),
        { stderr: 'HTTP 422: real a1 error\n' },
      );
      throw err;
    });
    let caught: unknown;
    try {
      submitAoneReview(
        req({ comments: [{ path: 'a.ts', line: 3, body: 'b' }] }),
      );
    } catch (err) {
      caught = err;
    }
    const partial = caught as AonePartialPostError;
    expect(caught).toBeInstanceOf(AonePartialPostError);
    expect(partial.message).toContain('HTTP 422: real a1 error');
    expect(partial.message).not.toContain('line two of the body');
  });

  it('discloses a head that moved DURING the batch (the gate is check-then-post)', () => {
    // The gate reads the head once, BEFORE the batch; an AGit-Flow amend
    // pushed mid-batch slips it. The success report must disclose the
    // orphaned pins instead of claiming they held.
    a1JsonMock
      .mockReturnValueOnce({
        mergeRequest: {
          sourceBranch: 'sha-head',
          detailUrl: 'https://code.alibaba-inc.com/g/p/codereview/7',
        },
      })
      .mockReturnValueOnce({
        mergeRequest: {
          sourceBranch: 'sha-amended',
          detailUrl: 'https://code.alibaba-inc.com/g/p/codereview/7',
        },
      });
    const result = submitAoneReview(req());
    expect(result.postedInline).toBe(2);
    expect(result.headMovedDuringPost).toBe(true);
  });

  it('a stable head through the batch reports no mid-batch drift', () => {
    const result = submitAoneReview(req());
    expect(result.headMovedDuringPost).toBe(false);
  });

  it('a post-batch re-read failure does not fail a successful post', () => {
    a1JsonMock
      .mockReturnValueOnce({
        mergeRequest: {
          sourceBranch: 'sha-head',
          detailUrl: 'https://code.alibaba-inc.com/g/p/codereview/7',
        },
      })
      .mockImplementationOnce(() => {
        throw new Error('Command failed: a1 repo mr view — network gone');
      });
    const result = submitAoneReview(req());
    expect(result.postedInline).toBe(2);
    expect(result.summaryPosted).toBe(true);
    expect(result.headMovedDuringPost).toBe(false);
  });
});
