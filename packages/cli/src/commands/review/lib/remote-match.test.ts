/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseRemoteUrl,
  matchRemotes,
  normalizeSegment,
  hostsEquivalent,
  isAoneCanonicalHost,
} from './remote-match.js';

describe('parseRemoteUrl', () => {
  interface ParseCase {
    name: string;
    url: string;
    want: {
      host: string;
      owner: string;
      repo: string;
      groupPath: string;
    } | null;
  }

  const cases: ParseCase[] = [
    {
      name: 'scp shape',
      url: 'git@github.com:QwenLM/qwen-code.git',
      want: {
        host: 'github.com',
        owner: 'qwenlm',
        repo: 'qwen-code',
        groupPath: 'qwenlm/qwen-code',
      },
    },
    {
      name: 'scp shape without .git',
      url: 'git@github.com:QwenLM/qwen-code',
      want: {
        host: 'github.com',
        owner: 'qwenlm',
        repo: 'qwen-code',
        groupPath: 'qwenlm/qwen-code',
      },
    },
    {
      name: 'https shape',
      url: 'https://github.com/wenshao/qwen-code.git',
      want: {
        host: 'github.com',
        owner: 'wenshao',
        repo: 'qwen-code',
        groupPath: 'wenshao/qwen-code',
      },
    },
    {
      name: 'https shape with trailing slash',
      url: 'https://github.com/wenshao/qwen-code/',
      want: {
        host: 'github.com',
        owner: 'wenshao',
        repo: 'qwen-code',
        groupPath: 'wenshao/qwen-code',
      },
    },
    {
      name: 'https shape with userinfo',
      url: 'https://user@github.com/wenshao/qwen-code.git',
      want: {
        host: 'github.com',
        owner: 'wenshao',
        repo: 'qwen-code',
        groupPath: 'wenshao/qwen-code',
      },
    },
    {
      name: 'ssh scheme with port',
      url: 'ssh://git@ghe.example.com:22/team/tool.git',
      want: {
        host: 'ghe.example.com',
        owner: 'team',
        repo: 'tool',
        groupPath: 'team/tool',
      },
    },
    {
      name: 'host case is normalised',
      url: 'git@GitHub.COM:Owner/Repo.git',
      want: {
        host: 'github.com',
        owner: 'owner',
        repo: 'repo',
        groupPath: 'owner/repo',
      },
    },
    {
      name: 'a nested-group path collapses to the last two segments',
      url: 'https://github.com/a/b/c.git',
      want: { host: 'github.com', owner: 'b', repo: 'c', groupPath: 'a/b/c' },
    },
    {
      name: 'an Aone nested-group clone collapses and is matchable',
      url: 'git@gitlab.alibaba-inc.com:group/subgroup/odps_src.git',
      want: {
        host: 'gitlab.alibaba-inc.com',
        owner: 'subgroup',
        repo: 'odps_src',
        groupPath: 'group/subgroup/odps_src',
      },
    },
    {
      name: 'bare local path',
      url: '/srv/git/qwen-code.git',
      want: null,
    },
    {
      name: 'file scheme has no host',
      url: 'file:///srv/git/qwen-code.git',
      want: null,
    },
    {
      name: 'colon without slash is not the scp shape',
      url: 'weird:thing',
      want: null,
    },
    {
      name: 'empty string',
      url: '',
      want: null,
    },
    {
      name: 'owner missing',
      url: 'https://github.com/qwen-code.git',
      want: null,
    },
  ];

  it.each(cases)('$name', ({ url, want }) => {
    expect(parseRemoteUrl(url)).toEqual(want);
  });
});

describe('normalizeSegment', () => {
  it('lowercases and strips one trailing .git', () => {
    expect(normalizeSegment('QwenLM')).toBe('qwenlm');
    expect(normalizeSegment('qwen-code.git')).toBe('qwen-code');
    // Uppercase .GIT pins the lowercase-THEN-strip order: strip-before-
    // lowercase would leave the suffix behind and fail every comparison.
    expect(normalizeSegment('QWEN-CODE.GIT')).toBe('qwen-code');
    expect(normalizeSegment('qwen-code.git.git')).toBe('qwen-code.git');
  });
});

