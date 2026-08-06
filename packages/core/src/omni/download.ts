/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isPrivateHost, isPermittedRedirect } from '../utils/fetch.js';
import {
  resolveNetworkTarget,
  type ResolvedNetworkTarget,
} from '../extension/network-policy.js';
import { loadUndici, detectRuntime } from '../utils/runtimeFetchOptions.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('omni:download');

/** Thrown for URL localization failures. Messages must stay free of
 * credentials and local filesystem paths; they may include the URL host and
 * HTTP status. */
export class OmniDownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OmniDownloadError';
  }
}

export interface DownloadedMedia {
  /** Path of the fully-written temp file (inside downloads/). Caller is
   * responsible for recognition, promotion into objects/, and cleanup. This
   * is deliberately the ONLY field: the pipeline re-derives identity (hash,
   * sniff, size) from the file on disk — transfer-time observations such as
   * the server's Content-Type or the final URL must never be trusted, so
   * they are not carried here at all. */
  partPath: string;
}

/** How long the DNS resolve-and-pin step may take before the download is
 * declared stuck. Without it, resolution would be the only phase with no
 * watchdog: a resolver that never answers (and a caller that never aborts)
 * would spin the turn forever. The race abandons rather than cancels the
 * underlying lookup — it only stops waiting for it. */
const RESOLVE_TIMEOUT_MS = 30_000;
const HEADER_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 60_000;
/** Exported so the redirect-budget test can pin the exact fetch count to
 * this constant rather than to a magic number that drifts. */
export const MAX_REDIRECTS = 5;

/**
 * Test whether an @-path is a downloadable http(s) URL.
 *
 * Deliberately still matches `http://` even though `downloadMediaUrl` refuses
 * plaintext: recognizing it yields an explicit "must be https" error, whereas
 * failing to recognize it would let the ref fall through to filesystem
 * resolution, where the ENOENT skip drops it with no message at all.
 */
