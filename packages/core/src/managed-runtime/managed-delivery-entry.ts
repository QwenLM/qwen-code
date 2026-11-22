/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  assertManagedSessionDurableRef,
  type ManagedSessionDurableRef,
} from './managed-session-records.js';
import {
  MANAGED_TOOL_RESULT_KINDS,
  parseToolResultEnvelope,
  type ToolResultEnvelope,
} from './managed-tool-result.js';

// Phase 3b of #17453 (docs/design/2026-11-19-managed-runtime-owned-observation):
// the ordered delivery stream a worker-owned background capture produces.
// Each entry carries the complete resources it introduces, so an entry and
// the bytes it references are always staged together and deleted together.
// A consumer (the resident Harness applier, or the Broker's staging ledger)
// acknowledges the highest contiguous sequence it made durable; the worker
// drops an entry only after that acknowledgement.

export interface ManagedDeliveryResource {
  readonly ref: ManagedSessionDurableRef;
  readonly bytesBase64: string;
}

type ManagedDeliveryEntryKind = 'output' | 'observation' | 'terminal';

interface ManagedDeliveryEntryBase {
  readonly deliverySeq: number;
  readonly executionCallId: string;
  readonly bindingGeneration: string;
  readonly kind: ManagedDeliveryEntryKind;
  readonly resources: readonly ManagedDeliveryResource[];
}

/** A manifest revision with the segment bytes, pages and manifest it adds. */
export interface ManagedDeliveryOutputEntry extends ManagedDeliveryEntryBase {
  readonly kind: 'output';
  readonly manifestRef: ManagedSessionDurableRef;
  readonly manifestRevision: number;
}

/** One Monitor observation, its sequence fixed when the observation is made. */
export interface ManagedDeliveryObservationEntry
  extends ManagedDeliveryEntryBase {
  readonly kind: 'observation';
  readonly sequence: number;
  readonly lines: readonly string[];
  readonly notification: {
    readonly inputId: string;
    readonly turnId: string;
    readonly contentRef: ManagedSessionDurableRef;
    readonly admissionRef: ManagedSessionDurableRef;
  } | null;
}

export type ManagedMonitorStopReason = 'exited' | 'max_events' | 'idle_timeout';

/** The exit proof and the final manifest revision of a background run. */
export interface ManagedDeliveryTerminalEntry extends ManagedDeliveryEntryBase {
  readonly kind: 'terminal';
  readonly envelope: ToolResultEnvelope;
  readonly evidence: {
    readonly exitCode: number | null;
    readonly exitSignal: string | null;
  } | null;
  readonly stopRequested: boolean;
  readonly executionStatus: 'success' | 'error' | 'cancelled';
  /** Present for monitor_run: the policy reason a proven end settles at. */
  readonly monitorStopReason?: ManagedMonitorStopReason;
  readonly manifestRef: ManagedSessionDurableRef | null;
}

export type ManagedDeliveryEntry =
  | ManagedDeliveryOutputEntry
  | ManagedDeliveryObservationEntry
  | ManagedDeliveryTerminalEntry;

/** The largest single delivery request, sized above one 256 KiB flush batch. */
export const MANAGED_DELIVERY_REQUEST_LIMIT_BYTES = 512 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireString(
  object: Record<string, unknown>,
  key: string,
  max = 512,
): string {
  const value = object[key];
  if (typeof value !== 'string' || !value || value.length > max) {
    throw new Error(`Delivery entry ${key} is invalid.`);
  }
  return value;
}

function requirePositiveInteger(
  object: Record<string, unknown>,
  key: string,
): number {
  const value = object[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`Delivery entry ${key} must be a positive integer.`);
  }
  return value as number;
}

function parseResource(value: unknown): ManagedDeliveryResource {
  if (!isRecord(value)) throw new Error('Delivery resource is invalid.');
  const ref = assertManagedSessionDurableRef(
    { ...(value['ref'] as object) },
    'delivery resource',
  );
  const bytesBase64 = value['bytesBase64'];
  if (typeof bytesBase64 !== 'string') {
    throw new Error('Delivery resource bytes are invalid.');
  }
  const bytes = Buffer.from(bytesBase64, 'base64');
  if (bytes.toString('base64') !== bytesBase64) {
    throw new Error('Delivery resource bytes are not canonical base64.');
  }
  if (bytes.byteLength !== ref.byteLength) {
    throw new Error('Delivery resource byte length conflicts.');
  }
  return { ref, bytesBase64 };
}

function parseResources(value: unknown): ManagedDeliveryResource[] {
  if (!Array.isArray(value)) {
    throw new Error('Delivery entry resources must be an array.');
  }
  return value.map(parseResource);
}

