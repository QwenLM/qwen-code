/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { CapabilityVerifier } from './capability-verifier.js';
import { computeRequestHmac, sha256Base64Url } from './request-binding.js';

describe('CapabilityVerifier', () => {
  const issuer = 'https://broker.example.test';
  const audience = 'qwen-memory-gateway';
  const now = new Date('2026-07-22T00:00:00.000Z');
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const requestSecret = randomBytes(32);
  const certificateThumbprint = sha256Base64Url('certificate');
  const body = Buffer.from('{"query":"build"}');
  const operationId = randomUUID();
  const request = {
    method: 'POST',
    route: '/v1/runtime/search',
    operationId,
    body,
    peerCertificateThumbprint: certificateThumbprint,
    requiredCapability: 'memory:read' as const,
  };
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  let verifier: CapabilityVerifier;

  it.each([
    { requestHmacSecret: new Uint8Array() },
    { maxTokenTtlSeconds: 301 },
    { clockToleranceSeconds: Number.NaN },
  ])('rejects unsafe verifier configuration: %o', (override) => {
    expect(
      () =>
        new CapabilityVerifier({
          issuer,
          audience,
          expectedTenantId: 'tenant-a',
          key: async () => privateKey,
          requestHmacSecret: requestSecret,
          ...override,
        }),
    ).toThrow('configuration is invalid');
  });

  beforeAll(async () => {
    const keys = await generateKeyPair('ES256');
    privateKey = keys.privateKey;
    verifier = new CapabilityVerifier({
      issuer,
      audience,
      expectedTenantId: 'tenant-a',
      key: async () => keys.publicKey,
      requestHmacSecret: requestSecret,
      now: () => now,
    });
  });

  async function token(
    overrides: Record<string, unknown> = {},
    requestOverrides: Partial<typeof request> = {},
    includeJti = true,
  ): Promise<string> {
    const boundRequest = { ...request, ...requestOverrides };
    const signer = new SignJWT({
      tenant_id: 'tenant-a',
      workspace_id: 'workspace-a',
      repository_id: 'repository-a',
      revocation_epoch: 7,
      authz_exp: nowSeconds + 60,
      capabilities: ['memory:read'],
      cnf: { 'x5t#S256': certificateThumbprint },
      req_hmac: computeRequestHmac(requestSecret, {
        method: boundRequest.method,
        route: boundRequest.route,
        operationId: boundRequest.operationId,
        bodyDigest: sha256Base64Url(boundRequest.body),
      }),
      ...overrides,
    })
      .setProtectedHeader({
        alg: 'ES256',
        typ: 'qwen-memory-runtime+jwt',
      })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject('principal-a')
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 60);
    if (includeJti) {
      signer.setJti(randomUUID());
    }
    return signer.sign(privateKey);
  }

  it('accepts an exact sender-constrained request', async () => {
    const capability = await token();
    const identity = await verifier.verify({
      ...request,
      token: capability,
    });

    expect(identity).toMatchObject({
      tenantId: 'tenant-a',
      principalId: 'principal-a',
      workspaceId: 'workspace-a',
      repositoryId: 'repository-a',
      revocationEpoch: 7,
      capabilityFingerprint: sha256Base64Url(capability),
      replayExpiresAt: new Date('2026-07-22T00:01:05.000Z'),
    });
  });

  it('rejects a capability issued for another tenant shard', async () => {
    await expect(
      verifier.verify({
        ...request,
        token: await token({ tenant_id: 'tenant-b' }),
      }),
    ).rejects.toThrow('tenant mismatch');
  });

  it.each([
    ['body', { body: Buffer.from('{"query":"other"}') }],
    ['route', { route: '/v1/runtime/proposals' }],
    ['operation', { operationId: randomUUID() }],
    ['certificate', { peerCertificateThumbprint: sha256Base64Url('other') }],
  ])('rejects a mismatched %s binding', async (_name, mismatch) => {
    await expect(
      verifier.verify({
        ...request,
        ...mismatch,
        token: await token(),
      }),
    ).rejects.toThrow();
  });

  it('rejects missing jti, excessive TTL, and an authorization lease shorter than the token', async () => {
    await expect(
      verifier.verify({
        ...request,
        token: await token({}, {}, false),
      }),
    ).rejects.toThrow();

    const longLived = await new SignJWT({
      tenant_id: 'tenant-a',
      workspace_id: 'workspace-a',
      repository_id: 'repository-a',
      revocation_epoch: 7,
      authz_exp: nowSeconds + 600,
      capabilities: ['memory:read'],
      cnf: { 'x5t#S256': certificateThumbprint },
      req_hmac: computeRequestHmac(requestSecret, {
        method: request.method,
        route: request.route,
        operationId: request.operationId,
        bodyDigest: sha256Base64Url(request.body),
      }),
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'qwen-memory-runtime+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject('principal-a')
      .setJti(randomUUID())
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 600)
      .sign(privateKey);
    await expect(
      verifier.verify({ ...request, token: longLived }),
    ).rejects.toThrow();

    await expect(
      verifier.verify({
        ...request,
        token: await token({ authz_exp: nowSeconds + 30 }),
      }),
    ).rejects.toThrow();
  });
});
