/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BridgeExecutionEngine } from '@qwen-code/acp-bridge/bridgeOptions';
import type { AcpChannel, ChannelFactory } from '@qwen-code/acp-bridge/channel';
import { ProcessRegistry } from '@qwen-code/acp-bridge/processRegistry';
import { createSpawnChannelFactory } from '@qwen-code/acp-bridge/spawnChannel';
import { readSessionTranscriptSnapshot } from '@qwen-code/qwen-code-core/services/session-transcript-reader.js';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import { isManagedSessionTranscriptSync } from '@qwen-code/qwen-code-core/utils/sessionStorageUtils.js';
import {
  createAcpSessionBridge,
  type AcpSessionBridge,
} from './acp-session-bridge.js';
import { createManagedEngineChannelFactory } from './managed-engine-channel-factory.js';

// Real `qwen --acp` children, run from source through tsx; workspace
// packages resolve to their sources too, not their built output.
const CLI_ENTRY = fileURLToPath(new URL('../cli.ts', import.meta.url));
const CLI_TSCONFIG = fileURLToPath(
  new URL('../../tsconfig.json', import.meta.url),
);
const TSX_LOADER = pathToFileURL(
  createRequire(import.meta.url).resolve('tsx/esm'),
).href;
const MODEL = 'm2-fixture';
const IMAGE_MODEL = 'm2-image-fixture';
const IMAGE_BASE_URL = 'https://images.invalid/v1';

