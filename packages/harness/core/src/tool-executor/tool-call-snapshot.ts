/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCall } from './types.js';

export interface ToolCallSnapshot {
  toolCallScopeId: string;
  toolCalls: ToolCall[];
  /** Identifies the CodeMode call and, via parentToolUseId, the tool call that launched the agent. */
  codeMode?: { rootToolUseId: string; parentToolUseId?: string };
}

export type ToolCallSnapshotListener = (snapshot: ToolCallSnapshot) => void;

export interface ToolCallSnapshotPublisher {
  publishToolCallSnapshot(snapshot: ToolCallSnapshot): void;
}

export interface ToolCallSnapshotSubscriber {
  subscribeToolCallSnapshots(listener: ToolCallSnapshotListener): () => void;
}

export interface ToolCallSnapshotStore
  extends ToolCallSnapshotPublisher,
    ToolCallSnapshotSubscriber {
  clearToolCallSnapshotListeners(): void;
}

export class InMemoryToolCallSnapshotStore implements ToolCallSnapshotStore {
  private readonly listeners = new Set<ToolCallSnapshotListener>();

  publishToolCallSnapshot(snapshot: ToolCallSnapshot): void {
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  subscribeToolCallSnapshots(listener: ToolCallSnapshotListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clearToolCallSnapshotListeners(): void {
    this.listeners.clear();
  }
}
