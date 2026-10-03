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
import sharp from 'sharp';
import type { PngOptions } from 'sharp';
import type { Part } from '@google/genai';
import * as imageView from '../utils/image-view.js';
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

const png = (): Part => inlinePart('image/png', PNG_BYTES);

/** An image delivery result; `extra` adds the branch-specific fields. */
function delivery(
  fileUri: string,
  mimeType: string,
  sha256: string,
  extra: Record<string, unknown> = {},
) {
  return {
    fileUri,
    mimeType,
    sha256,
    recognized: { modality: 'image' },
    tokenEstimate: {
      estimatedTokenCount: 1,
      method: 'raw-resource-v1',
      status: 'ok',
    },
    deduped: false,
    ...extra,
  };
}

/** A solid-colour PNG rendered by sharp. */
const solidPng = (width: number, height: number, opts?: PngOptions) =>
  sharp({ create: { width, height, channels: 3, background: '#204080' } })
    .png(opts)
    .toBuffer();

/** Long edge of a base64-encoded image. */
async function longEdge(data: string): Promise<number> {
  const metadata = await sharp(Buffer.from(data, 'base64')).metadata();
  return Math.max(metadata.width ?? 0, metadata.height ?? 0);
}

/** A tool result wrapping `nested` the way convertToFunctionResponse does. */
const wrapped = (...nested: Part[]): Part[] => [
  {
    functionResponse: {
      id: 'call_1',
      name: 'Read',
      response: { output: 'ok' },
      parts: nested,
    },
  } as Part,
];

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
const mkTmp = (prefix: string) =>
  nodeFs.mkdtemp(nodePath.join(os.tmpdir(), prefix));

function cfg(modalities: Record<string, boolean>, qwenDir?: string): Config {
  return {
    isOmniEnabled: () => true,
    getContentGeneratorConfig: () => ({ modalities }),
    storage: { getQwenDir: () => qwenDir ?? testQwenDir },
  } as unknown as Config;
}

beforeAll(async () => {
  testQwenDir = await mkTmp('omni-trm-qwen-');
});

