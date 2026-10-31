/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  assertManagedSessionDurableRef,
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';
import {
  parseManagedExtensionApplyCommand,
  type ManagedExtensionApplyCommand,
} from './managed-extension-package.js';

export const MANAGED_EXTENSION_CONFIG_KIND = 'hosted-extension-config';

export const MANAGED_CONFIG_INSTALL_PHASES = [
  'preparing',
  'prepared',
  'committed',
  'active',
  'recovery_required',
  'failed',
] as const;

export type ManagedConfigInstallPhase =
  (typeof MANAGED_CONFIG_INSTALL_PHASES)[number];

export interface ManagedConfigInstallContent {
  readonly kind: typeof MANAGED_EXTENSION_CONFIG_KIND;
  readonly formatVersion: 1;
  readonly command: ManagedExtensionApplyCommand;
  readonly mode: 'apply' | 'recoverPrevious';
  readonly phaseOperationId: string;
  readonly configRevision: number;
  readonly previousConfigRevision: number;
  readonly phase: ManagedConfigInstallPhase;
  readonly previousBundleRef: ManagedSessionDurableRef | null;
  readonly restoresBundleRef: ManagedSessionDurableRef | null;
  readonly bundleRef: ManagedSessionDurableRef | null;
  readonly rootSnapshotRef: ManagedSessionDurableRef;
  readonly stageAckRefs: readonly ManagedSessionDurableRef[];
  readonly enableAckRefs: readonly ManagedSessionDurableRef[];
  readonly error: { readonly code: string } | null;
}

export interface ManagedConfigInstallRecord
  extends ManagedConfigInstallContent {
  readonly operationId: string;
  readonly revision: number;
  readonly previousRecordRef: ManagedSessionDurableRef | null;
}

export interface ManagedConfigBinding {
  readonly revision: number;
  readonly previousRevision: number | null;
  readonly bundleRef: ManagedSessionDurableRef;
  readonly rootSnapshotRef: ManagedSessionDurableRef;
}

const CONTENT_KEYS = [
  'kind',
  'formatVersion',
  'command',
  'mode',
  'phaseOperationId',
  'configRevision',
  'previousConfigRevision',
  'phase',
  'previousBundleRef',
  'restoresBundleRef',
  'bundleRef',
  'rootSnapshotRef',
  'stageAckRefs',
  'enableAckRefs',
  'error',
] as const;

export function isManagedExtensionConfig(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === MANAGED_EXTENSION_CONFIG_KIND
  );
}

export function parseManagedConfigInstallContent(
  value: unknown,
): ManagedConfigInstallContent {
  return parse(value, false) as ManagedConfigInstallContent;
}

export function parseManagedConfigInstallRecord(
  value: unknown,
): ManagedConfigInstallRecord {
  return parse(value, true) as ManagedConfigInstallRecord;
}

function parse(
  value: unknown,
  envelope: boolean,
): ManagedConfigInstallContent | ManagedConfigInstallRecord {
  const body = object(value);
  const expected = envelope
    ? [...CONTENT_KEYS, 'operationId', 'revision', 'previousRecordRef']
    : CONTENT_KEYS;
  if (
    Object.keys(body).length !== expected.length ||
    Object.keys(body).some(
      (key) => !(expected as readonly string[]).includes(key),
    ) ||
    body['kind'] !== MANAGED_EXTENSION_CONFIG_KIND ||
    body['formatVersion'] !== 1 ||
    !['apply', 'recoverPrevious'].includes(String(body['mode'])) ||
    !revision(body['configRevision'], 1) ||
    !revision(body['previousConfigRevision'], 0) ||
    body['configRevision'] !== Number(body['previousConfigRevision']) + 1 ||
    !(MANAGED_CONFIG_INSTALL_PHASES as readonly unknown[]).includes(
      body['phase'],
    )
  )
    invalid();
  const command = parseManagedExtensionApplyCommand(body['command']);
  const phase = body['phase'] as ManagedConfigInstallPhase;
  const compensating = body['mode'] === 'recoverPrevious';
  if (
    body['phaseOperationId'] !==
    (compensating
      ? managedExtensionCompensationOperationId(command.operationId)
      : command.operationId)
  )
    invalid();
  if (
    Number(body['previousConfigRevision']) !==
    command.expectedRevision + (compensating ? 1 : 0)
  )
    invalid();
  const stageAckRefs = refs(body['stageAckRefs']);
  const enableAckRefs = refs(body['enableAckRefs']);
  if (
    (['prepared', 'committed', 'active'].includes(phase) &&
      stageAckRefs.length < 2) ||
    (phase === 'active' && enableAckRefs.length < 2) ||
    (['preparing', 'prepared', 'failed'].includes(phase) &&
      enableAckRefs.length !== 0)
  )
    invalid();
  const error = body['error'] === null ? null : object(body['error']);
  if (
    error &&
    (Object.keys(error).length !== 1 ||
      typeof error['code'] !== 'string' ||
      !/^[a-z][a-z0-9_]{0,127}$/u.test(error['code']))
  )
    invalid();
  if (
    (phase === 'failed' || phase === 'recovery_required') !==
    (error !== null)
  )
    invalid();
  const parsed: ManagedConfigInstallContent = {
    kind: MANAGED_EXTENSION_CONFIG_KIND,
    formatVersion: 1,
    command,
    mode: body['mode'] as 'apply' | 'recoverPrevious',
    phaseOperationId: body['phaseOperationId'] as string,
    configRevision: body['configRevision'] as number,
    previousConfigRevision: body['previousConfigRevision'] as number,
    phase,
    previousBundleRef:
      body['previousBundleRef'] === null
        ? null
        : ref(body['previousBundleRef']),
    restoresBundleRef:
      body['restoresBundleRef'] === null
        ? null
        : ref(body['restoresBundleRef']),
    bundleRef: body['bundleRef'] === null ? null : ref(body['bundleRef']),
    rootSnapshotRef: ref(body['rootSnapshotRef']),
    stageAckRefs,
    enableAckRefs,
    error: error ? { code: error['code'] as string } : null,
  };
  if ((parsed.restoresBundleRef !== null) !== compensating) invalid();
  if (parsed.bundleRef === null && !['preparing', 'failed'].includes(phase))
    invalid();
  if (!envelope) return parsed;
  if (
    body['operationId'] !== command.operationId ||
    !revision(body['revision'], 1)
  )
    invalid();
  const previousRecordRef =
    body['previousRecordRef'] === null ? null : ref(body['previousRecordRef']);
  if (
    (body['revision'] === 1) !== (previousRecordRef === null) ||
    (previousRecordRef &&
      (previousRecordRef.kind !== 'managed-config_install' ||
        previousRecordRef.schemaVersion !== 1))
  )
    invalid();
  return {
    ...parsed,
    operationId: command.operationId,
    revision: body['revision'] as number,
    previousRecordRef,
  };
}

