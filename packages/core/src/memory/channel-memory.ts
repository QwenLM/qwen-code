/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { Storage } from '../config/storage.js';
import {
  createChannelMemoryEntry,
  MAX_CHANNEL_MEMORY_ENTRIES_PER_REQUEST,
  normalizeChannelMemoryText,
  parseChannelMemoryDocument,
  parseLegacyChannelMemory,
  renderChannelMemoryRecall,
  serializeChannelMemoryDocument,
  type ChannelMemoryDocument,
  type ChannelMemoryEntry,
} from './channel-memory-document.js';

export interface ChannelMemoryTarget {
  channelName: string;
  chatId: string;
  threadId?: string;
}

export interface ChannelMemoryMutationResult {
  changed: boolean;
  filePath: string;
}

export interface AddChannelMemoryResult extends ChannelMemoryMutationResult {
  added: ChannelMemoryEntry[];
  duplicateIds: string[];
}

export interface UpdateChannelMemoryResult extends ChannelMemoryMutationResult {
  entry?: ChannelMemoryEntry;
}

export interface RemoveChannelMemoryResult extends ChannelMemoryMutationResult {
  removed: ChannelMemoryEntry[];
}

export type ChannelMemoryWriteResult = ChannelMemoryMutationResult;

export const CHANNEL_MEMORY_FILE_NAME = 'CHANNEL.json';
export const LEGACY_CHANNEL_MEMORY_FILE_NAME = 'CHANNEL.md';
export const MAX_CHANNEL_MEMORY_BYTES = 1024 * 1024;

const pendingMutations = new Map<string, Promise<void>>();
const LOCK_OPTIONS: lockfile.LockOptions = {
  realpath: false,
  retries: {
    retries: 12,
    minTimeout: 50,
    maxTimeout: 1000,
    factor: 2,
    randomize: true,
  },
  stale: 5000,
};

interface LoadedChannelMemory {
  document: ChannelMemoryDocument;
  legacyBytes?: Buffer;
  legacyHasEntries: boolean;
}

interface Mutation<T> {
  changed: boolean;
  result: T;
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function releaseLock(release: () => Promise<void>): Promise<void> {
  try {
    await release();
  } catch {
    // The write/delete already completed; stale-lock cleanup is non-fatal.
  }
}

async function cleanupLegacyAfterCommit(legacyPath: string): Promise<void> {
  try {
    await fs.unlink(legacyPath);
  } catch {
    // Canonical data is committed; a matching legacy file is safe to retry.
  }
}

function safeChannelName(channelName: string): string {
  const slug = channelName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 20) || '_';
  const hash = createHash('sha256')
    .update(channelName)
    .digest('hex')
    .slice(0, 16);
  return `${slug}-${hash}`;
}

function hashedThreadPath(target: ChannelMemoryTarget): string {
  return createHash('sha256')
    .update(target.chatId)
    .update('\0')
    .update(target.threadId ?? '')
    .digest('hex')
    .slice(0, 32);
}

function getChannelMemoryDirectory(target: ChannelMemoryTarget): string {
  return path.join(
    Storage.getGlobalQwenDir(),
    'channels',
    'memory',
    safeChannelName(target.channelName),
    hashedThreadPath(target),
  );
}

export function getChannelMemoryFilePath(target: ChannelMemoryTarget): string {
  return path.join(getChannelMemoryDirectory(target), CHANNEL_MEMORY_FILE_NAME);
}

export function getLegacyChannelMemoryFilePath(
  target: ChannelMemoryTarget,
): string {
  return path.join(
    getChannelMemoryDirectory(target),
    LEGACY_CHANNEL_MEMORY_FILE_NAME,
  );
}

async function serializeMutation<T>(
  directory: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = pendingMutations.get(directory) ?? Promise.resolve();
  let resolveCurrent: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  const queued = previous.then(
    () => current,
    () => current,
  );
  pendingMutations.set(directory, queued);

  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    resolveCurrent();
    if (pendingMutations.get(directory) === queued) {
      pendingMutations.delete(directory);
    }
  }
}

