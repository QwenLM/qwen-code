/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Part } from '@google/genai';
import type { Config } from '../config/config.js';

const deliverMock = vi.hoisted(() => vi.fn());
const gateMock = vi.hoisted(() => vi.fn());
vi.mock('./index.js', () => ({
  isOmniDeliveryActive: gateMock,
  processMediaForOmniDelivery: deliverMock,
}));

import { processToolResultOmniMedia } from './tool-result-media.js';

// A minimal real PNG header so sniffMediaType accepts the bytes as image.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);
// ISO BMFF video header (ftypisom) — sniffs as video/mp4.
const MP4_BYTES = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypisom', 'latin1'),
  Buffer.alloc(64),
]);

function inlinePart(mimeType: string, bytes: Buffer): Part {
  return { inlineData: { mimeType, data: bytes.toString('base64') } };
}

function cfg(modalities: Record<string, boolean>): Config {
  return {
    isOmniEnabled: () => true,
    getContentGeneratorConfig: () => ({ modalities }),
    storage: { getQwenDir: () => '/tmp/omni-trm-test-qwen' },
  } as unknown as Config;
}

beforeEach(() => {
  gateMock.mockReturnValue(true);
  deliverMock.mockReset();
  deliverMock.mockResolvedValue({
    fileUri: 'oss://bucket/key',
    mimeType: 'image/png',
    sha256: 'a'.repeat(64),
    recognized: { modality: 'image' },
    tokenEstimate: {
      estimatedTokenCount: 1,
      method: 'raw-resource-v1',
      status: 'ok',
    },
    deduped: false,
  });
});

describe('processToolResultOmniMedia', () => {
  const signal = new AbortController().signal;

  it('returns the original array identity when nothing changes', async () => {
    const parts: Part[] = [{ text: 'no media' }];
    const result = await processToolResultOmniMedia(parts, cfg({}), signal);
    expect(result).toBe(parts);
  });

  it('converts qualifying inline media to fileData', async () => {
    const parts = [inlinePart('image/png', PNG_BYTES)];
    const result = await processToolResultOmniMedia(
      parts,
      cfg({ image: true }),
      signal,
    );
    expect(result).not.toBe(parts);
    expect(result[0]!.fileData?.fileUri).toBe('oss://bucket/key');
  });

  it('gates on the SNIFFED modality, not the declared MIME type', async () => {
    // Declared audio (enabled), actual bytes are an MP4 video container,
    // and video modality is DISABLED — must stay inline, no upload.
    const parts = [inlinePart('audio/wav', MP4_BYTES)];
    const result = await processToolResultOmniMedia(
      parts,
      cfg({ audio: true, video: false }),
      signal,
    );
    expect(result).toBe(parts);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('enforces the per-result upload-count budget (excess stays inline)', async () => {
    const parts = Array.from({ length: 12 }, () =>
      inlinePart('image/png', PNG_BYTES),
    );
    const result = await processToolResultOmniMedia(
      parts,
      cfg({ image: true }),
      signal,
    );
    expect(deliverMock).toHaveBeenCalledTimes(8);
    const uploaded = result.filter((p) => p.fileData).length;
    const keptInline = result.filter((p) => p.inlineData).length;
    expect(uploaded).toBe(8);
    expect(keptInline).toBe(4);
  });

  it('keeps parts inline when a single delivery fails, without failing the batch', async () => {
    deliverMock
      .mockRejectedValueOnce(new Error('upload exploded'))
      .mockResolvedValueOnce({
        fileUri: 'oss://bucket/key2',
        mimeType: 'image/png',
        sha256: 'b'.repeat(64),
        recognized: { modality: 'image' },
        tokenEstimate: {
          estimatedTokenCount: 1,
          method: 'raw-resource-v1',
          status: 'ok',
        },
        deduped: false,
      });
    const parts = [
      inlinePart('image/png', PNG_BYTES),
      inlinePart('image/png', PNG_BYTES),
    ];
    const result = await processToolResultOmniMedia(
      parts,
      cfg({ image: true }),
      signal,
    );
    expect(result[0]!.inlineData).toBeDefined();
    expect(result[1]!.fileData?.fileUri).toBe('oss://bucket/key2');
  });

  it('keeps the part inline when staging-dir setup itself fails', async () => {
    // ~/.qwen/omni existing as a regular FILE makes mkdir fail with ENOTDIR.
    // That failure must degrade THIS part to inline like any other delivery
    // failure — not reject the whole call, which would report a tool that
    // succeeded as failed.
    const os = await import('node:os');
    const nodePath = await import('node:path');
    const fs = await import('node:fs/promises');
    const qwenDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'omni-trm-'));
    // OmniObjectStore roots at <qwenDir>/omni; make that path a plain file.
    await fs.writeFile(nodePath.join(qwenDir, 'omni'), 'not a directory');
    try {
      const config = {
        isOmniEnabled: () => true,
        getContentGeneratorConfig: () => ({ modalities: { image: true } }),
        storage: { getQwenDir: () => qwenDir },
      } as unknown as Config;
      const parts = [inlinePart('image/png', PNG_BYTES)];
      const result = await processToolResultOmniMedia(parts, config, signal);
      expect(result).toBe(parts);
      expect(deliverMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(qwenDir, { recursive: true, force: true });
    }
  });
});
