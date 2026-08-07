/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import os from 'node:os';
import nodePath from 'node:path';
import nodeFs from 'node:fs/promises';
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

// Per-run isolated qwen dir: a shared hardcoded path would leak staging
// files across runs and collide between concurrent test invocations.
let testQwenDir: string;

function cfg(modalities: Record<string, boolean>): Config {
  return {
    isOmniEnabled: () => true,
    getContentGeneratorConfig: () => ({ modalities }),
    storage: { getQwenDir: () => testQwenDir },
  } as unknown as Config;
}

beforeAll(async () => {
  testQwenDir = await nodeFs.mkdtemp(
    nodePath.join(os.tmpdir(), 'omni-trm-qwen-'),
  );
});

afterAll(async () => {
  await nodeFs.rm(testQwenDir, { recursive: true, force: true });
});

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

  it('withholds the part with a text placeholder on a transport-guard rejection', async () => {
    // A guard rejection is a policy verdict — keeping the part inline would
    // deliver the exact bytes the guard was configured to reject. Must become
    // a text placeholder, NOT stay inlineData, and NOT fail the whole batch.
    const { OmniTransportGuardError } = await import('./guard.js');
    deliverMock
      .mockRejectedValueOnce(
        new OmniTransportGuardError('x.png exceeds the omni upload limit'),
      )
      .mockResolvedValueOnce({
        fileUri: 'oss://bucket/key3',
        mimeType: 'image/png',
        sha256: 'c'.repeat(64),
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
    expect(result[0]!.inlineData).toBeUndefined();
    expect(result[0]!.text).toMatch(/withheld by the omni transport guard/);
    expect(result[0]!.text).toMatch(/exceeds the omni upload limit/);
    expect(result[1]!.fileData?.fileUri).toBe('oss://bucket/key3');
  });

  it('keeps the part inline when staging-dir setup itself fails', async () => {
    // ~/.qwen/omni existing as a regular FILE makes mkdir fail with ENOTDIR.
    // That failure must degrade THIS part to inline like any other delivery
    // failure — not reject the whole call, which would report a tool that
    // succeeded as failed.
    const qwenDir = await nodeFs.mkdtemp(
      nodePath.join(os.tmpdir(), 'omni-trm-'),
    );
    // OmniObjectStore roots at <qwenDir>/omni; make that path a plain file.
    await nodeFs.writeFile(nodePath.join(qwenDir, 'omni'), 'not a directory');
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
      await nodeFs.rm(qwenDir, { recursive: true, force: true });
    }
  });

  it('returns the original array untouched when the omni gate is off', async () => {
    gateMock.mockReturnValue(false);
    const parts = [inlinePart('image/png', PNG_BYTES)];
    const result = await processToolResultOmniMedia(
      parts,
      cfg({ image: true }),
      signal,
    );
    expect(result).toBe(parts);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('emits the degradation disclosure text immediately before the fileData part', async () => {
    deliverMock.mockResolvedValue({
      fileUri: 'oss://bucket/degraded',
      mimeType: 'image/jpeg',
      sha256: 'b'.repeat(64),
      recognized: { modality: 'image' },
      tokenEstimate: {
        estimatedTokenCount: 1,
        method: 'raw-resource-v1',
        status: 'ok',
      },
      deduped: false,
      disclosure: 'downsampled to 1568px',
      degraded: true,
    });
    const parts = [inlinePart('image/png', PNG_BYTES)];
    const result = await processToolResultOmniMedia(
      parts,
      cfg({ image: true }),
      signal,
    );
    expect(result).toHaveLength(2);
    expect(result[0]!.text).toBe(
      '【媒体降质】tool-media.image：downsampled to 1568px',
    );
    expect(result[1]!.fileData?.fileUri).toBe('oss://bucket/degraded');
    // The pipeline was told this media came from a tool (policy origins).
    expect(deliverMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({
        origin: 'tool',
        displayName: 'tool-media.image',
        expectedModality: 'image',
      }),
    );
  });

  it('expands a disclosed delivery inside functionResponse.parts', async () => {
    deliverMock.mockResolvedValue({
      fileUri: 'oss://bucket/degraded',
      mimeType: 'image/jpeg',
      sha256: 'b'.repeat(64),
      recognized: { modality: 'image' },
      tokenEstimate: {
        estimatedTokenCount: 1,
        method: 'raw-resource-v1',
        status: 'ok',
      },
      deduped: false,
      disclosure: 'downsampled to 1568px',
      degraded: true,
    });
    const parts: Part[] = [
      {
        functionResponse: {
          id: 'call_1',
          name: 'Read',
          response: { output: 'ok' },
          parts: [
            { text: 'caption' },
            inlinePart('image/png', PNG_BYTES),
          ] as Part[],
        },
      } as Part,
    ];
    const result = await processToolResultOmniMedia(
      parts,
      cfg({ image: true }),
      signal,
    );
    const nested = result[0]!.functionResponse?.parts as Part[];
    expect(nested).toHaveLength(3);
    expect(nested[0]!.text).toBe('caption');
    expect(nested[1]!.text).toBe(
      '【媒体降质】tool-media.image：downsampled to 1568px',
    );
    expect(nested[2]!.fileData?.fileUri).toBe('oss://bucket/degraded');
  });

  it('converts media nested inside functionResponse.parts (the production funnel shape)', async () => {
    // Both physical funnels deliver tool-result media wrapped by
    // convertToFunctionResponse as {functionResponse: {…, parts:
    // [{inlineData}]}} — not as top-level inlineData parts. This is the
    // branch production actually exercises.
    const parts: Part[] = [
      {
        functionResponse: {
          id: 'call_1',
          name: 'Read',
          response: { output: 'ok' },
          parts: [
            { text: 'caption' },
            inlinePart('image/png', PNG_BYTES),
          ] as Part[],
        },
      } as Part,
    ];
    const result = await processToolResultOmniMedia(
      parts,
      cfg({ image: true }),
      signal,
    );
    expect(result).not.toBe(parts);
    const nested = result[0]!.functionResponse?.parts as Part[];
    expect(nested[0]!.text).toBe('caption');
    expect(nested[1]!.fileData?.fileUri).toBe('oss://bucket/key');
    expect(nested[1]!.inlineData).toBeUndefined();
    // The wrapper's identity fields survive the rebuild.
    expect(result[0]!.functionResponse?.id).toBe('call_1');
    expect(result[0]!.functionResponse?.name).toBe('Read');
  });

  it('returns the original identity when functionResponse.parts contains no qualifying media', async () => {
    const parts: Part[] = [
      {
        functionResponse: {
          id: 'call_1',
          name: 'Read',
          response: { output: 'ok' },
          parts: [{ text: 'no media here' }] as Part[],
        },
      } as Part,
    ];
    const result = await processToolResultOmniMedia(
      parts,
      cfg({ image: true }),
      signal,
    );
    expect(result).toBe(parts);
  });

  it('enforces the aggregate upload-byte budget (over-budget parts stay inline)', async () => {
    // Two parts: the first consumes nearly the whole 128 MiB budget, the
    // second no longer fits and must stay inline even though the upload
    // COUNT budget still has room.
    const bigBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(127 * 1024 * 1024),
    ]);
    const parts = [
      inlinePart('image/png', bigBytes),
      inlinePart('image/png', bigBytes),
    ];
    const result = await processToolResultOmniMedia(
      parts,
      cfg({ image: true }),
      signal,
    );
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(result[0]!.fileData).toBeDefined();
    expect(result[1]!.inlineData).toBeDefined();
  });

  it('propagates an abort instead of degrading the part to inline', async () => {
    // A user abort is not a delivery failure — swallowing it into the
    // keep-inline path would let an aborted turn keep converting parts.
    const controller = new AbortController();
    deliverMock.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted mid-upload');
    });
    const parts = [inlinePart('image/png', PNG_BYTES)];
    await expect(
      processToolResultOmniMedia(
        parts,
        cfg({ image: true }),
        controller.signal,
      ),
    ).rejects.toThrow('aborted mid-upload');
  });
});
