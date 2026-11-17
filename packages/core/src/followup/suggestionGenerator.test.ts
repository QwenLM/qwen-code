/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { Config } from '../config/config.js';

const {
  mockGetCacheSafeParams,
  mockGetCacheSafeParamsSessionId,
  mockRunForkedAgent,
  mockRunSideQuery,
} = vi.hoisted(() => ({
  mockGetCacheSafeParams: vi.fn(),
  mockGetCacheSafeParamsSessionId: vi.fn(),
  mockRunForkedAgent: vi.fn(),
  mockRunSideQuery: vi.fn(),
}));

vi.mock('../utils/sideQuery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/sideQuery.js')>();
  return {
    ...actual,
    runSideQuery: mockRunSideQuery,
  };
});

vi.mock('../agents/forkedAgent.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../agents/forkedAgent.js')>();
  return {
    ...actual,
    getCacheSafeParams: mockGetCacheSafeParams,
    getCacheSafeParamsSessionId: mockGetCacheSafeParamsSessionId,
    runForkedAgent: mockRunForkedAgent,
  };
});

import {
  _setWordSegmenterForTest,
  generatePromptSuggestion,
  getFilterReason,
  shouldFilterSuggestion,
  SUGGESTION_PROMPT,
} from './suggestionGenerator.js';

const conversationHistory: Content[] = [
  { role: 'user', parts: [{ text: 'fix this' }] },
  { role: 'model', parts: [{ text: 'I fixed it.' }] },
  { role: 'user', parts: [{ text: 'anything else?' }] },
  { role: 'model', parts: [{ text: 'You could run tests.' }] },
];

const cacheSafeParams = () => ({
  generationConfig: {},
  history: conversationHistory,
  model: 'main-model',
  version: 1,
  sessionId: 'test-session',
});

