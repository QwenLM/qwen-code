/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Opt-in daemon first-output benchmark.
 *
 * The single-bundle mode records a cold/warm two-session baseline. The
 * comparison mode runs paired control/candidate processes in balanced AB/BA
 * order. Every process, workspace, home, qwen home, and listener is isolated.
 *
 * Latency figures are only meaningful when nothing else competes for the host,
 * so this file is excluded from the shared integration config and must run
 * under its own serial config:
 *   QWEN_FIRST_OUTPUT_BENCHMARK=1 QWEN_SANDBOX=false BENCHMARK_CLI_PATH=... \
 *     npx vitest run --config integration-tests/vitest.firstoutput.config.ts
 *
 * See readBenchmarkConfig() for the intentionally strict bundle-path contract.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, it } from 'vitest';

import {
  DaemonClient,
  type DaemonEvent,
  type DaemonSession,
} from '@qwen-code/sdk';
import {
  DEFAULT_BOOTSTRAP_ITERATIONS,
  DEFAULT_FIRST_OUTPUT_EVENT_BUFFER_LIMIT,
  DEFAULT_MATERIAL_THRESHOLD_MS,
  DEFAULT_ORDER_SENSITIVITY_THRESHOLD_MS,
  FIRST_OUTPUT_BENCHMARK_VERSION,
  FirstOutputTracker,
  evaluateSingleBundlePrototypeGate,
  findInvalidTimings,
  measuredPairCountForDwell,
  nullablePercentiles,
  pairedCandidateControlStats,
  parseBenchmarkPostSessionDwell,
  renderFirstOutputBenchmarkMarkdown,
  validateExpectedFinalText,
  validatePromptAcceptance,
  type FirstOutputBenchmarkArtifactV2,
  type FirstOutputFailure,
  type FirstOutputFailureCode,
  type FirstOutputMetricName,
  type FirstOutputPairResult,
  type FirstOutputPairedMetricSummary,
  type FirstOutputProcessRunResult,
  type FirstOutputSessionRunResult,
  type FirstOutputSingleMetricSummary,
} from './_first-output-benchmark.js';
import {
  countDescendants,
  LISTENING_LINE_RE,
  sleep,
} from './_daemon-harness.js';
import { writeSnapshotArtifacts } from './_daemon-perf-report.js';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';

const ENABLED = process.env['QWEN_FIRST_OUTPUT_BENCHMARK'] === '1';
const SANDBOX_DISABLED = process.env['QWEN_SANDBOX'] === 'false';
const SKIP = !ENABLED || process.platform === 'win32';

const SINGLE_WARMUPS = 2;
const SINGLE_MEASURED = 50;
const COMPARE_WARMUP_PAIRS = 2;
const SINGLE_SESSIONS_PER_PROCESS = 2;
const COMPARE_SESSIONS_PER_PROCESS = 1;
const PROVIDER_DELAY_MS = 50;
const BOOT_TIMEOUT_MS = 35_000;
const TURN_TIMEOUT_MS = 30_000;
const SDK_FETCH_TIMEOUT_MS = TURN_TIMEOUT_MS + 5_000;
const PROCESS_EXIT_TIMEOUT_MS = 5_000;
const DESCENDANT_EXIT_TIMEOUT_MS = 5_000;
const EMERGENCY_CLEANUP_TIMEOUT_MS = 60_000;
const MAX_POST_SESSION_DWELL_MS = 500;
const SESSION_TIMEOUT_BUDGET_MS =
  SDK_FETCH_TIMEOUT_MS * 2 +
  TURN_TIMEOUT_MS * 3 +
  PROCESS_EXIT_TIMEOUT_MS +
  MAX_POST_SESSION_DWELL_MS;
const PROCESS_TIMEOUT_BUDGET_MS = (sessionCount: 1 | 2) =>
  BOOT_TIMEOUT_MS +
  sessionCount * SESSION_TIMEOUT_BUDGET_MS +
  PROCESS_EXIT_TIMEOUT_MS * 3 +
  DESCENDANT_EXIT_TIMEOUT_MS * 2;
const SINGLE_RUN_TIMEOUT_BUDGET_MS =
  (SINGLE_WARMUPS + SINGLE_MEASURED) *
  PROCESS_TIMEOUT_BUDGET_MS(SINGLE_SESSIONS_PER_PROCESS);
const COMPARE_RUN_TIMEOUT_BUDGET_MS =
  (COMPARE_WARMUP_PAIRS + 30) *
  2 *
  PROCESS_TIMEOUT_BUDGET_MS(COMPARE_SESSIONS_PER_PROCESS);
const BENCHMARK_TEST_TIMEOUT_MS =
  Math.ceil(
    Math.max(SINGLE_RUN_TIMEOUT_BUDGET_MS, COMPARE_RUN_TIMEOUT_BUDGET_MS) *
      1.25,
  ) +
  5 * 60_000;
const PROMPT_LENGTH = 128;
const TOKEN = 'daemon-first-output-benchmark-token';
const EXPECTED_ANSWER = 'benchmark response complete';
const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUTPUT_DIR = path.join(
  REPOSITORY_ROOT,
  '.qwen',
  'investigations',
  'daemon-first-output-benchmark',
  new Date().toISOString().replace(/[:.]/g, '').replace(/Z$/, ''),
);
const BOOTSTRAP_SEED = 0x51f02026;
const activeDaemons = new Set<BenchmarkDaemon>();
const activeProcessGroups = new Set<ActiveProcessGroup>();
const activeFakeProviders = new Set<FakeOpenAIServer>();
const activeTempDirs = new Set<string>();
const activeCompileCacheDirs = new Set<string>();
let promptSequence = 0;

type BundleRole = 'single' | 'control' | 'candidate';
type PairOrder = 'AB' | 'BA';

interface ResolvedBundle {
  role: BundleRole;
  configuredPath: string;
  realPath: string;
  sha256: string;
  compileCacheDir: string;
}

interface SingleBenchmarkConfig {
  mode: 'single';
  bundle: ResolvedBundle;
  postSessionDwellMs: 0;
}

interface CompareBenchmarkConfig {
  mode: 'compare';
  control: ResolvedBundle;
  candidate: ResolvedBundle;
  postSessionDwellMs: 0 | 100 | 500;
  measuredPairs: 10 | 30;
}

type BenchmarkConfig = SingleBenchmarkConfig | CompareBenchmarkConfig;

interface BenchmarkDaemon {
  client: DaemonClient;
  child: ChildProcess;
  pid: number;
  processStartedAtMs: number;
  daemonReadyAtMs: number;
  port: number;
  stdout: { value: string };
  stderr: { value: string };
  processGroup: ActiveProcessGroup;
}

interface ActiveProcessGroup {
  child: ChildProcess;
  pid: number;
  descendantPids: Set<number>;
  descendantSnapshotComplete: boolean;
}

interface ProviderTiming {
  prompt: string;
  requestAtMs: number;
  readyAtMs: number;
}

interface ProcessSample {
  sampleId: string;
  role: BundleRole;
  bundleRealPath: string;
  bundleSha256: string;
  order: PairOrder | null;
  pairIndex: number | null;
  warmup: boolean;
  pid: number | null;
  processStartedAtMs: number | null;
  daemonReadyAtMs: number | null;
  daemonPort: number | null;
  fakeProviderPort: number | null;
  sessions: FirstOutputSessionRunResult[];
  failure: FirstOutputFailure | null;
  safeToContinue: boolean;
  stdout: string;
  stderr: string;
  cleanup: {
    completed: boolean;
    daemonExited: boolean;
    residualProcessCount: number;
    failure: FirstOutputFailure | null;
  };
  deferredTempRoot: string | null;
}

interface ExpectedRequest {
  prompt: string;
  count: number;
  timing?: ProviderTiming;
}

interface ProviderFailureState {
  value: FirstOutputFailure | null;
}

class BenchmarkFailure extends Error {
  constructor(
    readonly code: FirstOutputFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BenchmarkFailure';
  }
}

class BenchmarkSpawnFailure extends BenchmarkFailure {
  constructor(
    primary: FirstOutputFailure,
    readonly pid: number,
    readonly stdout: string,
    readonly stderr: string,
    readonly processStartedAtMs: number,
    readonly cleanupFailure: FirstOutputFailure | null,
    readonly residualProcessCount: number,
    readonly safeToContinue: boolean,
    readonly daemonExited: boolean,
  ) {
    super(primary.code, primary.message);
    this.name = 'BenchmarkSpawnFailure';
  }
}

class ResidualProcessFailure extends BenchmarkFailure {
  constructor(
    message: string,
    readonly residualProcessCount: number,
  ) {
    super('residual_process', message);
    this.name = 'ResidualProcessFailure';
  }
}

class BenchmarkTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms.`);
    this.name = 'BenchmarkTimeoutError';
  }
}

function firstOutputFailure(
  error: unknown,
  fallback: FirstOutputFailureCode = 'harness_error',
): FirstOutputFailure {
  return error instanceof BenchmarkFailure
    ? { code: error.code, message: error.message }
    : { code: fallback, message: errorMessage(error) };
}

function readBenchmarkConfig(): BenchmarkConfig {
  if (!SANDBOX_DISABLED) {
    throw new Error(
      'Invalid first-output benchmark config: QWEN_SANDBOX must be exactly false.',
    );
  }
  const singlePath = process.env['BENCHMARK_CLI_PATH']?.trim();
  const controlPath = process.env['BENCHMARK_CONTROL_CLI_PATH']?.trim();
  const candidatePath = process.env['BENCHMARK_CANDIDATE_CLI_PATH']?.trim();
  const hasSingle = Boolean(singlePath);
  const hasControl = Boolean(controlPath);
  const hasCandidate = Boolean(candidatePath);

  if (hasSingle && (hasControl || hasCandidate)) {
    throw new Error(
      'Invalid first-output benchmark config: BENCHMARK_CLI_PATH cannot be ' +
        'combined with BENCHMARK_CONTROL_CLI_PATH or ' +
        'BENCHMARK_CANDIDATE_CLI_PATH.',
    );
  }
  if (hasControl !== hasCandidate) {
    throw new Error(
      'Invalid first-output benchmark config: compare mode requires both ' +
        'BENCHMARK_CONTROL_CLI_PATH and BENCHMARK_CANDIDATE_CLI_PATH.',
    );
  }
  if (!hasSingle && !hasControl) {
    throw new Error(
      'Invalid first-output benchmark config: set BENCHMARK_CLI_PATH for ' +
        'single mode, or set both BENCHMARK_CONTROL_CLI_PATH and ' +
        'BENCHMARK_CANDIDATE_CLI_PATH for compare mode.',
    );
  }

  if (hasSingle) {
    if (process.env['BENCHMARK_POST_SESSION_DWELL_MS'] !== undefined) {
      throw new Error(
        'Invalid first-output benchmark config: ' +
          'BENCHMARK_POST_SESSION_DWELL_MS is compare-only.',
      );
    }
    if (process.env['BENCHMARK_MEASURED_PAIRS'] !== undefined) {
      throw new Error(
        'Invalid first-output benchmark config: ' +
          'BENCHMARK_MEASURED_PAIRS is compare-only.',
      );
    }
    return {
      mode: 'single',
      bundle: resolveBundle(singlePath!, 'single'),
      postSessionDwellMs: 0,
    };
  }

  // Parsed only after the compare-only rejections above, so an unsupported
  // value in single mode reports that the variable is compare-only rather than
  // listing the dwell values compare mode would have accepted.
  const dwell = parseBenchmarkPostSessionDwell(
    process.env['BENCHMARK_POST_SESSION_DWELL_MS'],
  );
  const control = resolveBundle(controlPath!, 'control');
  const candidate = resolveBundle(candidatePath!, 'candidate');
  if (control.realPath === candidate.realPath) {
    throw new Error(
      'Invalid first-output benchmark config: control and candidate resolve ' +
        `to the same bundle (${control.realPath}).`,
    );
  }
  if (control.sha256 === candidate.sha256) {
    throw new Error(
      'Invalid first-output benchmark config: control and candidate bundle ' +
        `hashes are identical (${control.sha256}).`,
    );
  }
  return {
    mode: 'compare',
    control,
    candidate,
    postSessionDwellMs: dwell,
    measuredPairs: measuredPairCountForDwell(
      dwell,
      process.env['BENCHMARK_MEASURED_PAIRS'],
    ),
  };
}

function resolveBundle(input: string, role: BundleRole): ResolvedBundle {
  const configuredPath = path.resolve(input);
  let realPath: string;
  try {
    realPath = fs.realpathSync(configuredPath);
  } catch (error) {
    throw new Error(
      `Invalid ${role} bundle path ${JSON.stringify(input)}: ${errorMessage(error)}`,
    );
  }
  const stat = fs.statSync(realPath);
  if (!stat.isFile()) {
    throw new Error(
      `Invalid ${role} bundle path ${JSON.stringify(input)}: expected a file.`,
    );
  }
  const compileCacheDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `qwen-first-output-cache-${role}-`),
  );
  activeCompileCacheDirs.add(compileCacheDir);
  return {
    role,
    configuredPath,
    realPath,
    sha256: createHash('sha256')
      .update(fs.readFileSync(realPath))
      .digest('hex'),
    compileCacheDir,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function spawnBenchmarkDaemon(
  bundle: ResolvedBundle,
  workspace: string,
  env: NodeJS.ProcessEnv,
): Promise<BenchmarkDaemon> {
  const processStartedAtMs = performance.now();
  const child = spawn(
    process.execPath,
    [
      bundle.realPath,
      'serve',
      '--port',
      '0',
      '--token',
      TOKEN,
      '--hostname',
      '127.0.0.1',
      '--workspace',
      workspace,
      '--max-sessions',
      '0',
    ],
    {
      cwd: workspace,
      detached: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const pid = child.pid;
  if (!pid) {
    throw new Error(`Failed to spawn ${bundle.role} daemon: no child pid.`);
  }
  const processGroup: ActiveProcessGroup = {
    child,
    pid,
    descendantPids: new Set(),
    descendantSnapshotComplete: false,
  };
  activeProcessGroups.add(processGroup);

  const stdout = { value: '' };
  const stderr = { value: '' };
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout.value += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.value += chunk.toString();
  });

  let port: number;
  try {
    port = await waitForListening(child, stdout, stderr);
  } catch (error) {
    const primary = firstOutputFailure(error);
    let cleanupFailure: FirstOutputFailure | null = null;
    let residualProcessCount = 0;
    let safeToContinue = true;
    try {
      await terminateTrackedProcessGroup(processGroup);
      activeProcessGroups.delete(processGroup);
    } catch (cleanupError) {
      safeToContinue = false;
      cleanupFailure ??= firstOutputFailure(cleanupError, 'cleanup_timeout');
      residualProcessCount =
        cleanupError instanceof ResidualProcessFailure
          ? cleanupError.residualProcessCount
          : 0;
    }
    throw new BenchmarkSpawnFailure(
      primary,
      pid,
      tailUtf8(stdout.value),
      tailUtf8(stderr.value),
      processStartedAtMs,
      cleanupFailure,
      residualProcessCount,
      safeToContinue,
      hasChildExited(child),
    );
  }

  const daemon: BenchmarkDaemon = {
    client: new DaemonClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: TOKEN,
      fetchTimeoutMs: SDK_FETCH_TIMEOUT_MS,
    }),
    child,
    pid,
    processStartedAtMs,
    daemonReadyAtMs: performance.now(),
    port,
    stdout,
    stderr,
    processGroup,
  };
  activeDaemons.add(daemon);
  return daemon;
}

function waitForListening(
  child: ChildProcess,
  stdout: { value: string },
  stderr: { value: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      clearTimeout(timer);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = () => {
      const port = stdout.value.match(LISTENING_LINE_RE)?.groups?.['port'];
      if (!port || settled) return;
      settled = true;
      cleanup();
      resolve(Number(port));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(
        new BenchmarkFailure(
          'daemon_exited_before_listen',
          `Daemon exited before listening (code=${code}, signal=${signal}).\n` +
            `stdout:\n${tailUtf8(stdout.value)}\nstderr:\n${tailUtf8(stderr.value)}`,
        ),
      );
    };
    const onError = (error: Error) => {
      fail(
        new BenchmarkFailure(
          'daemon_exited_before_listen',
          `Daemon spawn failed: ${error.message}`,
          { cause: error },
        ),
      );
    };
    const timer = setTimeout(() => {
      fail(
        new BenchmarkFailure(
          'daemon_boot_timeout',
          `Daemon did not listen within ${BOOT_TIMEOUT_MS}ms.\n` +
            `stdout:\n${tailUtf8(stdout.value)}\nstderr:\n${tailUtf8(stderr.value)}`,
        ),
      );
    }, BOOT_TIMEOUT_MS);
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function terminateBenchmarkDaemon(
  daemon: BenchmarkDaemon,
): Promise<null> {
  await terminateTrackedProcessGroup(daemon.processGroup);
  activeDaemons.delete(daemon);
  activeProcessGroups.delete(daemon.processGroup);
  return null;
}

function benchmarkDescendantPids(pid: number): number[] {
  const descendants = benchmarkDescendants(pid);
  return [
    ...new Set([...descendants.acpChildren, ...descendants.mcpGrandchildren]),
  ];
}

function benchmarkDescendants(pid: number) {
  return countDescendants(pid, {
    acpFilter: '(^|[[:space:]])--acp([[:space:]]|$)',
  });
}

function rememberDescendantPids(
  processGroup: ActiveProcessGroup,
  descendantPids: readonly number[],
): void {
  for (const descendantPid of descendantPids) {
    processGroup.descendantPids.add(descendantPid);
  }
}

async function terminateTrackedProcessGroup(
  processGroup: ActiveProcessGroup,
): Promise<void> {
  let enumerationFailure: FirstOutputFailure | null = null;
  if (!hasChildExited(processGroup.child)) {
    try {
      rememberDescendantPids(
        processGroup,
        benchmarkDescendantPids(processGroup.pid),
      );
      processGroup.descendantSnapshotComplete = true;
    } catch (error) {
      processGroup.descendantSnapshotComplete = false;
      enumerationFailure = firstOutputFailure(error, 'cleanup_timeout');
    }
  }

  const trackedPids = [...processGroup.descendantPids];
  const remainingPids = await terminateProcessGroup(
    processGroup.child,
    trackedPids,
  );
  for (const trackedPid of trackedPids) {
    if (!remainingPids.includes(trackedPid)) {
      processGroup.descendantPids.delete(trackedPid);
    }
  }
  if (remainingPids.length > 0) {
    throw new ResidualProcessFailure(
      `Tracked descendants survived teardown: ${remainingPids.join(', ')}.`,
      remainingPids.length,
    );
  }
  if (!processGroup.descendantSnapshotComplete) {
    throw new BenchmarkFailure(
      'cleanup_timeout',
      enumerationFailure?.message ??
        'Descendant enumeration did not complete before the process-group leader exited.',
    );
  }
}

async function terminateProcessGroup(
  child: ChildProcess,
  descendantPids: number[],
): Promise<number[]> {
  const pid = child.pid;
  if (!pid) return descendantPids;

  if (!hasChildExited(child)) {
    signalProcessGroup(pid, 'SIGTERM');
  }
  await waitForChildExit(child, PROCESS_EXIT_TIMEOUT_MS);
  let remaining = await waitForDescendantsExit(
    descendantPids,
    DESCENDANT_EXIT_TIMEOUT_MS,
  );

  if (!hasChildExited(child)) {
    signalProcessGroup(pid, 'SIGKILL');
    await waitForChildExit(child, PROCESS_EXIT_TIMEOUT_MS);
    remaining = await waitForDescendantsExit(
      remaining,
      DESCENDANT_EXIT_TIMEOUT_MS,
    );
  }
  if (!hasChildExited(child)) {
    throw new BenchmarkFailure(
      'cleanup_timeout',
      `Daemon process group ${pid} did not exit after SIGKILL.`,
    );
  }

  return remaining;
}

async function waitForDescendantsExit(
  descendantPids: readonly number[],
  timeoutMs: number,
): Promise<number[]> {
  const deadline = performance.now() + timeoutMs;
  let remaining = descendantPids.filter(isProcessAlive);
  while (remaining.length > 0 && performance.now() < deadline) {
    await sleep(25);
    remaining = remaining.filter(isProcessAlive);
  }
  return remaining;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') throw error;
  }
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (hasChildExited(child)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

function fakeProviderPort(server: FakeOpenAIServer): number {
  const port = Number(new URL(server.baseUrl).port);
  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new Error(
      `Fake provider returned an invalid base URL: ${server.baseUrl}`,
    );
  }
  return port;
}

function isolatedDaemonEnv(
  home: string,
  qwenHome: string,
  tempDir: string,
  workspace: string,
  fakeServer: FakeOpenAIServer,
  bundle: ResolvedBundle,
): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  if (process.env['PATH']) inherited['PATH'] = process.env['PATH'];
  const trustedFoldersPath = path.join(qwenHome, 'trustedFolders.json');
  fs.writeFileSync(
    trustedFoldersPath,
    JSON.stringify({ [fs.realpathSync(workspace)]: 'TRUST_FOLDER' }),
  );
  return {
    ...inherited,
    HOME: home,
    QWEN_HOME: qwenHome,
    TMPDIR: tempDir,
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    NODE_COMPILE_CACHE: bundle.compileCacheDir,
    QWEN_SANDBOX: 'false',
    QWEN_CODE_INTEGRATION_TEST: 'true',
    QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
    QWEN_TELEMETRY_ENABLED: 'false',
    QWEN_CODE_TRUSTED_FOLDERS_PATH: trustedFoldersPath,
    CI: 'true',
    TERM: 'dumb',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    NO_COLOR: '1',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    OPENAI_API_KEY: 'fake-key',
    OPENAI_BASE_URL: fakeServer.baseUrl,
    OPENAI_MODEL: 'fake-model',
    QWEN_MODEL: 'fake-model',
  };
}

function prepareIsolatedDirectories(sampleId: string): {
  root: string;
  workspace: string;
  home: string;
  qwenHome: string;
  tempDir: string;
} {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `qwen-first-output-${sampleId}-`),
  );
  activeTempDirs.add(root);
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const qwenHome = path.join(home, '.qwen');
  const tempDir = path.join(root, 'tmp');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(qwenHome, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(
    path.join(qwenHome, 'settings.json'),
    JSON.stringify({
      ui: { enableFollowupSuggestions: false },
    }),
  );
  return { root, workspace, home, qwenHome, tempDir };
}

function makePrompt(): string {
  promptSequence++;
  const marker = `first-output-${String(promptSequence).padStart(6, '0')}`;
  const prefix = `Reply with one short sentence. Benchmark marker: ${marker}. `;
  if (prefix.length > PROMPT_LENGTH) {
    throw new Error('Benchmark prompt prefix exceeded its fixed width.');
  }
  return prefix.padEnd(PROMPT_LENGTH, 'x');
}

function startTimedFakeProvider(
  expectedRequests: Map<string, ExpectedRequest>,
  failureState: ProviderFailureState,
): Promise<FakeOpenAIServer> {
  return startFakeOpenAIServer(
    async ({ body }) => {
      if (body['stream'] !== true || body['model'] !== 'fake-model') {
        const message =
          'Benchmark Provider requires stream=true and model=fake-model.';
        failureState.value ??= {
          code: 'harness_error',
          message,
        };
        throw new Error(message);
      }
      const messages = JSON.stringify(body['messages'] ?? []);
      const matches = [...expectedRequests.values()].filter(({ prompt }) =>
        messages.includes(prompt),
      );
      if (matches.length !== 1) {
        const message = `Expected exactly one benchmark prompt in provider request, found ${matches.length}.`;
        failureState.value ??= {
          code: 'provider_request_count_mismatch',
          message,
        };
        throw new Error(message);
      }
      const expected = matches[0];
      expected.count++;
      if (expected.count !== 1) {
        const message = `Benchmark prompt reached the provider ${expected.count} times.`;
        failureState.value ??= {
          code: 'provider_request_count_mismatch',
          message,
        };
        throw new Error(message);
      }
      const requestAtMs = performance.now();
      await sleep(PROVIDER_DELAY_MS);
      const readyAtMs = performance.now();
      expected.timing = {
        prompt: expected.prompt,
        requestAtMs,
        readyAtMs,
      };
      return { content: EXPECTED_ANSWER };
    },
    { keepAlive: false },
  );
}

async function runSession(
  daemon: BenchmarkDaemon,
  workspace: string,
  ordinal: 1 | 2,
  postSessionDwellMs: number,
  expectedRequests: Map<string, ExpectedRequest>,
): Promise<FirstOutputSessionRunResult> {
  const prompt = makePrompt();
  const expectedRequest: ExpectedRequest = { prompt, count: 0 };
  expectedRequests.set(prompt, expectedRequest);

  const sessionCreateStart = performance.now();
  let session: DaemonSession | undefined;
  let promptId: string | null = null;
  let abort: AbortController | undefined;
  let promptAbort: AbortController | undefined;
  let streamTask: Promise<void> | undefined;
  let failure: FirstOutputFailure | null = null;
  let cleanupFailure: FirstOutputFailure | null = null;
  const tracker = new FirstOutputTracker();
  const timestamps: FirstOutputSessionRunResult['timestamps'] = {
    sessionCreateStart,
    sessionReady: null,
    sseReady: null,
    promptStart: null,
    promptAccepted: null,
    providerRequestArrival: null,
    providerReady: null,
    firstModelOutput: null,
    firstAnswerText: null,
    terminal: null,
  };

  try {
    try {
      session = await daemon.client.createOrAttachSession({
        workspaceCwd: workspace,
        sessionScope: 'thread',
      });
    } catch (error) {
      throw new BenchmarkFailure(
        'session_create_failed',
        `Session creation failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (!session.sessionId || !session.clientId) {
      throw new BenchmarkFailure(
        'session_create_failed',
        'Session creation returned a malformed response.',
      );
    }
    timestamps.sessionReady = performance.now();

    abort = new AbortController();
    const epochReady = deferred<void>();
    const terminalReady = deferred<void>();
    void terminalReady.promise.catch(() => undefined);
    streamTask = (async () => {
      try {
        for await (const event of daemon.client.subscribeEvents(
          session!.sessionId,
          {
            signal: abort!.signal,
            onEpoch: () => {
              if (timestamps.sseReady === null) {
                timestamps.sseReady = performance.now();
                epochReady.resolve();
              }
            },
          },
        )) {
          tracker.push(event as DaemonEvent, performance.now());
          if (tracker.snapshot().terminal !== null) {
            terminalReady.resolve();
            return;
          }
        }
        const streamEnded = new BenchmarkFailure(
          'sse_stream_ended',
          'SSE stream ended before the matching prompt terminal.',
        );
        epochReady.reject(streamEnded);
        terminalReady.reject(streamEnded);
      } catch (error) {
        if (!abort!.signal.aborted) {
          epochReady.reject(error);
          terminalReady.reject(
            new BenchmarkFailure(
              'sse_stream_ended',
              `SSE stream failed: ${errorMessage(error)}`,
              { cause: error },
            ),
          );
        }
      }
    })();

    try {
      await withTimeout(
        epochReady.promise,
        TURN_TIMEOUT_MS,
        'SSE epoch readiness',
      );
    } catch (error) {
      throw new BenchmarkFailure(
        error instanceof BenchmarkTimeoutError
          ? 'sse_connect_timeout'
          : 'sse_stream_ended',
        `SSE connection failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    // The dwell exists to give a candidate genuinely idle time before the
    // prompt, so it is anchored to SSE readiness rather than session readiness.
    // The SSE connect sits between the two: anchoring to sessionReady lets a
    // slow connect consume the whole window, silently degrading the scenario
    // into an immediate-prompt run that still reports its configured dwell.
    if (timestamps.sseReady === null) {
      throw new BenchmarkFailure(
        'harness_error',
        'SSE readiness resolved without recording a timestamp.',
      );
    }
    const promptNotBefore = timestamps.sseReady + postSessionDwellMs;
    if (performance.now() < promptNotBefore) {
      await sleep(promptNotBefore - performance.now());
    }

    timestamps.promptStart = performance.now();
    promptAbort = new AbortController();
    let accepted: Awaited<ReturnType<DaemonClient['promptNonBlocking']>>;
    try {
      accepted = await withTimeout(
        daemon.client.promptNonBlocking(
          session.sessionId,
          {
            prompt: [{ type: 'text', text: prompt }],
          },
          promptAbort.signal,
          session.clientId,
        ),
        TURN_TIMEOUT_MS,
        'prompt acceptance',
      );
    } catch (error) {
      promptAbort.abort();
      const snapshot = tracker.snapshot();
      if (snapshot.failureCode !== null) {
        throw new BenchmarkFailure(
          snapshot.failureCode,
          snapshot.failureMessage ?? snapshot.failureCode,
        );
      }
      throw new BenchmarkFailure(
        error instanceof BenchmarkTimeoutError
          ? 'prompt_accept_timeout'
          : 'prompt_rejected',
        `Prompt acceptance failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const acceptance = validatePromptAcceptance(accepted);
    if (acceptance.kind === 'failure') {
      throw new BenchmarkFailure(
        acceptance.failure.code,
        acceptance.failure.message,
      );
    }
    timestamps.promptAccepted = performance.now();
    promptId = acceptance.promptId;
    tracker.acceptPrompt(promptId);
    const acceptedSnapshot = tracker.snapshot();
    if (
      acceptedSnapshot.terminal !== null ||
      acceptedSnapshot.failureCode !== null
    ) {
      terminalReady.resolve();
    }

    try {
      await withTimeout(
        terminalReady.promise,
        TURN_TIMEOUT_MS,
        'matching prompt terminal',
      );
    } catch (error) {
      const snapshot = tracker.snapshot();
      if (snapshot.failureCode !== null) {
        throw new BenchmarkFailure(
          snapshot.failureCode,
          snapshot.failureMessage ?? snapshot.failureCode,
        );
      }
      if (error instanceof BenchmarkFailure) throw error;
      throw new BenchmarkFailure(
        snapshot.firstOutput === null
          ? 'first_output_timeout'
          : 'terminal_timeout',
        errorMessage(error),
        { cause: error },
      );
    }
    const tracked = tracker.snapshot();
    if (tracked.failureCode !== null) {
      throw new BenchmarkFailure(
        tracked.failureCode,
        tracked.failureMessage ?? tracked.failureCode,
      );
    }
    if (!tracked.runEligible || !tracked.firstOutput || !tracked.terminal) {
      throw new BenchmarkFailure(
        'harness_error',
        `Prompt ${promptId} completed without an eligible output and terminal.`,
      );
    }
    if (tracked.firstOutput.kind !== 'answer_text') {
      throw new BenchmarkFailure(
        'unexpected_output_kind',
        `Expected answer_text as first output, received ${tracked.firstOutput.kind}.`,
      );
    }
    const finalTextFailure = validateExpectedFinalText(
      tracked.finalAnswerText,
      EXPECTED_ANSWER,
    );
    if (finalTextFailure) {
      throw new BenchmarkFailure(
        finalTextFailure.code,
        finalTextFailure.message,
      );
    }
    if (expectedRequest.count !== 1 || !expectedRequest.timing) {
      throw new BenchmarkFailure(
        'provider_request_count_mismatch',
        `Expected exactly one target generation request, observed ${expectedRequest.count}.`,
      );
    }
  } catch (error) {
    failure = firstOutputFailure(error);
  } finally {
    promptAbort?.abort();
    abort?.abort();
    if (streamTask) {
      try {
        await withTimeout(streamTask, PROCESS_EXIT_TIMEOUT_MS, 'SSE shutdown');
      } catch (error) {
        cleanupFailure ??= firstOutputFailure(error, 'cleanup_timeout');
      }
    }
  }

  const tracked = tracker.snapshot();
  if (expectedRequest.timing) {
    timestamps.providerRequestArrival = expectedRequest.timing.requestAtMs;
    timestamps.providerReady = expectedRequest.timing.readyAtMs;
  }
  timestamps.firstModelOutput = tracked.firstOutput?.receivedAtMs ?? null;
  timestamps.firstAnswerText = tracked.firstAnswer?.receivedAtMs ?? null;
  timestamps.terminal = tracked.terminal?.receivedAtMs ?? null;
  const timings = computeSessionTimings(timestamps, daemon.processStartedAtMs);
  const invalidMetrics = findInvalidTimings(timings);
  if (invalidMetrics.length > 0) {
    failure ??= {
      code: 'harness_error',
      message: `Invalid durations: ${invalidMetrics
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')}`,
    };
    for (const [key] of invalidMetrics) timings[key] = null;
  }

  return {
    ordinal,
    sessionId: session?.sessionId ?? null,
    promptId,
    timestamps,
    timings,
    firstOutput: tracked.firstOutput,
    firstAnswer: tracked.firstAnswer,
    finalAnswerText: tracked.finalAnswerText,
    terminal: tracked.terminal,
    providerRequestCount: expectedRequest.count,
    runEligible: failure === null && tracked.runEligible,
    answerMetricEligible: failure === null && tracked.answerMetricEligible,
    failure,
    cleanupFailure,
    diagnostics: {
      promptLength: prompt.length,
      promptSha256: createHash('sha256').update(prompt).digest('hex'),
      bufferedBeforeAcceptanceCount: tracked.bufferedBeforeAcceptanceCount,
      matchingEventCount: tracked.matchingEventCount,
      matchingTerminalCount: tracked.matchingTerminalCount,
      sseReadyBeforePrompt:
        timestamps.sseReady !== null &&
        timestamps.promptStart !== null &&
        timestamps.sseReady <= timestamps.promptStart,
      actualProviderDelayMs: duration(
        timestamps.providerReady,
        timestamps.providerRequestArrival,
      ),
    },
  };
}

