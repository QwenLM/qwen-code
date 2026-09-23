/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeExecutionSelection } from '@qwen-code/acp-bridge/bridgeOptions';
import {
  channelFactoryForwardsChildEnv,
  createSpawnChannelFactory,
} from '@qwen-code/acp-bridge/spawnChannel';
import {
  SessionExecutionEngineError,
  SessionService,
} from '@qwen-code/qwen-code-core';
import { type CliArgs } from '../config/config.js';
import {
  createDaemonExecutionEngines,
  daemonManagedHostArgv,
} from './daemon-execution-engines.js';
import { createWorkspaceGenerationGuard } from './workspace-registry.js';

describe('daemon execution engines', () => {
  const sessionId = '550e8400-e29b-41d4-a716-446655440201';
  let root: string;
  let workspace: string;
  let home: string;
  let runtimeBaseDir: string;
  let guard: ReturnType<typeof createWorkspaceGenerationGuard>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'daemon-engines-'));
    workspace = path.join(root, 'workspace');
    home = path.join(root, 'home');
    runtimeBaseDir = path.join(root, 'runtime');
    await mkdir(workspace);
    await mkdir(home);
    vi.stubEnv('QWEN_HOME', home);
    guard = createWorkspaceGenerationGuard();
  });

  afterEach(async () => {
    guard.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  function engines(workspaceTrusted = true, requireManagedForOrdinary = false) {
    return createDaemonExecutionEngines({
      workspaceCwd: workspace,
      sessionRuntimeBaseDir: runtimeBaseDir,
      runtimeEnvironment: { ...process.env, QWEN_HOME: home },
      workspaceTrusted,
      generationGuard: guard,
      argv: daemonManagedHostArgv({}),
      workspaceId: 'workspace-hash',
      requireManagedForOrdinary,
      legacyFactory: createSpawnChannelFactory(),
      resolveToolRuntimeProvider: () => undefined,
    });
  }

  function spawn(
    request: {
      sourceType?: string;
      sourceId?: string;
      parentSessionId?: string;
      worktree?: { slug: string; path: string; branch: string };
    } = {},
    extra: { daemonOwnedStandalone?: boolean } = {},
  ): BridgeExecutionSelection {
    return {
      operation: 'spawn',
      daemonOwnedStandalone: extra.daemonOwnedStandalone === true,
      request: {
        workspaceCwd: workspace,
        ...request,
      },
    };
  }

  function restore(
    operation: 'load' | 'resume',
    id = sessionId,
    request: Partial<
      Extract<
        BridgeExecutionSelection,
        { operation: 'load' | 'resume' }
      >['request']
    > = {},
    daemonOwnedStandalone = false,
  ): BridgeExecutionSelection {
    return {
      operation,
      daemonOwnedStandalone,
      request: {
        sessionId: id,
        workspaceCwd: workspace,
        ...request,
      },
    };
  }

  function managedSessionStore(
    overrides: Partial<
      NonNullable<
        Extract<
          BridgeExecutionSelection,
          { operation: 'load' | 'resume' }
        >['request']['managedSessionStore']
      >
    > = {},
  ) {
    return {
      baseUrl: 'http://127.0.0.1:8080',
      tenantId: 'tenant-1',
      workspaceId: 'workspace-hash',
      writerId: 'harness-boot-1',
      leaseDurationMs: 1_000,
      ...overrides,
    };
  }

  function record(
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

  async function writeTranscript(records: unknown[]) {
    const service = new SessionService(workspace, {
      runtimeBaseDir,
    });
    const file = service.getSessionTranscriptPath(sessionId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      records.map((value) => JSON.stringify(value)).join('\n') + '\n',
    );
  }

  it('selects managed for an ordinary trusted spawn with empty config', async () => {
    const pair = engines();
    expect(channelFactoryForwardsChildEnv(pair.managed)).toBe(true);
    expect(channelFactoryForwardsChildEnv(pair.legacy)).toBe(true);
    expect(pair.managed).not.toBe(pair.legacy);
    await expect(pair.select(spawn())).resolves.toBe('managed');
    await expect(pair.select(spawn({ sourceType: 'default' }))).resolves.toBe(
      'managed',
    );
    await expect(pair.select(spawn({ sourceType: 'api' }))).resolves.toBe(
      'managed',
    );
  });

  it('keeps deferred spawn sources on legacy', async () => {
    const pair = engines();
    await expect(pair.select(spawn({ sourceType: 'channel' }))).resolves.toBe(
      'legacy',
    );
    await expect(
      pair.select(spawn({ sourceType: 'scheduled_task' })),
    ).resolves.toBe('legacy');
    await expect(
      pair.select(spawn({ sourceType: 'managed-gateway' })),
    ).resolves.toBe('legacy');
    await expect(pair.select(spawn({ sourceType: 'qwen-live' }))).resolves.toBe(
      'legacy',
    );
    await expect(
      pair.select(spawn({ sourceType: 'standalone' })),
    ).resolves.toBe('legacy');
    await expect(pair.select(spawn({ sourceType: 'side_task' }))).resolves.toBe(
      'legacy',
    );
    await expect(
      pair.select(
        spawn({
          sourceType: 'default',
          sourceId: 'scheduled_task_run:task-1',
        }),
      ),
    ).resolves.toBe('legacy');
    await expect(
      pair.select(spawn({ parentSessionId: sessionId })),
    ).resolves.toBe('legacy');
    await expect(
      pair.select(
        spawn({
          worktree: { slug: 'wt', path: workspace, branch: 'main' },
        }),
      ),
    ).resolves.toBe('legacy');
    await expect(
      pair.select(spawn({}, { daemonOwnedStandalone: true })),
    ).resolves.toBe('legacy');
    await expect(
      pair.select(spawn({ sourceType: 'unknown-source' })),
    ).resolves.toBe('legacy');
  });

  it('keeps MCP, hooks, and extension candidates on legacy', async () => {
    const pair = engines();
    writeFileSync(
      path.join(home, 'settings.json'),
      JSON.stringify({
        mcpServers: { demo: { command: 'echo' } },
      }),
    );
    await expect(pair.select(spawn())).resolves.toBe('legacy');

    await rm(path.join(home, 'settings.json'));
    writeFileSync(
      path.join(home, 'settings.json'),
      JSON.stringify({
        hooks: { BeforeTool: [] },
      }),
    );
    await expect(pair.select(spawn())).resolves.toBe('legacy');

    await rm(path.join(home, 'settings.json'));
    writeFileSync(
      path.join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: { demo: { command: 'echo' } },
      }),
    );
    await expect(pair.select(spawn())).resolves.toBe('legacy');

    await rm(path.join(workspace, '.mcp.json'));
    writeFileSync(path.join(workspace, '.mcp.json'), '{');
    await expect(pair.select(spawn())).resolves.toBe('legacy');

    await rm(path.join(workspace, '.mcp.json'));
    mkdirSync(path.join(home, 'extensions', 'demo'), { recursive: true });
    await expect(pair.select(spawn())).resolves.toBe('legacy');
  });

  it('fails an incompatible ordinary spawn instead of falling back in Hosted Harness mode', async () => {
    writeFileSync(
      path.join(home, 'settings.json'),
      JSON.stringify({ mcpServers: { demo: { command: 'echo' } } }),
    );

    await expect(engines(true, true).select(spawn())).rejects.toThrow(
      /Hosted Harness requires the managed execution engine/,
    );
    await expect(
      engines(true, true).select(spawn({ sourceType: 'channel' })),
    ).resolves.toBe('legacy');
  });

  it('keeps untrusted workspaces on legacy', async () => {
    await expect(engines(false).select(spawn())).resolves.toBe('legacy');
    await expect(
      engines(false).select(spawn({ sourceType: 'default' })),
    ).resolves.toBe('legacy');
  });

  it('does not treat extra extension files as empty', async () => {
    mkdirSync(path.join(home, 'extensions'), { recursive: true });
    writeFileSync(path.join(home, 'extensions', 'notes.txt'), 'keep');
    await expect(engines().select(spawn())).resolves.toBe('legacy');

    await rm(path.join(home, 'extensions'), { recursive: true, force: true });
    mkdirSync(path.join(home, 'extension-store'), { recursive: true });
    writeFileSync(path.join(home, 'extension-store', 'notes.txt'), 'keep');
    await expect(engines().select(spawn())).resolves.toBe('legacy');
  });

  it('treats an initialized empty extension store as compatible', async () => {
    mkdirSync(path.join(home, 'extensions'), { recursive: true });
    writeFileSync(
      path.join(home, 'extensions', 'extension-enablement.json'),
      '{}',
    );
    mkdirSync(path.join(home, 'extension-store', 'transactions'), {
      recursive: true,
    });
    mkdirSync(path.join(home, 'extension-store', 'staging'), {
      recursive: true,
    });
    mkdirSync(path.join(home, 'extension-store', 'rollback'), {
      recursive: true,
    });
    writeFileSync(path.join(home, 'extension-store', 'lock'), '');
    writeFileSync(
      path.join(home, 'extension-store', 'state.json'),
      JSON.stringify({ version: 2, extensions: {} }),
    );
    await expect(engines().select(spawn())).resolves.toBe('managed');
    await writeTranscript([
      record('owner', {
        type: 'system',
        subtype: 'session_execution_engine',
        message: undefined,
        systemPayload: { version: 1, engine: 'managed' },
      }),
      record('user-1'),
    ]);
    await expect(engines().select(restore('load'))).resolves.toBe('managed');
  });

  it('does not treat a held extension-store lock as empty', async () => {
    mkdirSync(path.join(home, 'extension-store', 'lock.lock'), {
      recursive: true,
    });
    await expect(engines().select(spawn())).resolves.toBe('legacy');
    await writeTranscript([
      record('owner', {
        type: 'system',
        subtype: 'session_execution_engine',
        message: undefined,
        systemPayload: { version: 1, engine: 'managed' },
      }),
      record('user-1'),
    ]);
    await expect(engines().select(restore('load'))).rejects.toThrow(
      /cannot execute with the current configuration/,
    );
  });

  it('restores verified owners without guessing', async () => {
    const pair = engines();
    await writeTranscript([
      record('owner', {
        type: 'system',
        subtype: 'session_execution_engine',
        message: undefined,
        systemPayload: { version: 1, engine: 'managed' },
      }),
      record('user-1'),
    ]);
    await expect(pair.select(restore('load'))).resolves.toBe('managed');
    await expect(pair.select(restore('resume'))).resolves.toBe('managed');

    await writeTranscript([
      record('owner', {
        type: 'system',
        subtype: 'session_execution_engine',
        message: undefined,
        systemPayload: { version: 1, engine: 'legacy' },
      }),
      record('user-1'),
    ]);
    await expect(pair.select(restore('load'))).resolves.toBe('legacy');

    await writeTranscript([record('user-1')]);
    await expect(pair.select(restore('load'))).resolves.toBe('legacy');
  });

  it('uses the Hosted Harness remote store as managed restore authority', async () => {
    await expect(
      engines(true, true).select(
        restore('load', sessionId, {
          managedSessionStore: managedSessionStore(),
        }),
      ),
    ).resolves.toBe('managed');
  });

  it('does not let remote store metadata bypass restore ownership outside Hosted Harness', async () => {
    const request = {
      managedSessionStore: managedSessionStore(),
    };
    await expect(
      engines().select(restore('load', sessionId, request)),
    ).rejects.toThrow(/requires Hosted Harness session\/load/);
    await expect(
      engines(true, true).select(restore('resume', sessionId, request)),
    ).rejects.toThrow(/requires Hosted Harness session\/load/);
    await expect(
      engines(true, true).select(restore('load', sessionId, request, true)),
    ).rejects.toThrow(/requires Hosted Harness session\/load/);
  });

  it('fails closed when remote store scope or managed configuration differs', async () => {
    await expect(
      engines(true, true).select(
        restore('load', sessionId, {
          managedSessionStore: managedSessionStore({
            workspaceId: 'another-workspace',
          }),
        }),
      ),
    ).rejects.toThrow(/belongs to another workspace/);
    await expect(
      engines(true, true).select(
        restore('load', sessionId, {
          workspaceCwd: path.join(root, 'another-workspace'),
          managedSessionStore: managedSessionStore(),
        }),
      ),
    ).rejects.toThrow(/belongs to another workspace/);

    writeFileSync(
      path.join(home, 'settings.json'),
      JSON.stringify({ mcpServers: { demo: { command: 'echo' } } }),
    );
    await expect(
      engines(true, true).select(
        restore('load', sessionId, {
          managedSessionStore: managedSessionStore(),
        }),
      ),
    ).rejects.toThrow(/cannot execute with the current configuration/);
  });

  it('fails managed restore when current config is incompatible', async () => {
    await writeTranscript([
      record('owner', {
        type: 'system',
        subtype: 'session_execution_engine',
        message: undefined,
        systemPayload: { version: 1, engine: 'managed' },
      }),
      record('user-1'),
    ]);
    writeFileSync(
      path.join(home, 'settings.json'),
      JSON.stringify({
        mcpServers: { demo: { command: 'echo' } },
      }),
    );
    await expect(engines().select(restore('load'))).rejects.toBeInstanceOf(
      SessionExecutionEngineError,
    );
    await expect(engines().select(restore('load'))).rejects.toThrow(
      /cannot execute with the current configuration/,
    );
    await rm(path.join(home, 'settings.json'));
    await expect(engines(false).select(restore('load'))).rejects.toThrow(
      /cannot execute with the current configuration/,
    );
  });

  it('fails restore when owner records conflict or are missing', async () => {
    const pair = engines();
    await writeTranscript([
      record('owner-1', {
        type: 'system',
        subtype: 'session_execution_engine',
        message: undefined,
        systemPayload: { version: 1, engine: 'legacy' },
      }),
      record('owner-2', {
        type: 'system',
        subtype: 'session_execution_engine',
        message: undefined,
        systemPayload: { version: 1, engine: 'managed' },
      }),
    ]);
    await expect(pair.select(restore('load'))).rejects.toBeInstanceOf(
      SessionExecutionEngineError,
    );

    await expect(
      pair.select(restore('load', '550e8400-e29b-41d4-a716-446655440299')),
    ).rejects.toBeInstanceOf(SessionExecutionEngineError);
  });

  it('does not construct a host while selecting', async () => {
    const resolveProvider = vi.fn(() => undefined);
    const pair = createDaemonExecutionEngines({
      workspaceCwd: workspace,
      sessionRuntimeBaseDir: runtimeBaseDir,
      runtimeEnvironment: { ...process.env, QWEN_HOME: home },
      workspaceTrusted: true,
      generationGuard: guard,
      argv: {} as CliArgs,
      workspaceId: 'workspace-hash',
      legacyFactory: createSpawnChannelFactory(),
      resolveToolRuntimeProvider: resolveProvider,
    });
    await pair.select(spawn());
    expect(resolveProvider).not.toHaveBeenCalled();
  });
});
