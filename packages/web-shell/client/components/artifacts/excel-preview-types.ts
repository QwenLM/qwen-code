import type { CSSProperties } from 'react';

export const MAX_EXCEL_PREVIEW_BYTES = 10 * 1024 * 1024;
export const MAX_EXCEL_PREVIEW_CELLS = 100_000;

export interface ExcelPreviewCell {
  text: string;
  formula?: string;
  uncalculated?: boolean;
  style: CSSProperties;
}

export interface ExcelPreviewSheet {
  name: string;
  rows: (ExcelPreviewCell | null)[][];
  columns: number;
  truncated: boolean;
  merges: { top: number; left: number; bottom: number; right: number }[];
}

export interface ExcelPreviewWorkbookInfo {
  sheetNames: string[];
}

export type ExcelPreviewRequest =
  | { type: 'load'; data: ArrayBuffer }
  | { type: 'sheet'; index: number };

export type ExcelPreviewResult =
  | { type: 'loaded'; workbook: ExcelPreviewWorkbookInfo }
  | { type: 'sheet'; index: number; sheet: ExcelPreviewSheet }
  | { type: 'error' };

export function excelColumnLabel(index: number): string {
  let label = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  }
  return label;
}
