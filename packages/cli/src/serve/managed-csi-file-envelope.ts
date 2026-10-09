/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import { parseManagedSessionRecordJson } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  createManagedCsiAttestationRequest,
  MANAGED_CSI_PROTOCOL,
  parseManagedCsiBoot,
  parseManagedCsiDrainRequest,
  validateManagedCsiAttestationResponse,
  type ManagedCsiBoot,
  type ManagedCsiPodIdentity,
  type ManagedCsiStorage,
} from './managed-csi-envelope.js';
import {
  createManagedContextReady,
  type ManagedContextBoot,
  type ManagedContextReady,
} from './managed-context-envelope.js';
import { CSI_FILES_RETIREMENT_CAPABILITY_DIGEST } from './managed-csi-file-profile.js';
import { resolveManagedRuntimeBrokerBaseUrl } from './managed-runtime-broker-url.js';

export const MANAGED_CSI_FILE_PROTOCOL = 'managed-csi/2';
export const MANAGED_CSI_FILE_PREFIX = '/internal/managed-runtime/csi/v2';
export const MANAGED_CSI_FILE_ROUTES = Object.freeze(
  ['context-attest', 'context', 'attest', 'drain'].map((name) =>
    Object.freeze({
      method: 'POST',
      path: `${MANAGED_CSI_FILE_PREFIX}/${name}`,
    }),
  ),
);

export interface ManagedCsiFileIdentity {
  readonly profile: 'csi-files-retirement/1';
  readonly sessionId: string;
  readonly capabilityDigest: typeof CSI_FILES_RETIREMENT_CAPABILITY_DIGEST;
}

interface ManagedCsiFileBootFields {
  readonly type: 'boot';
  readonly managedCsi: typeof MANAGED_CSI_FILE_PROTOCOL;
  readonly identity: ManagedCsiFileIdentity;
  readonly context: ManagedContextBoot;
  readonly storage: ManagedCsiStorage;
}

export interface ManagedCsiNativeAuthority {
  readonly protocolVersion: 1;
  readonly origin: string;
}

export type ManagedCsiFileBoot = ManagedCsiFileBootFields &
  (
    | { readonly version: 4 }
    | { readonly version: 5; readonly authority: ManagedCsiNativeAuthority }
  );

export interface ManagedCsiFileReady {
  readonly type: 'ready';
  readonly version: 4 | 5;
  readonly managedCsi: typeof MANAGED_CSI_FILE_PROTOCOL;
  readonly identity: ManagedCsiFileIdentity;
  readonly context: ManagedContextReady;
}

export function parseManagedCsiFileJson(
  bytes: Uint8Array,
  limit: number,
): unknown {
  if (bytes.byteLength > limit) throw new Error('Invalid CSI file JSON.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  parseManagedSessionRecordJson(text, limit);
  return JSON.parse(
    text,
    (_key: string, value: unknown, context?: { source?: string }) => {
      if (
        typeof value === 'number' &&
        (!Number.isSafeInteger(value) ||
          context?.source === undefined ||
          !/^(?:0|[1-9][0-9]*)$/.test(context.source))
      )
        throw new Error('Invalid CSI file JSON.');
      return value;
    },
  ) as unknown;
}

export function parseManagedCsiFileBoot(value: unknown): ManagedCsiFileBoot {
  try {
    const authorityBoot =
      value !== null &&
      typeof value === 'object' &&
      'version' in value &&
      value.version === 5;
    const boot = closed(value, [
      ...(authorityBoot ? ['authority'] : []),
      'context',
      'identity',
      'managedCsi',
      'storage',
      'type',
      'version',
    ]);
    const identity = closed(boot['identity'], [
      'capabilityDigest',
      'profile',
      'sessionId',
    ]);
    const data = parseManagedCsiBoot({
      type: 'boot',
      version: 3,
      managedCsi: MANAGED_CSI_PROTOCOL,
      context: boot['context'],
      storage: boot['storage'],
    });
    if (
      boot['type'] !== 'boot' ||
      (boot['version'] !== 4 && !authorityBoot) ||
      boot['managedCsi'] !== MANAGED_CSI_FILE_PROTOCOL ||
      identity['profile'] !== 'csi-files-retirement/1' ||
      identity['capabilityDigest'] !== CSI_FILES_RETIREMENT_CAPABILITY_DIGEST ||
      typeof identity['sessionId'] !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        identity['sessionId'],
      ) ||
      data.context.isolationClass !== 'session' ||
      data.context.capabilityDigest !== identity['capabilityDigest']
    )
      throw new Error();
    const fields: ManagedCsiFileBootFields = {
      type: 'boot' as const,
      managedCsi: MANAGED_CSI_FILE_PROTOCOL,
      identity: Object.freeze(identity) as unknown as ManagedCsiFileIdentity,
      context: data.context,
      storage: data.storage,
    };
    return authorityBoot
      ? Object.freeze({
          ...fields,
          version: 5 as const,
          authority: readManagedCsiNativeAuthority(boot['authority']),
        })
      : Object.freeze({ ...fields, version: 4 as const });
  } catch {
    throw new Error('Managed CSI file boot document is invalid.');
  }
}

