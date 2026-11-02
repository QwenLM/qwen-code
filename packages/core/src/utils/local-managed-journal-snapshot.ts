/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openSyncNoFollow } from './no-follow-open.js';
import {
  MANAGED_SESSION_LIMITS,
  ManagedSessionRecordError,
} from './managed-session-format.js';
import type {
  ManagedSessionDurableRef,
  ManagedSessionHeader,
  ManagedSessionJsonValue,
  ManagedSessionKey,
} from '../managed-runtime/managed-session-records.js';

export const LOCAL_MANAGED_SNAPSHOT_KIND = 'managed-local-journal-snapshot';

export const LOCAL_MANAGED_SNAPSHOT_PAGE_KIND =
  'managed-local-journal-snapshot-page';

export const LOCAL_MANAGED_SNAPSHOT_BASE = 'managed_session_snapshot_base_v1';

export const LOCAL_MANAGED_SNAPSHOT_FORMAT =
  'qwen-managed-local-journal-snapshot/1';

export const LOCAL_MANAGED_SNAPSHOT_PAGE_BYTES = 16 * 1024 * 1024;

export const LOCAL_MANAGED_JOURNAL_FORMAT = 2;

export interface LocalManagedJournalManifest {
  readonly format: typeof LOCAL_MANAGED_SNAPSHOT_FORMAT;
  readonly sessionKey: ManagedSessionKey;
  readonly pages: readonly ManagedSessionDurableRef[];
  readonly byteLength: number;
  readonly digest: string;
  readonly committedSequence: number;
  readonly lastCommitDigest: string;
  readonly lastRecordUuid: string;
  readonly resources: readonly ManagedSessionDurableRef[];
  readonly titleRef: ManagedSessionDurableRef | null;
  readonly sourceRef: ManagedSessionDurableRef | null;
}

export interface LocalManagedJournalBase {
  readonly manifest: ManagedSessionDurableRef;
  readonly header: ManagedSessionHeader;
  readonly headerEnd: number;
  readonly baseEnd: number;
}

export function localJournalDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function localJournalObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManagedSessionRecordError(
      'Local journal snapshot is not an object.',
    );
  }
  return value as Record<string, unknown>;
}

function requireSnapshot(
  condition: boolean,
  detail: string,
): asserts condition {
  if (!condition)
    throw new ManagedSessionRecordError(`Local journal snapshot ${detail}.`);
}

export function localJournalRef(value: unknown): ManagedSessionDurableRef {
  return assertManagedSessionDurableRef(value as ManagedSessionJsonValue);
}

/** Read one physical generation, including when a frozen byte bound is supplied. */
export function readLocalJournalBytes(
  filePath: string,
  maxBytes?: number,
  expectedBytes?: number,
): Buffer {
  const fd = openSyncNoFollow(filePath);
  try {
    const before = fs.fstatSync(fd);
    requireSnapshot(before.isFile(), 'is not a regular file');
    requireSnapshot(
      expectedBytes === undefined || before.size === expectedBytes,
      'resource length differs',
    );
    const size =
      maxBytes === undefined ? before.size : Math.min(maxBytes, before.size);
    requireSnapshot(
      Number.isSafeInteger(size) && size >= 0,
      'byte bound is invalid',
    );
    const bytes = readDescriptorPrefix(fd, size);
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(filePath);
    requireSnapshot(
      !current.isSymbolicLink() &&
        current.isFile() &&
        current.dev === before.dev &&
        current.ino === before.ino &&
        after.size >= size &&
        ((after.ctimeMs === before.ctimeMs &&
          after.mtimeMs === before.mtimeMs) ||
          (maxBytes !== undefined &&
            after.size > before.size &&
            readDescriptorPrefix(fd, size).equals(bytes))),
      'file changed while reading',
    );
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ManagedSessionRecordError(
        'Local journal generation disappeared while reading.',
      );
    }
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function readDescriptorPrefix(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(fd, bytes, offset, size - offset, offset);
    requireSnapshot(count > 0, 'file ended before its frozen boundary');
    offset += count;
  }
  return bytes;
}