describe('matchRemotes', () => {
  const FORK_LAYOUT = [
    'origin\tgit@github.com:QwenLM/qwen-code.git (fetch)',
    'origin\tgit@github.com:QwenLM/qwen-code.git (push)',
    'wenshao\tgit@github.com:wenshao/qwen-code.git (fetch)',
    'wenshao\tgit@github.com:wenshao/qwen-code.git (push)',
  ].join('\n');

  it('matches the upstream in a fork layout', () => {
    const { matched } = matchRemotes(FORK_LAYOUT, {
      owner: 'QwenLM',
      repo: 'qwen-code',
    });
    expect(matched).toEqual(['origin']);
  });

  it('matches the fork by its own owner', () => {
    const { matched } = matchRemotes(FORK_LAYOUT, {
      owner: 'wenshao',
      repo: 'qwen-code',
    });
    expect(matched).toEqual(['wenshao']);
  });

  it('compares case-insensitively', () => {
    const { matched } = matchRemotes(FORK_LAYOUT, {
      owner: 'QWENLM',
      repo: 'QWEN-CODE',
    });
    expect(matched).toEqual(['origin']);
  });

  it('tolerates a .git suffix on the input repo', () => {
    const { matched } = matchRemotes(FORK_LAYOUT, {
      owner: 'QwenLM',
      repo: 'qwen-code.git',
    });
    expect(matched).toEqual(['origin']);
  });

  // The regression row: a substring comparison matched `shao/qwen-code`
  // against the `wenshao` remote and one review read one repository while
  // posting to another. Exact segment equality must not.
  it('does not substring-match an owner contained in another', () => {
    const { matched } = matchRemotes(FORK_LAYOUT, {
      owner: 'shao',
      repo: 'qwen-code',
    });
    expect(matched).toEqual([]);
  });

  it('strips an explicit port from the input host before comparing', () => {
    // parse-args' PR_URL_RE keeps `host:port` in the verdict and lib/gh.ts'
    // HOSTNAME_RE accepts it, but a parsed remote URL never carries a port —
    // without the strip, a port-bearing GHE review could never match its own
    // remote and would be demoted to lightweight mode.
    const remotes = [
      'origin\thttps://ghe.example.com/team/repo.git (fetch)',
      'origin\thttps://ghe.example.com/team/repo.git (push)',
    ].join('\n');
    expect(
      matchRemotes(remotes, {
        owner: 'team',
        repo: 'repo',
        host: 'ghe.example.com:8443',
      }).matched,
    ).toEqual(['origin']);
  });

  it('does not match a different host', () => {
    const { matched } = matchRemotes(FORK_LAYOUT, {
      owner: 'QwenLM',
      repo: 'qwen-code',
      host: 'ghe.example.com',
    });
    expect(matched).toEqual([]);
  });

  it('matches a GHE remote only under its own host', () => {
    const remotes = [
      'origin\tgit@github.com:QwenLM/qwen-code.git (fetch)',
      'origin\tgit@github.com:QwenLM/qwen-code.git (push)',
      'ghe\tgit@ghe.example.com:QwenLM/qwen-code.git (fetch)',
      'ghe\tgit@ghe.example.com:QwenLM/qwen-code.git (push)',
    ].join('\n');
    expect(
      matchRemotes(remotes, {
        owner: 'QwenLM',
        repo: 'qwen-code',
        host: 'ghe.example.com',
      }).matched,
    ).toEqual(['ghe']);
    expect(
      matchRemotes(remotes, { owner: 'QwenLM', repo: 'qwen-code' }).matched,
    ).toEqual(['origin']);
  });

  it('reports every match when several remotes serve the same repo', () => {
    const remotes = [
      'upstream\thttps://github.com/QwenLM/qwen-code.git (fetch)',
      'upstream\thttps://github.com/QwenLM/qwen-code.git (push)',
      'mirror\tgit@github.com:QwenLM/qwen-code.git (fetch)',
      'mirror\tgit@github.com:QwenLM/qwen-code.git (push)',
    ].join('\n');
    const { matched } = matchRemotes(remotes, {
      owner: 'QwenLM',
      repo: 'qwen-code',
    });
    expect(matched).toEqual(['upstream', 'mirror']);
  });

  it('matches on the fetch URL only, and counts each remote once', () => {
    // pushurl differs from the fetch URL; only the fetch side serves
    // `git fetch <remote> pull/<n>/head`, so only it can match — and the
    // push line must not add a duplicate.
    const remotes = [
      'origin\thttps://github.com/QwenLM/qwen-code.git (fetch)',
      'origin\thttps://github.com/someone-else/push-target.git (push)',
    ].join('\n');
    const { matched } = matchRemotes(remotes, {
      owner: 'QwenLM',
      repo: 'qwen-code',
    });
    expect(matched).toEqual(['origin']);
  });

  it('does not match when only the push URL points at the repo', () => {
    const remotes = [
      'origin\thttps://github.com/someone-else/fetch-side.git (fetch)',
      'origin\thttps://github.com/QwenLM/qwen-code.git (push)',
    ].join('\n');
    const { matched } = matchRemotes(remotes, {
      owner: 'QwenLM',
      repo: 'qwen-code',
    });
    expect(matched).toEqual([]);
  });

  it('matches a partial-clone remote despite the filter annotation', () => {
    // `git clone --filter=blob:none` makes `git remote -v` print
    // `<name>\t<url> (fetch) [blob:none]` — the annotation sits after the
    // marker and must not lose the remote (a silent exit-6 demotion for
    // every partial clone).
    const remotes = [
      'origin\thttps://github.com/QwenLM/qwen-code.git (fetch) [blob:none]',
      'origin\thttps://github.com/QwenLM/qwen-code.git (push)',
    ].join('\n');
    const { matched } = matchRemotes(remotes, {
      owner: 'QwenLM',
      repo: 'qwen-code',
    });
    expect(matched).toEqual(['origin']);
  });

  it('skips unparsable remotes', () => {
    const remotes = [
      'local\t/srv/git/qwen-code.git (fetch)',
      'local\t/srv/git/qwen-code.git (push)',
      'origin\tgit@github.com:QwenLM/qwen-code.git (fetch)',
      'origin\tgit@github.com:QwenLM/qwen-code.git (push)',
    ].join('\n');
    const { matched } = matchRemotes(remotes, {
      owner: 'QwenLM',
      repo: 'qwen-code',
    });
    expect(matched).toEqual(['origin']);
  });

  it('handles empty output', () => {
    const { matched } = matchRemotes('', {
      owner: 'QwenLM',
      repo: 'qwen-code',
    });
    expect(matched).toEqual([]);
  });

  it('matches an Aone CR-URL web host against a git-host remote', () => {
    // A CR URL uses code.alibaba-inc.com (web); the clone's remote uses
    // gitlab.alibaba-inc.com (git). They are the same platform.
    const { matched } = matchRemotes(
      'origin\tgit@gitlab.alibaba-inc.com:maxcompute/odps_src.git (fetch)\n',
      { owner: 'maxcompute', repo: 'odps_src', host: 'code.alibaba-inc.com' },
    );
    expect(matched).toEqual(['origin']);
  });

  it("a nested-group target does NOT match a different group's same-named repo", () => {
    // The owner/repo collapse is non-injective: groupA/frontend/app and
    // groupB/frontend/app share their last two segments. With the full
    // group path carried, the match compares every segment and refuses the
    // wrong group — the review-one-repo-post-to-another hazard.
    const remoteV =
      'origin\tgit@gitlab.alibaba-inc.com:groupB/frontend/app.git (fetch)\n';
    const { matched } = matchRemotes(remoteV, {
      owner: 'frontend',
      repo: 'app',
      host: 'code.alibaba-inc.com',
      groupPath: 'groupA/frontend/app',
    });
    expect(matched).toEqual([]);
  });

  it("a nested-group target matches its own group's remote", () => {
    const remoteV =
      'origin\tgit@gitlab.alibaba-inc.com:groupA/frontend/app.git (fetch)\n';
    const { matched } = matchRemotes(remoteV, {
      owner: 'frontend',
      repo: 'app',
      host: 'code.alibaba-inc.com',
      groupPath: 'groupA/frontend/app',
    });
    expect(matched).toEqual(['origin']);
  });

  it('without a group path the last-two rule stands (two-segment want)', () => {
    // GitHub targets and bare numbers carry no nested path — the collapse
    // comparison remains, so a nested-group remote still matches its last
    // two segments.
    const remoteV =
      'origin\tgit@gitlab.alibaba-inc.com:groupB/frontend/app.git (fetch)\n';
    const { matched } = matchRemotes(remoteV, {
      owner: 'frontend',
      repo: 'app',
      host: 'code.alibaba-inc.com',
    });
    expect(matched).toEqual(['origin']);
  });

  it('a nested-group target does NOT match a two-segment remote', () => {
    // A two-segment remote can never BE the nested target's repo — the
    // fallback must not lend it the match (reverse direction of the
    // same-tail hazard).
    const remoteV =
      'origin\tgit@gitlab.alibaba-inc.com:frontend/app.git (fetch)\n';
    const { matched } = matchRemotes(remoteV, {
      owner: 'frontend',
      repo: 'app',
      host: 'code.alibaba-inc.com',
      groupPath: 'groupA/frontend/app',
    });
    expect(matched).toEqual([]);
  });

  it('a two-segment target path does NOT match a nested remote', () => {
    // The CR URL pins an exact two-segment repo; a nested remote sharing
    // its tail is a different project.
    const remoteV =
      'origin\tgit@gitlab.alibaba-inc.com:groupB/frontend/app.git (fetch)\n';
    const { matched } = matchRemotes(remoteV, {
      owner: 'frontend',
      repo: 'app',
      host: 'code.alibaba-inc.com',
      groupPath: 'frontend/app',
    });
    expect(matched).toEqual([]);
  });
});

