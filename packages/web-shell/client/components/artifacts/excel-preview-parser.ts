import ExcelJS from 'exceljs';
import { format } from 'ssf';
import type { Cell, CellValue, Row, Worksheet } from 'exceljs';
import {
  MAX_EXCEL_PREVIEW_CELLS,
  MAX_EXCEL_PREVIEW_MERGED_CELLS,
  MAX_EXCEL_PREVIEW_MERGES,
} from './excel-preview-types';
import type {
  ExcelPreviewCell,
  ExcelPreviewSheet,
  ExcelPreviewWorkbookInfo,
} from './excel-preview-types';

function rgb(argb: string | undefined): string | undefined {
  return argb && /^(?:[\da-f]{2})?[\da-f]{6}$/i.test(argb)
    ? `#${argb.slice(-6)}`
    : undefined;
}

function displayValue(
  value: CellValue,
  numberFormat: string,
  date1904: boolean,
): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && 'error' in value) return value.error;
  if (typeof value === 'object' && 'richText' in value)
    return value.richText.map((part) => part.text).join('');
  if (typeof value === 'object' && 'hyperlink' in value) return value.text;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number' || value instanceof Date) {
    const numeric =
      value instanceof Date
        ? 25569 + value.getTime() / 86400000 - (date1904 ? 1462 : 0)
        : value;
    try {
      return format(
        numberFormat || (value instanceof Date ? 'yyyy-mm-dd' : 'General'),
        numeric,
        { date1904 },
      );
    } catch {
      return value instanceof Date ? value.toISOString() : String(value);
    }
  }
  return typeof value === 'string' ? value : '';
}

function previewCell(cell: Cell, date1904: boolean): ExcelPreviewCell {
  const formula = cell.formula;
  // ExcelJS's value getter drops falsy formula results, including 0 and false.
  const value =
    cell.type === ExcelJS.ValueType.Formula ? cell.result : cell.value;
  const alignment = cell.alignment?.horizontal;
  const fill = cell.fill;
  return {
    text: displayValue(value, cell.numFmt, date1904),
    ...(formula
      ? { formula, uncalculated: value === undefined || value === null }
      : {}),
    style: {
      fontWeight: cell.font?.bold ? 'bold' : undefined,
      fontStyle: cell.font?.italic ? 'italic' : undefined,
      color: rgb(cell.font?.color?.argb),
      backgroundColor:
        fill?.type === 'pattern' && fill.pattern === 'solid'
          ? rgb(fill.fgColor?.argb)
          : undefined,
      textAlign:
        alignment === 'left' ||
        alignment === 'center' ||
        alignment === 'right' ||
        alignment === 'justify'
          ? alignment
          : undefined,
    },
  };
}

function address(value: string): { row: number; column: number } {
  const match = /^\$?([A-Z]+)\$?([1-9]\d*)$/i.exec(value);
  if (!match) throw new Error('Invalid merged cell address.');
  let column = 0;
  for (const character of match[1]!.toUpperCase())
    column = column * 26 + character.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (row > 1_048_576 || column > 16_384)
    throw new Error('Merged cell address is outside the worksheet.');
  return { row: row - 1, column: column - 1 };
}

const mergeBudgets = new WeakMap<
  ExcelJS.Workbook,
  { cells: number; count: number }
>();
let mergeGuardInstalled = false;

function installMergeGuard() {
  if (mergeGuardInstalled) return;
  // ExcelJS 4.4.0 expands merges before load resolves; this private hook must
  // stay covered by load tests when upgrading. Guard only preview workbooks.
  const prototype = Object.getPrototypeOf(
    new ExcelJS.Workbook().addWorksheet('guard'),
  ) as {
    _parseMergeCells(this: Worksheet, model: { mergeCells?: string[] }): void;
  };
  const parseMergeCells = prototype._parseMergeCells;
  prototype._parseMergeCells = function (model) {
    const budget = mergeBudgets.get(this.workbook);
    if (budget) {
      const ranges = model.mergeCells ?? [];
      budget.count += ranges.length;
      if (budget.count > MAX_EXCEL_PREVIEW_MERGES)
        throw new RangeError('Too many merged ranges to preview.');
      for (const range of ranges) {
        const parts = range.split(':');
        if (parts.length > 2) throw new Error('Invalid merged range.');
        const a = address(parts[0]!);
        const b = address(parts[1] ?? parts[0]!);
        budget.cells +=
          (Math.abs(b.row - a.row) + 1) * (Math.abs(b.column - a.column) + 1);
        if (budget.cells > MAX_EXCEL_PREVIEW_MERGED_CELLS)
          throw new RangeError('Merged ranges are too large to preview.');
      }
    }
    parseMergeCells.call(this, model);
  };
  mergeGuardInstalled = true;
}

export async function loadExcelWorkbook(
  data: ArrayBuffer,
): Promise<ExcelJS.Workbook> {
  installMergeGuard();
  const workbook = new ExcelJS.Workbook();
  mergeBudgets.set(workbook, { cells: 0, count: 0 });
  try {
    return await workbook.xlsx.load(data);
  } finally {
    mergeBudgets.delete(workbook);
  }
}

export function getExcelWorkbookInfo(
  workbook: ExcelJS.Workbook,
): ExcelPreviewWorkbookInfo {
  return {
    sheetNames: workbook.worksheets.map((sheet) => sheet.name),
  };
}

// ExcelJS 4.4.0 stores sparse arrays: its public iterators and model getter
// scan every hole up to XFD. Enumerate present entries for preview work instead.
type SparseWorksheet = Worksheet & {
  _rows: (Row & { _cells: (Cell | undefined)[] })[];
  _merges: Record<
    string,
    { top: number; left: number; bottom: number; right: number }
  >;
};

export function projectExcelSheet(
  workbook: ExcelJS.Workbook,
  index: number,
): ExcelPreviewSheet {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= workbook.worksheets.length
  ) {
    throw new RangeError('Worksheet index is outside the preview range.');
  }
  const sheet = workbook.worksheets[index]! as SparseWorksheet;
  // Ignore peripheral formatting-only cells, preserving merged placeholders.
  let columns = 0;
  let lastRow = 0;
  for (const row of Object.values(sheet._rows)) {
    if (!row) continue;
    for (const cell of Object.values(row._cells)) {
      if (!cell || cell.type === ExcelJS.ValueType.Null) continue;
      lastRow = Math.max(lastRow, row.number);
      columns = Math.max(columns, Number(cell.col));
    }
  }
  const rowCount =
    columns === 0
      ? 0
      : Math.min(lastRow, Math.floor(MAX_EXCEL_PREVIEW_CELLS / columns));
  return {
    name: sheet.name,
    columns,
    truncated: columns > 0 && lastRow > rowCount,
    rows: Array.from({ length: rowCount }, (_, r) =>
      Array.from({ length: columns }, (_, c) => {
        const cell = sheet.findRow(r + 1)?.findCell(c + 1);
        return cell && cell.type !== ExcelJS.ValueType.Null && !cell.isMerged
          ? previewCell(cell, workbook.properties.date1904)
          : cell?.isMerged && cell.master.address === cell.address
            ? previewCell(cell, workbook.properties.date1904)
            : null;
      }),
    ),
    merges: Object.values(sheet._merges)
      .map((merge) => ({
        top: merge.top - 1,
        left: merge.left - 1,
        bottom: merge.bottom - 1,
        right: merge.right - 1,
      }))
      .filter((merge) => merge.top < rowCount && merge.left < columns),
  };
}
