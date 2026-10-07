/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

const CLOSING_TAG_LINE = /\r?\n[ \t]*<\/(?:think|thinking)[ \t]*>[ \t\r\n]*$/i;
const EARLIER_CLOSING_TAG = /<\/think(?:ing)?[ \t]*>/i;
const INDENTED_CODE_LINE = /^\r?\n(?: {4}|\t)/;
const MAX_PENDING_LENGTH = 128;

export class TrailingThinkingTagFilter {
  private pending = '';
  private hasVisibleText = false;
  private literalContent = false;
  private markerTail = '';
  /** The line held in `pending` was separated from the prose by a blank line. */
  private blankLineBeforeCandidate = false;

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
    // A closing tag that is not the trailing candidate means the answer is
    // about the tag itself, so a later identical one is literal too.
    this.literalContent ||= EARLIER_CLOSING_TAG.test(prefix);
    // CommonMark starts an indented code block on a blank line followed by
    // four spaces or a tab, and forbids one from interrupting a paragraph — so
    // a blank line plus indent is literal sample text, while a single newline
    // plus indent is only a lazy paragraph continuation. The blank line leaves
    // with the prefix, so remember it for the calls that finish the candidate.
    if (candidateStart > 0) {
      this.blankLineBeforeCandidate = /\n[ \t]*$/.test(prefix);
    }
    const candidateLine =
      candidateStart >= 0 ? this.pending.slice(candidateStart) : '';
    const eligible =
      !this.literalContent &&
      candidateStart >= 0 &&
      !(
        this.blankLineBeforeCandidate && INDENTED_CODE_LINE.test(candidateLine)
      ) &&
      (this.hasVisibleText || /\S/.test(prefix)) &&
      // Only a still-open stream needs the bound; on the last call the whole
      // tail is known, so a whitespace-padded tag still has to be caught.
      (final || this.pending.length - candidateStart <= MAX_PENDING_LENGTH);
    if (eligible && (!final || (completed && closing))) {
      this.pending = final ? '' : candidateLine;
      this.hasVisibleText ||= /\S/.test(prefix);
      return prefix;
    }

    const result = this.pending;
    this.pending = '';
    this.blankLineBeforeCandidate = false;
    this.hasVisibleText ||= /\S/.test(result);
    return result;
  }
}
