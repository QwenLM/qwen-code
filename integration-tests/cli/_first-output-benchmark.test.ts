/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BOOTSTRAP_ITERATIONS,
  FIRST_OUTPUT_BENCHMARK_VERSION,
  FirstOutputTracker,
  classifyFirstOutputEvent,
  evaluateSingleBundlePrototypeGate,
  findInvalidTimings,
  measuredPairCountForDwell,
  nullablePercentiles,
  parseBenchmarkPostSessionDwell,
  pairedCandidateControlStats,
  percentiles,
  renderFirstOutputBenchmarkMarkdown,
  validateExpectedFinalText,
  validatePromptAcceptance,
  type BenchmarkDaemonEvent,
  type FirstOutputBenchmarkArtifactV2,
  type FirstOutputSessionTimings,
  type PairedMetricSample,
} from './_first-output-benchmark.js';

describe('measuredPairCountForDwell', () => {
  it('uses 30 decision pairs except for the 500ms diagnostic', () => {
    expect(measuredPairCountForDwell(0)).toBe(30);
    expect(measuredPairCountForDwell(100)).toBe(30);
    expect(measuredPairCountForDwell(500)).toBe(10);
  });

  it('rejects sample counts that could mislabel a diagnostic or decision run', () => {
    expect(() => measuredPairCountForDwell(0, '10')).toThrow(
      '0ms dwell requires exactly 30 measured pairs',
    );
    expect(() => measuredPairCountForDwell(500, '30')).toThrow(
      '500ms dwell requires exactly 10 measured pairs',
    );
    expect(() => measuredPairCountForDwell(100, '20')).toThrow(
      'expected exactly 10 or 30',
    );
  });
});

describe('parseBenchmarkPostSessionDwell', () => {
  it('accepts only the three benchmark scenarios', () => {
    expect(parseBenchmarkPostSessionDwell()).toBe(0);
    expect(parseBenchmarkPostSessionDwell('0')).toBe(0);
    expect(parseBenchmarkPostSessionDwell('100')).toBe(100);
    expect(parseBenchmarkPostSessionDwell('500')).toBe(500);
  });

  it('rejects unsupported and timer-overflow dwell values', () => {
    expect(() => parseBenchmarkPostSessionDwell('1')).toThrow(
      'expected exactly 0, 100, or 500',
    );
    expect(() => parseBenchmarkPostSessionDwell('2147483648')).toThrow(
      'expected exactly 0, 100, or 500',
    );
  });
});

function sessionUpdate(
  promptId: string,
  update: Record<string, unknown>,
  id = 1,
  meta?: Record<string, unknown>,
): BenchmarkDaemonEvent {
  return {
    id,
    v: 1,
    type: 'session_update',
    promptId,
    data: { sessionId: 'session-1', update },
    ...(meta ? { _meta: meta } : {}),
  };
}

function answer(promptId: string, text: string, id = 1): BenchmarkDaemonEvent {
  return sessionUpdate(
    promptId,
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    },
    id,
  );
}

function thought(promptId: string, text: string, id = 1): BenchmarkDaemonEvent {
  return sessionUpdate(
    promptId,
    {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text },
    },
    id,
  );
}

function toolCall(promptId: string, id = 1): BenchmarkDaemonEvent {
  return sessionUpdate(
    promptId,
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'Read file',
    },
    id,
  );
}

function turnComplete(promptId: string, id = 10): BenchmarkDaemonEvent {
  return {
    id,
    v: 1,
    type: 'turn_complete',
    promptId,
    data: {
      sessionId: 'session-1',
      promptId,
      stopReason: 'end_turn',
    },
  };
}

function turnError(
  promptId: string,
  message: string,
  id = 10,
): BenchmarkDaemonEvent {
  return {
    id,
    v: 1,
    type: 'turn_error',
    promptId,
    data: {
      sessionId: 'session-1',
      promptId,
      code: 'provider_error',
      message,
    },
  };
}

