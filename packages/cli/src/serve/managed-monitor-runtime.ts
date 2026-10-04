/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MANAGED_MONITOR_ROUTE,
  monitorUnitNameOf,
  type ManagedMonitorOperationView,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-monitor-protocol.js';
import type { ManagedMonitorRegistry } from './managed-monitor-registry.js';

// H3 of #12827: the worker-side answerer of the monitor maintenance route,
// mirroring the shell route's discipline: status reports what the registry
// itself physically knows (running, or what it retained after a proven
// end), and stop terminates with the same evidence rules — an end it
// cannot prove is `unknown`, never a claimed exit.

export class ManagedMonitorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ManagedMonitorError';
  }
}

interface ParsedOperation {
  readonly kind: 'monitor-status' | 'monitor-stop';
  readonly operationId: string;
  readonly targetOperationId: string;
}

const KEYS = ['kind', 'operationId', 'sessionKey', 'targetOperationId'];

function parseOperation(value: unknown): ParsedOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManagedMonitorError(
      'managed_monitor_invalid',
      'Monitor operation is invalid.',
    );
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join(',') !== [...KEYS].sort().join(',')) {
    throw new ManagedMonitorError(
      'managed_monitor_invalid',
      'Monitor operation is invalid.',
    );
  }
  const kind = object['kind'];
  if (kind !== 'monitor-status' && kind !== 'monitor-stop') {
    throw new ManagedMonitorError(
      'managed_monitor_invalid',
      'Monitor operation is invalid.',
    );
  }
  const sessionKey = object['sessionKey'];
  if (
    !sessionKey ||
    typeof sessionKey !== 'object' ||
    typeof (sessionKey as Record<string, unknown>)['tenantId'] !== 'string' ||
    typeof (sessionKey as Record<string, unknown>)['sessionId'] !== 'string'
  ) {
    throw new ManagedMonitorError(
      'managed_monitor_invalid',
      'Monitor operation scope is invalid.',
    );
  }
  for (const key of ['operationId', 'targetOperationId'] as const) {
    const field = object[key];
    if (typeof field !== 'string' || !field || field.length > 512) {
      throw new ManagedMonitorError(
        'managed_monitor_invalid',
        `Monitor operation ${key} is invalid.`,
      );
    }
  }
  return {
    kind,
    operationId: object['operationId'] as string,
    targetOperationId: object['targetOperationId'] as string,
  };
}

export class ManagedMonitorRuntime {
  constructor(private readonly registry: ManagedMonitorRegistry) {}

  async control(
    runtimeSessionId: string,
    value: unknown,
  ): Promise<ManagedMonitorOperationView> {
    const operation = parseOperation(value);
    const unitName = monitorUnitNameOf(operation.targetOperationId);
    const registered = this.registry.describe(unitName);
    if (registered && registered.sessionId === runtimeSessionId) {
      if (operation.kind === 'monitor-status') {
        return {
          operationId: operation.targetOperationId,
          state: 'running',
          unitName,
        };
      }
      const receipt = await this.registry.terminate(unitName, 5_000);
      if (!receipt || receipt.evidence === null) {
        return { operationId: operation.targetOperationId, state: 'unknown' };
      }
      return {
        operationId: operation.targetOperationId,
        state: 'exited',
        unitName,
        evidence: receipt.evidence,
      };
    }
    const finished = this.registry.describeFinished(unitName);
    if (
      finished &&
      finished.sessionId === runtimeSessionId &&
      finished.receipt.evidence !== null
    ) {
      // A watch that ended on this worker answers from its retained
      // receipt, for status and stop alike: both are idempotent.
      return {
        operationId: operation.targetOperationId,
        state: 'exited',
        unitName,
        evidence: finished.receipt.evidence,
      };
    }
    return { operationId: operation.targetOperationId, state: 'unknown' };
  }
}

export { MANAGED_MONITOR_ROUTE };
