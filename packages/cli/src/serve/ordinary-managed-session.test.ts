/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import http from 'node:http';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { ChannelFactory } from '@qwen-code/acp-bridge';
import {
  PRIVATE_MANAGED_TOOL_RUNTIME_ENV,
  PRIVATE_MANAGED_TOOL_RUNTIME_VALUE,
} from '@qwen-code/acp-bridge/status';
import {
  hashDaemonWorkspace,
  SessionService,
  Storage,
} from '@qwen-code/qwen-code-core';
import {
  resetEnvironmentTrackingForTesting,
  resetHomeEnvBootstrapForTesting,
} from '../config/environment.js';
import { resetTrustedFoldersForTesting } from '../config/trustedFolders.js';
import { isSlowTestHost } from '../test-utils/slow-test-host.js';
import { ClientMcpSenderRegistry } from './acp-http/client-mcp-sender-registry.js';
import {
  canonicalizeWorkspace,
  createAcpSessionBridge,
  createSpawnChannelFactory,
} from './acp-session-bridge.js';
import { createBridgeFileSystemAdapter } from './bridge-file-system-adapter.js';
import {
  createDaemonExecutionEngines,
  daemonManagedHostArgv,
} from './daemon-execution-engines.js';
import { createWorkspaceFileSystemFactory } from './fs/index.js';
import { LocalManagedRuntimeProvider } from './managed-runtime-provider.js';
import { resolveManagedRuntimeWorkerLauncher } from './managed-runtime-worker-launcher.js';
import { sessionAttachmentsRoots } from './session-attachments-root.js';
import { getServeAppLifecycle } from './serve-app-lifecycle.js';
import { createServeApp } from './server.js';
import type { ServeOptions } from './types.js';
import type { DaemonWorkspaceService } from './workspace-service/index.js';
import {
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
  createWorkspaceSessionOwnerIndex,
  type WorkspaceRuntime,
} from './workspace-registry.js';

const spawnHarness = vi.hoisted(() => ({
  blockLegacySpawn: false,
  blockManagedSpawn: false,
}));

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

vi.mock('./managed-agent-channel.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./managed-agent-channel.js')>();
  const { markChannelFactoryForwardsChildEnv } = await import(
    '@qwen-code/acp-bridge/spawnChannel'
  );
  return {
    ...actual,
    createManagedAgentChannelFactory: (
      options: Parameters<typeof actual.createManagedAgentChannelFactory>[0],
    ) => {
      const inner = actual.createManagedAgentChannelFactory(options);
      const factory: ChannelFactory = (cwd, env, signal) => {
        if (spawnHarness.blockManagedSpawn) {
          return Promise.reject(new Error('managed-spawn-blocked'));
        }
        return inner(cwd, env, signal);
      };
      markChannelFactoryForwardsChildEnv(factory);
      return factory;
    },
  };
});

const PORT = 18765;
const ASSISTANT_TEXT = 'ordinary-managed-pong';
const SHELL_OUTPUT_FILE = 'ordinary-managed-pong.txt';
const SHELL_COMMAND = `echo ${ASSISTANT_TEXT} > ${SHELL_OUTPUT_FILE}`;
const timeoutMs = isSlowTestHost() ? 180_000 : 120_000;
vi.setConfig({ testTimeout: timeoutMs, hookTimeout: timeoutMs });

