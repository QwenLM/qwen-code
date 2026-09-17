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
  GOAL_VERIFIER_REQUEST_BYTE_LIMIT,
  GoalVerifierInputTooLargeError,
  goalVerifierTimeoutMs,
  measureGoalVerifierEnvelopeBytes,
  parseGoalVerifierText,
  type GoalVerifierInput,
} from './goal-verifier.js';
import type { GoalEvidenceRecord } from './goal-evidence.js';
import { buildGoalVerifierEvidenceWindow } from './goal-verifier-window.js';
import { GOAL_PROPOSAL_REASON_MAX_BYTES } from './goal-protocol.js';

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
      evidenceRefs: ['tool-1'],
    },
    evidence: [
      // A catalog record carries a preview the request must never send.
      {
        uuid: 'tool-1',
        provenance: 'tool_result',
        turnId: 'turn-3',
        preview: '18 tests passed',
        proofKind: 'external_fact',
        content: '18 tests passed',
      } as GoalVerifierInput['evidence'][number],
    ],
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

describe('goalVerifierTimeoutMs', () => {
  it('grows with the request and stops at the side query lifetime', () => {
    expect(goalVerifierTimeoutMs(1_000)).toBe(45_000);
    expect(goalVerifierTimeoutMs(64_000)).toBe(60_000);
    expect(goalVerifierTimeoutMs(GOAL_VERIFIER_REQUEST_BYTE_LIMIT)).toBe(
      150_000,
    );
    expect(goalVerifierTimeoutMs(10_000_000)).toBe(180_000);
  });
});

