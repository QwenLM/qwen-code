/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionWriterLease } from '../services/session-writer-lease.js';
import { openNoFollow } from '../utils/no-follow-open.js';
import {
  isSinglePathSegment,
  managedSessionResourceRoot,
} from '../utils/sessionStorageUtils.js';
import {
  assertManagedSessionDigest,
  assertManagedSessionDurableRef,
  assertManagedSessionSequence,
  assertManagedSessionStableId,
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
  type ManagedSessionKey,
} from './managed-session-records.js';
import {
  isToolResultPageAt,
  MANAGED_TOOL_RESULT_KINDS,
  MANAGED_TOOL_RESULT_LIMITS,
  parseToolResultManifestBytes,
  parseToolResultPageBytes,
  parseToolResultPrefixRequest,
  parseToolResultPublishRequest,
  parseToolResultSealRequest,
  type ToolResultPrefix,
  type ToolResultSealReceipt,
  type ToolResultSegmentReceipt,
  type ToolResultStoreCode,
  type ToolResultStoreOutcome,
} from './managed-tool-result.js';
import type {
  ToolResultRangeRequest,
  ToolResultSegmentStore,
} from './managed-tool-result-store.js';

const NAMESPACE = 'managed-tool-result-segments-v1';
const CHUNK_BYTES = 64 * 1024;
const EMPTY_DIGEST = createHash('sha256').digest('hex');
const writableRoots = new Set<string>();
const identityKeys = [
  'tenantId',
  'sessionId',
  'turnId',
  'executionCallId',
  'callId',
  'invocationDigest',
  'bindingGeneration',
  'captureId',
  'revision',
] as const;

class CorruptToolResultError extends Error {}

function refused(code: ToolResultStoreCode): ToolResultStoreOutcome<never> {
  return { status: 'refused', code };
}

function ok<T>(result: T): ToolResultStoreOutcome<T> {
  return { status: 'ok', result };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function maybeStat(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function assertDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ManagedSessionRecordError(
      'tool-result directory is not private.',
    );
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !['EACCES', 'EINVAL', 'EPERM'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    ) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function ensureDirectory(parent: string, name: string): Promise<string> {
  const directory = path.join(parent, name);
  if (!(await maybeStat(directory))) {
    await mkdir(directory, { mode: 0o700 });
  }
  await assertDirectory(directory);
  await syncDirectory(parent);
  return directory;
}

async function writeAndSync(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function installFile(
  directory: string,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const pending = path.join(directory, `.pending-${randomUUID()}`);
  const target = path.join(directory, name);
  await writeAndSync(pending, bytes);
  try {
    await link(pending, target);
    await syncDirectory(directory);
  } finally {
    await unlink(pending).catch(() => undefined);
  }
}

async function installDirectory(
  parent: string,
  name: string,
  files: ReadonlyArray<{ name: string; bytes: Uint8Array }>,
): Promise<void> {
  const pending = path.join(parent, `.pending-${randomUUID()}`);
  await mkdir(pending, { mode: 0o700 });
  try {
    for (const file of files) {
      await writeAndSync(path.join(pending, file.name), file.bytes);
    }
    await syncDirectory(pending);
    if (await maybeStat(path.join(parent, name))) {
      throw new ManagedSessionRecordError(
        'tool-result identity already exists.',
      );
    }
    await rename(pending, path.join(parent, name));
    await syncDirectory(parent);
  } finally {
    await rm(pending, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readSmallFile(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await openNoFollow(file);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new CorruptToolResultError('invalid tool-result record size.');
    }
    const bytes = Buffer.alloc(stat.size);
    for (let offset = 0; offset < bytes.byteLength; ) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) {
        throw new CorruptToolResultError('truncated tool-result record.');
      }
      offset += bytesRead;
    }
    if ((await handle.stat()).size !== stat.size) {
      throw new CorruptToolResultError('changed tool-result record.');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseReceipt<T extends object>(
  bytes: Buffer,
  keys: readonly string[],
): T {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      keys.some((key) => !(key in value))
    ) {
      throw new Error('invalid keys');
    }
    return value as T;
  } catch {
    throw new CorruptToolResultError('invalid tool-result receipt.');
  }
}

async function hashFile(
  file: string,
  byteLength: number,
  digest: string,
  onChunk?: (chunk: Buffer, position: number) => void,
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await openNoFollow(file);
  } catch (error) {
    if (isMissing(error)) {
      throw new CorruptToolResultError('missing tool-result bytes.');
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== byteLength) {
      throw new CorruptToolResultError('tool-result byte length changed.');
    }
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    for (let position = 0; position < byteLength; ) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.byteLength, byteLength - position),
        position,
      );
      if (bytesRead === 0) {
        throw new CorruptToolResultError('truncated tool-result bytes.');
      }
      const slice = chunk.subarray(0, bytesRead);
      hash.update(slice);
      onChunk?.(slice, position);
      position += bytesRead;
    }
    if (
      hash.digest('hex') !== digest ||
      (await handle.stat()).size !== byteLength
    ) {
      throw new CorruptToolResultError('tool-result digest changed.');
    }
  } finally {
    await handle.close();
  }
}

