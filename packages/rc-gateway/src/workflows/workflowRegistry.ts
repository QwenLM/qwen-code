/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type WorkflowStatus =
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';

const TERMINAL: ReadonlySet<WorkflowStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

export interface WorkflowRun {
  runId: string;
  name: string;
  scriptHash: string;
  status: WorkflowStatus;
  phase?: string;
  phaseIndex?: number;
  agents: Array<{ agentId: string; sessionId: string }>;
  tokensSpent: number;
  startedAt: string;
  finishedAt: string | null;
  controller: AbortController;
}

/** In-memory registry of live/terminal workflow runs (journal on disk backs
 * resume; this tracks the observable run state for the gateway endpoints). */
export class WorkflowRunRegistry {
  private readonly runs = new Map<string, WorkflowRun>();

  create(input: {
    runId: string;
    name: string;
    scriptHash: string;
  }): WorkflowRun {
    const run: WorkflowRun = {
      runId: input.runId,
      name: input.name,
      scriptHash: input.scriptHash,
      status: 'running',
      agents: [],
      tokensSpent: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      controller: new AbortController(),
    };
    this.runs.set(run.runId, run);
    return run;
  }

  get(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  list(): WorkflowRun[] {
    return [...this.runs.values()];
  }

  setPhase(runId: string, phase: string, phaseIndex: number): void {
    const run = this.runs.get(runId);
    if (run) {
      run.phase = phase;
      run.phaseIndex = phaseIndex;
    }
  }

  addAgent(runId: string, agentId: string, sessionId: string): void {
    this.runs.get(runId)?.agents.push({ agentId, sessionId });
  }

  setTokens(runId: string, tokensSpent: number): void {
    const run = this.runs.get(runId);
    if (run) run.tokensSpent = tokensSpent;
  }

  setStatus(runId: string, status: WorkflowStatus): boolean {
    const run = this.runs.get(runId);
    if (!run || TERMINAL.has(run.status)) return false;
    run.status = status;
    if (TERMINAL.has(status)) run.finishedAt = new Date().toISOString();
    return true;
  }

  isTerminal(runId: string): boolean {
    const run = this.runs.get(runId);
    return !run || TERMINAL.has(run.status);
  }

  /**
   * Atomic CAS: only a run whose status is currently exactly 'running' can
   * begin cancelling. Returns whether THIS caller won the transition, so
   * concurrent/late `POST .../cancel` calls within the drain window (the run
   * only reaches the terminal 'cancelled' status later, once the background
   * finish() runs after in-flight sessions drain) can gate abort()/audit/SSE
   * on the return value — mirroring agentRegistry.setStatus's CAS pattern.
   * A run already 'cancelling' or terminal loses (returns false); the
   * background finish() path is the only place that ever reaches 'cancelled'.
   */
  beginCancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running') return false;
    run.status = 'cancelling';
    return true;
  }
}
