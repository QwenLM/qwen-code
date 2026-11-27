/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read an OAuth client secret:
 *   1. If the `MCP_CLIENT_SECRET` env var is set, return it.
 *   2. Otherwise, prompt interactively on a raw-mode TTY.
 *
 * Throws when no env var is set and stdin is not a TTY (e.g. in
 * non-interactive SDK / pipe invocations). Non-interactive callers should
 * set `MCP_CLIENT_SECRET` instead.
 */
export async function readClientSecret(): Promise<string> {
  const envSecret = process.env['MCP_CLIENT_SECRET'];
  if (envSecret) {
    return envSecret;
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      'No TTY available to prompt for client secret. Set MCP_CLIENT_SECRET env var instead.',
    );
  }

  return new Promise<string>((resolve, reject) => {
    process.stderr.write('Enter OAuth client secret: ');
    process.stdin.setRawMode?.(true);
    let secret = '';
    const onData = (chunk: Buffer) => {
      const c = chunk.toString();
      if (c === '\n' || c === '\r') {
        process.stdin.setRawMode?.(false);
        process.stdin.removeListener('data', onData);
        process.stderr.write('\n');
        resolve(secret);
      } else if (c === '\u0003') {
        // Ctrl-C
        process.stdin.setRawMode?.(false);
        process.stdin.removeListener('data', onData);
        reject(new Error('Cancelled'));
      } else if (c === '\u007F' || c === '\b') {
        secret = secret.slice(0, -1);
      } else {
        secret += c;
      }
    };
    process.stdin.on('data', onData);
  });
}