async function readFileIfExists(filePath: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

function legacyHash(legacyBytes: Buffer): string {
  return createHash('sha256').update(legacyBytes).digest('hex');
}

function verifyDualFileState(
  document: ChannelMemoryDocument,
  legacyBytes: Buffer | undefined,
): void {
  if (
    legacyBytes !== undefined &&
    document.migration?.legacySha256 !== legacyHash(legacyBytes)
  ) {
    throw new Error('Channel memory migration conflict');
  }
}

async function loadChannelMemory(
  target: ChannelMemoryTarget,
): Promise<LoadedChannelMemory> {
  const filePath = getChannelMemoryFilePath(target);
  const [initialJsonBytes, legacyBytes] = await Promise.all([
    readFileIfExists(filePath),
    readFileIfExists(getLegacyChannelMemoryFilePath(target)),
  ]);
  const jsonBytes =
    initialJsonBytes ??
    (legacyBytes === undefined ? await readFileIfExists(filePath) : undefined);

  if (jsonBytes !== undefined) {
    if (jsonBytes.length > MAX_CHANNEL_MEMORY_BYTES) {
      throw new Error('Channel memory exceeds maximum size');
    }
    const document = parseChannelMemoryDocument(jsonBytes.toString('utf8'));
    verifyDualFileState(document, legacyBytes);
    return {
      document,
      legacyBytes,
      legacyHasEntries:
        legacyBytes !== undefined &&
        parseLegacyChannelMemory(legacyBytes).entries.length > 0,
    };
  }

  if (legacyBytes !== undefined) {
    const document = parseLegacyChannelMemory(legacyBytes);
    return {
      document,
      legacyBytes,
      legacyHasEntries: document.entries.length > 0,
    };
  }

  return { document: { version: 1, entries: [] }, legacyHasEntries: false };
}

async function writeChannelMemory(
  filePath: string,
  serialized: string,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let committed = false;
  try {
    const handle = await fs.open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, filePath);
    committed = true;
  } finally {
    if (!committed) {
      await fs.unlink(tempPath).catch((error: unknown) => {
        if (!isMissingFile(error)) {
          throw error;
        }
      });
    }
  }
}

async function mutateChannelMemory<T>(
  target: ChannelMemoryTarget,
  apply: (
    document: ChannelMemoryDocument,
    sourceHasEntries: boolean,
  ) => Mutation<T>,
): Promise<T> {
  const filePath = getChannelMemoryFilePath(target);
  const directory = path.dirname(filePath);
  const legacyPath = getLegacyChannelMemoryFilePath(target);

  return serializeMutation(directory, async () => {
    await fs.mkdir(directory, { recursive: true });
    const lockPath = path.join(directory, '.channel-memory.lock');
    const lockHandle = await fs.open(lockPath, 'a', 0o600);
    await lockHandle.close();
    const release = await lockfile.lock(lockPath, LOCK_OPTIONS);
    try {
      const loaded = await loadChannelMemory(target);
      const mutation = apply(
        loaded.document,
        loaded.document.entries.length > 0 || loaded.legacyHasEntries,
      );
      if (!mutation.changed) {
        return mutation.result;
      }

      const serialized = serializeChannelMemoryDocument(loaded.document);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_CHANNEL_MEMORY_BYTES) {
        throw new Error('Channel memory exceeds maximum size');
      }
      await writeChannelMemory(filePath, serialized);
      if (loaded.legacyBytes !== undefined) {
        await cleanupLegacyAfterCommit(legacyPath);
      }
      return mutation.result;
    } finally {
      await releaseLock(release);
    }
  });
}

export async function listChannelMemoryEntries(
  target: ChannelMemoryTarget,
): Promise<ChannelMemoryEntry[]> {
  const { document } = await loadChannelMemory(target);
  return document.entries;
}

