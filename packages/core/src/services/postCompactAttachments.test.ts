import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Content } from '@google/genai';
import { extractRecentFilePaths } from './postCompactAttachments.js';

function fileReadCall(path: string): Content {
  return {
    role: 'model',
    parts: [
      {
        functionCall: {
          name: 'read_file',
          args: { file_path: path },
        },
      },
    ],
  };
}

function fileWriteCall(path: string): Content {
  return {
    role: 'model',
    parts: [
      {
        functionCall: {
          name: 'write_file',
          args: { file_path: path, content: '...' },
        },
      },
    ],
  };
}

describe('extractRecentFilePaths', () => {
  it('returns the most recently-touched file paths first', () => {
    const history: Content[] = [
      fileReadCall('/a.ts'),
      fileReadCall('/b.ts'),
      fileWriteCall('/c.ts'),
    ];
    expect(extractRecentFilePaths(history, 5)).toEqual([
      '/c.ts',
      '/b.ts',
      '/a.ts',
    ]);
  });

  it('deduplicates by file path, keeping the most recent touch', () => {
    const history: Content[] = [
      fileReadCall('/a.ts'),
      fileReadCall('/b.ts'),
      fileWriteCall('/a.ts'), // a.ts is now most recent
    ];
    expect(extractRecentFilePaths(history, 5)).toEqual(['/a.ts', '/b.ts']);
  });

  it('respects the maxFiles cap', () => {
    const history: Content[] = Array.from({ length: 10 }, (_, i) =>
      fileReadCall(`/file${i}.ts`),
    );
    expect(extractRecentFilePaths(history, 3)).toHaveLength(3);
  });

  it('returns an empty array when no file-touching tool calls exist', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi' }] },
    ];
    expect(extractRecentFilePaths(history, 5)).toEqual([]);
  });

  it('ignores tool calls without a file_path argument', () => {
    const history: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: { name: 'web_fetch', args: { url: 'https://x.com' } },
          },
        ],
      },
      fileReadCall('/real.ts'),
    ];
    expect(extractRecentFilePaths(history, 5)).toEqual(['/real.ts']);
  });

  it('recognizes edit and replace tools too', () => {
    const history: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'edit',
              args: { file_path: '/e.ts', old_string: 'x', new_string: 'y' },
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'replace', args: { file_path: '/r.ts' } } },
        ],
      },
    ];
    const paths = extractRecentFilePaths(history, 5);
    expect(paths).toContain('/e.ts');
    expect(paths).toContain('/r.ts');
  });

  it('returns empty array when maxFiles is 0 or negative', () => {
    const history: Content[] = [fileReadCall('/a.ts'), fileReadCall('/b.ts')];
    expect(extractRecentFilePaths(history, 0)).toEqual([]);
    expect(extractRecentFilePaths(history, -1)).toEqual([]);
  });
});

import { extractRecentImages } from './postCompactAttachments.js';

function modelCallScreenshot(app: string): Content {
  return {
    role: 'model',
    parts: [
      {
        functionCall: {
          name: 'computer_use__get_app_state',
          args: { app },
        },
      },
    ],
  };
}

function userToolResultWithImage(mimeType: string, data: string): Content {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          name: 'computer_use__get_app_state',
          response: { output: 'screenshot returned' },
        },
      },
      { inlineData: { mimeType, data } },
    ],
  };
}

