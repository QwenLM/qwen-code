/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The ambient binding a agent turn executes under.
 *
 * A workspace agent is one long-lived body that works many threads in sequence, so
 * "which thread is this?" cannot come from the model and cannot come from a
 * process-global register that async work would leak across. It comes from an
 * `AsyncLocalStorage` frame established at the per-turn seam — the same place
 * `runWithAgentContext` is established inside `runBackgroundTurn`, which the
 * resident continuation re-enters for every turn.
 *
 * Wrapping the *lifetime* launch once would bind the body to its first thread
 * forever; that is the failure this module exists to make impossible.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** The triple every mutating agent tool trusts, plus what the prompt stamps. */
export interface AgentRunContext {
  workspaceId: string;
  /** `WorkspaceAgent.id`, not the background-agent id. */
  agentId: string;
  runId: string;
  threadId: string;
  /** Budget root of the thread tree; carried so tools need no second read. */
  rootThreadId: string;
  /** 1 for the first execution of this run; higher after a revive. */
  attempt: number;
  /** Last thread message included in this turn's delivery. */
  contextThroughSequence?: number;
}

const store = new AsyncLocalStorage<AgentRunContext>();

function sameRun(a: AgentRunContext, b: AgentRunContext): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.agentId === b.agentId &&
    a.runId === b.runId &&
    a.threadId === b.threadId &&
    a.rootThreadId === b.rootThreadId &&
    a.attempt === b.attempt
  );
}

/**
 * Runs `fn` bound to one agent run.
 *
 * Re-entering with the identical context is allowed (a turn seam may be
 * reached through more than one wrapper). Nesting a *different* run throws:
 * that can only mean a frame was established at the wrong level, and silently
 * shadowing it is how a body posts one thread's conclusion into another.
 */
export function runWithAgentRunContext<T>(
  context: AgentRunContext,
  fn: () => T,
): T {
  const current = store.getStore();
  if (current && !sameRun(current, context)) {
    throw new Error(
      `Refusing to nest agent run ${context.runId} (thread ${context.threadId}) ` +
        `inside run ${current.runId} (thread ${current.threadId}). ` +
        `Establish the run frame at the per-turn seam, not around a lifetime.`,
    );
  }
  return store.run(context, fn);
}

/** The current agent run, or `undefined` outside a agent turn. */
export function getAgentRunContext(): AgentRunContext | undefined {
  return store.getStore();
}

/** True inside a agent turn. Ordinary subagents and the user session are not. */
export function isAgentRun(): boolean {
  return store.getStore() !== undefined;
}

/**
 * The current agent run, or a typed failure naming the tool.
 *
 * A agent tool reaching this without a frame is a wiring bug, not model input:
 * failing loudly beats acting on a guess about which thread was meant.
 */
export function requireAgentRunContext(toolName: string): AgentRunContext {
  const context = store.getStore();
  if (!context) {
    throw new Error(
      `${toolName} requires an active agent run context; none is bound to this turn.`,
    );
  }
  return context;
}
