/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PastedContent } from '@qwen-code/core';
import {
  cleanupOldClipboardImages,
  saveClipboardImage,
} from './clipboardUtils.js';
import {
  ClipboardImageCaptureError,
  materializePendingClipboardImages,
  startClipboardImageCapture,
} from './clipboardImageCapture.js';

vi.mock('./clipboardUtils.js', () => ({
  cleanupOldClipboardImages: vi.fn(),
  saveClipboardImage: vi.fn(),
}));

function pendingImage(preparationId: string): PastedContent & {
  type: 'image';
  preparationId: string;
} {
  return {
    id: 0,
    type: 'image',
    content: '',
    filename: 'Pasted image',
    preparationId,
  };
}

describe('clipboard image capture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cleanupOldClipboardImages).mockResolvedValue(undefined);
  });

  it('lets submit await the capture already started by paste', async () => {
    let finishCapture: ((path: string | null) => void) | undefined;
    vi.mocked(saveClipboardImage).mockReturnValueOnce(
      new Promise((resolve) => {
        finishCapture = resolve;
      }),
    );
    const image = pendingImage('capture-submit');

    const background = startClipboardImageCapture(image, '/project');
    const submission = materializePendingClipboardImages({ 0: image });

    expect(saveClipboardImage).toHaveBeenCalledOnce();
    finishCapture?.('/tmp/clipboard-1.png');

    const [captured, submitted] = await Promise.all([
      background,
      submission,
    ]);
    expect(captured).toMatchObject({
      sourcePath: '/tmp/clipboard-1.png',
      filename: 'clipboard-1.png',
    });
    expect(submitted[0]).toEqual(captured);
    expect(saveClipboardImage).toHaveBeenCalledOnce();
    expect(cleanupOldClipboardImages).toHaveBeenCalledWith('/project');
  });

  it('rejects submit when native clipboard capture fails', async () => {
    vi.mocked(saveClipboardImage).mockResolvedValueOnce(null);
    const image = pendingImage('capture-failure');

    const background = startClipboardImageCapture(image, '/project');
    const submission = materializePendingClipboardImages({ 0: image });

    await expect(background).rejects.toBeInstanceOf(
      ClipboardImageCaptureError,
    );
    await expect(submission).rejects.toBeInstanceOf(
      ClipboardImageCaptureError,
    );
  });

  it('reuses a completed capture while buffer state is publishing', async () => {
    vi.mocked(saveClipboardImage).mockResolvedValueOnce(
      '/tmp/clipboard-ready.png',
    );
    const image = pendingImage('capture-publishing');

    await startClipboardImageCapture(image, '/project');
    const submitted = await materializePendingClipboardImages({ 0: image });

    expect(submitted[0].sourcePath).toBe('/tmp/clipboard-ready.png');
    expect(saveClipboardImage).toHaveBeenCalledOnce();
  });

  it('passes through images whose capture already reached sourcePath', async () => {
    const image = {
      ...pendingImage('already-captured'),
      sourcePath: '/tmp/ready.png',
    };
    const contents = { 0: image };

    await expect(materializePendingClipboardImages(contents)).resolves.toBe(
      contents,
    );
    expect(saveClipboardImage).not.toHaveBeenCalled();
  });
});