function computeSessionTimings(
  timestamps: FirstOutputSessionRunResult['timestamps'],
  processStartedAtMs: number,
): FirstOutputSessionRunResult['timings'] {
  return {
    processToSessionReadyMs: duration(
      timestamps.sessionReady,
      processStartedAtMs,
    ),
    sseReadyToPromptMs: duration(timestamps.promptStart, timestamps.sseReady),
    promptToProviderRequestArrivalMs: duration(
      timestamps.providerRequestArrival,
      timestamps.promptStart,
    ),
    promptToFirstModelOutputMs: duration(
      timestamps.firstModelOutput,
      timestamps.promptStart,
    ),
    promptToFirstAnswerTextMs: duration(
      timestamps.firstAnswerText,
      timestamps.promptStart,
    ),
    providerReadyToFirstModelOutputMs: duration(
      timestamps.firstModelOutput,
      timestamps.providerReady,
    ),
    processToFirstModelOutputMs: duration(
      timestamps.firstModelOutput,
      processStartedAtMs,
    ),
    promptToTerminalMs: duration(timestamps.terminal, timestamps.promptStart),
  };
}

function duration(end: number | null, start: number | null): number | null {
  return end === null || start === null ? null : end - start;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new BenchmarkTimeoutError(label, timeoutMs));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function runProcessSample(options: {
  sampleId: string;
  bundle: ResolvedBundle;
  order: PairOrder | null;
  pairIndex: number | null;
  warmup: boolean;
  postSessionDwellMs: number;
  sessionCount: 1 | 2;
}): Promise<ProcessSample> {
  let dirs: ReturnType<typeof prepareIsolatedDirectories> | undefined;
  const expectedRequests = new Map<string, ExpectedRequest>();
  const providerFailureState: ProviderFailureState = { value: null };
  let fakeServer: FakeOpenAIServer | undefined;
  let daemon: BenchmarkDaemon | undefined;
  let spawnFailure: BenchmarkSpawnFailure | undefined;
  const sessions: FirstOutputSessionRunResult[] = [];
  let failure: FirstOutputFailure | null = null;
  let cleanupFailure: FirstOutputFailure | null = null;
  let residualProcessCount = 0;
  let firstSessionAcpPids: number[] | null = null;
  let safeToContinue = true;

  try {
    dirs = prepareIsolatedDirectories(options.sampleId);
    fakeServer = await startTimedFakeProvider(
      expectedRequests,
      providerFailureState,
    );
    activeFakeProviders.add(fakeServer);
    daemon = await spawnBenchmarkDaemon(
      options.bundle,
      dirs.workspace,
      isolatedDaemonEnv(
        dirs.home,
        dirs.qwenHome,
        dirs.tempDir,
        dirs.workspace,
        fakeServer,
        options.bundle,
      ),
    );

    for (let ordinal = 1; ordinal <= options.sessionCount; ordinal += 1) {
      const session = await runSession(
        daemon,
        dirs.workspace,
        ordinal as 1 | 2,
        options.postSessionDwellMs,
        expectedRequests,
      );
      sessions.push(session);
      cleanupFailure ??= session.cleanupFailure;
      if (options.sessionCount === 2 && session.failure === null) {
        const descendants = benchmarkDescendants(daemon.pid);
        rememberDescendantPids(daemon.processGroup, [
          ...descendants.acpChildren,
          ...descendants.mcpGrandchildren,
        ]);
        const acpPids = descendants.acpChildren.sort(
          (left, right) => left - right,
        );
        session.diagnostics = { ...session.diagnostics, acpPids };
        if (ordinal === 1) {
          firstSessionAcpPids = acpPids;
        } else if (
          firstSessionAcpPids === null ||
          firstSessionAcpPids.length !== 1 ||
          acpPids.length !== 1 ||
          firstSessionAcpPids[0] !== acpPids[0]
        ) {
          failure = {
            code: 'harness_error',
            message:
              'Cold and warm sessions did not use the same single ACP child process.',
          };
        }
      }
      if (session.failure !== null || session.cleanupFailure !== null) {
        failure ??= providerFailureState.value ?? session.failure;
        break;
      }
    }

    for (const session of sessions) {
      if (!session.sessionId) continue;
      try {
        await daemon.client.closeSession(session.sessionId, undefined);
      } catch (error) {
        cleanupFailure ??= {
          code: 'cleanup_timeout',
          message: `Session close failed: ${errorMessage(error)}`,
        };
      }
    }

    if (
      failure === null &&
      cleanupFailure === null &&
      options.sessionCount === 2
    ) {
      const [first, second] = sessions;
      if (
        !first ||
        !second ||
        first.sessionId === second.sessionId ||
        first.promptId === second.promptId
      ) {
        failure = {
          code: 'harness_error',
          message:
            'The two sessionScope=thread benchmark turns did not retain distinct session and prompt ids.',
        };
      }
    }
  } catch (error) {
    if (error instanceof BenchmarkSpawnFailure) {
      spawnFailure = error;
      cleanupFailure ??= error.cleanupFailure;
      residualProcessCount = error.residualProcessCount;
      safeToContinue = error.safeToContinue;
    }
    failure ??= firstOutputFailure(error);
  } finally {
    if (daemon && activeDaemons.has(daemon)) {
      try {
        const processCleanupFailure = await terminateBenchmarkDaemon(daemon);
        cleanupFailure ??= processCleanupFailure;
      } catch (error) {
        safeToContinue = false;
        cleanupFailure ??= firstOutputFailure(error, 'cleanup_timeout');
        residualProcessCount =
          error instanceof ResidualProcessFailure
            ? error.residualProcessCount
            : residualProcessCount;
      }
    }
    failure ??= providerFailureState.value;
    if (
      fakeServer &&
      failure === null &&
      cleanupFailure === null &&
      (expectedRequests.size !== options.sessionCount ||
        fakeServer.requests.length !== options.sessionCount ||
        [...expectedRequests.values()].some((request) => request.count !== 1))
    ) {
      failure = {
        code: 'provider_request_count_mismatch',
        message:
          'Provider request-count invariant failed after daemon exit: ' +
          `expected exactly one generation for each of ${options.sessionCount} ` +
          `sessions, saw ${fakeServer.requests.length} total request(s).`,
      };
    }
    if (fakeServer) {
      try {
        await withTimeout(
          fakeServer.close(),
          PROCESS_EXIT_TIMEOUT_MS,
          'Fake Provider shutdown',
        );
        activeFakeProviders.delete(fakeServer);
      } catch (error) {
        safeToContinue = false;
        cleanupFailure ??= {
          code: 'cleanup_timeout',
          message: `Fake Provider close failed: ${errorMessage(error)}`,
        };
      }
    }
    if (dirs && safeToContinue) {
      try {
        fs.rmSync(dirs.root, { recursive: true, force: true });
        activeTempDirs.delete(dirs.root);
      } catch (error) {
        cleanupFailure ??= {
          code: 'cleanup_timeout',
          message: `Temporary-state cleanup failed: ${errorMessage(error)}`,
        };
      }
    }
  }

  const failed = failure !== null || cleanupFailure !== null;
  return {
    sampleId: options.sampleId,
    role: options.bundle.role,
    bundleRealPath: options.bundle.realPath,
    bundleSha256: options.bundle.sha256,
    order: options.order,
    pairIndex: options.pairIndex,
    warmup: options.warmup,
    pid: daemon?.pid ?? spawnFailure?.pid ?? null,
    processStartedAtMs:
      daemon?.processStartedAtMs ?? spawnFailure?.processStartedAtMs ?? null,
    daemonReadyAtMs: daemon?.daemonReadyAtMs ?? null,
    daemonPort: daemon?.port ?? null,
    fakeProviderPort: fakeServer ? fakeProviderPort(fakeServer) : null,
    sessions,
    failure,
    safeToContinue,
    stdout: failed
      ? tailUtf8(daemon?.stdout.value ?? spawnFailure?.stdout ?? '')
      : '',
    stderr: failed
      ? tailUtf8(daemon?.stderr.value ?? spawnFailure?.stderr ?? '')
      : '',
    cleanup: {
      completed: cleanupFailure === null,
      daemonExited:
        daemon !== undefined
          ? hasChildExited(daemon.child)
          : spawnFailure !== undefined
            ? spawnFailure.daemonExited
            : true,
      residualProcessCount,
      failure: cleanupFailure,
    },
    deferredTempRoot: dirs && activeTempDirs.has(dirs.root) ? dirs.root : null,
  };
}

