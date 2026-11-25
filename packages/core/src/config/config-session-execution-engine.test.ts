/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config, type ConfigParameters } from './config.js';
import { Storage } from './storage.js';
import {
  SessionExecutionEngineError,
  type SessionExecutionEngineState,
} from '../services/session-execution-engine.js';
import {
  readSessionTranscriptSnapshot,
  type SessionRestoreProjection,
} from '../services/session-transcript-reader.js';

const SESSION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

let root: string;
let projectDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'qwen-config-engine-'));
  projectDir = path.join(root, 'project');
  await mkdir(projectDir, { recursive: true });
  Storage.setRuntimeBaseDir(path.join(root, 'runtime'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  Storage.setRuntimeBaseDir(null);
  await rm(root, { recursive: true, force: true });
});

function createConfig(params: Partial<ConfigParameters>): Config {
  return new Config({
    sessionId: SESSION_ID,
    cwd: projectDir,
    targetDir: projectDir,
    debugMode: false,
    model: 'test-model',
    chatRecording: true,
    usageStatisticsEnabled: false,
    overrideExtensions: [],
    ...params,
  });
}

// Stops initialization where hooks, MCP and tools would start, and reports
// what the transcript held at that point.
async function initializeUntilSideEffects(
  config: Config,
): Promise<{ reached: boolean; transcript?: string }> {
  const observed: { reached: boolean; transcript?: string } = {
    reached: false,
  };
  vi.spyOn(
    config as unknown as { initializeInternal(): Promise<void> },
    'initializeInternal',
  ).mockImplementation(async () => {
    observed.reached = true;
    observed.transcript = await readFile(
      config.getTranscriptPath(),
      'utf8',
    ).catch(() => undefined);
  });
  await config.initialize();
  return observed;
}

function restoreProjection(
  executionEngine: SessionExecutionEngineState | undefined,
): SessionRestoreProjection {
  return {
    sessionId: SESSION_ID,
    filePath: path.join(root, `${SESSION_ID}.jsonl`),
    startTime: new Date(0).toISOString(),
    lastUpdated: new Date(0).toISOString(),
    runtime: {
      apiHistory: [],
      uiTelemetryEvents: [],
      recording: { lastCompletedUuid: 'leaf', turnParentUuids: [] },
      goalRecords: [],
      initialTurn: 0,
      backgroundNotificationTaskIds: [],
    },
    ...(executionEngine ? { executionEngine } : {}),
  } as unknown as SessionRestoreProjection;
}

const snapshot = {
  filePath: 'transcript.jsonl',
  dev: 1,
  ino: 1,
  size: 1,
  lastUpdated: new Date(0).toISOString(),
};

describe('Config session execution engine', () => {
  it.each([
    ['without', {}],
    [
      'with',
      { experimentalZedIntegration: true, sessionWriterLeaseEnabled: true },
    ],
  ])(
    'records a new session owner %s a writer lease before side effects',
    async (_lease, params) => {
      const config = createConfig({
        ...params,
        sessionExecutionEngine: 'legacy',
      });
      try {
        const { transcript } = await initializeUntilSideEffects(config);

        expect(
          transcript
            ?.trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
        ).toEqual([
          expect.objectContaining({
            sessionId: SESSION_ID,
            parentUuid: null,
            type: 'system',
            subtype: 'session_execution_engine',
            systemPayload: { version: 1, engine: 'legacy' },
          }),
        ]);
        await expect(
          readSessionTranscriptSnapshot(
            config.getTranscriptPath(),
            SESSION_ID,
            false,
          ),
        ).resolves.toMatchObject({
          executionEngine: {
            status: 'verified',
            engine: 'legacy',
            recorded: true,
          },
        });
      } finally {
        await config.closeSessionWriter();
      }
    },
  );

  it('writes no owner when chat recording is off', async () => {
    const config = createConfig({
      chatRecording: false,
      sessionExecutionEngine: 'legacy',
    });

    await expect(initializeUntilSideEffects(config)).resolves.toEqual({
      reached: true,
      transcript: undefined,
    });
  });

  it('does not record an owner for a Config no paired host selected', async () => {
    const config = createConfig({});

    await expect(initializeUntilSideEffects(config)).resolves.toEqual({
      reached: true,
      transcript: undefined,
    });
  });

  it('restores a transcript whose own snapshot proves the selected owner', async () => {
    const projection = restoreProjection({
      sessionId: SESSION_ID,
      snapshot,
      status: 'verified',
      engine: 'legacy',
      recorded: false,
    });
    const config = createConfig({
      sessionExecutionEngine: 'legacy',
      sessionRestoreProjection: projection,
      sessionRestoreProjectionSource: async () => projection,
    });

    await expect(initializeUntilSideEffects(config)).resolves.toMatchObject({
      reached: true,
      transcript: undefined,
    });
  });

  it.each([
    [
      'another engine',
      {
        sessionId: SESSION_ID,
        snapshot,
        status: 'verified',
        engine: 'managed',
        recorded: true,
      } as const,
      'belongs to managed, cannot execute with legacy',
    ],
    [
      'unprovable history',
      {
        sessionId: SESSION_ID,
        snapshot,
        status: 'unavailable',
        reason: 'conflicting owners',
      } as const,
      'conflicting owners',
    ],
    ['no owner proof', undefined, 'ownership was not verified'],
  ])(
    'refuses a restore owned by %s before side effects',
    async (_name, executionEngine, reason) => {
      const projection = restoreProjection(executionEngine);
      const config = createConfig({
        sessionExecutionEngine: 'legacy',
        sessionRestoreProjection: projection,
        sessionRestoreProjectionSource: async () => projection,
      });
      const internal = vi.spyOn(
        config as unknown as { initializeInternal(): Promise<void> },
        'initializeInternal',
      );

      const initialized = config.initialize();
      await expect(initialized).rejects.toBeInstanceOf(
        SessionExecutionEngineError,
      );
      await expect(initialized).rejects.toThrow(reason);
      expect(internal).not.toHaveBeenCalled();
      await expect(readFile(config.getTranscriptPath())).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );
});
