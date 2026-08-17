/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { a1JsonMock, ensureAuthMock, gitMock, gitRawMock } = vi.hoisted(() => ({
  a1JsonMock: vi.fn(),
  ensureAuthMock: vi.fn(),
  gitMock: vi.fn(),
  gitRawMock: vi.fn(),
}));

vi.mock('./aone-client.js', () => ({
  a1Json: a1JsonMock,
  a1: vi.fn(),
  ensureAoneAuthenticated: ensureAuthMock,
}));

vi.mock('../git.js', () => ({
  git: gitMock,
  gitRaw: gitRawMock,
}));

import { aoneReader, parseRemoteUrl } from './aone.js';
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

  it('consumes a `/`-bearing scp userinfo whole', () => {
    expect(
      parseRemoteUrl('ci-user:/token-with-slash@code.alibaba-inc.com:g/p.git'),
    ).toEqual({
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
      expect.stringMatching(/^base-sha\.\.__qwen-review-diff-7-\d+$/),
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
    // `--` ends option parsing: the target branch is server-controlled MR
    // metadata and must never reach git as an option.
    expect(gitMock).toHaveBeenCalledWith('fetch', 'origin', '--', 'master');
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
        /^__qwen-review-diff-7-\d+~1\.\.__qwen-review-diff-7-\d+$/,
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
    for (const target of ['FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD']) {
      a1JsonMock.mockReturnValue({
        mergeRequest: { sourceBranch: 'sha', targetBranch: target },
      });
      expect(() => aoneReader.fetchDiff(7, 'g/p')).toThrow(
        /not a plain branch name/,
      );
    }
    expect(gitRawMock).not.toHaveBeenCalled();
  });
});
