import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Nodes } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { splitMarkdown } from './markdown-chunks.js';
import type { MarkdownChunkOptions } from './markdown-chunks.js';

const parser = unified().use(remarkParse).use(remarkGfm);
const fixture = readFileSync(
  new URL('./fixtures/knowledge-search.md', import.meta.url),
  'utf8',
);
const defaults: MarkdownChunkOptions = {
  targetLength: 3800,
  maxLength: 20_000,
  unit: 'utf16',
};
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
  nodes(text).flatMap((node) => (node.type === 'code' ? [node.value] : []));
const rows = (text: string) =>
  nodes(text).flatMap((node) =>
    node.type === 'table'
      ? node.children.slice(1).map((row) =>
          row.children
            .map((cell) =>
              cell.children
                .filter((child) => child.type === 'text')
                .map((child) => child.value)
                .join(''),
            )
            .join('|'),
        )
      : [],
  );

function checkBudget(chunks: string[], options = defaults) {
  for (const chunk of chunks) {
    expect(
      options.unit === 'utf8' ? Buffer.byteLength(chunk) : chunk.length,
    ).toBeLessThanOrEqual(options.maxLength);
    expect(chunk.isWellFormed()).toBe(true);
  }
}

describe.each(['utf16', 'utf8'] as const)('Markdown chunks (%s)', (unit) => {
  const options = { ...defaults, unit };
  const split = (text: string) => splitMarkdown(text, options);

  it('retains all 12 original citation URLs and all six table rows in multiple messages', () => {
    const chunks = split(fixture);
    expect(chunks.length).toBeGreaterThan(1);
    expect(links(fixture)).toHaveLength(12);
    expect(chunks.flatMap(links)).toEqual(links(fixture));
    expect(chunks.flatMap(rows)).toEqual(rows(fixture));
    expect(chunks.flatMap(rows)).toHaveLength(6);
    for (const url of links(fixture))
      expect(chunks.some((chunk) => chunk.includes(url))).toBe(true);
    expect(chunks.find((chunk) => chunk.includes('买家与复购指标'))).toContain(
      '| 文档 | 内容摘要 |\n|---|---|',
    );
    checkBudget(chunks, options);
  });

  it('retains repeated links and rows when the complete response exceeds the hard limit', () => {
    const chunks = split([fixture, fixture, fixture].join('\n\n'));
    expect(chunks.flatMap(links)).toEqual([
      ...links(fixture),
      ...links(fixture),
      ...links(fixture),
    ]);
    expect(chunks.flatMap(rows)).toHaveLength(18);
    checkBudget(chunks, options);
  });

  it('splits near the target even below the hard limit, on paragraph and section boundaries', () => {
    const a = 'a'.repeat(1800);
    const b = 'b'.repeat(2100);
    expect(split(`${a}\n\n${b}`)).toEqual([a, b]);
    expect(split(`${a}\n\n## Heading\n\n${b}`)).toEqual([
      a,
      `## Heading\n\n${b}`,
    ]);
    const longSection = split(`## Heading\n\n${a}\n\n${b}`);
    expect(longSection).toEqual([`## Heading\n\n${a}`, b]);
  });

  it('keeps headings with a first table that is larger than the target', () => {
    const table = `| Name |\n| --- |\n| ${'x'.repeat(4000)} |`;
    expect(split(`## Heading\n\n${table}`)).toEqual([`## Heading\n\n${table}`]);
  });

  it('keeps large links and inline formatting intact', () => {
    const link = `[source](https://example.com/${'a'.repeat(5000)}#__dac_citation=%7B%22title%22%3A%22x%22%7D)`;
    const chunks = split(
      `${'a'.repeat(3700)} ${link} **bold _nested_** and \`code\``,
    );
    expect(chunks.flatMap(links)).toEqual(links(link));
    expect(chunks.some((chunk) => chunk.includes(link))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes('**bold _nested_**'))).toBe(
      true,
    );
    checkBudget(chunks, options);
  });

  it('splits Chinese and emoji at Unicode boundaries without losing text', () => {
    const text = '中文😀测试。'.repeat(1800);
    const chunks = split(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
    checkBudget(chunks, options);
  });

  it('splits oversized tables by complete rows with repeated headers', () => {
    const header = '| Name | Value |\n| --- | --- |';
    const data = Array.from(
      { length: 120 },
      (_, i) => `| Row ${i} | ${'中😀'.repeat(60)} |`,
    );
    const text = [header, ...data].join('\n');
    const chunks = split(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap(rows)).toEqual(rows(text));
    for (const chunk of chunks) {
      expect(chunk.startsWith(header)).toBe(true);
      expect(nodes(chunk).filter((node) => node.type === 'table')).toHaveLength(
        1,
      );
    }
    checkBudget(chunks, options);
  });

  it('preserves code languages and lines across oversized fences', () => {
    const value = Array.from(
      { length: 1200 },
      (_, i) => `const line${i} = '中😀';`,
    ).join('\n');
    const chunks = split(`~~~~typescript title\n${value}\n~~~~`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap(code).join('\n')).toBe(value);
    for (const chunk of chunks) {
      const block = parser.parse(chunk).children[0];
      expect(block).toMatchObject({
        type: 'code',
        lang: 'typescript',
        meta: 'title',
      });
    }
    checkBudget(chunks, options);
  });

  it('splits a long code line and closes unfinished fences', () => {
    const value = '中😀'.repeat(9000);
    const chunks = split('```sql\n' + value);
    expect(chunks.flatMap(code).join('')).toBe(value);
    checkBudget(chunks, options);
    expect(split('```sql\nselect 1')).toEqual(['```sql\nselect 1\n```']);
  });

  it('shows a notice and sends every character of an oversized indivisible link as code', () => {
    const raw = `[source](https://example.com/${'中😀'.repeat(9000)})`;
    const chunks = split(raw);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap(code).join('')).toBe(raw);
    for (const chunk of chunks)
      expect(chunk).toContain('original text follows in parts');
    checkBudget(chunks, options);
  });

  it('retains reference definitions in each message that could use them', () => {
    const text = `${'a'.repeat(3500)} [one][ref]\n\n${'b'.repeat(3500)} [two][ref]\n\n[ref]: https://example.com/path%20x "Title"`;
    const chunks = split(text);
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) {
      expect(nodes(chunk).some((node) => node.type === 'linkReference')).toBe(
        true,
      );
      expect(chunk).toContain('[ref]: https://example.com/path%20x "Title"');
    }
    checkBudget(chunks, options);
  });

  it('preserves list items and quote blocks', () => {
    const text = `- ${'a'.repeat(2500)}\n- ${'b'.repeat(2500)}\n\n> ${'q'.repeat(4500)}`;
    const chunks = split(text);
    expect(
      chunks.flatMap((chunk) =>
        nodes(chunk).filter((node) => node.type === 'listItem'),
      ),
    ).toHaveLength(2);
    expect(
      chunks.flatMap((chunk) =>
        nodes(chunk).filter((node) => node.type === 'blockquote'),
      ).length,
    ).toBeGreaterThan(0);
    checkBudget(chunks, options);
  });
});

