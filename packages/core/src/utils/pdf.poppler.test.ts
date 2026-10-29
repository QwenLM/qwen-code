/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Config } from '../config/config.js';
import { processSingleFileContent } from './fileUtils.js';
import {
  extractPDFText,
  getPDFPageCount,
  isPdftoppmAvailable,
  isPdftotextAvailable,
  renderPDFPagesToImages,
  resetPdftoppmCache,
  resetPdftotextCache,
} from './pdf.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp) };
});

function pdfFixture(text = ''): Buffer {
  const stream = text
    ? `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`
    : '0.2 0.4 0.6 rg 10 10 100 100 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 6 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 6 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

describe('real Poppler', () => {
  let directory: string;
  let available: boolean;
  beforeEach(async () => {
    const actual =
      await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
    vi.mocked(execFile).mockReset().mockImplementation(actual.execFile);
    vi.mocked(fs.mkdtemp).mockClear();
    resetPdftoppmCache();
    resetPdftotextCache();
    directory = await fs.mkdtemp(join(tmpdir(), 'pdf-poppler-test-'));
    available = (await isPdftoppmAvailable()) && (await isPdftotextAvailable());
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('extracts actual text and renders decodable JPEG pages within the aggregate ceiling', async ({
    skip,
  }) => {
    if (!available) return skip();
    const textFile = join(directory, 'text.pdf');
    const pdf = pdfFixture('real PDF text');
    await fs.writeFile(textFile, pdf);
    const native = await processSingleFileContent(
      textFile,
      {
        getTargetDir: () => directory,
        getEffectiveInputModalities: () => ({ pdf: true }),
      } as Config,
      {
        mediaLimits: {
          maxInlineMediaBase64Bytes: 768 * 1024,
          maxMediaResultBytes: 896 * 1024,
        },
      },
    );
    expect(native.llmContent).toEqual({
      inlineData: {
        data: pdf.toString('base64'),
        mimeType: 'application/pdf',
        displayName: 'text.pdf',
      },
    });
    expect(await getPDFPageCount(textFile)).toBe(2);
    const text = await extractPDFText(textFile, { firstPage: 2, lastPage: 2 });
    expect(text.success && text.text).toContain('real PDF text');
    const scan = join(directory, 'scan.pdf');
    await fs.writeFile(scan, pdfFixture());
    const extracted = await extractPDFText(scan);
    expect(extracted.success).toBe(false);
    const render = await renderPDFPagesToImages(scan, {
      firstPage: 1,
      lastPage: 2,
      maxTotalBase64Bytes: 768 * 1024,
    });
    expect(render.success).toBe(true);
    if (!render.success) throw new Error(render.error);
    expect(render.images).toHaveLength(2);
    for (const image of render.images) {
      expect(image.mimeType).toBe('image/jpeg');
      expect(
        await sharp(Buffer.from(image.data, 'base64')).metadata(),
      ).toMatchObject({ format: 'jpeg', width: 1600, height: 1600 });
    }
    const firstPageBytes = render.images[0]!.data.length;
    const prefix = await renderPDFPagesToImages(scan, {
      firstPage: 1,
      lastPage: 2,
      maxTotalBase64Bytes: firstPageBytes,
    });
    expect(prefix).toEqual({
      success: true,
      images: [render.images[0]],
      bytesTruncated: true,
    });
    expect(
      await renderPDFPagesToImages(scan, {
        firstPage: 1,
        lastPage: 2,
        maxTotalBase64Bytes: firstPageBytes - 1,
      }),
    ).toMatchObject({ success: false, tooLarge: true });
    const renderDirectories = await Promise.all(
      vi
        .mocked(fs.mkdtemp)
        .mock.results.map(({ value }) => value as Promise<string>),
    );
    for (const path of renderDirectories.filter((path) =>
      path.includes('pdf-render-'),
    )) {
      await expect(fs.access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  for (const command of ['pdfinfo', 'pdftotext', 'pdftoppm'] as const) {
    it(`waits for real ${command} exit on cancellation and completes renderer cleanup`, async ({
      skip,
    }) => {
      if (!available || process.platform === 'win32') return skip();
      const file = join(directory, 'cancel.pdf');
      await fs.writeFile(file, pdfFixture('cancel this extraction'));
      const actual =
        await vi.importActual<typeof import('node:child_process')>(
          'node:child_process',
        );
      const controller = new AbortController();
      let child: ReturnType<typeof execFile> | undefined;
      let exited = false;
      let started!: () => void;
      const spawned = new Promise<void>((resolve) => {
        started = resolve;
      });
      vi.mocked(execFile).mockImplementation(
        (...args: Parameters<typeof execFile>) => {
          const process = actual.execFile(...args);
          if (args[0] === command) {
            child = process;
            process.once('spawn', () => {
              process.kill('SIGSTOP');
              started();
            });
            process.once('exit', () => {
              exited = true;
            });
          }
          return process;
        },
      );
      const operation =
        command === 'pdfinfo'
          ? getPDFPageCount(file, controller.signal)
          : command === 'pdftotext'
            ? extractPDFText(file, { signal: controller.signal })
            : renderPDFPagesToImages(file, {
                signal: controller.signal,
                maxTotalBase64Bytes: 768 * 1024,
              });
      const outcome = operation.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await spawned;
        expect(child?.exitCode).toBeNull();
        expect(child?.signalCode).toBeNull();
        controller.abort();
      } finally {
        child?.kill('SIGCONT');
        await outcome;
      }
      expect(await outcome).toMatchObject({ name: 'AbortError' });
      expect(exited).toBe(true);
      if (command === 'pdftoppm') {
        const directories = await Promise.all(
          vi
            .mocked(fs.mkdtemp)
            .mock.results.map(({ value }) => value as Promise<string>),
        );
        const renderDirectories = directories.filter((path) =>
          path.includes('pdf-render-'),
        );
        expect(renderDirectories).toHaveLength(1);
        for (const path of renderDirectories) {
          await expect(fs.access(path)).rejects.toMatchObject({
            code: 'ENOENT',
          });
        }
      }
    });
  }
});
