/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

function isClosingAnalysisTag(tag: string): boolean {
  return tag.startsWith('</');
}

function isSelfClosingTag(tag: string): boolean {
  return tag.endsWith('/>');
}

function findAnalysisCloseEnd(text: string, from: number): number {
  const tagPattern = /<\/?analysis(?=[\s/>])[^>]*>/gi;
  let depth = 1;
  tagPattern.lastIndex = from;

  while (true) {
    const match = tagPattern.exec(text);
    if (!match) {
      return -1;
    }

    const tag = match[0].toLowerCase();
    if (isClosingAnalysisTag(tag)) {
      depth -= 1;
      if (depth === 0) {
        return match.index + match[0].length;
      }
    } else if (!isSelfClosingTag(tag)) {
      depth += 1;
    }
  }
}

function stripClosedAnalysisBlocks(text: string): string {
  const tagPattern = /<\/?analysis(?=[\s/>])[^>]*>/gi;
  let result = '';
  let index = 0;

  while (true) {
    tagPattern.lastIndex = index;
    const match = tagPattern.exec(text);
    if (!match) {
      return result + text.slice(index);
    }

    const tag = match[0].toLowerCase();
    const start = match.index;
    const end = start + match[0].length;

    if (isClosingAnalysisTag(tag)) {
      result += text.slice(index, end);
      index = end;
      continue;
    }

    if (isSelfClosingTag(tag)) {
      result += text.slice(index, start) + ' ';
      index = end;
      continue;
    }

    const closeEnd = findAnalysisCloseEnd(text, end);
    if (closeEnd === -1) {
      if (/<\/summary(?=[\s/>])[^>]*>/i.test(text.slice(end))) {
        return result + text.slice(index);
      }
      return result + text.slice(index, start);
    }

    result += text.slice(index, start) + ' ';
    index = closeEnd;
  }
}

/**
 * Find the top-level `</summary>` that closes an already-open visible summary
 * within `text`, returning the regexp match (with `.index`) or null when the
 * closer has not arrived yet. Nested literal `<summary>...</summary>` pairs are
 * balanced so their closers are not mistaken for the wrapper close. The scan
 * starts at depth 0 because `text` excludes the opening wrapper tag.
 */
function findTopLevelSummaryClose(text: string): RegExpExecArray | null {
  const tagPattern = /<\/?summary(?=[\s/>])[^>]*>/gi;
  let depth = 0;

  while (true) {
    const match = tagPattern.exec(text);
    if (!match) {
      return null;
    }

    const tag = match[0].toLowerCase();
    if (tag.startsWith('</')) {
      if (depth === 0) {
        return match;
      }
      depth -= 1;
    } else if (!isSelfClosingTag(tag)) {
      depth += 1;
    }
  }
}

/**
 * Resolve the tail of a visible summary that turned out to contain
 * `<analysis>`-shaped text, reusing the batch analysis stripper so the
 * streaming and non-streaming paths agree on which occurrences are protocol
 * scratchpad (paired `<analysis>...</analysis>`, dropped) versus literal
 * visible text (an unmatched `<analysis>` opener before the summary close,
 * kept). The trailing `</summary>` reproduces the batch look-ahead that
 * distinguishes those two cases.
 */
function sanitizeVisibleSummaryTail(tail: string): string {
  return stripClosedAnalysisBlocks(tail + '</summary>').replace(
    /<\/summary(?=[\s/>])[^>]*>$/i,
    '',
  );
}

function stripVisibleTags(text: string): string {
  const tagPattern = /<\/?summary(?=[\s/>])[^>]*>/gi;
  const stripped = stripClosedAnalysisBlocks(text);
  let result = '';
  let index = 0;
  let summaryDepth = 0;

  while (true) {
    tagPattern.lastIndex = index;
    const match = tagPattern.exec(stripped);
    if (!match) {
      return result + stripped.slice(index);
    }

    const tag = match[0].toLowerCase();
    const start = match.index;
    const end = start + match[0].length;

    result += stripped.slice(index, start);
    if (tag.startsWith('<summary')) {
      if (summaryDepth > 0) {
        result += match[0];
      } else if (needsBoundarySpace(stripped, start, end)) {
        result += ' ';
      }
      summaryDepth += 1;
    } else if (summaryDepth > 1) {
      result += match[0];
      summaryDepth -= 1;
    } else if (summaryDepth === 1) {
      if (needsBoundarySpace(stripped, start, end)) result += ' ';
      summaryDepth = 0;
    } else {
      result += match[0];
    }
    index = end;
  }
}

