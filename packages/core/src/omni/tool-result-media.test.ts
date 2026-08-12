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
vi.mock('./index.js', async (importOriginal) => ({
  // buildAdditionalMediaParts stays REAL: these tests pin the funnel's
  // materialization of multi-output deliveries end to end.
  ...(await importOriginal<typeof import('./index.js')>()),
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

/** Role each replacement Part plays in the group, so one assertion can pin
 * the whole group's order. */
function tagPart(part: Part): string {
  if (part.fileData) return 'media';
  const text = part.text ?? '';
  if (text.startsWith('【媒体资源】')) return 'handle';
  if (text.startsWith('【媒体省略】')) return 'omission';
  if (text.startsWith('【媒体降质】')) return 'disclosure';
  if (text.startsWith('【媒体转写】')) return 'transcript';
  return 'text';
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

  it('withholds the part when guard-stage PROCESSING fails (never inline the rejected bytes)', async () => {
    // A guard-policy execution failure arrives as OmniTransportGuardError
    // with the underlying error as `cause` (see processMediaForOmniDelivery's
    // guard loop): the violation verdict already stands, so falling back to
    // inline would deliver exactly the over-limit bytes the guard rejected.
    const { OmniTransportGuardError } = await import('./guard.js');
    deliverMock.mockRejectedValueOnce(
      new OmniTransportGuardError(
        'Transport-guard processing failed for x.png: ffmpeg failed (exit 1)',
        { cause: new Error('ffmpeg failed (exit 1)') },
      ),
    );
    const result = await processToolResultOmniMedia(
      [inlinePart('image/png', PNG_BYTES)],
      cfg({ image: true }),
      signal,
    );
    expect(result[0]!.inlineData).toBeUndefined();
    expect(result[0]!.text).toMatch(/withheld by the omni transport guard/);
    expect(result[0]!.text).toMatch(/Transport-guard processing failed/);
  });

  it('replaces an explicitly omitted delivery with the omission notice text', async () => {
    // Stage B (policy design §10.2): the pipeline itself withheld the media
    // after the guard policies could not bring it within limits. Not an
    // error — the notice stands in for the part.
    deliverMock.mockResolvedValueOnce({
      fileUri: '',
      mimeType: 'image/png',
      sha256: '',
      recognized: { modality: 'image' },
      tokenEstimate: {
        estimatedTokenCount: 1,
        method: 'raw-resource-v1',
        status: 'ok',
      },
      deduped: false,
      omission: { reason: 'still 900 bytes over the upload limit' },
    });
    const parts = [inlinePart('image/png', PNG_BYTES)];
    const result = await processToolResultOmniMedia(
      parts,
      cfg({ image: true }),
      signal,
    );
    expect(result).not.toBe(parts);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      text: '【媒体省略】tool-media.image：still 900 bytes over the upload limit',
    });
  });

  // Session resource handle (M §5.2): the only identity the model ever gets
  // for tool-produced media. A branch that drops it hands the model media it
  // can never name again — no recall, no follow-up omni tool call, and no
  // path to fall back on. The handle must LEAD the group so the disclosure
  // keeps its D8 adjacency to the media part.
  const RESOURCE_ID = 'media-3-c0ffee01';
  const HANDLE_TEXT = `【媒体资源】tool-media.image：${RESOURCE_ID}`;
  const HANDLE_DELIVERY = {
    mimeType: 'image/png',
    sha256: 'a'.repeat(64),
    recognized: { modality: 'image' },
    tokenEstimate: {
      estimatedTokenCount: 1,
      method: 'raw-resource-v1',
      status: 'ok',
    },
    deduped: false,
    resourceId: RESOURCE_ID,
  };

  it.each([
    {
      branch: 'plain upload',
      delivery: { fileUri: 'oss://bucket/key' },
      tags: ['handle', 'media'],
    },
    {
      branch: 'degraded upload',
      delivery: {
        fileUri: 'oss://bucket/degraded',
        disclosure: 'downsampled to 1568px',
        degraded: true,
      },
      tags: ['handle', 'disclosure', 'media'],
    },
    {
      branch: 'omitted media',
      delivery: { fileUri: '', omission: { reason: 'still over the limit' } },
      tags: ['handle', 'omission'],
    },
    {
      branch: 'pure transcript',
      delivery: { fileUri: '', transcripts: [{ text: '你好，世界' }] },
      tags: ['handle', 'transcript'],
    },
    {
      branch: 'degraded pure transcript',
      delivery: {
        fileUri: '',
        transcripts: [{ text: '你好，世界' }],
        disclosure: 'transcribed after downsampling',
        degraded: true,
      },
      tags: ['handle', 'disclosure', 'transcript'],
    },
  ])(
    'leads the $branch replacement group with the resource handle',
    async ({ delivery, tags }) => {
      deliverMock.mockResolvedValueOnce({ ...HANDLE_DELIVERY, ...delivery });
      const result = await processToolResultOmniMedia(
        [inlinePart('image/png', PNG_BYTES)],
        cfg({ image: true }),
        signal,
      );
      expect(result.map(tagPart)).toEqual(tags);
      expect(result[0]!.text).toBe(HANDLE_TEXT);
    },
  );

  it('charges uploaded additionalMedia extras against the upload-count budget', async () => {
    // One part whose delivery carries 7 uploaded extras uses 1 + 7 = 8
    // upload slots — a multi-output policy must not let a tool result fan
    // out past MAX_UPLOADS_PER_TOOL_RESULT. The next part stays inline.
    deliverMock.mockResolvedValueOnce({
      fileUri: 'oss://bucket/primary',
      mimeType: 'image/jpeg',
      sha256: 'b'.repeat(64),
      recognized: { modality: 'image' },
      tokenEstimate: {
        estimatedTokenCount: 1,
        method: 'raw-resource-v1',
        status: 'ok',
      },
      deduped: false,
      additionalMedia: Array.from({ length: 8 }, (_, i) => ({
        fileUri: i === 0 ? '' : `oss://bucket/frame${i}`,
        mimeType: 'image/jpeg',
        sha256: String(i).repeat(64).slice(0, 64),
        // The omitted extra was NOT uploaded — it must not be charged.
        ...(i === 0 ? { omission: { reason: 'too big' } } : {}),
      })),
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
    // Second part never started a delivery (budget exhausted).
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(result[result.length - 1]!.inlineData).toBeDefined();
    expect(result.filter((p) => p.fileData).length).toBe(8);
  });

  it('an omission does not consume the per-result upload budgets', async () => {
    // Nothing was uploaded for an omitted part, so all 8 upload slots must
    // remain for the following parts.
    deliverMock.mockResolvedValueOnce({
      fileUri: '',
      mimeType: 'image/png',
      sha256: '',
      recognized: { modality: 'image' },
      tokenEstimate: {
        estimatedTokenCount: 1,
        method: 'raw-resource-v1',
        status: 'ok',
      },
      deduped: false,
      omission: { reason: 'over limit' },
    });
    const parts = Array.from({ length: 9 }, () =>
      inlinePart('image/png', PNG_BYTES),
    );
    const result = await processToolResultOmniMedia(
      parts,
      cfg({ image: true }),
      signal,
    );
    expect(deliverMock).toHaveBeenCalledTimes(9);
    expect(result.filter((p) => p.fileData).length).toBe(8);
    expect(result.filter((p) => p.inlineData).length).toBe(0);
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

  it('keeps the part inline when downloads/ is a planted symlink (no bytes through the link)', async () => {
    // mkdir { recursive: true } succeeds silently on a symlink-to-dir, so
    // without the lstat guard the staged bytes would land at an
    // attacker-chosen location outside the omni root.
    const qwenDir = await nodeFs.mkdtemp(
      nodePath.join(os.tmpdir(), 'omni-trm-link-'),
    );
    const outside = await nodeFs.mkdtemp(
      nodePath.join(os.tmpdir(), 'omni-trm-out-'),
    );
    try {
      await nodeFs.mkdir(nodePath.join(qwenDir, 'omni'), { recursive: true });
      await nodeFs.symlink(
        outside,
        nodePath.join(qwenDir, 'omni', 'downloads'),
      );
      const config = {
        isOmniEnabled: () => true,
        getContentGeneratorConfig: () => ({ modalities: { image: true } }),
        storage: { getQwenDir: () => qwenDir },
      } as unknown as Config;
      const parts = [inlinePart('image/png', PNG_BYTES)];
      const result = await processToolResultOmniMedia(parts, config, signal);
      expect(result).toBe(parts);
      expect(deliverMock).not.toHaveBeenCalled();
      // Nothing was written through the link.
      await expect(nodeFs.readdir(outside)).resolves.toEqual([]);
    } finally {
      await nodeFs.rm(qwenDir, { recursive: true, force: true });
      await nodeFs.rm(outside, { recursive: true, force: true });
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

  it('materializes additionalMedia extras as [disclosure, fileData] pairs after the primary', async () => {
    deliverMock.mockResolvedValue({
      fileUri: 'oss://bucket/frame1',
      mimeType: 'image/jpeg',
      sha256: 'b'.repeat(64),
      recognized: { modality: 'image' },
      tokenEstimate: {
        estimatedTokenCount: 1,
        method: 'raw-resource-v1',
        status: 'ok',
      },
      deduped: false,
      disclosure: '帧 1/3',
      degraded: true,
      additionalMedia: [
        {
          fileUri: 'oss://bucket/frame2',
          mimeType: 'image/jpeg',
          sha256: 'd'.repeat(64),
          disclosure: '帧 2/3',
        },
        {
          fileUri: '',
          mimeType: 'image/jpeg',
          sha256: 'e'.repeat(64),
          disclosure: '帧 3/3',
          omission: { reason: 'too big' },
        },
      ],
    });
    const parts = [inlinePart('image/png', PNG_BYTES)];
    const result = await processToolResultOmniMedia(
      parts,
      cfg({ image: true }),
      signal,
    );
    // [primary disclosure, primary fileData, extra disclosure, extra
    // fileData, omitted-extra disclosure, omission notice] — D8 adjacency
    // per pair; a violating extra is an explicit omission text Part.
    expect(result).toHaveLength(6);
    expect(result[0]!.text).toBe('【媒体降质】tool-media.image：帧 1/3');
    expect(result[1]!.fileData?.fileUri).toBe('oss://bucket/frame1');
    expect(result[2]!.text).toBe('【媒体降质】tool-media.image：帧 2/3');
    expect(result[3]!.fileData?.fileUri).toBe('oss://bucket/frame2');
    expect(result[4]!.text).toBe('【媒体降质】tool-media.image：帧 3/3');
    expect(result[5]!.text).toContain('【媒体省略】tool-media.image');
    expect(result[5]!.text).toContain('too big');
  });

  it('materializes additionalMedia extras even when the primary has no disclosure', async () => {
    // The undisclosed-primary branch is separate code from the disclosed
    // one — both must splice the extras in.
    deliverMock.mockResolvedValue({
      fileUri: 'oss://bucket/frame1',
      mimeType: 'image/jpeg',
      sha256: 'b'.repeat(64),
      recognized: { modality: 'image' },
      tokenEstimate: {
        estimatedTokenCount: 1,
        method: 'raw-resource-v1',
        status: 'ok',
      },
      deduped: false,
      additionalMedia: [
        {
          fileUri: 'oss://bucket/frame2',
          mimeType: 'image/jpeg',
          sha256: 'd'.repeat(64),
        },
      ],
    });
    const parts = [inlinePart('image/png', PNG_BYTES)];
    const result = await processToolResultOmniMedia(
      parts,
      cfg({ image: true }),
      signal,
    );
    expect(result).toHaveLength(2);
    expect(result[0]!.fileData?.fileUri).toBe('oss://bucket/frame1');
    expect(result[1]!.fileData?.fileUri).toBe('oss://bucket/frame2');
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
