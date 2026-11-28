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
  localDateKey,
  loadUsageHistory,
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

  it('keeps same-root project transcripts distinct from an unjoined ledger', async () => {
    const isolatedHome = path.join(home, 'same-root-projects');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 5, 12));
    const originalHome = process.env['HOME'];
    process.env['HOME'] = isolatedHome;
    process.env['QWEN_HOME'] = isolatedHome;
    process.env['QWEN_RUNTIME_DIR'] = isolatedHome;
    const sessionId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    for (const project of ['/project/a', '/project/b']) {
      const pathForSession = new SessionService(project, {
        runtimeBaseDir: isolatedHome,
      }).getSessionTranscriptPath(sessionId);
      seedTranscript(
        isolatedHome,
        path.dirname(pathForSession),
        sessionId,
        project,
      );
    }
    const localDate = localDateKey(Date.now());
    const ledgerFile = path.join(
      isolatedHome,
      'usage',
      `token-usage-${localDate.slice(0, 7)}.jsonl`,
    );
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.writeFileSync(
      ledgerFile,
      JSON.stringify({
        schemaVersion: 1,
        id: 'unjoined-runtime-request',
        timestamp: new Date(Date.now() - 1000).toISOString(),
        localDate,
        localMonth: localDate.slice(0, 7),
        sessionId,
        model: 'qwen-max',
        authType: 'openai',
        source: 'main',
        inputTokens: 100,
        outputTokens: 0,
        cachedTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 100,
        apiDurationMs: 10,
      }) + '\n',
    );

    try {
      const data = await loadStatsData('today', undefined, sessionId);

      expect(data.report.models['qwen-max']?.totalTokens).toBe(2100);
      expect(data.report.totalRequests).toBe(3);
      expect(data.report.sessionCount).toBe(1);
    } finally {
      vi.useRealTimers();
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
    }
  });

  it('keeps transcript ownership on the persisted fast path', async () => {
    const isolatedHome = path.join(home, 'persisted-transcript-scope');
    const originalHome = process.env['HOME'];
    process.env['HOME'] = isolatedHome;
    process.env['QWEN_HOME'] = isolatedHome;
    process.env['QWEN_RUNTIME_DIR'] = isolatedHome;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 5, 12));
    const sessionId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const history = path.join(isolatedHome, 'usage_record.jsonl');
    try {
      const projects = ['/project/a', '/project/b'];
      for (const [index, project] of projects.entries()) {
        const transcript = new SessionService(project, {
          runtimeBaseDir: isolatedHome,
        }).getSessionTranscriptPath(sessionId);
        seedTranscript(
          isolatedHome,
          path.dirname(transcript),
          sessionId,
          project,
        );
        persistSessionUsage({
          sessionId,
          project,
          startTime: new Date(Date.now() - 7_200_000),
          endTime: new Date(Date.now() - 7_200_000 + 2_000),
          metrics: metrics((index + 1) * 100),
        });
      }
      const records = fs
        .readFileSync(history, 'utf8')
        .trim()
        .split('\n')
        .map((line) => ({
          ...JSON.parse(line),
          runScoped: false,
          transcriptRebuild: true,
        }));
      fs.writeFileSync(
        history,
        `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      );
      const localDate = localDateKey(Date.now());
      const ledgerFile = path.join(
        isolatedHome,
        'usage',
        `token-usage-${localDate.slice(0, 7)}.jsonl`,
      );
      fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
      fs.writeFileSync(
        ledgerFile,
        JSON.stringify({
          schemaVersion: 1,
          id: 'unjoined-ledger',
          timestamp: new Date().toISOString(),
          localDate,
          localMonth: localDate.slice(0, 7),
          sessionId,
          model: 'qwen-max',
          authType: 'openai',
          source: 'main',
          inputTokens: 50,
          outputTokens: 0,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 50,
          apiDurationMs: 10,
        }) + '\n',
      );

      const data = await loadStatsData(
        'all',
        undefined,
        sessionId,
        projects[0],
      );
      expect(data.report.models['qwen-max']?.totalTokens).toBe(350);
      expect(data.report.totalRequests).toBe(3);
      expect(data.report.sessionCount).toBe(1);
    } finally {
      vi.useRealTimers();
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
    }
  });

  it('keeps the active session joined to its ledger without a transcript', async () => {
    const isolatedHome = path.join(home, 'active-missing-transcript');
    const originalHome = process.env['HOME'];
    process.env['HOME'] = isolatedHome;
    process.env['QWEN_HOME'] = isolatedHome;
    process.env['QWEN_RUNTIME_DIR'] = isolatedHome;
    fs.mkdirSync(isolatedHome, { recursive: true });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 5, 12));
    const sessionId = B;
    const executionId = 'active-no-transcript-response';
    const current = buildCurrentSessionRecord(
      sessionId,
      new Date(Date.now() - 1_000),
      isolatedHome,
      metrics(100),
    )!;
    current.requestExecutionIds = [executionId];
    expect(current.successfulRequestExecutionIds).toBeUndefined();
    const transcript = new SessionService(isolatedHome, {
      runtimeBaseDir: isolatedHome,
    }).getSessionTranscriptPath(sessionId);
    expect(fs.existsSync(transcript)).toBe(false);
    const localDate = localDateKey(Date.now());
    const ledgerFile = path.join(
      isolatedHome,
      'usage',
      `token-usage-${localDate.slice(0, 7)}.jsonl`,
    );
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.writeFileSync(
      ledgerFile,
      JSON.stringify({
        schemaVersion: 1,
        id: 'active-missing-transcript-row',
        executionId,
        timestamp: new Date().toISOString(),
        localDate,
        localMonth: localDate.slice(0, 7),
        sessionId,
        model: 'qwen-max',
        authType: 'openai',
        source: 'main',
        inputTokens: 100,
        outputTokens: 0,
        cachedTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 100,
        apiDurationMs: 10,
      }) + '\n',
    );

    try {
      const data = await loadStatsData(
        'today',
        current,
        sessionId,
        isolatedHome,
      );
      expect(data.report.models['qwen-max']?.totalTokens).toBe(100);
      expect(data.report.totalRequests).toBe(1);
      expect(data.report.sessionCount).toBe(1);
      expect(data.report.tools.totalCalls).toBe(2);
    } finally {
      vi.useRealTimers();
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
    }
  });

  it('keeps another project history beside the active session ledger', async () => {
    const isolatedHome = path.join(home, 'active-project-isolation');
    const previousHome = process.env['HOME'];
    const previousQwenHome = process.env['QWEN_HOME'];
    const previousRuntime = process.env['QWEN_RUNTIME_DIR'];
    process.env['HOME'] = isolatedHome;
    process.env['QWEN_HOME'] = isolatedHome;
    process.env['QWEN_RUNTIME_DIR'] = isolatedHome;
    fs.mkdirSync(isolatedHome, { recursive: true });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 5, 12));
    const projectA = '/runtime/history-a';
    const projectB = '/runtime/history-b';
    const sessionId = B;
    persistSessionUsage({
      sessionId,
      project: projectA,
      startTime: new Date(Date.now() - 7_200_000),
      endTime: new Date(Date.now() - 3_600_000),
      metrics: metrics(1000),
    });
    const usagePath = path.join(isolatedHome, 'usage_record.jsonl');
    const authoritative = JSON.parse(
      fs.readFileSync(usagePath, 'utf8').trim().split('\n').at(-1)!,
    );
    authoritative.transcriptRebuild = true;
    delete authoritative.runScoped;
    fs.writeFileSync(usagePath, `${JSON.stringify(authoritative)}\n`);
    seedTranscript(
      isolatedHome,
      path.dirname(
        new SessionService(projectA, {
          runtimeBaseDir: isolatedHome,
        }).getSessionTranscriptPath(sessionId),
      ),
      sessionId,
      projectA,
    );
    const current = buildCurrentSessionRecord(
      sessionId,
      new Date(Date.now() - 1_000),
      projectB,
      metrics(100),
    )!;
    const executionId = 'project-b-active-response';
    current.requestExecutionIds = [executionId];
    delete current.successfulRequestExecutionIds;
    const ledgerPath = path.join(
      isolatedHome,
      'usage',
      `token-usage-${localDateKey(Date.now()).slice(0, 7)}.jsonl`,
    );
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(
      ledgerPath,
      JSON.stringify({
        schemaVersion: 1,
        id: 'project-b-ledger',
        executionId,
        timestamp: new Date().toISOString(),
        localDate: localDateKey(Date.now()),
        localMonth: localDateKey(Date.now()).slice(0, 7),
        sessionId,
        model: 'qwen-max',
        authType: 'openai',
        source: 'main',
        inputTokens: 100,
        outputTokens: 0,
        cachedTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 100,
        apiDurationMs: 10,
      }) + '\n',
    );
    try {
      const loaded = await loadUsageHistory(sessionId, {
        persistRebuild: false,
        projectRoot: projectB,
        readAt: Date.now(),
      });
      expect(loaded.map((record) => record.project)).toEqual([projectA]);
      const data = await loadStatsData('today', current, sessionId, projectB);
      expect(data.report.models['qwen-max']?.totalTokens).toBe(1100);
      expect(data.report.totalRequests).toBe(2);
      expect(data.report.sessionCount).toBe(1);
    } finally {
      vi.useRealTimers();
      if (previousHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previousHome;
      if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = previousQwenHome;
      if (previousRuntime === undefined) delete process.env['QWEN_RUNTIME_DIR'];
      else process.env['QWEN_RUNTIME_DIR'] = previousRuntime;
    }
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
    expect(data.report.sessionCount).toBe(2);
    expect(live?.runScoped).toBe(true);

    const records = fs
      .readFileSync(path.join(home, 'usage_record.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.sessionId)).toEqual([A]);
  });

  it('uses the active session identity in the completed-window delta', async () => {
    const isolatedHome = path.join(home, 'active-delta-proof');
    const previousHome = process.env['HOME'];
    const previousQwenHome = process.env['QWEN_HOME'];
    const previousRuntime = process.env['QWEN_RUNTIME_DIR'];
    process.env['HOME'] = isolatedHome;
    process.env['QWEN_HOME'] = isolatedHome;
    process.env['QWEN_RUNTIME_DIR'] = isolatedHome;
    fs.mkdirSync(isolatedHome, { recursive: true });
    const dayAt = (offset: number) => new Date(2026, 5, 1 + offset, 12);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(dayAt(15));
    const sessionId = B;
    const project = '/delta/current-project';
    const current = buildCurrentSessionRecord(
      sessionId,
      dayAt(5),
      project,
      metrics(200),
    )!;
    current.timestamp = dayAt(13).getTime();
    current.models['qwen-max']!.requests = 2;
    current.requestExecutionIds = [
      'active-previous-response',
      'active-current-response',
    ];
    delete current.successfulRequestExecutionIds;
    persistSessionUsage({
      sessionId: 'earlier-delta-session',
      project: '/delta/old-project',
      startTime: dayAt(3),
      endTime: dayAt(4),
      metrics: metrics(100),
    });
    const usagePath = path.join(isolatedHome, 'usage_record.jsonl');
    const oldSnapshot = JSON.parse(fs.readFileSync(usagePath, 'utf8').trim());
    delete oldSnapshot.runScoped;
    fs.writeFileSync(usagePath, `${JSON.stringify(oldSnapshot)}\n`);
    const rows = [
      {
        offset: 4,
        id: 'earlier-delta-response',
        sessionId: 'earlier-delta-session',
      },
      { offset: 7, id: 'active-previous-response', sessionId },
      { offset: 13, id: 'active-current-response', sessionId },
    ].map(({ offset, id, sessionId: owner }) => {
      const date = dayAt(offset);
      return JSON.stringify({
        schemaVersion: 1,
        id,
        executionId: id,
        timestamp: date.toISOString(),
        localDate: localDateKey(date.getTime()),
        localMonth: localDateKey(date.getTime()).slice(0, 7),
        sessionId: owner,
        model: 'qwen-max',
        authType: 'openai',
        source: 'main',
        inputTokens: 100,
        outputTokens: 0,
        cachedTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 100,
        apiDurationMs: 10,
      });
    });
    const ledger = path.join(
      isolatedHome,
      'usage',
      'token-usage-2026-06.jsonl',
    );
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, `${rows.join('\n')}\n`);
    expect(
      fs.existsSync(
        new SessionService(project, {
          runtimeBaseDir: isolatedHome,
        }).getSessionTranscriptPath(sessionId),
      ),
    ).toBe(false);
    try {
      const data = await loadStatsData('week', current, sessionId, project);
      expect(data.delta?.tokens).toBe(-50);
    } finally {
      vi.useRealTimers();
      if (previousHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previousHome;
      if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
      else process.env['QWEN_HOME'] = previousQwenHome;
      if (previousRuntime === undefined) delete process.env['QWEN_RUNTIME_DIR'];
      else process.env['QWEN_RUNTIME_DIR'] = previousRuntime;
    }
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
        expect(data.report.sessionCount).toBe(2);
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
