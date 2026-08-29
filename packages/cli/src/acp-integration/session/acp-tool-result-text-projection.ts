/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Buffer } from 'node:buffer';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { isA2uiToolMeta } from '@qwen-code/acp-bridge/bridgeClient';
import {
  JSON_STRING_DELIMITER_BYTES,
  jsonStringJsonByteLength,
  jsonStringPayloadByteLength,
  truncateJsonStringPayload,
} from '../../utils/json-string-byte-projection.js';

export const ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET = 65_536;
export const ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER =
  '\n[... truncated for ACP transport ...]\n';

interface CanonicalTextContentBlock {
  type: 'content';
  content: {
    type: 'text';
    text: string;
  };
}

const EMPTY_CONTENT_ARRAY_JSON_BYTES = Buffer.byteLength('[]', 'utf8');
const EMPTY_TEXT_BLOCK_JSON_BYTES = Buffer.byteLength(
  JSON.stringify(createTextBlock('')),
  'utf8',
);
const JSON_ARRAY_SEPARATOR_BYTES = 1;
const TRUNCATION_MARKER_PAYLOAD_BYTES =
  jsonStringJsonByteLength(ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER) -
  JSON_STRING_DELIMITER_BYTES;
const MAX_CANONICAL_TEXT_BLOCKS = Math.floor(
  (ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET -
    EMPTY_CONTENT_ARRAY_JSON_BYTES +
    JSON_ARRAY_SEPARATOR_BYTES) /
    (EMPTY_TEXT_BLOCK_JSON_BYTES + JSON_ARRAY_SEPARATOR_BYTES),
);

function createTextBlock(text: string): CanonicalTextContentBlock {
  return {
    type: 'content',
    content: { type: 'text', text },
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  first: string,
  second: string,
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    Object.hasOwn(value, first) &&
    Object.hasOwn(value, second)
  );
}

function canonicalTextBlocks(
  value: unknown,
): CanonicalTextContentBlock[] | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const block of value) {
    if (
      !isObjectRecord(block) ||
      !hasExactKeys(block, 'type', 'content') ||
      block['type'] !== 'content' ||
      !isObjectRecord(block['content']) ||
      !hasExactKeys(block['content'], 'type', 'text') ||
      block['content']['type'] !== 'text' ||
      typeof block['content']['text'] !== 'string'
    ) {
      return undefined;
    }
  }
  return value as CanonicalTextContentBlock[];
}

function contentSkeletonBytes(blockCount: number): number {
  if (blockCount === 0) return EMPTY_CONTENT_ARRAY_JSON_BYTES;
  return (
    EMPTY_CONTENT_ARRAY_JSON_BYTES +
    blockCount * EMPTY_TEXT_BLOCK_JSON_BYTES +
    (blockCount - 1) * JSON_ARRAY_SEPARATOR_BYTES
  );
}