export function parseLocalJournalBase(
  bytes: Buffer,
  sessionKey: ManagedSessionKey,
): LocalManagedJournalBase | undefined {
  let header: ManagedSessionHeader | undefined;
  let headerEnd = 0;
  let offset = 0;
  while (offset < bytes.length) {
    const start = offset;
    const end = bytes.indexOf(10, offset);
    if (end < 0) break;
    const line = bytes.subarray(offset, end).toString('utf8');
    if (line.length === 0) return undefined;
    let record: Record<string, unknown>;
    try {
      record = localJournalObject(
        parseManagedSessionRecordJson(
          line,
          MANAGED_SESSION_LIMITS.maxEventBytes,
        ),
      );
    } catch {
      return undefined;
    }
    offset = end + 1;
    if (record['subtype'] === 'managed_session_header_v1') {
      if (
        localJournalObject(record['managedSession'])['minimumReader'] !==
        'managed-session/2'
      )
        return undefined;
      requireSnapshot(header === undefined, 'header is repeated');
      requireSnapshot(
        end - start <= MANAGED_SESSION_LIMITS.maxHeaderBytes,
        'header exceeds its byte limit',
      );
      header = parseManagedSessionHeader(record['managedSession']);
      requireSnapshot(
        managedSessionKeysEqual(header.sessionKey, sessionKey),
        'scope differs',
      );
      headerEnd = offset;
      continue;
    }
    if (record['subtype'] === LOCAL_MANAGED_SNAPSHOT_BASE) {
      requireSnapshot(
        header !== undefined && headerEnd === start,
        'base precedes its header',
      );
      requireSnapshot(
        header.minimumReader === 'managed-session/2',
        'base has no reader barrier',
      );
      const body = localJournalObject(record['managedSessionSnapshot']);
      requireSnapshot(
        body['format'] === LOCAL_MANAGED_SNAPSHOT_FORMAT &&
          Object.keys(body).length === 3 &&
          record['type'] === 'system' &&
          typeof record['uuid'] === 'string' &&
          record['uuid'].length > 0 &&
          (typeof record['parentUuid'] === 'string' ||
            record['parentUuid'] === null) &&
          record['sessionId'] === sessionKey.sessionId,
        'base fields are invalid',
      );
      requireSnapshot(
        managedSessionKeysEqual(
          assertManagedSessionKey(
            body['sessionKey'] as ManagedSessionJsonValue,
          ),
          sessionKey,
        ),
        'base scope differs',
      );
      const manifest = localJournalRef(body['manifest']);
      requireSnapshot(
        manifest.kind === LOCAL_MANAGED_SNAPSHOT_KIND &&
          manifest.resourceId === manifest.digest,
        'manifest ref is invalid',
      );
      return { manifest, header, headerEnd, baseEnd: offset };
    }
    if (header !== undefined) {
      requireSnapshot(
        header.minimumReader !== 'managed-session/2',
        'base is missing',
      );
      return undefined;
    }
  }
  requireSnapshot(
    header?.minimumReader !== 'managed-session/2',
    'base is incomplete',
  );
  return undefined;
}

export function readLocalJournalResource(
  runtimeBaseDir: string,
  sessionKey: ManagedSessionKey,
  ref: ManagedSessionDurableRef,
): Buffer {
  const root = path.join(runtimeBaseDir, 'resources', sessionKey.sessionId);
  for (const segment of [sessionKey.sessionId, ref.kind, ref.resourceId]) {
    requireSnapshot(
      segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !/[/\\]/.test(segment),
      'resource path is invalid',
    );
  }
  for (const directory of [
    path.dirname(root),
    root,
    path.join(root, ref.kind),
  ]) {
    const stat = fs.lstatSync(directory);
    requireSnapshot(
      stat.isDirectory() && !stat.isSymbolicLink(),
      'resource directory is not private',
    );
  }
  requireSnapshot(
    ref.byteLength <= 64 * 1024 * 1024,
    'resource exceeds its byte limit',
  );
  const bytes = readLocalJournalBytes(
    path.join(root, ref.kind, ref.resourceId),
    undefined,
    ref.byteLength,
  );
  requireSnapshot(
    bytes.length === ref.byteLength && localJournalDigest(bytes) === ref.digest,
    'resource length or digest differs',
  );
  return bytes;
}