describe('classifyFirstOutputEvent', () => {
  it('classifies non-empty answer text and preserves the receive-independent server timestamp', () => {
    const event = answer('prompt-1', 'hello');
    event._meta = { serverTimestamp: '2026-07-27T00:00:00.000Z' };

    expect(classifyFirstOutputEvent(event, 'prompt-1')).toEqual({
      type: 'output',
      kind: 'answer_text',
      text: 'hello',
      toolCallId: null,
      serverTimestampMs: Date.parse('2026-07-27T00:00:00.000Z'),
    });
  });

  it('classifies thought text and an initial tool call as output', () => {
    expect(
      classifyFirstOutputEvent(thought('prompt-1', 'thinking'), 'prompt-1'),
    ).toMatchObject({
      type: 'output',
      kind: 'thought_text',
      text: 'thinking',
    });
    expect(
      classifyFirstOutputEvent(toolCall('prompt-1'), 'prompt-1'),
    ).toMatchObject({
      type: 'output',
      kind: 'tool_call',
      toolCallId: 'call-1',
    });
  });

  it('excludes empty, replayed, diagnostic, user, and update-only frames', () => {
    const excluded = [
      sessionUpdate('prompt-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: { usage: { totalTokens: 1 } },
      }),
      sessionUpdate('prompt-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'old answer' },
        _meta: { qwenTranscript: { sourceRecordIds: ['record-1'] } },
      }),
      sessionUpdate('prompt-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'status' },
        _meta: {
          source: 'todo_stop_guard',
          qwenDiscreteMessage: true,
        },
      }),
      sessionUpdate('prompt-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'future local status' },
        _meta: {
          source: 'future_local_status',
          qwenDiscreteMessage: true,
        },
      }),
      sessionUpdate('prompt-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'background task finished' },
        _meta: { source: 'background_notification' },
      }),
      sessionUpdate('prompt-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'local command output' },
        _meta: { source: 'slash_command' },
      }),
      answer(
        'prompt-1',
        'IMPORTANT: This conversation approached the input token limit. ' +
          'A compressed context will be sent for future messages.',
      ),
      sessionUpdate('prompt-1', {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'echo' },
      }),
      sessionUpdate('prompt-1', {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
      }),
      sessionUpdate('prompt-1', {
        sessionUpdate: 'tool_call',
        toolCallId: '',
        title: 'Malformed tool call',
      }),
      sessionUpdate('prompt-1', {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-without-title',
      }),
      {
        v: 1,
        type: 'replay_complete',
        promptId: 'prompt-1',
        data: {},
      },
    ];

    for (const event of excluded) {
      expect(classifyFirstOutputEvent(event, 'prompt-1').type).toBe('ignore');
    }
  });

  it('requires exact prompt correlation for output and terminal events', () => {
    expect(
      classifyFirstOutputEvent(answer('other-prompt', 'wrong'), 'prompt-1'),
    ).toEqual({ type: 'ignore', reason: 'wrong_prompt_id' });

    const wrongNestedPrompt = turnComplete('prompt-1');
    (wrongNestedPrompt.data as Record<string, unknown>)['promptId'] =
      'other-prompt';
    expect(classifyFirstOutputEvent(wrongNestedPrompt, 'prompt-1')).toEqual({
      type: 'ignore',
      reason: 'wrong_prompt_id',
    });

    const missingEnvelopePrompt = turnComplete('prompt-1');
    delete missingEnvelopePrompt.promptId;
    expect(classifyFirstOutputEvent(missingEnvelopePrompt, 'prompt-1')).toEqual(
      {
        type: 'ignore',
        reason: 'wrong_prompt_id',
      },
    );
  });
});