describe.skipIf(process.platform === 'win32')('Managed engine host', () => {
  let root: string;
  let workspace: string;
  let runtimeDir: string;
  let server: Server;
  let modelRequests: Array<{
    tools?: Array<{ function?: { name?: string } }>;
  }>;
  let bridge: AcpSessionBridge | undefined;
  let registry: ProcessRegistry;
  let engine: BridgeExecutionEngine;
  let started: Record<BridgeExecutionEngine, AcpChannel[]>;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'qwen-m2-')));
    workspace = path.join(root, 'workspace');
    runtimeDir = path.join(root, 'runtime');
    const qwenHome = path.join(root, 'config');
    await mkdir(workspace);
    await mkdir(qwenHome);
    modelRequests = [];
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      modelRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [delta, finishReason] of [
        [{ role: 'assistant', content: 'MANAGED_REPLY' }, null],
        [{}, 'stop'],
      ]) {
        res.write(
          `data: ${JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 0,
            model: MODEL,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );
      }
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await writeFile(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify({
        security: { auth: { selectedType: 'openai' } },
        model: { name: MODEL },
        telemetry: { enabled: false },
        privacy: { usageStatisticsEnabled: false },
        // Legacy registers image generation with its other tools; a Managed
        // session reaches it only through the later path its registry refuses.
        imageModel: `openai:${IMAGE_MODEL}\0${IMAGE_BASE_URL}`,
        modelProviders: {
          openai: [
            { id: MODEL, envKey: 'OPENAI_API_KEY', baseUrl },
            {
              id: IMAGE_MODEL,
              envKey: 'OPENAI_API_KEY',
              baseUrl: IMAGE_BASE_URL,
              imageOnly: true,
            },
          ],
        },
      }),
    );
    const sourceEnv: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')),
    );
    Object.assign(sourceEnv, {
      HOME: root,
      QWEN_HOME: qwenHome,
      QWEN_RUNTIME_DIR: runtimeDir,
      QWEN_CLI_ENTRY: CLI_ENTRY,
      NODE_OPTIONS: `--import ${TSX_LOADER}`,
      TSX_TSCONFIG_PATH: CLI_TSCONFIG,
      OPENAI_API_KEY: 'm2-fixture-key',
      OPENAI_BASE_URL: baseUrl,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      NO_COLOR: '1',
    });
    registry = new ProcessRegistry();
    engine = 'managed';
    started = { legacy: [], managed: [] };
    const record =
      (
        target: BridgeExecutionEngine,
        factory: ChannelFactory,
      ): ChannelFactory =>
      async (...args) => {
        const channel = await factory(...args);
        started[target].push(channel);
        return channel;
      };
    const options = { sourceEnv, processRegistry: registry };
    bridge = createAcpSessionBridge({
      boundWorkspace: workspace,
      sessionScope: 'thread',
      channelIdleTimeoutMs: 0,
      initializeTimeoutMs: 60_000,
      executionEngines: {
        legacy: record('legacy', createSpawnChannelFactory(options)),
        managed: record('managed', createManagedEngineChannelFactory(options)),
        select: () => engine,
      },
    });
  });

  afterEach(async () => {
    await bridge?.shutdown();
    bridge = undefined;
    await registry.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  async function prompt(sessionId: string): Promise<string> {
    let text = '';
    const events = bridge!.subscribeEvents(sessionId);
    const collected = (async () => {
      for await (const event of events) {
        const update = (
          event.data as {
            update?: { sessionUpdate?: string; content?: { text?: string } };
          }
        ).update;
        if (update?.sessionUpdate === 'agent_message_chunk') {
          text += update.content?.text ?? '';
        }
        if (event.type === 'turn_complete') return;
      }
    })();
    const response = await bridge!.sendPrompt(sessionId, {
      sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    expect(response.stopReason).toBe('end_turn');
    await collected;
    return text;
  }

  it('runs a Managed session in its own child and reclaims it', async () => {
    const session = await bridge!.spawnOrAttach({
      workspaceCwd: workspace,
      sessionScope: 'thread',
    });
    expect(started.managed).toHaveLength(1);
    expect(started.legacy).toHaveLength(0);

    const transcript = new SessionService(workspace, {
      runtimeBaseDir: runtimeDir,
    }).getSessionTranscriptPath(session.sessionId);
    expect(isManagedSessionTranscriptSync(transcript)).toBe(true);
    const snapshot = await readSessionTranscriptSnapshot(
      transcript,
      session.sessionId,
      false,
    );
    expect(snapshot?.executionEngine).toMatchObject({
      status: 'verified',
      engine: 'managed',
    });

    expect(await prompt(session.sessionId)).toBe('MANAGED_REPLY');
    expect(modelRequests.length).toBeGreaterThan(0);
    // The prompt's one conversation request declares only the tools the
    // Runtime worker runs, not image generation, which the host would run
    // itself; side queries, such as memory extraction, declare none.
    const declaring = modelRequests.filter((body) => body.tools);
    expect(declaring).toHaveLength(1);
    expect(
      declaring[0]!.tools!.map((tool) => tool.function?.name).sort(),
    ).toEqual(['edit', 'read_file', 'run_shell_command', 'write_file']);

    await bridge!.closeSession(session.sessionId);
    const [managed] = started.managed;
    // Reclaimed once idle: the child finishes its own shutdown and its whole
    // process tree leaves the daemon's registry.
    expect(await managed.exited).toEqual({ exitCode: 0, signalCode: null });
    await managed.registryReleased;
    expect(registry.committedProcessCount).toBe(0);

    // Restore arrives with M6; until then the host refuses it with the engine
    // classification, and the Bridge starts no other channel for it.
    await expect(
      bridge!.loadSession({
        sessionId: session.sessionId,
        workspaceCwd: workspace,
      }),
    ).rejects.toMatchObject({
      code: -32024,
      data: { errorKind: 'session_execution_engine_unavailable' },
    });
    expect(started.managed).toHaveLength(2);
    expect(started.legacy).toHaveLength(0);
  }, 120_000);

  it('leaves Legacy sessions usable when the Managed child dies', async () => {
    engine = 'legacy';
    const legacy = await bridge!.spawnOrAttach({
      workspaceCwd: workspace,
      sessionScope: 'thread',
    });
    // No Managed work, no Managed process.
    expect(started.managed).toHaveLength(0);
    engine = 'managed';
    const managed = await bridge!.spawnOrAttach({
      workspaceCwd: workspace,
      sessionScope: 'thread',
    });
    expect(started.legacy).toHaveLength(1);
    expect(started.managed).toHaveLength(1);

    started.managed[0].killSync();
    await started.managed[0].registryReleased;
    await expect(prompt(managed.sessionId)).rejects.toThrow();

    const beforeLegacy = modelRequests.length;
    expect(await prompt(legacy.sessionId)).toBe('MANAGED_REPLY');
    // Legacy keeps its host tools, image generation among them, so the Managed
    // check above can fail.
    expect(
      modelRequests[beforeLegacy]?.tools?.map((tool) => tool.function?.name),
    ).toContain('image_gen');
    const replacement = await bridge!.spawnOrAttach({
      workspaceCwd: workspace,
      sessionScope: 'thread',
    });
    expect(started.managed).toHaveLength(2);
    expect(await prompt(replacement.sessionId)).toBe('MANAGED_REPLY');
    expect(started.legacy).toHaveLength(1);
  }, 120_000);
});