it('honors the exact soft and hard boundaries', () => {
  expect(splitMarkdown('x'.repeat(3800), defaults)).toHaveLength(1);
  expect(splitMarkdown('x'.repeat(3801), defaults)).toHaveLength(2);
  const link = (length: number) => `[x](https://x/${'a'.repeat(length - 15)})`;
  expect(link(20_000)).toHaveLength(20_000);
  expect(splitMarkdown(link(20_000), defaults)).toEqual([link(20_000)]);
  expect(
    splitMarkdown(link(20_001), defaults).every(
      (chunk) => code(chunk).length === 1,
    ),
  ).toBe(true);
});

it('counts generated headers, fences and caller prefixes in both budgets', () => {
  const prefix = '来源😀\n\n';
  for (const unit of ['utf16', 'utf8'] as const) {
    const count = (text: string) =>
      unit === 'utf8' ? Buffer.byteLength(text) : text.length;
    const overhead = count(prefix);
    const options = {
      targetLength: 3800 - overhead,
      maxLength: 20_000 - overhead,
      unit,
    };
    const chunks = splitMarkdown(
      '```js\n' + 'x'.repeat(45_000) + '\n```',
      options,
    ).map((chunk) => prefix + chunk);
    expect(chunks.length).toBeGreaterThan(1);
    checkBudget(chunks, { ...defaults, unit });
  }
});

