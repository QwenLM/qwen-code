/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

// The cwd-origin probe shells out to `git remote get-url origin`; mocking it
// keeps these tests independent of the machine's actual clone origin. The
// builtin needs both a named and a default export mocked for the graph.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const mocked = { ...actual, execFileSync: execFileSyncMock };
  return { ...mocked, default: mocked };
});

import { detectPlatformKind } from './registry.js';
import { parseRemoteUrl } from './aone.js';

describe('detectPlatformKind', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it('detects Aone from a CANONICAL Aone --host (trimmed, port-bearing, cased)', () => {
    expect(detectPlatformKind({ host: 'gitlab.alibaba-inc.com' })).toBe('aone');
    expect(detectPlatformKind({ host: 'code.alibaba-inc.com' })).toBe('aone');
    expect(detectPlatformKind({ host: 'GITLAB.Alibaba-Inc.com:443' })).toBe(
      'aone',
    );
    // A NON-default port on the canonical pair still names Aone.
    expect(detectPlatformKind({ host: 'code.alibaba-inc.com:8443' })).toBe(
      'aone',
    );
    expect(detectPlatformKind({ host: ' gitlab.alibaba-inc.com ' })).toBe(
      'aone',
    );
  });

  it('an EXPLICIT family-but-not-canonical host stays GitHub — it is a GHE instance', () => {
    // The review skill always passes --host; a `*.alibaba-inc.com` host
    // that is NOT the canonical pair (`ghe.alibaba-inc.com` is the live
    // example) is a GitHub Enterprise instance — selecting Aone there
    // would authenticate against the wrong platform and read an unrelated
    // same-numbered Aone MR. The family predicate stands only for the
    // no-explicit-signal cwd fallback (pinned below).
    expect(detectPlatformKind({ host: 'GHE.Alibaba-Inc.com:8443' })).toBe(
      'github',
    );
    // The explicit-remote arm follows the same rule.
    expect(
      detectPlatformKind({
        remoteUrl: 'git@ghe.alibaba-inc.com:group/repo.git',
      }),
    ).toBe('github');
  });

  it('the cwd origin probe keeps the FAMILY predicate', () => {
    // An origin the caller did not name explicitly is the one place a
    // non-canonical Aone-family host still reads as Aone.
    execFileSyncMock.mockReturnValue('git@ghe.alibaba-inc.com:group/repo.git');
    expect(detectPlatformKind({})).toBe('aone');
    execFileSyncMock.mockReturnValue(
      'git@gitlab.alibaba-inc.com:maxcompute/odps_src.git',
    );
    expect(detectPlatformKind({})).toBe('aone');
  });

  it('detects Aone from the trailing-dot FQDN spelling of the same host', () => {
    // DNS-identical to the plain host, admitted by the URL grammar — both
    // spellings must hit the same guards.
    expect(detectPlatformKind({ host: 'code.alibaba-inc.com.' })).toBe('aone');
    // The remoteUrl arm too — a dotted-spelling clone must route to the
    // same platform its CR-URL twin names.
    expect(
      detectPlatformKind({
        remoteUrl: 'https://code.alibaba-inc.com./maxcompute/odps_src.git',
      }),
    ).toBe('aone');
  });

  it('detects Aone from an Aone remote URL', () => {
    expect(
      detectPlatformKind({
        remoteUrl: 'git@gitlab.alibaba-inc.com:maxcompute/odps_src.git',
      }),
    ).toBe('aone');
  });

  it('an explicit non-Aone host/remote beats the cwd probe', () => {
    // Regression guard: from an Aone-origin clone, an explicitly-GitHub
    // target must stay GitHub, not be hijacked to Aone by the cwd probe.
    execFileSyncMock.mockReturnValue(
      'git@gitlab.alibaba-inc.com:maxcompute/odps_src.git',
    );
    expect(detectPlatformKind({ host: 'github.com' })).toBe('github');
    expect(
      detectPlatformKind({ remoteUrl: 'git@github.com:QwenLM/qwen-code.git' }),
    ).toBe('github');
  });

  it('falls back to the cwd origin when there is no explicit signal', () => {
    execFileSyncMock.mockReturnValue(
      'git@gitlab.alibaba-inc.com:maxcompute/odps_src.git',
    );
    expect(detectPlatformKind({})).toBe('aone');
    execFileSyncMock.mockReturnValue('git@github.com:QwenLM/qwen-code.git');
    expect(detectPlatformKind({})).toBe('github');
  });

  it('an unreadable origin falls back to github without throwing', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not a git repository');
    });
    expect(detectPlatformKind({})).toBe('github');
  });

  it('detection agrees with GIT (and the canonical parser) on token-bearing userinfo', () => {
    // Round-11 re-bless: detection delegates to the canonical
    // aone.parseRemoteUrl, which reads git's OWN scp grammar — hostinfo
    // ends at the FIRST `:` (GIT_TRACE-probed: `git ls-remote
    // 'git:S1/xx@…'` connects to host `git`), and URL userinfo cannot
    // carry `/`. These shapes therefore carry no Aone identity — detection
    // says GitHub while the parse side fails closed, and the two can never
    // disagree again (one parser, one source of truth).
    expect(
      detectPlatformKind({
        remoteUrl: 'git:S1/xx@gitlab.alibaba-inc.com:maxcompute/odps_src.git',
      }),
    ).toBe('github');
    expect(
      detectPlatformKind({
        remoteUrl: 'https://oauth2:abc/def@code.alibaba-inc.com/group/proj.git',
      }),
    ).toBe('github');
    // The `?`-bearing userinfo corner stays consistent in the other
    // direction: the canonical parser accepts it, so detection says Aone.
    expect(
      detectPlatformKind({
        remoteUrl: 'https://user:pa?ss@code.alibaba-inc.com/group/proj.git',
      }),
    ).toBe('aone');
  });

  it('an explicit --host outranks the remote-URL hint in BOTH directions', () => {
    // fetch-pr threads both hints; a remoteUrl-first order let an Aone
    // origin hijack an explicitly-GitHub invocation — and because MR ids
    // are global, the hijack can succeed with an unrelated MR's head.
    expect(
      detectPlatformKind({
        host: 'github.com',
        remoteUrl: 'git@gitlab.alibaba-inc.com:maxcompute/odps_src.git',
      }),
    ).toBe('github');
    // The mirror arm: an explicit Aone host beats a non-Aone remote.
    expect(
      detectPlatformKind({
        host: 'gitlab.alibaba-inc.com',
        remoteUrl: 'git@github.com:QwenLM/qwen-code.git',
      }),
    ).toBe('aone');
  });
});

