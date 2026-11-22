import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
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
  it('replans from source when nested container budgets cannot fit a fragment', () => {
    const text =
      Array.from(
        { length: 15 },
        (_, i) => '  '.repeat(i) + '- level ' + i,
      ).join('\n') +
      '\n' +
      '  '.repeat(15) +
      '\u0001'.repeat(32000);
    const parts = splitMarkdown(text, {
      targetLength: 1250,
      maxLength: 1250,
      unit,
    });
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => measure(part) <= 1250)).toBe(true);
    expect(
      parts
        .flatMap(code)
        .map((block) => block.value)
        .join(''),
    ).toBe(text);
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
  it.each(['js`&#10;~~~', '&#65; example\\*&#10;meta'])(
    'preserves source info when re-fencing encoded or escaped metadata: %s',
    (info) => {
      for (const newline of ['\n', '\r\n', '\r']) {
        for (const closed of [false, true]) {
          const body = '<span> synthetic **text** </span>'.repeat(900);
          const text = `~~~${info}${newline}${body}${closed ? `${newline}~~~` : ''}`;
          const original = code(text)[0]!;
          const parts = split(text);
          const blocks = parts.flatMap(code);
          expect(blocks).toHaveLength(parts.length);
          expect(blocks.every((block) => block.lang === original.lang)).toBe(
            true,
          );
          expect(blocks.every((block) => block.meta === original.meta)).toBe(
            true,
          );
          expect(blocks.map((block) => block.value).join('')).toBe(body);
          expect(
            parts.every((part) => part.split('\n')[0]!.endsWith(info)),
          ).toBe(true);
          expect(
            parts.flatMap(nodes).some((node) => node.type === 'html'),
          ).toBe(false);
        }
      }
    },
  );
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
    expect(parts.length).toBeLessThanOrEqual(
      4 * Math.ceil(measure(text) / 3800),
    );
    expect(
      parts.every((part) => part.includes('original text follows in parts')),
    ).toBe(true);
    expect(
      parts
        .flatMap(code)
        .map((block) => block.value)
        .join(''),
    ).toBe(text);
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
  it('retains deeply nested list content when the depth fallback begins with a newline', () => {
    const body = 'tail ' + 'y'.repeat(6000);
    const text =
      Array.from(
        { length: 16 },
        (_, i) => ' '.repeat(2 * i) + '- level' + i,
      ).join('\n') +
      '\n' +
      ' '.repeat(32) +
      body;
    const parts = split(text);
    expect(
      parts
        .flatMap(code)
        .map((block) => block.value)
        .join(''),
    ).toContain(body);
  });
  it.each(['> quoted body', '- item body', 'x'.repeat(3000)])(
    'keeps content after a gap that consumes the target',
    (body) => {
      for (const length of [3801, 19895, 19900]) {
        const text = '\n'.repeat(length) + body;
        const parts = split(text);
        expect(parts.length).toBeLessThan(20);
        expect(parts.join('')).toBe(text);
      }
    },
  );
  it('keeps bare list items after a nearly full heading', () => {
    const text = '# ' + 'h'.repeat(3795) + '\n\n1.\n\nrest';
    expect(split(text).join('')).toBe(text);
  });
  it('retains heading references when their reserved budget is exhausted', () => {
    const definition = '[ref]: https://docs.example.com/ref';
    const text = '# [ref] ' + 'h'.repeat(3740) + '\n\nbody\n\n' + definition;
    const parts = split(text);
    expect(parts.every((part) => part.includes(definition))).toBe(true);
    expect(
      parts.flatMap(nodes).filter((node) => node.type === 'linkReference'),
    ).toHaveLength(1);
  });
  it('preserves large code metadata without one-character fragments', () => {
    const language = 'x'.repeat(3797);
    const body = 'y'.repeat(30000);
    const blocks = split('```' + language + '\n' + body + '\n```').flatMap(
      code,
    );
    expect(blocks.length).toBeLessThan(100);
    expect(blocks.every((block) => block.lang === language)).toBe(true);
    expect(blocks.map((block) => block.value).join('')).toBe(body);
  });
  it.each([10500, 11000, 15000])(
    'retains affordable code language and metadata above half the hard budget (%s)',
    (length) => {
      const metadata = 'x'.repeat(length - 3);
      const body = '中😀y'.repeat(7500);
      const parts = split('```ts ' + metadata + '\n' + body + '\n```');
      const blocks = parts.flatMap(code);
      expect(blocks).toHaveLength(parts.length);
      expect(
        blocks.every((block) => block.lang === 'ts' && block.meta === metadata),
      ).toBe(true);
      expect(blocks.map((block) => block.value).join('')).toBe(body);
      expect(
        parts.every((part) => !part.includes('original text follows in parts')),
      ).toBe(true);
    },
  );
  it.each([10500, 11000])(
    'retains affordable large table headers and every row (%s)',
    (length) => {
      const header = '| ' + 'h'.repeat(length) + ' |\n|---|\n';
      const data = Array.from(
        { length: 100 },
        (_, i) => '| row-' + i + ' ' + '中😀'.repeat(100) + ' |',
      ).join('\n');
      const parts = split(header + data);
      expect(parts.every((part) => part.startsWith(header))).toBe(true);
      expect(
        parts.every((part) =>
          nodes(part).some((node) => node.type === 'table'),
        ),
      ).toBe(true);
      expect(parts.map((part) => part.slice(header.length)).join('')).toBe(
        data,
      );
      expect(parts.flatMap(rows)).toHaveLength(100);
    },
  );
  it.each([
    1891, 1892, 3788, 3789, 3790, 3797, 9983, 9984, 19985, 19988, 19989, 19990,
    19991, 19992,
  ])(
    'bounds fence repetition around budget boundaries (info length %s)',
    (length) => {
      const info = 'x'.repeat(length);
      const body = '中😀y'.repeat(7500);
      const text = '```' + info + '\n' + body + '\n```';
      const parts = split(text);
      expect(parts.length).toBeLessThanOrEqual(
        4 * Math.ceil(measure(text) / options.targetLength),
      );
      expect(
        parts.reduce((sum, part) => sum + measure(part), 0),
      ).toBeLessThanOrEqual(4 * measure(text) + options.maxLength);
      const blocks = parts.flatMap(code);
      if (
        parts.some((part) => part.includes('original text follows in parts'))
      ) {
        expect(blocks.map((block) => block.value).join('')).toBe(text);
      } else {
        expect(blocks.every((block) => block.lang === info)).toBe(true);
        expect(blocks.map((block) => block.value).join('')).toBe(body);
      }
    },
  );
  it('does not turn the exact three-character fence budget into 10000 messages', () => {
    const info = 'x'.repeat(3789);
    const body = 'y'.repeat(30000);
    const parts = split('```' + info + '\n' + body + '\n```');
    expect(parts).toHaveLength(2);
    expect(parts.flatMap(code).every((block) => block.lang === info)).toBe(
      true,
    );
    expect(
      parts
        .flatMap(code)
        .map((block) => block.value)
        .join(''),
    ).toBe(body);
  });
  it.each([3780, 9980, 19960])(
    'bounds repeated table headers and preserves all source (%s)',
    (length) => {
      const header = '| ' + 'h'.repeat(length) + ' |\n|---|\n';
      const data = Array(3000).fill('| 中😀 |').join('\n');
      const text = header + data;
      const parts = split(text);
      expect(parts.length).toBeLessThanOrEqual(
        4 * Math.ceil(measure(text) / 3800),
      );
      expect(
        parts.reduce((sum, part) => sum + measure(part), 0),
      ).toBeLessThanOrEqual(4 * measure(text) + 20000);
      if (
        parts.some((part) => part.includes('original text follows in parts'))
      ) {
        expect(
          parts
            .flatMap(code)
            .map((block) => block.value)
            .join(''),
        ).toBe(text);
      } else {
        expect(parts.every((part) => part.startsWith(header))).toBe(true);
        expect(parts.map((part) => part.slice(header.length)).join('')).toBe(
          data,
        );
      }
    },
  );
  it.each(['123456789. ', '123456789.   '])(
    'bounds deep repeated list prefixes (%s)',
    (marker) => {
      const body = '中😀y'.repeat(7500);
      const text = marker.repeat(16) + body;
      const parts = split(text);
      expect(parts.length).toBeLessThanOrEqual(
        4 * Math.ceil(measure(text) / 3800),
      );
      expect(
        parts.reduce((sum, part) => sum + measure(part), 0),
      ).toBeLessThanOrEqual(4 * measure(text) + 20000);
      const restored = parts
        .flatMap(code)
        .map((block) => block.value)
        .join('');
      expect(restored).toContain(body);
      expect(restored.match(/中😀y/gu)).toHaveLength(7500);
    },
  );
  it('preserves nested code after a nearly exhausted prefix budget', () => {
    const body = 'x'.repeat(39500);
    const text = '\n'.repeat(19883) + '> - ```sh\n>   ' + body + '\n>   ```';
    const blocks = split(text).flatMap(code);
    expect(blocks.every((block) => block.lang === 'sh')).toBe(true);
    expect(blocks.map((block) => block.value).join('')).toBe(body);
  });
  it('retains an oversized header-only table after its introduction', () => {
    const table =
      Array.from({ length: 1400 }, (_, i) => 'column-' + i).join('|') +
      '\n' +
      Array(1400).fill('---').join('|');
    const parts = split('Synthetic lead-in.\n' + table);
    expect(parts[0]).toBe('Synthetic lead-in.\n');
    expect(
      parts
        .flatMap(code)
        .map((block) => block.value)
        .join(''),
    ).toBe(table);
  });
  it('preserves task checkboxes with continued fenced code', () => {
    const body = 'a'.repeat(25000);
    const text = '- [x]\n    ```bash\n    ' + body + '\n    ```';
    const parts = split(text);
    expect(parts.every((part) => part.startsWith('- [x]'))).toBe(true);
    expect(
      parts
        .flatMap(code)
        .map((block) => block.value)
        .join(''),
    ).toBe(code(text)[0]!.value);
  });
  it('keeps code metadata when a list item and its gap reach the hard limit', () => {
    const body = 'x'.repeat(19982);
    const parts = split('- ```ts\n  ' + body + '\n  ```\n- next');
    const blocks = parts.flatMap(code);
    expect(blocks.every((block) => block.lang === 'ts')).toBe(true);
    expect(blocks.map((block) => block.value).join('')).toBe(body);
    expect(parts.at(-1)).toContain('- next');
  });
  it('preserves original list item gaps across chunk boundaries', () => {
    for (const separator of ['\n', '\n\n']) {
      const text = Array.from(
        { length: 60 },
        (_, i) => '- bullet ' + i + ' filler '.repeat(15),
      ).join(separator);
      expect(split(text).join('')).toBe(text);
    }
    expect(split(fixture).join('')).toBe(fixture);
  });
  it('does not turn a split literal backtick run into inline code', () => {
    const stem = '[a](https://docs.example.com/';
    const link = stem + 'x'.repeat(3798 - stem.length - 1) + ')';
    for (const prefix of [
      'x'.repeat(3798) + '```',
      link + '```',
      stem + ')' + '`'.repeat(3801 - stem.length - 1),
    ]) {
      const text = prefix + 'y'.repeat(10) + '`' + 'z'.repeat(10);
      const parts = split(text);
      expect(parts.join('')).toBe(text);
      expect(parts.flatMap(links)).toEqual(links(text));
      expect(
        parts
          .flatMap(nodes)
          .filter((node) => node.type === 'inlineCode' || node.type === 'code'),
      ).toEqual([]);
      expect(parts.filter((part) => part.includes('```'))).toHaveLength(1);
    }
  });
  it.each(['```', '~~~'])(
    'keeps prose visible when a continuation begins with %s',
    (marker) => {
      const stem = '[a](https://docs.example.com/';
      const link = stem + 'x'.repeat(3800 - stem.length - 1) + ')';
      for (const prefix of ['word '.repeat(760), link]) {
        const text =
          prefix + marker + ' fences like this. ' + 'tail '.repeat(600);
        const parts = split(text);
        const blocks = parts.flatMap(code);
        expect(blocks.length).toBeGreaterThan(0);
        expect(blocks.every((block) => block.lang === 'text')).toBe(true);
        expect(
          parts
            .map((part) =>
              code(part).length
                ? code(part)
                    .map((block) => block.value)
                    .join('')
                : part,
            )
            .join(''),
        ).toBe(text);
        expect(parts.flatMap(links)).toEqual(links(text));
      }
    },
  );
  it('reserves reference definitions within the ordinary prose target', () => {
    const definition = '[ref]: https://docs.example.com/' + 'a'.repeat(70);
    const text = 'Ordinary [ref] sentence. '.repeat(600) + '\n\n' + definition;
    const parts = split(text);
    expect(parts.every((part) => measure(part) <= 3800)).toBe(true);
    expect(parts.every((part) => part.includes(definition))).toBe(true);
    expect(
      parts.flatMap(nodes).filter((node) => node.type === 'linkReference'),
    ).toHaveLength(600);
  });
  it('preserves escaped punctuation and character references across cuts', () => {
    const text = 'x'.repeat(3799) + '\\* &amp; ' + 'y'.repeat(5000);
    const parts = split(text);
    expect(parts.join('')).toBe(text);
    expect(parts.some((part) => part.includes('\\*'))).toBe(true);
    expect(parts.some((part) => part.includes('&amp;'))).toBe(true);
  });
});

