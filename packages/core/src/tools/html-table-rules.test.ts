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

  it('does not let a span attribute grow the output', () => {
    const page = (span: number) =>
      `<table><tr><td colspan="${span}">x</td></tr>` +
      '<tr><td>a</td></tr></table><p>after</p>';

    // colspan="1000000" produced 10,000,026 characters, which pushed the rest
    // of the page past the 100 KB the tool returns.
    const huge = service(true).turndown(page(1_000_000));

    expect(huge).toBe(service(true).turndown(page(1000)));
    expect(huge.length).toBeLessThan(100);
    expect(huge).toContain('after');
  });

  it('survives spans that would cover millions of grid cells', () => {
    // Tracking that many slots threw "RangeError: Set maximum size exceeded".
    const html = `<table>${'<tr><td rowspan="65534" colspan="1000">x</td></tr>'.repeat(3)}</table>`;

    expect(() => service(true).turndown(html)).not.toThrow();
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
