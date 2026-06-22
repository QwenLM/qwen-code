/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TurnContent } from './types.js';

/**
 * Accumulates thought and message chunks for a single model turn.
 * A turn ends when tool calls begin or the model stops generating.
 */
export class TurnBuffer {
  private thoughts: string[] = [];
  private messages: string[] = [];
  private _hasToolCalls = false;

  appendThought(text: string): void {
    if (text) this.thoughts.push(text);
  }

  appendMessage(text: string): void {
    if (text) this.messages.push(text);
  }

  markToolCall(): void {
    this._hasToolCalls = true;
  }

  /**
   * Returns accumulated content and resets the buffer.
   * Returns null if buffer is empty.
   */
  flush(): TurnContent | null {
    const thoughtText = this.thoughts.join('');
    const messageText = this.messages.join('');

    if (!thoughtText.trim() && !messageText.trim()) {
      this.reset();
      return null;
    }

    const content: TurnContent = {
      thoughts: this.thoughts.filter((t) => t.trim()),
      messages: this.messages.filter((m) => m.trim()),
      hasToolCalls: this._hasToolCalls,
    };

    this.reset();
    return content;
  }

  private reset(): void {
    this.thoughts = [];
    this.messages = [];
    this._hasToolCalls = false;
  }

  get isEmpty(): boolean {
    return this.thoughts.length === 0 && this.messages.length === 0;
  }
}
