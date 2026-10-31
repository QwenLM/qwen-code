/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

const CLOSING_TAG_LINE = /\r?\n[ \t]*<\/(think|thinking)[ \t]*>[ \t\r\n]*$/i;
/** Any already-released closing markup makes later suffix removal ambiguous. */
const RELEASED_CLOSING_MARKUP = /<\//;
// The converter quarantines unresolved thinking-tag prefixes. Keep those
// prefixes available to that quarantine logic; complete `<think` or
// `<thinking` markup retains the existing literal-content behavior.
const LITERAL_OPENING_MARKUP =
  /<(?!(?:t|th|thi|thin|thinki|thinkin)\s*(?=<|$)|think(?=$)|thinking(?=$))[a-z!?]/i;
const MAX_PENDING_LENGTH = 128;
/**
 * Rolling window over released text. Wide enough to hold a closer split
 * across calls, so the ambiguity latch below does not depend on where the
 * provider happened to cut the deltas.
 */
const EMITTED_TAIL_LENGTH = 12;

export class TrailingThinkingTagFilter {
  private pending = '';
  private hasVisibleText = false;
  private literalContent = false;
  private markerTail = '';
  private emittedTail = '';
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
      /`|~{3}/.test(markers) || LITERAL_OPENING_MARKUP.test(markers);
    this.markerTail = markers.replace(/\s+$/, ' ').slice(-12);
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
    if (!closing && this.pending.endsWith('\r')) {
      // The hold cannot depend on `candidateStart` still being -1: once the
      // answer has an earlier line break it comes from `lastIndexOf('\n')`,
      // and the `\r` is then released into the delivered prose.
      candidateStart = Math.max(candidateStart, this.pending.length - 1);
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
    // Earlier, already-released closing markup makes a later suffix
    // ambiguous. The markup can straddle a release boundary, so test it over
    // a cumulative view of what this filter has handed over plus this call's
    // prefix -- never the withheld candidate itself.
    this.literalContent ||= RELEASED_CLOSING_MARKUP.test(
      this.emittedTail + prefix,
    );
    const eligible =
      !this.literalContent &&
      candidateStart >= 0 &&
      (this.hasVisibleText || /\S/.test(prefix)) &&
      this.pending.length - candidateStart <= MAX_PENDING_LENGTH;
    if (eligible && (!final || (completed && closing))) {
      if (final && closing) {
        this.sanitizedTagName = closing[1]!.toLowerCase() as
          | 'think'
          | 'thinking';
      }
      this.pending = final ? '' : this.pending.slice(candidateStart);
      this.hasVisibleText ||= /\S/.test(prefix);
      this.noteReleased(prefix);
      return prefix;
    }

    const result = this.pending;
    this.pending = '';
    // This release hands back a region the latch above never saw (the eligible
    // branch only sees `prefix`), so a complete closer here has to arm it too:
    // otherwise the same bytes keep or lose their final closer by framing.
    this.literalContent ||= RELEASED_CLOSING_MARKUP.test(
      this.emittedTail + result,
    );
    this.hasVisibleText ||= /\S/.test(result);
    this.noteReleased(result);
    return result;
  }

  /**
   * Hands back a hold that is entirely whitespace. A tagged-thinking takeover
   * stops calling this filter for the rest of the turn, so whitespace it still
   * holds would otherwise be stranded -- and whitespace is model output. A
   * held tag fragment is deliberately left alone: draining it would leak the
   * fragment as prose.
   */
  drainWhitespace(): string {
    if (!/^\s+$/.test(this.pending)) return '';
    const held = this.pending;
    this.pending = '';
    this.noteReleased(held);
    return held;
  }

  /**
   * Records text this filter has handed to the consumer. A release can be
   * split across calls, so the earlier-closer latch needs a rolling view of
   * everything emitted rather than one call's prefix. Only released text is
   * fed here: a withheld candidate must never arm the latch, or the ordinary
   * strip would disable itself.
   */
  private noteReleased(text: string): void {
    this.emittedTail = (this.emittedTail + text).slice(-EMITTED_TAIL_LENGTH);
  }
}
