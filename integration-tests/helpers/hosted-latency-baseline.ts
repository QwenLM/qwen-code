/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';

export const HOSTED_PROVISIONING_DELAY_MS = 15_000;

export interface HostedLatencySample {
  scenario: 'no-tool' | 'tool';
  warmRequestedMs: number;
  runtimeReadyMs: number;
  firstVisibleTextMs: number;
  turnCompleteMs: number;
  acquireMs: number | null;
  executionStartMs: number | null;
  toolWaitMs: number | null;
  sameContext: boolean | null;
  storeRequests: number;
  modelRounds: Array<{
    requestMs: number;
    firstTextMs: number;
    finishedMs: number;
  }>;
}

export interface HostedLatencyMeasurement {
  version: 1;
  provider: 'local-openai-fixture';
  runtimeProvisioningDelayMs: number;
  samples: HostedLatencySample[];
}

function time(value: number | null, name: string): asserts value is number {
  assert(
    typeof value === 'number' && Number.isFinite(value) && value >= 0,
    name,
  );
}

export function validateHostedLatency(report: HostedLatencyMeasurement) {
  assert.equal(report.version, 1);
  assert.equal(report.provider, 'local-openai-fixture');
  assert.equal(report.runtimeProvisioningDelayMs, HOSTED_PROVISIONING_DELAY_MS);
  assert.deepEqual(report.samples.map((sample) => sample.scenario).sort(), [
    'no-tool',
    'tool',
  ]);
  for (const sample of report.samples) {
    for (const name of [
      'warmRequestedMs',
      'runtimeReadyMs',
      'firstVisibleTextMs',
      'turnCompleteMs',
    ] as const)
      time(sample[name], name);
    assert(
      Number.isSafeInteger(sample.storeRequests) && sample.storeRequests > 0,
    );
    assert(
      sample.runtimeReadyMs - sample.warmRequestedMs >=
        HOSTED_PROVISIONING_DELAY_MS,
    );
    assert(sample.firstVisibleTextMs <= sample.turnCompleteMs);
    assert.equal(sample.modelRounds.length, sample.scenario === 'tool' ? 2 : 1);
    for (const round of sample.modelRounds) {
      for (const name of ['requestMs', 'firstTextMs', 'finishedMs'] as const)
        time(round[name], name);
      assert(
        round.requestMs <= round.firstTextMs &&
          round.firstTextMs <= round.finishedMs,
      );
    }
    const first = sample.modelRounds[0];
    assert(
      first.firstTextMs < sample.runtimeReadyMs,
      'model text precedes readiness',
    );
    // Text streams as durable message.delta events, so it becomes visible
    // while the model round is still running, not only after it finishes.
    assert(
      first.firstTextMs <= sample.firstVisibleTextMs,
      'visible text follows the first provider delta',
    );
    if (sample.scenario === 'no-tool') {
      assert(
        sample.warmRequestedMs <= sample.turnCompleteMs,
        'provisioning starts before no-tool completion',
      );
      assert(
        sample.turnCompleteMs < sample.runtimeReadyMs,
        'no-tool completion precedes readiness',
      );
      assert.equal(sample.acquireMs, null);
      assert.equal(sample.executionStartMs, null);
      assert.equal(sample.toolWaitMs, null);
      assert.equal(sample.sameContext, null);
    } else {
      time(sample.acquireMs, 'acquireMs');
      time(sample.executionStartMs, 'executionStartMs');
      time(sample.toolWaitMs, 'toolWaitMs');
      assert(
        first.finishedMs < sample.runtimeReadyMs,
        'tool request precedes readiness',
      );
      assert.equal(sample.toolWaitMs, sample.runtimeReadyMs - first.finishedMs);
      assert(sample.runtimeReadyMs <= sample.acquireMs);
      assert(sample.acquireMs <= sample.executionStartMs);
      assert(sample.executionStartMs < sample.modelRounds[1].requestMs);
      assert.equal(sample.sameContext, true);
    }
  }
}

export function compareHostedLatency(
  baseline: HostedLatencyMeasurement,
  current: HostedLatencyMeasurement,
) {
  validateHostedLatency(baseline);
  validateHostedLatency(current);
  return current.samples.map((sample) => {
    const previous = baseline.samples.find(
      (item) => item.scenario === sample.scenario,
    )!;
    return {
      scenario: sample.scenario,
      firstModelTextDeltaMs:
        sample.modelRounds[0].firstTextMs - previous.modelRounds[0].firstTextMs,
      firstVisibleTextDeltaMs:
        sample.firstVisibleTextMs - previous.firstVisibleTextMs,
      turnCompleteDeltaMs: sample.turnCompleteMs - previous.turnCompleteMs,
      toolWaitDeltaMs:
        sample.toolWaitMs === null
          ? null
          : sample.toolWaitMs - previous.toolWaitMs!,
      storeRequestsDelta: sample.storeRequests - previous.storeRequests,
    };
  });
}