export function readLocalJournalManifest(
  runtimeBaseDir: string,
  sessionKey: ManagedSessionKey,
  ref: ManagedSessionDurableRef,
): LocalManagedJournalManifest {
  requireSnapshot(
    ref.kind === LOCAL_MANAGED_SNAPSHOT_KIND &&
      ref.resourceId === ref.digest &&
      ref.schemaVersion === 1,
    'manifest reference is invalid',
  );
  const value = localJournalObject(
    parseManagedSessionRecordJson(
      readLocalJournalResource(runtimeBaseDir, sessionKey, ref).toString(
        'utf8',
      ),
      ref.byteLength,
    ),
  );
  requireSnapshot(
    value['format'] === LOCAL_MANAGED_SNAPSHOT_FORMAT &&
      Object.keys(value).length === 11,
    'manifest fields are invalid',
  );
  const key = assertManagedSessionKey(
    value['sessionKey'] as ManagedSessionJsonValue,
  );
  requireSnapshot(
    managedSessionKeysEqual(key, sessionKey),
    'manifest scope differs',
  );
  const list = (field: string) => {
    const items = value[field];
    requireSnapshot(Array.isArray(items), `${field} is not an array`);
    return items.map(localJournalRef);
  };
  const pages = list('pages');
  requireSnapshot(
    pages.length > 0 &&
      pages.every(
        (page) =>
          page.kind === LOCAL_MANAGED_SNAPSHOT_PAGE_KIND &&
          page.schemaVersion === 1 &&
          page.resourceId === page.digest &&
          page.byteLength <= LOCAL_MANAGED_SNAPSHOT_PAGE_BYTES,
      ),
    'page reference is invalid',
  );
  requireSnapshot(
    Number.isSafeInteger(value['byteLength']) &&
      (value['byteLength'] as number) > 0 &&
      Number.isSafeInteger(value['committedSequence']) &&
      (value['committedSequence'] as number) > 0 &&
      typeof value['digest'] === 'string' &&
      /^[0-9a-f]{64}$/.test(value['digest']) &&
      typeof value['lastCommitDigest'] === 'string' &&
      /^[0-9a-f]{64}$/.test(value['lastCommitDigest']) &&
      typeof value['lastRecordUuid'] === 'string',
    'manifest head is invalid',
  );
  return {
    format: LOCAL_MANAGED_SNAPSHOT_FORMAT,
    sessionKey: key,
    pages,
    byteLength: value['byteLength'] as number,
    digest: value['digest'],
    committedSequence: value['committedSequence'] as number,
    lastCommitDigest: value['lastCommitDigest'],
    lastRecordUuid: value['lastRecordUuid'],
    resources: list('resources'),
    titleRef:
      value['titleRef'] === null ? null : localJournalRef(value['titleRef']),
    sourceRef:
      value['sourceRef'] === null ? null : localJournalRef(value['sourceRef']),
  };
}

