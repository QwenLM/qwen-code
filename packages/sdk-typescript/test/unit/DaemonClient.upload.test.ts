/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  DaemonClient,
  DaemonHttpError,
} from '../../src/daemon/DaemonClient.js';
import type { DaemonTransport } from '../../src/daemon/DaemonTransport.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal | null;
}

function recordingFetch(
  reply: (req: CapturedRequest) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = new Headers(init.headers);
        h.forEach((v, k) => (headers[k.toLowerCase()] = v));
      }
      const captured: CapturedRequest = {
        url,
        method: init?.method ?? 'GET',
        headers,
        body: init?.body ?? null,
        signal: init?.signal ?? null,
      };
      calls.push(captured);
      return reply(captured);
    },
  ) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

describe('uploadWorkspaceFile', () => {
  const uploadResult = {
    kind: 'file_upload',
    path: 'blob.bin',
    sizeBytes: 4,
    hash: `sha256:${'d'.repeat(64)}`,
  };

  it('POSTs octet-stream bytes with the path in the query string', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(201, uploadResult),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    await expect(
      client.uploadWorkspaceFile(
        { path: 'blob.bin', data: new Uint8Array([1, 2, 3, 4]) },
        'client-1',
      ),
    ).resolves.toEqual(uploadResult);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('http://daemon/file/upload?path=blob.bin');
    expect(calls[0]?.headers['content-type']).toBe('application/octet-stream');
    expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
  });

  it('uses direct REST when an ACP transport is configured', async () => {
    const { fetch: restFetch, calls } = recordingFetch(() =>
      jsonResponse(201, uploadResult),
    );
    const transportFetch = vi.fn(async () =>
      jsonResponse(404, { error: 'ACP route not found' }),
    );
    const transport: DaemonTransport = {
      type: 'acp-http',
      supportsReplay: true,
      connected: true,
      restFetch,
      fetch: transportFetch,
      async *subscribeEvents() {},
      dispose() {},
    };
    const client = new DaemonClient({ baseUrl: 'http://daemon', transport });

    await expect(
      client.uploadWorkspaceFile({
        path: 'blob.bin',
        data: new Uint8Array([1]),
      }),
    ).resolves.toEqual(uploadResult);
    expect(calls[0]?.url).toBe('http://daemon/file/upload?path=blob.bin');
    expect(transportFetch).not.toHaveBeenCalled();
  });

  it('URL-encodes the path query parameter exactly once', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(201, uploadResult),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    await client.uploadWorkspaceFile({
      path: 'a&b+c=d #1 数据 %b.txt',
      data: new Uint8Array([0]),
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/file/upload');
    expect(url.searchParams.get('path')).toBe('a&b+c=d #1 数据 %b.txt');
  });

  it('sends the raw bytes as the request body', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(201, uploadResult),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const data = new Uint8Array([7, 8, 9]);
    await client.uploadWorkspaceFile({ path: 'a.bin', data });
    expect(calls[0]?.body).toBe(data);
  });

  it('sends Blob bodies untouched on the fetch path', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(201, uploadResult),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const data = new Blob(['blob-bytes']);
    await client.uploadWorkspaceFile({ path: 'a.bin', data });
    expect(calls[0]?.body).toBe(data);
  });

  it('rejects a 2xx fetch response whose JSON body is missing path', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(200, {}));
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    await expect(
      client.uploadWorkspaceFile({
        path: 'a.bin',
        data: new Uint8Array([1]),
      }),
    ).rejects.toThrow(/invalid upload response body/);
  });

  it('rejects a non-JSON 2xx fetch body with the same labeled error as XHR', async () => {
    // Proxy/captive-portal interstitials answer 200 + HTML; both transports
    // must reject with the labeled error (not a bare SyntaxError on fetch).
    const { fetch } = recordingFetch(
      () => new Response('<html>interstitial</html>', { status: 200 }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    await expect(
      client.uploadWorkspaceFile({
        path: 'a.bin',
        data: new Uint8Array([1]),
      }),
    ).rejects.toThrow(/invalid upload response body/);
  });

  it('uses the workspace-qualified route via workspaceByCwd', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(201, uploadResult),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    await client
      .workspaceByCwd('/repo')
      .uploadWorkspaceFile({ path: 'a.bin', data: new Uint8Array([9]) });
    expect(calls[0]?.url).toBe(
      'http://daemon/workspaces/%2Frepo/file/upload?path=a.bin',
    );
  });

  it('preserves the upload 413 error body', async () => {
    const body = {
      errorKind: 'file_too_large',
      error: 'Request body too large (max 50 MiB)',
      status: 413,
      maxBytes: 52428800,
    };
    const { fetch } = recordingFetch(() => jsonResponse(413, body));
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const err = await client
      .uploadWorkspaceFile({ path: 'big.bin', data: new Uint8Array(1) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonHttpError);
    expect((err as DaemonHttpError).status).toBe(413);
    expect((err as DaemonHttpError).body).toEqual(body);
  });

  it('fails before sending when progress is requested without XMLHttpRequest', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(201, uploadResult),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    await expect(
      client.uploadWorkspaceFile({
        path: 'a.bin',
        data: new Uint8Array([1]),
        onProgress: () => {},
      }),
    ).rejects.toThrow(/XMLHttpRequest/);
    expect(calls).toHaveLength(0);
  });

  it('forwards the abort signal to the request', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(201, uploadResult),
    );
    // `fetchTimeoutMs: 0` (the upload production config) skips the timeout
    // signal composition, so the captured signal is exactly the caller's —
    // a dropped `req.signal` would surface as `null` here.
    const client = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch,
      fetchTimeoutMs: 0,
    });
    const ctrl = new AbortController();
    await client.uploadWorkspaceFile({
      path: 'a.bin',
      data: new Uint8Array([1]),
      signal: ctrl.signal,
    });
    expect(calls[0]?.signal).toBe(ctrl.signal);
  });

  it(
    'inherits the client timeout when timeoutMs is omitted',
    // The mock fetch settles only via the abort signal; under the exact
    // regression this test guards (no timeout armed, no signal composed)
    // nothing would abort and the promise would hang into the package
    // testTimeout. A per-test budget fails that shape fast.
    { timeout: 5_000 },
    async () => {
      vi.useFakeTimers();
      try {
        const fetch = vi.fn(
          async (_input: RequestInfo | URL, init?: RequestInit) =>
            await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => reject(init.signal?.reason),
                { once: true },
              );
            }),
        ) as unknown as typeof globalThis.fetch;
        const client = new DaemonClient({
          baseUrl: 'http://daemon',
          fetch,
          fetchTimeoutMs: 25,
        });
        const result = client
          .uploadWorkspaceFile({
            path: 'a.bin',
            data: new Uint8Array([1]),
          })
          .catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(25);
        await expect(result).resolves.toMatchObject({ name: 'TimeoutError' });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('allows timeoutMs 0 to disable the client timeout', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(201, uploadResult),
    );
    const client = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch,
      fetchTimeoutMs: 25,
    });
    await client.uploadWorkspaceFile({
      path: 'a.bin',
      data: new Uint8Array([1]),
      timeoutMs: 0,
    });
    expect(calls[0]?.signal).toBeNull();
  });

  it('applies an explicit timeout to progress uploads', async () => {
    class FakeXMLHttpRequest {
      static latest: FakeXMLHttpRequest | undefined;
      timeout = 0;
      status = 0;
      responseText = '';
      upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;

      constructor() {
        FakeXMLHttpRequest.latest = this;
      }

      open = vi.fn();
      setRequestHeader = vi.fn();
      abort() {
        this.onabort?.();
      }
      send() {
        this.ontimeout?.();
      }
    }

    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    try {
      const client = new DaemonClient({ baseUrl: 'http://daemon' });
      const error = await client
        .uploadWorkspaceFile({
          path: 'a.bin',
          data: new Uint8Array([1]),
          timeoutMs: 17,
          onProgress: () => {},
        })
        .catch((caught: unknown) => caught);

      expect(FakeXMLHttpRequest.latest?.timeout).toBe(17);
      expect(error).toMatchObject({ name: 'TimeoutError' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the XHR timeout disabled for timeoutMs 0 despite the client default', async () => {
    class FakeXMLHttpRequest {
      static latest: FakeXMLHttpRequest | undefined;
      timeout = 0;
      status = 201;
      responseText = JSON.stringify(uploadResult);
      upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;

      constructor() {
        FakeXMLHttpRequest.latest = this;
      }

      open() {}
      setRequestHeader() {}
      abort() {}
      send() {
        this.onload?.();
      }
    }

    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    try {
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetchTimeoutMs: 30_000,
      });
      await client.uploadWorkspaceFile({
        path: 'a.bin',
        data: new Uint8Array([1]),
        timeoutMs: 0,
        onProgress: () => {},
      });
      expect(FakeXMLHttpRequest.latest?.timeout).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe('progress uploads over XMLHttpRequest', () => {
    class FakeXMLHttpRequest {
      static latest: FakeXMLHttpRequest | undefined;
      static sendHook: ((xhr: FakeXMLHttpRequest) => void) | undefined;
      timeout = 0;
      status = 0;
      responseText = '';
      sentBody: unknown = undefined;
      upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open = vi.fn();
      setRequestHeader = vi.fn();

      constructor() {
        FakeXMLHttpRequest.latest = this;
      }

      abort() {
        this.onabort?.();
      }
      send(body?: unknown) {
        this.sentBody = body;
        FakeXMLHttpRequest.sendHook?.(this);
      }
    }

    beforeEach(() => {
      FakeXMLHttpRequest.latest = undefined;
      FakeXMLHttpRequest.sendHook = undefined;
      vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('builds the request and maps upload progress events', async () => {
      const client = new DaemonClient({ baseUrl: 'http://daemon' });
      const data = new Uint8Array([1, 2, 3]);
      const progress: Array<{ loaded: number; total: number }> = [];

      const promise = client.uploadWorkspaceFile(
        {
          path: 'a.bin',
          data,
          onProgress: (event) => progress.push(event),
        },
        'client-1',
      );
      const xhr = FakeXMLHttpRequest.latest!;
      expect(xhr.open).toHaveBeenCalledWith(
        'POST',
        'http://daemon/file/upload?path=a.bin',
      );
      expect(xhr.setRequestHeader).toHaveBeenCalledWith(
        'Content-Type',
        'application/octet-stream',
      );
      expect(xhr.setRequestHeader).toHaveBeenCalledWith(
        'X-Qwen-Client-Id',
        'client-1',
      );
      expect(xhr.sentBody).toBe(data);

      xhr.upload.onprogress?.({
        lengthComputable: true,
        loaded: 2,
        total: 4,
      } as ProgressEvent);
      expect(progress).toEqual([{ loaded: 2, total: 4 }]);
      xhr.upload.onprogress?.({
        lengthComputable: false,
        loaded: 9,
        total: 0,
      } as ProgressEvent);
      expect(progress).toHaveLength(1);

      xhr.status = 201;
      xhr.responseText = JSON.stringify(uploadResult);
      xhr.onload?.();
      await expect(promise).resolves.toEqual(uploadResult);
    });

    it('rejects non-2xx responses with a parsed DaemonHttpError', async () => {
      const body = {
        errorKind: 'file_too_large',
        error: 'Request body too large (max 50 MiB)',
        status: 413,
        maxBytes: 52428800,
      };
      const client = new DaemonClient({ baseUrl: 'http://daemon' });

      const promise = client
        .uploadWorkspaceFile({
          path: 'big.bin',
          data: new Uint8Array([1]),
          onProgress: () => {},
        })
        .catch((caught: unknown) => caught);
      const xhr = FakeXMLHttpRequest.latest!;
      xhr.status = 413;
      xhr.responseText = JSON.stringify(body);
      xhr.onload?.();

      const error = await promise;
      expect(error).toBeInstanceOf(DaemonHttpError);
      expect((error as DaemonHttpError).status).toBe(413);
      expect((error as DaemonHttpError).body).toEqual(body);
    });

    it('rejects network failures', async () => {
      const client = new DaemonClient({ baseUrl: 'http://daemon' });

      const promise = client
        .uploadWorkspaceFile({
          path: 'a.bin',
          data: new Uint8Array([1]),
          onProgress: () => {},
        })
        .catch((caught: unknown) => caught);
      FakeXMLHttpRequest.latest!.onerror?.();

      const error = await promise;
      expect(error).toMatchObject({
        message: expect.stringContaining('network request failed'),
      });
    });

    it('aborts on signal cancellation and detaches the abort listener', async () => {
      const client = new DaemonClient({ baseUrl: 'http://daemon' });
      const ctrl = new AbortController();
      const addSpy = vi.spyOn(ctrl.signal, 'addEventListener');
      const removeSpy = vi.spyOn(ctrl.signal, 'removeEventListener');

      const promise = client
        .uploadWorkspaceFile({
          path: 'a.bin',
          data: new Uint8Array([1]),
          signal: ctrl.signal,
          onProgress: () => {},
        })
        .catch((caught: unknown) => caught);

      ctrl.abort();
      await expect(promise).resolves.toMatchObject({ name: 'AbortError' });
      const registered = addSpy.mock.calls.find(
        ([type]) => type === 'abort',
      )?.[1];
      expect(registered).toBeTypeOf('function');
      expect(removeSpy).toHaveBeenCalledWith('abort', registered);
    });

    it('rejects and cleans up when xhr.send throws synchronously', async () => {
      const client = new DaemonClient({ baseUrl: 'http://daemon' });
      FakeXMLHttpRequest.sendHook = () => {
        throw new Error('detached buffer');
      };
      const ctrl = new AbortController();
      const addSpy = vi.spyOn(ctrl.signal, 'addEventListener');
      const removeSpy = vi.spyOn(ctrl.signal, 'removeEventListener');

      const error = await client
        .uploadWorkspaceFile({
          path: 'a.bin',
          data: new Uint8Array([1]),
          signal: ctrl.signal,
          onProgress: () => {},
        })
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ message: 'detached buffer' });
      const registered = addSpy.mock.calls.find(
        ([type]) => type === 'abort',
      )?.[1];
      expect(registered).toBeTypeOf('function');
      expect(removeSpy).toHaveBeenCalledWith('abort', registered);
    });

    it('detaches the abort listener after a successful upload settles', async () => {
      const client = new DaemonClient({ baseUrl: 'http://daemon' });
      const ctrl = new AbortController();
      const addSpy = vi.spyOn(ctrl.signal, 'addEventListener');
      const removeSpy = vi.spyOn(ctrl.signal, 'removeEventListener');

      const promise = client.uploadWorkspaceFile({
        path: 'a.bin',
        data: new Uint8Array([1]),
        signal: ctrl.signal,
        onProgress: () => {},
      });
      const xhr = FakeXMLHttpRequest.latest!;
      xhr.status = 201;
      xhr.responseText = JSON.stringify(uploadResult);
      xhr.onload?.();

      await expect(promise).resolves.toEqual(uploadResult);
      const registered = addSpy.mock.calls.find(
        ([type]) => type === 'abort',
      )?.[1];
      expect(registered).toBeTypeOf('function');
      expect(removeSpy).toHaveBeenCalledWith('abort', registered);
    });

    it('rejects a pre-aborted signal before constructing an XHR', async () => {
      const client = new DaemonClient({ baseUrl: 'http://daemon' });
      const ctrl = new AbortController();
      ctrl.abort();

      await expect(
        client.uploadWorkspaceFile({
          path: 'a.bin',
          data: new Uint8Array([1]),
          signal: ctrl.signal,
          onProgress: () => {},
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(FakeXMLHttpRequest.latest).toBeUndefined();
    });

    it('propagates the caller abort reason on a pre-aborted signal', async () => {
      const client = new DaemonClient({ baseUrl: 'http://daemon' });
      const sentinel = new Error('sentinel');
      const ctrl = new AbortController();
      ctrl.abort(sentinel);

      await expect(
        client.uploadWorkspaceFile({
          path: 'a.bin',
          data: new Uint8Array([1]),
          signal: ctrl.signal,
          onProgress: () => {},
        }),
      ).rejects.toBe(sentinel);
    });

    it('propagates the caller abort reason through xhr abort', async () => {
      // Matches the fetch transport (AbortSignal.any carries the reason):
      // callers keying on `err === reason` must see the same rejection
      // whether or not progress reporting selected the XHR path.
      const client = new DaemonClient({ baseUrl: 'http://daemon' });
      const sentinel = new Error('sentinel');
      const ctrl = new AbortController();

      const promise = client
        .uploadWorkspaceFile({
          path: 'a.bin',
          data: new Uint8Array([1]),
          signal: ctrl.signal,
          onProgress: () => {},
        })
        .catch((caught: unknown) => caught);
      expect(FakeXMLHttpRequest.latest).toBeDefined();

      ctrl.abort(sentinel);
      await expect(promise).resolves.toBe(sentinel);
    });

    it('rejects a 2xx response with a non-JSON body like the fetch path', async () => {
      const client = new DaemonClient({ baseUrl: 'http://daemon' });

      const promise = client
        .uploadWorkspaceFile({
          path: 'a.bin',
          data: new Uint8Array([1]),
          onProgress: () => {},
        })
        .catch((caught: unknown) => caught);
      const xhr = FakeXMLHttpRequest.latest!;
      xhr.status = 200;
      xhr.responseText = '<html>interstitial</html>';
      xhr.onload?.();

      const error = await promise;
      expect(error).toMatchObject({
        message: expect.stringContaining('invalid upload response body'),
      });
    });

    it('rejects a 2xx response whose JSON body is missing path', async () => {
      const client = new DaemonClient({ baseUrl: 'http://daemon' });

      const promise = client
        .uploadWorkspaceFile({
          path: 'a.bin',
          data: new Uint8Array([1]),
          onProgress: () => {},
        })
        .catch((caught: unknown) => caught);
      const xhr = FakeXMLHttpRequest.latest!;
      xhr.status = 200;
      xhr.responseText = JSON.stringify({});
      xhr.onload?.();

      const error = await promise;
      expect(error).toMatchObject({
        message: expect.stringContaining('invalid upload response body'),
      });
    });

    it('sends Blob bodies untouched on the XHR path', async () => {
      const client = new DaemonClient({ baseUrl: 'http://daemon' });
      const data = new Blob(['blob-bytes']);

      const promise = client.uploadWorkspaceFile({
        path: 'a.bin',
        data,
        onProgress: () => {},
      });
      const xhr = FakeXMLHttpRequest.latest!;
      expect(xhr.sentBody).toBe(data);
      xhr.status = 201;
      xhr.responseText = JSON.stringify(uploadResult);
      xhr.onload?.();
      await expect(promise).resolves.toEqual(uploadResult);
    });

    it('inherits the client timeout on the XHR when timeoutMs is omitted', async () => {
      const client = new DaemonClient({
        baseUrl: 'http://daemon',
        fetchTimeoutMs: 30_000,
      });

      const promise = client.uploadWorkspaceFile({
        path: 'a.bin',
        data: new Uint8Array([1]),
        onProgress: () => {},
      });
      const xhr = FakeXMLHttpRequest.latest!;
      xhr.status = 201;
      xhr.responseText = JSON.stringify(uploadResult);
      xhr.onload?.();

      await expect(promise).resolves.toEqual(uploadResult);
      expect(xhr.timeout).toBe(30_000);
    });
  });
});
