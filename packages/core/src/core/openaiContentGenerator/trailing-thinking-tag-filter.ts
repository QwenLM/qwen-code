/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

const CLOSING_TAG_LINE = /\r?\n[ \t]*<\/(think|thinking)[ \t]*>[ \t\r\n]*$/i;
const MAX_PENDING_LENGTH = 128;

export class TrailingThinkingTagFilter {
  private pending = '';
  private hasVisibleText = false;
  private literalContent = false;
  private markerTail = '';
  private previousLineBlank = true;
  private currentLineBlank = true;
  private lineIndent = 0;
  sanitizedTagName?: 'think' | 'thinking';

  parse(text: string, final: boolean, completed: boolean): string {
    this.pending += text;
    const markers = this.markerTail + text;
    // Bare closing tags are ambiguous in code or tagged examples. Keep those
    // answers verbatim rather than guessing which occurrence was intentional.
    this.literalContent ||=
      /`|~{3}|<think(?:ing)?(?:\s|>)|<(?:pre|textarea|script|style)(?:\s|>)/i.test(
        markers,
      );
    this.markerTail = markers.slice(-12);
    for (const character of text) {
      if (character === '\n') {
        this.previousLineBlank = this.currentLineBlank;
        this.currentLineBlank = true;
        this.lineIndent = 0;
      } else if (this.currentLineBlank && /[ \t\r]/.test(character)) {
        if (character !== '\r') {
          this.lineIndent = Math.min(
            4,
            this.lineIndent +
              (character === '\t' ? 4 - (this.lineIndent % 4) : 1),
          );
        }
      } else {
        // Indented code cannot interrupt a paragraph; one newline and four
        // spaces alone must still allow the known orphan suffix to be stripped.
        this.literalContent ||=
          this.currentLineBlank &&
          this.previousLineBlank &&
          this.lineIndent >= 4;
        this.currentLineBlank = false;
      }
    }

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
    // An earlier, already nonterminal closer makes a later identical suffix
    // ambiguous. Inspect only the prefix, never the withheld candidate itself.
    this.literalContent ||= /<\/(?:think|thinking)[ \t]*>/i.test(prefix);
    const eligible =
      !this.literalContent &&
      candidateStart >= 0 &&
      (this.hasVisibleText || /\S/.test(prefix)) &&
      // Only a still-open stream needs the bound; on the last call the whole
      // tail is known, so a whitespace-padded tag still has to be caught.
      (final || this.pending.length - candidateStart <= MAX_PENDING_LENGTH);
    if (eligible && (!final || (completed && closing))) {
      if (final && closing) {
        this.sanitizedTagName = closing[1]!.toLowerCase() as
          | 'think'
          | 'thinking';
      }
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
