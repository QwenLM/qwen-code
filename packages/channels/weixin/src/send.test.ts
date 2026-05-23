import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { markdownToPlainText } from './send.js';

const {
  mockReadFileSync,
  mockStatSync,
  mockRealpathSync,
  mockGetUploadUrl,
  mockUploadToCdn,
  mockSendMessage,
  mockRandomBytes,
} = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockStatSync: vi.fn(),
  mockRealpathSync: vi.fn((p: string) => p),
  mockGetUploadUrl: vi.fn(),
  mockUploadToCdn: vi.fn(),
  mockSendMessage: vi.fn(),
  mockRandomBytes: vi.fn((size: number) => Buffer.alloc(size, 0x42)),
}));

// PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

vi.mock('node:os', () => ({
  tmpdir: () => '/tmp',
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: mockReadFileSync,
    statSync: mockStatSync,
    realpathSync: mockRealpathSync,
    openSync: vi.fn(() => 42),
    readSync: vi.fn((_fd: number, buf: Buffer) => {
      PNG_HEADER.copy(buf);
      return PNG_HEADER.length;
    }),
    closeSync: vi.fn(),
  };
});

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual };
});

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: mockRandomBytes,
    randomUUID: () => 'test-uuid',
  };
});

vi.mock('./api.js', () => ({
  sendMessage: mockSendMessage,
  getUploadUrl: mockGetUploadUrl,
  uploadToCdn: mockUploadToCdn,
}));

// Use real encryptAesEcb / computeMd5 so tests catch padding mismatches.
const { encryptAesEcb, computeMd5 } =
  await vi.importActual<typeof import('./media.js')>('./media.js');

const { sendImage, detectImageMime, validateImagePath } = await import(
  './send.js'
);

describe('markdownToPlainText', () => {
  it('strips code blocks', () => {
    const input = '```js\nconst x = 1;\n```';
    expect(markdownToPlainText(input)).toBe('const x = 1;');
  });

  it('strips inline code', () => {
    expect(markdownToPlainText('use `npm install`')).toBe('use npm install');
  });

  it('strips bold', () => {
    expect(markdownToPlainText('**bold text**')).toBe('bold text');
  });

  it('strips italic', () => {
    expect(markdownToPlainText('*italic text*')).toBe('italic text');
    expect(markdownToPlainText('_italic text_')).toBe('italic text');
  });

  it('strips bold+italic', () => {
    expect(markdownToPlainText('***bold italic***')).toBe('bold italic');
  });

  it('strips strikethrough', () => {
    expect(markdownToPlainText('~~deleted~~')).toBe('deleted');
  });

  it('strips headings', () => {
    expect(markdownToPlainText('# Title\n## Subtitle')).toBe('Title\nSubtitle');
  });

  it('converts links to text (url)', () => {
    expect(markdownToPlainText('[click here](https://example.com)')).toBe(
      'click here (https://example.com)',
    );
  });

  it('converts image syntax (link regex fires before image regex)', () => {
    // In the current implementation, the link regex fires before the image regex,
    // so `![alt](url)` becomes `!alt (url)` rather than `[alt]`
    const result = markdownToPlainText('![alt](https://img.png)');
    expect(result).toBe('!alt (https://img.png)');
  });

  it('strips blockquote markers', () => {
    expect(markdownToPlainText('> quoted text')).toBe('quoted text');
  });

  it('normalizes list markers', () => {
    expect(markdownToPlainText('* item 1\n- item 2')).toBe(
      '- item 1\n- item 2',
    );
  });

  it('collapses triple+ newlines', () => {
    expect(markdownToPlainText('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('trims result', () => {
    expect(markdownToPlainText('  \n hello \n  ')).toBe('hello');
  });

  it('handles double underscore bold', () => {
    expect(markdownToPlainText('__bold__')).toBe('bold');
  });

  it('handles complex markdown', () => {
    const input = '# Title\n\n**Bold** and *italic* with `code`\n\n> quote';
    const result = markdownToPlainText(input);
    expect(result).toContain('Title');
    expect(result).toContain('Bold');
    expect(result).toContain('italic');
    expect(result).toContain('code');
    expect(result).toContain('quote');
    expect(result).not.toContain('#');
    expect(result).not.toContain('**');
    expect(result).not.toContain('`');
  });
});

describe('detectImageMime', () => {
  it('detects PNG magic bytes', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    expect(detectImageMime(buf)).toBe('image/png');
  });

  it('detects GIF magic bytes', () => {
    const buf = Buffer.from([0x47, 0x49, 0x46]);
    expect(detectImageMime(buf)).toBe('image/gif');
  });

  it('detects WebP magic bytes (RIFF)', () => {
    const buf = Buffer.from([0x52, 0x49, 0x46, 0x46]);
    expect(detectImageMime(buf)).toBe('image/webp');
  });

  it('detects JPEG magic bytes', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff]);
    expect(detectImageMime(buf)).toBe('image/jpeg');
  });

  it('throws for unrecognized magic bytes', () => {
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    expect(() => detectImageMime(buf)).toThrow('Unrecognized image format');
  });
});

