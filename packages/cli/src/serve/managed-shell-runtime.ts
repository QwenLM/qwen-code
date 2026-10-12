/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MANAGED_SHELL_ROUTE,
  shellUnitNameOf,
  type ManagedShellOperationView,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-shell-protocol.js';
import type { ManagedBackgroundShellRegistry } from './managed-background-shell-registry.js';

// H3 of #12827: the worker-side answerer of the shell maintenance route.
// It is deliberately narrow: status reports what the registry itself
// physically knows (running, or what it retained after a proven end),
// and terminate drains with the same evidence rules as the supervisor —
// an end it cannot prove is `unknown`, never a claimed exit.

export class ManagedShellError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ManagedShellError';
  }
}

interface ParsedOperation {
  readonly kind: 'shell-status' | 'shell-terminate';
  readonly operationId: string;
  readonly targetOperationId: string;
}

const KEYS = ['kind', 'operationId', 'sessionKey', 'targetOperationId'];

function parseOperation(value: unknown): ParsedOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManagedShellError(
      'managed_shell_invalid',
      'Shell operation is invalid.',
    );
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join(',') !== [...KEYS].sort().join(',')) {
    throw new ManagedShellError(
      'managed_shell_invalid',
      'Shell operation is invalid.',
    );
  }
  const kind = object['kind'];
  if (kind !== 'shell-status' && kind !== 'shell-terminate') {
    throw new ManagedShellError(
      'managed_shell_invalid',
      'Shell operation is invalid.',
    );
  }
  const sessionKey = object['sessionKey'];
  if (
    !sessionKey ||
    typeof sessionKey !== 'object' ||
    typeof (sessionKey as Record<string, unknown>)['tenantId'] !== 'string' ||
    typeof (sessionKey as Record<string, unknown>)['sessionId'] !== 'string'
  ) {
    throw new ManagedShellError(
      'managed_shell_invalid',
      'Shell operation scope is invalid.',
    );
  }
  for (const key of ['operationId', 'targetOperationId'] as const) {
    const field = object[key];
    if (typeof field !== 'string' || !field || field.length > 512) {
      throw new ManagedShellError(
        'managed_shell_invalid',
        `Shell operation ${key} is invalid.`,
      );
    }
  }
  return {
    kind,
    operationId: object['operationId'] as string,
    targetOperationId: object['targetOperationId'] as string,
  };
}

export class ManagedShellRuntime {
  constructor(private readonly registry: ManagedBackgroundShellRegistry) {}

  async control(
    runtimeSessionId: string,
    value: unknown,
  ): Promise<ManagedShellOperationView> {
    const operation = parseOperation(value);
    const unitName = shellUnitNameOf(operation.targetOperationId);
    const registered = this.registry.describe(unitName);
    if (registered && registered.sessionId === runtimeSessionId) {
      if (operation.kind === 'shell-status') {
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
      // A Shell that ended on this worker answers from its retained
      // receipt, for status and terminate alike: both are idempotent.
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

export { MANAGED_SHELL_ROUTE };