export function managedConfigBinding(
  content: ManagedConfigInstallContent,
): ManagedConfigBinding {
  if (!content.bundleRef) invalid();
  return {
    revision: content.configRevision,
    previousRevision: content.previousConfigRevision || null,
    bundleRef: content.bundleRef,
    rootSnapshotRef: content.rootSnapshotRef,
  };
}

export function assertManagedConfigInstallSuccessor(
  previous: ManagedConfigInstallRecord | undefined,
  next: ManagedConfigInstallContent,
): void {
  if (!previous) {
    if (
      next.phase !== 'preparing' ||
      next.mode !== 'apply' ||
      next.previousConfigRevision !== 0
    )
      invalid();
    return;
  }
  if (previous.command.operationId !== next.command.operationId) {
    if (
      !['active', 'failed'].includes(previous.phase) ||
      (previous.phase === 'failed' && previous.mode === 'recoverPrevious') ||
      next.phase !== 'preparing' ||
      next.mode !== 'apply' ||
      next.previousConfigRevision !==
        (previous.phase === 'failed'
          ? previous.previousConfigRevision
          : previous.configRevision)
    )
      invalid();
    return;
  }
  const transitions: Record<ManagedConfigInstallPhase, readonly string[]> = {
    preparing: ['prepared', 'failed'],
    prepared: ['committed', 'failed'],
    committed: ['active', 'recovery_required'],
    active: [],
    recovery_required: ['active', 'recovery_required'],
    failed: [],
  };
  const compensation =
    previous.phase === 'recovery_required' &&
    previous.mode === 'apply' &&
    next.mode === 'recoverPrevious' &&
    next.phase === 'preparing';
  if (
    (!compensation && !transitions[previous.phase].includes(next.phase)) ||
    JSON.stringify(previous.command) !== JSON.stringify(next.command) ||
    (!compensation &&
      (previous.mode !== next.mode ||
        previous.phaseOperationId !== next.phaseOperationId ||
        previous.configRevision !== next.configRevision ||
        (!(previous.phase === 'preparing' && previous.bundleRef === null) &&
          JSON.stringify(previous.bundleRef) !==
            JSON.stringify(next.bundleRef)) ||
        JSON.stringify(previous.rootSnapshotRef) !==
          JSON.stringify(next.rootSnapshotRef) ||
        JSON.stringify(previous.previousBundleRef) !==
          JSON.stringify(next.previousBundleRef) ||
        JSON.stringify(previous.restoresBundleRef) !==
          JSON.stringify(next.restoresBundleRef))) ||
    (compensation &&
      (next.configRevision !== previous.configRevision + 1 ||
        previous.previousBundleRef === null ||
        JSON.stringify(next.previousBundleRef) !==
          JSON.stringify(previous.bundleRef) ||
        JSON.stringify(next.restoresBundleRef) !==
          JSON.stringify(previous.previousBundleRef)))
  )
    invalid();
}

export function managedExtensionCompensationOperationId(
  operationId: string,
): string {
  const bytes = createHash('sha256')
    .update(`managed-extension-recoverPrevious:${operationId.toLowerCase()}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function ref(value: unknown): ManagedSessionDurableRef {
  return assertManagedSessionDurableRef(
    value as ManagedSessionJsonValue,
    'extension config reference',
  );
}

function refs(value: unknown): readonly ManagedSessionDurableRef[] {
  if (!Array.isArray(value) || value.length > 8) invalid();
  const parsed = value.map(ref);
  if (new Set(parsed.map((entry) => entry.resourceId)).size !== parsed.length)
    invalid();
  return parsed;
}

function revision(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function invalid(): never {
  throw new ManagedSessionRecordError('Invalid Managed configuration install.');
}
