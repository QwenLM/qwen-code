/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MANAGED_MESSAGE_BODY_ENTRY_BYTES } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-message-projection.js';
import {
  managedSessionDurableRefsEqual,
  type ManagedSessionDurableRef,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-storage.js';

/**
 * The budget of each `HostedRestoreKeptBytes`: a cold Workspace load keeps one
 * per kind of resource it reuses, each within this many bytes. An entry is
 * charged its length plus a fixed overhead; the message-body cache's measured
 * entry overhead stands in for the key, map entry and buffer objects, which
 * are of the same shape here. A resource past the budget is read from the
 * Session Store again by the step that needs it.
 */
const HOSTED_RESTORE_KEEP_BYTES = 8 * 1024 * 1024;

/**
 * A reader that serves `bytes`, already read through `store`, for exactly
 * `ref`, and reads every other resource through `store`.
 */
export function readerWithVerified(
  store: Pick<ManagedSessionResourceStore, 'read'>,
  ref: ManagedSessionDurableRef,
  bytes: Buffer,
): Pick<ManagedSessionResourceStore, 'read'> {
  return {
    read: (part) =>
      managedSessionDurableRefsEqual(part, ref)
        ? Promise.resolve(bytes)
        : store.read(part),
  };
}

/**
 * Resource bytes a cold Workspace load read and verified once, kept within a
 * byte budget so that a later step does not read them from the Store again.
 * The read that produced them must have checked them against their reference;
 * `keep` checks only their length. Entries are served only for a reference
 * identical to the one they were kept under. Each entry is held in a buffer of
 * its own, so a slice of a pooled buffer does not pin the pool. Kept buffers
 * are shared with their readers and must not be modified.
 */
export class HostedRestoreKeptBytes {
  private readonly kept = new Map<
    string,
    { readonly ref: ManagedSessionDurableRef; readonly bytes: Buffer }
  >();
  private size = 0;

  constructor(
    private readonly limitBytes = HOSTED_RESTORE_KEEP_BYTES,
    private readonly entryBytes = MANAGED_MESSAGE_BODY_ENTRY_BYTES,
  ) {}

  /** Charged bytes of the kept entries. */
  get bytes(): number {
    return this.size;
  }

  /**
   * Keeps `bytes` for `ref` unless their length differs from the ref's,
   * something is kept for that resource already, or the budget does not
   * allow it. Returns whether it is kept.
   */
  keep(ref: ManagedSessionDurableRef, bytes: Buffer): boolean {
    const cost = bytes.byteLength + this.entryBytes;
    if (
      bytes.byteLength !== ref.byteLength ||
      this.kept.has(ref.resourceId) ||
      this.size + cost > this.limitBytes
    )
      return false;
    let held = bytes;
    if (bytes.buffer.byteLength !== bytes.byteLength) {
      held = Buffer.allocUnsafeSlow(bytes.byteLength);
      bytes.copy(held);
    }
    this.kept.set(ref.resourceId, { ref, bytes: held });
    this.size += cost;
    return true;
  }

  /** The bytes kept for exactly `ref`, if any. */
  get(ref: ManagedSessionDurableRef): Buffer | undefined {
    const entry = this.kept.get(ref.resourceId);
    return entry !== undefined && managedSessionDurableRefsEqual(entry.ref, ref)
      ? entry.bytes
      : undefined;
  }

  /** The kept entries, in the order they were kept. */
  entries(): IterableIterator<{
    readonly ref: ManagedSessionDurableRef;
    readonly bytes: Buffer;
  }> {
    return this.kept.values();
  }

  /** Releases every entry. */
  clear(): void {
    this.kept.clear();
    this.size = 0;
  }
}