function tailUtf8(value: string): string {
  const bytes = Buffer.from(value);
  return bytes.subarray(Math.max(0, bytes.length - 4_096)).toString();
}

async function runSingleSamples(config: SingleBenchmarkConfig): Promise<{
  warmups: ProcessSample[];
  measured: ProcessSample[];
}> {
  const warmups: ProcessSample[] = [];
  const measured: ProcessSample[] = [];
  for (let index = 1; index <= SINGLE_WARMUPS; index++) {
    logProgress(`single warmup ${index}/${SINGLE_WARMUPS}`);
    const sample = await runProcessSample({
      sampleId: `single-warmup-${index}`,
      bundle: config.bundle,
      order: null,
      pairIndex: null,
      warmup: true,
      postSessionDwellMs: 0,
      sessionCount: SINGLE_SESSIONS_PER_PROCESS,
    });
    warmups.push(sample);
    if (!isSuccessfulProcessSample(sample, SINGLE_SESSIONS_PER_PROCESS)) {
      return { warmups, measured };
    }
  }
  for (let index = 1; index <= SINGLE_MEASURED; index++) {
    logProgress(`single measured ${index}/${SINGLE_MEASURED}`);
    const sample = await runProcessSample({
      sampleId: `single-measured-${index}`,
      bundle: config.bundle,
      order: null,
      pairIndex: null,
      warmup: false,
      postSessionDwellMs: 0,
      sessionCount: SINGLE_SESSIONS_PER_PROCESS,
    });
    measured.push(sample);
    if (!isSuccessfulProcessSample(sample, SINGLE_SESSIONS_PER_PROCESS)) {
      return { warmups, measured };
    }
  }
  return { warmups, measured };
}

