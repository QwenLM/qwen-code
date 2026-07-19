/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchGitLog, fetchGitCommitDetail } from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { sendBridgeError } from '../server/error-response.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  registerWorkspaceGitLogRoutes,
  registerWorkspaceQualifiedGitLogRoutes,
} from './workspace-git-log.js';

vi.mock('@qwen-code/qwen-code-core', () => ({
  fetchGitLog: vi.fn(),
  fetchGitCommitDetail: vi.fn(),
  MAX_LOG_LIMIT: 200,
  DEFAULT_LOG_LIMIT: 50,
}));

const fetchGitLogMock = vi.mocked(fetchGitLog);
const fetchGitCommitDetailMock = vi.mocked(fetchGitCommitDetail);

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

const ENTRY = {
  sha: 'abcdef1234567890abcdef1234567890abcdef12',
  shortSha: 'abcdef1',
  authorName: 'Test',
  authorEmail: 't@example.com',
  authorDate: 1_700_000_000,
  subject: 'do a thing',
  refs: 'HEAD -> main',
  parents: ['0000000000000000000000000000000000000000'],
};

describe('workspace Git log routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the commit list for the bound workspace', async () => {
    fetchGitLogMock.mockResolvedValue({ entries: [ENTRY], hasMore: true });
    const app = express();
    registerWorkspaceGitLogRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    const response = await request(app).get('/workspace/git/log');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      v: 1,
      workspaceCwd: '/work/main',
      available: true,
      hasMore: true,
      entries: [
        {
          sha: ENTRY.sha,
          shortSha: 'abcdef1',
          subject: 'do a thing',
          refs: 'HEAD -> main',
          parents: ENTRY.parents,
        },
      ],
    });
  });

  it('reports available=false when the workspace is not a git repo', async () => {
    fetchGitLogMock.mockResolvedValue(null);
    const app = express();
    registerWorkspaceGitLogRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    const response = await request(app).get('/workspace/git/log');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      available: false,
      entries: [],
      hasMore: false,
    });
  });

  it('clamps limit to MAX_LOG_LIMIT and passes skip through', async () => {
    fetchGitLogMock.mockResolvedValue({ entries: [], hasMore: false });
    const app = express();
    registerWorkspaceGitLogRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    await request(app).get('/workspace/git/log?limit=9999&skip=30');

    expect(fetchGitLogMock).toHaveBeenCalledWith('/work/main', {
      limit: 200,
      skip: 30,
    });
  });

  it('falls back to the default limit for a non-numeric limit', async () => {
    fetchGitLogMock.mockResolvedValue({ entries: [], hasMore: false });
    const app = express();
    registerWorkspaceGitLogRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    await request(app).get('/workspace/git/log?limit=abc');

    expect(fetchGitLogMock).toHaveBeenCalledWith('/work/main', {
      limit: 50,
      skip: 0,
    });
  });

  it('returns commit detail for a valid sha', async () => {
    fetchGitCommitDetailMock.mockResolvedValue({
      ...ENTRY,
      body: 'the body',
      files: [{ path: 'a.ts', added: 3, removed: 1, isBinary: false }],
      filesCount: 1,
      linesAdded: 3,
      linesRemoved: 1,
      hiddenCount: 0,
    });
    const app = express();
    registerWorkspaceGitLogRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    const response = await request(app).get(
      `/workspace/git/log/commit?sha=${ENTRY.shortSha}`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      available: true,
      sha: ENTRY.sha,
      body: 'the body',
      files: [{ path: 'a.ts', added: 3, removed: 1, isBinary: false }],
      filesCount: 1,
    });
    expect(fetchGitCommitDetailMock).toHaveBeenCalledWith(
      '/work/main',
      ENTRY.shortSha,
    );
  });

  it('rejects a missing sha with 400', async () => {
    const app = express();
    registerWorkspaceGitLogRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    const response = await request(app).get('/workspace/git/log/commit');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ errorKind: 'parse_error' });
    expect(fetchGitCommitDetailMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed (non-hex) sha with 400, distinct from a valid miss', async () => {
    const app = express();
    registerWorkspaceGitLogRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    const response = await request(app).get(
      '/workspace/git/log/commit?sha=not-hex',
    );

    // A 400 (not a 200 available:false) is what lets the client distinguish a
    // bad request from a valid lookup that found no commit.
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ errorKind: 'parse_error' });
    expect(fetchGitCommitDetailMock).not.toHaveBeenCalled();
  });

  it('reports available=false for a valid sha with no matching commit', async () => {
    fetchGitCommitDetailMock.mockResolvedValue(null);
    const app = express();
    registerWorkspaceGitLogRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
    });

    const response = await request(app).get(
      '/workspace/git/log/commit?sha=deadbee',
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ available: false });
  });

  it('rejects an untrusted workspace on the qualified routes', async () => {
    const app = express();
    const primary = runtime('primary', '/work/main', true);
    const untrusted = runtime('untrusted', '/work/untrusted', false);
    registerWorkspaceQualifiedGitLogRoutes(app, {
      workspaceRegistry: registry([primary, untrusted]),
      sendBridgeError,
    });

    const list = await request(app).get('/workspaces/untrusted/git/log');
    const detail = await request(app).get(
      '/workspaces/untrusted/git/log/commit?sha=abcdef1',
    );

    expect(list.status).toBe(403);
    expect(detail.status).toBe(403);
    expect(fetchGitLogMock).not.toHaveBeenCalled();
    expect(fetchGitCommitDetailMock).not.toHaveBeenCalled();
  });

  it('uses the selected trusted workspace runtime for the qualified log route', async () => {
    fetchGitLogMock.mockResolvedValue({ entries: [], hasMore: false });
    const app = express();
    const primary = runtime('primary', '/work/main', true);
    const secondary = runtime('secondary', '/work/secondary', true);
    registerWorkspaceQualifiedGitLogRoutes(app, {
      workspaceRegistry: registry([primary, secondary]),
      sendBridgeError,
    });

    const response = await request(app).get('/workspaces/secondary/git/log');

    expect(response.status).toBe(200);
    expect(fetchGitLogMock).toHaveBeenCalledWith('/work/secondary', {
      limit: 50,
      skip: 0,
    });
  });
});
