/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  computeManagedContextDigest,
  isCanonicalDecimalText,
  isManagedIdentifier,
  isWorkspaceStorageId,
  type ManagedContextBinding,
} from './managed-workspace-binding.js';

// TypeScript half of the managed-context/1 envelope contract (W0a-2). The
// shared fixtures in contracts/managed-context-v1.fixtures.json pin it, and a
// conformance test in packages/sdk-java/runtime-broker pins the same key sets,
// routes and digests. The Runtime worker serves it for boot v2 (W0c-1).

export const MANAGED_CONTEXT_PROTOCOL = 'managed-context/1';
export const MANAGED_CONTEXT_BOOT_VERSION = 2;
export const MANAGED_CONTEXT_READY_VERSION = 2;
export const MANAGED_CONTEXT_BODY_LIMIT_BYTES = 16 * 1024;

export const MANAGED_CONTEXT_ROUTES = Object.freeze([
  Object.freeze({
    key: 'attest',
    method: 'POST',
    path: '/internal/managed-runtime/v3/attest',
    protocolVersion: 3,
    requestBodyLimitBytes: MANAGED_CONTEXT_BODY_LIMIT_BYTES,
    responseBodyLimitBytes: MANAGED_CONTEXT_BODY_LIMIT_BYTES,
    cacheControl: 'no-store',
  }),
  Object.freeze({
    key: 'context',
    method: 'POST',
    path: '/internal/managed-runtime/v3/context',
    protocolVersion: 3,
    requestBodyLimitBytes: MANAGED_CONTEXT_BODY_LIMIT_BYTES,
    responseBodyLimitBytes: MANAGED_CONTEXT_BODY_LIMIT_BYTES,
    cacheControl: 'no-store',
  }),
] as const);

const PROTOCOL_VERSION = MANAGED_CONTEXT_ROUTES[0].protocolVersion;
const INVALID_BOOT_MESSAGE = 'Managed context boot document is invalid.';
const MAXIMUM_MOUNT_ROOT_BYTES = 4096;
/** The Broker's limit for a Runtime Session ID, in UTF-16 code units. */
const MAXIMUM_SESSION_ID_LENGTH = 512;
const MAXIMUM_PORT = 65535;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** The token68 syntax of a bearer credential (RFC 6750), 1 to 512 long. */
const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/;
const MAXIMUM_TOKEN_LENGTH = 512;
/** In Unicode mode, this class matches only unpaired surrogates. */
const LONE_SURROGATE_PATTERN = /[\ud800-\udfff]/u;
const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const READY_URL_PATTERN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;

// Each list is sorted, so it compares element by element with sorted keys.
const BOOT_KEYS = Object.freeze([
  'capabilityDigest',
  'epoch',
  'isolationClass',
  'leaseId',
  'managedContext',
  'mountRoot',
  'provisionRequestId',
  'runtimeIncarnation',
  'runtimeInstanceId',
  'storageId',
  'tenantId',
  'token',
  'type',
  'version',
  'workspaceGeneration',
  'workspaceId',
] as const);
const READY_KEYS = Object.freeze([
  'epoch',
  'leaseId',
  'managedContext',
  'runtimeIncarnation',
  'runtimeInstanceId',
  'type',
  'url',
  'version',
] as const);
const ATTESTATION_KEYS = Object.freeze([
  'capabilityDigest',
  'isolationClass',
  'managedContext',
  'mountRoot',
  'protocolVersion',
  'provisionRequestId',
  'storageId',
  'tenantId',
  'workspaceGeneration',
  'workspaceId',
] as const);
const INSTALLATION_KEYS = Object.freeze([
  'binding',
  'contextDigest',
  'managedContext',
  'operationId',
  'protocolVersion',
  'sessionId',
] as const);
const BINDING_KEYS = Object.freeze([
  'contextConfigRef',
  'contextRevision',
  'cwdRelative',
  'storageId',
  'tenantId',
  'workspaceGeneration',
  'workspaceId',
] as const);
/** The boot fields that an attestation request must repeat exactly. */
const ATTESTED_KEYS = Object.freeze([
  'provisionRequestId',
  'tenantId',
  'workspaceId',
  'workspaceGeneration',
  'storageId',
  'mountRoot',
  'capabilityDigest',
  'isolationClass',
] as const);
/** The binding fields that must match the Workspace the Runtime booted in. */
const WORKSPACE_KEYS = Object.freeze([
  'tenantId',
  'workspaceId',
  'workspaceGeneration',
  'storageId',
] as const);

