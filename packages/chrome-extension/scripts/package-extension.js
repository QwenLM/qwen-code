/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const extensionRoot = path.join(packageRoot, 'dist/extension');
if (
  process.env.EXTENSION_OUT_DIR &&
  path.resolve(packageRoot, process.env.EXTENSION_OUT_DIR) !== extensionRoot
) {
  throw new Error('Release packaging requires dist/extension output');
}
const archive = path.join(packageRoot, 'chrome-extension.zip');

await rm(archive, { force: true });
await new Promise((resolve, reject) => {
  const output = createWriteStream(archive);
  const zip = archiver('zip', { zlib: { level: 9 } });
  output.once('close', resolve);
  output.once('error', reject);
  zip.once('error', reject);
  zip.once('warning', reject);
  zip.pipe(output);
  zip.directory(extensionRoot, false);
  void zip.finalize();
});
console.log(`Created ${archive}`);