interface RawPair {
  pairIndex: number;
  order: PairOrder;
  warmup: boolean;
  control: ProcessSample;
  candidate: ProcessSample;
  safeToContinue: boolean;
}

async function runComparisonPairs(
  config: CompareBenchmarkConfig,
): Promise<{ warmups: RawPair[]; measured: RawPair[] }> {
  const warmups: RawPair[] = [];
  const measured: RawPair[] = [];
  const warmupOrders: PairOrder[] = ['AB', 'BA'];
  for (let index = 1; index <= COMPARE_WARMUP_PAIRS; index++) {
    const order = warmupOrders[index - 1];
    logProgress(
      `compare warmup pair ${index}/${COMPARE_WARMUP_PAIRS} (${order})`,
    );
    const pair = await runComparisonPair(config, index, order, true);
    warmups.push(pair);
    if (!isSuccessfulRawPair(pair)) return { warmups, measured };
  }
  for (let index = 1; index <= config.measuredPairs; index++) {
    const order: PairOrder = index % 2 === 1 ? 'AB' : 'BA';
    logProgress(
      `compare measured pair ${index}/${config.measuredPairs} (${order})`,
    );
    const pair = await runComparisonPair(config, index, order, false);
    measured.push(pair);
    if (!isSuccessfulRawPair(pair)) return { warmups, measured };
  }
  return { warmups, measured };
}