describe('generatePromptSuggestion', () => {
  beforeEach(() => {
    mockGetCacheSafeParams.mockReset();
    mockGetCacheSafeParamsSessionId.mockReset();
    mockGetCacheSafeParamsSessionId.mockReturnValue('test-session');
    mockRunForkedAgent.mockReset();
    mockRunSideQuery.mockReset();
  });

  /** Cache-safe params for this session and a fork that suggests "run tests". */
  function mockCacheFork(): void {
    mockGetCacheSafeParams.mockReturnValue(cacheSafeParams());
    mockRunForkedAgent.mockResolvedValue({
      text: null,
      jsonResult: { suggestion: 'run tests' },
      usage: { inputTokens: 10, outputTokens: 3, cacheHitTokens: 5 },
    });
  }

  function mockBaseLlm(): void {
    mockRunSideQuery.mockResolvedValue({
      text: '{"suggestion":"from base llm"}',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }

  /** Runs the generator with a config whose main model is `main-model`. */
  function suggest({
    fastModel,
    sessionId = 'test-session',
    enableCacheSharing = true,
    signal = new AbortController().signal,
    model,
    history = conversationHistory,
  }: {
    fastModel?: string;
    sessionId?: string;
    enableCacheSharing?: boolean;
    signal?: AbortSignal;
    model?: string;
    history?: Content[];
  } = {}) {
    const config = {
      getFastModel: vi.fn(() => fastModel),
      getModel: vi.fn(() => 'main-model'),
      getSessionId: vi.fn(() => sessionId),
    } as unknown as Config;
    return generatePromptSuggestion(config, history, signal, {
      enableCacheSharing,
      model,
    });
  }

  it('passes cache-safe model in cache mode when no explicit or fast model exists', async () => {
    mockCacheFork();
    const signal = new AbortController().signal;
    await suggest({ signal });

    expect(mockGetCacheSafeParams).toHaveBeenCalledWith('test-session');
    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'main-model', abortSignal: signal }),
    );
  });

  it('uses a compact side query when the fast model differs from the cached model', async () => {
    mockCacheFork();
    mockBaseLlm();
    await suggest({ fastModel: 'openai:fast-model' });

    expect(mockRunForkedAgent).not.toHaveBeenCalled();
    expect(mockRunSideQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ model: 'openai:fast-model' }),
    );
  });
  it('passes preserveTools: true for Anthropic prompt-cache sharing', async () => {
    mockCacheFork();
    await suggest();

    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ preserveTools: true }),
    );
  });

  it('falls back to the base LLM when the cache-safe slot belongs to another session', async () => {
    // The cache-safe slot is a process-global: in a multi-session daemon it
    // can hold ANOTHER session's transcript + systemInstruction. The
    // suggestion must NOT fork from a foreign session's params (cross-session
    // content leak) — it falls back to the session-safe base-LLM path
    // (#9233).
    mockGetCacheSafeParamsSessionId.mockReturnValue('session-B');
    mockBaseLlm();

    const result = await suggest({ sessionId: 'session-A' }); // this session is different

    // The cache API rejects the foreign slot before cloning its payload.
    expect(mockGetCacheSafeParams).toHaveBeenCalledWith('session-A');
    // The fork must NOT be used for a foreign session's params.
    expect(mockRunForkedAgent).not.toHaveBeenCalled();
    // The session-safe base-LLM path is used instead.
    expect(mockRunSideQuery).toHaveBeenCalled();
    expect(result.suggestion).toBe('from base llm');
  });

  it('does not use the cache-safe fork when cache sharing is disabled', async () => {
    mockGetCacheSafeParams.mockReturnValue(cacheSafeParams());
    mockBaseLlm();

    const result = await suggest({ enableCacheSharing: false });

    expect(mockGetCacheSafeParamsSessionId).not.toHaveBeenCalled();
    expect(mockGetCacheSafeParams).not.toHaveBeenCalled();
    expect(mockRunForkedAgent).not.toHaveBeenCalled();
    expect(mockRunSideQuery).toHaveBeenCalled();
    expect(result.suggestion).toBe('from base llm');
  });

  it('keeps the cached fork when the fast model matches the cached model', async () => {
    mockCacheFork();
    await suggest({ fastModel: 'main-model' });

    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ preserveTools: true, model: 'main-model' }),
    );
    expect(mockRunSideQuery).not.toHaveBeenCalled();
  });

  it('lets an explicit model override the fast model and use the same-model fork', async () => {
    mockCacheFork();
    await suggest({ fastModel: 'fast-model', model: 'main-model' });

    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'main-model', preserveTools: true }),
    );
    expect(mockRunSideQuery).not.toHaveBeenCalled();
  });

  it('uses the explicit different model without inheriting parent context', async () => {
    const snapshot = {
      ...cacheSafeParams(),
      history: [{ role: 'user', parts: [{ text: 'parent-only history' }] }],
      generationConfig: {
        systemInstruction: 'parent-only system prompt',
        tools: [{ functionDeclarations: [{ name: 'parent_tool' }] }],
      },
    };
    mockGetCacheSafeParams.mockReturnValue(snapshot);
    mockBaseLlm();
    await suggest({ fastModel: 'fast-model', model: 'explicit-model' });

    expect(mockRunForkedAgent).not.toHaveBeenCalled();
    const request = mockRunSideQuery.mock.calls[0][1];
    expect(request.model).toBe('explicit-model');
    expect(request.maxAttempts).toBe(1);
    expect(JSON.stringify(request)).not.toContain('parent-only');
    expect(JSON.stringify(request)).not.toContain('parent_tool');
    expect(snapshot.history[0].parts[0].text).toBe('parent-only history');
  });

  it('uses the current main model when a snapshot belongs to a previous model', async () => {
    mockGetCacheSafeParams.mockReturnValue({
      ...cacheSafeParams(),
      model: 'previous-main-model',
    });
    mockBaseLlm();
    await suggest();

    expect(mockRunForkedAgent).not.toHaveBeenCalled();
    expect(mockRunSideQuery.mock.calls[0][1].model).toBe('main-model');
  });

  it('uses a compact side query when no cache snapshot exists', async () => {
    mockGetCacheSafeParamsSessionId.mockReturnValue(undefined);
    mockBaseLlm();
    await suggest();

    expect(mockRunForkedAgent).not.toHaveBeenCalled();
    expect(mockRunSideQuery.mock.calls[0][1].contents).toEqual([
      {
        role: 'user',
        parts: [
          {
            text: 'User: fix this\n\nUser: anything else?\n\nAssistant: You could run tests.',
          },
        ],
      },
      { role: 'user', parts: [{ text: SUGGESTION_PROMPT }] },
    ]);
  });

  it.each(['English context ', '中文上下文'])(
    'bounds long %s while retaining the latest request and answer ends',
    async (padding) => {
      mockBaseLlm();
      const history: Content[] = [
        {
          role: 'user',
          parts: [{ text: 'Original: analyze only, do not edit.' }],
        },
        { role: 'model', parts: [{ text: 'Earlier answer.' }] },
        ...Array.from(
          { length: 10 },
          (_, index): Content => ({
            role: 'user',
            parts: [
              { text: `Earlier user ${index}: ${padding.repeat(1_000)}` },
            ],
          }),
        ),
        {
          role: 'user',
          parts: [
            { text: `Latest request: ${padding.repeat(1_000)}No deployment.` },
          ],
        },
        {
          role: 'model',
          parts: [
            {
              text: `Answer beginning: ${padding.repeat(2_000)}Final next step: inspect the report.`,
            },
          ],
        },
      ];
      const before = structuredClone(history);
      await suggest({ history, enableCacheSharing: false });

      const request = mockRunSideQuery.mock.calls[0][1];
      const context = request.contents[0].parts[0].text as string;
      expect(context.length).toBeLessThanOrEqual(4_000);
      expect(context).toContain('Latest request:');
      expect(context).toContain('No deployment.');
      expect(context).toContain('Answer beginning:');
      expect(context).toContain('Final next step: inspect the report.');
      expect(context).toContain('Earlier user 9:');
      expect(context).not.toContain('Earlier answer.');
      expect(context.indexOf('Earlier user 9:')).toBeLessThan(
        context.indexOf('Latest request:'),
      );
      expect(context.indexOf('Latest request:')).toBeLessThan(
        context.indexOf('Answer beginning:'),
      );
      expect(request.contents[1].parts[0].text).toBe(SUGGESTION_PROMPT);
      expect(history).toEqual(before);
    },
  );

  it('keeps a recent earlier user constraint when space is available', async () => {
    mockBaseLlm();
    const history: Content[] = [
      {
        role: 'user',
        parts: [{ text: 'Only analyze the failure. Do not edit or deploy.' }],
      },
      { role: 'model', parts: [{ text: 'I will inspect the data.' }] },
      { role: 'user', parts: [{ text: 'Focus on the slow query.' }] },
      {
        role: 'model',
        parts: [{ text: 'The query plan identifies the issue.' }],
      },
    ];
    await suggest({ history, enableCacheSharing: false });

    expect(
      mockRunSideQuery.mock.calls[0][1].contents[0].parts[0].text,
    ).toContain('Do not edit or deploy.');
  });

  it('summarizes only current-turn tool results without forwarding protocol blocks or large payloads', async () => {
    mockBaseLlm();
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'Old request' }] },
      { role: 'model', parts: [{ text: 'Old answer' }] },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'old_tool',
              response: { error: 'stale error' },
            },
          },
        ],
      },
      { role: 'user', parts: [{ text: 'Diagnose without editing.' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'run_shell_command',
              args: { command: 'private command arguments' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read_file',
              response: {
                output: `raw body ${'x'.repeat(50_000)}important output tail`,
              },
            },
          },
          {
            functionResponse: {
              name: 'run_shell_command',
              response: {
                error: `details ${'y'.repeat(50_000)}permission denied`,
              },
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [{ text: 'The command failed; assess the permission.' }],
      },
    ];
    await suggest({ history, enableCacheSharing: false });

    const request = mockRunSideQuery.mock.calls[0][1];
    const context = request.contents[0].parts[0].text as string;
    expect(context).toContain('Diagnose without editing.');
    expect(context).toContain('Tool read_file: completed');
    expect(context).toContain('important output tail');
    expect(context).toContain('Tool run_shell_command: error');
    expect(context).toContain('permission denied');
    expect(context).not.toContain('old_tool');
    expect(context).not.toContain('private command arguments');
    expect(context).not.toContain('x'.repeat(500));
    expect(context.indexOf('Tool read_file:')).toBeLessThan(
      context.indexOf('Tool run_shell_command:'),
    );
    expect(
      request.contents.every((entry: Content) =>
        entry.parts?.every((part) => typeof part.text === 'string'),
      ),
    ).toBe(true);
  });

  it('excludes thinking, reminders, memory metadata and image payloads', async () => {
    mockBaseLlm();
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'Original request' }] },
      { role: 'model', parts: [{ text: 'Hidden thinking', thought: true }] },
      {
        role: 'user',
        parts: [
          {
            text: '<system-reminder>Internal memory</system-reminder>Latest real request',
          },
          {
            inlineData: { mimeType: 'image/png', data: 'private image bytes' },
          },
          { fileData: { mimeType: 'text/plain', fileUri: 'private file URI' } },
          {
            text: 'Internal memory catalog',
            partMetadata: { 'qwen-code:memory-catalog-snapshot': true },
          },
        ],
      },
      {
        role: 'model',
        parts: [
          { text: 'Secret reasoning', thought: true },
          { text: 'Visible final answer' },
        ],
      },
    ];
    await suggest({ history, enableCacheSharing: false });

    const context = mockRunSideQuery.mock.calls[0][1].contents[0].parts[0]
      .text as string;
    expect(context).toContain('Original request');
    expect(context).toContain('Latest real request');
    expect(context).toContain('Visible final answer');
    expect(context).not.toMatch(
      /Hidden thinking|Secret reasoning|Internal memory|private|system-reminder/,
    );
  });

  it('skips an empty visible context without making a model request', async () => {
    await suggest({
      enableCacheSharing: false,
      history: [
        { role: 'model', parts: [{ text: 'thinking 1', thought: true }] },
        { role: 'model', parts: [{ text: 'thinking 2', thought: true }] },
      ],
    });
    expect(mockRunSideQuery).not.toHaveBeenCalled();
  });

  it('skips an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await suggest({ signal: controller.signal });

    expect(result).toEqual({ suggestion: null });
    expect(mockGetCacheSafeParams).not.toHaveBeenCalled();
    expect(mockRunSideQuery).not.toHaveBeenCalled();
    expect(mockRunForkedAgent).not.toHaveBeenCalled();
  });

  it('discards a late suggestion after cancellation', async () => {
    const controller = new AbortController();
    mockRunSideQuery.mockImplementation(async () => {
      controller.abort();
      return { text: 'run tests' };
    });
    const result = await suggest({
      signal: controller.signal,
      enableCacheSharing: false,
    });

    expect(result).toEqual({ suggestion: null });
  });
});

