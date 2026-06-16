/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonEvent } from './types.js';

// ---------------------------------------------------------------------------
// JSON-RPC notification shape
// ---------------------------------------------------------------------------

/**
 * A JSON-RPC 2.0 notification (no `id` field). ACP transports receive
 * these on the wire and must convert them to `DaemonEvent`.
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AcpEventDenormalizer
// ---------------------------------------------------------------------------

/**
 * Monotonic id generator for ACP-sourced events. ACP notifications do
 * not carry a per-session monotonic id the way REST SSE frames do.
 * The denormalizer stamps a local monotonic id so the SDK's
 * `reduceDaemonSessionEvent` / `advanceLastEventId` contract is
 * satisfied. These ids are NOT compatible with the REST daemon's
 * `Last-Event-ID` replay — `AcpWsTransport.supportsReplay = false`
 * reflects this.
 */
let nextSyntheticId = 1;

/**
 * Convert an ACP JSON-RPC notification into a `DaemonEvent`.
 *
 * Mapping rules:
 *   - `session/update` notification → `DaemonEvent` with the `type`
 *     field read from `params.type`. The full `params` object becomes
 *     `data`.
 *   - `_qwen/notify` notification → `DaemonEvent` with `type` and
 *     `data` read from `params`.
 *   - Notifications with `method` matching a known daemon event type
 *     directly (e.g. `memory_changed`, `agent_changed`) are passed
 *     through with `params` as `data`.
 *
 * Returns `undefined` for notifications that don't map to any known
 * `DaemonEvent` shape (the caller silently drops them).
 */
export function denormalizeAcpNotification(
  notification: JsonRpcNotification,
): DaemonEvent | undefined {
  const params = notification.params ?? {};

  // Primary path: session/update carries the event payload inside
  // params.update.sessionUpdate.  The daemon's `translateEvent` sends:
  //   { method: "session/update", params: { sessionId, update: { sessionUpdate: "<type>", ...fields } } }
  // The `update` object (or `update.sessionUpdate` string for the type)
  // is the canonical event data.
  if (notification.method === 'session/update') {
    const rawUpdate = isRecord(params['update']) ? params['update'] : undefined;

    // New format (current daemon): type at update.sessionUpdate, data
    // is the update object itself.
    // Legacy format: type at params.type, data at params.data.
    const type = rawUpdate
      ? typeof rawUpdate['sessionUpdate'] === 'string'
        ? rawUpdate['sessionUpdate']
        : undefined
      : typeof params['type'] === 'string'
        ? params['type']
        : undefined;
    if (!type || type.length === 0) return undefined;

    // Build the event data payload. For the new format, spread the
    // update object and inject sessionId so the WS transport's
    // per-session filter (event.data.sessionId) works. For the
    // legacy format, use params.data or fall back to params itself.
    let data: unknown;
    if (rawUpdate) {
      const d: Record<string, unknown> = { ...rawUpdate };
      if (typeof params['sessionId'] === 'string') {
        d['sessionId'] = params['sessionId'];
      }
      data = d;
    } else {
      data = params['data'] ?? params;
    }

    // _meta may live inside the update object or at params level.
    const meta = rawUpdate
      ? isRecord(rawUpdate['_meta'])
        ? rawUpdate['_meta']
        : isRecord(params['_meta'])
          ? params['_meta']
          : undefined
      : isRecord(params['_meta'])
        ? params['_meta']
        : undefined;

    return {
      id: nextSyntheticId++,
      v: 1,
      type,
      data,
      _meta: meta,
      originatorClientId:
        typeof params['originatorClientId'] === 'string'
          ? params['originatorClientId']
          : undefined,
    };
  }

  // Extension path: _qwen/notify is a generic notification envelope.
  if (notification.method === '_qwen/notify') {
    const type = params['type'];
    if (typeof type !== 'string' || type.length === 0) return undefined;
    return {
      id: nextSyntheticId++,
      v: 1,
      type,
      data: params['data'] ?? params,
      _meta: isRecord(params['_meta']) ? params['_meta'] : undefined,
      originatorClientId:
        typeof params['originatorClientId'] === 'string'
          ? params['originatorClientId']
          : undefined,
    };
  }

  // Workspace events arrive as top-level methods matching the event
  // type name directly (e.g. `memory_changed`, `agent_changed`,
  // `auth_device_flow_started`).
  if (notification.method.includes('_') || notification.method.includes('/')) {
    // Extract the event type: for `namespace/event` use the event
    // part; for `snake_case` names use the full method.
    const type = notification.method.includes('/')
      ? notification.method.split('/').pop()!
      : notification.method;

    return {
      id: nextSyntheticId++,
      v: 1,
      type,
      data: params,
      _meta: isRecord(params['_meta']) ? params['_meta'] : undefined,
      originatorClientId:
        typeof params['originatorClientId'] === 'string'
          ? params['originatorClientId']
          : undefined,
    };
  }

  return undefined;
}

/**
 * Filter a mixed stream of ACP notifications, yielding only
 * `DaemonEvent`s for the specified session. Events without a
 * `sessionId` field in their data are considered workspace-scoped
 * and are always yielded (they fan out to all sessions).
 */
export function* filterEventsBySession(
  events: Iterable<DaemonEvent>,
  sessionId: string,
): Generator<DaemonEvent> {
  for (const event of events) {
    const data = event.data;
    if (isRecord(data)) {
      const eventSessionId = data['sessionId'];
      // If the event has a sessionId, only yield if it matches.
      // Events without sessionId are workspace-scoped and pass through.
      if (
        typeof eventSessionId === 'string' &&
        eventSessionId.length > 0 &&
        eventSessionId !== sessionId
      ) {
        continue;
      }
    }
    yield event;
  }
}

/**
 * Reset the synthetic id counter. Exposed for testing only.
 * @internal
 */
export function _resetSyntheticIdCounter(): void {
  nextSyntheticId = 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