export type ManagedContextIsolationClass = 'session' | 'workspace';

export interface ManagedContextBoot {
  readonly type: 'boot';
  readonly version: typeof MANAGED_CONTEXT_BOOT_VERSION;
  readonly managedContext: typeof MANAGED_CONTEXT_PROTOCOL;
  readonly runtimeInstanceId: string;
  readonly runtimeIncarnation: string;
  readonly leaseId: string;
  readonly provisionRequestId: string;
  readonly token: string;
  readonly epoch: number;
  readonly capabilityDigest: string;
  readonly isolationClass: ManagedContextIsolationClass;
  readonly tenantId: string;
  readonly workspaceId: string;
  /** Decimal text, so a 64-bit value never passes through Number. */
  readonly workspaceGeneration: string;
  readonly storageId: string;
  /** Where the Broker mounted the Workspace; data until it is verified. */
  readonly mountRoot: string;
}

export interface ManagedContextReady {
  readonly type: 'ready';
  readonly version: typeof MANAGED_CONTEXT_READY_VERSION;
  readonly managedContext: typeof MANAGED_CONTEXT_PROTOCOL;
  readonly runtimeInstanceId: string;
  readonly runtimeIncarnation: string;
  readonly leaseId: string;
  readonly epoch: number;
  readonly url: string;
}

export interface ManagedContextAttestationResponse {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly managedContext: typeof MANAGED_CONTEXT_PROTOCOL;
  readonly runtimeInstanceId: string;
  readonly runtimeIncarnation: string;
  readonly leaseId: string;
  readonly epoch: number;
  readonly provisionRequestId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly workspaceGeneration: string;
  readonly storageId: string;
  readonly mountRoot: string;
  readonly capabilityDigest: string;
  readonly isolationClass: ManagedContextIsolationClass;
}

export interface ManagedContextReceipt {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly managedContext: typeof MANAGED_CONTEXT_PROTOCOL;
  readonly operationId: string;
  readonly sessionId: string;
  readonly runtimeInstanceId: string;
  readonly runtimeIncarnation: string;
  readonly epoch: number;
  readonly contextDigest: string;
  readonly contextRevision: string;
  readonly workspaceGeneration: string;
}

export type ManagedContextRefusal =
  | {
      readonly status: 400;
      readonly code: 'managed_runtime_attestation_invalid';
    }
  | {
      readonly status: 409;
      readonly code: 'managed_runtime_identity_conflict';
    }
  | { readonly status: 409; readonly code: 'managed_context_conflict' }
  | { readonly status: 409; readonly code: 'managed_context_unavailable' };

export type ManagedContextOutcome<Body> =
  | { readonly status: 200; readonly body: Body }
  | ManagedContextRefusal;

const INVALID: ManagedContextRefusal = Object.freeze({
  status: 400,
  code: 'managed_runtime_attestation_invalid',
});
const IDENTITY_CONFLICT: ManagedContextRefusal = Object.freeze({
  status: 409,
  code: 'managed_runtime_identity_conflict',
});
const CONTEXT_CONFLICT: ManagedContextRefusal = Object.freeze({
  status: 409,
  code: 'managed_context_conflict',
});
const CONTEXT_UNAVAILABLE: ManagedContextRefusal = Object.freeze({
  status: 409,
  code: 'managed_context_unavailable',
});

/**
 * Validates a boot v2 document and returns a frozen copy of it. Throws
 * without echoing the input, which carries the bearer token.
 */
