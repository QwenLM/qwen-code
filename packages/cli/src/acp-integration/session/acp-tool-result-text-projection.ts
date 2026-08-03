/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Buffer } from 'node:buffer';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { isA2uiToolMeta } from '@qwen-code/acp-bridge/bridgeClient';

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
const JSON_STRING_DELIMITER_BYTES = 2;
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

function jsonPayloadBytesAt(
  value: string,
  index: number,
): { bytes: number; width: number } {
  const code = value.charCodeAt(index);
  if (code === 0x22 || code === 0x5c) return { bytes: 2, width: 1 };
  if (code <= 0x1f) {
    return {
      bytes:
        code === 0x08 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0c ||
        code === 0x0d
          ? 2
          : 6,
      width: 1,
    };
  }
  if (code <= 0x7f) return { bytes: 1, width: 1 };
  if (code <= 0x7ff) return { bytes: 2, width: 1 };
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = value.charCodeAt(index + 1);
    return next >= 0xdc00 && next <= 0xdfff
      ? { bytes: 4, width: 2 }
      : { bytes: 6, width: 1 };
  }
  if (code >= 0xdc00 && code <= 0xdfff) {
    return { bytes: 6, width: 1 };
  }
  return { bytes: 3, width: 1 };
}

export function jsonStringJsonByteLength(value: string): number {
  let bytes = JSON_STRING_DELIMITER_BYTES;
  for (let index = 0; index < value.length; ) {
    const part = jsonPayloadBytesAt(value, index);
    bytes += part.bytes;
    index += part.width;
  }
  return bytes;
}

function jsonPayloadBytesBefore(
  value: string,
  end: number,
): { bytes: number; width: number } {
  const last = value.charCodeAt(end - 1);
  if (last >= 0xdc00 && last <= 0xdfff && end >= 2) {
    const previous = value.charCodeAt(end - 2);
    if (previous >= 0xd800 && previous <= 0xdbff) {
      return { bytes: 4, width: 2 };
    }
  }
  return jsonPayloadBytesAt(value, end - 1);
}

function selectPrefix(value: string, budget: number): number {
  let end = 0;
  let bytes = 0;
  while (end < value.length) {
    const part = jsonPayloadBytesAt(value, end);
    if (bytes + part.bytes > budget) break;
    bytes += part.bytes;
    end += part.width;
  }
  return end;
}

function selectSuffix(value: string, budget: number): number {
  let start = value.length;
  let bytes = 0;
  while (start > 0) {
    const part = jsonPayloadBytesBefore(value, start);
    if (bytes + part.bytes > budget) break;
    bytes += part.bytes;
    start -= part.width;
  }
  return start;
}

function copyString(value: string): string {
  return value.split('').join('');
}

function truncateStringPayload(
  value: string,
  originalPayloadBytes: number,
  payloadBudget: number,
): string {
  if (originalPayloadBytes <= payloadBudget) return value;
  if (payloadBudget < TRUNCATION_MARKER_PAYLOAD_BYTES) {
    return ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER;
  }
  const sourceBudget = payloadBudget - TRUNCATION_MARKER_PAYLOAD_BYTES;
  const headBudget = Math.floor(sourceBudget * 0.2);
  const tailBudget = sourceBudget - headBudget;
  const headEnd = selectPrefix(value, headBudget);
  const tailStart = selectSuffix(value, tailBudget);
  return (
    copyString(value.slice(0, headEnd)) +
    ACP_TOOL_RESULT_TEXT_TRUNCATION_MARKER +
    copyString(value.slice(tailStart))
  );
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
  const payloadBytes = original.map(
    (block) =>
      jsonStringJsonByteLength(block.content.text) -
      JSON_STRING_DELIMITER_BYTES,
  );
  const totalPayloadBytes = payloadBytes.reduce((sum, bytes) => sum + bytes, 0);
  if (
    skeletonBytes + totalPayloadBytes <=
    ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET
  ) {
    return original;
  }

  const allocations = allocatePayloadBudgets(
    payloadBytes,
    ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET - skeletonBytes,
  );
  if (!allocations) return fallbackContent();

  const projected = original.map((block, index) => {
    if (payloadBytes[index] <= allocations[index]) return block;
    return createTextBlock(
      truncateStringPayload(
        block.content.text,
        payloadBytes[index],
        allocations[index],
      ),
    );
  });
  return jsonByteLength(projected) <= ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET
    ? projected
    : fallbackContent();
}

function projectRawOutput(value: string): string {
  const jsonBytes = jsonStringJsonByteLength(value);
  if (jsonBytes <= ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET) return value;
  const projected = truncateStringPayload(
    value,
    jsonBytes - JSON_STRING_DELIMITER_BYTES,
    ACP_TOOL_RESULT_TEXT_JSON_BYTE_BUDGET - JSON_STRING_DELIMITER_BYTES,
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