describe('parseRemoteUrl', () => {
  it('parses the scp-like ssh form', () => {
    expect(
      parseRemoteUrl('git@gitlab.alibaba-inc.com:maxcompute/odps_src.git'),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'maxcompute',
      repo: 'odps_src',
      groupPath: 'maxcompute/odps_src',
    });
  });

  it('parses a USER-LESS scp-like remote (ssh-config / insteadOf)', () => {
    expect(
      parseRemoteUrl('gitlab.alibaba-inc.com:maxcompute/odps_src.git'),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'maxcompute',
      repo: 'odps_src',
      groupPath: 'maxcompute/odps_src',
    });
  });

  it('parses the https form (with and without .git)', () => {
    expect(
      parseRemoteUrl('https://gitlab.alibaba-inc.com/maxcompute/odps_src.git'),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'maxcompute',
      repo: 'odps_src',
      groupPath: 'maxcompute/odps_src',
    });
    expect(
      parseRemoteUrl('https://gitlab.alibaba-inc.com/maxcompute/odps_src'),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'maxcompute',
      repo: 'odps_src',
      groupPath: 'maxcompute/odps_src',
    });
  });

  it('parses ssh:// with a user@ prefix', () => {
    expect(
      parseRemoteUrl(
        'ssh://git@gitlab.alibaba-inc.com/maxcompute/odps_src.git',
      ),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'maxcompute',
      repo: 'odps_src',
      groupPath: 'maxcompute/odps_src',
    });
  });

  it('scheme case is irrelevant (RFC 3986), matching hostOfRemoteUrl', () => {
    expect(
      parseRemoteUrl('HTTPS://GitLab.Alibaba-Inc.com/maxcompute/odps_src.git'),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'maxcompute',
      repo: 'odps_src',
      groupPath: 'maxcompute/odps_src',
    });
  });

  it('lowercases the host and keeps the last two path segments (nested groups)', () => {
    expect(
      parseRemoteUrl('https://GitLab.Alibaba-Inc.com/sub/maxcompute/odps_src'),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'maxcompute',
      repo: 'odps_src',
      groupPath: 'sub/maxcompute/odps_src',
    });
  });

  it('strips a trailing slash and a .git/ suffix', () => {
    expect(
      parseRemoteUrl('https://gitlab.alibaba-inc.com/maxcompute/odps_src.git/'),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'maxcompute',
      repo: 'odps_src',
      groupPath: 'maxcompute/odps_src',
    });
    expect(
      parseRemoteUrl('git@gitlab.alibaba-inc.com:maxcompute/odps_src/'),
    ).toEqual({
      host: 'gitlab.alibaba-inc.com',
      owner: 'maxcompute',
      repo: 'odps_src',
      groupPath: 'maxcompute/odps_src',
    });
  });

  it('returns null for unparseable URLs', () => {
    expect(parseRemoteUrl('not-a-url')).toBeNull();
    expect(parseRemoteUrl('https://host/onlyone')).toBeNull();
  });
});
