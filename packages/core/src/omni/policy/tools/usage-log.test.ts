/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendOmniUsageLog } from './usage-log.js';
import { parseSseCompletion } from './transcribe-audio.js';

/** Build an SSE body: content deltas, then an optional final usage chunk. */
function sse(parts: string[], usage?: Record<string, number>): string {
  const lines = parts.map(
    (c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}`,
  );
  if (usage) {
    lines.push(`data: ${JSON.stringify({ choices: [], usage })}`);
  }
  lines.push('data: [DONE]');
  return lines.join('\n\n');
}

describe('parseSseCompletion', () => {
  it('assembles delta content and captures the final usage block', () => {
    const body = sse(['Hel', 'lo'], {
      prompt_tokens: 120,
      completion_tokens: 8,
      total_tokens: 128,
    });
    const { text, usage } = parseSseCompletion(body);
    expect(text).toBe('Hello');
    expect(usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 8,
      total_tokens: 128,
    });
  });

  it('returns undefined usage when no usage chunk is present', () => {
    const { text, usage } = parseSseCompletion(sse(['abc']));
    expect(text).toBe('abc');
    expect(usage).toBeUndefined();
  });
});

describe('appendOmniUsageLog', () => {
  const created: string[] = [];
  const origEnv = process.env['OMNI_USAGE_LOG'];

  afterEach(() => {
    if (origEnv === undefined) delete process.env['OMNI_USAGE_LOG'];
    else process.env['OMNI_USAGE_LOG'] = origEnv;
    for (const dir of created.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function logPath(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'omni-usage-'));
    created.push(dir);
    return path.join(dir, 'usage.jsonl');
  }

  it('appends one JSONL line with model, tool, and token counts', () => {
    const p = logPath();
    process.env['OMNI_USAGE_LOG'] = p;
    appendOmniUsageLog(
      'qwen3.5-omni-plus',
      { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      'omni_transcribe_audio',
    );
    const line = JSON.parse(readFileSync(p, 'utf8').trim());
    expect(line).toMatchObject({
      model: 'qwen3.5-omni-plus',
      tool: 'omni_transcribe_audio',
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: null,
    });
    expect(typeof line.ts).toBe('number');
  });

  it('records cached_tokens from prompt_tokens_details (OpenAI standard)', () => {
    const p = logPath();
    process.env['OMNI_USAGE_LOG'] = p;
    appendOmniUsageLog('qwen3.5-omni-plus', {
      prompt_tokens: 4000,
      completion_tokens: 10,
      total_tokens: 4010,
      prompt_tokens_details: { cached_tokens: 3500 },
    });
    const line = JSON.parse(readFileSync(p, 'utf8').trim());
    expect(line.cachedInputTokens).toBe(3500);
  });

  it('records cached_tokens from the top level (DashScope variant)', () => {
    const p = logPath();
    process.env['OMNI_USAGE_LOG'] = p;
    appendOmniUsageLog('qwen3.5-omni-plus', {
      prompt_tokens: 4000,
      completion_tokens: 10,
      total_tokens: 4010,
      cached_tokens: 3200,
    });
    const line = JSON.parse(readFileSync(p, 'utf8').trim());
    expect(line.cachedInputTokens).toBe(3200);
  });

  it('is a no-op when OMNI_USAGE_LOG is unset', () => {
    const p = logPath();
    delete process.env['OMNI_USAGE_LOG'];
    appendOmniUsageLog('m', { total_tokens: 1 }, 't');
    expect(existsSync(p)).toBe(false);
  });

  it('is a no-op when usage is undefined', () => {
    const p = logPath();
    process.env['OMNI_USAGE_LOG'] = p;
    appendOmniUsageLog('m', undefined, 't');
    expect(existsSync(p)).toBe(false);
  });
});
