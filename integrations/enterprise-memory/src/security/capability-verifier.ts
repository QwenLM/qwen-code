/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { jwtVerify, type JWTPayload } from 'jose';
import type { RuntimeCapability, RuntimeIdentity } from '../domain.js';
import {
  computeRequestHmac,
  requestHmacMatches,
  sha256Base64Url,
} from './request-binding.js';

type VerificationKey = Parameters<typeof jwtVerify>[1];

const ALLOWED_CAPABILITIES = new Set<RuntimeCapability>([
  'context:read',
  'events:write',
  'memory:read',
  'proposal:write',
  'feedback:write',
]);

export interface CapabilityVerifierOptions {
  issuer: string;
  audience: string;
  expectedTenantId: string;
  key: VerificationKey;
  requestHmacSecret: Uint8Array;
  maxTokenTtlSeconds?: number;
  clockToleranceSeconds?: number;
  now?: () => Date;
}

export interface CapabilityRequest {
  token: string;
  method: string;
  route: string;
  operationId: string;
  body: Uint8Array;
  peerCertificateThumbprint: string;
  requiredCapability: RuntimeCapability;
}

export interface VerifiedRuntimeIdentity extends RuntimeIdentity {
  capabilityId: string;
  capabilityFingerprint: string;
  replayExpiresAt: Date;
  requestBinding: string;
}

interface CapabilityClaims extends JWTPayload {
  tenant_id?: unknown;
  workspace_id?: unknown;
  repository_id?: unknown;
  revocation_epoch?: unknown;
  authz_exp?: unknown;
  capabilities?: unknown;
  cnf?: unknown;
  req_hmac?: unknown;
}

export class CapabilityVerificationError extends Error {}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CapabilityVerificationError(`Missing or invalid ${name}`);
  }
  return value;
}

function requireInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new CapabilityVerificationError(`Missing or invalid ${name}`);
  }
  return value as number;
}

function readCertificateThumbprint(cnf: unknown): string {
  if (typeof cnf !== 'object' || cnf === null) {
    throw new CapabilityVerificationError('Missing cnf claim');
  }
  return requireString(
    (cnf as Record<string, unknown>)['x5t#S256'],
    'cnf.x5t#S256',
  );
}

function readCapabilities(value: unknown): ReadonlySet<RuntimeCapability> {
  if (!Array.isArray(value)) {
    throw new CapabilityVerificationError('Missing capabilities claim');
  }
  const capabilities = new Set<RuntimeCapability>();
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      !ALLOWED_CAPABILITIES.has(item as RuntimeCapability)
    ) {
      throw new CapabilityVerificationError('Invalid runtime capability');
    }
    capabilities.add(item as RuntimeCapability);
  }
  return capabilities;
}

export class CapabilityVerifier {
  private readonly maxTokenTtlSeconds: number;
  private readonly clockToleranceSeconds: number;
  private readonly now: () => Date;

  constructor(private readonly options: CapabilityVerifierOptions) {
    this.maxTokenTtlSeconds = options.maxTokenTtlSeconds ?? 300;
    this.clockToleranceSeconds = options.clockToleranceSeconds ?? 5;
    this.now = options.now ?? (() => new Date());
    if (
      options.issuer.length === 0 ||
      options.audience.length === 0 ||
      options.expectedTenantId.length === 0 ||
      options.requestHmacSecret.byteLength < 32 ||
      !Number.isSafeInteger(this.maxTokenTtlSeconds) ||
      this.maxTokenTtlSeconds <= 0 ||
      this.maxTokenTtlSeconds > 300 ||
      !Number.isSafeInteger(this.clockToleranceSeconds) ||
      this.clockToleranceSeconds < 0 ||
      this.clockToleranceSeconds > 60
    ) {
      throw new Error('Capability verifier configuration is invalid');
    }
  }

  async verify(request: CapabilityRequest): Promise<VerifiedRuntimeIdentity> {
    let claims: CapabilityClaims;
    try {
      const result = await jwtVerify(request.token, this.options.key, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: ['ES256'],
        typ: 'qwen-memory-runtime+jwt',
        clockTolerance: this.clockToleranceSeconds,
        currentDate: this.now(),
      });
      claims = result.payload as CapabilityClaims;
    } catch (error) {
      throw new CapabilityVerificationError(
        error instanceof Error ? error.message : 'Invalid capability token',
      );
    }

    const principalId = requireString(claims.sub, 'sub');
    const capabilityId = requireString(claims.jti, 'jti');
    const issuedAt = requireInteger(claims.iat, 'iat');
    const expiresAt = requireInteger(claims.exp, 'exp');
    const authorizationExpiresAt = requireInteger(
      claims.authz_exp,
      'authz_exp',
    );
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (
      expiresAt <= issuedAt ||
      issuedAt > nowSeconds + this.clockToleranceSeconds ||
      expiresAt - issuedAt > this.maxTokenTtlSeconds
    ) {
      throw new CapabilityVerificationError('Capability TTL exceeds policy');
    }
    if (expiresAt > authorizationExpiresAt) {
      throw new CapabilityVerificationError(
        'Capability outlives authorization lease',
      );
    }

    const certificateThumbprint = readCertificateThumbprint(claims.cnf);
    if (Buffer.from(certificateThumbprint, 'base64url').length !== 32) {
      throw new CapabilityVerificationError('Invalid certificate thumbprint');
    }
    if (
      !requestHmacMatches(
        certificateThumbprint,
        request.peerCertificateThumbprint,
      )
    ) {
      throw new CapabilityVerificationError('mTLS sender constraint mismatch');
    }

    const capabilities = readCapabilities(claims.capabilities);
    if (!capabilities.has(request.requiredCapability)) {
      throw new CapabilityVerificationError(
        'Capability does not allow operation',
      );
    }

    const actualRequestHmac = requireString(claims.req_hmac, 'req_hmac');
    const expectedRequestHmac = computeRequestHmac(
      this.options.requestHmacSecret,
      {
        method: request.method,
        route: request.route,
        operationId: request.operationId,
        bodyDigest: sha256Base64Url(request.body),
      },
    );
    if (!requestHmacMatches(expectedRequestHmac, actualRequestHmac)) {
      throw new CapabilityVerificationError('Exact request binding mismatch');
    }

    const revocationEpoch = requireInteger(
      claims.revocation_epoch,
      'revocation_epoch',
    );
    if (revocationEpoch < 0) {
      throw new CapabilityVerificationError('Invalid revocation epoch');
    }

    const tenantId = requireString(claims.tenant_id, 'tenant_id');
    if (tenantId !== this.options.expectedTenantId) {
      throw new CapabilityVerificationError('Capability tenant mismatch');
    }

    return {
      tenantId,
      principalId,
      workspaceId: requireString(claims.workspace_id, 'workspace_id'),
      repositoryId: requireString(claims.repository_id, 'repository_id'),
      revocationEpoch,
      capabilityId,
      capabilityFingerprint: sha256Base64Url(request.token),
      replayExpiresAt: new Date(
        (expiresAt + this.clockToleranceSeconds) * 1000,
      ),
      requestBinding: actualRequestHmac,
    };
  }
}
