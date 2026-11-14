import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, type Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { afterEach, beforeEach, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const excelRequire = createRequire(require.resolve('exceljs'));
const unzipper = excelRequire('unzipper') as {
  Extract(options: { path: string }): Writable & { promise(): Promise<void> };
  Open: {
    file(filename: string): Promise<{
      extract(options: { path: string }): Promise<void>;
    }>;
  };
};

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'qwen-excel-archive-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it.each(['Extract', 'Open.file.extract'] as const)(
  '%s does not write into a same-prefix sibling directory',
  async (method) => {
    const destination = path.join(directory, 'out');
    const archive = path.join(directory, 'input.zip');
    const zip = new JSZip();
    zip.file('ok.txt', 'normal entry');
    zip.file('../out-evil/marker.txt', 'controlled marker', {
      createFolders: false,
    });
    await writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }));

    if (method === 'Extract') {
      await createReadStream(archive)
        .pipe(unzipper.Extract({ path: destination }))
        .promise();
    } else {
      await (await unzipper.Open.file(archive)).extract({ path: destination });
    }

    expect(await readFile(path.join(destination, 'ok.txt'), 'utf8')).toBe(
      'normal entry',
    );
    await expect(
      readFile(path.join(directory, 'out-evil', 'marker.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it('preserves ExcelJS stream writer and reader compatibility', async () => {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const writer = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream,
    useSharedStrings: false,
  });
  const sheet = writer.addWorksheet('Data');
  sheet.addRow(['name', 'count']).commit();
  sheet.addRow(['example', 7]).commit();
  await writer.commit();

  const reader = new ExcelJS.stream.xlsx.WorkbookReader(
    Readable.from([Buffer.concat(chunks)]),
    { worksheets: 'emit', sharedStrings: 'cache' },
  );
  const rows: ExcelJS.CellValue[][] = [];
  for await (const worksheet of reader) {
    for await (const row of worksheet) {
      expect(Array.isArray(row.values)).toBe(true);
      rows.push((row.values as ExcelJS.CellValue[]).slice(1));
    }
  }
  expect(rows).toEqual([
    ['name', 'count'],
    ['example', 7],
  ]);
});
