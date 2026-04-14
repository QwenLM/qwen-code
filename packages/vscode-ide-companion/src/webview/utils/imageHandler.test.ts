/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeImageAttachment,
  escapePath,
  unescapePath,
} from '../../utils/imageSupport.js';

const mockMkdir = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockWriteFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockReaddir = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockStat = vi.hoisted(() => vi.fn());
const mockUnlink = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('fs/promises', () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readdir: mockReaddir,
  stat: mockStat,
  unlink: mockUnlink,
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    Storage: { getGlobalTempDir: () => '/mock/tmp' },
  };
});

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [],
  },
}));

import {
  processImageAttachments,
  saveImageToFile,
  buildPromptBlocks,
} from './imageHandler.js';

describe('imageHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decodes base64 data URL and writes correct buffer to disk', async () => {
    const filePath = await saveImageToFile(
      'data:image/png;base64,YWJj',
      'image/png',
    );

    expect(filePath).toBeTruthy();
    expect(mockMkdir).toHaveBeenCalledWith(
      path.join('/mock/tmp', 'clipboard'),
      { recursive: true },
    );
    expect(mockWriteFile).toHaveBeenCalledOnce();

    const [writtenPath, buffer] = mockWriteFile.mock.calls[0];
    expect(buffer).toEqual(Buffer.from('abc'));
    expect(path.basename(writtenPath)).toMatch(
      /^clipboard-\d+-[a-f0-9-]+\.png$/,
    );
  });

  it('decodes raw base64 (without data URL prefix)', async () => {
    const filePath = await saveImageToFile('YWJj', 'image/png');

    expect(filePath).toBeTruthy();
    const [, buffer] = mockWriteFile.mock.calls[0];
    expect(buffer).toEqual(Buffer.from('abc'));
  });

  it('prunes old clipboard images after saving', async () => {
    mockReaddir.mockResolvedValueOnce(['clipboard-1.png', 'clipboard-2.png']);
    mockStat
      .mockResolvedValueOnce({ mtimeMs: 100 })
      .mockResolvedValueOnce({ mtimeMs: 200 });

    await saveImageToFile('data:image/png;base64,YWJj', 'image/png');

    expect(mockReaddir).toHaveBeenCalled();
  });

  it('generates unique file names for images saved in the same millisecond', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234567890);

    await saveImageToFile('data:image/png;base64,YWJj', 'image/png');
    await saveImageToFile('data:image/png;base64,ZGVm', 'image/png');

    const firstName = path.basename(mockWriteFile.mock.calls[0][0]);
    const secondName = path.basename(mockWriteFile.mock.calls[1][0]);
    expect(firstName).not.toBe(secondName);
  });

  it('returns null when file write throws', async () => {
    mockWriteFile.mockRejectedValueOnce(new Error('disk full'));
    const result = await saveImageToFile(
      'data:image/png;base64,YWJj',
      'image/png',
    );
    expect(result).toBeNull();
  });

  it('returns saved prompt image metadata for validated attachments', async () => {
    const result = await processImageAttachments('Inspect this image', [
      {
        id: 'img-1',
        name: 'pasted.png',
        type: 'image/png',
        size: 3,
        data: 'data:image/png;base64,YWJj',
        timestamp: Date.now(),
      },
    ]);

    expect(result.savedImageCount).toBe(1);
    expect(result.promptImages).toEqual([
      expect.objectContaining({
        name: 'pasted.png',
        mimeType: 'image/png',
        path: expect.stringContaining(`${path.sep}clipboard-`),
      }),
    ]);
    expect(result.formattedText).toContain('@');
  });
});

describe('buildPromptBlocks', () => {
  it('builds ACP resource_link blocks from saved image attachments', () => {
    expect(
      buildPromptBlocks('Please inspect this screenshot.', [
        {
          path: '/tmp/My Images/pasted image.png',
          name: 'pasted image.png',
          mimeType: 'image/png',
        },
      ]),
    ).toEqual([
      { type: 'text', text: 'Please inspect this screenshot.' },
      {
        type: 'resource_link',
        name: 'pasted image.png',
        mimeType: 'image/png',
        uri: 'file:///tmp/My Images/pasted image.png',
      },
    ]);
  });

  it('returns only resource links when the prompt has images only', () => {
    expect(
      buildPromptBlocks('', [
        {
          path: '/tmp/clipboard/pasted.webp',
          name: 'pasted.webp',
          mimeType: 'image/webp',
        },
      ]),
    ).toEqual([
      {
        type: 'resource_link',
        name: 'pasted.webp',
        mimeType: 'image/webp',
        uri: 'file:///tmp/clipboard/pasted.webp',
      },
    ]);
  });
});

describe('normalizeImageAttachment', () => {
  it('rejects attachments with unsupported image mime types', () => {
    expect(
      normalizeImageAttachment({
        id: 'img-1',
        name: 'animated.gif',
        type: 'image/gif',
        size: 43,
        data: 'data:image/gif;base64,R0lGODdhAQABAIAAAP///////ywAAAAAAQABAAACAkQBADs=',
        timestamp: Date.now(),
      }),
    ).toBeNull();
  });

  it('rejects attachments whose decoded payload exceeds the enforced byte limit', () => {
    expect(
      normalizeImageAttachment(
        {
          id: 'img-2',
          name: 'oversized.png',
          type: 'image/png',
          size: 1,
          data: 'data:image/png;base64,QUJDREU=',
          timestamp: Date.now(),
        },
        { maxBytes: 4 },
      ),
    ).toBeNull();
  });
});

describe('pathEscaping', () => {
  it('round-trips shell-escaped file paths', () => {
    const originalPath = '/tmp/My Images/(draft) final.png';
    expect(unescapePath(escapePath(originalPath))).toBe(originalPath);
  });
});
