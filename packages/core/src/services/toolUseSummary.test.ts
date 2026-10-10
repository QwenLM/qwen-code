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
  type GenerateToolUseSummaryParams,
  TOOL_USE_SUMMARY_SYSTEM_PROMPT,
  truncateJson,
} from './toolUseSummary.js';

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
    // A 10MB string field must not be fully serialized before the outer cap
    // (10MB+ of JSON only to slice it): each string leaf is sliced to maxLength
    // first, so the serializer never sees the full payload.
    const obj = { content: 'y'.repeat(10_000_000) };
    const result = truncateJson(obj, 300);
    expect(result.length).toBeLessThanOrEqual(300);
    // Fewer `y`s than maxLength (JSON quoting and the field name eat some of
    // the budget) confirms the input never reached its full 10MB form.
    const yCount = (result.match(/y/g) ?? []).length;
    expect(yCount).toBeLessThan(300);
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
      getLlmClient: () => (baseLlm ? {} : undefined),
      getBaseLlmClient: () => baseLlm,
      getModel: () => fastModel ?? 'main-model',
    } as unknown as Config;
  };

  /** A `generateText` mock that resolves with `text`. */
  const replying = (text: string) =>
    vi.fn().mockResolvedValue({ text, usage: undefined });

  /**
   * Summarizes with fast model 'qwen-fast' backed by `generateContentFn` (no
   * LLM client when omitted) and one empty Read tool, unless `params` override.
   */
  const summarize = (
    generateContentFn?: ReturnType<typeof vi.fn>,
    params: Partial<GenerateToolUseSummaryParams> = {},
  ) =>
    generateToolUseSummary({
      config: makeMockConfig('qwen-fast', generateContentFn),
      tools: [{ name: 'Read', input: {}, output: '' }],
      signal: new AbortController().signal,
      ...params,
    });

  /** The user prompt text of the first model call. */
  const promptOf = (generateContentFn: ReturnType<typeof vi.fn>) =>
    generateContentFn.mock.calls[0][0].contents[0].parts[0].text as string;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when tools array is empty', async () => {
    expect(await summarize(undefined, { tools: [] })).toBeNull();
  });

  it('returns null when no fast model is configured', async () => {
    const result = await summarize(undefined, {
      config: makeMockConfig(undefined),
      tools: [{ name: 'Read', input: { file: 'a.ts' }, output: '...' }],
    });
    expect(result).toBeNull();
  });

  it('returns null when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await summarize(undefined, { signal: ac.signal })).toBeNull();
  });

  it('calls model with fast model id and system prompt', async () => {
    const generateContentFn = replying('Searched in auth/');
    const result = await summarize(generateContentFn, {
      tools: [
        { name: 'Grep', input: { pattern: 'login' }, output: '3 matches' },
      ],
    });

    expect(result).toBe('Searched in auth/');
    expect(generateContentFn).toHaveBeenCalledTimes(1);

    const options = generateContentFn.mock.calls[0][0];

    expect(options.model).toBe('qwen-fast');
    expect(options.promptId).toBe('side-query:tool-use-summary');
    expect(options.systemInstruction).toBe(TOOL_USE_SUMMARY_SYSTEM_PROMPT);

    const userText = promptOf(generateContentFn);
    expect(userText).toContain('Tool: Grep');
    expect(userText).toContain('"pattern":"login"');
    expect(userText).toContain('3 matches');
    expect(userText).toContain('Label:');
  });

  it('includes lastAssistantText as intent prefix', async () => {
    const generateContentFn = replying('Fixed auth bug');
    await summarize(generateContentFn, {
      tools: [{ name: 'Edit', input: {}, output: '' }],
      lastAssistantText:
        'I will now fix the authentication bug in the login flow.',
    });

    const userText = promptOf(generateContentFn);
    expect(userText).toContain(
      "User's intent (from assistant's last message):",
    );
    expect(userText).toContain('fix the authentication bug');
  });

  it('truncates lastAssistantText to 200 chars', async () => {
    const generateContentFn = replying('Done');
    await summarize(generateContentFn, {
      tools: [{ name: 'Edit', input: {}, output: '' }],
      lastAssistantText: 'A'.repeat(500),
    });

    const userText = promptOf(generateContentFn);
    // 200 As + some wrapper text, but no 500 As
    expect(userText).toContain('A'.repeat(200));
    expect(userText).not.toContain('A'.repeat(201));
  });

  it('returns null when model returns empty text', async () => {
    expect(await summarize(replying(''))).toBeNull();
  });

  it('returns null when model call throws', async () => {
    const generateContentFn = vi.fn().mockRejectedValue(new Error('API error'));
    expect(await summarize(generateContentFn)).toBeNull();
  });

  it('returns null when the signal aborts during the call', async () => {
    const ac = new AbortController();
    const generateContentFn = vi.fn().mockImplementation(async () => {
      ac.abort();
      throw new Error('aborted');
    });
    expect(
      await summarize(generateContentFn, { signal: ac.signal }),
    ).toBeNull();
  });

  it('truncates tool input/output to 300 chars', async () => {
    const generateContentFn = replying('Read file');
    await summarize(generateContentFn, {
      tools: [
        {
          name: 'Read',
          input: { content: 'x'.repeat(10000) },
          output: 'y'.repeat(10000),
        },
      ],
    });

    const userText = promptOf(generateContentFn);
    // Each field is capped at 300, so the prompt lacks the full 10K repetition.
    expect(userText).not.toContain('x'.repeat(500));
    expect(userText).not.toContain('y'.repeat(500));
    expect(userText).toContain('...');
  });

  it('cleans markdown bullets / quotes from model output', async () => {
    const result = await summarize(replying('- "Searched auth/"'), {
      tools: [{ name: 'Grep', input: {}, output: '' }],
    });
    expect(result).toBe('Searched auth/');
  });
});
