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
  parseGoalVerifierText,
  type GoalVerifierInput,
} from './goal-verifier.js';

function makeInput(): GoalVerifierInput {
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

function makeConfig(reply: string) {
  const generateText = vi.fn().mockResolvedValue({
    text: reply,
    usage: undefined,
  });
  const generateJson = vi.fn();
  const baseLlmClient = {
    generateText,
    generateJson,
  } as unknown as BaseLlmClient;
  const getOutputLanguageFilePath = vi
    .fn()
    .mockReturnValue('/must-not-read-output-language.md');
  const config = {
    getBaseLlmClient: vi.fn().mockReturnValue(baseLlmClient),
    getFastModel: vi.fn().mockReturnValue('fast-model'),
    getModel: vi.fn().mockReturnValue('main-model'),
    getOutputLanguageFilePath,
  } as unknown as Config;
  return {
    config,
    generateJson,
    generateText,
    getOutputLanguageFilePath,
  };
}

describe('parseGoalVerifierText', () => {
  it('parses the exact accept-reject union', () => {
    expect(
      parseGoalVerifierText('{"decision":"accept","reason":"grounded"}'),
    ).toEqual({ decision: 'accept', reason: 'grounded' });
    expect(
      parseGoalVerifierText('{"decision":"reject","reason":"insufficient"}'),
    ).toEqual({ decision: 'reject', reason: 'insufficient' });
  });

  it.each([
    '```json\n{"decision":"accept","reason":"grounded"}\n```',
    'Result: {"decision":"accept","reason":"grounded"}',
    '{"decision":"accept","reason":"grounded","extra":true}',
    '{"decision":"maybe","reason":"grounded"}',
    '{"decision":"accept","reason":"   "}',
  ])('rejects non-exact output: %s', (reply) => {
    expect(() => parseGoalVerifierText(reply)).toThrow(/goal verifier/i);
  });

  it('rejects a reason longer than the schema bound', () => {
    const reply = JSON.stringify({
      decision: 'accept',
      reason: 'x'.repeat(2_001),
    });

    expect(() => parseGoalVerifierText(reply)).toThrow(/too long/i);
  });

  it('applies the reason bound before trimming whitespace', () => {
    const reply = JSON.stringify({
      decision: 'accept',
      reason: `${' '.repeat(2_000)}x`,
    });

    expect(() => parseGoalVerifierText(reply)).toThrow(/too long/i);
  });
});

describe('createGoalVerifier', () => {
  it('uses the text side-query with an exact schema and no tools', async () => {
    const { config, generateJson, generateText, getOutputLanguageFilePath } =
      makeConfig('{"decision":"accept","reason":"grounded"}');

    await expect(createGoalVerifier(config)(makeInput())).resolves.toEqual({
      decision: 'accept',
      reason: 'grounded',
    });

    expect(generateJson).not.toHaveBeenCalled();
    expect(getOutputLanguageFilePath).not.toHaveBeenCalled();
    expect(generateText).toHaveBeenCalledTimes(1);
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
        responseJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            decision: { type: 'string', enum: ['accept', 'reject'] },
            reason: { type: 'string', minLength: 1, maxLength: 2_000 },
          },
          required: ['decision', 'reason'],
        },
        thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
      },
    });
    expect(request).not.toHaveProperty('tools');
    expect(request).not.toHaveProperty('toolConfig');
    expect(request.config).not.toHaveProperty('tools');
    expect(request.config).not.toHaveProperty('toolConfig');
    expect(request.systemInstruction).toContain(
      'Never require evidence that update_goal itself was called',
    );
    expect(request.systemInstruction).toContain(
      'Treat get_goal and update_goal as trusted protocol operations',
    );
  });

  it('projects only bounded verifier fields into the request', async () => {
    const { config, generateText } = makeConfig(
      '{"decision":"reject","reason":"needs stronger evidence"}',
    );
    const input = makeInput() as GoalVerifierInput & {
      fullHistory?: readonly string[];
    };
    input.fullHistory = ['must not leak'];

    await createGoalVerifier(config)(input);

    const request = generateText.mock.calls[0]![0] as Parameters<
      BaseLlmClient['generateText']
    >[0];
    const text = request.contents[0]?.parts?.[0]?.text;
    expect(typeof text).toBe('string');
    const payload = JSON.parse(text ?? '') as Record<string, unknown>;
    expect(payload).toEqual({
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
          proofKind: 'external_fact',
          content: '18 tests passed',
        },
      ],
      currentDeliveredOutput: ['Implementation and verification are complete.'],
    });
    expect(text).not.toContain('must not leak');
    expect(text).not.toContain('preview');
  });

  it('includes the blocked policy only for a blocked proposal', async () => {
    const { config, generateText } = makeConfig(
      '{"decision":"accept","reason":"requires user authority"}',
    );
    const input: GoalVerifierInput = {
      goal: makeInput().goal,
      proposal: {
        status: 'blocked',
        reason: 'A material user choice is required',
        evidenceRefs: ['user-1'],
        blockerKind: 'authority',
      },
      evidence: [
        {
          uuid: 'user-1',
          provenance: 'real_user',
          turnId: 'turn-3',
          preview: 'Wait for my approval',
          proofKind: 'user_input',
          content: 'Wait for my approval before publishing.',
        },
      ],
      blockedPolicy:
        'Authority blockers may stop when no meaningful in-scope work remains.',
    };

    await createGoalVerifier(config)(input);

    const request = generateText.mock.calls[0]![0] as Parameters<
      BaseLlmClient['generateText']
    >[0];
    const text = request.contents[0]?.parts?.[0]?.text ?? '';
    expect(JSON.parse(text)).toMatchObject({
      proposal: { status: 'blocked', blockerKind: 'authority' },
      blockedPolicy:
        'Authority blockers may stop when no meaningful in-scope work remains.',
    });
  });

  it('rejects malformed model output', async () => {
    const { config } = makeConfig(
      '```json\n{"decision":"accept","reason":"grounded"}\n```',
    );

    await expect(createGoalVerifier(config)(makeInput())).rejects.toThrow(
      /invalid json/i,
    );
  });

  it('propagates provider failures and clears the timeout', async () => {
    const { config, generateText } = makeConfig('unused');
    const providerError = new Error('provider unavailable');
    generateText.mockRejectedValue(providerError);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    try {
      await expect(createGoalVerifier(config)(makeInput())).rejects.toBe(
        providerError,
      );
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  it('aborts the underlying request at the verifier timeout', async () => {
    const { config, generateText } = makeConfig('unused');
    let capturedSignal: AbortSignal | undefined;
    generateText.mockImplementation(async (request) => {
      capturedSignal = request.abortSignal;
      await new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(request.abortSignal.reason);
        if (request.abortSignal.aborted) {
          rejectAbort();
          return;
        }
        request.abortSignal.addEventListener('abort', rejectAbort, {
          once: true,
        });
      });
      throw new Error('unreachable');
    });

    await expect(
      createGoalVerifier(config, { timeoutMs: 5 })(makeInput()),
    ).rejects.toThrow(/timed out after 5ms/i);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('combines the caller attempt signal with the timeout', async () => {
    const { config, generateText } = makeConfig('unused');
    const caller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    generateText.mockImplementation(async (request) => {
      capturedSignal = request.abortSignal;
      await new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(request.abortSignal.reason);
        request.abortSignal.addEventListener('abort', rejectAbort, {
          once: true,
        });
      });
      throw new Error('unreachable');
    });

    const verification = createGoalVerifier(config, { timeoutMs: 1_000 })(
      makeInput(),
      caller.signal,
    );
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    caller.abort(new Error('attempt superseded'));

    await expect(verification).rejects.toThrow('attempt superseded');
    expect(capturedSignal?.aborted).toBe(true);
  });
});
