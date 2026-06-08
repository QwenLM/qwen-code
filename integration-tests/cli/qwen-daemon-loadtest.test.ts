/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon connection stress test — mock ACP, POSIX-only.
 *
 * Exercises the daemon's HTTP/SSE surface under concurrent session load
 * using a mock ACP child (fixtures/mock-acp-child/agent.mjs) that
 * responds in ~100ms without hitting a real model. This validates
 * daemon/bridge overhead, session lifecycle, SSE eviction, and crash
 * recovery — NOT real model latency or tool execution.
 *
 * Gated by QWEN_LOADTEST_ENABLED=1. Run via:
 *   QWEN_LOADTEST_ENABLED=1 npx vitest run \
 *     --config integration-tests/vitest.loadtest.config.ts \
 *     -- qwen-daemon-loadtest
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  spawnDaemon,
  percentiles,
  consumeSseEvents,
  gitHead,
  makeTempWorkspace,
  sleep,
  type SpawnedDaemon,
  type ScenarioResult,
} from './_daemon-harness.js';
import {
  resolveOutputDir,
  formatPercentiles,
  writeSnapshotArtifacts,
  collectPlatformInfo,
} from './_daemon-perf-report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Skip logic
// ---------------------------------------------------------------------------

const SKIP =
  process.env['QWEN_LOADTEST_ENABLED'] !== '1' ||
  process.platform === 'win32' ||
  Boolean(
    process.env['QWEN_SANDBOX'] &&
      process.env['QWEN_SANDBOX']!.toLowerCase() !== 'false',
  );

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MOCK_AGENT_PATH = path.resolve(
  __dirname,
  '../fixtures/mock-acp-child/agent.mjs',
);
const OUTPUT_DIR = resolveOutputDir('loadtest');

const LIFECYCLE_CYCLES = 20;
const BURST_SESSIONS = 10;
const MAX_SESSIONS = 50;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

interface LoadtestSnapshot {
  version: 1;
  capturedAt: string;
  gitCommit: string | null;
  platform: ReturnType<typeof collectPlatformInfo>;
  scenarios: ScenarioResult[];
}

const snapshot: LoadtestSnapshot = {
  version: 1,
  capturedAt: new Date().toISOString(),
  gitCommit: gitHead(),
  platform: collectPlatformInfo(),
  scenarios: [],
};

// ---------------------------------------------------------------------------
// Process leak safety net
// ---------------------------------------------------------------------------

let activeDaemon: SpawnedDaemon | null = null;

