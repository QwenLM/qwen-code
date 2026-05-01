import { describe, it, expect, vi } from 'vitest';
import { markdownToPlainText } from './send.js';

const {
  mockReadFileSync,
  mockGetUploadUrl,
  mockUploadToCdn,
  mockSendMessage,
  mockRandomBytes,
} = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockGetUploadUrl: vi.fn(),
  mockUploadToCdn: vi.fn(),
  mockSendMessage: vi.fn(),
  mockRandomBytes: vi.fn((size: number) => Buffer.alloc(size, 0x42)),
}));

vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
}));

vi.mock('node:crypto', () => ({
  randomBytes: mockRandomBytes,
  randomUUID: () => 'test-uuid',
}));

vi.mock('./api.js', () => ({
  sendMessage: mockSendMessage,
  getUploadUrl: mockGetUploadUrl,
  uploadToCdn: mockUploadToCdn,
}));

vi.mock('./media.js', () => ({
  encryptAesEcb: vi.fn((data: Buffer) => data),
  computeMd5: vi.fn(() => 'd41d8cd98f00b204e9800998ecf8427e'),
}));

const { sendImage } = await import('./send.js');

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

describe('sendImage', () => {
  const defaultParams = {
    to: 'user-123',
    imagePath: '/tmp/test.png',
    baseUrl: 'https://api.example.com',
    token: 'token-abc',
    contextToken: 'ctx-456',
  };

  const fakeImageData = Buffer.from('fake-image-bytes');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('completes the four-step upload and send flow', async () => {
    mockReadFileSync.mockReturnValue(fakeImageData);
    mockGetUploadUrl.mockResolvedValue('upload-param-value');
    mockUploadToCdn.mockResolvedValue('cdn-encrypt-param');
    mockSendMessage.mockResolvedValue(undefined);

    await sendImage(defaultParams);

    // Step 1: read file
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
      'd41d8cd98f00b204e9800998ecf8427e',
      encryptedSize,
      expectedAesKeyHex,
    );

    // Step 3: upload to CDN (uploadToCdn takes urlOrParam, filekey, encryptedData)
    expect(mockUploadToCdn).toHaveBeenCalledWith(
      'upload-param-value',
      expectedFilekey,
      fakeImageData,
    );

    // Step 4: send message with image_item using CDN's x-encrypted-param
    const expectedAesKeyBase64 = Buffer.from(
      '42424242424242424242424242424242',
      'ascii',
    ).toString('base64');
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
