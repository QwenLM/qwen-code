/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeChannel,
  type ChannelHandle,
} from '@qwen-code/acp-bridge/internal/testUtils';
import {
  SESSION_EXECUTION_ENGINE_META_KEY,
  type BridgeExecutionEngine,
} from '@qwen-code/acp-bridge/bridgeOptions';
import { REQUESTED_SESSION_ID_META_KEY } from '@qwen-code/acp-bridge/bridgeTypes';
import type { ChannelFactory } from '@qwen-code/acp-bridge/channel';
import { SERVE_CONTROL_EXT_METHODS } from '@qwen-code/acp-bridge/status';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import { isSlowTestHost } from '../test-utils/slow-test-host.js';
import type { ManagedExecutionEngineCompatibility } from './session-execution-engine-selector.js';
import type { WorkspaceRegistry } from './workspace-registry.js';

// Every test re-imports the whole serve module graph, which can take seconds
// under parallel load.
const timeoutMs = isSlowTestHost() ? 60_000 : 30_000;
vi.setConfig({ testTimeout: timeoutMs, hookTimeout: timeoutMs });

let root: string;
let workspaceCwd: string;
let runtimeBaseDir: string;
let previousRuntimeDir: string | undefined;
let shutdown: (() => Promise<void>) | undefined;

beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'qwen-paired-host-')),
  );
  workspaceCwd = path.join(root, 'workspace');
  runtimeBaseDir = path.join(root, '.runtime');
  await mkdir(workspaceCwd);
  previousRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
  process.env['QWEN_RUNTIME_DIR'] = runtimeBaseDir;
});

afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  vi.doUnmock('./acp-session-bridge.js');
  vi.resetModules();
  vi.restoreAllMocks();
  if (previousRuntimeDir === undefined) {
    delete process.env['QWEN_RUNTIME_DIR'];
  } else {
    process.env['QWEN_RUNTIME_DIR'] = previousRuntimeDir;
  }
  await rm(root, { recursive: true, force: true });
});

function transcriptPath(sessionId: string): string {
  return new SessionService(workspaceCwd, {
    runtimeBaseDir,
  }).getSessionTranscriptPath(sessionId);
}

