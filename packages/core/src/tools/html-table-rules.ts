/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

interface TurndownLike {
  addRule(key: string, rule: unknown): unknown;
}

// HTML clamps colspan to 1..1000, and a rowspan never reaches past its table.
const MAX_COLSPAN = 1000;

// A span attribute on an untrusted page must not be able to make the output,
// or the conversion, much larger than the page. So a table is padded out to a
// full grid only while the grid stays within a few cells per real cell, and
// never past MAX_GRID_CELLS, where its Markdown is already well over 100 KB,
// more than a fetched page may return. A table past that is written row by
// row, one column per cell, as if it had no spans.
const GRID_CELLS_PER_CELL = 8;
const MIN_GRID_CELLS = 64;
const MAX_GRID_CELLS = 40_000;

/**
 * Give a Turndown service the table rules it does not ship with.
 *
 * Turndown has no table support of its own, so a `<table>` is flattened into
 * one paragraph per cell: a price ends up several blank lines away from the
 * product it belongs to, and nothing records which column it came from.
 *
 * `turndown-plugin-gfm` is the usual answer and is not used here on purpose:
 * measured against 1.0.2, it emits a table that carries no `<th>` as raw HTML,
 * does not escape a pipe inside a cell, and lets a `<br>` break the row in half.
 */
export function addTableRules(service: TurndownLike): void {
  service.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement: (content: string, node: HTMLElement) => {
      const grid = gridFor(node);
      // Markdown has no merged cells, so a span becomes the empty cells the
      // columns it covers would otherwise be missing.
      const before = ' |'.repeat(grid.before.get(node) ?? 0);
      const spanned = ' |'.repeat((grid.colspan.get(node) ?? 1) - 1);
      return `${before} ${cellText(content)} |${spanned}`;
    },
  });

  service.addRule('tableRow', {
    filter: 'tr',
    replacement: (content: string, node: HTMLElement) => {
      const grid = gridFor(node);
      const row = `|${content}${' |'.repeat(grid.after.get(node) ?? 0)}`;
      if (node !== grid.header) {
        return `\n${row}`;
      }
      // A GFM table has to open with a header row, so the first row that has
      // cells becomes one. On a page written without <th> that is what it is.
      return `\n${row}\n|${' --- |'.repeat(grid.headerWidth)}`;
    },
  });

  // A section wrapper must not put a blank line between the header row and the
  // body, because a blank line ends the table.
  service.addRule('tableSection', {
    filter: ['thead', 'tbody', 'tfoot'],
    replacement: (content: string) => content,
  });

  service.addRule('tableCaption', {
    filter: 'caption',
    replacement: (content: string) =>
      content.trim() ? `${content.trim()}\n\n` : '',
  });

  service.addRule('table', {
    filter: 'table',
    // A row with no cells is blank to Turndown, which writes it as a blank
    // line instead of calling the row rule, and a blank line ends the table.
    replacement: (content: string) =>
      `\n\n${content.trim().replace(/^(\|.*)\n\s*\n(?=\|)/gm, '$1\n')}\n\n`,
  });
}

function cellText(content: string): string {
  // Turndown writes a <br> as two spaces and a newline; the whole break folds
  // into one space, because a newline would end the row halfway through. This
  // splits instead of matching `\s*\n\s*`, which backtracks quadratically over
  // a long run of &nbsp; that no newline follows.
  return escapePipes(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .join(' ')
      .trim(),
  );
}

/**
 * A GFM row splits at a pipe preceded by an even number of backslashes, so
 * every pipe is left with an odd number. In text Turndown has already doubled
 * each backslash, so that is always one more; inside a code span it has not,
 * and `a\|b` there already has one.
 */
function escapePipes(text: string): string {
  const parts = text.split('|');
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index];
    let run = 0;
    while (run < part.length && part[part.length - 1 - run] === '\\') {
      run++;
    }
    if (run % 2 === 0) {
      parts[index] = `${part}\\`;
    }
  }
  return parts.join('|');
}

function tableOf(node: Node): HTMLElement | null {
  let parent: Node | null = node.parentNode;
  while (parent && parent.nodeName !== 'TABLE') {
    parent = parent.parentNode;
  }
  return (parent as HTMLElement) ?? null;
}

interface TableGrid {
  /** The row the delimiter goes under: the first one that has cells. */
  header: Element | null;
  headerWidth: number;
  /** Empty cells a cell needs in front of it, because a rowspan holds those columns. */
  before: Map<Element, number>;
  /** Columns a cell covers once its colspan is clamped. */
  colspan: Map<Element, number>;
  /** Empty cells a row needs at its end, to reach the width of the widest row. */
  after: Map<Element, number>;
}

const NOT_IN_A_TABLE: TableGrid = {
  header: null,
  headerWidth: 0,
  before: new Map(),
  colspan: new Map(),
  after: new Map(),
};

const grids = new WeakMap<Element, TableGrid>();