describe('validateImagePath', () => {
  const workspaceDirs = ['/home/user/project'];

  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mock behaviour: identity pass-through for realpath,
    // regular file, small size, PNG magic in readSync.
    mockRealpathSync.mockImplementation((p: string) => p);
    mockStatSync.mockReturnValue({
      isFile: () => true,
      size: 100,
    } as unknown as ReturnType<(typeof fs)['statSync']>);
    vi.mocked(fs.readSync).mockImplementation((_fd: number, buf: Buffer) => {
      PNG_HEADER.copy(buf);
      return PNG_HEADER.length;
    });
  });

  it('rejects disallowed extensions', () => {
    expect(() =>
      validateImagePath('/tmp/screenshot.txt', workspaceDirs),
    ).toThrow('Image extension not allowed');
  });

  it('rejects non-existent files', () => {
    mockRealpathSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });
    expect(() => validateImagePath('/tmp/missing.png', workspaceDirs)).toThrow(
      'Image file not found',
    );
  });

  it('rejects non-regular files (directories etc.)', () => {
    mockStatSync.mockReturnValue({
      isFile: () => false,
      size: 0,
    } as unknown as ReturnType<(typeof fs)['statSync']>);
    expect(() => validateImagePath('/tmp/some-dir.png', workspaceDirs)).toThrow(
      'Not a regular file',
    );
  });

  it('rejects files exceeding 20 MB cap', () => {
    mockStatSync.mockReturnValue({
      isFile: () => true,
      size: 21 * 1024 * 1024,
    } as unknown as ReturnType<(typeof fs)['statSync']>);
    expect(() => validateImagePath('/tmp/huge.png', workspaceDirs)).toThrow(
      'Image too large',
    );
  });

  it('rejects paths outside allowed directories', () => {
    mockRealpathSync.mockImplementation((p: string) => p);
    expect(() => validateImagePath('/etc/passwd.png', workspaceDirs)).toThrow(
      'Image path outside allowed directories',
    );
  });

  it('rejects image with magic bytes that do not match extension', () => {
    // readSync returns JPEG magic, but file extension is .png
    vi.mocked(fs.readSync).mockImplementation((_fd: number, buf: Buffer) => {
      const jpegMagic = Buffer.from([0xff, 0xd8, 0xff]);
      jpegMagic.copy(buf);
      return jpegMagic.length;
    });
    expect(() =>
      validateImagePath('/tmp/actually-jpeg.png', workspaceDirs),
    ).toThrow('Image type mismatch');
  });

  it('returns resolved realpath on success', () => {
    mockRealpathSync.mockImplementation((p: string) => `/private${p}`);
    const result = validateImagePath('/tmp/photo.png', workspaceDirs);
    expect(result).toBe('/private/tmp/photo.png');
  });
});

