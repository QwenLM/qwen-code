import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { build, normalizePath } from 'vite';
import { expect, it } from 'vitest';
import { exceljsBrowser } from '../exceljs-build';

const require = createRequire(import.meta.url);

it('builds the spreadsheet parser from ExcelJS sources with patched browser dependencies', async () => {
  let files: string[] = [];
  await build({
    configFile: false,
    root: resolve(__dirname, '..'),
    logLevel: 'silent',
    plugins: [
      exceljsBrowser(),
      {
        name: 'inspect-spreadsheet-dependencies',
        generateBundle() {
          files = this.getWatchFiles().map(normalizePath);
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: {
        entry: 'client/components/artifacts/excel-preview-parser.ts',
        formats: ['es'],
      },
    },
  });
  expect(files).toContain(
    normalizePath(require.resolve('exceljs/lib/exceljs.bare.js')),
  );
  expect(
    files.filter((file) =>
      /\/(?:archiver|archiver-utils|glob|inflight|minimatch|unzipper)\//.test(
        file,
      ),
    ),
  ).toEqual([]);
  expect(files.some((file) => /\/exceljs\/dist\//.test(file))).toBe(false);
  const uuidEntry = files.find((file) =>
    file.endsWith('/uuid/dist/cjs-browser/index.js'),
  );
  expect(uuidEntry).toBeDefined();
  const uuid = JSON.parse(
    readFileSync(resolve(dirname(uuidEntry!), '../../package.json'), 'utf8'),
  ) as { version: string };
  expect(uuid.version).toBe('11.1.1');
}, 30_000);