describe('extractRecentImages', () => {
  it('returns the last N images in chronological order (oldest first)', () => {
    const history: Content[] = [
      modelCallScreenshot('Safari'),
      userToolResultWithImage('image/png', 'aaaa'),
      modelCallScreenshot('Mail'),
      userToolResultWithImage('image/png', 'bbbb'),
      modelCallScreenshot('Safari'),
      userToolResultWithImage('image/png', 'cccc'),
    ];
    const result = extractRecentImages(history, 3);
    expect(result.map((r) => r.part.inlineData?.data)).toEqual([
      'aaaa',
      'bbbb',
      'cccc',
    ]);
  });

  it('caps at maxImages by keeping the newest', () => {
    const history: Content[] = [];
    for (let i = 0; i < 5; i++) {
      history.push(modelCallScreenshot(`App${i}`));
      history.push(userToolResultWithImage('image/png', `data${i}`));
    }
    const result = extractRecentImages(history, 3);
    expect(result.map((r) => r.part.inlineData?.data)).toEqual([
      'data2',
      'data3',
      'data4',
    ]);
  });

  it('captures the preceding model functionCall as metadata', () => {
    const history: Content[] = [
      modelCallScreenshot('Safari'),
      userToolResultWithImage('image/png', 'aaaa'),
    ];
    const result = extractRecentImages(history, 3);
    expect(result).toHaveLength(1);
    expect(result[0].sourceToolName).toBe('computer_use__get_app_state');
    expect(result[0].sourceToolArgs).toEqual({ app: 'Safari' });
    expect(result[0].turnIndex).toBe(1); // user+fr is at index 1
  });

  it('also picks up images from user-paste (no preceding model+fc)', () => {
    const history: Content[] = [
      {
        role: 'user',
        parts: [
          { text: 'check this' },
          { inlineData: { mimeType: 'image/png', data: 'pastedimage' } },
        ],
      },
    ];
    const result = extractRecentImages(history, 3);
    expect(result).toHaveLength(1);
    expect(result[0].sourceToolName).toBeUndefined();
    expect(result[0].part.inlineData?.data).toBe('pastedimage');
  });

  it('ignores non-image inlineData', () => {
    const history: Content[] = [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'application/pdf', data: 'pdfdata' } },
        ],
      },
    ];
    expect(extractRecentImages(history, 3)).toEqual([]);
  });
});

import { readFileSizeAdaptive } from './postCompactAttachments.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('readFileSizeAdaptive', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pca-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns kind=embed with full content when file is under the size cap', async () => {
    const path = join(tmpDir, 'small.txt');
    writeFileSync(path, 'hello world', 'utf-8');
    const result = await readFileSizeAdaptive(path, 5_000);
    expect(result.kind).toBe('embed');
    if (result.kind === 'embed') {
      expect(result.content).toBe('hello world');
    }
  });

  it('returns kind=reference when file exceeds the size cap', async () => {
    const path = join(tmpDir, 'big.txt');
    // 5000 tokens × 4 chars = 20000 chars cap; write 30000 chars to exceed
    writeFileSync(path, 'x'.repeat(30_000), 'utf-8');
    const result = await readFileSizeAdaptive(path, 5_000);
    expect(result.kind).toBe('reference');
  });

  it('returns kind=missing when the file does not exist', async () => {
    const path = join(tmpDir, 'nope.txt');
    const result = await readFileSizeAdaptive(path, 5_000);
    expect(result.kind).toBe('missing');
  });

  it('returns kind=binary when content has too many non-printable bytes', async () => {
    const path = join(tmpDir, 'bin.dat');
    const buf = Buffer.alloc(100);
    for (let i = 0; i < 100; i++) buf[i] = i % 32; // mostly control bytes
    writeFileSync(path, buf);
    const result = await readFileSizeAdaptive(path, 5_000);
    expect(result.kind).toBe('binary');
  });

  it('counts CHARACTERS not BYTES for the size cap (UTF-8 multibyte safe)', async () => {
    const path = join(tmpDir, 'cjk.txt');
    // 10000 Chinese characters = ~30000 bytes (3 bytes each) but only
    // 10000 chars. With maxTokens=5000 (20000 char cap), this should
    // embed cleanly. If the implementation counted bytes, it would
    // wrongly classify as 'reference'.
    const cjkText = '中'.repeat(10_000);
    writeFileSync(path, cjkText, 'utf-8');
    const result = await readFileSizeAdaptive(path, 5_000);
    expect(result.kind).toBe('embed');
    if (result.kind === 'embed') {
      expect(result.content).toBe(cjkText);
      expect(result.content.length).toBe(10_000);
    }
  });
});

import { buildFileRestorationBlocks } from './postCompactAttachments.js';

