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
 * Resolution order: AsyncLocalStorage context (in-process) → undefined.
 * Phase 2 will add dynamic team context for pane-based teammates.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { TeammateIdentity } from './types.js';

/**
 * Per-async-context store for teammate identity.
 * Set by TeamManager when running an in-process teammate's code.
 */
export const teammateIdentityStore = new AsyncLocalStorage<TeammateIdentity>();

/**
 * Get the current teammate identity, or undefined if not in a
 * teammate context.
 */
export function getTeammateContext(): TeammateIdentity | undefined {
  return teammateIdentityStore.getStore();
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
  return teammateIdentityStore.getStore()?.agentName;
}

/**
 * Get the current team name, or undefined.
 */
export function getTeamName(): string | undefined {
  return teammateIdentityStore.getStore()?.teamName;
}

/**
 * Whether the current context is any teammate (leader or worker).
 * Alias for `isInProcessTeammate()`.
 */
export const isTeammate = isInProcessTeammate;

/**
 * Whether the current context is the team leader.
 */
export function isTeamLead(): boolean {
  return teammateIdentityStore.getStore()?.isTeamLead ?? false;
}

/**
 * Get the current teammate's assigned color, or undefined.
 */
export function getTeammateColor(): string | undefined {
  return teammateIdentityStore.getStore()?.color;
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