describe('ordinary REST session Managed owner', () => {
  let root: string;
  let workspace: string;
  let home: string;
  let app: ReturnType<typeof createServeApp> | undefined;
  let managedRuntimeProvider: LocalManagedRuntimeProvider | undefined;
  let modelServer: http.Server | undefined;
  let modelBaseUrl = 'http://127.0.0.1:9/v1';
  let modelHold: Promise<void> | undefined;
  let modelReply: 'text' | 'shell-then-text' = 'text';
  let modelRequests: Array<{
    tools: number;
    roles: string[];
    stream: boolean;
  }>;

  beforeEach(async () => {
    spawnHarness.blockLegacySpawn = false;
    spawnHarness.blockManagedSpawn = false;
    modelHold = undefined;
    modelReply = 'text';
    modelRequests = [];
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
    const { cliEntry } = resolveManagedRuntimeWorkerLauncher();
    vi.stubEnv('QWEN_CLI_ENTRY', cliEntry);
    if (cliEntry.endsWith('.ts')) {
      const tsx = createRequire(import.meta.url).resolve('tsx/esm');
      const nodeOptions = process.env['NODE_OPTIONS'] ?? '';
      const flag = `--import ${tsx}`;
      if (!nodeOptions.includes(tsx)) {
        vi.stubEnv(
          'NODE_OPTIONS',
          [nodeOptions, flag].filter((part) => part.length > 0).join(' '),
        );
      }
    }
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
    await managedRuntimeProvider?.dispose();
    managedRuntimeProvider = undefined;
    if (modelServer) {
      await new Promise<void>((resolve) => {
        modelServer?.close(() => resolve());
      });
      modelServer = undefined;
    }
    modelHold = undefined;
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
      let aborted = false;
      req.on('aborted', () => {
        aborted = true;
      });
      req.on('data', (chunk: Buffer | string) => {
        raw += typeof chunk === 'string' ? chunk : chunk.toString();
      });
      req.on('end', () => {
        void (async () => {
          if (modelHold) await modelHold;
          if (aborted || res.destroyed) return;
          let body: {
            stream?: boolean;
            model?: string;
            messages?: Array<{ role?: string }>;
            tools?: unknown[];
          } = {};
          try {
            body = JSON.parse(raw) as {
              stream?: boolean;
              model?: string;
              messages?: Array<{ role?: string }>;
              tools?: unknown[];
            };
          } catch {
            res.writeHead(400).end('bad json');
            return;
          }
          const toolFollowUp = (body.messages ?? []).some(
            (message) => message.role === 'tool' || message.role === 'function',
          );
          modelRequests.push({
            tools: Array.isArray(body.tools) ? body.tools.length : 0,
            roles: (body.messages ?? []).map((message) => message.role ?? ''),
            stream: body.stream === true,
          });
          writeChatCompletion(res, body.model ?? 'qwen3-coder-plus', {
            stream: body.stream === true,
            ...(modelReply === 'shell-then-text' &&
            !toolFollowUp &&
            Array.isArray(body.tools) &&
            body.tools.length > 0
              ? {
                  toolCall: {
                    name: 'run_shell_command',
                    args: { command: SHELL_COMMAND },
                  },
                }
              : {}),
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

  function makeManagedRuntime(input: {
    cwd: string;
    primary: boolean;
    sessionOwnerIndex: ReturnType<typeof createWorkspaceSessionOwnerIndex>;
    resolveToolRuntimeProvider: () => LocalManagedRuntimeProvider | undefined;
  }): WorkspaceRuntime {
    const generationGuard = createWorkspaceGenerationGuard();
    const runtimeBaseDir = Storage.getRuntimeBaseDir();
    const attachments = sessionAttachmentsRoots(input.cwd, runtimeBaseDir);
    const fsFactory = createWorkspaceFileSystemFactory({
      boundWorkspaces: [input.cwd],
      trusted: true,
      emit: () => {},
    });
    const clientMcpSenderRegistry = new ClientMcpSenderRegistry();
    const bridge = createAcpSessionBridge({
      sessionAttachmentsRoot: attachments.root,
      ...(attachments.fallback
        ? { sessionAttachmentsFallbackRoot: attachments.fallback }
        : {}),
      maxSessions: 1,
      initializeTimeoutMs: 90_000,
      sessionLifecycle: input.sessionOwnerIndex.handleBridgeSessionLifecycle,
      executionEngines: createDaemonExecutionEngines({
        workspaceCwd: input.cwd,
        sessionRuntimeBaseDir: runtimeBaseDir,
        runtimeEnvironment: process.env,
        workspaceTrusted: true,
        generationGuard,
        argv: daemonManagedHostArgv({}),
        workspaceId: hashDaemonWorkspace(input.cwd),
        legacyFactory: createSpawnChannelFactory(),
        resolveToolRuntimeProvider: input.resolveToolRuntimeProvider,
      }),
      boundWorkspace: input.cwd,
      fileSystem: createBridgeFileSystemAdapter(fsFactory),
      clientMcpSender: clientMcpSenderRegistry.lookup,
      childEnvOverrides: {
        [PRIVATE_MANAGED_TOOL_RUNTIME_ENV]: PRIVATE_MANAGED_TOOL_RUNTIME_VALUE,
      },
    });
    return {
      workspaceId: hashDaemonWorkspace(input.cwd),
      workspaceCwd: input.cwd,
      sessionRuntimeBaseDir: runtimeBaseDir,
      primary: input.primary,
      trusted: true,
      env: { mode: 'parent-process', overlayKeys: [] },
      bridge,
      workspaceService: {
        getWorkspaceTrustStatus: async () => ({
          v: 1,
          workspaceCwd: input.cwd,
          trusted: true,
          folderTrustEnabled: true,
        }),
      } as unknown as DaemonWorkspaceService,
      routeFileSystemFactory: fsFactory,
      clientMcpSenderRegistry,
      generationGuard,
    };
  }

  function bootDualWorkspaceApp(secondary: string) {
    const sessionOwnerIndex = createWorkspaceSessionOwnerIndex();
    const toolRuntimeProviderRef: {
      current: LocalManagedRuntimeProvider | undefined;
    } = { current: undefined };
    const resolveToolRuntimeProvider = () => toolRuntimeProviderRef.current;
    const primaryRuntime = makeManagedRuntime({
      cwd: workspace,
      primary: true,
      sessionOwnerIndex,
      resolveToolRuntimeProvider,
    });
    const secondaryRuntime = makeManagedRuntime({
      cwd: secondary,
      primary: false,
      sessionOwnerIndex,
      resolveToolRuntimeProvider,
    });
    const workspaceRegistry = createWorkspaceRegistry(
      [primaryRuntime, secondaryRuntime],
      { sessionOwnerIndex },
    );
    managedRuntimeProvider = new LocalManagedRuntimeProvider(workspaceRegistry);
    toolRuntimeProviderRef.current = managedRuntimeProvider;
    return createServeApp(serveOptions(), undefined, {
      primaryWorkspaceTrusted: true,
      workspaceRegistry,
      fsFactory: primaryRuntime.routeFileSystemFactory,
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

  async function createManagedSession(cwd?: string): Promise<string> {
    const res = await request(app!)
      .post('/session')
      .set('Host', host())
      .send(cwd ? { cwd } : {});
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toEqual(expect.any(String));
    const sessionId = res.body.sessionId as string;
    if (cwd !== undefined) {
      expect(res.body.workspaceCwd).toBe(cwd);
    }
    await expect(
      new SessionService(cwd ?? workspace, {
        runtimeBaseDir: Storage.getRuntimeBaseDir(),
      }).readExecutionEngine(sessionId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      recorded: true,
      sessionId,
    });
    return sessionId;
  }

  function transcriptRecord(
    sessionId: string,
    uuid: string,
    fields: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      uuid,
      parentUuid: 'root',
      sessionId,
      cwd: workspace,
      timestamp: '2026-09-15T00:00:00.000Z',
      version: 'test',
      type: 'user',
      message: { role: 'user', parts: [{ text: uuid }] },
      ...fields,
    };
  }

  async function writeTranscript(
    sessionId: string,
    records: unknown[],
  ): Promise<void> {
    const file = sessionService().getSessionTranscriptPath(sessionId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      records.map((value) => JSON.stringify(value)).join('\n') + '\n',
    );
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

  async function waitForPermissionRequest(
    sessionId: string,
    promptId: string,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(app!)
        .get(`/session/${sessionId}/status`)
        .set('Host', host());
      const body = res.body as {
        isWaitingForPermission?: boolean;
        pendingInteractions?: Array<{ requestId?: string; kind?: string }>;
      };
      const requestId = body.pendingInteractions?.find(
        (item) => item.kind === 'permission',
      )?.requestId;
      if (
        res.status === 200 &&
        body.isWaitingForPermission === true &&
        typeof requestId === 'string'
      ) {
        return requestId;
      }
      const turn = await request(app!)
        .get(`/session/${sessionId}/turns/${promptId}`)
        .set('Host', host());
      const turnBody = turn.body as { state?: string };
      if (
        turn.status === 200 &&
        turnBody.state &&
        turnBody.state !== 'running' &&
        turnBody.state !== 'queued'
      ) {
        let wrote = false;
        try {
          await readFile(path.join(workspace, SHELL_OUTPUT_FILE), 'utf8');
          wrote = true;
        } catch {
          wrote = false;
        }
        const transcript = await request(app!)
          .get(`/session/${sessionId}/transcript`)
          .set('Host', host());
        throw new Error(
          `turn settled before permission wrote=${wrote} modelRequests=${JSON.stringify(modelRequests)} turn=${JSON.stringify(turn.body)} transcript=${JSON.stringify(transcript.body).slice(0, 4000)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`permission request for ${sessionId} did not arrive`);
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
    expect(serveOptions()).not.toHaveProperty('experimentalManagedAgents');
    spawnHarness.blockLegacySpawn = true;
    app = bootApp();
    await createManagedSession();
  });

  it('does not publish an ordinary session when transcript write fails', async () => {
    vi.stubEnv('OPENAI_BASE_URL', modelBaseUrl);
    await writeSettings();
    spawnHarness.blockLegacySpawn = true;
    app = bootApp();

    const sessionId = randomUUID();
    const transcriptPath = sessionService().getSessionTranscriptPath(sessionId);
    await mkdir(transcriptPath, { recursive: true });
    try {
      const failed = await request(app)
        .post('/session')
        .set('Host', host())
        .send({ sessionId });
      expect(failed.status).not.toBe(200);
      expect(JSON.stringify(failed.body)).not.toContain('legacy-spawn-blocked');
      expect(failed.body?.sessionId).toBeUndefined();

      const leftover = await sessionService()
        .readExecutionEngine(sessionId)
        .catch(() => undefined);
      expect(leftover).toBeUndefined();

      const prompt = await request(app)
        .post(`/session/${sessionId}/prompt`)
        .set('Host', host())
        .send({ prompt: [{ type: 'text', text: 'say ping' }] });
      expect(prompt.status).toBe(404);
    } finally {
      await rm(transcriptPath, { recursive: true, force: true });
    }

    const created = await request(app)
      .post('/session')
      .set('Host', host())
      .send({ sessionId });
    expect(created.status).toBe(200);
    expect(created.body.sessionId).toBe(sessionId);
    await expect(
      sessionService().readExecutionEngine(sessionId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      recorded: true,
      sessionId,
    });
  });

  it('runs an ordinary Managed permission dialog then executes the approved tool', async () => {
    modelReply = 'shell-then-text';
    await startModelServer();
    await writeSettings();
    app = bootApp();
    const sessionId = await createManagedSession();

    const admitted = await request(app)
      .post(`/session/${sessionId}/prompt`)
      .set('Host', host())
      .send({
        prompt: [
          {
            type: 'text',
            text: `run ${SHELL_COMMAND}`,
          },
        ],
      });
    expect(admitted.status).toBe(202);
    const promptId = admitted.body.promptId as string;

    const requestId = await waitForPermissionRequest(sessionId, promptId);
    const vote = await request(app)
      .post(`/session/${sessionId}/permission/${requestId}`)
      .set('Host', host())
      .send({ outcome: { outcome: 'selected', optionId: 'proceed_once' } });
    expect(vote.status).toBe(200);

    const turn = await waitForTurn(sessionId, promptId);
    expect(turn.state).toBe('completed');
    await expect(
      readFile(path.join(workspace, SHELL_OUTPUT_FILE), 'utf8'),
    ).resolves.toContain(ASSISTANT_TEXT);
    await expect(
      sessionService().readExecutionEngine(sessionId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      sessionId,
    });
  });

  it('keeps ordinary Managed sessions isolated across two daemon workspaces', async () => {
    const secondaryDir = path.join(root, 'workspace-b');
    await mkdir(secondaryDir);
    const secondary = canonicalizeWorkspace(secondaryDir);
    await writeFile(path.join(workspace, 'owner.txt'), 'primary');
    await writeFile(path.join(secondary, 'owner.txt'), 'secondary');

    await startModelServer();
    await writeSettings();
    spawnHarness.blockLegacySpawn = true;
    app = bootDualWorkspaceApp(secondary);

    const primaryId = await createManagedSession();
    const secondaryId = await createManagedSession(secondary);
    expect(primaryId).not.toBe(secondaryId);

    const primaryService = new SessionService(workspace, {
      runtimeBaseDir: Storage.getRuntimeBaseDir(),
    });
    const secondaryService = new SessionService(secondary, {
      runtimeBaseDir: Storage.getRuntimeBaseDir(),
    });
    await expect(
      primaryService.readExecutionEngine(secondaryId),
    ).resolves.toBeUndefined();
    await expect(
      secondaryService.readExecutionEngine(primaryId),
    ).resolves.toBeUndefined();

    const primaryPrompt = await request(app)
      .post(`/session/${primaryId}/prompt`)
      .set('Host', host())
      .send({ prompt: [{ type: 'text', text: 'say ping-primary' }] });
    expect(primaryPrompt.status).toBe(202);
    const secondaryPrompt = await request(app)
      .post(`/session/${secondaryId}/prompt`)
      .set('Host', host())
      .send({ prompt: [{ type: 'text', text: 'say ping-secondary' }] });
    expect(secondaryPrompt.status).toBe(202);

    const primaryTurn = await waitForTurn(
      primaryId,
      primaryPrompt.body.promptId as string,
    );
    const secondaryTurn = await waitForTurn(
      secondaryId,
      secondaryPrompt.body.promptId as string,
    );
    expect(primaryTurn.state).toBe('completed');
    expect(secondaryTurn.state).toBe('completed');
    expect(primaryService.getSessionTranscriptPath(primaryId)).not.toBe(
      secondaryService.getSessionTranscriptPath(secondaryId),
    );

    const primaryTranscript = await request(app)
      .get(`/session/${primaryId}/transcript`)
      .set('Host', host());
    expect(primaryTranscript.status).toBe(200);
    expect(JSON.stringify(primaryTranscript.body)).toContain(ASSISTANT_TEXT);
    const secondaryTranscript = await request(app)
      .get(`/session/${secondaryId}/transcript`)
      .set('Host', host());
    expect(secondaryTranscript.status).toBe(200);
    expect(JSON.stringify(secondaryTranscript.body)).toContain(ASSISTANT_TEXT);
    await expect(
      readFile(path.join(workspace, 'owner.txt'), 'utf8'),
    ).resolves.toBe('primary');
    await expect(
      readFile(path.join(secondary, 'owner.txt'), 'utf8'),
    ).resolves.toBe('secondary');

    const crossedPrimary = await request(app)
      .get(
        `/workspaces/${encodeURIComponent(secondary)}/session/${primaryId}/transcript`,
      )
      .set('Host', host());
    expect(crossedPrimary.status).toBe(404);
    const crossedSecondary = await request(app)
      .get(
        `/workspaces/${encodeURIComponent(workspace)}/session/${secondaryId}/transcript`,
      )
      .set('Host', host());
    expect(crossedSecondary.status).toBe(404);

    await expect(
      primaryService.readExecutionEngine(primaryId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      sessionId: primaryId,
    });
    await expect(
      secondaryService.readExecutionEngine(secondaryId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      sessionId: secondaryId,
    });
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

  it('pages GET /session/:id/transcript for a cold Managed session without spawning legacy', async () => {
    await startModelServer();
    await writeSettings();
    app = bootApp();
    const sessionId = await createManagedSession();

    const admitted = await request(app)
      .post(`/session/${sessionId}/prompt`)
      .set('Host', host())
      .send({ prompt: [{ type: 'text', text: 'say ping' }] });
    expect(admitted.status).toBe(202);
    const turn = await waitForTurn(sessionId, admitted.body.promptId as string);
    expect(turn.state).toBe('completed');

    await getServeAppLifecycle(app).close({ timeoutMs: 30_000 });
    app = bootApp();

    spawnHarness.blockLegacySpawn = true;
    const res = await request(app)
      .get(`/session/${sessionId}/transcript`)
      .set('Host', host());
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(sessionId);
    expect(JSON.stringify(res.body)).toContain(ASSISTANT_TEXT);

    const index = await request(app)
      .get(`/session/${sessionId}/turn-index`)
      .set('Host', host());
    expect(index.status).toBe(200);
    expect(index.body.sessionId).toBe(sessionId);
    expect(index.body.totalTurns).toBeGreaterThan(0);
    await expect(
      sessionService().readExecutionEngine(sessionId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      sessionId,
    });
  });

  it('queues a second ordinary prompt on the live Managed session', async () => {
    await startModelServer();
    await writeSettings();
    app = bootApp();
    const sessionId = await createManagedSession();

    let releaseHold!: () => void;
    modelHold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    const first = await request(app)
      .post(`/session/${sessionId}/prompt`)
      .set('Host', host())
      .send({ prompt: [{ type: 'text', text: 'first' }] });
    expect(first.status).toBe(202);
    const firstId = first.body.promptId as string;

    await vi.waitFor(
      async () => {
        const running = await request(app!)
          .get(`/session/${sessionId}/turns/${firstId}`)
          .set('Host', host());
        const body = running.body as { state?: string };
        expect(running.status).toBe(200);
        expect(body.state).toBe('running');
      },
      { timeout: 15_000, interval: 50 },
    );

    const second = await request(app)
      .post(`/session/${sessionId}/prompt`)
      .set('Host', host())
      .send({ prompt: [{ type: 'text', text: 'second' }] });
    expect(second.status).toBe(202);
    const secondId = second.body.promptId as string;

    const pending = await request(app)
      .get(`/session/${sessionId}/pending-prompts`)
      .set('Host', host());
    expect(pending.status).toBe(200);
    expect(pending.body.pendingPrompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ promptId: firstId, state: 'running' }),
        expect.objectContaining({ promptId: secondId, state: 'queued' }),
      ]),
    );

    const queuedTurn = await request(app)
      .get(`/session/${sessionId}/turns/${secondId}`)
      .set('Host', host());
    const queuedBody = queuedTurn.body as { state?: string };
    expect(queuedTurn.status).toBe(200);
    expect(queuedBody.state).toBe('queued');
    await expect(
      sessionService().readExecutionEngine(sessionId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      sessionId,
    });

    releaseHold();
    await vi.waitFor(
      async () => {
        const idle = await request(app!)
          .get(`/session/${sessionId}/pending-prompts`)
          .set('Host', host());
        expect(idle.status).toBe(200);
        expect(idle.body.pendingPrompts).toEqual([]);
      },
      { timeout: 45_000, interval: 50 },
    );
    const firstTurn = await waitForTurn(sessionId, firstId);
    const secondTurn = await waitForTurn(sessionId, secondId);
    expect(firstTurn.state).toBe('completed');
    expect(secondTurn.state).toBe('completed');
    await expect(
      sessionService().readExecutionEngine(sessionId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      sessionId,
    });
  });

  it('reuses the same ordinary promptId instead of admitting a second turn', async () => {
    await startModelServer();
    await writeSettings();
    app = bootApp();
    const sessionId = await createManagedSession();

    let releaseHold!: () => void;
    modelHold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    const promptId = randomUUID();
    const prompt = [{ type: 'text', text: 'same-turn' }];
    const first = await request(app)
      .post(`/session/${sessionId}/prompt`)
      .set('Host', host())
      .send({ promptId, prompt });
    expect(first.status).toBe(202);
    expect(first.body.promptId).toBe(promptId);

    const retry = await request(app)
      .post(`/session/${sessionId}/prompt`)
      .set('Host', host())
      .send({ promptId, prompt });
    expect(retry.status).toBe(202);
    expect(retry.body.promptId).toBe(promptId);

    const pending = await request(app)
      .get(`/session/${sessionId}/pending-prompts`)
      .set('Host', host());
    expect(pending.status).toBe(200);
    expect(pending.body.pendingPrompts).toEqual([
      expect.objectContaining({ promptId, state: 'running' }),
    ]);

    const conflict = await request(app)
      .post(`/session/${sessionId}/prompt`)
      .set('Host', host())
      .send({
        promptId,
        prompt: [{ type: 'text', text: 'different-turn' }],
      });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('prompt_id_conflict');
    await expect(
      sessionService().readExecutionEngine(sessionId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      sessionId,
    });

    releaseHold();
    const turn = await waitForTurn(sessionId, promptId);
    expect(turn.state).toBe('completed');
    await expect(
      sessionService().readExecutionEngine(sessionId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      sessionId,
    });
  });

  it('keeps an ordinary Managed turn after SSE disconnect and resumes events', async () => {
    await startModelServer();
    await writeSettings();
    app = bootApp();
    const sessionId = await createManagedSession();

    let releaseHold!: () => void;
    modelHold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    const admitted = await request(app)
      .post(`/session/${sessionId}/prompt`)
      .set('Host', host())
      .send({ prompt: [{ type: 'text', text: 'say ping' }] });
    expect(admitted.status).toBe(202);
    const promptId = admitted.body.promptId as string;
    const lastEventId = String(admitted.body.lastEventId);
    const eventEpoch = admitted.body.eventEpoch as string;

    const firstStream = await collectSseUntil(
      sessionId,
      {
        'Last-Event-ID': lastEventId,
        'X-Qwen-Event-Epoch': eventEpoch,
      },
      (buf) => buf.includes('retry:'),
    );
    expect(firstStream).toContain('retry:');

    await vi.waitFor(
      async () => {
        const running = await request(app!)
          .get(`/session/${sessionId}/turns/${promptId}`)
          .set('Host', host());
        const body = running.body as { state?: string };
        expect(running.status).toBe(200);
        expect(body.state).toBe('running');
      },
      { timeout: 15_000, interval: 50 },
    );

    const pending = await request(app)
      .get(`/session/${sessionId}/pending-prompts`)
      .set('Host', host());
    expect(pending.status).toBe(200);
    expect(pending.body.pendingPrompts).toEqual([
      expect.objectContaining({ promptId, state: 'running' }),
    ]);
    await expect(
      sessionService().readExecutionEngine(sessionId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      sessionId,
    });

    const events = collectSseUntil(
      sessionId,
      {
        'Last-Event-ID': lastEventId,
        'X-Qwen-Event-Epoch': eventEpoch,
      },
      (buf) => buf.includes(ASSISTANT_TEXT),
    );
    releaseHold();
    const sse = await events;
    const turn = await waitForTurn(sessionId, promptId);
    expect(turn.state).toBe('completed');
    expect(sse).toContain(ASSISTANT_TEXT);
    await expect(
      sessionService().readExecutionEngine(sessionId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      sessionId,
    });
  });

  it('restores a cold ordinary Managed session after the daemon app restarts', async () => {
    await startModelServer();
    await writeSettings();
    app = bootApp();
    const sessionId = await createManagedSession();

    const first = await request(app)
      .post(`/session/${sessionId}/prompt`)
      .set('Host', host())
      .send({ prompt: [{ type: 'text', text: 'say ping' }] });
    expect(first.status).toBe(202);
    const firstTurn = await waitForTurn(
      sessionId,
      first.body.promptId as string,
    );
    expect(firstTurn.state).toBe('completed');
    expect(JSON.stringify(firstTurn)).toContain(ASSISTANT_TEXT);

    await getServeAppLifecycle(app).close({ timeoutMs: 30_000 });
    app = bootApp();

    await expect(
      sessionService().readExecutionEngine(sessionId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      recorded: true,
      sessionId,
    });

    spawnHarness.blockLegacySpawn = true;
    const loaded = await request(app)
      .post(`/session/${sessionId}/load`)
      .set('Host', host())
      .send({});
    expect(loaded.status).toBe(200);
    expect(loaded.body.sessionId).toBe(sessionId);
    expect(loaded.body.attached).toBe(false);
    expect(JSON.stringify(loaded.body)).toContain(ASSISTANT_TEXT);
    await expect(
      sessionService().readExecutionEngine(sessionId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      sessionId,
    });

    const second = await request(app)
      .post(`/session/${sessionId}/prompt`)
      .set('Host', host())
      .send({ prompt: [{ type: 'text', text: 'say ping again' }] });
    expect(second.status).toBe(202);
    const secondTurn = await waitForTurn(
      sessionId,
      second.body.promptId as string,
    );
    expect(secondTurn.state).toBe('completed');
    expect(JSON.stringify(secondTurn)).toContain(ASSISTANT_TEXT);
    await expect(
      sessionService().readExecutionEngine(sessionId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      sessionId,
    });
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

  it('keeps deferred session sources on the legacy factory at the same REST entry', async () => {
    vi.stubEnv('OPENAI_BASE_URL', modelBaseUrl);
    await writeSettings();
    spawnHarness.blockLegacySpawn = true;
    app = bootApp();

    for (const body of [
      { sourceType: 'scheduled_task' },
      { sourceType: 'channel' },
      {
        sourceType: 'default',
        sourceId: 'scheduled_task_run:task-1',
      },
    ]) {
      const res = await request(app)
        .post('/session')
        .set('Host', host())
        .send(body);
      expect(res.status).not.toBe(200);
      expect(JSON.stringify(res.body)).toContain('legacy-spawn-blocked');
      expect(res.body?.sessionId).toBeUndefined();
    }
  });

  it('keeps ordinary user hooks on the legacy factory at the same REST entry', async () => {
    vi.stubEnv('OPENAI_BASE_URL', modelBaseUrl);
    await writeSettings({
      hooks: { BeforeTool: [] },
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

  it('loads a complete old session without owner on the legacy factory', async () => {
    vi.stubEnv('OPENAI_BASE_URL', modelBaseUrl);
    await writeSettings();
    spawnHarness.blockLegacySpawn = true;
    app = bootApp();

    const legacyId = randomUUID();
    await writeTranscript(legacyId, [transcriptRecord(legacyId, 'user-1')]);
    await expect(
      sessionService().readExecutionEngine(legacyId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'legacy',
      recorded: false,
      sessionId: legacyId,
    });

    const loaded = await request(app)
      .post(`/session/${legacyId}/load`)
      .set('Host', host())
      .send({});
    expect(loaded.status).not.toBe(200);
    expect(JSON.stringify(loaded.body)).toContain('legacy-spawn-blocked');
    await expect(
      sessionService().readExecutionEngine(legacyId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'legacy',
      recorded: false,
      sessionId: legacyId,
    });

    const created = await createManagedSession();
    expect(created).not.toBe(legacyId);
  });

  it('fails incompatible Managed restore without retrying the legacy factory', async () => {
    vi.stubEnv('OPENAI_BASE_URL', modelBaseUrl);
    await writeSettings({
      mcpServers: { demo: { command: 'false' } },
    });
    spawnHarness.blockLegacySpawn = true;
    app = bootApp();

    const sessionId = randomUUID();
    await writeTranscript(sessionId, [
      transcriptRecord(sessionId, 'owner', {
        type: 'system',
        subtype: 'session_execution_engine',
        message: undefined,
        systemPayload: { version: 1, engine: 'managed' },
      }),
      transcriptRecord(sessionId, 'user-1'),
    ]);
    await expect(
      sessionService().readExecutionEngine(sessionId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      recorded: true,
      sessionId,
    });

    const loaded = await request(app)
      .post(`/session/${sessionId}/load`)
      .set('Host', host())
      .send({});
    expect(loaded.status).not.toBe(200);
    expect(JSON.stringify(loaded.body)).toContain(
      'cannot execute with the current configuration',
    );
    expect(JSON.stringify(loaded.body)).not.toContain('legacy-spawn-blocked');
    await expect(
      sessionService().readExecutionEngine(sessionId),
    ).resolves.toMatchObject({
      status: 'verified',
      engine: 'managed',
      recorded: true,
      sessionId,
    });
  });

  it('does not retry the legacy factory when Managed spawn fails', async () => {
    vi.stubEnv('OPENAI_BASE_URL', modelBaseUrl);
    await writeSettings();
    spawnHarness.blockLegacySpawn = true;
    spawnHarness.blockManagedSpawn = true;
    app = bootApp();

    const sessionId = randomUUID();
    const failed = await request(app)
      .post('/session')
      .set('Host', host())
      .send({ sessionId });
    expect(failed.status).not.toBe(200);
    expect(JSON.stringify(failed.body)).toContain('managed-spawn-blocked');
    expect(JSON.stringify(failed.body)).not.toContain('legacy-spawn-blocked');
    expect(failed.body?.sessionId).toBeUndefined();

    const leftover = await sessionService()
      .readExecutionEngine(sessionId)
      .catch(() => undefined);
    expect(leftover).toBeUndefined();
  });
});

function writeChatCompletion(
  res: http.ServerResponse,
  model: string,
  opts: {
    stream: boolean;
    toolCall?: { name: string; args: Record<string, unknown> };
  },
): void {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const toolCalls = opts.toolCall
    ? [
        {
          id: `call_${randomUUID()}`,
          type: 'function',
          function: {
            name: opts.toolCall.name,
            arguments: JSON.stringify(opts.toolCall.args),
          },
        },
      ]
    : undefined;
  const usage = {
    prompt_tokens: 8,
    completion_tokens: 4,
    total_tokens: 12,
  };
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
            message: {
              role: 'assistant',
              content: toolCalls ? null : ASSISTANT_TEXT,
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: toolCalls ? 'tool_calls' : 'stop',
          },
        ],
        usage,
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
  if (toolCalls) {
    const toolCall = toolCalls[0]!;
    res.write(chunk({ role: 'assistant' }));
    res.write(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: toolCall.id,
            type: toolCall.type,
            function: {
              name: toolCall.function.name,
              arguments: '',
            },
          },
        ],
      }),
    );
    res.write(
      chunk({
        tool_calls: [
          {
            index: 0,
            function: { arguments: toolCall.function.arguments },
          },
        ],
      }),
    );
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage,
      })}\n\n`,
    );
  } else {
    res.write(chunk({ role: 'assistant', content: '' }));
    res.write(chunk({ content: ASSISTANT_TEXT }));
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage,
      })}\n\n`,
    );
  }
  res.write('data: [DONE]\n\n');
  res.end();
}
