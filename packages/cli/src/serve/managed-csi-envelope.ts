/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  assertManagedSessionDurableRef,
  assertManagedSessionStableId,
  parseManagedSessionRecordJson,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { LocalShellCaptureRequest } from '@qwen-code/qwen-code-core/managed-runtime/managed-shell-result-session.js';
import type { ToolResultExpectedIdentity } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result-store.js';
import {
  createManagedContextAttestationResponse,
  parseManagedContextBoot,
  type ManagedContextBoot,
} from './managed-context-envelope.js';
import { isCanonicalDecimalText } from './managed-workspace-binding.js';

export const MANAGED_CSI_PROTOCOL = 'managed-csi/1';
export const MANAGED_CSI_ATTEST_PATH =
  '/internal/managed-runtime/csi/v1/attest';
export const MANAGED_CSI_DRAIN_PATH = '/internal/managed-runtime/csi/v1/drain';
export const MANAGED_CSI_ACK_PATH =
  '/internal/managed-runtime/csi/v1/acknowledge';
export const MANAGED_CSI_WORKER_ACK_PROTOCOL =
  'managed-csi-original-worker-ack/1';
export const MANAGED_CSI_ACK_LIMIT_BYTES = 16 * 1024;

export interface ManagedCsiAcknowledgement {
  readonly executionCallId: string;
  readonly manifest: ManagedSessionDurableRef;
  readonly deliveryStatus: 'committed';
  readonly historyRevision: number;
}

export interface ManagedCsiAckRequest {
  readonly protocolVersion: 1;
  readonly managedCsi: typeof MANAGED_CSI_PROTOCOL;
  readonly workerAck: typeof MANAGED_CSI_WORKER_ACK_PROTOCOL;
  readonly retirementId: string;
  readonly context: ReturnType<typeof createManagedContextAttestationResponse>;
  readonly storage: ManagedCsiStorage;
  readonly pod: ManagedCsiPodIdentity;
  readonly reference: LocalShellCaptureRequest['reference'];
  readonly acknowledgement: ManagedCsiAcknowledgement;
}

export interface ManagedCsiAckResponse extends ManagedCsiAckRequest {
  readonly state: 'ACKNOWLEDGED';
  readonly captureIdentity: ToolResultExpectedIdentity;
}

export class ManagedCsiAckRequestError extends Error {
  constructor(readonly status: 400 | 409) {
    super('Managed CSI acknowledgement conflicts.');
  }
}

export function parseManagedCsiAckJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  parseManagedSessionRecordJson(text, MANAGED_CSI_ACK_LIMIT_BYTES);
  return JSON.parse(
    text,
    (_key: string, value: unknown, context?: { source?: string }) => {
      if (
        typeof value === 'number' &&
        (context?.source === undefined || !/^[1-9][0-9]*$/.test(context.source))
      )
        throw new Error('Managed CSI acknowledgement JSON is invalid.');
      return value;
    },
  ) as unknown;
}

export function parseManagedCsiAcknowledgement(
  value: unknown,
): ManagedCsiAcknowledgement {
  const ack = closed(value, [
    'deliveryStatus',
    'executionCallId',
    'historyRevision',
    'manifest',
  ]);
  const manifest = assertManagedSessionDurableRef(
    ack['manifest'] as ManagedSessionJsonValue,
    'manifest',
  );
  if (
    ack['deliveryStatus'] !== 'committed' ||
    !Number.isSafeInteger(ack['historyRevision']) ||
    (ack['historyRevision'] as number) < 1 ||
    manifest.kind !== 'managed-tool-result-manifest' ||
    manifest.schemaVersion !== 1 ||
    manifest.byteLength < 1 ||
    manifest.byteLength > 65536
  )
    throw new Error();
  return {
    executionCallId: stableId(ack['executionCallId']),
    manifest,
    deliveryStatus: 'committed',
    historyRevision: ack['historyRevision'] as number,
  };
}

