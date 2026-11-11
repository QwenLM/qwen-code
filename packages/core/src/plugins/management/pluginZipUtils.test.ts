/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const pluginTempSlug = process.env['BRAND_TEMP_PATH_SLUG'] || 'qwen-code';
const remoteTempPrefix = `${pluginTempSlug}-plugin-remote-`;

const zipMocks = vi.hoisted(() => ({
  downloaderConfig: undefined as { maxSize?: number } | undefined,
  failCleanup: false,
  download: vi.fn(async (_url: string, _destPath: string) => {}),
  extract: vi.fn(
    async (_zipPath: string, _opts: { dir: string }): Promise<void> => {},
  ),
  assertContainedSymlinks: vi.fn(async (_pluginRoot: string) => {}),
  installLocalPluginOp: vi.fn(),
  runLoggerWarn: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: (...args: Parameters<typeof actual.rm>) => {
      if (
        zipMocks.failCleanup &&
        path.basename(String(args[0])).startsWith(remoteTempPrefix)
      ) {
        return Promise.reject(new Error('simulated cleanup failure'));
      }
      return actual.rm(...args);
    },
  };
});

vi.mock('../../utils/archiveUtils.js', () => ({
  extractArchiveSafely: (
    zipPath: string,
    dir: string,
    options: { symlinkPolicy?: string },
  ) => zipMocks.extract(zipPath, { dir, ...options }),
  assertContainedSymlinks: zipMocks.assertContainedSymlinks,
}));

vi.mock('../../utils/downloader.js', () => ({
  Downloader: class {
    constructor(config?: { maxSize?: number }) {
      zipMocks.downloaderConfig = config;
    }

    async download(url: string, destPath: string): Promise<void> {
      return zipMocks.download(url, destPath);
    }
  },
}));
vi.mock('./pluginOperations.js', async (original) => ({
  ...(await original<typeof import('./pluginOperations.js')>()),
  installLocalPluginOp: zipMocks.installLocalPluginOp,
}));
import { runLogger } from '../../utils/runLogger.js';
import { installRemotePluginZip } from './pluginZipUtils.js';
import { isRemotePluginZipUrl } from './pluginManager.js';

describe('pluginZipUtils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(runLogger, 'warn').mockImplementation(zipMocks.runLoggerWarn);
    zipMocks.downloaderConfig = undefined;
    zipMocks.failCleanup = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recognizes remote ZIP URLs with case-insensitive paths and query strings', () => {
    expect(
      isRemotePluginZipUrl('https://example.test/plugin.ZIP?signature=abc'),
    ).toBe(true);
    expect(isRemotePluginZipUrl('http://example.test/plugin.zip')).toBe(true);
    expect(isRemotePluginZipUrl('https://example.test/plugin.tar.gz')).toBe(
      false,
    );
    expect(isRemotePluginZipUrl('./plugin.zip')).toBe(false);
  });

  it('installs a wrapped plugin ZIP while ignoring Finder metadata', async () => {
    let tempDir: string | undefined;
    zipMocks.extract.mockImplementation(async (_zipPath, opts) => {
      tempDir = path.dirname(opts.dir);
      await fs.mkdir(path.join(opts.dir, '__MACOSX'), { recursive: true });
      await fs.mkdir(path.join(opts.dir, 'demo-plugin', 'skills'), {
        recursive: true,
      });
    });
    zipMocks.installLocalPluginOp.mockImplementation(
      async (pluginRoot: string, scope: string, options: unknown) => ({
        ok: true,
        pluginId: 'demo-plugin@local',
        plugin: {
          name: 'demo-plugin',
          source: 'local',
          repository: 'local',
          path: pluginRoot,
          enabled: true,
          manifest: { name: 'demo-plugin', version: '1.0.0' },
        },
        installPath: '/cache/demo-plugin/1.0.0',
        marketplace: 'local',
        scope,
        options,
      }),
    );

    const url = 'https://example.test/demo.zip?signature=abc';
    const result = await installRemotePluginZip(url, 'project', {
      projectPath: '/workspace',
    });

    expect(result.ok).toBe(true);
    expect(zipMocks.downloaderConfig?.maxSize).toBe(100 * 1024 * 1024);
    expect(zipMocks.download).toHaveBeenCalledWith(
      url,
      expect.stringContaining('download.zip'),
    );
    expect(zipMocks.extract).toHaveBeenCalledWith(
      expect.stringContaining('download.zip'),
      expect.objectContaining({ symlinkPolicy: 'allow-contained' }),
    );
    expect(zipMocks.installLocalPluginOp).toHaveBeenCalledWith(
      expect.stringMatching(/demo[/\\]demo-plugin$/),
      'project',
      { projectPath: '/workspace' },
    );
    expect(zipMocks.assertContainedSymlinks).toHaveBeenCalledWith(
      expect.stringMatching(/demo[/\\]demo-plugin$/),
    );
    expect(tempDir).toBeDefined();
    expect(path.basename(tempDir!).startsWith(remoteTempPrefix)).toBe(true);
    await expect(fs.stat(tempDir!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the archive filename for a flat manifest-less plugin', async () => {
    zipMocks.extract.mockImplementation(async (_zipPath, opts) => {
      await fs.mkdir(path.join(opts.dir, 'commands'), { recursive: true });
    });
    zipMocks.installLocalPluginOp.mockResolvedValue({
      ok: false,
      error: {
        type: 'generic-error',
        source: 'install-local',
        error: 'test result',
      },
    });

    await installRemotePluginZip('https://example.test/demo.zip', 'user');

    expect(zipMocks.installLocalPluginOp).toHaveBeenCalledWith(
      expect.stringMatching(/[/\\]demo$/),
      'user',
      undefined,
    );
  });

  it('does not report install failure when temporary cleanup fails', async () => {
    let tempDir: string | undefined;
    zipMocks.extract.mockImplementation(async (_zipPath, opts) => {
      tempDir = path.dirname(opts.dir);
      await fs.mkdir(path.join(opts.dir, 'commands'), { recursive: true });
    });
    zipMocks.installLocalPluginOp.mockResolvedValue({
      ok: true,
      pluginId: 'demo@local',
      plugin: {
        name: 'demo',
        source: 'local',
        repository: 'local',
        path: '/cache/demo',
        enabled: true,
        manifest: { name: 'demo', version: '1.0.0' },
      },
      installPath: '/cache/demo/1.0.0',
      marketplace: 'local',
    });
    zipMocks.failCleanup = true;

    await expect(
      installRemotePluginZip('https://example.test/demo.zip', 'user'),
    ).resolves.toMatchObject({ ok: true, pluginId: 'demo@local' });
    expect(zipMocks.runLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to clean temporary directory'),
      expect.objectContaining({ message: 'simulated cleanup failure' }),
    );

    zipMocks.failCleanup = false;
    expect(tempDir).toBeDefined();
    await fs.rm(tempDir!, { recursive: true, force: true });
  });

  it('rejects insecure HTTP URLs before downloading', async () => {
    await expect(
      installRemotePluginZip('http://example.test/demo.zip', 'user'),
    ).rejects.toThrow('requires an HTTPS .zip URL');
    expect(zipMocks.download).not.toHaveBeenCalled();
  });

  it('does not install when archive symlink validation fails', async () => {
    zipMocks.extract.mockRejectedValue(
      new Error('Refusing to install: symlink points outside the archive.'),
    );

    await expect(
      installRemotePluginZip('https://example.test/demo.zip', 'user'),
    ).rejects.toThrow('symlink points outside the archive');
    expect(zipMocks.installLocalPluginOp).not.toHaveBeenCalled();
  });
});
