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

describe('downloadMedia (DingTalk)', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // First fetch is the DingTalk download-code API that returns a downloadUrl;
  // the second fetch is the actual file download that the size cap guards.
  function mockApiResponse(
    downloadUrl = 'https://dl.dingtalk.example/file',
  ): Response {
    return {
      ok: true,
      json: vi.fn().mockResolvedValue({ downloadUrl }),
    } as unknown as Response;
  }

  it('downloads a file within the size limit', async () => {
    const mockData = new Uint8Array([1, 2, 3, 4]);
    const fileResp = {
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

    fetchSpy
      .mockResolvedValueOnce(mockApiResponse())
      .mockResolvedValueOnce(fileResp as unknown as Response);

    const result = await downloadMedia('code', 'robot', 'token');

    expect(result).not.toBeNull();
    expect(result?.buffer).toEqual(Buffer.from(mockData));
    expect(result?.mimeType).toBe('image/png');
  });

  it('rejects a Content-Length exceeding 50MB and releases the connection', async () => {
    const largeSize = 60 * 1024 * 1024; // 60 MB
    const bodyCancel = vi.fn();
    const fileResp = {
      ok: true,
      headers: {
        get: (key: string) =>
          key === 'content-length' ? largeSize.toString() : null,
      },
      body: {
        cancel: bodyCancel,
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
          cancel: vi.fn(),
        }),
      },
    };

    fetchSpy
      .mockResolvedValueOnce(mockApiResponse())
      .mockResolvedValueOnce(fileResp as unknown as Response);

    const result = await downloadMedia('code', 'robot', 'token');

    expect(result).toBeNull();
    expect(bodyCancel).toHaveBeenCalled();
  });

  it('rejects a stream exceeding 50MB with no Content-Length header', async () => {
    const chunkSize = 10 * 1024 * 1024; // 10 MB per chunk
    const mockData = new Uint8Array(chunkSize);
    const cancelMock = vi.fn();
    const fileResp = {
      ok: true,
      headers: {
        get: () => null, // no content-length → must be caught while streaming
      },
      body: {
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: false, value: mockData }), // never ends
          cancel: cancelMock,
        }),
      },
    };

    fetchSpy
      .mockResolvedValueOnce(mockApiResponse())
      .mockResolvedValueOnce(fileResp as unknown as Response);

    const result = await downloadMedia('code', 'robot', 'token');

    expect(result).toBeNull();
    expect(cancelMock).toHaveBeenCalled();
  });

  it('returns null when the file response body is null', async () => {
    const fileResp = {
      ok: true,
      headers: { get: () => null },
      body: null,
    };

    fetchSpy
      .mockResolvedValueOnce(mockApiResponse())
      .mockResolvedValueOnce(fileResp as unknown as Response);

    const result = await downloadMedia('code', 'robot', 'token');

    expect(result).toBeNull();
  });
});
