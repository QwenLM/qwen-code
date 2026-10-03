/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ArenaAgentClient } from './ArenaAgentClient.js';
import { safeAgentId } from './types.js';
import type { ArenaControlSignal } from './types.js';
import { uiTelemetryService } from '../../telemetry/uiTelemetry.js';
import type { SessionMetrics } from '../../telemetry/uiTelemetry.js';
import { ToolCallDecision } from '../../telemetry/tool-call-decision.js';

type ModelMetrics = SessionMetrics['models'][string];
const modelEntry = (
  totalRequests: number,
  totalLatencyMs: number,
  prompt: number,
  candidates: number,
  total: number,
  totalErrors = 0,
): ModelMetrics => ({
  api: { totalRequests, totalErrors, totalLatencyMs },
  tokens: { prompt, candidates, total, cached: 0, thoughts: 0 },
  bySource: {},
});

const createMockMetrics = (
  overrides: Partial<{
    totalRequests: number;
    totalTokens: number;
    promptTokens: number;
    candidatesTokens: number;
    totalLatencyMs: number;
    totalCalls: number;
    totalSuccess: number;
    totalFail: number;
    totalDurationMs: number;
  }> = {},
): SessionMetrics => ({
  models: {
    'test-model': modelEntry(
      overrides.totalRequests ?? 0,
      overrides.totalLatencyMs ?? 0,
      overrides.promptTokens ?? 0,
      overrides.candidatesTokens ?? 0,
      overrides.totalTokens ?? 0,
    ),
  },
  tools: {
    totalCalls: overrides.totalCalls ?? 0,
    totalSuccess: overrides.totalSuccess ?? 0,
    totalFail: overrides.totalFail ?? 0,
    totalDurationMs: overrides.totalDurationMs ?? 0,
    totalDecisions: {
      [ToolCallDecision.ACCEPT]: 0,
      [ToolCallDecision.REJECT]: 0,
      [ToolCallDecision.MODIFY]: 0,
      [ToolCallDecision.AUTO_ACCEPT]: 0,
    },
    byName: {},
  },
  files: {
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
  },
});

const ENV_KEYS = [
  'ARENA_AGENT_ID',
  'ARENA_SESSION_ID',
  'ARENA_SESSION_DIR',
] as const;
type ArenaEnv = Partial<Record<(typeof ENV_KEYS)[number], string>>;

/** Calls create() with exactly `env` set (others deleted), then restores. */
function createWithEnv(env: ArenaEnv): ArenaAgentClient | null {
  const saved = ENV_KEYS.map((k) => process.env[k]);
  const apply = (values: Array<string | undefined>) =>
    ENV_KEYS.forEach((k, i) => {
      if (values[i] === undefined) delete process.env[k];
      else process.env[k] = values[i];
    });
  apply(ENV_KEYS.map((k) => env[k]));
  try {
    return ArenaAgentClient.create();
  } finally {
    apply(saved);
  }
}

const setMetrics = (metrics: SessionMetrics) =>
  vi.mocked(uiTelemetryService.getMetrics).mockReturnValue(metrics);

