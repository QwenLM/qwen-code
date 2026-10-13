import type { RootContent, Nodes, Definition } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

export interface MarkdownChunkOptions {
  targetLength: number;
  maxLength: number;
  unit: 'utf16' | 'utf8';
}

const parser = unified().use(remarkParse).use(remarkGfm);
const blockParser = unified().use(remarkParse);
const fallbackNotice =
  '> Markdown element exceeds the message limit; original text follows in parts.\n\n';

/** Split at Markdown boundaries, retaining source spelling (especially URLs). */
export function splitMarkdown(
  text: string,
  options: MarkdownChunkOptions,
): string[] {
  return chunkMarkdown(text, options, 0);
}

function chunkMarkdown(
  text: string,
  options: MarkdownChunkOptions,
  depth: number,
  measure?: (value: string) => number,
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
  const size =
    measure ??
    ((value: string) =>
      unit === 'utf8' ? Buffer.byteLength(value, 'utf8') : value.length);
  const minimum = size(`${fallbackNotice}\`\`\`text\n\n\`\`\``) + 4;
  if (size(text) <= targetLength && !/`{3}|~{3}/u.test(text)) return [text];
  const source = (node: Nodes) =>
    text.slice(node.position!.start.offset!, node.position!.end.offset!);
  const closedFence = (raw: string) => {
    const lines = raw.split('\n');
    const opener = /^ {0,3}(`{3,}|~{3,})/u.exec(lines[0]!);
    return (
      !opener ||
      (lines.length > 1 &&
        new RegExp(
          `^ {0,3}${opener[1]![0]}{${opener[1]!.length},}[ \\t]*\\r?$`,
          'u',
        ).test(lines.at(-1)!))
    );
  };
  // A fence nested in a quote or list keeps the container prefix on its
  // closing line, so closure must be tested with those prefixes stripped.
  const bareFenceSource = (node: Nodes) => {
    const indent = Math.max(0, (node.position!.start.column ?? 1) - 1);
    const stripped = source(node).replace(/^ {0,3}> ?/gm, '');
    return indent
      ? stripped.replace(new RegExp(`^ {0,${indent}}`, 'gm'), '')
      : stripped;
  };

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
    hardBudget = budget,
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
      }
      if (firstOnly && end < value.length) {
        const whitespace = /^\s+/u.exec(value.slice(end))?.[0].length ?? 0;
        if (whitespace) {
          if (size(value.slice(0, end + whitespace)) <= budget)
            end += whitespace;
          // Back off only when the run would open a continuation line with
          // four spaces or a tab, which re-parses as an indented code block;
          // backing off a harmless run could cut a character reference.
          else if (
            /(?:^|\n)(?: {4}|\t)/u.test(value.slice(end, end + whitespace))
          ) {
            let before = end;
            while (before && /\s/u.test(value[before - 1]!)) before--;
            if (before > 1) {
              const head = value.slice(0, before);
              const reduced = size(head) - 1;
              // A reduced budget too small for the first code point would
              // throw out of fitEnd; keep the wider cut instead.
              if (reduced >= size(String.fromCodePoint(head.codePointAt(0)!)))
                end = fitEnd(head, reduced);
            }
          }
        }
      }
      if (firstOnly && end < value.length) {
        const ampersand = value.lastIndexOf('&', end - 1);
        if (firstOnly && ampersand >= 0) {
          const entity = /^&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/iu.exec(
            value.slice(ampersand),
          );
          if (entity && ampersand + entity[0].length > end) {
            end =
              ampersand ||
              (size(entity[0]) <= hardBudget ? entity[0].length : end);
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
    // A budget below the smallest wrapped fallback is a caller error.
    if (budget <= 0 && limit < minimum)
      throw new RangeError('Markdown budget cannot contain a code fence');
    const preferred = Math.min(
      budget,
      Math.max(unit === 'utf8' ? 4 : 2, soft - overhead),
    );
    if (preferred < soft / 2 || Math.ceil(size(value) / preferred) > 256) {
      const info = opening.slice(closing.length).trimStart();
      const bodyBudget = Math.floor(
        Math.min(soft, limit - size(notice + info + '\n\n') - 8) / 3,
      );
      return splitText(value, bodyBudget).map((part) => {
        const fence = fenceFor(part, info);
        const separator = info.startsWith(fence[0]!) ? ' ' : '';
        return `${notice}${fence}${separator}${info}\n${part}${!notice && part.endsWith('\n') ? '' : '\n'}${fence}`;
      });
    }
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
        `${notice}${opening}\n${part}${!notice && part.endsWith('\n') ? '' : '\n'}${closing}`,
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

  if (depth >= 16) return plainFallback(text, maxLength);
  // GFM table bodies parse quadratically. For large documents, identify
  // blocks with CommonMark and validate only each table's two header lines.
  const large = size(text) > 100_000;
  const tree = (large ? blockParser : parser).parse(text);
  if (large) {
    const references = new Map<string, string>();
    for (const node of tree.children) {
      if (node.type === 'definition') {
        const id = node.identifier.toUpperCase();
        if (!references.has(id)) references.set(id, source(node));
      }
    }
    const parseAt = (raw: string, offset: number) => {
      const context = new Set<string>();
      for (const match of raw.matchAll(/\[((?:\\.|[^[\]\\])*)\]/gu)) {
        const id = match[1]!
          .replace(/[\t\n\r ]+/g, ' ')
          .replace(/^ | $/g, '')
          .toLowerCase()
          .toUpperCase();
        const definition = references.get(id);
        if (definition) context.add(definition);
      }
      const children = parser
        .parse(raw + (context.size ? '\n\n' + [...context].join('\n') : ''))
        .children.filter((node) => node.type !== 'definition');
      const shift = (child: Nodes) => {
        if (child.position) {
          child.position.start.offset! += offset;
          child.position.end.offset! += offset;
        }
        if ('children' in child) child.children.forEach(shift);
      };
      children.forEach(shift);
      return children;
    };
    tree.children = tree.children.flatMap((node): RootContent[] => {
      if (node.type !== 'paragraph') return [node];
      const raw = source(node);
      const lines = raw.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
      let offset = 0;
      for (let i = 1; i < lines.length; i++) {
        const header = lines[i - 1]!;
        const delimiter = lines[i]!;
        if (/^[ \t|:-]+\r?\n?$/u.test(delimiter)) {
          const table = parser.parse(header + delimiter).children[0];
          if (table?.type === 'table') {
            const prefix = raw.slice(0, offset);
            const before = parseAt(prefix, node.position!.start.offset!);
            table.position = {
              start: {
                ...node.position!.start,
                offset: node.position!.start.offset! + offset,
              },
              end: node.position!.end,
            };
            return [...before, table];
          }
        }
        offset += header.length;
      }
      return parseAt(raw, node.position!.start.offset!);
    });
  }
  const definitions: Definition[] = [];
  let unfinishedFence = false;
  const collect = (node: Nodes) => {
    if (node.type === 'definition') definitions.push(node);
    if (node.type === 'code' && !closedFence(bareFenceSource(node)))
      unfinishedFence = true;
    if ('children' in node) node.children.forEach(collect);
  };
  collect(tree);
  if (size(text) <= targetLength && !unfinishedFence) return [text];
  const suffix = definitions.length
    ? '\n\n' + definitions.map(source).join('\n')
    : '';
  const hard = maxLength - size(suffix);
  const target = Math.min(
    hard,
    targetLength - Math.min(size(suffix), Math.floor(targetLength / 2)),
  );
  // A body window below the floor degenerates into mostly-duplicated messages
  // that each re-carry the suffix; degrade the whole document instead. A
  // nested level whose inherited budget cannot hold its own wrapped fallback
  // hands the source back to its parent, whose wider budget can degrade.
  const floor = Math.max(minimum, Math.floor(targetLength / 2));
  if (hard < floor) {
    if (maxLength >= floor) return plainFallback(text, maxLength);
    if (depth > 0) return [text];
  }

  function inlineParts(node: Nodes, soft: number, limit: number): string[] {
    if (!('children' in node)) return plainFallback(source(node), limit);
    // GFM escaped autolink literals can lose their inline source positions.
    if (node.children.some((child) => !child.position)) {
      const raw = source(node);
      return size(raw) <= limit ? [raw] : plainFallback(raw, limit);
    }
    const parts: string[] = [];
    let current = '';
    const flush = () => {
      if (current) parts.push(current);
      current = '';
    };
    for (const child of node.children) {
      const raw = source(child);
      if (child.type !== 'text') {
        if (
          current &&
          size(current + raw) > soft &&
          !(
            size(raw) > soft &&
            size(current) < soft / 2 &&
            size(current + raw) <= limit
          )
        )
          flush();
        if (size(raw) > limit) {
          flush();
          parts.push(...plainFallback(raw, limit));
        } else current += raw;
        continue;
      }
      let remaining = raw;
      if (
        size(current) > soft &&
        size(raw) < soft / 2 &&
        size(current + raw) <= limit
      ) {
        current += raw;
        continue;
      }
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
          limit,
        )[0]!;
        if (size(piece) > limit)
          throw new RangeError('Markdown budget is too small');
        if (size(current + piece) > limit) flush();
        current += piece;
        remaining = remaining.slice(piece.length);
        if (remaining) flush();
      }
    }
    const end = node.children.at(-1)?.position?.end.offset;
    if (end !== undefined) {
      const tail = text.slice(end, node.position!.end.offset!);
      if (size(current + tail) > limit) flush();
      current += tail;
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
      // A separator keeps an info string starting with the fence character
      // from extending the opening run beyond the closing fence.
      const opening = info.startsWith(fence[0]!)
        ? `${fence} ${info}`
        : fence + info;
      const normalized = `${opening}\n${node.value}\n${fence}`;
      if (size(normalized) <= limit) {
        // Preserve a closed source block verbatim; close unfinished fences.
        return [closedFence(raw) && size(raw) <= limit ? raw : normalized];
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
      return node.children.flatMap((item, index) => {
        const itemText = source(item);
        const gap = index
          ? text.slice(
              node.children[index - 1]!.position!.end.offset!,
              item.position!.start.offset!,
            )
          : '';
        if (size(itemText) <= soft) return [gap + itemText];
        const marker = /^(\s*(?:[-+*]|\d+[.)])\s+)(?:\[[ xX]\]\s+)?/u.exec(
          itemText,
        )!;
        const prefix = marker[0];
        const indent = ' '.repeat(marker[1]!.length);
        const bareIndent = ' '.repeat(marker[1]!.length);
        const body = itemText
          .slice(prefix.length)
          .replace(new RegExp(`^ {1,${indent.length}}`, 'gm'), '');
        const wrap = (piece: string) => {
          piece = piece.replace(/^\s*\n/u, '');
          const nested = /^(?:[-+*]|\d+[.)])\s/u.test(piece);
          // A piece that opens a block construct cannot stay on the marker
          // line (only paragraph text can follow a marker); give it its own
          // line under the bare bullet and drop the checkbox, which is only
          // recognized inline.
          if (!nested && /^(?:`{3,}|~{3,}|#{1,6}(?:\s|$)|>|\|)/u.test(piece))
            return (
              `${marker[1]!.trimEnd()}\n${bareIndent}` +
              piece.replace(/\n/g, `\n${bareIndent}`)
            );
          const head = nested ? `${prefix.trimEnd()}\n${indent}` : prefix;
          return head + piece.replace(/\n/g, `\n${indent}`);
        };
        const pieces = chunkMarkdown(
          body,
          { ...options, targetLength: soft, maxLength: limit },
          depth + 1,
          // Continuation pieces emit with a leading newline; reserve it.
          (value) => (value ? size(wrap(value)) + 1 : 0),
        ).map(wrap);
        if (gap) pieces[0] = gap + pieces[0];
        // Continuation pieces of a chunked item open with the marker and no
        // leading newline; without their own line break a piece can fuse
        // with the previous piece's last line, breaking a fence or marker.
        return pieces.map((piece, pieceIndex) =>
          pieceIndex === 0 ? piece : `\n${piece}`,
        );
      });
    }
    if (node.type === 'blockquote') {
      const body = raw.replace(/^ {0,3}> ?/gm, '');
      // Blank quoted lines keep a bare marker: an unprefixed empty line would
      // terminate the quote and tear a quoted code block apart.
      const wrap = (piece: string) => {
        const lines = piece.split('\n');
        const last = lines.length - 1;
        return lines
          .map((line, i) =>
            i === last && line === '' ? line : line === '' ? '>' : `> ${line}`,
          )
          .join('\n');
      };
      return chunkMarkdown(
        body,
        { ...options, targetLength: soft, maxLength: limit },
        depth + 1,
        (value) => (value ? size(wrap(value)) : 0),
      ).map(wrap);
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
  let headingSeparator = '';
  for (const node of tree.children) {
    const separator = text.slice(previousEnd, node.position!.start.offset!);
    previousEnd = node.position!.end.offset!;
    if (node.type === 'definition') continue;
    const raw = source(node);
    if (
      node.type === 'heading' &&
      size(headings + separator + raw) <=
        hard - Math.max(minimum, Math.floor(target / 2)) &&
      (!headings || size(headings + separator + raw) <= target)
    ) {
      if (!headings) headingSeparator = separator;
      headings += (headings ? separator : '') + raw;
      continue;
    }
    const leading = headings ? headingSeparator : separator;
    const head = headings ? headings + separator : '';
    const reserve = size(head);
    if ((head && reserve >= hard - minimum) || size(leading) > hard) {
      flush();
      chunks.push(...plainFallback(leading + head + raw + suffix, maxLength));
      headings = '';
      headingSeparator = '';
      continue;
    }
    const available = target - size(current + leading + head);
    const soft = Math.min(
      hard - reserve,
      node.type === 'paragraph' &&
        size(raw) > available &&
        available > target / 2 &&
        (size(raw) > target || (current && size(current) < target / 4))
        ? available
        : Math.max(1, target - Math.min(reserve, Math.floor(target / 2))),
    );
    const pieces = splitBlock(node, soft, hard - reserve);
    for (const [index, piece] of pieces.entries()) {
      if (
        index > 0 &&
        (piece.startsWith(fallbackNotice) ||
          pieces[index - 1]!.startsWith(fallbackNotice))
      )
        flush();
      const joiner =
        index === 0
          ? leading
          : node.type === 'paragraph' || node.type === 'list'
            ? ''
            : '\n\n';
      let next = (index === 0 ? head : '') + piece;
      if (!current && joiner) next = joiner + next;
      const combined = current ? `${current}${joiner}${next}` : next;
      if (current && size(combined) > target) {
        if (index === 0) {
          // A joiner ending in spaces or tabs carries the next block's
          // indentation; keep it with that block instead of flushing it
          // with the current chunk.
          if (size(current + joiner) <= target && !/[ \t]$/u.test(joiner))
            current += joiner;
          else next = joiner + next;
        }
        flush();
      }
      if (size(next) > hard) {
        flush();
        chunks.push(...plainFallback(next + suffix, maxLength));
        continue;
      }
      current = current ? `${current}${joiner}${next}` : next;
    }
    headings = '';
    headingSeparator = '';
  }
  if (headings) {
    const tail = current + headingSeparator + headings;
    if (current && size(tail) > target) {
      if (size(current + headingSeparator) <= hard) current += headingSeparator;
      else headings = headingSeparator + headings;
      flush();
    }
    current = current
      ? tail
      : size(headingSeparator + headings) <= hard
        ? headingSeparator + headings
        : headings;
  }
  if (!definitions.length && current) {
    const tail = text.slice(previousEnd);
    if (size(current + tail) <= hard) current += tail;
    else {
      flush();
      chunks.push(...plainFallback(tail, maxLength));
    }
  }
  flush();
  return chunks.length
    ? chunks
    : size(text) <= maxLength
      ? [text]
      : plainFallback(text, maxLength);
}
