import type { RootContent, Nodes } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

export interface MarkdownChunkOptions {
  targetLength: number;
  maxLength: number;
  unit: 'utf16' | 'utf8';
}

const parser = unified().use(remarkParse).use(remarkGfm);
const fallbackNotice =
  '> Markdown element exceeds the message limit; original text follows in parts.\n\n';

/** Split at Markdown boundaries, retaining source spelling (especially URLs). */
export function splitMarkdown(
  text: string,
  options: MarkdownChunkOptions,
): string[] {
  const { targetLength, maxLength, unit } = options;
  if (
    !Number.isSafeInteger(targetLength) ||
    !Number.isSafeInteger(maxLength) ||
    targetLength <= 0 ||
    maxLength < targetLength
  ) {
    throw new RangeError('Invalid Markdown chunk budget');
  }
  const size = (value: string) =>
    unit === 'utf8' ? Buffer.byteLength(value, 'utf8') : value.length;
  const source = (node: Nodes) =>
    text.slice(node.position!.start.offset!, node.position!.end.offset!);

  function fitEnd(value: string, budget: number): number {
    let low = 0;
    let high = value.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (size(value.slice(0, mid)) <= budget) low = mid;
      else high = mid - 1;
    }
    if (
      low > 0 &&
      low < value.length &&
      /[\uD800-\uDBFF]/u.test(value[low - 1]!) &&
      /[\uDC00-\uDFFF]/u.test(value[low]!)
    ) {
      low--;
    }
    if (!low && value) {
      throw new RangeError(
        'Markdown budget cannot contain one Unicode character',
      );
    }
    return low;
  }

  function splitText(
    value: string,
    budget: number,
    firstOnly = false,
  ): string[] {
    const parts: string[] = [];
    while (value) {
      let end = fitEnd(value, budget);
      if (end < value.length) {
        const candidate = value.slice(0, end);
        for (const boundary of [/[。！？]|[.!?](?=\s|$)/gu, /\s+/gu]) {
          let preferred = 0;
          for (const match of candidate.matchAll(boundary)) {
            preferred = match.index + match[0].length;
          }
          if (preferred >= end / 2) {
            end = preferred;
            break;
          }
        }
        const ampersand = value.lastIndexOf('&', end - 1);
        if (firstOnly && ampersand >= 0) {
          const entity = /^&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/iu.exec(
            value.slice(ampersand),
          );
          if (entity && ampersand + entity[0].length > end) {
            end = ampersand || entity[0].length;
          }
        }
        // Keep escaped punctuation with its escape character.
        const escapes = value.slice(0, end).match(/\\+$/u)?.[0].length ?? 0;
        const next = value.charCodeAt(end);
        const escapedPunctuation =
          (next >= 33 && next <= 47) ||
          (next >= 58 && next <= 64) ||
          (next >= 91 && next <= 96) ||
          (next >= 123 && next <= 126);
        if (firstOnly && escapes % 2 && escapedPunctuation)
          end = end > 1 ? end - 1 : 2;
      }
      parts.push(value.slice(0, end));
      value = value.slice(end);
      if (firstOnly) break;
    }
    return parts;
  }

  function fenceFor(value: string, info = ''): string {
    let ticks = 2;
    let tildes = 2;
    for (const match of value.matchAll(/(`+|~+)/g)) {
      if (match[1]![0] === '`') ticks = Math.max(ticks, match[1]!.length);
      else tildes = Math.max(tildes, match[1]!.length);
    }
    return !info.includes('`') && ticks <= tildes
      ? '`'.repeat(ticks + 1)
      : '~'.repeat(tildes + 1);
  }

  function fencedParts(
    value: string,
    opening: string,
    closing: string,
    limit: number,
    soft: number,
    notice = '',
  ): string[] {
    const overhead = size(`${notice}${opening}\n\n${closing}`);
    const budget = limit - overhead;
    if (budget <= 0)
      throw new RangeError('Markdown budget cannot contain a code fence');
    const preferred = Math.min(
      budget,
      Math.max(unit === 'utf8' ? 4 : 2, soft - overhead),
    );
    const parts: string[] = [];
    let current = '';
    for (const line of value.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
      if (current && size(current + line) > preferred) {
        parts.push(current);
        current = '';
      }
      if (size(line) > budget) {
        const pieces = splitText(line, preferred);
        parts.push(...pieces.slice(0, -1));
        current = pieces.at(-1)!;
      } else current += line;
    }
    if (current || !parts.length) parts.push(current);
    return parts.map(
      (part) =>
        `${notice}${opening}\n${part}${part.endsWith('\n') ? '' : '\n'}${closing}`,
    );
  }

  function plainFallback(value: string, limit: number): string[] {
    const fence = fenceFor(value);
    return fencedParts(
      value,
      `${fence}text`,
      fence,
      limit,
      Math.min(targetLength, limit),
      fallbackNotice,
    );
  }

  const tree = parser.parse(text);
  const definitions = tree.children.filter(
    (node) => node.type === 'definition',
  );
  const suffix = definitions.length
    ? '\n\n' + definitions.map(source).join('\n')
    : '';
  const hard = maxLength - size(suffix);
  const target = Math.min(hard, Math.max(1, targetLength - size(suffix)));
  if (hard <= 0) return plainFallback(text, maxLength);

  function inlineParts(node: Nodes, soft: number, limit: number): string[] {
    if (!('children' in node)) return plainFallback(source(node), limit);
    const parts: string[] = [];
    let current = '';
    const flush = () => {
      if (current) parts.push(current);
      current = '';
    };
    for (const child of node.children) {
      const raw = source(child);
      if (child.type !== 'text') {
        if (current && size(current + raw) > soft) flush();
        if (size(raw) > limit) {
          flush();
          parts.push(...plainFallback(raw, limit));
        } else current += raw;
        continue;
      }
      let remaining = raw;
      while (remaining) {
        if (size(current) >= soft) flush();
        const budget = soft - size(current);
        // A code point may be wider than the remaining soft budget.
        const first = String.fromCodePoint(remaining.codePointAt(0)!);
        if (size(first) > budget && current) {
          flush();
          continue;
        }
        const piece = splitText(
          remaining,
          Math.max(budget, size(first)),
          true,
        )[0]!;
        if (size(piece) > limit)
          throw new RangeError('Markdown budget is too small');
        if (size(current + piece) > limit) flush();
        current += piece;
        remaining = remaining.slice(piece.length);
        if (remaining) flush();
      }
    }
    flush();
    return parts;
  }

  function splitBlock(
    node: RootContent,
    soft: number,
    limit: number,
  ): string[] {
    const raw = source(node);
    if (node.type === 'code') {
      const info = `${node.lang ?? ''}${node.meta ? ` ${node.meta}` : ''}`;
      const fence = fenceFor(node.value, info);
      const opening = fence + info;
      const normalized = `${opening}\n${node.value}\n${fence}`;
      if (size(normalized) <= limit) {
        // Preserve a closed source block verbatim; close unfinished fences.
        const lines = raw.split('\n');
        const opener = /^ {0,3}(`{3,}|~{3,})/u.exec(lines[0]!);
        const last = lines.at(-1)!.trim();
        const closed =
          opener &&
          lines.length > 1 &&
          new RegExp(`^${opener[1]![0]}{${opener[1]!.length},}\\s*$`, 'u').test(
            last,
          );
        return [closed && size(raw) <= limit ? raw : normalized];
      }
      if (size(opening + '\n\n' + fence) >= limit)
        return plainFallback(raw, limit);
      return fencedParts(node.value, opening, fence, limit, soft);
    }
    if (size(raw) <= soft) return [raw];
    if (node.type === 'table') {
      if (size(raw) <= limit) return [raw];
      const lines = raw.split('\n');
      const header = lines.slice(0, 2).join('\n');
      const parts: string[] = [];
      let current = header;
      for (const row of lines.slice(2)) {
        if (size(`${header}\n${row}`) > limit) {
          if (current !== header) parts.push(current);
          parts.push(...plainFallback(`${header}\n${row}`, limit));
          current = header;
        } else {
          if (current !== header && size(`${current}\n${row}`) > soft) {
            parts.push(current);
            current = header;
          }
          current += `\n${row}`;
        }
      }
      if (current !== header) parts.push(current);
      return parts.length ? parts : plainFallback(raw, limit);
    }
    if (node.type === 'heading') {
      return size(raw) <= limit ? [raw] : plainFallback(raw, limit);
    }
    if (node.type === 'paragraph') {
      return inlineParts(node, soft, limit);
    }
    if (node.type === 'list') {
      return node.children.flatMap((item) => {
        const itemText = source(item);
        if (size(itemText) <= limit) return [itemText];
        const marker = /^(\s*(?:[-+*]|\d+[.)])\s+)(?:\[[ xX]\]\s+)?/u.exec(
          itemText,
        )!;
        const prefix = marker[0];
        const indent = ' '.repeat(marker[1]!.length);
        const body = itemText
          .slice(prefix.length)
          .replace(new RegExp(`^ {1,${indent.length}}`, 'gm'), '');
        // Reserve indentation for every line before repacking the item.
        const pieces = splitMarkdown(body, {
          ...options,
          targetLength: Math.max(1, soft - size(prefix)),
          maxLength: limit - size(prefix),
        });
        const wrapped = pieces.map(
          (piece) => prefix + piece.replace(/\n/g, `\n${indent}`),
        );
        return wrapped.every((piece) => size(piece) <= limit)
          ? wrapped
          : plainFallback(itemText, limit);
      });
    }
    if (node.type === 'blockquote') {
      const body = raw.replace(/^ {0,3}> ?/gm, '');
      const pieces = splitMarkdown(body, {
        ...options,
        targetLength: Math.max(1, soft - 2),
        maxLength: limit - 2,
      });
      return pieces.flatMap((piece) => {
        const wrapped = piece.replace(/^/gm, '> ');
        return size(wrapped) <= limit ? [wrapped] : plainFallback(piece, limit);
      });
    }
    return size(raw) <= limit ? [raw] : plainFallback(raw, limit);
  }

  const chunks: string[] = [];
  let current = '';
  let headings = '';
  const flush = () => {
    if (current) chunks.push(current + suffix);
    current = '';
  };
  let previousEnd = 0;
  for (const node of tree.children) {
    const separator = text.slice(previousEnd, node.position!.start.offset!);
    previousEnd = node.position!.end.offset!;
    if (node.type === 'definition') continue;
    if (
      node.type === 'heading' &&
      size(headings + source(node) + '\n\n') <= hard - 4
    ) {
      headings += source(node) + '\n\n';
      continue;
    }
    const reserve = size(headings);
    const pieces = splitBlock(
      node,
      reserve < target ? target - reserve : Math.min(target, hard - reserve),
      hard - reserve,
    );
    for (const [index, piece] of pieces.entries()) {
      if (
        index > 0 &&
        (piece.startsWith(fallbackNotice) ||
          pieces[index - 1]!.startsWith(fallbackNotice))
      )
        flush();
      const joiner =
        index === 0 ? separator : node.type === 'paragraph' ? '' : '\n\n';
      const next = (index === 0 ? headings : '') + piece;
      const combined = current ? `${current}${joiner}${next}` : next;
      if (current && size(combined) > target) flush();
      current = current ? `${current}${joiner}${next}` : next;
    }
    headings = '';
  }
  if (headings) {
    flush();
    current = headings.trimEnd();
  }
  flush();
  return chunks.length ? chunks : [text];
}
