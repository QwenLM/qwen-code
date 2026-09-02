/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ensureBrowserBroker } from './broker-launcher.js';

describe('Browser Broker launcher', () => {
  it('does not expose model-provider credentials to the detached Broker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qbu-launcher-'));
    const brokerPath = join(root, 'broker.mjs');
    const outputPath = join(root, 'environment.json');
    const previous = process.env['DASHSCOPE_API_KEY'];
    try {
      writeFileSync(
        brokerPath,
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(outputPath)}, JSON.stringify(process.env));\n`,
      );
      process.env['DASHSCOPE_API_KEY'] = 'must-not-reach-broker';
      await ensureBrowserBroker(brokerPath, join(root, 'broker.sock'));
      await waitFor(() => existsSync(outputPath));
      const environment = JSON.parse(
        readFileSync(outputPath, 'utf8'),
      ) as Record<string, string>;
      expect(environment['QWEN_BROWSER_USE_SOCKET_PATH']).toBe(
        join(root, 'broker.sock'),
      );
      expect(environment['DASHSCOPE_API_KEY']).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env['DASHSCOPE_API_KEY'];
      else process.env['DASHSCOPE_API_KEY'] = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the Browser SDK on the shared Broker path', () => {
    const source = readFileSync(
      new URL('./sdk-backend.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('new BrokerClientTransport');
    expect(source).toContain('ensureBrowserBroker');
    expect(source).not.toContain('ChromeExtensionTransport');
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Broker');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