afterAll(async () => {
  await nodeFs.rm(testQwenDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.unstubAllEnvs();
  gateMock.mockReturnValue(true);
  deliverMock.mockReset();
  deliverMock.mockResolvedValue(
    delivery('oss://bucket/key', 'image/png', 'a'.repeat(64)),
  );
});

describe('processToolResultOmniMedia', () => {
  const signal = new AbortController().signal;

  const run = (
    parts: Part[],
    modalities: Record<string, boolean> = { image: true },
    qwenDir?: string,
  ) => processToolResultOmniMedia(parts, cfg(modalities, qwenDir), signal);

  it('returns the original array identity when nothing changes', async () => {
    const parts: Part[] = [{ text: 'no media' }];
    const result = await run(parts, {});
    expect(result).toBe(parts);
  });

  it('converts qualifying inline media to fileData', async () => {
    const parts = [png()];
    const result = await run(parts);
    expect(result).not.toBe(parts);
    expect(result[0]!.fileData?.fileUri).toBe('oss://bucket/key');
  });

  it('gates on the SNIFFED modality, not the declared MIME type', async () => {
    // Declared audio (enabled), actual bytes are an MP4 video container,
    // and video modality is DISABLED — must stay inline, no upload.
    const parts = [inlinePart('audio/wav', MP4_BYTES)];
    const result = await run(parts, { audio: true, video: false });
    expect(result).toBe(parts);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('enforces the per-result upload-count budget (excess stays inline)', async () => {
    const result = await run(Array.from({ length: 12 }, png));
    expect(deliverMock).toHaveBeenCalledTimes(8);
    const uploaded = result.filter((p) => p.fileData).length;
    const keptInline = result.filter((p) => p.inlineData).length;
    expect(uploaded).toBe(8);
    expect(keptInline).toBe(4);
  });

  it('keeps parts inline when a single delivery fails, without failing the batch', async () => {
    deliverMock
      .mockRejectedValueOnce(new Error('upload exploded'))
      .mockResolvedValueOnce(
        delivery('oss://bucket/key2', 'image/png', 'b'.repeat(64)),
      );
    const result = await run([png(), png()]);
    expect(result[0]!.inlineData).toBeDefined();
    expect(result[1]!.fileData?.fileUri).toBe('oss://bucket/key2');
  });

  it('withholds the part with a text placeholder on a transport-guard rejection', async () => {
    // A guard rejection is a policy verdict: keeping the part inline would
    // deliver the exact bytes the guard rejected. Must become a text
    // placeholder, NOT stay inlineData, and NOT fail the whole batch.
    const { OmniTransportGuardError } = await import('./guard.js');
    deliverMock
      .mockRejectedValueOnce(
        new OmniTransportGuardError('x.png exceeds the omni upload limit'),
      )
      .mockResolvedValueOnce(
        delivery('oss://bucket/key3', 'image/png', 'c'.repeat(64)),
      );
    const result = await run([png(), png()]);
    expect(result[0]!.inlineData).toBeUndefined();
    expect(result[0]!.text).toMatch(/withheld by the omni transport guard/);
    expect(result[0]!.text).toMatch(/exceeds the omni upload limit/);
    expect(result[1]!.fileData?.fileUri).toBe('oss://bucket/key3');
  });

  it('keeps the recall handle on a guard-rejected part', async () => {
    // The bind happens before the guard rules, so the session already has a
    // record of this media. Withholding the handle too would strand a
    // recorded resource (no bytes AND no memory recall), while the omission
    // branch, whose verdict is identical, does hand the handle over.
    const { OmniTransportGuardError } = await import('./guard.js');
    const rejection = new OmniTransportGuardError(
      'x.png exceeds the omni upload limit',
    );
    rejection.sessionResourceId = 'media-6-ab12';
    deliverMock.mockRejectedValueOnce(rejection);

    const result = await run([png()]);

    expect(result[0]!.text).toContain('media-6-ab12');
    expect(result[1]!.text).toMatch(/withheld by the omni transport guard/);
  });

  it('withholds the part when guard-stage PROCESSING fails (never inline the rejected bytes)', async () => {
    // A guard-policy execution failure arrives as OmniTransportGuardError
    // with the underlying error as `cause` (processMediaForOmniDelivery's
    // guard loop): the verdict already stands, so falling back to inline
    // would deliver exactly the over-limit bytes the guard rejected.
    const { OmniTransportGuardError } = await import('./guard.js');
    deliverMock.mockRejectedValueOnce(
      new OmniTransportGuardError(
        'Transport-guard processing failed for x.png: ffmpeg failed (exit 1)',
        { cause: new Error('ffmpeg failed (exit 1)') },
      ),
    );
    const result = await run([png()]);
    expect(result[0]!.inlineData).toBeUndefined();
    expect(result[0]!.text).toMatch(/withheld by the omni transport guard/);
    expect(result[0]!.text).toMatch(/Transport-guard processing failed/);
  });

  it('replaces an explicitly omitted delivery with the omission notice text', async () => {
    // Stage B (policy design §10.2): the pipeline withheld the media after
    // the guard policies could not bring it within limits. Not an error —
    // the notice stands in for the part.
    deliverMock.mockResolvedValueOnce(
      delivery('', 'image/png', '', {
        omission: { reason: 'still 900 bytes over the upload limit' },
      }),
    );
    const parts = [png()];
    const result = await run(parts);
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
    ...delivery('', 'image/png', 'a'.repeat(64)),
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
      const result = await run([png()]);
      expect(result.map(tagPart)).toEqual(tags);
      expect(result[0]!.text).toBe(HANDLE_TEXT);
    },
  );

  it('charges uploaded additionalMedia extras against the upload-count budget', async () => {
    // One part whose delivery carries 7 uploaded extras uses 1 + 7 = 8
    // upload slots — a multi-output policy must not let a tool result fan
    // out past MAX_UPLOADS_PER_TOOL_RESULT. The next part stays inline.
    deliverMock.mockResolvedValueOnce(
      delivery('oss://bucket/primary', 'image/jpeg', 'b'.repeat(64), {
        additionalMedia: Array.from({ length: 8 }, (_, i) => ({
          fileUri: i === 0 ? '' : `oss://bucket/frame${i}`,
          mimeType: 'image/jpeg',
          sha256: String(i).repeat(64).slice(0, 64),
          // The omitted extra was NOT uploaded — it must not be charged.
          ...(i === 0 ? { omission: { reason: 'too big' } } : {}),
        })),
      }),
    );
    const result = await run([png(), png()]);
    // Second part never started a delivery (budget exhausted).
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(result[result.length - 1]!.inlineData).toBeDefined();
    expect(result.filter((p) => p.fileData).length).toBe(8);
  });

  it('an omission does not consume the per-result upload budgets', async () => {
    // Nothing was uploaded for an omitted part, so all 8 upload slots must
    // remain for the following parts.
    deliverMock.mockResolvedValueOnce(
      delivery('', 'image/png', '', { omission: { reason: 'over limit' } }),
    );
    const result = await run(Array.from({ length: 9 }, png));
    expect(deliverMock).toHaveBeenCalledTimes(9);
    expect(result.filter((p) => p.fileData).length).toBe(8);
    expect(result.filter((p) => p.inlineData).length).toBe(0);
  });

  it('keeps the part inline when staging-dir setup itself fails', async () => {
    // ~/.qwen/omni existing as a regular FILE makes mkdir fail with ENOTDIR.
    // That must degrade THIS part to inline like any other delivery failure,
    // not reject the whole call (which would report a successful tool as
    // failed).
    const qwenDir = await mkTmp('omni-trm-');
    // OmniObjectStore roots at <qwenDir>/omni; make that path a plain file.
    await nodeFs.writeFile(nodePath.join(qwenDir, 'omni'), 'not a directory');
    try {
      const parts = [png()];
      const result = await run(parts, { image: true }, qwenDir);
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
    const qwenDir = await mkTmp('omni-trm-link-');
    const outside = await mkTmp('omni-trm-out-');
    try {
      await nodeFs.mkdir(nodePath.join(qwenDir, 'omni'), { recursive: true });
      await nodeFs.symlink(
        outside,
        nodePath.join(qwenDir, 'omni', 'downloads'),
      );
      const parts = [png()];
      const result = await run(parts, { image: true }, qwenDir);
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
    const parts = [png()];
    const result = await run(parts);
    expect(result).toBe(parts);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  const degraded = () =>
    delivery('oss://bucket/degraded', 'image/jpeg', 'b'.repeat(64), {
      disclosure: 'downsampled to 1568px',
      degraded: true,
    });

  it('emits the degradation disclosure text immediately before the fileData part', async () => {
    deliverMock.mockResolvedValue(degraded());
    const result = await run([png()]);
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
    deliverMock.mockResolvedValue(
      delivery('oss://bucket/frame1', 'image/jpeg', 'b'.repeat(64), {
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
      }),
    );
    const result = await run([png()]);
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
    deliverMock.mockResolvedValue(
      delivery('oss://bucket/frame1', 'image/jpeg', 'b'.repeat(64), {
        additionalMedia: [
          {
            fileUri: 'oss://bucket/frame2',
            mimeType: 'image/jpeg',
            sha256: 'd'.repeat(64),
          },
        ],
      }),
    );
    const result = await run([png()]);
    expect(result).toHaveLength(2);
    expect(result[0]!.fileData?.fileUri).toBe('oss://bucket/frame1');
    expect(result[1]!.fileData?.fileUri).toBe('oss://bucket/frame2');
  });

  it('expands a disclosed delivery inside functionResponse.parts', async () => {
    deliverMock.mockResolvedValue(degraded());
    const result = await run(wrapped({ text: 'caption' }, png()));
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
    // [{inlineData}]}}, not as top-level inlineData parts. This is the
    // branch production actually exercises.
    const parts = wrapped({ text: 'caption' }, png());
    const result = await run(parts);
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
    const parts = wrapped({ text: 'no media here' });
    const result = await run(parts);
    expect(result).toBe(parts);
  });

  it('enforces the aggregate upload-byte budget (over-budget parts are bounded, not uploaded)', async () => {
    // The first part consumes nearly the whole 128 MiB budget; the second
    // no longer fits and must not upload even though the upload COUNT
    // budget has room. It is still bounded: the renderer's source cap
    // refuses 127 MiB and the trailing inline clamp substitutes the
    // placeholder, the bounded delivery the producer-side pipeline would
    // have made had the funnel never run.
    const bigBytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(127 * 1024 * 1024),
    ]);
    const big = () => inlinePart('image/png', bigBytes);
    const result = await run([big(), big()]);
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(result[0]!.fileData).toBeDefined();
    expect(result[1]!.text).toContain('[Media omitted: image/png');
  });

  it('bounds an over-budget image it keeps inline instead of delivering source-resolution bytes', async () => {
    // Producers skip their inline clamp while omni delivery owns the media,
    // so an image the funnel DECLINES must still be bounded here, else the
    // original bytes reach the model inline on every turn. Nine images
    // exhaust the eight-upload budget; the ninth must come back re-encoded,
    // not as the server's original 3840x2160 PNG. Removing the keep-inline
    // bound turns this test red.
    const oversized = await solidPng(3840, 2160);
    const result = await run(
      Array.from({ length: 9 }, () => inlinePart('image/png', oversized)),
    );
    expect(deliverMock).toHaveBeenCalledTimes(8);
    expect(result.filter((p) => p.fileData)).toHaveLength(8);
    const keptInline = result.filter((p) => p.inlineData);
    expect(keptInline).toHaveLength(1);
    expect(keptInline[0]!.inlineData!.mimeType).toBe('image/jpeg');
    expect(
      await longEdge(keptInline[0]!.inlineData!.data!),
    ).toBeLessThanOrEqual(1568);
  });

  it('bounds an image whose upload fails instead of delivering source-resolution bytes inline', async () => {
    // Same residue, different decline exit: a staging/upload failure keeps
    // the part inline, and the kept image must be bounded rather than
    // forwarded at source resolution.
    deliverMock.mockRejectedValue(new Error('upload exploded'));
    const oversized = await solidPng(3840, 2160);
    const result = await run([inlinePart('image/png', oversized)]);
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(result[0]!.inlineData!.mimeType).toBe('image/jpeg');
    expect(await longEdge(result[0]!.inlineData!.data!)).toBeLessThanOrEqual(
      1568,
    );
  });

  it('re-encodes a declined image that fits the visual budget but outweighs the inline ceiling', async () => {
    // The renderer must be handed the caller's byte ceiling, not only the
    // visual budget. 1200x800 fits visually (long edge 1200, 43x29 patches)
    // but stored uncompressed it outweighs a 1 MiB ceiling, while the same
    // frame re-encodes to a few KB of JPEG. Deciding "already fits" on
    // geometry alone returns null here and the trailing clamp then withholds
    // the part instead of keeping the resized image — the producer-side
    // pipeline's rule, mirrored on the decline path.
    vi.stubEnv('QWEN_CODE_MAX_INLINE_MEDIA_BYTES', String(1024 * 1024));
    deliverMock.mockRejectedValue(new Error('upload exploded'));
    const heavy = await solidPng(1200, 800, { compressionLevel: 0 });

    const result = await run([inlinePart('image/png', heavy)]);

    const kept = result[0]!;
    expect(kept.text).toBeUndefined();
    expect(kept.inlineData!.mimeType).toBe('image/jpeg');
    expect(Buffer.from(kept.inlineData!.data!, 'base64').length).toBeLessThan(
      1024 * 1024,
    );
  });

  it('holds a declined audio part to the inline ceiling', async () => {
    // The producer skipped its inline clamp because this funnel takes the
    // bytes over; a part it declines must get that limit here instead.
    vi.stubEnv('QWEN_CODE_MAX_INLINE_MEDIA_BYTES', '1');
    const wav = Buffer.concat([
      Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'),
      Buffer.alloc(64),
    ]);
    const result = await run([inlinePart('audio/wav', wav)], { audio: false });
    expect(deliverMock).not.toHaveBeenCalled();
    expect(result[0]!.text).toContain('[Media omitted: audio/wav');
  });

  it('does not send a declined GIF to the renderer', async () => {
    const bound = vi.spyOn(imageView, 'boundImageBuffer');
    const gif = Buffer.concat([
      Buffer.from('GIF89a', 'latin1'),
      Buffer.alloc(64),
    ]);
    const parts = [inlinePart('image/gif', gif)];
    const result = await run(parts, { image: false });
    expect(bound).not.toHaveBeenCalled();
    expect(result).toBe(parts);
    bound.mockRestore();
  });

  it('propagates an abort instead of degrading the part to inline', async () => {
    // A user abort is not a delivery failure — swallowing it into the
    // keep-inline path would let an aborted turn keep converting parts.
    const controller = new AbortController();
    deliverMock.mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted mid-upload');
    });
    await expect(
      processToolResultOmniMedia(
        [png()],
        cfg({ image: true }),
        controller.signal,
      ),
    ).rejects.toThrow('aborted mid-upload');
  });
});
