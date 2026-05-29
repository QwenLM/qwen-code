/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CPU profiling utility that generates .cpuprofile files for Chrome DevTools.
 *
 * Three trigger modes:
 * 1. Environment variable: QWEN_CODE_CPU_PROFILE=1 — records from process start to exit
 * 2. Signal toggle: SIGUSR1 — first signal starts, second stops and writes
 * 3. Command: /doctor cpu-profile [--duration N] — records for N seconds
 *
 * Output: ~/.qwen/cpu-profiles/qwen-code-cpu-<pid>-<timestamp>.cpuprofile
 * Zero overhead when disabled (single env var check at init).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { registerCleanup } from './cleanup.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProfilerState = 'idle' | 'recording' | 'stopping';

export type CpuProfileStartResult = { ok: true } | { ok: false; error: string };

export type CpuProfileStopResult =
  | { ok: true; filePath: string }
  | { ok: false; error: string };

interface InspectorSession {
  connect(): void;
  disconnect(): void;
  post(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PROFILES = 5;
const RATE_LIMIT_MS = 30_000;
const MIN_FREE_BYTES_AFTER_WRITE = 256 * 1024 * 1024;
const DEFAULT_SAMPLING_INTERVAL_US = 1000; // 1ms
const ESTIMATED_PROFILE_BYTES = 10 * 1024 * 1024; // 10 MiB conservative estimate

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let state: ProfilerState = 'idle';
let session: InspectorSession | null = null;
let initialized = false;
let signalHandlerRegistered = false;
const lastWriteByDir = new Map<string, number>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize CPU profiler. Call once at process start.
 * Always registers SIGUSR1 handler (for ad-hoc profiling).
 * When QWEN_CODE_CPU_PROFILE=1, also starts recording immediately.
 */
export function initCpuProfiler(): void {
  if (initialized) return;
  initialized = true;

  // Always register signal handler for ad-hoc profiling (non-Windows)
  registerSignalHandler();

  // Always register cleanup to flush any in-progress profile on exit
  registerCleanup(async () => {
    if (state === 'recording') {
      const result = await stopCpuProfile();
      if (result.ok) {
        process.stderr.write(
          `[cpu-profiler] Profile written: ${result.filePath}\n`,
        );
      }
    }
  });

  const enabled = process.env['QWEN_CODE_CPU_PROFILE'] === '1';
  if (!enabled) return;

  // Start recording immediately in env-var mode
  void startCpuProfile().then((result) => {
    if (!result.ok) {
      process.stderr.write(`[cpu-profiler] Failed to start: ${result.error}\n`);
    }
  });
}

/**
 * Start CPU profiling.
 * @param opts.samplingInterval - Sampling interval in microseconds (default 1000 = 1ms)
 */
export async function startCpuProfile(opts?: {
  samplingInterval?: number;
}): Promise<CpuProfileStartResult> {
  if (state !== 'idle') {
    return {
      ok: false,
      error:
        state === 'recording'
          ? 'CPU profiling is already in progress.'
          : 'CPU profiler is stopping, please wait.',
    };
  }

  // Set state eagerly before the first await to prevent concurrent callers
  // (e.g., rapid SIGUSR1 signals) from both passing the idle guard.
  state = 'recording';

  try {
    const inspectorSession = await getOrCreateSession();
    await inspectorSession.post('Profiler.enable');
    await inspectorSession.post('Profiler.setSamplingInterval', {
      interval: opts?.samplingInterval ?? DEFAULT_SAMPLING_INTERVAL_US,
    });
    await inspectorSession.post('Profiler.start');
    return { ok: true };
  } catch (error) {
    state = 'idle';
    disconnectSession();
    return { ok: false, error: formatError(error) };
  }
}

/**
 * Stop CPU profiling and write the .cpuprofile file.
 * @returns File path on success.
 */
export async function stopCpuProfile(options?: {
  outputDir?: string;
  now?: Date;
  rateLimitMs?: number;
  maxProfiles?: number;
}): Promise<CpuProfileStopResult> {
  if (state !== 'recording') {
    return {
      ok: false,
      error:
        state === 'idle'
          ? 'CPU profiler is not recording.'
          : 'CPU profiler is already stopping.',
    };
  }

  const outputDir = options?.outputDir ?? defaultOutputDir();
  const now = options?.now ?? new Date();
  const rateLimitMs = options?.rateLimitMs ?? RATE_LIMIT_MS;
  const maxProfiles = options?.maxProfiles ?? MAX_PROFILES;

  // Check rate limit BEFORE stopping the V8 profiler — if rate-limited,
  // keep the profiler running so data isn't lost.
  try {
    enforceRateLimit(outputDir, now, rateLimitMs);
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }

  state = 'stopping';

  try {
    if (!session) {
      throw new Error('Inspector session lost unexpectedly.');
    }

    const result = (await session.post('Profiler.stop')) as {
      profile: unknown;
    };
    if (!result.profile) {
      throw new Error(
        'V8 Profiler.stop returned an empty profile; recording may have been interrupted.',
      );
    }
    await session.post('Profiler.disable');

    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(outputDir, 0o700);
    } catch {
      // Best-effort hardening on filesystems without POSIX chmod.
    }

    checkDiskSpace(outputDir);

    const filePath = path.join(
      outputDir,
      `qwen-code-cpu-${process.pid}-${formatTimestamp(now)}.cpuprofile`,
    );

    try {
      fs.writeFileSync(filePath, JSON.stringify(result.profile), {
        mode: 0o600,
      });
    } catch (writeError) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // Best-effort cleanup of partial file.
      }
      throw writeError;
    }

