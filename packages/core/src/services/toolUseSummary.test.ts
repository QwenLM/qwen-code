/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../config/config.js';
import {
  cleanSummary,
  createToolUseSummaryMessage,
  generateToolUseSummary,
  TOOL_USE_SUMMARY_SYSTEM_PROMPT,
  truncateJson,
} from './toolUseSummary.js';

// Sanity helper for the pre-truncation tests: `y` count in the output must
// be less than maxLength (since JSON quoting and the field name eat some of
// the budget) — confirming the input never reached its full 10MB form.
function maxLengthGuard(maxLength: number) {
  return maxLength;
}

describe('truncateJson', () => {
  it('returns JSON for short values', () => {
    expect(truncateJson({ foo: 'bar' }, 100)).toBe('{"foo":"bar"}');
    expect(truncateJson('hello', 100)).toBe('"hello"');
    expect(truncateJson(42, 100)).toBe('42');
  });

  it('truncates long values with ellipsis', () => {
    const long = 'x'.repeat(500);
    const result = truncateJson(long, 50);
    expect(result.length).toBe(50);
    expect(result.endsWith('...')).toBe(true);
  });

  it('handles undefined', () => {
    expect(truncateJson(undefined, 100)).toBe('[undefined]');
  });

  it('pre-truncates large string leaves before JSON serialization', () => {
    // Ensures we don't allocate the full JSON for a 10MB string just to
    // slice it to maxLength. The result must still be ≤ maxLength.
    const huge = 'x'.repeat(10_000_000);
    const result = truncateJson(huge, 300);
    expect(result.length).toBeLessThanOrEqual(300);
    expect(result.endsWith('...')).toBe(true);
  });

  it('pre-truncates large string fields inside objects', () => {
    // The point: a 10MB string field must not be fully serialized before the
    // outer cap is applied (would allocate 10MB+ of JSON only to slice it).
    // Pre-truncation slices each string leaf to maxLength first, so the
    // serializer never sees the full payload.
    const obj = { content: 'y'.repeat(10_000_000) };
    const result = truncateJson(obj, 300);
    expect(result.length).toBeLessThanOrEqual(300);
    // The huge field is truncated to <= maxLength characters — far below
    // its original 10M length.
    const yCount = (result.match(/y/g) ?? []).length;
    expect(yCount).toBeLessThan(maxLengthGuard(300));
  });

  it('handles circular references gracefully', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(truncateJson(circular, 100)).toBe('[unable to serialize]');
  });
});

describe('cleanSummary', () => {
  it('preserves well-formed labels', () => {
    expect(cleanSummary('Searched in auth/')).toBe('Searched in auth/');
    expect(cleanSummary('Fixed NPE in UserService')).toBe(
      'Fixed NPE in UserService',
    );
  });

  it('takes first line only', () => {
    expect(cleanSummary('Created signup endpoint\nSome reasoning')).toBe(
      'Created signup endpoint',
    );
  });

  it('strips surrounding quotes', () => {
    expect(cleanSummary('"Read config.json"')).toBe('Read config.json');
    expect(cleanSummary("'Ran failing tests'")).toBe('Ran failing tests');
    expect(cleanSummary('`Fixed bug`')).toBe('Fixed bug');
  });

  it('strips leading bullet/dash', () => {
    expect(cleanSummary('- Searched auth')).toBe('Searched auth');
    expect(cleanSummary('* Read files')).toBe('Read files');
    expect(cleanSummary('• Fixed NPE')).toBe('Fixed NPE');
  });

  it('strips Label:/Summary: prefixes', () => {
    expect(cleanSummary('Label: Fixed bug')).toBe('Fixed bug');
    expect(cleanSummary('Summary: Ran tests')).toBe('Ran tests');
    expect(cleanSummary('Label:Searched files')).toBe('Searched files');
  });

  it('rejects error messages', () => {
    expect(cleanSummary('API error: 500')).toBe('');
    expect(cleanSummary('Error: something went wrong')).toBe('');
    expect(cleanSummary('I cannot generate a summary')).toBe('');
    expect(cleanSummary("I can't help with that")).toBe('');
    expect(cleanSummary('Unable to determine')).toBe('');
  });

  it('caps length at 100 chars', () => {
    const long = 'x'.repeat(200);
    expect(cleanSummary(long).length).toBe(100);
  });

  it('returns empty for empty/whitespace input', () => {
    expect(cleanSummary('')).toBe('');
    expect(cleanSummary('   ')).toBe('');
    expect(cleanSummary('\n\n')).toBe('');
  });

  it('preserves CJK labels', () => {
    expect(cleanSummary('搜索了 auth 模块')).toBe('搜索了 auth 模块');
  });

  it('strips Unicode curly quotes', () => {
    expect(cleanSummary('“Read config.json”')).toBe('Read config.json');
    expect(cleanSummary('‘Ran tests’')).toBe('Ran tests');
  });

  it('strips CJK corner brackets', () => {
    expect(cleanSummary('「搜索了 auth 模块」')).toBe('搜索了 auth 模块');
    expect(cleanSummary('『Fixed bug』')).toBe('Fixed bug');
  });

  it('strips markdown emphasis markers', () => {
    expect(cleanSummary('**Read 4 files**')).toBe('Read 4 files');
    expect(cleanSummary('_Searched auth_')).toBe('Searched auth');
    expect(cleanSummary('__Fixed NPE__')).toBe('Fixed NPE');
  });

  it('rejects Chinese refusal responses', () => {
    expect(cleanSummary('我无法生成摘要')).toBe('');
    expect(cleanSummary('我不能回答这个')).toBe('');
    expect(cleanSummary('抱歉，我不能帮助')).toBe('');
    expect(cleanSummary('无法确定')).toBe('');
    expect(cleanSummary('无法完成')).toBe('');
  });

  it('rejects curly-apostrophe English refusals', () => {
    // U+2019 right single quotation mark — models often emit this for
    // typographic apostrophes and the ASCII-only check missed it.
    expect(cleanSummary('I can’t generate that')).toBe('');
  });

  it('rejects additional English refusal patterns', () => {
    expect(cleanSummary('Failed to read files')).toBe('');
    expect(cleanSummary('Sorry, I cannot')).toBe('');
    expect(cleanSummary('Request failed')).toBe('');
  });
});

