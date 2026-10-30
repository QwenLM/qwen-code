/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import {
  isUnverifiableIdentityError,
  openNoFollow,
} from '../utils/no-follow-open.js';
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

export const MANAGED_SESSION_RESOURCE_LIMITS = Object.freeze({
  /**
   * A runaway guard rather than a retention policy: retention is the
   * checkpoint/compaction work, but no single publish may fill the disk on
   * its own.
   */
  maxResourceBytes: 64 * 1024 * 1024,
} as const);

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
    if (
      kind === 'managed-local-journal-snapshot' ||
      kind === 'managed-local-journal-snapshot-page'
    ) {
      throw new ManagedSessionRecordError(
        'Native snapshot resources use their dedicated publisher.',
      );
    }
    return this.publishBytes(kind, bytes, randomUUID(), false);
  }

  publishJournalSnapshot(
    kind:
      | 'managed-local-journal-snapshot'
      | 'managed-local-journal-snapshot-page',
    bytes: Buffer,
  ): Promise<ManagedSessionDurableRef> {
    return this.publishBytes(
      kind,
      bytes,
      createHash('sha256').update(bytes).digest('hex'),
      true,
    );
  }

  private async publishBytes(
    kind: string,
    bytes: Buffer,
    resourceId: string,
    immutable: boolean,
  ): Promise<ManagedSessionDurableRef> {
    const safeKind = assertPathSegment(kind, 'kind');
    if (bytes.byteLength > MANAGED_SESSION_RESOURCE_LIMITS.maxResourceBytes) {
      throw new ManagedSessionRecordError(
        `${safeKind} is ${bytes.byteLength} bytes where ${MANAGED_SESSION_RESOURCE_LIMITS.maxResourceBytes} is the maximum.`,
      );
    }
    const directory = path.join(this.root, safeKind);
    const pending = path.join(
      directory,
      immutable
        ? `.${resourceId}.${randomUUID()}.pending`
        : `.${resourceId}.pending`,
    );

    const target = path.join(directory, resourceId);
    await ensurePrivateDirectory(path.dirname(this.root));
    await ensurePrivateDirectory(this.root);
    const checkedDirectory = await ensurePrivateDirectory(directory);

    const resourceRef: ManagedSessionDurableRef = {
      resourceId,
      kind: safeKind,
      schemaVersion: 1,
      byteLength: bytes.byteLength,
      digest: immutable
        ? resourceId
        : createHash('sha256').update(bytes).digest('hex'),
    };
    if (immutable && (await lstatOrUndefined(target))) {
      await this.read(resourceRef);
      await syncDirectory(directory);
      return resourceRef;
    }
    const handle = await open(pending, 'wx', 0o600);
    let written: { dev: number; ino: number };
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      written = await handle.stat();
    } catch (cause) {
      await handle.close();
      await unlink(pending).catch(() => undefined);
      throw cause;
    }
    await handle.close();

    try {
      if (immutable) {
        try {
          await link(pending, target);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
          await this.read(resourceRef);
          await unlink(pending);
          await syncDirectory(directory);
          return resourceRef;
        }
        await unlink(pending);
      } else {
        await rename(pending, target);
      }
      // The directory checks above and this rename are path-based, and Node
      // has no `openat`, so a swap between them can land the bytes outside the
      // session tree. These checks refuse a publish whose entry is no longer
      // the file this call wrote, or whose kind directory is no longer the
      // directory that was checked — including the case where the swapped
      // symlink is still in place, which a target-only check resolves through
      // and compares the outside file to itself. A swap reverted before the
      // checks still escapes, so this narrows the window rather than proving
      // containment.
      const destination = await lstatOrUndefined(directory);
      const published = await lstatOrUndefined(target);
      if (
        destination === undefined ||
        destination.isSymbolicLink() ||
        !destination.isDirectory() ||
        destination.dev !== checkedDirectory.dev ||
        destination.ino !== checkedDirectory.ino ||
        published === undefined ||
        !published.isFile() ||
        published.dev !== written.dev ||
        published.ino !== written.ino
      ) {
        throw new ManagedSessionRecordError(
          `resource ${resourceId} was not published inside its session directory.`,
        );
      }
      await syncDirectory(directory);
    } catch (cause) {
      await unlink(pending).catch(() => undefined);
      throw cause;
    }

    return resourceRef;
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
    // Opening the leaf without following it only helps when the directories
    // above it are real: a symlinked kind directory redirects the same open to
    // an outside copy that passes the digest check.
    try {
      for (const directory of [
        path.dirname(this.root),
        this.root,
        path.dirname(target),
      ]) {
        const ancestor = await lstat(directory);
        if (ancestor.isSymbolicLink() || !ancestor.isDirectory()) {
          throw new ManagedSessionRecordError(
            `session resource directory is not private: ${directory} is not a real directory.`,
          );
        }
      }
    } catch (cause) {
      if (cause instanceof ManagedSessionRecordError) throw cause;
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ManagedSessionRecordError(
          `resource ${ref.resourceId} is not present for session ${this.sessionKey.sessionId}.`,
        );
      }
      throw cause;
    }
    let bytes: Buffer;
    let size: number;
    try {
      // A symlink here redirects the read outside the session's tree, so the
      // leaf must be a regular file before its bytes are trusted.
      const stat = await lstat(target);
      if (!stat.isFile()) {
        throw new ManagedSessionRecordError(
          `resource ${ref.resourceId} is not a regular file.`,
        );
      }
      size = stat.size;
    } catch (cause) {
      if (cause instanceof ManagedSessionRecordError) throw cause;
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ManagedSessionRecordError(
          `resource ${ref.resourceId} is not present for session ${this.sessionKey.sessionId}.`,
        );
      }
      throw cause;
    }
    if (size !== ref.byteLength) {
      throw new ManagedSessionRecordError(
        `resource ${ref.resourceId} is ${size} bytes on disk where ${ref.byteLength} was recorded.`,
      );
    }
    let handle: FileHandle;
    try {
      handle = await openNoFollow(target);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ManagedSessionRecordError(
          `resource ${ref.resourceId} is not present for session ${this.sessionKey.sessionId}.`,
        );
      }
      if ((cause as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new ManagedSessionRecordError(
          `resource ${ref.resourceId} is not a regular file.`,
        );
      }
      if (isUnverifiableIdentityError(cause)) {
        throw new ManagedSessionRecordError(
          `resource ${ref.resourceId} could not be identity-verified.`,
        );
      }
      throw cause;
    }
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== size) {
        throw new ManagedSessionRecordError(
          `resource ${ref.resourceId} changed while it was being read.`,
        );
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
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

/**
 * Creates a directory the session owns with private permissions, refuses
 * anything that is not a real directory, and tightens a pre-existing real
 * directory to 0700 when permitted rather than refusing it. Without the
 * check a pre-existing symlink redirects every resource written through it.
 */
async function ensurePrivateDirectory(
  directory: string,
): Promise<{ dev: number; ino: number }> {
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ManagedSessionRecordError(
      `session resource directory is not private: ${directory} is not a real directory.`,
    );
  }
  // Directories written by an earlier build carry the process default mode.
  // Tighten them when permitted; a directory owned by another user or on a
  // mount without chmod support stays as it is rather than turning a working
  // publish into a refusal.
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) {
    await tightenDirectory(directory);
  }
  // `publish` promises a ref that is safe to reference from a transaction
  // once it resolves, so a directory entry has to be durable in its parent
  // before bytes land under it. `publish` calls this once per level, so only
  // the level this call created is new; syncing an existing parent on every
  // publish would add a directory fsync per level for nothing.
  if (created !== undefined) {
    await syncDirectory(path.dirname(directory));
  }
  return { dev: stat.dev, ino: stat.ino };
}

async function lstatOrUndefined(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw cause;
  }
}

/**
 * Tightens a directory the session owns through a no-follow handle. A swap
 * between the lstat gate and this call cannot redirect the permission change
 * to another path. A refused open or chmod leaves the directory as it is so
 * a working publish does not become a refusal.
 */
async function tightenDirectory(directory: string): Promise<void> {
  const flags =
    constants.O_RDONLY |
    (constants.O_NOFOLLOW ?? 0) |
    (constants.O_DIRECTORY ?? 0);
  let handle: FileHandle;
  try {
    handle = await open(directory, flags);
  } catch {
    return;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory()) return;
    await handle.chmod(0o700);
  } catch {
    // A refused chmod keeps the pre-change capability.
  } finally {
    await handle.close();
  }
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
