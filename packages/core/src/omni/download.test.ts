/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import type { AddressInfo, LookupFunction } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { downloadMediaUrl, OmniDownloadError } from './download.js';

// Keep the suite hermetic: the SSRF gate resolves hostnames, and tests that do
// not inject a fake target must not depend on (or wait for) real DNS.
const dnsLookupMock = vi.hoisted(() =>
  vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
);
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return { ...actual, promises: { ...actual.promises, lookup: dnsLookupMock } };
});

/**
 * A pinned target of the shape resolveNetworkTarget returns: `lookup` answers
 * with `address` regardless of the hostname asked for, which is what binds the
 * connection. Tests that only need the gate's verdict never reach it.
 */
function pinnedTarget(url: string, address = '93.184.216.34') {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family: 4 }]);
    } else {
      callback(null, address, 4);
    }
  };
  return { url: new URL(url), lookup };
}

/**
 * Ask a request's dispatcher where it is pinned, by invoking the `connect.lookup`
 * it was built with. Asserting on the resolved address (rather than merely that
 * a dispatcher exists) is what makes the pinning tests fail if the lookup is
 * missing or points somewhere else.
 */
async function pinnedAddressOf(init: RequestInit | undefined): Promise<string> {
  const dispatcher = (init as { dispatcher?: unknown } | undefined)?.dispatcher;
  if (!dispatcher) return 'NO-DISPATCHER';
  const lookup = dispatcher as {
    // undici stores constructor options on a symbol-keyed internal; read the
    // connect options back off it rather than reaching into private fields.
    [key: symbol]: unknown;
  };
  const options = Object.getOwnPropertySymbols(lookup)
    .map((s) => lookup[s])
    .find(
      (v): v is { connect?: { lookup?: LookupFunction } } =>
        typeof v === 'object' && v !== null && 'connect' in v,
    );
  const fn = options?.connect?.lookup;
  if (!fn) return 'NO-LOOKUP';
  return new Promise<string>((resolve) => {
    fn('media.example.com', { all: false }, (err, address) =>
      resolve(err ? `ERR:${err.message}` : String(address)),
    );
  });
}

let downloadsDir: string;

beforeEach(async () => {
  downloadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-dl-'));
});

afterEach(async () => {
  await fs.rm(downloadsDir, { recursive: true, force: true });
});

function fetchOk(
  body: Buffer | string,
  headers: Record<string, string> = {},
): typeof fetch {
  return vi.fn(async () => new Response(body, { status: 200, headers }));
}

async function listParts(): Promise<string[]> {
  return (await fs.readdir(downloadsDir)).filter((f) => f.endsWith('.part'));
}