function assertResourceRef(
  value: unknown,
  kind: string,
  maxBytes?: number,
): ManagedSessionDurableRef {
  const ref = assertManagedSessionDurableRef(
    value as ManagedSessionJsonValue,
    'tool-result resource',
  );
  if (
    ref.kind !== kind ||
    ref.schemaVersion !== 1 ||
    (maxBytes !== undefined &&
      (ref.byteLength < 1 || ref.byteLength > maxBytes)) ||
    !isSinglePathSegment(ref.resourceId)
  ) {
    throw new ManagedSessionRecordError(
      'invalid tool-result resource reference.',
    );
  }
  return ref;
}

function assertSessionKey(key: ManagedSessionKey): void {
  for (const field of ['tenantId', 'workspaceId', 'sessionId'] as const) {
    assertManagedSessionStableId(key[field], `sessionKey.${field}`);
  }
  if (!isSinglePathSegment(key.sessionId)) {
    throw new ManagedSessionRecordError('sessionId must be one path segment.');
  }
}

export class LocalToolResultSegmentStore implements ToolResultSegmentStore {
  private closed = false;
  private closePromise?: Promise<void>;
  private tail: Promise<void> = Promise.resolve();

  private constructor(
    readonly root: string,
    private readonly sessionRoot: string,
    private readonly sessionKey: ManagedSessionKey,
    private readonly lease?: SessionWriterLease,
  ) {}

  static async openWritable(options: {
    sessionKey: ManagedSessionKey;
    lease: SessionWriterLease;
  }): Promise<LocalToolResultSegmentStore> {
    assertSessionKey(options.sessionKey);
    if (options.lease.sessionId !== options.sessionKey.sessionId) {
      throw new ManagedSessionRecordError(
        'tool-result lease belongs to another Session.',
      );
    }
    await options.lease.assertOwnedAndUnchanged();
    const base = await realpath(options.lease.runtimeBaseDir);
    const sessionRoot = managedSessionResourceRoot(
      base,
      options.sessionKey.sessionId,
    );
    const root = path.join(sessionRoot, NAMESPACE);
    if (writableRoots.has(root)) {
      throw new ManagedSessionRecordError('tool-result writer already open.');
    }
    writableRoots.add(root);
    try {
      const store = new LocalToolResultSegmentStore(
        root,
        sessionRoot,
        options.sessionKey,
        options.lease,
      );
      await store.openNamespace(true);
      return store;
    } catch (error) {
      writableRoots.delete(root);
      throw error;
    }
  }

  static async openReadOnly(options: {
    runtimeBaseDir: string;
    sessionKey: ManagedSessionKey;
  }): Promise<LocalToolResultSegmentStore> {
    assertSessionKey(options.sessionKey);
    const base = await realpath(options.runtimeBaseDir);
    const sessionRoot = managedSessionResourceRoot(
      base,
      options.sessionKey.sessionId,
    );
    const store = new LocalToolResultSegmentStore(
      path.join(sessionRoot, NAMESPACE),
      sessionRoot,
      options.sessionKey,
    );
    await store.openNamespace(false);
    return store;
  }