function needsBoundarySpace(text: string, start: number, end: number): boolean {
  return (
    start > 0 &&
    end < text.length &&
    !/\s/.test(text[start - 1]!) &&
    !/\s/.test(text[end]!)
  );
}

function stripAnalysisOutsideSummary(text: string): string {
  const tagPattern = /<\/?(?:analysis|summary)(?=[\s/>])[^>]*>/gi;
  let result = '';
  let index = 0;
  let summaryDepth = 0;
  let recoveringUnclosedAnalysis = false;

  while (true) {
    tagPattern.lastIndex = index;
    const match = tagPattern.exec(text);
    if (!match) {
      return result + text.slice(index);
    }

    const tag = match[0].toLowerCase();
    const start = match.index;
    const end = start + match[0].length;

    if (summaryDepth > 0) {
      result += text.slice(index, end);
      if (tag.startsWith('<summary')) {
        summaryDepth += 1;
      } else if (tag.startsWith('</summary')) {
        summaryDepth -= 1;
        if (summaryDepth === 0 && recoveringUnclosedAnalysis) {
          return result;
        }
      }
      index = end;
      continue;
    }

    if (tag.startsWith('<summary')) {
      result += text.slice(index, end);
      summaryDepth = 1;
      index = end;
      continue;
    }

    if (!tag.startsWith('<analysis')) {
      result += text.slice(index, end);
      index = end;
      continue;
    }

    result += text.slice(index, start);
    if (isSelfClosingTag(tag)) {
      index = end;
      continue;
    }

    const closeEnd = findAnalysisCloseEnd(text, end);
    if (closeEnd !== -1) {
      index = closeEnd;
    } else {
      const rest = text.slice(end);
      const summaryIndex = rest.search(/<summary(?=[\s/>])[^>]*>/i);
      if (summaryIndex === -1) {
        index = text.length;
      } else {
        recoveringUnclosedAnalysis = true;
        index = end + summaryIndex;
      }
    }
  }
}

export function stripAnalysisSummaryProtocolTags(text: string): string {
  return stripVisibleTags(stripAnalysisOutsideSummary(text).trim()).trim();
}

const PROTOCOL_TAG_PREFIXES = [
  '<analysis',
  '</analysis',
  '<summary',
  '</summary',
] as const;

type TagStart =
  | { type: 'possible' }
  | { type: 'none' }
  | { type: 'protocol'; name: 'analysis' | 'summary'; closing: boolean };

function classifyTagStart(text: string): TagStart {
  const lower = text.toLowerCase();
  // Direction 1: buffer is a prefix of a known tag (e.g. '<ana' could
  // become '<analysis>'). We need more characters to decide.
  if (PROTOCOL_TAG_PREFIXES.some((prefix) => prefix.startsWith(lower))) {
    return { type: 'possible' };
  }

  // Direction 2: a known tag is a prefix of the buffer (e.g. '<analysis>'
  // or '<analysis attr>'). Check the delimiter character after the tag name
  // to confirm it is a real tag boundary, not a longer word like '<analyze'.
  for (const prefix of PROTOCOL_TAG_PREFIXES) {
    if (!lower.startsWith(prefix)) continue;
    const delimiter = lower[prefix.length];
    if (delimiter === undefined) return { type: 'possible' };
    if (/[\s/>]/.test(delimiter)) {
      return {
        type: 'protocol',
        name: prefix.endsWith('analysis') ? 'analysis' : 'summary',
        closing: prefix.startsWith('</'),
      };
    }
  }

  return { type: 'none' };
}

export class TopLevelProtocolTagStreamFilter {
  private mode: 'detect' | 'passthrough' | 'protocol' = 'detect';
  private detectionBuffer = '';
  private tagCandidate = '';
  private protocolTag:
    | { name: 'analysis' | 'summary'; closing: boolean; lastChar: string }
    | undefined;
  private literalTag = false;
  private analysisDepth = 0;
  private visibleSummaryOpen = false;
  private literalSummaryDepth = 0;
  private literalSummaryOpeningLastChar: string | undefined;
  private outputStarted = false;
  private recoveryBuffer: string | undefined;
  private recoveryAnalysisDepth = 0;
  private recoverySummaryOpened = false;
  private recoverySummaryDepth = 0;
  private recoveryComplete = false;
  // Set once an `<analysis>`-shaped token appears inside a visible summary. From
  // that point the summary tail is buffered raw (rather than emitted char by
  // char) so it can be resolved with the batch stripper, keeping the streaming
  // and non-streaming paths in agreement on paired-vs-literal analysis tokens.
  private visibleSummaryTailBuffer: string | undefined;

