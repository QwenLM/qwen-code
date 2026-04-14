/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAutoMemoryConsolidationLockPath,
  getAutoMemoryMetadataPath,
} from './paths.js';

vi.mock('./dream.js', () => ({
  runManagedAutoMemoryDream: vi.fn(),
}));

import { runManagedAutoMemoryDream } from './dream.js';
import {
  createManagedAutoMemoryDreamRuntimeForTests,
  DEFAULT_AUTO_DREAM_MIN_HOURS,
  type SessionScannerFn,
} from './dreamScheduler.js';
import { ensureAutoMemoryScaffold } from './store.js';

/**
 * Creates a simple in-memory session scanner for tests.
 * Returns session IDs from `sessions` that are not in `excluded`.
 */
function makeSessionScanner(sessions: string[]): SessionScannerFn {
  return async (_projectRoot, _sinceMs, excludeSessionId) =>
    sessions.filter((id) => id !== excludeSessionId);
}

describe('managed auto-memory dream scheduler', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'auto-memory-dream-scheduler-'),
    );
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(
      projectRoot,
      new Date('2026-04-01T00:00:00.000Z'),
    );
    // Default: dream succeeds with no touched topics
    vi.mocked(runManagedAutoMemoryDream).mockReset();
    vi.mocked(runManagedAutoMemoryDream).mockResolvedValue({
      touchedTopics: [],
      dedupedEntries: 0,
      systemMessage: undefined,
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it('waits for enough distinct sessions before scheduling dream', async () => {
    // Start with one session in the scanner; first call should skip (need 2)
    const knownSessions = ['session-0'];
    const runtime = createManagedAutoMemoryDreamRuntimeForTests(
      makeSessionScanner(knownSessions),
    );

    const first = await runtime.schedule({
      projectRoot,
      sessionId: 'session-1',
      now: new Date('2026-04-01T10:00:00.000Z'),
      minHoursBetweenDreams: 0,
      minSessionsBetweenDreams: 2,
    });
    expect(first).toEqual({
      status: 'skipped',
      skippedReason: 'min_sessions',
    });

    // Add a second session so the count reaches the threshold
    knownSessions.push('session-00');
    const runtime2 = createManagedAutoMemoryDreamRuntimeForTests(
      makeSessionScanner(knownSessions),
    );

    const second = await runtime2.schedule({
      projectRoot,
      sessionId: 'session-2',
      now: new Date('2026-04-01T11:00:00.000Z'),
      minHoursBetweenDreams: 0,
      minSessionsBetweenDreams: 2,
    });

    expect(second.status).toBe('scheduled');
    await second.promise;

    const metadata = JSON.parse(
      await fs.readFile(getAutoMemoryMetadataPath(projectRoot), 'utf-8'),
    ) as { lastDreamAt?: string; lastDreamSessionId?: string };

    expect(metadata.lastDreamSessionId).toBe('session-2');
    expect(metadata.lastDreamAt).toBe('2026-04-01T11:00:00.000Z');
    await expect(
      fs.access(getAutoMemoryConsolidationLockPath(projectRoot)),
    ).rejects.toThrow();
  });

  it('skips dream in the same session after a successful run', async () => {
    const runtime = createManagedAutoMemoryDreamRuntimeForTests(
      makeSessionScanner(['session-0']),
    );

    const scheduled = await runtime.schedule({
      projectRoot,
      sessionId: 'session-1',
      now: new Date('2026-04-01T10:00:00.000Z'),
      minHoursBetweenDreams: 0,
      minSessionsBetweenDreams: 1,
    });
    await scheduled.promise;

    const skipped = await runtime.schedule({
      projectRoot,
      sessionId: 'session-1',
      now: new Date('2026-04-01T12:00:00.000Z'),
      minHoursBetweenDreams: 0,
      minSessionsBetweenDreams: 1,
    });

    expect(skipped).toEqual({
      status: 'skipped',
      skippedReason: 'same_session',
    });
  });

  it('skips dream when consolidation lock already exists', async () => {
    const runtime = createManagedAutoMemoryDreamRuntimeForTests(
      makeSessionScanner(['session-0']),
    );
    // Write our own PID so isProcessRunning() considers the lock live.
    await fs.writeFile(
      getAutoMemoryConsolidationLockPath(projectRoot),
      String(process.pid),
      'utf-8',
    );

    const result = await runtime.schedule({
      projectRoot,
      sessionId: 'session-2',
      now: new Date(
        `2026-04-0${DEFAULT_AUTO_DREAM_MIN_HOURS > 0 ? '2' : '1'}T12:00:00.000Z`,
      ),
      minHoursBetweenDreams: 0,
      minSessionsBetweenDreams: 1,
    });

    expect(result).toEqual({
      status: 'skipped',
      skippedReason: 'locked',
    });
  });

  it('propagates dream result to task metadata and releases lock on completion', async () => {
    vi.mocked(runManagedAutoMemoryDream).mockResolvedValue({
      touchedTopics: ['user'],
      dedupedEntries: 2,
      systemMessage: 'Dream agent consolidated 2 entries.',
    });

    const runtime = createManagedAutoMemoryDreamRuntimeForTests(
      makeSessionScanner(['session-0']),
    );
    const result = await runtime.schedule({
      projectRoot,
      sessionId: 'session-1',
      now: new Date('2026-04-01T10:00:00.000Z'),
      minHoursBetweenDreams: 0,
      minSessionsBetweenDreams: 1,
    });

    expect(result.status).toBe('scheduled');
    const finalTask = await result.promise;

    // Task should complete successfully
    expect(finalTask?.status).toBe('completed');
    // Scheduler propagates dream result to task metadata
    expect(finalTask?.metadata).toEqual(
      expect.objectContaining({
        touchedTopics: ['user'],
        dedupedEntries: 2,
      }),
    );
    // Lock must be released after completion
    await expect(
      fs.access(getAutoMemoryConsolidationLockPath(projectRoot)),
    ).rejects.toThrow();
    // Metadata must record the session and timestamp
    const metadata = JSON.parse(
      await fs.readFile(getAutoMemoryMetadataPath(projectRoot), 'utf-8'),
    ) as { lastDreamSessionId?: string; lastDreamAt?: string };
    expect(metadata.lastDreamSessionId).toBe('session-1');
    expect(metadata.lastDreamAt).toBe('2026-04-01T10:00:00.000Z');
  });
});
