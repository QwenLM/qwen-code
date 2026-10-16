/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ManagedSessionDurableRef } from './managed-session-records.js';
import { assertManagedSessionDurableRef } from './managed-session-records.js';
import type { ManagedSessionResourceStore } from './managed-session-storage.js';
import {
  MANAGED_TOOL_RESULT_KINDS as KINDS,
  MANAGED_TOOL_RESULT_LIMITS as LIMITS,
  isToolResultPageAt,
  parseToolResultManifestBytes,
  parseToolResultPageBytes,
  parseToolResultPrefixRequest,
  parseToolResultPublishRequest,
  parseToolResultSealRequest,
  type ToolResultPrefix,
  type ToolResultSealReceipt,
  type ToolResultSegmentReceipt,
  type ToolResultStoreOutcome,
} from './managed-tool-result.js';
import type {
  ToolResultRangeRequest,
  ToolResultSegmentStore,
} from './managed-tool-result-store.js';

export interface DurableToolResultResourceStore
  extends ManagedSessionResourceStore {
  publish(
    kind: string,
    bytes: Buffer,
    resourceId?: string,
  ): Promise<ManagedSessionDurableRef>;
}

export const HOSTED_TOOL_RESULT_RESOURCE_LIMITS: Readonly<
  Record<string, number>
> = {
  [KINDS.content]: 1024 * 1024,
  [KINDS.page]: LIMITS.maxPageBytes,
  [KINDS.manifest]: LIMITS.maxManifestBytes,
};

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function id(
  captureId: string,
  streamId: string,
  ordinal: number | 'seal',
): string {
  return digest(Buffer.from(JSON.stringify([captureId, streamId, ordinal])));
}

function ref(resourceId: string, bytes: Buffer): ManagedSessionDurableRef {
  return {
    resourceId,
    kind: KINDS.content,
    schemaVersion: 1,
    byteLength: bytes.length,
    digest: digest(bytes),
  };
}

const conflict = {
  status: 'refused',
  code: 'managed_tool_result_conflict',
} as const;
const invalid = {
  status: 'refused',
  code: 'managed_tool_result_invalid',
} as const;
const corrupt = {
  status: 'refused',
  code: 'managed_tool_result_digest_mismatch',
} as const;
const ok = <T>(result: T): ToolResultStoreOutcome<T> => ({
  status: 'ok',
  result,
});

interface Stream {
  readonly receipts: ToolResultSegmentReceipt[];
  readonly hash: ReturnType<typeof createHash>;
  byteLength: number;
  sealed: boolean;
}