export async function addChannelMemoryEntries(
  target: ChannelMemoryTarget,
  texts: readonly string[],
  createdBy?: string,
): Promise<AddChannelMemoryResult> {
  if (texts.length > MAX_CHANNEL_MEMORY_ENTRIES_PER_REQUEST) {
    throw new Error('Channel memory accepts at most 10 entries per request');
  }

  const filePath = getChannelMemoryFilePath(target);
  return mutateChannelMemory<AddChannelMemoryResult>(target, (document) => {
    const entriesByNormalizedText = new Map(
      document.entries.map((entry) => [
        normalizeChannelMemoryText(entry.text),
        entry,
      ]),
    );
    const ids = new Set(document.entries.map((entry) => entry.id));
    const added: ChannelMemoryEntry[] = [];
    const duplicateIds: string[] = [];

    for (const text of texts) {
      const normalizedText = normalizeChannelMemoryText(text);
      if (!normalizedText) {
        continue;
      }
      const duplicate = entriesByNormalizedText.get(normalizedText);
      if (duplicate !== undefined) {
        duplicateIds.push(duplicate.id);
        continue;
      }

      let randomHex: string;
      do {
        randomHex = randomBytes(6).toString('hex');
      } while (ids.has(`m-${randomHex}`));
      const entry = createChannelMemoryEntry({
        text,
        createdBy,
        now: new Date().toISOString(),
        randomHex,
      });
      ids.add(entry.id);
      entriesByNormalizedText.set(normalizedText, entry);
      document.entries.push(entry);
      added.push(entry);
    }

    return {
      changed: added.length > 0,
      result: {
        changed: added.length > 0,
        filePath,
        added,
        duplicateIds,
      },
    };
  });
}

export async function updateChannelMemoryEntry(
  target: ChannelMemoryTarget,
  mutation: { id: string; text: string; expectedText?: string },
): Promise<UpdateChannelMemoryResult> {
  const filePath = getChannelMemoryFilePath(target);
  return mutateChannelMemory<UpdateChannelMemoryResult>(target, (document) => {
    const entry = document.entries.find(
      (candidate) => candidate.id === mutation.id,
    );
    if (entry === undefined) {
      if (mutation.expectedText !== undefined) {
        throw new Error('Channel memory entry changed');
      }
      return { changed: false, result: { changed: false, filePath } };
    }
    if (
      mutation.expectedText !== undefined &&
      entry.text !== mutation.expectedText
    ) {
      throw new Error('Channel memory entry changed');
    }

    const replacement = createChannelMemoryEntry({
      text: mutation.text,
      now: new Date().toISOString(),
      randomHex: '000000000000',
    });
    entry.text = replacement.text;
    entry.updatedAt = replacement.updatedAt;
    return {
      changed: true,
      result: { changed: true, filePath, entry: { ...entry } },
    };
  });
}

export async function removeChannelMemoryEntries(
  target: ChannelMemoryTarget,
  mutation: {
    ids: readonly string[];
    expectedTextById?: Readonly<Record<string, string>>;
  },
): Promise<RemoveChannelMemoryResult> {
  const filePath = getChannelMemoryFilePath(target);
  return mutateChannelMemory<RemoveChannelMemoryResult>(target, (document) => {
    const requestedIds = new Set(mutation.ids);
    const entriesById = new Map(
      document.entries.map((entry) => [entry.id, entry]),
    );
    for (const id of requestedIds) {
      const expectedText = mutation.expectedTextById?.[id];
      if (
        expectedText !== undefined &&
        entriesById.get(id)?.text !== expectedText
      ) {
        throw new Error('Channel memory entry changed');
      }
    }
    const removed = document.entries.filter((entry) =>
      requestedIds.has(entry.id),
    );
    if (removed.length === 0) {
      return { changed: false, result: { changed: false, filePath, removed } };
    }
    document.entries = document.entries.filter(
      (entry) => !requestedIds.has(entry.id),
    );
    return { changed: true, result: { changed: true, filePath, removed } };
  });
}

export async function readChannelMemory(
  target: ChannelMemoryTarget,
): Promise<string> {
  return renderChannelMemoryRecall(await listChannelMemoryEntries(target));
}

export async function appendChannelMemory(
  target: ChannelMemoryTarget,
  text: string,
): Promise<ChannelMemoryMutationResult> {
  const { changed, filePath } = await addChannelMemoryEntries(target, [text]);
  return { changed, filePath };
}

export async function clearChannelMemory(
  target: ChannelMemoryTarget,
): Promise<ChannelMemoryMutationResult> {
  const filePath = getChannelMemoryFilePath(target);
  return mutateChannelMemory<ChannelMemoryMutationResult>(
    target,
    (document, sourceHasEntries) => {
      if (!sourceHasEntries) {
        return { changed: false, result: { changed: false, filePath } };
      }
      document.entries = [];
      return { changed: true, result: { changed: true, filePath } };
    },
  );
}
