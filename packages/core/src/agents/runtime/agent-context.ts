/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Per-run AsyncLocalStorage frame for agent execution.
 *
 * Tools capture `this.config` at construction time, so a sub-agent running
 * with a different model cannot rely on the constructor-bound Config to
 * report the right ContentGenerator or modalities. This frame lets
 * `Config.getContentGenerator{,Config}()` resolve to the active sub-agent
 * view, and lets nested `agent` tool launches discover their parent's id —
 * both without threading extra parameters through every call site.
 *
 * Helpers patch one field at a time and merge with whatever is already on
 * the stack, so wrapping at different layers preserves every set field.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../../core/contentGenerator.js';
import { isTeammate } from '../team/identity.js';
import { isInForkExecution } from '../../tools/agent/fork-subagent.js';

export interface RuntimeContentGeneratorView {
  readonly contentGenerator: ContentGenerator;
  readonly contentGeneratorConfig: ContentGeneratorConfig;
}

interface AgentContext {
  readonly agentId?: string;
  readonly runtimeView?: RuntimeContentGeneratorView;
  /**
   * Nesting depth — 0 for a top-level subagent (called from a user's
   * top-level interaction), +1 per nested `runWithAgentContext` frame.
   * Auto-incremented by default; resume paths (background resume,
   * AgentInteractive, deferred approvals) pass `depthOverride` to restore
   * the original launch depth instead. Read via
   * {@link getCurrentAgentDepth} for telemetry (#3731 Phase 3).
   */
  readonly depth?: number;
}

const storage = new AsyncLocalStorage<AgentContext>();

export function runWithAgentContext<T>(
  agentId: string,
  fn: () => Promise<T>,
  depthOverride?: number,
): Promise<T> {
  const current = storage.getStore() ?? {};
  // Auto-increment depth: top-level = 0, nested = parent+1. No caller has
  // to know about it; telemetry reads it back via getCurrentAgentDepth
  // (#3731 Phase 3 subagent spans). depthOverride restores the original
  // launch depth on background/foreground resume — otherwise the frame
  // recomputes from a top-level (depth 0) parent and a resumed nested agent
  // would regain spawn capacity it should not have.
  const depth = depthOverride ?? (current.depth ?? -1) + 1;
  return storage.run({ ...current, agentId, depth }, fn);
}

export function runWithRuntimeContentGenerator<T>(
  view: RuntimeContentGeneratorView,
  fn: () => Promise<T>,
): Promise<T> {
  const current = storage.getStore() ?? {};
  return storage.run({ ...current, runtimeView: view }, fn);
}

/** Consume an async generator with the runtime model view restored per step. */
export async function* wrapAsyncGeneratorWithRuntimeContentGenerator<
  TYield,
  TReturn = void,
>(
  view: RuntimeContentGeneratorView,
  generator: AsyncGenerator<TYield, TReturn>,
): AsyncGenerator<TYield, TReturn> {
  let completed = false;
  try {
    while (true) {
      const next = await runWithRuntimeContentGenerator(view, () =>
        generator.next(),
      );
      if (next.done) {
        completed = true;
        return next.value;
      }
      yield next.value;
    }
  } finally {
    if (!completed) {
      await runWithRuntimeContentGenerator(view, () =>
        generator.return(undefined as TReturn),
      );
    }
  }
}

export function getCurrentAgentId(): string | null {
  return storage.getStore()?.agentId ?? null;
}

/**
 * Returns the depth of the current agent context frame. 0 means we're
 * inside a top-level subagent (or no subagent at all — but in that case
 * the caller won't typically need this). Used by telemetry to populate
 * `qwen-code.subagent.depth` on subagent spans.
 *
 * @remarks Returns 0 for two semantically distinct states: (a) no agent
 * frame exists, and (b) a top-level frame exists with `depth=0`. Callers
 * that need to discriminate MUST first check {@link getCurrentAgentId} —
 * it returns `null` only in state (a). See `runWithSubagentSpan` in
 * `tools/agent/agent.ts` for the canonical disambiguation pattern.
 * Review wenshao @ #4410 (DeepSeek bot 3290820381).
 */
export function getCurrentAgentDepth(): number {
  return storage.getStore()?.depth ?? 0;
}

export function getRuntimeContentGenerator():
  | RuntimeContentGeneratorView
  | undefined {
  return storage.getStore()?.runtimeView;
}

/**
 * True when there is no active agent frame — i.e. we are in the top-level
 * user session, not inside a sub-agent. The canonical "top-level only"
 * predicate for gating capabilities (teammate spawning, forking) that must
 * not be reachable from a nested sub-agent.
 */
export function isTopLevelSession(): boolean {
  return getCurrentAgentId() === null;
}

/**
 * The 0-based depth a child spawned by the current invoker would have:
 * 0 when spawning from the top-level session (no agent frame), parent
 * depth + 1 inside a sub-agent frame. Single source of the launch-depth
 * formula — used for subagent telemetry spans, persisted in AgentMeta so
 * background/foreground resume can restore the original nesting level (via
 * the runWithAgentContext depthOverride), and underlying
 * {@link canSpawnNestedAgent}.
 */
export function childLaunchDepth(): number {
  return getCurrentAgentId() !== null ? getCurrentAgentDepth() + 1 : 0;
}

/**
 * Whether the current invoker may spawn a nested sub-agent given the
 * configured maximum nesting depth (1-based levels; a top-level sub-agent is
 * level 1). Single source of truth for the depth relationship, shared by
 * AgentCore.prepareTools() (schema gating) and AgentTool.execute() (runtime
 * guard) so the two cannot drift apart.
 *
 * The would-be child sits at level `childLaunchDepth() + 1` (levels are
 * 1-based, depths 0-based), which must not exceed `maxDepth`.
 */
export function canSpawnNestedAgent(maxDepth: number): boolean {
  return childLaunchDepth() + 1 <= maxDepth;
}

/**
 * Single source of the sub-agent spawn exclusion policy, shared by
 * `AgentCore.prepareTools()` (schema gating) and `AgentTool.execute()`
 * (runtime guards) so the two layers cannot drift: a rule missed on the
 * runtime side is a silent spawn bypass, missed on the schema side it burns
 * model turns on guaranteed-rejected calls.
 *
 * Returns the first blocking reason — evaluated in `execute()`'s guard
 * order, so the winning reason (and its user-facing message) is stable for
 * contexts that trip several rules (e.g. a teammate at leaf depth) — or
 * null when a spawn is permitted. All four inputs are pure
 * AsyncLocalStorage reads, so the composition is order-insensitive for the
 * schema side's boolean use.
 *
 * Callers gate on different frame requirements on top of this:
 * `prepareTools()` adds `!isTopLevelSession()` to fail closed on a missing
 * agent frame (it only ever serves agents), while `execute()` must allow
 * the top-level session — that is the normal spawn path.
 */
export function spawnBlockReason(
  maxDepth: number,
): 'depth' | 'teammate' | 'fork' | null {
  if (!canSpawnNestedAgent(maxDepth)) return 'depth';
  if (isTeammate()) return 'teammate';
  if (isInForkExecution()) return 'fork';
  return null;
}
