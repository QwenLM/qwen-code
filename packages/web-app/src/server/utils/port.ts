/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import net from 'net';

const MAX_PORT_ATTEMPTS = 10;

/**
 * Check if a port is available
 */
function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => {
      resolve(false);
    });

    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });

    server.listen(port, host);
  });
}

/**
 * Find an available port starting from the given port
 */
export async function findAvailablePort(
  host: string,
  startPort: number,
): Promise<number> {
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset++) {
    const port = startPort + offset;
    if (await isPortAvailable(host, port)) {
      return port;
    }
    if (offset > 0) {
      console.log(
        `Port ${startPort + offset - 1} is in use, trying ${port}...`,
      );
    }
  }

  throw new Error(
    `Cannot find available port in range ${startPort}-${startPort + MAX_PORT_ATTEMPTS - 1}`,
  );
}
