/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  INSTALL_METADATA_FILENAME,
  EXTENSIONS_CONFIG_FILENAME,
} from './variables.js';
import { ExtensionStorage } from './storage.js';
import { QWEN_DIR } from '../config/storage.js';
import {
  ExtensionManager,
  ExtensionUpdateState,
  SettingScope,
  type ExtensionManagerOptions,
  type Extension,
  validateName,
  getExtensionId,
  hashValue,
  type ExtensionConfig,
  type ExtensionMutationEvent,
  type PreparedExtensionMutation,
} from './extensionManager.js';
import type { MCPServerConfig, ExtensionInstallMetadata } from '../index.js';
import { ExtensionStore } from './extension-store.js';

const mockGit = {
  clone: vi.fn(),
  getRemotes: vi.fn(),
  fetch: vi.fn(),
  checkout: vi.fn(),
  listRemote: vi.fn(),
  revparse: vi.fn(),
  path: vi.fn(),
};
const mockDownloadFromArchiveUrl = vi.hoisted(() => vi.fn());
const mockExtractArchiveFile = vi.hoisted(() => vi.fn());

vi.mock('simple-git', () => ({
  simpleGit: vi.fn((path: string) => {
    mockGit.path.mockReturnValue(path);
    return mockGit;
  }),
}));

vi.mock('./github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./github.js')>();
  return {
    ...actual,
    downloadFromArchiveUrl: mockDownloadFromArchiveUrl,
    downloadFromGitHubRelease: vi
      .fn()
      .mockRejectedValue(new Error('Mocked GitHub release download failure')),
    extractArchiveFile: mockExtractArchiveFile,
  };
});

const mockHomedir = vi.hoisted(() => vi.fn());
vi.mock('os', async (importOriginal) => {
  const mockedOs = await importOriginal<typeof os>();
  return {
    ...mockedOs,
    homedir: mockHomedir,
  };
});

const mockLogExtensionEnable = vi.hoisted(() => vi.fn());
const mockLogExtensionInstallEvent = vi.hoisted(() => vi.fn());
const mockLogExtensionUninstall = vi.hoisted(() => vi.fn());
const mockLogExtensionDisable = vi.hoisted(() => vi.fn());
const mockLogExtensionUpdateEvent = vi.hoisted(() => vi.fn());
vi.mock('../telemetry/loggers.js', () => ({
  logExtensionEnable: mockLogExtensionEnable,
  logExtensionUpdateEvent: mockLogExtensionUpdateEvent,
}));

vi.mock('../index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../index.js')>();
  return {
    ...actual,
    logExtensionEnable: mockLogExtensionEnable,
    logExtensionInstallEvent: mockLogExtensionInstallEvent,
    logExtensionUninstall: mockLogExtensionUninstall,
    logExtensionDisable: mockLogExtensionDisable,
  };
});

const EXTENSIONS_DIRECTORY_NAME = path.join(QWEN_DIR, 'extensions');

function createExtension({
  extensionsDir = 'extensions-dir',
  name = 'my-extension',
  version = '1.0.0',
  addContextFile = false,
  contextFileName = undefined as string | undefined,
  mcpServers = {} as Record<string, MCPServerConfig>,
  installMetadata = undefined as ExtensionInstallMetadata | undefined,
} = {}): string {
  const extDir = path.join(extensionsDir, name);
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(
    path.join(extDir, EXTENSIONS_CONFIG_FILENAME),
    JSON.stringify({ name, version, contextFileName, mcpServers }),
  );

  if (addContextFile) {
    fs.writeFileSync(path.join(extDir, 'QWEN.md'), 'context');
  }

  if (contextFileName) {
    fs.writeFileSync(path.join(extDir, contextFileName), 'context');
  }

  if (installMetadata) {
    fs.writeFileSync(
      path.join(extDir, INSTALL_METADATA_FILENAME),
      JSON.stringify(installMetadata),
    );
  }
  return extDir;
}

