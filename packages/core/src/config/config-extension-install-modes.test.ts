/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Config } from './config.js';

describe('extension installation without ambient discovery', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-install-mode-'));
    vi.stubEnv('QWEN_HOME', root);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['safe', 'bare'])(
    'keeps an installed extension out of the %s runtime when discovery has not run',
    async (mode) => {
      const source = path.join(root, 'source');
      fs.mkdirSync(source);
      fs.writeFileSync(
        path.join(source, 'qwen-extension.json'),
        JSON.stringify({
          name: 'mode-extension',
          version: '1.0.0',
          contextFileName: 'QWEN.md',
          mcpServers: { fixture: { command: 'node', args: ['fixture.js'] } },
        }),
      );
      fs.writeFileSync(path.join(source, 'QWEN.md'), 'Extension context');
      const config = new Config({
        cwd: root,
        targetDir: root,
        debugMode: false,
        usageStatisticsEnabled: false,
        model: 'test-model',
        safeMode: mode === 'safe',
        bareMode: mode === 'bare',
      });
      expect(config.getExtensions()).toEqual([]);
      await expect(
        config
          .getExtensionManager()
          .installExtension(
            { type: 'local', source },
            undefined,
            undefined,
            undefined,
            { name: 'mode-extension', version: '0.9.0' },
          ),
      ).rejects.toThrow('was not already installed, cannot update it');
      expect(config.getExtensions()).toEqual([]);
      const installed = await config
        .getExtensionManager()
        .installExtension({ type: 'local', source });
      expect(installed.name).toBe('mode-extension');
      expect.soft(config.getExtensions()).toEqual([]);
      expect.soft(config.getExtensionContextFilePaths()).toEqual([]);
      expect.soft(config.getMcpServers()).toEqual({});
    },
  );
});
