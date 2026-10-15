/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Config } from '../config/config.js';
import { getCurrentAgentId } from '../agents/runtime/agent-context.js';
import { getInvocationContext } from '../utils/invocation-context.js';

export interface HookExecutionOwner {
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly agentId: string | null;
}

const storage = new AsyncLocalStorage<HookExecutionOwner | undefined>();

export function getHookExecutionOwner(): HookExecutionOwner | undefined {
  return storage.getStore();
}

export function runWithHookExecutionOwner<T>(
  owner: HookExecutionOwner | undefined,
  fn: () => T,
): T {
  return storage.run(owner, fn);
}

export function runOutsideHookExecutionOwner<T>(fn: () => T): T {
  return storage.exit(fn);
}

export function resolveHookExecutionOwner(
  runtimeId: string,
  sessionId: string,
  agentId?: string | null,
): HookExecutionOwner {
  const inherited = storage.getStore();
  if (agentId === undefined && inherited) return inherited;
  return Object.freeze({
    runtimeId,
    sessionId: getInvocationContext()?.sessionId ?? sessionId,
    agentId: agentId === undefined ? getCurrentAgentId() : agentId,
  });
}

export function captureHookExecutionOwner(
  config: Config,
  agentId?: string | null,
): HookExecutionOwner | undefined {
  const hookSystem = config.getHookSystem?.();
  return hookSystem
    ? resolveHookExecutionOwner(
        hookSystem.runtimeId,
        config.getSessionId(),
        agentId,
      )
    : undefined;
}

export function assertHookExecutionOwner(
  owner: HookExecutionOwner | undefined,
  runtimeId: string,
  sessionId: string,
): asserts owner is HookExecutionOwner {
  if (
    !owner ||
    typeof owner.runtimeId !== 'string' ||
    owner.runtimeId.trim() === '' ||
    typeof owner.sessionId !== 'string' ||
    owner.sessionId.trim() === '' ||
    owner.runtimeId !== runtimeId ||
    owner.sessionId !== sessionId ||
    (owner.agentId !== null &&
      (typeof owner.agentId !== 'string' || owner.agentId.trim() === ''))
  ) {
    throw new Error('Hook execution owner does not match this runtime/session');
  }
}