function gridFor(node: Element): TableGrid {
  const table = tableOf(node);
  if (!table) {
    return NOT_IN_A_TABLE;
  }
  let grid = grids.get(table);
  if (!grid) {
    grid = measure(table);
    grids.set(table, grid);
  }
  return grid;
}

function measure(table: Element): TableGrid {
  const rows = Array.from(table.querySelectorAll('tr')).filter(
    (row) => tableOf(row) === table,
  );
  const cells = rows.map(cellsOf);
  const headerIndex = cells.findIndex((rowCells) => rowCells.length > 0);
  const header = headerIndex >= 0 ? rows[headerIndex] : null;

  const layout = layOut(rows, cells);
  if (layout) {
    return { header, headerWidth: layout.width, ...layout };
  }
  // Past the budget the spans are ignored, so a row is as wide as its own
  // cells. The header still has to reach the widest row, or the cells beyond
  // it fall out of the table. A shorter body row is fine as it is, because GFM
  // fills it with empty cells, and padding every row is exactly the growth the
  // budget exists to prevent.
  const width = cells.reduce(
    (widest, rowCells) => Math.max(widest, rowCells.length),
    0,
  );
  const after = new Map<Element, number>();
  if (header) {
    after.set(header, width - cells[headerIndex].length);
  }
  return {
    header,
    headerWidth: width,
    before: new Map(),
    colspan: new Map(),
    after,
  };
}

/**
 * Lay the table out on a grid the way a browser does, so spans take their
 * columns. Returns null once the grid would pass the table's budget.
 */
function layOut(
  rows: Element[],
  cells: Element[][],
): (Omit<TableGrid, 'header' | 'headerWidth'> & { width: number }) | null {
  const before = new Map<Element, number>();
  const colspan = new Map<Element, number>();
  const widths: number[] = [];
  const taken = new Set<string>();
  const groupEnds = rowGroupEnds(rows);
  let width = 0;
  const realCells = cells.reduce(
    (total, rowCells) => total + rowCells.length,
    0,
  );
  const budget = Math.min(
    MAX_GRID_CELLS,
    MIN_GRID_CELLS + GRID_CELLS_PER_CELL * realCells,
  );

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    let column = 0;
    const free = (): number => {
      let skipped = 0;
      while (taken.has(`${rowIndex},${column}`)) {
        column++;
        skipped++;
      }
      return skipped;
    };
    for (const cell of cells[rowIndex]) {
      before.set(cell, free());
      const across = spanOf(cell, 'colspan', 1, MAX_COLSPAN);
      const down = spanOf(
        cell,
        'rowspan',
        groupEnds[rowIndex] - rowIndex,
        rows.length - rowIndex,
      );
      if (taken.size + across * down > budget) {
        return null;
      }
      colspan.set(cell, across);
      for (let r = 0; r < down; r++) {
        for (let c = 0; c < across; c++) {
          taken.add(`${rowIndex + r},${column + c}`);
        }
      }
      column += across;
    }
    // `column` is the width the row emits cells for. Trailing slots a rowspan
    // from above still claims widen the table, and become right-side padding.
    widths.push(column);
    free();
    width = Math.max(width, column);
  }

  // A row with no cells is never written, so only the others are padded.
  const writtenRows = cells.filter((rowCells) => rowCells.length > 0).length;
  if (width * writtenRows > budget) {
    return null;
  }
  const after = new Map<Element, number>();
  rows.forEach((row, index) => after.set(row, width - widths[index]));
  return { width, before, colspan, after };
}

function cellsOf(row: Element): Element[] {
  return Array.from(row.children).filter(
    (child) => child.nodeName === 'TH' || child.nodeName === 'TD',
  );
}

/**
 * For each row, the index one past the last row of its row group, so a
 * rowspan="0" cell knows where to stop. A row's group is the thead, tbody or
 * tfoot it sits in; a page that writes none gets the tbody the parser adds.
 */
function rowGroupEnds(rows: Element[]): number[] {
  const ends: number[] = [];
  for (let index = rows.length - 1; index >= 0; index--) {
    const sameGroup =
      index + 1 < rows.length &&
      rows[index + 1].parentNode === rows[index].parentNode;
    ends[index] = sameGroup ? ends[index + 1] : index + 1;
  }
  return ends;
}

/**
 * The columns or rows a span covers, clamped to `max`. A span of 0 is `zero`:
 * HTML5 dropped colspan="0" and a browser reads it as one column, while
 * rowspan="0" still covers every remaining row of the cell's row group.
 */
function spanOf(
  cell: Element,
  attribute: 'colspan' | 'rowspan',
  zero: number,
  max: number,
): number {
  const value = Number.parseInt(cell.getAttribute(attribute) ?? '', 10);
  if (!Number.isFinite(value) || value < 0) {
    return 1;
  }
  return Math.min(value === 0 ? zero : value, max);
}