describe('ArenaAgentClient', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-reporter-test-'));
    vi.spyOn(uiTelemetryService, 'getMetrics').mockReturnValue(
      createMockMetrics(),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  const newReporter = async (agentId = 'model-a') => {
    const reporter = new ArenaAgentClient(agentId, tempDir);
    await reporter.init();
    return reporter;
  };
  const filePath = (dir: 'agents' | 'control', agentId = 'model-a') =>
    path.join(tempDir, dir, `${safeAgentId(agentId)}.json`);
  const readStatus = async (agentId = 'model-a') =>
    JSON.parse(await fs.readFile(filePath('agents', agentId), 'utf-8'));
  const writeControl = (signal: ArenaControlSignal) =>
    fs.writeFile(filePath('control'), JSON.stringify(signal), 'utf-8');

  describe('create() factory', () => {
    it('should return null when ARENA_AGENT_ID is not set', () => {
      expect(createWithEnv({})).toBeNull();
    });

    it('should return null when ARENA_SESSION_ID is not set', () => {
      expect(
        createWithEnv({
          ARENA_AGENT_ID: 'test-agent',
          ARENA_SESSION_DIR: tempDir,
        }),
      ).toBeNull();
    });

    it('should return null when ARENA_SESSION_DIR is not set', () => {
      expect(
        createWithEnv({
          ARENA_AGENT_ID: 'test-agent',
          ARENA_SESSION_ID: 'test-session',
        }),
      ).toBeNull();
    });

    it('should return an instance when all env vars are set', () => {
      const reporter = createWithEnv({
        ARENA_AGENT_ID: 'test-agent',
        ARENA_SESSION_ID: 'test-session',
        ARENA_SESSION_DIR: tempDir,
      });
      expect(reporter).toBeInstanceOf(ArenaAgentClient);
    });
  });

  describe('init()', () => {
    it('should create the agents/ and control/ directories', async () => {
      await newReporter('agent-1');

      const agentsStat = await fs.stat(path.join(tempDir, 'agents'));
      const controlStat = await fs.stat(path.join(tempDir, 'control'));
      expect(agentsStat.isDirectory()).toBe(true);
      expect(controlStat.isDirectory()).toBe(true);
    });

    it('should be idempotent', async () => {
      const reporter = await newReporter('agent-1');
      await reporter.init(); // Should not throw

      const stat = await fs.stat(path.join(tempDir, 'agents'));
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('updateStatus()', () => {
    it('should write per-agent status file with stats from telemetry', async () => {
      const agentId = 'model-a';
      const reporter = await newReporter(agentId);
      setMetrics(
        createMockMetrics({
          totalRequests: 3,
          totalTokens: 1500,
          promptTokens: 1000,
          candidatesTokens: 500,
          totalCalls: 7,
          totalSuccess: 6,
          totalFail: 1,
        }),
      );

      await reporter.updateStatus('Editing files');
      const content = await readStatus(agentId);

      expect(content.agentId).toBe(agentId);
      expect(content.status).toBe('running');
      expect(content.rounds).toBe(3);
      expect(content.currentActivity).toBe('Editing files');
      expect(content.stats.totalTokens).toBe(1500);
      expect(content.stats.inputTokens).toBe(1000);
      expect(content.stats.outputTokens).toBe(500);
      expect(content.stats.toolCalls).toBe(7);
      expect(content.stats.successfulToolCalls).toBe(6);
      expect(content.stats.failedToolCalls).toBe(1);
      expect(content.finalSummary).toBeNull();
      expect(content.error).toBeNull();
      expect(content.updatedAt).toBeTypeOf('number');
    });

    it('should perform atomic write (no partial reads)', async () => {
      const reporter = await newReporter();

      // Write status multiple times rapidly; the file must stay valid JSON.
      await Promise.all(
        Array.from({ length: 10 }, () => reporter.updateStatus()),
      );

      const content = await readStatus();
      expect(content.agentId).toBe('model-a');
      expect(content.status).toBe('running');
    });

    it('should reflect latest telemetry on each call', async () => {
      const reporter = await newReporter();

      setMetrics(
        createMockMetrics({
          totalRequests: 1,
          totalTokens: 100,
          totalCalls: 5,
        }),
      );
      await reporter.updateStatus();
      setMetrics(
        createMockMetrics({
          totalRequests: 2,
          totalTokens: 200,
          totalCalls: 8,
        }),
      );
      await reporter.updateStatus();

      const content = await readStatus();
      expect(content.rounds).toBe(2);
      expect(content.stats.totalTokens).toBe(200);
      expect(content.stats.toolCalls).toBe(8);
    });

    it('should auto-initialize if not yet initialized', async () => {
      // Skip init() call
      await new ArenaAgentClient('model-a', tempDir).updateStatus();

      const content = await readStatus();
      expect(content.agentId).toBe('model-a');
    });
  });

  describe('checkControlSignal()', () => {
    it('should return null when no control file exists', async () => {
      const reporter = await newReporter();

      const signal = await reporter.checkControlSignal();
      expect(signal).toBeNull();
    });

    it('should read and delete control file', async () => {
      const reporter = await newReporter();
      await writeControl({
        type: 'shutdown',
        reason: 'User cancelled',
        timestamp: Date.now(),
      });

      const signal = await reporter.checkControlSignal();
      expect(signal).not.toBeNull();
      expect(signal!.type).toBe('shutdown');
      expect(signal!.reason).toBe('User cancelled');

      // File should be deleted (consumed)
      await expect(fs.access(filePath('control'))).rejects.toThrow();
    });

    it('should return null on subsequent reads (consume-once)', async () => {
      const reporter = await newReporter();
      await writeControl({
        type: 'cancel',
        reason: 'Timeout',
        timestamp: Date.now(),
      });

      const first = await reporter.checkControlSignal();
      expect(first).not.toBeNull();

      const second = await reporter.checkControlSignal();
      expect(second).toBeNull();
    });
  });

  describe('reportCompleted()', () => {
    it('should write status with completed state and optional summary', async () => {
      const reporter = await newReporter();
      await reporter.reportCompleted('Successfully implemented feature X');

      const content = await readStatus();
      expect(content.status).toBe('completed');
      expect(content.finalSummary).toBe('Successfully implemented feature X');
      expect(content.error).toBeNull();
    });

    it('should write status with idle state and no summary', async () => {
      const reporter = await newReporter();
      await reporter.reportCompleted();

      const content = await readStatus();
      expect(content.status).toBe('completed');
      expect(content.finalSummary).toBeNull();
      expect(content.error).toBeNull();
    });
  });

  describe('stats aggregation and wall-clock durationMs', () => {
    it('should aggregate multi-model stats and use wall-clock durationMs', async () => {
      setMetrics({
        ...createMockMetrics({
          totalCalls: 10,
          totalSuccess: 8,
          totalFail: 2,
          totalDurationMs: 2000,
        }),
        models: {
          'model-a': modelEntry(3, 1000, 100, 50, 150),
          'model-b': modelEntry(2, 500, 200, 100, 300, 1),
        },
      });

      const reporter = await newReporter();
      await reporter.updateStatus();
      const content = await readStatus();

      expect(content.stats.rounds).toBe(5);
      expect(content.stats.totalTokens).toBe(450);
      expect(content.stats.inputTokens).toBe(300);
      expect(content.stats.outputTokens).toBe(150);
      expect(content.stats.toolCalls).toBe(10);
      expect(content.stats.successfulToolCalls).toBe(8);
      expect(content.stats.failedToolCalls).toBe(2);
      // durationMs should be wall-clock time, not API latency sum (1500)
      expect(content.stats.durationMs).toBeGreaterThanOrEqual(0);
      expect(content.stats.durationMs).toBeLessThan(5000);
    });

    it('should return zeros when no models exist', async () => {
      setMetrics({ ...createMockMetrics(), models: {} });

      const reporter = await newReporter();
      await reporter.updateStatus();
      const content = await readStatus();

      expect(content.stats.rounds).toBe(0);
      expect(content.stats.totalTokens).toBe(0);
      expect(content.stats.inputTokens).toBe(0);
      expect(content.stats.outputTokens).toBe(0);
      // durationMs is wall-clock, so still non-negative even with no models
      expect(content.stats.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('safeAgentId()', () => {
    it.each([
      [
        'should pass through typical model IDs unchanged',
        'qwen-coder-plus',
        'qwen-coder-plus',
      ],
      ['should handle IDs without unsafe characters', 'simple-id', 'simple-id'],
      [
        'should replace slashes with double dashes',
        'org/model-name',
        'org--model-name',
      ],
      ['should handle multiple unsafe characters', 'a/b\\c:d', 'a--b--c--d'],
    ])('%s', (_title, input, expected) => {
      expect(safeAgentId(input)).toBe(expected);
    });
  });
});
