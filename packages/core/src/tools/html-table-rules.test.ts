/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import TurndownService from 'turndown';
import { addTableRules } from './html-table-rules.js';

/** The service `web-fetch.ts` builds, with and without the table rules. */
function service(withTables: boolean): TurndownService {
  const instance = new TurndownService();
  instance.remove(['script', 'style', 'noscript']);
  instance.addRule('drop-images', { filter: 'img', replacement: () => '' });
  if (withTables) {
    addTableRules(instance);
  }
  return instance;
}

/** Read the markdown table back the way a reader does. */
function tableRows(markdown: string): string[][] {
  return markdown
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split(/(?<!\\)\|/)
        .map((cell) => cell.replace(/\\(.)/g, '$1').trim()),
    );
}

const PRICING =
  '<table><thead><tr><th>Plan</th><th>Price</th><th>Seats</th></tr></thead>' +
  '<tbody><tr><td>Starter</td><td>9 EUR</td><td>3</td></tr>' +
  '<tr><td>Pro</td><td>29 EUR</td><td>10</td></tr></tbody></table>';

describe('addTableRules', () => {
  it('keeps a value in the row and the column it belongs to', () => {
    const markdown = service(true).turndown(
      `<h1>Pricing</h1>${PRICING}<p>after</p>`,
    );

    expect(tableRows(markdown)).toEqual([
      ['Plan', 'Price', 'Seats'],
      ['---', '---', '---'],
      ['Starter', '9 EUR', '3'],
      ['Pro', '29 EUR', '10'],
    ]);
    // The table has to be a block of its own, or it is read as prose.
    expect(markdown).toContain('Pricing\n=======\n\n| Plan | Price | Seats |');
    expect(markdown).toContain('| Pro | 29 EUR | 10 |\n\nafter');
  });

  it('flattens the same table into one paragraph per cell without the rules', () => {
    // The bug this pins: `9 EUR` ends up several blank lines from `Starter`.
    expect(service(false).turndown(PRICING)).toBe(
      'Plan\n\nPrice\n\nSeats\n\nStarter\n\n9 EUR\n\n3\n\nPro\n\n29 EUR\n\n10',
    );
  });

  it('uses the first row as the header when the page wrote no th', () => {
    const html =
      '<table><tr><td>Plan</td><td>Price</td></tr><tr><td>Starter</td><td>9 EUR</td></tr></table>';

    expect(tableRows(service(true).turndown(html))).toEqual([
      ['Plan', 'Price'],
      ['---', '---'],
      ['Starter', '9 EUR'],
    ]);
  });

  it('keeps a pipe inside the cell that holds it', () => {
    const html =
      '<table><tr><th>Name</th><th>Modes</th></tr><tr><td>codec</td><td>a|b|c</td></tr></table>';

    expect(tableRows(service(true).turndown(html))[2]).toEqual([
      'codec',
      'a|b|c',
    ]);
  });

  it("keeps a cell's own backslash next to a pipe", () => {
    const html =
      '<table><tr><th>Pattern</th></tr><tr><td>a\\|b</td></tr></table>';

    expect(tableRows(service(true).turndown(html))[2]).toEqual(['a\\|b']);
  });

  it('keeps a pipe inside a code span from splitting the cell', () => {
    // Turndown leaves a code span's backslashes alone, so `a\|b` there already
    // has one; adding a second made it an even run, and a GFM row splits at a
    // pipe after an even run.
    const html =
      '<table><tr><th>Regex</th><th>Use</th></tr>' +
      '<tr><td><code>a\\|b</code></td><td>alt</td></tr></table>';

    expect(service(true).turndown(html).split('\n')[2]).toBe(
      '| `a\\|b` | alt |',
    );
  });

  it('folds a line break inside a cell into a space', () => {
    const html =
      '<table><tr><th>Hours</th></tr><tr><td>Mon<br>Fri</td></tr></table>';

    expect(tableRows(service(true).turndown(html))[2]).toEqual(['Mon Fri']);
  });

  it('keeps the inline markup and links inside a cell', () => {
    const html =
      '<table><tr><th>Item</th></tr><tr><td><strong>Cable</strong>, see <a href="https://example.com/d">docs</a></td></tr></table>';

    expect(tableRows(service(true).turndown(html))[2]).toEqual([
      '**Cable**, see [docs](https://example.com/d)',
    ]);
  });

  it('puts a caption in its own paragraph above the table', () => {
    const html =
      '<table><caption>Prices</caption><tr><th>A</th></tr><tr><td>1</td></tr></table>';

    expect(service(true).turndown(html)).toBe(
      'Prices\n\n| A |\n| --- |\n| 1 |',
    );
  });

  it('writes a caption the parser moved past the rows above the table', () => {
    // Written after the rows, the caption ran into the last row; written
    // between two row groups, it split the table in two.
    const after =
      '<table><tr><th>A</th></tr><tr><td>1</td></tr><caption>Prices</caption></table>';
    const between =
      '<table><thead><tr><th>A</th></tr></thead><caption>Prices</caption>' +
      '<tbody><tr><td>1</td></tr></tbody></table>';

    expect(service(true).turndown(after)).toBe(
      'Prices\n\n| A |\n| --- |\n| 1 |',
    );
    expect(service(true).turndown(between)).toBe(
      'Prices\n\n| A |\n| --- |\n| 1 |',
    );
  });

  it('pads the columns a colspan covers', () => {
    // One cell for three columns left the row two cells short of the header.
    const html =
      '<table><tr><th>A</th><th>B</th><th>C</th></tr>' +
      '<tr><td colspan="3">total</td></tr>' +
      '<tr><td>1</td><td colspan="2">rest</td></tr></table>';

    expect(tableRows(service(true).turndown(html))).toEqual([
      ['A', 'B', 'C'],
      ['---', '---', '---'],
      ['total', '', ''],
      ['1', 'rest', ''],
    ]);
  });

  it('holds the column a rowspan covers open in the rows below it', () => {
    // Without the placeholder, "9 EUR" moved left into the Product column.
    const html =
      '<table><tr><th>Product</th><th>Variant</th><th>Price</th></tr>' +
      '<tr><td rowspan="2">Cable</td><td>1 m</td><td>9 EUR</td></tr>' +
      '<tr><td>2 m</td><td>12 EUR</td></tr></table>';

    expect(tableRows(service(true).turndown(html))).toEqual([
      ['Product', 'Variant', 'Price'],
      ['---', '---', '---'],
      ['Cable', '1 m', '9 EUR'],
      ['', '2 m', '12 EUR'],
    ]);
  });

  it('gives a rowspan="0" cell the rest of its row group', () => {
    // rowspan="0" is as tall as the rest of the group, so the rows under it
    // start one column in. Reading it as one row moved "2 m" into Product.
    const body = (span: string) =>
      '<table><thead><tr><th>Product</th><th>Variant</th><th>Price</th></tr></thead>' +
      `<tbody><tr><td rowspan="${span}">Cable</td><td>1 m</td><td>9 EUR</td></tr>` +
      '<tr><td>2 m</td><td>12 EUR</td></tr>' +
      '<tr><td>3 m</td><td>15 EUR</td></tr></tbody></table>';

    expect(tableRows(service(true).turndown(body('0')))).toEqual([
      ['Product', 'Variant', 'Price'],
      ['---', '---', '---'],
      ['Cable', '1 m', '9 EUR'],
      ['', '2 m', '12 EUR'],
      ['', '3 m', '15 EUR'],
    ]);
    // A browser lays the zero span out exactly like the span it stands for.
    expect(service(true).turndown(body('0'))).toBe(
      service(true).turndown(body('3')),
    );
  });

  it('stops a rowspan="0" at the end of its row group', () => {
    // The group is the thead, so the cell covers its own row and no more.
    const html =
      '<table><thead><tr><th rowspan="0">Group</th><th>A</th></tr></thead>' +
      '<tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>';

    expect(tableRows(service(true).turndown(html))).toEqual([
      ['Group', 'A'],
      ['---', '---'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('ends a rowspan with its row group', () => {
    // A browser does not carry a thead cell down into the body, so the body
    // row keeps its first column.
    const html =
      '<table><thead><tr><th rowspan="2">Product</th><th>Price</th></tr></thead>' +
      '<tbody><tr><td>Cable</td><td>9 EUR</td></tr></tbody></table>';

    expect(tableRows(service(true).turndown(html))).toEqual([
      ['Product', 'Price'],
      ['---', '---'],
      ['Cable', '9 EUR'],
    ]);
  });

  it('reads colspan="0" as one column', () => {
    // HTML5 dropped colspan="0"; a browser reports colSpan === 1 for it.
    const html =
      '<table><tr><th>A</th><th>B</th></tr>' +
      '<tr><td colspan="0">x</td><td>y</td></tr></table>';

    expect(tableRows(service(true).turndown(html))[2]).toEqual(['x', 'y']);
  });

  it('counts the header columns by their spans', () => {
    const html =
      '<table><tr><th colspan="2">Size</th><th>Price</th></tr>' +
      '<tr><td>S</td><td>M</td><td>9 EUR</td></tr></table>';

    expect(tableRows(service(true).turndown(html))).toEqual([
      ['Size', '', 'Price'],
      ['---', '---', '---'],
      ['S', 'M', '9 EUR'],
    ]);
  });

  it('pads a row that is short of the widest row', () => {
    const html =
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td></tr></table>';

    expect(tableRows(service(true).turndown(html))).toEqual([
      ['A', 'B'],
      ['---', '---'],
      ['1', ''],
    ]);
  });

  it('writes a header row and its body with no blank line between them', () => {
    // A blank line anywhere between two rows ends the table, so the whole
    // output is pinned rather than only the lines that start with a pipe.
    expect(service(true).turndown(PRICING)).toBe(
      '| Plan | Price | Seats |\n' +
        '| --- | --- | --- |\n' +
        '| Starter | 9 EUR | 3 |\n' +
        '| Pro | 29 EUR | 10 |',
    );
  });

  it("holds a rowspan open when it covers the row's last columns", () => {
    // No later cell forces the placeholder, so it has to come from the row's
    // right-side padding (found on Mintplex-Labs/anything-llm#6388).
    const html =
      '<table><tr><th>A</th><th>B</th></tr>' +
      '<tr><td>1</td><td rowspan="2">x</td></tr>' +
      '<tr><td>2</td></tr></table>';

    expect(tableRows(service(true).turndown(html))).toEqual([
      ['A', 'B'],
      ['---', '---'],
      ['1', 'x'],
      ['2', ''],
    ]);
  });

  it('does not let a span attribute grow the output', () => {
    const page = (span: number) =>
      `<table><tr><td colspan="${span}">x</td></tr>` +
      '<tr><td>a</td></tr></table><p>after</p>';

    // colspan="1000000" produced 10,000,026 characters, which pushed the rest
    // of the page past the 100 KB the tool returns.
    const huge = service(true).turndown(page(1_000_000));

    expect(huge).toBe('| x |\n| --- |\n| a |\n\nafter');
    expect(huge).toBe(service(true).turndown(page(1000)));
  });

  it('pads a table only while its grid stays within a few cells per real cell', () => {
    // A lone cell with colspan="72" was padded to 72 columns, and a page of
    // such tables came out twelve times its own size.
    expect(
      service(true).turndown('<table><tr><td colspan="72">x</td></tr></table>'),
    ).toBe('| x |\n| --- |');

    // 16 x 17 = 272 grid cells for 32 real ones is more than 8 per cell, so
    // only the header is padded; GFM fills the short rows itself.
    const html =
      `<table><tr>${'<th>h</th>'.repeat(16)}</tr>` +
      '<tr><td>x</td></tr>'.repeat(16) +
      '</table>';

    expect(service(true).turndown(html).split('\n')[2]).toBe('| x |');
  });

  it('narrows a colspan wider than the table to the widest row', () => {
    // Taken at its word, colspan="1000" made the grid 1000 columns wide, so
    // the whole table fell back to no spans and "2 m" moved into Product.
    const html =
      '<table><tr><th colspan="1000">Cables</th></tr>' +
      '<tr><td rowspan="2">Cable</td><td>1 m</td><td>9 EUR</td></tr>' +
      '<tr><td>2 m</td><td>12 EUR</td></tr>' +
      '<tr><td>a</td><td>b</td><td>c</td></tr>'.repeat(48) +
      '</table>';

    const rows = tableRows(service(true).turndown(html));

    expect(rows[0]).toEqual(['Cables', '', '']);
    expect(rows[1]).toEqual(['---', '---', '---']);
    expect(rows[3]).toEqual(['', '2 m', '12 EUR']);
  });

  it('drops a span the budget cannot pay for from its own cell only', () => {
    // colspan="3" rowspan="1000" over empty rows is 3,000 grid cells for six
    // real ones. Leaving the whole table without its spans lost the column
    // the later rowspan holds, and "s" moved into the first column.
    const html =
      '<table><tr><td colspan="3" rowspan="1000">A</td></tr>' +
      '<tr></tr>'.repeat(999) +
      '<tr><td rowspan="2">P</td><td>q</td><td>r</td></tr>' +
      '<tr><td>s</td><td>t</td></tr></table>';

    expect(tableRows(service(true).turndown(html))).toEqual([
      ['A', '', ''],
      ['---', '---', '---'],
      ['P', 'q', 'r'],
      ['', 's', 't'],
    ]);
  });

  it('clamps a colspan at 1000 columns, as HTML does', () => {
    const html =
      `<table><tr>${'<td>c</td>'.repeat(1500)}</tr>` +
      '<tr><td colspan="5000">X</td><td>Y</td></tr></table>';

    expect(tableRows(service(true).turndown(html))[2].indexOf('Y')).toBe(1000);
  });

  it('stops padding a table past MAX_GRID_CELLS, whatever its size', () => {
    // 8 columns over 5,002 rows is 40,016 grid cells, within 8 per real cell
    // but past the 40,000 no table is padded beyond.
    const html =
      `<table><tr>${'<th>h</th>'.repeat(8)}</tr>` +
      '<tr><td colspan="8">x</td></tr>'.repeat(5001) +
      '</table>';

    const lines = service(true).turndown(html).split('\n');

    expect(lines[lines.length - 1]).toBe('| x |');
  });

  it('survives spans that would cover millions of grid cells', () => {
    // Tracking that many slots threw "RangeError: Set maximum size exceeded".
    const html = `<table>${'<tr><td rowspan="65534" colspan="1000">x</td></tr>'.repeat(3)}</table>`;

    expect(() => service(true).turndown(html)).not.toThrow();
  });

  it('keeps the widest row inside the table when the grid is over budget', () => {
    // Past the budget the delimiter counted only the header's own cells, so
    // the cells of the wider last row fell outside the table.
    const html =
      '<table><tr><th>A</th><th>B</th></tr>' +
      '<tr><td>x</td></tr>'.repeat(20) +
      `<tr>${'<td>w</td>'.repeat(20)}</tr></table>`;

    expect(service(true).turndown(html)).toBe(
      [
        `| A | B |${' |'.repeat(18)}`,
        `|${' --- |'.repeat(20)}`,
        ...Array<string>(20).fill('| x |'),
        `|${' w |'.repeat(20)}`,
      ].join('\n'),
    );
  });

  it('pads only the header when padding every row would outgrow the budget', () => {
    // GFM fills a short body row with empty cells itself. Padding every row
    // instead grows with the square of the table: one wide row under many
    // narrow ones.
    const width = 2000;
    const html =
      '<table>' +
      '<tr><td>h</td></tr>'.repeat(width) +
      `<tr>${'<td>w</td>'.repeat(width)}</tr></table>`;

    const markdown = service(true).turndown(html);
    const lines = markdown.split('\n');

    expect(lines[1]).toBe(`|${' --- |'.repeat(width)}`);
    expect(lines[lines.length - 1]).toBe(`|${' w |'.repeat(width)}`);
    expect(markdown.length).toBeLessThan(40 * width);
  });

  it('keeps the table whole around a row that has no cells', () => {
    // Turndown writes a cell-less row as a blank line, which ended the table
    // and pushed the body out of it.
    const html =
      '<table><tr><th>A</th><th>B</th></tr><tr></tr>' +
      '<tr><td>1</td><td>2</td></tr></table>';

    expect(service(true).turndown(html)).toBe(
      '| A | B |\n| --- | --- |\n| 1 | 2 |',
    );
  });

  it('writes no row for a row that has no cells but is not blank', () => {
    // A hidden input or a script keeps a row from being blank to Turndown.
    // Written, it was an empty data row, padded to the full width of the grid
    // outside the budget: 400 of them under a wide row came to 6.5 MB.
    const html =
      '<table><tr><td>a</td><td>b</td></tr>' +
      '<tr><input type="hidden" name="k" value="v"></tr>' +
      '<tr><script>x()</script></tr>' +
      '<tr><td>1</td><td>2</td></tr></table>';

    expect(service(true).turndown(html)).toBe(
      '| a | b |\n| --- | --- |\n| 1 | 2 |',
    );

    const wide = `<tr>${'<td colspan="8">c</td>'.repeat(100)}</tr>`;
    const ghosts = '<tr><script></script></tr>'.repeat(400);
    const markdown = service(true).turndown(
      `<table>${wide}${ghosts}${wide}</table>`,
    );

    expect(markdown.split('\n')).toHaveLength(3);
  });

  it('puts the delimiter under the first row that has cells', () => {
    // A leading cell-less row used to be taken as the header, so no row wrote
    // the delimiter and nothing on the page was a table.
    const html =
      '<table><tr></tr><tr><td>a</td><td>b</td></tr>' +
      '<tr><td>1</td><td>2</td></tr></table>';

    expect(service(true).turndown(html)).toBe(
      '| a | b |\n| --- | --- |\n| 1 | 2 |',
    );
  });

  it('folds a long run of non-breaking spaces without backtracking', () => {
    // The `\s*\n\s*` fold took 4.7 s for 80,000 of them at the end of a cell
    // and grows with the square of the run, so 200,000 would take far longer
    // than this timeout.
    const run = '\u00a0'.repeat(200_000);
    const html = `<table><tr><th>A</th></tr><tr><td>x${run}</td></tr></table>`;

    expect(tableRows(service(true).turndown(html))[2]).toEqual(['x']);
  }, 5_000);

  it('leaves markup without a table alone', () => {
    const html = '<p>hello</p><ul><li>a</li><li>b</li></ul>';

    expect(service(true).turndown(html)).toBe(service(false).turndown(html));
  });
});
