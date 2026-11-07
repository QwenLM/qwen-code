/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as http from 'node:http';

/** Upper bound on one probe round-trip; a loopback daemon answers in ms. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Ask the daemon's pre-auth Host gate whether it will reject requests that
 * carry `externalAuthority` as their Host header.
 *
 * The gate deliberately sits ahead of the CORS middleware (DNS-rebinding
 * defense), so its 403 carries no `Access-Control-Allow-Origin` and a
 * browser can never read it: cross-origin the fetch rejects with an opaque
 * `TypeError`, and same-origin the shell document itself is 403'd before any
 * script runs. The extension host is not CORS-bound, so it can ask the gate
 * directly — send the exact Host header the webview's browser WILL send (the
 * forwarded URL's authority) and let the gate answer authoritatively.
 *
 * Resolves `true` only on a 403 whose JSON body is
 * `{error: 'Invalid Host header'}`; any other status, a different or
 * malformed body, a timeout, or a connection error resolves `false`. Never
 * rejects.
 */
export function probePreAuthHostGateRejection(
  daemonBaseUrl: string,
  externalAuthority: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let request: http.ClientRequest;
    try {
      request = http.get(
        `${daemonBaseUrl}/capabilities`,
        {
          // node:http honors an explicit Host header (fetch/undici treat it
          // as forbidden) — that override is the whole point of the probe.
          headers: { Host: externalAuthority },
          timeout: PROBE_TIMEOUT_MS,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            if (response.statusCode !== 403) {
              resolve(false);
              return;
            }
            try {
              const body: unknown = JSON.parse(
                Buffer.concat(chunks).toString('utf8'),
              );
              resolve(
                (body as { error?: unknown } | null)?.error ===
                  'Invalid Host header',
              );
            } catch {
              resolve(false);
            }
          });
          response.on('error', () => resolve(false));
        },
      );
    } catch {
      resolve(false);
      return;
    }
    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}
