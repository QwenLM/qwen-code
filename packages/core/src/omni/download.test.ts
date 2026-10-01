/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import net from 'node:net';
import type { AddressInfo, LookupFunction } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  downloadMediaUrl,
  parseHttpUrlRef,
  OmniDownloadError,
  MAX_REDIRECTS,
} from './download.js';

// Hermetic suite: the SSRF gate resolves hostnames, and tests that inject no
// fake target must not depend on (or wait for) real DNS.
const dnsLookupMock = vi.hoisted(() =>
  vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
);
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return { ...actual, promises: { ...actual.promises, lookup: dnsLookupMock } };
});

/** A resolveNetworkTarget-shaped pinned target: `lookup` answers `address` for
 * any hostname, binding the connection. Verdict-only tests never reach it. */
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

/** Ask a request's dispatcher where it is pinned via its `connect.lookup`:
 * asserting the address (not merely that a dispatcher exists) makes pinning
 * tests fail if the lookup is missing or points elsewhere. */
async function pinnedAddressOf(init: RequestInit | undefined): Promise<string> {
  const dispatcher = (init as { dispatcher?: unknown } | undefined)?.dispatcher;
  if (!dispatcher) return 'NO-DISPATCHER';
  // undici stores constructor options on a symbol-keyed internal; read the
  // connect options back off it rather than reaching into private fields.
  const lookup = dispatcher as Record<symbol, unknown>;
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

/** A pull-counting body: `bytesPulled()` tells a streaming implementation
 * (stops pulling once the verdict is known) from one buffering the whole body.
 * Bytes, not pulls: Node's Response plumbing pulls a chunk or two itself. */
function countingBody(chunkSize: number, chunkCount: number) {
  let pulled = 0;
  let index = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (index >= chunkCount) {
        controller.close();
        return;
      }
      index += 1;
      pulled += chunkSize;
      controller.enqueue(new Uint8Array(chunkSize));
    },
  });
  return { stream, bytesPulled: () => pulled };
}

let downloadsDir: string;

beforeEach(async () => {
  downloadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-dl-'));
  // The proxy gate reads the environment when no detectProxy is injected; a
  // machine with HTTP(S)_PROXY set must not flip every verdict in this file.
  for (const scheme of ['https', 'http', 'all']) {
    vi.stubEnv(`${scheme}_proxy`, '');
    vi.stubEnv(`${scheme.toUpperCase()}_PROXY`, '');
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(downloadsDir, { recursive: true, force: true });
});

type DlParams = Parameters<typeof downloadMediaUrl>[0];
const MB = 1_000_000;
const CLIP = 'https://media.example.com/clip.mp4';
const M = 'https://m.example.com/';

/** downloadMediaUrl with this file's usual url, directory and 1000-byte cap. */
function dl(o: Partial<DlParams> = {}) {
  return downloadMediaUrl({
    url: 'https://media.example.com/a.mp4',
    downloadsDir,
    maxBytes: 1000,
    ...o,
  });
}

/** What `dl(o)` rejected with. */
const dlErr = async (o: Partial<DlParams> = {}) =>
  (await dl(o).catch((e: Error) => e)) as Error;

/** A fetch answering every call with `new Response(body, init)`. */
const respondWith = (body: BodyInit | null, init?: ResponseInit) =>
  vi.fn(async () => new Response(body, init)) as unknown as typeof fetch;

function fetchOk(
  body: Buffer | string,
  headers: Record<string, string> = {},
): typeof fetch {
  return vi.fn(async () => new Response(body, { status: 200, headers }));
}

const found = (location: string) =>
  new Response(null, { status: 302, headers: { location } });
const redirectTo = (location: string) =>
  vi.fn(async () => found(location)) as unknown as typeof fetch;
const pinned = async (u: string) => pinnedTarget(u);
const abortError = () =>
  Object.assign(new Error('aborted'), { name: 'AbortError' });

async function listParts(): Promise<string[]> {
  return (await fs.readdir(downloadsDir)).filter((f) => f.endsWith('.part'));
}

/** The request never reached fetch and left no .part behind. */
async function expectNoFetch(fetchFn: typeof fetch) {
  expect(fetchFn).not.toHaveBeenCalled();
  expect(await listParts()).toEqual([]);
}

/** `dl` of https://m.example.com/<file> rejects with `msg`; no .part left. */
async function rejectsClean(file: string, msg: RegExp, o: Partial<DlParams>) {
  await expect(dl({ url: M + file, ...o })).rejects.toThrow(msg);
  expect(await listParts()).toEqual([]);
}

/** `dl(o)` succeeds and its .part holds exactly `bytes`. */
async function expectDownloaded(o: Partial<DlParams>, bytes: Buffer) {
  const result = await dl(o);
  await expect(fs.readFile(result.partPath)).resolves.toEqual(bytes);
  return result;
}

function expectNamed(err: Error, msg: RegExp) {
  expect(err).toBeInstanceOf(OmniDownloadError);
  expect(err.message).toMatch(msg);
}

function expectAbort(err: Error) {
  expect(err.name).toBe('AbortError');
  expect(err).not.toBeInstanceOf(OmniDownloadError);
}

/** Download from `host` (real undici, no fetchFn) pinned to a loopback TCP
 * listener that drops each connection; returns the connections it saw. */
async function dlPinnedToSink(host: string) {
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
      dl({
        url: `https://${host}:${port}/clip.mp4`,
        maxBytes: MB,
        resolveTarget: async (u) => pinnedTarget(u, '127.0.0.1'),
      }),
    ).rejects.toThrow(OmniDownloadError);
    return connections;
  } finally {
    server.close();
  }
}

