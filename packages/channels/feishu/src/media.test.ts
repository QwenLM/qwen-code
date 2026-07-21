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

  it('should reject Content-Length exceeding 50MB and release the body', async () => {
    const largeSize = 60 * 1024 * 1024; // 60 MB
    const bodyCancel = vi.fn();
    const mockResponse = {
      ok: true,
      headers: {
        get: (key: string) => {
          if (key === 'content-length') return largeSize.toString();
          return null;
        },
      },
      body: {
        cancel: bodyCancel,
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
          cancel: vi.fn(),
        }),
      },
    };

    fetchSpy.mockResolvedValueOnce(mockResponse as unknown as Response);

    const result = await downloadMedia('om_msg', 'file_key', 'file', 'token');

    expect(result).toBeNull();
    // The oversized body is cancelled to release the connection instead of
    // being left dangling until GC.
    expect(bodyCancel).toHaveBeenCalled();
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

  it('awaits reader.cancel() so a failing stream teardown is caught, not leaked', async () => {
    const chunkSize = 10 * 1024 * 1024; // 10 MB per read; crosses 50MB on the 6th
    const mockData = new Uint8Array(chunkSize);
    // A stream whose cancel() rejects during teardown. Because the fixed code
    // AWAITS reader.cancel(), this rejection propagates into downloadMedia's
    // own catch (logging "downloadMedia error: …"). With the previous
    // un-awaited call the rejection floated free as an unhandled rejection and
    // the code instead ran the "rejected: actual size exceeds" branch — so
    // asserting on which branch logged deterministically pins the await.
    const cancelMock = vi
      .fn()
      .mockRejectedValue(new Error('reader teardown failed'));
    const mockResponse = {
      ok: true,
      headers: {
        get: () => null, // no content-length -> exercise the stream-size path
      },
      body: {
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: false, value: mockData }),
          cancel: cancelMock,
        }),
      },
    };

    fetchSpy.mockResolvedValueOnce(mockResponse as unknown as Response);

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const result = await downloadMedia('om_msg', 'file_key', 'file', 'token');

      expect(result).toBeNull();
      expect(cancelMock).toHaveBeenCalledTimes(1);
      const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(logged).toContain('downloadMedia error');
      expect(logged).toContain('reader teardown failed');
    } finally {
      stderrSpy.mockRestore();
    }
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
