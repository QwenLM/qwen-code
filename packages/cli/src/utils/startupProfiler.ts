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
  if (process.env['QWEN_CODE_PROFILE_STARTUP'] !== '1') {
    enabled = false;
    return;
  }
  // Skip profiling in the outer (pre-sandbox) process — the child will
  // re-run index.ts inside the sandbox and collect its own profile.
  if (!process.env['SANDBOX']) {
    enabled = false;
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
    sessionId: '',
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

    const filename = `${report.timestamp.replace(/[:.]/g, '-')}-${sessionId || 'unknown'}.json`;
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
