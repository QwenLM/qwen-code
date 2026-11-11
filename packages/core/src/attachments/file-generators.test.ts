/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createToolFileStateCache,
  isFullFileRead,
} from '../utils/fileStateCache.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseAtMentionedPaths,
  processAtMentionedFiles,
  generateFileAttachment,
  getChangedFiles,
} from './generators/file-generators.js';
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../utils/fileStateCache.js';
import {
  MAX_OUTPUT_SIZE,
  DEFAULT_MAX_LINES_TEXT_FILE,
  IMAGE_TARGET_RAW_SIZE,
  MAX_READ_TOKENS,
} from '../utils/constants.js';
import { readTextFileWithLimits } from '../tools/read-file.js';
import { createAttachmentMessage } from './factory.js';
import { normalizeAttachmentsForAPI } from './normalize.js';
import {
  CHANGED_FILE_SNIPPET_MAX_BYTES,
  CHANGED_FILES_TOTAL_MAX_BYTES,
} from './changed-file-limits.js';
import { extractPDFPages, getPDFPageCount } from '../utils/pdf.js';
import type { AttachmentToolUseContext } from './types.js';
import { createJpegBuffer, createPngBuffer } from '../test-utils/index.js';

vi.mock('../utils/pdf.js', () => ({
  getPDFPageCount: vi.fn().mockResolvedValue(null),
  extractPDFPages: vi.fn().mockResolvedValue({
    success: false,
    error: {
      reason: 'unavailable',
      message: 'pdftoppm unavailable',
    },
  }),
}));

function createCtx(cwd: string): AttachmentToolUseContext {
  return {
    fileReadState: createToolFileStateCache(),
    readFileState: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ),
    cwd,
    loadedNestedMemoryPaths: new Set(),
    sentSkillNames: new Map(),
    pendingHookOutputs: [],
    pendingHookAttachments: [],
    postCompactCandidates: null,
    announcedMcpInstructionServers: new Set(),
    announcedLazyMcpTools: new Set(),
    announcedAgentTypes: new Set(),
    seenSessionStartHookOutputs: new Set(),
  };
}

// ── parseAtMentionedPaths ──────────────────────────────────────────────────

describe('parseAtMentionedPaths()', () => {
  const cwd = '/home/user/project';

  it('parses absolute @path', () => {
    const paths = parseAtMentionedPaths('look at @/src/main.ts please', cwd);
    expect(paths).toEqual(['/src/main.ts']);
  });

  it('parses relative @./path', () => {
    const paths = parseAtMentionedPaths('check @./utils.ts', cwd);
    expect(paths).toEqual([`${cwd}/utils.ts`]);
  });

  it('parses quoted @"path with spaces"', () => {
    const paths = parseAtMentionedPaths('@"my file.ts"', cwd);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain('my file.ts');
  });

  it('returns [] when no @mentions', () => {
    const paths = parseAtMentionedPaths('fix the bug please', cwd);
    expect(paths).toEqual([]);
  });

  it('deduplicates multiple @mentions of same file', () => {
    // The function itself doesn't deduplicate — processAtMentionedFiles does
    const paths = parseAtMentionedPaths('@/src/a.ts and @/src/a.ts again', cwd);
    expect(paths).toEqual(['/src/a.ts', '/src/a.ts']);
  });

  it('parses multiple different @mentions', () => {
    const paths = parseAtMentionedPaths('@/src/a.ts and @./b.ts', cwd);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe('/src/a.ts');
    expect(paths[1]).toBe(`${cwd}/b.ts`);
  });

  it('parses bare filename with extension like @tsconfig.json', () => {
    const paths = parseAtMentionedPaths('check @tsconfig.json please', cwd);
    expect(paths).toEqual([`${cwd}/tsconfig.json`]);
  });

  it('parses bare filename with path like @src/index.ts', () => {
    const paths = parseAtMentionedPaths('look at @src/index.ts', cwd);
    expect(paths).toEqual([`${cwd}/src/index.ts`]);
  });

  it('accepts bare exact names', () => {
    expect(parseAtMentionedPaths('@Data @README @src', cwd)).toEqual([
      `${cwd}/Data`,
      `${cwd}/README`,
      `${cwd}/src`,
    ]);
  });

  it('ignores emails, embedded mentions and escaped mentions', () => {
    expect(
      parseAtMentionedPaths(
        String.raw`user@example.com x@src/a.ts \@src/a.ts`,
        cwd,
      ),
    ).toEqual([]);
  });

  it('parses ranges and punctuation without changing the path', () => {
    expect(
      parseAtMentionedPaths('查看。@src/a.ts#L2-4, @"my file.ts#L1"', cwd),
    ).toEqual([`${cwd}/src/a.ts`, `${cwd}/my file.ts`]);
    expect(parseAtMentionedPaths('@a.ts#L0 @a.ts#L4-2', cwd)).toEqual([]);
  });

  it('expands home paths without expanding named users', () => {
    expect(parseAtMentionedPaths('@~ @~/src/../a.ts @~other/a.ts', cwd)).toEqual([
      path.resolve(os.homedir()),
      path.resolve(os.homedir(), 'a.ts'),
      path.resolve(cwd, '~other/a.ts'),
    ]);
  });
});

