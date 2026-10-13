import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Nodes } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { splitMarkdown } from './markdown-chunks.js';

const parser = unified().use(remarkParse).use(remarkGfm);
const fixture = readFileSync(
  new URL('./fixtures/synthetic-knowledge-search.md', import.meta.url),
  'utf8',
);
function nodes(text: string): Nodes[] {
  const result: Nodes[] = [];
  const visit = (node: Nodes) => {
    result.push(node);
    if ('children' in node) node.children.forEach(visit);
  };
  visit(parser.parse(text));
  return result;
}
const links = (text: string) =>
  nodes(text).flatMap((node) => (node.type === 'link' ? [node.url] : []));
const code = (text: string) =>
  nodes(text).flatMap((node) => (node.type === 'code' ? [node] : []));
const rows = (text: string) =>
  nodes(text).flatMap((node) =>
    node.type === 'table'
      ? node.children
          .slice(1)
          .map((row) =>
            row.children
              .map((cell) =>
                cell.children
                  .map((child) => ('value' in child ? child.value : ''))
                  .join(''),
              )
              .join('|'),
          )
      : [],
  );

describe.each(['utf16', 'utf8'] as const)('Markdown chunks (%s)', (unit) => {
  const options = { targetLength: 3800, maxLength: 20_000, unit };
  const measure = (text: string) =>
    unit === 'utf8' ? Buffer.byteLength(text) : text.length;
  const split = (text: string) => {
    const parts = splitMarkdown(text, options);
    for (const part of parts) {
      expect(measure(part)).toBeLessThanOrEqual(20_000);
      expect(part.isWellFormed()).toBe(true);
    }
    return parts;
  };
  it('keeps synthetic citation URLs and all rows intact across multiple messages', () => {
    const parts = split(fixture);
    expect(parts.length).toBeGreaterThan(1);
    expect(links(fixture)).toHaveLength(12);
    expect(
      links(fixture).every(
        (url) => new URL(url).hostname === 'docs.example.com',
      ),
    ).toBe(true);
    expect(parts.flatMap(links)).toEqual(links(fixture));
    expect(parts.flatMap(rows)).toEqual(rows(fixture));
    expect(parts.flatMap(rows)).toHaveLength(6);
    for (const url of links(fixture))
      expect(parts.filter((part) => part.includes(url))).toHaveLength(1);
  });
  it('splits ordinary paragraphs near the target without cutting Unicode', () => {
    const text = '合成😀 prose. '.repeat(1500);
    const parts = split(text);
    expect(parts.join('')).toBe(text);
    expect(parts.every((part) => measure(part) <= 3800)).toBe(true);
  });
  it.each([
    '[source](https://docs.example.com/' + 'x'.repeat(6000) + ')',
    '`' + 'x'.repeat(6000) + '`',
    'https://docs.example.com/' + 'x'.repeat(6000),
    '~~' + 'x'.repeat(6000) + '~~',
    '| a | b |\n|---|---|\n| x |' + 'x'.repeat(6000) + '|',
    '```ts example\n' + 'x'.repeat(6000) + '\n```',
  ])(
    'keeps a complete structure above the target within the hard limit',
    (text) => {
      expect(split(text)).toEqual([text]);
    },
  );
  it('repeats exact table headers and never loses a row in a large document', () => {
    const header = '| key | value |\n|:---|---:|\n';
    const data = Array.from(
      { length: 900 },
      (_, index) => `| row-${index} | ${'x'.repeat(140)} |`,
    ).join('\n');
    const parts = split(header + data);
    expect(parts.every((part) => part.startsWith(header))).toBe(true);
    expect(parts.flatMap(rows)).toEqual(rows(header + data));
  });
  it('does not misclassify a pipe-free underline as a two-column table', () => {
    const text = 'lead '.repeat(900) + '\na | b\n-----\ntail';
    const parts = split(text);
    expect(parts.flatMap(rows)).toHaveLength(0);
    expect(parts.join('\n')).toContain('a | b');
  });
  it('retains the indentation that defines fenced code content', () => {
    const text = '  ```ts\n  x\n  ```';
    expect(
      split(text)
        .flatMap(code)
        .map((block) => block.value),
    ).toEqual(['x']);
    expect(split('```ts')[0]).toMatch(/\n```$/u);
  });
  it('splits oversized code at lines with language and metadata retained', () => {
    const body = Array.from(
      { length: 2000 },
      (_, index) => `line${index} 中😀`,
    ).join('\n');
    const text = `~~~ts example\n${body}\n~~~`;
    const parts = split(text);
    const blocks = parts.flatMap(code);
    expect(blocks.length).toBe(parts.length);
    expect(
      blocks.every((block) => block.lang === 'ts' && block.meta === 'example'),
    ).toBe(true);
    expect(blocks.map((block) => block.value).join('\n')).toBe(body);
  });
  it('splits an oversized code line and closes an unfinished fence', () => {
    const body = '中😀'.repeat(9000);
    const parts = split('```ts\n' + body);
    expect(
      parts
        .flatMap(code)
        .map((block) => block.value)
        .join(''),
    ).toBe(body);
    expect(parts.every((part) => part.endsWith('```'))).toBe(true);
  });
  it.each([
    '[source](https://docs.example.com/' + 'x'.repeat(21000) + ')',
    '| a | b |\n|---|---|\n| source |' + 'x'.repeat(21000) + '|',
  ])(
    'labels oversized indivisible source and retains it losslessly',
    (text) => {
      const parts = split(text);
      expect(
        parts.every((part) => part.includes('original text follows in parts')),
      ).toBe(true);
      expect(
        parts
          .flatMap(code)
          .map((block) => block.value)
          .join(''),
      ).toBe(text);
    },
  );
  it('retains headings with their first content and repeats reference definitions', () => {
    const url = 'https://docs.example.com/ref';
    const text =
      '# First\n\n' + 'hello [ref]. '.repeat(800) + '\n\n[ref]: ' + url;
    const parts = split(text);
    expect(parts[0]).toContain('# First\n\nhello [ref]');
    expect(parts.every((part) => part.includes('[ref]: ' + url))).toBe(true);
    expect(
      parts.flatMap(nodes).filter((node) => node.type === 'linkReference'),
    ).toHaveLength(800);
  });
  it('reserves large reference definitions before protecting entities', () => {
    const definition = '[ref]: https://docs.example.com/' + 'x'.repeat(19700);
    const text =
      'x'.repeat(4000) +
      '&' +
      '#0000000000000000000000000000065;' +
      '\n\n' +
      definition;
    const parts = split(text);
    expect(parts.every((part) => measure(part) <= 20000)).toBe(true);
  });
  it.each(['> ', '- '])(
    'splits long %s containers and retains their links',
    (marker) => {
      const text =
        marker + 'hello [source](https://docs.example.com/page) '.repeat(900);
      const parts = split(text);
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.every((part) => part.startsWith(marker))).toBe(true);
      expect(parts.flatMap(links)).toEqual(links(text));
    },
  );
  it('preserves code content in a list with tab-indented continuation lines', () => {
    const text = '- intro\n\t```ts\n\t' + 'x'.repeat(5000) + '\n\t```';
    const blocks = split(text).flatMap(code);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.lang).toBe('ts');
    expect(blocks[0]!.value).toBe('x'.repeat(5000));
  });
  it('splits lists at existing item boundaries', () => {
    const text = Array.from(
      { length: 1000 },
      (_, i) => `- item ${i} [source](https://docs.example.com/${i})`,
    ).join('\n');
    const parts = split(text);
    expect(parts.flatMap(links)).toEqual(links(text));
    expect(
      parts.every((part) => nodes(part).some((node) => node.type === 'list')),
    ).toBe(true);
  });
  it('keeps fallback within the hard budget when the soft budget is small', () => {
    for (const text of [
      '[source](https://docs.example.com/' + 'x'.repeat(201) + ')',
      '\n'.repeat(200) + '[ref]: https://docs.example.com/ref',
    ]) {
      const parts = splitMarkdown(text, {
        targetLength: 10,
        maxLength: 200,
        unit,
      });
      expect(parts.every((part) => measure(part) <= 200)).toBe(true);
      expect(
        parts
          .flatMap(code)
          .map((block) => block.value)
          .join(''),
      ).toBe(text);
    }
  });
  it('preserves escaped punctuation and character references across cuts', () => {
    const text = 'x'.repeat(3799) + '\\* &amp; ' + 'y'.repeat(5000);
    const parts = split(text);
    expect(parts.join('')).toBe(text);
    expect(parts.some((part) => part.includes('\\*'))).toBe(true);
    expect(parts.some((part) => part.includes('&amp;'))).toBe(true);
  });
});
