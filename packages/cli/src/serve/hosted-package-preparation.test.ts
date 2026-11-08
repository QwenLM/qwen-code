/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHostedHarnessContract,
  HOSTED_HARNESS_BOOT_ID_HEADER,
  HOSTED_HARNESS_PROTOCOL_HEADER,
} from './hosted-harness-contract.js';
import { HostedHarnessInstance } from './hosted-harness-instance.js';
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
let instance: HostedHarnessInstance;

beforeEach(() => {
  app = express();
  app.use(express.json());
  accepting = true;
  app.use((req, res, next) => {
    if (req.get('Authorization') !== 'Bearer internal') res.sendStatus(401);
    else next();
  });
  const contract = createHostedHarnessContract(
    `sha256:${'f'.repeat(64)}`,
    boot,
  );
  instance = new HostedHarnessInstance(
    { ...contract, instanceId: 'preparation-test' },
    () => ({
      attachedSessions: 0,
      activeTurns: 0,
      openingSessions: 0,
      pendingInputs: 0,
      heldResources: 0,
      pendingPublications: 0,
    }),
  );
  instance.register(app);
  close = registerHostedPackagePreparation(app, contract, {
    accepting: () => accepting && instance.accepting,
    beginOperation: instance.beginOperation,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
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
  it.each(['prepare', 'preview', 'inspect'])(
    'releases the instance operation after a cancelled %s settles',
    async (mode) => {
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No listener');
      const request = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        path: `${base}/${mode}?metadata=${encodeURIComponent(
          JSON.stringify({
            ...metadata,
            input: {
              ...metadata.input,
              sourceKind: mode === 'inspect' ? 'extension' : 'mcp',
            },
          }),
        )}`,
        method: 'POST',
        headers: {
          Authorization: 'Bearer internal',
          [HOSTED_HARNESS_PROTOCOL_HEADER]: '1',
          [HOSTED_HARNESS_BOOT_ID_HEADER]: boot,
          'Content-Type': 'application/octet-stream',
          'Content-Length': document.length,
        },
      });
      request.on('error', () => undefined);
      try {
        request.write(document.subarray(0, 1));
        await vi.waitFor(() => expect(instance.inFlightMutations).toBe(1));
        request.destroy();
        await vi.waitFor(() => expect(instance.inFlightMutations).toBe(0));
        const result = await headers(
          supertest(app).post('/internal/hosted-harness/v1/instance:drain'),
        )
          .send({
            operationId: '22222222-2222-4222-8222-222222222222',
            expectedBootId: boot,
          })
          .expect(202);
        expect(result.body.state).toBe('DRAINED');
      } finally {
        request.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it('keeps the instance busy until response cleanup completes', async () => {
    const remove = fs.rm;
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const cleaning = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      if (
        path.basename(String(file)).startsWith('qwen-hosted-package-') &&
        options?.recursive
      ) {
        entered();
        await cleanup;
      }
      return remove(file, options);
    });
    syncBuiltinESMExports();
    try {
      const response = headers(
        supertest(app)
          .post(`${base}/preview`)
          .query({ metadata: JSON.stringify(metadata) }),
      )
        .set('Content-Type', 'application/octet-stream')
        .send(document)
        .expect(200);
      await Promise.all([response, cleaning]);
      expect(instance.inFlightMutations).toBe(1);
      const result = await headers(
        supertest(app).post('/internal/hosted-harness/v1/instance:drain'),
      )
        .send({
          operationId: '22222222-2222-4222-8222-222222222222',
          expectedBootId: boot,
        })
        .expect(202);
      expect(result.body.state).toBe('QUIESCING');
      release();
      await vi.waitFor(() => expect(instance.snapshot().state).toBe('DRAINED'));
      expect(instance.inFlightMutations).toBe(0);
    } finally {
      release();
    }
  });

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
