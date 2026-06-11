/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readQwenMarketplaceConfig,
  resolveQwenMarketplaceExtensionDir,
} from './qwenMarketplace.js';
import { cloneFromGit } from './github.js';
import { QWEN_MARKETPLACE_CONFIG_FILENAME } from './variables.js';
import type { QwenMarketplaceConfig } from './marketplaceTypes.js';

vi.mock('./github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github.js')>();
  return {
    ...actual,
    cloneFromGit: vi.fn(),
    downloadFromGitHubRelease: vi.fn(),
  };
});

describe('qwenMarketplace', () => {
  let marketplaceDir: string;

  const writeManifest = (config: QwenMarketplaceConfig | object) => {
    fs.writeFileSync(
      path.join(marketplaceDir, QWEN_MARKETPLACE_CONFIG_FILENAME),
      JSON.stringify(config),
    );
  };

  beforeEach(() => {
    marketplaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-mkt-'));
  });

  afterEach(() => {
    fs.rmSync(marketplaceDir, { recursive: true, force: true });
  });

  describe('readQwenMarketplaceConfig', () => {
    it('reads a valid manifest', () => {
      writeManifest({
        name: 'm',
        extensions: [{ name: 'foo', source: './foo' }],
      });
      const config = readQwenMarketplaceConfig(marketplaceDir);
      expect(config?.name).toBe('m');
      expect(config?.extensions).toHaveLength(1);
    });

    it('returns null when the manifest is missing or malformed', () => {
      expect(readQwenMarketplaceConfig(marketplaceDir)).toBeNull();

      writeManifest({ name: 'm' }); // no extensions array
      expect(readQwenMarketplaceConfig(marketplaceDir)).toBeNull();

      fs.writeFileSync(
        path.join(marketplaceDir, QWEN_MARKETPLACE_CONFIG_FILENAME),
        'not json',
      );
      expect(readQwenMarketplaceConfig(marketplaceDir)).toBeNull();
    });
  });

  describe('resolveQwenMarketplaceExtensionDir', () => {
    it('resolves a relative entry source within the marketplace', async () => {
      const extDir = path.join(marketplaceDir, 'foo');
      fs.mkdirSync(extDir);
      writeManifest({
        name: 'm',
        extensions: [{ name: 'foo', source: './foo' }],
      });

      const resolved = await resolveQwenMarketplaceExtensionDir(
        marketplaceDir,
        'foo',
      );
      expect(path.resolve(resolved.extensionDir)).toBe(path.resolve(extDir));
    });

    it('honors metadata.extensionRoot for relative sources', async () => {
      const extDir = path.join(marketplaceDir, 'extensions', 'foo');
      fs.mkdirSync(extDir, { recursive: true });
      writeManifest({
        name: 'm',
        metadata: { extensionRoot: 'extensions' },
        extensions: [{ name: 'foo', source: './foo' }],
      });

      const resolved = await resolveQwenMarketplaceExtensionDir(
        marketplaceDir,
        'foo',
      );
      expect(path.resolve(resolved.extensionDir)).toBe(path.resolve(extDir));
    });

    it('resolves "." to the marketplace directory itself', async () => {
      writeManifest({
        name: 'm',
        extensions: [{ name: 'self', source: '.' }],
      });
      const resolved = await resolveQwenMarketplaceExtensionDir(
        marketplaceDir,
        'self',
      );
      expect(path.resolve(resolved.extensionDir)).toBe(
        path.resolve(marketplaceDir),
      );
    });

    it('rejects a relative source that escapes via ..', async () => {
      // A sibling dir that would be the escape target; resolution must refuse
      // it even though it exists.
      fs.mkdirSync(path.join(path.dirname(marketplaceDir), 'outside'), {
        recursive: true,
      });
      writeManifest({
        name: 'm',
        extensions: [{ name: 'evil', source: '../outside' }],
      });
      await expect(
        resolveQwenMarketplaceExtensionDir(marketplaceDir, 'evil'),
      ).rejects.toThrow(/escapes the marketplace directory/);
    });

    it('rejects an absolute source path', async () => {
      writeManifest({
        name: 'm',
        extensions: [{ name: 'evil', source: path.resolve(os.tmpdir()) }],
      });
      await expect(
        resolveQwenMarketplaceExtensionDir(marketplaceDir, 'evil'),
      ).rejects.toThrow(/escapes the marketplace directory/);
    });

    it('rejects an extensionRoot that escapes via ..', async () => {
      writeManifest({
        name: 'm',
        metadata: { extensionRoot: '../../etc' },
        extensions: [{ name: 'foo', source: './foo' }],
      });
      await expect(
        resolveQwenMarketplaceExtensionDir(marketplaceDir, 'foo'),
      ).rejects.toThrow(/escapes the marketplace directory/);
    });

    it('throws for an unknown entry name', async () => {
      writeManifest({
        name: 'm',
        extensions: [{ name: 'foo', source: './foo' }],
      });
      await expect(
        resolveQwenMarketplaceExtensionDir(marketplaceDir, 'missing'),
      ).rejects.toThrow(/missing not found/);
    });

    it('throws when a relative source does not exist', async () => {
      writeManifest({
        name: 'm',
        extensions: [{ name: 'foo', source: './nope' }],
      });
      await expect(
        resolveQwenMarketplaceExtensionDir(marketplaceDir, 'foo'),
      ).rejects.toThrow(/not found/);
    });

    it('rejects a git@/ssh string source with a structured-form hint', async () => {
      writeManifest({
        name: 'm',
        extensions: [{ name: 'foo', source: 'git@github.com:owner/repo.git' }],
      });
      await expect(
        resolveQwenMarketplaceExtensionDir(marketplaceDir, 'foo'),
      ).rejects.toThrow(/structured form/);
    });

    it('throws for an unsupported structured source', async () => {
      writeManifest({
        name: 'm',
        extensions: [
          { name: 'foo', source: { type: 'ftp', url: 'x' } as never },
        ],
      });
      await expect(
        resolveQwenMarketplaceExtensionDir(marketplaceDir, 'foo'),
      ).rejects.toThrow(/Unsupported/);
    });

    it('cleans up the download dir when a remote fetch fails', async () => {
      let downloadDir: string | undefined;
      vi.mocked(cloneFromGit).mockImplementation(
        async (_meta: unknown, dest: string) => {
          downloadDir = dest;
          throw new Error('clone failed');
        },
      );
      writeManifest({
        name: 'm',
        extensions: [
          { name: 'foo', source: { type: 'git', url: 'x', ref: 'v1' } },
        ],
      });

      await expect(
        resolveQwenMarketplaceExtensionDir(marketplaceDir, 'foo'),
      ).rejects.toThrow(/clone failed/);
      expect(downloadDir).toBeDefined();
      expect(fs.existsSync(downloadDir!)).toBe(false);
    });
  });
});