/** `dl(o)` rejects with `msg`, never calling fetch (`clean`: and no .part). */
async function refusesUnfetched(
  o: Partial<DlParams>,
  msg: RegExp,
  clean = false,
) {
  const fetchFn = vi.fn<typeof fetch>();
  await expect(dl({ ...o, fetchFn })).rejects.toThrow(msg);
  expect(fetchFn).not.toHaveBeenCalled();
  if (clean) expect(await listParts()).toEqual([]);
}

/** An 800 KiB counted body against a 64 KiB cap: rejected with `msg`, having
 * pulled far less than the whole body, and no .part left behind. */
async function expectCapStopsPulling(
  url: string,
  init: ResponseInit,
  msg: RegExp,
) {
  const { stream, bytesPulled } = countingBody(8 * 1024, 100);
  const fetchFn = respondWith(stream, init);
  await expect(dl({ url, maxBytes: 64 * 1024, fetchFn })).rejects.toThrow(msg);
  expect(bytesPulled()).toBeLessThan(8 * 1024 * 100);
  expect(await listParts()).toEqual([]);
}

describe('parseHttpUrlRef', () => {
  it('accepts http and https refs, scheme case-insensitively', () => {
    expect(parseHttpUrlRef('https://example.com/a.mp4')?.hostname).toBe(
      'example.com',
    );
    expect(parseHttpUrlRef('http://example.com/a.mp4')?.protocol).toBe('http:');
    expect(parseHttpUrlRef('HTTPS://EXAMPLE.COM/A.MP4')).toBeInstanceOf(URL);
    expect(parseHttpUrlRef('HtTp://example.com/a.mp4')).toBeInstanceOf(URL);
  });

  it('returns null for non-URL paths and unparseable URLs', () => {
    for (const ref of [
      'src/media/clip.mp4',
      './clip.mp4',
      'clip.mp4',
      'ftp://example.com/clip.mp4',
      'httpx://example.com/clip.mp4',
      'https://',
      'https://[',
    ]) {
      expect(parseHttpUrlRef(ref)).toBeNull();
    }
  });
});

