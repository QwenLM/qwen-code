/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `vi.mock('node:child_process')` cannot intercept in this package (see
// git-branch-ops.test.ts), so detection runs the real git binary against
// throwaway repositories, the a1 body parsing is exercised through its
// exported pure functions, and the exec layer runs through the
// setA1ExecForTest seam.

import { execSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AONE_BACKFILL_PAGES_PER_STATE,
  AoneCliUnavailableError,
  AoneCommandError,
  listAoneMergeRequests,
  mapAoneMrState,
  parseAoneMrListPage,
  parseAoneMrView,
  resolveAoneWorkspaceRepo,
  setA1ExecForTest,
  viewAoneMergeRequest,
} from './aone-mrs.js';

describe('mapAoneMrState', () => {
  it('maps the probed Aone states onto the sidecar vocabulary', () => {
    expect(mapAoneMrState('merged')).toBe('merged');
    expect(mapAoneMrState('closed')).toBe('closed');
    expect(mapAoneMrState('opened')).toBe('open');
    expect(mapAoneMrState('reopened')).toBe('open');
    // Approved-but-unmerged is still open.
    expect(mapAoneMrState('accepted')).toBe('open');
    expect(mapAoneMrState(undefined)).toBe('open');
    expect(mapAoneMrState('MERGED')).toBe('merged');
  });
});

describe('resolveAoneWorkspaceRepo', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-aone-mrs-'));
    execSync('git init', { cwd: repo, stdio: 'pipe' });
  });

  afterEach(async () => {
    await fsp.rm(repo, { recursive: true, force: true });
  });

  it('resolves the full group path of an scp-style Aone origin', async () => {
    execSync(
      'git remote add origin git@gitlab.alibaba-inc.com:jspt/agentic_coding.git',
      { cwd: repo, stdio: 'pipe' },
    );
    const resolved = await resolveAoneWorkspaceRepo(repo);
    expect(resolved?.repoPath).toBe('jspt/agentic_coding');
    expect(resolved?.gitRoot).toBe(path.resolve(repo));
  });

  it('keeps nested-group segments intact', async () => {
    execSync(
      'git remote add origin https://gitlab.alibaba-inc.com/group/sub/project.git',
      { cwd: repo, stdio: 'pipe' },
    );
    const resolved = await resolveAoneWorkspaceRepo(repo);
    expect(resolved?.repoPath).toBe('group/sub/project');
  });

  it('treats the family predicate like review’s cwd probe', async () => {
    // A canonical pair check would read this GHE-shaped host as GitHub; the
    // detection deliberately mirrors review's family-wild origin probe.
    execSync('git remote add origin git@some-ghe.alibaba-inc.com:o/r.git', {
      cwd: repo,
      stdio: 'pipe',
    });
    const resolved = await resolveAoneWorkspaceRepo(repo);
    expect(resolved?.repoPath).toBe('o/r');
  });

  it('returns undefined for GitHub origins', async () => {
    execSync('git remote add origin git@github.com:o/r.git', {
      cwd: repo,
      stdio: 'pipe',
    });
    expect(await resolveAoneWorkspaceRepo(repo)).toBeUndefined();
  });

  it('returns undefined when the origin is unreadable', async () => {
    expect(await resolveAoneWorkspaceRepo(repo)).toBeUndefined();
  });

  it('returns undefined outside a git repository', async () => {
    const bare = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-aone-bare-'));
    try {
      expect(await resolveAoneWorkspaceRepo(bare)).toBeUndefined();
    } finally {
      await fsp.rm(bare, { recursive: true, force: true });
    }
  });

  it('finds the repository root from a nested workspace cwd', async () => {
    execSync(
      'git remote add origin git@gitlab.alibaba-inc.com:jspt/agentic_coding.git',
      { cwd: repo, stdio: 'pipe' },
    );
    const nested = path.join(repo, 'deep', 'workspace');
    await fsp.mkdir(nested, { recursive: true });
    const resolved = await resolveAoneWorkspaceRepo(nested);
    expect(resolved?.gitRoot).toBe(path.resolve(repo));
    expect(resolved?.repoPath).toBe('jspt/agentic_coding');
  });
});

