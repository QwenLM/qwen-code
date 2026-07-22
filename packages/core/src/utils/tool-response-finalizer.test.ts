/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Part } from '@google/genai';
import type { Config } from '../config/config.js';
import { getPlanModeSystemReminder } from '../core/prompts.js';
import { ToolNames } from '../tools/tool-names.js';
import {
  enforceFunctionResponseBudget,
  finalizeToolResponses,
  toolResponseTextLength,
  type ToolResponseBudgetEntry,
} from './tool-response-finalizer.js';
import { persistAndTruncateToolResult } from './truncation.js';

const debugLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./debugLogger.js', () => ({
  createDebugLogger: () => debugLogger,
}));

vi.mock('./truncation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./truncation.js')>();
  return {
    ...actual,
    persistAndTruncateToolResult: vi.fn(),
  };
});

const persist = vi.mocked(persistAndTruncateToolResult);

function entry(
  callId: string,
  responseParts: Part[],
  persistedOutputFiles?: string[],
): ToolResponseBudgetEntry {
  return {
    callId,
    toolName: 'shell',
    responseParts,
    persistedOutputFiles,
  };
}

function config(budget: number): Config {
  return {
    getToolOutputBatchBudget: () => budget,
  } as Config;
}

describe('tool response finalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persist.mockImplementation(async (callId, _toolName, content) => ({
      content,
      outputFile: `/tmp/${callId}.txt`,
      bytesWritten: Buffer.byteLength(content),
    }));
  });

  it('leaves a batch within budget unchanged', async () => {
    const entries = [
      entry('small', [
        {
          functionResponse: {
            id: 'small',
            name: 'shell',
            response: { output: 'small output' },
          },
        },
      ]),
    ];

    await expect(finalizeToolResponses(config(100), entries)).resolves.toBe(
      entries,
    );
    expect(persist).not.toHaveBeenCalled();
    expect(debugLogger.info).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'preserves the plan-mode lifecycle reminder outside the output budget (planOnly=%s)',
    async (planOnly) => {
      const reminder = getPlanModeSystemReminder(planOnly);
      const entries: ToolResponseBudgetEntry[] = [
        {
          callId: 'enter-plan',
          toolName: ToolNames.ENTER_PLAN_MODE,
          responseParts: [
            {
              functionResponse: {
                id: 'enter-plan',
                name: ToolNames.ENTER_PLAN_MODE,
                response: { output: reminder },
              },
            },
          ],
        },
      ];

      await expect(finalizeToolResponses(config(1), entries)).resolves.toBe(
        entries,
      );
      expect(persist).not.toHaveBeenCalled();
    },
  );

  it('budgets hook context appended after the plan-mode lifecycle reminder', async () => {
    const reminder = getPlanModeSystemReminder(false);
    const hookContext = `\n\n${'hook-context'.repeat(1000)}`;
    const entries: ToolResponseBudgetEntry[] = [
      {
        callId: 'enter-plan',
        toolName: ToolNames.ENTER_PLAN_MODE,
        responseParts: [
          {
            functionResponse: {
              id: 'enter-plan',
              name: ToolNames.ENTER_PLAN_MODE,
              response: { output: `${reminder}${hookContext}` },
            },
          },
        ],
      },
    ];

    const result = await finalizeToolResponses(config(100), entries);
    const output = result[0].responseParts[0].functionResponse?.response?.[
      'output'
    ] as string;

    expect(output.startsWith(reminder)).toBe(true);
    expect(output.length).toBeLessThanOrEqual(reminder.length + 2 + 100);
    expect(output.length).toBeLessThan(reminder.length + hookContext.length);
    expect(persist).toHaveBeenCalledWith(
      'enter-plan',
      ToolNames.ENTER_PLAN_MODE,
      hookContext.slice(2),
      expect.anything(),
    );
  });

  it('keeps hook context budgeted across both scheduler finalization passes', async () => {
    const reminder = getPlanModeSystemReminder(false);
    const entries: ToolResponseBudgetEntry[] = [
      {
        callId: 'enter-plan',
        toolName: ToolNames.ENTER_PLAN_MODE,
        responseParts: [
          {
            functionResponse: {
              id: 'enter-plan',
              name: ToolNames.ENTER_PLAN_MODE,
              response: { output: `${reminder}\n\n${'first'.repeat(1000)}` },
            },
          },
        ],
      },
    ];

    const firstPass = await finalizeToolResponses(config(100), entries);
    const firstOutput = firstPass[0].responseParts[0].functionResponse
      ?.response?.['output'] as string;
    const secondPassInput: ToolResponseBudgetEntry[] = [
      {
        ...firstPass[0],
        responseParts: [
          {
            functionResponse: {
              id: 'enter-plan',
              name: ToolNames.ENTER_PLAN_MODE,
              response: {
                output: `${firstOutput}\n\n${'second'.repeat(1000)}`,
              },
            },
          },
        ],
      },
    ];

    const secondPass = await finalizeToolResponses(
      config(100),
      secondPassInput,
    );
    const output = secondPass[0].responseParts[0].functionResponse?.response?.[
      'output'
    ] as string;

    expect(output.startsWith(`${reminder}\n\n`)).toBe(true);
    expect(output.length).toBeLessThanOrEqual(reminder.length + 2 + 100);
    expect(output).not.toContain('second'.repeat(1000));
  });

  it('still bounds enter_plan_mode failures', async () => {
    const entries: ToolResponseBudgetEntry[] = [
      {
        callId: 'enter-plan',
        toolName: ToolNames.ENTER_PLAN_MODE,
        responseParts: [
          {
            functionResponse: {
              id: 'enter-plan',
              name: ToolNames.ENTER_PLAN_MODE,
              response: { error: 'x'.repeat(1000) },
            },
          },
        ],
      },
    ];

    const result = await finalizeToolResponses(config(100), entries);
    const error =
      result[0].responseParts[0].functionResponse?.response?.['error'];

    expect(typeof error).toBe('string');
    expect((error as string).length).toBeLessThanOrEqual(100);
  });

  it('does not exempt arbitrary enter_plan_mode output', async () => {
    const entries: ToolResponseBudgetEntry[] = [
      {
        callId: 'enter-plan',
        toolName: ToolNames.ENTER_PLAN_MODE,
        responseParts: [
          {
            functionResponse: {
              id: 'enter-plan',
              name: ToolNames.ENTER_PLAN_MODE,
              response: { output: 'untrusted'.repeat(1000) },
            },
          },
        ],
      },
    ];

    const result = await finalizeToolResponses(config(100), entries);
    const output = result[0].responseParts[0].functionResponse?.response?.[
      'output'
    ] as string;

    expect(output.length).toBeLessThanOrEqual(100);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('counts protected lifecycle output in response metadata', () => {
    const reminder = getPlanModeSystemReminder(false);
    const parts: Part[] = [
      {
        functionResponse: {
          id: 'enter-plan',
          name: ToolNames.ENTER_PLAN_MODE,
          response: { output: reminder },
        },
      },
    ];

    expect(toolResponseTextLength(parts)).toBe(reminder.length);
  });

  it('hard-caps producer-truncated responses without writing them again', async () => {
    const prefix = 'Tool output was too large and has been truncated';
    const entries = [
      entry(
        'one',
        [
          {
            functionResponse: {
              id: 'one',
              name: 'shell',
              response: { output: `${prefix}${'a'.repeat(7000)}` },
            },
          },
        ],
        ['/tmp/one.output'],
      ),
      entry(
        'two',
        [
          {
            functionResponse: {
              id: 'two',
              name: 'shell',
              response: { output: `${prefix}${'b'.repeat(7000)}` },
            },
          },
        ],
        ['/tmp/two.output'],
      ),
    ];

    const result = await finalizeToolResponses(config(10_000), entries);

    expect(
      result.reduce(
        (total, item) => total + toolResponseTextLength(item.responseParts),
        0,
      ),
    ).toBeLessThanOrEqual(10_000);
    expect(persist).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain('/tmp/one.output');
    expect(JSON.stringify(result)).toContain('/tmp/two.output');
    expect(JSON.stringify(result)).not.toContain('Full output:');
    expect(JSON.stringify(result)).toContain('Persisted tool-output artifact:');
    expect(debugLogger.info).toHaveBeenCalledWith(
      'Tool response budget (10000 chars): reduced 2 result(s) from 14096 to 10000 chars.',
    );
  });

  it('keeps every producer artifact path visible when the budget permits', async () => {
    const entries = [
      entry(
        'multi-artifact',
        [
          {
            functionResponse: {
              id: 'multi-artifact',
              name: 'mcp',
              response: { output: 'x'.repeat(10_000) },
            },
          },
        ],
        ['/tmp/first.output', '/tmp/second.output'],
      ),
    ];

    const result = await finalizeToolResponses(config(500), entries);
    const output = result[0].responseParts[0].functionResponse?.response?.[
      'output'
    ] as string;

    expect(output).toContain('/tmp/first.output');
    expect(output).toContain('/tmp/second.output');
    expect(persist).not.toHaveBeenCalled();
  });

  it('counts output, error, and top-level text while preserving media', async () => {
    const media: Part = {
      inlineData: { mimeType: 'image/png', data: 'BASE64' },
    };
    const entries = [
      entry('mixed', [
        {
          functionResponse: {
            id: 'mixed',
            name: 'shell',
            response: {
              output: 'o'.repeat(4000),
              error: 'e'.repeat(4000),
            },
          },
        },
        { text: 't'.repeat(4000) },
        media,
      ]),
    ];

    const result = await finalizeToolResponses(config(3000), entries);

    expect(toolResponseTextLength(result[0].responseParts)).toBeLessThanOrEqual(
      3000,
    );
    expect(result[0].responseParts[2]).toBe(media);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result[0].persistedOutputFiles).toEqual(['/tmp/mixed.txt']);
  });

  it('enforces the cap when persistence has already failed', async () => {
    const entries = [
      entry(
        'failed',
        [
          {
            functionResponse: {
              id: 'failed',
              name: 'shell',
              response: { output: 'x'.repeat(10_000) },
            },
          },
        ],
        [],
      ),
    ];

    const result = await finalizeToolResponses(config(500), entries);

    expect(toolResponseTextLength(result[0].responseParts)).toBeLessThanOrEqual(
      500,
    );
    expect(persist).not.toHaveBeenCalled();
  });

  it('enforces the cap when persistence throws', async () => {
    persist.mockRejectedValueOnce(new Error('disk unavailable'));
    const entries = [
      entry('throws', [
        {
          functionResponse: {
            id: 'throws',
            name: 'shell',
            response: { output: 'x'.repeat(10_000) },
          },
        },
      ]),
    ];

    const result = await finalizeToolResponses(config(500), entries);

    expect(toolResponseTextLength(result[0].responseParts)).toBeLessThanOrEqual(
      500,
    );
    expect(result[0].persistedOutputFiles).toEqual([]);
  });

  it('uses distinct artifact paths for duplicate call ids', async () => {
    const responseParts = (value: string): Part[] => [
      {
        functionResponse: {
          id: 'duplicate',
          name: 'shell',
          response: { output: value.repeat(1000) },
        },
      },
    ];
    const entries = [
      entry('duplicate', responseParts('a')),
      entry('duplicate', responseParts('b')),
    ];

    const result = await finalizeToolResponses(config(100), entries);

    expect(persist).toHaveBeenNthCalledWith(
      1,
      'duplicate-1',
      'shell',
      'a'.repeat(1000),
      expect.anything(),
    );
    expect(persist).toHaveBeenNthCalledWith(
      2,
      'duplicate-2',
      'shell',
      'b'.repeat(1000),
      expect.anything(),
    );
    expect(result[0].persistedOutputFiles).toEqual(['/tmp/duplicate-1.txt']);
    expect(result[1].persistedOutputFiles).toEqual(['/tmp/duplicate-2.txt']);
  });

  it('avoids collisions between duplicate ids and natural suffix ids', async () => {
    const responseParts = (callId: string, value: string): Part[] => [
      {
        functionResponse: {
          id: callId,
          name: 'shell',
          response: { output: value.repeat(1000) },
        },
      },
    ];
    const entries = [
      entry('call', responseParts('call', 'a')),
      entry('call', responseParts('call', 'b')),
      entry('call-1', responseParts('call-1', 'c')),
    ];

    await finalizeToolResponses(config(100), entries);

    expect(persist.mock.calls.map(([callId]) => callId)).toEqual([
      'call-2',
      'call-3',
      'call-1',
    ]);
  });

  it('avoids collisions after call ids are normalized to basenames', async () => {
    const responseParts = (callId: string, value: string): Part[] => [
      {
        functionResponse: {
          id: callId,
          name: 'shell',
          response: { output: value.repeat(1000) },
        },
      },
    ];
    const entries = [
      entry('dir/call', responseParts('dir/call', 'a')),
      entry('call', responseParts('call', 'b')),
    ];

    await finalizeToolResponses(config(100), entries);

    expect(persist.mock.calls.map(([callId]) => callId)).toEqual([
      'call-1',
      'call-2',
    ]);
  });

  it('does not persist or rewrite responses when the budget is disabled', async () => {
    const entries = [
      entry('disabled', [
        {
          functionResponse: {
            id: 'disabled',
            name: 'shell',
            response: { output: 'x'.repeat(10_000) },
          },
        },
      ]),
    ];

    await expect(
      finalizeToolResponses(config(Number.POSITIVE_INFINITY), entries),
    ).resolves.toBe(entries);
    expect(persist).not.toHaveBeenCalled();
  });

  it('does not split UTF-16 surrogate pairs', () => {
    const entries = [
      entry('unicode', [
        {
          functionResponse: {
            id: 'unicode',
            name: 'shell',
            response: { output: '😀'.repeat(1000) },
          },
        },
      ]),
    ];

    const result = enforceFunctionResponseBudget(entries, 201);
    const output =
      result[0].responseParts[0].functionResponse?.response?.['output'];

    expect(typeof output).toBe('string');
    expect((output as string).length).toBeLessThanOrEqual(201);
    expect((output as string).includes('\uFFFD')).toBe(false);
    for (let index = 0; index < (output as string).length; index++) {
      const code = (output as string).charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = (output as string).charCodeAt(index + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
        index++;
      } else {
        expect(code < 0xdc00 || code > 0xdfff).toBe(true);
      }
    }
  });

  it('the send guard caps function responses without touching user text', () => {
    const userText = 'user'.repeat(1000);
    const entries = [
      entry('send', [
        { text: userText },
        {
          functionResponse: {
            id: 'send',
            name: 'shell',
            response: { output: 'x'.repeat(1000) },
          },
        },
      ]),
    ];

    const result = enforceFunctionResponseBudget(entries, 100);

    expect(result[0].responseParts[0].text).toBe(userText);
    const output =
      result[0].responseParts[1].functionResponse?.response?.['output'];
    expect(typeof output).toBe('string');
    expect((output as string).length).toBeLessThanOrEqual(100);
  });

  it('the send guard preserves an enter_plan_mode lifecycle response', () => {
    const reminder = getPlanModeSystemReminder(false);
    const entries: ToolResponseBudgetEntry[] = [
      {
        callId: 'send-boundary',
        toolName: 'tool-response-batch',
        responseParts: [
          {
            functionResponse: {
              id: 'enter-plan',
              name: ToolNames.ENTER_PLAN_MODE,
              response: { output: reminder },
            },
          },
        ],
      },
    ];

    expect(enforceFunctionResponseBudget(entries, 1)).toBe(entries);
  });

  it('the send guard budgets hook context after an enter_plan_mode lifecycle response', () => {
    const reminder = getPlanModeSystemReminder(false);
    const entries: ToolResponseBudgetEntry[] = [
      {
        callId: 'send-boundary',
        toolName: 'tool-response-batch',
        responseParts: [
          {
            functionResponse: {
              id: 'enter-plan',
              name: ToolNames.ENTER_PLAN_MODE,
              response: { output: `${reminder}\n\n${'hook'.repeat(1000)}` },
            },
          },
        ],
      },
    ];

    const result = enforceFunctionResponseBudget(entries, 100);
    const output = result[0].responseParts[0].functionResponse?.response?.[
      'output'
    ] as string;

    expect(output.startsWith(reminder)).toBe(true);
    expect(output.length).toBeLessThanOrEqual(reminder.length + 2 + 100);
  });
});
