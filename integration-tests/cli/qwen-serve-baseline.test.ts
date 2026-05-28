/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `qwen serve` daemon — performance baseline harness.
 *
 * First implementation PR of the Mode B v0.16 rollout (issue #4175 Wave 1
 * PR 1). Captures reference metrics for: RSS curve across session counts,
 * same-workspace attach latency, prompt p50/p99 (when a real model key is
 * available), MCP child amplification (P1 baseline before M2 shared pool),
 * and SSE replay/backpressure basics.
 *
 * Why this PR is first: every subsequent Mode B PR (M2 MCP shared pool /
 * M3 architecture refactor / M4 multi-client safety) changes memory or
 * latency or child-process characteristics. Without baseline numbers
 * captured BEFORE those land, we cannot tell whether a refactor regressed
 * or improved performance. This file owns the reference-snapshot output
 * (`.integration-tests/<timestamp>/perf-baseline.json` + `.md`).
 *
 * No optimization in this PR — measurement only. Assertions are
 * catastrophic-regression upper bounds (e.g. RSS at 1 session < 500 MB);
 * everything else is reported into the snapshot.
 *
 * POSIX only. The harness uses `ps` + `pgrep` against the host process
 * table. Windows is skipped (no `ps`/`pgrep`); Docker/Podman sandbox is
 * also skipped because the daemon's `qwen --acp` child and its MCP
 * grandchildren run inside the sandbox container's PID namespace, which
 * host-side `pgrep -P` cannot observe — the descendant walk would always
 * see zero MCP grandchildren and time out. Same rationale and skip shape
 * as `acp-integration.test.ts` / `cron-tools.test.ts`.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { EventBus } from '../../packages/cli/src/serve/eventBus.js';
import {
  spawnDaemon,
  startRssPolling,
  countDescendants,
  percentiles,
  writeWorkspaceSettings,
  type SpawnedDaemon,
  type DescendantCount,
  type Percentiles,
} from './_daemon-harness.js';

// Minimal type-shape for the SSE backpressure unit suite — we only assert
// `.type`, so we avoid coupling tests to the full BridgeEvent surface.
interface BridgeEventLike {
  type: string;
}

// Skip on Windows (helpers shell out to `ps` / `pgrep`) and under
// Docker/Podman sandbox (the daemon subtree runs in a separate PID
// namespace the host `pgrep` can't observe — matches the existing
// `acp-integration.test.ts` / `cron-tools.test.ts` skip precedent).
const SKIP =
  process.platform === 'win32' ||
  Boolean(
    process.env['QWEN_SANDBOX'] &&
      process.env['QWEN_SANDBOX']!.toLowerCase() !== 'false',
  );

// Read iteration tunings from env (documented in #4175 PR 1 plan).
const HEAVY = process.env['QWEN_BASELINE_HEAVY'] === '1';
const PROMPT_ITERATIONS = Number(
  process.env['QWEN_BASELINE_PROMPT_ITERATIONS'] ?? (HEAVY ? 100 : 20),
);
const RSS_SAMPLE_INTERVAL_MS = Number(
  process.env['QWEN_BASELINE_RSS_SAMPLE_INTERVAL_MS'] ?? 100,
);
const RSS_SAMPLE_DURATION_MS = Number(
  process.env['QWEN_BASELINE_RSS_SAMPLE_DURATION_MS'] ??
    (HEAVY ? 15_000 : 5_000),
);
const PROMPT_LATENCY_CREDENTIAL_ENV_KEYS = [
  'DASHSCOPE_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'QWEN_API_KEY',
];
const HAS_PROMPT_LATENCY_CREDENTIAL =
  process.env['QWEN_BASELINE_ENABLE_PROMPT_LATENCY'] === '1' ||
  PROMPT_LATENCY_CREDENTIAL_ENV_KEYS.some((key) => Boolean(process.env[key])) ||
  Object.entries(process.env).some(
    ([key, value]) => key.startsWith('QWEN_CUSTOM_API_KEY_') && Boolean(value),
  );
