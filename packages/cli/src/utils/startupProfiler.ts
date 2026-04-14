/**
 * Lightweight startup performance profiler.
 *
 * Activated by setting QWEN_CODE_PROFILE_STARTUP=1. When enabled, collects
 * high-resolution timestamps at key phases of CLI startup and writes a JSON
 * report to ~/.qwen/startup-perf/ on finalization.
 *
 * Usage (already wired in index.ts / gemini.tsx):
 *   initStartupProfiler()        — call once at process start to record T0
 *   profileCheckpoint('name')    — call at each phase boundary
 *   finalizeStartupProfile(id)   — call after last checkpoint to write report
 *
 * Only profiles inside the sandbox child process to avoid duplicate reports.
 * Zero overhead when disabled (single env var check).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

interface Checkpoint {
  name: string;
  timestamp: number;
}

export interface StartupPhase {
  name: string;
  startMs: number;
  durationMs: number;
}

export interface StartupReport {
  timestamp: string;
  sessionId: string;
  totalMs: number;
  phases: StartupPhase[];
  nodeVersion: string;
  platform: string;
  arch: string;
}

let enabled = false;
let t0 = 0;
let checkpoints: Checkpoint[] = [];
let finalized = false;

export function initStartupProfiler(): void {
  // Reset any prior state so the function is idempotent.
  resetStartupProfiler();

  if (process.env['QWEN_CODE_PROFILE_STARTUP'] !== '1') {
    return;
  }
  // Skip profiling in the outer (pre-sandbox) process — the child will
  // re-run index.ts inside the sandbox and collect its own profile.
  if (!process.env['SANDBOX']) {
    return;
  }
  enabled = true;
  finalized = false;
  t0 = performance.now();
  checkpoints = [];
}

export function profileCheckpoint(name: string): void {
  if (!enabled) return;
  checkpoints.push({ name, timestamp: performance.now() });
}

export function getStartupReport(): StartupReport | null {
  if (!enabled || checkpoints.length === 0) return null;

  const phases: StartupPhase[] = [];
  let prev = t0;

  // Each phase's durationMs is the delta from the previous checkpoint (or T0
  // for the first one). Checkpoints are assumed to be recorded sequentially.
  for (const cp of checkpoints) {
    phases.push({
      name: cp.name,
      startMs: Math.round((prev - t0) * 100) / 100,
      durationMs: Math.round((cp.timestamp - prev) * 100) / 100,
    });
    prev = cp.timestamp;
  }

  const lastTimestamp = checkpoints[checkpoints.length - 1]!.timestamp;

  return {
    timestamp: new Date().toISOString(),
    sessionId: 'unknown',
    totalMs: Math.round((lastTimestamp - t0) * 100) / 100,
    phases,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

export function finalizeStartupProfile(sessionId?: string): void {
  if (!enabled || finalized) return;
  finalized = true;

  const report = getStartupReport();
  if (!report) return;

  if (sessionId) {
    report.sessionId = sessionId;
  }

  try {
    const dir = path.join(os.homedir(), '.qwen', 'startup-perf');
    fs.mkdirSync(dir, { recursive: true });

    const filename = `${report.timestamp.replace(/[:.]/g, '-')}-${report.sessionId}.json`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, JSON.stringify(report, null, 2), 'utf-8');
    process.stderr.write(`Startup profile written to: ${filepath}\n`);
  } catch {
    process.stderr.write(
      'Warning: Failed to write startup profile report\n',
    );
  }
}

export function resetStartupProfiler(): void {
  enabled = false;
  t0 = 0;
  checkpoints = [];
  finalized = false;
}
