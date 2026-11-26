/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { EVENT_API_RESPONSE } from '@qwen-code/qwen-code-core/telemetry/constants.js';
import {
  uiTelemetryService,
  type UiEvent,
} from '@qwen-code/qwen-code-core/telemetry/uiTelemetry.js';
import { persistSessionUsageOnClose } from './usage-persistence.js';

function apiResponseEvent(
  model: string,
  input: number,
  output: number,
  executionId: string,
): UiEvent {
  return {
    'event.name': EVENT_API_RESPONSE,
    'event.timestamp': new Date().toISOString(),
    model,
    duration_ms: 42,
    input_token_count: input,
    output_token_count: output,
    cached_content_token_count: 0,
    thoughts_token_count: 0,
    tool_token_count: 0,
    total_token_count: input + output,
    execution_id: executionId,
  } as UiEvent;
}

describe('persistSessionUsageOnClose', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevQwenHome: string | undefined;
  let prevRuntime: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-persist-close-'));
    prevHome = process.env['HOME'];
    prevQwenHome = process.env['QWEN_HOME'];
    prevRuntime = process.env['QWEN_RUNTIME_DIR'];
    process.env['HOME'] = tmpHome;
    process.env['QWEN_HOME'] = tmpHome;
    process.env['QWEN_RUNTIME_DIR'] = tmpHome;
    uiTelemetryService.reset();
  });

  afterEach(() => {
    uiTelemetryService.reset();
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    if (prevQwenHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = prevQwenHome;
    if (prevRuntime === undefined) delete process.env['QWEN_RUNTIME_DIR'];
    else process.env['QWEN_RUNTIME_DIR'] = prevRuntime;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const makeConfig = (projectRoot: string): Config =>
    ({
      getProjectRoot: () => projectRoot,
    }) as unknown as Config;

  const readRecords = () => {
    const file = path.join(tmpHome, 'usage_record.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };

  it('writes zero records when a resumed daemon session closes without new live activity', () => {
    uiTelemetryService.addReplayedEvent(
      apiResponseEvent('qwen-max', 1000, 200, 'replayed-exec'),
      'resumed-only',
    );
    persistSessionUsageOnClose(makeConfig('/proj/a'), 'resumed-only');
    expect(readRecords()).toHaveLength(0);
  });

  it('persists only live delta for the closing session, isolated from concurrent sessions, and writes at most once after removeSession', () => {
    uiTelemetryService.addReplayedEvent(
      apiResponseEvent('qwen-max', 5000, 1000, 'replayed-1'),
      'sess-a',
    );
    uiTelemetryService.addEvent(
      apiResponseEvent('qwen-max', 80, 20, 'live-a-1'),
      'sess-a',
    );
    uiTelemetryService.recordSkillInvocation('review', true, 'sess-a');
    uiTelemetryService.addEvent(
      apiResponseEvent('qwen-max', 300, 50, 'live-b-1'),
      'sess-b',
    );

    persistSessionUsageOnClose(makeConfig('/proj/a'), 'sess-a');
    uiTelemetryService.removeSession('sess-a');
    // Second close attempt must not write a duplicate record.
    persistSessionUsageOnClose(makeConfig('/proj/a'), 'sess-a');

    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sessionId: 'sess-a',
      project: '/proj/a',
      runScoped: true,
      requestExecutionIds: ['live-a-1'],
      successfulRequestExecutionIds: ['live-a-1'],
      models: {
        'qwen-max': {
          requests: 1,
          inputTokens: 80,
          outputTokens: 20,
          totalTokens: 100,
        },
      },
      skills: {
        totalCalls: 1,
        totalSuccess: 1,
        totalFail: 0,
      },
    });

    // Concurrent session B retains its own live bucket until it closes.
    persistSessionUsageOnClose(makeConfig('/proj/b'), 'sess-b');
    uiTelemetryService.removeSession('sess-b');
    const afterB = readRecords();
    expect(afterB).toHaveLength(2);
    expect(afterB[1]).toMatchObject({
      sessionId: 'sess-b',
      project: '/proj/b',
      runScoped: true,
      requestExecutionIds: ['live-b-1'],
      models: {
        'qwen-max': {
          requests: 1,
          inputTokens: 300,
          outputTokens: 50,
          totalTokens: 350,
        },
      },
    });
  });
});
