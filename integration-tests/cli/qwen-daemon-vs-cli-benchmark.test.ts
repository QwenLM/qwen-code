/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon vs CLI — performance benchmark.
 *
 * Compares the two qwen-code execution modes across startup latency,
 * session creation, memory footprint, and (when a model key is
 * available) prompt round-trip latency and concurrent queuing behavior.
 *
 * Gated by QWEN_BENCHMARK_ENABLED=1 — does NOT run in the default CI
 * suite. POSIX only (uses `ps`, `pgrep`, `/usr/bin/time`).
 *
 * Outputs a JSON + Markdown snapshot to the integration test output
 * directory, similar to `qwen-serve-baseline.test.ts`.
 */

import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { afterAll, describe, expect, it } from 'vitest';

import { DaemonHttpError } from '@qwen-code/sdk';
import {
  spawnDaemon,
  percentiles,
  gitHead,
  makeTempWorkspace,
  sleep,
  type SpawnedDaemon,
  type Percentiles,
} from './_daemon-harness.js';
import {
  spawnDaemonWithTime,
  spawnCliWithTime,
  measureProcessTreeRss,
  measureCliStartupWithProfiler,
  type ProcessResourceMetrics,
  type ProcessTreeRss,
  type StartupPhasesResult,
} from './_daemon-benchmark-helpers.js';
import {
  resolveOutputDir,
  formatPercentiles,
  writeSnapshotArtifacts,
  collectPlatformInfo,
} from './_daemon-perf-report.js';

// ---------------------------------------------------------------------------
// Skip logic
// ---------------------------------------------------------------------------

const SKIP =
  process.env['QWEN_BENCHMARK_ENABLED'] !== '1' ||
  process.platform === 'win32' ||
  Boolean(
    process.env['QWEN_SANDBOX'] &&
      process.env['QWEN_SANDBOX']!.toLowerCase() !== 'false',
  );

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HEAVY = process.env['BENCHMARK_HEAVY'] === '1';
const ITERATIONS = Number(
  process.env['BENCHMARK_ITERATIONS'] ?? (HEAVY ? 20 : 5),
);
const CONCURRENT_SESSIONS = Number(
  process.env['BENCHMARK_CONCURRENT_SESSIONS'] ?? (HEAVY ? 10 : 5),
);

const THROUGHPUT_WINDOW_S = Number(
  process.env['BENCHMARK_THROUGHPUT_WINDOW_S'] ?? (HEAVY ? 30 : 10),
);
const CHURN_ROUNDS = Number(
  process.env['BENCHMARK_CHURN_ROUNDS'] ?? ITERATIONS * 4,
);

const PROMPT_CREDENTIAL_ENV_KEYS = [
  'DASHSCOPE_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'QWEN_API_KEY',
];
const HAS_MODEL_KEY =
  PROMPT_CREDENTIAL_ENV_KEYS.some((k) => Boolean(process.env[k])) ||
  Object.entries(process.env).some(
    ([k, v]) => k.startsWith('QWEN_CUSTOM_API_KEY_') && Boolean(v),
  );
const SKIP_PROMPT = !HAS_MODEL_KEY;

const OUTPUT_DIR = resolveOutputDir('benchmark');

const THRESH = {
  cliColdStartP99MaxMs: 10_000,
  daemonBootP99MaxMs: 30_000,
  sessionCreateP99MaxMs: 5_000,
  daemonBaselineTreeRssMaxMB: 1_500,
  promptP99MaxMs: 120_000,
};

// ---------------------------------------------------------------------------
// Snapshot accumulator
// ---------------------------------------------------------------------------

interface BenchmarkSnapshot {
  version: 1;
  capturedAt: string;
  gitCommit: string | null;
  platform: { os: string; arch: string; nodeVersion: string };
  notes: string[];
  config: {
    iterations: number;
    concurrentSessions: number;
    heavy: boolean;
  };
  cliColdStart?: Percentiles & {
    peakRssMB: number | null;
    startupPhases?: {
      moduleLoadMs: number | null;
      configInitMs: number | null;
      mcpSettledMs: number | null;
      fullStartupMs: number | null;
    };
  };
  daemonBootLatency?: Percentiles;
  warmSessionCreation?: Percentiles;
  memoryBaseline?: {
    cliVersionPeakRssMB: number | null;
    daemon0Sessions: ProcessTreeRss | null;
    daemon5Sessions: ProcessTreeRss | null;
    daemon10Sessions: ProcessTreeRss | null;
    growthPerSessionMB: number | null;
  };
  singlePromptLatency?: {
    cli: Percentiles | null;
    daemon: Percentiles | null;
    skipped: boolean;
    skipReason?: string;
  };
  concurrentQueueingLatency?: {
    sessionCount: number;
    totalPrompts: number;
    wallClockMs: number;
    promptsPerSec: number;
    perPromptLatency: Percentiles;
    successCount: number;
    failureCount: number;
    skipped: boolean;
    skipReason?: string;
  };
  burstStress?: {
    latency: Percentiles;
    successRate: number;
    concurrency: number;
  };
  throughputStress?: {
    anchored: { opsPerSec: number; totalOps: number };
    unanchored: { opsPerSec: number; totalOps: number };
    windowSeconds: number;
  };
  sessionChurn?: {
    latency: Percentiles;
    rounds: number;
    rssDriftMB: number;
  };
  sessionLimitSaturation?: {
    limitEnforced: boolean;
    recoverySucceeded: boolean;
    errorCode: string;
  };
  sseConnectionFlood?: {
    connectionsOpened: number;
    allConnected: boolean;
    daemonHealthyAfter: boolean;
  };
  resourceProfile?: {
    cli: ProcessResourceMetrics | null;
    daemon: ProcessResourceMetrics | null;
  };
}