export function parseManagedContextBoot(value: unknown): ManagedContextBoot {
  const boot = readClosed(value, BOOT_KEYS);
  if (
    !boot ||
    boot.type !== 'boot' ||
    boot.version !== MANAGED_CONTEXT_BOOT_VERSION ||
    boot.managedContext !== MANAGED_CONTEXT_PROTOCOL ||
    !isBearerToken(boot.token) ||
    !isManagedIdentifier(boot.runtimeInstanceId) ||
    !isManagedIdentifier(boot.runtimeIncarnation) ||
    !isManagedIdentifier(boot.leaseId) ||
    !isEpoch(boot.epoch) ||
    !hasValidAttestedFields(boot)
  ) {
    throw new Error(INVALID_BOOT_MESSAGE);
  }
  return Object.freeze(boot) as ManagedContextBoot;
}

/** The ready v2 record for a worker listening on the loopback `port`. */
export function createManagedContextReady(
  boot: ManagedContextBoot,
  port: number,
): ManagedContextReady {
  const identity = parseManagedContextBoot(boot);
  if (!Number.isInteger(port) || port < 1 || port > MAXIMUM_PORT) {
    throw new Error('Managed context ready port is invalid.');
  }
  return Object.freeze({
    type: 'ready',
    version: MANAGED_CONTEXT_READY_VERSION,
    managedContext: MANAGED_CONTEXT_PROTOCOL,
    runtimeInstanceId: identity.runtimeInstanceId,
    runtimeIncarnation: identity.runtimeIncarnation,
    leaseId: identity.leaseId,
    epoch: identity.epoch,
    url: `http://127.0.0.1:${port}`,
  });
}

/** Whether a ready record is exactly ready v2 for this boot document. */
export function isManagedContextReady(
  value: unknown,
  boot: ManagedContextBoot,
): boolean {
  const identity = parseManagedContextBoot(boot);
  const ready = readClosed(value, READY_KEYS);
  if (
    !ready ||
    ready.type !== 'ready' ||
    ready.version !== MANAGED_CONTEXT_READY_VERSION ||
    ready.managedContext !== MANAGED_CONTEXT_PROTOCOL ||
    ready.runtimeInstanceId !== identity.runtimeInstanceId ||
    ready.runtimeIncarnation !== identity.runtimeIncarnation ||
    ready.leaseId !== identity.leaseId ||
    ready.epoch !== identity.epoch ||
    typeof ready.url !== 'string'
  ) {
    return false;
  }
  const port = READY_URL_PATTERN.exec(ready.url)?.[1];
  return port !== undefined && Number(port) <= MAXIMUM_PORT;
}

/** The attestation v3 response, built from the boot document alone. */
export function createManagedContextAttestationResponse(
  boot: ManagedContextBoot,
): ManagedContextAttestationResponse {
  return attestationResponse(parseManagedContextBoot(boot));
}

/**
 * Checks an attestation v3 request body against the boot document: 400 for
 * a bad shape, 409 when any attested field differs, compared exactly.
 */
export function checkManagedContextAttestation(
  body: unknown,
  boot: ManagedContextBoot,
): ManagedContextOutcome<ManagedContextAttestationResponse> {
  const identity = parseManagedContextBoot(boot);
  const request = readClosed(body, ATTESTATION_KEYS);
  if (
    !request ||
    request.protocolVersion !== PROTOCOL_VERSION ||
    request.managedContext !== MANAGED_CONTEXT_PROTOCOL ||
    !hasValidAttestedFields(request)
  ) {
    return INVALID;
  }
  if (ATTESTED_KEYS.some((key) => request[key] !== identity[key])) {
    return IDENTITY_CONFLICT;
  }
  return { status: 200, body: attestationResponse(identity) };
}

interface Installation {
  readonly sessionId: string;
  readonly contextDigest: string;
  readonly receipt: ManagedContextReceipt;
}

