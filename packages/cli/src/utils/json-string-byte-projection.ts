/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Buffer } from 'node:buffer';

export const JSON_STRING_DELIMITER_BYTES = 2;

function jsonPayloadBytesAt(value: string, index: number): number {
  const code = value.charCodeAt(index);
  if (code === 0x22 || code === 0x5c) return 2;
  if (code <= 0x1f) {
    return code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
      ? 2
      : 6;
  }
  if (code <= 0x7f) return 1;
  if (code <= 0x7ff) return 2;
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = value.charCodeAt(index + 1);
    return next >= 0xdc00 && next <= 0xdfff ? 4 : 6;
  }
  if (code >= 0xdc00 && code <= 0xdfff) return 6;
  return 3;
}

function jsonPayloadWidthAt(value: string, index: number): number {
  const code = value.charCodeAt(index);
  if (code < 0xd800 || code > 0xdbff) return 1;
  const next = value.charCodeAt(index + 1);
  return next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
}

export function jsonStringPayloadByteLength(
  value: string,
  stopAfterBytes = Number.POSITIVE_INFINITY,
): number {
  let bytes = 0;
  for (let index = 0; index < value.length; ) {
    bytes += jsonPayloadBytesAt(value, index);
    if (bytes > stopAfterBytes) return bytes;
    index += jsonPayloadWidthAt(value, index);
  }
  return bytes;
}

export function jsonStringJsonByteLength(value: string): number {
  return JSON_STRING_DELIMITER_BYTES + jsonStringPayloadByteLength(value);
}

function jsonPayloadWidthBefore(value: string, end: number): number {
  const last = value.charCodeAt(end - 1);
  if (last >= 0xdc00 && last <= 0xdfff && end >= 2) {
    const previous = value.charCodeAt(end - 2);
    if (previous >= 0xd800 && previous <= 0xdbff) return 2;
  }
  return 1;
}

function selectPrefix(value: string, budget: number): number {
  let end = 0;
  let bytes = 0;
  while (end < value.length) {
    const partBytes = jsonPayloadBytesAt(value, end);
    if (bytes + partBytes > budget) break;
    bytes += partBytes;
    end += jsonPayloadWidthAt(value, end);
  }
  return end;
}

function selectSuffix(value: string, budget: number): number {
  let start = value.length;
  let bytes = 0;
  while (start > 0) {
    const partWidth = jsonPayloadWidthBefore(value, start);
    const partBytes = jsonPayloadBytesAt(value, start - partWidth);
    if (bytes + partBytes > budget) break;
    bytes += partBytes;
    start -= partWidth;
  }
  return start;
}

function copyString(value: string): string {
  return value.split('').join('');
}

export function truncateJsonStringPayload(
  value: string,
  originalPayloadBytes: number,
  payloadBudget: number,
  marker: string,
): string {
  if (originalPayloadBytes <= payloadBudget) return value;
  const markerPayloadBytes = jsonStringPayloadByteLength(marker);
  if (payloadBudget < markerPayloadBytes) {
    return copyString(value.slice(0, selectPrefix(value, payloadBudget)));
  }
  const sourceBudget = payloadBudget - markerPayloadBytes;
  const headBudget = Math.floor(sourceBudget * 0.2);
  const tailBudget = sourceBudget - headBudget;
  const headEnd = selectPrefix(value, headBudget);
  const tailStart = selectSuffix(value, tailBudget);
  return (
    copyString(value.slice(0, headEnd)) +
    marker +
    copyString(value.slice(tailStart))
  );
}

export function projectJsonStringToByteBudget(
  value: string,
  jsonByteBudget: number,
  marker: string,
): string {
  const payloadBudget = Math.max(
    0,
    jsonByteBudget - JSON_STRING_DELIMITER_BYTES,
  );
  const payloadBytes = jsonStringPayloadByteLength(value, payloadBudget);
  if (payloadBytes <= payloadBudget) return value;

  const projected = truncateJsonStringPayload(
    value,
    payloadBytes,
    payloadBudget,
    marker,
  );
  if (Buffer.byteLength(JSON.stringify(projected), 'utf8') <= jsonByteBudget) {
    return projected;
  }

  const fallback = copyString(
    marker.slice(0, selectPrefix(marker, payloadBudget)),
  );
  return Buffer.byteLength(JSON.stringify(fallback), 'utf8') <= jsonByteBudget
    ? fallback
    : '';
}