async function writeOwner(
  sessionId: string,
  engine: BridgeExecutionEngine,
): Promise<void> {
  const file = transcriptPath(sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({
      uuid: crypto.randomUUID(),
      parentUuid: null,
      sessionId,
      timestamp: new Date().toISOString(),
      type: 'system',
      subtype: 'session_execution_engine',
      cwd: workspaceCwd,
      systemPayload: { version: 1, engine },
    })}\n`,
  );
}

// An engine that honors the B2a host contract: it persists the owner before
// answering a new session, and answers every creation and restore with its
// receipt.
function engine(name: BridgeExecutionEngine) {
  const channels: ChannelHandle[] = [];
  const receipt = () => ({
    _meta: { [SESSION_EXECUTION_ENGINE_META_KEY]: name },
  });
  const factory: ChannelFactory = async () => {
    const handle = makeChannel({
      newSessionImpl: async (params) => {
        const requested = params._meta?.[REQUESTED_SESSION_ID_META_KEY];
        const sessionId =
          typeof requested === 'string' ? requested : crypto.randomUUID();
        await writeOwner(sessionId, name);
        return { sessionId, ...receipt() };
      },
      loadSessionImpl: receipt,
      resumeSessionImpl: receipt,
      extMethodImpl: (method) =>
        method === SERVE_CONTROL_EXT_METHODS.sessionClose
          ? { closed: true }
          : method === SERVE_CONTROL_EXT_METHODS.sessionSource
            ? { persisted: true }
            : {},
    });
    channels.push(handle);
    return handle.channel;
  };
  const calls = <K extends keyof ChannelHandle['agent']>(key: K) =>
    channels.flatMap(
      (channel) =>
        channel.agent[key] as unknown as Array<{ sessionId?: string }>,
    );
  return {
    factory,
    channels,
    created: () => calls('newSessionCalls').length,
    restored: () =>
      [...calls('loadSessionCalls'), ...calls('resumeSessionCalls')].map(
        (call) => call.sessionId,
      ),
    prompted: () => calls('promptCalls').map((call) => call.sessionId),
  };
}

async function pairedHost(options: { withManaged: boolean }) {
  const legacy = engine('legacy');
  const managed = engine('managed');
  const state: { compatibility: ManagedExecutionEngineCompatibility } = {
    compatibility: { status: 'compatible' },
  };
  vi.doMock('./acp-session-bridge.js', async () => {
    const actual = await vi.importActual<
      typeof import('./acp-session-bridge.js')
    >('./acp-session-bridge.js');
    return { ...actual, defaultSpawnChannelFactory: legacy.factory };
  });
  const { createServeApp } = await import('./server.js');
  const app = createServeApp(
    {
      hostname: '127.0.0.1',
      port: 4170,
      mode: 'http-bridge',
      workspace: workspaceCwd,
      experimentalPairedEngines: true,
    },
    undefined,
    options.withManaged
      ? {
          managedExecutionEngine: {
            factory: managed.factory,
            evaluate: () => state.compatibility,
          },
        }
      : {},
  );
  const bridge = (app.locals as { workspaceRegistry: WorkspaceRegistry })
    .workspaceRegistry.primary.bridge;
  shutdown = () => bridge.shutdown();
  const post = (route: string, body: Record<string, unknown> = {}) =>
    request(app)
      .post(route)
      .set('Host', '127.0.0.1:4170')
      .send({ cwd: workspaceCwd, sessionScope: 'thread', ...body });
  const close = (sessionId: string) =>
    request(app).delete(`/session/${sessionId}`).set('Host', '127.0.0.1:4170');
  return { bridge, legacy, managed, state, post, close };
}

describe('a paired embedded serve host', () => {
  it('starts, restores and shuts down with both engines', async () => {
    const { bridge, legacy, managed, post, close } = await pairedHost({
      withManaged: true,
    });

    const onManaged = await post('/session');
    expect(onManaged.status).toBe(200);
    const onLegacy = await post('/session', { sourceType: 'channel' });
    expect(onLegacy.status).toBe(200);
    expect(managed.created()).toBe(1);
    expect(legacy.created()).toBe(1);
    const managedId = onManaged.body.sessionId as string;
    const legacyId = onLegacy.body.sessionId as string;

    expect((await close(managedId)).status).toBe(204);
    expect((await close(legacyId)).status).toBe(204);
    expect((await post(`/session/${managedId}/load`)).status).toBe(200);
    expect((await post(`/session/${legacyId}/resume`)).status).toBe(200);
    expect(managed.restored()).toEqual([managedId]);
    expect(legacy.restored()).toEqual([legacyId]);

    await bridge.shutdown();
    expect(legacy.channels.every((channel) => channel.killed)).toBe(true);
    expect(managed.channels.every((channel) => channel.killed)).toBe(true);
    expect(legacy.channels.length + managed.channels.length).toBeGreaterThan(1);
  });

  it('keeps attached and durably owned sessions on their engine when the outcome changes', async () => {
    const { bridge, legacy, managed, state, post, close } = await pairedHost({
      withManaged: true,
    });
    const created = await post('/session');
    expect(created.status).toBe(200);
    const sessionId = created.body.sessionId as string;

    state.compatibility = { status: 'deferred', reason: 'MCP servers' };
    expect((await post('/session')).status).toBe(200);
    expect(legacy.created()).toBe(1);
    await bridge.sendPrompt(sessionId, {
      sessionId,
      prompt: [{ type: 'text', text: 'still on Managed' }],
    });
    expect(managed.prompted()).toEqual([sessionId]);
    expect(legacy.prompted()).toEqual([]);

    expect((await close(sessionId)).status).toBe(204);
    const before = await readFile(transcriptPath(sessionId), 'utf8');
    const refused = await post(`/session/${sessionId}/load`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'session_execution_engine_unavailable',
    });
    expect(managed.restored()).toEqual([]);
    expect(legacy.restored()).toEqual([]);
    expect(await readFile(transcriptPath(sessionId), 'utf8')).toBe(before);

    state.compatibility = { status: 'compatible' };
    expect((await post(`/session/${sessionId}/load`)).status).toBe(200);
    expect(managed.restored()).toEqual([sessionId]);
    expect(legacy.restored()).toEqual([]);
  });

  it('runs every session on Legacy and refuses Managed owners without a Managed engine', async () => {
    const { legacy, post } = await pairedHost({ withManaged: false });

    expect((await post('/session')).status).toBe(200);
    expect(legacy.created()).toBe(1);

    const managedId = crypto.randomUUID();
    await writeOwner(managedId, 'managed');
    const before = await readFile(transcriptPath(managedId), 'utf8');
    const refused = await post(`/session/${managedId}/resume`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'session_execution_engine_unavailable',
    });
    expect(legacy.restored()).toEqual([]);
    expect(legacy.channels).toHaveLength(1);
    expect(await readFile(transcriptPath(managedId), 'utf8')).toBe(before);
  });
});