    recordWrite(outputDir, now);
    cleanupOldProfiles(outputDir, maxProfiles);

    state = 'idle';
    return { ok: true, filePath };
  } catch (error) {
    state = 'idle';
    disconnectSession();
    return { ok: false, error: formatError(error) };
  }
}

/**
 * Whether the profiler is currently recording.
 */
export function isCpuProfileRecording(): boolean {
  return state === 'recording';
}

/**
 * Register SIGUSR1 signal handler for toggle mode.
 * Safe to call multiple times; only registers once.
 * No-op on Windows (SIGUSR1 does not exist).
 */
export function registerSignalHandler(): void {
  if (signalHandlerRegistered) return;
  if (process.platform === 'win32') return;

  signalHandlerRegistered = true;
  process.on('SIGUSR1', handleSigusr1);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset all module state. Test-only. */
export function _resetCpuProfilerForTest(): void {
  state = 'idle';
  initialized = false;
  signalHandlerRegistered = false;
  disconnectSession();
  lastWriteByDir.clear();
}

/** Clear rate limit state. Test-only. */
export function clearCpuProfileRateLimit(): void {
  lastWriteByDir.clear();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function defaultOutputDir(): string {
  return path.join(os.homedir(), '.qwen', 'cpu-profiles');
}

function formatTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Overridable factory for testing (avoids mocking ESM dynamic imports)
let sessionFactory: (() => Promise<InspectorSession>) | null = null;

/** Override session creation for testing. */
export function _setSessionFactoryForTest(
  factory: (() => Promise<InspectorSession>) | null,
): void {
  sessionFactory = factory;
}

async function getOrCreateSession(): Promise<InspectorSession> {
  if (session) return session;

  if (sessionFactory) {
    session = await sessionFactory();
    return session;
  }

  // Dynamic import to avoid any overhead when profiling is disabled
  const inspectorModule = await import('node:inspector/promises');
  const newSession =
    new inspectorModule.Session() as unknown as InspectorSession;
  newSession.connect();
  session = newSession;
  return session;
}

function disconnectSession(): void {
  if (session) {
    try {
      session.disconnect();
    } catch {
      // Ignore disconnect errors during cleanup.
    }
    session = null;
  }
}

function handleSigusr1(): void {
  if (state === 'idle') {
    void startCpuProfile().then((result) => {
      if (result.ok) {
        process.stderr.write(
          `[cpu-profiler] Recording started (PID ${process.pid}). Send SIGUSR1 again to stop.\n`,
        );
      } else {
        process.stderr.write(
          `[cpu-profiler] Failed to start: ${result.error}\n`,
        );
      }
    });
  } else if (state === 'recording') {
    void stopCpuProfile().then((result) => {
      if (result.ok) {
        process.stderr.write(
          `[cpu-profiler] Profile written: ${result.filePath}\n`,
        );
      } else {
        process.stderr.write(
          `[cpu-profiler] Failed to stop: ${result.error}\n`,
        );
      }
    });
  }
  // state === 'stopping': ignore, already in progress
}

function enforceRateLimit(
  outputDir: string,
  now: Date,
  rateLimitMs: number,
): void {
  if (rateLimitMs <= 0) return;

  const key = path.resolve(outputDir);
  const nowMs = now.getTime();
  const lastWriteMs = lastWriteByDir.get(key);
  if (lastWriteMs !== undefined && nowMs - lastWriteMs < rateLimitMs) {
    const waitSeconds = Math.ceil((rateLimitMs - (nowMs - lastWriteMs)) / 1000);
    throw new Error(
      `CPU profile rate limit: wait ${waitSeconds}s before writing another profile.`,
    );
  }
}

function recordWrite(outputDir: string, now: Date): void {
  lastWriteByDir.set(path.resolve(outputDir), now.getTime());
}

function checkDiskSpace(outputDir: string): void {
  try {
    const stats = fs.statfsSync(outputDir);
    const available = stats.bavail * stats.bsize;
    if (available - ESTIMATED_PROFILE_BYTES < MIN_FREE_BYTES_AFTER_WRITE) {
      throw new Error(
        'Insufficient free disk space for CPU profile; skipping to avoid filling the disk.',
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('Insufficient free disk')
    ) {
      throw error;
    }
    // statfsSync may fail on some platforms; proceed anyway.
  }
}

function cleanupOldProfiles(outputDir: string, maxProfiles: number): void {
  if (maxProfiles < 1) return;

  let profiles: string[];
  try {
    profiles = fs
      .readdirSync(outputDir)
      .filter(
        (name) =>
          name.startsWith('qwen-code-cpu-') && name.endsWith('.cpuprofile'),
      )
      .map((name) => path.join(outputDir, name))
      .sort((a, b) => {
        try {
          return (
            fs.lstatSync(b).mtimeMs - fs.lstatSync(a).mtimeMs ||
            path.basename(b).localeCompare(path.basename(a))
          );
        } catch {
          return 0;
        }
      });
  } catch {
    return;
  }

  for (const filePath of profiles.slice(maxProfiles)) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Cleanup is best effort.
    }
  }
}
