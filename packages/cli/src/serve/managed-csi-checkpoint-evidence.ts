/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { open } from 'node:fs/promises';
import {
  inspectOriginalReceiptCheckpointCoverage,
  type OriginalReceiptCheckpointObservation,
} from '@qwen-code/qwen-code-core/managed-runtime/original-receipt-checkpoint.js';
import { parseManagedSessionRecordJson } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  inspectOriginalFileCheckpointCoverage,
  type OriginalFileCheckpointObservation,
} from '@qwen-code/qwen-code-core/managed-runtime/original-file-checkpoint.js';
import {
  inspectOriginalCsiInventory,
  type OriginalCsiInventoryObservation,
} from '@qwen-code/qwen-code-core/managed-runtime/original-csi-inventory.js';
import {
  inspectOriginalCsiRetirementBoundary,
  type OriginalCsiRetirementBoundaryObservation,
} from '@qwen-code/qwen-code-core/managed-runtime/original-csi-retirement-boundary.js';

const file = process.argv[2];
if (process.argv.length !== 3 || file === undefined) {
  throw new Error('Usage: managed-csi-checkpoint-evidence <snapshot-json>');
}
let result:
  | OriginalReceiptCheckpointObservation
  | OriginalFileCheckpointObservation
  | OriginalCsiInventoryObservation
  | OriginalCsiRetirementBoundaryObservation;
try {
  const handle = await open(file, 'r');
  const limit = 48 * 1024 * 1024;
  let bytes: Buffer;
  try {
    if ((await handle.stat()).size > limit)
      throw new Error('Snapshot exceeds its size limit.');
    bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const read = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > limit) throw new Error('Snapshot exceeds its size limit.');
    bytes = bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
  const snapshot = parseManagedSessionRecordJson(bytes.toString('utf8'), limit);
  const format =
    snapshot !== null &&
    typeof snapshot === 'object' &&
    !Array.isArray(snapshot)
      ? snapshot['format']
      : undefined;
  result = await (
    format === 'qwen-csi-session-retirement-boundary/1'
      ? inspectOriginalCsiRetirementBoundary
      : format === 'qwen-csi-retirement-inventory/1'
        ? inspectOriginalCsiInventory
        : format === 'qwen-csi-session-checkpoint-snapshot/1'
          ? inspectOriginalFileCheckpointCoverage
          : inspectOriginalReceiptCheckpointCoverage
  )(snapshot);
} catch (error) {
  result = {
    status: 'unresolved',
    reason: error instanceof Error ? error.message : 'Invalid snapshot.',
  };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode =
  result.status === 'matched' || result.status === 'observed' ? 0 : 1;
