/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const buildConfig = fileURLToPath(
  new URL('../bun-build-config.ts', import.meta.url),
);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Bun embedded native assets', () => {
  it.each(['module-first', 'asset-first'])(
    'preserves module exports and raw asset bytes (%s)',
    (order) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'native-assets-'));
      tempDirs.push(dir);
      const manifest = '{"name":"native-fixture"}\n';
      const module = 'export default function value() { return 42; }\n';
      const nativeBytes = Buffer.from([0, 255, 127, 1]);
      writeFileSync(path.join(dir, 'package.json'), manifest);
      writeFileSync(path.join(dir, 'binding.js'), module);
      writeFileSync(path.join(dir, 'binding.node'), nativeBytes);

      const moduleImports = [
        "import manifest from './package.json';",
        "import value from './binding.js';",
      ];
      const assetImports = [
        "import manifestPath from './package.json?embedded-native' with { type: 'file' };",
        "import modulePath from './binding.js?embedded-native' with { type: 'file' };",
        "import nativePath from './binding.node?embedded-native' with { type: 'file' };",
      ];
      writeFileSync(
        path.join(dir, 'entry.ts'),
        [
          ...(order === 'module-first'
            ? [...moduleImports, ...assetImports]
            : [...assetImports, ...moduleImports]),
          "import { readFileSync } from 'node:fs';",
          'console.log(JSON.stringify({',
          '  name: manifest.name, value: value(),',
          "  manifest: readFileSync(manifestPath, 'utf8'),",
          "  module: readFileSync(modulePath, 'utf8'),",
          "  native: readFileSync(nativePath).toString('hex'),",
          '}));',
        ].join('\n'),
      );
      writeFileSync(
        path.join(dir, 'build.ts'),
        `import { createEmbeddedNativeAssetsPlugin } from ${JSON.stringify(buildConfig)};
const result = await Bun.build({
  entrypoints: ['./entry.ts'],
  target: 'bun', format: 'esm', minify: true,
  outdir: './out', naming: 'entry.js',
  plugins: [createEmbeddedNativeAssetsPlugin()],
});
if (!result.success) throw new AggregateError(result.logs, 'Build failed');
`,
      );

      const build = spawnSync('bun', ['run', 'build.ts'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(build.status, build.stderr || build.error?.message).toBe(0);

      const run = spawnSync('bun', ['entry.js'], {
        cwd: path.join(dir, 'out'),
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(run.status, run.stderr || run.error?.message).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        name: 'native-fixture',
        value: 42,
        manifest,
        module,
        native: nativeBytes.toString('hex'),
      });
    },
    60_000,
  );
});
