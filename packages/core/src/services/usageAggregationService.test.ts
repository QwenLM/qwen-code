/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  getGlobalUsageData,
  getDailyUsage,
  getMonthlyUsage,
  getModelUsage,
} from './usageAggregationService.js';

// Mock Storage to control project directories
vi.mock('../config/storage.js', () => ({
  Storage: {
    getRuntimeBaseDir: vi.fn(),
  },
}));

import { Storage } from '../config/storage.js';

const mockGetRuntimeBaseDir = vi.mocked(Storage.getRuntimeBaseDir);

describe('usageAggregationService', () => {
  let tmpDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    mockGetRuntimeBaseDir.mockReturnValue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createProjectDir(projectId: string): string {
    const dir = path.join(projectsDir, projectId);
    fs.mkdirSync(path.join(dir, 'chats'), { recursive: true });
    return dir;
  }

  function writeChatFile(
    projectDir: string,
    sessionId: string,
    records: Array<Record<string, unknown>>,
  ): void {
    const filePath = path.join(
      projectDir,
      'chats',
      `${sessionId}.jsonl`,
    );
    const content = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(filePath, content, 'utf8');
  }

  function makeAssistantRecord(
    timestamp: string,
    model: string,
    usage: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
      cachedContentTokenCount?: number;
      thoughtsTokenCount?: number;
    },
  ): Record<string, unknown> {
    return {
      uuid: `uuid-${Math.random().toString(36).slice(2)}`,
      parentUuid: null,
      sessionId: 'session-1',
      timestamp,
      type: 'assistant',
      cwd: '/test',
      version: '0.16.1',
      model,
      usageMetadata: usage,
    };
  }

  describe('getGlobalUsageData', () => {
    it('returns empty data when no projects exist', async () => {
      const data = await getGlobalUsageData();
      expect(data.projectCount).toBe(0);
      expect(Object.keys(data.daily)).toHaveLength(0);
      expect(Object.keys(data.monthly)).toHaveLength(0);
    });

    it('aggregates data from a single session', async () => {
      const projectDir = createProjectDir('project-a');
      writeChatFile(projectDir, 'session-1', [
        makeAssistantRecord('2026-05-24T10:00:00Z', 'qwen3-coder', {
          promptTokenCount: 1000,
          candidatesTokenCount: 200,
          totalTokenCount: 1200,
          cachedContentTokenCount: 100,
        }),
        makeAssistantRecord('2026-05-24T11:00:00Z', 'qwen-max', {
          promptTokenCount: 500,
          candidatesTokenCount: 100,
          totalTokenCount: 600,
        }),
      ]);

      const data = await getGlobalUsageData();
      expect(data.projectCount).toBe(1);

      const dayData = data.daily['2026-05-24'];
      expect(dayData).toBeDefined();
      expect(dayData.total.prompt).toBe(1500);
      expect(dayData.total.candidates).toBe(300);
      expect(dayData.total.total).toBe(1800);
      expect(dayData.total.cached).toBe(100);
      expect(dayData.requestCount).toBe(2);

      const monthData = data.monthly['2026-05'];
      expect(monthData).toBeDefined();
      expect(monthData.total.prompt).toBe(1500);
    });

    it('aggregates data across multiple projects', async () => {
      const projectA = createProjectDir('project-a');
      const projectB = createProjectDir('project-b');

      writeChatFile(projectA, 'session-1', [
        makeAssistantRecord('2026-05-24T10:00:00Z', 'qwen3-coder', {
          promptTokenCount: 1000,
          candidatesTokenCount: 200,
          totalTokenCount: 1200,
        }),
      ]);

      writeChatFile(projectB, 'session-2', [
        makeAssistantRecord('2026-05-24T14:00:00Z', 'qwen-max', {
          promptTokenCount: 500,
          candidatesTokenCount: 100,
          totalTokenCount: 600,
        }),
      ]);

      const data = await getGlobalUsageData();
      expect(data.projectCount).toBe(2);

      const dayData = data.daily['2026-05-24'];
      expect(dayData.total.prompt).toBe(1500);
      expect(dayData.total.candidates).toBe(300);
      expect(dayData.byModel['qwen3-coder']).toBeDefined();
      expect(dayData.byModel['qwen-max']).toBeDefined();
    });

    it('ignores non-assistant records', async () => {
      const projectDir = createProjectDir('project-a');
      writeChatFile(projectDir, 'session-1', [
        {
          type: 'user',
          timestamp: '2026-05-24T10:00:00Z',
          message: { role: 'user', parts: [{ text: 'hello' }] },
        },
        makeAssistantRecord('2026-05-24T10:01:00Z', 'qwen3-coder', {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          totalTokenCount: 150,
        }),
      ]);

      const data = await getGlobalUsageData();
      const dayData = data.daily['2026-05-24'];
      expect(dayData.requestCount).toBe(1);
      expect(dayData.total.prompt).toBe(100);
    });

    it('creates and reads cache file for incremental updates', async () => {
      const projectDir = createProjectDir('project-a');
      writeChatFile(projectDir, 'session-1', [
        makeAssistantRecord('2026-05-24T10:00:00Z', 'qwen3-coder', {
          promptTokenCount: 1000,
          candidatesTokenCount: 200,
          totalTokenCount: 1200,
        }),
      ]);

      // First call creates cache
      const data1 = await getGlobalUsageData();
      expect(data1.daily['2026-05-24'].total.prompt).toBe(1000);

      // Cache file should exist
      const cachePath = path.join(projectDir, 'usage-cache.json');
      expect(fs.existsSync(cachePath)).toBe(true);

      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      expect(cache.version).toBe(1);
      expect(cache.sessions['session-1']).toBeDefined();
    });
  });

  describe('getDailyUsage', () => {
    it('returns sorted daily data', async () => {
      const projectDir = createProjectDir('project-a');
      writeChatFile(projectDir, 'session-1', [
        makeAssistantRecord('2026-05-22T10:00:00Z', 'qwen3-coder', {
          promptTokenCount: 500,
          candidatesTokenCount: 100,
          totalTokenCount: 600,
        }),
        makeAssistantRecord('2026-05-24T10:00:00Z', 'qwen3-coder', {
          promptTokenCount: 1000,
          candidatesTokenCount: 200,
          totalTokenCount: 1200,
        }),
      ]);

      const data = await getDailyUsage(7);
      expect(data.length).toBeGreaterThanOrEqual(2);
      // Sorted newest first
      expect(data[0].date).toBe('2026-05-24');
      expect(data[1].date).toBe('2026-05-22');
    });

    it('limits to specified number of days', async () => {
      const projectDir = createProjectDir('project-a');
      const records = [];
      for (let i = 1; i <= 10; i++) {
        records.push(
          makeAssistantRecord(
            `2026-05-${String(i).padStart(2, '0')}T10:00:00Z`,
            'qwen3-coder',
            { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
          ),
        );
      }
      writeChatFile(projectDir, 'session-1', records);

      const data = await getDailyUsage(3);
      expect(data).toHaveLength(3);
    });
  });

  describe('getMonthlyUsage', () => {
    it('returns sorted monthly data', async () => {
      const projectDir = createProjectDir('project-a');
      writeChatFile(projectDir, 'session-1', [
        makeAssistantRecord('2026-03-15T10:00:00Z', 'qwen3-coder', {
          promptTokenCount: 500,
          candidatesTokenCount: 100,
          totalTokenCount: 600,
        }),
        makeAssistantRecord('2026-05-24T10:00:00Z', 'qwen3-coder', {
          promptTokenCount: 1000,
          candidatesTokenCount: 200,
          totalTokenCount: 1200,
        }),
      ]);

      const data = await getMonthlyUsage(6);
      expect(data.length).toBeGreaterThanOrEqual(2);
      expect(data[0].month).toBe('2026-05');
      expect(data[0].usage.total.prompt).toBe(1000);
    });
  });

  describe('getModelUsage', () => {
    it('returns per-model aggregated data', async () => {
      const projectDir = createProjectDir('project-a');
      writeChatFile(projectDir, 'session-1', [
        makeAssistantRecord('2026-05-24T10:00:00Z', 'qwen3-coder', {
          promptTokenCount: 1000,
          candidatesTokenCount: 200,
          totalTokenCount: 1200,
        }),
        makeAssistantRecord('2026-05-24T11:00:00Z', 'qwen-max', {
          promptTokenCount: 500,
          candidatesTokenCount: 100,
          totalTokenCount: 600,
        }),
        makeAssistantRecord('2026-05-24T12:00:00Z', 'qwen3-coder', {
          promptTokenCount: 800,
          candidatesTokenCount: 150,
          totalTokenCount: 950,
        }),
      ]);

      const data = await getModelUsage(3);
      expect(data['qwen3-coder']).toBeDefined();
      expect(data['qwen3-coder'].tokens.prompt).toBe(1800);
      expect(data['qwen3-coder'].tokens.candidates).toBe(350);
      expect(data['qwen3-coder'].requestCount).toBe(2);

      expect(data['qwen-max']).toBeDefined();
      expect(data['qwen-max'].tokens.prompt).toBe(500);
      expect(data['qwen-max'].requestCount).toBe(1);
    });
  });
});