describe('parseAoneMrListPage', () => {
  function mrEntry(id: number, overrides: Record<string, unknown> = {}) {
    return {
      id,
      // Deliberately distinct from the global id: `number` must map from
      // Aone's global `id`, never the project-local `iid` (the codereview
      // URL and `mr view` both key on the global one).
      iid: id + 1000,
      state: 'opened',
      sourceBranch: `feature/${id}`,
      detailUrl: '',
      ...overrides,
    };
  }

  it('maps entries onto the slim shape', () => {
    const entries = parseAoneMrListPage([
      mrEntry(1, { state: 'merged' }),
      mrEntry(2, { state: 'reopened' }),
      mrEntry(3, { state: 'accepted' }),
    ]);
    expect(entries).toEqual([
      { number: 1, headRefName: 'feature/1', state: 'merged' },
      { number: 2, headRefName: 'feature/2', state: 'open' },
      { number: 3, headRefName: 'feature/3', state: 'open' },
    ]);
  });

  it('skips malformed entries', () => {
    const entries = parseAoneMrListPage([
      mrEntry(1),
      { id: 'not-a-number', state: 'merged' },
      { id: 0, state: 'merged' },
      { id: 1.5, state: 'merged' },
      null,
      mrEntry(2, { sourceBranch: 42, state: 'unknown-state' }),
    ]);
    expect(entries).toEqual([
      { number: 1, headRefName: 'feature/1', state: 'open' },
      { number: 2, headRefName: '', state: 'open' },
    ]);
  });

  it('refuses a non-array body', () => {
    expect(() => parseAoneMrListPage({ unexpected: true })).toThrow(
      AoneCommandError,
    );
  });
});

describe('parseAoneMrView', () => {
  const DETAIL_URL =
    'https://code.alibaba-inc.com/jspt/agentic_coding/codereview/26430560';

  it('extracts the detailUrl and mapped state', () => {
    const view = parseAoneMrView(
      {
        mergeRequest: {
          state: 'merged',
          detailUrl: DETAIL_URL,
          sourceBranch: 'yongxun',
        },
      },
      26430560,
    );
    expect(view).toEqual({
      number: 26430560,
      url: DETAIL_URL,
      state: 'merged',
    });
  });

  it('refuses a view without a usable detailUrl', () => {
    expect(() =>
      parseAoneMrView({ mergeRequest: { state: 'opened', detailUrl: '' } }, 1),
    ).toThrow(AoneCommandError);
    expect(() =>
      parseAoneMrView(
        { mergeRequest: { state: 'opened', detailUrl: 'javascript:alert(1)' } },
        1,
      ),
    ).toThrow(AoneCommandError);
  });

  it('refuses a body without mergeRequest', () => {
    expect(() => parseAoneMrView({}, 1)).toThrow(AoneCommandError);
    expect(() => parseAoneMrView(null, 1)).toThrow(AoneCommandError);
  });
});

