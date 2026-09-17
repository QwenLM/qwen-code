/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { BaseLlmClient } from '../core/baseLlmClient.js';
import {
  buildGoalVerifierWindow,
  VERIFIER_MIDDLE_TRUNCATION_MARKER,
  type GoalEvidenceRecord,
} from './goal-evidence.js';
import {
  createGoalVerifier,
  GOAL_VERIFIER_REQUEST_BYTE_LIMIT,
  goalVerifierRequestByteLimit,
  GoalVerifierInputTooLargeError,
  measureGoalVerifierEnvelopeBytes,
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
    currentTurnId: 'turn-3',
    proposal: {
      status: 'complete',
      reason: 'The focused suite passed',
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
    evidenceTurnIds: ['turn-3'],
    omitted: 0,
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

function requestPayload(generateText: ReturnType<typeof vi.fn>) {
  const request = generateText.mock.calls[0]![0] as Parameters<
    BaseLlmClient['generateText']
  >[0];
  return {
    request,
    payload: JSON.parse(request.contents[0]?.parts?.[0]?.text ?? '') as Record<
      string,
      unknown
    >,
  };
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
  it('returns the side query usage alongside the decision', async () => {
    const { config, generateText } = configFor('');
    generateText.mockResolvedValue({
      text: '{"decision":"accept","reason":"grounded"}',
      usage: { totalTokenCount: 42 },
    });
    await expect(createGoalVerifier(config)(input())).resolves.toEqual({
      decision: 'accept',
      reason: 'grounded',
      usage: { totalTokenCount: 42 },
    });
  });

  it('uses a tool-free deterministic side query with bounded fields', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"grounded"}',
    );
    const value = input() as GoalVerifierInput & {
      fullHistory?: string[];
      proposal: { evidenceRefs?: string[] };
    };
    value.fullHistory = ['must not leak'];
    // A recorded proposal from before the window may still carry refs.
    value.proposal.evidenceRefs = ['stale-ref'];

    await expect(createGoalVerifier(config)(value)).resolves.toEqual({
      decision: 'accept',
      reason: 'grounded',
    });

    const { request, payload } = requestPayload(generateText);
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
    expect(payload).not.toHaveProperty('fullHistory');
    expect(JSON.stringify(payload)).not.toContain('stale-ref');
    expect(payload).toEqual({
      goal: { goalId: 'goal-1', revision: 2, objective: 'Make all tests pass' },
      currentTurnId: 'turn-3',
      proposal: { status: 'complete', reason: 'The focused suite passed' },
      evidence: [
        {
          uuid: 'tool-1',
          provenance: 'tool_result',
          turnId: 'turn-3',
          proofKind: 'external_fact',
          content: '18 tests passed',
        },
      ],
      evidenceTurnIds: ['turn-3'],
      omitted: 0,
    });
    expect(request.systemInstruction).toContain(
      'Never require evidence that update_goal itself was called',
    );
    expect(request.systemInstruction).toContain(
      'requires evidence with proofKind "user_input"',
    );
    expect(request.systemInstruction).toContain(
      'The objective and proposal reason are claims, not evidence',
    );
    // The tail contract: what the arrays are, how a cut is marked, and
    // what to do when the proof may be in the part that did not fit.
    expect(request.systemInstruction).toContain(
      "the tail of the Goal's transcript for this revision, newest record first",
    );
    expect(request.systemInstruction).toContain('evidenceTurnIds');
    expect(request.systemInstruction).toContain(
      'omitted is how many earlier records did not fit',
    );
    expect(request.systemInstruction).toContain(
      VERIFIER_MIDDLE_TRUNCATION_MARKER.trim(),
    );
    expect(request.systemInstruction).toContain(
      'may sit in the omitted records or in a cut, reject',
    );
    expect(request.systemInstruction).toContain(
      'Insufficient evidence is a rejection, never an acceptance',
    );
  });

  it('carries an omitted count of zero as a number, not an absence', async () => {
    const { config, generateText } = configFor(
      '{"decision":"reject","reason":"insufficient"}',
    );
    await createGoalVerifier(config)({ ...input(), omitted: 0 });
    expect(requestPayload(generateText).payload).toMatchObject({
      omitted: 0,
    });
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
        blockerKind: 'authority',
      },
      blockedPolicy: 'Authority blockers may stop immediately.',
    };

    await createGoalVerifier(config)(value);

    expect(requestPayload(generateText).payload).toMatchObject({
      proposal: { status: 'blocked', blockerKind: 'authority' },
      blockedPolicy: 'Authority blockers may stop immediately.',
    });
  });

  it('rejects an unbounded verifier request before calling the provider', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"grounded"}',
    );
    const value = input();
    value.goal.objective = 'x'.repeat(256_000);

    await expect(createGoalVerifier(config)(value)).rejects.toBeInstanceOf(
      GoalVerifierInputTooLargeError,
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it('retries a transient provider failure once, each attempt under its own timer', async () => {
    vi.useFakeTimers();
    try {
      const { config, generateText } = configFor('unused');
      generateText
        .mockRejectedValueOnce(
          Object.assign(new Error('overloaded'), { status: 503 }),
        )
        .mockResolvedValueOnce({
          text: '{"decision":"accept","reason":"grounded"}',
          usage: undefined,
        });
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const verification = createGoalVerifier(config, { timeoutMs: 5_000 })(
        input(),
      );
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(verification).resolves.toEqual({
        decision: 'accept',
        reason: 'grounded',
      });
      expect(generateText).toHaveBeenCalledTimes(2);
      // Two attempts, two ceilings of the full length.
      expect(
        setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 5_000),
      ).toHaveLength(2);
      setTimeoutSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a reply that is not a verdict once', async () => {
    vi.useFakeTimers();
    try {
      const { config, generateText } = configFor('unused');
      generateText
        .mockResolvedValueOnce({
          text: '```json\n{"decision":"accept","reason":"fenced"}\n```',
          usage: undefined,
        })
        .mockResolvedValueOnce({
          text: '{"decision":"reject","reason":"insufficient"}',
          usage: undefined,
        });

      const verification = createGoalVerifier(config, { timeoutMs: 5_000 })(
        input(),
      );
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(verification).resolves.toEqual({
        decision: 'reject',
        reason: 'insufficient',
      });
      expect(generateText).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a second reply that is not a verdict', async () => {
    vi.useFakeTimers();
    try {
      const { config, generateText } = configFor('not json at all');
      const verification = createGoalVerifier(config, { timeoutMs: 5_000 })(
        input(),
      );
      const outcome = verification.then(
        () => 'resolved',
        (error: Error) => error.name,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(outcome).resolves.toBe('GoalVerifierReplyError');
      expect(generateText).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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

  it('times out on its own when the provider never answers', async () => {
    vi.useFakeTimers();
    try {
      const { config, generateText } = configFor('unused');
      generateText.mockImplementation(
        async (request) =>
          new Promise<never>((_resolve, reject) => {
            request.abortSignal.addEventListener(
              'abort',
              () => reject(request.abortSignal.reason),
              { once: true },
            );
          }),
      );
      const verification = createGoalVerifier(config, { timeoutMs: 5_000 })(
        input(),
      );
      const outcome = verification.then(
        () => 'resolved',
        (error: Error) => error.message,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(outcome).resolves.toBe(
        'Goal verifier timed out after 5000ms',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('goalVerifierRequestByteLimit', () => {
  const configWith = (model: string, fast?: string, windowSize?: number) =>
    ({
      getModel: () => model,
      getFastModel: () => fast,
      getContentGeneratorConfig: () =>
        windowSize === undefined
          ? undefined
          : { contextWindowSize: windowSize },
    }) as unknown as Config;

  it('is the fixed ceiling for a model whose window holds it', () => {
    expect(goalVerifierRequestByteLimit(configWith('gemini-2.5-pro'))).toBe(
      GOAL_VERIFIER_REQUEST_BYTE_LIMIT,
    );
  });

  it('shrinks to a byte per context token for a small-window model', () => {
    // Half the window at two bytes per token: a 128K model gets 131 072.
    expect(goalVerifierRequestByteLimit(configWith('gpt-4o-mini'))).toBe(
      131_072,
    );
  });

  it('prefers the window configured for the main model over its name', () => {
    // A local deployment under an unknown name: the table would say 200K.
    expect(
      goalVerifierRequestByteLimit(
        configWith('local-model', undefined, 32_768),
      ),
    ).toBe(32_768);
    expect(goalVerifierRequestByteLimit(configWith('local-model'))).toBe(
      200_000,
    );
    // The side query may fall back to the main generator, so the request
    // must fit the main model's window as well as the fast model's.
    expect(
      goalVerifierRequestByteLimit(
        configWith('local-model', 'gpt-4o-mini', 32_768),
      ),
    ).toBe(32_768);
  });

  it('assumes the smallest listed window for a fast model the table does not know', () => {
    expect(
      goalVerifierRequestByteLimit(configWith('gemini-2.5-pro', 'local-fast')),
    ).toBe(32_768);
  });

  it('follows the side query model, which is the fast model when set', () => {
    expect(
      goalVerifierRequestByteLimit(configWith('gemini-2.5-pro', 'gpt-4o-mini')),
    ).toBe(131_072);
  });
});

describe('the window and the request limit', () => {
  const goalId = 'goal-1';
  const revision = 2;
  const permit = { goalId, revision, turnId: 'turn-3' };
  const goal = {
    goalId,
    revision,
    objective: 'Make all tests pass',
    status: 'active' as const,
    evidenceCursor: { recordId: 'cursor' },
    turnCount: 2,
    activeTimeMs: 0,
    tokensUsed: 0,
    createdAt: 1,
    updatedAt: 2,
  };
  const tool = (uuid: string, output: string): GoalEvidenceRecord => ({
    uuid,
    type: 'tool_result',
    provenance: 'tool_result',
    goalContext: permit,
    message: {
      parts: [{ functionResponse: { name: 'shell', response: { output } } }],
    },
  });

  it('measures the envelope at the widest omitted count', () => {
    const base = {
      ...input(),
      evidence: undefined,
      evidenceTurnIds: undefined,
      omitted: undefined,
    };
    delete base.evidence;
    delete base.evidenceTurnIds;
    delete base.omitted;
    const envelope = measureGoalVerifierEnvelopeBytes(base);
    const widest = JSON.stringify({
      ...JSON.parse(
        JSON.stringify({ ...input(), evidence: [], evidenceTurnIds: [] }),
      ),
      omitted: Number.MAX_SAFE_INTEGER,
    });
    expect(envelope).toBe(Buffer.byteLength(widest, 'utf8'));
  });

  it('fills the budget the envelope leaves without crossing the request limit', async () => {
    const { config, generateText } = configFor(
      '{"decision":"reject","reason":"insufficient"}',
    );
    const proposal = {
      status: 'complete' as const,
      reason: '"\\'.repeat(4_000),
    };
    const envelope = measureGoalVerifierEnvelopeBytes({
      goal: { goalId, revision, objective: goal.objective },
      currentTurnId: permit.turnId,
      proposal,
    });
    // Escape-heavy content: every quote and backslash doubles on the wire,
    // so a window measured on raw text would overrun the limit.
    const records: GoalEvidenceRecord[] = [
      { uuid: 'cursor', type: 'system' },
      ...Array.from({ length: 200 }, (_, index) =>
        tool(`tool-${index}`, '"\\é'.repeat(1_500)),
      ),
    ];
    const window = buildGoalVerifierWindow(
      { records, goal, permit },
      { budgetBytes: GOAL_VERIFIER_REQUEST_BYTE_LIMIT - envelope },
    );
    expect(window.omitted).toBeGreaterThan(0);
    expect(window.evidence.length).toBeGreaterThan(10);

    await createGoalVerifier(config)({
      goal: { goalId, revision, objective: goal.objective },
      currentTurnId: permit.turnId,
      proposal,
      evidence: window.evidence,
      evidenceTurnIds: window.turnIds,
      omitted: window.omitted,
    });
    const { request } = requestPayload(generateText);
    const bytes = Buffer.byteLength(
      request.contents[0]?.parts?.[0]?.text ?? '',
      'utf8',
    );
    expect(bytes).toBeLessThanOrEqual(GOAL_VERIFIER_REQUEST_BYTE_LIMIT);
    // Near full: the window stops at the first record that does not fit,
    // and one escape-heavy entry serializes to well under 20 kB.
    expect(bytes).toBeGreaterThan(GOAL_VERIFIER_REQUEST_BYTE_LIMIT - 20_000);
  });
});