export function parseManagedCsiCaptureIdentity(
  value: unknown,
): ToolResultExpectedIdentity {
  const identity = closed(value, [
    'bindingGeneration',
    'callId',
    'captureId',
    'executionCallId',
    'invocationDigest',
    'revision',
    'sessionId',
    'tenantId',
    'turnId',
  ]);
  if (
    !isCanonicalDecimalText(identity['bindingGeneration']) ||
    identity['revision'] !== 1 ||
    typeof identity['captureId'] !== 'string' ||
    !/^[a-z0-9_-]{1,128}$/.test(identity['captureId']) ||
    !invocationDigest(identity['invocationDigest'])
  )
    throw new Error();
  return {
    tenantId: stableId(identity['tenantId']),
    sessionId: stableId(identity['sessionId']),
    turnId: stableId(identity['turnId']),
    executionCallId: stableId(identity['executionCallId']),
    callId: stableId(identity['callId']),
    invocationDigest: identity['invocationDigest'],
    bindingGeneration: identity['bindingGeneration'],
    captureId: identity['captureId'],
    revision: 1,
  };
}

export function parseManagedCsiAckRequest(
  value: unknown,
  boot: ManagedCsiBoot,
  pod: ManagedCsiPodIdentity,
): ManagedCsiAckRequest {
  let request: Record<string, unknown>;
  let reference: LocalShellCaptureRequest['reference'];
  let acknowledgement: ManagedCsiAcknowledgement;
  const context = createManagedContextAttestationResponse(boot.context);
  try {
    request = closed(value, ACK_REQUEST_KEYS);
    if (
      typeof request['retirementId'] !== 'string' ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(
        request['retirementId'],
      )
    )
      throw new Error();
    const ref = closed(request['reference'], [
      'argsDigest',
      'callId',
      'promptId',
      'sessionId',
    ]);
    if (!invocationDigest(ref['argsDigest'])) throw new Error();
    reference = {
      sessionId: stableId(ref['sessionId']),
      promptId: stableId(ref['promptId']),
      callId: stableId(ref['callId']),
      argsDigest: ref['argsDigest'],
    };
    acknowledgement = parseManagedCsiAcknowledgement(
      request['acknowledgement'],
    );
    closed(request['context'], Object.keys(context).sort());
    closed(request['storage'], STORAGE_KEYS);
    closed(request['pod'], ['namespace', 'nodeName', 'uid']);
  } catch {
    throw new ManagedCsiAckRequestError(400);
  }
  try {
    validateManagedCsiPodIdentity(pod, boot.storage.namespace);
    if (
      request['protocolVersion'] !== 1 ||
      request['managedCsi'] !== MANAGED_CSI_PROTOCOL ||
      request['workerAck'] !== MANAGED_CSI_WORKER_ACK_PROTOCOL ||
      boot.context.isolationClass !== 'workspace'
    )
      throw new Error();
    for (const [key, expected] of [
      ['context', context],
      ['storage', boot.storage],
      ['pod', pod],
    ] as const) {
      const fields = request[key] as Record<string, unknown>;
      if (
        !Object.entries(expected).every(
          ([name, field]) => fields[name] === field,
        )
      )
        throw new Error();
    }
  } catch {
    throw new ManagedCsiAckRequestError(409);
  }
  return {
    protocolVersion: 1,
    managedCsi: MANAGED_CSI_PROTOCOL,
    workerAck: MANAGED_CSI_WORKER_ACK_PROTOCOL,
    retirementId: request['retirementId'] as string,
    context,
    storage: { ...boot.storage },
    pod: { ...pod },
    reference,
    acknowledgement,
  };
}

export function parseManagedCsiAckResponse(
  value: unknown,
  boot: ManagedCsiBoot,
  pod: ManagedCsiPodIdentity,
): ManagedCsiAckResponse {
  try {
    const response = closed(
      value,
      [...ACK_REQUEST_KEYS, 'captureIdentity', 'state'].sort(),
    );
    if (response['state'] !== 'ACKNOWLEDGED') throw new Error();
    const request = parseManagedCsiAckRequest(
      Object.fromEntries(ACK_REQUEST_KEYS.map((key) => [key, response[key]])),
      boot,
      pod,
    );
    const identity = parseManagedCsiCaptureIdentity(
      response['captureIdentity'],
    );
    if (
      identity.tenantId !== boot.context.tenantId ||
      identity.executionCallId !== request.acknowledgement.executionCallId ||
      identity.callId !== request.reference.callId ||
      identity.invocationDigest !== request.reference.argsDigest
    )
      throw new Error();
    return { ...request, state: 'ACKNOWLEDGED', captureIdentity: identity };
  } catch {
    throw new ManagedCsiAckRequestError(409);
  }
}

