/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const readFile = fs.promises.readFile;
fs.promises.readFile = async function (file, ...options) {
  // Arm after backup preparation so only the native Edit read is held.
  if (typeof file === 'string' && fs.existsSync(`${file}.read-gate`)) {
    fs.writeFileSync(`${file}.read-entered`, '');
    while (fs.existsSync(`${file}.read-gate`)) await delay(10);
  }
  return readFile.call(this, file, ...options);
};
syncBuiltinESMExports();
