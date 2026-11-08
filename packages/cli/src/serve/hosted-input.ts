/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';

export const HOSTED_ATTACHMENT_INPUT_BYTES = 8 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'log',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'java',
  'sql',
  'sh',
  'bash',
  'rs',
  'go',
  'c',
  'h',
  'cpp',
  'toml',
  'ini',
  'properties',
  'svg',
]);
const TEXT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
  'application/yaml',
  'image/svg+xml',
]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseHostedInput(value: unknown): {
  text: string;
  parts: Part[];
  attachments: Part[];
} {
  if (!Array.isArray(value) || !value.length || value.length > 100)
    throw new Error('Invalid Hosted input.');
  const texts: string[] = [];
  const attachments: Part[] = [];
  for (const block of value) {
    const item = object(block);
    if (
      item?.['type'] === 'text' &&
      Object.keys(item).length === 2 &&
      typeof item['text'] === 'string' &&
      item['text'].length > 0
    ) {
      texts.push(item['text']);
      continue;
    }
    if (
      item?.['type'] === 'image' &&
      Object.keys(item).length === 3 &&
      typeof item['data'] === 'string' &&
      typeof item['mimeType'] === 'string'
    ) {
      const data = item['data'];
      const mimeType =
        item['mimeType'] === 'image/jpg' ? 'image/jpeg' : item['mimeType'];
      if (!data || data.length > HOSTED_ATTACHMENT_INPUT_BYTES)
        throw new Error('Invalid Hosted image.');
      const bytes = Buffer.from(data, 'base64');
      const valid =
        mimeType === 'image/png'
          ? bytes.length >= 8 &&
            bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : mimeType === 'image/jpeg'
            ? bytes.length >= 3 &&
              bytes[0] === 255 &&
              bytes[1] === 216 &&
              bytes[2] === 255
            : mimeType === 'image/gif'
              ? ['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6))
              : mimeType === 'image/webp' &&
                bytes.length >= 12 &&
                bytes.toString('ascii', 0, 4) === 'RIFF' &&
                bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!valid || bytes.toString('base64') !== data)
        throw new Error('Invalid Hosted image.');
      attachments.push({ inlineData: { data, mimeType } });
      continue;
    }
    const resource = object(item?.['resource']);
    if (
      item?.['type'] === 'resource' &&
      Object.keys(item).length === 2 &&
      resource &&
      Object.keys(resource).length === 3 &&
      typeof resource['uri'] === 'string' &&
      resource['uri'].startsWith('managed-input:///') &&
      typeof resource['text'] === 'string' &&
      resource['text'].length > 0 &&
      !resource['text'].includes('\0') &&
      typeof resource['mimeType'] === 'string'
    ) {
      const name = decodeURIComponent(
        resource['uri'].slice('managed-input:///'.length),
      );
      const mime = resource['mimeType'];
      if (
        !name.trim() ||
        name.length > 255 ||
        name === '.' ||
        name === '..' ||
        /[/\\\p{Cc}]/u.test(name) ||
        !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(mime) ||
        !(
          mime.startsWith('text/') ||
          TEXT_MIMES.has(mime) ||
          (mime === 'application/octet-stream' &&
            TEXT_EXTENSIONS.has(name.split('.').at(-1)!.toLowerCase()))
        )
      )
        throw new Error('Invalid Hosted text attachment.');
      attachments.push({
        text: `Attached file ${JSON.stringify(name)} (${mime}):\n<attachment>\n${resource['text']}\n</attachment>`,
      });
      continue;
    }
    throw new Error('Invalid Hosted input block.');
  }
  if (
    attachments.length &&
    Buffer.byteLength(JSON.stringify(value)) > HOSTED_ATTACHMENT_INPUT_BYTES
  )
    throw new Error('Hosted attachment input exceeds 8 MiB.');
  const text = texts.join('\n');
  return {
    text,
    attachments,
    parts: [...(text ? [{ text }] : []), ...attachments],
  };
}

export async function readHostedInput(
  session: ManagedSession,
  promptId: string,
  fallbackText: string,
): Promise<ReturnType<typeof parseHostedInput>> {
  const accepted = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .findLast(
      (event) =>
        event.kind === 'input.accepted' &&
        event.payload['inputId'] === promptId,
    );
  if (accepted?.payload['source'] !== 'hosted-harness')
    return {
      text: fallbackText,
      parts: [{ text: fallbackText }],
      attachments: [],
    };
  const ref = assertManagedSessionDurableRef(
    accepted.payload['contentRef'],
    'Hosted input',
  );
  if (
    ref.kind !== 'managed-input' ||
    ref.schemaVersion !== 1 ||
    ref.byteLength > HOSTED_ATTACHMENT_INPUT_BYTES
  )
    throw new Error('Invalid Hosted input reference.');
  return parseHostedInput(
    JSON.parse((await session.resources.read(ref)).toString('utf8')),
  );
}