describe('createToolUseSummaryMessage', () => {
  it('creates a message with generated uuid and timestamp', () => {
    const msg = createToolUseSummaryMessage('Fixed bug', ['call-1', 'call-2']);
    expect(msg.type).toBe('tool_use_summary');
    expect(msg.summary).toBe('Fixed bug');
    expect(msg.precedingToolUseIds).toEqual(['call-1', 'call-2']);
    expect(msg.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(msg.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('generates distinct uuids', () => {
    const a = createToolUseSummaryMessage('a', []);
    const b = createToolUseSummaryMessage('b', []);
    expect(a.uuid).not.toBe(b.uuid);
  });
});

describe('generateToolUseSummary', () => {
  const makeMockConfig = (
    fastModel: string | undefined,
    generateContentFn?: ReturnType<typeof vi.fn>,
  ): Config => {
    const baseLlm = generateContentFn
      ? { generateText: generateContentFn }
      : undefined;
    return {
      getFastModel: () => fastModel,
      // The chat-client check inside generateToolUseSummary is a gating
      // sanity check that runs before any LLM call; only its presence matters.
      getGeminiClient: () => (baseLlm ? {} : undefined),
      getBaseLlmClient: () => baseLlm,
      getModel: () => fastModel ?? 'main-model',
    } as unknown as Config;
  };

  const abortController = (): AbortController => new AbortController();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when tools array is empty', async () => {
    const config = makeMockConfig('qwen-fast');
    const result = await generateToolUseSummary({
      config,
      tools: [],
      signal: abortController().signal,
    });
    expect(result).toBeNull();
  });

  it('returns null when no fast model is configured', async () => {
    const config = makeMockConfig(undefined);
    const result = await generateToolUseSummary({
      config,
      tools: [{ name: 'Read', input: { file: 'a.ts' }, output: '...' }],
      signal: abortController().signal,
    });
    expect(result).toBeNull();
  });

  it('returns null when signal is already aborted', async () => {
    const config = makeMockConfig('qwen-fast');
    const ac = abortController();
    ac.abort();
    const result = await generateToolUseSummary({
      config,
      tools: [{ name: 'Read', input: {}, output: '' }],
      signal: ac.signal,
    });
    expect(result).toBeNull();
  });

  it('calls model with fast model id and system prompt', async () => {
    const generateContentFn = vi.fn().mockResolvedValue({
      text: 'Searched in auth/',
      usage: undefined,
    });
    const config = makeMockConfig('qwen-fast', generateContentFn);

    const result = await generateToolUseSummary({
      config,
      tools: [
        { name: 'Grep', input: { pattern: 'login' }, output: '3 matches' },
      ],
      signal: abortController().signal,
    });

    expect(result).toBe('Searched in auth/');
    expect(generateContentFn).toHaveBeenCalledTimes(1);

    const options = generateContentFn.mock.calls[0][0];

    expect(options.model).toBe('qwen-fast');
    expect(options.promptId).toBe('side-query:tool-use-summary');
    expect(options.systemInstruction).toBe(TOOL_USE_SUMMARY_SYSTEM_PROMPT);

    const userText = options.contents[0].parts[0].text as string;
    expect(userText).toContain('Tool: Grep');
    expect(userText).toContain('"pattern":"login"');
    expect(userText).toContain('3 matches');
    expect(userText).toContain('Label:');
  });

  it('includes lastAssistantText as intent prefix', async () => {
    const generateContentFn = vi.fn().mockResolvedValue({
      text: 'Fixed auth bug',
      usage: undefined,
    });
    const config = makeMockConfig('qwen-fast', generateContentFn);

    await generateToolUseSummary({
      config,
      tools: [{ name: 'Edit', input: {}, output: '' }],
      signal: abortController().signal,
      lastAssistantText:
        'I will now fix the authentication bug in the login flow.',
    });

    const userText = generateContentFn.mock.calls[0][0].contents[0].parts[0]
      .text as string;
    expect(userText).toContain(
      "User's intent (from assistant's last message):",
    );
    expect(userText).toContain('fix the authentication bug');
  });

  it('truncates lastAssistantText to 200 chars', async () => {
    const generateContentFn = vi.fn().mockResolvedValue({
      text: 'Done',
      usage: undefined,
    });
    const config = makeMockConfig('qwen-fast', generateContentFn);

    const longText = 'A'.repeat(500);
    await generateToolUseSummary({
      config,
      tools: [{ name: 'Edit', input: {}, output: '' }],
      signal: abortController().signal,
      lastAssistantText: longText,
    });

    const userText = generateContentFn.mock.calls[0][0].contents[0].parts[0]
      .text as string;
    // 200 As + some wrapper text, but no 500 As
    expect(userText).toContain('A'.repeat(200));
    expect(userText).not.toContain('A'.repeat(201));
  });

  it('uses explicit model parameter over config fast model', async () => {
    const generateContentFn = vi.fn().mockResolvedValue({
      text: 'Done',
      usage: undefined,
    });
    const config = makeMockConfig('qwen-fast', generateContentFn);

    await generateToolUseSummary({
      config,
      tools: [{ name: 'Edit', input: {}, output: '' }],
      signal: abortController().signal,
      model: 'qwen-turbo-explicit',
    });

    expect(generateContentFn.mock.calls[0][0].model).toBe(
      'qwen-turbo-explicit',
    );
  });

  it('returns null when model returns empty text', async () => {
    const generateContentFn = vi.fn().mockResolvedValue({
      text: '',
      usage: undefined,
    });
    const config = makeMockConfig('qwen-fast', generateContentFn);

    const result = await generateToolUseSummary({
      config,
      tools: [{ name: 'Read', input: {}, output: '' }],
      signal: abortController().signal,
    });
    expect(result).toBeNull();
  });

  it('returns null when model call throws', async () => {
    const generateContentFn = vi.fn().mockRejectedValue(new Error('API error'));
    const config = makeMockConfig('qwen-fast', generateContentFn);

    const result = await generateToolUseSummary({
      config,
      tools: [{ name: 'Read', input: {}, output: '' }],
      signal: abortController().signal,
    });
    expect(result).toBeNull();
  });

  it('returns null when the signal aborts during the call', async () => {
    const ac = abortController();
    const generateContentFn = vi.fn().mockImplementation(async () => {
      ac.abort();
      throw new Error('aborted');
    });
    const config = makeMockConfig('qwen-fast', generateContentFn);

    const result = await generateToolUseSummary({
      config,
      tools: [{ name: 'Read', input: {}, output: '' }],
      signal: ac.signal,
    });
    expect(result).toBeNull();
  });

  it('truncates tool input/output to 300 chars', async () => {
    const generateContentFn = vi.fn().mockResolvedValue({
      text: 'Read file',
      usage: undefined,
    });
    const config = makeMockConfig('qwen-fast', generateContentFn);

    const hugeInput = { content: 'x'.repeat(10000) };
    const hugeOutput = 'y'.repeat(10000);

    await generateToolUseSummary({
      config,
      tools: [{ name: 'Read', input: hugeInput, output: hugeOutput }],
      signal: abortController().signal,
    });

    const userText = generateContentFn.mock.calls[0][0].contents[0].parts[0]
      .text as string;
    // Each field capped at 300, so overall prompt shouldn't contain the
    // full 10K repetition.
    expect(userText).not.toContain('x'.repeat(500));
    expect(userText).not.toContain('y'.repeat(500));
    expect(userText).toContain('...');
  });

  it('cleans markdown bullets / quotes from model output', async () => {
    const generateContentFn = vi.fn().mockResolvedValue({
      text: '- "Searched auth/"',
      usage: undefined,
    });
    const config = makeMockConfig('qwen-fast', generateContentFn);

    const result = await generateToolUseSummary({
      config,
      tools: [{ name: 'Grep', input: {}, output: '' }],
      signal: abortController().signal,
    });
    expect(result).toBe('Searched auth/');
  });
});
