/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal authenticated HTTP client the per-daemon CLI commands use
 * (`qwen-rc fork`, `qwen-rc daemons health|whoami|add|remove`). The rest of
 * the CLI is deliberately daemon-free (on-disk reads); this is the single
 * seam that talks to a daemon over the wire.
 *
 * Error classification is what the CLI renders on:
 *  - {@link DaemonUnreachableError} — the fetch itself failed (DNS,
 *    connection refused, TLS, timeout); the daemon may be down.
 *  - {@link DaemonHttpError} — the daemon answered, but non-2xx; carries the
 *    HTTP status and the JSON body's `code` (e.g. `fork_mid_prompt`).
 */

export class DaemonUnreachableError extends Error {
  constructor(url: string, cause: unknown) {
    const msg =
      cause instanceof Error ? cause.message || cause.name : String(cause);
    super(`cannot reach ${url}: ${msg}`);
    this.name = 'DaemonUnreachableError';
  }
}

export class DaemonHttpError extends Error {
  readonly status: number;
  /** The JSON error body's `code` field, when present. */
  readonly code?: string;
  /** The parsed JSON error body (when the body was JSON). */
  readonly body?: unknown;

  constructor(status: number, body: unknown) {
    const b =
      body && typeof body === 'object'
        ? (body as Record<string, unknown>)
        : undefined;
    const message =
      b && typeof b.error === 'string' ? b.error : `HTTP ${status}`;
    super(`daemon returned ${status}: ${message}`);
    this.name = 'DaemonHttpError';
    this.status = status;
    this.body = body;
    if (b && typeof b.code === 'string') this.code = b.code;
  }
}

/** A successful (2xx) daemon response. */
export interface DaemonResponse {
  status: number;
  /** The parsed JSON body, or the raw text when the body was not JSON. */
  json: unknown;
}

export interface DaemonRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Absolute path, e.g. `/session/<id>/fork`. */
  path: string;
  /** JSON request body (sets Content-Type: application/json). */
  body?: unknown;
  /** Default 10 000 ms. */
  timeoutMs?: number;
  /**
   * Skip TLS certificate verification (self-signed local daemons). Sets
   * NODE_TLS_REJECT_UNAUTHORIZED=0 for the rest of this process — acceptable
   * here because the CLI exits right after the command.
   */
  insecure?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Perform one request against a daemon. `target.url` is the base (no trailing
 * slash required); `path` is joined onto it. Throws
 * DaemonUnreachableError / DaemonHttpError per the module contract.
 */
export async function daemonRequest(
  target: { url: string; token?: string },
  opts: DaemonRequestOptions,
): Promise<DaemonResponse> {
  if (opts.insecure && !process.env['NODE_TLS_REJECT_UNAUTHORIZED']) {
    // Process-lifetime: every caller is a short-lived CLI command.
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  }
  const url = new URL(opts.path, target.url.replace(/\/+$/, '') + '/');
  const headers: Record<string, string> = {};
  if (target.token) headers['Authorization'] = `Bearer ${target.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`),
      ),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: controller.signal,
      redirect: 'manual',
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === 'AbortError' || err.name === 'TimeoutError')
    ) {
      throw new DaemonUnreachableError(url.href, err);
    }
    throw new DaemonUnreachableError(url.href, err);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: unknown = text;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON — keep the raw text.
    }
  }
  if (res.status < 200 || res.status >= 300) {
    throw new DaemonHttpError(res.status, json);
  }
  return { status: res.status, json };
}

export type HealthStatus = 'ok' | 'unreachable' | 'error';

/**
 * `GET /rc/health` (public, no token) with a short timeout. `ok` = 200;
 * `error` = the daemon answered but not with 200; `unreachable` = the fetch
 * itself failed.
 */
export async function probeHealth(
  url: string,
  timeoutMs: number,
): Promise<HealthStatus> {
  try {
    const res = await daemonRequest(
      { url },
      {
        method: 'GET',
        path: '/rc/health',
        timeoutMs,
      },
    );
    return res.status === 200 ? 'ok' : 'error';
  } catch (err) {
    return err instanceof DaemonHttpError ? 'error' : 'unreachable';
  }
}
