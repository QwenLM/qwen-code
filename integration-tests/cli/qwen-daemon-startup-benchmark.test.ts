/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * qwen serve daemon startup benchmark.
 *
 * Measures only the cold path from spawning the built CLI to the HTTP
 * listener-ready stdout line. It intentionally does not create a session, so
 * ACP/runtime preheat cost remains observed but not part of the primary
 * listener-ready latency.
 *
 * Gated by QWEN_BENCHMARK_ENABLED=1 and writes JSON/Markdown artifacts to the
 * integration test output directory.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_REPO_ROOT,
  gitHead,
  makeTempWorkspace,
  percentiles,
  type Percentiles,
} from './_daemon-harness.js';
import {
  collectPlatformInfo,
  formatPercentiles,
  resolveOutputDir,
  writeSnapshotArtifacts,
} from './_daemon-perf-report.js';

const SANDBOX_ENABLED = Boolean(
  process.env['QWEN_SANDBOX'] &&
    process.env['QWEN_SANDBOX'].toLowerCase() !== 'false',
);
const SKIP = process.env['QWEN_BENCHMARK_ENABLED'] !== '1' || SANDBOX_ENABLED;

const ITERATIONS = Number(process.env['BENCHMARK_ITERATIONS'] ?? 5);
const WARMUP_ITERATIONS = Number(
  process.env['BENCHMARK_WARMUP_ITERATIONS'] ?? 1,
);
const BOOT_TIMEOUT_MS = Number(
  process.env['BENCHMARK_BOOT_TIMEOUT_MS'] ?? 15_000,
);
const EXTERNAL_P99_MAX_MS = Number(
  process.env['BENCHMARK_DAEMON_STARTUP_P99_MAX_MS'] ?? 15_000,
);

const OUTPUT_DIR = resolveOutputDir('daemon-startup');
const TOKEN = 'daemon-startup-benchmark-token';
const CLI_BIN =
  process.env['TEST_CLI_PATH'] ??
  path.resolve(DEFAULT_REPO_ROOT, 'dist/cli.js');
const PREHEAT_STATUSES = [
  'external_bridge',
  'not_scheduled',
  'scheduled',
  'running',
  'succeeded',
  'failed',
] as const;

type PreheatStatus = (typeof PREHEAT_STATUSES)[number];

interface DaemonStartupStatus {
  processStartedAt: string;
  listenerReadyAt?: string;
  processToListenMs?: number;
  runQwenServeToListenMs?: number;
  preheat?: {
    status?: PreheatStatus;
    durationMs?: number;
    error?: string;
  };
}

interface DaemonStatusResponse {
  daemon?: {
    startup?: DaemonStartupStatus;
  };
}

interface StartupRun {
  iteration: number;
  measured: boolean;
  externalCommandToListeningMs: number;
  processToListenMs: number;
  runQwenServeToListenMs: number;
  preheatStatus: PreheatStatus;
  port: number;
  stdoutListeningLine: string;
}

interface StartupBenchmarkSnapshot {
  version: 1;
  capturedAt: string;
  gitCommit: string | null;
  platform: { os: string; arch: string; nodeVersion: string };
  cliBin: string;
  config: {
    iterations: number;
    warmupIterations: number;
    bootTimeoutMs: number;
    externalP99MaxMs: number;
  };
  notes: string[];
  runs: StartupRun[];
  externalCommandToListening?: Percentiles;
  processToListen?: Percentiles;
  runQwenServeToListen?: Percentiles;
}

const snapshot: StartupBenchmarkSnapshot = {
  version: 1,
  capturedAt: new Date().toISOString(),
  gitCommit: gitHead(),
  platform: collectPlatformInfo(),
  cliBin: CLI_BIN,
  config: {
    iterations: ITERATIONS,
    warmupIterations: WARMUP_ITERATIONS,
    bootTimeoutMs: BOOT_TIMEOUT_MS,
    externalP99MaxMs: EXTERNAL_P99_MAX_MS,
  },
  notes: [
    'Measures built CLI `qwen serve` cold startup to the stdout listening line.',
    'Runs the default daemon path except for ephemeral port, loopback host, explicit workspace, and --no-open.',
    'Does not create a session; preheat state is recorded but not included in the primary listener-ready metric.',
    'Validates stderr startup timing and /daemon/status startup fields for each run.',
  ],
  runs: [],
};

const LISTENING_RE =
  /^(qwen serve listening on http:\/\/127\.0\.0\.1:(\d+) \(mode=.*\))$/m;
