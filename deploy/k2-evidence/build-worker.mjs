/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const output = process.argv[2];
if (process.argv.length !== 3 || !output || !path.isAbsolute(output)) {
  throw new Error('Supply a new absolute worker artifact directory');
}
await mkdir(output, { mode: 0o700 });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inputs = new Map();
const packageBytes = await readFile(path.join(root, 'package.json'));
inputs.set(path.join(root, 'package.json'), {
  path: path.join(root, 'package.json'),
  bytes: packageBytes.length,
  sha256: sha(packageBytes),
});
const loaders = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.json': 'json',
  '.wasm': 'binary',
};
const result = await build({
  absWorkingDir: root,
  stdin: {
    contents: `import { runManagedRuntimeAttestationWorker } from './packages/cli/src/serve/managed-runtime-attestation-worker.ts';
const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== 'managed-runtime-worker' || args[1] !== '--container-boot' || args[2] !== '/var/run/qwen-runtime/boot.json') throw new Error('Invalid private worker invocation');
await runManagedRuntimeAttestationWorker(args[2]);`,
    resolveDir: root,
    sourcefile: 'k2-container-entry.mjs',
    loader: 'js',
  },
  outfile: path.join(output, 'worker.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  write: false,
  metafile: true,
  sourcemap: false,
  inject: [path.join(root, 'scripts/esbuild-shims.js')],
  define: {
    'process.env.CLI_VERSION': JSON.stringify(JSON.parse(packageBytes).version),
    'process.env.NODE_ENV': JSON.stringify('production'),
    global: 'globalThis',
    __dirname: '__qwen_dirname',
    __filename: '__qwen_filename',
  },
  plugins: [
    {
      name: 'pin-worker-input-bytes',
      setup(builder) {
        builder.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
          const loader = loaders[path.extname(args.path)];
          if (!loader) throw new Error('Unsupported worker module artifact');
          const stat = await lstat(args.path);
          if (!stat.isFile() || stat.size > 32 * 1024 * 1024) {
            throw new Error('Worker module is not a bounded regular file');
          }
          const bytes = await readFile(args.path);
          const previous = inputs.get(args.path);
          const pin = {
            path: args.path,
            bytes: bytes.length,
            sha256: sha(bytes),
          };
          if (previous && previous.sha256 !== pin.sha256) {
            throw new Error('Worker module changed during compilation');
          }
          inputs.set(args.path, pin);
          return {
            contents: bytes,
            loader,
            resolveDir: path.dirname(args.path),
          };
        });
      },
    },
  ],
});
if (result.warnings.length || result.outputFiles.length !== 1) {
  throw new Error('Worker bundle has unsupported diagnostics or outputs');
}
for (const pin of inputs.values()) {
  if (sha(await readFile(pin.path)) !== pin.sha256) {
    throw new Error('Worker input changed before artifact closing');
  }
}
const artifact = result.outputFiles[0];
await writeFile(artifact.path, artifact.contents, { flag: 'wx', mode: 0o600 });
await writeFile(
  path.join(output, 'metafile.json'),
  JSON.stringify(result.metafile, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 },
);
const manifest = {
  schemaVersion: 1,
  bundle: {
    file: 'worker.mjs',
    bytes: artifact.contents.length,
    sha256: sha(artifact.contents),
  },
  command: ['/usr/local/bin/node', '/opt/qwen-k2/worker.mjs'],
  requiredArguments: [
    'managed-runtime-worker',
    '--container-boot',
    '/var/run/qwen-runtime/boot.json',
  ],
  inputs: [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path)),
  qualified: false,
};
await writeFile(
  path.join(output, 'bundle-manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 },
);
process.stdout.write(
  JSON.stringify({
    output,
    ...manifest.bundle,
    inputCount: inputs.size,
    qualified: false,
  }) + '\n',
);