describe('the a1 exec layer', () => {
  // The seam substitutes the a1 SPAWN (not the parsers), pinning the error
  // contract — parsed shape over exit code, ENOENT mapping, version floor —
  // without vi.mock('node:child_process').
  afterEach(() => {
    setA1ExecForTest();
  });

  const HEALTHY_VERSION = { stdout: 'a1 version 9.9.9' };

  it('treats an exit-0 a1.error/v1 body as a command error', async () => {
    setA1ExecForTest(async (args) =>
      args.includes('--version')
        ? HEALTHY_VERSION
        : {
            stdout: JSON.stringify({
              schemaVersion: 'a1.error/v1',
              message: 'repo not found',
            }),
          },
    );

    const attempt = viewAoneMergeRequest('g/p', 1);
    await expect(attempt).rejects.toBeInstanceOf(AoneCommandError);
    await expect(attempt).rejects.toThrow('repo not found');
  });

  it('reads the structured cause off an exit-1 stdout', async () => {
    setA1ExecForTest(async (args) => {
      if (args.includes('--version')) return HEALTHY_VERSION;
      throw Object.assign(new Error('a1 exited with code 1'), {
        stdout: JSON.stringify({
          schemaVersion: 'a1.error/v1',
          message: 'structured cause',
        }),
      });
    });

    await expect(
      listAoneMergeRequests('g/p', { state: 'opened', pages: 1 }),
    ).rejects.toThrow('structured cause');
  });

  it('refuses non-JSON stdout as a command error', async () => {
    setA1ExecForTest(async (args) =>
      args.includes('--version')
        ? HEALTHY_VERSION
        : { stdout: 'login page html, not json' },
    );

    await expect(viewAoneMergeRequest('g/p', 1)).rejects.toThrow(
      'a1 returned non-JSON output',
    );
  });

  it('maps a missing a1 binary onto the unavailable error', async () => {
    setA1ExecForTest(async () => {
      throw Object.assign(new Error('spawn a1 ENOENT'), { code: 'ENOENT' });
    });

    await expect(
      listAoneMergeRequests('g/p', { state: 'opened', pages: 1 }),
    ).rejects.toThrow(AoneCliUnavailableError);
  });

  it('maps ENOENT on the read itself onto the unavailable error', async () => {
    setA1ExecForTest(async (args) => {
      if (args.includes('--version')) return HEALTHY_VERSION;
      throw Object.assign(new Error('spawn a1 ENOENT'), { code: 'ENOENT' });
    });

    await expect(viewAoneMergeRequest('g/p', 7)).rejects.toThrow(
      AoneCliUnavailableError,
    );
  });

  it('rejects a below-floor a1 before any mr read', async () => {
    const calls: string[][] = [];
    setA1ExecForTest(async (args) => {
      calls.push([...args]);
      return args.includes('--version')
        ? { stdout: 'a1 version 0.1.0 (2026-01-01)' }
        : { stdout: JSON.stringify([]) };
    });

    await expect(
      listAoneMergeRequests('g/p', { state: 'opened', pages: 1 }),
    ).rejects.toThrow(AoneCliUnavailableError);
    expect(calls).toEqual([['--version']]);
  });

  it('re-probes the version after a failed probe instead of memoizing it', async () => {
    let probes = 0;
    setA1ExecForTest(async (args) => {
      if (args.includes('--version')) {
        probes += 1;
        if (probes === 1) {
          throw Object.assign(new Error('a1 --version timed out'), {
            killed: true,
          });
        }
        return { stdout: 'a1 version 0.1.0' };
      }
      return { stdout: JSON.stringify([]) };
    });

    // First read: the probe fails and the read fails open.
    await expect(
      listAoneMergeRequests('g/p', { state: 'opened', pages: 1 }),
    ).resolves.toEqual([]);
    // Second read: the re-probe succeeds and the below-floor version rules.
    await expect(
      listAoneMergeRequests('g/p', { state: 'opened', pages: 1 }),
    ).rejects.toThrow(AoneCliUnavailableError);
    expect(probes).toBe(2);
  });

  it('stops paging at a short page', async () => {
    const listCalls: string[][] = [];
    setA1ExecForTest(async (args) => {
      if (args.includes('--version')) return HEALTHY_VERSION;
      listCalls.push([...args]);
      return {
        stdout: JSON.stringify([
          { id: 1, state: 'opened', sourceBranch: 'b-1' },
          { id: 2, state: 'opened', sourceBranch: 'b-2' },
        ]),
      };
    });

    const entries = await listAoneMergeRequests('g/p', {
      state: 'opened',
      pages: AONE_BACKFILL_PAGES_PER_STATE,
    });

    expect(entries).toEqual([
      { number: 1, headRefName: 'b-1', state: 'open' },
      { number: 2, headRefName: 'b-2', state: 'open' },
    ]);
    // 2 entries < the server-fixed page size of 20: no further page.
    expect(listCalls).toHaveLength(1);
  });
});