const ACK_REQUEST_KEYS = [
  'acknowledgement',
  'context',
  'managedCsi',
  'pod',
  'protocolVersion',
  'reference',
  'retirementId',
  'storage',
  'workerAck',
];

function stableId(value: unknown): string {
  return assertManagedSessionStableId(value as ManagedSessionJsonValue, 'id');
}

function invocationDigest(value: unknown): value is string {
  return typeof value === 'string' && /^(?:sha256:)?[0-9a-f]{64}$/.test(value);
}

export interface ManagedCsiStorage {
  readonly clusterDomain: string;
  readonly namespace: string;
  readonly pvcUid: string;
  readonly pvUid: string;
  readonly driver: 'diskplugin.csi.alibabacloud.com';
  readonly volumeHandle: string;
  readonly backendDomain: string;
  readonly diskSerial: string;
  readonly physicalKey: string;
  readonly registrationRevision: string;
  readonly reservationId: string;
  readonly reservationRevision: string;
}

/** Boot v3 wraps the unchanged closed boot-v2 contract. */
export interface ManagedCsiBoot {
  readonly type: 'boot';
  readonly version: 3;
  readonly managedCsi: typeof MANAGED_CSI_PROTOCOL;
  readonly context: ManagedContextBoot;
  readonly storage: ManagedCsiStorage;
}

export interface ManagedCsiPodIdentity {
  readonly uid: string;
  readonly namespace: string;
  readonly nodeName: string;
}

export interface ManagedCsiMountReceipt {
  readonly mountId: string;
  readonly device: string;
  readonly source: string;
  readonly diskSerial: string;
  readonly rootDevice: string;
  readonly rootInode: string;
}

export function createManagedCsiAttestationRequest(boot: ManagedCsiBoot) {
  return Object.freeze({
    protocolVersion: 1,
    managedCsi: MANAGED_CSI_PROTOCOL,
    provisionRequestId: boot.context.provisionRequestId,
    physicalKey: boot.storage.physicalKey,
    registrationRevision: boot.storage.registrationRevision,
    reservationId: boot.storage.reservationId,
    reservationRevision: boot.storage.reservationRevision,
  });
}

export class ManagedCsiDrainRequestError extends Error {
  constructor(readonly status: 400 | 409) {
    super('Managed CSI drain request is invalid.');
  }
}

export function createManagedCsiDrainRequest(
  boot: ManagedCsiBoot,
  pod: ManagedCsiPodIdentity,
  retirementId: string,
  operation: 'seal' | 'status',
) {
  return {
    protocolVersion: 1,
    managedCsi: MANAGED_CSI_PROTOCOL,
    operation,
    retirementId,
    context: createManagedContextAttestationResponse(boot.context),
    storage: boot.storage,
    pod,
  };
}

