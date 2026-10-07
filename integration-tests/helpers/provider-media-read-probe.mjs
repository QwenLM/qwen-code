/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import childProcess from 'node:child_process';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const counts = {};
const write = fs.writeFileSync;
function record(file) {
  if (
    typeof file !== 'string' ||
    !/^proof\.(png|jpeg|webp|gif|pdf)$/.test(path.basename(file))
  )
    return;
  const key = path.resolve(file);
  counts[key] = (counts[key] ?? 0) + 1;
  write(
    path.join(path.dirname(key), '.provider-media-reads.json'),
    JSON.stringify(counts),
  );
}
for (const [owner, names] of [
  [fs.promises, ['open', 'readFile']],
  [fs, ['open', 'openSync', 'readFile', 'readFileSync', 'createReadStream']],
]) {
  for (const name of names) {
    const original = owner[name];
    owner[name] = function (file, ...args) {
      record(file);
      return original.call(this, file, ...args);
    };
  }
}
const execFile = childProcess.execFile;
childProcess.execFile = function (command, args, ...options) {
  if (
    ['pdfinfo', 'pdftotext', 'pdftoppm'].includes(path.basename(command)) &&
    Array.isArray(args)
  ) {
    for (const file of args) record(file);
  }
  return execFile.call(this, command, args, ...options);
};
Object.defineProperties(
  childProcess.execFile,
  Object.getOwnPropertyDescriptors(execFile),
);
syncBuiltinESMExports();
