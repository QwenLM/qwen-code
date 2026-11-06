/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import express from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHostedHarnessContract,
  HOSTED_HARNESS_BOOT_ID_HEADER,
  HOSTED_HARNESS_PROTOCOL_HEADER,
} from './hosted-harness-contract.js';
import {
  registerHostedPackagePreparation,
  HOSTED_PACKAGE_PREPARATION_PREFIX as base,
} from './hosted-package-preparation.js';

const boot = '11111111-1111-4111-8111-111111111111';
const scope = {
  tenantId: 'tenant',
  workspaceId: 'workspace',
  actorKey: 'a'.repeat(64),
};
const target = { platform: 'linux', arch: 'x64' };
const document = Buffer.from(
  JSON.stringify({
    name: 'sample',
    serverName: 'tools',
    recipe: { command: 'node', args: ['server.js'] },
  }),
);
const metadata = {
  ...scope,
  input: {
    sourceKind: 'mcp',
    target,
    sourceDigest: createHash('sha256').update(document).digest('hex'),
    compilerVersion: 1,
  },
};
let close: () => Promise<void>;
let app: express.Application;
let accepting: boolean;

beforeEach(() => {
  app = express();
  accepting = true;
  app.use((req, res, next) => {
    if (req.get('Authorization') !== 'Bearer internal') res.sendStatus(401);
    else next();
  });
  close = registerHostedPackagePreparation(
    app,
    createHostedHarnessContract(`sha256:${'f'.repeat(64)}`, boot),
    { accepting: () => accepting },
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});
function headers(request: supertest.Test) {
  return request
    .set('Authorization', 'Bearer internal')
    .set(HOSTED_HARNESS_PROTOCOL_HEADER, '1')
    .set(HOSTED_HARNESS_BOOT_ID_HEADER, boot);
}
function prepare(input = metadata) {
  return headers(
    supertest(app)
      .post(`${base}/prepare`)
      .query({ metadata: JSON.stringify(input) }),
  )
    .set('Content-Type', 'application/octet-stream')
    .send(document);
}

describe('Hosted process-global package preparation', () => {
  it('previews normalized source without retaining preparation handles', async () => {
    for (let index = 0; index < 17; index++) {
      const result = await headers(
        supertest(app)
          .post(`${base}/preview`)
          .query({ metadata: JSON.stringify(metadata) }),
      )
        .set('Content-Type', 'application/octet-stream')
        .send(document)
        .expect(200);
      expect(result.body.manifest.name).toBe('sample');
      expect(result.body.preparationId).toBeUndefined();
    }
  });
  it('prepares without a Session and restricts artifact reads to the original scope and boot', async () => {
    const result = await prepare().expect(201);
    expect(result.body.manifest).toMatchObject({
      name: 'sample',
      sourceType: 'snapshot',
    });
    expect(result.body.inspection.mcpServers[0]).toMatchObject({
      name: 'tools',
      redacted: false,
    });
    const url = `${base}/${result.body.preparationId}/archive`;
    const archive = await headers(
      supertest(app)
        .get(url)
        .query({ scope: JSON.stringify(scope) }),
    ).expect(200);
    expect(createHash('sha256').update(archive.body).digest('hex')).toBe(
      result.body.packageDigest,
    );
    await headers(
      supertest(app)
        .get(url)
        .query({
          scope: JSON.stringify({ ...scope, actorKey: 'b'.repeat(64) }),
        }),
    ).expect(404);
    await headers(
      supertest(app)
        .get(url)
        .query({ scope: JSON.stringify(scope) }),
    )
      .set(
        HOSTED_HARNESS_BOOT_ID_HEADER,
        '22222222-2222-4222-8222-222222222222',
      )
      .expect(409);
    const inspection = await headers(
      supertest(app)
        .post(`${base}/inspect`)
        .query({
          metadata: JSON.stringify({
            ...scope,
            input: {
              ...metadata.input,
              sourceKind: 'extension',
              sourceDigest: result.body.packageDigest,
            },
          }),
        }),
    )
      .set('Content-Type', 'application/octet-stream')
      .send(archive.body)
      .expect(200);
    expect(inspection.body).toEqual(result.body.inspection);
  });

  it('rejects unauthorized, malformed and mismatching inputs', async () => {
    await supertest(app).post(`${base}/prepare`).expect(401);
    await headers(supertest(app).post(`${base}/prepare`)).expect(400);
    await prepare({
      ...metadata,
      input: { ...metadata.input, sourceDigest: '0'.repeat(64) },
    }).expect(400);
    await headers(
      supertest(app)
        .post(`${base}/prepare`)
        .query({ metadata: JSON.stringify(metadata) }),
    )
      .set('Content-Type', 'application/json')
      .send({})
      .expect(400);
  });

  it('expires handles and refuses new preparation while draining', async () => {
    const result = await prepare().expect(201);
    accepting = false;
    await prepare().expect(409);
    const original = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(original + 16 * 60_000);
    await headers(
      supertest(app)
        .get(`${base}/${result.body.preparationId}/archive`)
        .query({ scope: JSON.stringify(scope) }),
    ).expect(404);
  });
});