// ── generateFileAttachment ─────────────────────────────────────────────────

describe('generateFileAttachment()', () => {
  let tempRootDir: string;
  let ctx: AttachmentToolUseContext;

  beforeEach(async () => {
    vi.mocked(getPDFPageCount).mockReset();
    vi.mocked(getPDFPageCount).mockResolvedValue(null);

    const realTmp = await fsp.realpath(os.tmpdir());
    tempRootDir = await fsp.mkdtemp(
      path.join(realTmp, 'file-attachment-root-'),
    );
    ctx = createCtx(tempRootDir);
  });

  afterEach(async () => {
    if (fs.existsSync(tempRootDir)) {
      await fsp.rm(tempRootDir, { recursive: true, force: true });
    }
  });

  it('never resolves annotations through similarly named files', async () => {
    await fsp.mkdir(path.join(tempRootDir, 'src'));
    await fsp.writeFile(
      path.join(tempRootDir, 'src', 'UserData.java'),
      'wrong',
    );
    await fsp.writeFile(
      path.join(tempRootDir, 'src', 'DataHelper.java'),
      'wrong',
    );
    expect(
      await processAtMentionedFiles('使用 @Data @Builder @Service', ctx),
    ).toEqual([]);
    await fsp.writeFile(path.join(tempRootDir, 'Data'), 'exact data');
    expect(await processAtMentionedFiles('@Data @Data', ctx)).toEqual([
      expect.objectContaining({ type: 'file', content: 'exact data' }),
    ]);
  });

  it('reads quoted filenames and bare directories as separate attachments', async () => {
    await fsp.writeFile(path.join(tempRootDir, 'a b.txt'), 'quoted content');
    await fsp.mkdir(path.join(tempRootDir, 'src'));
    await fsp.writeFile(path.join(tempRootDir, 'src', 'index.ts'), 'source');
    expect(await processAtMentionedFiles('@"a b.txt" @src', ctx)).toEqual([
      expect.objectContaining({ type: 'file', content: 'quoted content' }),
      expect.objectContaining({
        type: 'directory',
        content: expect.stringContaining('index.ts'),
      }),
    ]);
  });

  it('preserves other files when a PDF read throws', async () => {
    await fsp.writeFile(path.join(tempRootDir, 'first.txt'), 'first');
    await fsp.writeFile(path.join(tempRootDir, 'broken.pdf'), '%PDF');
    await fsp.writeFile(path.join(tempRootDir, 'last.txt'), 'last');
    vi.mocked(extractPDFPages).mockRejectedValueOnce(
      new Error('PDF read failed'),
    );
    expect(
      await processAtMentionedFiles('@first.txt @broken.pdf @last.txt', ctx),
    ).toEqual([
      expect.objectContaining({ type: 'file', content: 'first' }),
      expect.objectContaining({ type: 'file', content: 'last' }),
    ]);
  });

  it('preserves registered agent precedence and allows explicit file paths', async () => {
    await fsp.writeFile(path.join(tempRootDir, 'reviewer'), 'file content');
    const agents = new Set(['reviewer']);
    expect(await processAtMentionedFiles('@reviewer', ctx, agents)).toEqual([]);
    expect(await processAtMentionedFiles('@./reviewer', ctx, agents)).toEqual([
      expect.objectContaining({ type: 'file', content: 'file content' }),
    ]);
  });

  it('honors Read deny rules for bare names and line ranges', async () => {
    await fsp.writeFile(path.join(tempRootDir, 'Data'), 'denied content');
    ctx.permissionPaths = {
      rules: { allow: {}, deny: { session: ['Read(Data)'] }, ask: {} },
      additionalDirectories: [],
    };
    expect(await processAtMentionedFiles('@Data @Data#L1', ctx)).toEqual([]);
    expect(ctx.fileReadState.size).toBe(0);
  });

  it('reads separate line ranges and does not cache a partial read as a full file', async () => {
    const filename = path.join(tempRootDir, 'a.ts');
    await fsp.writeFile(filename, 'one\ntwo\nthree\nfour');
    const attachments = await processAtMentionedFiles(
      '@a.ts#L2-3 @a.ts#L2-3 @a.ts#L4',
      ctx,
    );
    expect(attachments).toEqual([
      expect.objectContaining({
        type: 'file',
        content: 'two\nthree',
        offset: 2,
        limit: 2,
      }),
      expect.objectContaining({
        type: 'file',
        content: 'four',
        offset: 4,
        limit: 1,
      }),
    ]);
    expect(isFullFileRead(ctx.fileReadState.get(filename)!)).toBe(false);
    expect(await processAtMentionedFiles('@a.ts', ctx)).toEqual([
      expect.objectContaining({
        type: 'file',
        content: 'one\ntwo\nthree\nfour',
      }),
    ]);
    expect(isFullFileRead(ctx.fileReadState.get(filename)!)).toBe(true);
  });

  it('reads a normal text file', async () => {
    const filePath = path.join(tempRootDir, 'small.txt');
    await fsp.writeFile(filePath, 'hello\nworld');

    const attachment = await generateFileAttachment(
      filePath,
      'at-mention',
      ctx,
    );

    expect(attachment).toMatchObject({
      type: 'file',
      filename: filePath,
      content: 'hello\nworld',
      displayPath: 'small.txt',
    });
  });

  it.each([false, true])(
    'uses a deduplication notice only for a complete baseline (partial=%s)',
    async (partial) => {
      const filePath = path.join(tempRootDir, 'dedup.txt');
      await fsp.writeFile(filePath, 'complete');
      await generateFileAttachment(filePath, 'at-mention', ctx);
      if (partial) {
        const state = ctx.fileReadState.get(filePath)!;
        ctx.fileReadState.set(filePath, { ...state, isPartialView: true });
      }
      const next = await generateFileAttachment(filePath, 'at-mention', ctx);
      expect(next?.type).toBe(partial ? 'file' : 'already_read_file');
      expect(isFullFileRead(ctx.fileReadState.get(filePath)!)).toBe(true);
    },
  );

  it('skips non-PDF @mentions larger than the Read size limit', async () => {
    const filePath = path.join(tempRootDir, 'large.txt');
    await fsp.writeFile(filePath, Buffer.alloc(MAX_OUTPUT_SIZE + 1, 'a'));

    const attachment = await generateFileAttachment(
      filePath,
      'at-mention',
      ctx,
    );

    expect(attachment).toBeNull();
  });

  it('reads @mentioned images larger than the text Read size limit', async () => {
    const filePath = path.join(tempRootDir, 'large.png');
    const imageBuffer = await createPngBuffer(900, 900);
    expect(imageBuffer.length).toBeGreaterThan(MAX_OUTPUT_SIZE);
    expect(imageBuffer.length).toBeLessThan(IMAGE_TARGET_RAW_SIZE);
    await fsp.writeFile(filePath, imageBuffer);

    const attachment = await generateFileAttachment(
      filePath,
      'at-mention',
      ctx,
    );

    if (attachment?.type !== 'image_file') {
      throw new Error(
        `Expected image_file attachment, got ${attachment?.type}`,
      );
    }
    expect(attachment.filename).toBe(filePath);
    expect(attachment.mediaType).toMatch(/^image\//);
    expect(attachment.originalSize).toBe(imageBuffer.length);
    expect(attachment.base64).toBe(imageBuffer.toString('base64'));
  });

  it('returns an explicit attachment when an @mentioned image is truncated', async () => {
    const filePath = path.join(tempRootDir, 'truncated.jpg');
    const completeJpeg = await createJpegBuffer(10, 10);
    await fsp.writeFile(filePath, completeJpeg.subarray(0, -2));

    const attachment = await generateFileAttachment(
      filePath,
      'at-mention',
      ctx,
    );

    expect(attachment).toMatchObject({
      type: 'invalid_image_file',
      filename: filePath,
      displayPath: 'truncated.jpg',
    });
    if (attachment?.type !== 'invalid_image_file') {
      throw new Error(`Expected invalid_image_file, got ${attachment?.type}`);
    }
    expect(attachment.reason).toContain('Invalid or unsupported image data');
  });

  it('returns a compact reference for compact-mode files over the Read size limit', async () => {
    const filePath = path.join(tempRootDir, 'large.log');
    await fsp.writeFile(filePath, Buffer.alloc(MAX_OUTPUT_SIZE + 1, 'a'));

    const attachment = await generateFileAttachment(filePath, 'compact', ctx);

    expect(attachment).toEqual({
      type: 'compact_file_reference',
      filename: filePath,
      displayPath: 'large.log',
    });
  });

  it('falls back to the first 2000 lines when token validation overflows', async () => {
    const filePath = path.join(tempRootDir, 'dense.txt');
    const lines = Array.from(
      { length: DEFAULT_MAX_LINES_TEXT_FILE + 100 },
      (_, i) => `${String(i).padStart(4, '0')} ${'a'.repeat(43)}`,
    );
    await fsp.writeFile(filePath, lines.join('\n'));

    const attachment = await generateFileAttachment(
      filePath,
      'at-mention',
      ctx,
    );

    expect(attachment).toMatchObject({
      type: 'file',
      filename: filePath,
      content: lines.slice(0, DEFAULT_MAX_LINES_TEXT_FILE).join('\n'),
      truncated: true,
      displayPath: 'dense.txt',
    });
    expect(ctx.fileReadState.get(filePath)?.isPartialView).toBe(true);
    expect(isFullFileRead(ctx.fileReadState.get(filePath)!)).toBe(false);
    expect(ctx.readFileState.get(filePath)?.isPartialView).toBe(true);
  });

  it('uses a PDF reference only when the PDF exceeds the inline page threshold', async () => {
    const filePath = path.join(tempRootDir, 'large.pdf');
    await fsp.writeFile(filePath, Buffer.from('%PDF-1.4'));
    vi.mocked(getPDFPageCount).mockResolvedValueOnce(11);

    const attachment = await generateFileAttachment(
      filePath,
      'at-mention',
      ctx,
    );

    expect(attachment).toMatchObject({
      type: 'pdf_reference',
      filename: filePath,
      pageCount: 11,
      fileSize: 8,
      displayPath: 'large.pdf',
    });
  });
});

// ── getChangedFiles ────────────────────────────────────────────────────────

describe('getChangedFiles()', () => {
  let ctx: AttachmentToolUseContext;

  beforeEach(() => {
    ctx = createCtx('/project');
  });

  it('returns [] when readFileState is empty', async () => {
    const results = await getChangedFiles(ctx);
    expect(results).toEqual([]);
  });

  it('skips files with offset (paginated reads)', async () => {
    ctx.readFileState.set('/project/file.ts', {
      content: 'old content',
      timestamp: 0, // very old timestamp — would normally trigger change
      offset: 10,
      limit: undefined,
    });
    const results = await getChangedFiles(ctx);
    expect(results).toEqual([]);
  });

  it('skips files with limit (paginated reads)', async () => {
    ctx.readFileState.set('/project/file.ts', {
      content: 'old content',
      timestamp: 0,
      offset: undefined,
      limit: 50,
    });
    const results = await getChangedFiles(ctx);
    expect(results).toEqual([]);
  });

  it('removes deleted files from cache', async () => {
    // File that doesn't exist on disk
    ctx.readFileState.set('/project/nonexistent.ts', {
      content: 'content',
      timestamp: 0,
      offset: undefined,
      limit: undefined,
    });
    await getChangedFiles(ctx);
    expect(ctx.readFileState.has('/project/nonexistent.ts')).toBe(false);
  });
});

describe('changed-file limits with real files', () => {
  let dir: string;
  let ctx: AttachmentToolUseContext;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'changed-file-limits-'));
    ctx = createCtx(dir);
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  async function growEmptyMention(name: string, content: string) {
    const filename = path.join(dir, name);
    await fsp.writeFile(filename, '');
    await processAtMentionedFiles(`@"${filename}"`, ctx);
    expect(ctx.readFileState.get(filename)?.content).toBe('');
    await fsp.writeFile(filename, content);
    // Avoid depending on filesystem timestamp granularity or wall-clock sleeps.
    await fsp.utimes(filename, new Date(), new Date(Date.now() + 10_000));
    return filename;
  }

  it('bounds empty-to-large Unicode changes and sends the truncation notice to the model', async () => {
    const content = '中文😀'.repeat(3000);
    const filename = await growEmptyMention('unicode.txt', content);
    const [attachment] = await getChangedFiles(ctx);
    expect(attachment.type).toBe('edited_text_file');
    if (attachment.type !== 'edited_text_file')
      throw new Error('expected text');
    expect(Buffer.byteLength(attachment.snippet)).toBeLessThanOrEqual(
      CHANGED_FILE_SNIPPET_MAX_BYTES,
    );
    expect(attachment.snippet).not.toContain('\uFFFD');
    expect(attachment.truncationReason).toBe('file');
    // Exercise transcript serialization and the actual provider normalization,
    // so retained full content cannot accidentally leak into the model input.
    const visible = JSON.stringify(
      normalizeAttachmentsForAPI(
        JSON.parse(JSON.stringify([createAttachmentMessage(attachment)])),
      ),
    );
    expect(visible).toContain('truncated');
    expect(visible).toContain('Use Read with offset and limit');
    expect(visible).not.toContain(content);
    expect(ctx.fileReadState.get(filename)?.contentNotInModelContext).toBe(
      true,
    );
    expect(await getChangedFiles(ctx)).toEqual([]);

    const restored = createCtx(dir);
    attachment.restoreAttachmentContext(restored);
    expect(restored.readFileState.get(filename)?.contentNotInModelContext).toBe(
      true,
    );
  });

  it.each([
    ['bytes', () => 'x'.repeat(MAX_OUTPUT_SIZE + 1)],
    ['tokens', () => 'x'.repeat(MAX_READ_TOKENS * 4 + 1)],
  ])(
    'rejects empty-file growth over the %s limit and retains the prior baseline',
    async (_, makeContent) => {
      const filename = await growEmptyMention('overflow.txt', makeContent());
      await expect(
        readTextFileWithLimits(filename, 'txt', { wholeFile: true }),
      ).rejects.toThrow(/exceeds maximum/);
      const [attachment] = await getChangedFiles(ctx);
      expect(attachment).toMatchObject({
        type: 'edited_text_file',
        snippet: '',
        truncationReason: 'read_limit',
      });
      expect(JSON.stringify(attachment.toUserMessages())).toContain(
        'exceeded the Read size or token limit',
      );
      expect(ctx.readFileState.get(filename)?.content).toBe('');
      expect(ctx.fileReadState.get(filename)?.contentNotInModelContext).toBe(
        true,
      );
      expect(await getChangedFiles(ctx)).toEqual([]);
      // A later, readable version must still be detected after an overflow.
      await fsp.writeFile(filename, 'small again');
      await fsp.utimes(filename, new Date(), new Date(Date.now() + 20_000));
      expect(await getChangedFiles(ctx)).toMatchObject([
        { snippet: 'small again' },
      ]);
    },
  );

  it('enforces a hard cumulative budget and resets it on the next detection pass', async () => {
    for (let i = 0; i < 4; i++)
      await growEmptyMention(`${i}.txt`, 'x'.repeat(20_000));
    const attachments = await getChangedFiles(ctx);
    const texts = attachments.filter((a) => a.type === 'edited_text_file');
    expect(texts).toHaveLength(4);
    expect(
      texts.reduce((sum, a) => sum + Buffer.byteLength(a.snippet), 0),
    ).toBeLessThanOrEqual(CHANGED_FILES_TOTAL_MAX_BYTES);
    expect(
      texts.some((a) => a.snippet === '' && a.truncationReason === 'budget'),
    ).toBe(true);
    expect(
      texts.some((a) =>
        JSON.stringify(a.toUserMessages()).includes(
          'total changed-file injection budget',
        ),
      ),
    ).toBe(true);
    const filename = await growEmptyMention('next.txt', 'next change');
    expect(await getChangedFiles(ctx)).toMatchObject([
      { filename, snippet: 'next change' },
    ]);
  });

  it('keeps ordinary changes complete and suppresses mtime-only touches', async () => {
    const filename = await growEmptyMention('small.txt', 'hello\nworld');
    expect(await getChangedFiles(ctx)).toMatchObject([
      { snippet: 'hello\nworld' },
    ]);
    await fsp.utimes(filename, new Date(), new Date(Date.now() + 20_000));
    expect(await getChangedFiles(ctx)).toEqual([]);
  });

  it('reads a complete diff baseline beyond the default Read page length', async () => {
    const content = 'line\n'.repeat(DEFAULT_MAX_LINES_TEXT_FILE + 10);
    await growEmptyMention('many-lines.txt', content);
    const [attachment] = await getChangedFiles(ctx);
    expect(attachment).toMatchObject({ content, truncationReason: 'file' });
  });
});
