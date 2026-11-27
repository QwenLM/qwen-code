/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface CodeBlockLink {
  start: number;
  end: number;
  href: string;
}

const closingPairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

export function findCodeBlockLinks(line: string): CodeBlockLink[] {
  const links: CodeBlockLink[] = [];
  const pattern = /(?<![\w:/])https?:\/\/[^\s<>"`]+/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    let href = match[0];
    const quote = line[match.index - 1];
    if (quote === "'") {
      href = href.split("'")[0];
      pattern.lastIndex = match.index + href.length;
    }
    const isQuoted =
      ["'", '"', '`'].includes(quote) &&
      line[match.index + href.length] === quote;

    while (href && !isQuoted) {
      const close = href.at(-1)!;
      const open = closingPairs[close];
      if (!open || href.split(close).length <= href.split(open).length) break;
      href = href.slice(0, -1);
    }

    const hasControls = [...href].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    });
    if (
      /^https?:\/\/\//i.test(href) ||
      hasControls ||
      href.includes('\\') ||
      /%(?![\da-f]{2})/i.test(href)
    ) {
      continue;
    }
    try {
      const parsed = new URL(href);
      if (!parsed.hostname || !['http:', 'https:'].includes(parsed.protocol)) {
        continue;
      }
    } catch {
      continue;
    }
    links.push({ start: match.index, end: match.index + href.length, href });
  }
  return links;
}
