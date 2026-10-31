/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { createDocxGenerator } from './generate-docx.js';

let workspace: string;
const input = {
  outputPath: 'reports/nda.docx',
  title: 'NDA 合同',
  paragraphs: ['Confidential & private <text>.', '第二段: café 😀'],
};

beforeEach(async () => {
  await mkdir(path.resolve('../../.qwen'), { recursive: true });
  workspace = await mkdtemp(path.resolve('../../.qwen/docx-test-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('DOCX generation', () => {
  it('creates OOXML preserving title, Unicode, and literal XML characters', async () => {
    const generate = await createDocxGenerator(workspace);
    const result = await generate(input);
    const bytes = await readFile(result.resolvedPath);
    expect(result.resolvedPath).toBe(
      path.join(workspace, 'reports', 'nda.docx'),
    );
    expect(result.sizeBytes).toBe(bytes.length);
    expect(result.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(XMLValidator.validate(xml)).toBe(true);
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
    const paragraphs = parsed['w:document']['w:body']['w:p'];
    expect(
      paragraphs.map((p: { 'w:r': { 'w:t': unknown } }) => {
        const text = p['w:r']['w:t'];
        return typeof text === 'object' && text !== null
          ? (text as Record<string, unknown>)['#text']
          : text;
      }),
    ).toEqual([
      'NDA 合同',
      'Confidential & private <text>.',
      '第二段: café 😀',
    ]);
    expect(await readdir(path.join(workspace, 'reports'))).toEqual([
      'nda.docx',
    ]);
  });

  it.each([
    { name: 'LF', newline: '\n' },
    { name: 'CRLF', newline: '\r\n' },
    { name: 'CR', newline: '\r' },
  ])(
    'preserves $name line breaks in titles and paragraphs',
    async ({ newline }) => {
      const generate = await createDocxGenerator(workspace);
      const result = await generate({
        ...input,
        title: `NDA${newline}合同 & <title>`,
        paragraphs: [
          `${newline}First line${newline}${newline}  第二段: café 😀 & <text>  ${newline}`,
          '',
        ],
      });
      const zip = await JSZip.loadAsync(await readFile(result.resolvedPath));
      const xml = await zip.file('word/document.xml')!.async('string');
      expect(xml.match(/<w:br\b/g) ?? []).toHaveLength(5);
      const parsed = new XMLParser({
        preserveOrder: true,
        trimValues: false,
      }).parse(xml);
      const body = parsed.find(
        (node: Record<string, unknown>) => 'w:document' in node,
      )['w:document'][0]['w:body'];
      type RunChild = {
        'w:br'?: unknown;
        'w:t'?: Array<{ '#text': string }>;
      };
      const paragraphs = body.filter(
        (node: Record<string, unknown>) => 'w:p' in node,
      );
      expect(
        paragraphs.map((paragraph: { 'w:p': Array<{ 'w:r'?: RunChild[] }> }) =>
          paragraph['w:p']
            .flatMap((node) => node['w:r'] ?? [])
            .map((node) =>
              'w:br' in node
                ? '\n'
                : (node['w:t']?.map((text) => text['#text']).join('') ?? ''),
            )
            .join(''),
        ),
      ).toEqual([
        'NDA\n合同 & <title>',
        '\nFirst line\n\n  第二段: café 😀 & <text>  \n',
        '',
      ]);
    },
  );

  it('preserves an existing destination', async () => {
    await writeFile(path.join(workspace, 'nda.docx'), 'keep me');
    const generate = await createDocxGenerator(workspace);
    await expect(
      generate({ ...input, outputPath: 'nda.docx' }),
    ).rejects.toThrow();
    expect(await readFile(path.join(workspace, 'nda.docx'), 'utf8')).toBe(
      'keep me',
    );
  });

  it('allows exactly one concurrent writer for a destination', async () => {
    const generate = await createDocxGenerator(workspace);
    const results = await Promise.allSettled([
      generate(input),
      generate(input),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(await readdir(path.join(workspace, 'reports'))).toEqual([
      'nda.docx',
    ]);
  });

  it.each([
    '../escape.docx',
    '/escape.docx',
    'C:\\escape.docx',
    'a/../escape.docx',
    'a\\escape.docx',
    'file.txt',
    'a//file.docx',
    'CON.docx',
    'reports/\u202eevil.docx',
    '&amp;.docx',
    'report onload=x.docx',
  ])(
    'rejects unsafe output path %s before creating directories',
    async (outputPath) => {
      const generate = await createDocxGenerator(workspace);
      await expect(generate({ ...input, outputPath })).rejects.toThrow();
      expect(await readdir(workspace)).toEqual([]);
    },
  );

  it('rejects a symlink parent without writing to its target', async () => {
    const outside = await mkdtemp(path.resolve('../../.qwen/docx-outside-'));
    try {
      await symlink(outside, path.join(workspace, 'reports'), 'junction');
      const generate = await createDocxGenerator(workspace);
      await expect(generate(input)).rejects.toThrow();
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('preserves the target of an existing destination symlink', async () => {
    const target = path.join(workspace, 'original.docx');
    await writeFile(target, 'original bytes');
    await symlink(target, path.join(workspace, 'linked.docx'));
    const generate = await createDocxGenerator(workspace);
    await expect(
      generate({ ...input, outputPath: 'linked.docx' }),
    ).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('original bytes');
    expect((await readdir(workspace)).sort()).toEqual([
      'linked.docx',
      'original.docx',
    ]);
  });

  it.each([
    { name: 'empty title', patch: { title: '' } },
    { name: 'long title', patch: { title: 'x'.repeat(201) } },
    { name: 'empty paragraphs', patch: { paragraphs: [] } },
    {
      name: 'too many paragraphs',
      patch: { paragraphs: Array.from({ length: 1001 }, () => 'paragraph') },
    },
    {
      name: 'XML control character',
      patch: { paragraphs: ['invalid\u0000text'] },
    },
    {
      name: 'unpaired surrogate',
      patch: { paragraphs: ['invalid\ud800text'] },
    },
    { name: 'oversized text', patch: { paragraphs: ['x'.repeat(1_048_577)] } },
    { name: 'workspace override', patch: { workspace: '/another-workspace' } },
  ])('rejects $name without creating files', async ({ patch }) => {
    const generate = await createDocxGenerator(workspace);
    await expect(generate({ ...input, ...patch })).rejects.toThrow();
    expect(await readdir(workspace)).toEqual([]);
  });

  it('does not write after cancellation before generation', async () => {
    const generate = await createDocxGenerator(workspace);
    const controller = new AbortController();
    controller.abort();
    await expect(generate(input, controller.signal)).rejects.toThrow();
    expect(await readdir(workspace)).toEqual([]);
  });

  it('does not publish a document cancelled while rendering', async () => {
    const generate = await createDocxGenerator(workspace);
    const controller = new AbortController();
    const pending = generate(
      { ...input, outputPath: 'cancelled.docx' },
      controller.signal,
    );
    setImmediate(() => controller.abort());
    await expect(pending).rejects.toThrow();
    expect(await readdir(workspace)).toEqual([]);
  });
});
