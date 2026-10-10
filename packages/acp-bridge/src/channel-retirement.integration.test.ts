/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createAcpSessionBridge } from './bridge.js';
import { createSpawnChannelFactory } from './spawnChannel.js';
import type { AcpChannel } from './channel.js';

it.skipIf(process.platform === 'win32').each([
  {
    scenario: 'planned retirement',
    planned: true,
    exitCode: 0,
    oversized: false,
    level: 'info',
  },
  {
    scenario: 'unplanned clean EOF',
    planned: false,
    exitCode: 0,
    oversized: false,
    level: 'warn',
  },
  {
    scenario: 'planned retirement with nonzero exit',
    planned: true,
    exitCode: 7,
    oversized: false,
    level: 'warn',
  },
  {
    scenario: 'planned retirement with an oversized frame',
    planned: true,
    exitCode: 0,
    oversized: true,
    level: 'warn',
  },
  {
    scenario: 'planned retirement with nonzero exit and unguarded pipes',
    planned: true,
    exitCode: 7,
    oversized: false,
    level: 'warn',
    unguarded: true,
  },
])(
  'reports $scenario at $level with a real child',
  async ({ planned, exitCode, oversized, level, unguarded }) => {
    const workspace = await mkdtemp(join(tmpdir(), 'qwen-retirement-'));
    const childEntry = join(workspace, 'child.cjs');
    await writeFile(
      childEntry,
      `const readline = require('node:readline');
const { closeSync } = require('node:fs');
// Transport teardown closes stdin; retain lifetime until the exit acknowledgement.
// This timer never coordinates events and process.exit clears it on acknowledgement.
setInterval(() => {}, 60_000);
process.once('SIGUSR1', () => process.exit(${exitCode}));
process.once('SIGTERM', () => {
  process.on('SIGTERM', () => {});
  const finish = () => {
    closeSync(1);
    process.stdout.destroy();
    if (${Boolean(unguarded)}) process.exit(${exitCode});
  };
  if (${oversized}) process.stdout.write('x'.repeat(1024 * 1024 + 1), finish);
  else finish();
});
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result = {};
  if (message.method === 'initialize') {
    result = { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
  } else if (message.method === 'session/new') {
    result = { sessionId: String(process.pid) };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`,
    );
    const diagnostics: Array<{ line: string; level?: string }> = [];
    let spawnedChannel: AcpChannel | undefined;
    let childPid: number | undefined;
    const factory = createSpawnChannelFactory({
      sourceEnv: { ...process.env, QWEN_CLI_ENTRY: childEntry },
      pipeLimits: unguarded
        ? undefined
        : {
            maxFrameBytes: 1024 * 1024,
            maxQueuedMessages: 128,
            maxQueuedBytes: 8 * 1024 * 1024,
          },
      pipeHooks: {
        // Acknowledge the actual pipe failure before allowing process exit.
        // This pins the EOF-before-exit ordering without a scheduling delay.
        onTransportError: () => {
          if (childPid !== undefined) process.kill(childPid, 'SIGUSR1');
        },
      },
    });
    const bridge = createAcpSessionBridge({
      boundWorkspace: workspace,
      channelFactory: async (...args) => {
        spawnedChannel = await factory(...args);
        return spawnedChannel;
      },
      onDiagnosticLine: (line, level) => diagnostics.push({ line, level }),
    });
    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: workspace });
      childPid = Number(session.sessionId);
      expect(Number.isSafeInteger(childPid)).toBe(true);
      if (planned) {
        expect(await bridge.killSession(session.sessionId)).toBe(true);
      } else {
        // Exit the real child without the bridge recording retirement intent.
        await spawnedChannel!.kill();
      }
      await vi.waitFor(() => {
        expect(
          diagnostics.filter(({ line }) => line.includes('channel exited')),
        ).toEqual([
          {
            line: expect.stringContaining(
              oversized
                ? 'transport=ndjson_frame_too_large'
                : `channel exited (code=${exitCode}, signal=none, transport=${unguarded ? 'ok' : 'ndjson_unexpected_eof'}`,
            ),
            level,
          },
        ]);
        expect(bridge.sessionCount).toBe(0);
      });
    } finally {
      await bridge.shutdown();
      await rm(workspace, { recursive: true, force: true });
    }
  },
  15_000,
);