describe('hostsEquivalent', () => {
  it('identical hosts are equivalent', () => {
    expect(hostsEquivalent('github.com', 'github.com')).toBe(true);
  });

  it('Aone web and git hosts are one equivalence class', () => {
    expect(
      hostsEquivalent('code.alibaba-inc.com', 'gitlab.alibaba-inc.com'),
    ).toBe(true);
    expect(
      hostsEquivalent('gitlab.alibaba-inc.com', 'code.alibaba-inc.com'),
    ).toBe(true);
  });

  it('different non-Aone hosts are not equivalent', () => {
    expect(hostsEquivalent('github.com', 'gitlab.alibaba-inc.com')).toBe(false);
    expect(hostsEquivalent('a.com', 'b.com')).toBe(false);
  });

  it('equates the alias across spelling variants (port, dot, case)', () => {
    // The CR-URL grammar keeps `(?::\d+)?` inside the host capture, so a
    // review recorded from `code.alibaba-inc.com:443` must still bind a
    // submission carrying the skill-mandated `gitlab.alibaba-inc.com` —
    // raw spelling equality died at the gate after the whole review ran.
    expect(
      hostsEquivalent('code.alibaba-inc.com:443', 'gitlab.alibaba-inc.com'),
    ).toBe(true);
    expect(
      hostsEquivalent('CODE.ALIBABA-INC.COM', 'gitlab.alibaba-inc.com.'),
    ).toBe(true);
    // Same-host spellings with variants are identical too.
    expect(hostsEquivalent('github.com:443', 'GITHUB.COM')).toBe(true);
  });
});

