/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export class TerminalOutputBuffer {
  private readonly headBudget: number;
  private readonly tailBudget: number;
  private head = '';
  private tailChunks: string[] = [];
  private tailLength = 0;
  private omittedChars = 0;

  constructor(private readonly maxChars = 1024 * 1024) {
    this.headBudget = Math.floor(maxChars / 2);
    this.tailBudget = maxChars - this.headBudget;
  }

  append(chunk: string): void {
    if (!chunk) return;
    if (this.maxChars <= 0) {
      this.omittedChars += chunk.length;
      return;
    }

    if (this.head.length < this.headBudget) {
      const remainingHead = this.headBudget - this.head.length;
      if (chunk.length <= remainingHead) {
        this.head += chunk;
        return;
      }
      this.head += chunk.slice(0, remainingHead);
      chunk = chunk.slice(remainingHead);
    }

    this.tailChunks.push(chunk);
    this.tailLength += chunk.length;

    while (this.tailLength > this.tailBudget && this.tailChunks.length > 0) {
      const overflow = this.tailLength - this.tailBudget;
      const front = this.tailChunks[0];
      if (front.length <= overflow) {
        this.tailChunks.shift();
        this.tailLength -= front.length;
        this.omittedChars += front.length;
      } else {
        this.tailChunks[0] = front.slice(overflow);
        this.tailLength -= overflow;
        this.omittedChars += overflow;
        break;
      }
    }
  }

  tailText(maxChars = 12000): string {
    if (this.tailLength >= maxChars) {
      return this.sliceTailFromEnd(maxChars);
    }
    const marker = this.omittedMarker();
    const tailStr = this.materializeTail();
    const need = maxChars - tailStr.length;
    if (need <= marker.length) {
      return marker.slice(marker.length - need) + tailStr;
    }
    const headNeed = need - marker.length;
    const headPart =
      this.head.length > headNeed
        ? this.head.slice(this.head.length - headNeed)
        : this.head;
    return headPart + marker + tailStr;
  }

  toString(): string {
    const tail = this.materializeTail();
    if (this.omittedChars <= 0) {
      return this.head + tail;
    }
    return this.head + this.omittedMarker() + tail;
  }

  private materializeTail(): string {
    if (this.tailChunks.length === 0) return '';
    if (this.tailChunks.length === 1) return this.tailChunks[0];
    const joined = this.tailChunks.join('');
    this.tailChunks = [joined];
    return joined;
  }

  private sliceTailFromEnd(maxChars: number): string {
    const tail = this.materializeTail();
    return tail.slice(tail.length - maxChars);
  }

  private omittedMarker(): string {
    if (this.omittedChars <= 0) return '';
    return `\n[... ${this.omittedChars} characters omitted ...]\n`;
  }
}
