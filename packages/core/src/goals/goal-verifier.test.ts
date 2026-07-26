/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { BaseLlmClient } from '../core/baseLlmClient.js';
import {
  createGoalVerifier,
  GoalVerifierInputTooLargeError,
  parseGoalVerifierText,
  type GoalVerifierInput,
} from './goal-verifier.js';

function input(): GoalVerifierInput {
  return {
    goal: {
      goalId: 'goal-1',
      revision: 2,
      objective: 'Make all tests pass',
    },
    proposal: {
      status: 'complete',
      reason: 'The focused suite passed',
      evidenceRefs: ['tool-1'],
    },
    evidence: [
      {
        uuid: 'tool-1',
        provenance: 'tool_result',
        turnId: 'turn-3',
        preview: '18 tests passed',
        proofKind: 'external_fact',
        content: '18 tests passed',
      },
    ],
    currentDeliveredOutput: ['Implementation and verification are complete.'],
  };
}

function configFor(reply: string) {
  const generateText = vi.fn().mockResolvedValue({
    text: reply,
    usage: undefined,
  });
  const baseLlmClient = {
    generateText,
    generateJson: vi.fn(),
  } as unknown as BaseLlmClient;
  const config = {
    getBaseLlmClient: vi.fn().mockReturnValue(baseLlmClient),
    getFastModel: vi.fn().mockReturnValue('fast-model'),
    getModel: vi.fn().mockReturnValue('main-model'),
    getOutputLanguageFilePath: vi.fn(),
  } as unknown as Config;
  return { config, generateText };
}

describe('parseGoalVerifierText', () => {
  it('parses only the exact bounded result union', () => {
    expect(
      parseGoalVerifierText('{"decision":"accept","reason":"grounded"}'),
    ).toEqual({ decision: 'accept', reason: 'grounded' });
    expect(
      parseGoalVerifierText('{"decision":"reject","reason":"insufficient"}'),
    ).toEqual({ decision: 'reject', reason: 'insufficient' });
  });

  it.each([
    '```json\n{"decision":"accept","reason":"grounded"}\n```',
    '{"decision":"accept","reason":"grounded","extra":true}',
    '{"decision":"maybe","reason":"grounded"}',
    '{"decision":"accept","reason":"   "}',
  ])('rejects non-exact output: %s', (reply) => {
    expect(() => parseGoalVerifierText(reply)).toThrow(/goal verifier/i);
  });

  it('rejects an overlong reason before trimming', () => {
    expect(() =>
      parseGoalVerifierText(
        JSON.stringify({
          decision: 'accept',
          reason: `${' '.repeat(2_000)}x`,
        }),
      ),
    ).toThrow(/too long/i);
  });
});

describe('createGoalVerifier', () => {
  it('uses a tool-free deterministic side query with bounded fields', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"grounded"}',
    );
    const value = input() as GoalVerifierInput & { fullHistory?: string[] };
    value.fullHistory = ['must not leak'];

    await expect(createGoalVerifier(config)(value)).resolves.toEqual({
      decision: 'accept',
      reason: 'grounded',
    });

    const request = generateText.mock.calls[0]![0] as Parameters<
      BaseLlmClient['generateText']
    >[0];
    expect(request).toMatchObject({
      model: 'fast-model',
      promptId: 'side-query:goal-verifier',
      maxAttempts: 1,
      config: {
        temperature: 0,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
      },
    });
    expect(request).not.toHaveProperty('tools');
    const payload = JSON.parse(
      request.contents[0]?.parts?.[0]?.text ?? '',
    ) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('fullHistory');
    expect(JSON.stringify(payload)).not.toContain('preview');
    expect(request.systemInstruction).toContain(
      'Never require evidence that update_goal itself was called',
    );
  });

  it('includes blocked policy only for blocked proposals', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"requires authority"}',
    );
    const value: GoalVerifierInput = {
      ...input(),
      proposal: {
        status: 'blocked',
        reason: 'A user choice is required',
        evidenceRefs: ['tool-1'],
        blockerKind: 'authority',
      },
      blockedPolicy: 'Authority blockers may stop immediately.',
    };

    await createGoalVerifier(config)(value);

    const request = generateText.mock.calls[0]![0] as Parameters<
      BaseLlmClient['generateText']
    >[0];
    expect(
      JSON.parse(request.contents[0]?.parts?.[0]?.text ?? ''),
    ).toMatchObject({
      blockedPolicy: 'Authority blockers may stop immediately.',
    });
  });

  it('rejects an unbounded verifier request before calling the provider', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"grounded"}',
    );
    const value = input();
    value.currentDeliveredOutput = ['x'.repeat(64_000)];

    await expect(createGoalVerifier(config)(value)).rejects.toBeInstanceOf(
      GoalVerifierInputTooLargeError,
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it('propagates provider failure and clears its timeout', async () => {
    const { config, generateText } = configFor('unused');
    generateText.mockRejectedValue(new Error('provider unavailable'));
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    try {
      await expect(createGoalVerifier(config)(input())).rejects.toThrow(
        'provider unavailable',
      );
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  it('combines caller cancellation with its timeout', async () => {
    const { config, generateText } = configFor('unused');
    const caller = new AbortController();
    let signal: AbortSignal | undefined;
    generateText.mockImplementation(async (request) => {
      signal = request.abortSignal;
      await new Promise<never>((_resolve, reject) => {
        request.abortSignal.addEventListener(
          'abort',
          () => reject(request.abortSignal.reason),
          { once: true },
        );
      });
      throw new Error('unreachable');
    });

    const verification = createGoalVerifier(config, { timeoutMs: 1_000 })(
      input(),
      caller.signal,
    );
    await vi.waitFor(() => expect(signal).toBeDefined());
    caller.abort(new Error('attempt superseded'));

    await expect(verification).rejects.toThrow('attempt superseded');
    expect(signal?.aborted).toBe(true);
  });
});
