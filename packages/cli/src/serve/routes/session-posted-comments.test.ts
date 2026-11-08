/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import type { SendBridgeError } from '../server/error-response.js';
import { createWorkspaceRuntimeSessionService } from '../workspace-runtime-storage.js';
import { registerSessionPostedCommentsRoutes } from './session-posted-comments.js';

vi.mock('../workspace-runtime-storage.js', () => ({
  createWorkspaceRuntimeSessionService: vi.fn(),
}));

const mockSessionService = vi.mocked(createWorkspaceRuntimeSessionService);

const SESSION_ID = '7bddc58f-df4d-4546-a92b-afa88527483e';

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
    const entry = {
      type: 'tool_result',
      message: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'run_shell_command',
              response: {
                output:
                  'Command: gh pr comment 1 --body a\nDirectory: (root)\nOutput: https://github.com/o/r/pull/1#issuecomment-42\nError: (none)\nExit Code: 0\n',
              },
            },
          },
        ],
      },
    };
    writeFileSync(transcript, JSON.stringify(entry) + '\n');
    mockSessionService.mockReturnValue({
      getPrSessionPathForArchiveState: () => join(dir, `${SESSION_ID}.pr.json`),
    } as never);
    const app = appWithRuntime({ trusted: true, primary: false });
    const res = await request(app)
      .get(`/sessions/${SESSION_ID}/posted-comments`)
      .query({ workspaceCwd: '/ws/trusted' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ids: ['ic:42'] });
  });
});
