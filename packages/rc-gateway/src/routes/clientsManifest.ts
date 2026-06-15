/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GET /ui/clients-manifest.json (add-multi-workspace-client "Manifest endpoint
 * on daemons"). Owner-scope only. Returns the operator's `~/.qwen/rc/clients.toml`
 * (the multi-daemon registry) parsed to JSON so the web client can render its
 * daemon switcher without the operator hand-copying URLs.
 *
 * Spec-faithful details:
 *  - the TOML file uses `[[daemon]]` (singular) array-of-tables; the JSON output
 *    key is `daemons` (plural).
 *  - `generatedAt` is endpoint-generated (cache-build time), NOT read from file.
 *  - entries pass through verbatim — `default` is NOT synthesized (the client
 *    interprets "no explicit default → first entry is default").
 *  - missing or invalid TOML → `{ daemons: [], warning }` with status 200.
 *  - the response is cached server-side for 60 s.
 *
 * Security: this route lives in the otherwise-unauthenticated `/ui/` namespace
 * and MUST be mounted with route-level `bearerResolve` + `requireScope(OWNER)`
 * BEFORE the static `/ui` handler (the global bearer middleware runs after it).
 * The manifest body (urls / tokenStorageKeys) is NEVER logged.
 */

import type { RequestHandler } from 'express';
import { parse as parseToml } from 'smol-toml';

export interface ClientsManifest {
  daemons: unknown[];
  generatedAt?: string;
  warning?: string;
}

/**
 * Build the manifest from raw TOML text (or `null` when the file is absent).
 * Pure and total — never throws; a parse failure becomes a `warning`.
 */
export function buildClientsManifest(
  tomlText: string | null,
  nowIso: string,
): ClientsManifest {
  if (tomlText === null) {
    return { daemons: [], warning: 'clients.toml not found' };
  }
  let parsed: unknown;
  try {
    parsed = parseToml(tomlText);
  } catch (err) {
    return {
      daemons: [],
      warning: `invalid clients.toml: ${(err as Error).message}`,
    };
  }
  const daemon = (parsed as { daemon?: unknown }).daemon;
  const daemons = Array.isArray(daemon) ? daemon : [];
  return { daemons, generatedAt: nowIso };
}

export interface ClientsManifestRouteDeps {
  /** Read the registry file; resolve `null` on ENOENT, reject on other errors. */
  readToml: () => Promise<string | null>;
  now: () => number;
  /** Cache TTL in ms (default 60 000). */
  ttlMs?: number;
}

/**
 * The manifest route. Owner-scope is enforced by the caller's route middleware;
 * this handler self-catches (no global error middleware) and always answers 200
 * (a read failure degrades to `{ daemons: [], warning }`, never a 5xx).
 */
export function createClientsManifestRoute(
  deps: ClientsManifestRouteDeps,
): RequestHandler {
  const ttl = deps.ttlMs ?? 60_000;
  let cache: { at: number; body: ClientsManifest } | undefined;
  return async (_req, res) => {
    try {
      const now = deps.now();
      if (!cache || now - cache.at >= ttl) {
        const text = await deps.readToml();
        cache = {
          at: now,
          body: buildClientsManifest(text, new Date(now).toISOString()),
        };
      }
      res.status(200).json(cache.body);
    } catch {
      // Unexpected read error (not ENOENT, which readToml maps to null). Degrade
      // to the documented warning shape; do not leak the path/body.
      res
        .status(200)
        .json({ daemons: [], warning: 'cannot read clients.toml' });
    }
  };
}
