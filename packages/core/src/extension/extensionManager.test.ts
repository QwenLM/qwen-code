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
import { ExtensionPreferencesStore } from './extensionPreferences.js';
import {
  AGENT_PLUGIN_MCP_SCHEMA,
  AGENT_PLUGIN_SCHEMA,
} from './agent-plugins-v1/index.js';
import {
  EXTENSION_GIT_CREDENTIAL_SELECTOR_FILENAME,
  resolveStoredGitCredential,
} from './extension-git-credentials.js';
import { resetLocalGitVersionCacheForTesting } from './github.js';
import { FileTokenStorage } from '../mcp/token-storage/file-token-storage.js';

const mockGit = {
  clone: vi.fn(),
  getRemotes: vi.fn(),
  fetch: vi.fn(),
  checkout: vi.fn(),
  listRemote: vi.fn(),
  revparse: vi.fn(),
  version: vi.fn(),
  env: vi.fn(),
  path: vi.fn(),
};
const mockDownloadFromArchiveUrl = vi.hoisted(() => vi.fn());
const mockDownloadPublicGitHubArchiveFallback = vi.hoisted(() => vi.fn());
const mockDownloadFromGitHubRelease = vi.hoisted(() =>
  vi
    .fn()
    .mockRejectedValue(new Error('Mocked GitHub release download failure')),
);
const mockExtractArchiveFile = vi.hoisted(() => vi.fn());
const mockDownloadFromNpmRegistry = vi.hoisted(() => vi.fn());

vi.mock('simple-git', () => ({
  CheckRepoActions: { IS_REPO_ROOT: 'is-repo-root' },
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
    downloadPublicGitHubArchiveFallback:
      mockDownloadPublicGitHubArchiveFallback,
    downloadFromGitHubRelease: mockDownloadFromGitHubRelease,
    extractArchiveFile: mockExtractArchiveFile,
  };
});

// Wraps the real implementation (not a stub) so every existing scenario keeps
// its actual validation behavior; only call-site wiring is asserted on.
// afterEach's vi.restoreAllMocks() resets a bare vi.fn() back to a no-op, so
// the real implementation is held here and re-attached in beforeEach on
// every test, not just set once at module load.
const mockAssertDirectorySymlinksAreSafe = vi.hoisted(() => vi.fn());
const realAssertDirectorySymlinksAreSafe = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | (typeof import('./archive-safety.js'))['assertDirectorySymlinksAreSafe'],
}));
vi.mock('./archive-safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./archive-safety.js')>();
  realAssertDirectorySymlinksAreSafe.current =
    actual.assertDirectorySymlinksAreSafe;
  mockAssertDirectorySymlinksAreSafe.mockImplementation(
    actual.assertDirectorySymlinksAreSafe,
  );
  return {
    ...actual,
    assertDirectorySymlinksAreSafe: mockAssertDirectorySymlinksAreSafe,
  };
});

vi.mock('./npm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./npm.js')>();
  return {
    ...actual,
    downloadFromNpmRegistry: mockDownloadFromNpmRegistry,
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
  logExtensionInstallEvent: mockLogExtensionInstallEvent,
  logExtensionUninstall: mockLogExtensionUninstall,
  logExtensionDisable: mockLogExtensionDisable,
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

function createAgentPlugin(
  pluginRoot: string,
  {
    name = 'portable-plugin',
    version,
  }: { name?: string; version?: string } = {},
): void {
  fs.mkdirSync(path.join(pluginRoot, 'skills', 'direct'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(pluginRoot, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, 'plugin.json'),
    JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA,
      name,
      ...(version === undefined ? {} : { version }),
    }),
  );
  fs.writeFileSync(
    path.join(pluginRoot, 'skills', 'direct', 'SKILL.md'),
    '---\nname: direct\ndescription: Direct skill\nallowed-tools: Read\n---\nPortable instructions.',
  );
  fs.writeFileSync(path.join(pluginRoot, 'bin', 'server'), 'portable server');
  fs.writeFileSync(
    path.join(pluginRoot, 'mcp.json'),
    JSON.stringify({
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: {
        local: {
          type: 'stdio',
          command: './bin/server',
          args: ['${PLUGIN_ROOT}', '${PLUGIN_DATA}'],
        },
        remote: {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
        },
        legacy: {
          type: 'sse',
          url: 'https://example.com/sse',
        },
      },
    }),
  );
}

