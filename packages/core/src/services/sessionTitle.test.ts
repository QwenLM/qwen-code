/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import { wrapUserPromptSubmitContext } from '../utils/transcript-records.js';
import {
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from '../core/environmentContext.js';
import {
  normalizeForEchoCompare,
  sanitizeTitle,
  tryGenerateSessionTitle,
} from './sessionTitle.js';

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
    getLlmClient: vi.fn(() => ({
      getHistoryShallow: () => opts.history ?? [],
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

const reminder = (body: string) =>
  `${SYSTEM_REMINDER_OPEN}\n${body}\n${SYSTEM_REMINDER_CLOSE}`;

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
    // Not one of the TITLE_SYSTEM_PROMPT "Good examples" — those are
    // rejected as prompt echoes (see the #9706 tests below).
    const { config, generateJson } = makeConfig({
      fastModel: 'qwen-turbo',
      history: DIALOG_HISTORY,
      generateJsonResult: { title: 'Debug mobile login breakage' },
    });
    const outcome = await tryGenerateSessionTitle(
      config,
      new AbortController().signal,
    );
    expect(outcome).toEqual({
      ok: true,
      title: 'Debug mobile login breakage',
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

  // #9706: when the recent conversation carries little topical signal
  // (boilerplate-heavy channel sessions), the title model takes the cheapest
  // schema-valid answer and parrots a TITLE_SYSTEM_PROMPT "Good example"
  // back verbatim. Such canned titles say nothing about the session, so
  // they must be treated like an empty result and let the caller fall back.
  it('rejects a verbatim echo of a TITLE_SYSTEM_PROMPT example (#9706)', async () => {
    const { config } = makeConfig({
      fastModel: 'qwen-turbo',
      history: DIALOG_HISTORY,
      generateJsonResult: { title: 'Fix login button on mobile' },
    });
    const outcome = await tryGenerateSessionTitle(
      config,
      new AbortController().signal,
    );
    expect(outcome).toEqual({ ok: false, reason: 'empty_result' });
  });

  it('rejects case/punctuation variants of every prompt example (#9706)', async () => {
    const echoes = [
      // Case variants (incl. the prompt's own "Bad (wrong case)" example).
      'Fix Login Button On Mobile',
      'fix LOGIN button on mobile',
      // Whitespace / residual punctuation that sanitizeTitle strips down to
      // the bare example.
      '  Add OAuth authentication flow  ',
      'Debug failing CI pipeline tests.',
      // The CJK example.
      '重构用户鉴权中间件',
    ];
    for (const title of echoes) {
      const { config } = makeConfig({
        fastModel: 'qwen-turbo',
        history: DIALOG_HISTORY,
        generateJsonResult: { title },
      });
      const outcome = await tryGenerateSessionTitle(
        config,
        new AbortController().signal,
      );
      expect(outcome, `echo not rejected: ${JSON.stringify(title)}`).toEqual({
        ok: false,
        reason: 'empty_result',
      });
    }
  });

  it('rejects bracket-wrapped echoes of prompt examples (#9706)', async () => {
    // sanitizeTitle keeps ASCII/full-width brackets (legitimate in titles
    // like "(WIP) Fix build"), so the guard itself must see through a
    // bracket wrapper around a canned example.
    const wrapped = [
      '(Fix login button on mobile)',
      '[Add OAuth authentication flow]',
      '{Debug failing CI pipeline tests}',
      '（重构用户鉴权中间件）',
      // Wrappers that survive sanitizeTitle with inner punctuation intact —
      // the guard must not depend on an enumerated bracket family.
      '["Fix login button on mobile"]',
      '<Add OAuth authentication flow>',
      '«Debug failing CI pipeline tests»',
    ];
    for (const title of wrapped) {
      const { config } = makeConfig({
        fastModel: 'qwen-turbo',
        history: DIALOG_HISTORY,
        generateJsonResult: { title },
      });
      const outcome = await tryGenerateSessionTitle(
        config,
        new AbortController().signal,
      );
      expect(
        outcome,
        `wrapped echo not rejected: ${JSON.stringify(title)}`,
      ).toEqual({ ok: false, reason: 'empty_result' });
    }
  });

  it('still accepts a genuine title wrapped in brackets (#9706)', async () => {
    // The wrapper strip is comparison-only: a real title that happens to
    // carry brackets must pass through unchanged, not be corrupted or
    // rejected.
    const { config } = makeConfig({
      fastModel: 'qwen-turbo',
      history: DIALOG_HISTORY,
      generateJsonResult: { title: '(WIP) Fix build' },
    });
    const outcome = await tryGenerateSessionTitle(
      config,
      new AbortController().signal,
    );
    expect(outcome).toEqual({
      ok: true,
      title: '(WIP) Fix build',
      modelUsed: 'qwen-turbo',
    });
  });

  it('still accepts a topical title that merely resembles an example (#9706)', async () => {
    // The guard must be an exact (normalized) match, not fuzzy: a session
    // genuinely about a login button still gets a real, non-canned title.
    const { config } = makeConfig({
      fastModel: 'qwen-turbo',
      history: DIALOG_HISTORY,
      generateJsonResult: { title: 'Fix login button styling' },
    });
    const outcome = await tryGenerateSessionTitle(
      config,
      new AbortController().signal,
    );
    expect(outcome).toEqual({
      ok: true,
      title: 'Fix login button styling',
      modelUsed: 'qwen-turbo',
    });
  });

  it('uses the user-facing projection instead of hidden prompt context', async () => {
    const { config, generateJson } = makeConfig({
      fastModel: 'qwen-turbo',
      history: [
        { role: 'user', parts: [{ text: 'hidden channel instructions' }] },
        { role: 'model', parts: [{ text: 'Hello!' }] },
      ],
      generateJsonResult: { title: 'Answer greeting' },
    });

    await tryGenerateSessionTitle(config, new AbortController().signal, [
      '你好',
    ]);

    const call = generateJson.mock.calls[0][0] as {
      contents: Content[];
    };
    const prompt = call.contents[0]?.parts?.[0]?.text;
    expect(prompt).toContain('你好');
    expect(prompt).not.toContain('hidden channel instructions');
  });

  it('projects every recorded user turn when retrying title generation', async () => {
    const { config, generateJson } = makeConfig({
      fastModel: 'qwen-turbo',
      history: [
        { role: 'user', parts: [{ text: 'hidden first instructions' }] },
        { role: 'model', parts: [{ text: 'First reply' }] },
        { role: 'user', parts: [{ text: 'hidden second instructions' }] },
        { role: 'model', parts: [{ text: 'Second reply' }] },
      ],
      generateJsonResult: { title: 'Answer greetings' },
    });

    await tryGenerateSessionTitle(config, new AbortController().signal, [
      '你好',
      '再见',
    ]);

    const call = generateJson.mock.calls[0][0] as { contents: Content[] };
    const prompt = call.contents[0]?.parts?.[0]?.text;
    expect(prompt).toContain('你好');
    expect(prompt).toContain('再见');
    expect(prompt).not.toContain('hidden first instructions');
    expect(prompt).not.toContain('hidden second instructions');
  });

  it('treats an all-empty display projection as intentionally empty', async () => {
    const { config, generateJson } = makeConfig({
      fastModel: 'qwen-turbo',
      history: [
        { role: 'user', parts: [{ text: 'hidden channel instructions' }] },
        { role: 'model', parts: [{ text: 'Hello!' }] },
      ],
      generateJsonResult: { title: 'Should never be used' },
    });

    const outcome = await tryGenerateSessionTitle(
      config,
      new AbortController().signal,
      ['', ''],
    );

    // `''` entries mean "projection recorded, user-authored text empty" —
    // stay in projection mode (`empty_history`) instead of falling back to
    // the raw history, which carries the hidden model context.
    expect(outcome).toEqual({ ok: false, reason: 'empty_history' });
    expect(generateJson).not.toHaveBeenCalled();
  });

  it('does not align a display projection onto an intervening system turn', async () => {
    const { config, generateJson } = makeConfig({
      fastModel: 'qwen-turbo',
      history: [
        { role: 'user', parts: [{ text: 'hidden channel instructions' }] },
        { role: 'model', parts: [{ text: 'First reply' }] },
        { role: 'user', parts: [{ text: 'internal cron prompt' }] },
        { role: 'model', parts: [{ text: 'Cron reply' }] },
      ],
      generateJsonResult: { title: 'Answer greeting' },
    });

    await tryGenerateSessionTitle(config, new AbortController().signal, [
      'visible channel message',
    ]);

    const call = generateJson.mock.calls[0][0] as { contents: Content[] };
    const prompt = call.contents[0]?.parts?.[0]?.text;
    expect(prompt).toContain('visible channel message');
    expect(prompt).not.toContain('hidden channel instructions');
    expect(prompt).not.toContain('internal cron prompt');
  });

  it('omits unprojected older user turns from resumed channel history', async () => {
    const { config, generateJson } = makeConfig({
      fastModel: 'qwen-turbo',
      history: [
        { role: 'user', parts: [{ text: 'oldest hidden instructions' }] },
        { role: 'model', parts: [{ text: 'Oldest reply' }] },
        { role: 'user', parts: [{ text: 'older hidden instructions' }] },
        { role: 'model', parts: [{ text: 'Older reply' }] },
        { role: 'user', parts: [{ text: 'current hidden instructions' }] },
        { role: 'model', parts: [{ text: 'Current reply' }] },
      ],
      generateJsonResult: { title: 'Answer greeting' },
    });

    // Resumed sessions replay `undefined` for every user turn recorded before
    // display-projection tracking existed; only the newest turn projects.
    await tryGenerateSessionTitle(config, new AbortController().signal, [
      undefined,
      undefined,
      '当前消息',
    ]);

    const call = generateJson.mock.calls[0][0] as { contents: Content[] };
    const prompt = call.contents[0]?.parts?.[0]?.text;
    expect(prompt).toContain('当前消息');
    expect(prompt).not.toContain('undefined');
    expect(prompt).not.toContain('older hidden instructions');
    expect(prompt).not.toContain('current hidden instructions');
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
      getLlmClient: vi.fn(() => ({
        getHistoryShallow: () => history,
        getChat: () => ({
          getHistory: () => history,
        }),
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

  it('skips startup context when building the title prompt', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: reminder('STARTUP_SKILL_LIST') }] },
      { role: 'user', parts: [{ text: 'fix auto title for short prompts' }] },
      { role: 'model', parts: [{ text: 'I will inspect title generation.' }] },
    ];

    let captured = '';
    const { config } = makeConfig({
      fastModel: 'qwen-turbo',
      history,
      generateJsonResult: async (opts: unknown) => {
        captured = JSON.stringify((opts as { contents: Content[] }).contents);
        return { title: 'Fix auto title prompts' };
      },
    });

    await tryGenerateSessionTitle(config, new AbortController().signal);

    expect(captured).not.toContain('STARTUP_SKILL_LIST');
    expect(captured).toContain('fix auto title for short prompts');
  });

  it('strips system-reminder parts while keeping the real user prompt', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'start with titles' }] },
      { role: 'model', parts: [{ text: 'Ready.' }] },
      {
        role: 'user',
        parts: [
          { text: reminder('MID_SESSION_TOOL_METADATA') },
          { text: 'please add a regression test' },
        ],
      },
      { role: 'model', parts: [{ text: 'I will add the test.' }] },
    ];

    let captured = '';
    const { config } = makeConfig({
      fastModel: 'qwen-turbo',
      history,
      generateJsonResult: async (opts: unknown) => {
        captured = JSON.stringify((opts as { contents: Content[] }).contents);
        return { title: 'Add title regression test' };
      },
    });

    await tryGenerateSessionTitle(config, new AbortController().signal);

    expect(captured).not.toContain('MID_SESSION_TOOL_METADATA');
    expect(captured).toContain('please add a regression test');
  });

  it('excludes UserPromptSubmit hook context from the title prompt', async () => {
    const history: Content[] = [
      {
        role: 'user',
        parts: [
          { text: 'Diagnose the parser CI failure.' },
          {
            text: wrapUserPromptSubmitContext(
              'UNRELATED_MEMORY_TOPIC '.repeat(80),
            ),
          },
        ],
      },
      {
        role: 'model',
        parts: [{ text: 'I will inspect the parser workflow.' }],
      },
    ];

    let captured = '';
    const { config } = makeConfig({
      fastModel: 'qwen-turbo',
      history,
      generateJsonResult: async (opts: unknown) => {
        captured = JSON.stringify((opts as { contents: Content[] }).contents);
        return { title: 'Diagnose parser CI failure' };
      },
    });

    await tryGenerateSessionTitle(config, new AbortController().signal);

    expect(captured).toContain('Diagnose the parser CI failure.');
    expect(captured).not.toContain('UNRELATED_MEMORY_TOPIC');
  });

  it('drops pure system-reminder messages from the title prompt', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'fix session titles' }] },
      { role: 'model', parts: [{ text: 'I found the title service.' }] },
      { role: 'user', parts: [{ text: reminder('ADDED_MCP_TOOLS') }] },
    ];

    let captured = '';
    const { config } = makeConfig({
      fastModel: 'qwen-turbo',
      history,
      generateJsonResult: async (opts: unknown) => {
        captured = JSON.stringify((opts as { contents: Content[] }).contents);
        return { title: 'Fix session titles' };
      },
    });

    await tryGenerateSessionTitle(config, new AbortController().signal);

    expect(captured).not.toContain('ADDED_MCP_TOOLS');
    expect(captured).toContain('fix session titles');
  });

  it('strips IDE-merged system reminders from title prompt text', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'inspect the selected file' }] },
      { role: 'model', parts: [{ text: 'I will inspect it.' }] },
      {
        role: 'user',
        parts: [
          {
            text: `what does this function do?\n${reminder('IDE_SKILL_CONTEXT')}`,
          },
        ],
      },
    ];

    let captured = '';
    const { config } = makeConfig({
      fastModel: 'qwen-turbo',
      history,
      generateJsonResult: async (opts: unknown) => {
        captured = JSON.stringify((opts as { contents: Content[] }).contents);
        return { title: 'Inspect selected function' };
      },
    });

    await tryGenerateSessionTitle(config, new AbortController().signal);

    expect(captured).not.toContain('IDE_SKILL_CONTEXT');
    expect(captured).toContain('what does this function do?');
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
      getLlmClient: vi.fn(() => ({
        getHistoryShallow: () => history,
        getChat: () => ({
          getHistory: () => history,
        }),
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

describe('normalizeForEchoCompare', () => {
  it('normalizes both sides of the echo comparison identically (#9772)', () => {
    // An example with edge punctuation must compare equal to the echo that
    // sanitizeTitle strips that punctuation off — otherwise the guard
    // silently misses it.
    expect(normalizeForEchoCompare('Fix CI!')).toBe(
      normalizeForEchoCompare('Fix CI'),
    );
    expect(normalizeForEchoCompare('"Fix CI!"')).toBe(
      normalizeForEchoCompare('fix ci'),
    );
    expect(normalizeForEchoCompare('重构鉴权！')).toBe(
      normalizeForEchoCompare('重构鉴权'),
    );
  });

  it('keeps interior punctuation so distinct titles stay distinct', () => {
    expect(normalizeForEchoCompare('(WIP) Fix build')).not.toBe(
      normalizeForEchoCompare('WIP Fix build'.toLowerCase()),
    );
    expect(normalizeForEchoCompare('Fix login button styling')).not.toBe(
      normalizeForEchoCompare('Fix login button on mobile'),
    );
  });
});
