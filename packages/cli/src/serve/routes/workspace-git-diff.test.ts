/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchGitDiff,
  fetchGitDiffHunksForFile,
} from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { sendBridgeError } from '../server/error-response.js';
import {
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  registerWorkspaceGitDiffRoutes,
  registerWorkspaceQualifiedGitDiffRoutes,
} from './workspace-git-diff.js';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  fetchGitDiff: vi.fn(),
  fetchGitDiffHunksForFile: vi.fn(),
}));

const fetchGitDiffMock = vi.mocked(fetchGitDiff);
const fetchGitDiffHunksForFileMock = vi.mocked(fetchGitDiffHunksForFile);

function runtime(
  workspaceId: string,
  workspaceCwd: string,
  trusted: boolean,
): WorkspaceRuntime {
  return {
    workspaceId,
    workspaceCwd,
    primary: workspaceId === 'primary',
    trusted,
    bridge: { publishWorkspaceEvent: vi.fn() } as unknown as AcpSessionBridge,
  } as WorkspaceRuntime;
}

function registry(runtimes: WorkspaceRuntime[]): WorkspaceRegistry {
  return createWorkspaceRegistry(runtimes);
}

describe('workspace Git diff routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the diff file list for the bound workspace', async () => {
    fetchGitDiffMock.mockResolvedValue({
      stats: { filesCount: 2, linesAdded: 5, linesRemoved: 1 },
      perFileStats: new Map([
        ['src/a.ts', { added: 4, removed: 1, isBinary: false }],
        [
          'new.txt',
          { added: 1, removed: 0, isBinary: false, isUntracked: true },
        ],
      ]),
    });
    const app = express();
    registerWorkspaceGitDiffRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    const response = await request(app).get('/workspace/git/diff');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      v: 1,
      workspaceCwd: '/work/main',
      available: true,
      filesCount: 2,
      linesAdded: 5,
      linesRemoved: 1,
      files: [
        {
          path: 'src/a.ts',
          added: 4,
          removed: 1,
          isBinary: false,
          isUntracked: false,
          isDeleted: false,
          truncated: false,
        },
        {
          path: 'new.txt',
          added: 1,
          removed: 0,
          isBinary: false,
          isUntracked: true,
          isDeleted: false,
          truncated: false,
        },
      ],
      hiddenCount: 0,
    });
    expect(fetchGitDiffMock).toHaveBeenCalledWith('/work/main');
  });

  it('carries the pre-rename oldPath through the file list', async () => {
    fetchGitDiffMock.mockResolvedValue({
      stats: { filesCount: 1, linesAdded: 2, linesRemoved: 1 },
      perFileStats: new Map([
        [
          'src/new.ts',
          { added: 2, removed: 1, isBinary: false, oldPath: 'src/old.ts' },
        ],
      ]),
    });
    const app = express();
    registerWorkspaceGitDiffRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    const response = await request(app).get('/workspace/git/diff');

    expect(response.status).toBe(200);
    // The rename must survive serialization keyed by the new path with the old
    // path carried alongside, so both the Web Shell dialog and CLI can render
    // `old → new`.
    expect(response.body.files).toEqual([
      {
        path: 'src/new.ts',
        oldPath: 'src/old.ts',
        added: 2,
        removed: 1,
        isBinary: false,
        isUntracked: false,
        isDeleted: false,
        truncated: false,
      },
    ]);
  });

  it('reports available=false when the bound workspace is not a repo', async () => {
    fetchGitDiffMock.mockResolvedValue(null);
    const app = express();
    registerWorkspaceGitDiffRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    const response = await request(app).get('/workspace/git/diff');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ available: false, files: [] });
  });

  it('forwards a selected diff source to list and file reads', async () => {
    fetchGitDiffMock.mockResolvedValue({
      stats: { filesCount: 0, linesAdded: 0, linesRemoved: 0 },
      perFileStats: new Map(),
    });
    fetchGitDiffHunksForFileMock.mockResolvedValue({
      hunks: [],
      truncated: false,
    });
    const app = express();
    registerWorkspaceGitDiffRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    expect(
      (await request(app).get('/workspace/git/diff?mode=branch&ref=topic'))
        .status,
    ).toBe(200);
    expect(fetchGitDiffMock).toHaveBeenCalledWith('/work/main', {
      mode: 'branch',
      ref: 'topic',
    });

    expect(
      (await request(app).get('/workspace/git/diff?mode=staged')).status,
    ).toBe(200);
    expect(fetchGitDiffMock).toHaveBeenLastCalledWith('/work/main', {
      mode: 'staged',
    });
    expect(
      (await request(app).get('/workspace/git/diff?mode=unstaged')).status,
    ).toBe(200);
    expect(fetchGitDiffMock).toHaveBeenLastCalledWith('/work/main', {
      mode: 'unstaged',
    });

    expect(
      (
        await request(app).get(
          '/workspace/git/diff/file?path=a.ts&oldPath=old-a.ts&mode=commit&ref=abc1234',
        )
      ).status,
    ).toBe(200);
    expect(fetchGitDiffHunksForFileMock).toHaveBeenCalledWith(
      '/work/main',
      'a.ts',
      'old-a.ts',
      { mode: 'commit', ref: 'abc1234' },
    );
  });

  it('trims whitespace-padded refs before forwarding them', async () => {
    fetchGitDiffMock.mockResolvedValue({
      stats: { filesCount: 0, linesAdded: 0, linesRemoved: 0 },
      perFileStats: new Map(),
    });
    const app = express();
    registerWorkspaceGitDiffRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    const response = await request(app).get(
      '/workspace/git/diff?mode=commit&ref=%20topic%20',
    );

    expect(response.status).toBe(200);
    expect(fetchGitDiffMock).toHaveBeenCalledWith('/work/main', {
      mode: 'commit',
      ref: 'topic',
    });
  });

  it('accepts an explicit mode=uncommitted', async () => {
    fetchGitDiffMock.mockResolvedValue({
      stats: { filesCount: 0, linesAdded: 0, linesRemoved: 0 },
      perFileStats: new Map(),
    });
    const app = express();
    registerWorkspaceGitDiffRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    const response = await request(app).get(
      '/workspace/git/diff?mode=uncommitted',
    );

    expect(response.status).toBe(200);
    expect(fetchGitDiffMock).toHaveBeenCalledWith('/work/main', {
      mode: 'uncommitted',
    });
  });

  it('rejects invalid diff source queries on the file route', async () => {
    const app = express();
    registerWorkspaceGitDiffRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    expect(
      (await request(app).get('/workspace/git/diff/file?path=a.ts&mode=commit'))
        .status,
    ).toBe(400);
    expect(
      (
        await request(app).get(
          '/workspace/git/diff/file?path=a.ts&mode=garbage&ref=main',
        )
      ).status,
    ).toBe(400);
    expect(fetchGitDiffHunksForFileMock).not.toHaveBeenCalled();
  });

  it('rejects invalid diff source queries', async () => {
    const app = express();
    registerWorkspaceGitDiffRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    expect(
      (await request(app).get('/workspace/git/diff?mode=commit')).status,
    ).toBe(400);
    expect(
      (await request(app).get('/workspace/git/diff?mode=commit&ref=%20'))
        .status,
    ).toBe(400);
    expect(
      (await request(app).get('/workspace/git/diff?ref=topic')).status,
    ).toBe(400);
    expect(
      (await request(app).get('/workspace/git/diff?mode=unknown')).status,
    ).toBe(400);
    expect(
      (await request(app).get('/workspace/git/diff?mode=staged&ref=main'))
        .status,
    ).toBe(400);
    expect(fetchGitDiffMock).not.toHaveBeenCalled();
  });

  it('rejects legacy reads when the live primary workspace is untrusted', async () => {
    const app = express();
    registerWorkspaceGitDiffRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
      isWorkspaceTrusted: () => false,
    });

    const response = await request(app).get('/workspace/git/diff');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('untrusted_workspace');
    expect(fetchGitDiffMock).not.toHaveBeenCalled();
  });

  it('rejects legacy reads captured from a closed generation', async () => {
    const generationGuard = createWorkspaceGenerationGuard();
    generationGuard.close();
    const app = express();
    registerWorkspaceGitDiffRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
      captureGenerationAssertion: () => () => generationGuard.assertOpen(),
    });

    const response = await request(app).get('/workspace/git/diff');

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('workspace_runtime_unavailable');
    expect(fetchGitDiffMock).not.toHaveBeenCalled();
  });

  it('returns single-file hunks for the bound workspace', async () => {
    fetchGitDiffHunksForFileMock.mockResolvedValue({
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: ['-one', '+ONE', ' two'],
        },
      ],
      truncated: false,
    });
    const app = express();
    registerWorkspaceGitDiffRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    const response = await request(app).get(
      '/workspace/git/diff/file?path=src/a.ts',
    );

    expect(response.status).toBe(200);
    // `truncated` is intentionally ABSENT (not false) on an untruncated diff.
    expect(response.body).toEqual({
      v: 1,
      workspaceCwd: '/work/main',
      path: 'src/a.ts',
      available: true,
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: ['-one', '+ONE', ' two'],
        },
      ],
    });
    expect(fetchGitDiffHunksForFileMock).toHaveBeenCalledWith(
      '/work/main',
      'src/a.ts',
      undefined,
    );
  });

  it('forwards the oldPath query to fetchGitDiffHunksForFile', async () => {
    fetchGitDiffHunksForFileMock.mockResolvedValue({
      hunks: [],
      truncated: false,
    });
    const app = express();
    registerWorkspaceGitDiffRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    const response = await request(app).get(
      '/workspace/git/diff/file?path=src/new.ts&oldPath=src/old.ts',
    );

    expect(response.status).toBe(200);
    // The route must parse ?oldPath= and forward it so the core diff is
    // computed old→new (rename detection) instead of new-path-as-added.
    expect(fetchGitDiffHunksForFileMock).toHaveBeenCalledWith(
      '/work/main',
      'src/new.ts',
      'src/old.ts',
    );
  });

  it('surfaces a traversal oldPath as unavailable via core normalization', async () => {
    // The route forwards oldPath verbatim; fetchGitDiffHunksForFile rejects `..`
    // traversal (returns null) and the route surfaces that as available:false
    // rather than erroring or escaping the workspace.
    fetchGitDiffHunksForFileMock.mockResolvedValue(null);
    const app = express();
    registerWorkspaceGitDiffRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    const response = await request(app).get(
      '/workspace/git/diff/file?path=ok.ts&oldPath=../../etc/passwd',
    );

    expect(response.status).toBe(200);
    expect(fetchGitDiffHunksForFileMock).toHaveBeenCalledWith(
      '/work/main',
      'ok.ts',
      '../../etc/passwd',
    );
    expect(response.body.available).toBe(false);
    expect(response.body.hunks).toEqual([]);
  });

  it('surfaces the truncated flag when the diff was capped', async () => {
    fetchGitDiffHunksForFileMock.mockResolvedValue({
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ['+head'],
        },
      ],
      truncated: true,
    });
    const app = express();
    registerWorkspaceGitDiffRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    const response = await request(app).get(
      '/workspace/git/diff/file?path=big.txt',
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ available: true, truncated: true });
  });

  it('reports available=false when the file has no diff', async () => {
    fetchGitDiffHunksForFileMock.mockResolvedValue(null);
    const app = express();
    registerWorkspaceGitDiffRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    const response = await request(app).get(
      '/workspace/git/diff/file?path=src/a.ts',
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ available: false, hunks: [] });
  });

  it('rejects a missing path query with 400', async () => {
    const app = express();
    registerWorkspaceGitDiffRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    const response = await request(app).get('/workspace/git/diff/file');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ errorKind: 'parse_error' });
    expect(fetchGitDiffHunksForFileMock).not.toHaveBeenCalled();
  });

  it('uses the selected trusted workspace runtime for the file route', async () => {
    fetchGitDiffHunksForFileMock.mockResolvedValue({
      hunks: [],
      truncated: false,
    });
    const app = express();
    const primary = runtime('primary', '/work/main', true);
    const secondary = runtime('secondary', '/work/secondary', true);
    registerWorkspaceQualifiedGitDiffRoutes(app, {
      workspaceRegistry: registry([primary, secondary]),
      sendBridgeError,
    });

    const response = await request(app).get(
      '/workspaces/secondary/git/diff/file?path=b.ts',
    );

    expect(response.status).toBe(200);
    expect(fetchGitDiffHunksForFileMock).toHaveBeenCalledWith(
      '/work/secondary',
      'b.ts',
      undefined,
    );
  });

  it('keeps source selection inside the selected runtime', async () => {
    fetchGitDiffMock.mockResolvedValue({
      stats: { filesCount: 0, linesAdded: 0, linesRemoved: 0 },
      perFileStats: new Map(),
    });
    // A REAL workspace directory with a wt/ subdirectory: resolveContainedCwd
    // must resolve the ?cwd parameter to it. With a non-existent ?cwd the
    // resolver falls back to the runtime root, and the assertion below could
    // not tell containment apart from the fallback.
    // realpath the tmpdir root: the route resolves ?cwd through
    // fs.realpathSync, and on macOS os.tmpdir() is /var/folders/… while
    // realpath yields /private/var/folders/… — the raw paths would never
    // match there.
    const workspaceRoot = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'qwen-git-diff-route-')),
    );
    const containedCwd = path.join(workspaceRoot, 'wt');
    mkdirSync(containedCwd);
    try {
      const app = express();
      const primary = runtime('primary', '/work/main', true);
      const secondary = runtime('secondary', workspaceRoot, true);
      registerWorkspaceQualifiedGitDiffRoutes(app, {
        workspaceRegistry: registry([primary, secondary]),
        sendBridgeError,
      });

      const response = await request(app).get(
        `/workspaces/secondary/git/diff?cwd=${encodeURIComponent(containedCwd)}&mode=branch&ref=topic`,
      );

      expect(response.status).toBe(200);
      expect(fetchGitDiffMock).toHaveBeenCalledWith(containedCwd, {
        mode: 'branch',
        ref: 'topic',
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects an untrusted workspace before diffing', async () => {
    const app = express();
    const primary = runtime('primary', '/work/main', true);
    const untrusted = runtime('untrusted', '/work/untrusted', false);
    registerWorkspaceQualifiedGitDiffRoutes(app, {
      workspaceRegistry: registry([primary, untrusted]),
      sendBridgeError,
    });

    const response = await request(app).get('/workspaces/untrusted/git/diff');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('untrusted_workspace');
    expect(fetchGitDiffMock).not.toHaveBeenCalled();
  });

  it('does not return a diff after the selected generation closes', async () => {
    let releaseDiff!: (value: Awaited<ReturnType<typeof fetchGitDiff>>) => void;
    const pendingDiff = new Promise<Awaited<ReturnType<typeof fetchGitDiff>>>(
      (resolve) => {
        releaseDiff = resolve;
      },
    );
    fetchGitDiffMock.mockReturnValue(pendingDiff);
    const generationGuard = createWorkspaceGenerationGuard();
    const primary = runtime('primary', '/work/main', true);
    const secondary = {
      ...runtime('secondary', '/work/secondary', true),
      generationGuard,
    };
    const app = express();
    registerWorkspaceQualifiedGitDiffRoutes(app, {
      workspaceRegistry: registry([primary, secondary]),
      sendBridgeError,
    });

    const response = request(app)
      .get('/workspaces/secondary/git/diff')
      .then((result) => result);
    await vi.waitFor(() => expect(fetchGitDiffMock).toHaveBeenCalledOnce());
    generationGuard.close();
    releaseDiff(null);
    const result = await response;

    expect(result.status).toBe(503);
    expect(result.body.code).toBe('workspace_runtime_unavailable');
  });

  it('rejects an untrusted workspace on the single-file endpoint too', async () => {
    const app = express();
    const primary = runtime('primary', '/work/main', true);
    const untrusted = runtime('untrusted', '/work/untrusted', false);
    registerWorkspaceQualifiedGitDiffRoutes(app, {
      workspaceRegistry: registry([primary, untrusted]),
      sendBridgeError,
    });

    const response = await request(app).get(
      '/workspaces/untrusted/git/diff/file?path=a.ts',
    );

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('untrusted_workspace');
    expect(fetchGitDiffHunksForFileMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown workspace', async () => {
    const app = express();
    const primary = runtime('primary', '/work/main', true);
    registerWorkspaceQualifiedGitDiffRoutes(app, {
      workspaceRegistry: registry([primary]),
      sendBridgeError,
    });

    const response = await request(app).get('/workspaces/missing/git/diff');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'workspace_mismatch' });
  });
});
