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
  }> = {},
): SessionMetrics => ({
  models: {
    'test-model': {
      api: {
        totalRequests: overrides.totalRequests ?? 0,
        totalErrors: 0,
        totalLatencyMs: overrides.totalLatencyMs ?? 0,
      },
      tokens: {
        prompt: overrides.promptTokens ?? 0,
        candidates: overrides.candidatesTokens ?? 0,
        total: overrides.totalTokens ?? 0,
        cached: 0,
        thoughts: 0,
        tool: 0,
      },
    },
  },
  tools: {
    totalCalls: overrides.totalCalls ?? 0,
    totalSuccess: overrides.totalSuccess ?? 0,
    totalFail: overrides.totalFail ?? 0,
    totalDurationMs: 0,
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

  describe('create() factory', () => {
    it('should return null when ARENA_AGENT_ID is not set', () => {
      const original = process.env['ARENA_AGENT_ID'];
      const originalSession = process.env['ARENA_SESSION_ID'];
      const originalDir = process.env['ARENA_SESSION_DIR'];
      delete process.env['ARENA_AGENT_ID'];
      delete process.env['ARENA_SESSION_ID'];
      delete process.env['ARENA_SESSION_DIR'];

      const reporter = ArenaAgentClient.create();
      expect(reporter).toBeNull();

      // Restore
      if (original !== undefined) {
        process.env['ARENA_AGENT_ID'] = original;
      }
      if (originalSession !== undefined) {
        process.env['ARENA_SESSION_ID'] = originalSession;
      }
      if (originalDir !== undefined) {
        process.env['ARENA_SESSION_DIR'] = originalDir;
      }
    });

    it('should return null when ARENA_SESSION_ID is not set', () => {
      const originalAgent = process.env['ARENA_AGENT_ID'];
      const originalSession = process.env['ARENA_SESSION_ID'];
      const originalDir = process.env['ARENA_SESSION_DIR'];

      process.env['ARENA_AGENT_ID'] = 'test-agent';
      delete process.env['ARENA_SESSION_ID'];
      process.env['ARENA_SESSION_DIR'] = tempDir;

      const reporter = ArenaAgentClient.create();
      expect(reporter).toBeNull();

      // Restore
      if (originalAgent !== undefined) {
        process.env['ARENA_AGENT_ID'] = originalAgent;
      } else {
        delete process.env['ARENA_AGENT_ID'];
      }
      if (originalSession !== undefined) {
        process.env['ARENA_SESSION_ID'] = originalSession;
      }
      if (originalDir !== undefined) {
        process.env['ARENA_SESSION_DIR'] = originalDir;
      } else {
        delete process.env['ARENA_SESSION_DIR'];
      }
    });

    it('should return null when ARENA_SESSION_DIR is not set', () => {
      const originalAgent = process.env['ARENA_AGENT_ID'];
      const originalSession = process.env['ARENA_SESSION_ID'];
      const originalDir = process.env['ARENA_SESSION_DIR'];

      process.env['ARENA_AGENT_ID'] = 'test-agent';
      process.env['ARENA_SESSION_ID'] = 'test-session';
      delete process.env['ARENA_SESSION_DIR'];

      const reporter = ArenaAgentClient.create();
      expect(reporter).toBeNull();

      // Restore
      if (originalAgent !== undefined) {
        process.env['ARENA_AGENT_ID'] = originalAgent;
      } else {
        delete process.env['ARENA_AGENT_ID'];
      }
      if (originalSession !== undefined) {
        process.env['ARENA_SESSION_ID'] = originalSession;
      } else {
        delete process.env['ARENA_SESSION_ID'];
      }
      if (originalDir !== undefined) {
        process.env['ARENA_SESSION_DIR'] = originalDir;
      } else {
        delete process.env['ARENA_SESSION_DIR'];
      }
    });

    it('should return an instance when all env vars are set', () => {
      const originalAgent = process.env['ARENA_AGENT_ID'];
      const originalSession = process.env['ARENA_SESSION_ID'];
      const originalDir = process.env['ARENA_SESSION_DIR'];

      process.env['ARENA_AGENT_ID'] = 'test-agent';
      process.env['ARENA_SESSION_ID'] = 'test-session';
      process.env['ARENA_SESSION_DIR'] = tempDir;

      const reporter = ArenaAgentClient.create();
      expect(reporter).toBeInstanceOf(ArenaAgentClient);

      // Restore
      if (originalAgent !== undefined) {
        process.env['ARENA_AGENT_ID'] = originalAgent;
      } else {
        delete process.env['ARENA_AGENT_ID'];
      }
      if (originalSession !== undefined) {
        process.env['ARENA_SESSION_ID'] = originalSession;
      } else {
        delete process.env['ARENA_SESSION_ID'];
      }
      if (originalDir !== undefined) {
        process.env['ARENA_SESSION_DIR'] = originalDir;
      } else {
        delete process.env['ARENA_SESSION_DIR'];
      }
    });
  });

  describe('init()', () => {
    it('should create the agents/ and control/ directories', async () => {
      const reporter = new ArenaAgentClient('agent-1', tempDir);
      await reporter.init();

      const agentsDir = path.join(tempDir, 'agents');
      const controlDir = path.join(tempDir, 'control');
      const agentsStat = await fs.stat(agentsDir);
      const controlStat = await fs.stat(controlDir);
      expect(agentsStat.isDirectory()).toBe(true);
      expect(controlStat.isDirectory()).toBe(true);
    });

    it('should be idempotent', async () => {
      const reporter = new ArenaAgentClient('agent-1', tempDir);
      await reporter.init();
      await reporter.init(); // Should not throw

      const agentsDir = path.join(tempDir, 'agents');
      const stat = await fs.stat(agentsDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('updateStatus()', () => {
    it('should write per-agent status file with stats from telemetry', async () => {
      const agentId = 'model-a';
      const reporter = new ArenaAgentClient(agentId, tempDir);
      await reporter.init();

      vi.mocked(uiTelemetryService.getMetrics).mockReturnValue(
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

      const statusPath = path.join(
        tempDir,
        'agents',
        `${safeAgentId(agentId)}.json`,
      );
      const content = JSON.parse(await fs.readFile(statusPath, 'utf-8'));

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
      const agentId = 'model-a';
      const reporter = new ArenaAgentClient(agentId, tempDir);
      await reporter.init();

      // Write status multiple times rapidly
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(reporter.updateStatus());
      }
      await Promise.all(promises);

      // The file should be valid JSON (no corruption from concurrent writes)
      const statusPath = path.join(
        tempDir,
        'agents',
        `${safeAgentId(agentId)}.json`,
      );
      const content = JSON.parse(await fs.readFile(statusPath, 'utf-8'));
      expect(content.agentId).toBe(agentId);
      expect(content.status).toBe('running');
    });

    it('should reflect latest telemetry on each call', async () => {
      const agentId = 'model-a';
      const reporter = new ArenaAgentClient(agentId, tempDir);
      await reporter.init();

      // First update
      vi.mocked(uiTelemetryService.getMetrics).mockReturnValue(
        createMockMetrics({
          totalRequests: 1,
          totalTokens: 100,
          totalCalls: 5,
        }),
      );
      await reporter.updateStatus();

      // Second update with updated telemetry
      vi.mocked(uiTelemetryService.getMetrics).mockReturnValue(
        createMockMetrics({
          totalRequests: 2,
          totalTokens: 200,
          totalCalls: 8,
        }),
      );
      await reporter.updateStatus();

      const statusPath = path.join(
        tempDir,
        'agents',
        `${safeAgentId(agentId)}.json`,
      );
      const content = JSON.parse(await fs.readFile(statusPath, 'utf-8'));

      expect(content.rounds).toBe(2);
      expect(content.stats.totalTokens).toBe(200);
      expect(content.stats.toolCalls).toBe(8);
    });

    it('should auto-initialize if not yet initialized', async () => {
      const agentId = 'model-a';
      const reporter = new ArenaAgentClient(agentId, tempDir);
      // Skip init() call

      await reporter.updateStatus();

      const statusPath = path.join(
        tempDir,
        'agents',
        `${safeAgentId(agentId)}.json`,
      );
      const content = JSON.parse(await fs.readFile(statusPath, 'utf-8'));
      expect(content.agentId).toBe(agentId);
    });
  });

  describe('checkControlSignal()', () => {
    it('should return null when no control file exists', async () => {
      const agentId = 'model-a';
      const reporter = new ArenaAgentClient(agentId, tempDir);
      await reporter.init();

      const signal = await reporter.checkControlSignal();
      expect(signal).toBeNull();
    });

    it('should read and delete control file', async () => {
      const agentId = 'model-a';
      const reporter = new ArenaAgentClient(agentId, tempDir);
      await reporter.init();

      // Write a control signal
      const controlSignal: ArenaControlSignal = {
        type: 'shutdown',
        reason: 'User cancelled',
        timestamp: Date.now(),
      };
      const controlPath = path.join(
        tempDir,
        'control',
        `${safeAgentId(agentId)}.json`,
      );
      await fs.writeFile(controlPath, JSON.stringify(controlSignal), 'utf-8');

      // Read it
      const signal = await reporter.checkControlSignal();
      expect(signal).not.toBeNull();
      expect(signal!.type).toBe('shutdown');
      expect(signal!.reason).toBe('User cancelled');

      // File should be deleted (consumed)
      await expect(fs.access(controlPath)).rejects.toThrow();
    });

    it('should return null on subsequent reads (consume-once)', async () => {
      const agentId = 'model-a';
      const reporter = new ArenaAgentClient(agentId, tempDir);
      await reporter.init();

      // Write a control signal
      const controlSignal: ArenaControlSignal = {
        type: 'cancel',
        reason: 'Timeout',
        timestamp: Date.now(),
      };
      const controlPath = path.join(
        tempDir,
        'control',
        `${safeAgentId(agentId)}.json`,
      );
      await fs.writeFile(controlPath, JSON.stringify(controlSignal), 'utf-8');

      // First read should return the signal
      const first = await reporter.checkControlSignal();
      expect(first).not.toBeNull();

      // Second read should return null
      const second = await reporter.checkControlSignal();
      expect(second).toBeNull();
    });
  });

  describe('reportCompleted()', () => {
    it('should write status with completed state and optional summary', async () => {
      const agentId = 'model-a';
      const reporter = new ArenaAgentClient(agentId, tempDir);
      await reporter.init();

      await reporter.reportCompleted('Successfully implemented feature X');

      const statusPath = path.join(
        tempDir,
        'agents',
        `${safeAgentId(agentId)}.json`,
      );
      const content = JSON.parse(await fs.readFile(statusPath, 'utf-8'));

      expect(content.status).toBe('completed');
      expect(content.finalSummary).toBe('Successfully implemented feature X');
      expect(content.error).toBeNull();
    });

    it('should write status with idle state and no summary', async () => {
      const agentId = 'model-a';
      const reporter = new ArenaAgentClient(agentId, tempDir);
      await reporter.init();

      await reporter.reportCompleted();

      const statusPath = path.join(
        tempDir,
        'agents',
        `${safeAgentId(agentId)}.json`,
      );
      const content = JSON.parse(await fs.readFile(statusPath, 'utf-8'));

      expect(content.status).toBe('completed');
      expect(content.finalSummary).toBeNull();
      expect(content.error).toBeNull();
    });
  });

  describe('buildStatsFromMetrics()', () => {
    it('should aggregate stats across multiple models', () => {
      const metrics: SessionMetrics = {
        models: {
          'model-a': {
            api: {
              totalRequests: 3,
              totalErrors: 0,
              totalLatencyMs: 1000,
            },
            tokens: {
              prompt: 100,
              candidates: 50,
              total: 150,
              cached: 0,
              thoughts: 0,
              tool: 0,
            },
          },
          'model-b': {
            api: {
              totalRequests: 2,
              totalErrors: 1,
              totalLatencyMs: 500,
            },
            tokens: {
              prompt: 200,
              candidates: 100,
              total: 300,
              cached: 0,
              thoughts: 0,
              tool: 0,
            },
          },
        },
        tools: {
          totalCalls: 10,
          totalSuccess: 8,
          totalFail: 2,
          totalDurationMs: 2000,
          totalDecisions: {
            [ToolCallDecision.ACCEPT]: 0,
            [ToolCallDecision.REJECT]: 0,
            [ToolCallDecision.MODIFY]: 0,
            [ToolCallDecision.AUTO_ACCEPT]: 0,
          },
          byName: {},
        },
        files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
      };

      const stats = ArenaAgentClient.buildStatsFromMetrics(metrics);

      expect(stats.rounds).toBe(5);
      expect(stats.totalTokens).toBe(450);
      expect(stats.inputTokens).toBe(300);
      expect(stats.outputTokens).toBe(150);
      expect(stats.durationMs).toBe(1500);
      expect(stats.toolCalls).toBe(10);
      expect(stats.successfulToolCalls).toBe(8);
      expect(stats.failedToolCalls).toBe(2);
    });

    it('should return zeros when no models exist', () => {
      const metrics = createMockMetrics();
      // Override with empty models
      metrics.models = {};

      const stats = ArenaAgentClient.buildStatsFromMetrics(metrics);

      expect(stats.rounds).toBe(0);
      expect(stats.totalTokens).toBe(0);
      expect(stats.inputTokens).toBe(0);
      expect(stats.outputTokens).toBe(0);
      expect(stats.durationMs).toBe(0);
    });
  });

  describe('safeAgentId()', () => {
    it('should pass through typical model IDs unchanged', () => {
      expect(safeAgentId('qwen-coder-plus')).toBe('qwen-coder-plus');
    });

    it('should handle IDs without unsafe characters', () => {
      expect(safeAgentId('simple-id')).toBe('simple-id');
    });

    it('should replace slashes with double dashes', () => {
      expect(safeAgentId('org/model-name')).toBe('org--model-name');
    });

    it('should handle multiple unsafe characters', () => {
      expect(safeAgentId('a/b\\c:d')).toBe('a--b--c--d');
    });
  });
});