describe('FirstOutputTracker', () => {
  it('tracks thought as first output and later answer separately', () => {
    const tracker = new FirstOutputTracker();
    tracker.acceptPrompt('prompt-1');
    tracker.push(thought('prompt-1', 'thinking', 1), 20);
    tracker.push(answer('prompt-1', 'final ', 2), 30);
    tracker.push(answer('prompt-1', 'answer', 3), 40);
    tracker.push(turnComplete('prompt-1', 4), 50);

    expect(tracker.snapshot()).toMatchObject({
      firstOutput: {
        kind: 'thought_text',
        receivedAtMs: 20,
        text: 'thinking',
      },
      firstAnswer: {
        kind: 'answer_text',
        receivedAtMs: 30,
        text: 'final ',
      },
      finalAnswerText: 'final answer',
      runEligible: true,
      answerMetricEligible: true,
      failureCode: null,
    });
  });

  it('buffers events that precede HTTP acceptance and filters by the accepted promptId once', () => {
    const tracker = new FirstOutputTracker();
    tracker.push(answer('other-prompt', 'wrong', 1), 10);
    tracker.push(answer('prompt-1', 'right', 2), 11);
    tracker.push(turnComplete('prompt-1', 3), 12);

    expect(tracker.snapshot().firstOutput).toBeNull();
    tracker.acceptPrompt('prompt-1');
    tracker.acceptPrompt('prompt-1');

    expect(tracker.snapshot()).toMatchObject({
      bufferedEventCount: 0,
      bufferedBeforeAcceptanceCount: 3,
      matchingEventCount: 2,
      matchingTerminalCount: 1,
      firstOutput: {
        eventId: 2,
        text: 'right',
        receivedAtMs: 11,
      },
      finalAnswerText: 'right',
      runEligible: true,
    });
  });

  it('fails a clean terminal that arrives before qualifying output', () => {
    const tracker = new FirstOutputTracker();
    tracker.acceptPrompt('prompt-1');
    tracker.push(turnComplete('prompt-1'), 25);
    tracker.push(answer('prompt-1', 'too late'), 30);

    expect(tracker.snapshot()).toMatchObject({
      firstOutput: null,
      finalAnswerText: null,
      terminal: { kind: 'complete', receivedAtMs: 25 },
      failureCode: 'terminal_before_first_output',
      runEligible: false,
    });
  });

  it('preserves partial final answer text when turn_error terminates the run', () => {
    const tracker = new FirstOutputTracker();
    tracker.acceptPrompt('prompt-1');
    tracker.push(answer('prompt-1', 'partial ', 1), 10);
    tracker.push(answer('prompt-1', 'answer', 2), 11);
    tracker.push(turnError('prompt-1', 'provider unavailable', 3), 12);

    expect(tracker.snapshot()).toMatchObject({
      finalAnswerText: 'partial answer',
      terminal: {
        kind: 'error',
        code: 'provider_error',
        message: 'provider unavailable',
      },
      failureCode: 'turn_error',
      failureMessage: 'provider unavailable',
      runEligible: false,
    });
  });

  it('keeps a successful tool-call-only run eligible while excluding its null answer metric', () => {
    const tracker = new FirstOutputTracker();
    tracker.acceptPrompt('prompt-1');
    tracker.push(toolCall('prompt-1'), 10);
    tracker.push(turnComplete('prompt-1'), 20);

    expect(tracker.snapshot()).toMatchObject({
      firstOutput: { kind: 'tool_call' },
      firstAnswer: null,
      finalAnswerText: null,
      runEligible: true,
      answerMetricEligible: false,
    });
    expect(nullablePercentiles([12, null, 18])).toEqual({
      totalCount: 3,
      eligibleCount: 2,
      missingCount: 1,
      distribution: {
        count: 2,
        p50: 12,
        p90: 18,
        p99: 18,
        mean: 15,
        min: 12,
        max: 18,
      },
    });
  });

  it('reports bounded pre-acceptance buffering overflow', () => {
    const tracker = new FirstOutputTracker({ maxBufferedEvents: 1 });
    tracker.push(answer('prompt-1', 'first'), 10);
    tracker.push(answer('prompt-1', 'overflow'), 11);
    tracker.acceptPrompt('prompt-1');

    expect(tracker.snapshot()).toMatchObject({
      firstOutput: { text: 'first' },
      failureCode: 'event_buffer_overflow',
      runEligible: false,
    });
  });

  it('preserves the first causal tracker failure', () => {
    const tracker = new FirstOutputTracker({ maxBufferedEvents: 1 });
    tracker.push(answer('prompt-1', 'first'), 10);
    tracker.push(answer('prompt-1', 'overflow'), 11);
    tracker.acceptPrompt('prompt-1');
    tracker.push(turnError('prompt-1', 'later failure'), 12);

    expect(tracker.snapshot()).toMatchObject({
      failureCode: 'event_buffer_overflow',
      failureMessage: 'More than 1 events arrived before prompt acceptance',
      terminal: { kind: 'error' },
    });
  });
});

