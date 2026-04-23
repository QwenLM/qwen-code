/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { sanitizeTitle, tryGenerateSessionTitle } from './sessionTitle.js';

interface MockOptions {
  fastModel?: string | undefined;
  history?: Content[];
  generateJsonResult?:
    | Record<string, unknown>
    | ((...args: unknown[]) => Promise<Record<string, unknown>>);
}

function makeConfig(opts: MockOptions): {
  config: Config;
  generateJson: ReturnType<typeof vi.fn>;
} {
  const generateJson = vi.fn(async (...args: unknown[]) => {
    const r = opts.generateJsonResult;
    if (!r) throw new Error('no generateJsonResult configured');
    return typeof r === 'function' ? r(...args) : r;
  });

  const config = {
    getFastModel: vi.fn(() => opts.fastModel ?? undefined),
    getModel: vi.fn(() => 'qwen-plus'),
    getGeminiClient: vi.fn(() => ({
      getChat: () => ({
        getHistory: () => opts.history ?? [],
      }),
    })),
    getBaseLlmClient: vi.fn(() => ({ generateJson })),
  } as unknown as Config;

  return { config, generateJson };
}

const DIALOG_HISTORY: Content[] = [
  { role: 'user', parts: [{ text: 'my login button is broken on mobile' }] },
  {
    role: 'model',
    parts: [{ text: "Let's look at the button handler and the viewport CSS." }],
  },
];

describe('tryGenerateSessionTitle', () => {
  it('returns {ok:false, reason:"no_fast_model"} when fast model is absent', async () => {
    const { config } = makeConfig({
      fastModel: undefined,
      history: DIALOG_HISTORY,
    });
    const outcome = await tryGenerateSessionTitle(
      config,
      new AbortController().signal,
    );
    expect(outcome).toEqual({ ok: false, reason: 'no_fast_model' });
  });

  it('returns {ok:false, reason:"empty_history"} for a fresh session', async () => {
    const { config } = makeConfig({
      fastModel: 'qwen-turbo',
      history: [],
    });
    const outcome = await tryGenerateSessionTitle(
      config,
      new AbortController().signal,
    );
    expect(outcome).toEqual({ ok: false, reason: 'empty_history' });
  });

  it('returns {ok:false, reason:"model_error"} when the LLM throws', async () => {
    const { config } = makeConfig({
      fastModel: 'qwen-turbo',
      history: DIALOG_HISTORY,
      generateJsonResult: () => Promise.reject(new Error('API down')),
    });
    const outcome = await tryGenerateSessionTitle(
      config,
      new AbortController().signal,
    );
    expect(outcome).toEqual({ ok: false, reason: 'model_error' });
  });

  it('returns {ok:false, reason:"aborted"} when the user cancels', async () => {
    const controller = new AbortController();
    const { config } = makeConfig({
      fastModel: 'qwen-turbo',
      history: DIALOG_HISTORY,
      generateJsonResult: async () => {
        controller.abort();
        throw new Error('aborted');
      },
    });
    const outcome = await tryGenerateSessionTitle(config, controller.signal);
    expect(outcome).toEqual({ ok: false, reason: 'aborted' });
  });

  it('returns {ok:false, reason:"empty_result"} when the model returns junk', async () => {
    const { config } = makeConfig({
      fastModel: 'qwen-turbo',
      history: DIALOG_HISTORY,
      generateJsonResult: { title: '   ...  ' },
    });
    const outcome = await tryGenerateSessionTitle(
      config,
      new AbortController().signal,
    );
    expect(outcome).toEqual({ ok: false, reason: 'empty_result' });
  });

  it('returns {ok:true, title, modelUsed} on success', async () => {
    const { config, generateJson } = makeConfig({
      fastModel: 'qwen-turbo',
      history: DIALOG_HISTORY,
      generateJsonResult: { title: 'Fix login button on mobile' },
    });
    const outcome = await tryGenerateSessionTitle(
      config,
      new AbortController().signal,
    );
    expect(outcome).toEqual({
      ok: true,
      title: 'Fix login button on mobile',
      modelUsed: 'qwen-turbo',
    });
    // Schema call must use the fast model (not the main model) and the
    // canonical title schema with required:['title'] and maxAttempts:1.
    expect(generateJson).toHaveBeenCalledOnce();
    const callOpts = generateJson.mock.calls[0][0] as {
      model: string;
      schema: {
        type: string;
        required: string[];
        properties: { title: { type: string } };
      };
      maxAttempts: number;
    };
    expect(callOpts.model).toBe('qwen-turbo');
    expect(callOpts.schema.type).toBe('object');
    expect(callOpts.schema.required).toEqual(['title']);
    expect(callOpts.schema.properties.title.type).toBe('string');
    expect(callOpts.maxAttempts).toBe(1);
  });

  it('sanitizes residual markdown and trailing punctuation from the model result', async () => {
    const { config } = makeConfig({
      fastModel: 'qwen-turbo',
      history: DIALOG_HISTORY,
      generateJsonResult: { title: '**Fix login button.**' },
    });
    const outcome = await tryGenerateSessionTitle(
      config,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ ok: true, title: 'Fix login button' });
  });

  it('filters tool-call and tool-result turns from the prompt', async () => {
    // Users' tool invocations can carry 10K-token payloads (file dumps, grep
    // output). Those must never reach the title LLM — both for cost and
    // because they dilute the "what is this session about" signal.
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'scan the auth module' }] },
      {
        role: 'model',
        parts: [
          { text: 'Scanning…' },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { functionCall: { name: 'grep', args: { q: 'auth' } } } as any,
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'grep',
              response: { output: 'TEN_THOUSAND_TOKENS_OF_FILE_DUMP' },
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        ],
      },
      {
        role: 'model',
        parts: [{ text: 'The middleware stores tokens unsafely.' }],
      },
    ];

    let capturedContents: Content[] | null = null;
    const generateJson = vi.fn(async (opts: { contents: Content[] }) => {
      capturedContents = opts.contents;
      return { title: 'Audit auth middleware' };
    });
    const config = {
      getFastModel: vi.fn(() => 'qwen-turbo'),
      getModel: vi.fn(() => 'qwen-plus'),
      getGeminiClient: vi.fn(() => ({
        getChat: () => ({ getHistory: () => history }),
      })),
      getBaseLlmClient: vi.fn(() => ({ generateJson })),
    } as unknown as Config;

    const outcome = await tryGenerateSessionTitle(
      config,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ ok: true, title: 'Audit auth middleware' });

    // The tool-response payload must NOT have leaked into the prompt.
    expect(capturedContents).not.toBeNull();
    const serialized = JSON.stringify(capturedContents);
    expect(serialized).not.toContain('TEN_THOUSAND_TOKENS_OF_FILE_DUMP');
    expect(serialized).toContain('scan the auth module');
    expect(serialized).toContain('middleware stores tokens unsafely');
  });

  it('tail-slices conversations longer than 1000 characters', async () => {
    // A session that pivots mid-conversation — the final topic is what the
    // title should reflect. Feeding the head risks titling the session by
    // what the user opened with rather than what they ended up doing.
    const longUserText = 'BEGIN_HEAD ' + 'x'.repeat(3000) + ' END_TAIL_MARKER';
    const history: Content[] = [
      { role: 'user', parts: [{ text: longUserText }] },
      { role: 'model', parts: [{ text: 'END_MODEL_MARKER' }] },
    ];

    let captured: string | null = null;
    const generateJson = vi.fn(async (opts: { contents: Content[] }) => {
      captured = opts.contents[0]?.parts?.[0]?.text ?? '';
      return { title: 'Long session' };
    });
    const config = {
      getFastModel: vi.fn(() => 'qwen-turbo'),
      getModel: vi.fn(() => 'qwen-plus'),
      getGeminiClient: vi.fn(() => ({
        getChat: () => ({ getHistory: () => history }),
      })),
      getBaseLlmClient: vi.fn(() => ({ generateJson })),
    } as unknown as Config;

    await tryGenerateSessionTitle(config, new AbortController().signal);

    expect(captured).not.toBeNull();
    expect(captured).toContain('END_MODEL_MARKER');
    expect(captured).not.toContain('BEGIN_HEAD');
  });
});

