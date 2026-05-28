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
