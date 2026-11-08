/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { getSubagentSessionDir } from '@qwen-code/qwen-code-core/agents/agent-transcript.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import type { SendBridgeError } from '../server/error-response.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';
import { registerSessionPostedCommentsRoutes } from './session-posted-comments.js';

vi.mock('../workspace-runtime-storage.js', () => ({
  createWorkspaceRuntimeSessionService: vi.fn(),
  runWithWorkspaceRuntimeStorage: vi.fn(
    (_runtime: unknown, fn: () => unknown) => fn(),
  ),
}));
vi.mock('@qwen-code/qwen-code-core/config/storage.js', () => ({
  Storage: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/agents/agent-transcript.js', () => ({
  getSubagentSessionDir: vi.fn(),
}));

const mockSessionService = vi.mocked(createWorkspaceRuntimeSessionService);
const mockStorage = vi.mocked(Storage);
const mockSubagentDir = vi.mocked(getSubagentSessionDir);

const SESSION_ID = '7bddc58f-df4d-4546-a92b-afa88527483e';

function shellCreationEntry(commentId: number): string {
  return JSON.stringify({
    type: 'tool_result',
    message: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'run_shell_command',
            response: {
              output: `Command: gh pr comment 1 --body a\nDirectory: (root)\nOutput: https://github.com/o/r/pull/1#issuecomment-${commentId}\nError: (none)\nExit Code: 0\n`,
            },
          },
        },
      ],
    },
  });
}

function appWithRuntime(runtime: unknown): express.Express {
  const app = express();
  const registry = {
    getEntryByWorkspaceCwd: vi.fn(() =>
      runtime ? { current: { runtime } } : undefined,
    ),
  };
  registerSessionPostedCommentsRoutes(app, {
    workspaceRegistry: registry as unknown as WorkspaceRegistry,
    sendBridgeError: ((
      res: { status: (n: number) => { json: (b: unknown) => void } },
      err: unknown,
    ) => {
      res.status(500).json({ error: String(err) });
    }) as unknown as SendBridgeError,
  });
  return app;
}

describe('GET /sessions/:id/posted-comments', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'posted-comments-route-'));
    mockSessionService.mockReset();
    mockStorage.mockReset();
    mockSubagentDir.mockReset();
    mockStorage.mockImplementation(
      () => ({ getProjectDir: () => dir }) as never,
    );
    // Default: a subagent directory that does not exist (no delegated posts).
    mockSubagentDir.mockReturnValue(join(dir, 'subagents', SESSION_ID));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects an invalid session id', async () => {
    const app = appWithRuntime({ trusted: true, primary: false });
    const res = await request(app).get('/sessions/not-a-uuid/posted-comments');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_session_id');
    expect(mockSessionService).not.toHaveBeenCalled();
  });

  it('answers empty when no workspace cwd is given', async () => {
    const app = appWithRuntime({ trusted: true, primary: false });
    const res = await request(app).get(
      `/sessions/${SESSION_ID}/posted-comments`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ids: [] });
    expect(mockSessionService).not.toHaveBeenCalled();
  });

  it('answers empty for an untrusted workspace without reading its transcript', async () => {
    const app = appWithRuntime({ trusted: false, primary: false });
    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/posted-comments`)
      .query({ workspaceCwd: '/ws/untrusted' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ids: [] });
    // The trust gate must short-circuit before the session service is touched.
    expect(mockSessionService).not.toHaveBeenCalled();
  });

  it('answers empty for an unknown workspace', async () => {
    const app = appWithRuntime(undefined);
    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/posted-comments`)
      .query({ workspaceCwd: '/ws/unknown' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ids: [] });
    expect(mockSessionService).not.toHaveBeenCalled();
  });

  it('returns the posted ids for a trusted workspace', async () => {
    const transcript = join(dir, `${SESSION_ID}.jsonl`);
    writeFileSync(transcript, shellCreationEntry(42) + '\n');
    mockSessionService.mockReturnValue({
      sessionPrSidecarBelongsToCurrentProject: async () => true,
      getSessionTranscriptPath: () => transcript,
    } as never);
    const app = appWithRuntime({ trusted: true, primary: false });
    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/posted-comments`)
      .query({ workspaceCwd: '/ws/trusted' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ids: ['ic:42'] });
  });

  it('attributes a comment posted only in a subagent transcript', async () => {
    // A delegated post is still the session's own comment; reading only the
    // session transcript would echo it back. The subagent transcript carries
    // the creation result.
    const transcript = join(dir, `${SESSION_ID}.jsonl`);
    writeFileSync(transcript, '');
    const subagentDir = join(dir, 'subagents', SESSION_ID);
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, 'agent-a1.jsonl'),
      shellCreationEntry(777) + '\n',
    );
    mockSubagentDir.mockReturnValue(subagentDir);
    mockSessionService.mockReturnValue({
      sessionPrSidecarBelongsToCurrentProject: async () => true,
      getSessionTranscriptPath: () => transcript,
    } as never);
    const app = appWithRuntime({ trusted: true, primary: false });
    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/posted-comments`)
      .query({ workspaceCwd: '/ws/trusted' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ids: ['ic:777'] });
  });

  it('answers empty for a session belonging to a different project', async () => {
    mockSessionService.mockReturnValue({
      sessionPrSidecarBelongsToCurrentProject: async () => false,
      getSessionTranscriptPath: () => join(dir, `${SESSION_ID}.jsonl`),
    } as never);
    const app = appWithRuntime({ trusted: true, primary: false });
    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/posted-comments`)
      .query({ workspaceCwd: '/ws/trusted' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ids: [] });
  });
});