describe('buildFileRestorationBlocks', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pca-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces an empty array when no files are provided', async () => {
    const blocks = await buildFileRestorationBlocks([]);
    expect(blocks).toEqual([]);
  });

  it('produces a single user message listing references for all large files', async () => {
    const big1 = join(tmpDir, 'big1.txt');
    const big2 = join(tmpDir, 'big2.txt');
    writeFileSync(big1, 'x'.repeat(30_000));
    writeFileSync(big2, 'y'.repeat(30_000));

    const blocks = await buildFileRestorationBlocks([big1, big2]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].role).toBe('user');
    const text = (blocks[0].parts?.[0] as { text?: string }).text ?? '';
    expect(text).toContain(big1);
    expect(text).toContain(big2);
    expect(text).toContain('reference only');
    // Must instruct the model on how to view the actual content.
    expect(text).toMatch(/use.*read_file|call.*read_file/i);
  });

  it('produces one extra user message per embedded small file with its full content', async () => {
    const small = join(tmpDir, 'small.txt');
    writeFileSync(small, 'console.log("hi");');

    const blocks = await buildFileRestorationBlocks([small]);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const embedBlock = blocks.find((b) =>
      (b.parts?.[0] as { text?: string }).text?.includes('console.log("hi")'),
    );
    expect(embedBlock).toBeDefined();
    expect(embedBlock?.role).toBe('user');
  });

  it('omits the reference block entirely when no large files are present', async () => {
    const small = join(tmpDir, 'small.txt');
    writeFileSync(small, 'tiny');

    const blocks = await buildFileRestorationBlocks([small]);
    const allText = blocks
      .flatMap((b) => b.parts ?? [])
      .map((p) => (p as { text?: string }).text ?? '')
      .join('\n');
    expect(allText).not.toMatch(/reference only/i);
  });

  it('skips missing files silently', async () => {
    const blocks = await buildFileRestorationBlocks([
      join(tmpDir, 'does-not-exist.txt'),
    ]);
    expect(blocks).toEqual([]);
  });

  it('respects POST_COMPACT_TOKEN_BUDGET across embedded files', async () => {
    // POST_COMPACT_TOKEN_BUDGET (50_000) * CHARS_PER_TOKEN (4) = 200_000
    // char global budget. POST_COMPACT_MAX_TOKENS_PER_FILE (5_000) *
    // CHARS_PER_TOKEN (4) = 20_000 char per-file cap.
    //
    // Create 11 files at exactly the per-file cap (20_000 chars each).
    // Total embeddable content = 220_000 chars; budget fits exactly 10
    // (200_000 chars). The 11th must downgrade from embed to reference.
    const files: string[] = [];
    for (let i = 0; i < 11; i++) {
      const p = join(tmpDir, `f${i}.txt`);
      writeFileSync(
        p,
        String.fromCharCode('a'.charCodeAt(0) + i).repeat(20_000),
      );
      files.push(p);
    }

    const blocks = await buildFileRestorationBlocks(files);

    // The reference block must exist and must mention the 11th file.
    const referenceBlock = blocks.find((b) =>
      (b.parts?.[0] as { text?: string }).text?.includes('reference only'),
    );
    expect(referenceBlock).toBeDefined();
    expect((referenceBlock!.parts?.[0] as { text: string }).text).toContain(
      files[10],
    );

    // The first 10 files must be embedded (each as its own user message).
    for (let i = 0; i < 10; i++) {
      const ch = String.fromCharCode('a'.charCodeAt(0) + i);
      const expectedSlice = ch.repeat(20_000);
      const embedBlock = blocks.find((b) =>
        (b.parts?.[0] as { text?: string }).text?.includes(expectedSlice),
      );
      expect(
        embedBlock,
        `expected file ${i} (${ch.repeat(3)}...) to be embedded`,
      ).toBeDefined();
    }

    // The 11th file must NOT be embedded — it should only appear in the
    // reference block. Verify it does not show up in any embed block.
    const ch11 = String.fromCharCode('a'.charCodeAt(0) + 10);
    const embed11 = blocks.find((b) => {
      const text = (b.parts?.[0] as { text?: string }).text ?? '';
      // The reference block contains the path, not the content. An embed
      // block would contain a long run of the file's content characters.
      return text.includes(ch11.repeat(20_000));
    });
    expect(embed11).toBeUndefined();
  });
});

import {
  buildImageRestorationBlock,
  type ExtractedImage,
} from './postCompactAttachments.js';

