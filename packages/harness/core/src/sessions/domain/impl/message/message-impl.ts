/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message } from '../../interface/message/message.js';
import type { MessageForkInfo } from '../../interface/message/message-fork-info.js';

/**
 * Standard in-memory implementation of the {@link Message} aggregate.
 *
 * Fields are kept package-visible so that the factory can populate them
 * directly after `new MessageImpl()`. External callers consume the aggregate
 * through the {@link Message} interface.
 */
export class MessageImpl implements Message {
  uuid = '';
  sessionId = '';
  turnId: string | undefined;
  parent: string | null = null;
  logicalParent: string | null | undefined;
  sidechainOf: string | undefined;
  timestamp = '';
  role: 'user' | 'assistant' | 'system' | 'attachment' = 'user';
  payload: Record<string, unknown> | undefined;
  promptId: string | undefined;
  requestSetId: string | undefined;
  agentId: string | undefined;
  hiddenUserMessage = false;
  toolResult = false;
  compactSummary = false;
  meta = false;
  sidechain = false;
  origin: { readonly kind: string } | undefined;
  resumable = true;
  forkedFrom: MessageForkInfo | undefined;

  getUuid(): string {
    return this.uuid;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getTurnId(): string | undefined {
    return this.turnId;
  }

  getParent(): string | null {
    return this.parent;
  }

  getLogicalParent(): string | null | undefined {
    return this.logicalParent;
  }

  getSidechainOf(): string | undefined {
    return this.sidechainOf;
  }

  getTimestamp(): string {
    return this.timestamp;
  }

  getPromptId(): string | undefined {
    return this.promptId;
  }

  getRequestSetId(): string | undefined {
    return this.requestSetId;
  }

  getAgentId(): string | undefined {
    return this.agentId;
  }

  getRole(): 'user' | 'assistant' | 'system' | 'attachment' {
    return this.role;
  }

  isHiddenUserMessage(): boolean {
    return this.hiddenUserMessage;
  }

  isToolResult(): boolean {
    return this.toolResult;
  }

  isCompactSummary(): boolean {
    return this.compactSummary;
  }

  isMeta(): boolean {
    return this.meta;
  }

  isSidechain(): boolean {
    return this.sidechain;
  }

  isLocallySourced(): boolean {
    if (this.role !== 'user') {
      return true;
    }
    const kind = this.origin?.kind;
    return kind === undefined || kind === 'human' || kind === 'auto-continuation';
  }

  getSearchText(): string {
    if (this.role === 'assistant') {
      return extractTextFromPayload(this.payload);
    }
    return this.getDisplayableUserText() ?? '';
  }

  getDisplayableUserText(): string | undefined {
    if (this.role !== 'user') {
      return undefined;
    }
    return this.getRealUserPromptText() ?? this.getPromptFallbackText();
  }

  getRealUserPromptText(): string | null {
    if (this.role !== 'user') {
      return null;
    }
    const text = extractTextFromPayload(this.payload);
    return text || null;
  }

  getPromptFallbackText(): string | undefined {
    return undefined;
  }

  isResumable(): boolean {
    return this.resumable;
  }

  getForkedFrom(): MessageForkInfo | undefined {
    return this.forkedFrom;
  }

  getPayload(): Record<string, unknown> | undefined {
    return this.payload;
  }
}

function extractTextFromPayload(
  payload: Record<string, unknown> | undefined,
): string {
  if (!payload) {
    return '';
  }
  const content = payload['content'];
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === 'object' && block && 'text' in block
          ? String(block['text'] ?? '')
          : '',
      )
      .join('');
  }
  return '';
}
