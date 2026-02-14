/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:fs');
vi.mock('node:os');

describe('settingsReader', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.mocked(os.homedir).mockReturnValue('/mock/home');
  });

  async function loadModule() {
    return await import('./settingsReader.js');
  }

  describe('isDedicatedTerminalEnabled', () => {
    it('should return true when ide.dedicatedTerminal is true', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ ide: { dedicatedTerminal: true } }),
      );

      const { isDedicatedTerminalEnabled } = await loadModule();
      expect(isDedicatedTerminalEnabled()).toBe(true);
      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.join('/mock/home', '.qwen', 'settings.json'),
        'utf-8',
      );
    });

    it('should return false when ide.dedicatedTerminal is false', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ ide: { dedicatedTerminal: false } }),
      );

      const { isDedicatedTerminalEnabled } = await loadModule();
      expect(isDedicatedTerminalEnabled()).toBe(false);
    });

    it('should return true when ide section is missing', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));

      const { isDedicatedTerminalEnabled } = await loadModule();
      expect(isDedicatedTerminalEnabled()).toBe(true);
    });

    it('should return true when ide.dedicatedTerminal is not set', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ide: {} }));

      const { isDedicatedTerminalEnabled } = await loadModule();
      expect(isDedicatedTerminalEnabled()).toBe(true);
    });

    it('should return true when ide.dedicatedTerminal is not a boolean', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ ide: { dedicatedTerminal: 'yes' } }),
      );

      const { isDedicatedTerminalEnabled } = await loadModule();
      expect(isDedicatedTerminalEnabled()).toBe(true);
    });

    it('should return true when settings file does not exist', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      const { isDedicatedTerminalEnabled } = await loadModule();
      expect(isDedicatedTerminalEnabled()).toBe(true);
    });

    it('should return true when settings file contains invalid JSON', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json');

      const { isDedicatedTerminalEnabled } = await loadModule();
      expect(isDedicatedTerminalEnabled()).toBe(true);
    });

    it('should return true when settings has other ide properties but no dedicatedTerminal', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ ide: { enabled: true, hasSeenNudge: true } }),
      );

      const { isDedicatedTerminalEnabled } = await loadModule();
      expect(isDedicatedTerminalEnabled()).toBe(true);
    });
  });
});
