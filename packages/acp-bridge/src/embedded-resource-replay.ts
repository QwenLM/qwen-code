/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Buffer } from 'node:buffer';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { SessionAttachmentReference } from './sessionAttachments.js';

export const MAX_RECORDED_EMBEDDED_RESOURCES_BYTES = 256 * 1024;
export const MAX_RECORDED_EMBEDDED_RESOURCES = 256;
export const MAX_DAEMON_ATTACHMENT_REFERENCES = 256;

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

export interface ReplayableEmbeddedResourcesSnapshot {
  resources: Array<Extract<ContentBlock, { type: 'resource' }>>;
  /** True when replayable text resources were dropped by the retention bounds. */
  truncated: boolean;
}

/**
 * Selects the prompt's replayable embedded text resources for the durable
 * user record. The bounds limit retention only — they never reject the
 * prompt — so callers must surface `truncated` to keep the loss explicit.
 */
export function snapshotReplayableEmbeddedResources(
  prompt: ContentBlock[],
  nativeResourceIndexes: readonly number[] = [],
): ReplayableEmbeddedResourcesSnapshot {
  const resources: Array<Extract<ContentBlock, { type: 'resource' }>> = [];
  let retainedBytes = 0;
  let truncated = false;
  const nativeIndexes = new Set(nativeResourceIndexes);
  for (const [index, block] of prompt.entries()) {
    if (
      !block ||
      block.type !== 'resource' ||
      !block.resource ||
      // A resource without a non-empty URI can never be replayed
      // (transcript-replay.ts drops it), so it is neither retained nor charged.
      typeof block.resource.uri !== 'string' ||
      block.resource.uri.length === 0 ||
      !('text' in block.resource) ||
      typeof block.resource.text !== 'string'
    ) {
      continue;
    }
    if (nativeIndexes.has(index)) {
      continue;
    }
    if (resources.length >= MAX_RECORDED_EMBEDDED_RESOURCES) {
      truncated = true;
      continue;
    }
    const blockBytes = Buffer.byteLength(JSON.stringify(block), 'utf8');
    if (retainedBytes + blockBytes > MAX_RECORDED_EMBEDDED_RESOURCES_BYTES) {
      truncated = true;
      continue;
    }
    retainedBytes += blockBytes;
    resources.push(structuredClone(block));
  }
  return { resources, truncated };
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
      if (
        !block ||
        block.type !== 'resource' ||
        !block.resource ||
        !nativeUris.has(block.resource.uri)
      )
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
  const nativeUris = new Set(
    (references ?? [])
      .filter((reference) => reference.type === 'resource')
      .map(
        (reference) =>
          `attachment:///${encodeURIComponent(reference.attachmentId)}`,
      ),
  );
  const seenIndexes = new Set<number>();
  const indexes: number[] = [];
  for (const index of value) {
    if (
      typeof index !== 'number' ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= prompt.length ||
      seenIndexes.has(index)
    ) {
      return [];
    }
    const block = prompt[index];
    if (
      block?.type !== 'resource' ||
      !block.resource ||
      !nativeUris.has(block.resource.uri)
    ) {
      return [];
    }
    seenIndexes.add(index);
    indexes.push(index);
  }
  return indexes;
}
