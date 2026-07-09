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
  const tagPattern = /<\/?analysis\b[^>]*>/gi;
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
  const tagPattern = /<\/?analysis\b[^>]*>/gi;
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
  return stripClosedAnalysisBlocks(text)
    .replace(/<\/?summary\b[^>]*>/gi, ' ')
    .replace(/ {2,}/g, ' ');
}

function stripAnalysisOutsideSummary(text: string): string {
  const tagPattern = /<\/?(?:analysis|summary)\b[^>]*>/gi;
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
      const summaryIndex = rest.search(/<summary\b[^>]*>/i);
      index = summaryIndex === -1 ? text.length : end + summaryIndex;
    }
  }
}

export function stripAnalysisSummaryProtocolTags(text: string): string {
  return stripVisibleTags(stripAnalysisOutsideSummary(text).trim()).trim();
}

export function startsWithAnalysisSummaryProtocolTag(text: string): boolean {
  return /^<(?:analysis|summary)\b/i.test(text.trimStart());
}

function couldBecomeProtocolStart(text: string): boolean {
  const lower = text.trimStart().toLowerCase();
  return (
    lower.length === 0 ||
    '<analysis'.startsWith(lower) ||
    '<summary'.startsWith(lower) ||
    lower.startsWith('<analysis') ||
    lower.startsWith('<summary')
  );
}

export class TopLevelProtocolTagStreamFilter {
  private buffer = '';
  private passthrough = false;

  accept(text: string): string {
    if (this.passthrough) {
      return text;
    }

    this.buffer += text;
    if (couldBecomeProtocolStart(this.buffer)) {
      return '';
    }

    this.passthrough = true;
    const out = this.buffer;
    this.buffer = '';
    return out;
  }

  flush(): string {
    if (this.passthrough || this.buffer.length === 0) {
      return '';
    }

    const out = startsWithAnalysisSummaryProtocolTag(this.buffer)
      ? stripAnalysisSummaryProtocolTags(this.buffer)
      : this.buffer;
    this.buffer = '';
    this.passthrough = true;
    return out;
  }

  reset(): void {
    this.buffer = '';
    this.passthrough = false;
  }
}
