/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHmac, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  createDebugLogger,
  isDebugLogFileEnabled,
} from '@qwen-code/qwen-code-core';

export const TOOL_RESULT_DIAGNOSTIC_LIMIT = 50;
export const TOOL_RESULT_DIAGNOSTIC_WINDOW_MS = 60_000;
export const TOOL_RESULT_DIAGNOSTIC_LARGE_BYTES = 64 * 1024;
export const TOOL_RESULT_DIAGNOSTIC_EVENT_NAME =
  'qwen-code.tool_result.boundary';

export type ToolResultBoundary =
  | 'producer'
  | 'finalizer'
  | 'recorder'
  | 'projection'
  | 'wire';

export type ArtifactState = 'absent' | 'present' | 'unknown';

export interface ToolResultBoundaryObservation {
  boundary: ToolResultBoundary;
  representation: unknown;
  /** True when this boundary changed the representation from its predecessor. */
  mutated?: boolean;
  artifactState?: ArtifactState;
  artifactKind?: string;
  /** Exact bytes of the payload at a transport writer boundary. */
  wireBytes?: number;
  /** Stable, privacy-sensitive identifiers. They are hashed before logging. */
  identifiers?: Record<string, string | undefined>;
}

export interface ToolResultBoundaryDiagnosticEvent {
  eventName: typeof TOOL_RESULT_DIAGNOSTIC_EVENT_NAME;
  boundary: ToolResultBoundary;
  mutation: boolean;
  artifactState: ArtifactState;
  artifactKind?: string;
  jsCodeUnits: number;
  rawUtf8Bytes: number;
  jsonUtf8Bytes: number;
  wireBytes?: number;
  representationHmac: string;
  identifierHmacs: Record<string, string>;
  suppressedCount?: number;
}

export interface ToolResultBoundaryDiagnosticsOptions {
  now?: () => number;
  enabled?: () => boolean;
  secret?: Uint8Array;
  emit?: (event: ToolResultBoundaryDiagnosticEvent) => void;
}

const debugLogger = createDebugLogger('TOOL_RESULT_BOUNDARY');

function lengthDelimited(parts: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength, 0);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}

function digest(secret: Uint8Array, parts: readonly string[]): string {
  return createHmac('sha256', secret)
    .update(lengthDelimited(parts))
    .digest('hex');
}

function safeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return '[unserializable]';
  }
}

function collectStringStats(
  value: unknown,
  seen = new WeakSet<object>(),
): {
  codeUnits: number;
  utf8Bytes: number;
} {
  if (typeof value === 'string') {
    return {
      codeUnits: value.length,
      utf8Bytes: Buffer.byteLength(value, 'utf8'),
    };
  }
  if (typeof value !== 'object' || value === null) {
    return { codeUnits: 0, utf8Bytes: 0 };
  }
  if (seen.has(value)) return { codeUnits: 0, utf8Bytes: 0 };
  seen.add(value);
  let codeUnits = 0;
  let utf8Bytes = 0;
  const values = Array.isArray(value) ? value : Object.values(value);
  for (const child of values) {
    const stats = collectStringStats(child, seen);
    codeUnits += stats.codeUnits;
    utf8Bytes += stats.utf8Bytes;
  }
  return { codeUnits, utf8Bytes };
}

/**
 * Produces privacy-safe boundary facts. It never puts a representation,
 * identifier, path, prompt, or tool name in the emitted event.
 */
export function createToolResultBoundaryDiagnostics(
  options: ToolResultBoundaryDiagnosticsOptions = {},
): (observation: ToolResultBoundaryObservation) => void {
  const now = options.now ?? Date.now;
  const enabled = options.enabled ?? isDebugLogFileEnabled;
  const secret = options.secret ?? randomBytes(32);
  const emit = options.emit ?? ((event) => debugLogger.info(event));
  let windowStartedAt = now();
  let emitted = 0;
  let suppressed = 0;

  return (observation) => {
    try {
      if (!enabled()) return;
      const stats = collectStringStats(observation.representation);
      const json = safeJson(observation.representation);
      const jsonUtf8Bytes = Buffer.byteLength(json, 'utf8');
      const wireBytes = observation.wireBytes;
      const large =
        stats.utf8Bytes >= TOOL_RESULT_DIAGNOSTIC_LARGE_BYTES ||
        jsonUtf8Bytes >= TOOL_RESULT_DIAGNOSTIC_LARGE_BYTES ||
        (wireBytes ?? 0) >= TOOL_RESULT_DIAGNOSTIC_LARGE_BYTES;
      if (!large && observation.mutated !== true) return;

      const current = now();
      if (current - windowStartedAt >= TOOL_RESULT_DIAGNOSTIC_WINDOW_MS) {
        windowStartedAt = current;
        emitted = 0;
      }
      if (emitted >= TOOL_RESULT_DIAGNOSTIC_LIMIT) {
        suppressed++;
        return;
      }

      const event: ToolResultBoundaryDiagnosticEvent = {
        eventName: TOOL_RESULT_DIAGNOSTIC_EVENT_NAME,
        boundary: observation.boundary,
        mutation: observation.mutated === true,
        artifactState: observation.artifactState ?? 'unknown',
        ...(observation.artifactKind === undefined &&
        observation.artifactState !== 'present'
          ? {}
          : {
              artifactKind: observation.artifactKind ?? 'output_file',
            }),
        jsCodeUnits: stats.codeUnits,
        rawUtf8Bytes: stats.utf8Bytes,
        jsonUtf8Bytes,
        ...(wireBytes === undefined ? {} : { wireBytes }),
        representationHmac: digest(secret, ['representation', json]),
        identifierHmacs: Object.fromEntries(
          Object.entries(observation.identifiers ?? {})
            .filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            )
            .map(([key, value]) => [
              key,
              digest(secret, ['identifier', key, value]),
            ]),
        ),
        ...(suppressed === 0 ? {} : { suppressedCount: suppressed }),
      };
      suppressed = 0;
      emitted++;
      emit(event);
    } catch {
      // Diagnostics must be behaviorally inert, including when logging fails.
    }
  };
}

/** Process-local observer: the HMAC key intentionally never crosses a process boundary. */
export const observeToolResultBoundary = createToolResultBoundaryDiagnostics();

export function observeToolResultBoundaryWire(
  message: unknown,
  wireBytes: number,
): void {
  try {
    if (typeof message !== 'object' || message === null) return;
    const params = (message as Record<string, unknown>)['params'];
    if (typeof params !== 'object' || params === null) return;
    const update = (params as Record<string, unknown>)['update'];
    if (typeof update !== 'object' || update === null) return;
    const updateRecord = update as Record<string, unknown>;
    if (updateRecord['sessionUpdate'] !== 'tool_call_update') return;
    observeToolResultBoundary({
      boundary: 'wire',
      representation: update,
      wireBytes,
      identifiers: {
        callId:
          typeof updateRecord['toolCallId'] === 'string'
            ? updateRecord['toolCallId']
            : undefined,
      },
    });
  } catch {
    // Wire diagnostics must never affect the ACP stream.
  }
}

export function observeToolResultBoundaryWriter(
  representation: unknown,
  wireBytes: number,
  identifiers?: Record<string, string | undefined>,
): void {
  observeToolResultBoundary({
    boundary: 'wire',
    representation,
    wireBytes,
    identifiers,
  });
}