export function parseManagedCsiDrainRequest(
  value: unknown,
  boot: ManagedCsiBoot,
  pod: ManagedCsiPodIdentity,
): { operation: 'seal' | 'status'; retirementId: string } {
  let request: Record<string, unknown>;
  try {
    request = closed(value, [
      'context',
      'managedCsi',
      'operation',
      'pod',
      'protocolVersion',
      'retirementId',
      'storage',
    ]);
    if (
      (request['operation'] !== 'seal' && request['operation'] !== 'status') ||
      typeof request['retirementId'] !== 'string' ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(
        request['retirementId'],
      )
    )
      throw new Error();
  } catch {
    throw new ManagedCsiDrainRequestError(400);
  }
  try {
    validateManagedCsiPodIdentity(pod, boot.storage.namespace);
    if (
      request['protocolVersion'] !== 1 ||
      request['managedCsi'] !== MANAGED_CSI_PROTOCOL
    )
      throw new Error();
    for (const [key, expected] of [
      ['context', createManagedContextAttestationResponse(boot.context)],
      ['storage', boot.storage],
      ['pod', pod],
    ] as const) {
      const actual = closed(request[key], Object.keys(expected).sort());
      if (
        !Object.entries(expected).every(
          ([name, field]) => actual[name] === field,
        )
      )
        throw new Error();
    }
  } catch {
    throw new ManagedCsiDrainRequestError(409);
  }
  return {
    operation: request['operation'],
    retirementId: request['retirementId'],
  } as {
    operation: 'seal' | 'status';
    retirementId: string;
  };
}

export function validateManagedCsiAttestationRequest(
  value: unknown,
  boot: ManagedCsiBoot,
): void {
  const expected = createManagedCsiAttestationRequest(boot);
  try {
    const actual = closed(value, Object.keys(expected).sort());
    if (
      !Object.entries(expected).every(([key, field]) => actual[key] === field)
    )
      throw new Error();
  } catch {
    throw new Error('Managed CSI attestation request is invalid.');
  }
}