describe('extension tests', () => {
  let tempHomeDir: string;
  let tempWorkspaceDir: string;
  let userExtensionsDir: string;
  let savedQwenHome: string | undefined;
  let savedForceFileStorage: string | undefined;

  beforeEach(() => {
    savedQwenHome = process.env['QWEN_HOME'];
    savedForceFileStorage = process.env['QWEN_CODE_FORCE_FILE_STORAGE'];
    delete process.env['QWEN_HOME'];
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
    resetLocalGitVersionCacheForTesting();
    Object.values(mockGit).forEach((fn) => fn.mockReset());
    mockDownloadFromArchiveUrl.mockReset();
    mockDownloadPublicGitHubArchiveFallback.mockReset();
    mockDownloadFromGitHubRelease.mockReset();
    mockDownloadFromGitHubRelease.mockRejectedValue(
      new Error('Mocked GitHub release download failure'),
    );
    mockExtractArchiveFile.mockReset();
    mockDownloadFromNpmRegistry.mockReset();
    mockGit.revparse.mockResolvedValue('sample-commit');
    // vi.restoreAllMocks() in afterEach resets this bare vi.fn() back to a
    // no-op, so the real passthrough implementation must be re-attached
    // every test, not just cleared.
    mockAssertDirectorySymlinksAreSafe.mockReset();
    mockAssertDirectorySymlinksAreSafe.mockImplementation(
      realAssertDirectorySymlinksAreSafe.current!,
    );
  });

  afterEach(() => {
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
    if (savedQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = savedQwenHome;
    }
    if (savedForceFileStorage === undefined) {
      delete process.env['QWEN_CODE_FORCE_FILE_STORAGE'];
    } else {
      process.env['QWEN_CODE_FORCE_FILE_STORAGE'] = savedForceFileStorage;
    }
    vi.restoreAllMocks();
  });

  function createExtensionManager(
    options: Partial<ExtensionManagerOptions> = {},
  ): ExtensionManager {
    return new ExtensionManager({
      workspaceDir: tempWorkspaceDir,
      isWorkspaceTrusted: true,
      extensionStore: new ExtensionStore({
        extensionsDir: userExtensionsDir,
      }),
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

    function writeQoderPlugin(destination: string) {
      fs.mkdirSync(path.join(destination, '.qoder-plugin'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(destination, '.qoder-plugin', 'plugin.json'),
        JSON.stringify({ name: 'sample-qoder-plugin', version: '1.0.0' }),
      );
      fs.writeFileSync(
        path.join(destination, 'system-prompt.md'),
        '# System context',
      );
    }

    it('installs an Agent Plugin without converting package files', async () => {
      const sourcePath = path.join(tempWorkspaceDir, 'portable-source');
      createAgentPlugin(sourcePath);
      for (const component of ['commands', 'agents', 'hooks']) {
        fs.mkdirSync(path.join(sourcePath, component));
        fs.writeFileSync(path.join(sourcePath, component, 'ignored.md'), 'no');
      }
      fs.writeFileSync(path.join(sourcePath, 'QWEN.md'), 'ignored context');
      const sourceContents = new Map(
        [
          'plugin.json',
          'mcp.json',
          path.join('skills', 'direct', 'SKILL.md'),
          path.join('bin', 'server'),
        ].map((file) => [file, fs.readFileSync(path.join(sourcePath, file))]),
      );
      const outside = path.join(tempWorkspaceDir, 'outside.txt');
      fs.writeFileSync(outside, 'outside');
      if (process.platform !== 'win32') {
        fs.symlinkSync(outside, path.join(sourcePath, 'outside-link'));
      }

      const requestConsent = vi.fn(async () => {});
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = await manager.installExtension(
        { type: 'local', source: sourcePath },
        requestConsent,
      );

      expect(extension.version).toBe('1.0.0');
      expect(extension.format).toBe('agent-plugins-v1');
      expect(extension.installMetadata?.originSource).toBe('AgentPlugins');
      expect(extension.skills?.map((skill) => skill.name)).toEqual(['direct']);
      expect(extension.skills?.[0]?.allowedTools).toBeUndefined();
      expect(extension.commands).toEqual([]);
      expect(extension.agents).toEqual([]);
      expect(extension.contextFiles).toEqual([]);
      expect(extension.hooks).toBeUndefined();
      expect(extension.settings).toBeUndefined();
      expect(extension.channels).toBeUndefined();
      expect(Object.keys(extension.mcpServers ?? {})).toEqual([
        'local',
        'remote',
      ]);
      expect(extension.mcpServers?.['local']?.agentPluginV1).toBe(true);
      expect(extension.mcpServers?.['remote']?.agentPluginV1).toBe(true);
      expect(requestConsent).toHaveBeenCalledWith(
        expect.objectContaining({
          originSource: 'AgentPlugins',
          commands: [],
          subagents: [],
          skills: [expect.objectContaining({ name: 'direct' })],
        }),
      );

      for (const [file, contents] of sourceContents) {
        expect(fs.readFileSync(path.join(extension.path, file))).toEqual(
          contents,
        );
      }
      expect(
        fs.existsSync(path.join(extension.path, EXTENSIONS_CONFIG_FILENAME)),
      ).toBe(false);
      expect(
        fs.existsSync(path.join(extension.path, INSTALL_METADATA_FILENAME)),
      ).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.existsSync(path.join(extension.path, 'outside-link'))).toBe(
          false,
        );
      }
      const pluginData = extension.mcpServers?.['local']?.env?.['PLUGIN_DATA'];
      expect(pluginData).toBeDefined();
      expect(fs.statSync(pluginData!).isDirectory()).toBe(true);
    });

    it.runIf(process.platform !== 'win32')(
      'installs an Agent Plugin through a symlinked source root',
      async () => {
        const sourcePath = path.join(tempWorkspaceDir, 'portable-source-real');
        const symlinkPath = path.join(tempWorkspaceDir, 'portable-source-link');
        createAgentPlugin(sourcePath, { name: 'symlinked-plugin' });
        fs.symlinkSync(sourcePath, symlinkPath, 'dir');

        const manager = createExtensionManager();
        await manager.refreshCache();
        const installed = await manager.installExtension(
          { type: 'local', source: symlinkPath },
          async () => {},
        );

        expect(installed.name).toBe('symlinked-plugin');
        expect(installed.installMetadata).toMatchObject({
          source: symlinkPath,
          originSource: 'AgentPlugins',
        });
        expect(fs.existsSync(path.join(installed.path, 'plugin.json'))).toBe(
          true,
        );
      },
    );

    it('preserves Agent Plugin data across update and reinstall', async () => {
      const sourcePath = path.join(tempWorkspaceDir, 'persistent-source');
      createAgentPlugin(sourcePath, {
        name: 'persistent-plugin',
        version: '1.0.0',
      });
      const installMetadata = { type: 'local' as const, source: sourcePath };
      const manager = createExtensionManager();
      await manager.refreshCache();

      const installed = await manager.installExtension(
        installMetadata,
        async () => {},
      );
      const pluginData = installed.mcpServers?.['local']?.env?.['PLUGIN_DATA'];
      expect(pluginData).toBeDefined();
      fs.writeFileSync(path.join(pluginData!, 'state.txt'), 'persistent');

      createAgentPlugin(sourcePath, {
        name: 'persistent-plugin',
        version: '1.0.1',
      });
      const updated = await manager.installExtension(
        installMetadata,
        async () => {},
        undefined,
        undefined,
        installed.config,
      );
      expect(updated.version).toBe('1.0.1');
      expect(updated.mcpServers?.['local']?.env?.['PLUGIN_DATA']).toBe(
        pluginData,
      );
      expect(fs.readFileSync(path.join(pluginData!, 'state.txt'), 'utf8')).toBe(
        'persistent',
      );

      await manager.uninstallExtensionById(updated.id, false);
      const reinstalled = await manager.installExtension(
        installMetadata,
        async () => {},
      );
      expect(reinstalled.mcpServers?.['local']?.env?.['PLUGIN_DATA']).toBe(
        pluginData,
      );
      expect(fs.readFileSync(path.join(pluginData!, 'state.txt'), 'utf8')).toBe(
        'persistent',
      );
    });

    it('links an Agent Plugin and fingerprints its native manifest', async () => {
      const sourcePath = path.join(tempWorkspaceDir, 'linked-source');
      createAgentPlugin(sourcePath, {
        name: 'linked-plugin',
        version: '1.0.0',
      });
      const manager = createExtensionManager();
      await manager.refreshCache();

      const linked = await manager.installExtension(
        { type: 'link', source: sourcePath },
        async () => {},
      );
      expect(linked.path).toBe(sourcePath);
      expect(linked.installMetadata).toMatchObject({
        type: 'link',
        source: sourcePath,
        originSource: 'AgentPlugins',
      });
      expect(await manager.refreshCacheIfSourcesChanged()).toBe(true);
      expect(await manager.refreshCacheIfSourcesChanged()).toBe(false);

      const manifest = JSON.parse(
        fs.readFileSync(path.join(sourcePath, 'plugin.json'), 'utf8'),
      ) as Record<string, unknown>;
      fs.writeFileSync(
        path.join(sourcePath, 'plugin.json'),
        JSON.stringify({ ...manifest, version: '1.0.1-longer' }),
      );
      expect(await manager.refreshCacheIfSourcesChanged()).toBe(true);
      expect(manager.getLoadedExtensions()[0]?.version).toBe('1.0.1-longer');
      const installedPath = path.join(userExtensionsDir, 'linked-plugin');
      expect(fs.readdirSync(installedPath)).toEqual([
        INSTALL_METADATA_FILENAME,
      ]);
    });

    it.each([undefined, 42, ''])(
      'isolates link metadata with invalid source %s during refresh',
      async (source) => {
        const brokenLink = path.join(userExtensionsDir, 'broken-link');
        fs.mkdirSync(brokenLink, { recursive: true });
        fs.writeFileSync(
          path.join(brokenLink, INSTALL_METADATA_FILENAME),
          JSON.stringify({ type: 'link', source }),
        );
        createAgentPlugin(path.join(userExtensionsDir, 'valid-plugin'), {
          name: 'valid-plugin',
        });

        const manager = createExtensionManager();
        await expect(manager.refreshCache()).resolves.toBeUndefined();
        expect(manager.getLoadedExtensions().map(({ name }) => name)).toEqual([
          'valid-plugin',
        ]);
      },
    );

    it('installs an Agent Plugin from an archive', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'portable-plugin.zip');
      fs.writeFileSync(archivePath, 'synthetic archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          createAgentPlugin(destination, { name: 'archived-plugin' });
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();

      const installed = await manager.installExtension(
        { type: 'local', source: archivePath },
        async () => {},
      );

      expect(installed.name).toBe('archived-plugin');
      expect(installed.installMetadata?.originSource).toBe('AgentPlugins');
      expect(
        fs.existsSync(path.join(installed.path, 'qwen-extension.json')),
      ).toBe(false);
    });

    it('installs an Agent Plugin from Git', async () => {
      mockGit.clone.mockImplementation(async () => {
        createAgentPlugin(mockGit.path(), { name: 'git-agent-plugin' });
      });
      mockGit.getRemotes.mockResolvedValue([
        {
          name: 'origin',
          refs: { fetch: 'https://github.com/example/portable-plugin' },
        },
      ]);
      mockGit.fetch.mockResolvedValue(undefined);
      mockGit.checkout.mockResolvedValue(undefined);
      const manager = createExtensionManager();
      await manager.refreshCache();

      const installed = await manager.installExtension(
        {
          type: 'git',
          source: 'https://github.com/example/portable-plugin',
        },
        async () => {},
      );

      expect(installed.name).toBe('git-agent-plugin');
      expect(installed.installMetadata).toMatchObject({
        originSource: 'AgentPlugins',
        gitCommit: 'sample-commit',
      });
      expect(
        fs.existsSync(path.join(installed.path, 'qwen-extension.json')),
      ).toBe(false);
    });

    it('materializes validated Agent Plugin symlinks from the old-Git archive fallback', async () => {
      mockGit.version.mockResolvedValue({ major: 2, minor: 34, patch: 1 });
      mockDownloadPublicGitHubArchiveFallback.mockImplementation(
        async (_metadata: ExtensionInstallMetadata, destination: string) => {
          createAgentPlugin(destination, { name: 'old-git-agent-plugin' });
          fs.writeFileSync(path.join(destination, 'CLAUDE.md'), '# agents\n');
          if (process.platform !== 'win32') {
            fs.symlinkSync('CLAUDE.md', path.join(destination, 'AGENTS.md'));
          }
          return '0123456789abcdef0123456789abcdef01234567';
        },
      );
      const manager = createExtensionManager({ networkPolicy: 'public' });
      await manager.refreshCache();

      const installed = await manager.installExtension(
        {
          type: 'git',
          source: 'https://github.com/example/agent-plugin',
        },
        async () => {},
      );

      expect(installed.name).toBe('old-git-agent-plugin');
      expect(installed.installMetadata).toMatchObject({
        type: 'git',
        source: 'https://github.com/example/agent-plugin',
        gitCommit: '0123456789abcdef0123456789abcdef01234567',
        originSource: 'AgentPlugins',
      });
      if (process.platform !== 'win32') {
        const installedAgents = path.join(installed.path, 'AGENTS.md');
        expect(fs.lstatSync(installedAgents).isFile()).toBe(true);
        expect(fs.readFileSync(installedAgents, 'utf8')).toBe('# agents\n');
      }
      // Releases stay preferred over the archive fallback on older Git.
      expect(mockDownloadFromGitHubRelease).toHaveBeenCalled();
      expect(mockDownloadPublicGitHubArchiveFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'git',
          source: 'https://github.com/example/agent-plugin',
        }),
        expect.any(String),
        undefined,
      );
      expect(mockGit.clone).not.toHaveBeenCalled();
    });

    it('re-validates symlinks on the post-conversion tree when the old-Git archive fallback feeds a converter', async () => {
      // The archive-fallback validation only ever proves
      // sourceBeforeConversion safe. When conversion actually relocates the
      // tree (unlike the AgentPlugins case above, which never does), the
      // post-conversion directory must be re-validated rather than trusted
      // on the strength of a check that ran against a different directory.
      let fallbackDestination: string | undefined;
      mockGit.version.mockResolvedValue({ major: 2, minor: 34, patch: 1 });
      mockDownloadPublicGitHubArchiveFallback.mockImplementation(
        async (_metadata: ExtensionInstallMetadata, destination: string) => {
          fallbackDestination = destination;
          fs.writeFileSync(
            path.join(destination, 'gemini-extension.json'),
            JSON.stringify({
              name: 'old-git-gemini-extension',
              version: '1.0.0',
            }),
          );
          return '0123456789abcdef0123456789abcdef01234567';
        },
      );
      const manager = createExtensionManager({ networkPolicy: 'public' });
      await manager.refreshCache();

      const installed = await manager.installExtension(
        {
          type: 'git',
          source: 'https://github.com/example/gemini-extension',
        },
        async () => {},
      );

      expect(installed.name).toBe('old-git-gemini-extension');
      expect(installed.installMetadata).toMatchObject({
        originSource: 'Gemini',
      });
      expect(fallbackDestination).toBeDefined();
      // Real Gemini conversion always copies to a fresh temp dir, so this
      // only passes when the guard's
      // `localSourcePath !== sourceBeforeConversion` half is reachable —
      // gating it on `isAgentPlugin` as well (the bug this test guards
      // against) would make it structurally unreachable, since AgentPlugins
      // conversion never relocates the tree.
      // Escape regex metacharacters before building the pattern: on Windows
      // fallbackDestination contains backslashes (e.g. `C:\Users\...`),
      // which a raw RegExp would read as escape sequences rather than path
      // separators, silently matching nothing and passing regardless of
      // what path the guard was actually called with.
      const escapedFallbackDestination = fallbackDestination!.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      );
      expect(mockAssertDirectorySymlinksAreSafe).toHaveBeenCalledWith(
        expect.not.stringMatching(
          new RegExp(`^${escapedFallbackDestination}$`),
        ),
        undefined,
      );
    });

    it('aborts the install when post-conversion re-validation rejects the relocated tree', async () => {
      // The guard above only pins that re-validation is CALLED on the
      // relocated directory. This pins the other half: when that
      // re-validation actually rejects (the stale-trust scenario the guard
      // exists to catch), the install must abort rather than silently
      // proceeding with the unsafe tree.
      mockGit.version.mockResolvedValue({ major: 2, minor: 34, patch: 1 });
      mockDownloadPublicGitHubArchiveFallback.mockImplementation(
        async (_metadata: ExtensionInstallMetadata, destination: string) => {
          fs.writeFileSync(
            path.join(destination, 'gemini-extension.json'),
            JSON.stringify({
              name: 'old-git-gemini-extension-unsafe',
              version: '1.0.0',
            }),
          );
          return '0123456789abcdef0123456789abcdef01234567';
        },
      );
      mockAssertDirectorySymlinksAreSafe.mockRejectedValueOnce(
        new Error('Tar archive contains unsupported link entry: escape'),
      );
      const manager = createExtensionManager({ networkPolicy: 'public' });
      await manager.refreshCache();

      await expect(
        manager.installExtension(
          {
            type: 'git',
            source: 'https://github.com/example/gemini-extension-unsafe',
          },
          async () => {},
        ),
      ).rejects.toThrow('unsupported link entry');

      expect(
        fs.existsSync(
          path.join(
            userExtensionsDir,
            'old-git-gemini-extension-unsafe',
            EXTENSIONS_CONFIG_FILENAME,
          ),
        ),
      ).toBe(false);
    });

    it('keeps release installs ahead of the old-Git archive fallback', async () => {
      mockGit.version.mockResolvedValue({ major: 2, minor: 34, patch: 1 });
      mockDownloadFromGitHubRelease.mockImplementation(
        async (_metadata: ExtensionInstallMetadata, destination: string) => {
          writeExtractedExtension(destination, 'release-extension');
          return { tagName: 'v2.0.0', type: 'github-release' as const };
        },
      );
      const manager = createExtensionManager({ networkPolicy: 'public' });
      await manager.refreshCache();

      const installed = await manager.installExtension(
        {
          type: 'git',
          source: 'https://github.com/owner/repo',
        },
        async () => {},
      );

      expect(installed.installMetadata).toMatchObject({
        type: 'github-release',
        source: 'https://github.com/owner/repo',
        releaseTag: 'v2.0.0',
      });
      expect(mockDownloadPublicGitHubArchiveFallback).not.toHaveBeenCalled();
      expect(mockGit.clone).not.toHaveBeenCalled();
    });

    it('persists a credentialed one-time install as a source-free snapshot', async () => {
      mockGit.env.mockReturnValue(mockGit);
      mockGit.clone.mockImplementation(async () => {
        const destination = mockGit.path();
        writeExtractedExtension(destination, 'one-time-extension');
        fs.mkdirSync(path.join(destination, '.git'), { recursive: true });
        fs.writeFileSync(
          path.join(destination, '.git', 'config'),
          'credential must not be copied',
        );
      });
      mockGit.getRemotes.mockResolvedValue([
        {
          name: 'origin',
          refs: { fetch: 'https://git.example.com/team/extension.git' },
        },
      ]);
      const manager = createExtensionManager();
      await manager.refreshCache();

      const prepared = await manager.prepareExtensionInstall({
        installMetadata: {
          type: 'git',
          source: 'https://git.example.com/team/extension.git',
        },
        initialActivation: { scope: 'user' },
        requestConsent: async () => {},
        gitCredential: {
          username: 'user',
          password: 'fine-grained-token',
          persistence: 'one_time',
        },
      });

      expect(prepared.installMetadata).toMatchObject({
        type: 'snapshot',
        source: 'snapshot',
        installId: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(prepared.identity.id).toBe(prepared.installMetadata.installId);
      expect(fs.existsSync(path.join(prepared.stagingDirectory, '.git'))).toBe(
        false,
      );
      expect(
        fs.existsSync(
          path.join(
            prepared.stagingDirectory,
            EXTENSION_GIT_CREDENTIAL_SELECTOR_FILENAME,
          ),
        ),
      ).toBe(false);
      const stagedMetadata = fs.readFileSync(
        path.join(prepared.stagingDirectory, INSTALL_METADATA_FILENAME),
        'utf8',
      );
      expect(stagedMetadata).not.toContain('git.example.com');
      expect(stagedMetadata).not.toContain('fine-grained-token');

      mockLogExtensionInstallEvent.mockClear();
      const committed = await manager.commitPreparedExtension(prepared);
      expect(committed.extension?.id).toBe(prepared.identity.id);
      expect(committed.extension?.installMetadata?.type).toBe('snapshot');
      expect(mockLogExtensionInstallEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          extension_source: 'snapshot',
          status: 'success',
        }),
      );
      const telemetryEvents = mockLogExtensionInstallEvent.mock.calls.map(
        ([, event]) => event,
      );
      expect(JSON.stringify(telemetryEvents)).not.toContain('git.example.com');
      expect(JSON.stringify(telemetryEvents)).not.toContain(
        'fine-grained-token',
      );
      const reloadedManager = createExtensionManager();
      await reloadedManager.refreshCache();
      expect(reloadedManager.getLoadedExtensions()[0]?.id).toBe(
        prepared.identity.id,
      );
      await expect(
        reloadedManager.updateExtension(
          reloadedManager.getLoadedExtensions()[0]!,
          ExtensionUpdateState.UPDATE_AVAILABLE,
          () => {},
        ),
      ).rejects.toMatchObject({ code: 'extension_not_updatable' });
      await manager.disposePreparedExtension(prepared);
    });

    it('stores managed Git credentials separately from install metadata', async () => {
      process.env['QWEN_HOME'] = tempHomeDir;
      process.env['QWEN_CODE_FORCE_FILE_STORAGE'] = 'true';
      mockGit.env.mockReturnValue(mockGit);
      mockGit.clone.mockImplementation(async () => {
        writeExtractedExtension(mockGit.path(), 'stored-extension');
      });
      mockGit.getRemotes.mockResolvedValue([
        {
          name: 'origin',
          refs: { fetch: 'https://git.example.com/team/extension.git' },
        },
      ]);
      const manager = createExtensionManager();
      await manager.refreshCache();

      const prepared = await manager.prepareExtensionInstall({
        installMetadata: {
          type: 'git',
          source: 'https://git.example.com/team/extension.git',
        },
        initialActivation: { scope: 'user' },
        requestConsent: async () => {},
        gitCredential: {
          username: 'user',
          password: 'fine-grained-token',
          persistence: 'stored',
        },
      });

      expect(prepared.installMetadata).toMatchObject({
        type: 'git',
        source: 'https://git.example.com/team/extension.git',
        credentialPersistence: 'stored',
        installId: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const metadata = fs.readFileSync(
        path.join(prepared.stagingDirectory, INSTALL_METADATA_FILENAME),
        'utf8',
      );
      expect(metadata).not.toContain('fine-grained-token');

      const committed = await manager.commitPreparedExtension(prepared);
      const resolved = await resolveStoredGitCredential(
        committed.extension!.path,
      );
      expect(resolved).toMatchObject({
        credential: { username: 'user', password: 'fine-grained-token' },
      });
      const originalId = committed.identity.id;

      await manager.updateExtension(
        committed.extension!,
        ExtensionUpdateState.UPDATE_AVAILABLE,
        () => {},
      );

      expect(manager.getLoadedExtensions()[0]?.id).toBe(originalId);
      expect(mockGit.clone).toHaveBeenLastCalledWith(
        'https://git.example.com/team/extension.git',
        './',
        expect.any(Array),
      );
      expect(mockGit.env).toHaveBeenLastCalledWith(
        expect.objectContaining({
          GIT_CONFIG_KEY_0:
            'http.https://git.example.com/team/extension.git.extraHeader',
        }),
      );
      const storage = new FileTokenStorage(
        'Qwen Code Extension Git Credentials',
      );
      await expect(
        storage.getSecret(resolved.selector.secretKey),
      ).resolves.not.toBeNull();

      fs.writeFileSync(
        path.join(
          userExtensionsDir,
          'stored-extension',
          EXTENSIONS_CONFIG_FILENAME,
        ),
        '{',
      );
      const unloadedManager = createExtensionManager();
      await unloadedManager.refreshCache();
      expect(unloadedManager.getLoadedExtensions()).toEqual([]);
      await unloadedManager.uninstallExtensionById(originalId, false);
      await expect(
        storage.getSecret(resolved.selector.secretKey),
      ).resolves.toBeNull();
      await manager.disposePreparedExtension(prepared);
    });

    it('installs and uninstalls within an injected extension store root', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'custom-root.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtractedExtension(destination, 'custom-root');
        },
      );
      const customExtensionsDir = path.join(tempHomeDir, 'custom-extensions');
      const manager = createExtensionManager({
        extensionStore: new ExtensionStore({
          extensionsDir: customExtensionsDir,
        }),
      });

      const installed = await manager.installExtension(
        { type: 'local', source: archivePath },
        async () => {},
      );

      expect(installed.path).toBe(
        path.join(customExtensionsDir, 'custom-root'),
      );
      await manager.uninstallExtensionById(installed.id, true);
      expect(fs.existsSync(installed.path)).toBe(false);
    });

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

    it('reads an uploaded archive from a local path without persisting that path', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'uploaded.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtractedExtension(destination, 'uploaded-extension');
        },
      );
      const manager = createExtensionManager();

      const prepared = await manager.prepareExtensionInstall({
        installMetadata: { type: 'local', source: 'upload:uploaded.zip' },
        localSourcePath: archivePath,
        initialActivation: { scope: 'user' },
        requestConsent: async () => {},
      });

      expect(mockExtractArchiveFile).toHaveBeenLastCalledWith(
        archivePath,
        expect.any(String),
        undefined,
      );
      expect(prepared.installMetadata.source).toBe('upload:uploaded.zip');

      await manager.commitPreparedExtension(prepared);
      const metadata = manager.loadInstallMetadata(
        path.join(userExtensionsDir, 'uploaded-extension'),
      );
      expect(metadata?.source).toBe('upload:uploaded.zip');
      await manager.disposePreparedExtension(prepared);
      expect(fs.existsSync(archivePath)).toBe(true);
    });

    it('rejects a local source path for non-local installs', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'uploaded.zip');
      fs.writeFileSync(archivePath, 'archive');
      const manager = createExtensionManager();

      await expect(
        manager.prepareExtensionInstall({
          installMetadata: {
            type: 'git',
            source: 'https://example.com/extension.git',
          },
          localSourcePath: archivePath,
          initialActivation: { scope: 'user' },
          requestConsent: async () => {},
        }),
      ).rejects.toThrow('A local source path requires a local install.');
    });

    it('signals the durable commit before runtime refresh completes', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'commit-boundary.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtractedExtension(destination, 'commit-boundary');
        },
      );
      const manager = createExtensionManager();
      let finishRefresh!: () => void;
      const refreshBlocked = new Promise<void>((resolve) => {
        finishRefresh = resolve;
      });
      vi.spyOn(manager, 'refreshTools').mockImplementation(
        async () => await refreshBlocked,
      );
      const prepared = await manager.prepareExtensionInstall({
        installMetadata: { type: 'local', source: archivePath },
        initialActivation: { scope: 'user' },
        requestConsent: async () => {},
      });
      const committedGenerations: number[] = [];
      let settled = false;

      const committing = manager
        .commitPreparedExtension(prepared, (generation) => {
          committedGenerations.push(generation);
        })
        .finally(() => {
          settled = true;
        });

      await vi.waitFor(() => expect(committedGenerations).toHaveLength(1));
      expect(settled).toBe(false);
      finishRefresh();
      await committing;
    });

    it('fully validates the staged extension before commit', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'invalid-context.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(
            path.join(destination, EXTENSIONS_CONFIG_FILENAME),
            JSON.stringify({
              name: 'invalid-context',
              version: '1.0.0',
              contextFileName: 42,
            }),
          );
        },
      );
      const manager = createExtensionManager();
      const before = await manager.getExtensionStoreSnapshot();

      await expect(
        manager.prepareExtensionInstall({
          installMetadata: { type: 'local', source: archivePath },
          initialActivation: { scope: 'user' },
          requestConsent: async () => {},
        }),
      ).rejects.toThrow();

      expect(await manager.getExtensionStoreSnapshot()).toEqual(before);
      expect(
        fs.existsSync(path.join(userExtensionsDir, 'invalid-context')),
      ).toBe(false);
    });

    it('commits a fully validated extension without an explicit version', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'default-version.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(
            path.join(destination, EXTENSIONS_CONFIG_FILENAME),
            JSON.stringify({ name: 'default-version' }),
          );
        },
      );
      const manager = createExtensionManager();
      const prepared = await manager.prepareExtensionInstall({
        installMetadata: { type: 'local', source: archivePath },
        initialActivation: { scope: 'user' },
        requestConsent: async () => {},
      });

      try {
        const committed = await manager.commitPreparedExtension(prepared);
        expect(committed.version).toBe('1.0.0');
        expect(committed.extension?.version).toBe('1.0.0');
      } finally {
        await manager.disposePreparedExtension(prepared);
      }
    });

    it('stops archive preparation when cancellation follows download', async () => {
      const controller = new AbortController();
      const reason = new Error('preparation expired');
      mockDownloadFromArchiveUrl.mockImplementationOnce(async () => {
        controller.abort(reason);
      });
      const manager = createExtensionManager();

      await expect(
        manager.prepareExtensionInstall({
          installMetadata: {
            type: 'archive-url',
            source: 'https://example.com/extension.zip',
          },
          initialActivation: { scope: 'user' },
          requestConsent: async () => {},
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);
    });

    it('uses the installed path for Claude plugin root replacement', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'claude-ext.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          const pluginDirectory = path.join(destination, '.claude-plugin');
          fs.mkdirSync(pluginDirectory, { recursive: true });
          fs.writeFileSync(
            path.join(pluginDirectory, 'plugin.json'),
            JSON.stringify({ name: 'claude-ext', version: '1.0.0' }),
          );
          fs.mkdirSync(path.join(destination, 'hooks'));
          fs.writeFileSync(
            path.join(destination, 'README.md'),
            '${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh',
          );
        },
      );
      const manager = createExtensionManager();
      const prepared = await manager.prepareExtensionInstall({
        installMetadata: {
          type: 'local',
          source: archivePath,
        },
        initialActivation: { scope: 'user' },
        requestConsent: async () => {},
      });

      try {
        await manager.commitPreparedExtension(prepared);
        expect(
          path.normalize(
            fs.readFileSync(
              path.join(prepared.destinationDirectory, 'README.md'),
              'utf8',
            ),
          ),
        ).toBe(path.join(prepared.destinationDirectory, 'scripts', 'setup.sh'));
      } finally {
        await manager.disposePreparedExtension(prepared);
      }
    });

    it('does not report a temp cleanup warning when an immediate retry succeeds', async () => {
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
      let cleanupAttempts = 0;
      vi.spyOn(fs.promises, 'rm').mockImplementation(
        async (target, options) => {
          if (target === cleanupPath && cleanupAttempts++ === 0) {
            throw new Error('cleanup denied');
          }
          return await rm(target, options);
        },
      );

      const committed = await manager.commitPreparedExtension(prepared);

      expect(committed.generation).toBeGreaterThan(0);
      expect(committed.warnings).toBeUndefined();
      expect(prepared.disposed).toBe(true);
      await expect(
        manager.disposePreparedExtension(prepared),
      ).resolves.toBeUndefined();
      expect(cleanupAttempts).toBe(2);
      expect(fs.existsSync(cleanupPath)).toBe(false);
    });

    it('reports deferred settings failure as a post-commit warning', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'settings-warning.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtractedExtension(destination, 'settings-warning');
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();
      const prepared = await manager.prepareExtensionInstall({
        installMetadata: { type: 'local', source: archivePath },
        initialActivation: { scope: 'user' },
        requestConsent: async () => {},
      });
      Object.defineProperty(prepared, 'commitSettings', {
        value: vi.fn().mockRejectedValue(new Error('keychain unavailable')),
      });

      const committed = await manager.commitPreparedExtension(prepared);

      expect(committed.warnings).toContainEqual({
        code: 'extension_settings_legacy_sync_failed',
        error: 'keychain unavailable',
      });
    });

    it('signals the durable commit before deferred settings finish', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'settings-deferred.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtractedExtension(destination, 'settings-deferred');
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();
      const prepared = await manager.prepareExtensionInstall({
        installMetadata: { type: 'local', source: archivePath },
        initialActivation: { scope: 'user' },
        requestConsent: async () => {},
      });
      let finishSettings!: () => void;
      const settingsBlocked = new Promise<void>((resolve) => {
        finishSettings = resolve;
      });
      const commitSettings = vi.fn(async () => await settingsBlocked);
      Object.defineProperty(prepared, 'commitSettings', {
        value: commitSettings,
      });
      const onCommitted = vi.fn();

      const committing = manager.commitPreparedExtension(prepared, onCommitted);
      await vi.waitFor(() => expect(commitSettings).toHaveBeenCalledOnce());

      expect(onCommitted).toHaveBeenCalledOnce();
      expect(onCommitted.mock.invocationCallOrder[0]).toBeLessThan(
        commitSettings.mock.invocationCallOrder[0]!,
      );
      finishSettings();
      await expect(committing).resolves.toMatchObject({
        identity: { name: 'settings-deferred' },
      });
    });

    it('surfaces committed runtime refresh warnings after install reloads', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'refresh-warning.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtractedExtension(destination, 'refresh-warning');
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();
      vi.spyOn(manager, 'refreshTools').mockRejectedValueOnce(
        new Error('runtime stale'),
      );

      await expect(
        manager.installExtension(
          { type: 'local', source: archivePath },
          async () => {},
        ),
      ).rejects.toMatchObject({
        code: 'extension_committed_with_warnings',
        committed: true,
        identity: { name: 'refresh-warning' },
        warnings: [
          {
            code: 'extension_runtime_refresh_failed',
            error: 'runtime stale',
          },
        ],
      });
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
      const commitSettings = vi.fn();
      Object.defineProperty(prepared, 'commitSettings', {
        value: commitSettings,
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
      expect(commitSettings).not.toHaveBeenCalled();
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
        manager.commitPreparedExtension(forged),
      ).rejects.toMatchObject({ code: 'invalid_prepared_extension' });
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
        undefined,
      );
      expect(extension.name).toBe('local-archive-extension');
      expect(extension.installMetadata).toMatchObject({
        source: archivePath,
        type: 'local',
      });
    });

    it('should install a Qoder plugin with skills and system context', async () => {
      const sourcePath = path.join(tempWorkspaceDir, 'sample-qoder-plugin');
      fs.mkdirSync(path.join(sourcePath, '.qoder-plugin'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(sourcePath, '.qoder-plugin', 'plugin.json'),
        JSON.stringify({ name: 'sample-qoder-plugin', version: '1.0.0' }),
      );
      fs.writeFileSync(
        path.join(sourcePath, 'system-prompt.md'),
        '# System context',
      );
      const skillPath = path.join(sourcePath, 'skills', 'sample-skill');
      fs.mkdirSync(skillPath, { recursive: true });
      fs.writeFileSync(
        path.join(skillPath, 'SKILL.md'),
        '---\nname: sample-skill\ndescription: Synthetic skill\n---\n',
      );
      const commandsPath = path.join(sourcePath, 'commands');
      fs.mkdirSync(commandsPath, { recursive: true });
      fs.writeFileSync(
        path.join(commandsPath, 'sample.md'),
        '# Command\n${CLAUDE_PLUGIN_ROOT}/scripts/run.sh',
      );
      const hooksPath = path.join(sourcePath, 'hooks');
      fs.mkdirSync(hooksPath, { recursive: true });
      fs.writeFileSync(path.join(hooksPath, 'hooks.json'), '{}');
      const requestConsent = vi.fn(async () => {});
      const manager = createExtensionManager();
      await manager.refreshCache();

      const extension = await manager.installExtension(
        { source: sourcePath, type: 'local' },
        requestConsent,
      );

      expect(extension.installMetadata).toMatchObject({
        source: sourcePath,
        type: 'local',
        originSource: 'Qoder',
      });
      expect(extension.contextFiles).toEqual([
        path.join(extension.path, 'system-prompt.md'),
      ]);
      expect(extension.skills?.map((skill) => skill.name)).toEqual([
        'sample-skill',
      ]);
      expect(
        fs.readFileSync(
          path.join(extension.path, 'commands', 'sample.md'),
          'utf-8',
        ),
      ).toContain(`${extension.path}/scripts/run.sh`);
      expect(requestConsent).toHaveBeenCalledWith(
        expect.objectContaining({ originSource: 'Qoder' }),
      );
    });

    it.each([
      {
        type: 'local' as const,
        source: 'sample-qoder-plugin.zip',
      },
      {
        type: 'archive-url' as const,
        source: 'https://example.com/sample-qoder-plugin.zip',
      },
      {
        type: 'npm' as const,
        source: '@example/sample-qoder-plugin',
      },
    ])('should install a Qoder plugin from $type', async (installMetadata) => {
      const resolvedInstallMetadata =
        installMetadata.type === 'local'
          ? {
              ...installMetadata,
              source: path.join(tempWorkspaceDir, installMetadata.source),
            }
          : installMetadata;
      if (resolvedInstallMetadata.type === 'local') {
        fs.writeFileSync(resolvedInstallMetadata.source, 'synthetic archive');
        mockExtractArchiveFile.mockImplementation(
          async (_source: string, destination: string) => {
            writeQoderPlugin(destination);
          },
        );
      } else if (installMetadata.type === 'archive-url') {
        mockDownloadFromArchiveUrl.mockImplementation(
          async (_metadata: ExtensionInstallMetadata, destination: string) => {
            writeQoderPlugin(destination);
          },
        );
      } else {
        mockDownloadFromNpmRegistry.mockImplementation(
          async (_metadata: ExtensionInstallMetadata, destination: string) => {
            writeQoderPlugin(destination);
            return { version: '1.0.0', type: 'npm' };
          },
        );
      }
      const manager = createExtensionManager();
      await manager.refreshCache();

      const extension = await manager.installExtension(
        resolvedInstallMetadata,
        async () => {},
      );

      expect(extension.name).toBe('sample-qoder-plugin');
      expect(extension.installMetadata?.originSource).toBe('Qoder');
      expect(extension.contextFiles).toEqual([
        path.join(extension.path, 'system-prompt.md'),
      ]);
    });

    it('should install a Qoder plugin from Git', async () => {
      mockGit.clone.mockImplementation(async () => {
        writeQoderPlugin(mockGit.path());
      });
      mockGit.getRemotes.mockResolvedValue([
        {
          name: 'origin',
          refs: { fetch: 'https://github.com/example/sample-qoder-plugin' },
        },
      ]);
      mockGit.fetch.mockResolvedValue(undefined);
      mockGit.checkout.mockResolvedValue(undefined);
      const manager = createExtensionManager();
      await manager.refreshCache();

      const extension = await manager.installExtension(
        {
          type: 'git',
          source: 'https://github.com/example/sample-qoder-plugin',
        },
        async () => {},
      );

      expect(extension.name).toBe('sample-qoder-plugin');
      expect(extension.installMetadata?.originSource).toBe('Qoder');
      expect(extension.installMetadata?.gitCommit).toBe('sample-commit');
    });

    it('should retain the recorded commit for a converted Claude Git plugin', async () => {
      mockGit.clone.mockImplementation(async () => {
        const sourcePath = mockGit.path();
        fs.mkdirSync(path.join(sourcePath, '.claude-plugin'), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(sourcePath, '.claude-plugin', 'plugin.json'),
          JSON.stringify({ name: 'sample-claude-plugin', version: '1.0.0' }),
        );
      });
      mockGit.getRemotes.mockResolvedValue([
        {
          name: 'origin',
          refs: { fetch: 'https://github.com/example/sample-claude-plugin' },
        },
      ]);
      mockGit.fetch.mockResolvedValue(undefined);
      mockGit.checkout.mockResolvedValue(undefined);
      const manager = createExtensionManager();
      await manager.refreshCache();

      const extension = await manager.installExtension(
        {
          type: 'git',
          source: 'https://github.com/example/sample-claude-plugin',
        },
        async () => {},
      );

      expect(extension.installMetadata?.originSource).toBe('Claude');
      expect(extension.installMetadata?.gitCommit).toBe('sample-commit');
    });

    it('should retain the recorded commit when a marketplace plugin lives in the marketplace repo', async () => {
      mockGit.clone.mockImplementation(async () => {
        const sourcePath = mockGit.path();
        fs.mkdirSync(path.join(sourcePath, '.claude-plugin'), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(sourcePath, '.claude-plugin', 'marketplace.json'),
          JSON.stringify({
            name: 'sample-marketplace',
            owner: { name: 'Example', email: 'example@example.com' },
            plugins: [
              { name: 'sample-plugin', source: './plugins/sample-plugin' },
            ],
          }),
        );
        const pluginConfigDir = path.join(
          sourcePath,
          'plugins',
          'sample-plugin',
          '.claude-plugin',
        );
        fs.mkdirSync(pluginConfigDir, { recursive: true });
        fs.writeFileSync(
          path.join(pluginConfigDir, 'plugin.json'),
          JSON.stringify({ name: 'sample-plugin', version: '1.0.0' }),
        );
        fs.writeFileSync(
          path.join(path.dirname(pluginConfigDir), 'plugin.json'),
          JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA,
            name: 'carried-agent-plugin',
          }),
        );
      });
      mockGit.getRemotes.mockResolvedValue([
        {
          name: 'origin',
          refs: { fetch: 'https://github.com/example/sample-marketplace' },
        },
      ]);
      mockGit.fetch.mockResolvedValue(undefined);
      mockGit.checkout.mockResolvedValue(undefined);
      const manager = createExtensionManager();
      await manager.refreshCache();

      const extension = await manager.installExtension(
        {
          type: 'git',
          source: 'https://github.com/example/sample-marketplace',
          pluginName: 'sample-plugin',
        },
        async () => {},
      );

      expect(extension.name).toBe('sample-plugin');
      expect(extension.format).toBe('qwen');
      expect(extension.installMetadata?.originSource).toBe('Claude');
      expect(extension.installMetadata?.gitCommit).toBe('sample-commit');
      expect(extension.installMetadata?.externalContent).toBe(false);
      expect(fs.existsSync(path.join(extension.path, 'plugin.json'))).toBe(
        false,
      );
    });

    it('should drop the recorded commit when a marketplace plugin resolves from an external source', async () => {
      let cloneCalls = 0;
      mockGit.clone.mockImplementation(async () => {
        const sourcePath = mockGit.path();
        cloneCalls += 1;
        fs.mkdirSync(path.join(sourcePath, '.claude-plugin'), {
          recursive: true,
        });
        if (cloneCalls === 1) {
          fs.writeFileSync(
            path.join(sourcePath, '.claude-plugin', 'marketplace.json'),
            JSON.stringify({
              name: 'sample-marketplace',
              owner: { name: 'Example', email: 'example@example.com' },
              plugins: [
                {
                  name: 'sample-plugin',
                  source: { source: 'github', repo: 'example/nested-plugin' },
                },
              ],
            }),
          );
        } else {
          fs.writeFileSync(
            path.join(sourcePath, '.claude-plugin', 'plugin.json'),
            JSON.stringify({ name: 'sample-plugin', version: '1.0.0' }),
          );
        }
      });
      mockGit.getRemotes.mockResolvedValue([
        {
          name: 'origin',
          refs: { fetch: 'https://github.com/example/sample-marketplace' },
        },
      ]);
      mockGit.fetch.mockResolvedValue(undefined);
      mockGit.checkout.mockResolvedValue(undefined);
      const manager = createExtensionManager();
      await manager.refreshCache();

      const extension = await manager.installExtension(
        {
          type: 'git',
          source: 'https://github.com/example/sample-marketplace',
          pluginName: 'sample-plugin',
        },
        async () => {},
      );

      expect(extension.name).toBe('sample-plugin');
      expect(extension.installMetadata?.originSource).toBe('Claude');
      expect(extension.installMetadata?.gitCommit).toBeUndefined();
      expect(extension.installMetadata?.externalContent).toBe(true);
    });

    it('should mark external marketplace content downloaded from a GitHub release as not independently updatable', async () => {
      const { downloadFromGitHubRelease } = await import('./github.js');
      vi.mocked(downloadFromGitHubRelease).mockImplementationOnce(
        async (_metadata, destination) => {
          fs.mkdirSync(path.join(destination, '.claude-plugin'), {
            recursive: true,
          });
          fs.writeFileSync(
            path.join(destination, '.claude-plugin', 'marketplace.json'),
            JSON.stringify({
              name: 'sample-marketplace',
              owner: { name: 'Example', email: 'example@example.com' },
              plugins: [
                {
                  name: 'sample-plugin',
                  source: { source: 'github', repo: 'example/nested-plugin' },
                },
              ],
            }),
          );
          return { type: 'github-release', tagName: 'v1.0.0' };
        },
      );
      mockGit.clone.mockImplementation(async () => {
        const sourcePath = mockGit.path();
        fs.mkdirSync(path.join(sourcePath, '.claude-plugin'), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(sourcePath, '.claude-plugin', 'plugin.json'),
          JSON.stringify({ name: 'sample-plugin', version: '1.0.0' }),
        );
      });
      mockGit.getRemotes.mockResolvedValue([
        {
          name: 'origin',
          refs: { fetch: 'https://github.com/example/nested-plugin' },
        },
      ]);
      mockGit.fetch.mockResolvedValue(undefined);
      mockGit.checkout.mockResolvedValue(undefined);
      const manager = createExtensionManager();
      await manager.refreshCache();

      const extension = await manager.installExtension(
        {
          type: 'git',
          source: 'https://github.com/example/sample-marketplace',
          pluginName: 'sample-plugin',
        },
        async () => {},
      );

      expect(extension.installMetadata).toMatchObject({
        type: 'github-release',
        releaseTag: 'v1.0.0',
        originSource: 'Claude',
        externalContent: true,
      });
      expect(extension.installMetadata?.gitCommit).toBeUndefined();
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
      mockGit.getRemotes.mockResolvedValue([
        {
          name: 'origin',
          refs: { fetch: 'https://github.com/owner/repo' },
        },
      ]);
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

    it('forces the manager network policy onto remote operations', async () => {
      mockDownloadFromArchiveUrl.mockImplementation(
        async (_metadata: ExtensionInstallMetadata, destination: string) => {
          writeExtractedExtension(destination, 'policy-extension');
        },
      );
      const manager = createExtensionManager({ networkPolicy: 'public' });

      await manager.installExtension(
        {
          source: 'https://example.com/policy-extension.zip',
          type: 'archive-url',
        },
        async () => {},
      );

      expect(mockDownloadFromArchiveUrl).toHaveBeenCalledWith(
        expect.objectContaining({ networkPolicy: 'public' }),
        expect.any(String),
        undefined,
      );
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
    it('returns a committed warning when preference cleanup fails', async () => {
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
      await manager.refreshCache();
      vi.spyOn(ExtensionPreferencesStore.prototype, 'clear').mockImplementation(
        () => {
          throw new Error('cleanup failed');
        },
      );

      const result = await manager.uninstallExtension('my-extension', false);

      expect(result.warnings).toEqual([
        {
          code: 'extension_preferences_cleanup_failed',
          error: 'cleanup failed',
        },
      ]);
    });

    it('returns a committed warning when uninstall runtime refresh fails', async () => {
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
      await manager.refreshCache();
      vi.spyOn(manager, 'refreshTools').mockRejectedValue(
        new Error('refresh failed'),
      );

      const result = await manager.uninstallExtension('my-extension', false);

      expect(result.warnings).toEqual([
        {
          code: 'extension_runtime_refresh_failed',
          error: 'refresh failed',
        },
      ]);
    });

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

    it('uninstalls a committed extension by id when it cannot be loaded', async () => {
      const identity = { id: 'a9'.repeat(32), name: 'broken-extension' };
      const extensionStore = new ExtensionStore({
        extensionsDir: userExtensionsDir,
      });
      await extensionStore.ensureInitialized([identity]);
      const destination = path.join(userExtensionsDir, identity.name);
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, 'qwen-extension.json'), '{');
      const manager = createExtensionManager({ extensionStore });

      const snapshot = await manager.uninstallExtensionById(identity.id, true);

      expect(snapshot.extensions[identity.id]).toBeUndefined();
      expect(fs.existsSync(destination)).toBe(false);
    });

    it('treats a declaration as absent when uninstalling by id', async () => {
      const identity = { id: 'aa'.repeat(32), name: 'declared-extension' };
      const extensionStore = new ExtensionStore({
        extensionsDir: userExtensionsDir,
      });
      const declared = await extensionStore.setDefaultActivations(
        [identity],
        'disabled',
      );
      const manager = createExtensionManager({ extensionStore });

      const snapshot = await manager.uninstallExtensionById(identity.id, true);

      expect(snapshot).toEqual(declared);
      expect(snapshot.extensions[identity.id]?.declarationOnly).toBe(true);
    });

    it('uninstalls by id using the loaded artifact directory', async () => {
      const original = createExtension({
        extensionsDir: userExtensionsDir,
        name: 'manifest-name',
      });
      const destination = path.join(userExtensionsDir, 'artifact-directory');
      fs.renameSync(original, destination);
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;

      const snapshot = await manager.uninstallExtensionById(extension.id, true);

      expect(snapshot.extensions[extension.id]).toBeUndefined();
      expect(fs.existsSync(destination)).toBe(false);
    });
  });

  describe('refreshCacheIfSourcesChanged', () => {
    // Extension sources have no watcher, so read-only consumers rely on this to
    // stay eventually consistent with mutations made outside the process
    // (`qwen extensions install` in a terminal) without scanning on every read.
    // See docs/design/workspace-skills-read-model.md.
    it('does not refresh while the sources are unchanged', async () => {
      createExtension({ extensionsDir: userExtensionsDir, name: 'ext-a' });
      const manager = createExtensionManager();
      await manager.refreshCache();
      expect(manager.getLoadedExtensions()).toHaveLength(1);

      const refreshSpy = vi.spyOn(manager, 'refreshCache');
      for (let i = 0; i < 20; i++) {
        expect(await manager.refreshCacheIfSourcesChanged()).toBe(false);
      }

      expect(refreshSpy).not.toHaveBeenCalled();
      expect(manager.getLoadedExtensions()).toHaveLength(1);
    });

    it('refreshes once a new extension appears on disk', async () => {
      createExtension({ extensionsDir: userExtensionsDir, name: 'ext-a' });
      const manager = createExtensionManager();
      await manager.refreshCache();
      expect(manager.getLoadedExtensions()).toHaveLength(1);

      createExtension({ extensionsDir: userExtensionsDir, name: 'ext-b' });

      expect(await manager.refreshCacheIfSourcesChanged()).toBe(true);
      expect(
        manager
          .getLoadedExtensions()
          .map((e) => e.name)
          .sort(),
      ).toEqual(['ext-a', 'ext-b']);
      // The refresh commits a new baseline, so the next call is a no-op again.
      expect(await manager.refreshCacheIfSourcesChanged()).toBe(false);
    });

    it('refreshes after an extension is removed', async () => {
      createExtension({ extensionsDir: userExtensionsDir, name: 'ext-a' });
      const manager = createExtensionManager();
      await manager.refreshCache();

      fs.rmSync(path.join(userExtensionsDir, 'ext-a'), {
        recursive: true,
        force: true,
      });

      expect(await manager.refreshCacheIfSourcesChanged()).toBe(true);
      expect(manager.getLoadedExtensions()).toHaveLength(0);
    });

    it('refreshes after an in-place manifest edit', async () => {
      createExtension({ extensionsDir: userExtensionsDir, name: 'ext-a' });
      const manager = createExtensionManager();
      await manager.refreshCache();
      expect(manager.getLoadedExtensions()[0]?.version).toBe('1.0.0');

      // Rewriting the manifest changes neither the extensions dir nor the
      // extension dir mtime on every platform, which is why the fingerprint
      // covers each manifest itself. The new version is a different length so
      // the size differs too — otherwise this would depend on the filesystem's
      // mtime granularity.
      fs.writeFileSync(
        path.join(userExtensionsDir, 'ext-a', EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify({ name: 'ext-a', version: '10.0.0', mcpServers: {} }),
      );

      expect(await manager.refreshCacheIfSourcesChanged()).toBe(true);
      expect(manager.getLoadedExtensions()[0]?.version).toBe('10.0.0');
    });

    it('shares one refresh between concurrent callers', async () => {
      createExtension({ extensionsDir: userExtensionsDir, name: 'ext-a' });
      const manager = createExtensionManager();
      await manager.refreshCache();

      createExtension({ extensionsDir: userExtensionsDir, name: 'ext-b' });
      const refreshSpy = vi.spyOn(manager, 'refreshCache');

      const results = await Promise.all([
        manager.refreshCacheIfSourcesChanged(),
        manager.refreshCacheIfSourcesChanged(),
        manager.refreshCacheIfSourcesChanged(),
      ]);

      expect(results).toEqual([true, true, true]);
      expect(refreshSpy).toHaveBeenCalledOnce();
    });

    it('does not mask a change that lands while a refresh is running', async () => {
      // The committed baseline is captured before the load, so a write that
      // races the refresh leaves the fingerprint stale and is still seen next
      // time. Stamping after the load would swallow it until something else
      // moved on disk.
      createExtension({ extensionsDir: userExtensionsDir, name: 'ext-a' });
      const manager = createExtensionManager();
      await manager.refreshCache();
      expect(manager.getLoadedExtensions()).toHaveLength(1);

      const realLoad = manager['loadExtensionsFromExtensionsDir'].bind(manager);
      let raced = false;
      vi.spyOn(
        manager as unknown as {
          loadExtensionsFromExtensionsDir: (
            ...args: unknown[]
          ) => Promise<unknown>;
        },
        'loadExtensionsFromExtensionsDir',
      ).mockImplementation(async (...args: unknown[]) => {
        const loaded = await (
          realLoad as (...a: unknown[]) => Promise<unknown>
        )(...args);
        if (!raced) {
          raced = true;
          // Lands after this refresh has already read the directory.
          createExtension({ extensionsDir: userExtensionsDir, name: 'ext-b' });
        }
        return loaded;
      });

      // Triggered by the enablement file moving, so the first refresh does not
      // observe ext-b.
      //
      // Its mtime is pushed a second into the past on purpose. Hand-writing
      // this file is how the test simulates "something outside the store
      // changed the legacy projection", and that is precisely the condition
      // `ExtensionStore` fails closed on when the two timestamps cannot be
      // ordered. Left at `now`, the write lands in the same tick as the
      // store's own often enough to trip that guard: measured, 3 failures in 6
      // runs here and on unrelated branches, blocking CI on PRs that never
      // touch extensions. An explicitly older projection is orderable, which
      // is what this test needs and all it needs — the guard itself is doing
      // its job and is left alone.
      const enablementFile = path.join(
        userExtensionsDir,
        'extension-enablement.json',
      );
      fs.writeFileSync(
        enablementFile,
        JSON.stringify({ touched: { overrides: [] } }),
      );
      const older = new Date(Date.now() - 1_000);
      fs.utimesSync(enablementFile, older, older);
      expect(await manager.refreshCacheIfSourcesChanged()).toBe(true);
      expect(manager.getLoadedExtensions()).toHaveLength(1);

      vi.restoreAllMocks();

      // The racing install is still visible to the next check.
      expect(await manager.refreshCacheIfSourcesChanged()).toBe(true);
      expect(
        manager
          .getLoadedExtensions()
          .map((e) => e.name)
          .sort(),
      ).toEqual(['ext-a', 'ext-b']);
    });
  });

  describe('loadExtension', () => {
    it('uses the injected extension store root for discovery', async () => {
      const customExtensionsDir = path.join(tempHomeDir, 'custom-extensions');
      createExtension({
        extensionsDir: customExtensionsDir,
        name: 'custom-root-extension',
      });
      const manager = createExtensionManager({
        extensionStore: new ExtensionStore({
          extensionsDir: customExtensionsDir,
        }),
      });

      await manager.refreshCache();

      expect(manager.getLoadedExtensions()).toHaveLength(1);
      expect(manager.getLoadedExtensions()[0]?.path).toBe(
        path.join(customExtensionsDir, 'custom-root-extension'),
      );
    });

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

    it('should skip extensions with invalid setting environment variable names', async () => {
      const extensionDir = path.join(userExtensionsDir, 'bad-setting');
      fs.mkdirSync(extensionDir);
      fs.writeFileSync(
        path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify({
          name: 'bad-setting',
          version: '1.0.0',
          settings: [
            {
              name: 'API key',
              description: 'API key',
              envVar: 'API_KEY\nforged',
            },
          ],
        }),
      );

      const manager = createExtensionManager();
      await manager.refreshCache();

      expect(manager.getLoadedExtensions()).toEqual([]);
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
    it('sets multiple default activations with one generation and refresh', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'first-default-extension',
        version: '1.0.0',
      });
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'second-default-extension',
        version: '1.0.0',
      });
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager
        .getLoadedExtensions()
        .filter((extension) => extension.name.endsWith('default-extension'));
      expect(extensions).toHaveLength(2);
      const initial = await manager.getExtensionStoreSnapshot();
      const refreshTools = vi
        .spyOn(manager, 'refreshTools')
        .mockResolvedValue();

      const snapshot = await manager.setExtensionDefaultActivations(
        extensions.map(({ name }) => name),
        'disabled',
      );

      expect(snapshot.generation).toBe(initial.generation + 1);
      expect(refreshTools).toHaveBeenCalledOnce();
      for (const extension of extensions) {
        expect(snapshot.extensions[extension.id]?.defaultActivation).toBe(
          'disabled',
        );
      }
      expect(extensions.every((extension) => !extension.isActive)).toBe(true);
    });

    it('clears multiple workspace activations with one generation and refresh', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'first-workspace-extension',
        version: '1.0.0',
      });
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'second-workspace-extension',
        version: '1.0.0',
      });
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager
        .getLoadedExtensions()
        .filter((extension) => extension.name.endsWith('workspace-extension'));
      expect(extensions).toHaveLength(2);
      await manager.setExtensionWorkspaceActivations(
        extensions.map(({ name }) => name),
        tempWorkspaceDir,
        'disabled',
      );
      expect(extensions.every((extension) => !extension.isActive)).toBe(true);
      const initial = await manager.getExtensionStoreSnapshot();
      const refreshTools = vi
        .spyOn(manager, 'refreshTools')
        .mockResolvedValue();

      const snapshot = await manager.setExtensionWorkspaceActivations(
        extensions.map(({ name }) => name),
        tempWorkspaceDir,
        'inherit',
      );

      expect(snapshot.generation).toBe(initial.generation + 1);
      expect(refreshTools).toHaveBeenCalledOnce();
      for (const extension of extensions) {
        expect(
          manager.getExtensionActivationFromSnapshot(
            extension.id,
            snapshot,
            tempWorkspaceDir,
          ),
        ).toMatchObject({ workspace: 'inherit', effective: 'enabled' });
        expect(snapshot.extensions[extension.id]?.workspaceOverrides).toEqual(
          {},
        );
      }
      expect(extensions.every((extension) => extension.isActive)).toBe(true);
    });

    it('treats inherit for an unknown extension as a no-op', async () => {
      const manager = createExtensionManager();
      await manager.refreshCache();
      const initial = await manager.getExtensionStoreSnapshot();
      const refreshTools = vi
        .spyOn(manager, 'refreshTools')
        .mockResolvedValue();
      const onCommitted = vi.fn();

      const snapshot = await manager.setExtensionWorkspaceActivations(
        ['future-extension'],
        tempWorkspaceDir,
        'inherit',
        onCommitted,
      );

      expect(snapshot.updated).toBe(false);
      expect(snapshot.generation).toBe(initial.generation);
      expect(snapshot.extensions).toEqual(initial.extensions);
      expect(onCommitted).not.toHaveBeenCalled();
      expect(refreshTools).not.toHaveBeenCalled();
      expect(
        manager.getExtensionActivationForNameFromSnapshot(
          'future-extension',
          snapshot,
          tempWorkspaceDir,
        ),
      ).toMatchObject({
        default: 'enabled',
        workspace: 'inherit',
        effective: 'enabled',
        source: 'default',
      });
    });

    it('updates loaded and declared extensions with one generation and refresh', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'available-extension',
        version: '1.0.0',
      });
      const manager = createExtensionManager();
      await manager.refreshCache();
      const loaded = manager
        .getLoadedExtensions()
        .find((extension) => extension.name === 'available-extension')!;
      const declaredName = 'future-extension';
      const declaredId = hashValue(declaredName);
      const initial = await manager.getExtensionStoreSnapshot();
      const refreshTools = vi
        .spyOn(manager, 'refreshTools')
        .mockResolvedValue();
      const onCommitted = vi.fn();

      const snapshot = await manager.setExtensionDefaultActivations(
        [loaded.name, declaredName],
        'disabled',
        onCommitted,
      );

      expect(snapshot.generation).toBe(initial.generation + 1);
      expect(snapshot.extensions[declaredId]).toMatchObject({
        name: declaredName,
        declarationOnly: true,
        defaultActivation: 'disabled',
      });
      expect(snapshot.extensions[loaded.id]?.defaultActivation).toBe(
        'disabled',
      );
      expect(loaded.isActive).toBe(false);
      expect(onCommitted).toHaveBeenCalledOnce();
      expect(onCommitted).toHaveBeenCalledWith(snapshot.generation);
      expect(refreshTools).toHaveBeenCalledOnce();
      await expect(
        manager.setExtensionDefaultActivation(declaredId, 'enabled'),
      ).rejects.toThrow(`Extension with id ${declaredId} does not exist.`);
    });

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

    it('returns a committed warning when activation runtime refresh fails', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;
      vi.spyOn(manager, 'refreshTools').mockRejectedValue(
        new Error('refresh failed'),
      );

      const result = await manager.setExtensionDefaultActivation(
        extension.id,
        'disabled',
      );

      expect(result.warnings).toEqual([
        {
          code: 'extension_runtime_refresh_failed',
          error: 'refresh failed',
        },
      ]);
      expect(result.extensions[extension.id]?.defaultActivation).toBe(
        'disabled',
      );
    });

    it('derives activation from the supplied store snapshot', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;

      const disabledSnapshot = await manager.setExtensionDefaultActivation(
        extension.id,
        'disabled',
      );
      await manager.setExtensionDefaultActivation(extension.id, 'enabled');

      expect(
        manager.getExtensionActivationFromSnapshot(
          extension.id,
          disabledSnapshot,
          tempWorkspaceDir,
        ),
      ).toMatchObject({ effective: 'disabled', source: 'default' });
      await expect(
        manager.getExtensionActivation(extension.id, tempWorkspaceDir),
      ).resolves.toMatchObject({ effective: 'enabled', source: 'default' });
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

      const workspaceSnapshot = await manager.setExtensionActivationScope(
        extension.id,
        {
          scope: 'workspace',
          workspacePath: tempWorkspaceDir,
        },
      );
      const snapshot = await manager.setExtensionActivationScope(extension.id, {
        scope: 'user',
      });

      expect(snapshot.generation).toBe(workspaceSnapshot.generation + 1);
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
    it('fails before Git access when managed credentials are unavailable', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        installMetadata: {
          type: 'git',
          source: 'https://git.example.com/team/extension.git',
          gitCommit: 'sample-commit',
          credentialPersistence: 'stored',
          installId: 'a'.repeat(64),
        },
      });
      const manager = createExtensionManager({ networkPolicy: 'public' });
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;

      await expect(
        manager.updateExtension(
          extension,
          ExtensionUpdateState.UPDATE_AVAILABLE,
          () => {},
        ),
      ).rejects.toMatchObject({ code: 'extension_credential_unavailable' });
      expect(mockGit.clone).not.toHaveBeenCalled();
      expect(mockGit.listRemote).not.toHaveBeenCalled();
    });

    it('updates an old-Git public GitHub extension through a new archive SHA', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        version: '1.0.0',
        installMetadata: {
          type: 'git',
          source: 'https://github.com/owner/repo',
          gitCommit: '0123456789abcdef0123456789abcdef01234567',
        },
      });
      mockGit.version.mockResolvedValue({ major: 2, minor: 34, patch: 1 });
      mockDownloadPublicGitHubArchiveFallback.mockImplementation(
        async (_metadata: ExtensionInstallMetadata, destination: string) => {
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(
            path.join(destination, EXTENSIONS_CONFIG_FILENAME),
            JSON.stringify({ name: 'my-extension', version: '2.0.0' }),
          );
          return '89abcdef0123456789abcdef0123456789abcdef';
        },
      );
      const manager = createExtensionManager({ networkPolicy: 'public' });
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;

      await manager.updateExtension(
        extension,
        ExtensionUpdateState.UPDATE_AVAILABLE,
        () => {},
      );

      expect(manager.getLoadedExtensions()[0]?.installMetadata).toMatchObject({
        source: 'https://github.com/owner/repo',
        type: 'git',
        gitCommit: '89abcdef0123456789abcdef0123456789abcdef',
      });
      // The manager mutates installMetadata in place (gitCommit gets the new
      // SHA after the call), so pin only the immutable identity fields.
      expect(mockDownloadPublicGitHubArchiveFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'git',
          source: 'https://github.com/owner/repo',
        }),
        expect.any(String),
        undefined,
      );
      expect(mockGit.clone).not.toHaveBeenCalled();
    });

    it('applies the update network policy without mutating cached metadata', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        installMetadata: {
          type: 'git',
          source: 'https://github.com/owner/repo.git',
        },
      });
      mockGit.version.mockResolvedValue({ major: 2, minor: 52 });
      mockGit.env.mockReturnValue(mockGit);
      mockGit.getRemotes.mockResolvedValue([
        {
          name: 'origin',
          refs: { fetch: 'https://github.com/owner/repo.git' },
        },
      ]);
      mockGit.listRemote.mockResolvedValue('same-hash\tHEAD');
      mockGit.revparse.mockResolvedValue('same-hash');
      const manager = createExtensionManager({ networkPolicy: 'public' });
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;
      expect(extension.installMetadata?.networkPolicy).toBeUndefined();

      await manager.checkForAllExtensionUpdates(() => {});

      expect(extension.installMetadata?.networkPolicy).toBeUndefined();
      expect(mockGit.version).toHaveBeenCalled();
      expect(mockGit.env).toHaveBeenCalled();
      expect(mockGit.listRemote).toHaveBeenCalledWith([
        'https://github.com/owner/repo.git',
        'HEAD',
      ]);
    });

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
      const updatedExtension = {
        ...extension,
        version: '2.0.0',
        config: { ...extension.config, version: '2.0.0' },
      };
      vi.spyOn(manager, 'loadExtension')
        .mockResolvedValueOnce(updatedExtension)
        .mockResolvedValueOnce(null);

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

    it('rejects an invalid staged extension before commit', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'install-reload.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(
            path.join(destination, EXTENSIONS_CONFIG_FILENAME),
            JSON.stringify({ name: 'my-extension', version: '1.0.0' }),
          );
        },
      );
      const manager = createExtensionManager();
      const prepared = await manager.prepareExtensionInstall({
        installMetadata: { type: 'local', source: archivePath },
        initialActivation: { scope: 'user' },
        requestConsent: async () => {},
      });
      fs.writeFileSync(
        path.join(prepared.stagingDirectory, EXTENSIONS_CONFIG_FILENAME),
        '{ invalid json',
      );
      const before = await manager.getExtensionStoreSnapshot();

      try {
        await expect(manager.commitPreparedExtension(prepared)).rejects.toThrow(
          'Failed to load extension config',
        );
      } finally {
        await manager.disposePreparedExtension(prepared);
      }

      expect(await manager.getExtensionStoreSnapshot()).toEqual(before);
      expect(fs.existsSync(prepared.destinationDirectory)).toBe(false);
    });

    it('rejects staged identity changes before commit', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'identity-change.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(
            path.join(destination, EXTENSIONS_CONFIG_FILENAME),
            JSON.stringify({ name: 'original-name', version: '1.0.0' }),
          );
        },
      );
      const manager = createExtensionManager();
      const prepared = await manager.prepareExtensionInstall({
        installMetadata: { type: 'local', source: archivePath },
        initialActivation: { scope: 'user' },
        requestConsent: async () => {},
      });
      fs.writeFileSync(
        path.join(prepared.stagingDirectory, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify({ name: 'changed-name', version: '1.0.0' }),
      );
      const before = await manager.getExtensionStoreSnapshot();

      try {
        await expect(manager.commitPreparedExtension(prepared)).rejects.toThrow(
          'Prepared extension identity changed before commit.',
        );
      } finally {
        await manager.disposePreparedExtension(prepared);
      }

      expect(await manager.getExtensionStoreSnapshot()).toEqual(before);
      expect(fs.existsSync(prepared.destinationDirectory)).toBe(false);
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
      const updatedExtension = {
        ...extension,
        version: '2.0.0',
        config: { ...extension.config, version: '2.0.0' },
      };
      vi.spyOn(manager, 'loadExtension')
        .mockResolvedValueOnce(updatedExtension)
        .mockResolvedValueOnce(updatedExtension)
        .mockResolvedValueOnce(null);
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
        warnings: [
          {
            code: 'extension_reload_failed',
            error: 'Extension not found after commit.',
          },
        ],
      });

      expect(callback).toHaveBeenLastCalledWith(
        'my-extension',
        ExtensionUpdateState.UPDATED_NEEDS_RESTART,
      );
      expect(manager.getLoadedExtensions()).toEqual([]);
    });

    it('reports a committed update runtime warning as needing restart', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'refresh-update.zip');
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
      vi.spyOn(manager, 'refreshTools').mockRejectedValueOnce(
        new Error('runtime stale'),
      );
      const callback = vi.fn();

      await manager.updateExtension(
        extension,
        ExtensionUpdateState.UPDATE_AVAILABLE,
        callback,
      );

      expect(callback).toHaveBeenLastCalledWith(
        'my-extension',
        ExtensionUpdateState.UPDATED_NEEDS_RESTART,
      );
    });

    it('surfaces a committed settings compatibility warning distinctly', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'settings-update.zip');
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
      const internals = manager as unknown as {
        prepareExtensionUpdateFromState(
          extension: Extension,
        ): Promise<PreparedExtensionMutation>;
      };
      const prepared =
        await internals.prepareExtensionUpdateFromState(extension);
      Object.defineProperty(prepared, 'commitSettings', {
        value: vi.fn().mockRejectedValue(new Error('legacy sync unavailable')),
      });
      vi.spyOn(
        internals,
        'prepareExtensionUpdateFromState',
      ).mockResolvedValueOnce(prepared);
      const callback = vi.fn();

      await expect(
        manager.updateExtension(
          extension,
          ExtensionUpdateState.UPDATE_AVAILABLE,
          callback,
        ),
      ).resolves.toMatchObject({
        warnings: [
          {
            code: 'extension_settings_legacy_sync_failed',
            error: 'legacy sync unavailable',
          },
        ],
      });
      expect(callback).toHaveBeenLastCalledWith(
        'my-extension',
        ExtensionUpdateState.UPDATED_WITH_WARNINGS,
      );
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

  describe('performWorkspaceExtensionMigration', () => {
    const extension = {
      path: '/tmp/migration-source',
      config: { name: 'migration-extension' },
    } as Extension;

    it('reports a committed extension that could not be reloaded', async () => {
      const manager = createExtensionManager();
      vi.spyOn(manager, 'installExtension').mockRejectedValueOnce(
        Object.assign(new Error('committed with warnings'), {
          code: 'extension_committed_with_warnings',
          committed: true,
          identity: { id: 'migration-id', name: 'migration-extension' },
          warnings: [
            { code: 'extension_reload_failed', error: 'invalid manifest' },
          ],
        }),
      );

      await expect(
        manager.performWorkspaceExtensionMigration([extension], async () => {}),
      ).resolves.toEqual(['migration-extension']);
    });

    it('does not retry a committed extension for recoverable warnings', async () => {
      const manager = createExtensionManager();
      vi.spyOn(manager, 'installExtension').mockRejectedValueOnce(
        Object.assign(new Error('committed with warnings'), {
          code: 'extension_committed_with_warnings',
          committed: true,
          identity: { id: 'migration-id', name: 'migration-extension' },
          warnings: [
            {
              code: 'extension_runtime_refresh_failed',
              error: 'refresh delayed',
            },
          ],
        }),
      );

      await expect(
        manager.performWorkspaceExtensionMigration([extension], async () => {}),
      ).resolves.toEqual([]);
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
      await expect(
        manager.getExtensionActivation(extensions[0]!.id),
      ).resolves.toMatchObject({
        effective: 'disabled',
        source: 'cli_override',
      });
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
      it('uses a persisted install id instead of the source', () => {
        const installId = 'a'.repeat(64);
        expect(
          getExtensionId(
            { name: 'test-ext', version: '1.0.0' },
            {
              type: 'git',
              source: 'https://example.com/repo',
              installId,
              credentialPersistence: 'stored',
            },
          ),
        ).toBe(installId);
      });

      it('ignores install ids on unmanaged metadata', () => {
        const config = { name: 'test-ext', version: '1.0.0' };
        const source = 'https://example.com/repo';
        expect(
          getExtensionId(config, {
            type: 'git',
            source,
            installId: 'a'.repeat(64),
          }),
        ).toBe(getExtensionId(config, { type: 'git', source }));
      });

      it('rejects an invalid persisted install id', () => {
        expect(() =>
          getExtensionId(
            { name: 'test-ext', version: '1.0.0' },
            {
              type: 'snapshot',
              source: 'snapshot',
              installId: '../invalid',
            },
          ),
        ).toThrow('Stored extension install id is invalid');
      });

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

      it('gives same-named uploads distinct ids', () => {
        const config: ExtensionConfig = { name: 'test-ext', version: '1.0.0' };
        const first = getExtensionId(config, {
          type: 'local',
          source: 'upload:v1:first:extension.zip',
        });
        const second = getExtensionId(config, {
          type: 'local',
          source: 'upload:v1:second:extension.zip',
        });

        expect(first).not.toBe(second);
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

      it('gives plugins from the same repository distinct ids (#7568)', () => {
        const metadataFor = (pluginName: string) => ({
          type: 'git' as const,
          source: 'https://github.com/dotnet/skills',
          pluginName,
        });
        const dotnetId = getExtensionId(
          { name: 'dotnet', version: '1.0.0' },
          metadataFor('dotnet'),
        );
        const dotnetTestId = getExtensionId(
          { name: 'dotnet-test', version: '1.0.0' },
          metadataFor('dotnet-test'),
        );

        expect(dotnetId).toBe(
          hashValue('https://github.com/dotnet/skills:dotnet'),
        );
        expect(dotnetTestId).toBe(
          hashValue('https://github.com/dotnet/skills:dotnet-test'),
        );
        expect(dotnetId).not.toBe(dotnetTestId);
      });

      it('keeps the repo-only id when no plugin name is recorded', () => {
        const config: ExtensionConfig = { name: 'solo-ext', version: '1.0.0' };
        const metadata = {
          type: 'git' as const,
          source: 'https://github.com/owner/solo',
        };
        expect(getExtensionId(config, metadata)).toBe(
          hashValue('https://github.com/owner/solo'),
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
