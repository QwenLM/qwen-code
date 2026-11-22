/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, it } from 'vitest';
import { ProcessTransport } from '../../src/transport/ProcessTransport.js';

it('accepts a successful child result while a buffered stdin write is cut short', async () => {
  const transport = new ProcessTransport({
    spawnInfo: {
      command: process.execPath,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify({ type: "result", ok: true }) + "\\n", () => process.exit(0))',
        '--',
      ],
      type: 'node',
      originalInput: process.execPath,
    },
  });
  try {
    const messages: unknown[] = [];
    const completed = (async () => {
      for await (const message of transport.readMessages())
        messages.push(message);
    })();
    transport.write('x'.repeat(512 * 1024) + '\n');
    await completed;
    expect(messages).toEqual([{ type: 'result', ok: true }]);
    expect(transport.exitError).toBeNull();
  } finally {
    await transport.close();
  }
});