describe('sanitizeTitle', () => {
  it('strips leading and trailing markdown markers', () => {
    expect(sanitizeTitle('> **Fix login button**')).toBe('Fix login button');
    expect(sanitizeTitle('- Fix login button')).toBe('Fix login button');
    expect(sanitizeTitle('`Fix login button`')).toBe('Fix login button');
  });

  it('strips trailing punctuation in ASCII and CJK', () => {
    expect(sanitizeTitle('Fix login button.')).toBe('Fix login button');
    expect(sanitizeTitle('修复登录按钮。')).toBe('修复登录按钮');
    expect(sanitizeTitle('修复登录按钮，')).toBe('修复登录按钮');
  });

  it('normalizes internal whitespace', () => {
    expect(sanitizeTitle('Fix   login   button')).toBe('Fix login button');
  });

  it('returns empty for noise-only input', () => {
    expect(sanitizeTitle('')).toBe('');
    expect(sanitizeTitle('   \n  ')).toBe('');
    expect(sanitizeTitle('...')).toBe('');
    expect(sanitizeTitle('**')).toBe('');
  });

  it('strips terminal escape sequences (ANSI, OSC-8, BEL)', () => {
    // SECURITY: title renders directly to terminal; escapes must not survive.
    expect(sanitizeTitle('\x1b[2J\x1b[HHello world')).toBe('Hello world');
    expect(sanitizeTitle('before\x07after')).toBe('before after');
    // OSC-8 hyperlink injection — opens a clickable link in supporting terminals.
    expect(sanitizeTitle('\x1b]8;;http://evil\x1b\\click\x1b]8;;\x1b\\')).toBe(
      'click',
    );
    // Null byte in value would otherwise corrupt the JSONL writer on some runtimes.
    expect(sanitizeTitle('a\x00b')).toBe('a b');
  });

  it('drops orphaned surrogates after max-length truncation', () => {
    // Build a title that lands a surrogate pair exactly at the truncation boundary.
    const base = 'x'.repeat(199);
    // `"😀"` is a single emoji (two UTF-16 code units). After
    // slice(0, 200) we'd keep only the high surrogate.
    const title = base + '😀!';
    const sanitized = sanitizeTitle(title);
    // High surrogate must not linger on its own.
    expect(sanitized).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(sanitized.length).toBeLessThanOrEqual(200);
  });
});
