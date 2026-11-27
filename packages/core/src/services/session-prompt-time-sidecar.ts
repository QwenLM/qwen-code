/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/atomicFileWrite.js';

const isoTimestampSchema = z.string().datetime({ offset: true });
const sha256HexSchema = /^[0-9a-f]{64}$/;

const PROMPT_UUID_BLOOM_MIN_BYTES = 256;
export const PROMPT_UUID_BLOOM_MAX_BYTES = 131_072; // 128 KiB (~100k records at <1% FP)
const PROMPT_UUID_BLOOM_DEFAULT_HASHES = 7;
const PROMPT_UUID_BLOOM_MAX_HASHES = 16;
export const PROMPT_UUID_BLOOM_MAX_ITEMS = 120_000;

export interface SessionPromptTimeUuidBloom {
  /** Canonical base64 bitset whose byte length is a power of 2 in [256, 131072]. */
  bits: string;
  hashes: number;
  count: number;
}

export interface PromptUuidBloomState {
  buffer: Buffer;
  hashes: number;
  count: number;
}

export interface SessionPromptTimeSidecar {
  version: 1;
  fileIdentity: { dev: number; ino: number };
  snapshotSize: number;
  lastUpdated: string;
  lastUserPromptAt: string | null;
  leafUuid: string;
  firstRecordOwner: { sessionId: string; cwd: string };
  prefixSha256?: string;
  prefixUuidBloom?: SessionPromptTimeUuidBloom;
  managed?: boolean;
}

function hashUuid32(uuid: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < uuid.length; i += 1) {
    h ^= uuid.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function isValidBloomByteLength(length: number): boolean {
  return (
    length >= PROMPT_UUID_BLOOM_MIN_BYTES &&
    length <= PROMPT_UUID_BLOOM_MAX_BYTES &&
    (length & (length - 1)) === 0
  );
}

function selectBloomByteLength(expectedItems: number): number | undefined {
  if (
    !Number.isSafeInteger(expectedItems) ||
    expectedItems < 0 ||
    expectedItems > PROMPT_UUID_BLOOM_MAX_ITEMS
  ) {
    return undefined;
  }
  // Target ~10 bits/item (1.25 bytes/item) so k=7 stays under ~0.8% FP while
  // keeping typical sessions to 256 B – 8 KiB.
  const targetBytes = Math.ceil(expectedItems * 1.25);
  let bytes = PROMPT_UUID_BLOOM_MIN_BYTES;
  while (bytes < targetBytes && bytes < PROMPT_UUID_BLOOM_MAX_BYTES) {
    bytes <<= 1;
  }
  return bytes;
}

export function createPromptUuidBloom(
  expectedItems: number,
): PromptUuidBloomState | undefined {
  const byteLength = selectBloomByteLength(expectedItems);
  if (byteLength === undefined) return undefined;
  return {
    buffer: Buffer.alloc(byteLength),
    hashes: PROMPT_UUID_BLOOM_DEFAULT_HASHES,
    count: 0,
  };
}

export function addPromptUuidToBloom(
  state: PromptUuidBloomState,
  uuid: string,
): void {
  const bitLength = state.buffer.length << 3;
  const mask = bitLength - 1;
  const h1 = hashUuid32(uuid, 0x811c9dc5);
  const h2 = hashUuid32(uuid, 0x9e3779b1) | 1;
  for (let i = 0; i < state.hashes; i += 1) {
    const bit = (h1 + Math.imul(i, h2)) & mask;
    state.buffer[bit >>> 3]! |= 1 << (bit & 7);
  }
  state.count += 1;
}

export function promptUuidBloomMayContain(
  state: Pick<PromptUuidBloomState, 'buffer' | 'hashes'>,
  uuid: string,
): boolean {
  const bitLength = state.buffer.length << 3;
  const mask = bitLength - 1;
  const h1 = hashUuid32(uuid, 0x811c9dc5);
  const h2 = hashUuid32(uuid, 0x9e3779b1) | 1;
  for (let i = 0; i < state.hashes; i += 1) {
    const bit = (h1 + Math.imul(i, h2)) & mask;
    if ((state.buffer[bit >>> 3]! & (1 << (bit & 7))) === 0) {
      return false;
    }
  }
  return true;
}

export function encodePromptUuidBloom(
  state: PromptUuidBloomState,
): SessionPromptTimeUuidBloom | undefined {
  // Drop the Bloom once saturated past ~8 bits/item so the next append does
  // one lightweight scan and resizes to a larger power-of-two bitset.
  if (
    !isValidBloomByteLength(state.buffer.length) ||
    state.count > state.buffer.length
  ) {
    return undefined;
  }
  return {
    bits: state.buffer.toString('base64'),
    hashes: state.hashes,
    count: state.count,
  };
}

export function buildPromptUuidBloom(
  uuids: Iterable<string>,
  expectedItems: number,
): SessionPromptTimeUuidBloom | undefined {
  const state = createPromptUuidBloom(expectedItems);
  if (!state) return undefined;
  for (const uuid of uuids) {
    addPromptUuidToBloom(state, uuid);
  }
  return encodePromptUuidBloom(state);
}

function parsePromptUuidBloom(
  raw: unknown,
): SessionPromptTimeUuidBloom | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const bits = obj['bits'];
  const hashes = obj['hashes'];
  const count = obj['count'];
  if (
    typeof bits !== 'string' ||
    bits.length === 0 ||
    typeof hashes !== 'number' ||
    !Number.isSafeInteger(hashes) ||
    hashes < 1 ||
    hashes > PROMPT_UUID_BLOOM_MAX_HASHES ||
    !isNonNegativeSafeInteger(count)
  ) {
    return undefined;
  }
  const decoded = Buffer.from(bits, 'base64');
  if (!isValidBloomByteLength(decoded.length)) return undefined;
  if (decoded.toString('base64') !== bits) return undefined;
  return { bits, hashes, count };
}

