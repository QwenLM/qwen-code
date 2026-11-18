import { createRequire } from 'node:module';
import { PassThrough, Transform } from 'node:stream';
import browserify from 'browserify';
import { normalizePath, transformWithEsbuild, type Plugin } from 'vite';

const require = createRequire(import.meta.url);
const EXCELJS_BROWSER_ID = '\0web-shell-exceljs-browser';

function transformUuid(file: string) {
  if (!normalizePath(file).includes('/uuid/') || !file.endsWith('.js'))
    return new PassThrough();
  let source = '';
  // Browserify's parser predates the logical assignments used by UUID 11.
  return new Transform({
    transform(chunk, _encoding, callback) {
      source += chunk.toString();
      callback();
    },
    flush(callback) {
      void transformWithEsbuild(source, file, { target: 'es2019' }).then(
        ({ code }) => callback(null, code),
        callback,
      );
    },
  });
}

export function exceljsBrowser(): Plugin {
  return {
    name: 'web-shell-exceljs-browser',
    enforce: 'pre',
    resolveId(source) {
      if (source === 'exceljs') return EXCELJS_BROWSER_ID;
      return undefined;
    },
    load(id) {
      if (id !== EXCELJS_BROWSER_ID) return undefined;
      return new Promise<string>((resolve, reject) => {
        // The upstream dist bundle embeds dependencies that overrides cannot fix.
        browserify({
          entries: [require.resolve('exceljs/lib/exceljs.bare.js')],
          standalone: 'ExcelJS',
        })
          .transform(transformUuid, { global: true })
          .on('file', (file: string) => this.addWatchFile(file))
          .bundle((error, buffer) => {
            if (error) return reject(error);
            resolve(
              `const module = { exports: {} };\nconst exports = module.exports;\n${buffer.toString()}\nexport default module.exports;`,
            );
          });
      });
    },
  };
}
