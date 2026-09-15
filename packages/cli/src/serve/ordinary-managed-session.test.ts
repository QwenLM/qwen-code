/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { ChannelFactory } from '@qwen-code/acp-bridge';
import { SessionService, Storage } from '@qwen-code/qwen-code-core';
import {
  resetEnvironmentTrackingForTesting,
  resetHomeEnvBootstrapForTesting,
} from '../config/environment.js';
import { resetTrustedFoldersForTesting } from '../config/trustedFolders.js';
import { isSlowTestHost } from '../test-utils/slow-test-host.js';
import { canonicalizeWorkspace } from './acp-session-bridge.js';
import { createWorkspaceFileSystemFactory } from './fs/index.js';
import { getServeAppLifecycle } from './serve-app-lifecycle.js';
import { createServeApp } from './server.js';
import type { ServeOptions } from './types.js';

const spawnHarness = vi.hoisted(() => ({ blockLegacySpawn: false }));

vi.mock('@qwen-code/acp-bridge/spawnChannel', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/acp-bridge/spawnChannel')>();
  return {
    ...actual,
    createSpawnChannelFactory: (
      options?: Parameters<typeof actual.createSpawnChannelFactory>[0],
    ) => {
      const inner = actual.createSpawnChannelFactory(options);
      const factory: ChannelFactory = (cwd, env, signal) => {
        if (spawnHarness.blockLegacySpawn) {
          return Promise.reject(new Error('legacy-spawn-blocked'));
        }
        return inner(cwd, env, signal);
      };
      actual.markChannelFactoryForwardsChildEnv(factory);
      return factory;
    },
  };
});

const PORT = 18765;
const ASSISTANT_TEXT = 'ordinary-managed-pong';
const timeoutMs = isSlowTestHost() ? 180_000 : 120_000;
vi.setConfig({ testTimeout: timeoutMs, hookTimeout: timeoutMs });