describe('downloadMediaUrl', () => {
  it('streams the body to a .part file inside downloads/', async () => {
    const bytes = Buffer.from('media-bytes-here');
    const fetchFn = fetchOk(bytes, { 'content-type': 'video/mp4' });
    const result = await expectDownloaded({ maxBytes: MB, fetchFn }, bytes);
    expect(path.dirname(result.partPath)).toBe(downloadsDir);
    expect(result.partPath.endsWith('.part')).toBe(true);
  });

  it('rejects a malformed URL as a named download error, not a TypeError', async () => {
    // isPrivateHost fails open on unparseable input, so the re-parse inside
    // downloadMediaUrl is where a malformed ref surfaces: as the documented
    // error type, without echoing the ref.
    const fetchFn = vi.fn<typeof fetch>();
    for (const url of ['https://exa mple.com/a.mp4', 'https://[']) {
      expectNamed(await dlErr({ url, fetchFn }), /not a valid URL/);
    }
    await expectNoFetch(fetchFn);
  });

  it('refuses private/loopback hosts (SSRF)', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    for (const url of [
      'http://127.0.0.1:8734/x.mp4',
      'http://localhost:8734/x.mp4',
      'http://10.0.0.5/x.mp4',
      'http://internal.lan/x.mp4',
    ]) {
      await expect(dl({ url, fetchFn })).rejects.toThrow(
        /not publicly routable/,
      );
    }
    await expectNoFetch(fetchFn);
  });

  it('refuses a public-looking host that resolves to a private address', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    // DNS rebinding / split horizon: the name is syntactically public, so the
    // text-level gate passes; only resolution reveals the target.
    for (const address of ['127.0.0.1', '169.254.169.254', '10.1.2.3']) {
      dnsLookupMock.mockResolvedValueOnce([{ address, family: 4 }]);
      const err = await dlErr({ url: CLIP, maxBytes: MB, fetchFn });
      expectNamed(err, /refused for safety/);
      // The resolver phrases its errors for its original caller ("Extension
      // network host …"); that misattribution must not reach download errors.
      expect(err.message).not.toMatch(/Extension/);
    }
    await expectNoFetch(fetchFn);
  });

  it('refuses a public-looking host that resolves to a private IPv6 address', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    // Without these the suite would stay green under a classifier that fails
    // open on IPv6: loopback, link-local (incl. the fe80 metadata analogue),
    // ULA, and the IPv4-mapped form of a private IPv4.
    for (const address of ['::1', 'fe80::1', 'fd00::2', '::ffff:10.0.0.5']) {
      dnsLookupMock.mockResolvedValueOnce([{ address, family: 6 }]);
      await expect(dl({ url: CLIP, maxBytes: MB, fetchFn })).rejects.toThrow(
        /refused for safety/,
      );
    }
    await expectNoFetch(fetchFn);
  });

  it('accepts a host resolving to a public IPv6 address', async () => {
    // The acceptance counterpart: proves the IPv6 refusals above come from
    // classification rather than from IPv6 being rejected wholesale.
    const bytes = Buffer.from('v6-ok');
    dnsLookupMock.mockResolvedValueOnce([
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    await expectDownloaded(
      { url: CLIP, maxBytes: MB, fetchFn: fetchOk(bytes) },
      bytes,
    );
  });

  it('refuses when ANY resolved address is private (mixed A records)', async () => {
    // The connect may pick either address, so one bad entry is fatal.
    dnsLookupMock.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await refusesUnfetched({ url: CLIP, maxBytes: MB }, /refused for safety/);
  });

  it('fails closed when the host cannot be resolved', async () => {
    // Reversal of the old fail-open: bytes from an unverifiable host go to a
    // third party, so "cannot verify" means "refuse", not "connect and see".
    dnsLookupMock.mockRejectedValueOnce(
      Object.assign(new Error('EAI_AGAIN'), { code: 'EAI_AGAIN' }),
    );
    await refusesUnfetched({ maxBytes: MB }, /could not be verified/, true);
  });

  it('translates resolver errors into download-domain phrasing', async () => {
    // resolveNetworkTarget phrases its errors for its original caller
    // ("Extension network host …"); passing that through would misattribute
    // the refusal (the credentials gate avoids the same problem), so the
    // reachable resolver errors are translated, echoing only the hostname.
    const cases: Array<[string, RegExp]> = [
      [
        'Extension network host resolved to a blocked address: media.example.com',
        /URL host resolved to a non-public address/,
      ],
      [
        'Extension network host did not resolve: media.example.com',
        /URL host did not resolve/,
      ],
      ['socket hang up', /URL host could not be verified/],
    ];
    for (const [resolverText, expected] of cases) {
      const err = await dlErr({
        fetchFn: vi.fn<typeof fetch>(),
        resolveTarget: async () => {
          throw new Error(resolverText);
        },
      });
      expectNamed(err, expected);
      expect(err.message).not.toMatch(/Extension/);
    }
  });

  it('times out a resolve step that never answers', async () => {
    // Otherwise the only phase with no watchdog: a resolver that never settles
    // (and a caller that never aborts) would spin the turn forever.
    await refusesUnfetched(
      { resolveTarget: () => new Promise(() => {}), resolveTimeoutMs: 50 },
      /timed out resolving media\.example\.com/,
      true,
    );
  });

  it('propagates a user abort during resolve as an abort, not a timeout', async () => {
    const controller = new AbortController();
    const err = await dlErr({
      signal: controller.signal,
      fetchFn: vi.fn<typeof fetch>(),
      resolveTarget: () =>
        new Promise((_, reject) => {
          controller.abort();
          reject(abortError());
        }),
      resolveTimeoutMs: 50,
    });
    expectAbort(err);
  });

  it('refuses a target that cannot be pinned to a vetted address', async () => {
    // If the resolve step yields no pinned lookup, the connection cannot be
    // bound, so claiming rebinding protection would be false. Refuse instead.
    await refusesUnfetched(
      { maxBytes: MB, resolveTarget: async (u) => ({ url: new URL(u) }) },
      /cannot be safely bound/,
    );
  });

  it('refuses plaintext http URLs', async () => {
    const url = 'http://media.example.com/a.mp4';
    await refusesUnfetched({ url, maxBytes: MB }, /must be https/);
  });

  it('allows a host resolving to public addresses', async () => {
    const fetchFn = fetchOk(Buffer.from('ok-bytes'));
    await expectDownloaded(
      { maxBytes: MB, fetchFn, resolveTarget: pinned },
      Buffer.from('ok-bytes'),
    );
  });

  it('refuses to download when a proxy is configured (pin unenforceable)', async () => {
    // Same doctrine as the Bun refusal: the bare pinned Agent dispatches
    // directly, silently bypassing a configured proxy, while routing through
    // the proxy would hand resolution to its CONNECT handling, where the
    // pinned lookup never runs. Either way, refuse.
    await refusesUnfetched(
      { detectProxy: () => true, resolveTarget: pinned },
      /not supported behind a proxy/,
      true,
    );
  });

  it('detects a configured proxy from the environment', async () => {
    // Production detection path: no detectProxy injected, HTTPS_PROXY set —
    // the same signal EnvHttpProxyAgent (and config.ts) honors.
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.corp.example:8080');
    await refusesUnfetched(
      { resolveTarget: pinned },
      /not supported behind a proxy/,
    );
  });

  it('wraps downloads-directory failures without leaking the absolute path', async () => {
    // fs.mkdir error text embeds the absolute path; the wrap must keep the
    // OmniDownloadError contract and scrub it (messages reach UI, debug log).
    const blockerFile = path.join(downloadsDir, 'blocker');
    await fs.writeFile(blockerFile, 'not a directory');
    const fetchFn = vi.fn<typeof fetch>();
    const err = await dlErr({
      downloadsDir: path.join(blockerFile, 'nested'),
      fetchFn,
      resolveTarget: pinned,
    });
    expectNamed(err, /Could not prepare the downloads directory/);
    expect(err.message).not.toContain(downloadsDir);
    expect(err.message).not.toMatch(/\/home|\/Users|\/private|\/tmp\//);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a symlink planted at the downloads path (no bytes through the link)', async () => {
    // mkdir { recursive: true } succeeds silently on a symlink-to-dir, so
    // without the lstat guard bytes would land at an attacker-chosen location.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-dl-out-'));
    const linkDir = path.join(downloadsDir, 'downloads');
    await fs.symlink(outside, linkDir);
    const fetchFn = fetchOk('media-bytes');
    try {
      const err = await dlErr({
        downloadsDir: linkDir,
        fetchFn,
        resolveTarget: pinned,
      });
      expectNamed(err, /Could not prepare the downloads directory/);
      expect(fetchFn).not.toHaveBeenCalled();
      // Nothing was written through the link.
      await expect(fs.readdir(outside)).resolves.toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('pins the connection to the vetted address (real socket)', async () => {
    // Regression test for the check-then-connect hole (a preflight-only gate
    // lets `fetch` re-resolve): the socket must open to the approved address.
    // `pinned.invalid` never resolves (RFC 6761), so a connection can ONLY come
    // from the pin; the failed TLS handshake is fine (we assert where it went).
    // Dropping the dispatcher would make this ENOTFOUND with zero connections.
    expect(await dlPinnedToSink('pinned.invalid')).toHaveLength(1);
    expect(await listParts()).toEqual([]);
  });

  it('surfaces the cause chain of connection-level fetch failures', async () => {
    // Undici reports connection failures as a bare `TypeError: fetch failed`
    // with the actionable reason (ECONNREFUSED, TLS codes) on `cause`: show it.
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
          code: 'ECONNREFUSED',
        }),
      });
    }) as unknown as typeof fetch;
    const err = await dlErr({ fetchFn, resolveTarget: pinned });
    expectNamed(err, /ECONNREFUSED/);
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it('re-resolves and re-pins at every redirect hop', async () => {
    // Hop 1 resolves public; the same-host redirect target resolves private
    // (rebinding between hops) and must be refused before the second fetch.
    const fetchFn = redirectTo('https://media.example.com/real.mp4');
    let call = 0;
    await expect(
      dl({
        maxBytes: MB,
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
    // The https and credentials gates run once, before the loop, relying on
    // isPermittedRedirect refusing a protocol change or added credentials; if
    // that loosened a hop could bypass both, so assert it, not the invariant.
    for (const location of [
      'http://media.example.com/a.mp4',
      'https://alice:s3cret@media.example.com/a.mp4',
    ]) {
      const fetchFn = redirectTo(location);
      await expect(
        dl({ maxBytes: MB, fetchFn, resolveTarget: pinned }),
      ).rejects.toThrow(/Cross-origin redirect refused/);
    }
    expect(await listParts()).toEqual([]);
  });

  it('pins each hop to its own vetted address', async () => {
    // Replaces a weaker assertion that only required a non-null `dispatcher`,
    // which would pass with an Agent carrying no lookup or pinned to the wrong
    // address: ask each hop's lookup where it points. (Agent close/lifecycle is
    // deliberately NOT asserted: spying on the shared `Agent.prototype.close`
    // poisons every other test in the process.)
    const pins: string[] = [];
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_u, init) => {
        pins.push(await pinnedAddressOf(init));
        return found('https://media.example.com/real.mp4');
      })
      .mockImplementationOnce(async (_u, init) => {
        pins.push(await pinnedAddressOf(init));
        return new Response(Buffer.from('ok'));
      });
    let hop = 0;
    await dl({
      maxBytes: MB,
      fetchFn,
      // Hops 1 and 2 vet to *different* addresses, so a stale agent reused
      // across hops would show up as the wrong pin below.
      resolveTarget: async (u) =>
        pinnedTarget(u, ++hop === 1 ? '93.184.216.34' : '93.184.216.35'),
    });
    expect(pins).toEqual(['93.184.216.34', '93.184.216.35']);
  });

  it('does not route through the global fetch (undici version-skew safety)', async () => {
    // The dispatcher comes from the bundled undici, so fetch must too: Node's
    // built-in fetch may be a different major whose handler-interface check
    // rejects the Agent (`invalid onError method`, see runtimeFetchOptions.ts).
    // Assert the global fetch is never called while the pin still lands.
    const globalSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const connections = await dlPinnedToSink('skew.invalid');
      expect(globalSpy).not.toHaveBeenCalled();
      expect(connections).toHaveLength(1);
    } finally {
      globalSpy.mockRestore();
    }
  });

  it('resolves via dns.lookup when no target resolver is injected', async () => {
    // `resolveTarget` is a test seam; production must go through DNS, and the
    // multi-address check depends on its {all: true} option.
    dnsLookupMock.mockClear();
    await expect(
      dl({ maxBytes: MB, fetchFn: fetchOk(Buffer.from('ok')) }),
    ).resolves.toMatchObject({ partPath: expect.stringContaining('.part') });
    expect(dnsLookupMock).toHaveBeenCalledWith('media.example.com', {
      all: true,
      verbatim: true,
    });
  });

  it('refuses URLs that embed credentials, without echoing them', async () => {
    // resolveNetworkTarget would also reject these, but naming "extension
    // network requests". Assert the refusal and that neither user nor password
    // reaches the error text (rendered in the UI, written to the debug log).
    const fetchFn = vi.fn<typeof fetch>();
    const err = await dlErr({
      url: 'https://alice:s3cret@media.example.com/a.mp4',
      maxBytes: MB,
      fetchFn,
      resolveTarget: pinned,
    });
    expectNamed(err, /must not embed credentials/);
    expect(err.message).not.toMatch(/s3cret|alice/);
    await expectNoFetch(fetchFn);
  });

  it('refuses to download at all on runtimes that cannot pin the connection', async () => {
    // Bun accepts `dispatcher` and silently ignores it, so the request connects
    // wherever it re-resolves to (verified on Bun 1.3.11, for the global fetch
    // and undici's own). The gate is an allowlist (`!== 'node'`), so an
    // unrecognized runtime is refused too rather than fetched unpinned.
    const versions = process.versions as Record<string, string | undefined>;
    const previous = versions['bun'];
    versions['bun'] = '1.3.11';
    try {
      await refusesUnfetched(
        { maxBytes: MB, resolveTarget: pinned },
        /refused for safety on bun/,
        true,
      );
    } finally {
      if (previous === undefined) delete versions['bun'];
      else versions['bun'] = previous;
    }
  });

  it('rejects oversized Content-Length before reading the body', async () => {
    const fetchFn = fetchOk(Buffer.alloc(100), { 'content-length': '100' });
    await rejectsClean('big.mp4', /Content-Length 100 > 10 bytes/, {
      maxBytes: 10,
      fetchFn,
    });
  });

  it('does not read the body when Content-Length already exceeds the cap', async () => {
    // The pre-check must reject on the header alone, not after buffering the
    // body (bound is "far less than the body", not zero; see countingBody).
    await expectCapStopsPulling(
      M + 'big.mp4',
      { status: 200, headers: { 'content-length': '819200' } },
      /Content-Length 819200 > 65536 bytes/,
    );
  });

  it('enforces the byte cap on actual bytes even without Content-Length', async () => {
    // Streamed response with no content-length; .part cleaned on failure.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(64));
        controller.enqueue(new Uint8Array(64));
        controller.close();
      },
    });
    const fetchFn = respondWith(stream, { status: 200 });
    await rejectsClean('nolen.mp4', />100 bytes received/, {
      maxBytes: 100,
      fetchFn,
    });
  });

  it('stops pulling once the streamed byte cap trips (does not buffer the body)', async () => {
    // A buffering implementation (read everything, THEN reject) would pass the
    // cap test above; bytes pulled < body size pins the streaming behavior.
    await expectCapStopsPulling(
      M + 'nolen.mp4',
      { status: 200 },
      />65536 bytes received/,
    );
  });

  it('surfaces HTTP errors with status and host, cleaning the .part', async () => {
    const fetchFn = respondWith('gone', { status: 404 });
    await rejectsClean('nope.mp4', /HTTP 404 from m\.example\.com/, {
      fetchFn,
    });
  });

  it('follows same-origin redirects with manual redirect handling', async () => {
    // `redirect: 'manual'` is load-bearing: without it undici auto-follows and
    // every per-hop re-vet (re-resolve, re-pin, origin check) is skipped.
    const bytes = Buffer.from('after-redirect');
    const redirects: Array<string | undefined> = [];
    const sameOrigin = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_u, init) => {
        redirects.push(init?.redirect);
        return found('https://m.example.com/real.mp4');
      })
      .mockImplementationOnce(async (_u, init) => {
        redirects.push(init?.redirect);
        return new Response(bytes, { status: 200 });
      });
    await expectDownloaded({ url: M + 'a.mp4', fetchFn: sameOrigin }, bytes);
    expect(redirects).toEqual(['manual', 'manual']);
    expect(sameOrigin).toHaveBeenLastCalledWith(
      'https://m.example.com/real.mp4',
      expect.anything(),
    );

    const crossOrigin = redirectTo('https://evil.example.net/x.mp4');
    await expect(
      dl({ url: M + 'a.mp4', fetchFn: crossOrigin }),
    ).rejects.toThrow(/Cross-origin redirect refused/);
  });

  it('gives up after MAX_REDIRECTS same-origin hops', async () => {
    // An unbounded loop here is a self-inflicted infinite redirect chase;
    // pin both the refusal and the exact fetch budget.
    const fetchFn = redirectTo('https://m.example.com/next.mp4');
    await rejectsClean('a.mp4', /Too many or invalid redirects/, { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it('surfaces a malformed redirect Location as a named download error', async () => {
    // `new URL('http://[', base)` throws a raw TypeError; that must become an
    // OmniDownloadError (and not echo the server-controlled header value).
    await rejectsClean(
      'a.mp4',
      /malformed Location header from m\.example\.com/,
      { fetchFn: redirectTo('http://[') },
    );
  });

  it('times out when response headers never arrive', async () => {
    // The mock only rejects when the signal handed to it aborts, so this also
    // pins the `signal` wiring in the fetch init: drop it and the promise
    // never settles (the test times out) instead of naming the watchdog.
    const fetchFn = vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(abortError()), {
            once: true,
          });
        }),
    ) as unknown as typeof fetch;
    await rejectsClean(
      'slow.mp4',
      /timed out waiting for response headers from m\.example\.com/,
      { fetchFn, headerTimeoutMs: 50 },
    );
  });

  it('declares a stalled body dead after the idle window and cleans up', async () => {
    // First chunk arrives, then nothing — the idle watchdog (not the header
    // timer, already cleared) must abort the stream with a named message.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8)); // then never again, never closes
      },
    });
    const fetchFn = respondWith(stream, { status: 200 });
    await rejectsClean('stall.mp4', /Download stalled from m\.example\.com/, {
      fetchFn,
      idleTimeoutMs: 50,
    });
  });

  it('propagates user aborts and cleans up', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => {
      controller.abort();
      throw abortError();
    }) as unknown as typeof fetch;
    const signal = controller.signal;
    expectAbort(await dlErr({ url: M + 'a.mp4', signal, fetchFn }));
    expect(await listParts()).toEqual([]);
  });

  it('stops a mid-stream download when the caller aborts', async () => {
    // Unlike the test above, fetch never throws on its own: the abort acts only
    // through the {signal} handed to Readable.fromWeb. Without that wiring the
    // body streams to completion, resolving instead of rejecting.
    let pulls = 0;
    let index = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        pulls += 1;
        await new Promise((r) => setTimeout(r, 15));
        if (index >= 40) {
          controller.close();
          return;
        }
        index += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const fetchFn = respondWith(stream, { status: 200 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const err = await dlErr({
      url: M + 'slowbody.mp4',
      maxBytes: MB,
      signal: controller.signal,
      fetchFn,
    });
    expectAbort(err);
    // No further chunks are drawn once the abort lands (one in-flight pull
    // may still complete).
    const pullsAtRejection = pulls;
    await new Promise((r) => setTimeout(r, 100));
    expect(pulls).toBeLessThanOrEqual(pullsAtRejection + 1);
    expect(await listParts()).toEqual([]);
  });
});