  accept(text: string): string {
    if (this.mode === 'passthrough') return text;
    if (this.mode === 'protocol') return this.acceptProtocolText(text);

    this.detectionBuffer += text;
    const candidate = this.detectionBuffer.replace(/^[\s\u200b]+/, '');
    const classification = classifyTagStart(candidate);
    if (classification.type === 'possible') return '';

    if (classification.type === 'none') {
      this.mode = 'protocol';
      const out = this.acceptProtocolText(this.detectionBuffer);
      this.detectionBuffer = '';
      return out;
    }

    this.mode = 'protocol';
    this.detectionBuffer = '';
    return this.acceptProtocolText(candidate);
  }

  flush(): string {
    if (this.mode === 'passthrough') return '';
    if (this.mode === 'detect') {
      const candidate = this.detectionBuffer.replace(/^[\s\u200b]+/, '');
      const classification = classifyTagStart(candidate);
      const out =
        candidate.length > 0 && classification.type === 'possible'
          ? ''
          : this.detectionBuffer;
      this.resetToPassthrough();
      return out;
    }

    // A visible summary whose analysis tail never received a closing
    // `</summary>`: resolve whatever was buffered with the batch stripper so an
    // unclosed literal `<analysis>` mention is still preserved as visible text.
    if (this.visibleSummaryTailBuffer !== undefined) {
      const tail = sanitizeVisibleSummaryTail(this.visibleSummaryTailBuffer);
      this.resetToPassthrough();
      return tail;
    }

    const out =
      this.tagCandidate &&
      classifyTagStart(this.tagCandidate).type === 'none' &&
      this.analysisDepth === 0
        ? this.tagCandidate
        : '';
    const recovered =
      this.recoveryBuffer && this.recoverySummaryOpened
        ? stripAnalysisSummaryProtocolTags(this.recoveryBuffer)
        : '';
    this.resetToPassthrough();
    return out + recovered;
  }

  reset(): void {
    this.mode = 'detect';
    this.detectionBuffer = '';
    this.tagCandidate = '';
    this.protocolTag = undefined;
    this.literalTag = false;
    this.analysisDepth = 0;
    this.visibleSummaryOpen = false;
    this.literalSummaryDepth = 0;
    this.literalSummaryOpeningLastChar = undefined;
    this.outputStarted = false;
    this.recoveryBuffer = undefined;
    this.recoveryAnalysisDepth = 0;
    this.recoverySummaryOpened = false;
    this.recoverySummaryDepth = 0;
    this.recoveryComplete = false;
    this.visibleSummaryTailBuffer = undefined;
  }

  private acceptProtocolText(text: string): string {
    let out = '';

    for (const char of text) {
      if (this.recoveryBuffer !== undefined && !this.recoveryComplete) {
        this.recoveryBuffer += char;
      }

      // Inside a visible summary that contains `<analysis>`-shaped text, buffer
      // the tail until its top-level `</summary>` arrives, then resolve it with
      // the batch stripper so paired analysis blocks drop while literal
      // `<analysis>` mentions survive — matching the non-streaming path.
      if (this.visibleSummaryTailBuffer !== undefined) {
        this.visibleSummaryTailBuffer += char;
        if (char !== '>') continue;
        const close = findTopLevelSummaryClose(this.visibleSummaryTailBuffer);
        if (!close) continue;
        const tail = this.visibleSummaryTailBuffer.slice(0, close.index);
        out += sanitizeVisibleSummaryTail(tail);
        this.visibleSummaryTailBuffer = undefined;
        this.visibleSummaryOpen = false;
        continue;
      }

      if (this.protocolTag) {
        if (char === '>') {
          this.finishProtocolTag(this.protocolTag);
          this.protocolTag = undefined;
        } else if (!/\s/.test(char)) {
          this.protocolTag.lastChar = char;
        }
        continue;
      }

      if (this.literalTag) {
        // A '<' always begins a fresh tag candidate. Without this, an
        // unmatched '<' in prose (e.g. "3 < 5") keeps us scanning for the next
        // '>' — which is the one closing the protocol tag itself, causing the
        // protocol tag to leak (in a summary) or the answer to be swallowed
        // (in an analysis block).
        if (char === '<') {
          this.literalTag = false;
          this.literalSummaryOpeningLastChar = undefined;
          this.tagCandidate = char;
          continue;
        }
        if (this.analysisDepth === 0) out += char;
        if (this.literalSummaryOpeningLastChar && !/\s/.test(char)) {
          this.literalSummaryOpeningLastChar = char;
        }
        if (char === '>') {
          if (
            this.literalSummaryOpeningLastChar &&
            this.literalSummaryOpeningLastChar !== '/'
          ) {
            this.literalSummaryDepth += 1;
          }
          this.literalSummaryOpeningLastChar = undefined;
          this.literalTag = false;
        }
        continue;
      }

      if (this.tagCandidate) {
        this.tagCandidate += char;
        const classification = classifyTagStart(this.tagCandidate);
        if (classification.type === 'possible') continue;
        if (classification.type === 'protocol') {
          if (this.isLiteralVisibleSummaryTag(classification)) {
            out += this.tagCandidate;
            if (classification.closing) {
              this.literalSummaryDepth -= 1;
            } else if (/\/\s*>$/.test(this.tagCandidate)) {
              this.literalSummaryOpeningLastChar = undefined;
            } else if (char === '>') {
              this.literalSummaryDepth += 1;
            } else {
              this.literalSummaryOpeningLastChar = char;
            }
            this.literalTag = char !== '>';
            this.tagCandidate = '';
            continue;
          }
          if (
            classification.name === 'analysis' &&
            !classification.closing &&
            this.analysisDepth === 0 &&
            this.visibleSummaryOpen
          ) {
            // An `<analysis>`-shaped token inside visible summary content is
            // ambiguous until its scope is known: switch to buffering the
            // summary tail and let the batch stripper resolve it on close.
            this.visibleSummaryTailBuffer = this.tagCandidate;
            this.tagCandidate = '';
            continue;
          }
          if (
            classification.name === 'summary' &&
            !classification.closing &&
            this.analysisDepth > 0 &&
            this.recoveryBuffer === undefined
          ) {
            this.recoveryBuffer = this.tagCandidate;
            this.recoveryAnalysisDepth = this.analysisDepth;
          }
          this.protocolTag = {
            ...classification,
            lastChar: char === '>' ? '' : char,
          };
          this.tagCandidate = '';
          if (char === '>') {
            this.finishProtocolTag(this.protocolTag);
            this.protocolTag = undefined;
          }
          continue;
        }

        if (this.analysisDepth === 0) out += this.tagCandidate;
        this.literalTag = char !== '>';
        this.tagCandidate = '';
        continue;
      }

      if (char === '<') {
        this.tagCandidate = char;
      } else if (this.analysisDepth === 0) {
        if (this.outputStarted || !/\s/.test(char)) {
          out += char;
          this.outputStarted = true;
        }
      }
    }

    return out;
  }

