/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import express from 'express';
import supertest from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bearerAuth } from './auth.js';
import {
  createHostedHarnessContract,
  installHostedHarnessContractMiddleware,
} from './hosted-harness-contract.js';
import { registerHostedCsiSessionRoutes } from './hosted-csi-session.js';
import { CSI_FILES_ACTIVITY_CAPABILITY_DIGEST } from './managed-csi-file-profile.js';

describe('private original CSI Hosted routes', () => {
  afterEach(() => vi.restoreAllMocks());

  function setup(authenticated = true, ordinaryOwns = false) {
    const app = express();
    const contract = createHostedHarnessContract(`sha256:${'a'.repeat(64)}`);
    app.use(bearerAuth(authenticated ? 'operator' : undefined));
    app.use(express.json());
    installHostedHarnessContractMiddleware(app, contract);
    const handle = registerHostedCsiSessionRoutes(
      app,
      contract,
      'http://127.0.0.1:8081',
      { baseUrl: 'http://127.0.0.1:8080', token: 'broker' },
      () => ordinaryOwns,
    );
    const id = randomUUID();
    const body = {
      tenantId: 'tenant',
      workspaceId: 'workspace',
      writerToken: 'a'.repeat(32),
    };
    const headers = {
      Authorization: 'Bearer operator',
      'X-Qwen-Harness-Protocol-Version': '1',
      'X-Qwen-Harness-Boot-Id': contract.bootId,
    };
    return { app, handle, id, body, headers };
  }

  it('requires verified operator credentials even on an open loopback app', async () => {
    const { app, handle, id, body, headers } = setup(false);
    const rpc = vi.spyOn(globalThis, 'fetch');
    try {
      const response = await supertest(app)
        .post(`/session/${id}/internal-csi/attach`)
        .set(headers)
        .send(body);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('csi_operator_authentication_required');
      expect(rpc).not.toHaveBeenCalled();
    } finally {
      await handle.stopLocal();
    }
  });

  it('accepts the activity profile identity before negotiating the Session store', async () => {
    const { app, handle, id, body, headers } = setup();
    const routes: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const route = new URL(String(url)).pathname;
      routes.push(route);
      if (route.endsWith('tool-sessions:acquire'))
        return Response.json({
          protocolVersion: 1,
          acquired: true,
          harnessSessionId: id,
          runtimeSessionId: id,
          scope: {
            tenantId: 'tenant',
            workspaceId: 'workspace',
            workspaceGeneration: '1',
            canonicalCwd: '/workspace',
            capabilityDigest: CSI_FILES_ACTIVITY_CAPABILITY_DIGEST,
            isolationClass: 'session',
          },
          runtime: { bindingId: randomUUID(), generation: '1' },
        });
      return Response.json(
        {
          error: {
            code: 'fixture_store_closed',
            message: 'Closed for this test.',
          },
        },
        { status: 409 },
      );
    });
    try {
      const response = await supertest(app)
        .post(`/session/${id}/internal-csi/attach`)
        .set(headers)
        .send(body);
      expect(response.status).toBe(503);
      expect(response.body.code).not.toBe('csi_runtime_identity_conflict');
      expect(routes.some((route) => route.endsWith('/writers:acquire'))).toBe(
        true,
      );
    } finally {
      await handle.stopLocal();
    }
  });

  it('rejects injected authority and ordinary ownership before any Broker or Store I/O', async () => {
    const rpc = vi.spyOn(globalThis, 'fetch');
    for (const ordinary of [false, true]) {
      const { app, handle, id, body, headers } = setup(true, ordinary);
      try {
        for (const extra of [
          { cwd: '/foreign' },
          { baseUrl: 'https://foreign.example' },
          { toolProfile: 'csi-files-retirement/1' },
          { lifecycle: {} },
          { deadlineMs: 1 },
        ]) {
          const response = await supertest(app)
            .post(`/session/${id}/internal-csi/attach`)
            .set(headers)
            .send({ ...body, ...extra });
          expect(response.status).toBe(400);
        }
        if (ordinary) {
          const response = await supertest(app)
            .post(`/session/${id}/internal-csi/attach`)
            .set(headers)
            .send(body);
          expect(response.status).toBe(409);
          expect(response.body.code).toBe('csi_session_owner_conflict');
        }
      } finally {
        await handle.stopLocal();
      }
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3, 4])(
    'checks the activity storage floor before publishing CSI genesis (storage=%s)',
    async (supportedStorageVersion) => {
      const { app, handle, id, body, headers } = setup();
      const routes: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const route = new URL(String(url)).pathname;
        routes.push(route);
        if (route.endsWith('tool-sessions:acquire'))
          return Response.json({
            protocolVersion: 1,
            acquired: true,
            harnessSessionId: id,
            runtimeSessionId: id,
            scope: {
              tenantId: 'tenant',
              workspaceId: 'workspace',
              workspaceGeneration: '1',
              canonicalCwd: '/workspace',
              capabilityDigest: CSI_FILES_ACTIVITY_CAPABILITY_DIGEST,
              isolationClass: 'session',
            },
            runtime: { bindingId: randomUUID(), generation: '1' },
          });
        if (route.endsWith('/writers:acquire'))
          return Response.json(
            {
              supportedStorageVersion,
              activationLeaseRenewal: false,
              writerGeneration: 1,
              leaseUntil: Date.now() + 300_000,
              journalRevision: 0,
              committedSequence: 0,
              activationEpoch: 0,
              replayed: false,
            },
            { headers: { 'Cache-Control': 'no-store' } },
          );
        return Response.json(
          {
            error: {
              code: 'fixture_stop',
              message: 'Stop after the floor check.',
            },
          },
          { status: 409 },
        );
      });
      try {
        const response = await supertest(app)
          .post('/session/' + id + '/internal-csi/attach')
          .set(headers)
          .send(body);
        expect(routes.some((route) => route.endsWith('/writers:acquire'))).toBe(
          true,
        );
        if (supportedStorageVersion < 4) {
          expect(response.body.code).toBe('csi_activity_storage_unavailable');
          expect(routes.some((route) => route.endsWith('/restore'))).toBe(
            false,
          );
        } else {
          expect(response.body.code).not.toBe(
            'csi_activity_storage_unavailable',
          );
          expect(routes.some((route) => route.endsWith('/restore'))).toBe(true);
        }
      } finally {
        await handle.stopLocal();
      }
    },
  );

  it('retains failed attachment identity and closes ordinary aliases and stopped entry', async () => {
    const { app, handle, id, body, headers } = setup();
    const rpc = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 409 }));
    const route = `/session/${id}/internal-csi/attach`;
    try {
      const first = await supertest(app).post(route).set(headers).send(body);
      expect(first.status).toBe(409);
      expect(first.body.code).toBe('csi_runtime_admission_closed');
      const retry = await supertest(app).post(route).set(headers).send(body);
      expect(retry.body.code).toBe('csi_attachment_recovery_required');
      expect(rpc).toHaveBeenCalledTimes(1);
      for (const alias of [id, id.toUpperCase()]) {
        expect(
          (
            await supertest(app)
              .post(`/session/${alias}/load`)
              .set(headers)
              .send({})
          ).body.code,
        ).toBe('csi_private_route_closed');
        expect(
          (
            await supertest(app)
              .post('/session')
              .set(headers)
              .send({ sessionId: alias })
          ).body.code,
        ).toBe('csi_private_route_closed');
      }
      await handle.stopLocal();
      expect(
        (await supertest(app).post(route).set(headers).send(body)).body.code,
      ).toBe('csi_attachment_stopped');
      expect(rpc).toHaveBeenCalledTimes(1);
    } finally {
      await handle.stopLocal();
    }
  });
});
