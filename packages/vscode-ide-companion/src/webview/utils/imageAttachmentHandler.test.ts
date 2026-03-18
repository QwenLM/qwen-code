/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSaveImageBuffer = vi.hoisted(() =>
  vi.fn<(buffer: Buffer, fileName: string) => Promise<string>>(),
);
const mockPruneClipboard = vi.hoisted(() =>
  vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
);

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    saveImageBufferToClipboardDir: mockSaveImageBuffer,
    pruneClipboardImages: mockPruneClipboard,
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
} from './imageAttachmentHandler.js';

describe('imageAttachmentHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveImageBuffer.mockImplementation(
      async (_buffer: Buffer, fileName: string) =>
        `/mock/clipboard/${fileName}`,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decodes base64 data URL and delegates to shared save', async () => {
    const filePath = await saveImageToFile(
      'data:image/png;base64,YWJj',
      'image/png',
    );

    expect(filePath).toBeTruthy();
    expect(mockSaveImageBuffer).toHaveBeenCalledOnce();

    const [buffer, fileName] = mockSaveImageBuffer.mock.calls[0];
    expect(buffer).toEqual(Buffer.from('abc'));
    expect(fileName).toMatch(/^clipboard-\d+-[a-f0-9-]+\.png$/);
  });

  it('decodes raw base64 (without data URL prefix)', async () => {
    const filePath = await saveImageToFile('YWJj', 'image/png');

    expect(filePath).toBeTruthy();
    const [buffer] = mockSaveImageBuffer.mock.calls[0];
    expect(buffer).toEqual(Buffer.from('abc'));
  });

  it('calls pruneClipboardImages after saving', async () => {
    await saveImageToFile('data:image/png;base64,YWJj', 'image/png');
    expect(mockPruneClipboard).toHaveBeenCalledOnce();
  });

  it('generates unique file names for images saved in the same millisecond', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234567890);

    await saveImageToFile('data:image/png;base64,YWJj', 'image/png');
    await saveImageToFile('data:image/png;base64,ZGVm', 'image/png');

    const firstName = mockSaveImageBuffer.mock.calls[0][1];
    const secondName = mockSaveImageBuffer.mock.calls[1][1];
    expect(firstName).not.toBe(secondName);
  });

  it('returns null when saveImageBufferToClipboardDir throws', async () => {
    mockSaveImageBuffer.mockRejectedValueOnce(new Error('disk full'));
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
