/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { AgentRegistry } from '../agents/agentRegistry.js';
import { SessionSpawner } from './sessionSpawner.js';

let stub: StubDaemon | undefined;
afterEach(async () => {
  if (stub) await stub.close();
  stub = undefined;
});

describe('SessionSpawner', () => {
  it('spawns a real session per agent and tags workflowRunId', async () => {
    stub = await startStubDaemon({});
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));
    const map: Array<{ agentId: string; sessionId: string }> = [];
    const spawner = new SessionSpawner({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
      onAgentSpawned: (agentId, sessionId) => map.push({ agentId, sessionId }),
    });
    const out = await spawner.spawn({
      prompt: 'do a thing',
      systemContext: '',
    });
    expect(typeof out.tokens).toBe('number');
    expect(map).toHaveLength(1);
    expect(registry.list({ workflowRunId: 'run-1' })).toHaveLength(1);
    expect(stub!.createdSessionCount).toBe(1);
  });

  it('prepends systemContext to the prompt text sent to the daemon', async () => {
    stub = await startStubDaemon({});
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));
    const spawner = new SessionSpawner({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    const distinctiveSystemContext = 'YOU ARE A DISTINCTIVE SYSTEM PROMPT';
    await spawner.spawn({
      prompt: 'do a thing',
      systemContext: distinctiveSystemContext,
    });
    const body = stub.lastPromptBody as {
      prompt: Array<{ type: string; text: string }>;
    };
    expect(body.prompt[0]!.text).toContain(distinctiveSystemContext);
    expect(body.prompt[0]!.text).toContain('do a thing');
  });

  it('does not add spurious whitespace when systemContext is empty', async () => {
    stub = await startStubDaemon({});
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));
    const spawner = new SessionSpawner({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    await spawner.spawn({ prompt: 'do a thing', systemContext: '' });
    const body = stub.lastPromptBody as {
      prompt: Array<{ type: string; text: string }>;
    };
    expect(body.prompt[0]!.text).toBe('do a thing');
  });

  it('passes req.cwd through as workspaceCwd on session creation', async () => {
    stub = await startStubDaemon({});
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));
    const spawner = new SessionSpawner({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    await spawner.spawn({
      prompt: 'do a thing',
      systemContext: '',
      cwd: '/some/workspace',
    });
    const body = stub.lastCreateSessionBody as { cwd?: string };
    expect(body.cwd).toBe('/some/workspace');
  });

  it('does not send a workspaceCwd when req.cwd is not provided', async () => {
    stub = await startStubDaemon({});
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));
    const spawner = new SessionSpawner({
      daemon: new DaemonClient({ baseUrl: stub.baseUrl }),
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    await spawner.spawn({ prompt: 'do a thing', systemContext: '' });
    const body = stub.lastCreateSessionBody as { cwd?: string };
    expect(body.cwd).toBeUndefined();
  });

  it('forwards req.signal through to daemon.prompt for built-in cancellation', async () => {
    stub = await startStubDaemon({});
    const dir = await mkdtemp(join(tmpdir(), 'wf-spawner-'));
    const registry = await AgentRegistry.open(join(dir, 'agents.json'));
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const promptSpy = vi.spyOn(daemon, 'prompt');
    const spawner = new SessionSpawner({
      daemon,
      registry,
      runId: 'run-1',
      spawnedByTokenId: 'tk',
    });
    const controller = new AbortController();
    await spawner.spawn({
      prompt: 'do a thing',
      systemContext: '',
      signal: controller.signal,
    });
    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(promptSpy.mock.calls[0]![2]).toBe(controller.signal);
  });
});
