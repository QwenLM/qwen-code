import ExcelJS from 'exceljs';
import { format } from 'ssf';
import type { Cell, CellValue } from 'exceljs';
import { MAX_EXCEL_PREVIEW_CELLS } from './excel-preview-types';
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
  const match = /^([A-Z]+)(\d+)$/.exec(value)!;
  let column = 0;
  for (const character of match[1]!)
    column = column * 26 + character.charCodeAt(0) - 64;
  return { row: Number(match[2]) - 1, column: column - 1 };
}

export async function loadExcelWorkbook(
  data: ArrayBuffer,
): Promise<ExcelJS.Workbook> {
  return new ExcelJS.Workbook().xlsx.load(data);
}

export function getExcelWorkbookInfo(
  workbook: ExcelJS.Workbook,
): ExcelPreviewWorkbookInfo {
  return {
    sheetNames: workbook.worksheets.map((sheet) => sheet.name),
  };
}

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
  const sheet = workbook.worksheets[index]!;
  const columns = sheet.columnCount;
  const rowCount =
    columns === 0
      ? 0
      : Math.min(sheet.rowCount, Math.floor(MAX_EXCEL_PREVIEW_CELLS / columns));
  return {
    name: sheet.name,
    columns,
    truncated: columns > 0 && sheet.rowCount > rowCount,
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
    merges: sheet.model.merges
      .map((range) => {
        const [start, end] = range.split(':');
        const a = address(start!);
        const b = address(end ?? start!);
        return {
          top: a.row,
          left: a.column,
          bottom: b.row,
          right: b.column,
        };
      })
      .filter((merge) => merge.top < rowCount && merge.left < columns),
  };
}