export function decodePromptUuidBloom(
  bloom: SessionPromptTimeUuidBloom,
): PromptUuidBloomState | undefined {
  const valid = parsePromptUuidBloom(bloom);
  if (!valid) return undefined;
  return {
    buffer: Buffer.from(valid.bits, 'base64'),
    hashes: valid.hashes,
    count: valid.count,
  };
}

export const SESSION_PROMPT_TIME_SIDECAR_SUFFIX = '.prompt-time.json';

export function sessionPromptTimeSidecarPath(
  chatsDir: string,
  sessionId: string,
): string {
  return path.join(
    chatsDir,
    `${sessionId}${SESSION_PROMPT_TIME_SIDECAR_SUFFIX}`,
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// Windows Stats.ino can exceed Number.MAX_SAFE_INTEGER; match the reader's
// file-identity check rather than rejecting valid Windows inodes.
function isNonNegativeFileId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseSessionPromptTimeSidecar(
  raw: string,
): SessionPromptTimeSidecar | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== 1) return undefined;

  const rawIdentity = record['fileIdentity'];
  if (
    typeof rawIdentity !== 'object' ||
    rawIdentity === null ||
    Array.isArray(rawIdentity)
  ) {
    return undefined;
  }
  const identity = rawIdentity as Record<string, unknown>;
  if (
    !isNonNegativeFileId(identity['dev']) ||
    !isNonNegativeFileId(identity['ino'])
  ) {
    return undefined;
  }

  const snapshotSize = record['snapshotSize'];
  if (!isNonNegativeSafeInteger(snapshotSize) || snapshotSize === 0) {
    return undefined;
  }

  const lastUpdated = record['lastUpdated'];
  if (
    !isNonEmptyString(lastUpdated) ||
    !isoTimestampSchema.safeParse(lastUpdated).success
  ) {
    return undefined;
  }

  const lastUserPromptAt = record['lastUserPromptAt'];
  if (
    lastUserPromptAt !== null &&
    (!isNonEmptyString(lastUserPromptAt) ||
      !isoTimestampSchema.safeParse(lastUserPromptAt).success)
  ) {
    return undefined;
  }

  const leafUuid = record['leafUuid'];
  if (!isNonEmptyString(leafUuid)) return undefined;

  const rawOwner = record['firstRecordOwner'];
  if (
    typeof rawOwner !== 'object' ||
    rawOwner === null ||
    Array.isArray(rawOwner)
  ) {
    return undefined;
  }
  const owner = rawOwner as Record<string, unknown>;
  if (
    !isNonEmptyString(owner['sessionId']) ||
    !isNonEmptyString(owner['cwd'])
  ) {
    return undefined;
  }

  const prefixSha256 = record['prefixSha256'];
  if (
    prefixSha256 !== undefined &&
    (typeof prefixSha256 !== 'string' || !sha256HexSchema.test(prefixSha256))
  ) {
    return undefined;
  }

  let prefixUuidBloom: SessionPromptTimeUuidBloom | undefined;
  if (record['prefixUuidBloom'] !== undefined) {
    prefixUuidBloom = parsePromptUuidBloom(record['prefixUuidBloom']);
    if (!prefixUuidBloom) return undefined;
  }

  const managed = record['managed'];
  if (managed !== undefined && typeof managed !== 'boolean') {
    return undefined;
  }

  return {
    version: 1,
    fileIdentity: { dev: identity['dev'], ino: identity['ino'] },
    snapshotSize,
    lastUpdated,
    lastUserPromptAt,
    leafUuid,
    firstRecordOwner: {
      sessionId: owner['sessionId'],
      cwd: owner['cwd'],
    },
    ...(prefixSha256 !== undefined ? { prefixSha256 } : {}),
    ...(prefixUuidBloom !== undefined ? { prefixUuidBloom } : {}),
    ...(managed !== undefined ? { managed } : {}),
  };
}