/** One foreground producer, in ordinal order. Active uploads are never resumed. */
export class ResourceToolResultSegmentStore implements ToolResultSegmentStore {
  private captureId: string | undefined;
  private readonly streams = new Map<string, Stream>();
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly resources: DurableToolResultResourceStore) {}

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error('Tool result store closed.'));
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private stream(captureId: string, streamId: string): Stream | undefined {
    if (
      (streamId !== 'stdout' && streamId !== 'stderr') ||
      (this.captureId !== undefined && this.captureId !== captureId)
    )
      return undefined;
    this.captureId = captureId;
    let stream = this.streams.get(streamId);
    if (!stream) {
      stream = {
        receipts: [],
        hash: createHash('sha256'),
        byteLength: 0,
        sealed: false,
      };
      this.streams.set(streamId, stream);
    }
    return stream;
  }

  publish(
    request: unknown,
  ): Promise<ToolResultStoreOutcome<ToolResultSegmentReceipt>> {
    return this.enqueue(async () => {
      let input;
      try {
        input = parseToolResultPublishRequest(request);
      } catch {
        return invalid;
      }
      if (input.bytes.byteLength > 1024 * 1024) return invalid;
      const bytes = Buffer.from(input.bytes);
      const receipt = {
        ordinal: input.ordinal,
        byteLength: bytes.length,
        digest: digest(bytes),
      };
      if (
        input.expectedDigest !== null &&
        input.expectedDigest !== receipt.digest
      )
        return corrupt;
      const stream = this.stream(input.captureId, input.streamId);
      if (!stream) return conflict;
      const prior = stream.receipts[input.ordinal];
      if (prior)
        return JSON.stringify(prior) === JSON.stringify(receipt)
          ? ok(prior)
          : conflict;
      if (stream.sealed || input.ordinal !== stream.receipts.length)
        return conflict;
      const resourceId = id(input.captureId, input.streamId, input.ordinal);
      const published = await this.resources.publish(
        KINDS.content,
        bytes,
        resourceId,
      );
      const expected = ref(resourceId, bytes);
      if (
        Object.entries(expected).some(
          ([key, value]) =>
            published[key as keyof ManagedSessionDurableRef] !== value,
        )
      )
        throw new Error('Tool result publication receipt changed.');
      stream.receipts.push(receipt);
      stream.hash.update(bytes);
      stream.byteLength += bytes.length;
      return ok(receipt);
    });
  }

  seal(
    request: unknown,
  ): Promise<ToolResultStoreOutcome<ToolResultSealReceipt>> {
    return this.enqueue(async () => {
      let input;
      try {
        input = parseToolResultSealRequest(request);
      } catch {
        return invalid;
      }
      const stream = this.stream(input.captureId, input.streamId);
      if (!stream) return conflict;
      const receipt = this.prefixOf(stream);
      if (input.segmentCount !== receipt.segmentCount) return conflict;
      if (
        input.byteLength !== receipt.byteLength ||
        input.digest !== receipt.digest
      )
        return stream.sealed ? conflict : corrupt;
      const seal = {
        segmentCount: input.segmentCount,
        byteLength: input.byteLength,
        digest: input.digest,
      };
      const bytes = Buffer.from(JSON.stringify(seal));
      await this.resources.publish(
        KINDS.content,
        bytes,
        id(input.captureId, input.streamId, 'seal'),
      );
      stream.sealed = true;
      return ok(seal);
    });
  }

  private prefixOf(stream: Stream): ToolResultPrefix {
    return {
      segmentCount: stream.receipts.length,
      byteLength: stream.byteLength,
      digest: stream.hash.copy().digest('hex'),
      sealed: stream.sealed,
    };
  }

  prefix(request: unknown): Promise<ToolResultStoreOutcome<ToolResultPrefix>> {
    return this.enqueue(async () => {
      let input;
      try {
        input = parseToolResultPrefixRequest(request);
      } catch {
        return invalid;
      }
      const stream = this.stream(input.captureId, input.streamId);
      return stream ? ok(this.prefixOf(stream)) : conflict;
    });
  }

  private async read(
    resource: ManagedSessionDurableRef,
    kind: string,
    max: number,
  ): Promise<Buffer> {
    const validated = assertManagedSessionDurableRef(
      { ...resource },
      'tool result resource',
    );
    if (
      validated.kind !== kind ||
      validated.schemaVersion !== 1 ||
      validated.byteLength > max
    ) {
      throw new Error('Tool result resource exceeds its bound.');
    }
    const bytes = await this.resources.read(validated);
    if (
      bytes.length !== validated.byteLength ||
      digest(bytes) !== validated.digest
    )
      throw new Error('Corrupt tool result resource.');
    return bytes;
  }

  readRange(
    request: ToolResultRangeRequest,
  ): Promise<ToolResultStoreOutcome<Buffer>> {
    return this.enqueue(async () => {
      const { offset, length } = request;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > LIMITS.maxSegmentBytes
      )
        return invalid;
      const manifest = parseToolResultManifestBytes(
        await this.read(
          request.manifestRef,
          KINDS.manifest,
          LIMITS.maxManifestBytes,
        ),
      );
      for (const key of [
        'tenantId',
        'sessionId',
        'turnId',
        'executionCallId',
        'callId',
        'invocationDigest',
        'bindingGeneration',
        'captureId',
        'revision',
      ] as const) {
        if (manifest[key] !== request.expectedIdentity?.[key]) return conflict;
      }
      const index = manifest.contents.findIndex(
        (entry) => entry.streamId === request.streamId,
      );
      const entry = manifest.contents[index];
      if (
        !entry ||
        !('pages' in entry.body) ||
        offset > entry.byteLength ||
        length > entry.byteLength - offset
      )
        return invalid;
      if (entry.state === 'sealed') {
        const seal = Buffer.from(
          JSON.stringify({
            segmentCount: entry.body.pages.reduce(
              (sum, page) => sum + page.segmentCount,
              0,
            ),
            byteLength: entry.byteLength,
            digest: entry.digest,
          }),
        );
        await this.read(
          ref(id(manifest.captureId, entry.streamId, 'seal'), seal),
          KINDS.content,
          1024,
        );
      }
      const output = Buffer.alloc(length);
      for (const [pageIndex, pageRef] of entry.body.pages.entries()) {
        const page = parseToolResultPageBytes(
          await this.read(pageRef.ref, KINDS.page, LIMITS.maxPageBytes),
        );
        if (!isToolResultPageAt(manifest, index, pageIndex, page))
          return conflict;
        let position = page.offset;
        for (const [segmentIndex, segment] of page.segments.entries()) {
          const end = position + segment.byteLength;
          if (position < offset + length && end > offset) {
            const bytes = await this.read(
              {
                resourceId: id(
                  manifest.captureId,
                  entry.streamId,
                  page.firstOrdinal + segmentIndex,
                ),
                kind: KINDS.content,
                schemaVersion: 1,
                ...segment,
              },
              KINDS.content,
              1024 * 1024,
            );
            const from = Math.max(position, offset);
            const to = Math.min(end, offset + length);
            bytes.copy(output, from - offset, from - position, to - position);
          }
          position = end;
        }
      }
      return ok(output);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    this.streams.clear();
  }
}
