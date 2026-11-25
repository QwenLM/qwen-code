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
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import {
  createWorkspaceRegistry,
  WorkspaceGenerationClosedError,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  appendWorkspaceInputHistory,
  MAX_WORKSPACE_INPUT_HISTORY_ENTRY_CHARS,
} from '../workspace-input-history.js';
import { runWithWorkspaceRuntimeStorage } from '../workspace-runtime-storage.js';
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
  runtimeBaseDir?: string;
}): WorkspaceRuntime {
  return {
    workspaceId: opts.id,
    workspaceCwd: opts.cwd,
    sessionRuntimeBaseDir: opts.runtimeBaseDir ?? opts.cwd,
    primary: opts.primary ?? false,
    trusted: opts.trusted ?? true,
    generationGuard: {
      close: () => {
        opts.closed = true;
      },
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
    primaryRuntimeBaseDir?: string;
    secondaryRuntimeBaseDir?: string;
    onRegistry?: (registry: ReturnType<typeof createWorkspaceRegistry>) => void;
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
        runtimeBaseDir: opts?.primaryRuntimeBaseDir,
      }),
      fakeRuntime({
        id: 'secondary',
        cwd: secondaryCwd,
        primary: false,
        trusted: true,
        closed: opts?.secondaryClosed,
        runtimeBaseDir: opts?.secondaryRuntimeBaseDir,
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
    opts?.onRegistry?.(workspaceRegistry);
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

  it('waits for an admitted append before evaluating a conditional read', async () => {
    const app = createApp();
    const empty = await request(app).get('/workspace/input-history?kind=shell');
    const filePath = new Storage(primaryCwd, primaryCwd).getHistoryFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(['from-before-crash']));
    const holder = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          import lockfile from 'proper-lockfile';
          await lockfile.lock(process.argv.at(-1), {
            realpath: false,
            stale: 10_000,
            retries: 0,
            onCompromised: () => {},
          });
          process.send('locked');
          setInterval(() => {}, 60_000);
        `,
        filePath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    try {
      const errors: Buffer[] = [];
      holder.stderr?.on('data', (chunk: Buffer) => errors.push(chunk));
      const holderExit = once(holder, 'exit');
      const earlyFailure = holderExit.then(([code, signal]) => {
        throw new Error(
          `holder exited before locking (${code}/${signal}): ${Buffer.concat(errors)}`,
        );
      });
      await Promise.race([once(holder, 'message'), earlyFailure]);
      holder.kill('SIGKILL');
      const [, signal] = await holderExit;
      expect(signal).toBe('SIGKILL');
      const started = performance.now();
      const write = runWithWorkspaceRuntimeStorage(
        fakeRuntime({ id: 'primary', cwd: primaryCwd, primary: true }),
        () => appendWorkspaceInputHistory(primaryCwd, 'shell', 'from desktop'),
      );
      const conditional = request(app)
        .get('/workspace/input-history?kind=shell')
        .set('If-None-Match', empty.headers['etag'] as string);
      const refreshed = await conditional;
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.entries).toEqual([
        'from-before-crash',
        'from desktop',
      ]);
      expect(performance.now() - started).toBeGreaterThan(8_000);
      await write;
    } finally {
      if (!holder.killed) holder.kill('SIGKILL');
    }
  }, 60_000);

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

  it('uses primary and selected runtime base dirs instead of ambient storage', async () => {
    const primaryBase = path.join(scratch, 'primary-runtime-root');
    const secondaryBase = path.join(scratch, 'secondary-runtime-root');
    const app = createApp({
      primaryRuntimeBaseDir: primaryBase,
      secondaryRuntimeBaseDir: secondaryBase,
    });

    await request(app)
      .post('/workspace/input-history')
      .send({ kind: 'prompt', entry: 'primary-runtime-entry' })
      .expect(200);
    await request(app)
      .get('/workspace/input-history?kind=prompt')
      .expect(200)
      .expect((response) => {
        expect(response.body.entries).toEqual(['primary-runtime-entry']);
      });
    await request(app)
      .post('/workspaces/secondary/input-history')
      .send({ kind: 'prompt', entry: 'secondary-runtime-entry' })
      .expect(200);

    for (const [cwd, base, entry] of [
      [primaryCwd, primaryBase, 'primary-runtime-entry'],
      [secondaryCwd, secondaryBase, 'secondary-runtime-entry'],
    ] as const) {
      const storage = new Storage(cwd, base);
      const historyFile = path.join(
        storage.getProjectTempDir(),
        'input_history.json',
      );
      expect(JSON.parse(await fs.readFile(historyFile, 'utf8'))).toEqual([
        entry,
      ]);

      const ambientFile = path.join(
        new Storage(cwd).getProjectTempDir(),
        'input_history.json',
      );
      await expect(fs.access(ambientFile)).rejects.toThrow();
    }
  });

  it('uses the replacement primary runtime storage root', async () => {
    const oldBase = path.join(scratch, 'old-runtime');
    const replacementBase = path.join(scratch, 'replacement-runtime');
    let registry!: ReturnType<typeof createWorkspaceRegistry>;
    const app = createApp({
      primaryRuntimeBaseDir: oldBase,
      onRegistry: (value) => {
        registry = value;
      },
    });
    expect(registry.beginReplacement(registry.primaryEntry, 'review')).toBe(
      true,
    );
    registry.activateReplacement(
      registry.primaryEntry,
      fakeRuntime({
        id: 'primary',
        cwd: primaryCwd,
        primary: true,
        runtimeBaseDir: replacementBase,
      }),
      'review',
    );

    await request(app)
      .post('/workspace/input-history')
      .send({ kind: 'prompt', entry: 'after-replacement' })
      .expect(200);
    await request(app)
      .get('/workspace/input-history?kind=prompt')
      .expect(200)
      .expect((response) => {
        expect(response.body.entries).toEqual(['after-replacement']);
      });
    const replacementFile = path.join(
      new Storage(primaryCwd, replacementBase).getProjectTempDir(),
      'input_history.json',
    );
    expect(JSON.parse(await fs.readFile(replacementFile, 'utf8'))).toEqual([
      'after-replacement',
    ]);
    const oldFile = path.join(
      new Storage(primaryCwd, oldBase).getProjectTempDir(),
      'input_history.json',
    );
    await expect(fs.access(oldFile)).rejects.toThrow();
  });

  it('returns 503 instead of using the old primary during replacement', async () => {
    let registry!: ReturnType<typeof createWorkspaceRegistry>;
    const app = createApp({
      onRegistry: (value) => {
        registry = value;
      },
    });
    expect(registry.beginReplacement(registry.primaryEntry, 'review')).toBe(
      true,
    );

    const response = await request(app).get('/workspace/input-history');
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('workspace_runtime_unavailable');
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