export async function readSessionPromptTimeSidecarAsync(
  filePath: string,
  options: { signal?: AbortSignal } = {},
): Promise<SessionPromptTimeSidecar | undefined> {
  options.signal?.throwIfAborted();
  let raw: string;
  try {
    raw = options.signal
      ? await fsPromises.readFile(filePath, {
          encoding: 'utf8',
          signal: options.signal,
        })
      : await fsPromises.readFile(filePath, 'utf8');
  } catch {
    options.signal?.throwIfAborted();
    return undefined;
  }
  return parseSessionPromptTimeSidecar(raw);
}

export function writeSessionPromptTimeSidecar(
  filePath: string,
  data: Omit<SessionPromptTimeSidecar, 'version'>,
): boolean {
  if (
    !isNonNegativeFileId(data.fileIdentity.dev) ||
    !isNonNegativeFileId(data.fileIdentity.ino) ||
    !isNonNegativeSafeInteger(data.snapshotSize) ||
    data.snapshotSize === 0 ||
    !isNonEmptyString(data.lastUpdated) ||
    !isoTimestampSchema.safeParse(data.lastUpdated).success ||
    (data.lastUserPromptAt !== null &&
      (!isNonEmptyString(data.lastUserPromptAt) ||
        !isoTimestampSchema.safeParse(data.lastUserPromptAt).success)) ||
    !isNonEmptyString(data.leafUuid) ||
    !isNonEmptyString(data.firstRecordOwner.sessionId) ||
    !isNonEmptyString(data.firstRecordOwner.cwd) ||
    (data.prefixSha256 !== undefined &&
      !sha256HexSchema.test(data.prefixSha256)) ||
    (data.prefixUuidBloom !== undefined &&
      !parsePromptUuidBloom(data.prefixUuidBloom))
  ) {
    return false;
  }
  const payload: SessionPromptTimeSidecar = {
    version: 1,
    fileIdentity: {
      dev: data.fileIdentity.dev,
      ino: data.fileIdentity.ino,
    },
    snapshotSize: data.snapshotSize,
    lastUpdated: data.lastUpdated,
    lastUserPromptAt: data.lastUserPromptAt,
    leafUuid: data.leafUuid,
    firstRecordOwner: {
      sessionId: data.firstRecordOwner.sessionId,
      cwd: data.firstRecordOwner.cwd,
    },
    ...(data.prefixSha256 !== undefined
      ? { prefixSha256: data.prefixSha256 }
      : {}),
    ...(data.prefixUuidBloom !== undefined
      ? { prefixUuidBloom: data.prefixUuidBloom }
      : {}),
    ...(data.managed !== undefined ? { managed: data.managed } : {}),
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

export function removeSessionPromptTimeSidecar(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup; the transcript is authoritative.
  }
}

export function moveSessionPromptTimeSidecar(from: string, to: string): void {
  if (!fs.existsSync(from)) return;
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}
