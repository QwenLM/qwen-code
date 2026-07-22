/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CapabilityVerificationError,
  CapabilityVerifier,
} from './capability-verifier.js';
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
    options: {
      alg?: string;
      typ?: string;
      issuer?: string;
      audience?: string;
      issuedAt?: number;
      expiresAt?: number;
      signingKey?: CryptoKey | Uint8Array;
    } = {},
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
        alg: options.alg ?? 'ES256',
        typ: options.typ ?? 'qwen-memory-runtime+jwt',
      })
      .setIssuer(options.issuer ?? issuer)
      .setAudience(options.audience ?? audience)
      .setSubject('principal-a')
      .setIssuedAt(options.issuedAt ?? nowSeconds)
      .setExpirationTime(options.expiresAt ?? nowSeconds + 60);
    if (includeJti) {
      signer.setJti(randomUUID());
    }
    return signer.sign(options.signingKey ?? privateKey);
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
    [
      'body',
      { body: Buffer.from('{"query":"other"}') },
      'Exact request binding mismatch',
    ],
    [
      'route',
      { route: '/v1/runtime/proposals' },
      'Exact request binding mismatch',
    ],
    [
      'operation',
      { operationId: randomUUID() },
      'Exact request binding mismatch',
    ],
    [
      'certificate',
      { peerCertificateThumbprint: sha256Base64Url('other') },
      'mTLS sender constraint mismatch',
    ],
  ])(
    'rejects a mismatched %s binding',
    async (_name, mismatch, expectedError) => {
      await expect(
        verifier.verify({
          ...request,
          ...mismatch,
          token: await token(),
        }),
      ).rejects.toThrow(expectedError);
    },
  );

  it('rejects a missing capability ID', async () => {
    await expect(
      verifier.verify({
        ...request,
        token: await token({}, {}, false),
      }),
    ).rejects.toThrow('Missing or invalid jti');
  });

  it('rejects a capability whose TTL exceeds policy', async () => {
    await expect(
      verifier.verify({
        ...request,
        token: await token({ authz_exp: nowSeconds + 600 }, {}, true, {
          expiresAt: nowSeconds + 600,
        }),
      }),
    ).rejects.toThrow('Capability TTL exceeds policy');
  });

  it('rejects a capability that outlives its authorization lease', async () => {
    await expect(
      verifier.verify({
        ...request,
        token: await token({ authz_exp: nowSeconds + 30 }),
      }),
    ).rejects.toThrow('Capability outlives authorization lease');
  });

  it.each([
    ['type', { typ: 'JWT' }],
    ['issuer', { issuer: 'https://other.example.test' }],
    ['audience', { audience: 'other-audience' }],
    ['expiration', { expiresAt: nowSeconds - 10 }],
  ])('rejects an invalid token %s', async (_name, options) => {
    await expect(
      verifier.verify({
        ...request,
        token: await token({}, {}, true, options),
      }),
    ).rejects.toBeInstanceOf(CapabilityVerificationError);
  });

  it('rejects a disallowed signature algorithm', async () => {
    await expect(
      verifier.verify({
        ...request,
        token: await token({}, {}, true, {
          alg: 'HS256',
          signingKey: randomBytes(32),
        }),
      }),
    ).rejects.toBeInstanceOf(CapabilityVerificationError);
  });

  it('rejects a missing required capability', async () => {
    await expect(
      verifier.verify({
        ...request,
        token: await token({ capabilities: ['events:write'] }),
      }),
    ).rejects.toThrow('Capability does not allow operation');
  });

  it('rejects an unknown runtime capability', async () => {
    await expect(
      verifier.verify({
        ...request,
        token: await token({ capabilities: ['memory:delete'] }),
      }),
    ).rejects.toThrow('Invalid runtime capability');
  });

  it('rejects a negative revocation epoch', async () => {
    await expect(
      verifier.verify({
        ...request,
        token: await token({ revocation_epoch: -1 }),
      }),
    ).rejects.toThrow('Invalid revocation epoch');
  });
});