function fallbackContent(): CanonicalTextContentBlock[] {
  return [createTextBlock(ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER)];
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function allocatePayloadBudgets(
  payloadBytes: readonly number[],
  availableBytes: number,
): number[] | undefined {
  const base = payloadBytes.map((bytes) =>
    Math.min(bytes, TRUNCATION_MARKER_PAYLOAD_BYTES),
  );
  let remaining = availableBytes - base.reduce((sum, bytes) => sum + bytes, 0);
  if (remaining < 0) return undefined;

  const capacities = payloadBytes.map((bytes, index) => ({
    index,
    capacity: bytes - base[index],
  }));
  const sorted = capacities
    .filter(({ capacity }) => capacity > 0)
    .sort((left, right) =>
      left.capacity === right.capacity
        ? left.index - right.index
        : left.capacity - right.capacity,
    );
  let active = sorted.length;
  let position = 0;
  let level = 0;
  let remainder = 0;
  while (position < sorted.length && active > 0 && remaining > 0) {
    const nextLevel = sorted[position].capacity;
    const cost = (nextLevel - level) * active;
    if (cost > remaining) {
      level += Math.floor(remaining / active);
      remainder = remaining % active;
      remaining = 0;
      break;
    }
    level = nextLevel;
    remaining -= cost;
    while (
      position < sorted.length &&
      sorted[position].capacity === nextLevel
    ) {
      position++;
      active--;
    }
  }

  const allocations = base.map(
    (bytes, index) => bytes + Math.min(capacities[index].capacity, level),
  );
  if (remainder > 0) {
    for (const { index, capacity } of capacities) {
      if (remainder === 0) break;
      if (capacity > level) {
        allocations[index]++;
        remainder--;
      }
    }
  }
  return allocations;
}

function projectContent(
  original: CanonicalTextContentBlock[],
): CanonicalTextContentBlock[] {
  if (original.length > MAX_CANONICAL_TEXT_BLOCKS) return fallbackContent();
  const skeletonBytes = contentSkeletonBytes(original.length);
  const availablePayloadBytes =
    ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET - skeletonBytes;
  let remainingPayloadBytes = availablePayloadBytes;
  let needsProjection = false;
  for (const block of original) {
    const payloadBytes = jsonStringPayloadByteLength(
      block.content.text,
      remainingPayloadBytes,
    );
    if (payloadBytes > remainingPayloadBytes) {
      needsProjection = true;
      break;
    }
    remainingPayloadBytes -= payloadBytes;
  }
  if (!needsProjection) return original;

  const baseScans = original.map((block) =>
    jsonStringPayloadByteLength(
      block.content.text,
      TRUNCATION_MARKER_PAYLOAD_BYTES,
    ),
  );
  const basePayloadBytes = baseScans.map((bytes) =>
    Math.min(bytes, TRUNCATION_MARKER_PAYLOAD_BYTES),
  );
  const baseTotal = basePayloadBytes.reduce((sum, bytes) => sum + bytes, 0);
  if (baseTotal > availablePayloadBytes) return fallbackContent();

  const payloadBytes = original.map((block, index) => {
    if (baseScans[index] <= TRUNCATION_MARKER_PAYLOAD_BYTES) {
      return baseScans[index];
    }
    const maximumAllocation =
      availablePayloadBytes - baseTotal + basePayloadBytes[index];
    const bytes = jsonStringPayloadByteLength(
      block.content.text,
      maximumAllocation,
    );
    // Other blocks always retain their base, so this block cannot receive
    // more than maximumAllocation. One extra byte is enough to mean truncated.
    return bytes <= maximumAllocation ? bytes : maximumAllocation + 1;
  });

  const allocations = allocatePayloadBudgets(
    payloadBytes,
    availablePayloadBytes,
  );
  if (!allocations) return fallbackContent();

  const projected = original.map((block, index) => {
    if (payloadBytes[index] <= allocations[index]) return block;
    return createTextBlock(
      truncateJsonStringPayload(
        block.content.text,
        payloadBytes[index],
        allocations[index],
        ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER,
      ),
    );
  });
  return jsonByteLength(projected) <= ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET
    ? projected
    : fallbackContent();
}

function projectRawOutput(value: string): string {
  const payloadBudget =
    ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET - JSON_STRING_DELIMITER_BYTES;
  const payloadBytes = jsonStringPayloadByteLength(value, payloadBudget);
  if (payloadBytes <= payloadBudget) return value;
  const projected = truncateJsonStringPayload(
    value,
    payloadBytes,
    payloadBudget,
    ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER,
  );
  return jsonByteLength(projected) <= ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET
    ? projected
    : ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER;
}

function a2uiMeta(
  meta: Record<string, unknown> | undefined,
): { toolName?: string; serverId?: string } | undefined {
  if (!meta) return undefined;
  const toolName =
    typeof meta['toolName'] === 'string' ? meta['toolName'] : undefined;
  const serverId =
    typeof meta['serverId'] === 'string' ? meta['serverId'] : undefined;
  return toolName === undefined && serverId === undefined
    ? undefined
    : {
        ...(toolName === undefined ? {} : { toolName }),
        ...(serverId === undefined ? {} : { serverId }),
      };
}

export function projectAcpToolResultUpdate(
  update: SessionUpdate,
): SessionUpdate {
  const record = update as unknown as Record<string, unknown>;
  if (record['sessionUpdate'] !== 'tool_call_update') return update;
  const meta = isObjectRecord(record['_meta']) ? record['_meta'] : undefined;
  if (isA2uiToolMeta(a2uiMeta(meta))) return update;

  const content = canonicalTextBlocks(record['content']);
  const rawOutput = record['rawOutput'];
  if (
    content?.length === 1 &&
    typeof rawOutput === 'string' &&
    rawOutput === content[0].content.text
  ) {
    const projectedContent = projectContent(content);
    if (projectedContent === content) return update;
    const projectedText = projectedContent[0].content.text;
    return {
      ...record,
      content: projectedContent,
      rawOutput: projectedText,
    } as unknown as SessionUpdate;
  }

  const projectedContent = content ? projectContent(content) : undefined;
  const projectedRawOutput =
    typeof rawOutput === 'string' ? projectRawOutput(rawOutput) : undefined;
  const contentChanged =
    projectedContent !== undefined && projectedContent !== content;
  const rawOutputChanged =
    projectedRawOutput !== undefined && projectedRawOutput !== rawOutput;
  if (!contentChanged && !rawOutputChanged) return update;
  return {
    ...record,
    ...(contentChanged ? { content: projectedContent } : {}),
    ...(rawOutputChanged ? { rawOutput: projectedRawOutput } : {}),
  } as unknown as SessionUpdate;
}
