/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Internal stream retry allow-list. Keep this outside geminiChat.ts because
// that file is re-exported from the package barrel, and this retry policy is
// not part of the public API.
export const RETRYABLE_STREAM_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);