/** An installation request that passed steps 1 to 3, read once. */
interface InstallationRequest {
  readonly operationId: string;
  readonly sessionId: string;
  readonly contextDigest: string;
  readonly binding: ManagedContextBinding;
}

/**
 * The context installations of one Runtime, kept for its lifetime. Each
 * request is checked in the contract's order; a repeated installation
 * returns its original receipt, and a refused request records nothing.
 */
export class ManagedContextInstallations {
  readonly #boot: ManagedContextBoot;
  readonly #operations = new Map<string, Installation>();
  /** The context installed for each Session. */
  readonly #sessions = new Map<string, InstallationRequest>();

  constructor(boot: ManagedContextBoot) {
    this.#boot = parseManagedContextBoot(boot);
  }

  /**
   * Installs one Session's context. `verify` is step 6: it answers whether
   * the binding's effective directory can be verified.
   */
  async install(
    body: unknown,
    verify: (binding: ManagedContextBinding) => Promise<boolean>,
  ): Promise<ManagedContextOutcome<ManagedContextReceipt>> {
    const request = this.#read(body);
    if ('status' in request) {
      return request;
    }
    const earlier = this.#match(request);
    if (earlier) {
      return earlier;
    }
    const verified = await verify(request.binding);
    // Another installation may have been recorded during the verification.
    return (
      this.#match(request) ??
      (verified ? this.#record(request) : CONTEXT_UNAVAILABLE)
    );
  }

  /** The binding installed for a Session, if any. */
  installed(sessionId: string): ManagedContextBinding | undefined {
    return this.#sessions.get(sessionId)?.binding;
  }

  /** Steps 1 to 3: the shape, the digest and the Workspace part. */
  #read(body: unknown): InstallationRequest | ManagedContextRefusal {
    const request = readClosed(body, INSTALLATION_KEYS);
    const binding = request && readClosed(request.binding, BINDING_KEYS);
    if (
      !request ||
      !binding ||
      request.protocolVersion !== PROTOCOL_VERSION ||
      request.managedContext !== MANAGED_CONTEXT_PROTOCOL ||
      !isManagedIdentifier(request.operationId) ||
      !isRuntimeSessionId(request.sessionId) ||
      !isDigest(request.contextDigest)
    ) {
      return INVALID;
    }
    const contextDigest = digestOf(binding);
    if (
      contextDigest === undefined ||
      contextDigest !== request.contextDigest
    ) {
      return INVALID;
    }
    if (WORKSPACE_KEYS.some((key) => binding[key] !== this.#boot[key])) {
      return IDENTITY_CONFLICT;
    }
    return {
      operationId: request.operationId,
      sessionId: request.sessionId,
      contextDigest,
      binding: Object.freeze(binding) as ManagedContextBinding,
    };
  }

  /** Steps 4 and 5: the original receipt, a conflict, or nothing. */
  #match(
    request: InstallationRequest,
  ): ManagedContextOutcome<ManagedContextReceipt> | undefined {
    const previous = this.#operations.get(request.operationId);
    if (previous) {
      return previous.sessionId === request.sessionId &&
        previous.contextDigest === request.contextDigest
        ? { status: 200, body: previous.receipt }
        : CONTEXT_CONFLICT;
    }
    const installed = this.#sessions.get(request.sessionId);
    return installed !== undefined &&
      installed.contextDigest !== request.contextDigest
      ? CONTEXT_CONFLICT
      : undefined;
  }

  /** Step 7: records the installation and returns its receipt. */
  #record(
    request: InstallationRequest,
  ): ManagedContextOutcome<ManagedContextReceipt> {
    const { operationId, sessionId, contextDigest, binding } = request;
    const receipt: ManagedContextReceipt = Object.freeze({
      protocolVersion: PROTOCOL_VERSION,
      managedContext: MANAGED_CONTEXT_PROTOCOL,
      operationId,
      sessionId,
      runtimeInstanceId: this.#boot.runtimeInstanceId,
      runtimeIncarnation: this.#boot.runtimeIncarnation,
      epoch: this.#boot.epoch,
      contextDigest,
      contextRevision: binding.contextRevision,
      workspaceGeneration: binding.workspaceGeneration,
    });
    this.#operations.set(
      operationId,
      Object.freeze({ sessionId, contextDigest, receipt }),
    );
    this.#sessions.set(sessionId, request);
    return { status: 200, body: receipt };
  }
}

