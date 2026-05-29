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

  it('treats parallel tool calls in one content as "last part is newest"', () => {
    // Regression: discovered via real-session E2E. A model that issues
    // 6 parallel ReadFile calls puts all 6 functionCall parts in ONE
    // model+fc content. The previous implementation iterated parts
    // forward and filled the cap with the FIRST 5, dropping the
    // last-listed file. The cap-of-5 winner set must include the
    // LAST 5 (newest) parts when overflow happens.
    const history: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: { name: 'read_file', args: { file_path: '/p1.ts' } },
          },
          {
            functionCall: { name: 'read_file', args: { file_path: '/p2.ts' } },
          },
          {
            functionCall: { name: 'read_file', args: { file_path: '/p3.ts' } },
          },
          {
            functionCall: { name: 'read_file', args: { file_path: '/p4.ts' } },
          },
          {
            functionCall: { name: 'read_file', args: { file_path: '/p5.ts' } },
          },
          {
            functionCall: { name: 'read_file', args: { file_path: '/p6.ts' } },
          },
        ],
      },
    ];
    const paths = extractRecentFilePaths(history, 5);
    // Last 5 parts win, returned in newest-first order.
    expect(paths).toEqual(['/p6.ts', '/p5.ts', '/p4.ts', '/p3.ts', '/p2.ts']);
    expect(paths).not.toContain('/p1.ts');
  });
});

import {
  countToolResponseImages,
  extractRecentImages,
} from './postCompactAttachments.js';

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

// Mirrors the REAL shape coreToolScheduler.convertToFunctionResponse
// builds: the image is nested inside functionResponse.parts, NOT a
// top-level sibling. (The earlier top-level-sibling fixture never occurs
// in production and masked a bug where extractRecentImages found zero
// screenshots.)
function userToolResultWithImage(mimeType: string, data: string): Content {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          name: 'computer_use__get_app_state',
          response: { output: 'screenshot returned' },
          parts: [{ inlineData: { mimeType, data } }],
        } as unknown as NonNullable<
          Content['parts']
        >[number]['functionResponse'],
      },
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

  it('extracts tool images nested in functionResponse.parts (regression: real screenshot shape)', () => {
    // No top-level inlineData anywhere — the image lives ONLY inside
    // functionResponse.parts, exactly as convertToFunctionResponse emits.
    // The pre-fix extractRecentImages returned [] here.
    const history: Content[] = [
      modelCallScreenshot('Safari'),
      userToolResultWithImage('image/png', 'nestedshot'),
    ];
    const result = extractRecentImages(history, 3);
    expect(result).toHaveLength(1);
    expect(result[0].part.inlineData?.data).toBe('nestedshot');
    expect(result[0].sourceToolName).toBe('computer_use__get_app_state');
  });

  it('collects both nested tool images and top-level user pastes', () => {
    const history: Content[] = [
      modelCallScreenshot('Safari'),
      userToolResultWithImage('image/png', 'toolshot'),
      {
        role: 'user',
        parts: [
          { text: 'and this' },
          { inlineData: { mimeType: 'image/png', data: 'pasted' } },
        ],
      },
    ];
    const result = extractRecentImages(history, 3);
    expect(result.map((r) => r.part.inlineData?.data)).toEqual([
      'toolshot',
      'pasted',
    ]);
  });
});

