/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getAutoMemoryConsolidationLockPath,
  getAutoMemoryFilePath,
  getAutoMemoryMetadataPath,
} from './paths.js';
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-memory-dream-scheduler-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot, new Date('2026-04-01T00:00:00.000Z'));
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
    const runtime = createManagedAutoMemoryDreamRuntimeForTests(makeSessionScanner(knownSessions));

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
    const runtime2 = createManagedAutoMemoryDreamRuntimeForTests(makeSessionScanner(knownSessions));

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
    const runtime = createManagedAutoMemoryDreamRuntimeForTests(makeSessionScanner(['session-0']));

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
    const runtime = createManagedAutoMemoryDreamRuntimeForTests(makeSessionScanner(['session-0']));
    // Write our own PID so isProcessRunning() considers the lock live.
    await fs.writeFile(getAutoMemoryConsolidationLockPath(projectRoot), String(process.pid), 'utf-8');

    const result = await runtime.schedule({
      projectRoot,
      sessionId: 'session-2',
      now: new Date(`2026-04-0${DEFAULT_AUTO_DREAM_MIN_HOURS > 0 ? '2' : '1'}T12:00:00.000Z`),
      minHoursBetweenDreams: 0,
      minSessionsBetweenDreams: 1,
    });

    expect(result).toEqual({
      status: 'skipped',
      skippedReason: 'locked',
    });
  });

  it('runs the existing mechanical dream logic inside scheduled tasks', async () => {
    const runtime = createManagedAutoMemoryDreamRuntimeForTests(makeSessionScanner(['session-0']));
    const firstPath = getAutoMemoryFilePath(projectRoot, path.join('user', 'terse.md'));
    const duplicatePath = getAutoMemoryFilePath(projectRoot, path.join('user', 'terse-duplicate.md'));
    await fs.mkdir(path.dirname(firstPath), { recursive: true });
    await fs.writeFile(
      firstPath,
      [
        '---',
        'type: user',
        'name: User Memory',
        'description: User profile',
        '---',
        '',
        'User prefers terse responses.',
      ].join('\n'),
      'utf-8',
    );
    await fs.writeFile(
      duplicatePath,
      [
        '---',
        'type: user',
        'name: User Memory Duplicate',
        'description: Duplicate terse preference',
        '---',
        '',
        'User prefers terse responses.',
      ].join('\n'),
      'utf-8',
    );

    const result = await runtime.schedule({
      projectRoot,
      sessionId: 'session-1',
      now: new Date('2026-04-01T10:00:00.000Z'),
      minHoursBetweenDreams: 0,
      minSessionsBetweenDreams: 1,
    });
    const finalTask = await result.promise;

    expect(finalTask?.status).toBe('completed');
    expect(finalTask?.metadata).toEqual(
      expect.objectContaining({
        dedupedEntries: 1,
        touchedTopics: ['user'],
      }),
    );
  });
});
