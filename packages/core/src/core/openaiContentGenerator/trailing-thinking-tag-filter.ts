/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

const CLOSING_TAG_LINE = /\r?\n[ \t]*<\/(?:think|thinking)[ \t]*>[ \t\r\n]*$/i;
const MAX_PENDING_LENGTH = 128;

export class TrailingThinkingTagFilter {
  private pending = '';
  private hasVisibleText = false;
  private literalContent = false;
  private markerTail = '';

  parse(text: string, final: boolean, completed: boolean): string {
    this.pending += text;
    const markers = this.markerTail + text;
    // Bare closing tags are ambiguous in code or tagged examples. Keep those
    // answers verbatim rather than guessing which occurrence was intentional.
    this.literalContent ||= /`|~{3}|<think(?:ing)?(?:\s|>)/i.test(markers);
    this.markerTail = markers.slice(-12);

    const closing = CLOSING_TAG_LINE.exec(this.pending);
    let candidateStart = closing?.index ?? this.pending.lastIndexOf('\n');
    if (!closing && candidateStart < 0 && this.pending.endsWith('\r')) {
      candidateStart = this.pending.length - 1;
    } else if (!closing && this.pending[candidateStart - 1] === '\r') {
      candidateStart--;
    }
    if (!closing && candidateStart >= 0) {
      const candidate = this.pending.slice(candidateStart).trimStart();
      if (
        !['</think>', '</thinking>'].some((tag) =>
          tag.startsWith(candidate.toLowerCase()),
        ) &&
        !/^<\/(?:think|thinking)[ \t]*>?[ \t\r\n]*$/i.test(candidate)
      ) {
        candidateStart = -1;
      }
    }

    const prefix =
      candidateStart >= 0
        ? this.pending.slice(0, candidateStart)
        : this.pending;
    const eligible =
      !this.literalContent &&
      (this.hasVisibleText || /\S/.test(prefix)) &&
      candidateStart >= 0 &&
      this.pending.length - candidateStart <= MAX_PENDING_LENGTH;
    if (eligible && (!final || (completed && closing))) {
      this.pending = final ? '' : this.pending.slice(candidateStart);
      this.hasVisibleText ||= /\S/.test(prefix);
      return prefix;
    }

    const result = this.pending;
    this.pending = '';
    this.hasVisibleText ||= /\S/.test(result);
    return result;
  }
}
