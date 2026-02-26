/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseInstallSource } from './marketplace.js';
import * as fs from 'node:fs/promises';
import * as https from 'node:https';

// Mock dependencies
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
}));

vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

vi.mock('node:https', () => ({
  get: vi.fn(),
}));

vi.mock('./github.js', () => ({
  parseGitHubRepoForReleases: vi.fn((url: string) => {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
    throw new Error('Not a GitHub URL');
  }),
}));

describe('parseInstallSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: HTTPS requests fail (no marketplace config)
    vi.mocked(https.get).mockImplementation((_url, _options, callback) => {
      const mockRes = {
        statusCode: 404,
        on: vi.fn(),
      };
      if (typeof callback === 'function') {
        callback(mockRes as never);
      }
      return { on: vi.fn() } as never;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('owner/repo format parsing', () => {
    it('should parse owner/repo format without plugin name', async () => {
      // Mock stat to fail (not a local path)
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      const result = await parseInstallSource('owner/repo');

      expect(result.source).toBe('https://github.com/owner/repo');
      expect(result.type).toBe('git');
      expect(result.pluginName).toBeUndefined();
    });

    it('should parse owner/repo format with plugin name', async () => {
      // Mock stat to fail (not a local path)
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      const result = await parseInstallSource('owner/repo:my-plugin');

      expect(result.source).toBe('https://github.com/owner/repo');
      expect(result.type).toBe('git');
      expect(result.pluginName).toBe('my-plugin');
    });

    it('should handle owner/repo with dashes and underscores', async () => {
      // Mock stat to fail (not a local path)
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      const result = await parseInstallSource('my-org/my_repo:plugin-name');

      expect(result.source).toBe('https://github.com/my-org/my_repo');
      expect(result.pluginName).toBe('plugin-name');
    });
  });

  describe('HTTPS URL parsing', () => {
    it('should parse HTTPS GitHub URL without plugin name', async () => {
      // Mock stat to fail (not a local path)
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      const result = await parseInstallSource('https://github.com/owner/repo');

      expect(result.source).toBe('https://github.com/owner/repo');
      expect(result.type).toBe('git');
      expect(result.pluginName).toBeUndefined();
    });

    it('should parse HTTPS GitHub URL with plugin name', async () => {
      // Mock stat to fail (not a local path)
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      const result = await parseInstallSource(
        'https://github.com/owner/repo:my-plugin',
      );

      expect(result.source).toBe('https://github.com/owner/repo');
      expect(result.type).toBe('git');
      expect(result.pluginName).toBe('my-plugin');
    });

    it('should not treat port number as plugin name', async () => {
      // Mock stat to fail (not a local path)
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      const result = await parseInstallSource('https://example.com:8080/repo');

      expect(result.source).toBe('https://example.com:8080/repo');
      expect(result.pluginName).toBeUndefined();
    });
  });

  describe('git@ URL parsing', () => {
    it('should parse git@ URL without plugin name', async () => {
      // Mock stat to fail (not a local path)
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      const result = await parseInstallSource('git@github.com:owner/repo.git');

      expect(result.source).toBe('git@github.com:owner/repo.git');
      expect(result.type).toBe('git');
      expect(result.pluginName).toBeUndefined();
    });

    it('should parse git@ URL with plugin name', async () => {
      // Mock stat to fail (not a local path)
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      const result = await parseInstallSource(
        'git@github.com:owner/repo.git:my-plugin',
      );

      expect(result.source).toBe('git@github.com:owner/repo.git');
      expect(result.type).toBe('git');
      expect(result.pluginName).toBe('my-plugin');
    });
  });

  describe('local path parsing', () => {
    it('should parse relative path with ../ correctly', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({} as never);

      const result = await parseInstallSource('../claude-code');

      expect(result.source).toBe('../claude-code');
      expect(result.type).toBe('local');
      expect(result.pluginName).toBeUndefined();
    });

    it('should parse relative path with ./../ correctly', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({} as never);

      const result = await parseInstallSource('./../claude-code');

      expect(result.source).toBe('./../claude-code');
      expect(result.type).toBe('local');
      expect(result.pluginName).toBeUndefined();
    });

    it('should parse relative path with ./ correctly', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({} as never);

      const result = await parseInstallSource('./my-extension');

      expect(result.source).toBe('./my-extension');
      expect(result.type).toBe('local');
      expect(result.pluginName).toBeUndefined();
    });

    it('should parse local path without plugin name', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({} as never);

      const result = await parseInstallSource('/path/to/extension');

      expect(result.source).toBe('/path/to/extension');
      expect(result.type).toBe('local');
      expect(result.pluginName).toBeUndefined();
    });

    it('should parse local path with plugin name', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({} as never);

      const result = await parseInstallSource('/path/to/extension:my-plugin');

      expect(result.source).toBe('/path/to/extension');
      expect(result.type).toBe('local');
      expect(result.pluginName).toBe('my-plugin');
    });

    it('should throw error for non-existent path that looks like owner/repo', async () => {
      // First call to stat fails (path doesn't exist)
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      // Should fall through to owner/repo check and try to convert to GitHub URL
      const result = await parseInstallSource('some-org/some-repo');

      expect(result.source).toBe('https://github.com/some-org/some-repo');
      expect(result.type).toBe('git');
    });

    it('should throw error for non-existent path that is not valid format', async () => {
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      await expect(
        parseInstallSource('invalid-format-no-slash'),
      ).rejects.toThrow('Install source not found: invalid-format-no-slash');
    });

    it('should handle Windows drive letter correctly', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({} as never);

      const result = await parseInstallSource('C:\\path\\to\\extension');

      expect(result.source).toBe('C:\\path\\to\\extension');
      expect(result.type).toBe('local');
      // The colon after C should not be treated as plugin separator
      expect(result.pluginName).toBeUndefined();
    });
  });

  describe('marketplace config detection', () => {
    it('should detect marketplace type when config exists', async () => {
      // Mock stat to fail (not a local path)
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      const mockMarketplaceConfig = {
        name: 'test-marketplace',
        owner: { name: 'Test Owner' },
        plugins: [{ name: 'plugin1' }],
      };

      // Mock successful API response
      vi.mocked(https.get).mockImplementation((_url, _options, callback) => {
        const mockRes = {
          statusCode: 200,
          on: vi.fn((event, handler) => {
            if (event === 'data') {
              handler(Buffer.from(JSON.stringify(mockMarketplaceConfig)));
            }
            if (event === 'end') {
              handler();
            }
          }),
        };
        if (typeof callback === 'function') {
          callback(mockRes as never);
        }
        return { on: vi.fn() } as never;
      });

      const result = await parseInstallSource('owner/repo');

      expect(result.originSource).toBe('Claude');
      expect(result.marketplaceConfig).toEqual(mockMarketplaceConfig);
    });

    it('should remain git type when marketplace config not found', async () => {
      // Mock stat to fail (not a local path)
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      // HTTPS returns 404 (default mock behavior)
      const result = await parseInstallSource('owner/repo');

      expect(result.type).toBe('git');
      expect(result.marketplaceConfig).toBeUndefined();
    });
  });
});
