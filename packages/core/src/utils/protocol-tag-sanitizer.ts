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
      result += text.slice(index, end);
      index = end;
      continue;
    }

    result += text.slice(index, start) + ' ';
    index = closeEnd;
  }
}

function stripVisibleTags(text: string): string {
  return stripClosedAnalysisBlocks(text).replace(
    /<\/?summary(?=[\s/>])[^>]*>/gi,
    (tag, offset: number, source: string) => {
      const before = source[offset - 1];
      const after = source[offset + tag.length];
      return before && after && !/\s/.test(before) && !/\s/.test(after)
        ? ' '
        : '';
    },
  );
}

function stripAnalysisOutsideSummary(text: string): string {
  const tagPattern = /<\/?(?:analysis|summary)(?=[\s/>])[^>]*>/gi;
  let result = '';
  let index = 0;
  let summaryDepth = 0;

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
      index = summaryIndex === -1 ? text.length : end + summaryIndex;
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
  private outputStarted = false;
  private recoveryBuffer: string | undefined;
  private recoveryAnalysisDepth = 0;
  private recoverySummaryOpened = false;

  accept(text: string): string {
    if (this.mode === 'passthrough') return text;
    if (this.mode === 'protocol') return this.acceptProtocolText(text);

    this.detectionBuffer += text;
    const candidate = this.detectionBuffer.replace(/^[\s\u200b]+/, '');
    const classification = classifyTagStart(candidate);
    if (classification.type === 'possible') return '';

    if (classification.type === 'none') {
      this.mode = 'passthrough';
      const out = this.detectionBuffer;
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
    this.outputStarted = false;
    this.recoveryBuffer = undefined;
    this.recoveryAnalysisDepth = 0;
    this.recoverySummaryOpened = false;
  }

  private acceptProtocolText(text: string): string {
    let out = '';

    for (const char of text) {
      if (this.recoveryBuffer !== undefined) this.recoveryBuffer += char;

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
        if (this.analysisDepth === 0) out += char;
        if (char === '>') this.literalTag = false;
        continue;
      }

      if (this.tagCandidate) {
        this.tagCandidate += char;
        const classification = classifyTagStart(this.tagCandidate);
        if (classification.type === 'possible') continue;
        if (classification.type === 'protocol') {
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
        }
      } else if (!selfClosing) {
        this.analysisDepth += 1;
      }
    } else if (!tag.closing) {
      if (this.analysisDepth === 0) {
        this.outputStarted = true;
      } else if (this.recoveryBuffer !== undefined) {
        this.recoverySummaryOpened = true;
      }
    }
  }

  private resetToPassthrough(): void {
    this.mode = 'passthrough';
    this.detectionBuffer = '';
    this.tagCandidate = '';
    this.protocolTag = undefined;
    this.literalTag = false;
    this.recoveryBuffer = undefined;
    this.recoveryAnalysisDepth = 0;
    this.recoverySummaryOpened = false;
  }
}
