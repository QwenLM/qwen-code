/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionMetrics } from '@qwen-code/qwen-code-core';
import {
  persistSessionUsage,
  _resetReplayCacheForTest,
} from '@qwen-code/qwen-code-core';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import {
  loadStatsData,
  _resetStatsLedgerCacheForTest,
} from './statsDataService.js';
import { buildCurrentSessionRecord } from '../components/StatsDialog.js';

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
let previous: { qwenHome?: string; runtimeDir?: string };

const metrics = (tokens: number): SessionMetrics =>
  ({
    models: {
      'qwen-max': {
        api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 10 },
        bySource: {},
        tokens: {
          prompt: tokens,
          candidates: 0,
          total: tokens,
          cached: 0,
          thoughts: 0,
        },
      },
    },
    tools: {
      totalCalls: 2,
      totalSuccess: 2,
      totalFail: 0,
      totalDurationMs: 0,
      byName: {},
    },
    files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
  }) as unknown as SessionMetrics;

function seedTranscript(
  home: string,
  chatsDir?: string,
  sessionId = B,
  cwd = home,
): void {
  const started = Date.now() - 7_200_000;
  const time = (offset: number) => new Date(started + offset).toISOString();
  const records = [
    {
      sessionId,
      cwd,
      uuid: 'b-user',
      timestamp: time(0),
      type: 'user',
      message: { role: 'user', content: 'historical request' },
    },
    {
      sessionId,
      cwd,
      uuid: 'b-telemetry',
      timestamp: time(1_000),
      type: 'system',
      subtype: 'ui_telemetry',
      systemPayload: {
        uiEvent: {
          'event.name': 'qwen-code.api_response',
          'event.timestamp': time(1_000),
          response_id: 'stored-b',
          model: 'qwen-max',
          duration_ms: 900,
          input_token_count: 1000,
          output_token_count: 0,
          cached_content_token_count: 0,
          thoughts_token_count: 0,
          total_token_count: 1000,
          prompt_id: 'stored-b',
        },
      },
    },
    {
      sessionId,
      cwd,
      uuid: 'b-assistant',
      timestamp: time(2_000),
      type: 'assistant',
      message: { role: 'model', content: 'historical answer' },
    },
  ];
  const dir = chatsDir ?? path.join(home, 'projects', 'main', 'chats');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
  );
}

describe('stats cross-session transcript reconstruction', () => {
  let home: string;

  beforeEach(() => {
    previous = {
      qwenHome: process.env['QWEN_HOME'],
      runtimeDir: process.env['QWEN_RUNTIME_DIR'],
    };
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-stats-history-'));
    process.env['QWEN_HOME'] = home;
    process.env['QWEN_RUNTIME_DIR'] = home;
    _resetReplayCacheForTest();
    _resetStatsLedgerCacheForTest();
    persistSessionUsage({
      sessionId: A,
      project: home,
      startTime: new Date(Date.now() - 60_000),
      endTime: new Date(),
      metrics: metrics(100),
    });
    seedTranscript(home);
  });

  afterEach(() => {
    _resetReplayCacheForTest();
    _resetStatsLedgerCacheForTest();
    if (previous.qwenHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = previous.qwenHome;
    if (previous.runtimeDir === undefined)
      delete process.env['QWEN_RUNTIME_DIR'];
    else process.env['QWEN_RUNTIME_DIR'] = previous.runtimeDir;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('restores a non-persisted session alongside existing usage', () => {
    const pending = async () => {
      const data = await loadStatsData('all', undefined, B);
      return {
        tokens: data.report.models['qwen-max']?.totalTokens,
        requests: data.report.totalRequests,
        sessions: data.report.sessionCount,
        tools: data.report.tools.totalCalls,
      };
    };
    return expect(pending()).resolves.toEqual({
      tokens: 1100,
      requests: 2,
      sessions: 2,
      tools: 2,
    });
  });

  it('preserves a non-persisted session beside cumulative history', async () => {
    const history = path.join(home, 'usage_record.jsonl');
    const record = JSON.parse(fs.readFileSync(history, 'utf8'));
    Reflect.deleteProperty(record, 'runScoped');
    fs.writeFileSync(history, `${JSON.stringify(record)}\n`);

    const data = await loadStatsData('all', undefined, B, home);

    expect(data.report.models['qwen-max']?.totalTokens).toBe(1100);
    expect(data.report.sessionCount).toBe(2);
    expect(data.report.totalRequests).toBe(2);
  });

  it('adds only the current run without rewriting historical tokens', async () => {
    const live = buildCurrentSessionRecord(
      B,
      new Date(Date.now() - 1_000),
      home,
      metrics(5),
    );
    const data = await loadStatsData('all', live, B);

    expect(data.report.models['qwen-max']?.totalTokens).toBe(1105);
    expect(data.report.totalRequests).toBe(3);
    expect(data.report.sessionCount).toBe(3);
    expect(live?.runScoped).toBe(true);

    const records = fs
      .readFileSync(path.join(home, 'usage_record.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.sessionId)).toEqual([A]);
  });

  it('keeps multiple verified project directories out of the discovery path', async () => {
    const otherSession = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const otherRoot = path.join(home, 'second-project');
    persistSessionUsage({
      sessionId: otherSession,
      project: otherRoot,
      startTime: new Date(Date.now() - 60_000),
      endTime: new Date(),
      metrics: metrics(100),
    });
    const files = [
      { sessionId: A, project: home },
      { sessionId: otherSession, project: otherRoot },
    ].map(({ sessionId, project }) => {
      const filePath = new SessionService(project, {
        runtimeBaseDir: home,
      }).getSessionTranscriptPath(sessionId);
      seedTranscript(home, path.dirname(filePath), sessionId, project);
      return filePath;
    });
    const directorySpy = vi.spyOn(fs, 'readdirSync');
    const openSpy = vi.spyOn(fs.promises, 'open');
    const selectedPaths = new Set(files);
    try {
      for (let i = 0; i < 2; i++) {
        const data = await loadStatsData('all', undefined, A, home);
        expect(data.report.models['qwen-max']?.totalTokens).toBe(2200);
      }
      expect(
        openSpy.mock.calls.filter(([openedPath]) =>
          selectedPaths.has(String(openedPath)),
        ),
      ).toHaveLength(2);
      expect(directorySpy).not.toHaveBeenCalledWith(
        path.join(home, 'projects'),
      );
    } finally {
      directorySpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it('uses a supplied workspace root without enumerating projects', async () => {
    const live = buildCurrentSessionRecord(
      B,
      new Date(Date.now() - 1_000),
      home,
      metrics(5),
    );
    const sourcePath = new SessionService(home, {
      runtimeBaseDir: home,
    }).getSessionTranscriptPath(B);
    seedTranscript(home, path.dirname(sourcePath));
    expect(fs.existsSync(sourcePath)).toBe(true);
    const missingA = path.join(path.dirname(sourcePath), `${A}.jsonl`);
    expect(fs.existsSync(missingA)).toBe(false);
    const directorySpy = vi.spyOn(fs, 'readdirSync');
    try {
      const first = await loadStatsData('all', live, B, home);
      const second = await loadStatsData('all', live, B, home);
      for (const data of [first, second]) {
        expect(data.report.models['qwen-max']?.totalTokens).toBe(1105);
        expect(data.report.sessionCount).toBe(3);
      }
      expect(directorySpy).not.toHaveBeenCalled();
    } finally {
      directorySpy.mockRestore();
    }
    expect(
      fs
        .readFileSync(path.join(home, 'usage_record.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { sessionId: string }),
    ).toEqual([expect.objectContaining({ sessionId: A })]);
  });
});