function parseBase(object: Record<string, unknown>): ManagedDeliveryEntryBase {
  const kind = object['kind'];
  if (kind !== 'output' && kind !== 'observation' && kind !== 'terminal') {
    throw new Error('Delivery entry kind is invalid.');
  }
  const bindingGeneration = requireString(object, 'bindingGeneration', 20);
  if (!/^[1-9][0-9]{0,18}$/.test(bindingGeneration)) {
    throw new Error('Delivery entry binding generation is invalid.');
  }
  return {
    deliverySeq: requirePositiveInteger(object, 'deliverySeq'),
    executionCallId: requireString(object, 'executionCallId'),
    bindingGeneration,
    kind,
    resources: parseResources(object['resources']),
  };
}

export function parseManagedDeliveryEntry(
  value: unknown,
): ManagedDeliveryEntry {
  if (!isRecord(value)) throw new Error('Delivery entry must be an object.');
  const base = parseBase(value);
  if (base.kind === 'output') {
    const manifestRef = assertManagedSessionDurableRef(
      { ...(value['manifestRef'] as object) },
      'delivery manifest',
    );
    if (manifestRef.kind !== MANAGED_TOOL_RESULT_KINDS.manifest) {
      throw new Error('Delivery output manifest kind is invalid.');
    }
    return {
      ...base,
      kind: 'output',
      manifestRef,
      manifestRevision: requirePositiveInteger(value, 'manifestRevision'),
    };
  }
  if (base.kind === 'observation') {
    const sequence = requirePositiveInteger(value, 'sequence');
    if (!Array.isArray(value['lines']) || value['lines'].length === 0) {
      throw new Error('Delivery observation lines are invalid.');
    }
    const lines = value['lines'].map((line) => {
      if (typeof line !== 'string' || !line) {
        throw new Error('Delivery observation line is invalid.');
      }
      return line;
    });
    let notification: ManagedDeliveryObservationEntry['notification'] = null;
    if (value['notification'] !== null && value['notification'] !== undefined) {
      const input = value['notification'];
      if (!isRecord(input)) {
        throw new Error('Delivery observation notification is invalid.');
      }
      notification = {
        inputId: requireString(input, 'inputId'),
        turnId: requireString(input, 'turnId'),
        contentRef: assertManagedSessionDurableRef(
          { ...(input['contentRef'] as object) },
          'notification content',
        ),
        admissionRef: assertManagedSessionDurableRef(
          { ...(input['admissionRef'] as object) },
          'notification admission',
        ),
      };
    }
    return { ...base, kind: 'observation', sequence, lines, notification };
  }
  const envelope = parseToolResultEnvelope(value['envelope']);
  const executionStatus = value['executionStatus'];
  if (
    executionStatus !== 'success' &&
    executionStatus !== 'error' &&
    executionStatus !== 'cancelled'
  ) {
    throw new Error('Delivery terminal execution status is invalid.');
  }
  if (typeof value['stopRequested'] !== 'boolean') {
    throw new Error('Delivery terminal stop marker is invalid.');
  }
  let evidence: ManagedDeliveryTerminalEntry['evidence'] = null;
  if (value['evidence'] !== null && value['evidence'] !== undefined) {
    const raw = value['evidence'];
    if (!isRecord(raw)) throw new Error('Delivery terminal evidence invalid.');
    const exitCode = raw['exitCode'];
    const exitSignal = raw['exitSignal'];
    if (
      (exitCode !== null && !Number.isInteger(exitCode)) ||
      (exitSignal !== null && typeof exitSignal !== 'string') ||
      (exitCode === null && exitSignal === null)
    ) {
      throw new Error('Delivery terminal evidence is invalid.');
    }
    evidence = {
      exitCode: exitCode as number | null,
      exitSignal: exitSignal as string | null,
    };
  }
  let monitorStopReason: ManagedMonitorStopReason | undefined;
  if (value['monitorStopReason'] !== undefined) {
    const reason = value['monitorStopReason'];
    if (
      reason !== 'exited' &&
      reason !== 'max_events' &&
      reason !== 'idle_timeout'
    ) {
      throw new Error('Delivery terminal monitor stop reason is invalid.');
    }
    monitorStopReason = reason;
  }
  const manifestRef =
    value['manifestRef'] === null || value['manifestRef'] === undefined
      ? null
      : assertManagedSessionDurableRef(
          { ...(value['manifestRef'] as object) },
          'delivery terminal manifest',
        );
  return {
    ...base,
    kind: 'terminal',
    envelope,
    evidence,
    stopRequested: value['stopRequested'],
    executionStatus,
    ...(monitorStopReason ? { monitorStopReason } : {}),
    manifestRef,
  };
}
