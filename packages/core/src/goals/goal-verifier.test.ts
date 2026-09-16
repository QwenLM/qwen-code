/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createGoalEvidenceSnapshot,
  type GoalEvidenceRecord,
} from './goal-evidence.js';
import type { GoalRecord } from './goal-protocol.js';
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
      decision: 'reject',
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
    actionManifest: vi.fn().mockReturnValue([]),
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

function inputWithHistoricalChildOutput(count = 9): GoalVerifierInput {
  const value = input();
  const goal: GoalRecord = {
    ...value.goal,
    status: 'active',
    evidenceCursor: { recordId: 'start' },
    turnCount: 2,
    activeTimeMs: 0,
    tokensUsed: 0,
    createdAt: 1,
    updatedAt: 2,
  };
  const permit = {
    goalId: goal.goalId,
    revision: goal.revision,
    turnId: 'turn-3',
  };
  const action = (
    uuid: string,
    turnId: string,
    output: string,
  ): GoalEvidenceRecord[] => [
    {
      uuid: `${uuid}-call`,
      type: 'assistant',
      provenance: 'assistant_output',
      goalContext: { ...permit, turnId },
      message: {
        parts: [
          {
            functionCall: {
              id: uuid,
              name: 'shell',
              args: {
                command:
                  uuid === 'tool-1'
                    ? 'npm test --silent'
                    : 'read dependency documentation',
              },
            },
          },
        ],
      },
    },
    {
      uuid,
      type: 'tool_result',
      provenance: 'tool_result',
      goalContext: { ...permit, turnId },
      message: {
        parts: [
          {
            functionResponse: { id: uuid, name: 'shell', response: { output } },
          },
        ],
      },
    },
  ];
  const records: GoalEvidenceRecord[] = [
    { uuid: 'start', type: 'system' },
    {
      uuid: 'earlier-turn',
      type: 'assistant',
      provenance: 'assistant_output',
      goalContext: { ...permit, turnId: 'turn-2' },
      message: { parts: [{ text: 'Earlier dependency research' }] },
    },
    ...action('tool-1', permit.turnId, '18 tests passed'),
  ];
  const auditRecords = Array.from({ length: count }, (_, index) =>
    action(`child-${index}`, 'turn-2', 'Documentation content. '.repeat(950)),
  ).flat();
  value.evidenceSnapshot = createGoalEvidenceSnapshot({
    records,
    auditRecords,
    goal,
    permit,
  });
  value.evidence = value.evidenceSnapshot.validate(value.proposal).citedRecords;
  return value;
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
    expect(snapshot.requiredEvidence).toHaveBeenCalledWith(value.proposal);
  });

  it('reads the remaining slices of a cited original on demand', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"All complete"}',
    );
    const value = input();
    generateText.mockResolvedValueOnce({
      text: '{"decision":"needs_evidence","request":{"kind":"read","reference":"tool-1","cursor":"16000"}}',
      usage: { totalTokenCount: 1 },
    });
    generateText.mockResolvedValueOnce({
      text: '{"decision":"needs_evidence","request":{"kind":"read","reference":"tool-1","cursor":"32000"}}',
      usage: { totalTokenCount: 1 },
    });
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
    expect(payload.evidence[0]).toMatchObject({
      content: original.slice(0, 16_000),
      complete: false,
      nextCursor: '16000',
    });
    expect(
      providerRequest(generateText, 2).contents.at(-1)?.parts?.[0]?.text,
    ).toContain('FINAL CHECK FAILED');
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
      failureKind: 'service',
      reason: expect.stringContaining('fully reading'),
    });
  });

  it('passes historical gaps to the verifier but rejects incomplete cited proof', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"Fresh proof satisfies current state"}',
    );
    const value = input();
    value.coverageUnavailable = ['Old image cannot be inspected'];
    await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
      decision: 'accept',
    });
    expect(
      providerRequest(generateText).contents[0]?.parts?.[0]?.text,
    ).toContain('Old image cannot be inspected');
    generateText.mockClear();
    const { snapshot, read } = snapshotFor(value.evidence);
    read.mockReturnValue({
      ...read({ reference: 'tool-1' }),
      sourceComplete: false,
    });
    value.evidenceSnapshot = snapshot;
    await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
      decision: 'reject',
      reason: expect.stringContaining('fresh proof'),
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('verifies fresh proof after large historical outputs, media and an orphan call without hiding their actions', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"Fresh test verifies the requested current state"}',
    );
    const value = input();
    const goal: GoalRecord = {
      ...value.goal,
      status: 'active',
      evidenceCursor: { recordId: 'start' },
      turnCount: 1,
      activeTimeMs: 0,
      tokensUsed: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const permit = {
      goalId: goal.goalId,
      revision: goal.revision,
      turnId: 'turn-3',
    };
    const records: GoalEvidenceRecord[] = [{ uuid: 'start', type: 'system' }];
    for (let index = 0; index < 40; index++) {
      records.push({
        uuid: `call-${index}`,
        type: 'assistant',
        provenance: 'assistant_output',
        goalContext: permit,
        message: {
          parts: [
            {
              functionCall: {
                id: `id-${index}`,
                name: 'run_shell_command',
                args: {
                  command: index === 0 ? 'touch changed.txt' : 'inspect',
                },
              },
            },
          ],
        },
      });
      records.push({
        uuid: `result-${index}`,
        type: 'tool_result',
        provenance: 'tool_result',
        goalContext: permit,
        message: {
          parts: [
            {
              functionResponse: {
                id: `id-${index}`,
                name: 'run_shell_command',
                response: { output: 'x'.repeat(8_000) },
              },
            },
          ],
        },
      });
    }
    records.push({
      uuid: 'old-image',
      type: 'user',
      provenance: 'real_user',
      goalContext: permit,
      message: {
        parts: [
          { text: 'Unrelated earlier image' },
          { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
        ],
      },
    });
    records.push({
      uuid: 'orphan',
      type: 'assistant',
      provenance: 'assistant_output',
      goalContext: permit,
      message: {
        parts: [
          {
            functionCall: {
              id: 'orphan-id',
              name: 'run_shell_command',
              args: { command: 'inspect' },
            },
          },
        ],
      },
    });
    records.push({
      uuid: 'latest-call',
      type: 'assistant',
      provenance: 'assistant_output',
      goalContext: permit,
      message: {
        parts: [
          {
            functionCall: {
              id: 'latest',
              name: 'run_shell_command',
              args: { command: 'npm test' },
            },
          },
        ],
      },
    });
    records.push({
      uuid: 'tool-1',
      type: 'tool_result',
      provenance: 'tool_result',
      goalContext: permit,
      message: {
        parts: [
          {
            functionResponse: {
              id: 'latest',
              name: 'run_shell_command',
              response: { output: '18 tests passed' },
            },
          },
        ],
      },
    });
    value.evidenceSnapshot = createGoalEvidenceSnapshot({
      records,
      goal,
      permit,
    });
    value.evidence = value.evidenceSnapshot.validate(
      value.proposal,
    ).citedRecords;
    await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
      decision: 'accept',
    });
    expect(generateText).toHaveBeenCalledOnce();
    const request = providerRequest(generateText);
    const payload = JSON.parse(request.contents[0]!.parts![0]!.text!);
    expect(payload.snapshot.actions).toHaveLength(42);
    expect(payload.snapshot.actions[0].arguments).toContain(
      'touch changed.txt',
    );
    expect(payload.coverageUnavailable.join(' ')).toContain('orphan-id');
    expect(
      payload.evidence.find(
        (record: { uuid: string }) => record.uuid === 'old-image',
      ).sourceComplete,
    ).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('x'.repeat(8_000));
    expect(request.systemInstruction).toContain(
      'A write followed by a revert still violates an all-time no-write constraint',
    );
  });

  it('does not force a fresh proof to exhaust the call budget reading unrelated old child results', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"Fresh final tests establish current state; earlier documentation reads are unrelated"}',
    );
    const value = inputWithHistoricalChildOutput();

    await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
      decision: 'accept',
    });
    expect(generateText).toHaveBeenCalledOnce();
    const payload = JSON.parse(
      providerRequest(generateText).contents[0]!.parts![0]!.text!,
    );
    const childSlices = payload.evidence.filter((record: { uuid: string }) =>
      record.uuid.startsWith('child-'),
    );
    expect(childSlices).toHaveLength(9);
    for (const slice of childSlices) {
      expect(slice).toMatchObject({
        sourceComplete: true,
        complete: false,
        mustReadCompletely: false,
        nextCursor: expect.any(String),
      });
      expect(Buffer.byteLength(slice.content, 'utf8')).toBeLessThanOrEqual(
        1_000,
      );
      expect(slice.totalBytes).toBeGreaterThan(20_000);
    }
    expect(payload.snapshot.actions).toHaveLength(10);
    expect(
      payload.snapshot.actions.map(
        (entry: { recordId: string }) => entry.recordId,
      ),
    ).toEqual([
      'tool-1-call',
      ...Array.from({ length: 9 }, (_, index) => `child-${index}-call`),
    ]);
    expect(
      payload.snapshot.actions.map(
        (entry: { resultReferences: string[] }) => entry.resultReferences,
      ),
    ).toEqual([
      ['tool-1'],
      ...Array.from({ length: 9 }, (_, index) => [`child-${index}`]),
    ]);
  });

  it('counts an optional initial slice when the verifier reads its remaining original', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"Complete original inspected"}',
    );
    const value = inputWithHistoricalChildOutput(1);
    const snapshot = value.evidenceSnapshot!;
    let slice = snapshot.read({ reference: 'child-0', maxBytes: 1_000 });
    while (!slice.complete) {
      generateText.mockResolvedValueOnce({
        text: JSON.stringify({
          decision: 'needs_evidence',
          request: {
            kind: 'read',
            reference: 'child-0',
            cursor: slice.nextCursor,
          },
        }),
        usage: { totalTokenCount: 1 },
      });
      slice = snapshot.read({
        reference: 'child-0',
        cursor: slice.nextCursor,
        maxBytes: 16_000,
      });
    }

    await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
      decision: 'accept',
    });
    expect(generateText).toHaveBeenCalledTimes(3);
  });

  it.each(['cited', 'requested'])(
    'still refuses acceptance with only part of a %s child original',
    async (kind) => {
      const { config, generateText } = configFor(
        '{"decision":"accept","reason":"Enough"}',
      );
      const value = inputWithHistoricalChildOutput(1);
      if (kind === 'cited') {
        value.proposal.evidenceRefs = ['child-0'];
        value.evidence = value.evidenceSnapshot!.validate(
          value.proposal,
        ).citedRecords;
      } else {
        const initial = value.evidenceSnapshot!.read({
          reference: 'child-0',
          maxBytes: 1_000,
        });
        generateText.mockResolvedValueOnce({
          text: JSON.stringify({
            decision: 'needs_evidence',
            request: {
              kind: 'read',
              reference: 'child-0',
              cursor: initial.nextCursor,
            },
          }),
          usage: { totalTokenCount: 1 },
        });
      }

      await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
        decision: 'inconclusive',
        failureKind: 'service',
        reason: expect.stringContaining('fully reading'),
      });
      expect(generateText).toHaveBeenCalledTimes(kind === 'cited' ? 1 : 2);
    },
  );

  it('keeps running child execution a hard completion barrier', async () => {
    const { config, generateText } = configFor(
      '{"decision":"accept","reason":"Enough"}',
    );
    const value = input();
    value.activeWriters = ['shell still running'];
    await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
      decision: 'reject',
      reason: expect.stringContaining('active child'),
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
      decision: 'reject',
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
      decision: 'reject',
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
      failureKind: 'service',
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
      decision: 'reject',
      usage: { totalTokenCount: 8 },
      reason: expect.stringContaining('8-call'),
    });
    expect(generateText).toHaveBeenCalledTimes(8);
  });

  it('repairs invalid verifier references without penalizing the worker', async () => {
    const { config, generateText } = configFor(
      '{"decision":"needs_evidence","request":{"kind":"read","reference":"other-goal"}}',
    );
    const value = input();
    value.evidenceSnapshot = snapshotFor(value.evidence).snapshot;
    await expect(createGoalVerifier(config)(value)).resolves.toMatchObject({
      decision: 'inconclusive',
      failureKind: 'service',
      reason: expect.stringContaining('repeated'),
    });
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(
      providerRequest(generateText, 1).contents[2]?.parts?.[0]?.text,
    ).toContain('not in this Goal snapshot');
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