describe('extension tests', () => {
  let tempHomeDir: string;
  let tempWorkspaceDir: string;
  let userExtensionsDir: string;

  beforeEach(() => {
    tempHomeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-code-test-home-'),
    );
    tempWorkspaceDir = fs.mkdtempSync(
      path.join(tempHomeDir, 'qwen-code-test-workspace-'),
    );
    userExtensionsDir = path.join(tempHomeDir, EXTENSIONS_DIRECTORY_NAME);
    fs.mkdirSync(userExtensionsDir, { recursive: true });

    mockHomedir.mockReturnValue(tempHomeDir);
    vi.spyOn(process, 'cwd').mockReturnValue(tempWorkspaceDir);
    Object.values(mockGit).forEach((fn) => fn.mockReset());
    mockDownloadFromArchiveUrl.mockReset();
    mockExtractArchiveFile.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createExtensionManager(
    options: Partial<ExtensionManagerOptions> = {},
  ): ExtensionManager {
    return new ExtensionManager({
      workspaceDir: tempWorkspaceDir,
      isWorkspaceTrusted: true,
      ...options,
    });
  }

  describe('installExtension', () => {
    function writeExtractedExtension(destination: string, name: string) {
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(
        path.join(destination, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify({ name, version: '1.0.0' }),
      );
    }

    it('commits workspace initial activation with the installed artifact', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'workspace-ext.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtractedExtension(destination, 'workspace-ext');
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();

      const extension = await manager.installExtension(
        { type: 'local', source: archivePath },
        () => Promise.resolve(),
        undefined,
        tempWorkspaceDir,
        undefined,
        { scope: 'workspace', workspacePath: tempWorkspaceDir },
      );

      const activation = await manager.getExtensionActivation(
        extension.id,
        tempWorkspaceDir,
      );
      expect(activation).toMatchObject({
        default: 'disabled',
        workspace: 'enabled',
        effective: 'enabled',
      });
    });

    it('prepares without mutating the store and commits exactly once', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'prepared-ext.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtractedExtension(destination, 'prepared-ext');
        },
      );
      const manager = createExtensionManager();
      const events: ExtensionMutationEvent[] = [];
      manager.addMutationListener((event) => events.push(event));
      await manager.refreshCache();
      const before = await manager.getExtensionStoreSnapshot();

      const prepared = await manager.prepareExtensionInstall({
        installMetadata: { type: 'local', source: archivePath },
        initialActivation: { scope: 'user' },
        requestConsent: async () => {},
      });

      expect(fs.existsSync(path.join(userExtensionsDir, 'prepared-ext'))).toBe(
        false,
      );
      expect((await manager.getExtensionStoreSnapshot()).generation).toBe(
        before.generation,
      );
      expect(events).toEqual([]);

      const committed = await manager.commitPreparedExtension(prepared);
      expect(committed.extension?.name).toBe('prepared-ext');
      expect(committed.generation).toBe(before.generation + 1);
      await expect(
        manager.commitPreparedExtension(prepared),
      ).rejects.toMatchObject({ code: 'prepared_extension_consumed' });
      await manager.disposePreparedExtension(prepared);
      await manager.disposePreparedExtension(prepared);
      expect(events).toEqual([
        { id: 1, phase: 'start', operation: 'installExtension' },
        { id: 1, phase: 'end', operation: 'installExtension' },
      ]);
    });

    it('reports temp cleanup failure as a post-commit warning', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'cleanup-warning.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtractedExtension(destination, 'cleanup-warning');
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();
      const prepared = await manager.prepareExtensionInstall({
        installMetadata: { type: 'local', source: archivePath },
        initialActivation: { scope: 'user' },
        requestConsent: async () => {},
      });
      const cleanupPath = prepared.cleanupPaths[0]!;
      const rm = fs.promises.rm.bind(fs.promises);
      vi.spyOn(fs.promises, 'rm').mockImplementation(
        async (target, options) => {
          if (target === cleanupPath) throw new Error('cleanup denied');
          return await rm(target, options);
        },
      );

      const committed = await manager.commitPreparedExtension(prepared);

      expect(committed.generation).toBeGreaterThan(0);
      expect(committed.warnings).toContainEqual({
        code: 'extension_temp_cleanup_failed',
        error: 'cleanup denied',
      });
      await expect(
        manager.disposePreparedExtension(prepared),
      ).resolves.toBeUndefined();
    });

    it('records error telemetry when a prepared install commit fails', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'commit-failure.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtractedExtension(destination, 'commit-failure');
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();
      const prepared = await manager.prepareExtensionInstall({
        installMetadata: { type: 'local', source: archivePath },
        initialActivation: { scope: 'user' },
        requestConsent: async () => {},
      });
      vi.spyOn(
        ExtensionStore.prototype,
        'commitArtifact',
      ).mockRejectedValueOnce(new Error('disk full'));
      mockLogExtensionInstallEvent.mockClear();

      await expect(manager.commitPreparedExtension(prepared)).rejects.toThrow(
        'disk full',
      );
      expect(mockLogExtensionInstallEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          extension_name: 'commit-failure',
          status: 'error',
        }),
      );
      await manager.disposePreparedExtension(prepared);
    });

    it('rejects forged prepared handles without deleting their paths', async () => {
      const manager = createExtensionManager();
      const protectedPath = path.join(tempWorkspaceDir, 'keep-me');
      fs.mkdirSync(protectedPath);
      const forged = {
        stagingDirectory: protectedPath,
        cleanupPaths: [],
        disposed: false,
      } as unknown as PreparedExtensionMutation;

      await expect(
        manager.disposePreparedExtension(forged),
      ).rejects.toMatchObject({ code: 'invalid_prepared_extension' });
      expect(fs.existsSync(protectedPath)).toBe(true);
    });

    it('should install an extension from a local archive', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'local-extension.zip');
      fs.writeFileSync(archivePath, 'not used by mocked extractor');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtractedExtension(destination, 'local-archive-extension');
        },
      );

      const manager = createExtensionManager();
      await manager.refreshCache();

      const extension = await manager.installExtension(
        {
          source: archivePath,
          type: 'local',
        },
        async () => {},
      );

      expect(mockExtractArchiveFile).toHaveBeenCalledWith(
        archivePath,
        expect.any(String),
      );
      expect(extension.name).toBe('local-archive-extension');
      expect(extension.installMetadata).toMatchObject({
        source: archivePath,
        type: 'local',
      });
    });

    it('should emit mutation lifecycle events around install', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'local-extension.zip');
      fs.writeFileSync(archivePath, 'not used by mocked extractor');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtractedExtension(destination, 'local-archive-extension');
        },
      );

      const manager = createExtensionManager();
      const events: ExtensionMutationEvent[] = [];
      manager.addMutationListener((event) => events.push(event));
      await manager.refreshCache();

      await manager.installExtension(
        {
          source: archivePath,
          type: 'local',
        },
        async () => {},
      );

      expect(events).toEqual([
        { id: 1, phase: 'start', operation: 'installExtension' },
        { id: 1, phase: 'end', operation: 'installExtension' },
      ]);
    });

    it('should not reuse a dirty tempDir when falling back from GitHub release to git clone', async () => {
      // Regression for #6334: downloadFromGitHubRelease can dirty tempDir
      // (partial archive download / extraction) before failing. The fallback
      // git clone must receive a clean directory, or `git clone` errors with
      // "destination path '.' already exists and is not an empty directory".
      vi.spyOn(ExtensionStorage, 'createTmpDir').mockImplementation(async () =>
        fs.mkdtempSync(path.join(tempHomeDir, 'tracked-extension-')),
      );
      const { downloadFromGitHubRelease } = await import('./github.js');
      const downloadMock = vi.mocked(downloadFromGitHubRelease);
      downloadMock.mockImplementation(
        async (_meta: ExtensionInstallMetadata, destination: string) => {
          // Simulate a partial download that dirties tempDir before failing.
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(path.join(destination, 'partial.tar.gz'), 'partial');
          throw new Error('Mocked GitHub release download failure');
        },
      );

      let cloneRanOnCleanDir = false;
      mockGit.clone.mockImplementation(
        async (_url: string, _target: string) => {
          // cloneFromGit runs `git clone <url> ./` inside the tempDir it passed to
          // simpleGit(). Real git fails on a non-empty directory; mirror that so
          // the test fails (with the bug) if tempDir is not cleaned up first.
          const dir = mockGit.path();
          const isEmpty = fs.readdirSync(dir).length === 0;
          cloneRanOnCleanDir = isEmpty;
          if (!isEmpty) {
            throw new Error(
              "destination path '.' already exists and is not an empty directory.",
            );
          }
          writeExtractedExtension(dir, 'git-extension');
          return undefined;
        },
      );
      mockGit.getRemotes.mockResolvedValue([{ name: 'origin' }]);
      mockGit.fetch.mockResolvedValue(undefined);
      mockGit.checkout.mockResolvedValue(undefined);

      const manager = createExtensionManager();
      await manager.refreshCache();
      const controller = new AbortController();

      const extension = await manager.installExtension(
        {
          source: 'https://github.com/owner/repo',
          type: 'git',
        },
        async () => {},
        undefined,
        undefined,
        undefined,
        { scope: 'user' },
        controller.signal,
      );

      expect(downloadMock).toHaveBeenCalled();
      // The fallback clone must run on a clean tempDir; without the cleanup it
      // would throw "destination path '.' already exists and is not an empty
      // directory" and installExtension would reject before reaching here.
      expect(cloneRanOnCleanDir).toBe(true);
      expect(extension.name).toBe('git-extension');
    });

    it('should clean up converted temp dir for local archive installs', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'gemini-extension.zip');
      fs.writeFileSync(archivePath, 'not used by mocked extractor');
      const tempDirs: string[] = [];
      vi.spyOn(ExtensionStorage, 'createTmpDir').mockImplementation(
        async () => {
          const tempDir = fs.mkdtempSync(
            path.join(tempHomeDir, 'tracked-extension-'),
          );
          tempDirs.push(tempDir);
          return tempDir;
        },
      );
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(
            path.join(destination, 'gemini-extension.json'),
            JSON.stringify({
              name: 'gemini-archive-extension',
              version: '1.0.0',
            }),
          );
        },
      );

      const manager = createExtensionManager();
      await manager.refreshCache();

      const extension = await manager.installExtension(
        {
          source: archivePath,
          type: 'local',
        },
        async () => {},
      );

      expect(extension.name).toBe('gemini-archive-extension');
      expect(tempDirs).toHaveLength(2);
      expect(fs.existsSync(tempDirs[0])).toBe(false);
      expect(fs.existsSync(tempDirs[1])).toBe(false);
      expect(
        fs.existsSync(
          path.join(
            userExtensionsDir,
            'gemini-archive-extension',
            EXTENSIONS_CONFIG_FILENAME,
          ),
        ),
      ).toBe(true);
    });

    it('should install an extension from an archive URL', async () => {
      mockDownloadFromArchiveUrl.mockImplementation(
        async (_metadata: ExtensionInstallMetadata, destination: string) => {
          writeExtractedExtension(destination, 'archive-url-extension');
        },
      );

      const manager = createExtensionManager();
      await manager.refreshCache();
      const controller = new AbortController();

      const extension = await manager.installExtension(
        {
          source: 'https://example.com/archive-extension.zip',
          type: 'archive-url',
        },
        async () => {},
        undefined,
        undefined,
        undefined,
        { scope: 'user' },
        controller.signal,
      );

      expect(mockDownloadFromArchiveUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'https://example.com/archive-extension.zip',
          type: 'archive-url',
        }),
        expect.any(String),
        controller.signal,
      );
      expect(extension.name).toBe('archive-url-extension');
      expect(extension.installMetadata).toMatchObject({
        source: 'https://example.com/archive-extension.zip',
        type: 'archive-url',
      });
    });

    it('should clean up the temp dir when archive URL download fails', async () => {
      let tempDir: string | undefined;
      mockDownloadFromArchiveUrl.mockImplementation(
        async (_metadata: ExtensionInstallMetadata, destination: string) => {
          tempDir = destination;
          throw new Error('download failed');
        },
      );

      const manager = createExtensionManager();
      await manager.refreshCache();

      await expect(
        manager.installExtension(
          {
            source: 'https://example.com/archive-extension.zip',
            type: 'archive-url',
          },
          async () => {},
        ),
      ).rejects.toThrow('download failed');

      expect(tempDir).toBeDefined();
      expect(fs.existsSync(tempDir!)).toBe(false);
    });

    it('should clean up the temp dir when local archive extraction fails', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'local-extension.zip');
      fs.writeFileSync(archivePath, 'not used by mocked extractor');
      let tempDir: string | undefined;
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          tempDir = destination;
          throw new Error('extract failed');
        },
      );

      const manager = createExtensionManager();
      await manager.refreshCache();

      await expect(
        manager.installExtension(
          {
            source: archivePath,
            type: 'local',
          },
          async () => {},
        ),
      ).rejects.toThrow('extract failed');

      expect(tempDir).toBeDefined();
      expect(fs.existsSync(tempDir!)).toBe(false);
    });
  });

  describe('uninstallExtension', () => {
    it('should emit mutation lifecycle events around uninstall', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
        installMetadata: {
          type: 'local',
          source: tempWorkspaceDir,
          originSource: 'QwenCode',
        },
      });

      const manager = createExtensionManager();
      const events: ExtensionMutationEvent[] = [];
      manager.addMutationListener((event) => events.push(event));
      await manager.refreshCache();

      await manager.uninstallExtension('my-extension', false);

      expect(events).toEqual([
        { id: 1, phase: 'start', operation: 'uninstallExtension' },
        { id: 1, phase: 'end', operation: 'uninstallExtension' },
      ]);
    });
  });

  describe('loadExtension', () => {
    it('should include extension path in loaded extension', async () => {
      const extensionDir = path.join(userExtensionsDir, 'test-extension');
      fs.mkdirSync(extensionDir, { recursive: true });

      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'test-extension',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].path).toBe(extensionDir);
      expect(extensions[0].config.name).toBe('test-extension');
    });

    it('should load context file path when QWEN.md is present', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
        addContextFile: true,
      });
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext2',
        version: '2.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(2);
      const ext1 = extensions.find((e) => e.config.name === 'ext1');
      const ext2 = extensions.find((e) => e.config.name === 'ext2');
      expect(ext1?.contextFiles).toEqual([
        path.join(userExtensionsDir, 'ext1', 'QWEN.md'),
      ]);
      expect(ext2?.contextFiles).toEqual([]);
    });

    it('should load context file path from the extension config', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
        addContextFile: false,
        contextFileName: 'my-context-file.md',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      const ext1 = extensions.find((e) => e.config.name === 'ext1');
      expect(ext1?.contextFiles).toEqual([
        path.join(userExtensionsDir, 'ext1', 'my-context-file.md'),
      ]);
    });

    it('should use default QWEN.md when contextFileName is empty array', async () => {
      const extDir = path.join(userExtensionsDir, 'ext-empty-context');
      fs.mkdirSync(extDir, { recursive: true });
      fs.writeFileSync(
        path.join(extDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify({
          name: 'ext-empty-context',
          version: '1.0.0',
          contextFileName: [],
        }),
      );
      fs.writeFileSync(path.join(extDir, 'QWEN.md'), 'context content');

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      const ext = extensions.find((e) => e.config.name === 'ext-empty-context');
      expect(ext?.contextFiles).toEqual([
        path.join(userExtensionsDir, 'ext-empty-context', 'QWEN.md'),
      ]);
    });

    it('should skip extensions with invalid JSON and log a warning', async () => {
      // Good extension
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'good-ext',
        version: '1.0.0',
      });

      // Bad extension
      const badExtDir = path.join(userExtensionsDir, 'bad-ext');
      fs.mkdirSync(badExtDir);
      const badConfigPath = path.join(badExtDir, EXTENSIONS_CONFIG_FILENAME);
      fs.writeFileSync(badConfigPath, '{ "name": "bad-ext"'); // Malformed

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].config.name).toBe('good-ext');
    });

    it('should skip extensions with missing name and log a warning', async () => {
      // Good extension
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'good-ext',
        version: '1.0.0',
      });

      // Bad extension
      const badExtDir = path.join(userExtensionsDir, 'bad-ext-no-name');
      fs.mkdirSync(badExtDir);
      const badConfigPath = path.join(badExtDir, EXTENSIONS_CONFIG_FILENAME);
      fs.writeFileSync(badConfigPath, JSON.stringify({ version: '1.0.0' }));

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].config.name).toBe('good-ext');
    });

    it('should filter trust out of mcp servers', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'test-extension',
        version: '1.0.0',
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
            trust: true,
          } as MCPServerConfig,
        },
      });

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      // trust should be filtered from extension.mcpServers (not config.mcpServers)
      expect(extensions[0].mcpServers?.['test-server']?.trust).toBeUndefined();
      // config.mcpServers should still have trust (original config)
      expect(extensions[0].config.mcpServers?.['test-server']?.trust).toBe(
        true,
      );
    });

    it('should only load explicitly named extensions when refreshCache is filtered', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext2',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache({ names: ['ext2'] });
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].name).toBe('ext2');
    });

    it('keeps the previous cache when refreshCache fails before replacement', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'stable-ext',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();
      expect(manager.getLoadedExtensions().map((ext) => ext.name)).toEqual([
        'stable-ext',
      ]);

      const internals = manager as unknown as {
        loadExtensionsFromExtensionsDir: () => Promise<Extension[]>;
      };
      internals.loadExtensionsFromExtensionsDir = vi
        .fn()
        .mockRejectedValue(new Error('refresh failed'));

      await expect(manager.refreshCache()).rejects.toThrow('refresh failed');
      expect(manager.getLoadedExtensions().map((ext) => ext.name)).toEqual([
        'stable-ext',
      ]);
    });

    describe('command discovery', () => {
      it('should discover .md command files', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'md-commands-ext',
          version: '1.0.0',
        });
        const commandsDir = path.join(extDir, 'commands');
        fs.mkdirSync(commandsDir, { recursive: true });
        fs.writeFileSync(path.join(commandsDir, 'greet.md'), 'Hello!');
        fs.writeFileSync(path.join(commandsDir, 'farewell.md'), 'Bye!');

        const manager = createExtensionManager();
        await manager.refreshCache();
        const extensions = manager.getLoadedExtensions();

        const ext = extensions.find((e) => e.config.name === 'md-commands-ext');
        expect(ext?.commands).toEqual(
          expect.arrayContaining(['greet', 'farewell']),
        );
        expect(ext?.commands).toHaveLength(2);
      });

      it('should discover .toml command files', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'toml-commands-ext',
          version: '1.0.0',
        });
        const commandsDir = path.join(extDir, 'commands');
        fs.mkdirSync(commandsDir, { recursive: true });
        fs.writeFileSync(
          path.join(commandsDir, 'caveman.toml'),
          'prompt = "Talk like caveman"\ndescription = "Caveman mode"',
        );

        const manager = createExtensionManager();
        await manager.refreshCache();
        const extensions = manager.getLoadedExtensions();

        const ext = extensions.find(
          (e) => e.config.name === 'toml-commands-ext',
        );
        expect(ext?.commands).toEqual(['caveman']);
      });

      it('should discover both .md and .toml command files', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'mixed-commands-ext',
          version: '1.0.0',
        });
        const commandsDir = path.join(extDir, 'commands');
        fs.mkdirSync(commandsDir, { recursive: true });
        fs.writeFileSync(path.join(commandsDir, 'greet.md'), 'Hello!');
        fs.writeFileSync(
          path.join(commandsDir, 'caveman.toml'),
          'prompt = "Talk like caveman"',
        );

        const manager = createExtensionManager();
        await manager.refreshCache();
        const extensions = manager.getLoadedExtensions();

        const ext = extensions.find(
          (e) => e.config.name === 'mixed-commands-ext',
        );
        expect(ext?.commands).toEqual(
          expect.arrayContaining(['greet', 'caveman']),
        );
        expect(ext?.commands).toHaveLength(2);
      });

      it('should list both entries when .md and .toml exist for same command name', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'dedup-commands-ext',
          version: '1.0.0',
        });
        const commandsDir = path.join(extDir, 'commands');
        fs.mkdirSync(commandsDir, { recursive: true });
        fs.writeFileSync(path.join(commandsDir, 'greet.md'), 'Hello!');
        fs.writeFileSync(
          path.join(commandsDir, 'greet.toml'),
          'prompt = "Hello!"',
        );

        const manager = createExtensionManager();
        await manager.refreshCache();
        const extensions = manager.getLoadedExtensions();

        const ext = extensions.find(
          (e) => e.config.name === 'dedup-commands-ext',
        );
        // No dedup at discovery level — both entries surface so the consent
        // UI shows the true count; downstream CommandService handles conflicts.
        expect(ext?.commands).toEqual(['greet', 'greet']);
      });

      it('should discover nested .toml command files with colon-separated names', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'nested-toml-ext',
          version: '1.0.0',
        });
        const nestedDir = path.join(extDir, 'commands', 'caveman');
        fs.mkdirSync(nestedDir, { recursive: true });
        fs.writeFileSync(
          path.join(nestedDir, 'intensity.toml'),
          'prompt = "Switch intensity"',
        );

        const manager = createExtensionManager();
        await manager.refreshCache();
        const extensions = manager.getLoadedExtensions();

        const ext = extensions.find((e) => e.config.name === 'nested-toml-ext');
        expect(ext?.commands).toEqual(['caveman:intensity']);
      });

      it('should replace colons in path segments with underscores', async () => {
        if (process.platform !== 'linux') return; // colons forbidden in filenames on macOS/Windows
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'colon-name-ext',
          version: '1.0.0',
        });
        const commandsDir = path.join(extDir, 'commands');
        fs.mkdirSync(commandsDir, { recursive: true });
        fs.writeFileSync(path.join(commandsDir, 'foo:bar.md'), 'content');

        const manager = createExtensionManager();
        await manager.refreshCache();
        const extensions = manager.getLoadedExtensions();
        const ext = extensions.find((e) => e.config.name === 'colon-name-ext');
        expect(ext?.commands).toEqual(['foo_bar']);
      });

      it('should return empty commands when commands directory does not exist', async () => {
        createExtension({
          extensionsDir: userExtensionsDir,
          name: 'no-cmd-dir-ext',
          version: '1.0.0',
        });
        const manager = createExtensionManager();
        await manager.refreshCache();
        const extensions = manager.getLoadedExtensions();
        const ext = extensions.find((e) => e.config.name === 'no-cmd-dir-ext');
        expect(ext?.commands).toEqual([]);
      });

      it('should return empty commands when no .md or .toml files exist', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'no-commands-ext',
          version: '1.0.0',
        });
        const commandsDir = path.join(extDir, 'commands');
        fs.mkdirSync(commandsDir, { recursive: true });
        fs.writeFileSync(path.join(commandsDir, 'readme.txt'), 'not a cmd');

        const manager = createExtensionManager();
        await manager.refreshCache();
        const extensions = manager.getLoadedExtensions();

        const ext = extensions.find((e) => e.config.name === 'no-commands-ext');
        expect(ext?.commands).toEqual([]);
      });
    });
  });

  describe('enableExtension / disableExtension', () => {
    it('applies V2 default and workspace activation to loaded extensions', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;

      await manager.setExtensionDefaultActivation(extension.id, 'disabled');
      expect(manager.getLoadedExtensions()[0]?.isActive).toBe(false);

      await manager.setExtensionWorkspaceActivation(
        extension.id,
        tempWorkspaceDir,
        'enabled',
      );
      expect(manager.getLoadedExtensions()[0]?.isActive).toBe(true);

      await manager.clearExtensionWorkspaceActivation(
        extension.id,
        tempWorkspaceDir,
      );
      expect(manager.getLoadedExtensions()[0]?.isActive).toBe(false);
    });

    it('refreshes runtime tools after V2 activation changes', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;
      const refreshTools = vi
        .spyOn(manager, 'refreshTools')
        .mockResolvedValue();

      await manager.setExtensionDefaultActivation(extension.id, 'disabled');
      await manager.setExtensionActivationScope(extension.id, {
        scope: 'workspace',
        workspacePath: tempWorkspaceDir,
      });
      await manager.setExtensionWorkspaceActivation(
        extension.id,
        tempWorkspaceDir,
        'disabled',
      );
      await manager.clearExtensionWorkspaceActivation(
        extension.id,
        tempWorkspaceDir,
      );

      expect(refreshTools).toHaveBeenCalledTimes(4);
    });

    it('changes activation scope in one policy mutation', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;

      await manager.setExtensionActivationScope(extension.id, {
        scope: 'workspace',
        workspacePath: tempWorkspaceDir,
      });
      const snapshot = await manager.setExtensionActivationScope(extension.id, {
        scope: 'user',
      });

      expect(snapshot.extensions[extension.id]).toMatchObject({
        defaultActivation: 'enabled',
        workspaceOverrides: {},
      });
    });

    it('emits mutation lifecycle events for V2 activation changes', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });
      const manager = createExtensionManager();
      const events: ExtensionMutationEvent[] = [];
      manager.addMutationListener((event) => events.push(event));
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;

      await manager.setExtensionDefaultActivation(extension.id, 'disabled');
      await manager.setExtensionActivationScope(extension.id, {
        scope: 'workspace',
        workspacePath: tempWorkspaceDir,
      });
      await manager.setExtensionWorkspaceActivation(
        extension.id,
        tempWorkspaceDir,
        'disabled',
      );
      await manager.clearExtensionWorkspaceActivation(
        extension.id,
        tempWorkspaceDir,
      );

      expect(events).toEqual([
        {
          id: 1,
          phase: 'start',
          operation: 'setExtensionDefaultActivation',
        },
        {
          id: 1,
          phase: 'end',
          operation: 'setExtensionDefaultActivation',
        },
        {
          id: 2,
          phase: 'start',
          operation: 'setExtensionActivationScope',
        },
        {
          id: 2,
          phase: 'end',
          operation: 'setExtensionActivationScope',
        },
        {
          id: 3,
          phase: 'start',
          operation: 'setExtensionWorkspaceActivation',
        },
        {
          id: 3,
          phase: 'end',
          operation: 'setExtensionWorkspaceActivation',
        },
        {
          id: 4,
          phase: 'start',
          operation: 'clearExtensionWorkspaceActivation',
        },
        {
          id: 4,
          phase: 'end',
          operation: 'clearExtensionWorkspaceActivation',
        },
      ]);
    });

    it('keeps the V2 state in sync after a legacy scope mutation', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;

      await manager.disableExtension(
        extension.name,
        SettingScope.Workspace,
        tempWorkspaceDir,
      );

      const activation = await manager.getExtensionActivation(
        extension.id,
        tempWorkspaceDir,
      );
      expect(activation).toMatchObject({
        effective: 'disabled',
        source: 'workspace_override',
      });
    });

    it('keeps other workspace overrides during a legacy workspace mutation', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;
      const otherWorkspace = path.join(os.tmpdir(), 'other-workspace');
      await manager.setExtensionWorkspaceActivation(
        extension.id,
        otherWorkspace,
        'enabled',
      );

      await manager.disableExtension(
        extension.name,
        SettingScope.Workspace,
        tempWorkspaceDir,
      );

      const snapshot = await manager.getExtensionStoreSnapshot();
      expect(snapshot.extensions[extension.id]?.workspaceOverrides).toEqual({
        [otherWorkspace]: 'enabled',
        [fs.realpathSync.native(tempWorkspaceDir)]: 'disabled',
      });
    });

    it('clears only child workspace overrides during a legacy user mutation', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;
      const outsideWorkspace = path.join(os.tmpdir(), 'outside-workspace');
      await manager.setExtensionWorkspaceActivation(
        extension.id,
        tempWorkspaceDir,
        'enabled',
      );
      await manager.setExtensionWorkspaceActivation(
        extension.id,
        outsideWorkspace,
        'disabled',
      );

      await manager.disableExtension(extension.name, SettingScope.User);

      const snapshot = await manager.getExtensionStoreSnapshot();
      expect(snapshot.extensions[extension.id]?.workspaceOverrides).toEqual({
        [outsideWorkspace]: 'disabled',
      });
    });

    it('should emit mutation lifecycle events around extension changes', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      const events: ExtensionMutationEvent[] = [];
      manager.addMutationListener((event) => events.push(event));
      await manager.refreshCache();

      await manager.disableExtension('my-extension', SettingScope.User);

      expect(events).toEqual([
        { id: 1, phase: 'start', operation: 'disableExtension' },
        { id: 1, phase: 'end', operation: 'disableExtension' },
      ]);
    });

    it('should not emit mutation lifecycle events when validation fails', async () => {
      const manager = createExtensionManager();
      const events: ExtensionMutationEvent[] = [];
      manager.addMutationListener((event) => events.push(event));

      await expect(
        manager.disableExtension('missing-extension', SettingScope.User),
      ).rejects.toThrow(
        'Extension with name missing-extension does not exist.',
      );

      await expect(
        manager.enableExtension('missing-extension', SettingScope.User),
      ).rejects.toThrow(
        'Extension with name missing-extension does not exist.',
      );

      await expect(manager.addSource('   ')).rejects.toThrow(
        'Marketplace source cannot be empty.',
      );

      expect(events).toEqual([]);
    });

    it('should disable an extension at the user scope', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();

      await manager.disableExtension('my-extension', SettingScope.User);
      expect(manager.isEnabled('my-extension', tempWorkspaceDir)).toBe(false);
    });

    it('should disable an extension at the workspace scope', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();

      await manager.disableExtension(
        'my-extension',
        SettingScope.Workspace,
        tempWorkspaceDir,
      );

      expect(manager.isEnabled('my-extension', tempHomeDir)).toBe(true);
      expect(manager.isEnabled('my-extension', tempWorkspaceDir)).toBe(false);
    });

    it('should handle disabling the same extension twice', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();

      await manager.disableExtension('my-extension', SettingScope.User);
      await manager.disableExtension('my-extension', SettingScope.User);
      expect(manager.isEnabled('my-extension', tempWorkspaceDir)).toBe(false);
    });

    it('should throw an error if you request system scope', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();

      await expect(
        manager.disableExtension('my-extension', SettingScope.System),
      ).rejects.toThrow('System and SystemDefaults scopes are not supported.');
    });

    it('should enable an extension at the user scope', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();

      await manager.disableExtension('ext1', SettingScope.User);
      expect(manager.isEnabled('ext1')).toBe(false);

      await manager.enableExtension('ext1', SettingScope.User);
      expect(manager.isEnabled('ext1')).toBe(true);
    });

    it('should enable an extension at the workspace scope', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();

      await manager.disableExtension('ext1', SettingScope.Workspace);
      expect(manager.isEnabled('ext1', tempWorkspaceDir)).toBe(false);

      await manager.enableExtension('ext1', SettingScope.Workspace);
      expect(manager.isEnabled('ext1', tempWorkspaceDir)).toBe(true);
    });
  });

  describe('preference-only operations', () => {
    it('should not emit mutation lifecycle events for preference changes', () => {
      const manager = createExtensionManager();
      const events: ExtensionMutationEvent[] = [];
      manager.addMutationListener((event) => events.push(event));

      expect(manager.toggleFavorite('my-extension')).toBe(true);
      fs.writeFileSync(
        path.join(userExtensionsDir, 'marketplaces.json'),
        JSON.stringify([
          {
            name: 'marketplace',
            source: 'owner/repo',
            type: 'github',
            addedAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
      );
      expect(manager.markSourceUpdated('marketplace')).toMatchObject({
        name: 'marketplace',
      });

      expect(events).toEqual([]);
    });
  });

  describe('updateExtension', () => {
    it('rejects a stale direct update after the artifact changes', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'direct-update.zip');
      fs.writeFileSync(archivePath, 'archive');
      const writeExtension = (destination: string, version: string) => {
        fs.mkdirSync(destination, { recursive: true });
        fs.writeFileSync(
          path.join(destination, EXTENSIONS_CONFIG_FILENAME),
          JSON.stringify({ name: 'my-extension', version }),
        );
      };
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtension(destination, '1.0.0');
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();
      const metadata = { type: 'local' as const, source: archivePath };
      const installed = await manager.installExtension(
        metadata,
        async () => {},
      );
      const concurrentStore = new ExtensionStore();
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtension(destination, '2.0.0');
          const before = await concurrentStore.readSnapshot();
          const staging = await concurrentStore.createStagingDirectory();
          writeExtension(staging, 'concurrent');
          await concurrentStore.commitArtifact({
            operation: 'update',
            identity: { id: installed.id, name: installed.name },
            stagingDirectory: staging,
            destinationDirectory: installed.path,
            expectedArtifactGeneration:
              before.extensions[installed.id]!.artifactGeneration,
          });
        },
      );

      await expect(
        manager.installExtension(
          metadata,
          async () => {},
          undefined,
          tempWorkspaceDir,
          installed.config,
        ),
      ).rejects.toMatchObject({ code: 'extension_conflict' });
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(installed.path, EXTENSIONS_CONFIG_FILENAME),
            'utf8',
          ),
        ),
      ).toMatchObject({ version: 'concurrent' });
    });

    it('marks a direct update reload failure as already committed', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'direct-reload.zip');
      fs.writeFileSync(archivePath, 'archive');
      const extensionPath = createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
        installMetadata: {
          type: 'local',
          source: archivePath,
          originSource: 'QwenCode',
        },
      });
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(
            path.join(destination, EXTENSIONS_CONFIG_FILENAME),
            JSON.stringify({ name: 'my-extension', version: '2.0.0' }),
          );
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;
      vi.spyOn(manager, 'loadExtension').mockResolvedValue(null);

      await expect(
        manager.installExtension(
          { type: 'local', source: archivePath },
          async () => {},
          undefined,
          tempWorkspaceDir,
          extension.config,
        ),
      ).rejects.toMatchObject({
        code: 'extension_committed_with_warnings',
        committed: true,
      });
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(extensionPath, EXTENSIONS_CONFIG_FILENAME),
            'utf8',
          ),
        ),
      ).toMatchObject({ version: '2.0.0' });
    });

    it('reports a committed update reload failure as needing restart', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'reload-failure.zip');
      fs.writeFileSync(archivePath, 'archive');
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
        installMetadata: {
          type: 'local',
          source: archivePath,
          originSource: 'QwenCode',
        },
      });
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(
            path.join(destination, EXTENSIONS_CONFIG_FILENAME),
            JSON.stringify({ name: 'my-extension', version: '2.0.0' }),
          );
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;
      vi.spyOn(manager, 'loadExtension').mockResolvedValue(null);
      const callback = vi.fn();

      await expect(
        manager.updateExtension(
          extension,
          ExtensionUpdateState.UPDATE_AVAILABLE,
          callback,
        ),
      ).resolves.toEqual({
        name: 'my-extension',
        originalVersion: '1.0.0',
        updatedVersion: '2.0.0',
      });

      expect(callback).toHaveBeenLastCalledWith(
        'my-extension',
        ExtensionUpdateState.UPDATED_NEEDS_RESTART,
      );
      expect(manager.getLoadedExtensions()).toEqual([]);
    });

    it('should end mutation lifecycle events when temp directory creation fails', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'update.zip');
      fs.writeFileSync(archivePath, 'archive');
      const extensionPath = createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
        installMetadata: {
          type: 'local',
          source: archivePath,
          originSource: 'QwenCode',
        },
      });
      const manager = createExtensionManager();
      const events: ExtensionMutationEvent[] = [];
      const callback = vi.fn();
      manager.addMutationListener((event) => events.push(event));
      await manager.refreshCache();
      const extension = manager
        .getLoadedExtensions()
        .find((entry) => entry.path === extensionPath);
      vi.spyOn(ExtensionStorage, 'createTmpDir').mockRejectedValueOnce(
        new Error('disk full'),
      );

      await expect(
        manager.updateExtension(
          extension!,
          ExtensionUpdateState.UPDATE_AVAILABLE,
          callback,
        ),
      ).rejects.toThrow('disk full');

      expect(events).toEqual([
        { id: 1, phase: 'start', operation: 'updateExtension' },
        { id: 1, phase: 'end', operation: 'updateExtension' },
      ]);
      expect(callback).toHaveBeenCalledWith(
        'my-extension',
        ExtensionUpdateState.ERROR,
      );
    });
  });

  describe('validateExtensionOverrides', () => {
    it('should mark all extensions as active if no enabled extensions are provided', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext2',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(2);
      expect(extensions.every((e) => e.isActive)).toBe(true);
    });

    it('should mark only the enabled extensions as active', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext2',
        version: '1.0.0',
      });
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext3',
        version: '1.0.0',
      });

      const manager = createExtensionManager({
        enabledExtensionOverrides: ['ext1', 'ext3'],
      });
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions.find((e) => e.name === 'ext1')?.isActive).toBe(true);
      expect(extensions.find((e) => e.name === 'ext2')?.isActive).toBe(false);
      expect(extensions.find((e) => e.name === 'ext3')?.isActive).toBe(true);
    });

    it('should mark all extensions as inactive when "none" is provided', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext2',
        version: '1.0.0',
      });

      const manager = createExtensionManager({
        enabledExtensionOverrides: ['none'],
      });
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions.every((e) => !e.isActive)).toBe(true);
    });

    it('should treat "none" as disabling all only when it is the sole override', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext2',
        version: '1.0.0',
      });

      const manager = createExtensionManager({
        enabledExtensionOverrides: ['none', 'ext1'],
      });
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(manager.isEnabled('ext1')).toBe(true);
      expect(extensions.find((e) => e.name === 'ext1')?.isActive).toBe(true);
      expect(extensions.find((e) => e.name === 'ext2')?.isActive).toBe(false);
    });

    it('should handle case-insensitivity', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });

      const manager = createExtensionManager({
        enabledExtensionOverrides: ['EXT1'],
      });
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions.find((e) => e.name === 'ext1')?.isActive).toBe(true);
    });

    it('should log an error for unknown extensions', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });

      const manager = createExtensionManager({
        enabledExtensionOverrides: ['ext4'],
      });
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();
      expect(() =>
        manager.validateExtensionOverrides(extensions),
      ).not.toThrow();
    });
  });

  describe('loadExtensionConfig', () => {
    it('should resolve environment variables in extension configuration', async () => {
      process.env['TEST_API_KEY'] = 'test-api-key-123';
      process.env['TEST_DB_URL'] = 'postgresql://localhost:5432/testdb';

      try {
        const extDir = path.join(userExtensionsDir, 'test-extension');
        fs.mkdirSync(extDir);

        const extensionConfig = {
          name: 'test-extension',
          version: '1.0.0',
          mcpServers: {
            'test-server': {
              command: 'node',
              args: ['server.js'],
              env: {
                API_KEY: '$TEST_API_KEY',
                DATABASE_URL: '${TEST_DB_URL}',
                STATIC_VALUE: 'no-substitution',
              },
            },
          },
        };
        fs.writeFileSync(
          path.join(extDir, EXTENSIONS_CONFIG_FILENAME),
          JSON.stringify(extensionConfig),
        );

        const manager = createExtensionManager();
        await manager.refreshCache();
        const extensions = manager.getLoadedExtensions();

        expect(extensions).toHaveLength(1);
        const extension = extensions[0];
        expect(extension.config.name).toBe('test-extension');
        expect(extension.config.mcpServers).toBeDefined();

        const serverConfig = extension.config.mcpServers?.['test-server'];
        expect(serverConfig).toBeDefined();
        expect(serverConfig?.env).toBeDefined();
        expect(serverConfig?.env?.['API_KEY']).toBe('test-api-key-123');
        expect(serverConfig?.env?.['DATABASE_URL']).toBe(
          'postgresql://localhost:5432/testdb',
        );
        expect(serverConfig?.env?.['STATIC_VALUE']).toBe('no-substitution');
      } finally {
        delete process.env['TEST_API_KEY'];
        delete process.env['TEST_DB_URL'];
      }
    });

    it('should handle missing environment variables gracefully', async () => {
      const extDir = path.join(userExtensionsDir, 'test-extension');
      fs.mkdirSync(extDir);

      const extensionConfig = {
        name: 'test-extension',
        version: '1.0.0',
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
            env: {
              MISSING_VAR: '$UNDEFINED_ENV_VAR',
              MISSING_VAR_BRACES: '${ALSO_UNDEFINED}',
            },
          },
        },
      };

      fs.writeFileSync(
        path.join(extDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify(extensionConfig),
      );

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      const extension = extensions[0];
      const serverConfig = extension.config.mcpServers!['test-server'];
      expect(serverConfig.env).toBeDefined();
      expect(serverConfig.env!['MISSING_VAR']).toBe('$UNDEFINED_ENV_VAR');
      expect(serverConfig.env!['MISSING_VAR_BRACES']).toBe('${ALSO_UNDEFINED}');
    });
    describe('refreshTools', () => {
      it('refreshTools should return early if config is not set', async () => {
        const manager = createExtensionManager();
        // Should not throw when config is undefined
        await expect(manager.refreshTools()).resolves.not.toThrow();
      });

      it('refreshTools should call all refresh methods', async () => {
        const mockRefreshCache = vi.fn();
        const mockReinitializeMcpServers = vi.fn();
        const mockReloadHooks = vi.fn();
        const mockRefreshHierarchicalMemory = vi.fn();
        const mockSettingsMcpServers = { server: { command: 'cmd' } };

        const mockConfig = {
          getGeminiClient: () => ({
            isInitialized: () => false,
            setTools: vi.fn(),
          }),
          getSettingsMcpServers: () => mockSettingsMcpServers,
          reinitializeMcpServers: mockReinitializeMcpServers,
          getSkillManager: () => ({
            refreshCache: mockRefreshCache,
          }),
          getSubagentManager: () => ({
            refreshCache: mockRefreshCache,
          }),
          getHookSystem: () => ({
            reload: mockReloadHooks,
          }),
          refreshHierarchicalMemory: mockRefreshHierarchicalMemory,
        };

        const manager = createExtensionManager();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (manager as any).config = mockConfig;

        await manager.refreshTools();

        expect(mockReinitializeMcpServers).toHaveBeenCalledOnce();
        expect(mockReinitializeMcpServers).toHaveBeenCalledWith(
          mockSettingsMcpServers,
        );
        expect(mockRefreshCache).toHaveBeenCalledTimes(2); // skillManager and subagentManager
        expect(mockReloadHooks).toHaveBeenCalledOnce();
        expect(mockRefreshHierarchicalMemory).toHaveBeenCalledOnce();
      });
    });
  });

  describe('extensionManager utility functions', () => {
    describe('validateName', () => {
      it('should accept valid extension names', () => {
        expect(() => validateName('my-extension')).not.toThrow();
        expect(() => validateName('Extension123')).not.toThrow();
        expect(() => validateName('test-ext-1')).not.toThrow();
        expect(() => validateName('UPPERCASE')).not.toThrow();
      });

      it('should accept names with underscores and dots', () => {
        expect(() => validateName('my_extension')).not.toThrow();
        expect(() => validateName('my.extension')).not.toThrow();
        expect(() => validateName('my_ext.v1')).not.toThrow();
        expect(() => validateName('ext_1.2.3')).not.toThrow();
      });

      it('should reject names with invalid characters', () => {
        expect(() => validateName('my extension')).toThrow(
          'Invalid extension name',
        );
        expect(() => validateName('my@ext')).toThrow('Invalid extension name');
      });

      it('should reject empty names', () => {
        expect(() => validateName('')).toThrow('Invalid extension name');
      });
    });

    describe('hashValue', () => {
      it('should generate consistent hash for same input', () => {
        const hash1 = hashValue('test-input');
        const hash2 = hashValue('test-input');
        expect(hash1).toBe(hash2);
      });

      it('should generate different hashes for different inputs', () => {
        const hash1 = hashValue('input-1');
        const hash2 = hashValue('input-2');
        expect(hash1).not.toBe(hash2);
      });

      it('should generate a valid SHA256 hash', () => {
        const hash = hashValue('test');
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
      });
    });

    describe('getExtensionId', () => {
      it('should use hashed name when no install metadata', () => {
        const config: ExtensionConfig = { name: 'test-ext', version: '1.0.0' };
        const id = getExtensionId(config);
        expect(id).toBe(hashValue('test-ext'));
      });

      it('should use hashed source for local install', () => {
        const config: ExtensionConfig = { name: 'test-ext', version: '1.0.0' };
        const metadata = { type: 'local' as const, source: '/path/to/ext' };
        const id = getExtensionId(config, metadata);
        expect(id).toBe(hashValue('/path/to/ext'));
      });

      it('should use GitHub URL for git install', () => {
        const config: ExtensionConfig = { name: 'test-ext', version: '1.0.0' };
        const metadata = {
          type: 'git' as const,
          source: 'https://github.com/owner/repo',
        };
        const id = getExtensionId(config, metadata);
        expect(id).toBe(hashValue('https://github.com/owner/repo'));
      });

      it('should use source as-is for non-GitHub git URLs (e.g., GitLab)', () => {
        // For non-GitHub git servers, fall back to using the source URL directly
        const config: ExtensionConfig = { name: 'test-ext', version: '1.0.0' };
        const metadata = {
          type: 'git' as const,
          source: 'https://gitlab.company.com/team/extension-repo',
        };

        const id = getExtensionId(config, metadata);
        expect(id).toBe(
          hashValue('https://gitlab.company.com/team/extension-repo'),
        );
      });
    });
  });

  describe('hooks loading and processing', () => {
    it('should load hooks from qwen-extension.json', async () => {
      const extensionDir = path.join(userExtensionsDir, 'hooks-extension');
      fs.mkdirSync(extensionDir, { recursive: true });

      // Create qwen-extension.json with hooks
      const configWithHooks = {
        name: 'hooks-extension',
        version: '1.0.0',
        hooks: {
          PreToolUse: [
            {
              description: 'Run before tool start',
              hooks: [
                {
                  type: 'command',
                  command: 'echo "hello"',
                },
              ],
            },
          ],
        },
      };

      fs.writeFileSync(
        path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify(configWithHooks),
      );

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].hooks).toBeDefined();
      expect(extensions[0].hooks!['PreToolUse']).toHaveLength(1);
      expect(
        (
          extensions[0].hooks!['PreToolUse']![0].hooks![0] as {
            command: string;
          }
        ).command,
      ).toBe('echo "hello"');
    });

    it('should load hooks from hooks/hooks.json when not in main config', async () => {
      const extensionDir = path.join(
        userExtensionsDir,
        'hooks-from-file-extension',
      );
      fs.mkdirSync(extensionDir, { recursive: true });

      // Create qwen-extension.json without hooks
      const configWithoutHooks = {
        name: 'hooks-from-file-extension',
        version: '1.0.0',
      };

      fs.writeFileSync(
        path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify(configWithoutHooks),
      );

      // Create hooks directory and hooks.json
      const hooksDir = path.join(extensionDir, 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });

      const hooksJson = {
        PostToolUse: [
          {
            description: 'Run after install',
            hooks: [
              {
                type: 'command',
                command: `echo "installed in ${extensionDir}"`,
              },
            ],
          },
        ],
      };

      fs.writeFileSync(
        path.join(hooksDir, 'hooks.json'),
        JSON.stringify(hooksJson),
      );

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].hooks).toBeDefined();
      expect(extensions[0].hooks!['PostToolUse']).toHaveLength(1);
      expect(
        (
          extensions[0].hooks!['PostToolUse']![0].hooks![0] as {
            command: string;
          }
        ).command,
      ).toBe(`echo "installed in ${extensionDir}"`);
    });

    it('should substitute ${CLAUDE_PLUGIN_ROOT} variable in hooks', async () => {
      const extensionDir = path.join(userExtensionsDir, 'hooks-var-extension');
      fs.mkdirSync(extensionDir, { recursive: true });

      // Create qwen-extension.json with hooks using ${CLAUDE_PLUGIN_ROOT}
      const configWithHooks = {
        name: 'hooks-var-extension',
        version: '1.0.0',
        hooks: {
          PreToolUse: [
            {
              description: 'Run before start with var',
              hooks: [
                {
                  type: 'command',
                  command: '${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh',
                },
              ],
            },
          ],
        },
      };

      fs.writeFileSync(
        path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify(configWithHooks),
      );

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].hooks).toBeDefined();
      expect(extensions[0].hooks!['PreToolUse']).toHaveLength(1);
      expect(
        (
          extensions[0].hooks!['PreToolUse']![0].hooks![0] as {
            command: string;
          }
        ).command,
      ).toBe(`${extensionDir}/scripts/setup.sh`);
    });

    it('should load hooks from config.hooks string path', async () => {
      const extensionDir = path.join(
        userExtensionsDir,
        'hooks-from-config-path',
      );
      fs.mkdirSync(extensionDir, { recursive: true });

      // Create custom hooks directory and hooks file
      const customHooksDir = path.join(extensionDir, 'custom-hooks');
      fs.mkdirSync(customHooksDir, { recursive: true });

      const hooksJson = {
        PreToolUse: [
          {
            description: 'Run from custom path',
            hooks: [
              {
                type: 'command',
                command: 'echo "custom hooks path"',
              },
            ],
          },
        ],
      };

      fs.writeFileSync(
        path.join(customHooksDir, 'hooks.json'),
        JSON.stringify(hooksJson),
      );

      // Create qwen-extension.json with hooks as string path
      const configWithHooksPath = {
        name: 'hooks-from-config-path',
        version: '1.0.0',
        hooks: 'custom-hooks/hooks.json',
      };

      fs.writeFileSync(
        path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify(configWithHooksPath),
      );

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].hooks).toBeDefined();
      expect(extensions[0].hooks!['PreToolUse']).toHaveLength(1);
      expect(
        (
          extensions[0].hooks!['PreToolUse']![0].hooks![0] as {
            command: string;
          }
        ).command,
      ).toBe('echo "custom hooks path"');
    });

    it('should prefer config.hooks string path over hooks/hooks.json', async () => {
      const extensionDir = path.join(
        userExtensionsDir,
        'hooks-prefer-config-path',
      );
      fs.mkdirSync(extensionDir, { recursive: true });

      // Create hooks/hooks.json
      const hooksDir = path.join(extensionDir, 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(
        path.join(hooksDir, 'hooks.json'),
        JSON.stringify({
          PreToolUse: [
            {
              description: 'From hooks directory',
              hooks: [{ type: 'command', command: 'echo "hooks dir"' }],
            },
          ],
        }),
      );

      // Create custom hooks file
      const customHooksDir = path.join(extensionDir, 'custom');
      fs.mkdirSync(customHooksDir, { recursive: true });
      fs.writeFileSync(
        path.join(customHooksDir, 'my-hooks.json'),
        JSON.stringify({
          PreToolUse: [
            {
              description: 'From config path',
              hooks: [{ type: 'command', command: 'echo "config path"' }],
            },
          ],
        }),
      );

      // Create qwen-extension.json with hooks as string path
      fs.writeFileSync(
        path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify({
          name: 'hooks-prefer-config-path',
          version: '1.0.0',
          hooks: 'custom/my-hooks.json',
        }),
      );

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].hooks).toBeDefined();
      expect(
        (
          extensions[0].hooks!['PreToolUse']![0].hooks![0] as {
            command: string;
          }
        ).command,
      ).toBe('echo "config path"');
    });

    it('should substitute ${CLAUDE_PLUGIN_ROOT} in hooks file from config.hooks string path', async () => {
      const extensionDir = path.join(
        userExtensionsDir,
        'hooks-var-from-config-path',
      );
      fs.mkdirSync(extensionDir, { recursive: true });

      const customHooksDir = path.join(extensionDir, 'my-hooks');
      fs.mkdirSync(customHooksDir, { recursive: true });

      const hooksJson = {
        PreToolUse: [
          {
            description: 'Run with variable',
            hooks: [
              {
                type: 'command',
                command: '${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh',
              },
            ],
          },
        ],
      };

      fs.writeFileSync(
        path.join(customHooksDir, 'hooks.json'),
        JSON.stringify(hooksJson),
      );

      const configWithHooksPath = {
        name: 'hooks-var-from-config-path',
        version: '1.0.0',
        hooks: 'my-hooks/hooks.json',
      };

      fs.writeFileSync(
        path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify(configWithHooksPath),
      );

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].hooks).toBeDefined();
      expect(extensions[0].hooks!['PreToolUse']).toHaveLength(1);
      expect(
        (
          extensions[0].hooks!['PreToolUse']![0].hooks![0] as {
            command: string;
          }
        ).command,
      ).toBe(`${extensionDir}/scripts/setup.sh`);
    });
  });
});
