/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DataProcessor } from './DataProcessor.js';
import type { Config, ChatRecord } from '@qwen-code/qwen-code-core';
import type {
  InsightData,
  SessionFacets,
} from '../types/StaticInsightTypes.js';

// Mock dependencies
vi.mock('@qwen-code/qwen-code-core', async () => {
  const actual = await vi.importActual<
    typeof import('@qwen-code/qwen-code-core')
  >('@qwen-code/qwen-code-core');
  return {
    ...actual,
    read: vi.fn(),
    createDebugLogger: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    })),
  };
});

vi.mock('fs/promises', () => ({
  default: {
    readdir: vi.fn(),
    stat: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
}));

import fs from 'fs/promises';
import { read as readJsonlFile } from '@qwen-code/qwen-code-core';

const mockedFs = vi.mocked(fs);
const mockedReadJsonlFile = vi.mocked(readJsonlFile);

describe('DataProcessor', () => {
  let mockConfig: Config;
  let dataProcessor: DataProcessor;
  let mockGenerateJson: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockGenerateJson = vi.fn();
    mockConfig = {
      getBaseLlmClient: vi.fn(() => ({
        generateJson: mockGenerateJson,
      })),
      getModel: vi.fn(() => 'test-model'),
    } as unknown as Config;

    dataProcessor = new DataProcessor(mockConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('formatDate', () => {
    it('should format date as YYYY-MM-DD', () => {
      const date = new Date('2025-01-15T10:30:00Z');
      // Access private method through any cast for testing
      const result = (
        dataProcessor as unknown as { formatDate(date: Date): string }
      ).formatDate(date);
      expect(result).toBe('2025-01-15');
    });

    it('should handle different timezones correctly', () => {
      const date = new Date('2025-12-31T23:59:59Z');
      const result = (
        dataProcessor as unknown as { formatDate(date: Date): string }
      ).formatDate(date);
      // Result depends on local timezone, but should be a valid date string
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('formatRecordsForAnalysis', () => {
    it('should format empty records array', () => {
      const records: ChatRecord[] = [];
      const result = (
        dataProcessor as unknown as {
          formatRecordsForAnalysis(records: ChatRecord[]): string;
        }
      ).formatRecordsForAnalysis(records);
      expect(result).toContain('Session: unknown');
      expect(result).toContain('Duration: 0 turns');
    });

    it('should format user messages correctly', () => {
      const records: ChatRecord[] = [
        {
          sessionId: 'test-session',
          timestamp: new Date().toISOString(),
          type: 'user',
          message: {
            role: 'user',
            parts: [{ text: 'Hello, world!' }],
          },
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
      ];
      const result = (
        dataProcessor as unknown as {
          formatRecordsForAnalysis(records: ChatRecord[]): string;
        }
      ).formatRecordsForAnalysis(records);
      expect(result).toContain('Session: test-session');
      expect(result).toContain('[User]: Hello, world!');
    });

    it('should format assistant text messages correctly', () => {
      const records: ChatRecord[] = [
        {
          sessionId: 'test-session',
          timestamp: new Date().toISOString(),
          type: 'assistant',
          message: {
            role: 'assistant',
            parts: [{ text: 'I can help you with that.' }],
          },
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
      ];
      const result = (
        dataProcessor as unknown as {
          formatRecordsForAnalysis(records: ChatRecord[]): string;
        }
      ).formatRecordsForAnalysis(records);
      expect(result).toContain('[Assistant]: I can help you with that.');
    });

    it('should format function calls correctly', () => {
      const records: ChatRecord[] = [
        {
          sessionId: 'test-session',
          timestamp: new Date().toISOString(),
          type: 'assistant',
          message: {
            role: 'assistant',
            parts: [{ functionCall: { name: 'read_file', args: {} } }],
          },
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
      ];
      const result = (
        dataProcessor as unknown as {
          formatRecordsForAnalysis(records: ChatRecord[]): string;
        }
      ).formatRecordsForAnalysis(records);
      expect(result).toContain('[Tool: read_file]');
    });

    it('should handle multiple message parts', () => {
      const records: ChatRecord[] = [
        {
          sessionId: 'test-session',
          timestamp: new Date().toISOString(),
          type: 'assistant',
          message: {
            role: 'assistant',
            parts: [
              { text: 'Let me check that.' },
              { functionCall: { name: 'search', args: {} } },
            ],
          },
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
      ];
      const result = (
        dataProcessor as unknown as {
          formatRecordsForAnalysis(records: ChatRecord[]): string;
        }
      ).formatRecordsForAnalysis(records);
      expect(result).toContain('[Assistant]: Let me check that.');
      expect(result).toContain('[Tool: search]');
    });

    it('should handle messages without parts', () => {
      const records: ChatRecord[] = [
        {
          sessionId: 'test-session',
          timestamp: new Date().toISOString(),
          type: 'assistant',
          message: {
            role: 'assistant',
          },
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
      ];
      const result = (
        dataProcessor as unknown as {
          formatRecordsForAnalysis(records: ChatRecord[]): string;
        }
      ).formatRecordsForAnalysis(records);
      expect(result).not.toContain('[Assistant]:');
    });
  });

  describe('calculateStreaks', () => {
    it('should return zero streaks for empty dates array', () => {
      const result = (
        dataProcessor as unknown as {
          calculateStreaks(dates: string[]): {
            currentStreak: number;
            longestStreak: number;
            dates: string[];
          };
        }
      ).calculateStreaks([]);
      expect(result.currentStreak).toBe(0);
      expect(result.longestStreak).toBe(0);
      expect(result.dates).toEqual([]);
    });

    it('should calculate streak of 1 for single date', () => {
      const result = (
        dataProcessor as unknown as {
          calculateStreaks(dates: string[]): {
            currentStreak: number;
            longestStreak: number;
            dates: string[];
          };
        }
      ).calculateStreaks(['2025-01-15']);
      expect(result.currentStreak).toBe(1);
      expect(result.longestStreak).toBe(1);
    });

    it('should calculate consecutive day streak', () => {
      const dates = ['2025-01-15', '2025-01-16', '2025-01-17'];
      const result = (
        dataProcessor as unknown as {
          calculateStreaks(dates: string[]): {
            currentStreak: number;
            longestStreak: number;
            dates: string[];
          };
        }
      ).calculateStreaks(dates);
      expect(result.currentStreak).toBe(3);
      expect(result.longestStreak).toBe(3);
    });

    it('should handle non-consecutive dates', () => {
      const dates = ['2025-01-15', '2025-01-17', '2025-01-18'];
      const result = (
        dataProcessor as unknown as {
          calculateStreaks(dates: string[]): {
            currentStreak: number;
            longestStreak: number;
            dates: string[];
          };
        }
      ).calculateStreaks(dates);
      expect(result.longestStreak).toBe(2); // Jan 17-18
    });

    it('should sort dates before calculating streaks', () => {
      const dates = ['2025-01-18', '2025-01-15', '2025-01-16', '2025-01-17'];
      const result = (
        dataProcessor as unknown as {
          calculateStreaks(dates: string[]): {
            currentStreak: number;
            longestStreak: number;
            dates: string[];
          };
        }
      ).calculateStreaks(dates);
      expect(result.longestStreak).toBe(4);
    });

    it('should handle duplicate dates', () => {
      const dates = ['2025-01-15', '2025-01-15', '2025-01-16'];
      const result = (
        dataProcessor as unknown as {
          calculateStreaks(dates: string[]): {
            currentStreak: number;
            longestStreak: number;
            dates: string[];
          };
        }
      ).calculateStreaks(dates);
      expect(result.longestStreak).toBeGreaterThanOrEqual(1);
    });
  });

  describe('aggregateFacetsData', () => {
    it('should return empty aggregates for empty facets array', () => {
      const result = (
        dataProcessor as unknown as {
          aggregateFacetsData(facets: SessionFacets[]): {
            satisfactionAgg: Record<string, number>;
            frictionAgg: Record<string, number>;
            primarySuccessAgg: Record<string, number>;
            outcomesAgg: Record<string, number>;
            goalsAgg: Record<string, number>;
          };
        }
      ).aggregateFacetsData([]);
      expect(result.satisfactionAgg).toEqual({});
      expect(result.frictionAgg).toEqual({});
      expect(result.primarySuccessAgg).toEqual({});
      expect(result.outcomesAgg).toEqual({});
      expect(result.goalsAgg).toEqual({});
    });

    it('should aggregate satisfaction counts', () => {
      const facets: SessionFacets[] = [
        {
          session_id: 's1',
          underlying_goal: 'test',
          goal_categories: {},
          outcome: 'fully_achieved',
          user_satisfaction_counts: { satisfied: 2, neutral: 1 },
          Qwen_helpfulness: 'very_helpful',
          session_type: 'single_task',
          friction_counts: {},
          friction_detail: '',
          primary_success: 'none',
          brief_summary: 'Test summary',
        },
        {
          session_id: 's2',
          underlying_goal: 'test2',
          goal_categories: {},
          outcome: 'mostly_achieved',
          user_satisfaction_counts: { satisfied: 1, frustrated: 2 },
          Qwen_helpfulness: 'moderately_helpful',
          session_type: 'multi_task',
          friction_counts: {},
          friction_detail: '',
          primary_success: 'none',
          brief_summary: 'Test summary 2',
        },
      ];
      const result = (
        dataProcessor as unknown as {
          aggregateFacetsData(facets: SessionFacets[]): {
            satisfactionAgg: Record<string, number>;
          };
        }
      ).aggregateFacetsData(facets);
      expect(result.satisfactionAgg).toEqual({
        satisfied: 3,
        neutral: 1,
        frustrated: 2,
      });
    });

    it('should aggregate friction counts', () => {
      const facets: SessionFacets[] = [
        {
          session_id: 's1',
          underlying_goal: 'test',
          goal_categories: {},
          outcome: 'fully_achieved',
          user_satisfaction_counts: {},
          Qwen_helpfulness: 'very_helpful',
          session_type: 'single_task',
          friction_counts: { slow_response: 1, unclear_answer: 2 },
          friction_detail: 'Some friction',
          primary_success: 'none',
          brief_summary: 'Test summary',
        },
        {
          session_id: 's2',
          underlying_goal: 'test2',
          goal_categories: {},
          outcome: 'mostly_achieved',
          user_satisfaction_counts: {},
          Qwen_helpfulness: 'moderately_helpful',
          session_type: 'multi_task',
          friction_counts: { slow_response: 2 },
          friction_detail: 'More friction',
          primary_success: 'none',
          brief_summary: 'Test summary 2',
        },
      ];
      const result = (
        dataProcessor as unknown as {
          aggregateFacetsData(facets: SessionFacets[]): {
            frictionAgg: Record<string, number>;
          };
        }
      ).aggregateFacetsData(facets);
      expect(result.frictionAgg).toEqual({
        slow_response: 3,
        unclear_answer: 2,
      });
    });

    it('should aggregate primary success excluding none', () => {
      const facets: SessionFacets[] = [
        {
          session_id: 's1',
          underlying_goal: 'test',
          goal_categories: {},
          outcome: 'fully_achieved',
          user_satisfaction_counts: {},
          Qwen_helpfulness: 'very_helpful',
          session_type: 'single_task',
          friction_counts: {},
          friction_detail: '',
          primary_success: 'correct_code_edits',
          brief_summary: 'Test summary',
        },
        {
          session_id: 's2',
          underlying_goal: 'test2',
          goal_categories: {},
          outcome: 'mostly_achieved',
          user_satisfaction_counts: {},
          Qwen_helpfulness: 'moderately_helpful',
          session_type: 'multi_task',
          friction_counts: {},
          friction_detail: '',
          primary_success: 'none',
          brief_summary: 'Test summary 2',
        },
        {
          session_id: 's3',
          underlying_goal: 'test3',
          goal_categories: {},
          outcome: 'partially_achieved',
          user_satisfaction_counts: {},
          Qwen_helpfulness: 'slightly_helpful',
          session_type: 'exploration',
          friction_counts: {},
          friction_detail: '',
          primary_success: 'good_explanations',
          brief_summary: 'Test summary 3',
        },
      ];
      const result = (
        dataProcessor as unknown as {
          aggregateFacetsData(facets: SessionFacets[]): {
            primarySuccessAgg: Record<string, number>;
          };
        }
      ).aggregateFacetsData(facets);
      expect(result.primarySuccessAgg).toEqual({
        correct_code_edits: 1,
        good_explanations: 1,
      });
      expect(result.primarySuccessAgg['none']).toBeUndefined();
    });

    it('should aggregate outcomes', () => {
      const facets: SessionFacets[] = [
        {
          session_id: 's1',
          underlying_goal: 'test',
          goal_categories: {},
          outcome: 'fully_achieved',
          user_satisfaction_counts: {},
          Qwen_helpfulness: 'very_helpful',
          session_type: 'single_task',
          friction_counts: {},
          friction_detail: '',
          primary_success: 'none',
          brief_summary: 'Test summary',
        },
        {
          session_id: 's2',
          underlying_goal: 'test2',
          goal_categories: {},
          outcome: 'fully_achieved',
          user_satisfaction_counts: {},
          Qwen_helpfulness: 'moderately_helpful',
          session_type: 'multi_task',
          friction_counts: {},
          friction_detail: '',
          primary_success: 'none',
          brief_summary: 'Test summary 2',
        },
        {
          session_id: 's3',
          underlying_goal: 'test3',
          goal_categories: {},
          outcome: 'partially_achieved',
          user_satisfaction_counts: {},
          Qwen_helpfulness: 'slightly_helpful',
          session_type: 'exploration',
          friction_counts: {},
          friction_detail: '',
          primary_success: 'none',
          brief_summary: 'Test summary 3',
        },
      ];
      const result = (
        dataProcessor as unknown as {
          aggregateFacetsData(facets: SessionFacets[]): {
            outcomesAgg: Record<string, number>;
          };
        }
      ).aggregateFacetsData(facets);
      expect(result.outcomesAgg).toEqual({
        fully_achieved: 2,
        partially_achieved: 1,
      });
    });

    it('should aggregate goal categories', () => {
      const facets: SessionFacets[] = [
        {
          session_id: 's1',
          underlying_goal: 'test',
          goal_categories: { coding: 2, debugging: 1 },
          outcome: 'fully_achieved',
          user_satisfaction_counts: {},
          Qwen_helpfulness: 'very_helpful',
          session_type: 'single_task',
          friction_counts: {},
          friction_detail: '',
          primary_success: 'none',
          brief_summary: 'Test summary',
        },
        {
          session_id: 's2',
          underlying_goal: 'test2',
          goal_categories: { coding: 1, refactoring: 3 },
          outcome: 'mostly_achieved',
          user_satisfaction_counts: {},
          Qwen_helpfulness: 'moderately_helpful',
          session_type: 'multi_task',
          friction_counts: {},
          friction_detail: '',
          primary_success: 'none',
          brief_summary: 'Test summary 2',
        },
      ];
      const result = (
        dataProcessor as unknown as {
          aggregateFacetsData(facets: SessionFacets[]): {
            goalsAgg: Record<string, number>;
          };
        }
      ).aggregateFacetsData(facets);
      expect(result.goalsAgg).toEqual({
        coding: 3,
        debugging: 1,
        refactoring: 3,
      });
    });
  });

  describe('analyzeSession', () => {
    it('should return null for empty records', async () => {
      const result = await (
        dataProcessor as unknown as {
          analyzeSession(records: ChatRecord[]): Promise<SessionFacets | null>;
        }
      ).analyzeSession([]);
      expect(result).toBeNull();
    });

    it('should analyze session and return facets', async () => {
      const mockFacet = {
        underlying_goal: 'Test goal',
        goal_categories: { coding: 1 },
        outcome: 'fully_achieved',
        user_satisfaction_counts: { satisfied: 1 },
        Qwen_helpfulness: 'very_helpful',
        session_type: 'single_task',
        friction_counts: {},
        friction_detail: '',
        primary_success: 'correct_code_edits',
        brief_summary: 'Test summary',
      };

      mockGenerateJson.mockResolvedValue(mockFacet);

      const records: ChatRecord[] = [
        {
          sessionId: 'test-session',
          timestamp: new Date().toISOString(),
          type: 'user',
          message: {
            role: 'user',
            parts: [{ text: 'Help me with code' }],
          },
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
      ];

      const result = await (
        dataProcessor as unknown as {
          analyzeSession(records: ChatRecord[]): Promise<SessionFacets | null>;
        }
      ).analyzeSession(records);

      expect(result).not.toBeNull();
      expect(result?.session_id).toBe('test-session');
      expect(result?.underlying_goal).toBe('Test goal');
      expect(mockGenerateJson).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-model',
          schema: expect.any(Object),
        }),
      );
    });

    it('should return null when LLM returns empty result', async () => {
      mockGenerateJson.mockResolvedValue({});

      const records: ChatRecord[] = [
        {
          sessionId: 'test-session',
          timestamp: new Date().toISOString(),
          type: 'user',
          message: {
            role: 'user',
            parts: [{ text: 'Help' }],
          },
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
      ];

      const result = await (
        dataProcessor as unknown as {
          analyzeSession(records: ChatRecord[]): Promise<SessionFacets | null>;
        }
      ).analyzeSession(records);

      expect(result).toBeNull();
    });

    it('should handle LLM errors gracefully', async () => {
      mockGenerateJson.mockRejectedValue(new Error('LLM Error'));

      const records: ChatRecord[] = [
        {
          sessionId: 'test-session',
          timestamp: new Date().toISOString(),
          type: 'user',
          message: {
            role: 'user',
            parts: [{ text: 'Help' }],
          },
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
      ];

      const result = await (
        dataProcessor as unknown as {
          analyzeSession(records: ChatRecord[]): Promise<SessionFacets | null>;
        }
      ).analyzeSession(records);

      expect(result).toBeNull();
    });
  });

  describe('scanChatFiles', () => {
    it('should return empty array when base directory does not exist', async () => {
      const error = new Error('Directory not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockedFs.readdir.mockRejectedValue(error);

      const result = await (
        dataProcessor as unknown as {
          scanChatFiles(
            baseDir: string,
          ): Promise<Array<{ path: string; mtime: number }>>;
        }
      ).scanChatFiles('/nonexistent');

      expect(result).toEqual([]);
    });

    it('should scan project directories and find chat files', async () => {
      mockedFs.readdir.mockResolvedValueOnce([
        'project1',
        'project2',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      mockedFs.stat.mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.includes('project1') || pathStr.includes('project2')) {
          return Promise.resolve({
            isDirectory: () => true,
            mtimeMs: 1234567890,
          } as Awaited<ReturnType<typeof fs.stat>>);
        }
        if (pathStr.endsWith('.jsonl')) {
          return Promise.resolve({
            isDirectory: () => false,
            mtimeMs: 1234567890,
          } as Awaited<ReturnType<typeof fs.stat>>);
        }
        throw new Error('Unexpected path');
      });

      mockedFs.readdir.mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.endsWith('chats')) {
          if (pathStr.includes('project1')) {
            return Promise.resolve([
              'chat1.jsonl',
              'chat2.jsonl',
            ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
          }
          if (pathStr.includes('project2')) {
            return Promise.resolve(['chat3.jsonl'] as unknown as Awaited<
              ReturnType<typeof fs.readdir>
            >);
          }
        }
        return Promise.resolve(
          [] as unknown as Awaited<ReturnType<typeof fs.readdir>>,
        );
      });

      const result = await (
        dataProcessor as unknown as {
          scanChatFiles(
            baseDir: string,
          ): Promise<Array<{ path: string; mtime: number }>>;
        }
      ).scanChatFiles('/base');

      expect(result).toHaveLength(3);
      const paths = result.map((r) => r.path);
      expect(paths.some((p) => p.includes('chat1.jsonl'))).toBe(true);
      expect(paths.some((p) => p.includes('chat2.jsonl'))).toBe(true);
      expect(paths.some((p) => p.includes('chat3.jsonl'))).toBe(true);
    });

    it('should skip projects without chats directory', async () => {
      mockedFs.readdir.mockResolvedValueOnce([
        'project1',
        'project2',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);

      mockedFs.stat.mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.includes('project1') || pathStr.includes('project2')) {
          return Promise.resolve({ isDirectory: () => true } as Awaited<
            ReturnType<typeof fs.stat>
          >);
        }
        if (pathStr.endsWith('.jsonl')) {
          return Promise.resolve({
            isDirectory: () => false,
            mtimeMs: 1234567890,
          } as Awaited<ReturnType<typeof fs.stat>>);
        }
        throw new Error('Unexpected path');
      });

      const error = new Error('No chats dir') as NodeJS.ErrnoException;
      error.code = 'ENOENT';

      mockedFs.readdir.mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.endsWith('chats')) {
          if (pathStr.includes('project1')) {
            return Promise.resolve(['chat1.jsonl'] as unknown as Awaited<
              ReturnType<typeof fs.readdir>
            >);
          }
          if (pathStr.includes('project2')) {
            return Promise.reject(error);
          }
        }
        return Promise.resolve(
          [] as unknown as Awaited<ReturnType<typeof fs.readdir>>,
        );
      });

      const result = await (
        dataProcessor as unknown as {
          scanChatFiles(
            baseDir: string,
          ): Promise<Array<{ path: string; mtime: number }>>;
        }
      ).scanChatFiles('/base');

      expect(result).toHaveLength(1);
      expect(result[0].path).toContain('chat1.jsonl');
    });

    it('should handle file stat errors gracefully', async () => {
      mockedFs.readdir.mockResolvedValueOnce(['project1'] as unknown as Awaited<
        ReturnType<typeof fs.readdir>
      >);

      mockedFs.stat.mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.includes('project1') && !pathStr.includes('chats')) {
          return Promise.resolve({ isDirectory: () => true } as Awaited<
            ReturnType<typeof fs.stat>
          >);
        }
        if (pathStr.endsWith('chat1.jsonl')) {
          return Promise.reject(new Error('Stat failed'));
        }
        throw new Error('Unexpected path: ' + pathStr);
      });

      mockedFs.readdir.mockImplementation((path) => {
        const pathStr = String(path);
        if (pathStr.endsWith('chats')) {
          return Promise.resolve(['chat1.jsonl'] as unknown as Awaited<
            ReturnType<typeof fs.readdir>
          >);
        }
        return Promise.resolve(
          [] as unknown as Awaited<ReturnType<typeof fs.readdir>>,
        );
      });

      const result = await (
        dataProcessor as unknown as {
          scanChatFiles(
            baseDir: string,
          ): Promise<Array<{ path: string; mtime: number }>>;
        }
      ).scanChatFiles('/base');

      // When stat fails for a file, it should be skipped but not crash
      expect(result).toEqual([]);
    });
  });

  describe('generateMetrics', () => {
    it('should generate metrics from chat files', async () => {
      const mockRecords: ChatRecord[] = [
        {
          sessionId: 'session1',
          timestamp: '2025-01-15T10:00:00Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'Hello' }] },
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
        {
          sessionId: 'session1',
          timestamp: '2025-01-15T10:01:00Z',
          type: 'system',
          subtype: 'slash_command',
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
        {
          sessionId: 'session1',
          timestamp: '2025-01-15T10:05:00Z',
          type: 'assistant',
          message: { role: 'assistant', parts: [{ text: 'Hi' }] },
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
        {
          sessionId: 'session1',
          timestamp: '2025-01-15T10:06:00Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            parts: [{ functionCall: { name: 'read_file', args: {} } }],
          },
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
      ];

      mockedReadJsonlFile.mockResolvedValue(mockRecords);

      const files = [{ path: '/test/chat.jsonl', mtime: 1234567890 }];
      const result = await (
        dataProcessor as unknown as {
          generateMetrics(
            files: Array<{ path: string; mtime: number }>,
          ): Promise<unknown>;
        }
      ).generateMetrics(files);

      expect(result).toMatchObject({
        totalMessages: 2,
        totalSessions: 1,
        heatmap: expect.any(Object),
        activeHours: expect.any(Object),
        topTools: expect.any(Array),
      });
    });

    it('should track tool usage correctly', async () => {
      const mockRecords: ChatRecord[] = [
        {
          sessionId: 'session1',
          timestamp: '2025-01-15T10:00:00Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            parts: [{ functionCall: { name: 'read_file', args: {} } }],
          },
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
        {
          sessionId: 'session1',
          timestamp: '2025-01-15T10:01:00Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            parts: [{ functionCall: { name: 'read_file', args: {} } }],
          },
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
        {
          sessionId: 'session1',
          timestamp: '2025-01-15T10:02:00Z',
          type: 'assistant',
          message: {
            role: 'assistant',
            parts: [{ functionCall: { name: 'write_file', args: {} } }],
          },
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
      ];

      mockedReadJsonlFile.mockResolvedValue(mockRecords);

      const files = [{ path: '/test/chat.jsonl', mtime: 1234567890 }];
      const result = await (
        dataProcessor as unknown as {
          generateMetrics(
            files: Array<{ path: string; mtime: number }>,
          ): Promise<{ topTools: Array<[string, number]> }>;
        }
      ).generateMetrics(files);

      expect(result.topTools).toContainEqual(['read_file', 2]);
      expect(result.topTools).toContainEqual(['write_file', 1]);
    });

    it('should handle file read errors gracefully', async () => {
      mockedReadJsonlFile.mockRejectedValue(new Error('Read failed'));

      const files = [{ path: '/test/chat.jsonl', mtime: 1234567890 }];
      const result = await (
        dataProcessor as unknown as {
          generateMetrics(
            files: Array<{ path: string; mtime: number }>,
          ): Promise<{ totalMessages: number }>;
        }
      ).generateMetrics(files);

      expect(result.totalMessages).toBe(0);
    });

    it('should call progress callback during processing', async () => {
      const mockRecords: ChatRecord[] = [
        {
          sessionId: 'session1',
          timestamp: '2025-01-15T10:00:00Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'Hello' }] },
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
      ];

      mockedReadJsonlFile.mockResolvedValue(mockRecords);

      const files = [
        { path: '/test/chat1.jsonl', mtime: 1234567890 },
        { path: '/test/chat2.jsonl', mtime: 1234567891 },
      ];
      const onProgress = vi.fn();

      await (
        dataProcessor as unknown as {
          generateMetrics(
            files: Array<{ path: string; mtime: number }>,
            onProgress?: (stage: string, progress: number) => void,
          ): Promise<unknown>;
        }
      ).generateMetrics(files, onProgress);

      expect(onProgress).toHaveBeenCalled();
    });
  });

  describe('prepareCommonPromptData', () => {
    it('should prepare prompt data with all required sections', () => {
      const metrics = {
        heatmap: { '2025-01-15': 5, '2025-01-16': 3 },
        totalSessions: 10,
        totalMessages: 100,
        totalHours: 5,
        topTools: [
          ['read_file', 20],
          ['write_file', 10],
        ],
      } as unknown as Omit<InsightData, 'facets' | 'qualitative'>;

      const facets: SessionFacets[] = [
        {
          session_id: 's1',
          underlying_goal: 'Goal 1',
          goal_categories: { coding: 2, debugging: 1 },
          outcome: 'fully_achieved',
          user_satisfaction_counts: { satisfied: 2 },
          Qwen_helpfulness: 'very_helpful',
          session_type: 'single_task',
          friction_counts: { slow: 1 },
          friction_detail: 'Some friction detail',
          primary_success: 'correct_code_edits',
          brief_summary: 'Summary 1',
        },
      ];

      const result = (
        dataProcessor as unknown as {
          prepareCommonPromptData(
            metrics: Omit<InsightData, 'facets' | 'qualitative'>,
            facets: SessionFacets[],
          ): string;
        }
      ).prepareCommonPromptData(metrics, facets);

      expect(result).toContain('DATA:');
      expect(result).toContain('SESSION SUMMARIES:');
      expect(result).toContain('FRICTION DETAILS:');
      expect(result).toContain('Summary 1');
      expect(result).toContain('Some friction detail');
    });

    it('should filter out empty friction details', () => {
      const metrics = {
        heatmap: {},
        totalSessions: 1,
        totalMessages: 10,
        totalHours: 1,
        topTools: [],
      } as unknown as Omit<InsightData, 'facets' | 'qualitative'>;

      const facets: SessionFacets[] = [
        {
          session_id: 's1',
          underlying_goal: 'Goal 1',
          goal_categories: {},
          outcome: 'fully_achieved',
          user_satisfaction_counts: {},
          Qwen_helpfulness: 'very_helpful',
          session_type: 'single_task',
          friction_counts: {},
          friction_detail: '',
          primary_success: 'none',
          brief_summary: 'Summary 1',
        },
        {
          session_id: 's2',
          underlying_goal: 'Goal 2',
          goal_categories: {},
          outcome: 'mostly_achieved',
          user_satisfaction_counts: {},
          Qwen_helpfulness: 'moderately_helpful',
          session_type: 'multi_task',
          friction_counts: {},
          friction_detail: '   ',
          primary_success: 'none',
          brief_summary: 'Summary 2',
        },
      ];

      const result = (
        dataProcessor as unknown as {
          prepareCommonPromptData(
            metrics: Omit<InsightData, 'facets' | 'qualitative'>,
            facets: SessionFacets[],
          ): string;
        }
      ).prepareCommonPromptData(metrics, facets);

      // Check that FRICTION DETAILS section is empty or only contains whitespace
      const frictionSection =
        result.split('FRICTION DETAILS:')[1]?.split('USER INSTRUCTIONS')[0] ||
        '';
      const hasNonEmptyFrictionDetail =
        frictionSection.trim().length > 0 && frictionSection.includes('-');
      expect(hasNonEmptyFrictionDetail).toBe(false);
    });
  });

  describe('generateFacets', () => {
    it('should skip non-conversational sessions', async () => {
      const userOnlyRecords: ChatRecord[] = [
        {
          sessionId: 'user-only',
          timestamp: '2025-01-15T10:00:00Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'Hello' }] },
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
      ];

      const conversationalRecords: ChatRecord[] = [
        {
          sessionId: 'conversational',
          timestamp: '2025-01-15T10:00:00Z',
          type: 'user',
          message: { role: 'user', parts: [{ text: 'Hello' }] },
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
        {
          sessionId: 'conversational',
          timestamp: '2025-01-15T10:01:00Z',
          type: 'assistant',
          message: { role: 'assistant', parts: [{ text: 'Hi' }] },
          uuid: '',
          parentUuid: null,
          cwd: '',
          version: '',
        },
      ];

      // First file is user-only, second is conversational
      mockedReadJsonlFile
        .mockResolvedValueOnce(userOnlyRecords)
        .mockResolvedValueOnce(conversationalRecords);

      const mockFacet = {
        underlying_goal: 'Test',
        goal_categories: {},
        outcome: 'fully_achieved',
        user_satisfaction_counts: {},
        Qwen_helpfulness: 'very_helpful',
        session_type: 'single_task',
        friction_counts: {},
        friction_detail: '',
        primary_success: 'none',
        brief_summary: 'Test',
      };
      mockGenerateJson.mockResolvedValue(mockFacet);

      const files = [
        { path: '/test/user-only.jsonl', mtime: 2000 },
        { path: '/test/conversational.jsonl', mtime: 1000 },
      ];

      const result = await (
        dataProcessor as unknown as {
          generateFacets(
            files: Array<{ path: string; mtime: number }>,
            facetsOutputDir?: string,
          ): Promise<SessionFacets[]>;
        }
      ).generateFacets(files);

      // Only the conversational session should be analyzed
      expect(mockGenerateJson).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
      expect(result[0].session_id).toBe('conversational');
    });
  });
});
