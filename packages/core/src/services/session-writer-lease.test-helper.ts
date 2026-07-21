/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SessionWriterError,
  SessionWriterLease,
  type AcquireSessionWriterLeaseOptions,
} from './session-writer-lease.js';

export type SessionWriterLeaseTestCommandInput =
  | {
      type: 'acquire';
      options: AcquireSessionWriterLeaseOptions;
    }
  | { type: 'append'; value: unknown }
  | { type: 'release' };

export type SessionWriterLeaseTestCommand =
  SessionWriterLeaseTestCommandInput & { id: number };

export interface SessionWriterLeaseTestResponse {
  id: number;
  ok: boolean;
  ownerId?: string;
  errorKind?: string;
  message?: string;
}

let lease: SessionWriterLease | undefined;

async function handleCommand(
  command: SessionWriterLeaseTestCommand,
): Promise<void> {
  try {
    if (command.type === 'acquire') {
      lease = await SessionWriterLease.acquire(command.options);
      process.send?.({ id: command.id, ok: true, ownerId: lease.ownerId });
      return;
    }
    if (!lease) throw new Error('Lease has not been acquired');
    if (command.type === 'append') {
      await lease.appendJsonLine(command.value);
    } else {
      await lease.release();
      lease = undefined;
    }
    process.send?.({ id: command.id, ok: true });
  } catch (error) {
    process.send?.({
      id: command.id,
      ok: false,
      ...(error instanceof SessionWriterError
        ? { errorKind: error.errorKind }
        : {}),
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

process.on('message', (message: unknown) => {
  void handleCommand(message as SessionWriterLeaseTestCommand);
});
