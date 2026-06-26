/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request } from 'express';

/**
 * Allow same-origin requests from the demo page. Browsers send an `Origin`
 * header on same-origin POST/fetch calls; the browser-origin wall would reject
 * them. Only loopback origins are matched.
 */
export function installSelfOriginStripMiddleware(
  app: Application,
  getPort: () => number,
): void {
  let cachedStripPort = -1;
  let cachedSelfOrigins: Set<string> = new Set();

  app.use((req: Request, _res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      const port = getPort();
      if (port !== cachedStripPort) {
        cachedStripPort = port;
        cachedSelfOrigins = new Set([
          `http://127.0.0.1:${port}`,
          `http://localhost:${port}`,
          `http://[::1]:${port}`,
          `http://host.docker.internal:${port}`,
        ]);
      }
      if (cachedSelfOrigins.has(origin)) {
        delete req.headers.origin;
      }
    }
    next();
  });
}
