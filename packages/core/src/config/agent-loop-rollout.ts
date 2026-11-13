/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('AGENT_LOOP');

/**
 * The loop entry points whose model rounds and tool batches the shared
 * agent loop can run. Each surface resolves the loop switches on its own
 * so the rollout can open one surface at a time (#17045).
 */
export type AgentLoopSurface =
  | 'headless'
  | 'acp'
  | 'ink'
  | 'opentui'
  | 'agent-core'
  | 'speculation';

export const AGENT_LOOP_SURFACES: readonly AgentLoopSurface[] = [
  'headless',
  'acp',
  'ink',
  'opentui',
  'agent-core',
  'speculation',
];

// Each switch has its own default table so a rollout flip of the unified
// default for one surface cannot also flip the event-bus default. A rollout
// PR flips one entry of one table at a time; until then every surface stays
// on its legacy loop unless the setting or the environment says otherwise.
export const UNIFIED_SURFACE_DEFAULTS: Record<AgentLoopSurface, boolean> = {
  headless: false,
  acp: false,
  ink: false,
  opentui: false,
  'agent-core': false,
  speculation: false,
};

export const EVENT_BUS_SURFACE_DEFAULTS: Record<AgentLoopSurface, boolean> = {
  headless: false,
  acp: false,
  ink: false,
  opentui: false,
  'agent-core': false,
  speculation: false,
};

function isSurface(name: string): name is AgentLoopSurface {
  return (AGENT_LOOP_SURFACES as readonly string[]).includes(name);
}

// The env value cannot change during a process, but the resolver runs on every
// model round / tool batch; warn once per distinct token so a typo does not
// append one identical line per round to the debug log.
const warnedTokens = new Set<string>();

/** Test hook: forget which tokens have already been warned about. */
export function resetAgentLoopEnvWarnings(): void {
  warnedTokens.clear();
}

function warnOnce(entry: string, message: string): void {
  if (warnedTokens.has(entry)) return;
  warnedTokens.add(entry);
  debugLogger.warn(message);
}

/**
 * Parses a loop-switch environment variable for one surface. `1` and `0`
 * force every surface on or off; a comma-separated list of
 * `<surface>[=0|=1]` tokens forces the named surfaces and leaves the rest
 * to the setting and the built-in default. Unknown or malformed tokens are
 * ignored, so a list written for a newer CLI cannot break an older one.
 */
export function resolveAgentLoopEnvOverride(
  value: string | undefined,
  surface: AgentLoopSurface,
): boolean | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed === '1') return true;
  if (trimmed === '0') return false;
  for (const token of trimmed.split(',')) {
    const entry = token.trim();
    if (entry === '') continue;
    const eq = entry.indexOf('=');
    const name = eq === -1 ? entry : entry.slice(0, eq).trim();
    const flag = eq === -1 ? '1' : entry.slice(eq + 1).trim();
    if (!isSurface(name)) {
      warnOnce(entry, `ignoring unknown agent-loop surface token: ${entry}`);
      continue;
    }
    if (name !== surface) continue;
    if (flag === '1') return true;
    if (flag === '0') return false;
    // Skip only the unparseable token; a later well-formed token for the same
    // surface still applies, and a lone malformed token leaves the surface to
    // the setting/default. The first well-formed token wins.
    warnOnce(entry, `ignoring malformed agent-loop token: ${entry}`);
    continue;
  }
  return undefined;
}

/**
 * Resolves one loop switch for one surface: the environment override when
 * it addresses the surface, else the explicit setting when set, else the
 * surface's built-in default for that switch. The caller supplies the
 * per-switch default so the two switches cannot share a fallback table.
 */
export function resolveAgentLoopSwitch(options: {
  env: string | undefined;
  setting: boolean | undefined;
  surface: AgentLoopSurface;
  surfaceDefault: boolean;
}): boolean {
  const override = resolveAgentLoopEnvOverride(options.env, options.surface);
  if (override !== undefined) return override;
  if (options.setting !== undefined) return options.setting;
  return options.surfaceDefault;
}
