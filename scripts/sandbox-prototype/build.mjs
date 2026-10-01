/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(source, '../..');
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) {
  throw new Error(
    'Supply an absolute, empty prototype installation directory.',
  );
}
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error('Output must be empty.');
const result = await build({
  absWorkingDir: root,
  entryPoints: ['scripts/sandbox-prototype/api.mjs'],
  outfile: path.join(output, 'shell-service.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@lydell/node-pty', 'node-pty'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  metafile: true,
});
const workers = await build({
  absWorkingDir: root,
  entryPoints: {
    sandboxBwrapRelay: 'packages/core/src/sandbox/bwrap-relay.ts',
    sandboxFileWorker: 'packages/core/src/sandbox/file-worker.ts',
  },
  outdir: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  metafile: true,
});
await writeFile(path.join(output, 'package.json'), '{"type":"module"}\n');
const hash = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const inputs = {};
for (const file of Object.keys({
  ...result.metafile.inputs,
  ...workers.metafile.inputs,
})) {
  inputs[file] = await hash(path.resolve(root, file));
}
for (const name of ['verify.mjs']) {
  await copyFile(path.join(source, name), path.join(output, name));
}
const artifacts = {};
for (const name of await readdir(output)) {
  artifacts[name] = await hash(path.join(output, name));
}
const dirty =
  execFileSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  }).trim() !== '';
await writeFile(
  path.join(output, 'manifest.json'),
  JSON.stringify(
    {
      revision: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      dirty,
      inputs,
      artifacts,
    },
    null,
    2,
  ) + '\n',
);
if (dirty) console.warn('WARNING: prototype built from a dirty worktree.');
console.log(`Prototype installed at ${output}`);