export function readManagedCsiNativeAuthority(
  value: unknown,
): ManagedCsiNativeAuthority {
  const authority = closed(value, ['origin', 'protocolVersion']);
  const origin = authority['origin'];
  if (
    authority['protocolVersion'] !== 1 ||
    typeof origin !== 'string' ||
    origin.length > 2048
  )
    throw new Error('Managed CSI authority origin is invalid.');
  const url = resolveManagedRuntimeBrokerBaseUrl(origin);
  const hostname = url.hostname;
  if (
    url.origin !== origin ||
    /(^|\.)xn--/.test(hostname) ||
    (!hostname.startsWith('[') &&
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(
        hostname,
      )) ||
    (!hostname.startsWith('[') &&
      hostname.includes('.') &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(hostname) &&
      !/^[a-z]/.test(hostname.split('.').at(-1) ?? '')) ||
    (url.port !== '' && Number(url.port) === 0)
  )
    throw new Error('Managed CSI authority origin is not canonical.');
  return Object.freeze({ protocolVersion: 1, origin });
}

function dataBoot(boot: ManagedCsiFileBoot): ManagedCsiBoot {
  return {
    type: 'boot',
    version: 3,
    managedCsi: MANAGED_CSI_PROTOCOL,
    context: boot.context,
    storage: boot.storage,
  };
}

export function createManagedCsiFileReady(
  boot: ManagedCsiFileBoot,
  port: number,
): ManagedCsiFileReady {
  return Object.freeze({
    type: 'ready',
    version: boot.version,
    managedCsi: MANAGED_CSI_FILE_PROTOCOL,
    identity: boot.identity,
    context: createManagedContextReady(boot.context, port),
  });
}

export function wrapManagedCsiFileContext<T>(
  boot: ManagedCsiFileBoot,
  context: T,
) {
  return Object.freeze({
    protocolVersion: 2,
    managedCsi: MANAGED_CSI_FILE_PROTOCOL,
    identity: boot.identity,
    context,
  });
}

export function readManagedCsiFileContext(
  value: unknown,
  boot: ManagedCsiFileBoot,
): unknown {
  const body = closed(value, [
    'context',
    'identity',
    'managedCsi',
    'protocolVersion',
  ]);
  checkIdentity(body, boot);
  return body['context'];
}

export function createManagedCsiFileAttestationRequest(
  boot: ManagedCsiFileBoot,
) {
  return {
    ...createManagedCsiAttestationRequest(dataBoot(boot)),
    protocolVersion: 2,
    managedCsi: MANAGED_CSI_FILE_PROTOCOL,
    identity: boot.identity,
  };
}

export function validateManagedCsiFileAttestationRequest(
  value: unknown,
  boot: ManagedCsiFileBoot,
): void {
  if (!isDeepStrictEqual(value, createManagedCsiFileAttestationRequest(boot)))
    throw new Error('CSI file identity conflicts.');
}

export function validateManagedCsiFileAttestationResponse(
  value: unknown,
  boot: ManagedCsiFileBoot,
  pod: ManagedCsiPodIdentity,
): void {
  const body = closed(value, [
    'context',
    'identity',
    'managedCsi',
    'mount',
    'pod',
    'protocolVersion',
    'storage',
  ]);
  checkIdentity(body, boot);
  const { identity: _identity, ...data } = body;
  validateManagedCsiAttestationResponse(
    { ...data, protocolVersion: 1, managedCsi: MANAGED_CSI_PROTOCOL },
    dataBoot(boot),
    pod,
  );
}

export function readManagedCsiFileDrain(
  value: unknown,
  boot: ManagedCsiFileBoot,
  pod: ManagedCsiPodIdentity,
) {
  const body = closed(value, [
    'context',
    'identity',
    'managedCsi',
    'operation',
    'pod',
    'protocolVersion',
    'retirementId',
    'storage',
  ]);
  checkIdentity(body, boot);
  const { identity: _identity, ...data } = body;
  return parseManagedCsiDrainRequest(
    { ...data, protocolVersion: 1, managedCsi: MANAGED_CSI_PROTOCOL },
    dataBoot(boot),
    pod,
  );
}

function checkIdentity(
  body: Record<string, unknown>,
  boot: ManagedCsiFileBoot,
): void {
  if (
    body['protocolVersion'] !== 2 ||
    body['managedCsi'] !== MANAGED_CSI_FILE_PROTOCOL ||
    !isDeepStrictEqual(body['identity'], boot.identity)
  )
    throw new Error('CSI file identity conflicts.');
}

function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), keys)
  )
    throw new Error();
  return { ...value };
}
