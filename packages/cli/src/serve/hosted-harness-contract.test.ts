/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  createHostedHarnessContract,
  HOSTED_HARNESS_BOOT_ID_HEADER,
  HOSTED_HARNESS_PROTOCOL_HEADER,
  HOSTED_HARNESS_UPGRADE,
  installHostedHarnessContractMiddleware,
} from './hosted-harness-contract.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const BOOT_ID = '11111111-1111-4111-8111-111111111111';

function createApp() {
  const app = express();
  installHostedHarnessContractMiddleware(
    app,
    createHostedHarnessContract(DIGEST, BOOT_ID),
  );
  app.get('/session/:id', (req, res) => {
    res.status(200).json({ sessionId: req.params['id'] });
  });
  return app;
}

describe('Hosted Harness private contract', () => {
  it('creates a stable capability envelope', () => {
    expect(createHostedHarnessContract(DIGEST, BOOT_ID)).toEqual({
      protocolVersions: { current: 1, supported: [1] },
      bootId: BOOT_ID,
      capabilityDigest: DIGEST,
    });
  });

  it('requires the private protocol header', async () => {
    const response = await supertest(createApp()).get('/session/example');

    expect(response.status).toBe(426);
    expect(response.headers['upgrade']).toBe(HOSTED_HARNESS_UPGRADE);
    expect(response.headers['x-qwen-harness-boot-id']).toBe(BOOT_ID);
    expect(response.body).toEqual({
      error: 'Hosted Harness protocol version 1 is required.',
      code: 'hosted_harness_protocol_required',
    });
  });

  it('rejects an unsupported private protocol version', async () => {
    const response = await supertest(createApp())
      .get('/session/example')
      .set(HOSTED_HARNESS_PROTOCOL_HEADER, '2')
      .set(HOSTED_HARNESS_BOOT_ID_HEADER, BOOT_ID);

    expect(response.status).toBe(426);
    expect(response.headers['upgrade']).toBe(HOSTED_HARNESS_UPGRADE);
    expect(response.body.code).toBe('hosted_harness_protocol_required');
  });

  it('rejects malformed and stale boot ids', async () => {
    const malformed = await supertest(createApp())
      .get('/session/example')
      .set(HOSTED_HARNESS_PROTOCOL_HEADER, '1')
      .set(HOSTED_HARNESS_BOOT_ID_HEADER, 'not-a-uuid');
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('invalid_hosted_harness_boot_id');

    const stale = await supertest(createApp())
      .get('/session/example')
      .set(HOSTED_HARNESS_PROTOCOL_HEADER, '1')
      .set(
        HOSTED_HARNESS_BOOT_ID_HEADER,
        '22222222-2222-4222-8222-222222222222',
      );
    expect(stale.status).toBe(409);
    expect(stale.headers['x-qwen-harness-boot-id']).toBe(BOOT_ID);
    expect(stale.body.code).toBe('hosted_harness_generation_mismatch');
  });

  it('passes a matching generation to the session route', async () => {
    const response = await supertest(createApp())
      .get('/session/example')
      .set(HOSTED_HARNESS_PROTOCOL_HEADER, '1')
      .set(HOSTED_HARNESS_BOOT_ID_HEADER, BOOT_ID.toUpperCase());

    expect(response.status).toBe(200);
    expect(response.headers['x-qwen-harness-boot-id']).toBe(BOOT_ID);
    expect(response.body).toEqual({ sessionId: 'example' });
  });

  it('leaves ordinary session routes unchanged when no contract is installed', async () => {
    const app = express();
    installHostedHarnessContractMiddleware(app, undefined);
    app.get('/session/:id', (req, res) => {
      res.status(200).json({ sessionId: req.params['id'] });
    });

    const response = await supertest(app).get('/session/example');

    expect(response.status).toBe(200);
    expect(response.headers['x-qwen-harness-boot-id']).toBeUndefined();
  });
});