describe('findInvalidTimings', () => {
  function makeTimings(
    overrides: Partial<FirstOutputSessionTimings> = {},
  ): FirstOutputSessionTimings {
    return {
      processToSessionReadyMs: 10,
      sseReadyToPromptMs: 5,
      promptToProviderRequestArrivalMs: 20,
      promptToFirstModelOutputMs: 30,
      promptToFirstAnswerTextMs: 35,
      providerReadyToFirstModelOutputMs: 8,
      processToFirstModelOutputMs: 40,
      promptToTerminalMs: 50,
      ...overrides,
    };
  }

  it('treats finite non-negative and null timings as valid', () => {
    expect(findInvalidTimings(makeTimings())).toEqual([]);
    expect(
      findInvalidTimings(
        makeTimings({
          promptToFirstAnswerTextMs: null,
          promptToTerminalMs: 0,
        }),
      ),
    ).toEqual([]);
  });

  it('collects every invalid timing instead of stopping at the first', () => {
    const invalid = findInvalidTimings(
      makeTimings({
        sseReadyToPromptMs: -1,
        promptToFirstModelOutputMs: Number.NaN,
      }),
    );
    expect(invalid).toHaveLength(2);
    expect(invalid).toEqual([
      ['sseReadyToPromptMs', -1],
      ['promptToFirstModelOutputMs', Number.NaN],
    ]);
  });
});

describe('statistics', () => {
  it('calculates predictable nearest-rank percentiles', () => {
    expect(percentiles([5, 1, 4, 2, 3])).toEqual({
      count: 5,
      p50: 3,
      p90: 5,
      p99: 5,
      mean: 3,
      min: 1,
      max: 5,
    });
    expect(percentiles([])).toBeNull();
  });

  it('produces deterministic seeded 10,000-iteration bootstrap statistics', () => {
    const samples: PairedMetricSample[] = [
      {
        order: 'AB',
        valid: true,
        controlMs: 120,
        candidateMs: 90,
      },
      {
        order: 'BA',
        valid: true,
        controlMs: 125,
        candidateMs: 92,
      },
      {
        order: 'AB',
        valid: true,
        controlMs: 115,
        candidateMs: 91,
      },
      {
        order: 'BA',
        valid: true,
        controlMs: 130,
        candidateMs: 95,
      },
    ];

    const first = pairedCandidateControlStats(samples, { seed: 7264 });
    const second = pairedCandidateControlStats(samples, { seed: 7264 });

    expect(first).toEqual(second);
    expect(first.bootstrapMedianCi95).toMatchObject({
      lowMs: -35,
      highMs: -24,
      iterations: DEFAULT_BOOTSTRAP_ITERATIONS,
      seed: 7264,
    });
    expect(first).toMatchObject({
      control: { p50: 120, p90: 130, p99: 130, mean: 122.5 },
      candidate: { p50: 91, p90: 95, p99: 95, mean: 92 },
      medianDeltaMs: -31.5,
      meanDeltaMs: -30.5,
      candidateWins: 4,
      controlWins: 0,
      ties: 0,
      orderSensitivity: {
        abMedianDeltaMs: -27,
        baMedianDeltaMs: -34,
      },
      decision: 'improved',
    });
  });

  it('detects material AB/BA direction reversal and makes the decision inconclusive', () => {
    const stats = pairedCandidateControlStats(
      [
        {
          order: 'AB',
          valid: true,
          controlMs: 100,
          candidateMs: 80,
        },
        {
          order: 'AB',
          valid: true,
          controlMs: 100,
          candidateMs: 82,
        },
        {
          order: 'BA',
          valid: true,
          controlMs: 100,
          candidateMs: 101,
        },
        {
          order: 'BA',
          valid: true,
          controlMs: 100,
          candidateMs: 102,
        },
      ],
      { seed: 5 },
    );

    expect(stats.orderSensitivity).toEqual({
      abEligiblePairs: 2,
      baEligiblePairs: 2,
      abMedianDeltaMs: -19,
      baMedianDeltaMs: 1.5,
      thresholdMs: 10,
      orderSensitive: true,
    });
    expect(stats.decision).toBe('inconclusive');
  });

  it('preserves invalid pairs and omits valid pairs missing a nullable metric', () => {
    const stats = pairedCandidateControlStats(
      [
        {
          order: 'AB',
          valid: false,
          controlMs: 100,
          candidateMs: 90,
        },
        {
          order: 'BA',
          valid: true,
          controlMs: 100,
          candidateMs: null,
        },
      ],
      { seed: 1 },
    );

    expect(stats).toMatchObject({
      totalPairs: 2,
      validPairs: 1,
      invalidPairs: 1,
      eligiblePairs: 0,
      missingMetricPairs: 1,
      decision: 'invalid',
    });
  });

  it('never promotes a partial comparison when any pair is invalid', () => {
    const stats = pairedCandidateControlStats(
      [
        {
          order: 'AB',
          valid: false,
          controlMs: 100,
          candidateMs: 80,
        },
        {
          order: 'AB',
          valid: true,
          controlMs: 100,
          candidateMs: 70,
        },
        {
          order: 'BA',
          valid: true,
          controlMs: 100,
          candidateMs: 70,
        },
      ],
      { seed: 1 },
    );

    expect(stats).toMatchObject({
      validPairs: 2,
      invalidPairs: 1,
      medianDeltaMs: -30,
      decision: 'invalid',
      decisionReason: 'At least one pair is invalid',
    });
  });
});

