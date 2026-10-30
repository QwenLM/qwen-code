/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildWorkflowSteeringNotice,
  type WorkflowContext,
  type WorkflowIntent,
} from './workflow-intent.js';

export interface WorkflowModeState {
  readonly requested: boolean;
  readonly available: boolean;
  readonly effective: boolean;
  readonly reason?: string;
}

export interface PreparedWorkflowMode {
  readonly reminder?: string;
  readonly onModelRequestDispatched?: () => void;
}

export interface WorkflowModeSnapshot {
  readonly requested: boolean;
  readonly recorded: boolean;
  readonly pending: boolean;
  readonly announced?: boolean;
  readonly turns: number;
  readonly available?: boolean;
}

function envelope(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

function keywordText(keyword: WorkflowIntent): string {
  return keyword.reminder
    .replace(/^<system-reminder>\n/, '')
    .replace(/\n<\/system-reminder>$/, '');
}

/** Volatile state belongs to one canonical Config, never a derived agent. */
export class WorkflowModeContext {
  private requested = false;
  private recorded = false;
  private pending = false;
  private announced: boolean | undefined;
  private turns = 0;
  private available: boolean | undefined;
  private revision = 0;

  getRequested(): boolean {
    return this.requested;
  }

  hasRecord(): boolean {
    return this.recorded;
  }

  hasContext(): boolean {
    return this.requested || this.pending;
  }

  snapshot(): WorkflowModeSnapshot {
    return {
      requested: this.requested,
      recorded: this.recorded,
      pending: this.pending,
      announced: this.announced,
      turns: this.turns,
      available: this.available,
    };
  }

  restore(enabled?: boolean): void {
    this.restoreSnapshot({
      requested: enabled ?? false,
      recorded: enabled !== undefined,
      pending: enabled !== undefined,
      turns: 0,
    });
  }

  restoreSnapshot(snapshot: WorkflowModeSnapshot): void {
    this.revision++;
    this.requested = snapshot.requested;
    this.recorded = snapshot.recorded;
    this.pending = snapshot.pending;
    this.announced = snapshot.announced;
    this.turns = snapshot.turns;
    this.available = snapshot.available;
  }

  setRequested(enabled: boolean): void {
    if (this.recorded && enabled === this.requested) return;
    this.revision++;
    this.requested = enabled;
    this.recorded = true;
    this.pending = true;
    this.turns = 0;
  }

  observeAvailability(available: boolean): void {
    if (this.available === available) return;
    this.revision++;
    if (
      this.requested &&
      (available || this.available === true || this.announced === true)
    ) {
      this.pending = true;
      this.turns = 0;
    }
    this.available = available;
  }

  resetContext(): void {
    this.revision++;
    this.pending = this.recorded || this.announced === true;
    this.announced = undefined;
    this.turns = 0;
  }

  retire(): void {
    this.revision++;
  }

  prepare(
    context: WorkflowContext | null,
    keyword: WorkflowIntent | null,
  ): PreparedWorkflowMode {
    this.observeAvailability(context !== null);
    const effective = this.requested && context !== null;
    const due = this.pending || (effective && this.turns >= 9);
    let reminder = keyword?.reminder;
    if (due && effective) {
      const introduction =
        this.pending || this.announced !== true
          ? 'Workflow mode is enabled for this session. '
          : 'Workflow mode remains enabled for this session. ';
      reminder = envelope(
        buildWorkflowSteeringNotice(context.surface, {
          ...context,
          introduction,
        }),
      );
    } else if (due) {
      const exit = this.requested
        ? 'Workflow mode is temporarily unavailable. Do not apply the persistent workflow preference while its tools are unavailable.'
        : 'Workflow mode is off for this session. Do not apply the persistent workflow preference.';
      reminder = envelope(keyword ? `${exit}\n${keywordText(keyword)}` : exit);
    }
    if (!effective && !this.pending) return { reminder };

    const revision = this.revision;
    let dispatched = false;
    return {
      reminder,
      onModelRequestDispatched: () => {
        if (dispatched || revision !== this.revision) return;
        dispatched = true;
        this.announced = effective;
        this.pending = false;
        this.turns = reminder !== undefined ? 0 : this.turns + 1;
      },
    };
  }
}
