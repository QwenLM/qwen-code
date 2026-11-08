import type { Nodes, RootContent } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

export interface MarkdownChunkOptions {
  targetLength: number;
  maxLength: number;
  unit: 'utf16' | 'utf8';
  /** Per-message prefix already subtracted from the content budgets. */
  reservedLength?: number;
}

const blocks = unified().use(remarkParse);
const gfm = unified().use(remarkParse).use(remarkGfm);
const candidateOverflow = Symbol('Markdown candidate exceeds batch budget');
const notice =
  '> Markdown element exceeds the message limit; original text follows in parts.\n\n';

export function splitMarkdown(
  text: string,
  options: MarkdownChunkOptions,
): string[] {
  const { targetLength, maxLength, unit, reservedLength = 0 } = options;
  if (
    !Number.isSafeInteger(targetLength) ||
    !Number.isSafeInteger(maxLength) ||
    targetLength <= 0 ||
    maxLength < targetLength ||
    !Number.isSafeInteger(reservedLength) ||
    reservedLength < 0
  ) {
    throw new RangeError('Invalid Markdown chunk budget');
  }
  const size = (value: string) =>
    unit === 'utf8' ? Buffer.byteLength(value, 'utf8') : value.length;
  const length = size(text) + reservedLength;
  const maxOutput = 4 * length + maxLength + reservedLength;
  // Relative limits bound amplification, never truncate a delivery batch.
  const fits = (parts: string[]) =>
    parts.length <=
      Math.max(1, 4 * Math.ceil(length / (targetLength + reservedLength))) &&
    parts.reduce((total, part) => total + size(part) + reservedLength, 0) <=
      maxOutput &&
    parts.every((part) => size(part) <= maxLength);
  const attempt = (target: number, depth: number) => {
    try {
      const parts = split(text, target, maxLength, size, depth, maxOutput);
      return fits(parts) ? parts : undefined;
    } catch (error) {
      if (
        error !== candidateOverflow &&
        !(depth === 0 && error instanceof RangeError)
      )
        throw error;
      return undefined;
    }
  };
  const preferred = attempt(
    reservedLength > targetLength ? maxLength : targetLength,
    0,
  );
  if (preferred) return preferred;
  const expanded = attempt(maxLength, 0);
  if (expanded) return expanded;
  // Re-plan from the original source, without repeated container context.
  const literal = attempt(maxLength, 16);
  if (literal) return literal;
  throw new RangeError(
    'Markdown budget cannot contain a bounded lossless batch',
  );
}