describe('isAoneCanonicalHost', () => {
  it('accepts only the canonical Aone web/git pair', () => {
    expect(isAoneCanonicalHost('code.alibaba-inc.com')).toBe(true);
    expect(isAoneCanonicalHost('gitlab.alibaba-inc.com')).toBe(true);
  });

  it('normalizes port, trailing dot and case like the family predicate', () => {
    expect(isAoneCanonicalHost('CODE.ALIBABA-INC.COM')).toBe(true);
    expect(isAoneCanonicalHost('gitlab.alibaba-inc.com:443')).toBe(true);
    expect(isAoneCanonicalHost('code.alibaba-inc.com.')).toBe(true);
  });

  it('REJECTS the family wildcard — a GHE host is not Aone', () => {
    // The `.alibaba-inc.com` suffix also names GitHub Enterprise
    // instances; a write must not select a1 on a family resemblance.
    expect(isAoneCanonicalHost('ghe.alibaba-inc.com')).toBe(false);
    expect(isAoneCanonicalHost('github.alibaba-inc.com')).toBe(false);
  });

  it('rejects non-Aone and empty hosts', () => {
    expect(isAoneCanonicalHost('github.com')).toBe(false);
    expect(isAoneCanonicalHost(undefined)).toBe(false);
    expect(isAoneCanonicalHost('')).toBe(false);
  });
});