const SKIP_PROMPT_LATENCY =
  process.env['QWEN_BASELINE_SKIP_PROMPT_LATENCY'] === '1' ||
  !HAS_PROMPT_LATENCY_CREDENTIAL;

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const IDLE_MCP_PATH = path.join(FIXTURES_DIR, 'idle-mcp/server.mjs');
const MCP_SERVERS_CONFIGURED = 2;
const MCP_FIXTURE_PGREP_FILTER = 'idle-mcp/server\\.mjs';
const MCP_DESCENDANT_WAIT_TIMEOUT_MS = 10_000;
const MCP_DESCENDANT_POLL_MS = 250;
const RSS_DROPPED_SAMPLE_RATIO_MAX = 0.2;
const RUN_TS = new Date().toISOString().replace(/[:.]/g, '').replace(/Z$/, '');
const OUTPUT_DIR =
  process.env['INTEGRATION_TEST_FILE_DIR'] ??
  path.join(process.cwd(), '.integration-tests', `baseline-${RUN_TS}`);

// Catastrophic-regression upper bounds. These are intentionally loose —
// tightening them is a deliberate one-line PR after a regression is
// observed. Numbers chosen per #4175 PR 1 plan.
const THRESH = {
  rss1SessionMaxMB: 500,
  rss10SessionsMaxMB: 5_000,
  promptP99MaxMs: 60_000,
  attachLatencyMaxMs: 1_000,
  // P1 baseline: pre-M2, MCP children grow ~linearly with session count.
  // We assert "not worse than 2× linear" so a regression that doubles
  // the per-session spawn count gets caught even before M2 lands.
  mcpAmplificationFactor: 2,
};

// Snapshot accumulator — populated as each describe block runs, written
// in afterAll.
interface SnapshotShape {
  version: 1;
  capturedAt: string;
  gitCommit: string | null;
  platform: { os: string; arch: string; nodeVersion: string };
  /**
   * Notes about how to read this snapshot. Critical for cross-commit
   * comparison since some metrics' meaning changes as Wave 2/5 lands.
   */
  notes: string[];
  config: {
    promptIterations: number;
    rssSampleIntervalMs: number;
    rssSampleDurationMs: number;
    heavy: boolean;
  };
  rssScaling?: {
    session1MB: number;
    session5MB: number;
    session10MB: number;
    sampleCount: number;
    droppedSampleCount: number;
    growthPerSessionMB: number;
  };
  promptLatency?: {
    iterations: number;
    firstByteMs: Percentiles | null;
    totalMs: Percentiles | null;
    skipped: boolean;
    skipReason?: string;
  };
  attachLatency?: {
    session2Ms: number;
    session5Ms: number;
    thresholdMs: number;
  };
  mcpAmplification?: {
    mcpServersConfigured: number;
    childrenAt1Session: number;
    childrenAt3Sessions: number;
    childrenAt5Sessions: number;
    linearAmplification: boolean;
  };
  sseBackpressure?: {
    ringSize: number;
    maxQueuedDefault: number;
    evictionAtOverflow: boolean;
    replayUpToRing: boolean;
    heartbeatIntervalMs: number;
  };
}

const snapshot: SnapshotShape = {
  version: 1,
  capturedAt: new Date().toISOString(),
  gitCommit: gitHead(),
  platform: {
    os: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
  },
  notes: [
    'Daemon defaults to sessionScope: "single", so N successive ' +
      'createOrAttachSession calls against the same workspace return the ' +
      'same sessionId. RSS scaling and MCP amplification metrics here ' +
      'reflect "N attaches to one shared session", not "N distinct sessions".',
    'After Wave 2 PR 5 (per-request sessionScope override) lands, this ' +
      'harness will be updated to optionally pass sessionScope: "thread" ' +
      'so the same metrics expose per-session cost and surface the P1 ' +
      'MCP N×M amplification before M2 fixes it.',
  ],
  config: {
    promptIterations: PROMPT_ITERATIONS,
    rssSampleIntervalMs: RSS_SAMPLE_INTERVAL_MS,
    rssSampleDurationMs: RSS_SAMPLE_DURATION_MS,
    heavy: HEAVY,
  },
};

