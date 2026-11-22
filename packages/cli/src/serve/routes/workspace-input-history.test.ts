/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { Request } from 'express';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorkspaceRegistry,
  WorkspaceGenerationClosedError,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { MAX_WORKSPACE_INPUT_HISTORY_ENTRY_CHARS } from '../workspace-input-history.js';
import { registerWorkspaceInputHistoryRoutes } from './workspace-input-history.js';

function safeBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object'
    ? (req.body as Record<string, unknown>)
    : {};
}

function fakeRuntime(opts: {
  id: string;
  cwd: string;
  primary?: boolean;
  trusted?: boolean;
  closed?: boolean;
}): WorkspaceRuntime {
  return {
    workspaceId: opts.id,
    workspaceCwd: opts.cwd,
    primary: opts.primary ?? false,
    trusted: opts.trusted ?? true,
    generationGuard: {
      assertOpen: () => {
        if (opts.closed) {
          throw new WorkspaceGenerationClosedError();
        }
      },
    },
  } as unknown as WorkspaceRuntime;
}

describe('workspace-input-history routes', () => {
  const originalQwenHome = process.env['QWEN_HOME'];
  let scratch: string;
  let primaryCwd: string;
  let secondaryCwd: string;
  let untrustedCwd: string;

  beforeEach(async () => {
    scratch = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-input-history-routes-'),
    );
    const home = path.join(scratch, 'home');
    primaryCwd = path.join(scratch, 'primary');
    secondaryCwd = path.join(scratch, 'secondary');
    untrustedCwd = path.join(scratch, 'untrusted');
    await Promise.all([
      fs.mkdir(home, { recursive: true }),
      fs.mkdir(primaryCwd, { recursive: true }),
      fs.mkdir(secondaryCwd, { recursive: true }),
      fs.mkdir(untrustedCwd, { recursive: true }),
    ]);
    process.env['QWEN_HOME'] = home;
  });

  afterEach(async () => {
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
    await fs.rm(scratch, { recursive: true, force: true });
  });

  function createApp(opts?: {
    primaryClosed?: boolean;
    secondaryClosed?: boolean;
  }) {
    const app = express();
    app.use(express.json());
    const workspaceRegistry = createWorkspaceRegistry([
      fakeRuntime({
        id: 'primary',
        cwd: primaryCwd,
        primary: true,
        trusted: true,
        closed: opts?.primaryClosed,
      }),
      fakeRuntime({
        id: 'secondary',
        cwd: secondaryCwd,
        primary: false,
        trusted: true,
        closed: opts?.secondaryClosed,
      }),
      fakeRuntime({
        id: 'untrusted',
        cwd: untrustedCwd,
        primary: false,
        trusted: false,
      }),
    ]);

    registerWorkspaceInputHistoryRoutes(app, {
      mutate: () => (_req, _res, next) => next(),
      safeBody,
      boundWorkspace: primaryCwd,
      workspaceRegistry,
      captureGenerationAssertion: () => () => {
        if (opts?.primaryClosed) {
          throw new WorkspaceGenerationClosedError();
        }
      },
    });
    return app;
  }

  it('reads and writes prompt and shell history on primary route with ETag/304', async () => {
    const app = createApp();

    const empty = await request(app).get('/workspace/input-history');
    expect(empty.status).toBe(200);
    expect(empty.body.kind).toBe('prompt');
    expect(empty.body.entries).toEqual([]);
    expect(empty.headers['etag']).toBe(`"v1:${empty.body.revision}"`);

    const notModified = await request(app)
      .get('/workspace/input-history')
      .set('If-None-Match', empty.headers['etag'] as string);
    expect(notModified.status).toBe(304);

    const postPrompt = await request(app)
      .post('/workspace/input-history')
      .send({ kind: 'prompt', entry: 'from desktop' });
    expect(postPrompt.status).toBe(200);
    expect(postPrompt.body.entries).toEqual(['from desktop']);

    const postShell = await request(app)
      .post('/workspace/input-history')
      .send({ kind: 'shell', entry: 'git status' });
    expect(postShell.status).toBe(200);
    expect(postShell.body.entries).toEqual(['git status']);

    const afterPrompt = await request(app)
      .get('/workspace/input-history?kind=prompt')
      .set('If-None-Match', empty.headers['etag'] as string);
    expect(afterPrompt.status).toBe(200);
    expect(afterPrompt.body.entries).toEqual(['from desktop']);

    const afterShell = await request(app).get(
      '/workspace/input-history?kind=shell',
    );
    expect(afterShell.status).toBe(200);
    expect(afterShell.body.entries).toEqual(['git status']);
  });

  it('rejects invalid query and body inputs with 400', async () => {
    const app = createApp();

    const badKind = await request(app).get(
      '/workspace/input-history?kind=unknown',
    );
    expect(badKind.status).toBe(400);
    expect(badKind.body.code).toBe('invalid_input_history_kind');

    const badLimit = await request(app).get('/workspace/input-history?limit=0');
    expect(badLimit.status).toBe(400);
    expect(badLimit.body.code).toBe('invalid_limit');

    const emptyEntry = await request(app)
      .post('/workspace/input-history')
      .send({ kind: 'prompt', entry: '   ' });
    expect(emptyEntry.status).toBe(400);
    expect(emptyEntry.body.code).toBe('invalid_entry');

    const tooLong = await request(app)
      .post('/workspace/input-history')
      .send({
        kind: 'prompt',
        entry: 'a'.repeat(MAX_WORKSPACE_INPUT_HISTORY_ENTRY_CHARS + 1),
      });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe('invalid_entry');
  });

  it('scopes workspace-qualified routes to the resolved trusted runtime and never falls back to primary', async () => {
    const app = createApp();

    await request(app)
      .post('/workspace/input-history')
      .send({ kind: 'prompt', entry: 'primary-only' })
      .expect(200);

    await request(app)
      .post('/workspaces/secondary/input-history')
      .send({ kind: 'prompt', entry: 'secondary-only' })
      .expect(200);

    const secondaryRes = await request(app).get(
      '/workspaces/secondary/input-history?kind=prompt',
    );
    expect(secondaryRes.status).toBe(200);
    expect(secondaryRes.body.entries).toEqual(['secondary-only']);

    const primaryRes = await request(app).get(
      '/workspace/input-history?kind=prompt',
    );
    expect(primaryRes.status).toBe(200);
    expect(primaryRes.body.entries).toEqual(['primary-only']);

    const unknownRes = await request(app).get(
      '/workspaces/missing-ws/input-history',
    );
    expect(unknownRes.status).toBe(400);
    expect(unknownRes.body.code).toBe('workspace_mismatch');

    const untrustedGet = await request(app).get(
      '/workspaces/untrusted/input-history',
    );
    expect(untrustedGet.status).toBe(403);

    const untrustedPost = await request(app)
      .post('/workspaces/untrusted/input-history')
      .send({ kind: 'prompt', entry: 'nope' });
    expect(untrustedPost.status).toBe(403);
  });

  it('returns 503 workspace_runtime_unavailable when workspace generation is closed', async () => {
    const app = createApp({ primaryClosed: true, secondaryClosed: true });

    const primaryGet = await request(app).get('/workspace/input-history');
    expect(primaryGet.status).toBe(503);
    expect(primaryGet.body.code).toBe('workspace_runtime_unavailable');

    const secondaryPost = await request(app)
      .post('/workspaces/secondary/input-history')
      .send({ kind: 'prompt', entry: 'blocked' });
    expect(secondaryPost.status).toBe(503);
    expect(secondaryPost.body.code).toBe('workspace_runtime_unavailable');
  });
});