function split(
  text: string,
  target: number,
  maximum: number,
  size: (value: string) => number,
  depth: number,
  maxOutput: number,
): string[] {
  // Intermediate arrays can contain pieces later packed together. Bound their
  // output size, not their count, without charging the same pieces twice.
  const totals = new WeakMap<string[], number>();
  const append = (parts: string[], ...values: string[]) => {
    let total =
      totals.get(parts) ?? parts.reduce((sum, part) => sum + size(part), 0);
    for (const part of values) {
      total += size(part);
      if (total > maxOutput) throw candidateOverflow;
      parts.push(part);
    }
    totals.set(parts, total);
  };
  const source = (node: Nodes) =>
    text.slice(node.position!.start.offset!, node.position!.end.offset!);
  function cut(value: string, budget: number): number {
    let lo = 0;
    let hi = value.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size(value.slice(0, mid)) <= budget) lo = mid;
      else hi = mid - 1;
    }
    if (
      lo < value.length &&
      /[\uD800-\uDBFF]/u.test(value[lo - 1] ?? '') &&
      /[\uDC00-\uDFFF]/u.test(value[lo]!)
    )
      lo--;
    if (!lo && value)
      throw new RangeError(
        'Markdown budget cannot contain one Unicode character',
      );
    return lo;
  }
  function fence(value: string, info: string): string {
    const char = info.includes('`') ? '~' : '`';
    let length = 3;
    for (const run of value.matchAll(new RegExp(`${char}+`, 'g'))) {
      length = Math.max(length, run[0].length + 1);
    }
    return char.repeat(length);
  }
  function plain(value: string, limit: number): string[] {
    const result: string[] = [];
    while (value) {
      // At most two extra copies of the body length are needed for safe fences.
      const budget = Math.max(
        size('😀'),
        size(String.fromCodePoint(value.codePointAt(0)!)),
        Math.floor((limit - size(notice + '```text\n\n```')) / 3),
      );
      const end = cut(value, budget);
      const part = value.slice(0, end);
      const marker = fence(part, 'text');
      const chunk = `${notice}${marker}text\n${part}\n${marker}`;
      if (size(chunk) > limit)
        throw new RangeError(
          'Markdown budget cannot contain a fenced fragment',
        );
      append(result, chunk);
      value = value.slice(end);
    }
    return result;
  }
  if (size(text) <= target && !/`{3}|~{3}/u.test(text)) return [text];
  if (depth >= 16) return plain(text, maximum);
  const tree = blocks.parse(text);
  const definitions = tree.children.filter(
    (node) => node.type === 'definition',
  );
  const suffix = definitions.length
    ? '\n\n' + definitions.map(source).join('\n')
    : '';
  const hard = maximum - size(suffix);
  const minimum = size(notice + '```text\n😀\n```');
  const soft = Math.min(
    target - size(suffix) >= minimum ? target - size(suffix) : target,
    hard,
  );
  if (hard < size(notice + '```text\n😀\n```')) return plain(text, maximum);
  const references = new Map(
    definitions.map((node) => [node.identifier.toUpperCase(), source(node)]),
  );

  function paragraph(raw: string, preferred: number, limit: number): string[] {
    const lines = raw.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
    let offset = 0;
    for (let i = 1; i < lines.length; i++) {
      const header = lines[i - 1]! + lines[i]!;
      // GFM's full table parser is quadratic on large bodies; validate two lines only.
      if (
        /^[ \t|:-]+\r?\n?$/u.test(lines[i]!) &&
        gfm.parse(header).children[0]?.type === 'table'
      ) {
        const before = offset
          ? paragraph(raw.slice(0, offset), preferred, limit)
          : [];
        const table = raw.slice(offset);
        if (size(table) <= limit) return [...before, table];
        const result = [...before];
        const tableStart = result.length;
        let current = header;
        for (const row of lines.slice(i + 1)) {
          if (size(header + row) > limit) {
            if (current !== header) append(result, current);
            append(result, ...plain(header + row, limit));
            current = header;
          } else {
            if (current !== header && size(current + row) > preferred) {
              append(result, current);
              current = header;
            }
            current += row;
          }
        }
        if (current !== header) append(result, current);
        if (result.length === tableStart)
          append(result, ...plain(table, limit));
        return result;
      }
      offset += lines[i - 1]!.length;
    }
    const context = new Set<string>();
    for (const match of raw.matchAll(/\[((?:\\.|[^[\]\\])*)\]/gu)) {
      const id = match[1]!
        .replace(/[\t\n\r ]+/g, ' ')
        .trim()
        .toUpperCase();
      const definition = references.get(id);
      if (definition) context.add(definition);
    }
    const node = gfm.parse(
      raw + (context.size ? '\n\n' + [...context].join('\n') : ''),
    ).children[0];
    if (
      node?.type !== 'paragraph' ||
      node.children.some((child) => !child.position)
    ) {
      return size(raw) <= limit ? [raw] : plain(raw, limit);
    }
    const result: string[] = [];
    let current = '';
    const flush = () => {
      if (current) {
        const becomesCode =
          /`{3}|~{3}/u.test(current) &&
          blocks.parse(current).children.some((node) => node.type === 'code');
        append(result, ...(becomesCode ? plain(current, limit) : [current]));
      }
      current = '';
    };
    for (const child of node.children) {
      let value = raw.slice(
        child.position!.start.offset!,
        child.position!.end.offset!,
      );
      if (child.type !== 'text') {
        if (current && size(current + value) > preferred) flush();
        if (size(value) > limit) {
          flush();
          append(result, ...plain(value, limit));
        } else current += value;
        continue;
      }
      while (value) {
        if (
          current &&
          size(current + String.fromCodePoint(value.codePointAt(0)!)) >
            preferred
        )
          flush();
        let end = cut(
          value,
          Math.max(
            size(String.fromCodePoint(value.codePointAt(0)!)),
            preferred - size(current),
          ),
        );
        if (end < value.length) {
          const candidate = value.slice(0, end);
          const boundary = [
            ...candidate.matchAll(/[。！？]|[.!?](?=\s)|\s+/gu),
          ].at(-1);
          if (boundary) end = boundary.index + boundary[0].length;
          const amp = value.lastIndexOf('&', end - 1);
          const entity =
            amp >= 0
              ? /^&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/iu.exec(value.slice(amp))
              : null;
          if (entity && amp + entity[0].length > end)
            end = amp || entity[0].length;
          if (/[`~]/u.test(value[end] ?? '') && value[end - 1] === value[end]) {
            const run = value.slice(0, end).match(/(`+|~+)$/u)!;
            end = run.index || /^(`+|~+)/u.exec(value)![0].length;
          }
          const escapes = value.slice(0, end).match(/\\+$/u)?.[0].length ?? 0;
          if (escapes % 2 && /[!-/:-@[-`{-~]/u.test(value[end]!))
            end = end > 1 ? end - 1 : 2;
        }
        const piece = value.slice(0, end);
        if (size(current + piece) > limit) flush();
        if (size(piece) > limit) append(result, ...plain(piece, limit));
        else current += piece;
        value = value.slice(end);
        if (value) flush();
      }
    }
    const tail = raw.slice(node.children.at(-1)?.position?.end.offset ?? 0);
    if (size(current + tail) > limit) flush();
    current += tail;
    flush();
    return result;
  }

  function block(
    node: RootContent,
    preferred: number,
    limit: number,
  ): string[] {
    const raw = source(node);
    if (node.type === 'code') {
      const opener = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r\n|[\r\n]|$)/u.exec(
        raw,
      );
      const closed =
        !opener ||
        new RegExp(
          `\\n {0,3}${opener[1]![0]}{${opener[1]!.length},}[ \\t]*\\r?$`,
          'u',
        ).test(raw);
      if (closed && size(raw) <= limit) return [raw];
      const info = opener ? opener[2]! : '';
      const marker = fence(node.value, info);
      const opening = marker + (info.startsWith(marker[0]!) ? ' ' : '') + info;
      const wrap = (part: string) =>
        `${opening}\n${part}${part.endsWith('\n') ? '' : '\n'}${marker}`;
      if (size(wrap(node.value)) <= limit) return [wrap(node.value)];
      const overhead = size(wrap(''));
      if (overhead >= limit) return plain(raw, limit);
      const budget =
        overhead < preferred / 2 ? preferred - overhead : limit - overhead;
      const result: string[] = [];
      let current = '';
      for (let line of node.value.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
        if (current && size(wrap(current + line)) > preferred) {
          append(result, wrap(current));
          current = '';
        }
        while (size(line) > Math.min(budget, limit - overhead)) {
          if (
            size(String.fromCodePoint(line.codePointAt(0)!)) >
            limit - overhead
          )
            return plain(raw, limit);
          const end = cut(
            line,
            Math.min(
              Math.max(
                budget,
                size(String.fromCodePoint(line.codePointAt(0)!)),
              ),
              limit - overhead,
            ),
          );
          append(result, wrap(line.slice(0, end)));
          line = line.slice(end);
        }
        current += line;
      }
      if (current) append(result, wrap(current));
      return result;
    }
    if (size(raw) <= preferred) return [raw];
    if (node.type === 'paragraph') return paragraph(raw, preferred, limit);
    if (node.type === 'blockquote') {
      const body = raw.replace(/^ {0,3}> ?/gm, '');
      const wrap = (part: string) =>
        part
          .split('\n')
          .map((line) => (line ? `> ${line}` : '>'))
          .join('\n');
      return split(
        body,
        preferred,
        limit,
        (value) => (value ? size(wrap(value)) : 0),
        depth + 1,
        maxOutput,
      ).map(wrap);
    }
    if (node.type === 'list') {
      const result: string[] = [];
      for (const [itemIndex, item] of node.children.entries()) {
        const nextItem = node.children[itemIndex + 1];
        const gap = nextItem
          ? text.slice(
              item.position!.end.offset!,
              nextItem.position!.start.offset!,
            )
          : '';
        const itemText = source(item);
        if (size(itemText) <= preferred) {
          append(result, itemText, gap);
          continue;
        }
        const marker =
          /^(\s*(?:[-+*]|\d+[.)])\s+)(?:\[[ xX]\](?:[ \t]+|(?=\r?\n|$)))?/u.exec(
            itemText,
          );
        if (!marker) {
          append(result, itemText, gap);
          continue;
        }
        const indent = ' '.repeat(marker[1]!.length);
        const body = itemText
          .slice(marker[0].length)
          .replace(/^[ \t]+/gm, (leading) => {
            let column = 0;
            let end = 0;
            while (end < leading.length && column < indent.length) {
              column += leading[end++] === '\t' ? 4 - (column % 4) : 1;
            }
            return (
              ' '.repeat(Math.max(0, column - indent.length)) +
              leading.slice(end)
            );
          });
        const wrap = (part: string) => {
          const head =
            /^(?:`{3,}|~{3,}|#{1,6}(?:\s|$)|>|\||[-+*] |\d+[.)] )/u.test(part)
              ? `${marker[0].trimEnd()}\n${indent}`
              : marker[0];
          return head + part.replace(/\n/g, `\n${indent}`);
        };
        const parts = split(
          body,
          preferred,
          limit,
          (value) => (value ? size(wrap(value) + '\n') : 0),
          depth + 1,
          maxOutput,
        ).map(
          (part, index, parts) =>
            wrap(part) + (index < parts.length - 1 ? '\n' : ''),
        );
        append(result, ...parts, gap);
      }
      return result;
    }
    return size(raw) <= limit ? [raw] : plain(raw, limit);
  }

  const result: string[] = [];
  let current = '';
  let heading = '';
  let previousEnd = 0;
  const flush = () => {
    if (current) append(result, current + suffix);
    current = '';
  };
  for (const node of tree.children) {
    const gap = text.slice(previousEnd, node.position!.start.offset!);
    previousEnd = node.position!.end.offset!;
    if (node.type === 'definition') continue;
    if (node.type === 'heading' && size(heading + gap + source(node)) < soft) {
      heading += gap + source(node);
      continue;
    }
    let head = heading ? heading + gap : '';
    let leading = heading ? '' : gap;
    heading = '';
    let reserve = size(head + leading);
    if (reserve && (reserve >= hard - minimum || soft - reserve < minimum)) {
      flush();
      append(
        result,
        ...split(head + leading, soft, hard, size, depth + 1, maxOutput).map(
          (part) => part + suffix,
        ),
      );
      head = '';
      leading = '';
      reserve = 0;
    }
    const pieces = block(node, Math.max(1, soft - reserve), hard - reserve);
    for (const [index, piece] of pieces.entries()) {
      let next = index === 0 ? head + piece : piece;
      const separator =
        index === 0 ? leading : node.type === 'list' ? '' : '\n\n';
      let prefix = index === 0 ? leading : '';
      if (
        current &&
        ((index > 0 && node.type !== 'list') ||
          size(current + separator + next) > soft)
      ) {
        if (
          index === 0 &&
          !/[ \t]$/u.test(separator) &&
          size(current + separator) <= hard
        ) {
          current += separator;
          prefix = '';
        }
        flush();
      }
      if (!current) next = prefix + next;
      if (size(next) > hard) {
        flush();
        append(result, ...plain(next + suffix, maximum));
      } else current = current ? current + separator + next : next;
    }
  }
  if (heading) {
    if (current && size(current + heading) > soft) flush();
    current += heading;
  }
  if (!definitions.length) {
    const tail = text.slice(previousEnd);
    if (size(current + tail) <= hard) current += tail;
    else {
      flush();
      append(result, ...plain(tail, maximum));
    }
  }
  flush();
  return result.length
    ? result
    : size(text) <= maximum
      ? [text]
      : plain(text, maximum);
}
