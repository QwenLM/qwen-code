import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import {
  getExcelWorkbookInfo,
  loadExcelWorkbook,
  projectExcelSheet,
} from './excel-preview-parser';

async function preview(workbook: ExcelJS.Workbook) {
  return loadExcelWorkbook(await workbook.xlsx.writeBuffer());
}

describe('Excel preview projection', () => {
  it.each([false, true])(
    'preserves display values with date1904=%s',
    async (date1904) => {
      const book = new ExcelJS.Workbook();
      book.properties.date1904 = date1904;
      const sheet = book.addWorksheet('Report');
      sheet.addRow([1234.5, 0.125, 7, new Date('2026-10-08T00:00:00Z'), false]);
      sheet.getCell('A1').numFmt = '#,##0.00';
      sheet.getCell('B1').numFmt = '0.0%';
      sheet.getCell('C1').numFmt = '00000';
      sheet.getCell('D1').numFmt = 'yyyy-mm-dd';
      sheet.addRow([
        { formula: '1-1', result: 0 },
        { formula: '1=2', result: false },
        { formula: 'SUM(A1:A2)' },
        { error: '#DIV/0!' },
        { richText: [{ text: 'Hello ' }, { text: 'world' }] },
      ]);
      sheet.getCell('A3').value = {
        text: '<script>alert(1)</script>',
        hyperlink: 'javascript:alert(1)',
      };
      const parsed = projectExcelSheet(await preview(book), 0);
      expect(parsed.rows[0]!.map((cell) => cell?.text)).toEqual([
        '1,234.50',
        '12.5%',
        '00007',
        '2026-10-08',
        'FALSE',
      ]);
      expect(parsed.rows[1]!.map((cell) => cell?.text)).toEqual([
        '0',
        'FALSE',
        '',
        '#DIV/0!',
        'Hello world',
      ]);
      expect(parsed.rows[1]![0]).toMatchObject({
        formula: '1-1',
        uncalculated: false,
      });
      expect(parsed.rows[1]![2]).toMatchObject({
        formula: 'SUM(A1:A2)',
        uncalculated: true,
      });
      expect(parsed.rows[2]![0]?.text).toBe('<script>alert(1)</script>');
    },
  );

  it('keeps merged masters and basic styles without duplicating their values', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Merged');
    sheet.mergeCells('B2:C3');
    const cell = sheet.getCell('B2');
    cell.value = 'Merged value';
    cell.font = { bold: true, italic: true, color: { argb: 'FFFF0000' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF00FF00' },
    };
    cell.alignment = { horizontal: 'center' };
    book.addWorksheet('Empty');
    const loaded = await preview(book);
    const parsed = projectExcelSheet(loaded, 0);
    expect(parsed.merges).toEqual([{ top: 1, left: 1, bottom: 2, right: 2 }]);
    expect(parsed.rows[1]?.[1]).toMatchObject({
      text: 'Merged value',
      style: {
        fontWeight: 'bold',
        fontStyle: 'italic',
        color: '#FF0000',
        backgroundColor: '#00FF00',
        textAlign: 'center',
      },
    });
    expect(parsed.rows[2]?.[2]).toBeNull();
    expect(projectExcelSheet(loaded, 1)).toMatchObject({
      rows: [],
      columns: 0,
      truncated: false,
    });
  });

  it('budgets all grid cells without independent sheet or column limits', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Large');
    sheet.getCell('AY2001').value = 'outside preview';
    for (let i = 1; i < 21; i++) book.addWorksheet(`Sheet ${i}`);
    const loaded = await preview(book);
    const metadata = getExcelWorkbookInfo(loaded);
    expect(metadata.sheetNames).toHaveLength(21);
    expect(projectExcelSheet(loaded, 20).name).toBe('Sheet 20');
    const parsed = projectExcelSheet(loaded, 0);
    expect(parsed.rows).toHaveLength(Math.floor(100_000 / 51));
    expect(parsed).toMatchObject({ columns: 51, truncated: true });
    expect(parsed.rows.at(-1)).toHaveLength(51);
    expect(parsed.rows.length * parsed.columns).toBeLessThanOrEqual(100_000);
  });

  it('allows more than 2,000 rows, includes the exact budget and excludes the next row', () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Narrow');
    sheet.getCell('J10000').value = 'last included';
    const exact = projectExcelSheet(book, 0);
    expect(exact.rows).toHaveLength(10000);
    expect(exact.rows.at(-1)?.[9]?.text).toBe('last included');
    expect(exact.truncated).toBe(false);
    sheet.getCell('A10001').value = 'excluded';
    const over = projectExcelSheet(book, 0);
    expect(over.rows).toHaveLength(10000);
    expect(over.rows.length * over.columns).toBe(100_000);
    expect(over.truncated).toBe(true);
  });

  it('does not project unrequested worksheets when loading metadata or another sheet', async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('First').getCell('A1').value = 'first value';
    book.addWorksheet('Second').getCell('A1').value = 'second value';
    const loaded = await preview(book);
    const firstRead = vi.spyOn(loaded.worksheets[0]!, 'findRow');
    const secondRead = vi.spyOn(loaded.worksheets[1]!, 'findRow');
    expect(getExcelWorkbookInfo(loaded)).toEqual({
      sheetNames: ['First', 'Second'],
    });
    expect(firstRead).not.toHaveBeenCalled();
    expect(secondRead).not.toHaveBeenCalled();
    expect(projectExcelSheet(loaded, 1).rows[0]?.[0]?.text).toBe(
      'second value',
    );
    expect(secondRead).toHaveBeenCalled();
    expect(firstRead).not.toHaveBeenCalled();
    expect(projectExcelSheet(loaded, 0).rows[0]?.[0]?.text).toBe('first value');
  });

  it.each([-1, 1.5, 21, NaN])(
    'rejects unavailable worksheet index %s',
    (index) => {
      const book = new ExcelJS.Workbook();
      for (let i = 0; i < 21; i++) book.addWorksheet(`Sheet ${i}`);
      expect(() => projectExcelSheet(book, index)).toThrow(RangeError);
    },
  );

  it('rejects malformed files', async () => {
    await expect(loadExcelWorkbook(new ArrayBuffer(10))).rejects.toThrow();
  });
});