async function runComparisonPair(
  config: CompareBenchmarkConfig,
  pairIndex: number,
  order: PairOrder,
  warmup: boolean,
): Promise<RawPair> {
  const sequence =
    order === 'AB'
      ? ([config.control, config.candidate] as const)
      : ([config.candidate, config.control] as const);
  const samples: ProcessSample[] = [];
  for (const [position, bundle] of sequence.entries()) {
    const sampleId =
      `${warmup ? 'warmup' : 'measured'}-pair-${pairIndex}-` +
      `${position + 1}-${bundle.role}`;
    const sample = await runProcessSample({
      sampleId,
      bundle,
      order,
      pairIndex,
      warmup,
      postSessionDwellMs: config.postSessionDwellMs,
      sessionCount: COMPARE_SESSIONS_PER_PROCESS,
    });
    samples.push(sample);
    if (!sample.safeToContinue && position === 0) {
      const skippedBundle = sequence[1];
      samples.push(
        skippedProcessSample(
          `${warmup ? 'warmup' : 'measured'}-pair-${pairIndex}-2-${skippedBundle.role}`,
          skippedBundle,
          order,
          pairIndex,
          warmup,
        ),
      );
      break;
    }
  }
  const control = samples.find((sample) => sample.role === 'control');
  const candidate = samples.find((sample) => sample.role === 'candidate');
  if (!control || !candidate) {
    throw new Error(`Comparison pair ${pairIndex} lost a variant result.`);
  }
  return {
    pairIndex,
    order,
    warmup,
    control,
    candidate,
    safeToContinue: samples.every((sample) => sample.safeToContinue),
  };
}

function isSuccessfulProcessSample(
  sample: {
    failure: FirstOutputFailure | null;
    cleanup: { failure: FirstOutputFailure | null };
    sessions: readonly FirstOutputSessionRunResult[];
  },
  expectedSessions: 1 | 2,
): boolean {
  return (
    sample.failure === null &&
    sample.cleanup.failure === null &&
    sample.sessions.length === expectedSessions &&
    sample.sessions.every((session) => session.runEligible)
  );
}

function isSuccessfulRawPair(pair: RawPair): boolean {
  return (
    pair.safeToContinue &&
    isSuccessfulProcessSample(pair.control, COMPARE_SESSIONS_PER_PROCESS) &&
    isSuccessfulProcessSample(pair.candidate, COMPARE_SESSIONS_PER_PROCESS)
  );
}

function skippedProcessSample(
  sampleId: string,
  bundle: ResolvedBundle,
  order: PairOrder,
  pairIndex: number,
  warmup: boolean,
): ProcessSample {
  return {
    sampleId,
    role: bundle.role,
    bundleRealPath: bundle.realPath,
    bundleSha256: bundle.sha256,
    order,
    pairIndex,
    warmup,
    pid: null,
    processStartedAtMs: null,
    daemonReadyAtMs: null,
    daemonPort: null,
    fakeProviderPort: null,
    sessions: [],
    failure: {
      code: 'harness_error',
      message:
        "Arm was not started because the preceding arm's owned resources could not be verified as stopped.",
    },
    safeToContinue: false,
    stdout: '',
    stderr: '',
    cleanup: {
      completed: true,
      daemonExited: true,
      residualProcessCount: 0,
      failure: null,
    },
    deferredTempRoot: null,
  };
}

function logProgress(message: string): void {
  console.log(`[first-output-benchmark] ${message}`);
}

const METRICS: readonly FirstOutputMetricName[] = [
  'processToListenMs',
  'processToSessionReadyMs',
  'sseReadyToPromptMs',
  'promptToProviderRequestArrivalMs',
  'promptToFirstModelOutputMs',
  'promptToFirstAnswerTextMs',
  'providerReadyToFirstModelOutputMs',
  'processToFirstModelOutputMs',
  'promptToTerminalMs',
];

function toProcessRun(
  sample: ProcessSample,
  sampleIndex: number,
  orderPosition: 1 | 2 | null,
): FirstOutputProcessRunResult {
  return {
    variant: sample.role,
    sampleIndex,
    pairIndex: sample.pairIndex,
    orderPosition,
    measured: !sample.warmup,
    pid: sample.pid,
    timestamps: {
      processStart: sample.processStartedAtMs,
      daemonReady: sample.daemonReadyAtMs,
    },
    processToListenMs: duration(
      sample.daemonReadyAtMs,
      sample.processStartedAtMs,
    ),
    sessions: sample.sessions,
    failure: sample.failure,
    cleanup: sample.cleanup,
    stdout: sample.stdout,
    stderr: sample.stderr,
    diagnostics: {
      sampleId: sample.sampleId,
      bundleRealPath: sample.bundleRealPath,
      bundleSha256: sample.bundleSha256,
      daemonPort: sample.daemonPort,
      fakeProviderPort: sample.fakeProviderPort,
      deferredTempRoot: sample.deferredTempRoot,
    },
  };
}

function toPairResult(
  pair: RawPair,
  sampleIndex: number,
): FirstOutputPairResult {
  const controlPosition: 1 | 2 = pair.order === 'AB' ? 1 : 2;
  const candidatePosition: 1 | 2 = pair.order === 'AB' ? 2 : 1;
  const control = toProcessRun(pair.control, sampleIndex, controlPosition);
  const candidate = toProcessRun(
    pair.candidate,
    sampleIndex,
    candidatePosition,
  );
  const invalidReasons = [control, candidate].flatMap((run) => {
    const reasons: string[] = [];
    if (run.failure) reasons.push(`${run.variant}:${run.failure.code}`);
    if (run.cleanup.failure) {
      reasons.push(`${run.variant}:cleanup:${run.cleanup.failure.code}`);
    }
    if (run.sessions.some((session) => !session.runEligible)) {
      reasons.push(`${run.variant}:ineligible_session`);
    }
    return reasons;
  });
  return {
    pairIndex: pair.pairIndex,
    order: pair.order,
    control,
    candidate,
    valid: invalidReasons.length === 0,
    invalidReason:
      invalidReasons.length === 0 ? null : invalidReasons.join(', '),
  };
}

function sessionMetric(
  session: FirstOutputSessionRunResult,
  metric: FirstOutputMetricName,
): number | null {
  switch (metric) {
    case 'processToSessionReadyMs':
      return session.timings.processToSessionReadyMs;
    case 'sseReadyToPromptMs':
      return session.timings.sseReadyToPromptMs;
    case 'promptToProviderRequestArrivalMs':
      return session.timings.promptToProviderRequestArrivalMs;
    case 'promptToFirstModelOutputMs':
      return session.timings.promptToFirstModelOutputMs;
    case 'promptToFirstAnswerTextMs':
      return session.timings.promptToFirstAnswerTextMs;
    case 'providerReadyToFirstModelOutputMs':
      return session.timings.providerReadyToFirstModelOutputMs;
    case 'processToFirstModelOutputMs':
      return session.timings.processToFirstModelOutputMs;
    case 'promptToTerminalMs':
      return session.timings.promptToTerminalMs;
    case 'processToListenMs':
      return null;
  }
}

function buildSingleMetricSummary(
  runs: readonly FirstOutputProcessRunResult[],
  metric: FirstOutputMetricName,
): FirstOutputSingleMetricSummary {
  if (metric === 'processToListenMs') {
    return {
      all: nullablePercentiles(
        runs.map((run) =>
          isSuccessfulRun(run) ? run.processToListenMs : null,
        ),
      ),
      bySession: {},
    };
  }
  const bySession: Record<string, ReturnType<typeof nullablePercentiles>> = {};
  for (const ordinal of [1, 2] as const) {
    bySession[`session_${ordinal}`] = nullablePercentiles(
      runs.map((run) => {
        if (!isSuccessfulRun(run)) return null;
        const session = run.sessions.find(
          (candidate) => candidate.ordinal === ordinal,
        );
        return session ? sessionMetric(session, metric) : null;
      }),
    );
  }
  return {
    all: null,
    bySession,
  };
}

