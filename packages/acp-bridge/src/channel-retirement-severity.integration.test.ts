/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createAcpSessionBridge } from './bridge.js';
import { createSpawnChannelFactory } from './spawnChannel.js';

it.skipIf(process.platform === 'win32').each([
  { scenario: 'force-kill', expectedLevel: 'warn', tornDown: 1 },
  { scenario: 'new-failure', expectedLevel: 'warn', tornDown: 0 },
  { scenario: 'load-failure', expectedLevel: 'warn', tornDown: 0 },
  { scenario: 'planned', expectedLevel: 'info', tornDown: 0 },
  {
    scenario: 'idle-timer',
    expectedLevel: 'info',
    tornDown: 0,
    idleTimeout: 25,
  },
  {
    scenario: 'capacity',
    expectedLevel: 'info',
    tornDown: 0,
    idleTimeout: 60_000,
  },
  {
    scenario: 'workspace-stop',
    expectedLevel: 'info',
    tornDown: 0,
    idleTimeout: 60_000,
  },
])(
  'reports $scenario at $expectedLevel with guarded real-child EOF',
  async ({ scenario, expectedLevel, tornDown, idleTimeout }) => {
    const workspace = await mkdtemp(
      join(tmpdir(), 'qwen-retirement-severity-'),
    );
    const childEntry = join(workspace, 'child.cjs');
    const pidFile = join(workspace, 'pid');
    const traceFile = join(workspace, 'trace');
    await writeFile(
      childEntry,
      `
const readline = require('node:readline');
const { appendFileSync, closeSync, writeFileSync } = require('node:fs');
const record = (event) => appendFileSync(${JSON.stringify(traceFile)}, event + '\\n');
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 60000);
process.once('SIGUSR1', () => { record('exit=0'); process.exit(0); });
process.once('SIGTERM', () => {
  process.on('SIGTERM', () => {});
  record('SIGTERM');
  closeSync(1);
  process.stdout.destroy();
  record('stdout-closed');
});
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  record(message.method);
  if (${JSON.stringify(scenario)} === 'force-kill' && message.method === 'qwen/control/session/close') {
    record('close-ignored');
    return;
  }
  if ((${JSON.stringify(scenario)} === 'new-failure' && message.method === 'session/new') ||
      (${JSON.stringify(scenario)} === 'load-failure' && message.method === 'session/load')) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'fixture intentional failure' } }) + '\\n');
    return;
  }
  let result = {};
  if (message.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
  else if (message.method === 'session/new') result = { sessionId: String(process.pid) };
  else if (message.method === 'qwen/control/session/close') result = { closed: true };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`,
    );
    const diagnostics: Array<{ line: string; level?: string }> = [];
    const events: unknown[] = [];
    const factory = createSpawnChannelFactory({
      sourceEnv: { ...process.env, QWEN_CLI_ENTRY: childEntry },
      pipeLimits: {
        maxFrameBytes: 1024 * 1024,
        maxQueuedMessages: 128,
        maxQueuedBytes: 8 * 1024 * 1024,
      },
      pipeHooks: {
        onTransportError: () => {
          // Hold process exit until the actual guarded EOF has been observed.
          process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGUSR1');
        },
      },
    });
    const bridge = createAcpSessionBridge({
      boundWorkspace: workspace,
      initializeTimeoutMs: 1000,
      channelIdleTimeoutMs: idleTimeout,
      channelFactory: factory,
      onDiagnosticLine: (line, level) => diagnostics.push({ line, level }),
    });
    try {
      if (scenario === 'new-failure') {
        await expect(
          bridge.spawnOrAttach({ workspaceCwd: workspace }),
        ).rejects.toMatchObject({ message: 'fixture intentional failure' });
      } else if (scenario === 'load-failure') {
        await expect(
          bridge.loadSession({
            sessionId: 'fixture-restore',
            workspaceCwd: workspace,
          }),
        ).rejects.toMatchObject({ message: 'fixture intentional failure' });
      } else {
        const session = await bridge.spawnOrAttach({ workspaceCwd: workspace });
        const subscription = bridge.subscribeEvents(session.sessionId);
        const consumed = (async () => {
          for await (const event of subscription) events.push(event);
        })();
        if (scenario === 'workspace-stop') {
          const snapshot = bridge.getRuntimeStopSnapshot!();
          await expect(
            bridge.stopWorkspaceRuntime!(
              {
                confirmInterruptions: true,
                expectedChannelId: snapshot.channelId!,
                expectedRuntimeEpoch: snapshot.runtimeEpoch,
                expectedStopToken: snapshot.stopToken,
                expectedSessionIds: snapshot.sessions.map(
                  (entry) => entry.sessionId,
                ),
              },
              5_000,
            ),
          ).resolves.toMatchObject({ state: 'stopped', released: true });
        } else {
          expect(await bridge.killSession(session.sessionId)).toBe(true);
          if (scenario === 'capacity') {
            const candidate = bridge.getIdleChannelCandidate!();
            expect(candidate).toBeDefined();
            expect(await bridge.reclaimIdleChannel!(candidate!)).toBe(true);
          }
        }
        await consumed;
      }
      await vi.waitFor(
        () =>
          expect(
            diagnostics.filter(({ line }) => line.includes('channel exited')),
          ).toHaveLength(1),
        { timeout: 5_000 },
      );
      const exits = diagnostics.filter(({ line }) =>
        line.includes('channel exited'),
      );
      const childTrace = (await readFile(traceFile, 'utf8')).trim().split('\n');
      expect(childTrace).toContain('SIGTERM');
      expect(childTrace).toContain('stdout-closed');
      expect(childTrace).toContain('exit=0');
      if (scenario === 'force-kill') {
        expect(childTrace).toContain('close-ignored');
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'session_died',
              data: expect.objectContaining({
                reason: 'channel_closed',
                exitCode: 0,
                signalCode: null,
              }),
            }),
          ]),
        );
      }
      expect(bridge.sessionCount).toBe(0);
      expect(exits).toEqual([
        {
          line: expect.stringContaining(
            `channel exited (code=0, signal=none, transport=ndjson_unexpected_eof, ${tornDown} session(s) torn down)`,
          ),
          level: expectedLevel,
        },
      ]);
    } finally {
      await bridge.shutdown();
      await rm(workspace, { recursive: true, force: true });
    }
  },
  15000,
);
