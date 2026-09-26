/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { timingSafeEqual } from 'node:crypto';
import type { RequestListener } from 'node:http';
import express from 'express';
import type { Application, ErrorRequestHandler, RequestHandler } from 'express';

export const MANAGED_RUNTIME_ATTESTATION_BODY_LIMIT_BYTES = 16 * 1024;
export const MANAGED_RUNTIME_TOOL_REQUEST_BODY_LIMIT_BYTES = 256 * 1024;
export const MANAGED_RUNTIME_TOOL_RESULT_BODY_LIMIT_BYTES = 1024 * 1024;

export const OWNED_MANAGED_RUNTIME_ROUTES = Object.freeze([
  Object.freeze({
    key: 'attest',
    method: 'POST',
    path: '/internal/managed-runtime/v2/attest',
    protocolVersion: 2,
    requestBodyLimitBytes: MANAGED_RUNTIME_ATTESTATION_BODY_LIMIT_BYTES,
    responseBodyLimitBytes: MANAGED_RUNTIME_ATTESTATION_BODY_LIMIT_BYTES,
    cacheControl: 'no-store',
  }),
  Object.freeze({
    key: 'execute',
    method: 'POST',
    path: '/internal/managed-runtime/v2/execute',
    protocolVersion: 2,
    requestBodyLimitBytes: MANAGED_RUNTIME_TOOL_REQUEST_BODY_LIMIT_BYTES,
    responseBodyLimitBytes: MANAGED_RUNTIME_TOOL_RESULT_BODY_LIMIT_BYTES,
    cacheControl: 'no-store',
  }),
  Object.freeze({
    key: 'status',
    method: 'POST',
    path: '/internal/managed-runtime/v2/status',
    protocolVersion: 2,
    requestBodyLimitBytes: MANAGED_RUNTIME_ATTESTATION_BODY_LIMIT_BYTES,
    responseBodyLimitBytes: MANAGED_RUNTIME_TOOL_RESULT_BODY_LIMIT_BYTES,
    cacheControl: 'no-store',
  }),
  Object.freeze({
    key: 'cancel',
    method: 'POST',
    path: '/internal/managed-runtime/v2/cancel',
    protocolVersion: 2,
    requestBodyLimitBytes: MANAGED_RUNTIME_ATTESTATION_BODY_LIMIT_BYTES,
    responseBodyLimitBytes: MANAGED_RUNTIME_TOOL_RESULT_BODY_LIMIT_BYTES,
    cacheControl: 'no-store',
  }),
] as const);

export type OwnedManagedRuntimeRoute =
  (typeof OWNED_MANAGED_RUNTIME_ROUTES)[number];

const ATTEST_ROUTE = OWNED_MANAGED_RUNTIME_ROUTES[0];
const CAPABILITY_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REQUEST_KEYS = Object.freeze([
  'capabilityDigest',
  'isolationClass',
  'protocolVersion',
  'provisionRequestId',
  'tenantId',
  'workspaceCwd',
  'workspaceGeneration',
  'workspaceId',
] as const);

export interface ManagedRuntimeAttestationIdentity {
  readonly token: string;
  readonly runtimeInstanceId: string;
  readonly runtimeIncarnation: string;
  readonly leaseId: string;
  readonly epoch: number;
  readonly provisionRequestId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly workspaceGeneration: string;
  readonly workspaceCwd: string;
  readonly capabilityDigest: string;
  readonly isolationClass: 'session' | 'workspace';
}

type ManagedRuntimeAttestationResponse = Omit<
  ManagedRuntimeAttestationIdentity,
  'token'
> & {
  readonly protocolVersion: typeof ATTEST_ROUTE.protocolVersion;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function snapshotAttestationIdentity(
  identity: ManagedRuntimeAttestationIdentity,
): ManagedRuntimeAttestationIdentity {
  if (
    !isNonEmptyString(identity.token) ||
    !isNonEmptyString(identity.runtimeInstanceId) ||
    !isNonEmptyString(identity.runtimeIncarnation) ||
    !isNonEmptyString(identity.leaseId) ||
    !Number.isSafeInteger(identity.epoch) ||
    identity.epoch < 1 ||
    !isNonEmptyString(identity.provisionRequestId) ||
    !isNonEmptyString(identity.tenantId) ||
    !isNonEmptyString(identity.workspaceId) ||
    !isNonEmptyString(identity.workspaceGeneration) ||
    !isNonEmptyString(identity.workspaceCwd) ||
    !CAPABILITY_DIGEST_PATTERN.test(identity.capabilityDigest) ||
    (identity.isolationClass !== 'session' &&
      identity.isolationClass !== 'workspace')
  ) {
    throw new Error('Managed Runtime attestation identity is invalid.');
  }
  return Object.freeze({ ...identity });
}

function createAttestationResponseJson(
  identity: ManagedRuntimeAttestationIdentity,
): string {
  const response = {
    protocolVersion: ATTEST_ROUTE.protocolVersion,
    runtimeInstanceId: identity.runtimeInstanceId,
    runtimeIncarnation: identity.runtimeIncarnation,
    leaseId: identity.leaseId,
    epoch: identity.epoch,
    provisionRequestId: identity.provisionRequestId,
    tenantId: identity.tenantId,
    workspaceId: identity.workspaceId,
    workspaceGeneration: identity.workspaceGeneration,
    workspaceCwd: identity.workspaceCwd,
    capabilityDigest: identity.capabilityDigest,
    isolationClass: identity.isolationClass,
  } satisfies ManagedRuntimeAttestationResponse;
  const responseJson = JSON.stringify(response);
  if (Buffer.byteLength(responseJson) > ATTEST_ROUTE.responseBodyLimitBytes) {
    throw new Error('Managed Runtime attestation response exceeds 16 KiB.');
  }
  return responseJson;
}

function equalSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function isClosedAttestationRequest(
  value: unknown,
): value is Record<(typeof REQUEST_KEYS)[number], unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === REQUEST_KEYS.length &&
    keys.every((key, index) => key === REQUEST_KEYS[index])
  );
}

