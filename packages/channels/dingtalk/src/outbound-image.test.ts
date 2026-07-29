import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DingTalkMediaUploadError,
  findImageMarkers,
  readValidatedImage,
  replaceImageMarkers,
  sanitizeStreamingImageMarkers,
  uploadDingTalkImage,
} from './outbound-image.js';

const PNG_DATA = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

const testDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  testDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('outbound image markers', () => {
  it('finds markers outside fenced and inline code', () => {
    const text = [
      'before',
      '[IMAGE: /tmp/real.png]',
      '```text',
      '[IMAGE: /tmp/fenced.png]',
      '```',
      '`[IMAGE: /tmp/inline.png]`',
      '``[IMAGE: /tmp/double-inline.png]``',
      'after',
    ].join('\n');

    const markers = findImageMarkers(text);

    expect(markers).toEqual([
      expect.objectContaining({ path: '/tmp/real.png' }),
    ]);
    expect(replaceImageMarkers(text, markers, ['![image](media-id)'])).toBe(
      [
        'before',
        '![image](media-id)',
        '```text',
        '[IMAGE: /tmp/fenced.png]',
        '```',
        '`[IMAGE: /tmp/inline.png]`',
        '``[IMAGE: /tmp/double-inline.png]``',
        'after',
      ].join('\n'),
    );
  });

  it('replaces repeated markers by source position', () => {
    const text = [
      '`[IMAGE: /tmp/same.png]`',
      '[IMAGE: /tmp/same.png]',
      '[IMAGE: /tmp/same.png]',
    ].join('\n');
    const markers = findImageMarkers(text);

    expect(replaceImageMarkers(text, markers, ['first', 'second'])).toBe(
      ['`[IMAGE: /tmp/same.png]`', 'first', 'second'].join('\n'),
    );
  });
});

describe('streaming image markers', () => {
  it('hides complete and incomplete visible image paths', () => {
    expect(
      sanitizeStreamingImageMarkers(
        'before [IMAGE: /Users/ben/private/image.png] after',
      ),
    ).toBe('before [Image pending] after');
    expect(
      sanitizeStreamingImageMarkers('before [IMAGE: /Users/ben/private/image'),
    ).toBe('before [Image pending]');
    expect(
      sanitizeStreamingImageMarkers('before [IMAGE: /Users/ben/[private/image'),
    ).toBe('before [Image pending]');
  });

  it('preserves image-like text inside code', () => {
    expect(
      sanitizeStreamingImageMarkers(
        [
          '`[IMAGE: /Users/ben/inline.png]`',
          '```text',
          '[IMAGE: /Users/ben/fenced.png]',
          '```',
        ].join('\n'),
      ),
    ).toBe(
      [
        '`[IMAGE: /Users/ben/inline.png]`',
        '```text',
        '[IMAGE: /Users/ben/fenced.png]',
        '```',
      ].join('\n'),
    );
  });
});

describe('readValidatedImage', () => {
  it('reads a regular image inside the workspace', () => {
    const workspace = makeTempDir('dingtalk-image-workspace-');
    const imagePath = join(workspace, 'image.png');
    writeFileSync(imagePath, PNG_DATA);

    expect(
      readValidatedImage(imagePath, {
        workspaceDir: workspace,
        temporaryDir: workspace,
      }),
    ).toMatchObject({
      fileName: 'image.png',
      mimeType: 'image/png',
      data: PNG_DATA,
    });
  });

  it('rejects a symlink that escapes the allowed directories', () => {
    const workspace = makeTempDir('dingtalk-image-workspace-');
    const outside = makeTempDir('dingtalk-image-outside-');
    const outsideImage = join(outside, 'outside.png');
    const linkedImage = join(workspace, 'linked.png');
    writeFileSync(outsideImage, PNG_DATA);
    symlinkSync(outsideImage, linkedImage);

    expect(() =>
      readValidatedImage(linkedImage, {
        workspaceDir: workspace,
        temporaryDir: workspace,
      }),
    ).toThrow('outside allowed directories');
  });

  it('rejects extension and content mismatches', () => {
    const workspace = makeTempDir('dingtalk-image-workspace-');
    const imagePath = join(workspace, 'image.jpg');
    writeFileSync(imagePath, PNG_DATA);

    expect(() =>
      readValidatedImage(imagePath, {
        workspaceDir: workspace,
        temporaryDir: workspace,
      }),
    ).toThrow('Image type mismatch');
  });

  it('rejects directories', () => {
    const workspace = makeTempDir('dingtalk-image-workspace-');
    const imagePath = join(workspace, 'image.png');
    mkdirSync(imagePath);

    expect(() =>
      readValidatedImage(imagePath, {
        workspaceDir: workspace,
        temporaryDir: workspace,
      }),
    ).toThrow('Not a regular file');
  });

  it('rejects images larger than the upload limit before reading them', () => {
    const workspace = makeTempDir('dingtalk-image-workspace-');
    const imagePath = join(workspace, 'image.png');
    writeFileSync(imagePath, PNG_DATA);
    truncateSync(imagePath, 20 * 1024 * 1024 + 1);

    expect(() =>
      readValidatedImage(imagePath, {
        workspaceDir: workspace,
        temporaryDir: workspace,
      }),
    ).toThrow('Image too large');
  });
});

describe('uploadDingTalkImage', () => {
  it('uploads a validated image and returns its MediaID', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ errcode: 0, media_id: '@lAL-test-media-id' }),
          { status: 200 },
        ),
      );

    await expect(
      uploadDingTalkImage(
        {
          data: PNG_DATA,
          fileName: 'image.png',
          mimeType: 'image/png',
        },
        'access-token',
      ),
    ).resolves.toBe('@lAL-test-media-id');

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/media/upload?');
    expect(String(url)).toContain('type=image');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    const media = (init?.body as FormData).get('media');
    expect(media).toBeInstanceOf(Blob);
    expect((media as File).name).toBe('image.png');
  });

  it.each([40014, 42001])(
    'marks DingTalk token error %s as retryable authentication failure',
    async (errcode) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ errcode, errmsg: 'expired' }), {
          status: 200,
        }),
      );

      const request = uploadDingTalkImage(
        {
          data: PNG_DATA,
          fileName: 'image.png',
          mimeType: 'image/png',
        },
        'access-token',
      );

      await expect(request).rejects.toMatchObject({
        name: DingTalkMediaUploadError.name,
        authFailure: true,
      });
    },
  );

  it('does not include the access token in upload errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          errcode: 40035,
          errmsg: 'invalid secret-access-token',
        }),
        { status: 200 },
      ),
    );

    await expect(
      uploadDingTalkImage(
        {
          data: PNG_DATA,
          fileName: 'image.png',
          mimeType: 'image/png',
        },
        'secret-access-token',
      ),
    ).rejects.not.toThrow(/secret-access-token/);
  });

  it('does not include a credential-bearing request URL in network errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error(
        'request to https://oapi.dingtalk.com/media/upload?access_token=secret-access-token failed',
      ),
    );

    await expect(
      uploadDingTalkImage(
        {
          data: PNG_DATA,
          fileName: 'image.png',
          mimeType: 'image/png',
        },
        'secret-access-token',
      ),
    ).rejects.not.toThrow(/secret-access-token/);
  });
});