describe('runner decision contracts', () => {
  it('distinguishes accepted, legacy, and malformed prompt responses', () => {
    expect(
      validatePromptAcceptance({ promptId: 'prompt-1', lastEventId: 0 }),
    ).toEqual({
      kind: 'accepted',
      promptId: 'prompt-1',
      lastEventId: 0,
    });
    expect(validatePromptAcceptance({ stopReason: 'end_turn' })).toMatchObject({
      kind: 'failure',
      failure: { code: 'legacy_prompt_response' },
    });
    for (const malformed of [
      null,
      {},
      { promptId: '', lastEventId: 0 },
      { promptId: 'prompt-1', lastEventId: -1 },
      { promptId: 'prompt-1', lastEventId: 1.5 },
      { promptId: 'prompt-1', lastEventId: Number.NaN },
      { stopReason: 'end_turn', promptId: '' },
    ]) {
      expect(validatePromptAcceptance(malformed)).toMatchObject({
        kind: 'failure',
        failure: { code: 'prompt_rejected' },
      });
    }
  });

  it('applies the absolute and relative prototype gates only to complete baselines', () => {
    const tightAround = (centre: number) =>
      Array.from({ length: 30 }, (_, index) => centre - 1 + (index % 3));

    expect(
      evaluateSingleBundlePrototypeGate({
        complete: true,
        coldWarmPairedDeltasMs: [],
        seed: 7264,
        coldPromptToProviderRequestP50Ms: 200,
        warmPromptToProviderRequestP50Ms: 100,
        coldPromptToFirstModelOutputP50Ms: 400,
      }),
    ).toMatchObject({
      passed: false,
      pairedMedianDeltaMs: null,
      bootstrapMedianCi95: null,
    });
    expect(
      evaluateSingleBundlePrototypeGate({
        complete: true,
        coldWarmPairedDeltasMs: tightAround(30),
        seed: 7264,
        coldPromptToProviderRequestP50Ms: 200,
        warmPromptToProviderRequestP50Ms: 100,
        coldPromptToFirstModelOutputP50Ms: 400,
      }),
    ).toMatchObject({
      passed: true,
      providerDeltaMs: 100,
      pairedMedianDeltaMs: 30,
    });
    expect(
      evaluateSingleBundlePrototypeGate({
        complete: true,
        coldWarmPairedDeltasMs: tightAround(12),
        seed: 7264,
        coldPromptToProviderRequestP50Ms: 112,
        warmPromptToProviderRequestP50Ms: 100,
        coldPromptToFirstModelOutputP50Ms: 100,
      }),
    ).toMatchObject({ passed: true, pairedMedianDeltaMs: 12 });
    expect(
      evaluateSingleBundlePrototypeGate({
        complete: true,
        coldWarmPairedDeltasMs: tightAround(9),
        seed: 7264,
        coldPromptToProviderRequestP50Ms: 109,
        warmPromptToProviderRequestP50Ms: 100,
        coldPromptToFirstModelOutputP50Ms: 100,
      }),
    ).toMatchObject({ passed: false, pairedMedianDeltaMs: 9 });
    expect(
      evaluateSingleBundlePrototypeGate({
        complete: false,
        coldWarmPairedDeltasMs: tightAround(30),
        seed: 7264,
        coldPromptToProviderRequestP50Ms: 130,
        warmPromptToProviderRequestP50Ms: 100,
        coldPromptToFirstModelOutputP50Ms: 100,
      }),
    ).toMatchObject({ passed: false });
  });

  it('fails the prototype gate when a passing point estimate has a CI that crosses the threshold', () => {
    // Median 30 ms, but the samples are bimodal at -40 and 100 ms.
    const noisy = Array.from({ length: 30 }, (_, index) =>
      index % 2 === 0 ? -40 : 100,
    );
    const gate = evaluateSingleBundlePrototypeGate({
      complete: true,
      coldWarmPairedDeltasMs: noisy,
      seed: 7264,
      coldPromptToProviderRequestP50Ms: 130,
      warmPromptToProviderRequestP50Ms: 100,
      coldPromptToFirstModelOutputP50Ms: 400,
    });

    expect(gate.providerDeltaMs).toBe(30);
    expect(gate.pairedMedianDeltaMs).toBe(30);
    expect(gate.bootstrapMedianCi95?.lowMs).toBeLessThan(25);
    expect(gate.passed).toBe(false);
  });

  it('produces a deterministic prototype-gate interval for a fixed seed', () => {
    const deltas = Array.from({ length: 30 }, (_, index) => index);
    const input = {
      complete: true,
      coldWarmPairedDeltasMs: deltas,
      seed: 7264,
      bootstrapIterations: 200,
      coldPromptToProviderRequestP50Ms: 130,
      warmPromptToProviderRequestP50Ms: 100,
      coldPromptToFirstModelOutputP50Ms: 400,
    };

    const first = evaluateSingleBundlePrototypeGate(input);
    const second = evaluateSingleBundlePrototypeGate(input);
    expect(first).toEqual(second);
    expect(first.bootstrapMedianCi95).toMatchObject({
      lowMs: 9,
      highMs: 19.5,
      iterations: 200,
      seed: 7264,
    });

    const differentSeed = evaluateSingleBundlePrototypeGate({
      ...input,
      seed: 99,
    });
    expect(differentSeed.bootstrapMedianCi95).not.toEqual(
      first.bootstrapMedianCi95,
    );
  });

  it('rejects invalid prototype-gate inputs before sampling', () => {
    const validInput = {
      complete: true,
      coldWarmPairedDeltasMs: [30, 31, 29],
      seed: 7264,
      coldPromptToProviderRequestP50Ms: 200,
      warmPromptToProviderRequestP50Ms: 100,
      coldPromptToFirstModelOutputP50Ms: 400,
    };
    expect(() =>
      evaluateSingleBundlePrototypeGate({
        ...validInput,
        bootstrapIterations: 0,
      }),
    ).toThrow('bootstrapIterations must be a positive integer');
    expect(() =>
      evaluateSingleBundlePrototypeGate({ ...validInput, seed: Number.NaN }),
    ).toThrow('seed must be finite');
    expect(() =>
      evaluateSingleBundlePrototypeGate({
        ...validInput,
        coldWarmPairedDeltasMs: [Number.NaN],
      }),
    ).toThrow('coldWarmPairedDeltasMs must all be finite');
  });

  it('maps a mismatched final answer to the stable failure code', () => {
    expect(validateExpectedFinalText('expected', 'expected')).toBeNull();
    expect(validateExpectedFinalText('actual', 'expected')).toEqual({
      code: 'wrong_final_text',
      message: 'Unexpected final answer: "actual".',
    });
  });
});