/** Metadata readers need only the manifest and current physical tail. */
export function readLocalSnapshotDomainBody(
  bytes: Buffer,
  runtimeBaseDir: string,
  domain: 'session_metadata' | 'session_source',
): { body?: unknown } | undefined {
  let header: ManagedSessionHeader | undefined;
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line) break;
    const record = localJournalObject(JSON.parse(line));
    if (record['subtype'] === 'managed_session_header_v1') {
      header = parseManagedSessionHeader(record['managedSession']);
      break;
    }
  }
  if (!header) return undefined;
  const base = parseLocalJournalBase(bytes, header.sessionKey);
  if (!base) return undefined;
  const manifest = readLocalJournalManifest(
    runtimeBaseDir,
    header.sessionKey,
    base.manifest,
  );
  const pending = new Map<number, ManagedSessionDurableRef>();
  let latest =
    domain === 'session_metadata' ? manifest.titleRef : manifest.sourceRef;
  const lines = bytes.subarray(base.baseEnd).toString('utf8').split('\n');
  lines.pop();
  for (const line of lines) {
    const record = localJournalObject(JSON.parse(line));
    const body = localJournalObject(record['managedSession']);
    if (
      record['subtype'] === 'managed_session_event_v1' &&
      body['kind'] === 'domain.committed'
    ) {
      const payload = localJournalObject(body['payload']);
      if (payload['domain'] === domain)
        pending.set(
          body['sequence'] as number,
          localJournalRef(payload['recordRef']),
        );
    }
    if (record['subtype'] === 'managed_session_commit_v1') {
      for (const [sequence, ref] of pending) {
        if (
          sequence >= (body['firstSequence'] as number) &&
          sequence <= (body['lastSequence'] as number)
        )
          latest = ref;
      }
      pending.clear();
    }
  }
  return latest
    ? {
        body: JSON.parse(
          readLocalJournalResource(
            runtimeBaseDir,
            header.sessionKey,
            latest,
          ).toString('utf8'),
        ) as unknown,
      }
    : {};
}

/** Ownership and a maximal header need not fit together in a display window. */
export function readLocalJournalHeader(
  filePath: string,
): ManagedSessionHeader | undefined {
  for (const { line, complete } of localJournalPrefixLines(filePath)) {
    if (!complete) return undefined;
    const record = localJournalObject(
      parseManagedSessionRecordJson(
        line.toString('utf8'),
        MANAGED_SESSION_LIMITS.maxEventBytes,
      ),
    );
    if (record['subtype'] === 'managed_session_header_v1') {
      requireSnapshot(
        line.length <= MANAGED_SESSION_LIMITS.maxHeaderBytes,
        'header exceeds its byte limit',
      );
      return parseManagedSessionHeader(record['managedSession']);
    }
    if (record['subtype'] !== 'session_execution_engine') return undefined;
  }
  return undefined;
}

export function readLocalJournalFirstLine(
  filePath: string,
): string | undefined {
  for (const { line } of localJournalPrefixLines(filePath))
    return line.toString('utf8');
  return undefined;
}

function* localJournalPrefixLines(
  filePath: string,
): Generator<{ line: Buffer; complete: boolean }> {
  const fd = openSyncNoFollow(filePath);
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0);
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) {
        if (pending.length) yield { line: pending, complete: false };
        return;
      }
      pending = Buffer.concat([pending, chunk.subarray(0, count)]);
      let end: number;
      while ((end = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, end);
        requireSnapshot(
          line.length <= MANAGED_SESSION_LIMITS.maxEventBytes,
          'ownership record exceeds its byte limit',
        );
        pending = pending.subarray(end + 1);
        yield { line, complete: true };
      }
      requireSnapshot(
        pending.length <= MANAGED_SESSION_LIMITS.maxEventBytes,
        'ownership record exceeds its byte limit',
      );
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function localJournalPhysicalPrefix(
  bytes: Buffer,
  header: ManagedSessionHeader,
): Buffer {
  const lines: string[] = [];
  for (const line of bytes.toString('utf8').split('\n')) {
    const record = localJournalObject(JSON.parse(line));
    if (record['subtype'] === 'managed_session_header_v1') {
      lines.push(
        JSON.stringify({
          ...record,
          managedSession: { ...header, minimumReader: 'managed-session/2' },
        }),
      );
      return Buffer.from(`${lines.join('\n')}\n`);
    }
    lines.push(line);
  }
  throw new ManagedSessionRecordError('Local snapshot source has no header.');
}

