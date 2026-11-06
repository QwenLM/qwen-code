/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { createHostedHarnessContract } from './hosted-harness-contract.js';
import {
  HostedHarnessInstance,
  parseHostedHarnessPlacement,
} from './hosted-harness-instance.js';

const bootId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const digest = `sha256:${'a'.repeat(64)}`;

function fixture() {
  const app = express();
  app.use(express.json());
  const counters = {
    attachedSessions: 1,
    activeTurns: 0,
    openingSessions: 0,
    pendingInputs: 0,
    heldResources: 0,
    pendingPublications: 0,
  };
  const contract = {
    ...createHostedHarnessContract(digest, bootId, [], 'pod-a'),
    instanceId: 'pod-a',
  };
  const instance = new HostedHarnessInstance(contract, () => counters);
  instance.register(app);
  return { app, counters, instance };
}

function headers(request: supertest.Test) {
  return request
    .set('X-Qwen-Harness-Protocol-Version', '1')
    .set('X-Qwen-Harness-Boot-Id', bootId);
}

describe('Hosted Harness instance lifecycle', () => {
  it('fences process identity and drains every owner before declaring DRAINED', async () => {
    const { app, counters, instance } = fixture();
    const route = '/internal/hosted-harness/v1';
    expect((await supertest(app).get(`${route}/instance`)).status).toBe(426);
    const drain = () =>
      headers(supertest(app).post(`${route}/instance:drain`)).send({
        operationId,
        expectedBootId: bootId,
      });
    expect((await drain()).body.state).toBe('QUIESCING');
    expect(instance.accepting).toBe(false);
    expect((await drain()).status).toBe(202);
    expect(
      (
        await headers(supertest(app).post(`${route}/instance:drain`)).send({
          operationId: bootId,
          expectedBootId: bootId,
        })
      ).status,
    ).toBe(409);
    counters.attachedSessions = 0;
    counters.heldResources = 1;
    expect(instance.snapshot().state).toBe('QUIESCING');
    counters.heldResources = 0;
    expect(instance.snapshot().state).toBe('DRAINED');
    const metrics = await headers(supertest(app).get(`${route}/metrics`));
    expect(metrics.headers['cache-control']).toBe('no-store');
    expect(metrics.body.process.rssBytes).toBeGreaterThan(0);
    expect(JSON.stringify(metrics.body)).not.toContain('tenantId');
  });

  it('requires a complete placement and leaves the local contract opt-in', () => {
    expect(
      createHostedHarnessContract(digest, bootId, [], undefined).features,
    ).not.toContain('harness-pool-owner/1');
    expect(
      parseHostedHarnessPlacement({
        instanceId: 'pod-a',
        bootId,
        placementEpoch: 2,
      }).placementEpoch,
    ).toBe(2);
    for (const value of [
      null,
      { instanceId: 'pod-a', bootId },
      { instanceId: '../pod', bootId, placementEpoch: 1 },
      { instanceId: 'pod-a', bootId, placementEpoch: 0 },
      { instanceId: 'pod-a', bootId, placementEpoch: 1, extra: true },
    ])
      expect(() => parseHostedHarnessPlacement(value)).toThrow();
  });
});
