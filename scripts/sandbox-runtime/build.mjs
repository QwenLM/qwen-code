/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { wasmLoader } from 'esbuild-plugin-wasm';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hashFile, readSourceIdentity } from './source-manifest.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(source, '../..');
const output = process.argv[2];
if (!output || !path.isAbsolute(output))
  throw new Error('Supply empty absolute artifact directory');
await fs.mkdir(output, { recursive: true });
if ((await fs.readdir(output)).length)
  throw new Error('Artifact directory must be empty');
const require = createRequire(import.meta.url);
const coreExports = JSON.parse(
  await fs.readFile(path.join(root, 'packages/core/package.json'), 'utf8'),
).exports;
const coreSource = (specifier) => {
  const key =
    specifier === '@qwen-code/qwen-code-core'
      ? '.'
      : './' + specifier.slice('@qwen-code/qwen-code-core/'.length);
  const entry = coreExports[key];
  const file = typeof entry === 'string' ? entry : entry?.import;
  if (key === '.') return path.join(root, 'packages/core/src/index.ts');
  return path.join(
    root,
    'packages/core',
    (file ?? './src/' + key.slice(2))
      .replace('./dist/src/', './src/')
      .replace(/\.js$/, '.ts'),
  );
};
const common = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  metafile: true,
  external: [
    '@lydell/node-pty',
    'node-pty',
    '@qwen-code/audio-capture',
    '@teddyzhu/clipboard',
    'sharp',
  ],
  inject: [path.join(root, 'scripts/esbuild-shims.js')],
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.CLI_VERSION': '"0.23.4-internal-test"',
    global: 'globalThis',
    __dirname: '__qwen_dirname',
    __filename: '__qwen_filename',
  },
  loader: { '.node': 'file' },
  alias: {
    'is-in-ci': path.join(root, 'packages/cli/src/patches/is-in-ci.ts'),
    'jsonc-parser': require.resolve('jsonc-parser/lib/esm/main.js'),
    '@qwen-code/web-templates': path.join(
      root,
      'packages/web-templates/src/index.ts',
    ),
    punycode: require.resolve('punycode/'),
  },
  plugins: [
    {
      name: 'actual-core-source',
      setup(b) {
        b.onResolve(
          { filter: /^@qwen-code\/qwen-code-core(?:\/|$)/ },
          (args) => ({ path: coreSource(args.path) }),
        );
      },
    },
    {
      name: 'wasm-binary',
      setup(b) {
        b.onResolve({ filter: /\.wasm\?binary$/ }, (args) => ({
          path: createRequire(path.join(args.resolveDir, '_dummy_.js')).resolve(
            args.path.replace(/\?binary$/, ''),
          ),
          namespace: 'wasm-binary',
        }));
        b.onLoad({ filter: /.*/, namespace: 'wasm-binary' }, async (args) => ({
          contents: await fs.readFile(args.path),
          loader: 'binary',
        }));
      },
    },
    wasmLoader({ mode: 'embedded' }),
  ],
};
const result = await build({
  ...common,
  entryPoints: [path.join(source, 'launcher.mjs')],
  outfile: path.join(output, 'launcher.mjs'),
});
const workers = await build({
  ...common,
  entryPoints: {
    sandboxBwrapRelay: 'packages/core/src/sandbox/bwrap-relay.ts',
    sandboxFileWorker: 'packages/core/src/sandbox/file-worker.ts',
  },
  outdir: output,
});
await fs.writeFile(path.join(output, 'package.json'), '{"type":"module"}\n');
const inputs = {};
for (const file of Object.keys({
  ...result.metafile.inputs,
  ...workers.metafile.inputs,
})) {
  if (file.startsWith('wasm-binary:')) continue;
  try {
    inputs[file] = await hashFile(path.resolve(root, file));
  } catch {
    /* virtual loader modules are described in esbuild metafile */
  }
}
for (const name of [
  'baseline.mjs',
  'build.mjs',
  'launcher.mjs',
  'source-manifest.mjs',
  'verify.mjs',
  'README.md',
]) {
  const file = path.join(source, name);
  inputs[path.relative(root, file)] = await hashFile(file);
}
const sourceManifestTest = path.join(
  root,
  'scripts/tests/sandbox-runtime-source-manifest.test.js',
);
inputs[path.relative(root, sourceManifestTest)] =
  await hashFile(sourceManifestTest);
await fs.copyFile(
  path.join(source, 'verify.mjs'),
  path.join(output, 'verify.mjs'),
);
await fs.copyFile(
  path.join(source, 'source-manifest.mjs'),
  path.join(output, 'source-manifest.mjs'),
);
const artifacts = {};
for (const file of await fs.readdir(output))
  artifacts[file] = await hashFile(path.join(output, file));
const sourceIdentity = readSourceIdentity(root);
await fs.writeFile(
  path.join(output, 'manifest.json'),
  JSON.stringify(
    {
      created: new Date().toISOString(),
      ...sourceIdentity,
      inputs,
      artifacts,
    },
    null,
    2,
  ),
);
if (sourceIdentity.dirty)
  console.warn('WARNING: candidate built from a dirty worktree.');
console.log(
  JSON.stringify(
    { output, inputs: Object.keys(inputs).length, artifacts },
    null,
    2,
  ),
);
