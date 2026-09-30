/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isLoopbackBind } from './loopback-binds.js';

export function resolveManagedRuntimeBrokerBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Managed Runtime Broker URL is invalid.');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('Managed Runtime Broker URL must be an HTTP(S) origin.');
  }
  if (url.protocol === 'http:' && !isLoopbackBind(url.hostname)) {
    throw new Error(
      'Managed Runtime Broker URL must use HTTPS outside the loopback interface.',
    );
  }
  url.pathname = '/';
  return url;
}
