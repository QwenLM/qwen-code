/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request } from 'express';
import { formatHostForAuthority, isLoopbackBind } from '../loopback-binds.js';

/**
 * Allow same-origin requests from the Web Shell. Browsers send an `Origin`
 * header on same-origin POST/fetch calls; the browser-origin wall would reject
 * them. Only loopback origins are matched.
 */
export function installSelfOriginStripMiddleware(
  app: Application,
  getPort: () => number,
  bind: string,
): void {
  let cachedStripPort = -1;
  let cachedSelfOrigins: Set<string> = new Set();
  const boundHost = isLoopbackBind(bind)
    ? formatHostForAuthority(bind)
    : undefined;

  app.use((req: Request, _res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      const port = getPort();
      if (port !== cachedStripPort) {
        cachedStripPort = port;
        // Both schemes: under `--tls-cert/--tls-key` the loopback web
        // shell is served over https, so its same-origin requests carry
        // an `https://` Origin. Loopback hosts are trusted as same-origin
        // regardless of scheme.
        cachedSelfOrigins = new Set([
          `http://127.0.0.1:${port}`,
          `http://localhost:${port}`,
          `http://[::1]:${port}`,
          `http://host.docker.internal:${port}`,
          `https://127.0.0.1:${port}`,
          `https://localhost:${port}`,
          `https://[::1]:${port}`,
          `https://host.docker.internal:${port}`,
        ]);
        if (boundHost) {
          cachedSelfOrigins.add(`http://${boundHost}:${port}`);
          cachedSelfOrigins.add(`https://${boundHost}:${port}`);
        }
        // RFC 7230 §5.4: browsers omit the port in the Origin header when
        // it matches the scheme default (http→80, https→443).
        if (port === 80) {
          for (const host of [
            '127.0.0.1',
            'localhost',
            '[::1]',
            'host.docker.internal',
          ]) {
            cachedSelfOrigins.add(`http://${host}`);
          }
          if (boundHost) {
            cachedSelfOrigins.add(`http://${boundHost}`);
          }
        } else if (port === 443) {
          for (const host of [
            '127.0.0.1',
            'localhost',
            '[::1]',
            'host.docker.internal',
          ]) {
            cachedSelfOrigins.add(`https://${host}`);
          }
          if (boundHost) {
            cachedSelfOrigins.add(`https://${boundHost}`);
          }
        }
      }
      if (cachedSelfOrigins.has(origin)) {
        delete req.headers.origin;
      }
    }
    next();
  });
}