describe('artifact rendering', () => {
  it('renders v1 metric and failure summaries without mutating the artifact', () => {
    const stats = pairedCandidateControlStats(
      [
        {
          order: 'AB',
          valid: true,
          controlMs: 100,
          candidateMs: 80,
        },
      ],
      { seed: 1 },
    );
    const artifact = {
      version: FIRST_OUTPUT_BENCHMARK_VERSION,
      benchmark: 'daemon-first-output',
      mode: 'paired',
      capturedAt: '2026-07-27T00:00:00.000Z',
      harnessGitCommit: null,
      platform: {
        os: 'darwin',
        arch: 'arm64',
        nodeVersion: 'v22.0.0',
        cpuModel: 'test',
        logicalCpuCount: 8,
        availableCpuCount: 8,
        totalMemoryBytes: 1,
        loadAverage: [0, 0, 0],
      },
      config: {
        seed: 1,
        warmupPairs: 0,
        measuredPairs: 1,
        bootstrapIterations: DEFAULT_BOOTSTRAP_ITERATIONS,
        materialThresholdMs: 10,
        orderSensitivityThresholdMs: 10,
        providerDelayMs: 50,
        providerConnection: 'close-per-response',
        postSessionDwellMs: 0,
        promptShape: 'reply',
        expectedAnswer: 'ok',
        maxBufferedEvents: 256,
        providerRequestsPerSession: 1,
        timeoutsMs: {},
        variants: {
          control: {
            cliPath: '/control',
            realpath: '/control',
            sha256: 'control-hash',
            compileCache: {
              policy: 'fixed-private-per-variant-warmed',
              directory: '/cache/control',
            },
          },
          candidate: {
            cliPath: '/candidate',
            realpath: '/candidate',
            sha256: 'candidate-hash',
            compileCache: {
              policy: 'fixed-private-per-variant-warmed',
              directory: '/cache/candidate',
            },
          },
        },
      },
      warmups: [],
      pairs: [],
      summary: {
        expectedPairs: 1,
        validPairs: 1,
        invalidPairs: 0,
        failuresByCode: { turn_error: 1 },
        metrics: {
          promptToFirstModelOutputMs: {
            all: null,
            bySession: { session_1: stats },
          },
        },
        decision: {
          outcome: 'improved',
          scope: 'primary_metric_only',
          publicationGateEvaluated: false,
          primaryMetric: 'processToFirstModelOutputMs',
          primarySession: 1,
          reasons: ['Candidate is faster'],
        },
      },
    } satisfies FirstOutputBenchmarkArtifactV2;
    const before = JSON.stringify(artifact);

    const markdown = renderFirstOutputBenchmarkMarkdown(artifact);

    expect(markdown).toContain('Primary metric decision: **improved**');
    expect(markdown).toContain('| promptToFirstModelOutputMs |');
    expect(markdown).toContain('Control p50/p90/p99/mean');
    expect(markdown).toContain('Wins candidate/control/ties');
    expect(markdown).toContain('80.0/80.0/80.0/80.0');
    expect(markdown).toContain('- turn_error: 1');
    expect(JSON.stringify(artifact)).toBe(before);
  });

  it('renders a fatal configuration artifact', () => {
    const artifact = {
      version: FIRST_OUTPUT_BENCHMARK_VERSION,
      benchmark: 'daemon-first-output',
      mode: 'failed',
      capturedAt: '2026-07-27T00:00:00.000Z',
      harnessGitCommit: null,
      platform: {
        os: 'linux',
        arch: 'x64',
        nodeVersion: 'v22.0.0',
        cpuModel: 'test',
        logicalCpuCount: 2,
        availableCpuCount: 2,
        totalMemoryBytes: 1,
        loadAverage: [0, 0, 0],
      },
      config: { requestedMode: 'unknown' },
      failure: {
        code: 'invalid_configuration',
        message: 'bundle path is missing',
      },
      summary: {
        failuresByCode: { invalid_configuration: 1 },
        decision: {
          outcome: 'invalid',
          reasons: ['bundle path is missing'],
        },
      },
    } satisfies FirstOutputBenchmarkArtifactV2;

    expect(renderFirstOutputBenchmarkMarkdown(artifact)).toContain(
      'Failure: invalid_configuration',
    );
  });
});
