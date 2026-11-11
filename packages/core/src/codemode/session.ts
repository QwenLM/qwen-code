/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ActiveConversation } from '../config/config.js';
import type { QueryLifecycle } from '../tools/tool-types.js';
import { CodeModeCell } from './cells.js';
import { restoreStore, type CodeModeStore } from './store.js';

interface StoreSlot {
  conversation?: ActiveConversation;
  revision?: number;
  /** A failed read is retried by the next script. */
  stale: boolean;
  store: Promise<CodeModeStore>;
}

interface AgentState {
  cell?: CodeModeCell;
  store?: StoreSlot;
}

interface SessionState {
  sessionId: string;
  agents: Map<string, AgentState>;
}

/** Keyed by the owning Config; a different session ID replaces all state. */
const sessions = new WeakMap<object, SessionState>();

function sessionOf(owner: object, sessionId: string): SessionState {
  let state = sessions.get(owner);
  if (state?.sessionId !== sessionId) {
    if (state) void retireCells(state);
    state = { sessionId, agents: new Map() };
    sessions.set(owner, state);
  }
  return state;
}

function agentOf(state: SessionState, agentId?: string): AgentState {
  const key = agentId ?? '';
  let agent = state.agents.get(key);
  if (!agent) state.agents.set(key, (agent = {}));
  return agent;
}

function retireCells(state: SessionState): Promise<void[]> {
  return Promise.all(
    [...state.agents.values()].flatMap((agent) =>
      agent.cell ? [agent.cell.retire()] : [],
    ),
  );
}

export function getCodeModeCell(
  owner: object,
  sessionId: string,
  agentId?: string,
): CodeModeCell | undefined {
  const state = sessions.get(owner);
  return state?.sessionId === sessionId
    ? state.agents.get(agentId ?? '')?.cell
    : undefined;
}

export function createCodeModeCell(
  owner: object,
  sessionId: string,
  agentId: string | undefined,
  lifecycle: QueryLifecycle,
): CodeModeCell {
  const agent = agentOf(sessionOf(owner, sessionId), agentId);
  if (agent.cell)
    throw new Error(
      'A CodeMode cell already exists for this agent. Wait for or cancel it before starting another script.',
    );
  const cell: CodeModeCell = new CodeModeCell(lifecycle, () => {
    if (agent.cell === cell) agent.cell = undefined;
  });
  agent.cell = cell;
  return cell;
}

/**
 * One store per session and agent; new sessions on the same owner start empty.
 * Only the main agent (no agentId) is restored from `conversation`, and it
 * reloads whenever the conversation revision changes. Subagent state is
 * process-local.
 */
export async function loadStore(
  owner: object,
  sessionId: string,
  agentId?: string,
  conversation?: ActiveConversation,
  signal?: AbortSignal,
): Promise<CodeModeStore> {
  signal?.throwIfAborted();
  const agent = agentOf(sessionOf(owner, sessionId), agentId);
  const durable = agentId === undefined ? conversation : undefined;
  const revision = durable?.revision();
  const current = agent.store;
  if (
    current &&
    !current.stale &&
    current.conversation === durable &&
    current.revision === revision
  )
    return current.store;
  const slot: StoreSlot = {
    conversation: durable,
    revision,
    stale: false,
    store: restoreStore(durable, signal).catch((error: unknown) => {
      // A cancelled read must not leave the next cell waiting on the same I/O.
      slot.stale = true;
      throw error;
    }),
  };
  agent.store = slot;
  return slot.store;
}

/** Session disposal/reset cancels live cells and drops every store. */
export async function resetCodeModeSession(owner: object): Promise<void> {
  const state = sessions.get(owner);
  sessions.delete(owner);
  if (state) await retireCells(state);
}
