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
} from './remote-match.js';

describe('parseRemoteUrl', () => {
  interface ParseCase {
    name: string;
    url: string;
    want: { host: string; owner: string; repo: string } | null;
  }

  const cases: ParseCase[] = [
    {
      name: 'scp shape',
      url: 'git@github.com:QwenLM/qwen-code.git',
      want: { host: 'github.com', owner: 'qwenlm', repo: 'qwen-code' },
    },
    {
      name: 'scp shape without .git',
      url: 'git@github.com:QwenLM/qwen-code',
      want: { host: 'github.com', owner: 'qwenlm', repo: 'qwen-code' },
    },
    {
      name: 'https shape',
      url: 'https://github.com/wenshao/qwen-code.git',
      want: { host: 'github.com', owner: 'wenshao', repo: 'qwen-code' },
    },
    {
      name: 'https shape with trailing slash',
      url: 'https://github.com/wenshao/qwen-code/',
      want: { host: 'github.com', owner: 'wenshao', repo: 'qwen-code' },
    },
    {
      name: 'https shape with userinfo',
      url: 'https://user@github.com/wenshao/qwen-code.git',
      want: { host: 'github.com', owner: 'wenshao', repo: 'qwen-code' },
    },
    {
      name: 'ssh scheme with port',
      url: 'ssh://git@ghe.example.com:22/team/tool.git',
      want: { host: 'ghe.example.com', owner: 'team', repo: 'tool' },
    },
    {
      name: 'host case is normalised',
      url: 'git@GitHub.COM:Owner/Repo.git',
      want: { host: 'github.com', owner: 'owner', repo: 'repo' },
    },
    {
      name: 'extra path segment is not an owner/repo',
      url: 'https://github.com/a/b/c.git',
      want: null,
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
});
