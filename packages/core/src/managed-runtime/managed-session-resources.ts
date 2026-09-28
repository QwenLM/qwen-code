/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, rename, readFile, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { managedSessionResourceRoot } from '../utils/sessionStorageUtils.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
import {
  assertManagedBranchRecord,
  assertManagedSessionDurableRef,
  ManagedSessionRecordError,
  parseManagedSessionRecordJson,
  type ManagedSessionDurableRef,
  type ManagedSessionEvent,
  type ManagedSessionKey,
} from './managed-session-records.js';
import type { ManagedSessionResourceStore } from './managed-session-storage.js';

/**
 * Session-owned resource storage. Event payloads carry a `DurableRef` rather
 * than inline content, so without a store the log can only reference bytes
 * that exist nowhere.
 *
 * This covers publish and read for one session's private resources. Retention,
 * orphan reclamation, pins and workspace-owned resources are separate concerns
 * that need the reference-closure ledger, and are deliberately absent.
 */
export class LocalManagedSessionResourceStore
  implements ManagedSessionResourceStore
{
  private constructor(
    private readonly root: string,
    private readonly sessionKey: ManagedSessionKey,
  ) {}

  /**
   * Resources live beside the session under the controlled runtime base
   * directory. The system temp directory is never used, so publishing can
   * rename within one filesystem.
   */
  static create(options: {
    runtimeBaseDir: string;
    sessionKey: ManagedSessionKey;
  }): LocalManagedSessionResourceStore {
    return new LocalManagedSessionResourceStore(
      managedSessionResourceRoot(
        options.runtimeBaseDir,
        options.sessionKey.sessionId,
      ),
      options.sessionKey,
    );
  }

  get sessionRoot(): string {
    return this.root;
  }

  /**
   * Writes the bytes to a controlled temporary file, hashes while writing,
   * syncs, then publishes atomically and syncs the containing directory. The
   * returned ref is only safe to reference from a transaction after this
   * resolves.
   */
  async publish(
    kind: string,
    bytes: Buffer,
  ): Promise<ManagedSessionDurableRef> {
    const safeKind = assertPathSegment(kind, 'kind');
    const resourceId = randomUUID();
    const directory = path.join(this.root, safeKind);
    const pending = path.join(directory, `.${resourceId}.pending`);
    const target = path.join(directory, resourceId);
    await mkdir(directory, { recursive: true });

    const digest = createHash('sha256');
    const handle = await open(pending, 'wx', 0o600);
    try {
      digest.update(bytes);
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (cause) {
      await handle.close();
      await unlink(pending).catch(() => undefined);
      throw cause;
    }
    await handle.close();

    try {
      await rename(pending, target);
      await syncDirectory(directory);
    } catch (cause) {
      await unlink(pending).catch(() => undefined);
      throw cause;
    }

    return {
      resourceId,
      kind: safeKind,
      schemaVersion: 1,
      byteLength: bytes.byteLength,
      digest: digest.digest('hex'),
    };
  }

  /**
   * Reads a ref this session owns, verifying length and digest. A ref that
   * does not resolve to the recorded content is a failure, not a cache miss.
   */
  async read(ref: ManagedSessionDurableRef): Promise<Buffer> {
    const target = path.join(
      this.root,
      assertPathSegment(ref.kind, 'kind'),
      assertPathSegment(ref.resourceId, 'resourceId'),
    );
    let bytes: Buffer;
    try {
      bytes = await readFile(target);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ManagedSessionRecordError(
          `resource ${ref.resourceId} is not present for session ${this.sessionKey.sessionId}.`,
        );
      }
      throw cause;
    }
    if (bytes.byteLength !== ref.byteLength) {
      throw new ManagedSessionRecordError(
        `resource ${ref.resourceId} is ${bytes.byteLength} bytes where ${ref.byteLength} was recorded.`,
      );
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== ref.digest) {
      throw new ManagedSessionRecordError(
        `resource ${ref.resourceId} does not match its recorded digest.`,
      );
    }
    return bytes;
  }
}

/**
 * Classifies a committed checkpoint before recovery trusts it.
 *
 * A historical Managed log recorded branch points as `checkpoint.committed`
 * referencing a whole ChatRecord, so the resource kind is the only thing
 * separating a display record from Harness state. Returning that record is
 * what lets a reader keep showing those branch points without letting one
 * stand in for a resumable state; Harness state is never decoded as a record.
 */
export async function readManagedBranchCheckpoint(
  event: ManagedSessionEvent,
  resources: ManagedSessionResourceStore | undefined,
  checkpointSequence: (id: string) => number | undefined,
  committedSequence: number,
): Promise<ChatRecord | undefined> {
  if (event.kind !== 'checkpoint.committed') return undefined;
  if (resources === undefined) {
    throw new ManagedSessionRecordError(
      'a resource store is required to classify checkpoints.',
    );
  }
  const ref = assertManagedSessionDurableRef(
    event.payload['stateRef'],
    'checkpoint state',
  );
  const branch = ref.kind === 'managed-branch-checkpoint';
  if (
    ref.schemaVersion !== 1 ||
    (!branch && ref.kind !== 'managed-checkpoint')
  ) {
    throw new ManagedSessionRecordError('unknown checkpoint state format.');
  }
  const id = event.payload['checkpointId'] as string;
  const covered = event.payload['coveredSequence'] as number;
  const previous = event.payload['previousCheckpointId'] as string | null;
  const previousSequence =
    previous === null ? undefined : checkpointSequence(previous);
  if (
    checkpointSequence(id) !== undefined ||
    covered >= event.sequence ||
    covered > committedSequence ||
    (previous !== null &&
      (previousSequence === undefined || previousSequence > covered))
  ) {
    throw new ManagedSessionRecordError(
      'invalid checkpoint coverage or predecessor.',
    );
  }
  if (
    branch &&
    (event.payload['boundary'] !== null || covered !== event.sequence - 1)
  ) {
    throw new ManagedSessionRecordError(
      'invalid historical branch checkpoint boundary.',
    );
  }
  if (!branch) return undefined;
  const bytes = await resources.read(ref);
  return assertManagedBranchRecord(
    parseManagedSessionRecordJson(bytes.toString('utf8'), ref.byteLength),
    event.sessionKey,
    id,
  );
}

function assertPathSegment(value: string, label: string): string {
  if (value.length === 0) {
    throw new ManagedSessionRecordError(`${label} must not be empty.`);
  }
  if (value !== path.basename(value) || value === '.' || value === '..') {
    throw new ManagedSessionRecordError(
      `${label} must be a single path segment.`,
    );
  }
  return value;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    // Windows cannot fsync a directory; tolerate the refusal the same way
    // the writer-lease and deletion-journal stores do.
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