const snapshot: BenchmarkSnapshot = {
  version: 1,
  capturedAt: new Date().toISOString(),
  gitCommit: gitHead(),
  platform: collectPlatformInfo(),
  notes: [
    'CLI cold start uses -p mode with QWEN_CODE_PROFILE_STARTUP=1 to ' +
      'measure full initialization (Node startup + ESM + config + MCP ' +
      'discovery + auth). Profiler-reported fullStartupMs is used when ' +
      'available, else wall-clock time.',
    'Daemon boot latency includes HTTP listener startup. ACP child ' +
      'is preheated after listener start (fire-and-forget); first ' +
      'session creation coalesces onto the preheat if still in flight.',
    'Memory RSS is measured across the full process tree (daemon + ACP ' +
      'child + MCP grandchildren), not just the daemon parent.',
    'Stage 1 daemon uses a single ACP child — concurrent prompts are ' +
      'queued and processed serially at the ACP level. The concurrent ' +
      'queuing latency metric measures HTTP-layer concurrency handling, ' +
      'not true parallel prompt execution.',
  ],
  config: {
    iterations: ITERATIONS,
    concurrentSessions: CONCURRENT_SESSIONS,
    heavy: HEAVY,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

(SKIP ? describe.skip : describe)(
  'daemon vs CLI benchmark (POSIX-only, QWEN_BENCHMARK_ENABLED=1)',
  { retry: 0 },
  () => {
    // -----------------------------------------------------------------------
    // Phase 1: no-model metrics
    // -----------------------------------------------------------------------
    describe('Phase 1: no-model metrics', () => {
      it(
        'CLI cold start latency (full init via startup profiler)',
        async () => {
          const ws = makeTempWorkspace('cli-coldstart');
          try {
            const latencies: number[] = [];
            let lastResult: StartupPhasesResult | null = null;

            // Warmup (excluded)
            await measureCliStartupWithProfiler({ cwd: ws });

            for (let i = 0; i < ITERATIONS; i++) {
              const result = await measureCliStartupWithProfiler({ cwd: ws });
              // Use fullStartupMs (profiler) if available, else wall-clock
              latencies.push(result.fullStartupMs ?? result.wallClockMs);
              lastResult = result;
            }

            const stats = percentiles(latencies);
            snapshot.cliColdStart = {
              ...stats,
              peakRssMB: lastResult?.peakRssMB ?? null,
              startupPhases: lastResult
                ? {
                    moduleLoadMs: lastResult.moduleLoadMs,
                    configInitMs: lastResult.configInitMs,
                    mcpSettledMs: lastResult.mcpSettledMs,
                    fullStartupMs: lastResult.fullStartupMs,
                  }
                : undefined,
            };

            // Capture CLI resource metrics from last iteration
            const cliTimeResult = await spawnCliWithTime(
              ['-p', 'x', '--output-format', 'text'],
              { cwd: ws },
            );
            snapshot.resourceProfile = {
              ...snapshot.resourceProfile,
              cli: {
                peakRssMB: cliTimeResult.peakRssMB,
                userTimeMs: cliTimeResult.userTimeMs,
                sysTimeMs: cliTimeResult.sysTimeMs,
                voluntaryCtxSwitches: cliTimeResult.voluntaryCtxSwitches,
                involuntaryCtxSwitches: cliTimeResult.involuntaryCtxSwitches,
                pageFaults: cliTimeResult.pageFaults,
                pageReclaims: cliTimeResult.pageReclaims,
                instructionsRetired: cliTimeResult.instructionsRetired,
                cyclesElapsed: cliTimeResult.cyclesElapsed,
              },
              daemon: snapshot.resourceProfile?.daemon ?? null,
            };

            expect(stats.p99).toBeLessThan(THRESH.cliColdStartP99MaxMs);
          } finally {
            fs.rmSync(ws, { recursive: true, force: true });
          }
        },
        ITERATIONS * 30_000 + 60_000,
      );

      it(
        'daemon boot latency (including first session)',
        async () => {
          const latencies: number[] = [];
          let daemonResourceMetrics: ProcessResourceMetrics | null = null;

          for (let i = 0; i < ITERATIONS; i++) {
            const ws = makeTempWorkspace(`boot-${i}`);
            const isLast = i === ITERATIONS - 1;

            if (isLast) {
              // Last iteration: use /usr/bin/time wrapper to capture
              // resource metrics for the daemon lifecycle.
              let timedDaemon:
                | (SpawnedDaemon & {
                    getResourceMetrics: () => ProcessResourceMetrics;
                  })
                | undefined;
              try {
                const t0 = performance.now();
                timedDaemon = await spawnDaemonWithTime({
                  workspaceCwd: ws,
                  bootTimeoutMs: 35_000,
                });
                await timedDaemon.client.createOrAttachSession({
                  workspaceCwd: ws,
                });
                latencies.push(performance.now() - t0);
                await timedDaemon.dispose();
                daemonResourceMetrics = timedDaemon.getResourceMetrics();
              } finally {
                if (timedDaemon) await timedDaemon.dispose();
                fs.rmSync(ws, { recursive: true, force: true });
              }
            } else {
              let daemon: SpawnedDaemon | undefined;
              try {
                const t0 = performance.now();
                daemon = await spawnDaemon({
                  workspaceCwd: ws,
                  bootTimeoutMs: 35_000,
                });
                await daemon.client.createOrAttachSession({
                  workspaceCwd: ws,
                });
                latencies.push(performance.now() - t0);
              } finally {
                if (daemon) await daemon.dispose();
                fs.rmSync(ws, { recursive: true, force: true });
              }
            }
          }

          const stats = percentiles(latencies);
          snapshot.daemonBootLatency = stats;

          if (daemonResourceMetrics) {
            snapshot.resourceProfile = {
              cli: snapshot.resourceProfile?.cli ?? null,
              daemon: daemonResourceMetrics,
            };
          }

          expect(stats.p99).toBeLessThan(THRESH.daemonBootP99MaxMs);
        },
        ITERATIONS * 50_000 + 60_000,
      );

      it(
        'warm session creation latency',
        async () => {
          const ws = makeTempWorkspace('warm-session');
          let daemon: SpawnedDaemon | undefined;
          try {
            daemon = await spawnDaemon({
              workspaceCwd: ws,
              bootTimeoutMs: 35_000,
              extraArgs: ['--max-sessions', '0'],
            });

            // Warmup: first session triggers ACP child spawn.
            await daemon.client.createOrAttachSession({
              workspaceCwd: ws,
            });

            const latencies: number[] = [];
            for (let i = 0; i < ITERATIONS; i++) {
              const t0 = performance.now();
              await daemon.client.createOrAttachSession({
                workspaceCwd: ws,
                sessionScope: 'thread',
              });
              latencies.push(performance.now() - t0);
            }

            const stats = percentiles(latencies);
            snapshot.warmSessionCreation = stats;

            expect(stats.p99).toBeLessThan(THRESH.sessionCreateP99MaxMs);
          } finally {
            if (daemon) await daemon.dispose();
            fs.rmSync(ws, { recursive: true, force: true });
          }
        },
        ITERATIONS * 10_000 + 60_000,
      );

      it('memory baseline (process tree RSS)', async () => {
        const ws = makeTempWorkspace('memory');

        // CLI peak RSS via /usr/bin/time (full init path)
        const cliResult = await spawnCliWithTime(
          ['-p', 'x', '--output-format', 'text'],
          { cwd: ws },
        );
        const cliPeakRss = cliResult.peakRssMB;

        // Daemon RSS at 0/5/10 sessions
        let daemon: SpawnedDaemon | undefined;
        const sessionIds: string[] = [];
        try {
          daemon = await spawnDaemon({
            workspaceCwd: ws,
            bootTimeoutMs: 35_000,
            extraArgs: ['--max-sessions', '0'],
          });

          // Trigger ACP child spawn with first session
          const firstSession = await daemon.client.createOrAttachSession({
            workspaceCwd: ws,
          });
          sessionIds.push(firstSession.sessionId);
          await sleep(1000);
          const rss0 = daemon.daemon.pid
            ? measureProcessTreeRss(daemon.daemon.pid)
            : null;

          // Create 4 more sessions (total 5)
          for (let i = 0; i < 4; i++) {
            const s = await daemon.client.createOrAttachSession({
              workspaceCwd: ws,
              sessionScope: 'thread',
            });
            sessionIds.push(s.sessionId);
          }
          await sleep(1000);
          const rss5 = daemon.daemon.pid
            ? measureProcessTreeRss(daemon.daemon.pid)
            : null;

          // Create 5 more sessions (total 10)
          for (let i = 0; i < 5; i++) {
            const s = await daemon.client.createOrAttachSession({
              workspaceCwd: ws,
              sessionScope: 'thread',
            });
            sessionIds.push(s.sessionId);
          }
          await sleep(1000);
          const rss10 = daemon.daemon.pid
            ? measureProcessTreeRss(daemon.daemon.pid)
            : null;

          const growthPerSession =
            rss0 && rss10
              ? Math.round(((rss10.totalRssMB - rss0.totalRssMB) / 9) * 10) / 10
              : null;

          snapshot.memoryBaseline = {
            cliVersionPeakRssMB: cliPeakRss,
            daemon0Sessions: rss0,
            daemon5Sessions: rss5,
            daemon10Sessions: rss10,
            growthPerSessionMB: growthPerSession,
          };

          if (rss0) {
            expect(rss0.totalRssMB).toBeLessThan(
              THRESH.daemonBaselineTreeRssMaxMB,
            );
          }
        } finally {
          if (daemon) {
            for (const sid of sessionIds) {
              try {
                await daemon.client.closeSession(sid);
              } catch {
                /* best-effort */
              }
            }
            await daemon.dispose();
          }
          fs.rmSync(ws, { recursive: true, force: true });
        }
      }, 120_000);
    });

    // -----------------------------------------------------------------------
    // Phase 2: model-dependent metrics
    // -----------------------------------------------------------------------
    describe('Phase 2: model-dependent metrics', () => {
      if (!SKIP_PROMPT) {
        it(
          'single prompt latency — CLI vs daemon',
          async () => {
            const ws = makeTempWorkspace('prompt');
            let daemon: SpawnedDaemon | undefined;
            try {
              // --- CLI side ---
              const cliLatencies: number[] = [];
              // Warmup
              await spawnCliWithTime(
                [
                  '-p',
                  'reply with the single word ok',
                  '--output-format',
                  'text',
                ],
                { cwd: ws },
              );
              for (let i = 0; i < ITERATIONS; i++) {
                const result = await spawnCliWithTime(
                  [
                    '-p',
                    'reply with the single word ok',
                    '--output-format',
                    'text',
                  ],
                  { cwd: ws },
                );
                cliLatencies.push(result.wallClockMs);
              }

              // --- Daemon side ---
              daemon = await spawnDaemon({
                workspaceCwd: ws,
                bootTimeoutMs: 35_000,
              });
              const session = await daemon.client.createOrAttachSession({
                workspaceCwd: ws,
              });

              const daemonLatencies: number[] = [];
              // Warmup
              await daemon.client.prompt(session.sessionId, {
                prompt: [
                  { type: 'text', text: 'reply with the single word ok' },
                ],
              });
              for (let i = 0; i < ITERATIONS; i++) {
                const t0 = performance.now();
                await daemon.client.prompt(session.sessionId, {
                  prompt: [
                    { type: 'text', text: 'reply with the single word ok' },
                  ],
                });
                daemonLatencies.push(performance.now() - t0);
              }

              snapshot.singlePromptLatency = {
                cli: percentiles(cliLatencies),
                daemon: percentiles(daemonLatencies),
                skipped: false,
              };

              expect(snapshot.singlePromptLatency.cli!.p99).toBeLessThan(
                THRESH.promptP99MaxMs,
              );
              expect(snapshot.singlePromptLatency.daemon!.p99).toBeLessThan(
                THRESH.promptP99MaxMs,
              );
            } finally {
              if (daemon) await daemon.dispose();
              fs.rmSync(ws, { recursive: true, force: true });
            }
          },
          ITERATIONS * 180_000 + 60_000,
        );

        it(
          'concurrent queuing latency (daemon only)',
          async () => {
            const ws = makeTempWorkspace('concurrent');
            let daemon: SpawnedDaemon | undefined;
            const sessionIds: string[] = [];
            try {
              daemon = await spawnDaemon({
                workspaceCwd: ws,
                bootTimeoutMs: 35_000,
              });

              // Create M sessions
              for (let i = 0; i < CONCURRENT_SESSIONS; i++) {
                const s = await daemon.client.createOrAttachSession({
                  workspaceCwd: ws,
                  sessionScope: 'thread',
                });
                sessionIds.push(s.sessionId);
              }

              // Fire all prompts concurrently
              const perPromptLatencies: number[] = [];
              const wallT0 = performance.now();

              const results = await Promise.allSettled(
                sessionIds.map(async (sid) => {
                  const t0 = performance.now();
                  await daemon!.client.prompt(sid, {
                    prompt: [
                      { type: 'text', text: 'reply with the single word ok' },
                    ],
                  });
                  perPromptLatencies.push(performance.now() - t0);
                }),
              );

              const wallClockMs = performance.now() - wallT0;
              const successCount = results.filter(
                (r) => r.status === 'fulfilled',
              ).length;
              const failureCount = results.filter(
                (r) => r.status === 'rejected',
              ).length;

              snapshot.concurrentQueueingLatency = {
                sessionCount: CONCURRENT_SESSIONS,
                totalPrompts: CONCURRENT_SESSIONS,
                wallClockMs,
                promptsPerSec:
                  Math.round((successCount / (wallClockMs / 1000)) * 100) / 100,
                perPromptLatency: percentiles(perPromptLatencies),
                successCount,
                failureCount,
                skipped: false,
              };

              expect(wallClockMs).toBeLessThan(
                CONCURRENT_SESSIONS * THRESH.promptP99MaxMs,
              );
            } finally {
              if (daemon) {
                for (const sid of sessionIds) {
                  try {
                    await daemon.client.closeSession(sid);
                  } catch {
                    /* best-effort */
                  }
                }
                await daemon.dispose();
              }
              fs.rmSync(ws, { recursive: true, force: true });
            }
          },
          CONCURRENT_SESSIONS * 180_000 + 120_000,
        );
      }

      if (SKIP_PROMPT) {
        it('prompt tests skipped (no model credential env)', () => {
          snapshot.singlePromptLatency = {
            cli: null,
            daemon: null,
            skipped: true,
            skipReason:
              'No recognized model credential env var is set. ' +
              'Prompt benchmarks require real model access.',
          };
          snapshot.concurrentQueueingLatency = {
            sessionCount: 0,
            totalPrompts: 0,
            wallClockMs: 0,
            promptsPerSec: 0,
            perPromptLatency: percentiles([]),
            successCount: 0,
            failureCount: 0,
            skipped: true,
            skipReason:
              'No recognized model credential env var is set. ' +
              'Concurrent benchmarks require real model access.',
          };
          expect(true).toBe(true);
        });
      }
    });

    // -----------------------------------------------------------------------
    // Phase 3: stress tests (no model required)
    // -----------------------------------------------------------------------
    describe('Phase 3: stress tests', () => {
      it(
        'concurrent burst — N simultaneous session creations (daemon)',
        async () => {
          const ws = makeTempWorkspace('burst');
          let daemon: SpawnedDaemon | undefined;
          const sessionIds: string[] = [];
          try {
            daemon = await spawnDaemon({
              workspaceCwd: ws,
              bootTimeoutMs: 35_000,
              extraArgs: ['--max-sessions', '0'],
            });
            // First session triggers ACP child spawn (included in boot,
            // not in burst measurement).
            const warmup = await daemon.client.createOrAttachSession({
              workspaceCwd: ws,
            });
            sessionIds.push(warmup.sessionId);

            const latencies: number[] = [];
            const results = await Promise.allSettled(
              Array.from({ length: CONCURRENT_SESSIONS }, async () => {
                const t0 = performance.now();
                const s = await daemon!.client.createOrAttachSession({
                  workspaceCwd: ws,
                  sessionScope: 'thread',
                });
                latencies.push(performance.now() - t0);
                sessionIds.push(s.sessionId);
              }),
            );

            const successCount = results.filter(
              (r) => r.status === 'fulfilled',
            ).length;

            snapshot.burstStress = {
              latency: percentiles(latencies),
              successRate: successCount / CONCURRENT_SESSIONS,
              concurrency: CONCURRENT_SESSIONS,
            };

            expect(successCount).toBe(CONCURRENT_SESSIONS);
            expect(snapshot.burstStress.latency.p99).toBeLessThan(15_000);
          } finally {
            if (daemon) {
              for (const sid of sessionIds) {
                try {
                  await daemon.client.closeSession(sid);
                } catch {
                  /* best-effort */
                }
              }
              await daemon.dispose();
            }
            fs.rmSync(ws, { recursive: true, force: true });
          }
        },
        CONCURRENT_SESSIONS * 20_000 + 60_000,
      );

      it(
        'sustained throughput — session create+close ops/sec (daemon)',
        async () => {
          const ws = makeTempWorkspace('throughput');
          let daemon: SpawnedDaemon | undefined;
          const anchorIds: string[] = [];
          try {
            daemon = await spawnDaemon({
              workspaceCwd: ws,
              bootTimeoutMs: 35_000,
              extraArgs: ['--max-sessions', '0'],
            });

            const windowMs = THROUGHPUT_WINDOW_S * 1000;

            // --- Anchored: 3 anchor sessions keep ACP child alive ---
            for (let i = 0; i < 3; i++) {
              const s = await daemon.client.createOrAttachSession({
                workspaceCwd: ws,
                sessionScope: 'thread',
              });
              anchorIds.push(s.sessionId);
            }

            let anchoredOps = 0;
            const anchoredEnd = performance.now() + windowMs;
            while (performance.now() < anchoredEnd) {
              const s = await daemon.client.createOrAttachSession({
                workspaceCwd: ws,
                sessionScope: 'thread',
              });
              await daemon.client.closeSession(s.sessionId);
              anchoredOps++;
            }

            // Clean up anchors before unanchored run
            for (const sid of anchorIds) {
              try {
                await daemon.client.closeSession(sid);
              } catch {
                /* best-effort */
              }
            }
            anchorIds.length = 0;

            // --- Unanchored: no anchor sessions, each close kills ACP ---
            // First create triggers ACP respawn; subsequent cycles include
            // full ACP teardown + respawn cost.
            let unanchoredOps = 0;
            const unanchoredEnd = performance.now() + windowMs;
            while (performance.now() < unanchoredEnd) {
              const s = await daemon.client.createOrAttachSession({
                workspaceCwd: ws,
                sessionScope: 'thread',
              });
              await daemon.client.closeSession(s.sessionId);
              unanchoredOps++;
            }

            snapshot.throughputStress = {
              anchored: {
                opsPerSec:
                  Math.round((anchoredOps / THROUGHPUT_WINDOW_S) * 100) / 100,
                totalOps: anchoredOps,
              },
              unanchored: {
                opsPerSec:
                  Math.round((unanchoredOps / THROUGHPUT_WINDOW_S) * 100) / 100,
                totalOps: unanchoredOps,
              },
              windowSeconds: THROUGHPUT_WINDOW_S,
            };

            expect(anchoredOps).toBeGreaterThan(0);
            expect(unanchoredOps).toBeGreaterThan(0);
          } finally {
            if (daemon) {
              for (const sid of anchorIds) {
                try {
                  await daemon.client.closeSession(sid);
                } catch {
                  /* best-effort */
                }
              }
              await daemon.dispose();
            }
            fs.rmSync(ws, { recursive: true, force: true });
          }
        },
        THROUGHPUT_WINDOW_S * 2 * 1000 + 120_000,
      );

      it(
        'session churn + leak detection (daemon only)',
        async () => {
          const ws = makeTempWorkspace('churn');
          let daemon: SpawnedDaemon | undefined;
          const anchorIds: string[] = [];
          try {
            daemon = await spawnDaemon({
              workspaceCwd: ws,
              bootTimeoutMs: 35_000,
              extraArgs: ['--max-sessions', '0'],
            });

            // 3 anchor sessions keep ACP alive
            for (let i = 0; i < 3; i++) {
              const s = await daemon.client.createOrAttachSession({
                workspaceCwd: ws,
                sessionScope: 'thread',
              });
              anchorIds.push(s.sessionId);
            }
            await sleep(500);

            const rssBefore = daemon.daemon.pid
              ? measureProcessTreeRss(daemon.daemon.pid)
              : null;

            const churnLatencies: number[] = [];
            for (let i = 0; i < CHURN_ROUNDS; i++) {
              const t0 = performance.now();
              const s = await daemon.client.createOrAttachSession({
                workspaceCwd: ws,
                sessionScope: 'thread',
              });
              await daemon.client.closeSession(s.sessionId);
              churnLatencies.push(performance.now() - t0);
            }

            await sleep(500);
            const rssAfter = daemon.daemon.pid
              ? measureProcessTreeRss(daemon.daemon.pid)
              : null;

            const rssDrift =
              rssBefore && rssAfter
                ? Math.round(
                    (rssAfter.totalRssMB - rssBefore.totalRssMB) * 10,
                  ) / 10
                : 0;

            snapshot.sessionChurn = {
              latency: percentiles(churnLatencies),
              rounds: CHURN_ROUNDS,
              rssDriftMB: rssDrift,
            };

            expect(Math.abs(rssDrift)).toBeLessThan(100);
          } finally {
            if (daemon) {
              for (const sid of anchorIds) {
                try {
                  await daemon.client.closeSession(sid);
                } catch {
                  /* best-effort */
                }
              }
              await daemon.dispose();
            }
            fs.rmSync(ws, { recursive: true, force: true });
          }
        },
        CHURN_ROUNDS * 5_000 + 120_000,
      );

      it('session limit saturation and recovery (daemon only)', async () => {
        const MAX = 5;
        const ws = makeTempWorkspace('limit');
        let daemon: SpawnedDaemon | undefined;
        const sessionIds: string[] = [];
        try {
          daemon = await spawnDaemon({
            workspaceCwd: ws,
            bootTimeoutMs: 35_000,
            extraArgs: ['--max-sessions', String(MAX)],
          });

          // Fill to max
          for (let i = 0; i < MAX; i++) {
            const s = await daemon.client.createOrAttachSession({
              workspaceCwd: ws,
              sessionScope: 'thread',
            });
            sessionIds.push(s.sessionId);
          }

          // Attempt to exceed — expect 503
          let limitEnforced = false;
          let errorCode = '';
          try {
            await daemon.client.createOrAttachSession({
              workspaceCwd: ws,
              sessionScope: 'thread',
            });
          } catch (err) {
            if (err instanceof DaemonHttpError && err.status === 503) {
              limitEnforced = true;
              const body = err.body as Record<string, unknown> | undefined;
              errorCode = String(body?.['code'] ?? '');
            }
          }

          // Release one slot and recover
          await daemon.client.closeSession(sessionIds.shift()!);
          let recoverySucceeded = false;
          try {
            const s = await daemon.client.createOrAttachSession({
              workspaceCwd: ws,
              sessionScope: 'thread',
            });
            sessionIds.push(s.sessionId);
            recoverySucceeded = true;
          } catch {
            recoverySucceeded = false;
          }

          snapshot.sessionLimitSaturation = {
            limitEnforced,
            recoverySucceeded,
            errorCode,
          };

          expect(limitEnforced).toBe(true);
          expect(errorCode).toBe('session_limit_exceeded');
          expect(recoverySucceeded).toBe(true);
        } finally {
          if (daemon) {
            for (const sid of sessionIds) {
              try {
                await daemon.client.closeSession(sid);
              } catch {
                /* best-effort */
              }
            }
            await daemon.dispose();
          }
          fs.rmSync(ws, { recursive: true, force: true });
        }
      }, 60_000);

      it('SSE connection flood (daemon only)', async () => {
        const N = CONCURRENT_SESSIONS * 2;
        const ws = makeTempWorkspace('sse-flood');
        let daemon: SpawnedDaemon | undefined;
        const abortControllers: AbortController[] = [];
        let sessionId = '';
        try {
          daemon = await spawnDaemon({
            workspaceCwd: ws,
            bootTimeoutMs: 35_000,
          });
          const s = await daemon.client.createOrAttachSession({
            workspaceCwd: ws,
          });
          sessionId = s.sessionId;

          // Open N SSE connections concurrently.
          // Each waits for replay_complete (proves connection is live).
          let connectedCount = 0;
          const connectionResults = await Promise.allSettled(
            Array.from({ length: N }, async () => {
              const ac = new AbortController();
              abortControllers.push(ac);
              const timer = setTimeout(() => ac.abort(), 10_000);
              try {
                for await (const ev of daemon!.client.subscribeEvents(
                  sessionId,
                  { signal: ac.signal, lastEventId: 0 },
                )) {
                  if (ev.type === 'replay_complete') {
                    connectedCount++;
                    break;
                  }
                }
              } catch (err) {
                if (
                  err instanceof Error &&
                  (err.name === 'AbortError' || /abort/i.test(err.message))
                ) {
                  return;
                }
                throw err;
              } finally {
                clearTimeout(timer);
              }
            }),
          );

          // Abort all remaining connections
          for (const ac of abortControllers) {
            ac.abort();
          }

          // Verify daemon is still healthy
          const health = await daemon.client.health();
          const daemonHealthy = health.status === 'ok';

          const allConnected =
            connectionResults.filter((r) => r.status === 'fulfilled').length ===
            N;

          snapshot.sseConnectionFlood = {
            connectionsOpened: N,
            allConnected,
            daemonHealthyAfter: daemonHealthy,
          };

          expect(daemonHealthy).toBe(true);
          expect(connectedCount).toBe(N);
        } finally {
          for (const ac of abortControllers) {
            ac.abort();
          }
          if (daemon) {
            try {
              await daemon.client.closeSession(sessionId);
            } catch {
              /* best-effort */
            }
            await daemon.dispose();
          }
          fs.rmSync(ws, { recursive: true, force: true });
        }
      }, 30_000);
    });

    // -----------------------------------------------------------------------
    // Output
    // -----------------------------------------------------------------------
    afterAll(() => {
      if (SKIP) return;

      // Console summary
      const fmtP = (p: Percentiles | null | undefined): string =>
        p && p.count > 0
          ? `p50=${p.p50.toFixed(0)}ms  p90=${p.p90.toFixed(0)}ms  p99=${p.p99.toFixed(0)}ms  (n=${p.count})`
          : 'n/a';

      console.log('\n[benchmark] ---- daemon vs CLI summary ----');
      console.log(
        `  CLI cold start:      ${fmtP(snapshot.cliColdStart)}${
          snapshot.cliColdStart?.peakRssMB
            ? `  RSS=${snapshot.cliColdStart.peakRssMB}MB`
            : ''
        }`,
      );
      const sp = snapshot.cliColdStart?.startupPhases;
      if (sp) {
        console.log(
          `    phases:            module=${sp.moduleLoadMs ?? '?'}ms  configInit=${sp.configInitMs ?? '?'}ms  mcpSettled=${sp.mcpSettledMs ?? '?'}ms`,
        );
      }
      console.log(`  Daemon boot+1st:     ${fmtP(snapshot.daemonBootLatency)}`);
      console.log(
        `  Warm session create: ${fmtP(snapshot.warmSessionCreation)}`,
      );

      if (snapshot.memoryBaseline) {
        const mb = snapshot.memoryBaseline;
        const d0 = mb.daemon0Sessions;
        const d10 = mb.daemon10Sessions;
        console.log(
          `  Memory (daemon 0s):  ${d0 ? `total=${Math.round(d0.totalRssMB * 10) / 10}MB (daemon=${d0.daemonRssMB} acp=${d0.acpChildRssMB} mcp=${d0.mcpChildrenRssMB})` : 'n/a'}`,
        );
        console.log(
          `  Memory (daemon 10s): ${d10 ? `total=${Math.round(d10.totalRssMB * 10) / 10}MB (+${mb.growthPerSessionMB}MB/session)` : 'n/a'}`,
        );
        console.log(
          `  Memory (CLI -p init):  ${mb.cliVersionPeakRssMB ? `${mb.cliVersionPeakRssMB}MB` : 'n/a'}`,
        );
      }

      const spl = snapshot.singlePromptLatency;
      if (spl && !spl.skipped) {
        console.log(`  Prompt CLI:          ${fmtP(spl.cli)}`);
        console.log(`  Prompt daemon:       ${fmtP(spl.daemon)}`);
      } else {
        console.log('  Prompt:              skipped (no model key)');
      }

      const cql = snapshot.concurrentQueueingLatency;
      if (cql && !cql.skipped) {
        console.log(
          `  Concurrent (${cql.sessionCount}x):   ${cql.promptsPerSec} prompts/sec  wall=${cql.wallClockMs.toFixed(0)}ms  success=${cql.successCount}/${cql.totalPrompts}`,
        );
      }

      // Phase 3 stress tests
      const burst = snapshot.burstStress;
      if (burst) {
        console.log(
          `  Burst (${burst.concurrency}x):      ${fmtP(burst.latency)}  success=${(burst.successRate * 100).toFixed(0)}%`,
        );
      }

      const tp = snapshot.throughputStress;
      if (tp) {
        console.log(
          `  Throughput anchored: ${tp.anchored.opsPerSec} ops/sec (${tp.anchored.totalOps} ops in ${tp.windowSeconds}s)`,
        );
        console.log(
          `  Throughput cold:     ${tp.unanchored.opsPerSec} ops/sec (${tp.unanchored.totalOps} ops in ${tp.windowSeconds}s, incl. ACP respawn)`,
        );
      }

      const churn = snapshot.sessionChurn;
      if (churn) {
        console.log(
          `  Session churn:       ${fmtP(churn.latency)}  RSS drift=${churn.rssDriftMB}MB (${churn.rounds} rounds)`,
        );
      }

      const lim = snapshot.sessionLimitSaturation;
      if (lim) {
        console.log(
          `  Limit saturation:    enforced=${lim.limitEnforced} recovery=${lim.recoverySucceeded} code=${lim.errorCode}`,
        );
      }

      const sse = snapshot.sseConnectionFlood;
      if (sse) {
        console.log(
          `  SSE flood:           ${sse.connectionsOpened} connections  allConnected=${sse.allConnected}  healthy=${sse.daemonHealthyAfter}`,
        );
      }

      const rp = snapshot.resourceProfile;
      if (rp) {
        const fmtRes = (label: string, m: ProcessResourceMetrics | null) => {
          if (!m) return;
          const parts = [
            m.userTimeMs !== null ? `user=${m.userTimeMs}ms` : null,
            m.sysTimeMs !== null ? `sys=${m.sysTimeMs}ms` : null,
            m.voluntaryCtxSwitches !== null
              ? `vol_ctx=${m.voluntaryCtxSwitches}`
              : null,
            m.involuntaryCtxSwitches !== null
              ? `invol_ctx=${m.involuntaryCtxSwitches}`
              : null,
            m.pageFaults !== null ? `faults=${m.pageFaults}` : null,
            m.instructionsRetired !== null
              ? `instr=${(m.instructionsRetired / 1e6).toFixed(1)}M`
              : null,
          ].filter(Boolean);
          console.log(`  ${label}  ${parts.join('  ')}`);
        };
        fmtRes('Resources CLI:    ', rp.cli);
        fmtRes('Resources daemon: ', rp.daemon);
      }

      console.log('[benchmark] ---- end summary ----\n');

      writeSnapshotArtifacts(
        OUTPUT_DIR,
        'daemon-vs-cli-benchmark',
        snapshot,
        renderMarkdown(snapshot),
        'benchmark',
      );
    });
  },
);

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function renderMarkdown(s: BenchmarkSnapshot): string {
  const fmtP = formatPercentiles;

  const fmtTree = (r: ProcessTreeRss | null): string =>
    r
      ? `total=${Math.round(r.totalRssMB * 10) / 10}MB (daemon=${r.daemonRssMB} acp=${r.acpChildRssMB} mcp=${r.mcpChildrenRssMB})`
      : 'n/a';

  const lines = [
    `# qwen daemon vs CLI — performance benchmark`,
    ``,
    `Captured: ${s.capturedAt}`,
    `Git: ${s.gitCommit ?? 'unknown'}`,
    `Platform: ${s.platform.os}/${s.platform.arch} node=${s.platform.nodeVersion}`,
    `Iterations: ${s.config.iterations}  Concurrent: ${s.config.concurrentSessions}  Heavy: ${s.config.heavy}`,
    ``,
    `> **Note:** ${s.notes.join(' ')}`,
    ``,
    `## Phase 1: No-Model Metrics`,
    ``,
    `### CLI Cold Start (full init)`,
    s.cliColdStart
      ? (() => {
          const lines2 = [
            `- Latency: ${fmtP(s.cliColdStart)}`,
            `- Peak RSS: ${s.cliColdStart.peakRssMB ?? 'n/a'} MB`,
          ];
          const sp2 = s.cliColdStart.startupPhases;
          if (sp2) {
            lines2.push(
              `- Phase breakdown: module_load=${sp2.moduleLoadMs ?? '?'}ms, config_init=${sp2.configInitMs ?? '?'}ms, mcp_settled=${sp2.mcpSettledMs ?? '?'}ms`,
            );
          }
          lines2.push(
            `- *Measures full CLI init: Node startup + ESM + config + MCP discovery + auth (via startup profiler)*`,
          );
          return lines2.join('\n');
        })()
      : 'not run',
    ``,
    `### Daemon Boot (incl. first session)`,
    s.daemonBootLatency
      ? `- Latency: ${fmtP(s.daemonBootLatency)}\n- *Includes HTTP listener + ACP child spawn + first session creation*`
      : 'not run',
    ``,
    `### Warm Session Creation`,
    s.warmSessionCreation
      ? `- Latency: ${fmtP(s.warmSessionCreation)}\n- *ACP child already running; measures session creation overhead only*`
      : 'not run',
    ``,
    `### Memory Baseline (process tree RSS)`,
  ];

  if (s.memoryBaseline) {
    const mb = s.memoryBaseline;
    lines.push(
      `- CLI peak RSS (full init): ${mb.cliVersionPeakRssMB ?? 'n/a'} MB`,
      `- Daemon at 1 session: ${fmtTree(mb.daemon0Sessions)}`,
      `- Daemon at 5 sessions: ${fmtTree(mb.daemon5Sessions)}`,
      `- Daemon at 10 sessions: ${fmtTree(mb.daemon10Sessions)}`,
      `- Growth per session: ${mb.growthPerSessionMB ?? 'n/a'} MB`,
    );
  } else {
    lines.push('not run');
  }

  lines.push(``, `## Phase 2: Model-Dependent Metrics`, ``);

  const spl = s.singlePromptLatency;
  lines.push(`### Single Prompt Latency`);
  if (spl) {
    if (spl.skipped) {
      lines.push(`skipped (${spl.skipReason})`);
    } else {
      lines.push(
        `| Metric | CLI | Daemon |`,
        `|--------|-----|--------|`,
        `| p50    | ${spl.cli?.p50.toFixed(0) ?? '-'}ms | ${spl.daemon?.p50.toFixed(0) ?? '-'}ms |`,
        `| p90    | ${spl.cli?.p90.toFixed(0) ?? '-'}ms | ${spl.daemon?.p90.toFixed(0) ?? '-'}ms |`,
        `| p99    | ${spl.cli?.p99.toFixed(0) ?? '-'}ms | ${spl.daemon?.p99.toFixed(0) ?? '-'}ms |`,
        `| mean   | ${spl.cli?.mean.toFixed(0) ?? '-'}ms | ${spl.daemon?.mean.toFixed(0) ?? '-'}ms |`,
        ``,
        `*CLI = end-to-end (spawn+init+model+exit). Daemon = HTTP round-trip+model. Difference ≈ CLI startup amortization.*`,
      );
    }
  } else {
    lines.push('not run');
  }

  lines.push(``);
  const cql = s.concurrentQueueingLatency;
  lines.push(`### Concurrent Queuing Latency (daemon)`);
  if (cql) {
    if (cql.skipped) {
      lines.push(`skipped (${cql.skipReason})`);
    } else {
      lines.push(
        `- Sessions: ${cql.sessionCount}`,
        `- Wall clock: ${cql.wallClockMs.toFixed(0)}ms`,
        `- Throughput: ${cql.promptsPerSec} prompts/sec`,
        `- Success: ${cql.successCount}/${cql.totalPrompts}`,
        `- Per-prompt latency: ${fmtP(cql.perPromptLatency)}`,
        ``,
        `*Stage 1 single-ACP-child mode — prompts queue serially at the ACP level.*`,
      );
    }
  } else {
    lines.push('not run');
  }

  // Phase 3: stress tests
  lines.push(``, `## Phase 3: Stress Tests`, ``);

  const burst = s.burstStress;
  lines.push(`### Concurrent Burst (daemon)`);
  if (burst) {
    lines.push(
      `- Concurrency: ${burst.concurrency}`,
      `- Latency: ${fmtP(burst.latency)}`,
      `- Success rate: ${(burst.successRate * 100).toFixed(0)}%`,
      `- *Measures ${burst.concurrency} simultaneous session creations on a warm daemon (ACP child already running)*`,
    );
  } else {
    lines.push('not run');
  }

  lines.push(``);
  const tp = s.throughputStress;
  lines.push(`### Sustained Throughput (daemon)`);
  if (tp) {
    lines.push(
      `| Mode | ops/sec | total ops | window |`,
      `|------|---------|-----------|--------|`,
      `| Anchored (ACP stays alive) | ${tp.anchored.opsPerSec} | ${tp.anchored.totalOps} | ${tp.windowSeconds}s |`,
      `| Unanchored (ACP respawns each cycle) | ${tp.unanchored.opsPerSec} | ${tp.unanchored.totalOps} | ${tp.windowSeconds}s |`,
      ``,
      `*Anchored: 3 sessions keep ACP child alive during create+close cycles (steady-state). Unanchored: each close kills ACP child, next create respawns it (cold-cycle cost).*`,
    );
  } else {
    lines.push('not run');
  }

  lines.push(``);
  const churn = s.sessionChurn;
  lines.push(`### Session Churn + Leak Detection (daemon)`);
  if (churn) {
    lines.push(
      `- Rounds: ${churn.rounds}`,
      `- Latency: ${fmtP(churn.latency)}`,
      `- RSS drift: ${churn.rssDriftMB} MB`,
      `- *Drift < 100MB is normal V8 fragmentation; > 100MB indicates potential leak*`,
    );
  } else {
    lines.push('not run');
  }

  lines.push(``);
  const lim = s.sessionLimitSaturation;
  lines.push(`### Session Limit Saturation (daemon)`);
  if (lim) {
    lines.push(
      `- Limit enforced: ${lim.limitEnforced}`,
      `- Error code: ${lim.errorCode}`,
      `- Recovery after close: ${lim.recoverySucceeded}`,
    );
  } else {
    lines.push('not run');
  }

  lines.push(``);
  const sse = s.sseConnectionFlood;
  lines.push(`### SSE Connection Flood (daemon)`);
  if (sse) {
    lines.push(
      `- Connections opened: ${sse.connectionsOpened}`,
      `- All connected: ${sse.allConnected}`,
      `- Daemon healthy after: ${sse.daemonHealthyAfter}`,
    );
  } else {
    lines.push('not run');
  }

  // Resource profile
  const rp = s.resourceProfile;
  lines.push(``, `## Resource Profile (via /usr/bin/time)`, ``);
  if (rp && (rp.cli || rp.daemon)) {
    const fmtVal = (v: number | null, unit = '') =>
      v !== null ? `${v}${unit}` : '-';
    const fmtM = (v: number | null) =>
      v !== null ? `${(v / 1e6).toFixed(1)}M` : '-';

    lines.push(
      `| Metric | CLI (-p, full init) | Daemon (boot+session+exit) |`,
      `|--------|---------------------|---------------------------|`,
      `| Peak RSS | ${fmtVal(rp.cli?.peakRssMB ?? null, ' MB')} | ${fmtVal(rp.daemon?.peakRssMB ?? null, ' MB')} |`,
      `| User CPU | ${fmtVal(rp.cli?.userTimeMs ?? null, ' ms')} | ${fmtVal(rp.daemon?.userTimeMs ?? null, ' ms')} |`,
      `| System CPU | ${fmtVal(rp.cli?.sysTimeMs ?? null, ' ms')} | ${fmtVal(rp.daemon?.sysTimeMs ?? null, ' ms')} |`,
      `| Voluntary ctx switches | ${fmtVal(rp.cli?.voluntaryCtxSwitches ?? null)} | ${fmtVal(rp.daemon?.voluntaryCtxSwitches ?? null)} |`,
      `| Involuntary ctx switches | ${fmtVal(rp.cli?.involuntaryCtxSwitches ?? null)} | ${fmtVal(rp.daemon?.involuntaryCtxSwitches ?? null)} |`,
      `| Page faults (major) | ${fmtVal(rp.cli?.pageFaults ?? null)} | ${fmtVal(rp.daemon?.pageFaults ?? null)} |`,
      `| Page reclaims (minor) | ${fmtVal(rp.cli?.pageReclaims ?? null)} | ${fmtVal(rp.daemon?.pageReclaims ?? null)} |`,
      `| Instructions retired | ${fmtM(rp.cli?.instructionsRetired ?? null)} | ${fmtM(rp.daemon?.instructionsRetired ?? null)} |`,
      `| Cycles elapsed | ${fmtM(rp.cli?.cyclesElapsed ?? null)} | ${fmtM(rp.daemon?.cyclesElapsed ?? null)} |`,
      ``,
      `*CLI = single -p invocation (full init path). Daemon = full boot → first session → SIGTERM lifecycle.*`,
    );
  } else {
    lines.push('not run');
  }

  lines.push(``);
  return lines.join('\n');
}