export const managedRuntimeNoStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', ATTEST_ROUTE.cacheControl);
  next();
};

export function authorizeManagedRuntime(
  identity: ManagedRuntimeAttestationIdentity,
): RequestHandler {
  return (req, res, next): void => {
    const authorization = req.get('Authorization');
    if (
      !authorization?.startsWith('Bearer ') ||
      !equalSecret(authorization.slice('Bearer '.length), identity.token)
    ) {
      res.status(401).json({
        code: 'managed_runtime_unauthorized',
        error: 'Managed Runtime credentials are invalid.',
      });
      return;
    }
    if (req.get('Cache-Control') !== 'no-store') {
      res.status(400).json({
        code: 'managed_runtime_attestation_invalid',
        error: 'Managed Runtime attestation request is invalid.',
      });
      return;
    }
    if (
      req.get('X-Qwen-Managed-Lease-Id') !== identity.leaseId ||
      req.get('X-Qwen-Managed-Lease-Epoch') !== String(identity.epoch)
    ) {
      res.status(409).json({
        code: 'managed_runtime_identity_conflict',
        error: 'Managed Runtime lease identity conflicts.',
      });
      return;
    }
    next();
  };
}

function handleAttestation(
  identity: ManagedRuntimeAttestationIdentity,
  responseJson: string,
): RequestHandler {
  return (req, res): void => {
    const body: unknown = req.body;
    if (
      !isClosedAttestationRequest(body) ||
      body.protocolVersion !== ATTEST_ROUTE.protocolVersion ||
      !isNonEmptyString(body.provisionRequestId) ||
      !isNonEmptyString(body.tenantId) ||
      !isNonEmptyString(body.workspaceId) ||
      !isNonEmptyString(body.workspaceGeneration) ||
      !isNonEmptyString(body.workspaceCwd) ||
      typeof body.capabilityDigest !== 'string' ||
      !CAPABILITY_DIGEST_PATTERN.test(body.capabilityDigest) ||
      (body.isolationClass !== 'session' && body.isolationClass !== 'workspace')
    ) {
      res.status(400).json({
        code: 'managed_runtime_attestation_invalid',
        error: 'Managed Runtime attestation request is invalid.',
      });
      return;
    }
    if (
      body.provisionRequestId !== identity.provisionRequestId ||
      body.tenantId !== identity.tenantId ||
      body.workspaceId !== identity.workspaceId ||
      body.workspaceGeneration !== identity.workspaceGeneration ||
      body.workspaceCwd !== identity.workspaceCwd ||
      body.capabilityDigest !== identity.capabilityDigest ||
      body.isolationClass !== identity.isolationClass
    ) {
      res.status(409).json({
        code: 'managed_runtime_identity_conflict',
        error: 'Managed Runtime immutable identity conflicts.',
      });
      return;
    }
    res.status(200).type('application/json').send(responseJson);
  };
}

export const handleManagedRuntimeJsonError: ErrorRequestHandler = (
  error,
  _req,
  res,
  next,
) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (
    error &&
    typeof error === 'object' &&
    'type' in error &&
    error.type === 'entity.too.large'
  ) {
    res.status(413).json({
      code: 'managed_runtime_attestation_too_large',
      error: 'Managed Runtime request exceeds its body size limit.',
    });
    return;
  }
  if (
    error instanceof SyntaxError ||
    (error &&
      typeof error === 'object' &&
      'type' in error &&
      (error.type === 'charset.unsupported' ||
        error.type === 'encoding.unsupported'))
  ) {
    res.status(400).json({
      code: 'managed_runtime_attestation_invalid',
      error: 'Managed Runtime attestation request is invalid.',
    });
    return;
  }
  next(error);
};

export function registerManagedRuntimeAttestationRoute(
  app: Application,
  identity: ManagedRuntimeAttestationIdentity,
): void {
  const identitySnapshot = snapshotAttestationIdentity(identity);
  const responseJson = createAttestationResponseJson(identitySnapshot);
  const method = ATTEST_ROUTE.method.toLowerCase() as Lowercase<
    typeof ATTEST_ROUTE.method
  >;
  app[method](
    ATTEST_ROUTE.path,
    managedRuntimeNoStore,
    authorizeManagedRuntime(identitySnapshot),
    express.json({
      // Compressed private requests add no value at 16 KiB. Refusing them
      // keeps the limit on wire bytes and makes corrupt streams use the JSON
      // protocol error instead of Express' HTML error handler.
      inflate: false,
      limit: ATTEST_ROUTE.requestBodyLimitBytes,
      strict: true,
      type: 'application/json',
    }),
    handleAttestation(identitySnapshot, responseJson),
    handleManagedRuntimeJsonError,
  );
}

export function isOwnedManagedRuntimeRoute(
  method: string | undefined,
  url: string | undefined,
): boolean {
  return OWNED_MANAGED_RUNTIME_ROUTES.some(
    (route) => method === route.method && url === route.path,
  );
}

export function ownedManagedRuntimeRouteGate(
  next: RequestListener,
): RequestListener {
  return (req, res): void => {
    res.setHeader('Cache-Control', ATTEST_ROUTE.cacheControl);
    if (!isOwnedManagedRuntimeRoute(req.method, req.url)) {
      res.writeHead(404);
      res.end();
      return;
    }
    next(req, res);
  };
}