describe('ordinary REST session Managed owner', () => {
  let root: string;
  let workspace: string;
  let home: string;
  let app: ReturnType<typeof createServeApp> | undefined;
  let modelServer: http.Server | undefined;
  let modelBaseUrl = 'http://127.0.0.1:9/v1';
  let modelHold: Promise<void> | undefined;

  beforeEach(async () => {
    spawnHarness.blockLegacySpawn = false;
    modelHold = undefined;
    root = await mkdtemp(path.join(os.tmpdir(), 'ordinary-managed-session-'));
    const workspaceDir = path.join(root, 'workspace');
    const homeDir = path.join(root, 'home');
    await mkdir(workspaceDir);
    await mkdir(homeDir);
    workspace = canonicalizeWorkspace(workspaceDir);
    home = await realpath(homeDir);
    Storage.setRuntimeBaseDir(null);
    vi.stubEnv('QWEN_HOME', home);
    vi.stubEnv('QWEN_RUNTIME_DIR', '');
    vi.stubEnv(
      'QWEN_CODE_TRUSTED_FOLDERS_PATH',
      path.join(home, 'trustedFolders.json'),
    );
    vi.stubEnv('QWEN_OAUTH', '');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('GOOGLE_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'test-ordinary-managed-key');
    vi.stubEnv('OPENAI_MODEL', 'qwen3-coder-plus');
    vi.stubEnv('QWEN_TELEMETRY_ENABLED', '0');
    resetHomeEnvBootstrapForTesting();
    resetEnvironmentTrackingForTesting();
    resetTrustedFoldersForTesting();
  });

  afterEach(async () => {
    if (app) {
      await getServeAppLifecycle(app)
        .close({ timeoutMs: 30_000 })
        .catch(() => undefined);
      app = undefined;
    }
    if (modelServer) {
      await new Promise<void>((resolve) => {
        modelServer?.close(() => resolve());
      });
      modelServer = undefined;
    }
    resetHomeEnvBootstrapForTesting();
    resetEnvironmentTrackingForTesting();
    resetTrustedFoldersForTesting();
    Storage.setRuntimeBaseDir(null);
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function writeSettings(
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await writeFile(
      path.join(home, 'settings.json'),
      JSON.stringify({
        security: { auth: { selectedType: 'openai' } },
        model: {
          name: 'qwen3-coder-plus',
          baseUrl: modelBaseUrl,
        },
        ...extra,
      }),
    );
  }

  async function startModelServer(): Promise<void> {
    modelServer = http.createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
        res.writeHead(404).end('not found');
        return;
      }
      let raw = '';
      let closed = false;
      req.on('close', () => {
        closed = true;
      });
      req.on('data', (chunk: Buffer | string) => {
        raw += typeof chunk === 'string' ? chunk : chunk.toString();
      });
      req.on('end', () => {
        void (async () => {
          if (modelHold) await modelHold;
          if (closed) return;
          let body: { stream?: boolean; model?: string } = {};
          try {
            body = JSON.parse(raw) as { stream?: boolean; model?: string };
          } catch {
            res.writeHead(400).end('bad json');
            return;
          }
          writeChatCompletion(res, body.model ?? 'qwen3-coder-plus', {
            stream: body.stream === true,
          });
        })();
      });
    });
    await new Promise<void>((resolve) => {
      modelServer!.listen(0, '127.0.0.1', resolve);
    });
    const address = modelServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('mock model server did not bind a port');
    }
    modelBaseUrl = `http://127.0.0.1:${address.port}/v1`;
    vi.stubEnv('OPENAI_BASE_URL', modelBaseUrl);
  }

  function serveOptions(): ServeOptions {
    return {
      hostname: '127.0.0.1',
      port: PORT,
      mode: 'http-bridge',
      workspace,
      serveWebShell: false,
      maxSessions: 1,
      initializeTimeoutMs: 90_000,
    };
  }

  function bootApp() {
    return createServeApp(serveOptions(), undefined, {
      primaryWorkspaceTrusted: true,
      fsFactory: createWorkspaceFileSystemFactory({
        boundWorkspaces: [workspace],
        trusted: true,
        emit: () => {},
      }),
    });
  }

  function host(): string {
    return `127.0.0.1:${PORT}`;
  }

  function sessionService(): SessionService {
    return new SessionService(workspace, {
      runtimeBaseDir: Storage.getRuntimeBaseDir(),
    });
  }

  async function createManagedSession(): Promise<string> {
    const res = await request(app!)
      .post('/session')
      .set('Host', host())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toEqual(expect.any(String));
    const sessionId = res.body.sessionId as string;
    await expect(
      sessionService().readExecutionEngine(sessionId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      recorded: true,
      sessionId,
    });
    return sessionId;
  }

  async function waitForTurn(
    sessionId: string,
    promptId: string,
  ): Promise<{ state?: string; stopReason?: string }> {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const res = await request(app!)
        .get(`/session/${sessionId}/turns/${promptId}`)
        .set('Host', host());
      const body = res.body as { state?: string; stopReason?: string };
      if (
        res.status === 200 &&
        body.state !== 'running' &&
        body.state !== 'queued'
      ) {
        return body;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`turn ${promptId} did not settle`);
  }

  function collectSseUntil(
    sessionId: string,
    headers: Record<string, string>,
    predicate: (buf: string) => boolean,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let buf = '';
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.abort();
        if (error) reject(error);
        else resolve(buf);
      };
      const timer = setTimeout(() => {
        finish(new Error(`SSE timeout: ${buf.slice(-800)}`));
      }, 45_000);
      const pending = request(app!)
        .get(`/session/${sessionId}/events?snapshot=1`)
        .set('Host', host())
        .set(headers)
        .buffer(false)
        .parse((res, callback) => {
          res.on('data', (chunk: Buffer | string) => {
            buf += typeof chunk === 'string' ? chunk : chunk.toString();
            if (predicate(buf)) {
              callback(null, buf);
              finish();
            }
          });
          res.on('end', () => {
            callback(null, buf);
            finish();
          });
          res.on('error', (error: Error) => {
            callback(error, buf);
            finish(error);
          });
        });
      pending.end((error, _res) => {
        if (error && !settled) finish(error);
      });
    });
  }

  it('persists a verified managed owner through POST /session', async () => {
    vi.stubEnv('OPENAI_BASE_URL', modelBaseUrl);
    await writeSettings();
    app = bootApp();
    await createManagedSession();
  });

  it('runs prompt, events, and cancel on the ordinary Managed session', async () => {
    await startModelServer();
    await writeSettings();
    app = bootApp();
    const sessionId = await createManagedSession();

    const admitted = await request(app)
      .post(`/session/${sessionId}/prompt`)
      .set('Host', host())
      .send({ prompt: [{ type: 'text', text: 'say ping' }] });
    expect(admitted.status).toBe(202);
    expect(admitted.body.promptId).toEqual(expect.any(String));
    const promptId = admitted.body.promptId as string;
    const lastEventId = String(admitted.body.lastEventId);
    const eventEpoch = admitted.body.eventEpoch as string;

    const events = collectSseUntil(
      sessionId,
      {
        'Last-Event-ID': lastEventId,
        'X-Qwen-Event-Epoch': eventEpoch,
      },
      (buf) => buf.includes(ASSISTANT_TEXT),
    );
    const turn = await waitForTurn(sessionId, promptId);
    const sse = await events;
    expect(turn.state).toBe('completed');
    expect(JSON.stringify(turn)).toContain(ASSISTANT_TEXT);
    expect(sse).toContain(ASSISTANT_TEXT);
    await expect(
      sessionService().readExecutionEngine(sessionId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      sessionId,
    });

    let releaseHold!: () => void;
    modelHold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const hanging = await request(app)
      .post(`/session/${sessionId}/prompt`)
      .set('Host', host())
      .send({ prompt: [{ type: 'text', text: 'hang' }] });
    expect(hanging.status).toBe(202);
    expect(hanging.body.promptId).toEqual(expect.any(String));
    const cancel = await request(app)
      .post(`/session/${sessionId}/cancel`)
      .set('Host', host())
      .send({});
    expect(cancel.status).toBe(204);
    releaseHold();
    const cancelled = await waitForTurn(
      sessionId,
      hanging.body.promptId as string,
    );
    expect(['cancelled', 'completed']).toContain(cancelled.state);
    if (cancelled.state === 'completed') {
      expect(cancelled.stopReason).toBe('cancelled');
    }
  });

  it('pages GET /session/:id/transcript on the live Managed owner', async () => {
    await startModelServer();
    await writeSettings();
    app = bootApp();
    const sessionId = await createManagedSession();

    const admitted = await request(app)
      .post(`/session/${sessionId}/prompt`)
      .set('Host', host())
      .send({ prompt: [{ type: 'text', text: 'say ping' }] });
    expect(admitted.status).toBe(202);
    expect(admitted.body.promptId).toEqual(expect.any(String));
    const turn = await waitForTurn(sessionId, admitted.body.promptId as string);
    expect(turn.state).toBe('completed');

    spawnHarness.blockLegacySpawn = true;
    const res = await request(app!)
      .get(`/session/${sessionId}/transcript`)
      .set('Host', host());
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(sessionId);
    expect(JSON.stringify(res.body)).toContain(ASSISTANT_TEXT);
  });

  it('keeps MCP settings on the legacy factory at the same REST entry', async () => {
    vi.stubEnv('OPENAI_BASE_URL', modelBaseUrl);
    await writeSettings({
      mcpServers: { demo: { command: 'false' } },
    });
    spawnHarness.blockLegacySpawn = true;
    app = bootApp();

    const res = await request(app)
      .post('/session')
      .set('Host', host())
      .send({});

    expect(res.status).not.toBe(200);
    expect(JSON.stringify(res.body)).toContain('legacy-spawn-blocked');
    expect(res.body?.sessionId).toBeUndefined();
  });
});

function writeChatCompletion(
  res: http.ServerResponse,
  model: string,
  opts: { stream: boolean },
): void {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  if (!opts.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: ASSISTANT_TEXT },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12,
        },
      }),
    );
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const chunk = (
    delta: Record<string, unknown>,
    finishReason: string | null = null,
  ) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  res.write(chunk({ role: 'assistant', content: '' }));
  res.write(chunk({ content: ASSISTANT_TEXT }));
  res.write(
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();
}
