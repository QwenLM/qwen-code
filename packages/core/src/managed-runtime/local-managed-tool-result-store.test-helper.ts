/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import type { ManagedSessionKey } from './managed-session-records.js';
import { LocalToolResultSegmentStore } from './local-managed-tool-result-store.js';

type Command =
  | {
      id: number;
      type: 'open';
      runtimeBaseDir: string;
      transcriptPath: string;
      sessionKey: ManagedSessionKey;
    }
  | {
      id: number;
      type: 'publish' | 'publishWithoutReply';
      captureId: string;
      streamId: string;
      ordinal: number;
      base64: string;
    }
  | {
      id: number;
      type: 'seal' | 'sealWithoutReply';
      captureId: string;
      streamId: string;
      segmentCount: number;
      byteLength: number;
      digest: string;
    }
  | { id: number; type: 'staging'; captureId: string; streamId: string };

let store: LocalToolResultSegmentStore | undefined;

async function execute(command: Command): Promise<unknown> {
  if (command.type === 'open') {
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: command.runtimeBaseDir,
      sessionId: command.sessionKey.sessionId,
      transcriptPath: command.transcriptPath,
    });
    store = await LocalToolResultSegmentStore.openWritable({
      lease,
      sessionKey: command.sessionKey,
    });
    return 'opened';
  }
  if (!store) throw new Error('store is not open');
  if (command.type === 'publish' || command.type === 'publishWithoutReply') {
    const result = await store.publish({
      captureId: command.captureId,
      streamId: command.streamId,
      ordinal: command.ordinal,
      bytes: Buffer.from(command.base64, 'base64'),
    });
    if (command.type === 'publishWithoutReply')
      process.kill(process.pid, 'SIGKILL');
    return result;
  }
  if (command.type === 'seal' || command.type === 'sealWithoutReply') {
    const result = await store.seal({
      captureId: command.captureId,
      streamId: command.streamId,
      segmentCount: command.segmentCount,
      byteLength: command.byteLength,
      digest: command.digest,
    });
    if (command.type === 'sealWithoutReply')
      process.kill(process.pid, 'SIGKILL');
    return result;
  }
  const stream = path.join(
    store.root,
    `capture-${command.captureId}`,
    `stream-${command.streamId}`,
  );
  await mkdir(path.join(stream, '.pending-crashed'), { recursive: true });
  await writeFile(
    path.join(stream, '.pending-crashed', 'bytes'),
    'unpublished',
  );
  return 'staged';
}

process.on('message', (value: unknown) => {
  const command = value as Command;
  void execute(command).then(
    (result) => process.send?.({ id: command.id, ok: true, result }),
    (error: unknown) =>
      process.send?.({
        id: command.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
});