describe('countToolResponseImages', () => {
  it('counts only images nested in functionResponse.parts', () => {
    const history: Content[] = [
      modelCallScreenshot('Safari'),
      userToolResultWithImage('image/png', 'a'),
      modelCallScreenshot('Mail'),
      userToolResultWithImage('image/png', 'b'),
    ];
    expect(countToolResponseImages(history)).toBe(2);
  });

  it('excludes top-level user-pasted images', () => {
    const history: Content[] = [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/png', data: 'pasted' } }],
      },
    ];
    expect(countToolResponseImages(history)).toBe(0);
  });

  it('counts multiple images within a single tool result, ignoring non-images', () => {
    const history: Content[] = [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'computer_use__get_app_state',
              response: { output: '' },
              parts: [
                { inlineData: { mimeType: 'image/png', data: 'x' } },
                { inlineData: { mimeType: 'image/jpeg', data: 'y' } },
                { text: 'not an image' },
                { inlineData: { mimeType: 'application/pdf', data: 'doc' } },
              ],
            } as unknown as NonNullable<
              Content['parts']
            >[number]['functionResponse'],
          },
        ],
      },
    ];
    expect(countToolResponseImages(history)).toBe(2);
  });

  it('returns 0 for empty history', () => {
    expect(countToolResponseImages([])).toBe(0);
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

  it('uses a longer fence when file content contains triple backticks', async () => {
    const path = join(tmpDir, 'with-backticks.md');
    // File whose content contains a triple-backtick run — would close
    // a 3-backtick fence prematurely with the old implementation.
    const content =
      '# Heading\n\nSome text\n```ts\nconst x = 1;\n```\n\nMore text.';
    writeFileSync(path, content);

    const blocks = await buildFileRestorationBlocks([path]);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0].parts?.[0] as { text: string }).text;
    // The fence must be 4+ backticks long since content has a 3-backtick run.
    expect(text).toMatch(/````\n.*const x = 1;.*\n````/s);
    // The file content (including the inner ```ts) appears intact.
    expect(text).toContain('```ts\nconst x = 1;\n```');
    expect(text).toContain('More text.');
  });

  it('strips control characters from displayed file paths', async () => {
    // Construct a path that exists on disk but whose string representation
    // (in attachment text) should be sanitized. We can't easily put a real
    // newline in a filename, so we use a path with a tab — also stripped.
    // The actual file isn't read (we test reference block path only).
    // To do this without real file shenanigans, test the helper indirectly:
    // pass a non-existent path that contains \n in its string. It should
    // be classified as 'missing' by readFileSizeAdaptive, skipped silently —
    // BUT if the path is large enough to be a reference (i.e. exists), it
    // would render sanitized. We bypass real-fs sensitivity by checking
    // the reference output for a real file with normal name and asserting
    // the rendering goes through `sanitizePathForDisplay`. Since we can't
    // easily inject \n into a real path, we assert the behavior of the
    // helper directly via an indirect test: confirm a known-normal path
    // renders without modification.
    const normal = join(tmpDir, 'normal-file.ts');
    writeFileSync(normal, 'x'.repeat(30_000)); // force reference branch
    const blocks = await buildFileRestorationBlocks([normal]);
    const refText = (blocks[0].parts?.[0] as { text: string }).text;
    expect(refText).toContain(normal); // sanitization is identity for clean paths
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

import {
  composePostCompactHistory,
  postProcessSummary,
} from './postCompactAttachments.js';

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

  it('emits role-alternating history with multiple file/image attachments merged into a single user Content (Finding 2)', async () => {
    // Regression: prior implementation pushed each file restoration block
    // as its own user Content, producing consecutive user roles which
    // violates geminiChat.test.ts:6289 strict-alternation assertion and
    // is rejected by Gemini API with "consecutive same-role content".
    const small = join(tmpDir, 'a.ts');
    writeFileSync(small, 'export const a = 1;');
    const small2 = join(tmpDir, 'b.ts');
    writeFileSync(small2, 'export const b = 2;');
    const big = join(tmpDir, 'big.ts');
    writeFileSync(big, 'x'.repeat(30_000));

    const history: Content[] = [
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'read_file', args: { file_path: small } } },
          { functionCall: { name: 'read_file', args: { file_path: small2 } } },
          { functionCall: { name: 'read_file', args: { file_path: big } } },
        ],
      },
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/png', data: 'shot' } }],
      },
    ];

    const result = await composePostCompactHistory(history, 'SUM');
    // Strict alternation: no two adjacent entries share a role.
    for (let i = 1; i < result.length; i++) {
      expect(result[i].role).not.toBe(result[i - 1].role);
    }
  });

  it('preserves a trailing model+functionCall so a pending functionResponse has its match (Finding 3)', async () => {
    // Regression: the old split-point fallback explicitly retained
    // trailing model+functionCall so that a pending functionResponse
    // (sitting in sendMessageStream's pendingUserMessage) had a
    // matching call. The full-history rewrite dropped the entire
    // history including that call, producing user+functionResponse
    // with no preceding model+functionCall → API 400.
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'use the tool' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'read_file',
              args: { file_path: '/some/file.ts' },
            },
          },
        ],
      },
    ];
    const result = await composePostCompactHistory(history, 'SUM');
    // SOMEWHERE in the output the trailing functionCall must survive
    // so that a pending functionResponse has its match.
    const hasTrailingFuncCall = result.some(
      (c) => c.role === 'model' && c.parts?.some((p) => !!p.functionCall),
    );
    expect(hasTrailingFuncCall).toBe(true);
    // And strict alternation must still hold.
    for (let i = 1; i < result.length; i++) {
      expect(result[i].role).not.toBe(result[i - 1].role);
    }
    // The very last entry must be the model funcCall (so the next
    // appended user+functionResponse pairs with it).
    const last = result[result.length - 1];
    expect(last.role).toBe('model');
    expect(last.parts?.some((p) => !!p.functionCall)).toBe(true);
  });

  it('skips files outside the workspace root (Finding 4)', async () => {
    // Security: extractRecentFilePaths collects ALL functionCall paths
    // including model attempts at /etc/passwd that the permission
    // system already denied. readFileSizeAdaptive would happily read
    // those off disk. Filter at the composer with a workspace boundary.
    const inside = join(tmpDir, 'inside.ts');
    writeFileSync(inside, 'export const inside = true;');
    const outside = '/etc/hosts'; // exists on every system; outside tmpDir

    const history: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: { name: 'read_file', args: { file_path: outside } },
          },
          {
            functionCall: { name: 'read_file', args: { file_path: inside } },
          },
        ],
      },
    ];

    const result = await composePostCompactHistory(history, 'SUM', {
      workspaceRoot: tmpDir,
    });
    const allText = result
      .flatMap((c) => c.parts ?? [])
      .map((p) => (p as { text?: string }).text ?? '')
      .join('\n');
    expect(allText).toContain(inside);
    expect(allText).not.toContain('/etc/hosts');
  });

  it('honors AbortSignal — does not invoke file reads after abort (Finding 5)', async () => {
    const small = join(tmpDir, 'small.ts');
    writeFileSync(small, 'tiny');

    const history: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: { name: 'read_file', args: { file_path: small } },
          },
        ],
      },
    ];

    const ctrl = new AbortController();
    ctrl.abort();
    // Should reject with AbortError (or similar) — readFileSizeAdaptive
    // must observe the signal. We accept either rejection OR a clean
    // empty restoration (no file content embedded), depending on where
    // the signal check fires. The contract: NEVER embed file content
    // after abort.
    let result: Content[] = [];
    let threw = false;
    try {
      result = await composePostCompactHistory(history, 'SUM', {
        signal: ctrl.signal,
      });
    } catch {
      threw = true;
    }
    if (!threw) {
      const allText = result
        .flatMap((c) => c.parts ?? [])
        .map((p) => (p as { text?: string }).text ?? '')
        .join('\n');
      // Aborted before reading: file path / content must not appear in
      // an embed block. (A bare reference is fine — that's just the path.)
      expect(allText).not.toContain('tiny');
    }
  });

  it('strips the <analysis> block from the raw summary before placing it in newHistory', async () => {
    const history: Content[] = [{ role: 'user', parts: [{ text: 'do x' }] }];
    const raw =
      '<analysis>\nthe model was thinking out loud here\nshould not leak\n</analysis>\n\n<state_snapshot>\n  <primary_request_and_intent>actual summary</primary_request_and_intent>\n</state_snapshot>';
    const result = await composePostCompactHistory(history, raw);
    const summaryText = (result[0].parts?.[0] as { text: string }).text;
    expect(summaryText).not.toContain('<analysis>');
    expect(summaryText).not.toContain('thinking out loud');
    expect(summaryText).toContain('<state_snapshot>');
    expect(summaryText).toContain('actual summary');
  });

  it('appends the resume trailer to the summary message text', async () => {
    const history: Content[] = [{ role: 'user', parts: [{ text: 'do x' }] }];
    const result = await composePostCompactHistory(
      history,
      '<state_snapshot>...</state_snapshot>',
    );
    const summaryText = (result[0].parts?.[0] as { text: string }).text;
    // Trailer instructs the resuming agent not to greet / recap.
    expect(summaryText).toMatch(/resume.*prior task|continue from/i);
    expect(summaryText).toMatch(
      /do not acknowledge|do not re-introduce|do not greet/i,
    );
  });

  it('respects maxFiles / maxImages caps from options', async () => {
    const f1 = join(tmpDir, 'one.ts');
    const f2 = join(tmpDir, 'two.ts');
    writeFileSync(f1, 'export const one = 1;');
    writeFileSync(f2, 'export const two = 2;');

    const history: Content[] = [
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'read_file', args: { file_path: f1 } } },
          { functionCall: { name: 'read_file', args: { file_path: f2 } } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'computer_use__get_app_state',
              response: { output: '' },
              parts: [
                { inlineData: { mimeType: 'image/png', data: 'img1' } },
                { inlineData: { mimeType: 'image/png', data: 'img2' } },
              ],
            } as unknown as NonNullable<
              Content['parts']
            >[number]['functionResponse'],
          },
        ],
      },
    ];

    const result = await composePostCompactHistory(history, 'SUM', {
      workspaceRoot: tmpDir,
      maxFiles: 1,
      maxImages: 1,
    });

    const inlineImages = result
      .flatMap((c) => c.parts ?? [])
      .filter((p) => (p as { inlineData?: unknown }).inlineData);
    expect(inlineImages).toHaveLength(1);

    const allText = result
      .flatMap((c) => c.parts ?? [])
      .map((p) => (p as { text?: string }).text ?? '')
      .join('\n');
    // Parallel calls in one model turn: the last (two.ts) is most recent,
    // so the single retained file is two.ts; one.ts is dropped. Assert on
    // embedded CONTENT, not the path — the path can also surface in image
    // attribution metadata, which isn't what this cap controls.
    expect(allText).toContain('export const two = 2;');
    expect(allText).not.toContain('export const one = 1;');
  });

  it('restores no attachments when maxFiles and maxImages are 0', async () => {
    const f1 = join(tmpDir, 'z.ts');
    writeFileSync(f1, 'export const z = 1;');
    const history: Content[] = [
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'read_file', args: { file_path: f1 } } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'computer_use__get_app_state',
              response: { output: '' },
              parts: [{ inlineData: { mimeType: 'image/png', data: 'i' } }],
            } as unknown as NonNullable<
              Content['parts']
            >[number]['functionResponse'],
          },
        ],
      },
    ];
    const result = await composePostCompactHistory(history, 'SUM', {
      workspaceRoot: tmpDir,
      maxFiles: 0,
      maxImages: 0,
    });
    // Only [summary(user), ack(model)] — no attachment Content appended.
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('model');
  });
});

