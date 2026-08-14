/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { rendererResponse, resolveRendererAsset } from './app-protocol';

describe('Electron renderer protocol', () => {
  const root = path.resolve('/renderer');

  it('maps the trusted application origin into renderer assets', () => {
    expect(resolveRendererAsset(root, 'qwen-desktop://app/')).toBe(
      path.join(root, 'index.html'),
    );
    expect(
      resolveRendererAsset(root, 'qwen-desktop://app/assets/index.js'),
    ).toBe(path.join(root, 'assets', 'index.js'));
  });

  it('rejects other hosts and traversal', () => {
    expect(
      resolveRendererAsset(root, 'qwen-desktop://evil/index.html'),
    ).toBeUndefined();
    expect(
      resolveRendererAsset(root, 'qwen-desktop://app/%2e%2e/secret'),
    ).toBeUndefined();
  });

  it('serves emitted font assets with a browser-compatible content type', async () => {
    const rendererRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-electron-protocol-'),
    );
    try {
      await fs.writeFile(path.join(rendererRoot, 'font.woff'), 'font');
      const response = await rendererResponse(
        rendererRoot,
        'qwen-desktop://app/font.woff',
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('font/woff');
    } finally {
      await fs.rm(rendererRoot, { recursive: true, force: true });
    }
  });
});
