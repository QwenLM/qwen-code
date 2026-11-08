/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compareHostedLatency,
  validateHostedLatency,
  type HostedLatencyMeasurement,
} from '../helpers/hosted-latency-baseline.js';

function fixture(): HostedLatencyMeasurement {
  return {
    version: 1,
    provider: 'local-openai-fixture',
    runtimeProvisioningDelayMs: 15_000,
    samples: [
      {
        scenario: 'no-tool',
        warmRequestedMs: 10,
        runtimeReadyMs: 15_200,
        firstVisibleTextMs: 800,
        turnCompleteMs: 900,
        acquireMs: null,
        executionStartMs: null,
        toolWaitMs: null,
        sameContext: null,
        storeRequests: 12,
        modelRounds: [{ requestMs: 200, firstTextMs: 210, finishedMs: 250 }],
      },
      {
        scenario: 'tool',
        warmRequestedMs: 10,
        runtimeReadyMs: 15_200,
        firstVisibleTextMs: 16_000,
        turnCompleteMs: 16_010,
        acquireMs: 15_210,
        executionStartMs: 15_220,
        toolWaitMs: 14_950,
        sameContext: true,
        storeRequests: 40,
        modelRounds: [
          { requestMs: 200, firstTextMs: 210, finishedMs: 250 },
          { requestMs: 15_500, firstTextMs: 15_510, finishedMs: 15_600 },
        ],
      },
    ],
  };
}

describe('Hosted latency baseline gate', () => {
  it('reads the checked-in capture and compares measurements without absolute time gates', () => {
    const baseline = JSON.parse(
      readFileSync(
        new URL('../baselines/hosted-latency.json', import.meta.url),
        'utf8',
      ),
    );
    validateHostedLatency(baseline);
    expect(baseline.gitCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline.environment.database).toBeTruthy();
    expect(compareHostedLatency(baseline, fixture())).toHaveLength(2);
    const slower = fixture();
    slower.samples[1].turnCompleteMs += 10_000;
    expect(compareHostedLatency(fixture(), slower)[1].turnCompleteDeltaMs).toBe(
      10_000,
    );
  });

  it.each([
    ['missing scenario', (r: HostedLatencyMeasurement) => r.samples.pop()],
    [
      'duplicate scenario',
      (r: HostedLatencyMeasurement) => r.samples.push(r.samples[0]),
    ],
    [
      'changed fixture delay',
      (r: HostedLatencyMeasurement) => {
        r.runtimeProvisioningDelayMs = 100;
      },
    ],
    [
      'delay not applied',
      (r: HostedLatencyMeasurement) => {
        r.samples[0].runtimeReadyMs = 1000;
      },
    ],
    [
      'missing text',
      (r: HostedLatencyMeasurement) => {
        r.samples[0].firstVisibleTextMs = -1;
      },
    ],
    [
      'text before model output',
      (r: HostedLatencyMeasurement) => {
        r.samples[0].firstVisibleTextMs = 100;
      },
    ],
    [
      'nonfinite time',
      (r: HostedLatencyMeasurement) => {
        r.samples[0].turnCompleteMs = NaN;
      },
    ],
    [
      'infinite time',
      (r: HostedLatencyMeasurement) => {
        r.samples[0].turnCompleteMs = Infinity;
      },
    ],
    [
      'no-tool waits',
      (r: HostedLatencyMeasurement) => {
        r.samples[0].turnCompleteMs = 16_000;
      },
    ],
    [
      'no-tool provisioning starts after completion',
      (r: HostedLatencyMeasurement) => {
        r.samples[0].warmRequestedMs = r.samples[0].turnCompleteMs + 1000;
        r.samples[0].runtimeReadyMs = r.samples[0].warmRequestedMs + 15_000;
      },
    ],
    [
      'model waits',
      (r: HostedLatencyMeasurement) => {
        r.samples[1].modelRounds[0] = {
          requestMs: 15_300,
          firstTextMs: 15_310,
          finishedMs: 15_320,
        };
      },
    ],
    [
      'early acquisition',
      (r: HostedLatencyMeasurement) => {
        r.samples[1].acquireMs = 500;
      },
    ],
    [
      'early continuation',
      (r: HostedLatencyMeasurement) => {
        r.samples[1].modelRounds[1] = {
          requestMs: 500,
          firstTextMs: 510,
          finishedMs: 520,
        };
      },
    ],
    [
      'lost context',
      (r: HostedLatencyMeasurement) => {
        r.samples[1].sameContext = false;
      },
    ],
    [
      'no continuation',
      (r: HostedLatencyMeasurement) => {
        r.samples[1].modelRounds.pop();
      },
    ],
    [
      'no SQL traffic',
      (r: HostedLatencyMeasurement) => {
        r.samples[1].storeRequests = 0;
      },
    ],
    [
      'wrong wait duration',
      (r: HostedLatencyMeasurement) => {
        r.samples[1].toolWaitMs = 0;
      },
    ],
  ] as const)('rejects %s', (_name, mutate) => {
    const report = fixture();
    mutate(report);
    expect(() => compareHostedLatency(fixture(), report)).toThrow();
  });
});
