/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import type { Config } from '@qwen-code/qwen-code-core';
import { createApp } from './app.js';
import { setupWebSocket } from './websocket/handler.js';
import { findAvailablePort } from './utils/port.js';

export interface StartServerOptions {
  port?: number;
  host?: string;
  config: Config | null;
}

/**
 * Start the Web GUI server
 */
export async function startServer(
  options: StartServerOptions,
): Promise<number> {
  const { port = 5494, host = '127.0.0.1', config } = options;

  // Find available port
  const actualPort = await findAvailablePort(host, port);

  // Create Express app
  const app = createApp(config);

  // Create HTTP server
  const server = createServer(app);

  // Create WebSocket server
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss, config);

  // Start server
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(actualPort, host, () => {
      console.log(`Web GUI server listening on http://${host}:${actualPort}`);
      resolve(actualPort);
    });
  });
}

export { createApp } from './app.js';
