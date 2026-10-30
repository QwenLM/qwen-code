/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  assertManagedSessionDurableRef,
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';
import type { ManagedSessionResourceStore } from './managed-session-storage.js';

export const MANAGED_MESSAGE_KIND = 'managed-message';
export const MANAGED_MESSAGE_PART_KIND = 'managed-message-part';
export const MANAGED_MESSAGE_CHUNKS_KIND = 'managed-message-chunks';

/**
 * A part stays under the 64 KiB inline resource limit with margin, matching
 * the Hook message chunking precedent. A model answer routinely outgrows that
 * limit, and the final record must not fail its turn after the delta stream
 * already published the same text in full.
 */
export const MANAGED_MESSAGE_PART_BYTES = 60 * 1024;
export const MANAGED_MESSAGE_INLINE_BYTES = 64 * 1024;

/**
 * Publishes a reader-facing record body as one inline resource, or — past the
 * inline bound — as ordered byte parts behind a chunk manifest. Parts split on
 * byte offsets, not character boundaries; reassembly concatenates bytes before
 * decoding, so a split never damages the document.
 */
export async function publishManagedMessageBody(
  resources: ManagedSessionResourceStore,
  body: Buffer,
): Promise<ManagedSessionDurableRef> {
  if (body.byteLength <= MANAGED_MESSAGE_INLINE_BYTES) {
    return resources.publish(MANAGED_MESSAGE_KIND, body);
  }
  const parts: ManagedSessionDurableRef[] = [];
  for (
    let offset = 0;
    offset < body.byteLength;
    offset += MANAGED_MESSAGE_PART_BYTES
  ) {
    parts.push(
      await resources.publish(
        MANAGED_MESSAGE_PART_KIND,
        body.subarray(offset, offset + MANAGED_MESSAGE_PART_BYTES),
      ),
    );
  }
  return resources.publish(
    MANAGED_MESSAGE_CHUNKS_KIND,
    Buffer.from(JSON.stringify({ parts }), 'utf8'),
  );
}

/**
 * Reads a body published by {@link publishManagedMessageBody} through any
 * digest-verifying read: a plain resource comes back as stored, a chunk
 * manifest is reassembled from its parts in order.
 */
export async function readManagedMessageBody(
  read: (ref: ManagedSessionDurableRef) => Promise<Buffer>,
  ref: ManagedSessionDurableRef,
): Promise<Buffer> {
  if (ref.kind !== MANAGED_MESSAGE_CHUNKS_KIND) {
    return read(ref);
  }
  const { parts } = parseManagedMessageChunkManifest(await read(ref));
  // Workspace recovery uses a single-flight RPC for these reads.
  const buffers: Buffer[] = [];
  for (const part of parts) buffers.push(await read(part));
  return Buffer.concat(buffers);
}

/**
 * The parts a chunk manifest names, for transaction reference closure. Bodies
 * of any other kind reference nothing.
 */
export function managedMessageChunkParts(
  kind: string,
  body: Buffer,
): ManagedSessionDurableRef[] {
  return kind === MANAGED_MESSAGE_CHUNKS_KIND
    ? parseManagedMessageChunkManifest(body).parts
    : [];
}

function parseManagedMessageChunkManifest(bytes: Buffer): {
  parts: ManagedSessionDurableRef[];
} {
  const manifest = JSON.parse(bytes.toString('utf8')) as Record<
    string,
    unknown
  >;
  const parts = manifest['parts'];
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new ManagedSessionRecordError(
      'a Managed message chunk manifest must carry parts.',
    );
  }
  return {
    parts: parts.map((part) => {
      const ref = assertManagedSessionDurableRef(
        part as ManagedSessionJsonValue,
        'message chunk part',
      );
      if (ref.kind !== MANAGED_MESSAGE_PART_KIND) {
        throw new ManagedSessionRecordError(
          'a Managed message chunk manifest must reference message parts.',
        );
      }
      return ref;
    }),
  };
}
