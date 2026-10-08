import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import {
  getExcelWorkbookInfo,
  loadExcelWorkbook,
  projectExcelSheet,
} from './excel-preview-parser';

async function preview(workbook: ExcelJS.Workbook) {
  return loadExcelWorkbook(await workbook.xlsx.writeBuffer());
}

async function mergedWorkbook(rangesBySheet: string[][]) {
  const workbook = new ExcelJS.Workbook();
  rangesBySheet.forEach((_ranges, index) => {
    workbook.addWorksheet(`Sheet ${index}`).getCell('A1').value = 'Master';
  });
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  for (const [index, ranges] of rangesBySheet.entries()) {
    const path = `xl/worksheets/sheet${index + 1}.xml`;
    const xml = await zip.file(path)!.async('string');
    zip.file(
      path,
      xml.replace(
        '</worksheet>',
        `<mergeCells>${ranges.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells></worksheet>`,
      ),
    );
  }
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}

describe('Excel preview merge loading limits', () => {
  it.each<[string, string[][], string]>([
    ['one huge range', [['A1:XFD1048576']], 'Merged ranges are too large'],
    [
      'area just over the budget',
      [['A1:A100001']],
      'Merged ranges are too large',
    ],
    [
      'total area across worksheets',
      [['A1:J6000'], ['A1:J6000']],
      'Merged ranges are too large',
    ],
    [
      'too many ranges',
      [Array.from({ length: 10001 }, (_, i) => `A${i + 1}:B${i + 1}`)],
      'Too many merged ranges',
    ],
    [
      'total count across worksheets',
      [
        Array.from({ length: 6000 }, (_, i) => `A${i + 1}:B${i + 1}`),
        Array.from({ length: 6000 }, (_, i) => `A${i + 1}:B${i + 1}`),
      ],
      'Too many merged ranges',
    ],
    ['invalid address', [['A0:B2']], 'Invalid merged cell address'],
  ])('rejects %s before expansion', async (_name, ranges, message) => {
    const bytes = await mergedWorkbook(ranges);
    const prototype = Object.getPrototypeOf(
      new ExcelJS.Workbook().addWorksheet('Probe'),
    ) as ExcelJS.Worksheet;
    // Never allow an intentionally malicious fixture to allocate cells, even if
    // the guard regresses. The expected limit error must precede expansion.
    const expand = vi
      .spyOn(prototype, 'mergeCellsWithoutStyle')
      .mockImplementation(() => {});
    try {
      const error = await loadExcelWorkbook(bytes).then(
        () => '',
        (reason: Error) => reason.message,
      );
      expect(error).toContain(message);
      expect(expand).toHaveBeenCalledTimes(
        ranges.length > 1 ? ranges[0]!.length : 0,
      );
    } finally {
      expand.mockRestore();
    }
  });

  it('accepts the exact area budget and isolates concurrent workbook budgets', async () => {
    const bytes = await mergedWorkbook([['$A$1:$J$10000']]);
    const books = await Promise.all([
      loadExcelWorkbook(bytes),
      loadExcelWorkbook(bytes),
    ]);
    for (const book of books) {
      expect(book.worksheets[0]!.getCell('J10000').master.address).toBe('A1');
      expect(projectExcelSheet(book, 0)).toMatchObject({
        columns: 10,
        truncated: false,
      });
    }
  });

  it('accepts the exact range count without doing quadratic merge work in the test', async () => {
    const bytes = await mergedWorkbook([
      Array.from({ length: 10000 }, (_, i) => `A${i + 1}:B${i + 1}`),
    ]);
    const prototype = Object.getPrototypeOf(
      new ExcelJS.Workbook().addWorksheet('Probe'),
    ) as ExcelJS.Worksheet;
    const expand = vi
      .spyOn(prototype, 'mergeCellsWithoutStyle')
      .mockImplementation(() => {});
    try {
      await loadExcelWorkbook(bytes);
      expect(expand).toHaveBeenCalledTimes(10000);
    } finally {
      expand.mockRestore();
    }
  });
});

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

  it('ignores peripheral empty formatting while preserving coordinates and merges', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Data');
    for (let row = 1; row <= 2000; row++)
      sheet.addRow([`Row ${row}`, row, row * 2]);
    sheet.getCell('XFD1').font = { bold: true };
    sheet.getRow(5000).font = { bold: true };
    const empty = book.addWorksheet('Only formatting');
    empty.getCell('XFD1').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFF0000' },
    };
    const merged = book.addWorksheet('Merged extent');
    merged.mergeCells('B2:E4');
    merged.getCell('B2').value = 'Master';
    const loaded = await preview(book);
    expect(loaded.worksheets[0]!.columnCount).toBe(16384);
    const projected = projectExcelSheet(loaded, 0);
    expect(projected).toMatchObject({ columns: 3, truncated: false });
    expect(projected.rows).toHaveLength(2000);
    expect(projected.rows.at(-1)?.[0]?.text).toBe('Row 2000');
    expect(projectExcelSheet(loaded, 1)).toMatchObject({
      columns: 0,
      rows: [],
      truncated: false,
    });
    const mergedProjection = projectExcelSheet(loaded, 2);
    expect(mergedProjection.columns).toBe(5);
    expect(mergedProjection.rows).toHaveLength(4);
    expect(mergedProjection.rows[0]).toEqual([null, null, null, null, null]);
    expect(mergedProjection.rows[1]?.[1]?.text).toBe('Master');
    expect(mergedProjection.merges).toEqual([
      { top: 1, left: 1, bottom: 3, right: 4 },
    ]);
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
