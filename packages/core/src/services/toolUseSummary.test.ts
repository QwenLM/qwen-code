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
    const mockClient = generateContentFn
      ? { generateContent: generateContentFn }
      : undefined;
    return {
      getFastModel: () => fastModel,
      getGeminiClient: () => mockClient,
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
      candidates: [
        {
          content: { parts: [{ text: 'Searched in auth/' }] },
        },
      ],
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

    const args = generateContentFn.mock.calls[0];
    const [contents, generationConfig, , model, promptId] = args;

    expect(model).toBe('qwen-fast');
    expect(promptId).toBe('tool_use_summary_generation');
    expect(generationConfig.systemInstruction).toBe(
      TOOL_USE_SUMMARY_SYSTEM_PROMPT,
    );
    expect(generationConfig.tools).toEqual([]);

    const userText = contents[0].parts[0].text as string;
    expect(userText).toContain('Tool: Grep');
    expect(userText).toContain('"pattern":"login"');
    expect(userText).toContain('3 matches');
    expect(userText).toContain('Label:');
  });

  it('includes lastAssistantText as intent prefix', async () => {
    const generateContentFn = vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'Fixed auth bug' }] } }],
    });
    const config = makeMockConfig('qwen-fast', generateContentFn);

    await generateToolUseSummary({
      config,
      tools: [{ name: 'Edit', input: {}, output: '' }],
      signal: abortController().signal,
      lastAssistantText:
        'I will now fix the authentication bug in the login flow.',
    });

    const userText = generateContentFn.mock.calls[0][0][0].parts[0]
      .text as string;
    expect(userText).toContain(
      "User's intent (from assistant's last message):",
    );
    expect(userText).toContain('fix the authentication bug');
  });

  it('truncates lastAssistantText to 200 chars', async () => {
    const generateContentFn = vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'Done' }] } }],
    });
    const config = makeMockConfig('qwen-fast', generateContentFn);

    const longText = 'A'.repeat(500);
    await generateToolUseSummary({
      config,
      tools: [{ name: 'Edit', input: {}, output: '' }],
      signal: abortController().signal,
      lastAssistantText: longText,
    });

    const userText = generateContentFn.mock.calls[0][0][0].parts[0]
      .text as string;
    // 200 As + some wrapper text, but no 500 As
    expect(userText).toContain('A'.repeat(200));
    expect(userText).not.toContain('A'.repeat(201));
  });

  it('uses explicit model parameter over config fast model', async () => {
    const generateContentFn = vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'Done' }] } }],
    });
    const config = makeMockConfig('qwen-fast', generateContentFn);

    await generateToolUseSummary({
      config,
      tools: [{ name: 'Edit', input: {}, output: '' }],
      signal: abortController().signal,
      model: 'qwen-turbo-explicit',
    });

    expect(generateContentFn.mock.calls[0][3]).toBe('qwen-turbo-explicit');
  });

  it('returns null when model returns empty text', async () => {
    const generateContentFn = vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: '' }] } }],
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
      candidates: [{ content: { parts: [{ text: 'Read file' }] } }],
    });
    const config = makeMockConfig('qwen-fast', generateContentFn);

    const hugeInput = { content: 'x'.repeat(10000) };
    const hugeOutput = 'y'.repeat(10000);

    await generateToolUseSummary({
      config,
      tools: [{ name: 'Read', input: hugeInput, output: hugeOutput }],
      signal: abortController().signal,
    });

    const userText = generateContentFn.mock.calls[0][0][0].parts[0]
      .text as string;
    // Each field capped at 300, so overall prompt shouldn't contain the
    // full 10K repetition.
    expect(userText).not.toContain('x'.repeat(500));
    expect(userText).not.toContain('y'.repeat(500));
    expect(userText).toContain('...');
  });

  it('cleans markdown bullets / quotes from model output', async () => {
    const generateContentFn = vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: '- "Searched auth/"' }] } }],
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
