/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridge an {@link AcmeManager}'s rotating cert to a long-lived `https` server. The
 * server is created with an `SNICallback` that returns the CURRENT secure context;
 * a renewal calls {@link LiveTlsContext.update} (wired to the manager's `onChange`)
 * so the new cert is served on the next handshake — no restart, no dropped
 * connections. The callback must read the live context per handshake (not capture
 * one at boot), which is exactly what this indirection guarantees.
 */
import { createSecureContext, type SecureContext } from 'node:tls';
import type { CertBundle } from './acme/certStore.js';

/** Build a TLS secure context that serves the full chain (leaf + issuers). */
export function buildSecureContext(bundle: CertBundle): SecureContext {
  const fullchain = `${bundle.cert.trim()}\n${bundle.chain.trim()}\n`;
  return createSecureContext({ cert: fullchain, key: bundle.privateKey });
}

export interface LiveTlsContext {
  /** Pass as `https.createServer({ SNICallback })`. Serves the current cert. */
  sniCallback: (
    servername: string,
    cb: (err: Error | null, ctx?: SecureContext) => void,
  ) => void;
  /** Swap in a renewed cert (wire to `AcmeManager.onChange`). */
  update: (bundle: CertBundle) => void;
}

/**
 * A live TLS context seeded from the initial bundle. `build` is injectable so the
 * swap logic is unit-testable without real PEM material.
 */
export function createLiveTlsContext(
  initial: CertBundle,
  build: (bundle: CertBundle) => SecureContext = buildSecureContext,
): LiveTlsContext {
  let ctx = build(initial);
  return {
    sniCallback: (_servername, cb) => cb(null, ctx),
    update: (bundle) => {
      ctx = build(bundle);
    },
  };
}
