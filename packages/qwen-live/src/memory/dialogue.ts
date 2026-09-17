/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export interface MemoryDialogueEvent {
  inputItemId: string;
  role: 'user' | 'assistant';
  text: string;
  source?: 'normal' | 'filler';
  interrupted?: boolean;
}

export interface MemoryDialogueSink {
  recordUser(text: string): void;
  recordAssistant(
    text: string,
    options: { source: 'normal' | 'filler'; interrupted: boolean },
  ): void;
}

interface Answer {
  text: string;
  interrupted: boolean;
}

interface Input {
  user?: string;
  userRecorded: boolean;
  filler?: Answer;
  fillerRecorded: boolean;
  answer?: Answer;
}

const CAPACITY = 256;

export class MemoryDialogueCollector {
  // Null entries retain recently completed IDs without retaining their text.
  private readonly inputs = new Map<string, Input | null>();
  private closed = false;

  constructor(private readonly sink: MemoryDialogueSink) {}

  beginInput(inputItemId: string): void {
    if (
      this.closed ||
      typeof inputItemId !== 'string' ||
      !inputItemId.trim() ||
      this.inputs.has(inputItemId)
    ) {
      return;
    }
    if (this.inputs.size === CAPACITY) {
      const oldest = this.inputs.entries().next().value;
      if (oldest) {
        if (oldest[1]) this.emitKnown(oldest[1]);
        this.inputs.delete(oldest[0]);
      }
    }
    this.inputs.set(inputItemId, {
      userRecorded: false,
      fillerRecorded: false,
    });
    this.drain();
  }

  accept(event: MemoryDialogueEvent): void {
    if (this.closed || typeof event.text !== 'string') return;
    // Registration belongs to this attachment's input-commit callback. An
    // unmatched late response must never open a turn in a new attachment.
    const input = this.inputs.get(event.inputItemId);
    const text = event.text.trim();
    if (!input) return;
    if (event.role === 'user' && !text) {
      this.inputs.set(event.inputItemId, null);
      this.drain();
      return;
    }
    if (!text) return;
    if (event.role === 'user') {
      input.user ??= text;
    } else if (event.role === 'assistant') {
      const answer = { text, interrupted: event.interrupted === true };
      if (event.source === 'filler') input.filler ??= answer;
      else if (event.source === undefined || event.source === 'normal') {
        input.answer ??= answer;
      } else {
        return;
      }
    } else {
      return;
    }
    this.drain();
  }

  flush(): void {
    if (!this.closed) this.drain(true);
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    this.inputs.clear();
  }

  private emitKnown(input: Input): void {
    if (!input.user) return;
    if (!input.userRecorded) {
      input.userRecorded = true;
      this.sink.recordUser(input.user);
    }
    if (input.filler && !input.fillerRecorded) {
      input.fillerRecorded = true;
      this.sink.recordAssistant(input.filler.text, {
        source: 'filler',
        interrupted: input.filler.interrupted,
      });
    }
    if (input.answer) {
      this.sink.recordAssistant(input.answer.text, {
        source: 'normal',
        interrupted: input.answer.interrupted,
      });
    }
  }

  private drain(force = false): void {
    const pending = [...this.inputs].filter(
      (entry): entry is [string, Input] => entry[1] !== null,
    );
    for (const [index, [id, input]] of pending.entries()) {
      if (!input.user && !force) break;
      this.emitKnown(input);
      const followedByUser = pending
        .slice(index + 1)
        .some(([, next]) => next.user !== undefined);
      if (force || input.answer || followedByUser) {
        this.inputs.set(id, null);
      } else {
        break;
      }
    }
  }
}