function buildPairedMetricSummary(
  pairs: readonly FirstOutputPairResult[],
  metric: FirstOutputMetricName,
  seedOffset: number,
): FirstOutputPairedMetricSummary {
  if (metric === 'processToListenMs') {
    return {
      all: pairedCandidateControlStats(
        pairs.map((pair) => ({
          order: pair.order,
          valid: pair.valid,
          controlMs: pair.control.processToListenMs,
          candidateMs: pair.candidate.processToListenMs,
        })),
        pairedOptions(seedOffset),
      ),
      bySession: {},
    };
  }

  const sessionStats = pairedCandidateControlStats(
    pairs.map((pair) => ({
      order: pair.order,
      valid: pair.valid,
      controlMs: metricForOrdinal(pair.control, 1, metric),
      candidateMs: metricForOrdinal(pair.candidate, 1, metric),
    })),
    pairedOptions(seedOffset),
  );
  return {
    all: null,
    bySession: { session_1: sessionStats },
  };
}

function metricForOrdinal(
  run: FirstOutputProcessRunResult,
  ordinal: number,
  metric: FirstOutputMetricName,
): number | null {
  const session = run.sessions.find(
    (candidate) => candidate.ordinal === ordinal,
  );
  return session ? sessionMetric(session, metric) : null;
}

function pairedOptions(seedOffset: number): {
  seed: number;
  bootstrapIterations: number;
  materialThresholdMs: number;
  orderSensitivityThresholdMs: number;
} {
  return {
    seed: BOOTSTRAP_SEED + seedOffset,
    bootstrapIterations: DEFAULT_BOOTSTRAP_ITERATIONS,
    materialThresholdMs: DEFAULT_MATERIAL_THRESHOLD_MS,
    orderSensitivityThresholdMs: DEFAULT_ORDER_SENSITIVITY_THRESHOLD_MS,
  };
}

function commonArtifactFields(): Pick<
  FirstOutputBenchmarkArtifactV2,
  'version' | 'benchmark' | 'capturedAt' | 'harnessGitCommit' | 'platform'
> {
  const cpus = os.cpus();
  const loadAverage = os.loadavg() as [number, number, number];
  return {
    version: FIRST_OUTPUT_BENCHMARK_VERSION,
    benchmark: 'daemon-first-output',
    capturedAt: new Date().toISOString(),
    harnessGitCommit: gitHead(),
    platform: {
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cpuModel: cpus[0]?.model ?? 'unknown',
      logicalCpuCount: cpus.length,
      availableCpuCount: os.availableParallelism(),
      totalMemoryBytes: os.totalmem(),
      loadAverage,
    },
  };
}

function commonConfig(postSessionDwellMs: number): {
  seed: number;
  providerDelayMs: number;
  providerConnection: 'close-per-response';
  postSessionDwellMs: number;
  promptShape: string;
  expectedAnswer: string;
  maxBufferedEvents: number;
  providerRequestsPerSession: number;
  timeoutsMs: Record<string, number>;
} {
  return {
    seed: BOOTSTRAP_SEED,
    providerDelayMs: PROVIDER_DELAY_MS,
    providerConnection: 'close-per-response',
    postSessionDwellMs,
    promptShape:
      `Unique fixed-width ${PROMPT_LENGTH}-character prompt with a ` +
      'zero-padded per-session marker',
    expectedAnswer: EXPECTED_ANSWER,
    maxBufferedEvents: DEFAULT_FIRST_OUTPUT_EVENT_BUFFER_LIMIT,
    providerRequestsPerSession: 1,
    timeoutsMs: {
      daemonBoot: BOOT_TIMEOUT_MS,
      sdkFetch: SDK_FETCH_TIMEOUT_MS,
      promptTurn: TURN_TIMEOUT_MS,
      streamShutdown: PROCESS_EXIT_TIMEOUT_MS,
      providerShutdown: PROCESS_EXIT_TIMEOUT_MS,
      processExit: PROCESS_EXIT_TIMEOUT_MS,
      descendantExit: DESCENDANT_EXIT_TIMEOUT_MS,
      emergencyCleanup: EMERGENCY_CLEANUP_TIMEOUT_MS,
      outerTest: BENCHMARK_TEST_TIMEOUT_MS,
    },
  };
}

function variantDescriptor(bundle: ResolvedBundle): {
  cliPath: string;
  realpath: string;
  sha256: string;
  compileCache: {
    policy: 'fixed-private-per-variant-warmed';
    directory: string;
  };
} {
  return {
    cliPath: bundle.configuredPath,
    realpath: bundle.realPath,
    sha256: bundle.sha256,
    compileCache: {
      policy: 'fixed-private-per-variant-warmed',
      directory: bundle.compileCacheDir,
    },
  };
}

function buildSingleArtifact(
  config: SingleBenchmarkConfig,
  raw: Awaited<ReturnType<typeof runSingleSamples>>,
): FirstOutputBenchmarkArtifactV2 {
  const warmupRuns = raw.warmups.map((sample, index) =>
    toProcessRun(sample, index + 1, null),
  );
  const runs = raw.measured.map((sample, index) =>
    toProcessRun(sample, index + 1, null),
  );
  const metrics: Partial<
    Record<FirstOutputMetricName, FirstOutputSingleMetricSummary>
  > = {};
  for (const metric of METRICS) {
    metrics[metric] = buildSingleMetricSummary(runs, metric);
  }
  const successfulRuns = runs.filter(isSuccessfulRun).length;
  const measuredComplete = runs.length === SINGLE_MEASURED;
  const measuredValid = measuredComplete && successfulRuns === SINGLE_MEASURED;
  const warmupsComplete = warmupRuns.length === SINGLE_WARMUPS;
  const validWarmups = warmupRuns.filter(isSuccessfulRun).length;
  const warmupsValid = warmupsComplete && validWarmups === SINGLE_WARMUPS;
  const coldProviderP50 =
    metrics['promptToProviderRequestArrivalMs']?.bySession['session_1']
      ?.distribution?.p50 ?? null;
  const warmProviderP50 =
    metrics['promptToProviderRequestArrivalMs']?.bySession['session_2']
      ?.distribution?.p50 ?? null;
  const coldFirstOutputP50 =
    metrics['promptToFirstModelOutputMs']?.bySession['session_1']?.distribution
      ?.p50 ?? null;
  const complete = warmupsValid && measuredValid;
  const gate = evaluateSingleBundlePrototypeGate({
    complete,
    coldWarmPairedDeltasMs: coldWarmProviderDeltas(runs),
    seed: BOOTSTRAP_SEED,
    coldPromptToProviderRequestP50Ms: coldProviderP50,
    warmPromptToProviderRequestP50Ms: warmProviderP50,
    coldPromptToFirstModelOutputP50Ms: coldFirstOutputP50,
  });
  const providerDeltaMs = gate.providerDeltaMs;
  const gatePassed = gate.passed;
  const outcome = !complete
    ? 'invalid'
    : gatePassed
      ? 'prototype_allowed'
      : 'stop';
  return {
    ...commonArtifactFields(),
    mode: 'single',
    config: {
      ...commonConfig(0),
      warmupRuns: SINGLE_WARMUPS,
      measuredRuns: SINGLE_MEASURED,
      variant: variantDescriptor(config.bundle),
    },
    warmupRuns,
    runs,
    summary: {
      expectedRuns: SINGLE_MEASURED,
      successfulRuns,
      failedRuns: runs.length - successfulRuns,
      failuresByCode: countRunFailures([...warmupRuns, ...runs]),
      metrics,
      decision: {
        outcome,
        reasons: [
          measuredComplete
            ? `All ${SINGLE_MEASURED} measured processes ran.`
            : `Only ${runs.length}/${SINGLE_MEASURED} measured processes ran before the first invalid process stopped sampling.`,
          measuredValid
            ? `Paired cold-minus-warm Provider-arrival median: ${
                gate.pairedMedianDeltaMs === null
                  ? 'n/a'
                  : `${gate.pairedMedianDeltaMs.toFixed(1)}ms`
              }, 95% CI ${
                gate.bootstrapMedianCi95 === null
                  ? 'n/a'
                  : `[${gate.bootstrapMedianCi95.lowMs.toFixed(1)}, ${gate.bootstrapMedianCi95.highMs.toFixed(1)}]`
              }.`
            : `Only ${successfulRuns}/${SINGLE_MEASURED} measured processes were valid.`,
          warmupsComplete
            ? `Both compile-cache warmup processes ran.`
            : `Only ${warmupRuns.length}/${SINGLE_WARMUPS} compile-cache warmup processes ran before the first invalid process stopped sampling.`,
          warmupsValid
            ? 'Both compile-cache warmup processes were valid.'
            : `Only ${validWarmups}/${SINGLE_WARMUPS} compile-cache warmup processes were valid.`,
          gatePassed
            ? 'The baseline permits a separate Provider-preparation prototype.'
            : 'The baseline does not permit production Provider-preparation changes.',
          'Single-bundle measurements do not claim an optimization.',
        ],
        gate: {
          coldPromptToProviderRequestP50Ms: coldProviderP50,
          warmPromptToProviderRequestP50Ms: warmProviderP50,
          providerDeltaMs,
          pairedMedianDeltaMs: gate.pairedMedianDeltaMs,
          bootstrapMedianCi95: gate.bootstrapMedianCi95,
          coldPromptToFirstModelOutputP50Ms: coldFirstOutputP50,
          absoluteThresholdMs: gate.absoluteThresholdMs,
          relativeThresholdRatio: gate.relativeThresholdRatio,
          passed: gatePassed,
        },
      },
    },
  };
}

