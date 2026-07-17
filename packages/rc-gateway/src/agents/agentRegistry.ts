/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Max stored task length (design: "spawning prompt, truncated to 2k chars"). */
const TASK_MAX_CHARS = 2000;

export type AgentStatus =
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned';

/** Statuses a record can never leave. `setStatus` refuses transitions out. */
export const TERMINAL_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'orphaned',
]);

/**
 * One background agent, backed 1:1 by a daemon session (design: approach B,
 * agents-as-sessions). Shape mirrors the approved design doc exactly.
 */
export interface AgentRecord {
  agentId: string; // uuid
  sessionId: string; // the daemon session backing this agent
  parentSessionId: string | null;
  agentType: string; // 'general' | subagent-manager name
  task: string; // spawning prompt, truncated to 2k chars
  status: AgentStatus;
  spawnedByTokenId: string;
  subActor?: string; // if spawned via a bridge
  spawnedAt: string;
  finishedAt: string | null;
  workflowRunId?: string; // set when this agent backs a workflow run
}

interface PersistShape {
  agents: AgentRecord[];
}

/**
 * Persisted agent registry — JSON file store, same pattern as TokenStore
 * (tokenStore.ts): private constructor, `open()` reads-or-starts-empty,
 * every mutation awaits `persist()` (0600 file inside an ensured dir).
 * Cost is deliberately NOT stored here — it is computed at read time from
 * the cost tables keyed by sessionId (one source of truth).
 */
export class AgentRegistry {
  private constructor(
    private readonly filePath: string,
    private records: AgentRecord[],
    private readonly nowFn: () => number,
  ) {}

  static async open(
    filePath: string,
    nowFn: () => number = Date.now,
  ): Promise<AgentRegistry> {
    let records: AgentRecord[] = [];
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistShape;
      if (Array.isArray(parsed.agents)) records = parsed.agents;
    } catch {
      // Missing/corrupt file → start empty. First register() persists it.
    }
    return new AgentRegistry(filePath, records, nowFn);
  }

  async register(input: {
    sessionId: string;
    parentSessionId: string | null;
    agentType: string;
    task: string;
    spawnedByTokenId: string;
    subActor?: string;
    workflowRunId?: string;
  }): Promise<AgentRecord> {
    const rec: AgentRecord = {
      agentId: randomUUID(),
      sessionId: input.sessionId,
      parentSessionId: input.parentSessionId,
      agentType: input.agentType,
      task: input.task.slice(0, TASK_MAX_CHARS),
      status: 'running',
      spawnedByTokenId: input.spawnedByTokenId,
      ...(input.subActor !== undefined ? { subActor: input.subActor } : {}),
      ...(input.workflowRunId !== undefined
        ? { workflowRunId: input.workflowRunId }
        : {}),
      spawnedAt: new Date(this.nowFn()).toISOString(),
      finishedAt: null,
    };
    this.records.push(rec);
    await this.persist();
    return { ...rec };
  }

  get(agentId: string): AgentRecord | undefined {
    const rec = this.records.find((r) => r.agentId === agentId);
    return rec ? { ...rec } : undefined;
  }

  /**
   * The record backing `sessionId`. When a session id was reused (an earlier
   * agent on it already terminal), the non-terminal record wins so lifecycle
   * events land on the live agent.
   */
  findBySessionId(sessionId: string): AgentRecord | undefined {
    const matches = this.records.filter((r) => r.sessionId === sessionId);
    const live = matches.find((r) => !TERMINAL_AGENT_STATUSES.has(r.status));
    const rec = live ?? matches[matches.length - 1];
    return rec ? { ...rec } : undefined;
  }

  list(
    filter: {
      status?: AgentStatus;
      parent?: string;
      workflowRunId?: string;
    } = {},
  ): AgentRecord[] {
    return this.records
      .filter(
        (r) =>
          (filter.status === undefined || r.status === filter.status) &&
          (filter.parent === undefined ||
            r.parentSessionId === filter.parent) &&
          (filter.workflowRunId === undefined ||
            r.workflowRunId === filter.workflowRunId),
      )
      .map((r) => ({ ...r }));
  }

  /**
   * Transition a record's status. Returns false (and changes nothing) when
   * the id is unknown OR the record is already terminal — so a cancelled
   * agent's late `session_died` can never flip it to `failed`, and callers
   * can gate frame emission on the return value. Stamps `finishedAt` when
   * entering a terminal status.
   */
  async setStatus(agentId: string, status: AgentStatus): Promise<boolean> {
    const rec = this.records.find((r) => r.agentId === agentId);
    if (!rec || TERMINAL_AGENT_STATUSES.has(rec.status)) return false;
    rec.status = status;
    if (TERMINAL_AGENT_STATUSES.has(status)) {
      rec.finishedAt = new Date(this.nowFn()).toISOString();
    }
    await this.persist();
    return true;
  }

  /**
   * Startup reconciliation (design: "Reconciliation"): every `running` or
   * `blocked` record whose session is NOT in `liveSessionIds` becomes
   * `orphaned` (surfaced in GET /rc/agents, never silently dropped).
   * Returns the orphaned agent ids. Single persist after all stamps.
   */
  async reconcile(liveSessionIds: readonly string[]): Promise<string[]> {
    const live = new Set(liveSessionIds);
    const orphaned: string[] = [];
    const finishedAt = new Date(this.nowFn()).toISOString();
    for (const rec of this.records) {
      if (TERMINAL_AGENT_STATUSES.has(rec.status)) continue;
      if (live.has(rec.sessionId)) continue;
      rec.status = 'orphaned';
      rec.finishedAt = finishedAt;
      orphaned.push(rec.agentId);
    }
    if (orphaned.length > 0) await this.persist();
    return orphaned;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const body: PersistShape = { agents: this.records };
    await writeFile(this.filePath, JSON.stringify(body, null, 2), {
      mode: 0o600,
    });
  }
}