  private async openNamespace(write: boolean): Promise<void> {
    const runtimeBase = path.dirname(path.dirname(this.sessionRoot));
    await assertDirectory(runtimeBase);
    let parent = runtimeBase;
    for (const name of ['resources', this.sessionKey.sessionId, NAMESPACE]) {
      parent = write
        ? await ensureDirectory(parent, name)
        : path.join(parent, name);
      await assertDirectory(parent);
    }
    const owner = path.join(this.root, 'owner.json');
    if (!(await maybeStat(owner)) && write) {
      const entries = await readdir(this.root);
      if (entries.some((name) => !name.startsWith('.pending-'))) {
        throw new ManagedSessionRecordError(
          'tool-result owner record is missing.',
        );
      }
      await installFile(
        this.root,
        'owner.json',
        Buffer.from(JSON.stringify({ version: 1, ...this.sessionKey }), 'utf8'),
      );
    }
    const recorded = parseReceipt<ManagedSessionKey & { version: number }>(
      await readSmallFile(owner, 2048),
      ['version', 'tenantId', 'workspaceId', 'sessionId'],
    );
    if (
      recorded.version !== 1 ||
      recorded.tenantId !== this.sessionKey.tenantId ||
      recorded.workspaceId !== this.sessionKey.workspaceId ||
      recorded.sessionId !== this.sessionKey.sessionId
    ) {
      throw new ManagedSessionRecordError(
        'tool-result owner does not match Session.',
      );
    }
    if (write) await syncDirectory(this.root);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new ManagedSessionRecordError('tool-result store is closed.'),
      );
    }
    const promise = this.tail.then(async () => {
      if (this.lease) await this.lease.assertOwnedAndUnchanged();
      return operation();
    });
    this.tail = promise.then(
      () => undefined,
      () => undefined,
    );
    return promise;
  }

  private streamPath(captureId: string, streamId: string): string {
    return path.join(this.root, `capture-${captureId}`, `stream-${streamId}`);
  }

  private streamAnchorToken(captureId: string, streamId: string): string {
    const digest = createHash('sha256')
      .update(captureId)
      .update('\0')
      .update(streamId)
      .digest('hex');
    return digest;
  }

  private streamAnchorPath(captureId: string, streamId: string): string {
    return path.join(
      this.root,
      `published-stream-${this.streamAnchorToken(captureId, streamId)}`,
    );
  }

  private sealAnchorPath(captureId: string, streamId: string): string {
    return path.join(
      this.root,
      `sealed-stream-${this.streamAnchorToken(captureId, streamId)}`,
    );
  }

  private async hasStreamAnchor(
    captureId: string,
    streamId: string,
  ): Promise<boolean> {
    const file = this.streamAnchorPath(captureId, streamId);
    if (!(await maybeStat(file))) return false;
    const recorded = parseReceipt<{ captureId: string; streamId: string }>(
      await readSmallFile(file, 512),
      ['captureId', 'streamId'],
    );
    if (recorded.captureId !== captureId || recorded.streamId !== streamId) {
      throw new CorruptToolResultError('tool-result stream anchor changed.');
    }
    return true;
  }

  private async ensureStreamAnchor(
    captureId: string,
    streamId: string,
  ): Promise<void> {
    const file = this.streamAnchorPath(captureId, streamId);
    if (await this.hasStreamAnchor(captureId, streamId)) {
      await syncDirectory(this.root);
    } else {
      await installFile(
        this.root,
        path.basename(file),
        Buffer.from(JSON.stringify({ captureId, streamId })),
      );
    }
  }

  private async sealAnchor(
    captureId: string,
    streamId: string,
  ): Promise<ToolResultSealReceipt | undefined> {
    const file = this.sealAnchorPath(captureId, streamId);
    if (!(await maybeStat(file))) return undefined;
    const recorded = parseReceipt<
      ToolResultSealReceipt & { captureId: string; streamId: string }
    >(await readSmallFile(file, 512), [
      'captureId',
      'streamId',
      'segmentCount',
      'byteLength',
      'digest',
    ]);
    try {
      if (recorded.captureId !== captureId || recorded.streamId !== streamId) {
        throw new Error('identity mismatch');
      }
      assertManagedSessionSequence(recorded.segmentCount, 'seal.segmentCount');
      assertManagedSessionSequence(recorded.byteLength, 'seal.byteLength');
      assertManagedSessionDigest(recorded.digest, 'seal.digest');
    } catch {
      throw new CorruptToolResultError('corrupt tool-result seal anchor.');
    }
    return {
      segmentCount: recorded.segmentCount,
      byteLength: recorded.byteLength,
      digest: recorded.digest,
    };
  }

  private async ensureSealAnchor(
    captureId: string,
    streamId: string,
    receipt: ToolResultSealReceipt,
  ): Promise<void> {
    const file = this.sealAnchorPath(captureId, streamId);
    const existing = await this.sealAnchor(captureId, streamId);
    if (existing) {
      if (
        existing.segmentCount !== receipt.segmentCount ||
        existing.byteLength !== receipt.byteLength ||
        existing.digest !== receipt.digest
      ) {
        throw new CorruptToolResultError('tool-result seal anchor changed.');
      }
      await syncDirectory(this.root);
    } else {
      await installFile(
        this.root,
        path.basename(file),
        Buffer.from(JSON.stringify({ captureId, streamId, ...receipt })),
      );
    }
  }

  private async ensureStream(
    captureId: string,
    streamId: string,
  ): Promise<string> {
    await this.existingStream(captureId, streamId);
    const capture = await ensureDirectory(this.root, `capture-${captureId}`);
    return ensureDirectory(capture, `stream-${streamId}`);
  }

  private async existingStream(
    captureId: string,
    streamId: string,
  ): Promise<string | undefined> {
    const capture = path.join(this.root, `capture-${captureId}`);
    if (!(await maybeStat(capture))) {
      if (
        (await this.hasStreamAnchor(captureId, streamId)) ||
        (await this.sealAnchor(captureId, streamId))
      ) {
        throw new CorruptToolResultError(
          'published tool-result stream is missing.',
        );
      }
      return undefined;
    }
    await assertDirectory(capture);
    const stream = this.streamPath(captureId, streamId);
    if (!(await maybeStat(stream))) {
      if (
        (await this.hasStreamAnchor(captureId, streamId)) ||
        (await this.sealAnchor(captureId, streamId))
      ) {
        throw new CorruptToolResultError(
          'published tool-result stream is missing.',
        );
      }
      return undefined;
    }
    await assertDirectory(stream);
    return stream;
  }

  private async quarantineCandidate(
    captureId: string,
    streamId: string,
    bytes: Uint8Array,
    reason: string,
  ): Promise<void> {
    let directory: string;
    try {
      directory = await this.ensureStream(captureId, streamId);
    } catch (error) {
      if (!(error instanceof CorruptToolResultError)) throw error;
      directory = this.root;
    }
    await installDirectory(directory, `quarantine-${randomUUID()}`, [
      { name: 'bytes', bytes },
      {
        name: 'reason.json',
        bytes: Buffer.from(JSON.stringify({ captureId, streamId, reason })),
      },
    ]);
  }

  private async markCorrupt(stream: string, ordinal: number): Promise<void> {
    const marker = `corrupt-${ordinal.toString().padStart(5, '0')}`;
    if (!(await maybeStat(path.join(stream, marker)))) {
      await installFile(stream, marker, Buffer.from('corrupt\n'));
    } else {
      await syncDirectory(stream);
    }
  }

  private async publishedMarker(
    stream: string,
    ordinal: number,
    receipt?: ToolResultSegmentReceipt,
  ): Promise<boolean> {
    const file = path.join(
      stream,
      `published-${ordinal.toString().padStart(5, '0')}`,
    );
    if (!(await maybeStat(file))) {
      if (!receipt || !this.lease) return false;
      await installFile(
        stream,
        path.basename(file),
        Buffer.from(JSON.stringify(receipt)),
      );
      return true;
    }
    const recorded = parseReceipt<ToolResultSegmentReceipt>(
      await readSmallFile(file, 512),
      ['ordinal', 'byteLength', 'digest'],
    );
    if (
      recorded.ordinal !== ordinal ||
      !Number.isSafeInteger(recorded.byteLength) ||
      recorded.byteLength < 1 ||
      recorded.byteLength > MANAGED_TOOL_RESULT_LIMITS.maxSegmentBytes
    ) {
      throw new CorruptToolResultError(
        'invalid tool-result publication marker.',
      );
    }
    try {
      assertManagedSessionDigest(recorded.digest, 'published.digest');
    } catch {
      throw new CorruptToolResultError(
        'invalid tool-result publication marker.',
      );
    }
    if (
      receipt &&
      (recorded.byteLength !== receipt.byteLength ||
        recorded.digest !== receipt.digest)
    ) {
      throw new CorruptToolResultError(
        'tool-result publication marker changed.',
      );
    }
    return true;
  }

  private async readSegment(
    stream: string,
    ordinal: number,
    onChunk?: (chunk: Buffer) => void,
    mark = false,
  ): Promise<ToolResultSegmentReceipt | undefined> {
    const id = ordinal.toString().padStart(5, '0');
    if (await maybeStat(path.join(stream, `corrupt-${id}`))) {
      throw new CorruptToolResultError('quarantined tool-result segment.');
    }
    const directory = path.join(stream, `segment-${id}`);
    if (!(await maybeStat(directory))) {
      if (!(await this.publishedMarker(stream, ordinal))) return undefined;
      if (!(await maybeStat(directory))) {
        if (mark && this.lease) await this.markCorrupt(stream, ordinal);
        throw new CorruptToolResultError(
          'missing published tool-result segment.',
        );
      }
    }
    try {
      await assertDirectory(directory);
      const receipt = parseReceipt<ToolResultSegmentReceipt>(
        await readSmallFile(path.join(directory, 'receipt.json'), 512),
        ['ordinal', 'byteLength', 'digest'],
      );
      if (
        receipt.ordinal !== ordinal ||
        !Number.isSafeInteger(receipt.byteLength) ||
        receipt.byteLength < 1 ||
        receipt.byteLength > MANAGED_TOOL_RESULT_LIMITS.maxSegmentBytes
      ) {
        throw new CorruptToolResultError(
          'invalid tool-result segment receipt.',
        );
      }
      assertManagedSessionDigest(receipt.digest, 'segment.digest');
      await hashFile(
        path.join(directory, 'bytes'),
        receipt.byteLength,
        receipt.digest,
        (chunk) => onChunk?.(chunk),
      );
      if (mark || (await maybeStat(path.join(stream, `published-${id}`)))) {
        await this.publishedMarker(stream, ordinal, receipt);
      }
      return receipt;
    } catch (error) {
      if (
        error instanceof CorruptToolResultError ||
        error instanceof ManagedSessionRecordError ||
        isMissing(error)
      ) {
        if (mark && this.lease) await this.markCorrupt(stream, ordinal);
        throw new CorruptToolResultError('corrupt tool-result segment.');
      }
      throw error;
    }
  }

  private async readSeal(
    stream: string,
    captureId: string,
    streamId: string,
  ): Promise<ToolResultSealReceipt | undefined> {
    const directory = path.join(stream, 'seal');
    const anchor = await this.sealAnchor(captureId, streamId);
    if (!(await maybeStat(directory))) {
      if (anchor)
        throw new CorruptToolResultError('missing sealed tool-result stream.');
      return undefined;
    }
    await assertDirectory(directory);
    let receipt: ToolResultSealReceipt;
    try {
      receipt = parseReceipt<ToolResultSealReceipt>(
        await readSmallFile(path.join(directory, 'receipt.json'), 512),
        ['segmentCount', 'byteLength', 'digest'],
      );
    } catch (error) {
      if (isMissing(error)) {
        throw new CorruptToolResultError('missing tool-result seal receipt.');
      }
      throw error;
    }
    try {
      assertManagedSessionSequence(receipt.segmentCount, 'seal.segmentCount');
      assertManagedSessionSequence(receipt.byteLength, 'seal.byteLength');
      assertManagedSessionDigest(receipt.digest, 'seal.digest');
    } catch {
      throw new CorruptToolResultError('corrupt tool-result seal.');
    }
    if (
      anchor &&
      (anchor.segmentCount !== receipt.segmentCount ||
        anchor.byteLength !== receipt.byteLength ||
        anchor.digest !== receipt.digest)
    ) {
      throw new CorruptToolResultError('tool-result seal anchor changed.');
    }
    return receipt;
  }

  publish(
    request: unknown,
  ): Promise<ToolResultStoreOutcome<ToolResultSegmentReceipt>> {
    if (this.closed || !this.lease) {
      return Promise.reject(
        new ManagedSessionRecordError('tool-result store is not writable.'),
      );
    }
    let fields;
    try {
      fields = parseToolResultPublishRequest(request);
    } catch (error) {
      if (error instanceof ManagedSessionRecordError) {
        return Promise.resolve(refused('managed_tool_result_invalid'));
      }
      return Promise.reject(error);
    }
    const bytes = Uint8Array.from(fields.bytes);
    const received = createHash('sha256').update(bytes).digest('hex');
    return this.enqueue(async () => {
      if (
        fields.expectedDigest !== null &&
        fields.expectedDigest !== received
      ) {
        await this.quarantineCandidate(
          fields.captureId,
          fields.streamId,
          bytes,
          'digest_mismatch',
        );
        return refused('managed_tool_result_digest_mismatch');
      }
      try {
        const stream = await this.ensureStream(
          fields.captureId,
          fields.streamId,
        );
        const stored = await this.readSegment(
          stream,
          fields.ordinal,
          undefined,
          true,
        );
        if (stored) {
          if (
            stored.byteLength !== bytes.byteLength ||
            stored.digest !== received
          ) {
            await this.quarantineCandidate(
              fields.captureId,
              fields.streamId,
              bytes,
              'identity_conflict',
            );
            return refused('managed_tool_result_conflict');
          }
          await syncDirectory(stream);
          await this.ensureStreamAnchor(fields.captureId, fields.streamId);
          return ok(stored);
        }
        const seal = await this.readSeal(
          stream,
          fields.captureId,
          fields.streamId,
        );
        if (seal) {
          await this.quarantineCandidate(
            fields.captureId,
            fields.streamId,
            bytes,
            'sealed_identity_conflict',
          );
          if (fields.ordinal < seal.segmentCount) {
            await this.markCorrupt(stream, fields.ordinal);
          }
          return refused(
            fields.ordinal >= seal.segmentCount
              ? 'managed_tool_result_conflict'
              : 'managed_tool_result_digest_mismatch',
          );
        }
        const receipt = {
          ordinal: fields.ordinal,
          byteLength: bytes.byteLength,
          digest: received,
        };
        await installDirectory(
          stream,
          `segment-${fields.ordinal.toString().padStart(5, '0')}`,
          [
            { name: 'bytes', bytes },
            {
              name: 'receipt.json',
              bytes: Buffer.from(JSON.stringify(receipt)),
            },
          ],
        );
        await this.publishedMarker(stream, fields.ordinal, receipt);
        await this.ensureStreamAnchor(fields.captureId, fields.streamId);
        return ok(receipt);
      } catch (error) {
        if (error instanceof CorruptToolResultError) {
          await this.quarantineCandidate(
            fields.captureId,
            fields.streamId,
            bytes,
            'published_corruption',
          );
          return refused('managed_tool_result_digest_mismatch');
        }
        throw error;
      }
    });
  }

  seal(
    request: unknown,
  ): Promise<ToolResultStoreOutcome<ToolResultSealReceipt>> {
    if (this.closed || !this.lease) {
      return Promise.reject(
        new ManagedSessionRecordError('tool-result store is not writable.'),
      );
    }
    let fields;
    try {
      fields = parseToolResultSealRequest(request);
    } catch (error) {
      if (error instanceof ManagedSessionRecordError) {
        return Promise.resolve(refused('managed_tool_result_invalid'));
      }
      return Promise.reject(error);
    }
    return this.enqueue(async () => {
      try {
        const stream = await this.ensureStream(
          fields.captureId,
          fields.streamId,
        );
        const storedSeal = await this.readSeal(
          stream,
          fields.captureId,
          fields.streamId,
        );
        if (storedSeal) {
          if (
            storedSeal.segmentCount !== fields.segmentCount ||
            storedSeal.byteLength !== fields.byteLength ||
            storedSeal.digest !== fields.digest
          ) {
            return refused('managed_tool_result_conflict');
          }
        }
        const entries = await readdir(stream);
        const names = entries.filter((name) => /^segment-[0-9]{5}$/.test(name));
        if (
          names.length !== fields.segmentCount ||
          entries.some((name) => {
            const match = /^(?:segment|published|corrupt)-([0-9]{5})$/.exec(
              name,
            );
            return match && Number(match[1]) >= fields.segmentCount;
          })
        ) {
          return refused(
            storedSeal
              ? 'managed_tool_result_digest_mismatch'
              : 'managed_tool_result_conflict',
          );
        }
        const hash = createHash('sha256');
        let byteLength = 0;
        for (let ordinal = 0; ordinal < fields.segmentCount; ordinal++) {
          const receipt = await this.readSegment(
            stream,
            ordinal,
            (chunk) => hash.update(chunk),
            true,
          );
          if (!receipt) return refused('managed_tool_result_conflict');
          byteLength += receipt.byteLength;
        }
        if (
          byteLength !== fields.byteLength ||
          hash.digest('hex') !== fields.digest
        ) {
          return refused('managed_tool_result_digest_mismatch');
        }
        if (storedSeal) {
          await syncDirectory(stream);
          await this.ensureStreamAnchor(fields.captureId, fields.streamId);
          await this.ensureSealAnchor(
            fields.captureId,
            fields.streamId,
            storedSeal,
          );
          return ok(storedSeal);
        }
        const receipt = {
          segmentCount: fields.segmentCount,
          byteLength: fields.byteLength,
          digest: fields.digest,
        };
        await installDirectory(stream, 'seal', [
          { name: 'receipt.json', bytes: Buffer.from(JSON.stringify(receipt)) },
        ]);
        await this.ensureStreamAnchor(fields.captureId, fields.streamId);
        await this.ensureSealAnchor(fields.captureId, fields.streamId, receipt);
        return ok(receipt);
      } catch (error) {
        if (error instanceof CorruptToolResultError) {
          return refused('managed_tool_result_digest_mismatch');
        }
        throw error;
      }
    });
  }

  prefix(request: unknown): Promise<ToolResultStoreOutcome<ToolResultPrefix>> {
    if (this.closed) {
      return Promise.reject(
        new ManagedSessionRecordError('tool-result store is closed.'),
      );
    }
    let fields;
    try {
      fields = parseToolResultPrefixRequest(request);
    } catch (error) {
      if (error instanceof ManagedSessionRecordError) {
        return Promise.resolve(refused('managed_tool_result_invalid'));
      }
      return Promise.reject(error);
    }
    const operation = async () => {
      let retried = false;
      while (true) {
        try {
          const stream = await this.existingStream(
            fields.captureId,
            fields.streamId,
          );
          if (!stream) {
            return ok({
              segmentCount: 0,
              byteLength: 0,
              digest: EMPTY_DIGEST,
              sealed: false,
            });
          }
          const hash = createHash('sha256');
          let segmentCount = 0;
          let byteLength = 0;
          while (segmentCount <= MANAGED_TOOL_RESULT_LIMITS.maxOrdinal) {
            const receipt = await this.readSegment(
              stream,
              segmentCount,
              (chunk) => hash.update(chunk),
              !!this.lease,
            );
            if (!receipt) break;
            segmentCount++;
            byteLength += receipt.byteLength;
          }
          const digest = hash.digest('hex');
          const seal = await this.readSeal(
            stream,
            fields.captureId,
            fields.streamId,
          );
          if (
            seal &&
            (seal.segmentCount !== segmentCount ||
              seal.byteLength !== byteLength ||
              seal.digest !== digest)
          ) {
            throw new CorruptToolResultError(
              'sealed tool-result stream changed.',
            );
          }
          if (this.lease && (segmentCount > 0 || seal)) {
            await syncDirectory(stream);
            await this.ensureStreamAnchor(fields.captureId, fields.streamId);
            if (seal) {
              await this.ensureSealAnchor(
                fields.captureId,
                fields.streamId,
                seal,
              );
            }
          }
          return ok({ segmentCount, byteLength, digest, sealed: !!seal });
        } catch (error) {
          if (error instanceof CorruptToolResultError) {
            if (!this.lease && !retried) {
              retried = true;
              continue;
            }
            return refused('managed_tool_result_digest_mismatch');
          }
          throw error;
        }
      }
    };
    return this.enqueue(operation);
  }

  private async resourcePath(ref: ManagedSessionDurableRef): Promise<string> {
    await assertDirectory(this.sessionRoot);
    const directory = path.join(this.sessionRoot, ref.kind);
    await assertDirectory(directory);
    return path.join(directory, ref.resourceId);
  }

  private async readResource(
    ref: ManagedSessionDurableRef,
    maxBytes: number,
  ): Promise<Buffer> {
    const file = await this.resourcePath(ref);
    const bytes = await readSmallFile(file, maxBytes);
    if (
      bytes.byteLength !== ref.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== ref.digest
    ) {
      throw new CorruptToolResultError('tool-result resource digest changed.');
    }
    return bytes;
  }

  readRange(
    request: ToolResultRangeRequest,
  ): Promise<ToolResultStoreOutcome<Buffer>> {
    if (this.closed) {
      return Promise.reject(
        new ManagedSessionRecordError('tool-result store is closed.'),
      );
    }
    return this.enqueue(() => this.readRangeInternal(request));
  }

  private async readRangeInternal(
    request: ToolResultRangeRequest,
  ): Promise<ToolResultStoreOutcome<Buffer>> {
    try {
      const ref = assertResourceRef(
        request.manifestRef,
        MANAGED_TOOL_RESULT_KINDS.manifest,
        MANAGED_TOOL_RESULT_LIMITS.maxManifestBytes,
      );
      const offset = assertManagedSessionSequence(
        request.offset,
        'range.offset',
      );
      const length = assertManagedSessionSequence(
        request.length,
        'range.length',
      );
      if (length > MANAGED_TOOL_RESULT_LIMITS.maxSegmentBytes) {
        return refused('managed_tool_result_invalid');
      }
      const manifest = parseToolResultManifestBytes(
        await this.readResource(
          ref,
          MANAGED_TOOL_RESULT_LIMITS.maxManifestBytes,
        ),
      );
      if (
        manifest.tenantId !== this.sessionKey.tenantId ||
        manifest.sessionId !== this.sessionKey.sessionId ||
        identityKeys.some(
          (key) => manifest[key] !== request.expectedIdentity?.[key],
        )
      ) {
        return refused('managed_tool_result_conflict');
      }
      const entryIndex = manifest.contents.findIndex(
        (item) => item.streamId === request.streamId,
      );
      const entry = manifest.contents[entryIndex];
      if (
        !entry ||
        offset > entry.byteLength ||
        length > entry.byteLength - offset
      ) {
        return refused('managed_tool_result_invalid');
      }
      const bytes = Buffer.alloc(length);
      if ('ref' in entry.body) {
        const contentRef = assertResourceRef(
          entry.body.ref,
          MANAGED_TOOL_RESULT_KINDS.content,
        );
        await hashFile(
          await this.resourcePath(contentRef),
          contentRef.byteLength,
          contentRef.digest,
          (chunk, position) => copyRange(chunk, position, offset, bytes),
        );
      } else {
        const stream = await this.existingStream(
          manifest.captureId,
          entry.streamId,
        );
        if (!stream && entry.byteLength > 0) {
          throw new CorruptToolResultError('missing tool-result stream.');
        }
        for (
          let pageIndex = 0;
          pageIndex < entry.body.pages.length;
          pageIndex++
        ) {
          const pageRef = assertResourceRef(
            entry.body.pages[pageIndex].ref,
            MANAGED_TOOL_RESULT_KINDS.page,
            MANAGED_TOOL_RESULT_LIMITS.maxPageBytes,
          );
          const page = parseToolResultPageBytes(
            await this.readResource(
              pageRef,
              MANAGED_TOOL_RESULT_LIMITS.maxPageBytes,
            ),
          );
          if (!isToolResultPageAt(manifest, entryIndex, pageIndex, page)) {
            return refused('managed_tool_result_conflict');
          }
          let position = page.offset;
          for (let index = 0; index < page.segments.length; index++) {
            const segment = page.segments[index];
            const end = position + segment.byteLength;
            if (position < offset + length && end > offset) {
              if (!stream)
                throw new CorruptToolResultError('missing tool-result stream.');
              const receipt = await this.readSegment(
                stream,
                page.firstOrdinal + index,
                (chunk) => {
                  copyRange(chunk, position, offset, bytes);
                  position += chunk.byteLength;
                },
                !!this.lease,
              );
              if (
                !receipt ||
                receipt.byteLength !== segment.byteLength ||
                receipt.digest !== segment.digest
              ) {
                throw new CorruptToolResultError(
                  'tool-result page segment changed.',
                );
              }
            }
            position = end;
          }
        }
      }
      return ok(bytes);
    } catch (error) {
      if (error instanceof CorruptToolResultError || isMissing(error)) {
        return refused('managed_tool_result_digest_mismatch');
      }
      if (error instanceof ManagedSessionRecordError) {
        return refused('managed_tool_result_invalid');
      }
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.tail.finally(() => {
      if (this.lease) writableRoots.delete(this.root);
    });
    return this.closePromise;
  }
}

function copyRange(
  chunk: Buffer,
  position: number,
  offset: number,
  output: Buffer,
): void {
  const from = Math.max(position, offset);
  const to = Math.min(position + chunk.byteLength, offset + output.byteLength);
  if (to > from) {
    chunk.copy(output, from - offset, from - position, to - position);
  }
}