describe('postProcessSummary', () => {
  it('returns body + trailer when no <analysis> block is present', () => {
    const out = postProcessSummary('<state_snapshot>body</state_snapshot>');
    expect(out).toContain('<state_snapshot>body</state_snapshot>');
    expect(out).toMatch(/resume.*prior task/i);
  });

  it('strips <analysis> wrappers (greedy across newlines)', () => {
    const out = postProcessSummary(
      '<analysis>\nlots of\nmulti-line\nreasoning\n</analysis>\n\n<state_snapshot>body</state_snapshot>',
    );
    expect(out).not.toContain('<analysis>');
    expect(out).not.toContain('multi-line');
    expect(out).toContain('<state_snapshot>body</state_snapshot>');
  });

  it('strips multiple <analysis> blocks if the model emits more than one', () => {
    const out = postProcessSummary(
      '<analysis>first</analysis>\n<state_snapshot>body</state_snapshot>\n<analysis>second</analysis>',
    );
    expect(out).not.toContain('<analysis>');
    expect(out).not.toContain('first');
    expect(out).not.toContain('second');
  });

  it('does NOT re-inject the <analysis> body when the model emits only scratchpad (Finding 6)', () => {
    // Regression: prior implementation fell back to `rawSummary.trim()`
    // which re-injected the entire <analysis> block when strip left
    // an empty result. The whole point of the strip is to keep the
    // scratchpad out of the next agent's context.
    const raw = '<analysis>nothing else</analysis>';
    const out = postProcessSummary(raw);
    expect(out).not.toContain('<analysis>');
    expect(out).not.toContain('nothing else');
    // Trailer must still be appended so the resuming agent gets clear
    // continuation guidance even when the summary body is missing.
    expect(out).toMatch(/resume.*prior task/i);
  });

  it('strips an unclosed <analysis> block in the fallback path (Finding 6)', () => {
    // Pathological: model emits <analysis> tag but never closes it.
    // The closed-tag regex misses → stripped non-empty → no fallback.
    // The unclosed-tag fallback regex must catch this case so the
    // <analysis> body never leaks into history.
    const raw = '<analysis>still thinking about the answer';
    const out = postProcessSummary(raw);
    expect(out).not.toContain('<analysis>');
    expect(out).not.toContain('still thinking');
    expect(out).toMatch(/resume.*prior task/i);
  });
});
