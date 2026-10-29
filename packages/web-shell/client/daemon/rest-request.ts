/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DaemonClient } from '@qwen-code/sdk/daemon';
import { createDaemonClient, findDaemonAvailability } from './availability.js';

/** Native REST bridge, including hosts on an older supported peer SDK. */
export function createDaemonRestRequest(
  baseUrl: string,
  token?: string,
  client?: DaemonClient,
  bypassAvailability = false,
): (path: string, init?: RequestInit) => Promise<Response> {
  const sdk =
    client ??
    (bypassAvailability
      ? new DaemonClient({ baseUrl, token })
      : createDaemonClient({ baseUrl, token }));
  return async (path, init = {}) => {
    const availability = bypassAvailability
      ? undefined
      : findDaemonAvailability(baseUrl, token, sdk);
    const generation = availability?.getGeneration();
    availability?.assertAvailable();
    if (typeof sdk.requestRest === 'function') {
      // Caller signals own their deadlines; otherwise keep the SDK connect timeout.
      try {
        const response = await sdk.requestRest(
          path,
          init,
          init.signal ? 0 : undefined,
        );
        availability?.reportFailure(
          { status: response.status },
          init.signal ?? undefined,
          generation,
        );
        return response;
      } catch (error) {
        availability?.reportFailure(
          error,
          init.signal ?? undefined,
          generation,
        );
        throw error;
      }
    }
    if (
      !/^\/(?![/\\\t\r\n])/.test(path) ||
      new URL(path, 'http://daemon.invalid').origin !== 'http://daemon.invalid'
    ) {
      throw new Error('Daemon REST requests require an absolute route path');
    }
    const root = baseUrl.replace(/\/+$/, '');
    const base = new URL(`${root}/`, 'http://daemon.invalid');
    if (
      !new URL(`${root}${path}`, 'http://daemon.invalid').pathname.startsWith(
        base.pathname,
      )
    ) {
      throw new Error('Daemon REST requests must stay within the base path');
    }
    const headers = new Headers(
      token ? { Authorization: `Bearer ${token}` } : {},
    );
    new Headers(init.headers).forEach((value, name) =>
      headers.set(name, value),
    );
    const fetchImpl =
      sdk.transport?.restFetch ?? globalThis.fetch.bind(globalThis);
    const controller = init.signal ? undefined : new AbortController();
    const timer = controller
      ? setTimeout(
          () => controller.abort(new DOMException('timeout', 'TimeoutError')),
          30_000,
        )
      : undefined;
    try {
      return await (availability?.wrapFetch(fetchImpl) ?? fetchImpl)(
        `${root}${path}`,
        { ...init, headers, signal: init.signal ?? controller?.signal },
      );
    } finally {
      clearTimeout(timer);
    }
  };
}
