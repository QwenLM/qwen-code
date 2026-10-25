/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Content } from '@google/genai';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import type { HistoryItem } from '../types.js';

export async function writeToolCheckpoint(options: {
  directory: string;
  request: Pick<ToolCallRequestInfo, 'callId' | 'name' | 'args' | 'prompt_id'>;
  isCurrent: () => boolean;
  snapshot: () => {
    history: HistoryItem[];
    clientHistory: Content[];
    promptIds?: Array<string | null>;
  };
}): Promise<string | undefined> {
  if (!options.isCurrent()) return;
  const filePath =
    options.request.args['file_path'] ?? options.request.args['notebook_path'];
  if (typeof filePath !== 'string' || !filePath) return;
  // Capture and serialize before the first filesystem await. Missing native
  // canonical sources throw here; no partial checkpoint is written.
  const payload = JSON.stringify(
    {
      ...options.snapshot(),
      toolCall: {
        callId: options.request.callId,
        name: options.request.name,
        args: options.request.args,
      },
      promptId: options.request.prompt_id,
      filePath,
    },
    null,
    2,
  );
  const timestamp = new Date()
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\./g, '_');
  const nonce = randomUUID();
  const destination = path.join(
    options.directory,
    `${timestamp}-${nonce}-${path.basename(filePath)}-${options.request.name}.json`,
  );
  await mkdir(options.directory, { recursive: true });
  if (!options.isCurrent()) return;
  const temporary = path.join(options.directory, `.checkpoint-${nonce}.tmp`);
  try {
    await writeFile(temporary, payload, { flag: 'wx' });
    if (!options.isCurrent()) return;
    // Only the short publication step is synchronous; cancellation cannot run
    // between the final owner check and publishing a fully written file.
    renameSync(temporary, destination);
    return destination;
  } finally {
    await rm(temporary, { force: true });
  }
}