describe('buildImageRestorationBlock', () => {
  it('returns null when no images are provided', () => {
    expect(buildImageRestorationBlock([])).toBeNull();
  });

  it('emits a single user Content with metadata header + image parts', () => {
    const images: ExtractedImage[] = [
      {
        part: { inlineData: { mimeType: 'image/png', data: 'aaaa' } },
        turnIndex: 5,
        sourceToolName: 'computer_use__get_app_state',
        sourceToolArgs: { app: 'Safari' },
      },
      {
        part: { inlineData: { mimeType: 'image/png', data: 'bbbb' } },
        turnIndex: 11,
        sourceToolName: 'computer_use__get_app_state',
        sourceToolArgs: { app: 'Mail' },
      },
    ];
    const block = buildImageRestorationBlock(images);
    expect(block).not.toBeNull();
    expect(block!.role).toBe('user');
    expect(block!.parts).toHaveLength(3); // 1 text header + 2 images

    const header = (block!.parts![0] as { text: string }).text;
    expect(header).toContain('Recent visual snapshots');
    expect(header).toContain('turn 5');
    expect(header).toContain('computer_use__get_app_state');
    expect(header).toContain('"app":"Safari"');
    expect(header).toContain('turn 11');
    expect(header).toContain('"app":"Mail"');

    expect(block!.parts![1].inlineData?.data).toBe('aaaa');
    expect(block!.parts![2].inlineData?.data).toBe('bbbb');
  });

  it('handles images without source-tool metadata (user paste)', () => {
    const images: ExtractedImage[] = [
      {
        part: { inlineData: { mimeType: 'image/png', data: 'pasted' } },
        turnIndex: 3,
      },
    ];
    const block = buildImageRestorationBlock(images);
    const header = (block!.parts![0] as { text: string }).text;
    expect(header).toContain('turn 3');
    expect(header).toContain('user-provided'); // labeled instead of tool name
  });
});

import { composePostCompactHistory } from './postCompactAttachments.js';

describe('composePostCompactHistory', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pca-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns summary + ack only when history has no files or images', async () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
    ];
    const result = await composePostCompactHistory(history, 'SUMMARY_TEXT');
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect((result[0].parts?.[0] as { text: string }).text).toContain(
      'SUMMARY_TEXT',
    );
    expect(result[1].role).toBe('model');
  });

  it('orders sections as: summary → file refs → file embeds → images', async () => {
    const small = join(tmpDir, 'cfg.json');
    writeFileSync(small, '{"a":1}');
    const big = join(tmpDir, 'big.txt');
    writeFileSync(big, 'x'.repeat(30_000));

    const history: Content[] = [
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'read_file', args: { file_path: small } } },
        ],
      },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'read_file', args: { file_path: big } } },
        ],
      },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'computer_use__get_app_state',
              args: { app: 'Safari' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'computer_use__get_app_state',
              response: { output: 'screenshot' },
            },
          },
          { inlineData: { mimeType: 'image/png', data: 'shot' } },
        ],
      },
    ];

    const result = await composePostCompactHistory(history, 'SUM');

    // Section markers we expect, in order:
    const flatText = result
      .flatMap((c) => c.parts ?? [])
      .map((p) => (p as { text?: string }).text ?? '')
      .join('\n---\n');

    const idxSummary = flatText.indexOf('SUM');
    const idxRefs = flatText.indexOf('reference only');
    const idxEmbed = flatText.indexOf('cfg.json');
    const idxImage = flatText.indexOf('Recent visual snapshots');

    expect(idxSummary).toBeGreaterThanOrEqual(0);
    expect(idxRefs).toBeGreaterThan(idxSummary);
    expect(idxEmbed).toBeGreaterThan(idxRefs);
    expect(idxImage).toBeGreaterThan(idxEmbed);
  });

  it('includes a model ack message after the summary so role alternates correctly', async () => {
    const history: Content[] = [{ role: 'user', parts: [{ text: 'do x' }] }];
    const result = await composePostCompactHistory(history, 'SUM');
    // First two entries must be user (summary), then model (ack).
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('model');
    expect((result[1].parts?.[0] as { text: string }).text).toMatch(
      /got it|acknowledged|continue/i,
    );
  });
});
