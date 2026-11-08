/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';

let staleSocketSequence = 0;

export async function leaveStaleSocket(socketPath: string): Promise<void> {
  const livePath = path.join(
    path.dirname(socketPath),
    `.stale-${staleSocketSequence++}`,
  );
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(livePath, resolve);
  });
  try {
    await fs.rename(livePath, socketPath);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