function parseManagedSessionRecordJson(text: string, maximum: number): unknown {
  requireSnapshot(
    Buffer.byteLength(text) <= maximum,
    'record exceeds its byte limit',
  );
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ManagedSessionRecordError(
      'Local journal snapshot JSON is invalid.',
    );
  }
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 1 },
  ];
  while (pending.length) {
    const item = pending.pop()!;
    if (typeof item.value === 'number')
      requireSnapshot(Number.isFinite(item.value), 'number is not finite');
    if (item.value !== null && typeof item.value === 'object') {
      requireSnapshot(
        item.depth <= MANAGED_SESSION_LIMITS.maxJsonDepth,
        'JSON exceeds its depth limit',
      );
      for (const child of Object.values(item.value))
        pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  return value;
}

function assertManagedSessionKey(value: unknown): ManagedSessionKey {
  const key = localJournalObject(value);
  requireSnapshot(
    Object.keys(key).length === 3 &&
      [key['tenantId'], key['workspaceId'], key['sessionId']].every(
        (part) =>
          typeof part === 'string' &&
          part.length > 0 &&
          Buffer.byteLength(part) <= 512 &&
          [...part].every(
            (character) =>
              character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          ),
      ),
    'scope is invalid',
  );
  return {
    tenantId: key['tenantId'] as string,
    workspaceId: key['workspaceId'] as string,
    sessionId: key['sessionId'] as string,
  };
}

function managedSessionKeysEqual(
  a: ManagedSessionKey,
  b: ManagedSessionKey,
): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.workspaceId === b.workspaceId &&
    a.sessionId === b.sessionId
  );
}

function assertManagedSessionDurableRef(
  value: unknown,
): ManagedSessionDurableRef {
  const ref = localJournalObject(value);
  requireSnapshot(
    Object.keys(ref).length === 5 &&
      [ref['resourceId'], ref['kind']].every(
        (part) =>
          typeof part === 'string' &&
          part.length > 0 &&
          Buffer.byteLength(part) <= 512,
      ) &&
      Number.isSafeInteger(ref['schemaVersion']) &&
      (ref['schemaVersion'] as number) > 0 &&
      Number.isSafeInteger(ref['byteLength']) &&
      (ref['byteLength'] as number) >= 0 &&
      typeof ref['digest'] === 'string' &&
      /^[0-9a-f]{64}$/.test(ref['digest']),
    'resource reference is invalid',
  );
  return {
    resourceId: ref['resourceId'] as string,
    kind: ref['kind'] as string,
    schemaVersion: ref['schemaVersion'] as number,
    byteLength: ref['byteLength'] as number,
    digest: ref['digest'] as string,
  };
}

// The filesystem envelope is checked here; native replay validates the complete source header.
function parseManagedSessionHeader(value: unknown): ManagedSessionHeader {
  const header = localJournalObject(value);
  requireSnapshot(
    header['formatVersion'] === 1 &&
      header['engine'] === 'managed' &&
      ['managed-session/1', 'managed-session/2'].includes(
        String(header['minimumReader']),
      ) &&
      typeof header['createdBy'] === 'string',
    'physical header is invalid',
  );
  return {
    formatVersion: 1,
    minimumReader: header['minimumReader'] as string,
    engine: 'managed',
    sessionKey: assertManagedSessionKey(header['sessionKey']),
    definitionRef: localJournalRef(header['definitionRef']),
    rootSnapshotRef: localJournalRef(header['rootSnapshotRef']),
    createdBy: header['createdBy'],
    ...(header['baseTranscriptProof'] === undefined
      ? {}
      : {
          baseTranscriptProof: localJournalRef(header['baseTranscriptProof']),
        }),
  };
}