const STDERR_TIMING_RE =
  /qwen serve: startup timing: processToListenMs=(\d+) runQwenServeToListenMs=(\d+)/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminate(child: ChildProcess): Promise<void> {
  const exited = new Promise<true>((resolve) => {
    if (childHasExited(child)) {
      resolve(true);
      return;
    }
    child.once('exit', () => resolve(true));
  });
  signalChildTree(child, 'SIGTERM');
  if (await Promise.race([exited, sleep(250).then(() => false)])) {
    return;
  }
  signalChildTree(child, 'SIGKILL');
  await Promise.race([exited, sleep(750)]);
}

async function waitForStderrTiming(
  stderr: () => string,
): Promise<RegExpMatchArray> {
  const deadline = performance.now() + 1_000;
  while (performance.now() < deadline) {
    const match = stderr().match(STDERR_TIMING_RE);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const match = stderr().match(STDERR_TIMING_RE);
  if (match) return match;
  throw new Error(`startup timing line missing from stderr:\n${stderr()}`);
}

async function runStartupIteration(
  iteration: number,
  measured: boolean,
): Promise<StartupRun> {
  const workspace = makeTempWorkspace(
    `${iteration}`,
    'qwen-daemon-startup-benchmark',
  );
  const startedAt = performance.now();
  let stdout = '';
  let stderr = '';
  let child: ChildProcess | undefined;
  const { VITEST_WORKER_ID: _vitestWorkerId, ...childEnv } = process.env;

  try {
    child = spawn(
      process.execPath,
      [
        CLI_BIN,
        'serve',
        '--port',
        '0',
        '--hostname',
        '127.0.0.1',
        '--workspace',
        workspace,
        '--no-open',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        env: {
          ...childEnv,
          CI: '1',
          NO_COLOR: '1',
          QWEN_CODE_PROFILE_STARTUP: '0',
          QWEN_CODE_PROFILE_STARTUP_OUTER: '0',
          QWEN_CODE_SUPPRESS_YOLO_WARNING: '1',
          QWEN_SERVER_TOKEN: TOKEN,
        },
      },
    );

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const listening = await new Promise<{
      line: string;
      port: number;
      externalCommandToListeningMs: number;
    }>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        child?.stdout?.off('data', onStdout);
        child?.off('exit', onExit);
        clearTimeout(timer);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const onStdout = (chunk: Buffer) => {
        stdout += chunk.toString();
        const match = stdout.match(LISTENING_RE);
        if (!match) return;
        settled = true;
        cleanup();
        resolve({
          line: match[1],
          port: Number(match[2]),
          externalCommandToListeningMs: Math.round(
            performance.now() - startedAt,
          ),
        });
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        fail(
          new Error(
            `daemon exited before listening: code=${code} signal=${signal}\n` +
              `stdout=${stdout}\nstderr=${stderr}`,
          ),
        );
      };
      const timer = setTimeout(() => {
        fail(
          new Error(
            `daemon startup timed out after ${BOOT_TIMEOUT_MS}ms\n` +
              `stdout=${stdout}\nstderr=${stderr}`,
          ),
        );
      }, BOOT_TIMEOUT_MS);
      child?.stdout?.on('data', onStdout);
      child?.once('exit', onExit);
    });

    const timing = await waitForStderrTiming(() => stderr);
    const status = (await fetch(
      `http://127.0.0.1:${listening.port}/daemon/status?detail=full`,
      {
        headers: { authorization: `Bearer ${TOKEN}` },
      },
    ).then((res) => {
      if (!res.ok) {
        throw new Error(`/daemon/status returned ${res.status}`);
      }
      return res.json();
    })) as DaemonStatusResponse;

    const startup = status.daemon?.startup;
    const processToListenMs = startup?.processToListenMs;
    const runQwenServeToListenMs = startup?.runQwenServeToListenMs;
    const preheatStatus = startup?.preheat?.status;

    expect(startup?.processStartedAt).toEqual(expect.any(String));
    expect(startup?.listenerReadyAt).toEqual(expect.any(String));
    expect(processToListenMs).toEqual(Number(timing[1]));
    expect(runQwenServeToListenMs).toEqual(Number(timing[2]));
    expect(processToListenMs).toEqual(expect.any(Number));
    expect(runQwenServeToListenMs).toEqual(expect.any(Number));
    expect(processToListenMs).toBeGreaterThanOrEqual(runQwenServeToListenMs!);
    expect(preheatStatus).toEqual(expect.any(String));
    expect(PREHEAT_STATUSES).toContain(preheatStatus as PreheatStatus);

    return {
      iteration,
      measured,
      externalCommandToListeningMs: listening.externalCommandToListeningMs,
      processToListenMs: processToListenMs!,
      runQwenServeToListenMs: runQwenServeToListenMs!,
      preheatStatus: preheatStatus!,
      port: listening.port,
      stdoutListeningLine: listening.line,
    };
  } finally {
    if (child) await terminate(child);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

(SKIP ? describe.skip : describe)(
  'qwen serve daemon startup benchmark',
  { retry: 0 },
  () => {
    it(
      'measures built CLI startup to listener readiness',
      async () => {
        const total = WARMUP_ITERATIONS + ITERATIONS;
        for (let i = 0; i < total; i++) {
          const measured = i >= WARMUP_ITERATIONS;
          const run = await runStartupIteration(i, measured);
          snapshot.runs.push(run);
          console.log(
            `[daemon-startup] ${measured ? 'run' : 'warmup'} ${i}: ` +
              `external=${run.externalCommandToListeningMs}ms ` +
              `process=${run.processToListenMs}ms ` +
              `runQwenServe=${run.runQwenServeToListenMs}ms ` +
              `preheat=${run.preheatStatus}`,
          );
        }

        const measuredRuns = snapshot.runs.filter((run) => run.measured);
        snapshot.externalCommandToListening = percentiles(
          measuredRuns.map((run) => run.externalCommandToListeningMs),
        );
        snapshot.processToListen = percentiles(
          measuredRuns.map((run) => run.processToListenMs),
        );
        snapshot.runQwenServeToListen = percentiles(
          measuredRuns.map((run) => run.runQwenServeToListenMs),
        );

        expect(snapshot.externalCommandToListening.count).toBe(ITERATIONS);
        expect(snapshot.externalCommandToListening.p99).toBeLessThan(
          EXTERNAL_P99_MAX_MS,
        );
      },
      (WARMUP_ITERATIONS + ITERATIONS) * (BOOT_TIMEOUT_MS + 5_000),
    );

    afterAll(() => {
      if (SKIP || snapshot.runs.length === 0) return;

      console.log('\n[daemon-startup] ---- summary ----');
      console.log(
        `  External command -> listening: ${formatPercentiles(
          snapshot.externalCommandToListening,
        )}`,
      );
      console.log(
        `  process -> listening:          ${formatPercentiles(
          snapshot.processToListen,
        )}`,
      );
      console.log(
        `  runQwenServe -> listening:     ${formatPercentiles(
          snapshot.runQwenServeToListen,
        )}`,
      );
      console.log('[daemon-startup] ---- end summary ----\n');

      writeSnapshotArtifacts(
        OUTPUT_DIR,
        'daemon-startup-benchmark',
        snapshot,
        renderMarkdown(snapshot),
        'daemon-startup',
      );
    });
  },
);

function renderMarkdown(s: StartupBenchmarkSnapshot): string {
  const lines = [
    '# qwen serve daemon startup benchmark',
    '',
    `Captured: ${s.capturedAt}`,
    `Git: ${s.gitCommit ?? 'unknown'}`,
    `Platform: ${s.platform.os}/${s.platform.arch} node=${s.platform.nodeVersion}`,
    `CLI: ${s.cliBin}`,
    `Iterations: ${s.config.iterations}  Warmup: ${s.config.warmupIterations}`,
    '',
    `> ${s.notes.join(' ')}`,
    '',
    '## Summary',
    '',
    `- External command -> listening: ${formatPercentiles(
      s.externalCommandToListening,
    )}`,
    `- process -> listening: ${formatPercentiles(s.processToListen)}`,
    `- runQwenServe -> listening: ${formatPercentiles(s.runQwenServeToListen)}`,
    '',
    '## Runs',
    '',
    '| Iteration | Measured | External wall | processToListen | runQwenServeToListen | Preheat |',
    '|---:|:---:|---:|---:|---:|---|',
  ];

  for (const run of s.runs) {
    lines.push(
      `| ${run.iteration} | ${run.measured ? 'yes' : 'warmup'} | ` +
        `${run.externalCommandToListeningMs}ms | ${run.processToListenMs}ms | ` +
        `${run.runQwenServeToListenMs}ms | ${run.preheatStatus} |`,
    );
  }

  lines.push(
    '',
    '## Scope',
    '',
    'This benchmark stops at the stdout listening line and does not create a daemon session. It records the preheat state visible at listen time, but preheat completion is not part of the primary metric. Use `qwen-daemon-vs-cli-benchmark.test.ts` for first-session, memory, and prompt metrics.',
    '',
  );
  return lines.join('\n');
}