it('abandons an over-budget candidate before constructing thousands of repeated fences', () => {
  const opener = '```' + 'x'.repeat(19985) + '\n';
  const text = opener + 'y'.repeat(30000) + '\n```';
  const byteLength = Buffer.byteLength;
  let wrappedMeasurements = 0;
  const spy = vi
    .spyOn(Buffer, 'byteLength')
    .mockImplementation((value, encoding) => {
      if (typeof value === 'string' && value.startsWith(opener))
        wrappedMeasurements++;
      return byteLength(value, encoding);
    });
  let parts: string[];
  try {
    parts = splitMarkdown(text, {
      targetLength: 3800,
      maxLength: 20000,
      unit: 'utf8',
    });
  } finally {
    spy.mockRestore();
  }
  expect(wrappedMeasurements).toBeLessThan(100);
  expect(
    parts
      .flatMap(code)
      .map((block) => block.value)
      .join(''),
  ).toBe(text);
});

it('reports an impossible literal budget instead of swallowing the final failure', () => {
  expect(() =>
    splitMarkdown(
      '[source](https://docs.example.com/' + 'x'.repeat(400) + ')',
      {
        targetLength: 64,
        maxLength: 64,
        unit: 'utf8',
      },
    ),
  ).toThrow('Markdown budget cannot contain a fenced fragment');
});
