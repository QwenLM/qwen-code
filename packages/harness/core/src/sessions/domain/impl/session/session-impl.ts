/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message } from '../../interface/message/message.js';
import type { Session } from '../../interface/session/session.js';
import type { Turn } from '../../interface/turn/turn.js';
import { groupMessagesIntoTurns } from '../../../factory/turn-factory.js';
import { TurnImpl } from '../turn/turn-impl.js';

/**
 * Standard in-memory implementation of the {@link Session} aggregate.
 *
 * Fields are kept package-visible so that the factory can populate them
 * directly after `new SessionImpl()`. External callers consume the aggregate
 * through the {@link Session} interface, which exposes only reviewed getters
 * and setters.
 */
export class SessionImpl implements Session {
  // Identity
  sessionId = '';
  remoteId: string | undefined;

  // Origin
  entrypoint: string | undefined;
  version: string | undefined;
  userType: string | undefined;

  // Location
  projectDir = '';
  sessionPath = '';
  cwd = '';
  gitBranch: string | undefined;
  worktree: string | null | undefined;
  directories: readonly string[] | undefined;
  transcriptProjectDir: string | undefined;
  transcriptBucketDir: string | undefined;
  sourceWorktreePath: string | undefined;
  displayProjectPath: string | undefined;

  // Time
  startedAt = '';
  updatedAt = '';

  // Catalog metadata
  tag: string | undefined;
  summary: string | undefined;
  lastPrompt: string | undefined;
  customTitle: string | undefined;
  aiTitle: string | undefined;

  // Presentation
  index = 0;
  currentSession = false;
  fullContent: string | undefined;
  searchableMessages: readonly Message[] = [];
  searchableContent: string | undefined;

  // Statistics
  fileSize: number | undefined;

  // Children
  messages: readonly Message[] = [];
  turns: readonly Turn[] = [];
  /** Map from promptId to the owning turn for incremental updates. */
  private readonly turnByPromptId = new Map<string, TurnImpl>();

  constructor() {
    // Intentionally empty: all construction logic lives in the factory.
  }

  // Identity
  getSessionId(): string { return this.sessionId; }
  getRemoteId(): string | undefined { return this.remoteId; }

  // Origin
  getEntrypoint(): string | undefined { return this.entrypoint; }
  getVersion(): string | undefined { return this.version; }
  getUserType(): string | undefined { return this.userType; }

  // Location
  getProjectDir(): string { return this.projectDir; }
  getSessionPath(): string { return this.sessionPath; }
  getCwd(): string { return this.cwd; }
  getGitBranch(): string | undefined { return this.gitBranch; }
  getWorktree(): string | null | undefined { return this.worktree; }
  getDirectories(): readonly string[] | undefined { return this.directories; }
  getTranscriptProjectDir(): string | undefined { return this.transcriptProjectDir; }
  getTranscriptBucketDir(): string | undefined { return this.transcriptBucketDir; }
  getSourceWorktreePath(): string | undefined { return this.sourceWorktreePath; }
  getDisplayProjectPath(): string | undefined { return this.displayProjectPath; }

  // Time
  getStartedAt(): string { return this.startedAt; }
  getUpdatedAt(): string { return this.updatedAt; }

  // Catalog metadata
  getTag(): string | undefined { return this.tag; }
  getSummary(): string | undefined { return this.summary; }
  getLastPrompt(): string | undefined { return this.lastPrompt; }
  getCustomTitle(): string | undefined { return this.customTitle; }
  getAiTitle(): string | undefined { return this.aiTitle; }

  // Presentation
  getIndex(): number { return this.index; }
  setIndex(value: number): void { this.index = value; }
  isCurrentSession(): boolean { return this.currentSession; }
  getDisplayInfo(): string {
    return `Session ${this.getIndex() || this.sessionId}: ${this.getDisplayName()} (${this.getMessageCount()} messages, updated ${this.updatedAt})`;
  }

  getDisplayName(): string {
    return (
      this.customTitle ??
      this.aiTitle ??
      this.lastPrompt ??
      this.summary ??
      this.getFirstUserMessage() ??
      'Empty conversation'
    );
  }
  getFullContent(): string | undefined { return this.fullContent; }
  getSearchableMessages(): readonly Message[] { return this.searchableMessages; }
  getSearchableContent(): string | undefined { return this.searchableContent; }

  // Content access
  getMessages(): readonly Message[] { return this.messages; }
  getTurns(): readonly Turn[] { return this.turns; }

  /** Rebuilds the turn index from the current message chain. */
  rebuildTurns(): void {
    this.turns = groupMessagesIntoTurns(this.messages, this.sessionId);
    this.turnByPromptId.clear();
    for (const turn of this.turns) {
      this.turnByPromptId.set(turn.getPromptId(), turn as TurnImpl);
    }
  }

  // Statistics
  getMessageCount(): number { return this.messages.length; }
  getUserMessageCount(): number {
    // Real user-message counting requires Message aggregate projection.
    return 0;
  }
  getFileSize(): number | undefined { return this.fileSize; }

  // Queries
  hasResumableMessages(): boolean {
    return this.messages.some((m) => m.isResumable?.());
  }

  getFirstUserMessage(): string {
    for (const message of this.messages) {
      const text = message.getRealUserPromptText?.();
      if (text) return text;
      const fallback = message.getPromptFallbackText?.();
      if (fallback) return fallback;
    }
    return 'Empty conversation';
  }

  countUserMessages(): number {
    return this.messages.filter((m) => m.getRole?.() === 'user').length;
  }

  countDisplayMessages(): number {
    return this.messages.filter((m) => {
      const role = m.getRole?.();
      if (role === 'assistant') return true;
      if (role !== 'user') return false;
      return !m.isHiddenUserMessage?.();
    }).length;
  }

  getWorkspaceDirectories(): readonly string[] {
    return this.directories ?? [];
  }

  // In-memory state mutation
  addMessage(message: Message): void {
    this.messages = [...this.messages, message];

    const promptId = message.getPromptId();
    let turn: TurnImpl | undefined;

    if (promptId) {
      turn = this.turnByPromptId.get(promptId);
      if (!turn) {
        turn = new TurnImpl();
        turn.promptId = promptId;
        turn.sessionId = this.sessionId;
        turn.requestSetId = message.getRequestSetId();
        turn.agentId = message.getAgentId();
        this.turnByPromptId.set(promptId, turn);
        this.turns = [...this.turns, turn];
      }
    } else if (this.turns.length > 0) {
      // Orphan messages attach to the most recent turn.
      turn = this.turns[this.turns.length - 1] as TurnImpl;
    } else {
      // No preceding turn exists: create a synthetic single-message turn.
      turn = new TurnImpl();
      turn.promptId = message.getUuid();
      turn.sessionId = this.sessionId;
      turn.requestSetId = message.getRequestSetId();
      turn.agentId = message.getAgentId();
      this.turnByPromptId.set(turn.promptId, turn);
      this.turns = [turn];
    }

    turn.messages = [...turn.messages, message];

    if (message.getRole() === 'user') {
      const text = message.getRealUserPromptText?.() ?? message.getPromptFallbackText?.();
      if (text) {
        turn.promptText = text;
      }
      if (!turn.requestSetId) {
        turn.requestSetId = message.getRequestSetId();
      }
    }

    const payload = message.getPayload();
    if (
      message.getRole() === 'system' &&
      payload?.['subtype'] === 'compact_boundary'
    ) {
      turn.compactBoundary = true;
    }
  }

}