describe('measureGoalVerifierEnvelopeBytes', () => {
  it('measures the request with the evidence array empty, escaping included', () => {
    const value: GoalVerifierInput = {
      ...input(),
      evidenceTurnIds: ['turn-3'],
      omitted: 12,
    };
    const bytes = measureGoalVerifierEnvelopeBytes(value);
    const withoutEvidence = JSON.stringify({
      ...JSON.parse(
        JSON.stringify({
          goal: value.goal,
          currentTurnId: 'turn-3',
          proposal: { ...value.proposal },
          evidence: [],
          evidenceTurnIds: ['turn-3'],
          omitted: 12,
        }),
      ),
    });
    expect(bytes).toBe(Buffer.byteLength(withoutEvidence, 'utf8'));
    // A quote in the objective costs its escape.
    const escaped = measureGoalVerifierEnvelopeBytes({
      ...value,
      goal: { ...value.goal, objective: 'say "hi"' },
    });
    expect(escaped - bytes).toBe(
      Buffer.byteLength('say \\"hi\\"') -
        Buffer.byteLength('Make all tests pass'),
    );
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
    const value = input() as GoalVerifierInput & { fullHistory?: string[] };
    value.fullHistory = ['must not leak'];
    value.currentDeliveredOutput = ['compatibility copy'];

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
    expect(payload).toMatchObject({ currentTurnId: 'turn-3' });
    expect(payload).not.toHaveProperty('currentDeliveredOutput');
    expect(JSON.stringify(payload)).not.toContain('preview');
    expect(request.systemInstruction).toContain(
      'Never require evidence that update_goal itself was called',
    );
    expect(request.systemInstruction).toContain(
      'requires cited evidence with proofKind "user_input"',
    );
    expect(request.systemInstruction).toContain(
      'The objective and proposal reason are claims, not evidence',
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

  it('preserves the legacy delivered-output input contract', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"grounded"}',
    );
    const value = input();
    value.currentTurnId = undefined;
    value.currentDeliveredOutput = ['legacy output'];

    await createGoalVerifier(config)(value);

    const request = generateText.mock.calls[0]![0] as Parameters<
      BaseLlmClient['generateText']
    >[0];
    const payload = JSON.parse(
      request.contents[0]?.parts?.[0]?.text ?? '',
    ) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('currentTurnId');
    expect(payload).toMatchObject({
      currentDeliveredOutput: ['legacy output'],
    });
  });

  it('keeps maximum valid evidence and proposal reason within the request limit', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"grounded"}',
    );
    const value = input();
    value.proposal.reason = '\0'.repeat(8_000);
    value.evidence = [
      {
        ...value.evidence[0]!,
        proofKind: 'delivered_output',
        content: '\0'.repeat(24_000),
      },
    ];

    await expect(createGoalVerifier(config)(value)).resolves.toEqual({
      decision: 'accept',
      reason: 'grounded',
    });
    expect(generateText).toHaveBeenCalledOnce();
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

  it('carries a window built at the budget the envelope leaves, with the longest reason', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"grounded"}',
    );
    // Production ids are 36-character UUIDs and content escapes; the budget
    // has to leave room for both, so model them faithfully.
    const goalId = '0f8c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
    const turnId = '9e8d7c6b-5a4f-4e3d-9c2b-1a0f9e8d7c6b';
    const records: GoalEvidenceRecord[] = [
      { uuid: 'cursor', type: 'system', provenance: 'goal_control' },
      ...Array.from({ length: 140 }, (_, index) => ({
        uuid: `${index.toString(16).padStart(8, '0')}-1111-4222-8333-444455556666`,
        type: 'assistant' as const,
        provenance: 'assistant_output' as const,
        goalContext: { goalId, revision: 1, turnId },
        message: { parts: [{ text: '"\\'.repeat(1_050) }] },
      })),
    ];
    const objective = '"o\\'.repeat(6_000);
    const reason = '界'.repeat(Math.floor(GOAL_PROPOSAL_REASON_MAX_BYTES / 3));
    const proposal = {
      status: 'blocked' as const,
      reason,
      evidenceRefs: [] as string[],
      blockerKind: 'repeated' as const,
    };
    const base = {
      goal: { goalId, revision: 1, objective },
      currentTurnId: turnId,
      proposal,
      blockedPolicy: 'p'.repeat(1_500),
    };
    const envelopeBytes = measureGoalVerifierEnvelopeBytes({
      ...base,
      evidence: [],
      evidenceTurnIds: [turnId, turnId, turnId],
      omitted: Number.MAX_SAFE_INTEGER,
    });
    const window = buildGoalVerifierEvidenceWindow(
      {
        records,
        goal: {
          goalId,
          revision: 1,
          objective,
          status: 'active',
          evidenceCursor: { recordId: 'cursor' },
          turnCount: 1,
          activeTimeMs: 0,
          tokensUsed: 0,
          createdAt: 0,
          updatedAt: 0,
        },
        permit: { goalId, revision: 1, turnId },
        proposal,
      },
      { budgetBytes: GOAL_VERIFIER_REQUEST_BYTE_LIMIT - envelopeBytes },
    );
    expect(window.omitted).toBeGreaterThan(0);

    await expect(
      createGoalVerifier(config)({
        ...base,
        evidence: window.evidence,
        evidenceTurnIds: window.turnIds,
        omitted: window.omitted,
      }),
    ).resolves.toEqual({ decision: 'accept', reason: 'grounded' });
    const request = generateText.mock.calls[0]![0] as Parameters<
      BaseLlmClient['generateText']
    >[0];
    const text = request.contents[0]?.parts?.[0]?.text ?? '';
    const bytes = Buffer.byteLength(text, 'utf8');
    expect(bytes).toBeLessThanOrEqual(GOAL_VERIFIER_REQUEST_BYTE_LIMIT);
    // The budget is used, not merely respected: one more record would not fit.
    const oneMore = Buffer.byteLength(JSON.stringify(window.evidence[0])) + 1;
    expect(bytes + oneMore).toBeGreaterThan(GOAL_VERIFIER_REQUEST_BYTE_LIMIT);
    expect(JSON.parse(text)).toMatchObject({
      evidenceTurnIds: window.turnIds,
      omitted: window.omitted,
    });
  });
});