function buildPairedArtifact(
  config: CompareBenchmarkConfig,
  raw: Awaited<ReturnType<typeof runComparisonPairs>>,
): FirstOutputBenchmarkArtifactV2 {
  const warmups = raw.warmups.map((pair, index) =>
    toPairResult(pair, index + 1),
  );
  const pairs = raw.measured.map((pair, index) =>
    toPairResult(pair, index + 1),
  );
  const metrics: Partial<
    Record<FirstOutputMetricName, FirstOutputPairedMetricSummary>
  > = {};
  for (const [index, metric] of METRICS.entries()) {
    metrics[metric] = buildPairedMetricSummary(pairs, metric, index * 10);
  }
  const primary =
    metrics['processToFirstModelOutputMs']?.bySession['session_1'];
  if (!primary) {
    throw new Error('Primary paired metric summary was not produced.');
  }
  const validPairs = pairs.filter((pair) => pair.valid).length;
  const measuredComplete = pairs.length === config.measuredPairs;
  const measuredValid = measuredComplete && validPairs === config.measuredPairs;
  const warmupsValid =
    warmups.length === COMPARE_WARMUP_PAIRS &&
    warmups.every((pair) => pair.valid);
  const diagnosticOnly = config.measuredPairs === 10;
  const comparisonOutcome =
    measuredValid && warmupsValid
      ? diagnosticOnly
        ? 'inconclusive'
        : primary.decision
      : 'invalid';
  return {
    ...commonArtifactFields(),
    mode: 'paired',
    config: {
      ...commonConfig(config.postSessionDwellMs),
      warmupPairs: COMPARE_WARMUP_PAIRS,
      measuredPairs: config.measuredPairs,
      bootstrapIterations: DEFAULT_BOOTSTRAP_ITERATIONS,
      materialThresholdMs: DEFAULT_MATERIAL_THRESHOLD_MS,
      orderSensitivityThresholdMs: DEFAULT_ORDER_SENSITIVITY_THRESHOLD_MS,
      variants: {
        control: variantDescriptor(config.control),
        candidate: variantDescriptor(config.candidate),
      },
    },
    warmups,
    pairs,
    summary: {
      expectedPairs: config.measuredPairs,
      validPairs,
      invalidPairs: pairs.length - validPairs,
      failuresByCode: countPairFailures([...warmups, ...pairs]),
      metrics,
      decision: {
        outcome: comparisonOutcome,
        scope: 'primary_metric_only',
        publicationGateEvaluated: false,
        primaryMetric: 'processToFirstModelOutputMs',
        primarySession: 1,
        reasons: [
          ...(diagnosticOnly
            ? [
                'The 10-pair 500ms scenario is diagnostic-only and cannot produce a decision-bearing outcome.',
              ]
            : []),
          primary.decisionReason,
          warmupsValid
            ? 'Both compile-cache warmup pairs were valid.'
            : 'At least one compile-cache warmup pair failed.',
          measuredComplete
            ? `All ${config.measuredPairs} measured pairs ran.`
            : `Only ${pairs.length}/${config.measuredPairs} measured pairs ran before the first invalid pair stopped sampling.`,
          measuredValid
            ? `All ${config.measuredPairs} measured pairs were valid.`
            : `Only ${validPairs}/${config.measuredPairs} measured pairs were valid.`,
          `Session 1 median candidate-control delta: ${
            primary.medianDeltaMs === null
              ? 'n/a'
              : `${primary.medianDeltaMs.toFixed(1)}ms`
          }.`,
          'Each comparison arm measures one cold thread session.',
          'This artifact does not evaluate cross-scenario, resource, or publication gates.',
        ],
      },
    },
  };
}

function coldWarmProviderDeltas(
  runs: readonly FirstOutputProcessRunResult[],
): number[] {
  const deltas: number[] = [];
  for (const run of runs.filter(isSuccessfulRun)) {
    const coldMs = metricForOrdinal(run, 1, 'promptToProviderRequestArrivalMs');
    const warmMs = metricForOrdinal(run, 2, 'promptToProviderRequestArrivalMs');
    if (coldMs !== null && warmMs !== null) deltas.push(coldMs - warmMs);
  }
  return deltas;
}

function isSuccessfulRun(run: FirstOutputProcessRunResult): boolean {
  return isSuccessfulProcessSample(run, SINGLE_SESSIONS_PER_PROCESS);
}

function countRunFailures(
  runs: readonly FirstOutputProcessRunResult[],
): Partial<Record<FirstOutputFailureCode, number>> {
  const counts: Partial<Record<FirstOutputFailureCode, number>> = {};
  for (const run of runs) {
    for (const failure of [run.failure, run.cleanup.failure]) {
      if (!failure) continue;
      counts[failure.code] = (counts[failure.code] ?? 0) + 1;
    }
  }
  return counts;
}

function countPairFailures(
  pairs: readonly FirstOutputPairResult[],
): Partial<Record<FirstOutputFailureCode, number>> {
  return countRunFailures(
    pairs.flatMap((pair) => [pair.control, pair.candidate]),
  );
}

function buildFatalArtifact(
  failure: FirstOutputFailure,
): FirstOutputBenchmarkArtifactV2 {
  const hasSingle = Boolean(process.env['BENCHMARK_CLI_PATH']?.trim());
  const hasPaired = Boolean(
    process.env['BENCHMARK_CONTROL_CLI_PATH']?.trim() ||
      process.env['BENCHMARK_CANDIDATE_CLI_PATH']?.trim(),
  );
  return {
    ...commonArtifactFields(),
    mode: 'failed',
    config: {
      requestedMode:
        hasSingle === hasPaired ? 'unknown' : hasSingle ? 'single' : 'paired',
    },
    failure,
    summary: {
      failuresByCode: { [failure.code]: 1 },
      decision: {
        outcome: 'invalid',
        reasons: [failure.message],
      },
    },
  };
}

function gitHead(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

async function cleanupActiveResources(): Promise<void> {
  const failures: unknown[] = [];
  for (const processGroup of [...activeProcessGroups]) {
    try {
      await terminateTrackedProcessGroup(processGroup);
      activeProcessGroups.delete(processGroup);
      for (const daemon of activeDaemons) {
        if (daemon.processGroup === processGroup) {
          activeDaemons.delete(daemon);
        }
      }
    } catch (error) {
      failures.push(error);
    }
  }
  for (const fakeProvider of [...activeFakeProviders]) {
    try {
      await withTimeout(
        fakeProvider.close(),
        PROCESS_EXIT_TIMEOUT_MS,
        'Fake Provider emergency shutdown',
      );
      activeFakeProviders.delete(fakeProvider);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 0) {
    for (const tempDir of [...activeTempDirs]) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        activeTempDirs.delete(tempDir);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const cacheDir of [...activeCompileCacheDirs]) {
      try {
        fs.rmSync(cacheDir, { recursive: true, force: true });
        activeCompileCacheDirs.delete(cacheDir);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'One or more benchmark-owned resources survived emergency cleanup.',
    );
  }
}

(SKIP ? describe.skip : describe).sequential(
  'daemon first-output benchmark (opt-in, POSIX-only)',
  { retry: 0 },
  () => {
    afterAll(cleanupActiveResources, EMERGENCY_CLEANUP_TIMEOUT_MS);

    it(
      'records a single baseline or balanced paired comparison',
      async () => {
        let artifact: FirstOutputBenchmarkArtifactV2 | undefined;
        let runError: unknown;
        let configResolved = false;
        try {
          const config = readBenchmarkConfig();
          configResolved = true;
          artifact =
            config.mode === 'single'
              ? buildSingleArtifact(config, await runSingleSamples(config))
              : buildPairedArtifact(config, await runComparisonPairs(config));
        } catch (error) {
          runError = error;
          artifact = buildFatalArtifact(
            firstOutputFailure(
              error,
              configResolved ? 'harness_error' : 'invalid_configuration',
            ),
          );
        } finally {
          if (artifact) {
            writeSnapshotArtifacts(
              OUTPUT_DIR,
              'daemon-first-output-benchmark-v2',
              artifact,
              renderFirstOutputBenchmarkMarkdown(artifact),
              'first-output-benchmark',
            );
          }
        }

        if (runError !== undefined) throw runError;
        if (
          artifact.mode === 'failed' ||
          artifact.summary.decision.outcome === 'invalid'
        ) {
          throw new Error(
            'First-output benchmark produced an invalid artifact.',
          );
        }
      },
      BENCHMARK_TEST_TIMEOUT_MS,
    );
  },
);