describe('sendImage', () => {
  const defaultParams = {
    to: 'user-123',
    imagePath: '/tmp/test.png',
    baseUrl: 'https://api.example.com',
    token: 'token-abc',
    contextToken: 'ctx-456',
    workspaceDirs: ['/home/user/project'],
  };

  const fakeImageData = Buffer.concat([
    PNG_HEADER,
    Buffer.from('fake-image-bytes'),
  ]);

  beforeEach(() => {
    vi.clearAllMocks();
    // statSync: must be a regular file under file size limit
    mockStatSync.mockReturnValue({
      isFile: () => true,
      size: fakeImageData.length,
    } as unknown as ReturnType<(typeof import('node:fs'))['statSync']>);
    // realpathSync: identity pass-through (restore default after
    // validateImagePath tests may have overridden it).
    mockRealpathSync.mockImplementation((p: string) => p);
    // readFileSync: returns PNG-headed data for MIME check + full read
    mockReadFileSync.mockReturnValue(fakeImageData);
  });

  it('completes the four-step upload and send flow', async () => {
    mockGetUploadUrl.mockResolvedValue('upload-param-value');
    mockUploadToCdn.mockResolvedValue('cdn-encrypt-param');
    mockSendMessage.mockResolvedValue(undefined);

    await sendImage(defaultParams);

    // Step 1: validateImagePath uses openSync/readSync for magic-byte
    // check (only 16 bytes), then sendImage calls readFileSync for
    // full file read.
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
    expect(mockReadFileSync).toHaveBeenCalledWith('/tmp/test.png');

    // Step 2: get upload URL called with correct params
    const encryptedSize = Math.ceil((fakeImageData.length + 1) / 16) * 16;
    const expectedFilekey = '42424242424242424242424242424242';
    const expectedAesKeyHex = '42424242424242424242424242424242';
    expect(mockGetUploadUrl).toHaveBeenCalledWith(
      'https://api.example.com',
      'token-abc',
      'user-123',
      expectedFilekey,
      fakeImageData.length,
      computeMd5(fakeImageData),
      encryptedSize,
      expectedAesKeyHex,
    );

    // Step 3: upload to CDN (with real encryptAesEcb output)
    const aesKeyBytes = Buffer.alloc(16, 0x42);
    const expectedEncrypted = encryptAesEcb(fakeImageData, aesKeyBytes);
    expect(mockUploadToCdn).toHaveBeenCalledWith(
      'upload-param-value',
      expectedFilekey,
      expectedEncrypted,
    );

    // Step 4: send message with image_item using CDN's x-encrypted-param
    const expectedAesKeyBase64 = aesKeyBytes.toString('base64');
    expect(mockSendMessage).toHaveBeenCalledWith(
      'https://api.example.com',
      'token-abc',
      expect.objectContaining({
        to_user_id: 'user-123',
        context_token: 'ctx-456',
        item_list: [
          expect.objectContaining({
            type: 2, // MessageItemType.IMAGE
            image_item: expect.objectContaining({
              media: {
                encrypt_query_param: 'cdn-encrypt-param',
                aes_key: expectedAesKeyBase64,
                encrypt_type: 1,
              },
            }),
          }),
        ],
      }),
    );
  });

  it('propagates getUploadUrl errors', async () => {
    mockReadFileSync.mockReturnValue(fakeImageData);
    mockGetUploadUrl.mockRejectedValue(new Error('Auth expired'));

    await expect(sendImage(defaultParams)).rejects.toThrow('Auth expired');
    expect(mockUploadToCdn).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('propagates upload errors', async () => {
    mockReadFileSync.mockReturnValue(fakeImageData);
    mockGetUploadUrl.mockResolvedValue('upload-param-value');
    mockUploadToCdn.mockRejectedValue(new Error('CDN unavailable'));

    await expect(sendImage(defaultParams)).rejects.toThrow('CDN unavailable');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});