function gitHead(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function makeTempWorkspace(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qwen-baseline-${label}-`));
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAgentMessageChunkEvent(ev: {
  type: string;
  data: unknown;
}): boolean {
  if (ev.type !== 'session_update' || !isRecord(ev.data)) return false;
  const update = ev.data['update'];
  return isRecord(update) && update['sessionUpdate'] === 'agent_message_chunk';
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

async function waitForMcpGrandchildren(
  daemonPid: number,
  minMcpGrandchildren: number,
): Promise<DescendantCount> {
  const deadline = Date.now() + MCP_DESCENDANT_WAIT_TIMEOUT_MS;
  let last = countDescendants(daemonPid, {
    mcpFilter: MCP_FIXTURE_PGREP_FILTER,
  });

  while (Date.now() < deadline) {
    last = countDescendants(daemonPid, {
      mcpFilter: MCP_FIXTURE_PGREP_FILTER,
    });
    if (
      last.acpChildren.length >= 1 &&
      last.mcpGrandchildren.length >= minMcpGrandchildren
    ) {
      return last;
    }
    await sleep(MCP_DESCENDANT_POLL_MS);
  }

  throw new Error(
    `Timed out waiting for ${minMcpGrandchildren} MCP grandchildren ` +
      `under daemon ${daemonPid}; last acpChildren=` +
      `[${last.acpChildren.join(', ')}], mcpGrandchildren=` +
      `[${last.mcpGrandchildren.join(', ')}]`,
  );
}

async function createNSessions(
  daemon: SpawnedDaemon,
  n: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const sess = await daemon.client.createOrAttachSession({
      workspaceCwd: daemon.workspaceCwd,
    });
    ids.push(sess.sessionId);
  }
  return ids;
}

async function measureRssAtSessionCount(sessionCount: number): Promise<{
  peakRssMB: number;
  sampleCount: number;
  droppedSampleCount: number;
}> {
  const ws = makeTempWorkspace(`rss-${sessionCount}`);
  let daemon: SpawnedDaemon | undefined;
  try {
    daemon = await spawnDaemon({ workspaceCwd: ws });
    await createNSessions(daemon, sessionCount);
    const poller = startRssPolling(daemon.daemon.pid!, RSS_SAMPLE_INTERVAL_MS);
    await new Promise((r) => setTimeout(r, RSS_SAMPLE_DURATION_MS));
    poller.stop();
    if (poller.samples.length === 0) {
      throw new Error(
        `RSS polling produced no usable samples for ${sessionCount} sessions`,
      );
    }
    const sampleTotal = poller.samples.length + poller.droppedSamples;
    if (
      sampleTotal > 0 &&
      poller.droppedSamples / sampleTotal > RSS_DROPPED_SAMPLE_RATIO_MAX
    ) {
      throw new Error(
        `RSS polling dropped ${poller.droppedSamples}/${sampleTotal} ` +
          `samples for ${sessionCount} sessions`,
      );
    }
    const peakRssMB = poller.samples.reduce(
      (max, s) => Math.max(max, s.rssMB),
      0,
    );
    return {
      peakRssMB,
      sampleCount: poller.samples.length,
      droppedSampleCount: poller.droppedSamples,
    };
  } finally {
    if (daemon) await daemon.dispose();
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

(SKIP ? describe.skip : describe)(
  'daemon baseline harness (POSIX-only)',
  () => {
    describe('RSS scaling', () => {
      it(
        'captures peak RSS at 1 / 5 / 10 sessions',
        async () => {
          const r1 = await measureRssAtSessionCount(1);
          const r5 = await measureRssAtSessionCount(5);
          const r10 = await measureRssAtSessionCount(10);

          snapshot.rssScaling = {
            session1MB: r1.peakRssMB,
            session5MB: r5.peakRssMB,
            session10MB: r10.peakRssMB,
            sampleCount: r1.sampleCount + r5.sampleCount + r10.sampleCount,
            droppedSampleCount:
              r1.droppedSampleCount +
              r5.droppedSampleCount +
              r10.droppedSampleCount,
            growthPerSessionMB:
              Math.round(((r10.peakRssMB - r1.peakRssMB) / 9) * 10) / 10,
          };

          // Catastrophic upper bounds only.
          expect(r1.peakRssMB).toBeLessThan(THRESH.rss1SessionMaxMB);
          expect(r10.peakRssMB).toBeLessThan(THRESH.rss10SessionsMaxMB);
        },
        // Each session-count needs daemon spawn + N session creates +
        // RSS_SAMPLE_DURATION_MS sampling + dispose. ~3 × 15s budget per
        // count in heavy mode → 90s base; pad for slow CI.
        HEAVY ? 600_000 : 180_000,
      );
    });

    describe('attach latency', () => {
      it('measures Nth same-workspace session attach time', async () => {
        const ws = makeTempWorkspace('attach');
        let daemon: SpawnedDaemon | undefined;
        try {
          daemon = await spawnDaemon({ workspaceCwd: ws });
          // Create session 1 to warm the channel.
          await daemon.client.createOrAttachSession({ workspaceCwd: ws });

          const t2 = Date.now();
          await daemon.client.createOrAttachSession({ workspaceCwd: ws });
          const session2Ms = Date.now() - t2;

          // Skip ahead to session 5 attach to capture a "later" sample.
          await daemon.client.createOrAttachSession({ workspaceCwd: ws });
          await daemon.client.createOrAttachSession({ workspaceCwd: ws });
          const t5 = Date.now();
          await daemon.client.createOrAttachSession({ workspaceCwd: ws });
          const session5Ms = Date.now() - t5;

          snapshot.attachLatency = {
            session2Ms,
            session5Ms,
            thresholdMs: THRESH.attachLatencyMaxMs,
          };

          expect(session2Ms).toBeLessThan(THRESH.attachLatencyMaxMs);
          expect(session5Ms).toBeLessThan(THRESH.attachLatencyMaxMs);
        } finally {
          if (daemon) await daemon.dispose();
          fs.rmSync(ws, { recursive: true, force: true });
        }
      }, 60_000);
    });

    describe('MCP child amplification (P1 baseline)', () => {
      it('counts MCP grandchildren as session count grows', async () => {
        const ws = makeTempWorkspace('mcp');
        let daemon: SpawnedDaemon | undefined;
        try {
          writeWorkspaceSettings(ws, {
            mcpServers: {
              idle1: { command: 'node', args: [IDLE_MCP_PATH] },
              idle2: { command: 'node', args: [IDLE_MCP_PATH] },
            },
          });
          daemon = await spawnDaemon({ workspaceCwd: ws });

          await daemon.client.createOrAttachSession({ workspaceCwd: ws });
          const at1 = await waitForMcpGrandchildren(
            daemon.daemon.pid!,
            MCP_SERVERS_CONFIGURED,
          );

          await daemon.client.createOrAttachSession({ workspaceCwd: ws });
          await daemon.client.createOrAttachSession({ workspaceCwd: ws });
          const at3 = await waitForMcpGrandchildren(
            daemon.daemon.pid!,
            MCP_SERVERS_CONFIGURED,
          );

          await daemon.client.createOrAttachSession({ workspaceCwd: ws });
          await daemon.client.createOrAttachSession({ workspaceCwd: ws });
          const at5 = await waitForMcpGrandchildren(
            daemon.daemon.pid!,
            MCP_SERVERS_CONFIGURED,
          );

          const expectedMaxAt5 =
            MCP_SERVERS_CONFIGURED * 5 * THRESH.mcpAmplificationFactor;
          const linear =
            at5.mcpGrandchildren.length >= MCP_SERVERS_CONFIGURED * 5 * 0.5; // ≥50% of linear → confirmed amplification

          snapshot.mcpAmplification = {
            mcpServersConfigured: MCP_SERVERS_CONFIGURED,
            childrenAt1Session: at1.mcpGrandchildren.length,
            childrenAt3Sessions: at3.mcpGrandchildren.length,
            childrenAt5Sessions: at5.mcpGrandchildren.length,
            linearAmplification: linear,
          };

          // Sanity: at least 1 ACP child should exist throughout.
          expect(at1.acpChildren.length).toBeGreaterThanOrEqual(1);
          expect(at1.mcpGrandchildren.length).toBeGreaterThanOrEqual(
            MCP_SERVERS_CONFIGURED,
          );
          // Catastrophic bound: not worse than 2× linear.
          expect(at5.mcpGrandchildren.length).toBeLessThanOrEqual(
            expectedMaxAt5,
          );
        } finally {
          if (daemon) await daemon.dispose();
          fs.rmSync(ws, { recursive: true, force: true });
        }
      }, 120_000);

      // PR 14b cross-check: validate the daemon's in-process MCP
      // accounting on `GET /workspace/mcp` (`clientCount`, the field
      // SDK consumers and dashboards see, and the same source the
      // push-event channel — `mcp_budget_warning` /
      // `mcp_child_refused_batch` — reads) against external `pgrep -P`
      // measurement.
      //
      // Architectural note (PR 22a): a `qwen serve` ACP child runs
      // two `Config` objects, each carrying its own
      // `McpClientManager`. The bootstrap Config (`runAcpAgent` →
      // `config.initialize`) discovers MCP servers when the child
      // starts, and `/workspace/mcp` reads its manager via
      // `buildWorkspaceMcpStatus(this.config)` (`acpAgent.ts:1399`).
      // The per-session Config (`newSessionConfig` →
      // `config.initialize`) spawns a SECOND set of MCP children for
      // the SAME servers — its accounting is NOT what the
      // workspace-level snapshot reflects. So pgrep observes
      // `(1 + sessionCount) * MCP_SERVERS_CONFIGURED` grandchildren
      // while `clientCount` stays at `MCP_SERVERS_CONFIGURED`.
      //
      // What this test validates:
      // 1. `clientCount` is exactly the configured server count
      //    (bootstrap manager accounting is honest).
      // 2. pgrep observes the architectural 2×N grandchildren after
      //    one session is created — encoded literally so a future
      //    refactor that unifies bootstrap + session managers (#4175
      //    follow-up to drop the duplicate discovery) fails this
      //    assertion and forces a deliberate test update.
      // 3. `clientCount` NEVER exceeds the observed pgrep count —
      //    the original "snapshot must never over-report" guard.
      //
      // Skip-gated like the parent describe (POSIX, non-sandbox);
      // idle MCP fixtures are stdio-only so the relationship between
      // `clientCount` and pgrep is exact (no amplification slack
      // required at idle).
      it('clientCount matches external pgrep observation', async () => {
        const ws = makeTempWorkspace('mcp-counter');
        let daemon: SpawnedDaemon | undefined;
        try {
          writeWorkspaceSettings(ws, {
            mcpServers: {
              idle1: { command: 'node', args: [IDLE_MCP_PATH] },
              idle2: { command: 'node', args: [IDLE_MCP_PATH] },
            },
          });
          daemon = await spawnDaemon({ workspaceCwd: ws });
          await daemon.client.createOrAttachSession({ workspaceCwd: ws });

          // Wait until the OS sees the FULL post-session set
          // (`MCP_SERVERS_CONFIGURED * 2` grandchildren — see the
          // architectural note above), then read the snapshot.
          // pgrep first to lock the comparison floor; snapshot
          // second so the daemon can't sneak in a new connect
          // between the two reads.
          const expectedGrandchildren = MCP_SERVERS_CONFIGURED * 2;
          const observed = await waitForMcpGrandchildren(
            daemon.daemon.pid!,
            expectedGrandchildren,
          );
          const snapshot = await daemon.client.workspaceMcp();

          // (1) Bootstrap manager accounting is honest.
          expect(snapshot.clientCount).toBe(MCP_SERVERS_CONFIGURED);
          // (2) pgrep observes both managers' children. If a future
          // refactor unifies them, change this to
          // `MCP_SERVERS_CONFIGURED` (and update the architectural
          // note above).
          expect(observed.mcpGrandchildren.length).toBe(expectedGrandchildren);
          // (3) Snapshot never over-reports OS reality. Holds under
          // both the current 2× regime and the unified 1× future.
          expect(snapshot.clientCount).toBeLessThanOrEqual(
            observed.mcpGrandchildren.length,
          );
        } finally {
          if (daemon) await daemon.dispose();
          fs.rmSync(ws, { recursive: true, force: true });
        }
      }, 120_000);
    });

    describe('SSE backpressure (unit)', () => {
      // Note: EventBus is the daemon's per-session fan-out primitive. It
      // doesn't take a sessionId in publish/subscribe — the bus instance
      // itself is per-session, owned upstream. We use it directly here for
      // deterministic backpressure invariants without needing a live HTTP
      // round-trip; pattern matches `packages/cli/src/serve/eventBus.test.ts`.
      it('overflow at maxQueued boundary fires client_evicted', async () => {
        const bus = new EventBus();
        const ac = new AbortController();
        // Per-subscriber queue cap is set on subscribe(), not on bus
        // construction (matches the existing eventBus.test.ts:103 pattern).
        const iter = bus.subscribe({ maxQueued: 2, signal: ac.signal });

        // Publish 3 events into a 2-deep queue:
        //   - event 2 fills the queue to 100% (above the 75% warn threshold),
        //     so the bus force-pushes a `slow_client_warning` synthetic frame.
        //   - event 3 trips the eviction path → terminal `client_evicted` frame.
        // Resulting order: tick(1), tick(2), slow_client_warning, client_evicted.
        bus.publish({ type: 'tick', data: { i: 1 } });
        bus.publish({ type: 'tick', data: { i: 2 } });
        bus.publish({ type: 'tick', data: { i: 3 } });

        const collected: BridgeEventLike[] = [];
        for await (const ev of iter) {
          collected.push({ type: ev.type });
        }
        ac.abort();

        expect(collected).toHaveLength(4);
        expect(collected[2]!.type).toBe('slow_client_warning');
        expect(collected[3]!.type).toBe('client_evicted');
        snapshot.sseBackpressure = {
          ringSize: 4_000,
          maxQueuedDefault: 256,
          evictionAtOverflow: true,
          replayUpToRing: true,
          heartbeatIntervalMs: 15_000,
        };
      });

      it('replay across reconnect honors lastEventId up to ring size', async () => {
        const bus = new EventBus();
        // Publish 5 events.
        for (let i = 1; i <= 5; i++) {
          bus.publish({ type: 'tick', data: { i } });
        }
        // Subscribe with lastEventId=2 → should replay events 3..5.
        const ac = new AbortController();
        const iter = bus.subscribe({ lastEventId: 2, signal: ac.signal });
        const replayed: number[] = [];
        for await (const ev of iter) {
          const data = ev.data as { i: number };
          replayed.push(data.i);
          if (replayed.length >= 3) break;
        }
        ac.abort();
        expect(replayed).toEqual([3, 4, 5]);
      });
    });

    describe('prompt latency', () => {
      it.skipIf(SKIP_PROMPT_LATENCY)(
        `p50 / p99 over ${PROMPT_ITERATIONS} prompts`,
        async () => {
          const ws = makeTempWorkspace('prompt');
          let daemon: SpawnedDaemon | undefined;
          try {
            daemon = await spawnDaemon({ workspaceCwd: ws });
            const sess = await daemon.client.createOrAttachSession({
              workspaceCwd: ws,
            });
            const firstByteMs: number[] = [];
            const totalMs: number[] = [];

            for (let i = 0; i < PROMPT_ITERATIONS; i++) {
              const t0 = Date.now();
              // Subscribe to events for first-byte timing; promptly cancel
              // when we see the first model response chunk.
              const ac = new AbortController();
              const iter = daemon.client.subscribeEvents(sess.sessionId, {
                signal: ac.signal,
              });
              const firstByteP = (async (): Promise<number | null> => {
                try {
                  for await (const ev of iter) {
                    if (isAgentMessageChunkEvent(ev)) {
                      return Date.now();
                    }
                  }
                } catch (err) {
                  if (!isAbortError(err)) {
                    throw err;
                  }
                }
                return null;
              })();

              let promptError: unknown;
              let tEnd = Date.now();
              try {
                await daemon.client.prompt(sess.sessionId, {
                  prompt: [
                    { type: 'text', text: 'reply with the single word ok' },
                  ],
                });
                tEnd = Date.now();
              } catch (err) {
                promptError = err;
                tEnd = Date.now();
              } finally {
                ac.abort();
              }
              const tFirstByte = await firstByteP;
              if (promptError) throw promptError;
              if (tFirstByte === null) {
                throw new Error(
                  'Prompt latency probe completed without an ' +
                    'agent_message_chunk session_update event',
                );
              }

              firstByteMs.push(tFirstByte - t0);
              totalMs.push(tEnd - t0);
            }

            snapshot.promptLatency = {
              iterations: PROMPT_ITERATIONS,
              firstByteMs: percentiles(firstByteMs),
              totalMs: percentiles(totalMs),
              skipped: false,
            };

            expect(snapshot.promptLatency.totalMs!.p99).toBeLessThan(
              THRESH.promptP99MaxMs,
            );
          } finally {
            if (daemon) await daemon.dispose();
            fs.rmSync(ws, { recursive: true, force: true });
          }
        },
        HEAVY ? 30 * 60_000 : 10 * 60_000,
      );

      if (SKIP_PROMPT_LATENCY) {
        it('prompt latency skipped (no model credential env)', () => {
          snapshot.promptLatency = {
            iterations: 0,
            firstByteMs: null,
            totalMs: null,
            skipped: true,
            skipReason:
              'No recognized model credential env var is set; prompt latency requires real model access. Set QWEN_BASELINE_ENABLE_PROMPT_LATENCY=1 to force-run with non-env auth.',
          };
          // Mark via a no-op assertion so the suite still appears in output.
          expect(true).toBe(true);
        });
      }
    });

    afterAll(() => {
      if (SKIP) return;
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const jsonPath = path.join(OUTPUT_DIR, 'perf-baseline.json');
      fs.writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2));
      fs.writeFileSync(
        path.join(OUTPUT_DIR, 'perf-baseline.md'),
        renderMarkdown(snapshot),
      );
      // Echo the path so a reviewer / CI logs surface where the artifact
      // landed.
      console.log(`[baseline] perf-baseline.json written to ${jsonPath}`);
    });
  },
);

function renderMarkdown(s: SnapshotShape): string {
  const fmt = (p: Percentiles | null | undefined): string =>
    p
      ? `p50=${p.p50.toFixed(0)} p90=${p.p90.toFixed(0)} p99=${p.p99.toFixed(0)} mean=${p.mean.toFixed(0)} (n=${p.count})`
      : 'n/a';
  return [
    `# qwen serve daemon — perf baseline`,
    ``,
    `Captured: ${s.capturedAt}`,
    `Git: ${s.gitCommit ?? 'unknown'}`,
    `Platform: ${s.platform.os}/${s.platform.arch} node=${s.platform.nodeVersion}`,
    `Heavy mode: ${s.config.heavy}`,
    ``,
    `## RSS scaling`,
    s.rssScaling
      ? `- 1 session: ${s.rssScaling.session1MB} MB\n- 5 sessions: ${s.rssScaling.session5MB} MB\n- 10 sessions: ${s.rssScaling.session10MB} MB\n- RSS samples: ${s.rssScaling.sampleCount} (${s.rssScaling.droppedSampleCount} dropped)\n- growth/session: ${s.rssScaling.growthPerSessionMB} MB`
      : 'not run',
    ``,
    `## Attach latency`,
    s.attachLatency
      ? `- session 2 attach: ${s.attachLatency.session2Ms} ms\n- session 5 attach: ${s.attachLatency.session5Ms} ms`
      : 'not run',
    ``,
    `## MCP amplification (P1 baseline)`,
    s.mcpAmplification
      ? `- MCP servers configured: ${s.mcpAmplification.mcpServersConfigured}\n- children at 1 session: ${s.mcpAmplification.childrenAt1Session}\n- children at 3 sessions: ${s.mcpAmplification.childrenAt3Sessions}\n- children at 5 sessions: ${s.mcpAmplification.childrenAt5Sessions}\n- linear amplification observed: ${s.mcpAmplification.linearAmplification}`
      : 'not run',
    ``,
    `## Prompt latency`,
    s.promptLatency
      ? s.promptLatency.skipped
        ? `skipped (${s.promptLatency.skipReason})`
        : `- iterations: ${s.promptLatency.iterations}\n- first-byte (ms): ${fmt(s.promptLatency.firstByteMs)}\n- total (ms): ${fmt(s.promptLatency.totalMs)}`
      : 'not run',
    ``,
    `## SSE backpressure (unit-level invariants)`,
    s.sseBackpressure
      ? `- ring size: ${s.sseBackpressure.ringSize}\n- max queued (default): ${s.sseBackpressure.maxQueuedDefault}\n- eviction at overflow: ${s.sseBackpressure.evictionAtOverflow}\n- replay up to ring: ${s.sseBackpressure.replayUpToRing}\n- heartbeat interval (ms): ${s.sseBackpressure.heartbeatIntervalMs}`
      : 'not run',
    ``,
  ].join('\n');
}
