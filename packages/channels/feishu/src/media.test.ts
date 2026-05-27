import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import { downloadMedia } from './media.js';

describe('downloadMedia', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('should download file successfully', async () => {
    const mockData = new Uint8Array([1, 2, 3, 4]);
    const mockResponse = {
      ok: true,
      headers: {
        get: (key: string) => {
          if (key === 'content-length') return '4';
          if (key === 'content-type') return 'image/png';
          return null;
        },
      },
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: mockData })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          cancel: vi.fn(),
        }),
      },
    };

    fetchSpy.mockResolvedValueOnce(mockResponse as unknown as Response);

    const result = await downloadMedia(
      'om_valid_msg',
      'file_valid_key',
      'image',
      'valid_token',
    );

    expect(result).not.toBeNull();
    expect(result?.buffer).toEqual(Buffer.from(mockData));
    expect(result?.mimeType).toBe('image/png');
  });

  it('should reject invalid messageId (path traversal)', async () => {
    const result = await downloadMedia(
      '../../../etc/passwd',
      'file_key',
      'file',
      'token',
    );

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should reject invalid fileKey (path traversal)', async () => {
    const result = await downloadMedia(
      'om_msg',
      '../../../etc/passwd',
      'file',
      'token',
    );

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should reject empty parameters', async () => {
    expect(await downloadMedia('', 'file_key', 'file', 'token')).toBeNull();
    expect(await downloadMedia('om_msg', '', 'file', 'token')).toBeNull();
    expect(await downloadMedia('om_msg', 'file_key', 'file', '')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should return null on HTTP error', async () => {
    const mockResponse = {
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue('Not found'),
    };

    fetchSpy.mockResolvedValueOnce(mockResponse as unknown as Response);

    const result = await downloadMedia('om_msg', 'file_key', 'file', 'token');

    expect(result).toBeNull();
  });

  it('should reject Content-Length exceeding 50MB', async () => {
    const largeSize = 60 * 1024 * 1024; // 60 MB
    const mockResponse = {
      ok: true,
      headers: {
        get: (key: string) => {
          if (key === 'content-length') return largeSize.toString();
          return null;
        },
      },
      body: {
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
          cancel: vi.fn(),
        }),
      },
    };

    fetchSpy.mockResolvedValueOnce(mockResponse as unknown as Response);

    const result = await downloadMedia('om_msg', 'file_key', 'file', 'token');

    expect(result).toBeNull();
  });

  it('should reject stream exceeding 50MB', async () => {
    const chunkSize = 10 * 1024 * 1024; // 10 MB per chunk
    const mockData = new Uint8Array(chunkSize);
    const cancelMock = vi.fn();
    const mockResponse = {
      ok: true,
      headers: {
        get: () => null, // No content-length header
      },
      body: {
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: false, value: mockData }), // Infinite stream
          cancel: cancelMock,
        }),
      },
    };

    fetchSpy.mockResolvedValueOnce(mockResponse as unknown as Response);

    const result = await downloadMedia('om_msg', 'file_key', 'file', 'token');

    expect(result).toBeNull();
    expect(cancelMock).toHaveBeenCalled();
  });

  it('should return null when response body is null', async () => {
    const mockResponse = {
      ok: true,
      headers: {
        get: () => null,
      },
      body: null,
    };

    fetchSpy.mockResolvedValueOnce(mockResponse as unknown as Response);

    const result = await downloadMedia('om_msg', 'file_key', 'file', 'token');

    expect(result).toBeNull();
  });

  it('should handle network errors', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('Network error'));

    const result = await downloadMedia('om_msg', 'file_key', 'file', 'token');

    expect(result).toBeNull();
  });

  it('should handle missing content-type header', async () => {
    const mockData = new Uint8Array([1, 2, 3]);
    const mockResponse = {
      ok: true,
      headers: {
        get: () => null, // No content-type
      },
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: mockData })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          cancel: vi.fn(),
        }),
      },
    };

    fetchSpy.mockResolvedValueOnce(mockResponse as unknown as Response);

    const result = await downloadMedia('om_msg', 'file_key', 'file', 'token');

    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe('application/octet-stream'); // Default
  });
});