  private finishProtocolTag(tag: NonNullable<typeof this.protocolTag>): void {
    const selfClosing = tag.lastChar === '/';
    if (tag.name === 'analysis') {
      if (tag.closing) {
        this.analysisDepth = Math.max(0, this.analysisDepth - 1);
        if (
          this.recoveryBuffer !== undefined &&
          this.analysisDepth < this.recoveryAnalysisDepth
        ) {
          this.recoveryBuffer = undefined;
          this.recoveryAnalysisDepth = 0;
          this.recoverySummaryOpened = false;
          this.recoverySummaryDepth = 0;
          this.recoveryComplete = false;
        }
      } else if (!selfClosing) {
        this.analysisDepth += 1;
      }
    } else if (tag.closing) {
      if (this.analysisDepth === 0 && this.visibleSummaryOpen) {
        this.visibleSummaryOpen = false;
        return;
      }
      if (
        this.recoveryBuffer !== undefined &&
        !this.recoveryComplete &&
        this.recoverySummaryDepth > 0
      ) {
        this.recoverySummaryDepth -= 1;
        this.recoveryComplete = this.recoverySummaryDepth === 0;
      }
    } else {
      if (this.analysisDepth === 0) {
        this.outputStarted = true;
        this.visibleSummaryOpen = !selfClosing;
      } else if (this.recoveryBuffer !== undefined) {
        this.recoverySummaryOpened = true;
        this.recoverySummaryDepth += 1;
      }
    }
  }

  private isLiteralVisibleSummaryTag(
    tag: Extract<TagStart, { type: 'protocol' }>,
  ): boolean {
    return (
      tag.name === 'summary' &&
      this.analysisDepth === 0 &&
      this.visibleSummaryOpen &&
      (!tag.closing || this.literalSummaryDepth > 0)
    );
  }

  private resetToPassthrough(): void {
    this.mode = 'passthrough';
    this.detectionBuffer = '';
    this.tagCandidate = '';
    this.protocolTag = undefined;
    this.literalTag = false;
    this.visibleSummaryOpen = false;
    this.literalSummaryDepth = 0;
    this.literalSummaryOpeningLastChar = undefined;
    this.recoveryBuffer = undefined;
    this.recoveryAnalysisDepth = 0;
    this.recoverySummaryOpened = false;
    this.recoverySummaryDepth = 0;
    this.recoveryComplete = false;
    this.visibleSummaryTailBuffer = undefined;
  }
}
