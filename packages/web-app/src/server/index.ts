/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createApp } from './app.js';
import { setupWebSocket } from './websocket/handler.js';
import { findAvailablePort } from './utils/port.js';
import { pathToFileURL } from 'url';

export interface StartServerOptions {
  port?: number;
  host?: string;
  cwd?: string;
  // Deprecated, kept for API compatibility.
  config?: unknown;
}

/**
 * Start the Web GUI server
 */
export async function startServer(
  options: StartServerOptions,
): Promise<number> {
  const { port = 5494, host = '127.0.0.1' } = options;

  const actualPort = await findAvailablePort(host, port);

  const app = createApp();
  const server = createServer(app);

  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(actualPort, host, () => {
      console.log(`Web GUI server listening on http://${host}:${actualPort}`);
      resolve(actualPort);
    });
  });
}

export { createApp } from './app.js';

async function startFromEnv(): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  const host = env['QWEN_CODE_WEB_HOST'] ?? env['WEB_APP_HOST'] ?? '127.0.0.1';
  const port = Number(env['QWEN_CODE_WEB_PORT'] ?? env['WEB_APP_PORT']) || 5495;

  await startServer({ host, port });
}

function isMainModule(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  startFromEnv().catch((error) => {
    console.error('Failed to start Web GUI server:', error);
    process.exit(1);
  });
}
