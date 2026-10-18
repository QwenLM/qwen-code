/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable import/no-internal-modules -- Noble exposes hashing through public subpath exports, not its root. */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
/* eslint-enable import/no-internal-modules */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const APP_URI = 'ui://generated-ui/view-v1.html';
export const META_KEY = 'qwen/generated-ui';
export const MAX_RESULT_CHARS = 24_000;
export const MAX_RESULT_BYTES = 24_000;
const NON_BLANK_TEXT = /[^\s\u200c\u200d]/u;

export const showInputSchema = z
  .object({
    title: z.string().min(1).max(120),
    summary: z.string().min(1).max(2000),
    html: z.string().min(1).max(12_000),
    css: z.string().max(6000),
    javascript: z.string().max(12_000),
  })
  .strict();

export type ShowInput = z.infer<typeof showInputSchema>;

export const documentSchema = showInputSchema.extend({
  schemaVersion: z.literal(1),
  documentId: z.string().regex(/^g1_[0-9a-f]{64}$/),
});

export type GeneratedDocument = z.infer<typeof documentSchema>;

const publicResultSchema = documentSchema.pick({
  schemaVersion: true,
  documentId: true,
  title: true,
  summary: true,
});

const resultSchema = z
  .object({
    content: z.tuple([
      z.object({ type: z.literal('text'), text: z.string() }).strict(),
    ]),
    structuredContent: publicResultSchema,
    _meta: z.object({ [META_KEY]: documentSchema }).strict(),
    isError: z.literal(false).optional(),
  })
  .strict();

export function serializeDocument(input: ShowInput): string {
  return JSON.stringify({
    schemaVersion: 1,
    title: input.title,
    summary: input.summary,
    html: input.html,
    css: input.css,
    javascript: input.javascript,
  });
}

export function hashDocument(input: ShowInput): string {
  return `g1_${bytesToHex(sha256(utf8ToBytes(serializeDocument(input))))}`;
}

function checkResultBudget(value: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('Invalid generated view result.');
  }
  if (
    serialized === undefined ||
    serialized.length > MAX_RESULT_CHARS ||
    utf8ToBytes(serialized).byteLength > MAX_RESULT_BYTES
  ) {
    throw new Error('Generated view result exceeds its 24,000-byte budget.');
  }
}

function sweep(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
    ['\n', '\t', '\u200c', '\u200d'].includes(character) ? character : '',
  );
}

function summaryText(input: ShowInput): string {
  return sweep(`${input.title}\n${input.summary}`);
}

export function createShowResult(input: unknown): CallToolResult {
  const parsed = showInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('Invalid generated view document.');
  }
  // Sanitize once so the readable fallback, structuredContent and the hashed
  // snapshot all carry the same inert title/summary.
  const data: ShowInput = {
    ...parsed.data,
    title: sweep(parsed.data.title),
    summary: sweep(parsed.data.summary),
  };
  if (!NON_BLANK_TEXT.test(data.title) || !NON_BLANK_TEXT.test(data.summary)) {
    throw new Error('Invalid generated view document.');
  }
  const document: GeneratedDocument = {
    schemaVersion: 1,
    documentId: hashDocument(data),
    ...data,
  };
  const result: CallToolResult = {
    content: [{ type: 'text', text: summaryText(document) }],
    structuredContent: {
      schemaVersion: document.schemaVersion,
      documentId: document.documentId,
      title: document.title,
      summary: document.summary,
    },
    _meta: { [META_KEY]: document },
  };
  checkResultBudget(result);
  return result;
}

export function parseToolResult(value: unknown): GeneratedDocument {
  checkResultBudget(value);
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Invalid or unsupported generated view result.');
  }
  const result = parsed.data;
  const document = result._meta[META_KEY];
  const summary = result.structuredContent;
  if (
    hashDocument(document) !== document.documentId ||
    summary.documentId !== document.documentId ||
    summary.title !== document.title ||
    summary.summary !== document.summary ||
    !NON_BLANK_TEXT.test(document.title) ||
    !NON_BLANK_TEXT.test(document.summary) ||
    sweep(document.title) !== document.title ||
    sweep(document.summary) !== document.summary ||
    result.content[0].text !== summaryText(document)
  ) {
    throw new Error('Generated view snapshot does not match its identity.');
  }
  return document;
}
