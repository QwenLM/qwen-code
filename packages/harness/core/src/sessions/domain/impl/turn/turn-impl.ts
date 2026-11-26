/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message } from '../../interface/message/message.js';
import type { Turn } from '../../interface/turn/turn.js';

/**
 * Standard in-memory implementation of the {@link Turn} aggregate.
 *
 * A turn represents one agent-loop: it starts with a human-authored user
 * message and contains every message produced for that prompt (assistant
 * responses, tool results, system events). All messages in a turn share the
 * same {@link promptId}.
 *
 * Fields are kept package-visible so that the factory can populate them
 * directly after `new TurnImpl()`. External callers consume the aggregate
 * through the {@link Turn} interface.
 */
export class TurnImpl implements Turn {
  promptId = '';
  sessionId = '';
  requestSetId: string | undefined;
  promptText = '';
  inputMode: 'prompt' | 'bash' = 'prompt';
  agentId: string | undefined;
  compactBoundary = false;
  messages: readonly Message[] = [];

  constructor() {
    // Intentionally empty: all construction logic lives in the factory.
  }

  getPromptId(): string {
    return this.promptId;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getRequestSetId(): string | undefined {
    return this.requestSetId;
  }

  getUserMessage(): Message {
    const user = this.messages.find((m) => m.getRole() === 'user');
    if (!user) {
      throw new Error(`Turn ${this.promptId} has no user message.`);
    }
    return user;
  }

  getPromptText(): string {
    return this.promptText;
  }

  getInputMode(): 'prompt' | 'bash' {
    return this.inputMode;
  }

  getAgentId(): string | undefined {
    return this.agentId;
  }

  isSidechain(): boolean {
    return this.agentId !== undefined;
  }

  getRewindTargetUuid(): string {
    return this.getUserMessage().getUuid();
  }

  isCompactBoundary(): boolean {
    return this.compactBoundary;
  }

  getMessages(): readonly Message[] {
    return this.messages;
  }
}
