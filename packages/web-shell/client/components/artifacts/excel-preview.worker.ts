import {
  getExcelWorkbookInfo,
  loadExcelWorkbook,
  projectExcelSheet,
} from './excel-preview-parser';
import type {
  ExcelPreviewRequest,
  ExcelPreviewResult,
} from './excel-preview-types';

let workbook: Awaited<ReturnType<typeof loadExcelWorkbook>> | undefined;

self.onmessage = async (event: MessageEvent<ExcelPreviewRequest>) => {
  let result: ExcelPreviewResult;
  try {
    if (event.data.type === 'load') {
      workbook = undefined;
      workbook = await loadExcelWorkbook(event.data.data);
      result = { type: 'loaded', workbook: getExcelWorkbookInfo(workbook) };
    } else {
      if (!workbook) throw new Error('Workbook is not loaded.');
      result = {
        type: 'sheet',
        index: event.data.index,
        sheet: projectExcelSheet(workbook, event.data.index),
      };
    }
  } catch {
    result = { type: 'error' };
  }
  self.postMessage(result);
};
