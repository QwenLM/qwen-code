/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
  createWorkspaceRegistry,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  registerWorkspaceGitDiffRoutes,
  registerWorkspaceQualifiedGitDiffRoutes,
} from './workspace-git-diff.js';

vi.mock('@qwen-code/qwen-code-core', () => ({
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