describe('shouldFilterSuggestion', () => {
  it('filters "done"', () => {
    expect(shouldFilterSuggestion('done')).toBe(true);
  });

  it('filters meta-text', () => {
    expect(shouldFilterSuggestion('nothing found')).toBe(true);
    expect(shouldFilterSuggestion('no suggestion needed')).toBe(true);
    expect(shouldFilterSuggestion('silence')).toBe(true);
    expect(shouldFilterSuggestion('staying silent here')).toBe(true);
  });

  it('filters meta-wrapped text', () => {
    expect(shouldFilterSuggestion('(silence)')).toBe(true);
    expect(shouldFilterSuggestion('[no suggestion]')).toBe(true);
  });

  it('filters error messages', () => {
    expect(shouldFilterSuggestion('api error: 500')).toBe(true);
    expect(shouldFilterSuggestion('prompt is too long')).toBe(true);
  });

  it('filters prefixed labels', () => {
    expect(shouldFilterSuggestion('Suggestion: commit this')).toBe(true);
  });

  it('filters single words not in whitelist', () => {
    expect(shouldFilterSuggestion('hmm')).toBe(true);
    expect(shouldFilterSuggestion('maybe')).toBe(true);
  });

  it('allows whitelisted single words', () => {
    expect(shouldFilterSuggestion('yes')).toBe(false);
    expect(shouldFilterSuggestion('commit')).toBe(false);
    expect(shouldFilterSuggestion('push')).toBe(false);
    expect(shouldFilterSuggestion('no')).toBe(false);
  });

  it('allows slash commands as single word', () => {
    expect(shouldFilterSuggestion('/commit')).toBe(false);
  });

  it('uses character bounds for CJK suggestions', () => {
    expect(shouldFilterSuggestion('运行测试')).toBe(false);
    expect(shouldFilterSuggestion('テストを実行')).toBe(false);
    expect(shouldFilterSuggestion('테스트실행')).toBe(false);
    expect(getFilterReason('好')).toBe('too_few_words');
    expect(getFilterReason('运'.repeat(31))).toBe('too_many_words');
  });

  it('counts words with a segmenter for Thai, Lao, Khmer and Myanmar suggestions', () => {
    // These scripts are written without spaces between words, so a whole
    // suggestion is one whitespace-delimited "word".
    expect(getFilterReason('รันเทสต์อีกครั้ง')).toBeNull(); // Thai
    expect(getFilterReason('แก้บั๊กนี้ให้หน่อย')).toBeNull(); // Thai
    expect(getFilterReason('ແລ່ນການທົດສອບ')).toBeNull(); // Lao
    expect(getFilterReason('ដំណើរការតេស្ត')).toBeNull(); // Khmer
    expect(getFilterReason('စမ်းသပ်မှုလုပ်ပါ')).toBeNull(); // Myanmar
    expect(getFilterReason('ใช่')).toBeNull(); // "yes"
    // Long but within 12 words: the CJK 30-char cap would reject these.
    expect(getFilterReason('ช่วยรันเทสต์ทั้งหมดอีกครั้งหนึ่ง')).toBeNull();
    expect(
      getFilterReason('ช่วยรันเทสต์ทั้งหมด แล้ว commit ให้หน่อย'),
    ).toBeNull();
    expect(getFilterReason('ก')).toBe('too_few_words');
    expect(
      getFilterReason(
        'ช่วยรันเทสต์ทั้งหมดอีกครั้งแล้วแก้บั๊กที่เจอและอธิบายสาเหตุให้ละเอียด',
      ),
    ).toBe('too_many_words');
    // Cases where the word count and the 60-character fallback disagree, so
    // they fail if the segmenter is silently disabled.
    // 37 characters, 13 words: over the 12-word window.
    expect(getFilterReason('กดปุ่มนี้แล้วรอสักครู่นะครับผมจะไปเอง')).toBe(
      'too_many_words',
    );
    // 76 characters, 11 words: over the fallback cap, within the window.
    expect(
      getFilterReason(
        'ปรับปรุงประสิทธิภาพการประมวลผลฐานข้อมูลอิเล็กทรอนิกส์ของมหาวิทยาลัยเทคโนโลยี',
      ),
    ).toBeNull();
  });

  // Thai mixed with paths or commands: few whitespace words, but many
  // segments and over the 60-character fallback.
  const MIXED_WITH_SPACES = [
    'รันเทสต์ใน packages/core/src/followup และ packages/cli/src/ui ให้หน่อย',
    'รัน npx vitest run src/followupแล้วรายงานผลให้ฟังหน่อยนะครับ',
  ];

  it('keeps the slash command exemption for these scripts', () => {
    // 61 characters and 15 segments: over both bounds without the exemption.
    const slash =
      '/อธิบายโค้ดส่วนนี้ให้ละเอียดหน่อยนะครับผมอยากเข้าใจมันมากขึ้น';
    expect(getFilterReason(slash)).toBeNull();
    _setWordSegmenterForTest(null);
    try {
      expect(getFilterReason(slash)).toBeNull();
    } finally {
      _setWordSegmenterForTest(undefined);
    }
  });

  it('keeps whitespace bounds for these scripts when the suggestion has spaces', () => {
    for (const suggestion of MIXED_WITH_SPACES) {
      expect(getFilterReason(suggestion)).toBeNull();
    }
    _setWordSegmenterForTest(null);
    try {
      for (const suggestion of MIXED_WITH_SPACES) {
        expect(getFilterReason(suggestion)).toBeNull();
      }
    } finally {
      _setWordSegmenterForTest(undefined);
    }
  });

  it('falls back to a character bound for these scripts without full ICU', () => {
    _setWordSegmenterForTest(null);
    try {
      expect(getFilterReason('รันเทสต์อีกครั้ง')).toBeNull();
      expect(getFilterReason('ก')).toBe('too_few_words');
      expect(getFilterReason('ก'.repeat(61))).toBe('too_many_words');
    } finally {
      _setWordSegmenterForTest(undefined);
    }
  });

  it('does not create a segmenter on a small-icu build', () => {
    // process.config.variables is frozen, but process.config itself is
    // reconfigurable (see withIcuSmall in packages/cli/src/startup/icu-check.test.ts).
    const original = Object.getOwnPropertyDescriptor(process, 'config')!;
    const withIcuSmall = (value: unknown, fn: () => void) => {
      const variables = {
        ...(original.value as { variables: Record<string, unknown> }).variables,
        icu_small: value,
      };
      Object.defineProperty(process, 'config', {
        ...original,
        value: { ...(original.value as object), variables },
      });
      _setWordSegmenterForTest(undefined);
      try {
        fn();
      } finally {
        Object.defineProperty(process, 'config', original);
        _setWordSegmenterForTest(undefined);
      }
    };
    // 76 characters, 11 words: only the segmenter lets it through.
    const long =
      'ปรับปรุงประสิทธิภาพการประมวลผลฐานข้อมูลอิเล็กทรอนิกส์ของมหาวิทยาลัยเทคโนโลยี';
    withIcuSmall(true, () => {
      expect(getFilterReason(long)).toBe('too_many_words');
    });
    withIcuSmall(false, () => {
      expect(getFilterReason(long)).toBeNull();
    });
  });

  it('filters too many words', () => {
    expect(
      shouldFilterSuggestion(
        'this is a very long suggestion with way too many words in it to show',
      ),
    ).toBe(true);
  });

  it('filters suggestions >= 100 chars', () => {
    expect(shouldFilterSuggestion('a'.repeat(100))).toBe(true);
  });

  it('filters multiple sentences', () => {
    expect(shouldFilterSuggestion('Run the tests. Then commit.')).toBe(true);
    expect(shouldFilterSuggestion('Hello! How are you?')).toBe(true);
    expect(shouldFilterSuggestion('Do this. Then do that.')).toBe(true);
    // Abbreviation skipped, then real sentence boundary detected
    expect(shouldFilterSuggestion('Check Dr. Smith. Then commit.')).toBe(true);
    // Non-word char before punctuation — still detected as sentence boundary
    expect(shouldFilterSuggestion('Run (see docs). Then deploy')).toBe(true);
  });

  it('does not filter abbreviations as multiple sentences', () => {
    // Issue #6077 — "vs." followed by a capitalized word should pass.
    expect(
      shouldFilterSuggestion(
        "Let's start with the Weeds vs. Wildflowers audit.",
      ),
    ).toBe(false);
    expect(shouldFilterSuggestion('Weeds vs. Wildflowers audit')).toBe(false);
    // Common honorifics and abbreviations
    expect(shouldFilterSuggestion('Check Dr. Smith notes')).toBe(false);
    expect(shouldFilterSuggestion('Ask Mr. Jones for help')).toBe(false);
    expect(shouldFilterSuggestion('Talk to Ms. Patel next')).toBe(false);
    expect(shouldFilterSuggestion('See Prof. Lee today')).toBe(false);
    expect(shouldFilterSuggestion('Visit St. Petersburg office')).toBe(false);
    expect(shouldFilterSuggestion('Check etc. Tasks remaining')).toBe(false);
    expect(shouldFilterSuggestion('Review options etc. Then commit')).toBe(
      false,
    );
    // Latin shorthands with an internal period
    expect(shouldFilterSuggestion('Use e.g. Docker to build')).toBe(false);
    expect(shouldFilterSuggestion('Use i.e. Docker to build')).toBe(false);
    // Capitalized variants still recognized as abbreviations
    expect(shouldFilterSuggestion('Use E.g. Docker to build')).toBe(false);
    expect(shouldFilterSuggestion('Use I.e. Docker to build')).toBe(false);
  });

  it('filters formatting', () => {
    expect(shouldFilterSuggestion('run the **tests**')).toBe(true);
    expect(shouldFilterSuggestion('line1\nline2')).toBe(true);
  });

  it('filters control characters and ANSI escapes', () => {
    expect(shouldFilterSuggestion('run\rtests')).toBe(true); // carriage return
    expect(shouldFilterSuggestion('run\x1b[31mtests')).toBe(true); // ESC/CSI
    expect(shouldFilterSuggestion('run\ttests')).toBe(true); // tab (C0)
    expect(shouldFilterSuggestion('run\x7ftests')).toBe(true); // DEL
    expect(shouldFilterSuggestion('run\x9btests')).toBe(true); // C1 CSI
    expect(getFilterReason('run\x1b[31mtests')).toBe('control_chars');
  });

  it('filters evaluative language', () => {
    expect(shouldFilterSuggestion('looks good to me')).toBe(true);
    expect(shouldFilterSuggestion('thanks for the help')).toBe(true);
    expect(shouldFilterSuggestion('that works perfectly')).toBe(true);
  });

  it('filters AI-voice patterns', () => {
    expect(shouldFilterSuggestion('Let me check that')).toBe(true);
    expect(shouldFilterSuggestion("I'll run the tests")).toBe(true);
    expect(shouldFilterSuggestion("Here's what I found")).toBe(true);
  });

  it('does not false-positive on evaluative substrings', () => {
    expect(shouldFilterSuggestion('run nicely formatted tests')).toBe(false);
    expect(shouldFilterSuggestion('fix the greatest issue')).toBe(false);
    expect(shouldFilterSuggestion('create thanksgiving banner')).toBe(false);
  });

  it('allows good suggestions', () => {
    expect(shouldFilterSuggestion('run the tests')).toBe(false);
    expect(shouldFilterSuggestion('commit this')).toBe(false);
    expect(shouldFilterSuggestion('try it out')).toBe(false);
    expect(shouldFilterSuggestion('push it')).toBe(false);
    expect(shouldFilterSuggestion('create a PR')).toBe(false);
  });
});