describe('downloadMediaUrl', () => {
  it('streams to a .part file and hashes while writing', async () => {
    const bytes = Buffer.from('media-bytes-here');
    const result = await downloadMediaUrl({
      url: 'https://media.example.com/a.mp4',
      downloadsDir,
      maxBytes: 1_000_000,
      fetchFn: fetchOk(bytes, { 'content-type': 'video/mp4' }),
    });
    expect(result.sha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    expect(result.sizeBytes).toBe(bytes.length);
    expect(result.contentType).toBe('video/mp4');
    await expect(fs.readFile(result.partPath)).resolves.toEqual(bytes);
  });

  it('refuses private/loopback hosts (SSRF)', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    for (const url of [
      'http://127.0.0.1:8734/x.mp4',
      'http://localhost:8734/x.mp4',
      'http://10.0.0.5/x.mp4',
      'http://internal.lan/x.mp4',
    ]) {
      await expect(
        downloadMediaUrl({ url, downloadsDir, maxBytes: 1000, fetchFn }),
      ).rejects.toThrow(/not publicly routable/);
    }
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await listParts()).toEqual([]);
  });

  it('refuses a public-looking host that resolves to a private address', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    // DNS rebinding / split horizon: the name is syntactically public, so the
    // text-level gate passes; only resolution reveals the target.
    for (const address of ['127.0.0.1', '169.254.169.254', '10.1.2.3']) {
      dnsLookupMock.mockResolvedValueOnce([{ address, family: 4 }]);
      await expect(
        downloadMediaUrl({
          url: 'https://media.example.com/clip.mp4',
          downloadsDir,
          maxBytes: 1_000_000,
          fetchFn,
        }),
      ).rejects.toThrow(/refused for safety/);
    }
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await listParts()).toEqual([]);
  });

  it('refuses a public-looking host that resolves to a private IPv6 address', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    // Without these the suite would stay green under a classifier that fails
    // open on IPv6: loopback, link-local (incl. the fe80 metadata analogue),
    // ULA, and the IPv4-mapped form of a private IPv4.
    for (const address of ['::1', 'fe80::1', 'fd00::2', '::ffff:10.0.0.5']) {
      dnsLookupMock.mockResolvedValueOnce([{ address, family: 6 }]);
      await expect(
        downloadMediaUrl({
          url: 'https://media.example.com/clip.mp4',
          downloadsDir,
          maxBytes: 1_000_000,
          fetchFn,
        }),
      ).rejects.toThrow(/refused for safety/);
    }
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await listParts()).toEqual([]);
  });

  it('accepts a host resolving to a public IPv6 address', async () => {
    // The acceptance counterpart: proves the IPv6 refusals above come from
    // classification rather than from IPv6 being rejected wholesale.
    const bytes = Buffer.from('v6-ok');
    dnsLookupMock.mockResolvedValueOnce([
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    const result = await downloadMediaUrl({
      url: 'https://media.example.com/clip.mp4',
      downloadsDir,
      maxBytes: 1_000_000,
      fetchFn: fetchOk(bytes),
    });
    expect(result.sizeBytes).toBe(bytes.length);
  });

  it('refuses when ANY resolved address is private (mixed A records)', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    // The connect may pick either address, so one bad entry is fatal.
    dnsLookupMock.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(
      downloadMediaUrl({
        url: 'https://media.example.com/clip.mp4',
        downloadsDir,
        maxBytes: 1_000_000,
        fetchFn,
      }),
    ).rejects.toThrow(/refused for safety/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fails closed when the host cannot be resolved', async () => {
    // Reversal of the old fail-open behavior: bytes from an unverifiable host
    // are uploaded to a third party, so "cannot verify" must mean "refuse",
    // not "connect and let the socket report it".
    const fetchFn = vi.fn<typeof fetch>();
    dnsLookupMock.mockRejectedValueOnce(
      Object.assign(new Error('EAI_AGAIN'), { code: 'EAI_AGAIN' }),
    );
    await expect(
      downloadMediaUrl({
        url: 'https://media.example.com/a.mp4',
        downloadsDir,
        maxBytes: 1_000_000,
        fetchFn,
      }),
    ).rejects.toThrow(/could not be verified/);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await listParts()).toEqual([]);
  });

  it('refuses a target that cannot be pinned to a vetted address', async () => {
    // If the resolve step yields no pinned lookup, the connection cannot be
    // bound, so claiming rebinding protection would be false. Refuse instead.
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      downloadMediaUrl({
        url: 'https://media.example.com/a.mp4',
        downloadsDir,
        maxBytes: 1_000_000,
        fetchFn,
        resolveTarget: async (u) => ({ url: new URL(u) }),
      }),
    ).rejects.toThrow(/cannot be safely bound/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses plaintext http URLs', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      downloadMediaUrl({
        url: 'http://media.example.com/a.mp4',
        downloadsDir,
        maxBytes: 1_000_000,
        fetchFn,
      }),
    ).rejects.toThrow(/must be https/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('allows a host resolving to public addresses', async () => {
    const result = await downloadMediaUrl({
      url: 'https://media.example.com/a.mp4',
      downloadsDir,
      maxBytes: 1_000_000,
      fetchFn: fetchOk(Buffer.from('ok-bytes')),
      resolveTarget: async (u) => pinnedTarget(u),
    });
    expect(result.sizeBytes).toBe(8);
  });

  it('pins the connection to the vetted address (real socket)', async () => {
    // The regression test for the check-then-connect hole: a preflight-only
    // gate lets `fetch` re-resolve the name, so this asserts the socket is
    // actually opened to the address the gate approved — through the real
    // undici agent, with no fetchFn injected.
    //
    // `pinned.invalid` has no DNS record (RFC 6761 guarantees .invalid never
    // resolves), so an inbound connection can ONLY have come from the pin. The
    // TLS handshake then fails against this plain TCP listener, which is fine:
    // the assertion is where the connect went, not that it completed. Dropping
    // the dispatcher would make this ENOTFOUND with zero connections.
    const connections: string[] = [];
    const server = net.createServer((socket) => {
      connections.push(socket.remoteAddress ?? '');
      socket.destroy();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const { port } = server.address() as AddressInfo;
    try {
      await expect(
        downloadMediaUrl({
          url: `https://pinned.invalid:${port}/clip.mp4`,
          downloadsDir,
          maxBytes: 1_000_000,
          resolveTarget: async (u) => pinnedTarget(u, '127.0.0.1'),
        }),
      ).rejects.toThrow(OmniDownloadError);
      expect(connections).toHaveLength(1);
      expect(await listParts()).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('re-resolves and re-pins at every redirect hop', async () => {
    // Hop 1 resolves public; the same-host redirect target resolves private
    // (rebinding between hops) and must be refused before the second fetch.
    const fetchFn = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://media.example.com/real.mp4' },
        }),
    );
    let call = 0;
    await expect(
      downloadMediaUrl({
        url: 'https://media.example.com/a.mp4',
        downloadsDir,
        maxBytes: 1_000_000,
        fetchFn,
        resolveTarget: async (u) => {
          if (++call === 1) return pinnedTarget(u);
          throw new Error('resolved to a blocked address: media.example.com');
        },
      }),
    ).rejects.toThrow(/refused for safety/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await listParts()).toEqual([]);
  });

  it('cannot be downgraded or credentialed via a redirect hop', async () => {
    // The https and credentials gates run once, before the loop, so they rely
    // on isPermittedRedirect refusing a hop that changes protocol or adds
    // credentials. If that ever loosened, a hop could bypass both checks —
    // assert the refusal here rather than trusting the invariant.
    for (const location of [
      'http://media.example.com/a.mp4',
      'https://alice:s3cret@media.example.com/a.mp4',
    ]) {
      const fetchFn = vi.fn<typeof fetch>(
        async () => new Response(null, { status: 302, headers: { location } }),
      );
      await expect(
        downloadMediaUrl({
          url: 'https://media.example.com/a.mp4',
          downloadsDir,
          maxBytes: 1_000_000,
          fetchFn,
          resolveTarget: async (u) => pinnedTarget(u),
        }),
      ).rejects.toThrow(/Cross-origin redirect refused/);
    }
    expect(await listParts()).toEqual([]);
  });

  it('pins each hop to its own vetted address', async () => {
    // Replaces a weaker assertion that only required `dispatcher` to be
    // non-null — which would pass with an Agent carrying no lookup, or one
    // pinned to the wrong address. Instead, interrogate each dispatcher by
    // asking its lookup where it points, per hop. (Agent close/lifecycle is
    // deliberately NOT asserted here: spying on the shared
    // `Agent.prototype.close` poisons every other test in the process.)
    const pins: string[] = [];
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_u, init) => {
        pins.push(await pinnedAddressOf(init));
        return new Response(null, {
          status: 302,
          headers: { location: 'https://media.example.com/real.mp4' },
        });
      })
      .mockImplementationOnce(async (_u, init) => {
        pins.push(await pinnedAddressOf(init));
        return new Response(Buffer.from('ok'));
      });
    let hop = 0;
    await downloadMediaUrl({
      url: 'https://media.example.com/a.mp4',
      downloadsDir,
      maxBytes: 1_000_000,
      fetchFn,
      // Hop 1 and hop 2 vet to *different* addresses, so a stale agent
      // reused across hops would show up as the wrong pin below.
      resolveTarget: async (u) =>
        pinnedTarget(u, ++hop === 1 ? '93.184.216.34' : '93.184.216.35'),
    });
    expect(pins).toEqual(['93.184.216.34', '93.184.216.35']);
  });

  it('does not route through the global fetch (undici version-skew safety)', async () => {
    // The dispatcher comes from the bundled undici, so fetch must come from the
    // same version — Node's built-in fetch may be a different major whose
    // handler-interface check rejects the Agent (`invalid onError method`, see
    // runtimeFetchOptions.ts). Reverting to the global fetch would reintroduce
    // that skew, so assert it is never called while the pin still lands.
    const connections: string[] = [];
    const server = net.createServer((socket) => {
      connections.push(socket.remoteAddress ?? '');
      socket.destroy();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const { port } = server.address() as AddressInfo;
    const globalSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(
        downloadMediaUrl({
          url: `https://skew.invalid:${port}/clip.mp4`,
          downloadsDir,
          maxBytes: 1_000_000,
          resolveTarget: async (u) => pinnedTarget(u, '127.0.0.1'),
        }),
      ).rejects.toThrow(OmniDownloadError);
      expect(globalSpy).not.toHaveBeenCalled();
      expect(connections).toHaveLength(1);
    } finally {
      globalSpy.mockRestore();
      server.close();
    }
  });

  it('resolves via dns.lookup when no target resolver is injected', async () => {
    // `resolveTarget` is a test seam; production must go through DNS. Injecting
    // it everywhere would leave that wiring — and the {all: true} option the
    // multi-address check depends on — completely unexercised.
    dnsLookupMock.mockClear();
    await expect(
      downloadMediaUrl({
        url: 'https://media.example.com/a.mp4',
        downloadsDir,
        maxBytes: 1_000_000,
        fetchFn: fetchOk(Buffer.from('ok')),
      }),
    ).resolves.toMatchObject({ sizeBytes: 2 });
    expect(dnsLookupMock).toHaveBeenCalledWith('media.example.com', {
      all: true,
      verbatim: true,
    });
  });

  it('refuses URLs that embed credentials, without echoing them', async () => {
    // resolveNetworkTarget would also reject these, but with a message naming
    // "extension network requests". Assert both the refusal and that neither
    // the user nor the password reaches the error text — it is rendered in the
    // UI and written to the debug log.
    const fetchFn = vi.fn<typeof fetch>();
    const err = await downloadMediaUrl({
      url: 'https://alice:s3cret@media.example.com/a.mp4',
      downloadsDir,
      maxBytes: 1_000_000,
      fetchFn,
      resolveTarget: async (u) => pinnedTarget(u),
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(OmniDownloadError);
    expect((err as Error).message).toMatch(/must not embed credentials/);
    expect((err as Error).message).not.toMatch(/s3cret|alice/);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await listParts()).toEqual([]);
  });

  it('refuses to download at all on runtimes that cannot pin the connection', async () => {
    // Bun accepts `dispatcher` and silently ignores it, so the pinned lookup is
    // never consulted and the request connects wherever it re-resolves to —
    // verified against Bun 1.3.11, for both the global fetch and undici's own.
    // The gate is an allowlist (`!== 'node'`), so an unrecognized runtime is
    // refused too rather than fetched unpinned.
    const versions = process.versions as Record<string, string | undefined>;
    const previous = versions['bun'];
    const fetchFn = vi.fn<typeof fetch>();
    versions['bun'] = '1.3.11';
    try {
      await expect(
        downloadMediaUrl({
          url: 'https://media.example.com/a.mp4',
          downloadsDir,
          maxBytes: 1_000_000,
          fetchFn,
          resolveTarget: async (u) => pinnedTarget(u),
        }),
      ).rejects.toThrow(/refused for safety on bun/);
    } finally {
      if (previous === undefined) delete versions['bun'];
      else versions['bun'] = previous;
    }
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await listParts()).toEqual([]);
  });

  it('rejects oversized Content-Length before reading the body', async () => {
    await expect(
      downloadMediaUrl({
        url: 'https://m.example.com/big.mp4',
        downloadsDir,
        maxBytes: 10,
        fetchFn: fetchOk(Buffer.alloc(100), { 'content-length': '100' }),
      }),
    ).rejects.toThrow(/Content-Length 100 > 10 bytes/);
    expect(await listParts()).toEqual([]);
  });

  it('enforces the byte cap on actual bytes even without Content-Length', async () => {
    // Streamed response with no content-length header.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(64));
        controller.enqueue(new Uint8Array(64));
        controller.close();
      },
    });
    const fetchFn = vi.fn(
      async () => new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      downloadMediaUrl({
        url: 'https://m.example.com/nolen.mp4',
        downloadsDir,
        maxBytes: 100,
        fetchFn,
      }),
    ).rejects.toThrow(/>100 bytes received/);
    expect(await listParts()).toEqual([]); // .part cleaned on failure
  });

  it('surfaces HTTP errors with status and host, cleaning the .part', async () => {
    await expect(
      downloadMediaUrl({
        url: 'https://m.example.com/nope.mp4',
        downloadsDir,
        maxBytes: 1000,
        fetchFn: vi.fn(async () => new Response('gone', { status: 404 })),
      }),
    ).rejects.toThrow(/HTTP 404 from m\.example\.com/);
    expect(await listParts()).toEqual([]);
  });

  it('follows same-origin redirects and refuses cross-origin ones', async () => {
    const bytes = Buffer.from('after-redirect');
    const sameOrigin = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://m.example.com/real.mp4' },
        }),
      )
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    const ok = await downloadMediaUrl({
      url: 'https://m.example.com/a.mp4',
      downloadsDir,
      maxBytes: 1000,
      fetchFn: sameOrigin,
    });
    expect(ok.finalUrl).toBe('https://m.example.com/real.mp4');
    expect(ok.sizeBytes).toBe(bytes.length);

    const crossOrigin = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example.net/x.mp4' },
        }),
    ) as unknown as typeof fetch;
    await expect(
      downloadMediaUrl({
        url: 'https://m.example.com/a.mp4',
        downloadsDir,
        maxBytes: 1000,
        fetchFn: crossOrigin,
      }),
    ).rejects.toThrow(/Cross-origin redirect refused/);
  });

  it('surfaces a malformed redirect Location as a named download error', async () => {
    // `new URL('http://[', base)` throws a raw TypeError; that must become an
    // OmniDownloadError (and not echo the server-controlled header value).
    const fetchFn = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://[' },
        }),
    ) as unknown as typeof fetch;
    await expect(
      downloadMediaUrl({
        url: 'https://m.example.com/a.mp4',
        downloadsDir,
        maxBytes: 1000,
        fetchFn,
      }),
    ).rejects.toThrow(/malformed Location header from m\.example\.com/);
    expect(await listParts()).toEqual([]);
  });

  it('propagates user aborts and cleans up', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }) as unknown as typeof fetch;
    const err = await downloadMediaUrl({
      url: 'https://m.example.com/a.mp4',
      downloadsDir,
      maxBytes: 1000,
      signal: controller.signal,
      fetchFn,
    }).catch((e: Error) => e);
    expect((err as Error).name).toBe('AbortError');
    expect(err).not.toBeInstanceOf(OmniDownloadError);
    expect(await listParts()).toEqual([]);
  });
});