export function parseHttpUrlRef(pathName: string): URL | null {
  if (!/^https?:\/\//i.test(pathName)) return null;
  try {
    return new URL(pathName);
  } catch {
    return null;
  }
}

/**
 * Strip absolute filesystem paths from a message before it enters an
 * OmniDownloadError, keeping only the basename. fs and stream errors embed
 * full local paths (`ENOTDIR: not a directory, mkdir '/home/x/…'`), and
 * OmniDownloadError messages reach the UI and the debug log. The wrap sites
 * below only interpolate fs/undici error text — never URLs — so a
 * separator-based pattern cannot eat anything it should keep.
 */
function scrubPathsFromMessage(message: string): string {
  return message.replace(
    /(?:[A-Za-z]:)?(?:[\\/][^\s'"`\\/]+){2,}[\\/]?/g,
    (match) => path.basename(match),
  );
}

/**
 * Flatten an error's `cause` chain into "CODE: message" fragments. Undici
 * reports connection-level failures as a bare `TypeError: fetch failed` with
 * the actionable reason (ECONNREFUSED, TLS codes) on `cause`; without this
 * the user would see "fetch failed" and nothing they can act on.
 */
function formatCauseChain(err: unknown): string | undefined {
  const parts: string[] = [];
  let cause: unknown = err instanceof Error ? err.cause : undefined;
  for (let depth = 0; cause != null && depth < 4; depth++) {
    const code = (cause as { code?: unknown }).code;
    const message =
      cause instanceof Error
        ? cause.message
        : typeof cause === 'string'
          ? cause
          : undefined;
    if (typeof code === 'string' && message && !message.includes(code)) {
      parts.push(`${code}: ${message}`);
    } else if (message) {
      parts.push(message);
    } else if (typeof code === 'string') {
      parts.push(code);
    }
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return parts.length > 0 ? scrubPathsFromMessage(parts.join('; ')) : undefined;
}

/**
 * Detect a configured HTTP(S) proxy. Mirrors how the rest of the codebase
 * decides to proxy: config.ts installs a process-wide `EnvHttpProxyAgent` as
 * the global dispatcher when `--proxy`/`settings.proxy` resolves to a value
 * (see Config.initialize), and `EnvHttpProxyAgent` itself honors the
 * `HTTP(S)_PROXY` environment variables — so a proxy is in play if either
 * the env vars are set or that global dispatcher has been installed.
 */
function detectConfiguredProxy(
  undici: Awaited<ReturnType<typeof loadUndici>>,
): boolean {
  for (const key of [
    'https_proxy',
    'HTTPS_PROXY',
    'http_proxy',
    'HTTP_PROXY',
    'all_proxy',
    'ALL_PROXY',
  ]) {
    if (process.env[key]) return true;
  }
  try {
    return undici.getGlobalDispatcher() instanceof undici.EnvHttpProxyAgent;
  } catch {
    return false;
  }
}

/**
 * Stream a media URL into `downloads/<id>.part`.
 *
 * Policy (mirrors utils/fetch.ts fetchWithPolicy, but streaming — that
 * helper buffers whole bodies in memory and is unsuitable for GiB media):
 * - https only (plaintext is refused: media swapped in flight would be
 *   uploaded to a third party under the user's account); private/loopback
 *   hosts refused (SSRF), by hostname text
 *   AND by resolved address — and the vetted address is then PINNED to the
 *   connection via an undici agent whose `connect.lookup` returns only that
 *   address, so the client cannot re-resolve the name after validation. A
 *   preflight check alone is check-then-connect: `fetch` resolves again, and a
 *   low-TTL record answering public once then private would still be
 *   connected to. Validation failure (including a name that will not resolve)
 *   fails closed — these bytes are uploaded to a third party, so an
 *   unverifiable host must not be fetched at all;
 * - re-validated and re-pinned at every redirect hop (a permitted same-host
 *   redirect can still re-resolve elsewhere between hops);
 * - Node only: refused outright on runtimes that accept the pinning agent and
 *   ignore it (Bun), since there the pin is unenforceable;
 * - refused outright behind a configured proxy, for the same reason as the
 *   Bun case: through a proxy CONNECT tunnel the proxy resolves the name
 *   itself and the pinned `connect.lookup` never runs, so the pin would be a
 *   claim we cannot keep — while the bare pinned Agent, dispatching directly,
 *   would silently bypass the proxy users are required to route through;
 * - redirects followed only when same-host/protocol/port (isPermittedRedirect),
 *   bounded by MAX_REDIRECTS;
 * - `maxBytes` enforced against BOTH Content-Length and actual bytes written;
 * - three-timer model: resolve watchdog (30s, covering the DNS
 *   resolve-and-pin step), header timeout (30s, cleared when headers arrive),
 *   plus an idle watchdog reset per chunk (60s) — a slow large body is fine,
 *   a stalled one is not;
 * - on ANY failure the `.part` file is removed (no half-download survives).
 */
export async function downloadMediaUrl(params: {
  url: string;
  downloadsDir: string;
  maxBytes: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  /**
   * Test seam for the SSRF resolve-and-pin step; production resolves via DNS
   * and pins the answer (see resolveNetworkTarget). Tests inject a fake so
   * they neither touch real DNS nor need a listening socket.
   */
  resolveTarget?: (url: string) => Promise<ResolvedNetworkTarget>;
  /**
   * Test seam for the proxy gate; production detects via the env vars plus
   * the global dispatcher (see detectConfiguredProxy). Tests inject a fake
   * so they neither depend on nor mutate process-wide state.
   */
  detectProxy?: () => boolean;
  /** Test seams for the three watchdogs. Real timers with tiny injected
   * values are more faithful here than fake timers, which fight undici's
   * internals and the stream plumbing. Production always uses the defaults. */
  resolveTimeoutMs?: number;
  headerTimeoutMs?: number;
  idleTimeoutMs?: number;
}): Promise<DownloadedMedia> {
  const {
    url,
    downloadsDir,
    maxBytes,
    signal,
    resolveTimeoutMs = RESOLVE_TIMEOUT_MS,
    headerTimeoutMs = HEADER_TIMEOUT_MS,
    idleTimeoutMs = IDLE_TIMEOUT_MS,
  } = params;
  // `'public'` is what turns on resolution + address vetting + pinning; the
  // helper is a no-op passthrough for any other policy.
  const resolveTarget =
    params.resolveTarget ??
    ((target: string) => resolveNetworkTarget(target, 'public', signal));

  if (isPrivateHost(url)) {
    throw new OmniDownloadError(
      `URL host is not publicly routable (refused for safety): ${new URL(url).hostname}`,
    );
  }

  // isPrivateHost above fails OPEN on unparseable input (returns false), so
  // this re-parse is where a malformed ref first surfaces — unguarded it
  // would escape as a raw TypeError instead of the documented error type.
  // The ref itself stays out of the message (it may embed anything).
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OmniDownloadError('URL media ref is not a valid URL (refused).');
  }

  // https only, checked here so the message names the real reason: the
  // resolve-and-pin step below refuses plaintext (its error would just say
  // "could not be verified"). Media fetched over http can be swapped in
  // flight, and these bytes are uploaded to a third party under the user's
  // account — a URL whose contents cannot be attributed to the named host has
  // no business being delivered to the model.
  if (parsed.protocol !== 'https:') {
    throw new OmniDownloadError(
      `URL media must be https (refused for safety): ` +
        `${parsed.protocol}//${parsed.hostname}`,
    );
  }

  // Credentials in the URL are refused explicitly. `resolveNetworkTarget`
  // would also reject them, but its message says "extension network requests"
  // (that helper's original caller), which misattributes the reason here. The
  // check is deliberately silent about the values themselves: OmniDownloadError
  // messages reach the UI and the debug log.
  if (parsed.username || parsed.password) {
    throw new OmniDownloadError(
      `URL media must not embed credentials (refused for safety): ` +
        `${parsed.hostname}`,
    );
  }

  // Refuse outright on runtimes that cannot bind the connection. Bun accepts
  // `dispatcher` and silently ignores it (its `fetch` is a native
  // implementation, and it shims the `undici` module too, so neither the
  // global nor undici's own `fetch` routes through the agent) — the request
  // would resolve the name itself and connect wherever it landed, with the
  // pinned lookup never called. Since this path uploads the fetched bytes to a
  // third party, an unenforceable pin must be a refusal rather than a claim we
  // cannot keep. The same runtime fact is merely a missed optimization for
  // utils/apiPreconnect.ts, which skips non-Node runtimes for this reason.
  const runtime = detectRuntime();
  if (runtime !== 'node') {
    throw new OmniDownloadError(
      `URL media requires the Node runtime to verify the connection target ` +
        `(refused for safety on ${runtime}): use a local file path instead of ` +
        `a URL, or run under Node.`,
    );
  }

  const undici = await loadUndici();

  // Refuse outright behind a configured proxy, for the same reason as the
  // Bun case above: the bare pinned Agent below dispatches DIRECTLY, so it
  // would silently bypass the proxy config.ts installs process-wide (and any
  // TLS-inspection policy riding on it) — while routing THROUGH the proxy
  // would hand name resolution to the proxy's CONNECT handling, where the
  // pinned `connect.lookup` never runs and the SSRF pin becomes
  // unenforceable. Either way the promise cannot be kept, so refuse.
  const proxied = params.detectProxy
    ? params.detectProxy()
    : detectConfiguredProxy(undici);
  if (proxied) {
    throw new OmniDownloadError(
      `URL media fetching is not supported behind a proxy yet (refused): ` +
        `the connection pinning that enforces SSRF protection cannot be ` +
        `applied through a proxy. Download the file manually and use a ` +
        `local path instead.`,
    );
  }

  // Local filesystem failures (ENOTDIR, EROFS, EACCES) must stay inside the
  // OmniDownloadError contract, and fs error text embeds the absolute
  // directory path, which must not reach the UI or the debug log.
  try {
    await fs.mkdir(downloadsDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new OmniDownloadError(
      `Could not prepare the downloads directory for URL media: ${
        err instanceof Error ? scrubPathsFromMessage(err.message) : String(err)
      }`,
      { cause: err },
    );
  }
  const partPath = path.join(
    downloadsDir,
    `${randomBytes(8).toString('hex')}.part`,
  );

  let currentUrl = url;
  // Kept outside the loop: the pinned agent must stay open for the whole
  // streaming read, and each redirect hop replaces it with one pinned to that
  // hop's freshly vetted address.
  let dispatcher: import('undici').Dispatcher | undefined;
  try {
    for (let redirects = 0; ; redirects++) {
      // Resolve, vet, and PIN before each connect, every hop. The text-level
      // gate above cannot see where a public-looking name actually points,
      // and validating without pinning would only be check-then-connect —
      // `fetch` would resolve the name a second time and could still be
      // handed a private address.
      let target: ResolvedNetworkTarget;
      const resolveAbort = new AbortController();
      const resolveTimer = setTimeout(
        () => resolveAbort.abort(new Error('resolve timeout')),
        resolveTimeoutMs,
      );
      try {
        const pending = resolveTarget(currentUrl);
        // The race abandons `pending` on timeout; without this no-op handler
        // a late rejection from the abandoned lookup would surface as an
        // unhandled rejection.
        pending.catch(() => {});
        target = await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            resolveAbort.signal.addEventListener(
              'abort',
              () => reject(resolveAbort.signal.reason),
              { once: true },
            );
          }),
        ]);
      } catch (err) {
        if (signal?.aborted) throw err;
        if (resolveAbort.signal.aborted) {
          throw new OmniDownloadError(
            `Download timed out resolving ${new URL(currentUrl).hostname} ` +
              `(${resolveTimeoutMs / 1000}s)`,
          );
        }
        // Fail closed: unlike the general web-fetch path, these bytes are
        // uploaded to a third party, so "could not verify" must mean "do not
        // fetch" rather than "connect and hope". The resolver's own text is
        // translated rather than echoed: resolveNetworkTarget phrases its
        // errors as "Extension network host …" (that helper's original
        // caller), the same misattribution the credentials check above
        // avoids — and nothing server-controlled beyond the hostname may
        // enter the message anyway.
        const text = err instanceof Error ? err.message : String(err);
        const reason = /blocked address/i.test(text)
          ? 'resolved to a non-public address'
          : /did not resolve/i.test(text)
            ? 'did not resolve'
            : 'could not be verified';
        throw new OmniDownloadError(
          `URL host ${reason} (refused for safety): ` +
            `${new URL(currentUrl).hostname}`,
          { cause: err },
        );
      } finally {
        clearTimeout(resolveTimer);
      }
      if (!target.lookup) {
        // No pinned lookup means the connection cannot be bound to the vetted
        // address, so DNS-rebinding protection would be a claim we cannot
        // keep. Refuse instead of fetching unpinned.
        throw new OmniDownloadError(
          `URL host cannot be safely bound to a verified address ` +
            `(refused for safety): ${new URL(currentUrl).hostname}`,
        );
      }
      // Default to undici's OWN fetch, not the global one. The dispatcher below
      // comes from the bundled undici, and Node's built-in fetch may ship a
      // different major version whose handler-interface check rejects it
      // (`invalid onError method`) — see runtimeFetchOptions.ts, which pins
      // undiciFetch for exactly this reason. Here the stakes are higher than a
      // failed request: if the dispatcher were ever dropped rather than
      // rejected, the pin would silently not apply, so fetch and Agent must
      // come from one version.
      const fetchFn = params.fetchFn ?? (undici.fetch as typeof fetch);
      // Replace (not accumulate) the previous hop's agent.
      const previousDispatcher = dispatcher;
      dispatcher = new undici.Agent({ connect: { lookup: target.lookup } });
      await previousDispatcher?.close().catch(() => {});
      const headerAbort = new AbortController();
      const headerTimer = setTimeout(
        () => headerAbort.abort(new Error('header timeout')),
        headerTimeoutMs,
      );
      const combined = AbortSignal.any(
        signal ? [signal, headerAbort.signal] : [headerAbort.signal],
      );
      let res: Response;
      try {
        res = await fetchFn(currentUrl, {
          redirect: 'manual',
          signal: combined,
          // Not in the DOM RequestInit type; undici reads it (same cast as
          // services/image-generation-service.ts).
          dispatcher,
        } as RequestInit);
      } catch (err) {
        if (signal?.aborted) throw err;
        // Name the watchdog explicitly: the abort surfaces as a generic
        // AbortError ("This operation was aborted") with the real reason on
        // `cause`, so reading err.message alone would make a timeout
        // indistinguishable from any other failed request.
        if (headerAbort.signal.aborted) {
          throw new OmniDownloadError(
            `Download timed out waiting for response headers from ` +
              `${new URL(currentUrl).hostname} (${headerTimeoutMs / 1000}s)`,
          );
        }
        // Undici reports connection-level failures as a bare "fetch failed"
        // TypeError with the actionable reason (ECONNREFUSED, TLS codes) on
        // `cause` — surface that chain, or the user has nothing to act on.
        const detail =
          err instanceof Error
            ? scrubPathsFromMessage(err.message)
            : String(err);
        const causeDetail = formatCauseChain(err);
        throw new OmniDownloadError(
          `Download request failed for ${new URL(currentUrl).hostname}: ` +
            `${detail}${causeDetail ? ` (${causeDetail})` : ''}`,
          { cause: err },
        );
      } finally {
        clearTimeout(headerTimer);
      }

      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get('location');
        if (!location || redirects >= MAX_REDIRECTS) {
          throw new OmniDownloadError(
            `Too many or invalid redirects downloading from ${new URL(currentUrl).hostname}`,
          );
        }
        let redirectUrl: string;
        try {
          redirectUrl = new URL(location, currentUrl).toString();
        } catch {
          // A malformed Location must surface as a download error, not a
          // raw TypeError; the header value itself stays out of the message
          // (server-controlled, and OmniDownloadError reaches the UI).
          throw new OmniDownloadError(
            `Redirect with a malformed Location header from ${new URL(currentUrl).hostname}`,
          );
        }
        if (!isPermittedRedirect(currentUrl, redirectUrl)) {
          throw new OmniDownloadError(
            `Cross-origin redirect refused: ${new URL(currentUrl).hostname} → ${new URL(redirectUrl).hostname}`,
          );
        }
        currentUrl = redirectUrl;
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new OmniDownloadError(
          `Download failed: HTTP ${res.status} from ${new URL(currentUrl).hostname}`,
        );
      }

      const contentLength = Number(res.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new OmniDownloadError(
          `Download exceeds the omni media limit: Content-Length ${contentLength} > ${maxBytes} bytes.`,
        );
      }
      if (!res.body) {
        throw new OmniDownloadError('Download response had no body.');
      }

      // Stream to disk with byte cap + idle watchdog. Deliberately no hashing
      // here: the pipeline re-derives identity from the file on disk (see
      // DownloadedMedia), so a transfer-time hash would be dead work over up
      // to a GiB of media.
      let written = 0;
      const idleAbort = new AbortController();
      let idleTimer = setTimeout(
        () => idleAbort.abort(new Error('idle timeout')),
        idleTimeoutMs,
      );
      const streamSignal = AbortSignal.any(
        signal ? [signal, idleAbort.signal] : [idleAbort.signal],
      );
      try {
        const source = Readable.fromWeb(
          res.body as import('node:stream/web').ReadableStream,
          { signal: streamSignal },
        );
        const counter = async function* (src: AsyncIterable<Buffer>) {
          for await (const chunk of src) {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(
              () => idleAbort.abort(new Error('idle timeout')),
              idleTimeoutMs,
            );
            written += chunk.length;
            if (written > maxBytes) {
              throw new OmniDownloadError(
                `Download exceeds the omni media limit: >${maxBytes} bytes received.`,
              );
            }
            yield chunk;
          }
        };
        await pipeline(
          source,
          counter,
          createWriteStream(partPath, { mode: 0o600 }),
        );
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err instanceof OmniDownloadError) throw err;
        // Same identifiability rule as the header path: the idle abort
        // reaches here as an AbortError whose message hides the reason.
        if (idleAbort.signal.aborted) {
          throw new OmniDownloadError(
            `Download stalled from ${new URL(currentUrl).hostname}: no data ` +
              `for ${idleTimeoutMs / 1000}s`,
          );
        }
        // Write-stream failures embed the absolute `.part` path in their
        // message; scrub before interpolating (same contract as mkdir above).
        throw new OmniDownloadError(
          `Download interrupted from ${new URL(currentUrl).hostname}: ${
            err instanceof Error
              ? scrubPathsFromMessage(err.message)
              : String(err)
          }`,
          { cause: err },
        );
      } finally {
        clearTimeout(idleTimer);
      }

      debugLogger.debug(
        `downloaded ${written} bytes from ${new URL(currentUrl).hostname}`,
      );
      return { partPath };
    }
  } catch (err) {
    await fs.rm(partPath, { force: true });
    throw err;
  } finally {
    // The agent owns a live connection pool; the streaming read above needs it
    // open until the body is fully consumed, so it can only be closed here.
    await dispatcher?.close().catch(() => {});
  }
}