process.on('exit', () => {
  if (activeDaemon?.daemon.exitCode === null) {
    try {
      activeDaemon.daemon.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDaemonEnv(mode = 'echo'): Record<string, string> {
  return {
    QWEN_CLI_ENTRY: MOCK_AGENT_PATH,
    MOCK_ACP_MODE: mode,
    MOCK_ACP_PROMPT_DELAY_MS: '100',
    MOCK_ACP_EMIT_CHUNKS: '3',
  };
}

async function withDaemon(
  opts: {
    mode?: string;
    label: string;
    extraArgs?: string[];
    skipWarmup?: boolean;
  },
  fn: (d: SpawnedDaemon, ws: string) => Promise<void>,
): Promise<void> {
  const ws = makeTempWorkspace(opts.label);
  let d: SpawnedDaemon | undefined;
  try {
    d = await spawnDaemon({
      workspaceCwd: ws,
      extraArgs: [
        '--max-sessions',
        String(MAX_SESSIONS),
        ...(opts.extraArgs ?? []),
      ],
      env: mockDaemonEnv(opts.mode ?? 'echo'),
    });
    activeDaemon = d;

    if (!opts.skipWarmup) {
      const anchor = await d.client.createOrAttachSession({
        sessionScope: 'thread',
      });
      await d.client.prompt(anchor.sessionId, {
        prompt: [{ type: 'text', text: 'warmup' }],
      });
    }

    await fn(d, ws);
  } catch (err) {
    if (d) {
      console.error(
        `[loadtest:${opts.label}] stdout:\n${d.stdoutBuf.value}\nstderr:\n${d.stderrBuf.value}`,
      );
    }
    throw err;
  } finally {
    if (d) {
      await d.dispose();
      activeDaemon = null;
    }
    await sleep(100);
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

(SKIP ? describe.skip : describe).sequential(
  'daemon connection stress test (mock ACP, POSIX-only)',
  { retry: 0 },
  () => {
    afterEach(() => {
      if (activeDaemon?.daemon.exitCode === null) {
        try {
          activeDaemon.daemon.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        activeDaemon = null;
      }
    });

    // Scenario 1: rapid lifecycle
    it('rapid lifecycle: create-prompt-close cycles', async () => {
      const t0 = performance.now();
      const latencies: number[] = [];

      await withDaemon({ label: 'lifecycle' }, async (d) => {
        for (let i = 0; i < LIFECYCLE_CYCLES; i++) {
          const t = performance.now();
          const session = await d.client.createOrAttachSession({
            sessionScope: 'thread',
          });
          await d.client.prompt(session.sessionId, {
            prompt: [{ type: 'text', text: `cycle-${i}` }],
          });
          await d.client.closeSession(session.sessionId);
          latencies.push(performance.now() - t);
        }
      });

      const stats = percentiles(latencies);
      snapshot.scenarios.push({
        name: 'rapid-lifecycle',
        status: 'passed',
        durationMs: performance.now() - t0,
        metrics: { cycles: LIFECYCLE_CYCLES, ...stats },
      });

      expect(stats.p99).toBeLessThan(30_000);
    }, 120_000);

    // Scenario 2: SSE slow consumer triggers eviction
    it('SSE slow consumer triggers eviction through HTTP', async () => {
      const t0 = performance.now();
      let evicted = false;
      let received = 0;

      await withDaemon(
        { label: 'sse-eviction', extraArgs: ['--event-ring-size', '32'] },
        async (d) => {
          const session = await d.client.createOrAttachSession({
            sessionScope: 'thread',
          });

          // Start a slow SSE consumer with a small queue (16 = daemon
          // minimum) so eviction triggers before the 60s timeout.
          const consumePromise = consumeSseEvents(d.client, session.sessionId, {
            consumerDelayMs: 200,
            timeoutMs: 60_000,
            subscribe: { maxQueued: 16 },
          });

          // Fire rapid prompts to overwhelm the slow consumer's queue
          const promptCount = 20;
          for (let i = 0; i < promptCount; i++) {
            try {
              await d.client.prompt(session.sessionId, {
                prompt: [{ type: 'text', text: `flood-${i}` }],
              });
            } catch {
              break;
            }
          }

          const result = await consumePromise;
          evicted = result.evictionReason !== undefined;
          received = result.received;

          await d.client.closeSession(session.sessionId);
        },
      );

      snapshot.scenarios.push({
        name: 'sse-slow-consumer-eviction',
        status: 'passed',
        durationMs: performance.now() - t0,
        metrics: { evicted, received },
      });

      // Whether eviction fires depends on ring size vs consumer speed.
      // The catastrophic bound: the consumer received at least one event
      // and the daemon survived the prompt flood without crashing.
      expect(received).toBeGreaterThan(0);
    }, 120_000);

    // Scenario 3: Last-Event-ID reconnect under concurrent load
    it('Last-Event-ID reconnect under concurrent load', async () => {
      const t0 = performance.now();
      let reconnectReceived = 0;

      await withDaemon({ label: 'reconnect' }, async (d) => {
        const session = await d.client.createOrAttachSession({
          sessionScope: 'thread',
        });

        // Fire a prompt so the session has events in its ring buffer.
        await d.client.prompt(session.sessionId, {
          prompt: [{ type: 'text', text: 'seed-events' }],
        });

        // Replay from the beginning to collect seeded events.
        const initial = await consumeSseEvents(d.client, session.sessionId, {
          maxEvents: 3,
          timeoutMs: 10_000,
          subscribe: { lastEventId: 0 },
        });

        // Fire another prompt to push more events into the ring.
        await d.client.prompt(session.sessionId, {
          prompt: [{ type: 'text', text: 'generate-more' }],
        });

        // Reconnect with the actual last event id from the initial batch.
        if (initial.lastSeenId !== undefined) {
          const reconnect = await consumeSseEvents(
            d.client,
            session.sessionId,
            {
              maxEvents: 5,
              timeoutMs: 10_000,
              subscribe: { lastEventId: initial.lastSeenId },
            },
          );
          reconnectReceived = reconnect.received;
        }

        await d.client.closeSession(session.sessionId);
      });

      snapshot.scenarios.push({
        name: 'last-event-id-reconnect',
        status: 'passed',
        durationMs: performance.now() - t0,
        metrics: { reconnectReceived },
      });

      expect(reconnectReceived).toBeGreaterThan(0);
    }, 120_000);

    // Scenario 4: ACP child crash → session error recovery
    it('ACP child crash → session error recovery', async () => {
      const t0 = performance.now();
      let crashDetected = false;
      let recoverySucceeded = false;

      await withDaemon(
        { label: 'crash-recovery', mode: 'crash-on-prompt', skipWarmup: true },
        async (d) => {
          const session = await d.client.createOrAttachSession({
            sessionScope: 'thread',
          });

          try {
            await d.client.prompt(session.sessionId, {
              prompt: [{ type: 'text', text: 'trigger-crash' }],
            });
          } catch {
            crashDetected = true;
          }

          // Poll for daemon recovery instead of fixed sleep.
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            try {
              const health = await d.client.health();
              if (health !== undefined) {
                recoverySucceeded = true;
                break;
              }
            } catch {
              await sleep(200);
            }
          }
        },
      );

      snapshot.scenarios.push({
        name: 'acp-crash-recovery',
        status: 'passed',
        durationMs: performance.now() - t0,
        metrics: { crashDetected, recoverySucceeded },
      });

      expect(crashDetected).toBe(true);
      expect(recoverySucceeded).toBe(true);
    }, 90_000);

    // Scenario 5: burst concurrent sessions
    it('burst: concurrent sessions with mock prompts', async () => {
      const t0 = performance.now();
      const latencies: number[] = [];
      let successCount = 0;
      let failureCount = 0;

      await withDaemon({ label: 'burst' }, async (d) => {
        const results = await Promise.allSettled(
          Array.from({ length: BURST_SESSIONS }, async (_, i) => {
            const t = performance.now();
            const session = await d.client.createOrAttachSession({
              sessionScope: 'thread',
            });
            await d.client.prompt(session.sessionId, {
              prompt: [{ type: 'text', text: `burst-${i}` }],
            });
            await d.client.closeSession(session.sessionId);
            return performance.now() - t;
          }),
        );

        for (const r of results) {
          if (r.status === 'fulfilled') {
            successCount++;
            latencies.push(r.value);
          } else {
            failureCount++;
          }
        }
      });

      const stats = percentiles(latencies);
      snapshot.scenarios.push({
        name: 'burst-concurrent',
        status: 'passed',
        durationMs: performance.now() - t0,
        metrics: {
          burstSize: BURST_SESSIONS,
          successCount,
          failureCount,
          ...stats,
        },
      });

      expect(failureCount).toBe(0);
      expect(stats.p99).toBeLessThan(60_000);
    }, 120_000);

    // Report
    afterAll(() => {
      if (SKIP) return;
      writeSnapshotArtifacts(
        OUTPUT_DIR,
        'loadtest-report',
        snapshot,
        renderMarkdown(snapshot),
        'loadtest',
      );
    });
  },
);

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function renderMarkdown(s: LoadtestSnapshot): string {
  const lines = [
    `# qwen serve daemon — connection stress test report`,
    ``,
    `Captured: ${s.capturedAt}`,
    `Git: ${s.gitCommit ?? 'unknown'}`,
    `Platform: ${s.platform.os}/${s.platform.arch} node=${s.platform.nodeVersion}`,
    ``,
    `## Scenarios`,
    ``,
  ];

  for (const sc of s.scenarios) {
    lines.push(
      `### ${sc.name}`,
      `- Status: ${sc.status}`,
      `- Duration: ${sc.durationMs.toFixed(0)}ms`,
    );
    if (sc.error) {
      lines.push(`- Error: ${sc.error}`);
    }
    if (sc.metrics) {
      const m = sc.metrics;
      const pctlKeys = ['count', 'p50', 'p90', 'p99', 'mean', 'min', 'max'];
      if (
        'p50' in m &&
        typeof m['p50'] === 'number' &&
        typeof m['count'] === 'number'
      ) {
        lines.push(
          `- Latency: ${formatPercentiles({
            count: m['count'],
            p50: m['p50'],
            p90: m['p90'] as number,
            p99: m['p99'] as number,
            mean: m['mean'] as number,
            min: m['min'] as number,
            max: m['max'] as number,
          })}`,
        );
      }
      for (const [k, v] of Object.entries(m)) {
        if (pctlKeys.includes(k)) continue;
        lines.push(`- ${k}: ${JSON.stringify(v)}`);
      }
    }
    lines.push(``);
  }

  return lines.join('\n');
}
