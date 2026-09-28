/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonHttpError } from '@qwen-code/sdk/daemon';

/**
 * The daemon's pre-auth Host gate (packages/cli/src/serve/auth.ts) answers
 * requests whose Host header it does not recognize with a fixed
 * `403 { error: 'Invalid Host header' }` — pinned by the daemon error
 * taxonomy (docs/developers/daemon/18-error-taxonomy.md) as a DNS-rebinding
 * protection, and deliberately opaque server-side. The remote-webview window
 * reaches the daemon through a forwarded port whose Host the gate cannot
 * know, so this rejection is the expected symptom of a port-forwarding
 * mismatch. The daemon string stays untouched; the web shell maps it to
 * actionable guidance client-side instead.
 */
const PRE_AUTH_INVALID_HOST_BODY = 'Invalid Host header';

/**
 * Matches exactly the pre-auth Host gate rejection shape: a
 * `DaemonHttpError`-shaped value with status 403 and the taxonomy-pinned
 * body `{ error: 'Invalid Host header' }`. Duck-typed on `status` + `body`
 * rather than `instanceof` so the match survives the SDK class being
 * duplicated across bundles. Any other 403 body, other statuses, transport
 * failures, and non-error values do not match.
 */
export function isDaemonPreAuthInvalidHostError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { status, body } = error as Pick<DaemonHttpError, 'status' | 'body'>;
  if (status !== 403) {
    return false;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return false;
  }
  return (
    (body as Record<string, unknown>)['error'] === PRE_AUTH_INVALID_HOST_BODY
  );
}