export function validateManagedCsiPodIdentity(
  value: unknown,
  namespace: string,
): asserts value is ManagedCsiPodIdentity {
  const pod = closed(value, ['namespace', 'nodeName', 'uid']);
  if (
    typeof pod['uid'] !== 'string' ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(pod['uid']) ||
    pod['namespace'] !== namespace ||
    typeof pod['nodeName'] !== 'string' ||
    pod['nodeName'].length > 253 ||
    !pod['nodeName']
      .split('.')
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new Error('Managed CSI Pod identity is unavailable.');
}

export function validateManagedCsiAttestationResponse(
  value: unknown,
  boot: ManagedCsiBoot,
  expectedPod: ManagedCsiPodIdentity,
): void {
  try {
    validateManagedCsiPodIdentity(expectedPod, boot.storage.namespace);
    const response = closed(value, [
      'context',
      'managedCsi',
      'mount',
      'pod',
      'protocolVersion',
      'storage',
    ]);
    const context = createManagedContextAttestationResponse(boot.context);
    for (const [key, expected] of [
      ['context', context],
      ['storage', boot.storage],
      ['pod', expectedPod],
    ] as const) {
      const fields = closed(response[key], Object.keys(expected).sort());
      if (
        !Object.entries(expected).every(
          ([name, field]) => fields[name] === field,
        )
      )
        throw new Error();
    }
    const mount = closed(response['mount'], [
      'device',
      'diskSerial',
      'mountId',
      'rootDevice',
      'rootInode',
      'source',
    ]);
    if (
      response['protocolVersion'] !== 1 ||
      response['managedCsi'] !== MANAGED_CSI_PROTOCOL ||
      !unsignedDecimal(mount['mountId'], 0xffff_ffffn, true) ||
      typeof mount['source'] !== 'string' ||
      mount['source'].length > 128 ||
      !/^\/dev\/nvme(?:0|[1-9][0-9]*)n[1-9][0-9]*$/.test(mount['source']) ||
      mount['diskSerial'] !== boot.storage.diskSerial ||
      !unsignedDecimal(mount['rootDevice'], 0xffff_ffff_ffff_ffffn, false) ||
      !unsignedDecimal(mount['rootInode'], 0xffff_ffff_ffff_ffffn, true) ||
      linuxDeviceNumber(mount['device']) !== mount['rootDevice']
    )
      throw new Error();
  } catch {
    throw new Error('Managed CSI attestation response is invalid.');
  }
}

/** Linux/glibc dev_t encodes 32-bit major and minor in a 64-bit value. */
export function linuxDeviceNumber(value: unknown): string {
  if (typeof value !== 'string') throw new Error();
  const parts = value.split(':');
  if (
    parts.length !== 2 ||
    !parts.every((part) => unsignedDecimal(part, 0xffff_ffffn, false))
  )
    throw new Error();
  const major = BigInt(parts[0]);
  const minor = BigInt(parts[1]);
  return (
    ((major & 0xfffn) << 8n) |
    ((major & 0xffff_f000n) << 32n) |
    (minor & 0xffn) |
    ((minor & 0xffff_ff00n) << 12n)
  ).toString();
}

function unsignedDecimal(
  value: unknown,
  maximum: bigint,
  positive: boolean,
): value is string {
  return (
    typeof value === 'string' &&
    /^(?:0|[1-9][0-9]{0,19})$/.test(value) &&
    (!positive || value !== '0') &&
    BigInt(value) <= maximum
  );
}

const BOOT_KEYS = ['context', 'managedCsi', 'storage', 'type', 'version'];
const STORAGE_KEYS = [
  'backendDomain',
  'clusterDomain',
  'diskSerial',
  'driver',
  'namespace',
  'physicalKey',
  'pvUid',
  'pvcUid',
  'registrationRevision',
  'reservationId',
  'reservationRevision',
  'volumeHandle',
];
const INVALID = 'Managed CSI boot document is invalid.';

export function parseManagedCsiBoot(value: unknown): ManagedCsiBoot {
  try {
    const boot = closed(value, BOOT_KEYS);
    const storage = closed(boot['storage'], STORAGE_KEYS);
    const context = parseManagedContextBoot(boot['context']);
    if (
      boot['type'] !== 'boot' ||
      boot['version'] !== 3 ||
      boot['managedCsi'] !== MANAGED_CSI_PROTOCOL
    ) {
      throw new Error(INVALID);
    }
    for (const [key, maximum] of [
      ['clusterDomain', 256],
      ['backendDomain', 256],
      ['volumeHandle', 512],
      ['pvcUid', 128],
      ['pvUid', 128],
    ] as const) {
      const text = storage[key];
      if (
        typeof text !== 'string' ||
        text === '' ||
        /^[ \u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]+$/u.test(
          text,
        ) ||
        text.length > maximum ||
        Array.from(text).some(
          (char) =>
            char.charCodeAt(0) <= 31 ||
            (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
        ) ||
        /[\ud800-\udfff]/u.test(text)
      )
        throw new Error(INVALID);
    }
    if (
      typeof storage['namespace'] !== 'string' ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(storage['namespace']) ||
      storage['driver'] !== 'diskplugin.csi.alibabacloud.com' ||
      typeof storage['diskSerial'] !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(storage['diskSerial']) ||
      !isCanonicalDecimalText(storage['registrationRevision']) ||
      !isCanonicalDecimalText(storage['reservationRevision']) ||
      typeof storage['reservationId'] !== 'string' ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(
        storage['reservationId'],
      ) ||
      typeof storage['physicalKey'] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(storage['physicalKey']) ||
      !context.mountRoot.startsWith('/') ||
      context.mountRoot.length > 2048 ||
      context.mountRoot.includes('\\') ||
      !context.mountRoot
        .slice(1)
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..') ||
      physicalKey(
        storage['backendDomain'] as string,
        storage['driver'],
        storage['volumeHandle'] as string,
      ) !== storage['physicalKey']
    )
      throw new Error(INVALID);
    return Object.freeze({
      type: 'boot',
      version: 3,
      managedCsi: MANAGED_CSI_PROTOCOL,
      context,
      storage: Object.freeze({ ...storage }) as unknown as ManagedCsiStorage,
    });
  } catch {
    throw new Error(INVALID);
  }
}

function physicalKey(backend: string, driver: string, handle: string): string {
  const hash = createHash('sha256');
  for (const field of ['qwen-csi-physical/1', backend, driver, handle]) {
    const bytes = Buffer.from(field, 'utf8');
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.byteLength);
    hash.update(size).update(bytes);
  }
  return hash.digest('hex');
}

function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(INVALID);
  const fields = Object.keys(value).sort();
  if (
    fields.length !== keys.length ||
    !fields.every((field, index) => field === keys[index])
  )
    throw new Error(INVALID);
  return value as Record<string, unknown>;
}