function attestationResponse(
  identity: ManagedContextBoot,
): ManagedContextAttestationResponse {
  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    managedContext: MANAGED_CONTEXT_PROTOCOL,
    runtimeInstanceId: identity.runtimeInstanceId,
    runtimeIncarnation: identity.runtimeIncarnation,
    leaseId: identity.leaseId,
    epoch: identity.epoch,
    provisionRequestId: identity.provisionRequestId,
    tenantId: identity.tenantId,
    workspaceId: identity.workspaceId,
    workspaceGeneration: identity.workspaceGeneration,
    storageId: identity.storageId,
    mountRoot: identity.mountRoot,
    capabilityDigest: identity.capabilityDigest,
    isolationClass: identity.isolationClass,
  });
}

/**
 * Copies an object's fields when its own keys are exactly `keys`, so every
 * later check and use reads one snapshot. Anything else is undefined.
 */
function readClosed<Key extends string>(
  value: unknown,
  keys: readonly Key[],
): Record<Key, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const present = Object.keys(value).sort();
  if (
    present.length !== keys.length ||
    !present.every((key, index) => key === keys[index])
  ) {
    return undefined;
  }
  const snapshot = {} as Record<Key, unknown>;
  for (const key of keys) {
    snapshot[key] = (value as Record<Key, unknown>)[key];
  }
  return snapshot;
}

function hasValidAttestedFields(
  fields: Record<(typeof ATTESTED_KEYS)[number], unknown>,
): boolean {
  return (
    isManagedIdentifier(fields.provisionRequestId) &&
    isManagedIdentifier(fields.tenantId) &&
    isManagedIdentifier(fields.workspaceId) &&
    isCanonicalDecimalText(fields.workspaceGeneration) &&
    isWorkspaceStorageId(fields.storageId) &&
    isMountRoot(fields.mountRoot) &&
    isDigest(fields.capabilityDigest) &&
    (fields.isolationClass === 'session' ||
      fields.isolationClass === 'workspace')
  );
}

/** The W0a digest of a closed binding, or undefined when it is invalid. */
function digestOf(
  binding: Record<(typeof BINDING_KEYS)[number], unknown>,
): string | undefined {
  try {
    return computeManagedContextDigest(binding as ManagedContextBinding);
  } catch {
    return undefined;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * A Runtime Session ID: 1 to 512 UTF-16 units as the Broker counts them,
 * well-formed so that every JSON encoder carries it unchanged, and no NUL.
 */
function isRuntimeSessionId(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    value.length <= MAXIMUM_SESSION_ID_LENGTH &&
    !value.includes('\0') &&
    !LONE_SURROGATE_PATTERN.test(value)
  );
}

function isBearerToken(value: unknown): value is string {
  return (
    matches(BEARER_TOKEN_PATTERN, value) &&
    (value as string).length <= MAXIMUM_TOKEN_LENGTH
  );
}

function matches(pattern: RegExp, value: unknown): boolean {
  return typeof value === 'string' && pattern.test(value);
}

function isEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isDigest(value: unknown): value is string {
  return matches(DIGEST_PATTERN, value);
}

/**
 * An absolute path of 1 to 4096 UTF-8 bytes: well-formed UTF-16 without a
 * Unicode Cc control character (C0, DEL and C1).
 */
function isMountRoot(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > MAXIMUM_MOUNT_ROOT_BYTES ||
    !ABSOLUTE_PATH_PATTERN.test(value)
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return false;
    }
  }
  return Buffer.byteLength(value, 'utf8') <= MAXIMUM_MOUNT_ROOT_BYTES;
}
