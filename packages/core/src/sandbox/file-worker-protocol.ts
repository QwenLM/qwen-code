/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import {
  isSandboxFileVersion,
  type SandboxFileVersion,
} from './file-version.js';

export const MAX_FILE_HEADER_BYTES = 16 * 1024;

export interface SandboxWriteRequest {
  operation: 'write';
  destination: string;
  content: Buffer;
  expected: SandboxFileVersion | null;
}

export function encodeSandboxWriteRequest(
  request: SandboxWriteRequest,
): Buffer {
  const header = Buffer.from(
    JSON.stringify({
      operation: request.operation,
      destination: request.destination,
      expected: request.expected,
    }) + '\n',
  );
  if (header.length > MAX_FILE_HEADER_BYTES)
    throw new Error('File worker header exceeds 16 KiB.');
  return Buffer.concat([header, request.content]);
}

export async function readSandboxWriteRequest(
  input: AsyncIterable<Uint8Array>,
): Promise<SandboxWriteRequest> {
  const chunks: Buffer[] = [];
  let headerBytes = 0;
  let headerEnd = -1;
  for await (const value of input) {
    const chunk = Buffer.from(value);
    if (headerEnd === -1) {
      const newline = chunk.indexOf(10);
      if (newline !== -1) headerEnd = headerBytes + newline;
      headerBytes += newline === -1 ? chunk.length : newline + 1;
      if (headerBytes > MAX_FILE_HEADER_BYTES)
        throw new Error('File worker header exceeds 16 KiB.');
    }
    chunks.push(chunk);
  }
  if (headerEnd === -1) throw new Error('Missing file worker header.');
  const wire = Buffer.concat(chunks);
  const header: unknown = JSON.parse(
    wire.subarray(0, headerEnd).toString('utf8'),
  );
  if (!header || typeof header !== 'object')
    throw new Error('Invalid write request.');
  const record = header as Record<string, unknown>;
  if (
    record['operation'] !== 'write' ||
    typeof record['destination'] !== 'string' ||
    !path.isAbsolute(record['destination']) ||
    !(record['expected'] === null || isSandboxFileVersion(record['expected']))
  )
    throw new Error('Invalid write request.');
  return {
    operation: 'write',
    destination: record['destination'],
    expected: record['expected'],
    content: wire.subarray(headerEnd + 1),
  };
}
