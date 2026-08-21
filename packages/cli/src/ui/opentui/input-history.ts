/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prompt-history navigation for the OpenTUI composer (PR1 slice 1).
 *
 * Framework-neutral port of the original `useInputHistory` hook
 * (packages/cli/src/ui/hooks/useInputHistory.ts) with identical semantics:
 *  - ↑ (HISTORY_UP / NAVIGATION_UP at the buffer edge) walks from newest to
 *    oldest submitted prompt, stashing the in-progress query on the first
 *    navigation;
 *  - ↓ walks back toward the newest entry and restores the stashed query
 *    once past it;
 *  - the position resets after every submit so the next ↑ starts at the
 *    newest entry.
 */

export class InputHistory {
  private index = -1;
  private originalQuery = '';

  /** `getMessages` returns submitted prompts in chronological order. */
  constructor(private readonly getMessages: () => readonly string[]) {}

  /** Mirrors `useInputHistory.navigateUp`; returns the new buffer text. */
  navigateUp(currentQuery: string): string | null {
    const messages = this.getMessages();
    if (messages.length === 0) return null;

    let nextIndex = this.index;
    if (this.index === -1) {
      this.originalQuery = currentQuery;
      nextIndex = 0;
    } else if (this.index < messages.length - 1) {
      nextIndex = this.index + 1;
    } else {
      return null; // already at the oldest message
    }

    if (nextIndex === this.index) return null;
    this.index = nextIndex;
    return messages[messages.length - 1 - nextIndex] ?? null;
  }

  /** Mirrors `useInputHistory.navigateDown`; returns the new buffer text. */
  navigateDown(): string | null {
    if (this.index === -1) return null; // not navigating history
    const messages = this.getMessages();

    const nextIndex = this.index - 1;
    this.index = nextIndex;
    if (nextIndex === -1) {
      return this.originalQuery; // back past the newest entry → restore draft
    }
    return messages[messages.length - 1 - nextIndex] ?? null;
  }

  /** Mirrors `resetHistoryNav` — called after each submit. */
  reset(): void {
    this.index = -1;
    this.originalQuery = '';
  }

  /** Whether a history entry is currently shown in the buffer. */
  get isNavigating(): boolean {
    return this.index !== -1;
  }
}