it('packs small sections and list items near the target instead of sending each one', () => {
  expect(
    splitMarkdown('# One\n\nshort\n\n# Two\n\nshort', defaults),
  ).toHaveLength(1);
  const items = Array.from(
    { length: 80 },
    (_, i) => `- ${i}: ${'a'.repeat(80)}`,
  ).join('\n');
  const chunks = splitMarkdown(items, defaults);
  expect(chunks).toHaveLength(2);
  expect(
    chunks.flatMap((chunk) =>
      nodes(chunk).filter((node) => node.type === 'listItem'),
    ),
  ).toHaveLength(80);
});

it('retains long headings and their first paragraph together', () => {
  const text = `## ${'h'.repeat(4000)}\n\nfirst paragraph`;
  expect(splitMarkdown(text, defaults)).toEqual([text]);
});

it('does not cut character references or escaped punctuation', () => {
  for (const element of ['&amp;', '&#128512;', '\\*']) {
    const text = 'a'.repeat(3799) + element + 'b'.repeat(100);
    const chunks = splitMarkdown(text, defaults);
    expect(chunks.join('')).toBe(text);
    expect(chunks.some((chunk) => chunk.includes(element))).toBe(true);
  }
});

it('chooses fences that cannot close on code exposed by a long-line cut', () => {
  const value = 'x'.repeat(3790) + '```' + ' '.repeat(20_000);
  const chunks = splitMarkdown(`~~~~ts\n${value}\n~~~~`, defaults);
  expect(chunks.flatMap(code).join('')).toBe(value);
  checkBudget(chunks);
  const backtickInfo = splitMarkdown(
    '~~~lang`name\n' + 'x'.repeat(25_000) + '\n~~~',
    defaults,
  );
  expect(
    backtickInfo.every(
      (chunk) => parser.parse(chunk).children[0]?.type === 'code',
    ),
  ).toBe(true);
  expect(backtickInfo.flatMap(code).join('')).toBe('x'.repeat(25_000));
});

it('keeps plain-text fallback fences separate from surrounding paragraph text', () => {
  const element = '**' + 'x\n'.repeat(11_000) + 'x**';
  const chunks = splitMarkdown(`before ${element} after`, defaults);
  expect(chunks[0]).toBe('before ');
  expect(chunks.at(-1)).toBe(' after');
  expect(chunks.flatMap(code).join('\n')).toBe(element);
  checkBudget(chunks);
});

it('allows fence overhead and Unicode characters to exceed only the soft target', () => {
  const options = { targetLength: 8, maxLength: 64, unit: 'utf8' } as const;
  const value = '😀'.repeat(100);
  const chunks = splitMarkdown('```js\n' + value + '\n```', options);
  expect(chunks.flatMap(code).join('')).toBe(value);
  checkBudget(chunks, options);
});

it('keeps hard budgets when a character reference exceeds the remaining soft space', () => {
  const options = { targetLength: 12, maxLength: 12, unit: 'utf16' } as const;
  const text = '**a** &amp;! remainder';
  const chunks = splitMarkdown(text, options);
  expect(chunks.join('')).toBe(text);
  checkBudget(chunks, options);
  const unicode = splitMarkdown('\\😀'.repeat(10), {
    ...defaults,
    targetLength: 1,
  });
  expect(unicode.join('')).toBe('\\😀'.repeat(10));
  checkBudget(unicode);
});
