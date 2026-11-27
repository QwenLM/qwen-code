/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runLogger } from '@qwen-code/core';
import { cleanupDiagnosticLogs } from './diagnosticLogCleanup.js';

describe('cleanupDiagnosticLogs', () => {
  const now = new Date('2026-01-20T00:00:00.000Z');
  let logsRoot: string;

  beforeEach(async () => {
    logsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostic-logs-'));
    vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    vi.spyOn(runLogger, 'debug').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(logsRoot, { recursive: true, force: true });
  });

  async function createRun(runId: string, startedAt: string): Promise<void> {
    const runDir = path.join(logsRoot, 'runs', runId);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, 'manifest.json'),
      JSON.stringify({ run_id: runId, started_at: startedAt }) + '\n',
    );
    const timestamp = new Date(startedAt);
    await fs.utimes(runDir, timestamp, timestamp);
  }

  async function createSegment(
    runId: string,
    updatedAt: string,
    extension = '.jsonl',
  ): Promise<string> {
    const segmentPath = path.join(
      logsRoot,
      'sessions',
      'project-a',
      'session-a',
      'segments',
      `${runId}${extension}`,
    );
    await fs.mkdir(path.dirname(segmentPath), { recursive: true });
    await fs.writeFile(segmentPath, '{"type":"loop.started"}\n');
    const timestamp = new Date(updatedAt);
    await fs.utimes(segmentPath, timestamp, timestamp);
    return segmentPath;
  }

  async function exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  it('deletes expired runs and stale segments', async () => {
    await createRun('run-old', '2025-12-01T00:00:00.000Z');
    await createRun('run-recent', '2026-01-18T00:00:00.000Z');
    await createSegment('run-old', '2025-12-01T00:00:00.000Z');
    await createSegment('run-recent', '2026-01-18T00:00:00.000Z');
    await createSegment('run-orphan', '2025-12-01T00:00:00.000Z');
    await createSegment('run-orphan-log', '2025-12-01T00:00:00.000Z', '.log');

    const result = await cleanupDiagnosticLogs({
      logsRoot,
      currentRunId: 'run-current',
      now,
    });

    expect(result.disabled).toBe(false);
    expect(result.scannedRuns).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.deletedRuns).toBe(1);
    expect(result.scannedSegments).toBe(4);
    expect(result.deletedSegments).toBe(3);
    expect(await exists(path.join(logsRoot, 'runs', 'run-old'))).toBe(false);
    expect(await exists(path.join(logsRoot, 'runs', 'run-recent'))).toBe(true);
    expect(
      await exists(
        path.join(
          logsRoot,
          'sessions',
          'project-a',
          'session-a',
          'segments',
          'run-recent.jsonl',
        ),
      ),
    ).toBe(true);
  });

  it('uses run-name timestamps for runs and mtime for segments', async () => {
    const encodedOldRun = '2025-12-01T08-00-00-000+08-00-abc123-p42';
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Process has exited'), { code: 'ESRCH' });
    });
    await createRun(encodedOldRun, '2026-01-19T00:00:00.000Z');
    await createSegment(encodedOldRun, '2026-01-19T12:00:00.000Z');

    const result = await cleanupDiagnosticLogs({
      logsRoot,
      currentRunId: 'run-current',
      now,
    });

    expect(result.failed).toBe(0);
    expect(result.deletedRuns).toBe(1);
    expect(result.deletedSegments).toBe(0);
    expect(await exists(path.join(logsRoot, 'runs', encodedOldRun))).toBe(
      false,
    );
  });

  it('protects the current run and latest symlink target', async () => {
    await createRun('run-current', '2025-12-01T00:00:00.000Z');
    await createRun('run-latest', '2025-12-02T00:00:00.000Z');
    await createRun('run-old', '2025-12-03T00:00:00.000Z');
    await createSegment('run-current', '2025-12-01T00:00:00.000Z');
    await createSegment('run-latest', '2025-12-02T00:00:00.000Z');
    await createSegment('run-old', '2025-12-03T00:00:00.000Z');
    await fs.symlink(
      path.join('runs', 'run-latest'),
      path.join(logsRoot, 'latest'),
    );

    const result = await cleanupDiagnosticLogs({
      logsRoot,
      currentRunId: 'run-current',
      now,
    });

    expect(result.failed).toBe(0);
    expect(result.deletedRuns).toBe(1);
    expect(result.deletedSegments).toBe(1);
    expect(await exists(path.join(logsRoot, 'runs', 'run-current'))).toBe(true);
    expect(await exists(path.join(logsRoot, 'runs', 'run-latest'))).toBe(true);
    expect(await exists(path.join(logsRoot, 'runs', 'run-old'))).toBe(false);
  });

  it('keeps expired logs for a live process outside current and latest runs', async () => {
    const liveRun = `2025-12-01T00-00-00-000Z-live-p${process.pid}`;
    await createRun(liveRun, '2025-12-01T00:00:00.000Z');
    const jsonl = await createSegment(liveRun, '2025-12-01T00:00:00.000Z');
    const log = await createSegment(liveRun, '2025-12-01T00:00:00.000Z', '.log');
    await createRun('run-latest', '2026-01-19T00:00:00.000Z');
    await fs.symlink(path.join('runs', 'run-latest'), path.join(logsRoot, 'latest'));

    const result = await cleanupDiagnosticLogs({
      logsRoot,
      currentRunId: 'run-current',
      now,
    });

    expect(result.failed).toBe(0);
    expect(result.deletedRuns).toBe(0);
    expect(result.deletedSegments).toBe(0);
    expect(await exists(path.join(logsRoot, 'runs', liveRun))).toBe(true);
    expect(await exists(jsonl)).toBe(true);
    expect(await exists(log)).toBe(true);
  });

  it('keeps a live process segment even when its run directory is missing', async () => {
    const liveRun = `2025-12-01T00-00-00-000Z-live-p${process.pid}`;
    const segment = await createSegment(liveRun, '2025-12-01T00:00:00.000Z');

    const result = await cleanupDiagnosticLogs({
      logsRoot,
      currentRunId: 'run-current',
      now,
    });

    expect(result.failed).toBe(0);
    expect(result.deletedSegments).toBe(0);
    expect(await exists(segment)).toBe(true);
  });

  it.each(['EPERM', 'EACCES', 'EIO'])(
    'keeps expired logs when process inspection fails with %s',
    async (code) => {
      const runId = '2025-12-01T00-00-00-000Z-unknown-p42';
      await createRun(runId, '2025-12-01T00:00:00.000Z');
      const segment = await createSegment(runId, '2025-12-01T00:00:00.000Z');
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('Cannot inspect process'), { code });
      });

      const result = await cleanupDiagnosticLogs({
        logsRoot,
        currentRunId: 'run-current',
        now,
      });

      expect(result.failed).toBe(0);
      expect(result.deletedRuns).toBe(0);
      expect(result.deletedSegments).toBe(0);
      expect(await exists(path.join(logsRoot, 'runs', runId))).toBe(true);
      expect(await exists(segment)).toBe(true);
    },
  );

  it('deletes expired logs once their process has exited', async () => {
    const runId = '2025-12-01T00-00-00-000Z-exited-p42';
    await createRun(runId, '2025-12-01T00:00:00.000Z');
    const segment = await createSegment(runId, '2025-12-01T00:00:00.000Z');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Process has exited'), { code: 'ESRCH' });
    });

    const result = await cleanupDiagnosticLogs({
      logsRoot,
      currentRunId: 'run-current',
      now,
    });

    expect(result.failed).toBe(0);
    expect(result.deletedRuns).toBe(1);
    expect(result.deletedSegments).toBe(1);
    expect(await exists(path.join(logsRoot, 'runs', runId))).toBe(false);
    expect(await exists(segment)).toBe(false);
  });

  it('reports a non-missing latest link inspection failure without deleting runs', async () => {
    await createRun('run-old', '2025-12-01T00:00:00.000Z');
    await fs.mkdir(path.join(logsRoot, 'latest'));

    const result = await cleanupDiagnosticLogs({
      logsRoot,
      currentRunId: 'run-current',
      now,
    });

    expect(result.failed).toBe(1);
    expect(result.deletedRuns).toBe(0);
    expect(await exists(path.join(logsRoot, 'runs', 'run-old'))).toBe(true);
  });

  it('keeps runs and orphan segments for the full 30 days', async () => {
    await createRun('run-boundary', '2025-12-21T00:00:00.000Z');
    await createRun('run-recent', '2026-01-10T00:00:00.000Z');
    const boundary = await createSegment(
      'run-orphan-boundary',
      '2025-12-21T00:00:00.000Z',
    );
    const recent = await createSegment(
      'run-orphan-recent',
      '2026-01-10T00:00:00.000Z',
    );
    const expired = await createSegment(
      'run-orphan-expired',
      '2025-12-20T23:59:59.999Z',
    );

    const result = await cleanupDiagnosticLogs({
      logsRoot,
      currentRunId: 'run-current',
      now,
    });

    expect(result.failed).toBe(0);
    expect(result.deletedRuns).toBe(0);
    expect(result.deletedSegments).toBe(1);
    expect(await exists(path.join(logsRoot, 'runs', 'run-boundary'))).toBe(
      true,
    );
    expect(await exists(path.join(logsRoot, 'runs', 'run-recent'))).toBe(true);
    expect(await exists(boundary)).toBe(true);
    expect(await exists(recent)).toBe(true);
    expect(await exists(expired)).toBe(false);
  });
});
