/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { open } from 'node:fs/promises';
import { inspectOriginalReceiptCheckpointCoverage } from '@qwen-code/qwen-code-core/managed-runtime/original-receipt-checkpoint.js';
import { parseManagedSessionRecordJson } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';

const file = process.argv[2];
if (process.argv.length !== 3 || file === undefined) {
  throw new Error('Usage: managed-csi-checkpoint-evidence <snapshot-json>');
}
const handle = await open(file, 'r');
let bytes: Buffer;
try {
  const limit = 48 * 1024 * 1024;
  if ((await handle.stat()).size > limit)
    throw new Error('Snapshot exceeds its size limit.');
  bytes = Buffer.alloc(limit + 1);
  let length = 0;
  while (length <= limit) {
    const read = await handle.read(bytes, length, bytes.length - length, null);
    if (read.bytesRead === 0) break;
    length += read.bytesRead;
  }
  if (length > limit) throw new Error('Snapshot exceeds its size limit.');
  bytes = bytes.subarray(0, length);
} finally {
  await handle.close();
}
const result = await inspectOriginalReceiptCheckpointCoverage(
  parseManagedSessionRecordJson(bytes.toString('utf8'), 48 * 1024 * 1024),
);
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.status === 'matched' ? 0 : 1;
