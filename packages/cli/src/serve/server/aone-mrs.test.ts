/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `vi.mock('node:child_process')` cannot intercept in this package (see
// git-branch-ops.test.ts), so detection runs the real git binary against
// throwaway repositories and the a1 body parsing is exercised through its
// exported pure functions; the exec layer itself is covered by the E2E
// plan (.qwen/e2e-tests/aone-session-pr.md).

import { execSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AoneCommandError,
  mapAoneMrState,
  parseAoneMrListPage,
  parseAoneMrView,
  resolveAoneWorkspaceRepo,
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
