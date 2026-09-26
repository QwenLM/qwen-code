/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ManagedChildExecutionScope } from '../tools/managed-tool-session.js';
import type { AgentHeadless } from './runtime/agent-headless.js';

export function bindManagedChildExecution(
  agent: Pick<AgentHeadless, 'execute'>,
  scope: ManagedChildExecutionScope,
): void {
  if (!scope.signal) return;
  const scopeSignal = scope.signal;
  const execute = agent.execute.bind(agent);
  // executeExternalInputs delegates to execute, as do StopHook continuations.
  agent.execute = (context, signal, options) =>
    scope.run(() =>
      execute(
        context,
        signal ? AbortSignal.any([signal, scopeSignal]) : scopeSignal,
        options,
      ),
    );
}

export function createManagedChildCleanup(
  scope: ManagedChildExecutionScope,
  cleanup: () => void | Promise<void>,
): () => Promise<void> {
  scope.onClose(cleanup);
  return () => (scope.signal ? scope.close() : Promise.resolve(cleanup()));
}
