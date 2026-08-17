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
    });
  });

  it('strips a query string / fragment (credential-bearing channel)', () => {
    expect(
      parseRemoteUrl('https://h.example/g/p?private_token=SECRET'),
    ).toEqual({ host: 'h.example', owner: 'g', repo: 'p' });
    expect(parseRemoteUrl('https://h.example/g/p.git#frag')).toEqual({
      host: 'h.example',
      owner: 'g',
      repo: 'p',
    });
  });

  it('strips TWO OR MORE trailing slashes after .git', () => {
    expect(parseRemoteUrl('https://h.example/g/p.git//')).toEqual({
      host: 'h.example',
      owner: 'g',
      repo: 'p',
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
    ).toEqual({ host: 'code.alibaba-inc.com', owner: 'g', repo: 'p' });
    expect(
      parseRemoteUrl('https://ci-user:S1@S2@S3@code.alibaba-inc.com/g/p'),
    ).toEqual({ host: 'code.alibaba-inc.com', owner: 'g', repo: 'p' });
  });

  it('consumes a `/`-bearing scp userinfo whole', () => {
    expect(
      parseRemoteUrl('ci-user:/token-with-slash@code.alibaba-inc.com:g/p.git'),
    ).toEqual({ host: 'code.alibaba-inc.com', owner: 'g', repo: 'p' });
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
});
