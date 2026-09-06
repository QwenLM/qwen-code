/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler, Response } from 'express';
import { constants as zlibConstants, gzip } from 'node:zlib';

/**
 * Responses smaller than this skip compression: the gzip header/trailer (≈23
 * bytes) plus a compression pass cost more than the bytes they save on tiny
 * JSON payloads. Matches the 1 KiB default of the widely-deployed `compression`
 * middleware so behavior is familiar to reviewers.
 */
export const GZIP_MIN_RESPONSE_BYTES = 1024;

export interface GzipJsonResponsesOptions {
  /** Bodies shorter than this many bytes are sent as identity. */
  threshold?: number;
}

/**
 * Parse an `Accept-Encoding` header and report whether `gzip` is acceptable.
 *
 * Tokens are `coding[;q=weight]` separated by commas (RFC 9110 §12.5.3).
 * `gzip;q=0` (or `q=0.000`) explicitly disables gzip and must be honored even
 * when the literal "gzip" substring is present, which is why a plain substring
 * check is not enough. Unlisted weights default to 1 (acceptable).
 */
export function acceptsGzip(headerValue: unknown): boolean {
  if (typeof headerValue !== 'string' || headerValue.length === 0) return false;
  for (const rawToken of headerValue.split(',')) {
    const parts = rawToken.trim().split(';');
    const coding = parts[0]?.trim().toLowerCase();
    if (coding !== 'gzip') continue;
    for (const param of parts.slice(1)) {
      const eq = param.indexOf('=');
      if (eq === -1) continue;
      const key = param.slice(0, eq).trim().toLowerCase();
      const value = param
        .slice(eq + 1)
        .trim()
        .replace(/^"|"$/g, '');
      if (key === 'q' && Number.parseFloat(value) === 0) return false;
    }
    return true;
  }
  return false;
}

function isJsonContentType(contentType: unknown): boolean {
  if (typeof contentType !== 'string') return false;
  // Covers `application/json` and `application/json; charset=utf-8` — the only
  // shapes Express's res.json emits.
  return contentType.toLowerCase().startsWith('application/json');
}

/** 204/304 (and any 1xx) responses have no body to compress. */
function isNoBodyStatus(statusCode: number): boolean {
  return (
    statusCode === 204 ||
    statusCode === 304 ||
    (statusCode >= 100 && statusCode < 200)
  );
}

/**
 * Attachment (Content-Disposition) and range (Content-Range) responses must be
 * delivered byte-exact: the filename handling, partial-content math, and
 * client-side download progress all assume the identity representation.
 */
function hasByteExactSemantics(res: Response): boolean {
  return (
    res.getHeader('Content-Disposition') !== undefined ||
    res.getHeader('Content-Range') !== undefined
  );
}

function coerceResponseBody(body: unknown): Buffer | undefined {
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  // Express 5 routes other shapes (objects, numbers) through res.json, which
  // re-enters res.send with the serialized string; nothing to do here.
  return undefined;
}

/**
 * Compress JSON API responses with gzip when the client asks for it (#6181).
 *
 * Web Shell session loads return multi-megabyte transcript JSON. On mobile /
 * bandwidth-constrained clients the uncompressed transfer is the dominant cost
 * of switching sessions, so the serve layer now negotiates gzip like any other
 * HTTP server. Browser `fetch` decompresses transparently — the client needs
 * no changes.
 *
 * Scope is deliberately narrow to keep the blast radius small:
 * - Mounted AFTER authentication and the rate limiter: 401/403/429 bodies are
 *   tiny and must not spend CPU on unauthenticated callers.
 * - Wraps `res.send` (the funnel Express's `res.json` flows through). SSE
 *   streams, `res.write`/`res.end` chunked responses, `res.sendFile`, and the
 *   Web Shell static/SPA mounts never pass through it and are untouched.
 * - Only `application/json` bodies at or above `threshold` bytes.
 * - Skips HEAD, no-body statuses, responses that already carry a
 *   `Content-Encoding`, and attachment/range downloads (byte-exact semantics).
 * - Compression runs on the async `zlib.gzip` callback path so the daemon's
 *   event loop keeps serving SSE frames while a large transcript is on the
 *   wire. Level stays at `Z_DEFAULT_COMPRESSION` (= 6): transcript JSON is
 *   highly repetitive text where level 6 captures nearly all of the win;
 *   higher levels cost noticeably more CPU on a local single-user daemon for
 *   marginal size savings.
 *
 * Every response that flows through the wrapper gets `Vary: Accept-Encoding`
 * so caches never reuse one client's identity/gzip representation for another.
 * On the compressed path the `ETag` set by Express is dropped instead of being
 * recomputed over the gzip bytes: one resource now legitimately has two
 * representations, and entity tags that ignore the encoding would collide.
 */
export function gzipJsonResponses(
  options: GzipJsonResponsesOptions = {},
): RequestHandler {
  const threshold =
    options.threshold !== undefined && options.threshold >= 0
      ? options.threshold
      : GZIP_MIN_RESPONSE_BYTES;
  return function gzipJsonResponsesMiddleware(req, res, next) {
    if (!acceptsGzip(req.headers['accept-encoding'])) {
      // This client never negotiates gzip; leave its responses untouched
      // (zero per-request overhead, no Vary noise).
      next();
      return;
    }
    const originalSend = res.send.bind(res);
    res.send = function gzipAwareSend(body: unknown) {
      res.append('Vary', 'Accept-Encoding');
      const passthrough = (): Response => originalSend(body);
      const payload = coerceResponseBody(body);
      if (
        req.method === 'HEAD' ||
        res.headersSent ||
        res.writableEnded ||
        isNoBodyStatus(res.statusCode) ||
        res.getHeader('Content-Encoding') !== undefined ||
        hasByteExactSemantics(res) ||
        !isJsonContentType(res.getHeader('Content-Type')) ||
        payload === undefined ||
        payload.byteLength < threshold
      ) {
        return passthrough();
      }
      // Z_DEFAULT_COMPRESSION keeps the CPU/size balance the zlib authors
      // tuned for text payloads (see the doc comment above).
      gzip(
        payload,
        { level: zlibConstants.Z_DEFAULT_COMPRESSION },
        (error, compressed) => {
          if (error || res.headersSent || res.writableEnded) {
            // Another writer already won the race; only recover when the
            // response is still open, otherwise stay silent to avoid a
            // double-send ERR_HTTP_HEADERS_SENT.
            if (!res.headersSent && !res.writableEnded) originalSend(body);
            return;
          }
          if (compressed.byteLength >= payload.byteLength) {
            // Incompressible payload — the identity body is smaller.
            originalSend(body);
            return;
          }
          res.removeHeader('ETag');
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Content-Length', String(compressed.byteLength));
          res.end(compressed);
        },
      );
      // res.send/res.json are chainable; the body is flushed asynchronously
      // by the gzip callback.
      return res;
    };
    next();
  };
}
