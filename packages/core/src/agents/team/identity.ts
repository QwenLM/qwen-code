/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview AsyncLocalStorage-based teammate identity.
 *
 * Provides per-async-context identity for in-process teammates so that
 * tools (SendMessage, TaskUpdate, etc.) can determine which agent is
 * calling them without passing identity through every function signature.
 *
 * Resolution order: AsyncLocalStorage context (in-process) → consumed
 * subprocess identity → undefined.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { TeammateIdentity } from './types.js';

export const TEAMMATE_IDENTITY_ENV = 'QWEN_CODE_TEAMMATE_IDENTITY';

let subprocessTeammateIdentity: TeammateIdentity | undefined;

/**
 * Per-async-context store for teammate identity.
 * Set by TeamManager when running an in-process teammate's code.
 */
export const teammateIdentityStore = new AsyncLocalStorage<TeammateIdentity>();

export function createTeammateIdentityEnv(
  identity: TeammateIdentity,
): NodeJS.ProcessEnv {
  return { [TEAMMATE_IDENTITY_ENV]: JSON.stringify(identity) };
}

/**
 * Consume the private worker bootstrap payload. The environment entry is
 * removed before parsing so malformed input cannot leak to child processes.
 */
export function consumeTeammateIdentityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TeammateIdentity | undefined {
  const payload = env[TEAMMATE_IDENTITY_ENV];
  delete env[TEAMMATE_IDENTITY_ENV];
  if (payload === undefined) return undefined;

  const identity = JSON.parse(payload) as unknown;
  if (!isValidTeammateIdentity(identity)) {
    throw new Error(`Invalid ${TEAMMATE_IDENTITY_ENV} payload.`);
  }
  subprocessTeammateIdentity = identity;
  return identity;
}

/**
 * Get the current teammate identity, or undefined if not in a
 * teammate context.
 */
export function getTeammateContext(): TeammateIdentity | undefined {
  return teammateIdentityStore.getStore() ?? subprocessTeammateIdentity;
}

/**
 * Whether the current context is an in-process teammate.
 */
export function isInProcessTeammate(): boolean {
  return teammateIdentityStore.getStore() !== undefined;
}

/**
 * Get the current agent name, or undefined.
 */
export function getAgentName(): string | undefined {
  return getTeammateContext()?.agentName;
}

/**
 * Get the current team name, or undefined.
 */
export function getTeamName(): string | undefined {
  return getTeammateContext()?.teamName;
}

/**
 * Resolve the active team name: teammate identity first (when running
 * inside a teammate's async context), then fall back to the leader's
 * team context.
 */
export function resolveActiveTeamName(
  fallback: string | undefined,
): string | undefined {
  return getTeamName() ?? fallback;
}

/**
 * Whether the current process or async context is a teammate.
 */
export function isTeammate(): boolean {
  return getTeammateContext() !== undefined;
}

/**
 * Whether the current context is the team leader.
 */
export function isTeamLead(): boolean {
  return getTeammateContext()?.isTeamLead ?? false;
}

/**
 * Get the current teammate's assigned color, or undefined.
 */
export function getTeammateColor(): string | undefined {
  return getTeammateContext()?.color;
}

/**
 * Run a function within a teammate identity context.
 * Used by TeamManager when executing in-process teammate code.
 */
export function runWithTeammateIdentity<T>(
  identity: TeammateIdentity,
  fn: () => T,
): T {
  return teammateIdentityStore.run(identity, fn);
}

function isValidTeammateIdentity(
  value: unknown,
): value is TeammateIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity['agentId'] === 'string' &&
    identity['agentId'].length > 0 &&
    typeof identity['agentName'] === 'string' &&
    identity['agentName'].length > 0 &&
    typeof identity['teamName'] === 'string' &&
    identity['teamName'].length > 0 &&
    typeof identity['isTeamLead'] === 'boolean' &&
    (identity['color'] === undefined ||
      typeof identity['color'] === 'string') &&
    (identity['planModeRequired'] === undefined ||
      typeof identity['planModeRequired'] === 'boolean') &&
    (identity['parentSessionId'] === undefined ||
      typeof identity['parentSessionId'] === 'string')
  );
}
