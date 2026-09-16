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
      {
        uuid: 'tool-1',
        provenance: 'tool_result',
        turnId: 'turn-3',
        preview: '18 tests passed',
        proofKind: 'external_fact',
        content: '18 tests passed',
      },
    ],
  };
}

function configFor(reply: string) {
  const generateText = vi.fn().mockResolvedValue({
    text: reply,
    usage: { totalTokenCount: 10 },
  });
  const baseLlmClient = {
    generateText,
    generateJson: vi.fn(),
    resolveForModel: vi.fn().mockResolvedValue({
      model: 'fast-model',
      contentGeneratorConfig: { contextWindowSize: 512_000 },
    }),
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
      usage: { totalTokenCount: 10 },
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
      usage: { totalTokenCount: 10 },
    });
    expect(generateText).toHaveBeenCalledOnce();
  });

  it('rejects an unbounded verifier request before calling the provider', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"grounded"}',
    );
    const value = input();
    value.goal.objective = 'x'.repeat(256_000);

    await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
      decision: 'inconclusive',
      failureKind: 'capacity',
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('propagates provider failure and clears its timeout', async () => {
    const { config, generateText } = configFor('unused');
    generateText.mockRejectedValue(new Error('provider unavailable'));
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    try {
      await expect(createGoalVerifier(config)(input())).resolves.toMatchObject({
        decision: 'inconclusive',
        failureKind: 'service',
        reason: 'provider unavailable',
        usageComplete: false,
      });
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

function snapshotFor(
  records: GoalVerifierInput['evidence'],
  required = records.map((record) => record.uuid),
) {
  const list = vi.fn().mockReturnValue({
    entries: records.map(({ content: _content, ...entry }) => entry),
    hasMore: false,
    scopeStart: 'goal-created',
    snapshotTail: 'frozen-tail',
    snapshotId: 'snapshot-1',
  });
  const read = vi.fn(
    ({
      reference,
      cursor,
      maxBytes = 16_000,
    }: {
      reference: string;
      cursor?: string;
      maxBytes?: number;
    }) => {
      const record = records.find((entry) => entry.uuid === reference);
      if (!record) throw new Error('reference is not in this Goal snapshot');
      const buffer = Buffer.from(record.content);
      const start = Number(cursor ?? 0);
      const end = Math.min(start + maxBytes, buffer.length);
      return {
        ...record,
        content: buffer.subarray(start, end).toString('utf8'),
        sourceComplete: true,
        start,
        end,
        totalBytes: buffer.length,
        complete: end === buffer.length,
        ...(end < buffer.length ? { nextCursor: String(end) } : {}),
      };
    },
  );
  const snapshot = {
    entries: records.map(({ content: _content, ...entry }) => entry),
    list,
    read,
    requiredEvidence: vi.fn().mockReturnValue(required),
    scopeStart: 'goal-created',
    snapshotTail: 'frozen-tail',
    snapshotId: 'snapshot-1',
  } as unknown as NonNullable<GoalVerifierInput['evidenceSnapshot']>;
  return { snapshot, read, list };
}

function providerRequest(generateText: ReturnType<typeof vi.fn>, call = 0) {
  return generateText.mock.calls[call]![0] as Parameters<
    BaseLlmClient['generateText']
  >[0];
}

describe('bounded evidence verification', () => {
  it.each([
    '{"decision":"needs_evidence","request":{"kind":"list"}}',
    '{"decision":"needs_evidence","request":{"kind":"read","reference":"raw-1","cursor":"opaque"}}',
    '{"decision":"inconclusive","reason":"Original missing"}',
  ])('accepts the exact read-only protocol: %s', (text) => {
    expect(parseGoalVerifierText(text)).toEqual(JSON.parse(text));
  });

  it.each([
    '{"decision":"needs_evidence","request":{"kind":"shell","command":"pwd"}}',
    '{"decision":"needs_evidence","request":{"kind":"read","path":"/tmp/a"}}',
    '{"decision":"needs_evidence","request":{"kind":"read","reference":"raw","extra":true}}',
    '{"decision":"needs_evidence","request":{"kind":"list","cursor":null}}',
    '{"decision":"needs_evidence","request":{"kind":"list"},"reason":"extra"}',
    '{"decision":"accept","reason":"ok","request":{"kind":"list"}}',
  ])('rejects requests outside the bounded protocol: %s', (text) => {
    expect(() => parseGoalVerifierText(text)).toThrow(/Goal verifier/);
  });

  it('includes every required action and delivery across 150 catalog entries in one call', async () => {
    const { config, generateText } = configFor(
      '{"decision":"reject","reason":"Later failing tests contradict the old green result"}',
    );
    const value = input();
    const records = Array.from({ length: 150 }, (_, index) => ({
      ...value.evidence[0]!,
      uuid: `raw-${index}`,
      content:
        index === 149
          ? 'callId: new-check; command: test; FAILED'
          : `callId: action-${index}; command: inspect; result ${index}`,
    }));
    const { snapshot } = snapshotFor(records);
    value.evidenceSnapshot = snapshot;
    value.evidence = [records[0]!];
    value.proposal.evidenceRefs = [records[0]!.uuid];
    await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
      decision: 'reject',
    });
    expect(generateText).toHaveBeenCalledOnce();
    const payload = JSON.parse(
      providerRequest(generateText).contents[0]!.parts![0]!.text!,
    );
    expect(payload.evidence).toHaveLength(150);
    expect(payload.evidence[149].content).toContain('FAILED');
    expect(snapshot.requiredEvidence).toHaveBeenCalledWith(value.proposal, {
      includeHistoricalActions: true,
    });
  });

  it('reassembles all raw slices before exposing a giant original to the model', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"All complete"}',
    );
    const value = input();
    const original = `${'a'.repeat(38_000)}\nFINAL CHECK FAILED`;
    const { snapshot, read } = snapshotFor([
      { ...value.evidence[0]!, content: original },
    ]);
    value.evidenceSnapshot = snapshot;
    await createGoalVerifier(config)(value);
    expect(read).toHaveBeenCalledTimes(3);
    const payload = JSON.parse(
      providerRequest(generateText).contents[0]!.parts![0]!.text!,
    );
    expect(payload.evidence[0].content).toBe(original);
  });

  it('retains complete source history through list and multi-slice read responses', async () => {
    const { config, generateText } = configFor('');
    const replies = [
      '{"decision":"needs_evidence","request":{"kind":"list"}}',
      '{"decision":"needs_evidence","request":{"kind":"read","reference":"old-delivery"}}',
      '{"decision":"needs_evidence","request":{"kind":"read","reference":"old-delivery","cursor":"16000"}}',
      '{"decision":"accept","reason":"All explicit conditions satisfied"}',
    ];
    for (const text of replies)
      generateText.mockResolvedValueOnce({
        text,
        usage: { totalTokenCount: 11 },
      });
    const value = input();
    const { snapshot } = snapshotFor(
      [
        ...value.evidence,
        {
          ...value.evidence[0]!,
          uuid: 'old-delivery',
          proofKind: 'delivered_output',
          content: 'z'.repeat(19_000),
        },
      ],
      ['tool-1'],
    );
    value.evidenceSnapshot = snapshot;
    await expect(createGoalVerifier(config)(value)).resolves.toEqual({
      decision: 'accept',
      reason: 'All explicit conditions satisfied',
      usage: { totalTokenCount: 44 },
    });
    expect(generateText).toHaveBeenCalledTimes(4);
    const contents = providerRequest(generateText, 3).contents;
    expect(contents).toHaveLength(7);
    expect(contents[0]!.parts![0]!.text).toContain('18 tests passed');
    expect(
      JSON.parse(contents[6]!.parts![0]!.text!).evidenceResponse,
    ).toMatchObject({ complete: true, start: 16000, end: 19000 });
  });

  it('never accepts after only the first slice of a requested original', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"Enough"}',
    );
    generateText.mockResolvedValueOnce({
      text: '{"decision":"needs_evidence","request":{"kind":"read","reference":"old-delivery"}}',
      usage: { totalTokenCount: 5 },
    });
    const value = input();
    value.evidenceSnapshot = snapshotFor(
      [
        ...value.evidence,
        {
          ...value.evidence[0]!,
          uuid: 'old-delivery',
          content: 'z'.repeat(20_000),
        },
      ],
      ['tool-1'],
    ).snapshot;
    await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
      decision: 'inconclusive',
      failureKind: 'evidence_unavailable',
      reason: expect.stringContaining('fully reading'),
    });
  });

  it('stops when required child or original coverage is unavailable', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"Enough"}',
    );
    const value = input();
    value.coverageUnavailable = ['Child task has no recorded action journal'];
    await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
      decision: 'inconclusive',
      failureKind: 'evidence_unavailable',
    });
    expect(generateText).not.toHaveBeenCalled();
    value.coverageUnavailable = undefined;
    const { snapshot, read } = snapshotFor(value.evidence);
    read.mockReturnValue({
      ...read({ reference: 'tool-1' }),
      sourceComplete: false,
    });
    value.evidenceSnapshot = snapshot;
    await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
      decision: 'inconclusive',
      failureKind: 'evidence_unavailable',
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('charges the malformed response before its one structured correction', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"Now valid"}',
    );
    generateText.mockResolvedValueOnce({
      text: '{"decision":"accept","reason":5}',
      usage: { totalTokenCount: 13 },
    });
    const value = input();
    value.onUsage = vi.fn();
    await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
      decision: 'accept',
      usage: { totalTokenCount: 23 },
    });
    expect(value.onUsage).toHaveBeenNthCalledWith(
      1,
      { totalTokenCount: 13 },
      1,
    );
    expect(value.onUsage).toHaveBeenNthCalledWith(
      2,
      { totalTokenCount: 10 },
      2,
    );
    expect(
      providerRequest(generateText, 1).contents[2]!.parts![0]!.text,
    ).toContain('$.reason');
  });

  it('stops after one malformed-output correction and retains both usages', async () => {
    const { config, generateText } = configFor('not JSON');
    await expect(createGoalVerifier(config)(input())).resolves.toMatchObject({
      decision: 'inconclusive',
      failureKind: 'service',
      usage: { totalTokenCount: 20 },
    });
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('checks actual observed Goal tokens before issuing a correction call', async () => {
    const { config, generateText } = configFor('invalid');
    const value = input();
    value.beforeCall = ({ totalTokenCount }) =>
      totalTokenCount >= 10 ? 'Goal token budget exhausted' : undefined;
    await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
      decision: 'inconclusive',
      failureKind: 'budget',
      usage: { totalTokenCount: 10 },
    });
    expect(generateText).toHaveBeenCalledOnce();
  });

  it('uses the resolved fast model context and reserves output before any call', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"Enough"}',
    );
    vi.mocked(config.getBaseLlmClient().resolveForModel).mockResolvedValue({
      model: 'tiny-fast',
      contentGeneratorConfig: { model: 'tiny-fast', contextWindowSize: 3_000 },
    } as Awaited<ReturnType<BaseLlmClient['resolveForModel']>>);
    await expect(createGoalVerifier(config)(input())).resolves.toMatchObject({
      decision: 'inconclusive',
      failureKind: 'capacity',
      reason: expect.stringContaining('3000-token context'),
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(config.getBaseLlmClient().resolveForModel).toHaveBeenCalledWith(
      'fast-model',
      { failClosed: true },
    );
  });

  it('classifies provider context rejection as capacity and records exposed failure usage', async () => {
    const { config, generateText } = configFor('unused');
    generateText.mockRejectedValue(
      Object.assign(new Error('maximum context length exceeded'), {
        usage: { totalTokenCount: 4 },
      }),
    );
    const value = input();
    value.onUsage = vi.fn();
    await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
      decision: 'inconclusive',
      failureKind: 'capacity',
      usage: { totalTokenCount: 4 },
    });
    expect(value.onUsage).toHaveBeenCalledOnce();
  });

  it('reports missing provider usage as unobservable rather than zero', async () => {
    const { config, generateText } = configFor('unused');
    generateText.mockResolvedValue({
      text: '{"decision":"accept","reason":"Enough"}',
    });
    const value = input();
    value.onUsage = vi.fn();
    await expect(createGoalVerifier(config)(value)).resolves.toEqual({
      decision: 'accept',
      reason: 'Enough',
      usageComplete: false,
    });
    expect(value.onUsage).toHaveBeenCalledWith({}, 1);
  });

  it('stops repeated read requests without a third model call', async () => {
    const { config, generateText } = configFor(
      '{"decision":"needs_evidence","request":{"kind":"list"}}',
    );
    const value = input();
    value.evidenceSnapshot = snapshotFor(value.evidence).snapshot;
    await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
      decision: 'inconclusive',
      failureKind: 'capacity',
      reason: expect.stringContaining('repeated'),
    });
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('caps distinct progressing reads at the total call limit', async () => {
    const { config, generateText } = configFor('');
    for (let index = 0; index < 8; index++)
      generateText.mockResolvedValueOnce({
        text: JSON.stringify({
          decision: 'needs_evidence',
          request: { kind: 'list', cursor: String(index) },
        }),
        usage: { totalTokenCount: 1 },
      });
    const value = input();
    value.evidenceSnapshot = snapshotFor(value.evidence).snapshot;
    await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
      decision: 'inconclusive',
      failureKind: 'capacity',
      usage: { totalTokenCount: 8 },
      reason: expect.stringContaining('8-call'),
    });
    expect(generateText).toHaveBeenCalledTimes(8);
  });

  it('rejects an unauthorized reference instead of reading outside the snapshot', async () => {
    const { config, generateText } = configFor(
      '{"decision":"needs_evidence","request":{"kind":"read","reference":"other-goal"}}',
    );
    const value = input();
    value.evidenceSnapshot = snapshotFor(value.evidence).snapshot;
    await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
      decision: 'reject',
      reason: expect.stringContaining('not in this Goal snapshot'),
    });
    expect(generateText).toHaveBeenCalledOnce();
  });

  it('bounds an unresponsive provider and still records usage if it arrives late', async () => {
    const { config, generateText } = configFor('unused');
    let finish: (value: unknown) => void = () => undefined;
    generateText.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const value = input();
    value.onUsage = vi.fn();
    await expect(
      createGoalVerifier(config, { timeoutMs: 5 })(value),
    ).resolves.toMatchObject({
      decision: 'inconclusive',
      failureKind: 'service',
      reason: expect.stringContaining('timed out'),
    });
    finish({
      text: '{"decision":"accept","reason":"Late"}',
      usage: { totalTokenCount: 9 },
    });
    await vi.waitFor(() =>
      expect(value.onUsage).toHaveBeenCalledWith({ totalTokenCount: 9 }, 1),
    );
  });
});
