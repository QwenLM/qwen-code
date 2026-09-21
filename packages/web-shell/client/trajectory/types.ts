/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonTextTranscriptBlock,
  DaemonToolTranscriptBlock,
  DaemonTranscriptBlock,
  DaemonTranscriptTimingMeta,
  DaemonTurnUsage,
} from '@qwen-code/sdk/daemon';

/**
 * One item of a trajectory window in wire order: either a materialized
 * transcript block or a timing frame sitting where the telemetry record that
 * produced it was written.
 *
 * Timing frames are kept out of the block stream on purpose. Paged replay emits
 * one per telemetry record with no pairing of its own, precisely so a page
 * boundary cannot separate a request from its timing; pairing happens here,
 * over a window that is contiguous by construction.
 */
export type TrajectoryEntry =
  | { kind: 'block'; block: DaemonTranscriptBlock }
  | {
      kind: 'timing';
      timing: DaemonTranscriptTimingMeta;
      /** Persisted record uuid of the telemetry record, when stamped. */
      recordId?: string;
    }
  /**
   * One round's token counts, kept at the position the daemon reported them.
   *
   * The reducer folds these onto the round's assistant block, and a round that
   * produced only a thought and tool calls has no assistant block of its own —
   * its counts sum into the previous round's. Reading the frame where it
   * arrived is what keeps each round's tokens on the round that spent them.
   */
  | { kind: 'usage'; usage: DaemonTurnUsage };

/**
 * Recorded span of one row. Only values the daemon actually measured appear
 * here — a missing field means "not recorded", never "zero".
 */
export interface TrajectoryTiming {
  durationMs: number;
  /**
   * Requests only. Tool calls are logged in one loop after their whole batch
   * settles, so the recorded timestamp is the batch's end for every tool in it
   * and no honest per-tool start can be derived.
   */
  startedAt?: number;
  /** Requests only: dispatch to first user-visible content. */
  ttftMs?: number;
}

/** What a subagent spent, rolled up onto the tool call that spawned it. */
export interface TrajectorySubagentSummary {
  requests: number;
  tools: number;
  /** Summed request durations; 0 when none were recorded. */
  requestMs: number;
}

interface TrajectoryRowBase {
  /**
   * Identity that survives re-projection and page prepends. Derived from
   * persisted record / call identity, never from array position.
   */
  key: string;
  turnIndex: number;
  /** 0 for the main session, 1 for anything a subagent produced. */
  depth: number;
  /** Main-session request this row belongs to, when one was recorded. */
  requestIndex?: number;
}

export interface TrajectoryUserRow extends TrajectoryRowBase {
  kind: 'user';
  block: DaemonTextTranscriptBlock;
}

export interface TrajectoryRequestRow extends TrajectoryRowBase {
  kind: 'request';
  /** `unknown` when the frame recorded no status. */
  status: 'ok' | 'error' | 'unknown';
  timing: TrajectoryTiming;
  model?: string;
  /** Folded from the round's assistant block; absent when none carried it. */
  usage?: DaemonTurnUsage;
  responseId?: string;
  promptId?: string;
  /** Set when a subagent issued the request. */
  subagentId?: string;
  /** Main-session tool call that spawned the subagent, when resolvable. */
  parentToolCallId?: string;
}

export interface TrajectoryMessageRow extends TrajectoryRowBase {
  kind: 'message';
  block: DaemonTextTranscriptBlock;
  thought: boolean;
}

export interface TrajectoryToolRow extends TrajectoryRowBase {
  kind: 'tool';
  block: DaemonToolTranscriptBlock;
  /** Absent for an in-flight call, or a window with no timing frames. */
  timing?: TrajectoryTiming;
  toolStatus?: 'success' | 'error' | 'cancelled';
  /** Present on a tool call that spawned a subagent. */
  subagentSummary?: TrajectorySubagentSummary;
}

/** Shell output, permission prompts, status markers — carried, not paired. */
export interface TrajectoryOtherRow extends TrajectoryRowBase {
  kind: 'other';
  block: DaemonTranscriptBlock;
}

export type TrajectoryRow =
  | TrajectoryUserRow
  | TrajectoryRequestRow
  | TrajectoryMessageRow
  | TrajectoryToolRow
  | TrajectoryOtherRow;

export interface TrajectoryTurn {
  /** 1-based within the loaded window; not a session-wide turn number. */
  index: number;
  /** Absent when the window starts inside the turn. */
  userRowKey?: string;
  /**
   * The turn's last row whose key is derived from the record it describes,
   * rather than from its position in the window. Absent when the turn has no
   * such row. This is the identity collapse state is keyed on, so it has to
   * survive an older page landing; a positional key does not.
   */
  anchorKey?: string;
  rowKeys: string[];
  requestCount: number;
  /** Top-level tool rows; subagent tools are in the parent's summary. */
  toolCount: number;
  /** Summed main-session request durations; 0 when none were recorded. */
  requestMs: number;
  /** The window cut this turn's head off. */
  partial: boolean;
}

export interface Trajectory {
  turns: TrajectoryTurn[];
  rows: TrajectoryRow[];
  rowIndexByKey: Map<string, number>;
}
