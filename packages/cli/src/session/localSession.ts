/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  QueryEvent,
  ToolRegistry,
  SerializableConfirmationDetails,
  ReasoningEffortLevel,
  ToolCall,
  ToolCallSnapshotSubscriber,
} from '@qwen-code/core';
import type { SessionHandle } from './session.js';
import type { SessionArtifactRuntime } from './artifacts/sessionArtifactRuntime.js';

/** Current local execution facts, independent of any remote connection. */
export interface SessionExecutionState {
  /** Config/MCP ready, idle and not responding, as required by the local owner. */
  readonly canSubmitMessage: boolean;
  /** Used when an observer attaches during an existing model turn. */
  readonly isResponding: boolean;
  /** Current calls let a new observer recover an already pending approval. */
  readonly pendingToolCalls: readonly ToolCall[];
}

export type SessionExecutionUpdate =
  | { type: 'snapshot'; state: SessionExecutionState }
  | { type: 'query_event'; event: QueryEvent }
  // This is the existing owner's completion notification, not send_finished.
  | { type: 'turn_complete' };

/** Native settings facts. Protocol key names are chosen by each consumer. */
export interface LocalSessionSettings {
  sources?: { user: unknown; project: unknown; local: unknown; flag: unknown };
  effective: Readonly<Record<string, unknown>>;
  applied: { effort: ReasoningEffortLevel | null; ultracode: boolean };
  outputStyle: string;
  outputStyles: readonly string[];
}
export type LocalSessionArtifacts = Pick<
  SessionArtifactRuntime,
  'snapshot' | 'subscribe' | 'present'
>;

/** A local executor exposes its existing events; it creates no second runner. */
export interface LocalSessionHandle extends SessionHandle {
  /** Uses the existing native title generator; the caller owns scheduling. */
  generateTitle(): Promise<string | null>;
  /** Automatic title setting for this binding, updated through applySettings. */
  readonly automaticTitleEnabled: boolean;
  readSettings(): Promise<LocalSessionSettings>;
  describeApproval(
    id: string,
  ): Promise<SerializableConfirmationDetails | undefined>;
  getArtifacts(): Promise<LocalSessionArtifacts>;
  getExecutionState(): SessionExecutionState;
  /** Current execution facts first, then ordered changes without an attach gap. */
  observeExecution(
    listener: (update: SessionExecutionUpdate) => void,
  ): () => void;
  /** Main-session tools stay outside Config and child-agent registries. */
  readonly toolRegistry: Pick<ToolRegistry, 'registerTool' | 'unregisterTool'>;
  /** Reuse the owner's tool snapshots; the subscriber owns its unsubscribe. */
  readonly toolCallSnapshots: ToolCallSnapshotSubscriber;
}
