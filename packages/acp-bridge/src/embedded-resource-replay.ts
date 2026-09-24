/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Buffer } from 'node:buffer';
import { RequestError } from '@agentclientprotocol/sdk';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { SessionAttachmentReference } from './sessionAttachments.js';

export const MAX_RECORDED_EMBEDDED_RESOURCES_BYTES = 256 * 1024;
const MAX_DAEMON_ATTACHMENT_REFERENCES = 256;

export function readDaemonAttachmentReferences(
  value: unknown,
  maxReferences = MAX_DAEMON_ATTACHMENT_REFERENCES,
): SessionAttachmentReference[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > maxReferences
  ) {
    return undefined;
  }
  const references: SessionAttachmentReference[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return undefined;
    }
    const reference = item as Record<string, unknown>;
    if (
      (reference['type'] !== 'image' && reference['type'] !== 'resource') ||
      typeof reference['attachmentId'] !== 'string' ||
      reference['attachmentId'].length === 0 ||
      reference['attachmentId'].length > 255 ||
      typeof reference['mimeType'] !== 'string' ||
      reference['mimeType'].length === 0 ||
      reference['mimeType'].length > 128 ||
      typeof reference['size'] !== 'number' ||
      !Number.isSafeInteger(reference['size']) ||
      reference['size'] < 0 ||
      (reference['type'] === 'image' && reference['size'] === 0)
    ) {
      return undefined;
    }
    references.push({
      type: reference['type'],
      attachmentId: reference['attachmentId'],
      mimeType: reference['mimeType'],
      size: reference['size'],
    });
  }
  return references;
}

export function snapshotReplayableEmbeddedResources(
  prompt: ContentBlock[],
  nativeResourceIndexes: readonly number[] = [],
): Array<Extract<ContentBlock, { type: 'resource' }>> {
  const resources: Array<Extract<ContentBlock, { type: 'resource' }>> = [];
  let retainedBytes = 0;
  const nativeIndexes = new Set(nativeResourceIndexes);
  for (const [index, block] of prompt.entries()) {
    if (
      block.type !== 'resource' ||
      !('text' in block.resource) ||
      typeof block.resource.text !== 'string'
    ) {
      continue;
    }
    if (nativeIndexes.has(index)) {
      continue;
    }
    retainedBytes += Buffer.byteLength(JSON.stringify(block), 'utf8');
    if (retainedBytes > MAX_RECORDED_EMBEDDED_RESOURCES_BYTES) {
      throw RequestError.invalidParams(
        undefined,
        'Embedded text resources exceed the 256 KiB replay limit',
      );
    }
    resources.push(structuredClone(block));
  }
  return resources;
}

export function readDaemonNativeResourceIndexes(
  value: unknown,
  prompt: readonly ContentBlock[],
  references?: readonly SessionAttachmentReference[],
): number[] {
  if (value === undefined && references) {
    // Older daemon requests have references but no expansion positions. Only
    // exclude an unambiguous URI match; when blocks share a URI, keep both
    // rather than silently discarding a direct user resource.
    const nativeUris = new Set(
      references
        .filter((reference) => reference.type === 'resource')
        .map(
          (reference) =>
            `attachment:///${encodeURIComponent(reference.attachmentId)}`,
        ),
    );
    const matchingIndexes = new Map<string, number[]>();
    for (const [index, block] of prompt.entries()) {
      if (block.type !== 'resource' || !nativeUris.has(block.resource.uri))
        continue;
      const indexes = matchingIndexes.get(block.resource.uri) ?? [];
      indexes.push(index);
      matchingIndexes.set(block.resource.uri, indexes);
    }
    return [...matchingIndexes.values()].flatMap((indexes) =>
      indexes.length === 1 ? indexes : [],
    );
  }
  if (!Array.isArray(value) || value.length > (references?.length ?? 0)) {
    return [];
  }
  const indexes: number[] = [];
  for (const index of value) {
    if (
      typeof index !== 'number' ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= prompt.length ||
      indexes.includes(index)
    ) {
      return [];
    }
    const block = prompt[index];
    if (
      block?.type !== 'resource' ||
      !references?.some(
        (reference) =>
          reference.type === 'resource' &&
          block.resource.uri ===
            `attachment:///${encodeURIComponent(reference.attachmentId)}`,
      )
    ) {
      return [];
    }
    indexes.push(index);
  }
  return indexes;
}
