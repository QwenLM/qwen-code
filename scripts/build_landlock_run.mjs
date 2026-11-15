/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { chmodSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arch = process.argv[2];
if (!['x64', 'arm64'].includes(arch)) {
  console.error('usage: node scripts/build_landlock_run.mjs <x64|arm64>');
  process.exit(2);
}

const source = path.join(
  root,
  'packages/core/vendor/landlock-run/src/qwen-landlock-run.c',
);
const output = path.join(
  root,
  `packages/core/vendor/landlock-run/${arch}-linux/qwen-landlock-run`,
);
mkdirSync(path.dirname(output), { recursive: true });

const compiler = process.env['CC'] || 'musl-gcc';
const compilerArgs =
  path.basename(compiler) === 'zig'
    ? [
        'cc',
        '-target',
        arch === 'x64' ? 'x86_64-linux-musl' : 'aarch64-linux-musl',
      ]
    : [];
const result = spawnSync(
  compiler,
  [
    ...compilerArgs,
    '-std=c11',
    '-Os',
    '-static',
    '-s',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-o',
    output,
    source,
  ],
  { cwd: root, stdio: 'inherit' },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const header = readFileSync(output).subarray(0, 20);
const expectedMachine = arch === 'x64' ? 62 : 183;
if (
  header.length < 20 ||
  !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
  header[4] !== 2 ||
  header[5] !== 1 ||
  header.readUInt16LE(18) !== expectedMachine
) {
  unlinkSync(output);
  throw new Error(`Compiler did not produce a Linux ${arch} ELF.`);
}
chmodSync(output, 0o755);
