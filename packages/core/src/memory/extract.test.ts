/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAutoMemoryExtractCursorPath, getAutoMemoryTopicPath } from './paths.js';
import {
  applyExtractedMemoryPatches,
  buildTranscriptMessages,
  extractMemoryPatchesFromTranscript,
  loadUnprocessedTranscriptSlice,
  runAutoMemoryExtract,
  scheduleAutoMemoryExtract,
} from './extract.js';
import { ensureAutoMemoryScaffold } from './store.js';
import { markExtractRunning, resetAutoMemoryStateForTests } from './state.js';

describe('auto-memory extraction', () => {
  let tempDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-memory-extract-'));
    projectRoot = path.join(tempDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    await ensureAutoMemoryScaffold(projectRoot);
  });

  afterEach(async () => {
    resetAutoMemoryStateForTests();
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  it('builds transcript slices from history and cursor state', () => {
    const transcript = buildTranscriptMessages([
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'world' }] },
      { role: 'user', parts: [{ text: 'I prefer terse responses.' }] },
    ]);

    const slice = loadUnprocessedTranscriptSlice(
      'session-1',
      transcript,
      {
        sessionId: 'session-1',
        processedOffset: 2,
        updatedAt: new Date().toISOString(),
      },
    );

    expect(slice.messages).toHaveLength(1);
    expect(slice.messages[0]?.text).toBe('I prefer terse responses.');
    expect(slice.nextProcessedOffset).toBe(3);
  });

  it('extracts and applies durable memory patches', async () => {
    const transcript = buildTranscriptMessages([
      { role: 'user', parts: [{ text: 'I prefer terse responses.' }] },
      {
        role: 'user',
        parts: [{ text: 'The latency dashboard is https://grafana.internal/d/api-latency' }],
      },
    ]);

    const patches = extractMemoryPatchesFromTranscript(transcript);
    expect(patches.map((patch) => patch.topic)).toEqual(['user', 'reference']);

    const touched = await applyExtractedMemoryPatches(projectRoot, patches);
    expect(touched).toEqual(['user', 'reference']);

    const userTopic = await fs.readFile(getAutoMemoryTopicPath(projectRoot, 'user'), 'utf-8');
    const referenceTopic = await fs.readFile(getAutoMemoryTopicPath(projectRoot, 'reference'), 'utf-8');

    expect(userTopic).toContain('- I prefer terse responses.');
    expect(referenceTopic).toContain('grafana.internal/d/api-latency');
  });

  it('updates cursor and avoids duplicate writes for repeated extraction', async () => {
    const history = [
      { role: 'user', parts: [{ text: 'I prefer terse responses.' }] },
      { role: 'model', parts: [{ text: 'Understood.' }] },
    ];

    const first = await runAutoMemoryExtract({
      projectRoot,
      sessionId: 'session-1',
      history: [...history],
    });
    const second = await runAutoMemoryExtract({
      projectRoot,
      sessionId: 'session-1',
      history: [...history],
    });

    expect(first.touchedTopics).toEqual(['user']);
    expect(second.touchedTopics).toEqual([]);

    const cursor = JSON.parse(
      await fs.readFile(getAutoMemoryExtractCursorPath(projectRoot), 'utf-8'),
    ) as { processedOffset: number; sessionId: string };

    expect(cursor.sessionId).toBe('session-1');
    expect(cursor.processedOffset).toBe(2);
  });

  it('skips scheduled extraction while the project is already running', async () => {
    markExtractRunning(projectRoot);

    const result = await scheduleAutoMemoryExtract({
      projectRoot,
      sessionId: 'session-1',
      history: [{ role: 'user', parts: [{ text: 'I prefer terse responses.' }] }],
    });

    expect(result.skippedReason).toBe('already_running');
    expect(result.touchedTopics).toEqual([]);
  });
});