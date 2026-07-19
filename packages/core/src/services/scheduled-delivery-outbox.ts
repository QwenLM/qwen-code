/**
 * Cross-process handoff between a scheduled-task session and the daemon's
 * Channel delivery dispatcher. Records are workspace-private runtime state,
 * never project files.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';
import lockfile from 'proper-lockfile';
import { Storage } from '../config/storage.js';
import { getProjectHash } from '../utils/paths.js';
import { atomicWriteJSON } from '../utils/atomicFileWrite.js';
import {
  MAX_CHANNEL_DELIVERY_NAME_LENGTH,
  MAX_CHANNEL_DELIVERY_TARGET_ID_LENGTH,
  type CronTaskChannelTarget,
} from './cronTasksFile.js';

export type ScheduledDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'retryable'
  | 'delivered'
  | 'failed';

export interface ScheduledDeliveryError {
  code: string;
  message: string;
}

export interface ScheduledDeliveryRecord {
  deliveryId: string;
  taskId: string;
  firedAt: number;
  channelName: string;
  target: CronTaskChannelTarget;
  text: string;
  status: ScheduledDeliveryStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  leaseExpiresAt?: number;
  lastError?: ScheduledDeliveryError;
}

export interface EnqueueScheduledDeliveryInput {
  deliveryId: string;
  taskId: string;
  firedAt: number;
  channelName: string;
  target: CronTaskChannelTarget;
  text: string;
  createdAt?: number;
}

export type CompleteScheduledDeliveryInput =
  | {
      deliveryId: string;
      outcome: 'delivered';
      now?: number;
    }
  | {
      deliveryId: string;
      outcome: 'retryable';
      now?: number;
      nextAttemptAt: number;
      error: ScheduledDeliveryError;
    }
  | {
      deliveryId: string;
      outcome: 'failed';
      now?: number;
      error: ScheduledDeliveryError;
    };

const OUTBOX_FILENAME = 'scheduled_deliveries.json';
const OUTBOX_GUARD_FILENAME = 'scheduled_deliveries.guard';
const MAX_RECORDS = 200;
const MAX_TEXT_LENGTH = 100_000;
const TRUNCATED_TEXT_SUFFIX =
  '\n\n[Channel delivery truncated because the result exceeded the outbox size limit.]';
const MAX_ID_LENGTH = 256;
const MAX_ERROR_CODE_LENGTH = 128;
const MAX_ERROR_MESSAGE_LENGTH = 1000;

const LOCK_OPTIONS: lockfile.LockOptions = {
  realpath: false,
  stale: 10_000,
  retries: {
    retries: 20,
    minTimeout: 10,
    maxTimeout: 250,
    factor: 2,
    randomize: true,
  },
};

const outboxMutexes = new Map<string, Mutex>();

function getOutboxMutex(file: string): Mutex {
  let mutex = outboxMutexes.get(file);
  if (!mutex) {
    mutex = new Mutex();
    outboxMutexes.set(file, mutex);
  }
  return mutex;
}

function getOutboxDirectory(projectRoot: string): string {
  return path.join(Storage.getGlobalTempDir(), getProjectHash(projectRoot));
}

export function getScheduledDeliveryOutboxPath(projectRoot: string): string {
  return path.join(getOutboxDirectory(projectRoot), OUTBOX_FILENAME);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maxLength
  );
}

function isValidTarget(value: unknown): value is CronTaskChannelTarget {
  if (typeof value !== 'object' || value === null) return false;
  const target = value as Record<string, unknown>;
  return (
    (target['type'] === 'user' || target['type'] === 'chat') &&
    isBoundedString(target['id'], MAX_CHANNEL_DELIVERY_TARGET_ID_LENGTH) &&
    target['id'].trim().length > 0 &&
    Object.keys(target).every((key) => key === 'type' || key === 'id')
  );
}

function isValidError(value: unknown): value is ScheduledDeliveryError {
  if (typeof value !== 'object' || value === null) return false;
  const error = value as Record<string, unknown>;
  return (
    isBoundedString(error['code'], MAX_ERROR_CODE_LENGTH) &&
    isBoundedString(error['message'], MAX_ERROR_MESSAGE_LENGTH)
  );
}

function isValidRecord(value: unknown): value is ScheduledDeliveryRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isBoundedString(record['deliveryId'], MAX_ID_LENGTH) &&
    isBoundedString(record['taskId'], MAX_ID_LENGTH) &&
    isFiniteNumber(record['firedAt']) &&
    isBoundedString(record['channelName'], MAX_CHANNEL_DELIVERY_NAME_LENGTH) &&
    (record['channelName'] as string).trim().length > 0 &&
    isValidTarget(record['target']) &&
    isBoundedString(record['text'], MAX_TEXT_LENGTH) &&
    (record['status'] === 'pending' ||
      record['status'] === 'sending' ||
      record['status'] === 'retryable' ||
      record['status'] === 'delivered' ||
      record['status'] === 'failed') &&
    Number.isInteger(record['attempts']) &&
    (record['attempts'] as number) >= 0 &&
    isFiniteNumber(record['createdAt']) &&
    isFiniteNumber(record['updatedAt']) &&
    (record['nextAttemptAt'] === undefined ||
      isFiniteNumber(record['nextAttemptAt'])) &&
    (record['leaseExpiresAt'] === undefined ||
      isFiniteNumber(record['leaseExpiresAt'])) &&
    (record['lastError'] === undefined || isValidError(record['lastError']))
  );
}

async function readOutboxFile(
  file: string,
): Promise<ScheduledDeliveryRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Malformed JSON in ${file}; refusing to replace the outbox.`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_RECORDS) {
    throw new Error(`Invalid scheduled delivery outbox in ${file}.`);
  }
  for (const record of parsed) {
    if (!isValidRecord(record)) {
      throw new Error(`Invalid scheduled delivery record in ${file}.`);
    }
  }
  return parsed;
}

async function hardenExistingOutboxPermissions(file: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Invalid scheduled delivery outbox in ${file}.`);
  }
  await fs.chmod(file, 0o600);
}

export async function readScheduledDeliveryOutbox(
  projectRoot: string,
): Promise<ScheduledDeliveryRecord[]> {
  return readOutboxFile(getScheduledDeliveryOutboxPath(projectRoot));
}

async function mutateOutbox<T>(
  projectRoot: string,
  mutate: (records: ScheduledDeliveryRecord[]) => {
    records: ScheduledDeliveryRecord[];
    result: T;
  },
): Promise<T> {
  const directory = getOutboxDirectory(projectRoot);
  const file = getScheduledDeliveryOutboxPath(projectRoot);
  const guard = path.join(directory, OUTBOX_GUARD_FILENAME);
  return getOutboxMutex(file).runExclusive(async () => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    await fs.writeFile(guard, '', { flag: 'a', mode: 0o600 });
    await fs.chmod(guard, 0o600);
    const release = await lockfile.lock(guard, LOCK_OPTIONS);
    try {
      await hardenExistingOutboxPermissions(file);
      const current = await readOutboxFile(file);
      const next = mutate(current);
      if (next.records !== current) {
        await atomicWriteJSON(file, next.records, {
          noFollow: true,
          mode: 0o600,
          forceMode: true,
        });
      }
      return next.result;
    } finally {
      await release().catch(() => undefined);
    }
  });
}

function normalizeDeliveryText(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) return text;
  const prefixLimit = MAX_TEXT_LENGTH - TRUNCATED_TEXT_SUFFIX.length;
  let prefix = text.slice(0, prefixLimit);
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}${TRUNCATED_TEXT_SUFFIX}`;
}

function sameEnqueue(
  record: ScheduledDeliveryRecord,
  input: EnqueueScheduledDeliveryInput,
): boolean {
  return (
    record.taskId === input.taskId &&
    record.firedAt === input.firedAt &&
    record.channelName === input.channelName &&
    record.text === input.text &&
    JSON.stringify(record.target) === JSON.stringify(input.target)
  );
}

export async function enqueueScheduledDelivery(
  projectRoot: string,
  input: EnqueueScheduledDeliveryInput,
): Promise<ScheduledDeliveryRecord> {
  const normalizedInput: EnqueueScheduledDeliveryInput = {
    ...input,
    text: normalizeDeliveryText(input.text),
  };
  const createdAt = normalizedInput.createdAt ?? Date.now();
  const candidate: ScheduledDeliveryRecord = {
    deliveryId: normalizedInput.deliveryId,
    taskId: normalizedInput.taskId,
    firedAt: normalizedInput.firedAt,
    channelName: normalizedInput.channelName,
    target: { ...normalizedInput.target },
    text: normalizedInput.text,
    status: 'pending',
    attempts: 0,
    createdAt,
    updatedAt: createdAt,
  };
  if (!isValidRecord(candidate)) {
    throw new Error('Invalid scheduled delivery enqueue input.');
  }
  return mutateOutbox(projectRoot, (records) => {
    const existing = records.find(
      (record) => record.deliveryId === normalizedInput.deliveryId,
    );
    if (existing) {
      if (!sameEnqueue(existing, normalizedInput)) {
        throw new Error(
          `Refusing conflicting delivery id ${JSON.stringify(normalizedInput.deliveryId)}.`,
        );
      }
      return { records, result: existing };
    }
    let retained = records;
    if (retained.length >= MAX_RECORDS) {
      const terminalIndex = retained.findIndex(
        (record) => record.status === 'delivered' || record.status === 'failed',
      );
      if (terminalIndex < 0) {
        throw new Error('Scheduled delivery outbox is full.');
      }
      retained = retained.filter((_, index) => index !== terminalIndex);
    }
    return { records: [...retained, candidate], result: candidate };
  });
}

export async function claimScheduledDelivery(
  projectRoot: string,
  options: { now?: number; leaseMs: number },
): Promise<ScheduledDeliveryRecord | null> {
  const now = options.now ?? Date.now();
  if (
    !isFiniteNumber(now) ||
    !isFiniteNumber(options.leaseMs) ||
    options.leaseMs <= 0
  ) {
    throw new Error('Invalid scheduled delivery claim options.');
  }
  return mutateOutbox(projectRoot, (records) => {
    const candidate = records
      .filter(
        (record) =>
          record.status === 'pending' ||
          (record.status === 'retryable' &&
            (record.nextAttemptAt ?? 0) <= now) ||
          (record.status === 'sending' && (record.leaseExpiresAt ?? 0) <= now),
      )
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.deliveryId.localeCompare(right.deliveryId),
      )[0];
    if (!candidate) return { records, result: null };
    const claimed: ScheduledDeliveryRecord = {
      ...candidate,
      status: 'sending',
      attempts: candidate.attempts + 1,
      updatedAt: now,
      leaseExpiresAt: now + options.leaseMs,
    };
    delete claimed.nextAttemptAt;
    delete claimed.lastError;
    return {
      records: records.map((record) =>
        record.deliveryId === claimed.deliveryId ? claimed : record,
      ),
      result: claimed,
    };
  });
}

export async function completeScheduledDelivery(
  projectRoot: string,
  input: CompleteScheduledDeliveryInput,
): Promise<ScheduledDeliveryRecord> {
  const now = input.now ?? Date.now();
  if (!isFiniteNumber(now))
    throw new Error('Invalid delivery completion time.');
  return mutateOutbox(projectRoot, (records) => {
    const current = records.find(
      (record) => record.deliveryId === input.deliveryId,
    );
    if (!current) {
      throw new Error(
        `Scheduled delivery ${JSON.stringify(input.deliveryId)} not found.`,
      );
    }
    const completed: ScheduledDeliveryRecord = {
      ...current,
      status: input.outcome,
      updatedAt: now,
    };
    delete completed.leaseExpiresAt;
    delete completed.nextAttemptAt;
    delete completed.lastError;
    if (input.outcome === 'retryable') {
      if (!isFiniteNumber(input.nextAttemptAt) || input.nextAttemptAt < now) {
        throw new Error('Invalid scheduled delivery retry time.');
      }
      completed.nextAttemptAt = input.nextAttemptAt;
      completed.lastError = sanitizeError(input.error);
    } else if (input.outcome === 'failed') {
      completed.lastError = sanitizeError(input.error);
    }
    return {
      records: records.map((record) =>
        record.deliveryId === completed.deliveryId ? completed : record,
      ),
      result: completed,
    };
  });
}

function sanitizeError(error: ScheduledDeliveryError): ScheduledDeliveryError {
  const code = error.code.trim().slice(0, MAX_ERROR_CODE_LENGTH);
  const message = redactPersistedCredentials(error.message)
    .trim()
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
  if (!code || !message) throw new Error('Invalid scheduled delivery error.');
  return { code, message };
}

function redactPersistedCredentials(message: string): string {
  return message
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/giu, '$1<redacted>')
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*([=:])\s*[^\s,;]+/giu,
      '$1$2<redacted>',
    );
}
