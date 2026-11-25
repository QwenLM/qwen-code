/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import type {
  BridgeCommittedMidTurnMessage,
  BridgeMidTurnOwnership,
} from './bridgeTypes.js';

function ledgerPath(
  workspaceCwd: string,
  sessionId: string,
  kind: 'commits' | 'ownership' | 'generation',
  runtimeBaseDir?: string,
): string {
  const key = createHash('sha256')
    .update(JSON.stringify([workspaceCwd, sessionId]))
    .digest('hex');
  return path.join(
    new Storage(workspaceCwd, runtimeBaseDir).getProjectDir(),
    'mid-turn-delivery',
    `${key}.${kind}.json`,
  );
}

function readLedger<T>(file: string): T[] {
  try {
    const fd = openSync(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const records: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (!Array.isArray(records)) throw new Error('Invalid mid-turn ledger');
      return records as T[];
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function writeLedger(file: string, messages: readonly unknown[]): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(messages));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Rename publishes the whole batch to a replacement process at once.
    renameSync(temporary, file);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // An unpublished temporary file cannot be replayed.
    }
    throw error;
  }
}

export function readCommittedMidTurnMessages(
  workspaceCwd: string,
  sessionId: string,
  runtimeBaseDir?: string,
): BridgeCommittedMidTurnMessage[] {
  return readLedger(
    ledgerPath(workspaceCwd, sessionId, 'commits', runtimeBaseDir),
  );
}

export function commitMidTurnMessages(
  workspaceCwd: string,
  sessionId: string,
  messages: readonly BridgeCommittedMidTurnMessage[],
  runtimeBaseDir?: string,
): void {
  const file = ledgerPath(workspaceCwd, sessionId, 'commits', runtimeBaseDir);
  const records = new Map(
    readLedger<BridgeCommittedMidTurnMessage>(file).map((entry) => [
      entry.messageId,
      entry,
    ]),
  );
  for (const message of messages) {
    if (!records.has(message.messageId))
      records.set(message.messageId, message);
  }
  writeLedger(file, [...records.values()]);
}

export function clearCommittedMidTurnMessages(
  workspaceCwd: string,
  sessionId: string,
  messageIds: readonly string[],
  runtimeBaseDir?: string,
): void {
  const file = ledgerPath(workspaceCwd, sessionId, 'commits', runtimeBaseDir);
  const previous = readLedger<BridgeCommittedMidTurnMessage>(file);
  const cleared = new Set(messageIds);
  const remaining = previous.filter((entry) => !cleared.has(entry.messageId));
  if (remaining.length < previous.length) {
    if (remaining.length === 0) rmSync(file, { force: true });
    else writeLedger(file, remaining);
  }
}

export function readMidTurnOwnership(
  workspaceCwd: string,
  sessionId: string,
  runtimeBaseDir?: string,
): BridgeMidTurnOwnership[] {
  return readLedger(
    ledgerPath(workspaceCwd, sessionId, 'ownership', runtimeBaseDir),
  );
}

export function writeMidTurnOwnership(
  workspaceCwd: string,
  sessionId: string,
  entries: readonly BridgeMidTurnOwnership[],
  runtimeBaseDir?: string,
): void {
  writeLedger(
    ledgerPath(workspaceCwd, sessionId, 'ownership', runtimeBaseDir),
    entries,
  );
}

export function readMidTurnCancelGeneration(
  workspaceCwd: string,
  sessionId: string,
  runtimeBaseDir?: string,
): number {
  const [generation] = readLedger<number>(
    ledgerPath(workspaceCwd, sessionId, 'generation', runtimeBaseDir),
  );
  if (generation === undefined) return 0;
  if (!Number.isSafeInteger(generation) || generation < 0)
    throw new Error('Invalid mid-turn cancellation generation');
  return generation;
}

export function writeMidTurnCancelGeneration(
  workspaceCwd: string,
  sessionId: string,
  generation: number,
  runtimeBaseDir?: string,
): void {
  writeLedger(
    ledgerPath(workspaceCwd, sessionId, 'generation', runtimeBaseDir),
    [generation],
  );
}

export function deleteMidTurnDeliveryData(
  workspaceCwd: string,
  sessionId: string,
  runtimeBaseDir?: string,
): void {
  for (const kind of ['commits', 'ownership', 'generation'] as const) {
    rmSync(ledgerPath(workspaceCwd, sessionId, kind, runtimeBaseDir), {
      force: true,
    });
  }
}
