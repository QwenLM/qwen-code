/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'cancelled';

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
}
