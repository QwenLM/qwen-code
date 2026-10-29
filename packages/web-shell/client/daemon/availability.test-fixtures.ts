/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DaemonAvailability } from './availability.js';

export function offlineDaemon(
  baseUrl = 'http://daemon',
  features: string[] = [],
) {
  const server = { healthy: false };
  const nativeFetch: typeof fetch = async (input) => {
    if (!server.healthy) throw new TypeError('offline');
    return Response.json(
      String(input).endsWith('/health') ? { status: 'ok' } : { features },
    );
  };
  return {
    server,
    availability: new DaemonAvailability(baseUrl, undefined, nativeFetch),
  };
}
