/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  INSTALL_METADATA_FILENAME,
  EXTENSIONS_CONFIG_FILENAME,
} from './variables.js';
import { ExtensionStorage } from './storage.js';
import { QWEN_DIR } from '../config/storage.js';
import {
  EXTENSION_SCAN_CONCURRENCY,
  SKILL_LOAD_CONCURRENCY,
  peakDescriptorGateInFlight,
} from '../skills/skill-load.js';
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
  type PrepareExtensionInstallOptions,
} from './extensionManager.js';
import type {
  Config,
  MCPServerConfig,
  ExtensionInstallMetadata,
} from '../index.js';
import { ExtensionStore } from './extension-store.js';
import { SubagentError } from '../subagents/types.js';
import { SubagentManager } from '../subagents/subagent-manager.js';
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
import { SkillManager } from '../skills/skill-manager.js';
import { getGlobalDispatcher } from 'undici';

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

// Wraps the real check: scenarios keep validation, only wiring is asserted.
// restoreAllMocks() blanks a bare vi.fn(); beforeEach re-attaches the real one.
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

// Resource-exhaustion probe for the fs entrances the loaders swallow,
// mirroring the emfileProbe pattern in agent-plugins-v1/skills.test.ts. The
// loaders import BOTH 'node:fs' (extensionManager, workflow-extension) and
// 'fs/promises' (skill-load, subagent-manager), and vitest keeps those as
// separate module records, so both specifiers are wrapped with the same
// toggles. (vi.spyOn cannot stand in for the sync fns: the top-level
// node:fs namespace is non-configurable.)
const fsProbe = vi.hoisted(() => ({
  failReadFileFor: undefined as string | undefined,
  failReadFileSkip: 0,
  delayReadFileFor: undefined as string | undefined,
  failReadFileSyncFor: undefined as string | undefined,
  failReadFileSyncSkip: 0,
  failReaddirSyncFor: undefined as string | undefined,
  failReaddirFor: undefined as string | undefined,
  failAccessSyncFor: undefined as string | undefined,
  falseExistsSyncFor: undefined as string | undefined,
  untypedDirentsFor: undefined as string | undefined,
  readdirSyncCalls: 0,
  // Every directory argument handed to fs.promises.readdir; the Windows
  // separator-parity witness asserts the root commands walk argument is
  // path.join-normalized (R17-2).
  readdirArgs: [] as string[],
}));
const emfileError = (): Error =>
  Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (
        fsProbe.failReadFileSyncFor !== undefined &&
        String(args[0]).endsWith(fsProbe.failReadFileSyncFor)
      ) {
        // Armed reads may be let through first (the manifest path reads
        // plugin.json more than once per load) so a test can fault a
        // specific read in the sequence.
        if (fsProbe.failReadFileSyncSkip > 0) {
          fsProbe.failReadFileSyncSkip -= 1;
        } else {
          throw emfileError();
        }
      }
      return actual.readFileSync(...args);
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      if (
        fsProbe.failReaddirSyncFor !== undefined &&
        String(args[0]) === fsProbe.failReaddirSyncFor
      ) {
        fsProbe.readdirSyncCalls += 1;
        // The first armed call belongs to the refresh's own fingerprint
        // walk; only the loader's enumeration (every later call) fails.
        if (fsProbe.readdirSyncCalls > 1) throw emfileError();
      }
      return actual.readdirSync(...args);
    },
    existsSync: (...args: Parameters<typeof actual.existsSync>) => {
      if (
        fsProbe.falseExistsSyncFor !== undefined &&
        String(args[0]).includes(fsProbe.falseExistsSyncFor)
      ) {
        // What fs.existsSync itself returns when its stat hits
        // EMFILE/ENOMEM — its catch-all folds every errno into `false`.
        return false;
      }
      return actual.existsSync(...args);
    },
    accessSync: (...args: Parameters<typeof actual.accessSync>) => {
      if (
        fsProbe.failAccessSyncFor !== undefined &&
        String(args[0]).includes(fsProbe.failAccessSyncFor)
      ) {
        throw emfileError();
      }
      return actual.accessSync(...args);
    },
    promises: {
      ...actual.promises,
      readFile: async (
        ...args: Parameters<typeof actual.promises.readFile>
      ) => {
        if (
          fsProbe.delayReadFileFor !== undefined &&
          String(args[0]).includes(fsProbe.delayReadFileFor)
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (
          fsProbe.failReadFileFor !== undefined &&
          String(args[0]).includes(fsProbe.failReadFileFor)
        ) {
          // Armed reads may be let through first (the store's recovery reads
          // state.json before the scan runs) so a test can fault a specific
          // read in the sequence.
          if (fsProbe.failReadFileSkip > 0) {
            fsProbe.failReadFileSkip -= 1;
          } else {
            throw emfileError();
          }
        }
        return actual.promises.readFile(...args);
      },
      readdir: async (...args: Parameters<typeof actual.promises.readdir>) => {
        fsProbe.readdirArgs.push(String(args[0]));
        if (
          fsProbe.failReaddirFor !== undefined &&
          String(args[0]).includes(fsProbe.failReaddirFor)
        ) {
          throw emfileError();
        }
        const entries = await actual.promises.readdir(...args);
        if (
          fsProbe.untypedDirentsFor !== undefined &&
          String(args[0]).includes(fsProbe.untypedDirentsFor)
        ) {
          // DT_UNKNOWN, as on a filesystem whose readdir reports no d_type:
          // every type predicate reports false and the walk must lstat.
          return entries.map((entry) => ({
            name: entry.name,
            parentPath: entry.parentPath,
            isDirectory: () => false,
            isFile: () => false,
            isSymbolicLink: () => false,
            isBlockDevice: () => false,
            isCharacterDevice: () => false,
            isFIFO: () => false,
            isSocket: () => false,
          }));
        }
        return entries;
      },
    },
  };
});
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (
        fsProbe.delayReadFileFor !== undefined &&
        String(args[0]).includes(fsProbe.delayReadFileFor)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (
        fsProbe.failReadFileFor !== undefined &&
        String(args[0]).includes(fsProbe.failReadFileFor)
      ) {
        if (fsProbe.failReadFileSkip > 0) {
          fsProbe.failReadFileSkip -= 1;
        } else {
          throw emfileError();
        }
      }
      return actual.readFile(...args);
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (
        fsProbe.failReaddirFor !== undefined &&
        String(args[0]).includes(fsProbe.failReaddirFor)
      ) {
        throw emfileError();
      }
      return actual.readdir(...args);
    },
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

type Writer = (destination: string) => unknown;
type Consent = (options?: unknown) => Promise<void>;
type LoaderInternals = {
  loadExtensionsFromExtensionsDir: (...args: unknown[]) => Promise<unknown>;
};

/** Writes each file (strings as-is, anything else as JSON) under `root`. */
function writeTree(root: string, files: Record<string, unknown> = {}): string {
  fs.mkdirSync(root, { recursive: true });
  for (const [relative, body] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      typeof body === 'string' ? body : JSON.stringify(body),
    );
  }
  return root;
}

const writeManifest = (dir: string, config: object) =>
  writeTree(dir, { [EXTENSIONS_CONFIG_FILENAME]: config });
/** A writer of a bare `name` manifest at `version`. */
const extracted =
  (name: string, version = '1.0.0'): Writer =>
  (destination) =>
    writeManifest(destination, { name, version });
const readText = (...segments: string[]) =>
  fs.readFileSync(path.join(...segments), 'utf8');

/** A download/extract mock body that writes into its destination. */
const writesTo =
  (write: Writer, result?: unknown) =>
  async (_source: unknown, destination: string) => {
    write(destination);
    return result;
  };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const exists = (...segments: string[]) => fs.existsSync(path.join(...segments));
const storeAt = (extensionsDir: string) =>
  new ExtensionStore({ extensionsDir });
const rejectingWith = (message: string) =>
  vi.fn().mockRejectedValue(new Error(message));
const refreshFailed = (error: string) => ({
  code: 'extension_runtime_refresh_failed',
  error,
});
/** The start/end event pair of each mutation, numbered in order. */
const lifecycle = (...operations: string[]) =>
  operations.flatMap((operation, index) => [
    { id: index + 1, phase: 'start', operation },
    { id: index + 1, phase: 'end', operation },
  ]);

const OLD_GIT = { major: 2, minor: 34, patch: 1 };
const FALLBACK_SHA = '0123456789abcdef0123456789abcdef01234567';

function oldGitFallback(write: Writer, sha = FALLBACK_SHA) {
  mockGit.version.mockResolvedValue(OLD_GIT);
  mockDownloadPublicGitHubArchiveFallback.mockImplementation(
    writesTo(write, sha),
  );
}

const remote = (url: string) =>
  mockGit.getRemotes.mockResolvedValue([
    { name: 'origin', refs: { fetch: url } },
  ]);

/** A clone of `url` that writes its tree with `write`. */
function gitRepo(url: string, write: Writer) {
  mockGit.clone.mockImplementation(async () => {
    write(mockGit.path());
  });
  remote(url);
  mockGit.fetch.mockResolvedValue(undefined);
  mockGit.checkout.mockResolvedValue(undefined);
}

function createExtension({
  extensionsDir = 'extensions-dir',
  name = 'my-extension',
  version = '1.0.0',
  addContextFile = false,
  contextFileName = undefined as string | undefined,
  mcpServers = {} as Record<string, MCPServerConfig>,
  installMetadata = undefined as ExtensionInstallMetadata | undefined,
} = {}): string {
  const extDir = writeManifest(path.join(extensionsDir, name), {
    name,
    version,
    contextFileName,
    mcpServers,
  });
  if (addContextFile) {
    fs.writeFileSync(path.join(extDir, 'QWEN.md'), 'context');
  }
  if (contextFileName) {
    fs.writeFileSync(path.join(extDir, contextFileName), 'context');
  }
  if (installMetadata) {
    writeTree(extDir, { [INSTALL_METADATA_FILENAME]: installMetadata });
  }
  return extDir;
}

function createAgentPlugin(
  pluginRoot: string,
  {
    name = 'portable-plugin',
    version,
  }: { name?: string; version?: string } = {},
): string {
  return writeTree(pluginRoot, {
    'plugin.json': {
      $schema: AGENT_PLUGIN_SCHEMA,
      name,
      ...(version === undefined ? {} : { version }),
    },
    'skills/direct/SKILL.md':
      '---\nname: direct\ndescription: Direct skill\nallowed-tools: Read\n---\nPortable instructions.',
    'bin/server': 'portable server',
    'mcp.json': {
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: {
        local: {
          type: 'stdio',
          command: './bin/server',
          args: ['${PLUGIN_ROOT}', '${PLUGIN_DATA}'],
        },
        remote: { type: 'streamable-http', url: 'https://example.com/mcp' },
        legacy: { type: 'sse', url: 'https://example.com/sse' },
      },
    },
  });
}

describe('extension tests', () => {
  let tempHomeDir: string;
  let tempWorkspaceDir: string;
  let userExtensionsDir: string;

  beforeEach(() => {
    vi.stubEnv('QWEN_HOME', undefined);
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
    mockDownloadFromGitHubRelease
      .mockReset()
      .mockRejectedValue(new Error('Mocked GitHub release download failure'));
    mockExtractArchiveFile.mockReset();
    mockDownloadFromNpmRegistry.mockReset();
    mockGit.revparse.mockResolvedValue('sample-commit');
    // Re-attach the real passthrough (see the archive-safety mock).
    mockAssertDirectorySymlinksAreSafe
      .mockReset()
      .mockImplementation(realAssertDirectorySymlinksAreSafe.current!);
  });

  afterEach(() => {
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function createExtensionManager(
    options: Partial<ExtensionManagerOptions> = {},
  ): ExtensionManager {
    return new ExtensionManager({
      workspaceDir: tempWorkspaceDir,
      isWorkspaceTrusted: true,
      extensionStore: new ExtensionStore({ extensionsDir: userExtensionsDir }),
      ...options,
    });
  }

  const addExt = (options: Parameters<typeof createExtension>[0] = {}) =>
    createExtension({ extensionsDir: userExtensionsDir, ...options });
  const addPlugin = (name: string, version?: string) =>
    createAgentPlugin(path.join(userExtensionsDir, name), { name, version });

  /** A manager with a mutation-event recorder, after its first refresh. */
  async function ready(options: Partial<ExtensionManagerOptions> = {}) {
    const manager = createExtensionManager(options);
    const events: ExtensionMutationEvent[] = [];
    manager.addMutationListener((event) => events.push(event));
    await manager.refreshCache();
    const extensions = manager.getLoadedExtensions();
    return { manager, events, extensions, extension: extensions[0]! };
  }

  const localSource = (source: ExtensionInstallMetadata | string) =>
    typeof source === 'string' ? { type: 'local' as const, source } : source;

  /** `ready()` then one install with a consent spy (a string is a local source). */
  async function readyInstall(
    source: ExtensionInstallMetadata | string,
    options: Partial<ExtensionManagerOptions> = {},
    signal?: AbortSignal,
  ) {
    const requestConsent = vi.fn(async () => {});
    const loaded = await ready(options);
    const extension = await loaded.manager.installExtension(
      localSource(source),
      requestConsent,
      undefined,
      undefined,
      undefined,
      undefined,
      signal,
    );
    return { ...loaded, requestConsent, extension };
  }

  const install = (
    manager: ExtensionManager,
    source: ExtensionInstallMetadata | string,
    consent: Consent = async () => {},
  ) => manager.installExtension(localSource(source), consent);
  /** An install over `previous` (an update), optionally from `cwd`. */
  const reinstall = (
    manager: ExtensionManager,
    source: ExtensionInstallMetadata | string,
    previous: ExtensionConfig,
    cwd?: string,
  ) =>
    manager.installExtension(
      localSource(source),
      async () => {},
      undefined,
      cwd,
      previous,
    );

  const prepare = (
    manager: ExtensionManager,
    source: ExtensionInstallMetadata | string,
    extra: Partial<PrepareExtensionInstallOptions> = {},
  ) =>
    manager.prepareExtensionInstall({
      installMetadata: localSource(source),
      initialActivation: { scope: 'user' },
      requestConsent: async () => {},
      ...extra,
    });

  const update = (
    manager: ExtensionManager,
    extension: Extension,
    callback: Parameters<ExtensionManager['updateExtension']>[2] = () => {},
  ) =>
    manager.updateExtension(
      extension,
      ExtensionUpdateState.UPDATE_AVAILABLE,
      callback,
    );

  /** Writes an archive file whose mocked extraction runs `write` (a name writes a 1.0.0 manifest). */
  function archive(file: string, write?: string | Writer): string {
    const archivePath = path.join(tempWorkspaceDir, file);
    fs.writeFileSync(archivePath, 'archive');
    if (write !== undefined) {
      mockExtractArchiveFile.mockImplementation(
        writesTo(typeof write === 'string' ? extracted(write) : write),
      );
    }
    return archivePath;
  }

  const loadedNames = (manager: ExtensionManager) =>
    manager.getLoadedExtensions().map((extension) => extension.name);
  const expectConsent = (consent: ReturnType<typeof vi.fn>, fields: object) =>
    expect(consent).toHaveBeenCalledWith(expect.objectContaining(fields));
  const expectArchiveFallbackFor = (source: string) =>
    expect(mockDownloadPublicGitHubArchiveFallback).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'git', source }),
      expect.any(String),
      undefined,
    );
  const stubRefreshTools = (manager: ExtensionManager) =>
    vi.spyOn(manager, 'refreshTools').mockResolvedValue();
  const failRefreshTools = (manager: ExtensionManager, message: string) =>
    vi.spyOn(manager, 'refreshTools').mockRejectedValue(new Error(message));
  const failRefreshToolsOnce = (manager: ExtensionManager, message: string) =>
    vi.spyOn(manager, 'refreshTools').mockRejectedValueOnce(new Error(message));
  const stubCommitSettings = <T>(prepared: object, commitSettings: T) => {
    Object.defineProperty(prepared, 'commitSettings', {
      value: commitSettings,
    });
    return commitSettings;
  };

  function trackTmpDirs(): string[] {
    const tempDirs: string[] = [];
    vi.spyOn(ExtensionStorage, 'createTmpDir').mockImplementation(async () => {
      const tempDir = fs.mkdtempSync(
        path.join(tempHomeDir, 'tracked-extension-'),
      );
      tempDirs.push(tempDir);
      return tempDir;
    });
    return tempDirs;
  }

  describe('extension workflows', () => {
    const workflowSource = (name: string) =>
      `export const meta = { name: '${name}', description: 'Runs ${name}' };\nreturn 1;\n`;
    const workflowNames = (extension: Extension) =>
      extension.workflows?.map((workflow) => workflow.name);
    /** A `wf-ext` source tree under the workspace. */
    const workflowTree = (
      dir: string,
      files: Record<string, unknown>,
      config: object = {},
    ) =>
      writeTree(path.join(tempWorkspaceDir, dir), {
        [EXTENSIONS_CONFIG_FILENAME]: {
          name: 'wf-ext',
          version: '1.0.0',
          ...config,
        },
        ...files,
      });
    /** A source whose workflows/audit.js is a symlink into shared/. */
    function linkedWorkflowTree(dir: string): string {
      const sourcePath = workflowTree(dir, {
        'shared/audit.js': workflowSource('audit'),
      });
      fs.mkdirSync(path.join(sourcePath, 'workflows'));
      fs.symlinkSync(
        path.join(sourcePath, 'shared', 'audit.js'),
        path.join(sourcePath, 'workflows', 'audit.js'),
      );
      return sourcePath;
    }

    it('loads workflows from the default directory as <extension>:<meta.name>', async () => {
      const directory = writeTree(addExt({ name: 'suite' }), {
        'workflows/audit.js': workflowSource('audit'),
      });
      const { extension } = await ready();

      expect(workflowNames(extension)).toEqual(['suite:audit']);
      expect(extension.workflows?.[0]?.scriptPath).toBe(
        fs.realpathSync(path.join(directory, 'workflows', 'audit.js')),
      );
    });

    it('reads only the paths the manifest declares in workflows', async () => {
      writeTree(addExt({ name: 'suite' }), {
        [EXTENSIONS_CONFIG_FILENAME]: {
          name: 'suite',
          version: '1.0.0',
          workflows: '${extensionPath}${/}flows',
        },
        'workflows/default.js': workflowSource('default'),
        'flows/custom.js': workflowSource('custom'),
      });
      const { extension } = await ready();

      expect(workflowNames(extension)).toEqual(['suite:custom']);
    });

    it('offers the workflows it ships for consent on install', async () => {
      const sourcePath = workflowTree('workflow-source', {
        'workflows/audit.js': workflowSource('audit'),
      });
      const { requestConsent, extension } = await readyInstall(sourcePath);

      expectConsent(requestConsent, {
        workflows: [
          expect.objectContaining({
            name: 'wf-ext:audit',
            description: 'Runs audit',
            scriptPath: path.join(sourcePath, 'workflows', 'audit.js'),
          }),
        ],
        previousWorkflows: [],
      });
      expect(workflowNames(extension)).toEqual(['wf-ext:audit']);
      // The installed copy, not the source, is what loads.
      expect(extension.workflows?.[0]?.scriptPath).toBe(
        fs.realpathSync(path.join(extension.path, 'workflows', 'audit.js')),
      );
    });

    it.skipIf(process.platform === 'win32')(
      'discloses a symlinked workflow that the install copies as a regular file',
      async () => {
        const { requestConsent, extension } = await readyInstall(
          linkedWorkflowTree('linked-source'),
        );

        expectConsent(requestConsent, {
          workflows: [expect.objectContaining({ name: 'wf-ext:audit' })],
        });
        expect(
          fs
            .lstatSync(path.join(extension.path, 'workflows', 'audit.js'))
            .isSymbolicLink(),
        ).toBe(false);
        expect(workflowNames(extension)).toEqual(['wf-ext:audit']);
      },
    );

    it.skipIf(process.platform === 'win32')(
      'keeps runtime symlink rules for a linked extension, in consent and at load',
      async () => {
        const { requestConsent, extension } = await readyInstall({
          type: 'link',
          source: linkedWorkflowTree('linked-workflow-source'),
        });

        // A linked extension loads its source as-is, where links are refused,
        // so consent must not list what will never load.
        expectConsent(requestConsent, { workflows: [] });
        expect(extension.workflows).toEqual([]);
      },
    );

    it.each([
      'flows',
      '${extensionPath}${/}flows',
      '$QWEN_TEST_WORKFLOW_DIR',
      '${QWEN_TEST_WORKFLOW_DIR}',
    ])('discloses and loads the same workflows for %s', async (workflows) => {
      vi.stubEnv('QWEN_TEST_WORKFLOW_DIR', 'flows');
      const { requestConsent, extension } = await readyInstall(
        workflowTree(
          'workflow-source',
          { 'flows/a.js': workflowSource('audit') },
          { workflows },
        ),
      );

      expectConsent(requestConsent, {
        workflows: [expect.objectContaining({ name: 'wf-ext:audit' })],
        previousWorkflows: [],
      });
      expect(workflowNames(extension)).toEqual(['wf-ext:audit']);
    });
  });

  it('retains extension skill discovery errors until the next successful load', async () => {
    const skillDirectory = writeTree(
      path.join(addExt({ name: 'broken-skill' }), 'skills', 'review'),
      { 'SKILL.md': 'invalid frontmatter' },
    );
    const manifestPath = path.join(skillDirectory, 'SKILL.md');
    const { manager, extension: broken } = await ready();
    expect(broken).toBeDefined();
    expect(broken.skills).toEqual([]);
    expect(broken.skillsDiscoveryHasErrors).toBe(true);
    fs.writeFileSync(
      manifestPath,
      '---\nname: review\ndescription: Review code\n---\nBody.',
    );
    await manager.refreshCache();
    const [recovered] = manager.getLoadedExtensions();
    expect(recovered.skills?.map((skill) => skill.name)).toEqual(['review']);
    expect(recovered.skillsDiscoveryHasErrors).not.toBe(true);
    fs.rmSync(skillDirectory, { recursive: true });
    await manager.refreshCache();
    expect(manager.getLoadedExtensions()[0].skillsDiscoveryHasErrors).not.toBe(
      true,
    );
  });

  it('propagates Agent Plugin root discovery failures through recovery and confirmed removal', async () => {
    const pluginDirectory = addPlugin('portable-plugin');
    const skillsDirectory = path.join(pluginDirectory, 'skills');
    const outsideDirectory = path.join(tempWorkspaceDir, 'outside-skills');
    const manager = createExtensionManager();
    const skillManager = new SkillManager({
      isSafeMode: () => false,
      getBareMode: () => false,
      getProjectRoot: () => tempWorkspaceDir,
      getDisabledSkillLevels: () => new Set(['project', 'user', 'bundled']),
      getActiveExtensions: () =>
        manager.getLoadedExtensions().filter((extension) => extension.isActive),
    } as unknown as Config);
    const refresh = async () => {
      await manager.refreshCache();
      await skillManager.refreshCache();
      return manager.getLoadedExtensions()[0];
    };
    const cachedSkills = () =>
      skillManager.getCachedSkills()?.map((skill) => skill.name);

    await refresh();
    expect(cachedSkills()).toEqual(['portable-plugin:direct']);
    fs.renameSync(skillsDirectory, outsideDirectory);
    fs.symlinkSync(
      outsideDirectory,
      skillsDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const broken = await refresh();
    expect(broken.format).toBe('agent-plugins-v1');
    expect(broken.skills).toEqual([]);
    expect(broken.skillsDiscoveryHasErrors).toBe(true);
    expect(skillManager.getCachedSkills()).toEqual([]);
    expect(skillManager.hasDiscoveryErrors()).toBe(true);

    fs.unlinkSync(skillsDirectory);
    fs.renameSync(outsideDirectory, skillsDirectory);
    const recovered = await refresh();
    expect(recovered.skills?.map((skill) => skill.name)).toEqual(['direct']);
    expect(recovered.skillsDiscoveryHasErrors).not.toBe(true);
    expect(cachedSkills()).toEqual(['portable-plugin:direct']);
    expect(skillManager.hasDiscoveryErrors()).toBe(false);

    fs.rmSync(skillsDirectory, { recursive: true });
    const removed = await refresh();
    expect(removed.skills).toEqual([]);
    expect(removed.skillsDiscoveryHasErrors).not.toBe(true);
    expect(skillManager.getCachedSkills()).toEqual([]);
    expect(skillManager.hasDiscoveryErrors()).toBe(false);
  });

  describe('extension skill states', () => {
    let manager: ExtensionManager;
    let extensionDirectory: string;
    let extensionId: string;
    const writeSuite = (config: object) =>
      writeManifest(extensionDirectory, {
        name: 'suite',
        version: '1.0.0',
        ...config,
      });
    const useSkillRefresh = (refreshCache: unknown) =>
      manager.setConfig({
        getSkillManager: () => ({ refreshCache }),
      } as unknown as Config);
    const skillState = (name: string, workspace?: string) =>
      manager.getExtensionSkillState(extensionId, name, workspace);

    beforeEach(async () => {
      extensionDirectory = addExt({ name: 'suite' });
      for (const name of ['skill-a', 'skill-b', 'constructor', '__proto__']) {
        writeTree(extensionDirectory, {
          [`skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: Test skill\n---\nSkill body`,
        });
      }
      ({ manager } = await ready());
      extensionId = manager.getLoadedExtensions()[0]!.id;
    });

    it.each([undefined, {}])(
      'defaults undeclared skill states to enabled: %j',
      async (skillStates) => {
        writeSuite({ skillStates });
        await manager.refreshCache();
        expect(skillState('__proto__')).toEqual({
          defaultEnabled: true,
          workspaceEnabled: null,
        });
      },
    );

    it('parses normalized boolean defaults without losing prototype-named skills', async () => {
      writeSuite({
        skillStates: Object.fromEntries([
          [' Skill-A ', false],
          ['constructor', true],
          ['__proto__', false],
        ]),
      });
      await manager.refreshCache();
      for (const [name, expected] of [
        ['skill-a', false],
        ['skill-b', true],
        ['constructor', true],
        ['__proto__', false],
      ] as const) {
        expect(skillState(name).defaultEnabled).toBe(expected);
      }
    });

    it.each([
      null,
      [],
      'enabled',
      { 'skill-a': 'false' },
      { 'bad name': true },
    ])('rejects invalid native skillStates: %j', (skillStates) => {
      writeSuite({ skillStates });
      expect(() =>
        manager.loadExtensionConfig({ extensionDir: extensionDirectory }),
      ).toThrow();
    });

    it('saves a mixed batch on an inactive extension without changing activation or refreshing other resources', async () => {
      const refreshTools = stubRefreshTools(manager);
      await manager.setExtensionDefaultActivation(extensionId, 'disabled');
      refreshTools.mockClear();
      const refreshCache = vi.fn().mockResolvedValue(undefined);
      useSkillRefresh(refreshCache);
      const before = await manager.getExtensionStoreSnapshot();
      const onCommitted = vi.fn();
      const result = await manager.setExtensionSkillStates(
        extensionId,
        tempWorkspaceDir,
        [
          { name: 'Skill-A', state: 'disabled' },
          { name: '__proto__', state: 'enabled' },
        ],
        onCommitted,
      );
      expect(result.generation).toBe(before.generation + 1);
      expect(onCommitted).toHaveBeenCalledExactlyOnceWith(result.generation);
      expect(refreshCache).toHaveBeenCalledExactlyOnceWith({
        throwOnError: true,
      });
      expect(refreshTools).not.toHaveBeenCalled();
      expect(manager.getLoadedExtensions()[0]?.isActive).toBe(false);
      expect(skillState('skill-a')).toEqual({
        defaultEnabled: true,
        workspaceEnabled: false,
      });
      expect(skillState('__proto__').workspaceEnabled).toBe(true);
      expect(skillState('skill-b').workspaceEnabled).toBeNull();
      expect(
        skillState('skill-a', path.join(tempWorkspaceDir, 'other'))
          .workspaceEnabled,
      ).toBeNull();

      writeSuite({ version: '2.0.0', skillStates: { ['__proto__']: false } });
      await manager.refreshCache();
      expect(skillState('__proto__').workspaceEnabled).toBe(true);
      writeSuite({ version: '3.0.0' });
      const { manager: restarted } = await ready();
      expect(
        restarted.getExtensionSkillState(extensionId, 'skill-a')
          .workspaceEnabled,
      ).toBe(false);
    });

    it('rejects the entire batch for foreign ownership or duplicate names and does not refresh skills', async () => {
      writeTree(addExt({ name: 'other' }), {
        'skills/foreign/SKILL.md':
          '---\nname: foreign\ndescription: Other extension\n---\nOther body',
      });
      await manager.refreshCache();
      const before = await manager.getExtensionStoreSnapshot();
      const refreshCache = vi.fn();
      useSkillRefresh(refreshCache);
      await expect(
        manager.setExtensionSkillStates(extensionId, tempWorkspaceDir, [
          { name: 'skill-a', state: 'disabled' },
          { name: 'foreign', state: 'enabled' },
        ]),
      ).rejects.toThrow('does not belong');
      await expect(
        manager.setExtensionSkillStates(extensionId, tempWorkspaceDir, [
          { name: 'skill-a', state: 'disabled' },
          { name: ' Skill-A ', state: 'disabled' },
        ]),
      ).rejects.toThrow('Duplicate');
      expect(await manager.getExtensionStoreSnapshot()).toEqual(before);
      expect(refreshCache).not.toHaveBeenCalled();
    });

    it('retains committed states and reports skill-only refresh failure', async () => {
      useSkillRefresh(rejectingWith('skill refresh failed'));
      const result = await manager.setExtensionSkillStates(
        extensionId,
        tempWorkspaceDir,
        [{ name: 'skill-a', state: 'disabled' }],
      );
      expect(result.warnings).toEqual([refreshFailed('skill refresh failed')]);
      expect(skillState('skill-a').workspaceEnabled).toBe(false);
      expect((await manager.getExtensionStoreSnapshot()).generation).toBe(
        result.generation,
      );
    });
  });

  describe('installExtension', () => {
    const writeQoderPlugin = (destination: string) =>
      writeTree(destination, {
        '.qoder-plugin/plugin.json': {
          name: 'sample-qoder-plugin',
          version: '1.0.0',
        },
        'system-prompt.md': '# System context',
      });
    const claudePlugin = (name: string) => ({
      '.claude-plugin/plugin.json': { name, version: '1.0.0' },
    });
    const marketplace = (plugin: object) => ({
      '.claude-plugin/marketplace.json': {
        name: 'sample-marketplace',
        owner: { name: 'Example', email: 'example@example.com' },
        plugins: [plugin],
      },
    });
    const nestedPlugin = {
      name: 'sample-plugin',
      source: { source: 'github', repo: 'example/nested-plugin' },
    };
    const writeGemini = (name: string) => (destination: string) =>
      writeTree(destination, {
        'gemini-extension.json': { name, version: '1.0.0' },
      });
    const pluginDataOf = (extension: Extension) =>
      extension.mcpServers?.['local']?.env?.['PLUGIN_DATA'];

    it('installs an Agent Plugin without converting package files', async () => {
      const sourcePath = path.join(tempWorkspaceDir, 'portable-source');
      createAgentPlugin(sourcePath);
      writeTree(sourcePath, {
        'commands/ignored.md': 'no',
        'agents/ignored.md': 'no',
        'hooks/ignored.md': 'no',
        'QWEN.md': 'ignored context',
        // The Agent Plugins v1 schema defines no workflows, so a shipped
        // workflows/ directory must neither be disclosed nor loaded.
        'workflows/audit.js':
          "export const meta = { name: 'audit', description: 'Audit' };\nreturn 1;\n",
      });
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

      const { requestConsent, extension } = await readyInstall(sourcePath);

      expect(extension.version).toBe('1.0.0');
      expect(extension.format).toBe('agent-plugins-v1');
      expect(extension.installMetadata?.originSource).toBe('AgentPlugins');
      expect(extension.skills?.map((skill) => skill.name)).toEqual(['direct']);
      expect(extension.skills?.[0]?.allowedTools).toBeUndefined();
      expect(extension.commands).toEqual([]);
      expect(extension.agents).toEqual([]);
      expect(extension.workflows).toEqual([]);
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
      expectConsent(requestConsent, {
        originSource: 'AgentPlugins',
        commands: [],
        subagents: [],
        workflows: [],
        skills: [expect.objectContaining({ name: 'direct' })],
      });
      expect(extension.workflows).toEqual([]);

      for (const [file, contents] of sourceContents) {
        expect(fs.readFileSync(path.join(extension.path, file))).toEqual(
          contents,
        );
      }
      expect(exists(extension.path, EXTENSIONS_CONFIG_FILENAME)).toBe(false);
      expect(exists(extension.path, INSTALL_METADATA_FILENAME)).toBe(true);
      if (process.platform !== 'win32') {
        expect(exists(extension.path, 'outside-link')).toBe(false);
      }
      const pluginData = pluginDataOf(extension);
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

        const { extension: installed } = await readyInstall(symlinkPath);

        expect(installed.name).toBe('symlinked-plugin');
        expect(installed.installMetadata).toMatchObject({
          source: symlinkPath,
          originSource: 'AgentPlugins',
        });
        expect(exists(installed.path, 'plugin.json')).toBe(true);
      },
    );

    it('preserves Agent Plugin data across update and reinstall', async () => {
      const sourcePath = path.join(tempWorkspaceDir, 'persistent-source');
      const plugin = { name: 'persistent-plugin', version: '1.0.0' };
      createAgentPlugin(sourcePath, plugin);
      const metadata = { type: 'local' as const, source: sourcePath };
      const { manager, extension: installed } = await readyInstall(metadata);
      const pluginData = pluginDataOf(installed);
      expect(pluginData).toBeDefined();
      fs.writeFileSync(path.join(pluginData!, 'state.txt'), 'persistent');
      const expectDataKept = (extension: Extension) => {
        expect(pluginDataOf(extension)).toBe(pluginData);
        expect(readText(pluginData!, 'state.txt')).toBe('persistent');
      };

      createAgentPlugin(sourcePath, { ...plugin, version: '1.0.1' });
      const updated = await reinstall(manager, metadata, installed.config);
      expect(updated.version).toBe('1.0.1');
      expectDataKept(updated);

      await manager.uninstallExtensionById(updated.id, false);
      expectDataKept(await install(manager, metadata));
    });

    it('links an Agent Plugin and fingerprints its native manifest', async () => {
      const sourcePath = path.join(tempWorkspaceDir, 'linked-source');
      createAgentPlugin(sourcePath, {
        name: 'linked-plugin',
        version: '1.0.0',
      });
      const { manager, extension: linked } = await readyInstall({
        type: 'link',
        source: sourcePath,
      });

      expect(linked.path).toBe(sourcePath);
      expect(linked.installMetadata).toMatchObject({
        type: 'link',
        source: sourcePath,
        originSource: 'AgentPlugins',
      });
      expect(await manager.refreshCacheIfSourcesChanged()).toBe(true);
      expect(await manager.refreshCacheIfSourcesChanged()).toBe(false);

      const manifest = JSON.parse(
        readText(sourcePath, 'plugin.json'),
      ) as Record<string, unknown>;
      writeTree(sourcePath, {
        'plugin.json': { ...manifest, version: '1.0.1-longer' },
      });
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
        writeTree(path.join(userExtensionsDir, 'broken-link'), {
          [INSTALL_METADATA_FILENAME]: { type: 'link', source },
        });
        addPlugin('valid-plugin');

        const manager = createExtensionManager();
        await expect(manager.refreshCache()).resolves.toBeUndefined();
        expect(loadedNames(manager)).toEqual(['valid-plugin']);
      },
    );

    it('installs an Agent Plugin from an archive', async () => {
      const archivePath = archive('portable-plugin.zip', (destination) =>
        createAgentPlugin(destination, { name: 'archived-plugin' }),
      );

      const { extension: installed } = await readyInstall(archivePath);

      expect(installed.name).toBe('archived-plugin');
      expect(installed.installMetadata?.originSource).toBe('AgentPlugins');
      expect(exists(installed.path, 'qwen-extension.json')).toBe(false);
    });

    it('installs an Agent Plugin from Git', async () => {
      const source = 'https://github.com/example/portable-plugin';
      gitRepo(source, (dir) =>
        createAgentPlugin(dir, { name: 'git-agent-plugin' }),
      );

      const { extension: installed } = await readyInstall({
        type: 'git',
        source,
      });

      expect(installed.name).toBe('git-agent-plugin');
      expect(installed.installMetadata).toMatchObject({
        originSource: 'AgentPlugins',
        gitCommit: 'sample-commit',
      });
      expect(exists(installed.path, 'qwen-extension.json')).toBe(false);
    });

    const readyPublicGit = (source: string) =>
      readyInstall({ type: 'git', source }, { networkPolicy: 'public' });

    it('materializes validated Agent Plugin symlinks from the old-Git archive fallback', async () => {
      const source = 'https://github.com/example/agent-plugin';
      oldGitFallback((destination) => {
        createAgentPlugin(destination, { name: 'old-git-agent-plugin' });
        fs.writeFileSync(path.join(destination, 'CLAUDE.md'), '# agents\n');
        if (process.platform !== 'win32') {
          fs.symlinkSync('CLAUDE.md', path.join(destination, 'AGENTS.md'));
        }
      });

      const { extension: installed } = await readyPublicGit(source);

      expect(installed.name).toBe('old-git-agent-plugin');
      expect(installed.installMetadata).toMatchObject({
        type: 'git',
        source,
        gitCommit: FALLBACK_SHA,
        originSource: 'AgentPlugins',
      });
      if (process.platform !== 'win32') {
        const installedAgents = path.join(installed.path, 'AGENTS.md');
        expect(fs.lstatSync(installedAgents).isFile()).toBe(true);
        expect(fs.readFileSync(installedAgents, 'utf8')).toBe('# agents\n');
      }
      // Releases stay preferred over the archive fallback on older Git.
      expect(mockDownloadFromGitHubRelease).toHaveBeenCalled();
      expectArchiveFallbackFor(source);
      expect(mockGit.clone).not.toHaveBeenCalled();
    });

    it('re-validates symlinks on the post-conversion tree when the old-Git archive fallback feeds a converter', async () => {
      // The fallback only validated sourceBeforeConversion; when conversion
      // relocates the tree (AgentPlugins never does), re-validate the result.
      let fallbackDestination: string | undefined;
      oldGitFallback((destination) => {
        fallbackDestination = destination;
        writeGemini('old-git-gemini-extension')(destination);
      });

      const { extension: installed } = await readyPublicGit(
        'https://github.com/example/gemini-extension',
      );

      expect(installed.name).toBe('old-git-gemini-extension');
      expect(installed.installMetadata).toMatchObject({
        originSource: 'Gemini',
      });
      expect(fallbackDestination).toBeDefined();
      // Gemini conversion copies to a fresh temp dir, so this passes only if
      // the guard's `localSourcePath !== sourceBeforeConversion` half is
      // reachable, which gating it on `isAgentPlugin` (the bug) prevents.
      // Escape the path: raw Windows backslashes would match nothing and pass.
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
      // The guard above pins that re-validation is CALLED; this pins that its
      // rejection (the stale-trust case) aborts the install.
      oldGitFallback(writeGemini('old-git-gemini-extension-unsafe'));
      mockAssertDirectorySymlinksAreSafe.mockRejectedValueOnce(
        new Error('Tar archive contains unsupported link entry: escape'),
      );

      await expect(
        readyPublicGit('https://github.com/example/gemini-extension-unsafe'),
      ).rejects.toThrow('unsupported link entry');

      expect(
        exists(
          userExtensionsDir,
          'old-git-gemini-extension-unsafe',
          EXTENSIONS_CONFIG_FILENAME,
        ),
      ).toBe(false);
    });

    it('keeps release installs ahead of the old-Git archive fallback', async () => {
      mockGit.version.mockResolvedValue(OLD_GIT);
      mockDownloadFromGitHubRelease.mockImplementation(
        writesTo(extracted('release-extension'), {
          tagName: 'v2.0.0',
          type: 'github-release' as const,
        }),
      );

      const { extension: installed } = await readyPublicGit(
        'https://github.com/owner/repo',
      );

      expect(installed.installMetadata).toMatchObject({
        type: 'github-release',
        source: 'https://github.com/owner/repo',
        releaseTag: 'v2.0.0',
      });
      expect(mockDownloadPublicGitHubArchiveFallback).not.toHaveBeenCalled();
      expect(mockGit.clone).not.toHaveBeenCalled();
    });

    const gitSource = 'https://git.example.com/team/extension.git';
    const prepareWithCredential = (
      manager: ExtensionManager,
      persistence: 'one_time' | 'stored',
    ) =>
      prepare(
        manager,
        { type: 'git', source: gitSource },
        {
          gitCredential: {
            username: 'user',
            password: 'fine-grained-token',
            persistence,
          },
        },
      );
    const stagedMetadataOf = (prepared: PreparedExtensionMutation) =>
      readText(prepared.stagingDirectory, INSTALL_METADATA_FILENAME);

    it('persists a credentialed one-time install as a source-free snapshot', async () => {
      mockGit.env.mockReturnValue(mockGit);
      gitRepo(gitSource, (destination) =>
        writeTree(destination, {
          [EXTENSIONS_CONFIG_FILENAME]: {
            name: 'one-time-extension',
            version: '1.0.0',
          },
          '.git/config': 'credential must not be copied',
        }),
      );
      const { manager } = await ready();

      const prepared = await prepareWithCredential(manager, 'one_time');

      expect(prepared.installMetadata).toMatchObject({
        type: 'snapshot',
        source: 'snapshot',
        installId: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(prepared.identity.id).toBe(prepared.installMetadata.installId);
      expect(exists(prepared.stagingDirectory, '.git')).toBe(false);
      expect(
        exists(
          prepared.stagingDirectory,
          EXTENSION_GIT_CREDENTIAL_SELECTOR_FILENAME,
        ),
      ).toBe(false);
      const stagedMetadata = stagedMetadataOf(prepared);
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
      const telemetry = JSON.stringify(
        mockLogExtensionInstallEvent.mock.calls.map(([, event]) => event),
      );
      expect(telemetry).not.toContain('git.example.com');
      expect(telemetry).not.toContain('fine-grained-token');
      const { manager: reloaded, extension } = await ready();
      expect(extension?.id).toBe(prepared.identity.id);
      await expect(update(reloaded, extension)).rejects.toMatchObject({
        code: 'extension_not_updatable',
      });
      await manager.disposePreparedExtension(prepared);
    });

    it('stores managed Git credentials separately from install metadata', async () => {
      vi.stubEnv('QWEN_HOME', tempHomeDir);
      vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'true');
      mockGit.env.mockReturnValue(mockGit);
      gitRepo(gitSource, extracted('stored-extension'));
      const { manager } = await ready();

      const prepared = await prepareWithCredential(manager, 'stored');

      expect(prepared.installMetadata).toMatchObject({
        type: 'git',
        source: gitSource,
        credentialPersistence: 'stored',
        installId: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(stagedMetadataOf(prepared)).not.toContain('fine-grained-token');

      const committed = await manager.commitPreparedExtension(prepared);
      const resolved = await resolveStoredGitCredential(
        committed.extension!.path,
      );
      expect(resolved).toMatchObject({
        credential: { username: 'user', password: 'fine-grained-token' },
      });
      const originalId = committed.identity.id;

      await update(manager, committed.extension!);

      expect(manager.getLoadedExtensions()[0]?.id).toBe(originalId);
      expect(mockGit.clone).toHaveBeenLastCalledWith(
        gitSource,
        './',
        expect.any(Array),
      );
      expect(mockGit.env).toHaveBeenLastCalledWith(
        expect.objectContaining({
          GIT_CONFIG_KEY_0: `http.${gitSource}.extraHeader`,
        }),
      );
      const storage = new FileTokenStorage(
        'Qwen Code Extension Git Credentials',
      );
      const secret = () => storage.getSecret(resolved.selector.secretKey);
      await expect(secret()).resolves.not.toBeNull();

      writeTree(path.join(userExtensionsDir, 'stored-extension'), {
        [EXTENSIONS_CONFIG_FILENAME]: '{',
      });
      const { manager: unloaded } = await ready();
      expect(unloaded.getLoadedExtensions()).toEqual([]);
      await unloaded.uninstallExtensionById(originalId, false);
      await expect(secret()).resolves.toBeNull();
      await manager.disposePreparedExtension(prepared);
    });

    it('installs and uninstalls within an injected extension store root', async () => {
      const archivePath = archive('custom-root.zip', 'custom-root');
      const customExtensionsDir = path.join(tempHomeDir, 'custom-extensions');
      const manager = createExtensionManager({
        extensionStore: storeAt(customExtensionsDir),
      });

      const installed = await install(manager, archivePath);

      expect(installed.path).toBe(
        path.join(customExtensionsDir, 'custom-root'),
      );
      await manager.uninstallExtensionById(installed.id, true);
      expect(fs.existsSync(installed.path)).toBe(false);
    });

    it('commits workspace initial activation with the installed artifact', async () => {
      const archivePath = archive('workspace-ext.zip', 'workspace-ext');
      const { manager } = await ready();

      const extension = await manager.installExtension(
        { type: 'local', source: archivePath },
        () => Promise.resolve(),
        undefined,
        tempWorkspaceDir,
        undefined,
        { scope: 'workspace', workspacePath: tempWorkspaceDir },
      );

      await expect(
        manager.getExtensionActivation(extension.id, tempWorkspaceDir),
      ).resolves.toMatchObject({
        default: 'disabled',
        workspace: 'enabled',
        effective: 'enabled',
      });
    });

    it('prepares without mutating the store and commits exactly once', async () => {
      const archivePath = archive('prepared-ext.zip', 'prepared-ext');
      const { manager, events } = await ready();
      const before = await manager.getExtensionStoreSnapshot();

      const prepared = await prepare(manager, archivePath);

      expect(exists(userExtensionsDir, 'prepared-ext')).toBe(false);
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
      expect(events).toEqual(lifecycle('installExtension'));
    });

    it('reads an uploaded archive from a local path without persisting that path', async () => {
      const archivePath = archive('uploaded.zip', 'uploaded-extension');
      const manager = createExtensionManager();

      const prepared = await prepare(manager, 'upload:uploaded.zip', {
        localSourcePath: archivePath,
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
      const localSourcePath = archive('uploaded.zip');

      await expect(
        prepare(
          createExtensionManager(),
          { type: 'git', source: 'https://example.com/extension.git' },
          { localSourcePath },
        ),
      ).rejects.toThrow('A local source path requires a local install.');
    });

    it('signals the durable commit before runtime refresh completes', async () => {
      const archivePath = archive('commit-boundary.zip', 'commit-boundary');
      const manager = createExtensionManager();
      const refresh = deferred();
      vi.spyOn(manager, 'refreshTools').mockImplementation(
        async () => await refresh.promise,
      );
      const prepared = await prepare(manager, archivePath);
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
      refresh.resolve();
      await committing;
    });

    it('fully validates the staged extension before commit', async () => {
      const archivePath = archive('invalid-context.zip', (destination) =>
        writeManifest(destination, {
          name: 'invalid-context',
          version: '1.0.0',
          contextFileName: 42,
        }),
      );
      const manager = createExtensionManager();
      const before = await manager.getExtensionStoreSnapshot();

      await expect(prepare(manager, archivePath)).rejects.toThrow();

      expect(await manager.getExtensionStoreSnapshot()).toEqual(before);
      expect(exists(userExtensionsDir, 'invalid-context')).toBe(false);
    });

    it('commits a fully validated extension without an explicit version', async () => {
      const archivePath = archive('default-version.zip', (destination) =>
        writeManifest(destination, { name: 'default-version' }),
      );
      const manager = createExtensionManager();
      const prepared = await prepare(manager, archivePath);

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

      await expect(
        prepare(
          createExtensionManager(),
          { type: 'archive-url', source: 'https://example.com/extension.zip' },
          { signal: controller.signal },
        ),
      ).rejects.toBe(reason);
    });

    it('uses the installed path for Claude plugin root replacement', async () => {
      const archivePath = archive('claude-ext.zip', (destination) => {
        writeTree(destination, {
          ...claudePlugin('claude-ext'),
          'README.md': '${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh',
        });
        fs.mkdirSync(path.join(destination, 'hooks'));
      });
      const manager = createExtensionManager();
      const prepared = await prepare(manager, archivePath);

      try {
        await manager.commitPreparedExtension(prepared);
        expect(
          path.normalize(readText(prepared.destinationDirectory, 'README.md')),
        ).toBe(path.join(prepared.destinationDirectory, 'scripts', 'setup.sh'));
      } finally {
        await manager.disposePreparedExtension(prepared);
      }
    });

    /** `ready()` then a prepared local-archive install of extension `name`. */
    async function readyPrepared(name: string) {
      const archivePath = archive(`${name}.zip`, name);
      const loaded = await ready();
      return {
        ...loaded,
        prepared: await prepare(loaded.manager, archivePath),
      };
    }

    it('does not report a temp cleanup warning when an immediate retry succeeds', async () => {
      const { manager, prepared } = await readyPrepared('cleanup-warning');
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
      const { manager, prepared } = await readyPrepared('settings-warning');
      stubCommitSettings(prepared, rejectingWith('keychain unavailable'));

      const committed = await manager.commitPreparedExtension(prepared);

      expect(committed.warnings).toContainEqual({
        code: 'extension_settings_legacy_sync_failed',
        error: 'keychain unavailable',
      });
    });

    it('signals the durable commit before deferred settings finish', async () => {
      const { manager, prepared } = await readyPrepared('settings-deferred');
      const settings = deferred();
      const commitSettings = stubCommitSettings(
        prepared,
        vi.fn(async () => await settings.promise),
      );
      const onCommitted = vi.fn();

      const committing = manager.commitPreparedExtension(prepared, onCommitted);
      await vi.waitFor(() => expect(commitSettings).toHaveBeenCalledOnce());

      expect(onCommitted).toHaveBeenCalledOnce();
      expect(onCommitted.mock.invocationCallOrder[0]).toBeLessThan(
        commitSettings.mock.invocationCallOrder[0]!,
      );
      settings.resolve();
      await expect(committing).resolves.toMatchObject({
        identity: { name: 'settings-deferred' },
      });
    });

    it('surfaces committed runtime refresh warnings after install reloads', async () => {
      const archivePath = archive('refresh-warning.zip', 'refresh-warning');
      const { manager } = await ready();
      failRefreshToolsOnce(manager, 'runtime stale');

      await expect(install(manager, archivePath)).rejects.toMatchObject({
        code: 'extension_committed_with_warnings',
        committed: true,
        identity: { name: 'refresh-warning' },
        warnings: [refreshFailed('runtime stale')],
      });
    });

    it('records error telemetry when a prepared install commit fails', async () => {
      const { manager, prepared } = await readyPrepared('commit-failure');
      const commitSettings = stubCommitSettings(prepared, vi.fn());
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
      const archivePath = archive(
        'local-extension.zip',
        'local-archive-extension',
      );

      const { extension } = await readyInstall(archivePath);

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
      const sourcePath = writeTree(
        writeQoderPlugin(path.join(tempWorkspaceDir, 'sample-qoder-plugin')),
        {
          'skills/sample-skill/SKILL.md':
            '---\nname: sample-skill\ndescription: Synthetic skill\n---\n',
          'commands/sample.md':
            '# Command\n${CLAUDE_PLUGIN_ROOT}/scripts/run.sh',
          'hooks/hooks.json': '{}',
        },
      );

      const { requestConsent, extension } = await readyInstall(sourcePath);

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
      expect(readText(extension.path, 'commands', 'sample.md')).toContain(
        `${extension.path}/scripts/run.sh`,
      );
      expectConsent(requestConsent, { originSource: 'Qoder' });
    });

    it.each([
      { type: 'local' as const, source: 'sample-qoder-plugin.zip' },
      {
        type: 'archive-url' as const,
        source: 'https://example.com/sample-qoder-plugin.zip',
      },
      { type: 'npm' as const, source: '@example/sample-qoder-plugin' },
    ])('should install a Qoder plugin from $type', async (installMetadata) => {
      let source: ExtensionInstallMetadata | string = installMetadata;
      if (installMetadata.type === 'local') {
        source = archive(installMetadata.source, writeQoderPlugin);
      } else if (installMetadata.type === 'archive-url') {
        mockDownloadFromArchiveUrl.mockImplementation(
          writesTo(writeQoderPlugin),
        );
      } else {
        mockDownloadFromNpmRegistry.mockImplementation(
          writesTo(writeQoderPlugin, { version: '1.0.0', type: 'npm' }),
        );
      }

      const { extension } = await readyInstall(source);

      expect(extension.name).toBe('sample-qoder-plugin');
      expect(extension.installMetadata?.originSource).toBe('Qoder');
      expect(extension.contextFiles).toEqual([
        path.join(extension.path, 'system-prompt.md'),
      ]);
    });

    it('should install a Qoder plugin from Git', async () => {
      const source = 'https://github.com/example/sample-qoder-plugin';
      gitRepo(source, writeQoderPlugin);

      const { extension } = await readyInstall({ type: 'git', source });

      expect(extension.name).toBe('sample-qoder-plugin');
      expect(extension.installMetadata?.originSource).toBe('Qoder');
      expect(extension.installMetadata?.gitCommit).toBe('sample-commit');
    });

    it('should retain the recorded commit for a converted Claude Git plugin', async () => {
      const source = 'https://github.com/example/sample-claude-plugin';
      gitRepo(source, (dir) =>
        writeTree(dir, claudePlugin('sample-claude-plugin')),
      );

      const { extension } = await readyInstall({ type: 'git', source });

      expect(extension.installMetadata?.originSource).toBe('Claude');
      expect(extension.installMetadata?.gitCommit).toBe('sample-commit');
    });

    const marketplaceSource = 'https://github.com/example/sample-marketplace';
    const marketplaceInstall = () => ({
      type: 'git' as const,
      source: marketplaceSource,
      pluginName: 'sample-plugin',
    });

    it('should retain the recorded commit when a marketplace plugin lives in the marketplace repo', async () => {
      gitRepo(marketplaceSource, (dir) =>
        writeTree(dir, {
          ...marketplace({
            name: 'sample-plugin',
            source: './plugins/sample-plugin',
          }),
          'plugins/sample-plugin/.claude-plugin/plugin.json': {
            name: 'sample-plugin',
            version: '1.0.0',
          },
          'plugins/sample-plugin/plugin.json': {
            $schema: AGENT_PLUGIN_SCHEMA,
            name: 'carried-agent-plugin',
          },
        }),
      );

      const { extension } = await readyInstall(marketplaceInstall());

      expect(extension.name).toBe('sample-plugin');
      expect(extension.format).toBe('qwen');
      expect(extension.installMetadata?.originSource).toBe('Claude');
      expect(extension.installMetadata?.gitCommit).toBe('sample-commit');
      expect(extension.installMetadata?.externalContent).toBe(false);
      expect(exists(extension.path, 'plugin.json')).toBe(false);
    });

    it('should drop the recorded commit when a marketplace plugin resolves from an external source', async () => {
      let cloneCalls = 0;
      gitRepo(marketplaceSource, (dir) =>
        writeTree(
          dir,
          ++cloneCalls === 1
            ? marketplace(nestedPlugin)
            : claudePlugin('sample-plugin'),
        ),
      );

      const { extension } = await readyInstall(marketplaceInstall());

      expect(extension.name).toBe('sample-plugin');
      expect(extension.installMetadata?.originSource).toBe('Claude');
      expect(extension.installMetadata?.gitCommit).toBeUndefined();
      expect(extension.installMetadata?.externalContent).toBe(true);
    });

    it('should mark external marketplace content downloaded from a GitHub release as not independently updatable', async () => {
      mockDownloadFromGitHubRelease.mockImplementationOnce(
        writesTo(
          (destination) => writeTree(destination, marketplace(nestedPlugin)),
          { type: 'github-release', tagName: 'v1.0.0' },
        ),
      );
      gitRepo('https://github.com/example/nested-plugin', (dir) =>
        writeTree(dir, claudePlugin('sample-plugin')),
      );

      const { extension } = await readyInstall(marketplaceInstall());

      expect(extension.installMetadata).toMatchObject({
        type: 'github-release',
        releaseTag: 'v1.0.0',
        originSource: 'Claude',
        externalContent: true,
      });
      expect(extension.installMetadata?.gitCommit).toBeUndefined();
    });

    it('should emit mutation lifecycle events around install', async () => {
      const { events } = await readyInstall(
        archive('local-extension.zip', 'local-archive-extension'),
      );

      expect(events).toEqual(lifecycle('installExtension'));
    });

    it('should not reuse a dirty tempDir when falling back from GitHub release to git clone', async () => {
      // Regression for #6334: a failed release download can leave a partial
      // file in tempDir, and the fallback `git clone` then fails with
      // "destination path '.' already exists" unless it gets a clean directory.
      trackTmpDirs();
      mockDownloadFromGitHubRelease.mockImplementation(
        async (_meta: ExtensionInstallMetadata, destination: string) => {
          writeTree(destination, { 'partial.tar.gz': 'partial' });
          throw new Error('Mocked GitHub release download failure');
        },
      );
      let cloneRanOnCleanDir = false;
      // cloneFromGit runs `git clone <url> ./` in the tempDir it gave
      // simpleGit(); mirror real git failing on a non-empty directory.
      gitRepo('https://github.com/owner/repo', (dir) => {
        const isEmpty = fs.readdirSync(dir).length === 0;
        cloneRanOnCleanDir = isEmpty;
        if (!isEmpty) {
          throw new Error(
            "destination path '.' already exists and is not an empty directory.",
          );
        }
        extracted('git-extension')(dir);
      });
      const { extension } = await readyInstall(
        { source: 'https://github.com/owner/repo', type: 'git' },
        {},
        new AbortController().signal,
      );

      expect(mockDownloadFromGitHubRelease).toHaveBeenCalled();
      // Without the cleanup the clone throws and the install rejects.
      expect(cloneRanOnCleanDir).toBe(true);
      expect(extension.name).toBe('git-extension');
    });

    it('should clean up converted temp dir for local archive installs', async () => {
      const archivePath = archive(
        'gemini-extension.zip',
        writeGemini('gemini-archive-extension'),
      );
      const tempDirs = trackTmpDirs();

      const { extension } = await readyInstall(archivePath);

      expect(extension.name).toBe('gemini-archive-extension');
      expect(tempDirs).toHaveLength(2);
      expect(fs.existsSync(tempDirs[0])).toBe(false);
      expect(fs.existsSync(tempDirs[1])).toBe(false);
      expect(
        exists(
          userExtensionsDir,
          'gemini-archive-extension',
          EXTENSIONS_CONFIG_FILENAME,
        ),
      ).toBe(true);
    });

    const archiveUrlInstall = () => ({
      source: 'https://example.com/archive-extension.zip',
      type: 'archive-url' as const,
    });

    it('should install an extension from an archive URL', async () => {
      mockDownloadFromArchiveUrl.mockImplementation(
        writesTo(extracted('archive-url-extension')),
      );
      const controller = new AbortController();

      const { extension } = await readyInstall(
        archiveUrlInstall(),
        {},
        controller.signal,
      );

      expect(mockDownloadFromArchiveUrl).toHaveBeenCalledWith(
        expect.objectContaining(archiveUrlInstall()),
        expect.any(String),
        controller.signal,
      );
      expect(extension.name).toBe('archive-url-extension');
      expect(extension.installMetadata).toMatchObject(archiveUrlInstall());
    });

    it('forces the manager network policy onto remote operations', async () => {
      mockDownloadFromArchiveUrl.mockImplementation(
        writesTo(extracted('policy-extension')),
      );

      await install(createExtensionManager({ networkPolicy: 'public' }), {
        source: 'https://example.com/policy-extension.zip',
        type: 'archive-url',
      });

      expect(mockDownloadFromArchiveUrl).toHaveBeenCalledWith(
        expect.objectContaining({ networkPolicy: 'public' }),
        expect.any(String),
        undefined,
      );
    });

    /** A download/extract body that records its destination, then throws. */
    const failIn =
      (message: string, seen: { dir?: string }) =>
      async (_source: unknown, destination: string) => {
        seen.dir = destination;
        throw new Error(message);
      };

    it('should clean up the temp dir when archive URL download fails', async () => {
      const seen: { dir?: string } = {};
      mockDownloadFromArchiveUrl.mockImplementation(
        failIn('download failed', seen),
      );

      await expect(readyInstall(archiveUrlInstall())).rejects.toThrow(
        'download failed',
      );

      expect(seen.dir).toBeDefined();
      expect(fs.existsSync(seen.dir!)).toBe(false);
    });

    it('should clean up the temp dir when local archive extraction fails', async () => {
      const seen: { dir?: string } = {};
      const archivePath = archive('local-extension.zip');
      mockExtractArchiveFile.mockImplementation(failIn('extract failed', seen));

      await expect(readyInstall(archivePath)).rejects.toThrow('extract failed');

      expect(seen.dir).toBeDefined();
      expect(fs.existsSync(seen.dir!)).toBe(false);
    });
  });

  describe('uninstallExtension', () => {
    async function readyInstalled() {
      addExt({
        installMetadata: {
          type: 'local',
          source: tempWorkspaceDir,
          originSource: 'QwenCode',
        },
      });
      return ready();
    }

    it('returns a committed warning when preference cleanup fails', async () => {
      const { manager } = await readyInstalled();
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
      const { manager } = await readyInstalled();
      failRefreshTools(manager, 'refresh failed');

      const result = await manager.uninstallExtension('my-extension', false);

      expect(result.warnings).toEqual([refreshFailed('refresh failed')]);
    });

    it('should emit mutation lifecycle events around uninstall', async () => {
      const { manager, events } = await readyInstalled();

      await manager.uninstallExtension('my-extension', false);

      expect(events).toEqual(lifecycle('uninstallExtension'));
    });

    it('uninstalls a committed extension by id when it cannot be loaded', async () => {
      const identity = { id: 'a9'.repeat(32), name: 'broken-extension' };
      const extensionStore = storeAt(userExtensionsDir);
      await extensionStore.ensureInitialized([identity]);
      const destination = writeTree(
        path.join(userExtensionsDir, identity.name),
        { 'qwen-extension.json': '{' },
      );
      const manager = createExtensionManager({ extensionStore });

      const snapshot = await manager.uninstallExtensionById(identity.id, true);

      expect(snapshot.extensions[identity.id]).toBeUndefined();
      expect(fs.existsSync(destination)).toBe(false);
    });

    it('treats a declaration as absent when uninstalling by id', async () => {
      const identity = { id: 'aa'.repeat(32), name: 'declared-extension' };
      const extensionStore = storeAt(userExtensionsDir);
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
      const destination = path.join(userExtensionsDir, 'artifact-directory');
      fs.renameSync(addExt({ name: 'manifest-name' }), destination);
      const { manager, extension } = await ready();

      const snapshot = await manager.uninstallExtensionById(extension.id, true);

      expect(snapshot.extensions[extension.id]).toBeUndefined();
      expect(fs.existsSync(destination)).toBe(false);
    });
  });

  describe('refreshCacheIfSourcesChanged', () => {
    // Sources have no watcher: read-only consumers rely on this to see outside
    // mutations (`qwen extensions install` in a terminal) without scanning on
    // every read. See docs/design/workspace-skills-read-model.md.
    async function readyWithExtA() {
      addExt({ name: 'ext-a' });
      return (await ready()).manager;
    }

    it('does not refresh while the sources are unchanged', async () => {
      const manager = await readyWithExtA();
      expect(manager.getLoadedExtensions()).toHaveLength(1);

      const refreshSpy = vi.spyOn(manager, 'refreshCache');
      for (let i = 0; i < 20; i++) {
        expect(await manager.refreshCacheIfSourcesChanged()).toBe(false);
      }

      expect(refreshSpy).not.toHaveBeenCalled();
      expect(manager.getLoadedExtensions()).toHaveLength(1);
    });

    it('refreshes once a new extension appears on disk', async () => {
      const manager = await readyWithExtA();
      expect(manager.getLoadedExtensions()).toHaveLength(1);

      addExt({ name: 'ext-b' });

      expect(await manager.refreshCacheIfSourcesChanged()).toBe(true);
      expect(loadedNames(manager).sort()).toEqual(['ext-a', 'ext-b']);
      // The refresh commits a new baseline, so the next call is a no-op again.
      expect(await manager.refreshCacheIfSourcesChanged()).toBe(false);
    });

    it('refreshes after an extension is removed', async () => {
      const manager = await readyWithExtA();

      fs.rmSync(path.join(userExtensionsDir, 'ext-a'), {
        recursive: true,
        force: true,
      });

      expect(await manager.refreshCacheIfSourcesChanged()).toBe(true);
      expect(manager.getLoadedExtensions()).toHaveLength(0);
    });

    it('refreshes after an in-place manifest edit', async () => {
      const manager = await readyWithExtA();
      expect(manager.getLoadedExtensions()[0]?.version).toBe('1.0.0');

      // Manifests are fingerprinted since a rewrite need not touch dir mtimes;
      // the longer version changes the size, so mtime granularity is moot.
      writeManifest(path.join(userExtensionsDir, 'ext-a'), {
        name: 'ext-a',
        version: '10.0.0',
        mcpServers: {},
      });

      expect(await manager.refreshCacheIfSourcesChanged()).toBe(true);
      expect(manager.getLoadedExtensions()[0]?.version).toBe('10.0.0');
    });

    it('shares one refresh between concurrent callers', async () => {
      const manager = await readyWithExtA();

      addExt({ name: 'ext-b' });
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
      // Taking the baseline before the load keeps a racing write visible next
      // time; stamping after the load would hide it until something else moved.
      const manager = await readyWithExtA();
      expect(manager.getLoadedExtensions()).toHaveLength(1);

      const internals = manager as unknown as LoaderInternals;
      const realLoad = internals.loadExtensionsFromExtensionsDir.bind(manager);
      let raced = false;
      vi.spyOn(internals, 'loadExtensionsFromExtensionsDir').mockImplementation(
        async (...args) => {
          const loaded = await realLoad(...args);
          if (!raced) {
            raced = true;
            // Lands after this refresh has already read the directory.
            addExt({ name: 'ext-b' });
          }
          return loaded;
        },
      );

      // Triggered by the enablement file; the first refresh misses ext-b. Its
      // mtime is set a second back on purpose: `ExtensionStore` fails closed on
      // an outside legacy-projection change whose timestamps cannot be ordered,
      // and at `now` it often shares the store's tick (3 of 6 runs failed,
      // blocking unrelated CI). An older one is orderable; the guard stays.
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
      expect(loadedNames(manager).sort()).toEqual(['ext-a', 'ext-b']);
    });
  });

  describe('refreshExtensionDetailsSnapshot', () => {
    it('loads only the selected resources while preserving all snapshot identities', async () => {
      for (const name of ['ext-a', 'ext-b', 'ext-c']) {
        createExtension({
          extensionsDir: userExtensionsDir,
          name,
          addContextFile: true,
        });
      }
      const manager = createExtensionManager();
      const load = vi.spyOn(manager, 'loadExtension');
      const { snapshot, extension } =
        await manager.refreshExtensionDetailsSnapshot('EXT-B');

      expect(extension?.name).toBe('ext-b');
      expect(extension?.contextFiles).toHaveLength(1);
      expect(
        Object.values(snapshot.extensions)
          .map((entry) => entry.name)
          .sort(),
      ).toEqual(['ext-a', 'ext-b', 'ext-c']);
      const loaded = await Promise.all(
        load.mock.results.map((result) => result.value),
      );
      expect(
        loaded
          .filter((entry) => entry?.contextFiles.length)
          .map((entry) => entry.name),
      ).toEqual(['ext-b']);
      expect(manager.getLoadedExtensions()).toEqual([]);
      expect(await manager.refreshCacheIfSourcesChanged()).toBe(true);
      expect(manager.getLoadedExtensions()).toHaveLength(3);
      expect(
        manager
          .getLoadedExtensions()
          .every((entry) => entry.contextFiles.length === 1),
      ).toBe(true);
    });

    it('returns null for a missing extension without loading other resources', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext-a',
        addContextFile: true,
      });
      const manager = createExtensionManager();
      const load = vi.spyOn(manager, 'loadExtension');
      const { extension } =
        await manager.refreshExtensionDetailsSnapshot('missing');
      expect(extension).toBeNull();
      const loaded = await Promise.all(
        load.mock.results.map((result) => result.value),
      );
      expect(loaded.every((entry) => entry?.contextFiles.length === 0)).toBe(
        true,
      );
    });

    it('reads plugin details without creating its data directory', async () => {
      createAgentPlugin(path.join(userExtensionsDir, 'plugin-ext'), {
        name: 'plugin-ext',
      });
      const storeDir = path.join(tempHomeDir, 'detail-store');
      const manager = createExtensionManager({
        extensionStore: new ExtensionStore({
          extensionsDir: userExtensionsDir,
          storeDir,
        }),
      });
      const { extension } =
        await manager.refreshExtensionDetailsSnapshot('plugin-ext');
      expect(extension?.name).toBe('plugin-ext');
      expect(fs.existsSync(path.join(storeDir, 'plugin-data'))).toBe(false);
    });

    it('fails closed on an unreadable installed entry', async () => {
      createExtension({ extensionsDir: userExtensionsDir, name: 'ext-a' });
      fs.symlinkSync(
        path.join(userExtensionsDir, 'missing-target'),
        path.join(userExtensionsDir, 'broken'),
      );
      await expect(
        createExtensionManager().refreshExtensionDetailsSnapshot('ext-a'),
      ).rejects.toThrow();
    });
  });

  describe('refreshCatalogSnapshot', () => {
    it('loads manifest identity fields without subresources', async () => {
      addExt({
        name: 'qwen-ext',
        version: '1.2.3',
        installMetadata: {
          type: 'git',
          source: 'test-source',
          credentialPersistence: 'stored',
        },
      });
      addPlugin('plugin-ext', '2.0.0');

      const manager = createExtensionManager();
      const { snapshot, extensions } = await manager.refreshCatalogSnapshot();

      expect(snapshot.extensions).toEqual(
        expect.objectContaining({
          [extensions[0]!.id]: expect.objectContaining({
            name: expect.any(String),
          }),
        }),
      );
      expect(extensions).toHaveLength(2);
      const qwenExt = extensions.find((e) => e.name === 'qwen-ext');
      const pluginExt = extensions.find((e) => e.name === 'plugin-ext');
      expect(qwenExt?.version).toBe('1.2.3');
      expect(qwenExt?.installMetadata?.credentialPersistence).toBe('stored');
      expect(pluginExt?.version).toBe('2.0.0');
      for (const extension of extensions) {
        expect(extension.skills).toBeUndefined();
        expect(extension.commands).toBeUndefined();
        expect(extension.agents).toBeUndefined();
        expect(extension.hooks).toBeUndefined();
        expect(extension.contextFiles).toEqual([]);
      }
    });

    it('leaves the manager cache and fingerprint baseline untouched', async () => {
      addExt({ name: 'ext-a' });
      const manager = createExtensionManager();

      await manager.refreshCatalogSnapshot();

      // The catalog is stateless (no cache entry, no fingerprint baseline), so
      // a manifest-only result must not mask a later refresh.
      expect(manager.getLoadedExtensions()).toEqual([]);
      expect(await manager.refreshCacheIfSourcesChanged()).toBe(true);
      expect(manager.getLoadedExtensions()).toHaveLength(1);
    });

    it('does not re-read subresources between catalog refreshes but picks up manifest edits', async () => {
      const extensionDir = addExt({ name: 'ext-a', addContextFile: true });
      const manager = createExtensionManager();

      const first = await manager.refreshCatalogSnapshot();
      expect(first.extensions[0]?.skills).toBeUndefined();
      expect(first.extensions[0]?.contextFiles).toEqual([]);

      // A skill-file-only edit leaves the catalog's inputs unchanged (the
      // fingerprint never covers skill files), so the same head reloads.
      writeTree(extensionDir, {
        'skills/s/SKILL.md': '---\nname: s\ndescription: d\n---\nbody',
      });
      const second = await manager.refreshCatalogSnapshot();
      expect(second.extensions).toHaveLength(1);
      expect(second.extensions[0]?.skills).toBeUndefined();

      writeManifest(extensionDir, { name: 'ext-a', version: '9.9.9' });
      const third = await manager.refreshCatalogSnapshot();
      expect(third.extensions.map((e) => e.version)).toEqual(['9.9.9']);
    });

    it('keeps the full-load fail semantics: corrupt manifest skipped, broken entry stat throws', async () => {
      addExt({ name: 'good-ext' });
      const badExtDir = writeTree(path.join(userExtensionsDir, 'bad-ext'), {
        [EXTENSIONS_CONFIG_FILENAME]: '{ "name": "bad-ext"',
      });

      const manager = createExtensionManager();
      const first = await manager.refreshCatalogSnapshot();
      expect(first.extensions.map((e) => e.name)).toEqual(['good-ext']);

      // A dangling symlink at the extensions root must fail the whole load,
      // mirroring `loadExtensionsFromExtensionsDir` fail-closed behavior.
      fs.rmSync(badExtDir, { recursive: true });
      fs.symlinkSync(path.join(userExtensionsDir, 'missing-target'), badExtDir);
      await expect(manager.refreshCatalogSnapshot()).rejects.toThrow();
    });

    it('excludes an extension whose manifest head throws, matching the full load', async () => {
      // The head's throws (manifest parse, id, v1 MCP load) define what the
      // full load rejects; the catalog must exclude the same or it advertises
      // ids that detail/enable/update reject. Subresource/MCP loaders swallow
      // errors, so the head throws via the MCP dependency, not a disk shape.
      addExt({ name: 'good-ext' });
      addPlugin('broken-plugin');
      const mcpSpy = vi
        .spyOn(
          await import('./agent-plugins-v1/index.js'),
          'loadAgentPluginMcpServers',
        )
        .mockRejectedValue(new Error('mcp unavailable'));

      try {
        const { extensions } = await ready();
        const fullNames = extensions.map((e) => e.name);
        expect(fullNames).toEqual(['good-ext']);

        const catalog = await createExtensionManager().refreshCatalogSnapshot();
        expect(catalog.extensions.map((e) => e.name)).toEqual(fullNames);
      } finally {
        mcpSpy.mockRestore();
      }
    });

    it('does not create the agent plugin data root', async () => {
      addPlugin('plugin-ext');
      const storeDir = path.join(tempHomeDir, 'catalog-store');
      const manager = createExtensionManager({
        extensionStore: new ExtensionStore({
          extensionsDir: userExtensionsDir,
          storeDir,
        }),
      });

      await manager.refreshCatalogSnapshot();

      expect(exists(storeDir, 'plugin-data')).toBe(false);
    });

    it('a name-filtered catalog only returns the requested extensions', async () => {
      addExt({ name: 'ext-a' });
      addExt({ name: 'ext-b' });
      const manager = createExtensionManager();

      const { extensions } = await manager.refreshCatalogSnapshot({
        names: ['ext-a'],
      });
      expect(extensions.map((e) => e.name)).toEqual(['ext-a']);
      expect(manager.getLoadedExtensions()).toEqual([]);
    });
  });

  describe('loadExtension', () => {
    it('uses the injected extension store root for discovery', async () => {
      const customExtensionsDir = path.join(tempHomeDir, 'custom-extensions');
      createExtension({
        extensionsDir: customExtensionsDir,
        name: 'custom-root-extension',
      });

      const { manager } = await ready({
        extensionStore: storeAt(customExtensionsDir),
      });

      expect(manager.getLoadedExtensions()).toHaveLength(1);
      expect(manager.getLoadedExtensions()[0]?.path).toBe(
        path.join(customExtensionsDir, 'custom-root-extension'),
      );
    });

    it('should include extension path in loaded extension', async () => {
      const extensionDir = addExt({ name: 'test-extension' });

      const { extensions } = await ready();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].path).toBe(extensionDir);
      expect(extensions[0].config.name).toBe('test-extension');
    });

    it('should load context file path when QWEN.md is present', async () => {
      addExt({ name: 'ext1', addContextFile: true });
      addExt({ name: 'ext2', version: '2.0.0' });

      const { extensions } = await ready();

      expect(extensions).toHaveLength(2);
      const ext1 = extensions.find((e) => e.config.name === 'ext1');
      const ext2 = extensions.find((e) => e.config.name === 'ext2');
      expect(ext1?.contextFiles).toEqual([
        path.join(userExtensionsDir, 'ext1', 'QWEN.md'),
      ]);
      expect(ext2?.contextFiles).toEqual([]);
    });

    it('should load context file path from the extension config', async () => {
      addExt({ name: 'ext1', contextFileName: 'my-context-file.md' });

      const { extensions } = await ready();

      expect(extensions).toHaveLength(1);
      const ext1 = extensions.find((e) => e.config.name === 'ext1');
      expect(ext1?.contextFiles).toEqual([
        path.join(userExtensionsDir, 'ext1', 'my-context-file.md'),
      ]);
    });

    it('should use default QWEN.md when contextFileName is empty array', async () => {
      writeTree(path.join(userExtensionsDir, 'ext-empty-context'), {
        [EXTENSIONS_CONFIG_FILENAME]: {
          name: 'ext-empty-context',
          version: '1.0.0',
          contextFileName: [],
        },
        'QWEN.md': 'context content',
      });

      const { extensions } = await ready();

      expect(extensions).toHaveLength(1);
      const ext = extensions.find((e) => e.config.name === 'ext-empty-context');
      expect(ext?.contextFiles).toEqual([
        path.join(userExtensionsDir, 'ext-empty-context', 'QWEN.md'),
      ]);
    });

    it.each([
      [
        'should skip extensions with invalid JSON and log a warning',
        'bad-ext',
        '{ "name": "bad-ext"', // Malformed
      ],
      [
        'should skip extensions with missing name and log a warning',
        'bad-ext-no-name',
        JSON.stringify({ version: '1.0.0' }),
      ],
    ])('%s', async (_title, badName, badConfig) => {
      addExt({ name: 'good-ext' });
      writeTree(path.join(userExtensionsDir, badName), {
        [EXTENSIONS_CONFIG_FILENAME]: badConfig,
      });

      const { extensions } = await ready();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].config.name).toBe('good-ext');
    });

    it('should skip extensions with invalid setting environment variable names', async () => {
      writeManifest(path.join(userExtensionsDir, 'bad-setting'), {
        name: 'bad-setting',
        version: '1.0.0',
        settings: [
          {
            name: 'API key',
            description: 'API key',
            envVar: 'API_KEY\nforged',
          },
        ],
      });

      const { extensions } = await ready();

      expect(extensions).toEqual([]);
    });

    it('should filter trust out of mcp servers', async () => {
      addExt({
        name: 'test-extension',
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
            trust: true,
          } as MCPServerConfig,
        },
      });

      const { extensions } = await ready();

      expect(extensions).toHaveLength(1);
      // trust is dropped from extension.mcpServers; config.mcpServers keeps it
      expect(extensions[0].mcpServers?.['test-server']?.trust).toBeUndefined();
      expect(extensions[0].config.mcpServers?.['test-server']?.trust).toBe(
        true,
      );
    });

    it('should only load explicitly named extensions when refreshCache is filtered', async () => {
      addExt({ name: 'ext1' });
      addExt({ name: 'ext2' });

      const manager = createExtensionManager();
      await manager.refreshCache({ names: ['ext2'] });
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].name).toBe('ext2');
    });

    it('keeps the previous cache when refreshCache fails before replacement', async () => {
      addExt({ name: 'stable-ext' });
      const { manager } = await ready();
      expect(loadedNames(manager)).toEqual(['stable-ext']);

      (manager as unknown as LoaderInternals).loadExtensionsFromExtensionsDir =
        rejectingWith('refresh failed');

      await expect(manager.refreshCache()).rejects.toThrow('refresh failed');
      expect(loadedNames(manager)).toEqual(['stable-ext']);
    });

    describe('command discovery', () => {
      it.each<[string, string, Record<string, string> | null, string[]]>([
        [
          'should discover .md command files',
          'md-commands-ext',
          { 'greet.md': 'Hello!', 'farewell.md': 'Bye!' },
          ['greet', 'farewell'],
        ],
        [
          'should discover .toml command files',
          'toml-commands-ext',
          {
            'caveman.toml':
              'prompt = "Talk like caveman"\ndescription = "Caveman mode"',
          },
          ['caveman'],
        ],
        [
          'should discover both .md and .toml command files',
          'mixed-commands-ext',
          {
            'greet.md': 'Hello!',
            'caveman.toml': 'prompt = "Talk like caveman"',
          },
          ['greet', 'caveman'],
        ],
        // No dedup at discovery level — both entries surface so the consent
        // UI shows the true count; downstream CommandService handles conflicts.
        [
          'should list both entries when .md and .toml exist for same command name',
          'dedup-commands-ext',
          { 'greet.md': 'Hello!', 'greet.toml': 'prompt = "Hello!"' },
          ['greet', 'greet'],
        ],
        [
          'should discover nested .toml command files with colon-separated names',
          'nested-toml-ext',
          { 'caveman/intensity.toml': 'prompt = "Switch intensity"' },
          ['caveman:intensity'],
        ],
        [
          'should replace colons in path segments with underscores',
          'colon-name-ext',
          { 'foo:bar.md': 'content' },
          ['foo_bar'],
        ],
        [
          'should return empty commands when commands directory does not exist',
          'no-cmd-dir-ext',
          null,
          [],
        ],
        [
          'should return empty commands when no .md or .toml files exist',
          'no-commands-ext',
          { 'readme.txt': 'not a cmd' },
          [],
        ],
      ])('%s', async (_title, name, commands, expected) => {
        // colons are forbidden in filenames on macOS/Windows
        if (name === 'colon-name-ext' && process.platform !== 'linux') return;
        const extDir = addExt({ name });
        if (commands) writeTree(path.join(extDir, 'commands'), commands);

        const { extensions } = await ready();

        const ext = extensions.find((e) => e.config.name === name);
        // Several distinct commands are matched in any order.
        if (new Set(expected).size > 1) {
          expect(ext?.commands).toEqual(expect.arrayContaining(expected));
          expect(ext?.commands).toHaveLength(expected.length);
        } else {
          expect(ext?.commands).toEqual(expected);
        }
      });

      it('should discover commands under symlinked subdirectories', async () => {
        // The pre-readdir glob ran with `follow: true`, so a linked
        // subdirectory's commands were discovered; the traversal must
        // descend into it or a `type: 'link'` install's command set is
        // silently truncated (and stamped up to date).
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'linked-commands-ext',
          version: '1.0.0',
        });
        const realDir = path.join(extDir, 'real-commands');
        fs.mkdirSync(path.join(realDir, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(realDir, 'a.md'), 'A');
        fs.writeFileSync(path.join(realDir, 'sub', 'b.md'), 'B');
        const commandsDir = path.join(extDir, 'commands');
        fs.mkdirSync(commandsDir, { recursive: true });
        fs.writeFileSync(path.join(commandsDir, 'linkfile.md'), 'linkfile');
        fs.symlinkSync(realDir, path.join(commandsDir, 'linked'), 'dir');

        const manager = createExtensionManager();
        await manager.refreshCache();
        const ext = manager
          .getLoadedExtensions()
          .find((e) => e.config.name === 'linked-commands-ext');
        expect(ext?.commands?.slice().sort()).toEqual([
          'linked:a',
          'linked:sub:b',
          'linkfile',
        ]);
      });

      it('should discover symlinked command files and skip dangling links', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'symlink-file-commands-ext',
          version: '1.0.0',
        });
        const commandsDir = path.join(extDir, 'commands');
        fs.mkdirSync(commandsDir, { recursive: true });
        fs.writeFileSync(path.join(commandsDir, 'real.md'), 'real');
        fs.symlinkSync(
          path.join(commandsDir, 'real.md'),
          path.join(commandsDir, 'alias.md'),
        );
        fs.symlinkSync(
          path.join(commandsDir, 'gone.md'),
          path.join(commandsDir, 'dangling.md'),
        );

        const manager = createExtensionManager();
        await manager.refreshCache();
        const ext = manager
          .getLoadedExtensions()
          .find((e) => e.config.name === 'symlink-file-commands-ext');
        expect(ext?.commands?.slice().sort()).toEqual(['alias', 'real']);
      });

      it('should terminate on symlinked directory cycles', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'cycle-commands-ext',
          version: '1.0.0',
        });
        const commandsDir = path.join(extDir, 'commands');
        fs.mkdirSync(commandsDir, { recursive: true });
        fs.writeFileSync(path.join(commandsDir, 'top.md'), 'top');
        fs.symlinkSync(commandsDir, path.join(commandsDir, 'loop'), 'dir');

        const manager = createExtensionManager();
        await manager.refreshCache();
        const ext = manager
          .getLoadedExtensions()
          .find((e) => e.config.name === 'cycle-commands-ext');
        // The cycle is followed once and then cut by the realpath
        // visited-set, so the walk terminates instead of recursing until
        // the kernel's ELOOP limit.
        expect(ext?.commands?.slice().sort()).toEqual(['loop:top', 'top']);
      });

      it('should discover commands when readdir reports no entry types (DT_UNKNOWN)', async () => {
        // A filesystem whose readdir reports no d_type (FUSE without
        // readdirplus, XFS without ftype, some NFS servers) yields dirents
        // whose type predicates are all false. The walk must resolve those
        // with lstat — the glob it replaced did — or every command the
        // extension provides disappears while the refresh is stamped up to
        // date, so it never retries.
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'untyped-dirents-ext',
          version: '1.0.0',
        });
        const commandsDir = path.join(extDir, 'commands');
        fs.mkdirSync(path.join(commandsDir, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(commandsDir, 'top.md'), 'top');
        fs.writeFileSync(path.join(commandsDir, 'sub', 'nested.md'), 'nested');

        fsProbe.untypedDirentsFor = `${path.sep}commands`;
        try {
          const manager = createExtensionManager();
          await manager.refreshCache();
          const ext = manager
            .getLoadedExtensions()
            .find((e) => e.config.name === 'untyped-dirents-ext');
          expect(ext?.commands?.slice().sort()).toEqual(['sub:nested', 'top']);
        } finally {
          fsProbe.untypedDirentsFor = undefined;
        }
      });

      it.skipIf(
        process.platform === 'win32' ||
          (typeof process.getuid === 'function' && process.getuid() === 0),
      )(
        'should keep the readable commands when a subdirectory is unreadable',
        async () => {
          // A single recursive readdir rejects the whole walk on an EACCES
          // subdirectory, which the catch would launder into `commands: []`
          // for the extension; walking per directory keeps glob's old
          // short-listing behavior — only the unreadable subtree is lost.
          const extDir = createExtension({
            extensionsDir: userExtensionsDir,
            name: 'locked-commands-ext',
            version: '1.0.0',
          });
          const commandsDir = path.join(extDir, 'commands');
          fs.mkdirSync(path.join(commandsDir, 'ok'), { recursive: true });
          const lockedDir = path.join(commandsDir, 'locked');
          fs.mkdirSync(lockedDir, { recursive: true });
          fs.writeFileSync(path.join(commandsDir, 'ok', 'deploy.md'), 'Deploy');
          fs.writeFileSync(path.join(lockedDir, 'hidden.md'), 'Hidden');
          fs.chmodSync(lockedDir, 0o000);
          try {
            const manager = createExtensionManager();
            await manager.refreshCache();
            const ext = manager
              .getLoadedExtensions()
              .find((e) => e.config.name === 'locked-commands-ext');
            expect(ext?.commands).toEqual(['ok:deploy']);
          } finally {
            fs.chmodSync(lockedDir, 0o755);
          }
        },
      );

      it('should match command extensions case-insensitively only where the platform glob did', async () => {
        // The removed glob matched case-insensitively via its platform
        // default (nocase on macOS/Windows); FileCommandLoader still globs
        // with that default, so the discovery set must follow the same
        // platform split or the consent listing and the runnable set
        // diverge.
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'case-commands-ext',
          version: '1.0.0',
        });
        const commandsDir = path.join(extDir, 'commands');
        fs.mkdirSync(commandsDir, { recursive: true });
        fs.writeFileSync(path.join(commandsDir, 'Upper.MD'), 'upper');

        const manager = createExtensionManager();
        await manager.refreshCache();
        const ext = manager
          .getLoadedExtensions()
          .find((e) => e.config.name === 'case-commands-ext');
        const platformGlobMatched =
          process.platform === 'darwin' || process.platform === 'win32';
        expect(ext?.commands).toEqual(platformGlobMatched ? ['Upper'] : []);
      });
    });

    it('loads valid extensions concurrently and skips invalid ones', async () => {
      for (let i = 0; i < 8; i += 1) {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: `valid-ext-${i}`,
          version: '1.0.0',
        });
        for (let s = 0; s < 4; s += 1) {
          const skillDir = path.join(extDir, 'skills', `skill-${s}`);
          fs.mkdirSync(skillDir, { recursive: true });
          fs.writeFileSync(
            path.join(skillDir, 'SKILL.md'),
            `---\nname: skill-${s}\ndescription: Skill ${s}\n---\nBody`,
          );
        }
        const agentsDir = path.join(extDir, 'agents');
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(
          path.join(agentsDir, 'agent.md'),
          '---\nname: agent\ndescription: Agent\n---\nYou are a benchmark agent prompt.',
        );
      }
      // A corrupt manifest: loadExtension must skip it without throwing.
      const corruptDir = path.join(userExtensionsDir, 'corrupt-ext');
      fs.mkdirSync(corruptDir, { recursive: true });
      fs.writeFileSync(
        path.join(corruptDir, EXTENSIONS_CONFIG_FILENAME),
        '{not json',
      );
      // A valid extension mixing a broken skill and a broken agent with good
      // entries: the broken ones are dropped, the rest still load.
      const mixedDir = createExtension({
        extensionsDir: userExtensionsDir,
        name: 'mixed-ext',
        version: '1.0.0',
      });
      fs.mkdirSync(path.join(mixedDir, 'skills', 'good'), { recursive: true });
      fs.writeFileSync(
        path.join(mixedDir, 'skills', 'good', 'SKILL.md'),
        '---\nname: good\ndescription: Good skill\n---\nBody',
      );
      fs.mkdirSync(path.join(mixedDir, 'skills', 'bad'), { recursive: true });
      fs.writeFileSync(
        path.join(mixedDir, 'skills', 'bad', 'SKILL.md'),
        'no frontmatter here',
      );
      fs.mkdirSync(path.join(mixedDir, 'agents'), { recursive: true });
      fs.writeFileSync(
        path.join(mixedDir, 'agents', 'good.md'),
        '---\nname: good-agent\ndescription: Good agent\n---\nYou are a good agent prompt.',
      );
      fs.writeFileSync(
        path.join(mixedDir, 'agents', 'broken.md'),
        '---\nname: broken-agent\n---\nPrompt',
      );

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      const names = extensions.map((e) => e.config.name).sort();
      expect(names).toEqual([
        'mixed-ext',
        ...[...Array(8).keys()].map((i) => `valid-ext-${i}`),
      ]);

      const mixed = extensions.find((e) => e.config.name === 'mixed-ext');
      expect(mixed?.skills?.map((s) => s.name)).toEqual(['good']);
      expect(mixed?.agents?.map((a) => a.name)).toEqual(['good-agent']);
      for (const valid of extensions.filter((e) =>
        e.config.name.startsWith('valid-ext-'),
      )) {
        expect(valid.skills).toHaveLength(4);
        expect(valid.agents).toHaveLength(1);
      }
    });

    it('keeps concurrent manifest reads within the shared descriptor gate', async () => {
      // A large nested fan-out (many extensions × many skills/agents) must
      // hold total in-flight SKILL.md reads at or under SKILL_LOAD_CONCURRENCY
      // — the gate is module-wide, so per-level caps multiplying across the
      // extensions → loaders → files nesting would otherwise blow past it
      // under a low RLIMIT_NOFILE and silently truncate the load.
      const EXTENSIONS = 40;
      const SKILLS = 24;
      for (let i = 0; i < EXTENSIONS; i += 1) {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: `gate-ext-${i}`,
          version: '1.0.0',
        });
        for (let s = 0; s < SKILLS; s += 1) {
          const skillDir = path.join(extDir, 'skills', `skill-${s}`);
          fs.mkdirSync(skillDir, { recursive: true });
          fs.writeFileSync(
            path.join(skillDir, 'SKILL.md'),
            `---\nname: skill-${s}\ndescription: Skill ${s}\n---\nBody`,
          );
        }
      }

      const manager = createExtensionManager();
      await manager.refreshCache();

      const extensions = manager.getLoadedExtensions();
      expect(extensions).toHaveLength(EXTENSIONS);
      for (const extension of extensions) {
        expect(extension.skills).toHaveLength(SKILLS);
      }
      expect(peakDescriptorGateInFlight()).toBeLessThanOrEqual(
        SKILL_LOAD_CONCURRENCY,
      );
      // Sanity: the gate must have observed real concurrency, otherwise this
      // test proves nothing.
      expect(peakDescriptorGateInFlight()).toBeGreaterThan(1);
    });

    it(
      'does not wedge the descriptor gate across repeated failed scans',
      // The failing generations do real work (each waits for its in-flight
      // siblings to finish loading ~1200 skills before the batch settles), so
      // this test carries its own generous timeout. The assertion that
      // matters is that it settles at all: on the pre-fix code this exact
      // fixture hangs past any timeout because the gate pool is exhausted.
      { timeout: 240_000 },
      async () => {
        // A dangling symlink makes every refresh reject (its statSync throw
        // propagates). The rejection must not leak gate permits held by
        // in-flight siblings: repeated failed scans previously stacked
        // orphaned permit holders until the module-wide pool was exhausted
        // and every subsequent load in the process hung forever.
        // ceil(64 / (8 - 1)) + 1 failing scans is past the old wedge point.
        // The wedge needs at least 2 concurrent extensions (one failing, one
        // holding permits), so bail out loudly if the constants ever change
        // to make that impossible.
        const WEDGE_EXTENSIONS = EXTENSION_SCAN_CONCURRENCY - 1;
        if (WEDGE_EXTENSIONS < 1) {
          throw new Error(
            `EXTENSION_SCAN_CONCURRENCY=${EXTENSION_SCAN_CONCURRENCY} leaves no surviving sibling for the wedge scenario; rewrite this test against the new constants`,
          );
        }
        const FAILING_SCANS =
          Math.ceil(SKILL_LOAD_CONCURRENCY / WEDGE_EXTENSIONS) + 1;
        await fsp.symlink(
          path.join(tempHomeDir, 'missing'),
          path.join(userExtensionsDir, 'aaa-dangling'),
        );
        for (let i = 0; i < WEDGE_EXTENSIONS; i += 1) {
          const extDir = createExtension({
            extensionsDir: userExtensionsDir,
            name: `wedge-ext-${i}`,
            version: '1.0.0',
          });
          // Enough per-extension work that abandoned siblings of a failed
          // batch still hold gate permits when the next refresh starts — the
          // wedge needs retry traffic to outpace orphan reclamation (the
          // review's witness used ~3000 skills per extension).
          for (let s = 0; s < 1200; s += 1) {
            const skillDir = path.join(extDir, 'skills', `skill-${s}`);
            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(
              path.join(skillDir, 'SKILL.md'),
              `---\nname: skill-${s}\ndescription: Skill ${s}\n---\nBody`,
            );
          }
        }

        const manager = createExtensionManager();
        for (let i = 0; i < FAILING_SCANS; i += 1) {
          await expect(manager.refreshCache()).rejects.toThrow(/aaa-dangling/);
        }
        // The pool must still admit work: a fresh manager over the same
        // store (still failing on the symlink) settles — rejects, not hangs —
        // and removing the symlink makes loads succeed again.
        const recovered = createExtensionManager();
        await expect(recovered.refreshCache()).rejects.toThrow(/aaa-dangling/);
        fs.unlinkSync(path.join(userExtensionsDir, 'aaa-dangling'));
        await recovered.refreshCache();
        const recoveredExtensions = recovered.getLoadedExtensions();
        expect(recoveredExtensions).toHaveLength(WEDGE_EXTENSIONS);
        // Assert content, not just presence: every recovered extension must
        // carry the skills the failed generations scanned.
        for (const extension of recoveredExtensions) {
          expect(extension.skills).toHaveLength(1200);
        }
      },
    );

    describe('resource exhaustion', () => {
      // Arm the module-level probe to fail reads whose path contains
      // failPath; disarm on the returned call (always via try/finally).
      function armReadFileProbe(failPath: string): () => void {
        fsProbe.failReadFileFor = failPath;
        return () => {
          fsProbe.failReadFileFor = undefined;
        };
      }

      it('fails the whole refresh closed when a skill read hits resource exhaustion', async () => {
        // loadExtension's catch-all classifies per-extension failures; a
        // resource-exhaustion errno must reject the refresh rather than
        // commit a cache with this extension silently dropped — the cache
        // fingerprint is stamped from pre-load disk state, so a truncated
        // commit would stick until restart.
        createExtension({
          extensionsDir: userExtensionsDir,
          name: 'good-ext',
        });
        const emfileExtDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'emfile-ext',
        });
        const skillDir = path.join(emfileExtDir, 'skills', 's1');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, 'SKILL.md'),
          '---\nname: s1\ndescription: S1\n---\nBody',
        );

        const manager = createExtensionManager();
        await manager.refreshCache();
        expect(manager.getLoadedExtensions()).toHaveLength(2);

        // Move the fingerprint so the retry leg below has something to do.
        createExtension({
          extensionsDir: userExtensionsDir,
          name: 'later-ext',
        });

        const disarm = armReadFileProbe('emfile-ext');
        await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
        // The rejected refresh never committed: the previous cache survives.
        expect(
          manager
            .getLoadedExtensions()
            .map((e) => e.name)
            .sort(),
        ).toEqual(['emfile-ext', 'good-ext']);
        disarm();

        // The rejection never stamped a baseline either, so the next check
        // retries and loads everything.
        await expect(manager.refreshCacheIfSourcesChanged()).resolves.toBe(
          true,
        );
        expect(
          manager
            .getLoadedExtensions()
            .map((e) => e.name)
            .sort(),
        ).toEqual(['emfile-ext', 'good-ext', 'later-ext']);
      });

      it('fails the refresh closed when an install-metadata read hits resource exhaustion', async () => {
        // The sidecar's blanket "no metadata" catch must not launder the
        // errno: a linked extension whose sidecar cannot be read would
        // silently vanish from the load.
        createExtension({
          extensionsDir: userExtensionsDir,
          name: 'good-ext',
        });
        const manager = createExtensionManager();

        fsProbe.failReadFileSyncFor = INSTALL_METADATA_FILENAME;
        try {
          await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
        } finally {
          fsProbe.failReadFileSyncFor = undefined;
        }
      });

      it('fails the refresh closed when a workflow read hits resource exhaustion', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'wf-ext',
        });
        const workflowsDir = path.join(extDir, 'workflows');
        fs.mkdirSync(workflowsDir, { recursive: true });
        fs.writeFileSync(
          path.join(workflowsDir, 'audit.js'),
          "export const meta = { name: 'audit', description: 'Runs audit' };\nreturn 1;\n",
        );
        const manager = createExtensionManager();

        const disarm = armReadFileProbe(`${path.sep}workflows${path.sep}`);
        await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
        disarm();
      });

      it('fails the refresh closed instead of committing an empty cache when the extensions readdir hits resource exhaustion', async () => {
        createExtension({
          extensionsDir: userExtensionsDir,
          name: 'good-ext',
        });
        const manager = createExtensionManager();
        await manager.refreshCache();
        expect(manager.getLoadedExtensions()).toHaveLength(1);

        createExtension({
          extensionsDir: userExtensionsDir,
          name: 'later-ext',
        });

        // Fault only the loader's readdir, not the fingerprint's (the
        // fingerprint runs first on the same directory): the probe's first
        // armed call belongs to the fingerprint, every later one to the
        // loader.
        fsProbe.readdirSyncCalls = 0;
        fsProbe.failReaddirSyncFor = userExtensionsDir;
        try {
          await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
        } finally {
          fsProbe.failReaddirSyncFor = undefined;
        }
        // The failed refresh must not have replaced the committed cache
        // with an empty set.
        expect(manager.getLoadedExtensions().map((e) => e.name)).toEqual([
          'good-ext',
        ]);

        await expect(manager.refreshCacheIfSourcesChanged()).resolves.toBe(
          true,
        );
        expect(
          manager
            .getLoadedExtensions()
            .map((e) => e.name)
            .sort(),
        ).toEqual(['good-ext', 'later-ext']);
      });

      it('fails a named refresh closed instead of committing an empty cache when the extensions-root existence check hits resource exhaustion', async () => {
        // loadExtensionByName guards the extensions root: a bare existsSync
        // there folds EMFILE into "absent", every requested name resolves to
        // null, and the "successful" named refresh commits an empty cache —
        // no error, no retry. The existsSync probe is exactly the false
        // fs.existsSync itself produces under exhaustion; the accessSync
        // probe faults existsSyncOrThrow's errno-preserving replacement at
        // that same guard.
        createExtension({
          extensionsDir: userExtensionsDir,
          name: 'some-ext',
        });
        const manager = createExtensionManager();
        await manager.refreshCache();
        expect(manager.getLoadedExtensions()).toHaveLength(1);

        fsProbe.falseExistsSyncFor = userExtensionsDir;
        fsProbe.failAccessSyncFor = userExtensionsDir;
        try {
          await expect(
            manager.refreshCache({ names: ['some-ext'] }),
          ).rejects.toThrow('EMFILE');
        } finally {
          fsProbe.falseExistsSyncFor = undefined;
          fsProbe.failAccessSyncFor = undefined;
        }
        // The rejected named refresh never committed: the previously cached
        // extension survives.
        expect(manager.getLoadedExtensions().map((e) => e.name)).toEqual([
          'some-ext',
        ]);

        // A retried named refresh recovers.
        await manager.refreshCache({ names: ['some-ext'] });
        expect(manager.getLoadedExtensions().map((e) => e.name)).toEqual([
          'some-ext',
        ]);

        // A genuinely absent root must still resolve quietly to null: a
        // first-run machine with no extensions dir gets an empty result,
        // not an ENOENT throw.
        fs.rmSync(userExtensionsDir, { recursive: true, force: true });
        await expect(
          manager.loadExtensionByName('some-ext'),
        ).resolves.toBeNull();
      });

      it('keeps executor refusals dispatchable for an extension whose scan died of resource exhaustion', async () => {
        // Cold-start leg: with no previous cache to fall back to, the
        // refusals a scan recorded before it died must still gate dispatch —
        // a by-name load of the refused name refuses instead of silently
        // resolving the same-named builtin.
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'emfile-agents-ext',
        });
        const agentsDir = path.join(extDir, 'agents');
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(
          path.join(agentsDir, 'explore.md'),
          '---\nname: explore\ndescription: Explore agent\nexecutor: {kind: invalid, command: runner}\n---\nExplore carefully.',
        );
        fs.writeFileSync(
          path.join(agentsDir, 'other.md'),
          '---\nname: other\ndescription: Other agent\n---\nYou are a benchmark agent prompt.',
        );

        const disarm = armReadFileProbe('other.md');
        const manager = createExtensionManager();
        await expect(manager.refreshCache()).rejects.toThrow('EMFILE');

        expect(manager.getLoadedExtensions()).toEqual([]);
        const pending = manager
          .getPendingScanRefusals()
          .get('emfile-agents-ext');
        expect(pending?.get('explore')).toBeInstanceOf(SubagentError);
        disarm();

        // Recovery publishes the complete extension and its fresh refusals.
        await manager.refreshCache();
        const loaded = manager
          .getLoadedExtensions()
          .find((extension) => extension.name === 'emfile-agents-ext');
        expect(loaded?.agents?.map((agent) => agent.name)).toEqual(['other']);
        expect(loaded?.agentExecutorRefusals?.get('explore')).toBeInstanceOf(
          SubagentError,
        );
      });

      it("merges a dying scan's refusals even when the surfaced rejection is not the exhaustion errno", async () => {
        // aaa-dangling's statSync ENOENT sorts ahead of emfile-agents-ext's
        // EMFILE in the settled batch (scheduleWithConcurrency rethrows the
        // lowest-index rejection), so the refresh rejects with the symlink's
        // errno — the refusal merge must key on what the attempt recorded,
        // not on which error happened to surface.
        fs.symlinkSync(
          path.join(userExtensionsDir, 'missing-target'),
          path.join(userExtensionsDir, 'aaa-dangling'),
        );
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'emfile-agents-ext',
        });
        const agentsDir = path.join(extDir, 'agents');
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(
          path.join(agentsDir, 'explore.md'),
          '---\nname: explore\ndescription: Explore agent\nexecutor: {kind: invalid, command: runner}\n---\nExplore carefully.',
        );
        fs.writeFileSync(
          path.join(agentsDir, 'other.md'),
          '---\nname: other\ndescription: Other agent\n---\nYou are a benchmark agent prompt.',
        );

        const disarm = armReadFileProbe('other.md');
        const manager = createExtensionManager();
        await expect(manager.refreshCache()).rejects.toThrow(/aaa-dangling/);
        expect(manager.getLoadedExtensions()).toEqual([]);
        const pending = manager
          .getPendingScanRefusals()
          .get('emfile-agents-ext');
        expect(pending?.get('explore')).toBeInstanceOf(SubagentError);
        disarm();
      });

      it('fails the refresh closed when the commands enumeration hits resource exhaustion', async () => {
        // The commands listing must surface its errno: swallowing an EMFILE
        // here would commit `commands: []` and stamp it up to date, silently
        // uninstalling every extension's slash commands for the session.
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'cmd-ext',
        });
        const commandsDir = path.join(extDir, 'commands');
        fs.mkdirSync(commandsDir, { recursive: true });
        fs.writeFileSync(path.join(commandsDir, 'deploy.md'), 'Deploy it');

        const manager = createExtensionManager();
        fsProbe.readdirArgs = [];
        await manager.refreshCache();
        expect(manager.getLoadedExtensions()[0]?.commands).toEqual(['deploy']);
        // Separator-parity witness (R17-2): the root commands walk argument
        // is path.join-normalized by the production call site, so the
        // `${path.sep}commands` probe key below matches it on Windows too —
        // a template-`${ext}/commands` call site would build a mixed-separator
        // path the probe can never see there.
        const commandsReads = fsProbe.readdirArgs.filter((arg) =>
          arg.includes(`${path.sep}commands`),
        );
        expect(commandsReads[0]).toBe(path.join(extDir, 'commands'));

        fsProbe.failReaddirFor = `${path.sep}commands`;
        try {
          await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
        } finally {
          fsProbe.failReaddirFor = undefined;
        }
        expect(manager.getLoadedExtensions().map((e) => e.name)).toEqual([
          'cmd-ext',
        ]);
      });

      it('fails the refresh closed when a hooks sidecar read hits resource exhaustion', async () => {
        // A missing or unparsable hooks file stays warn-and-continue (hooks
        // are optional), but an EMFILE there must not be parsed as "bad
        // hooks file" — that would commit a load that silently lost the
        // extension's hooks.
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'hooks-ext',
        });
        const hooksDir = path.join(extDir, 'hooks');
        fs.mkdirSync(hooksDir, { recursive: true });
        fs.writeFileSync(
          path.join(hooksDir, 'hooks.json'),
          JSON.stringify({ hooks: {} }),
        );

        const manager = createExtensionManager();
        await manager.refreshCache();
        expect(manager.getLoadedExtensions()).toHaveLength(1);

        fsProbe.failReadFileSyncFor = 'hooks.json';
        try {
          await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
        } finally {
          fsProbe.failReadFileSyncFor = undefined;
        }
        expect(manager.getLoadedExtensions().map((e) => e.name)).toEqual([
          'hooks-ext',
        ]);
      });

      it('fails the refresh closed when a manifest config read hits resource exhaustion', async () => {
        // The manifest rewrap drops `code`, so an EMFILE from the config
        // read must be rethrown unwrapped — otherwise the classification at
        // loadExtension's catch misreads it as a parse failure and drops the
        // whole extension from a load reported as successful.
        createExtension({
          extensionsDir: userExtensionsDir,
          name: 'good-ext',
        });
        const manager = createExtensionManager();
        await manager.refreshCache();
        expect(manager.getLoadedExtensions()).toHaveLength(1);

        fsProbe.failReadFileSyncFor = EXTENSIONS_CONFIG_FILENAME;
        try {
          await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
        } finally {
          fsProbe.failReadFileSyncFor = undefined;
        }
        expect(manager.getLoadedExtensions().map((e) => e.name)).toEqual([
          'good-ext',
        ]);
      });

      it('fails the refresh closed when an Agent Plugins manifest probe read hits resource exhaustion', async () => {
        // getAgentPluginSchemaStatus reads plugin.json before the manifest
        // branch runs; its blanket "unrelated" catch must not launder an
        // EMFILE into a skip of the whole extension.
        const pluginRoot = path.join(userExtensionsDir, 'plugin-ext');
        createAgentPlugin(pluginRoot, { name: 'plugin-ext' });
        const manager = createExtensionManager();
        await manager.refreshCache();
        expect(manager.getLoadedExtensions().map((e) => e.name)).toEqual([
          'plugin-ext',
        ]);

        fsProbe.failReadFileSyncFor = 'plugin.json';
        try {
          await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
        } finally {
          fsProbe.failReadFileSyncFor = undefined;
        }
        expect(manager.getLoadedExtensions().map((e) => e.name)).toEqual([
          'plugin-ext',
        ]);
      });

      it('fails the refresh closed when an Agent Plugins manifest config read hits resource exhaustion', async () => {
        // Same errno preservation as the qwen manifest branch: the status
        // probe reads pass (skipped here), and the fault lands on
        // loadAgentPluginManifest's own read — the rewrap there must not
        // strip `code`, or the extension is dropped from a "successful"
        // load.
        const pluginRoot = path.join(userExtensionsDir, 'plugin-ext');
        createAgentPlugin(pluginRoot, { name: 'plugin-ext' });
        const manager = createExtensionManager();
        await manager.refreshCache();
        expect(manager.getLoadedExtensions().map((e) => e.name)).toEqual([
          'plugin-ext',
        ]);

        // plugin.json is read by the fingerprint's schema probe and by the
        // loader's schema probe before loadAgentPluginManifest reads it;
        // let those two through and fault the manifest read itself.
        fsProbe.failReadFileSyncFor = 'plugin.json';
        fsProbe.failReadFileSyncSkip = 2;
        try {
          await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
        } finally {
          fsProbe.failReadFileSyncFor = undefined;
          fsProbe.failReadFileSyncSkip = 0;
        }
        expect(manager.getLoadedExtensions().map((e) => e.name)).toEqual([
          'plugin-ext',
        ]);
      });

      it('keeps executor refusals dispatchable when a sibling loader dies first', async () => {
        // The skills leg rejects per-entry while the agents leg folds its
        // refusals into the caller's map only after its whole batch settles.
        // A fast-rejecting Promise.all would read the map before that fold
        // ran; the delayed agent read pins the ordering deterministically.
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'race-ext',
        });
        const skillDir = path.join(extDir, 'skills', 's1');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, 'SKILL.md'),
          '---\nname: s1\ndescription: S1\n---\nBody',
        );
        const agentsDir = path.join(extDir, 'agents');
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(
          path.join(agentsDir, 'explore.md'),
          '---\nname: explore\ndescription: Explore agent\nexecutor: {kind: invalid, command: runner}\n---\nExplore carefully.',
        );

        const manager = createExtensionManager();
        fsProbe.failReadFileFor = `${path.sep}skills${path.sep}`;
        fsProbe.delayReadFileFor = `${path.sep}agents${path.sep}`;
        try {
          await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
        } finally {
          fsProbe.failReadFileFor = undefined;
          fsProbe.delayReadFileFor = undefined;
        }
        expect(manager.getLoadedExtensions()).toEqual([]);
        const pending = manager.getPendingScanRefusals().get('race-ext');
        expect(pending?.get('explore')).toBeInstanceOf(SubagentError);
      });

      it("keeps a dying refresh's refusals when an overlapping refresh starts mid-settle", async () => {
        // A records refusals while its slow sibling settles. B must not
        // erase those attempt-local records when it starts in that window.
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'emfile-agents-ext',
        });
        const agentsDir = path.join(extDir, 'agents');
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(
          path.join(agentsDir, 'explore.md'),
          '---\nname: explore\ndescription: Explore agent\nexecutor: {kind: invalid, command: runner}\n---\nExplore carefully.',
        );
        fs.writeFileSync(
          path.join(agentsDir, 'other.md'),
          '---\nname: other\ndescription: Other agent\n---\nYou are a benchmark agent prompt.',
        );
        const slowDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'slow-ext',
        });
        const slowSkillDir = path.join(slowDir, 'skills', 's1');
        fs.mkdirSync(slowSkillDir, { recursive: true });
        fs.writeFileSync(
          path.join(slowSkillDir, 'SKILL.md'),
          '---\nname: s1\ndescription: S1\n---\nBody',
        );

        fsProbe.failReadFileFor = 'other.md';
        fsProbe.delayReadFileFor = 'slow-ext';
        const manager = createExtensionManager();
        try {
          const refreshA = manager.refreshCache();
          // B fails before discovering agents, so only A can preserve them.
          await new Promise((resolve) => setTimeout(resolve, 30));
          fsProbe.failReadFileFor = undefined;
          fsProbe.delayReadFileFor = undefined;
          fsProbe.failReadFileSyncFor = EXTENSIONS_CONFIG_FILENAME;
          const refreshB = manager.refreshCache();
          // Attach B's rejection handler before awaiting A: B's scan waits
          // on A's store mutex, so B can reject in the same microtask window
          // in which A settles. Awaiting A first leaves B momentarily
          // handlerless and surfaces an unhandled rejection.
          // eslint-disable-next-line vitest/valid-expect
          const refreshBRejection = expect(refreshB).rejects.toThrow('EMFILE');
          await expect(refreshA).rejects.toThrow('EMFILE');
          await refreshBRejection;
        } finally {
          fsProbe.failReadFileFor = undefined;
          fsProbe.delayReadFileFor = undefined;
          fsProbe.failReadFileSyncFor = undefined;
        }
        expect(manager.getLoadedExtensions()).toEqual([]);
        const pending = manager
          .getPendingScanRefusals()
          .get('emfile-agents-ext');
        expect(pending?.get('explore')).toBeInstanceOf(SubagentError);
      });

      it('keeps the warm cache intact and records fresh refusals separately', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'warm-ext',
        });
        const agentsDir = path.join(extDir, 'agents');
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(
          path.join(agentsDir, 'good.md'),
          '---\nname: good\ndescription: Good agent\n---\nYou are a benchmark agent prompt.',
        );
        const skillDir = path.join(extDir, 'skills', 's1');
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, 'SKILL.md'),
          '---\nname: s1\ndescription: S1\n---\nBody',
        );

        const manager = createExtensionManager();
        await manager.refreshCache();
        expect(
          manager.getLoadedExtensions()[0]?.agents?.map((a) => a.name),
        ).toEqual(['good']);

        fs.writeFileSync(
          path.join(agentsDir, 'reviewer.md'),
          '---\nname: reviewer\ndescription: Review agent\nexecutor: {kind: invalid, command: runner}\n---\nReview carefully.',
        );
        const disarm = armReadFileProbe(`${path.sep}skills${path.sep}`);
        await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
        disarm();

        const cached = manager
          .getLoadedExtensions()
          .find((extension) => extension.name === 'warm-ext');
        expect(cached?.agents?.map((a) => a.name)).toEqual(['good']);
        expect(cached?.skills?.map((s) => s.name)).toEqual(['s1']);
        expect(cached?.agentExecutorRefusals?.has('reviewer')).toBe(false);
        expect(
          manager.getPendingScanRefusals().get('warm-ext')?.get('reviewer'),
        ).toBeInstanceOf(SubagentError);
      });

      it('keeps refusals an extension recorded when a sibling kills the refresh', async () => {
        const refusalDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'aaa-refusal-ext',
        });
        const agentsDir = path.join(refusalDir, 'agents');
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(
          path.join(agentsDir, 'reviewer.md'),
          '---\nname: reviewer\ndescription: Review agent\nexecutor: {kind: invalid, command: runner}\n---\nReview carefully.',
        );
        const dyingDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'dying-ext',
        });
        const dyingSkillDir = path.join(dyingDir, 'skills', 's1');
        fs.mkdirSync(dyingSkillDir, { recursive: true });
        fs.writeFileSync(
          path.join(dyingSkillDir, 'SKILL.md'),
          '---\nname: s1\ndescription: S1\n---\nBody',
        );

        const disarm = armReadFileProbe(`${path.sep}dying-ext${path.sep}`);
        const manager = createExtensionManager();
        await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
        disarm();
        expect(manager.getLoadedExtensions()).toEqual([]);
        const pending = manager.getPendingScanRefusals().get('aaa-refusal-ext');
        expect(pending?.get('reviewer')).toBeInstanceOf(SubagentError);
      });

      it('publishes no runtime surface from a failed scan', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'tombstone-ext',
        });
        fs.writeFileSync(
          path.join(extDir, EXTENSIONS_CONFIG_FILENAME),
          JSON.stringify({
            name: 'tombstone-ext',
            version: '1.0.0',
            mcpServers: {
              'refused-server': { command: 'node', args: ['server.js'] },
            },
            lspServers: { probeLsp: { command: 'probe-lsp' } },
          }),
        );
        const agentsDir = path.join(extDir, 'agents');
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(
          path.join(agentsDir, 'explore.md'),
          '---\nname: explore\ndescription: Explore agent\nexecutor: {kind: invalid, command: runner}\n---\nExplore carefully.',
        );
        fs.writeFileSync(
          path.join(agentsDir, 'other.md'),
          '---\nname: other\ndescription: Other agent\n---\nYou are a benchmark agent prompt.',
        );

        const disarm = armReadFileProbe('other.md');
        const manager = createExtensionManager();
        await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
        disarm();

        expect(manager.getLoadedExtensions()).toEqual([]);
        const pending = manager.getPendingScanRefusals().get('tombstone-ext');
        expect(pending?.get('explore')).toBeInstanceOf(SubagentError);
      });

      it('publishes no failed-scan entry when the enablement projection is unreadable', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'aaa-refusal',
        });
        const agentsDir = path.join(extDir, 'agents');
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(
          path.join(agentsDir, 'explore.md'),
          '---\nname: explore\ndescription: Explore agent\nexecutor: {kind: invalid, command: runner}\n---\nExplore carefully.',
        );

        // Disable through the store while the extension still loads cleanly,
        // so the store's verdict (and the projection) record the disable.
        const enabler = createExtensionManager();
        await enabler.refreshCache();
        await enabler.disableExtension('aaa-refusal', SettingScope.User);

        // A dangling symlink at the extensions root rejects the next refresh
        // after aaa-refusal's scan recorded its refusal.
        fs.symlinkSync(
          path.join(userExtensionsDir, 'missing-target'),
          path.join(userExtensionsDir, 'zzz-dangling'),
        );

        // Make the projection unreadable for the fresh manager's head load:
        // readEnablementConfig's catch-all reads that as "everything
        // enabled", while the store snapshot (read via fs/promises, not the
        // probed sync path) still says disabled.
        fsProbe.failReadFileSyncFor = 'extension-enablement.json';
        try {
          const manager = createExtensionManager();
          await expect(manager.refreshCache()).rejects.toThrow(/zzz-dangling/);

          expect(manager.getLoadedExtensions()).toEqual([]);
          const pending = manager.getPendingScanRefusals().get('aaa-refusal');
          expect(pending?.get('explore')).toBeInstanceOf(SubagentError);
        } finally {
          fsProbe.failReadFileSyncFor = undefined;
        }
      });

      it('does not publish an extension the loader skipped when a sibling kills the refresh', async () => {
        const brokenDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'aaa-broken',
        });
        fs.writeFileSync(
          path.join(brokenDir, EXTENSIONS_CONFIG_FILENAME),
          JSON.stringify({
            name: 'aaa-broken',
            version: '1.0.0',
            hooks: { PreToolUse: [null] },
          }),
        );
        const brokenAgentsDir = path.join(brokenDir, 'agents');
        fs.mkdirSync(brokenAgentsDir, { recursive: true });
        fs.writeFileSync(
          path.join(brokenAgentsDir, 'explore.md'),
          '---\nname: explore\ndescription: Explore agent\nexecutor: {kind: invalid, command: runner}\n---\nExplore carefully.',
        );
        const dyingDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'zzz-dying',
        });
        const dyingSkillDir = path.join(dyingDir, 'skills', 's1');
        fs.mkdirSync(dyingSkillDir, { recursive: true });
        fs.writeFileSync(
          path.join(dyingSkillDir, 'SKILL.md'),
          '---\nname: s1\ndescription: S1\n---\nBody',
        );

        const disarm = armReadFileProbe(`${path.sep}zzz-dying${path.sep}`);
        const manager = createExtensionManager();
        await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
        disarm();

        expect(
          manager.getLoadedExtensions().map((extension) => extension.name),
        ).not.toContain('aaa-broken');
      });

      it('fails the refresh closed when an Agent Plugins mcp.json read hits resource exhaustion', async () => {
        // The mcp.json load is awaited inside the manifest head, so its
        // blanket non-ENOENT catch would launder an EMFILE into `{}` —
        // committing the plugin as active with zero MCP servers, stamped up
        // to date by the pre-load fingerprint.
        const pluginRoot = path.join(userExtensionsDir, 'plugin-ext');
        createAgentPlugin(pluginRoot, { name: 'plugin-ext' });

        const disarm = armReadFileProbe('mcp.json');
        const manager = createExtensionManager();
        try {
          await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
        } finally {
          disarm();
        }

        // The rejection committed nothing, so the next refresh loads the
        // plugin with its servers.
        await manager.refreshCache();
        const [extension] = manager.getLoadedExtensions();
        expect(extension.name).toBe('plugin-ext');
        expect(Object.keys(extension.mcpServers ?? {}).sort()).toEqual([
          'local',
          'remote',
        ]);
      });

      it('fails the refresh closed when the manifest existence check hits resource exhaustion', async () => {
        // fs.existsSync folds every failure into `false`: an EMFILE here
        // would read as "Configuration file not found" and skip the
        // extension from a refresh reported as successful. The existsSync
        // probe forces exactly the false existsSync produces under EMFILE;
        // the accessSync probe exercises the errno-classified replacement.
        createExtension({
          extensionsDir: userExtensionsDir,
          name: 'probe-ext',
        });

        fsProbe.falseExistsSyncFor = EXTENSIONS_CONFIG_FILENAME;
        fsProbe.failAccessSyncFor = EXTENSIONS_CONFIG_FILENAME;
        const manager = createExtensionManager();
        try {
          await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
        } finally {
          fsProbe.falseExistsSyncFor = undefined;
          fsProbe.failAccessSyncFor = undefined;
        }
        await manager.refreshCache();
        expect(manager.getLoadedExtensions().map((e) => e.name)).toEqual([
          'probe-ext',
        ]);
      });

      it('fails the refresh closed when the context-file existence check hits resource exhaustion', async () => {
        // Same existsSync fold: an EMFILE would silently strip the context
        // file from the committed load.
        createExtension({
          extensionsDir: userExtensionsDir,
          name: 'probe-ext',
          contextFileName: 'CONTEXT.md',
        });

        fsProbe.falseExistsSyncFor = 'CONTEXT.md';
        fsProbe.failAccessSyncFor = 'CONTEXT.md';
        const manager = createExtensionManager();
        try {
          await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
        } finally {
          fsProbe.falseExistsSyncFor = undefined;
          fsProbe.failAccessSyncFor = undefined;
        }
        await manager.refreshCache();
        const [extension] = manager.getLoadedExtensions();
        expect(
          extension.contextFiles?.some((file) => file.endsWith('CONTEXT.md')),
        ).toBe(true);
      });

      it('fails the refresh closed when the hooks existence check hits resource exhaustion', async () => {
        // Same existsSync fold: an EMFILE would silently drop the hooks the
        // extension ships from the committed load.
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'probe-ext',
        });
        const hooksDir = path.join(extDir, 'hooks');
        fs.mkdirSync(hooksDir, { recursive: true });
        fs.writeFileSync(
          path.join(hooksDir, 'hooks.json'),
          JSON.stringify({ hooks: {} }),
        );

        fsProbe.falseExistsSyncFor = 'hooks.json';
        fsProbe.failAccessSyncFor = 'hooks.json';
        const manager = createExtensionManager();
        try {
          await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
        } finally {
          fsProbe.falseExistsSyncFor = undefined;
          fsProbe.failAccessSyncFor = undefined;
        }
        await manager.refreshCache();
        expect(manager.getLoadedExtensions().map((e) => e.name)).toEqual([
          'probe-ext',
        ]);
      });

      it('retains refusals without publishing an entry when the store snapshot is unreadable', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'aaa-refusal',
        });
        const agentsDir = path.join(extDir, 'agents');
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(
          path.join(agentsDir, 'explore.md'),
          '---\nname: explore\ndescription: Explore agent\nexecutor: {kind: invalid, command: runner}\n---\nExplore carefully.',
        );

        // Disable through the store while the extension still loads cleanly,
        // so the store's verdict records the disable.
        const enabler = createExtensionManager();
        await enabler.refreshCache();
        await enabler.disableExtension('aaa-refusal', SettingScope.User);

        // A dangling symlink at the extensions root rejects the next refresh
        // after aaa-refusal's scan recorded its refusal.
        fs.symlinkSync(
          path.join(userExtensionsDir, 'missing-target'),
          path.join(userExtensionsDir, 'zzz-dangling'),
        );

        // The projection read fails (head load defaults to enabled) and the
        // store's state.json read fails once the scan is running — the two
        // recovery reads withLock runs before the scan are let through.
        fsProbe.failReadFileSyncFor = 'extension-enablement.json';
        fsProbe.failReadFileFor = 'state.json';
        fsProbe.failReadFileSkip = 2;
        try {
          const manager = createExtensionManager();
          await expect(manager.refreshCache()).rejects.toThrow(/zzz-dangling/);

          expect(manager.getLoadedExtensions()).toEqual([]);
          const pending = manager.getPendingScanRefusals().get('aaa-refusal');
          expect(pending?.get('explore')).toBeInstanceOf(SubagentError);
        } finally {
          fsProbe.failReadFileSyncFor = undefined;
          fsProbe.failReadFileFor = undefined;
          fsProbe.failReadFileSkip = 0;
        }
      });

      it('does not resurrect an extension whose uninstall overlaps a refresh that rejects after recording a refusal', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'race-ext',
        });
        const agentsDir = path.join(extDir, 'agents');
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(
          path.join(agentsDir, 'explore.md'),
          '---\nname: explore\ndescription: Explore agent\nexecutor: {kind: invalid, command: runner}\n---\nExplore carefully.',
        );
        fs.writeFileSync(
          path.join(agentsDir, 'other.md'),
          '---\nname: other\ndescription: Other agent\n---\nYou are a benchmark agent prompt.',
        );

        const manager = createExtensionManager();
        await manager.refreshCache();
        expect(manager.getLoadedExtensions().map((e) => e.name)).toEqual([
          'race-ext',
        ]);

        const disarm = armReadFileProbe('other.md');
        try {
          const refresh = manager.refreshCache();
          const uninstall = manager.uninstallExtension('race-ext', false);
          await expect(refresh).rejects.toThrow('EMFILE');
          await uninstall;
        } finally {
          disarm();
        }
        expect(manager.getLoadedExtensions().map((e) => e.name)).toEqual([]);
      });

      it('preserves refusals without consulting activation after a failed scan', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'aaa-refusal',
        });
        const agentsDir = path.join(extDir, 'agents');
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(
          path.join(agentsDir, 'explore.md'),
          '---\nname: explore\ndescription: Explore agent\nexecutor: {kind: invalid, command: runner}\n---\nExplore carefully.',
        );

        const enabler = createExtensionManager();
        await enabler.refreshCache();
        await enabler.disableExtension('aaa-refusal', SettingScope.User);

        // A dangling symlink at the extensions root rejects the next
        // refresh after aaa-refusal's scan recorded its refusal.
        fs.symlinkSync(
          path.join(userExtensionsDir, 'missing-target'),
          path.join(userExtensionsDir, 'zzz-dangling'),
        );

        const store = new ExtensionStore({ extensionsDir: userExtensionsDir });
        const activationSpy = vi
          .spyOn(store, 'getActivation')
          .mockImplementation(() => {
            throw Object.assign(new Error('ENOTDIR: not a directory'), {
              code: 'ENOTDIR',
            });
          });
        try {
          const manager = createExtensionManager({ extensionStore: store });
          await expect(manager.refreshCache()).rejects.toThrow(/zzz-dangling/);

          expect(manager.getLoadedExtensions()).toEqual([]);
          const pending = manager.getPendingScanRefusals().get('aaa-refusal');
          expect(activationSpy).not.toHaveBeenCalled();
          expect(pending?.get('explore')).toBeInstanceOf(SubagentError);
        } finally {
          activationSpy.mockRestore();
        }
      });

      it('gates dispatch with a failed-scan refusal when no runtime entry exists', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'aaa-refusal',
        });
        const agentsDir = path.join(extDir, 'agents');
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(
          path.join(agentsDir, 'explore.md'),
          '---\nname: explore\ndescription: Explore agent\nexecutor: {kind: invalid, command: runner}\n---\nExplore carefully.',
        );

        const enabler = createExtensionManager();
        await enabler.refreshCache();
        await enabler.disableExtension('aaa-refusal', SettingScope.User);

        // A dangling symlink at the extensions root rejects the next
        // refresh after aaa-refusal's scan recorded its refusal.
        const dangling = path.join(userExtensionsDir, 'zzz-dangling');
        fs.symlinkSync(
          path.join(userExtensionsDir, 'missing-target'),
          dangling,
        );

        const manager = createExtensionManager();
        // The store's state.json read fails once the scan is running — the
        // two recovery reads withLock runs before the scan are let through.
        fsProbe.failReadFileSyncFor = 'extension-enablement.json';
        fsProbe.failReadFileFor = 'state.json';
        fsProbe.failReadFileSkip = 2;
        try {
          await expect(manager.refreshCache()).rejects.toThrow(/zzz-dangling/);
        } finally {
          fsProbe.failReadFileSyncFor = undefined;
          fsProbe.failReadFileFor = undefined;
          fsProbe.failReadFileSkip = 0;
        }

        expect(manager.getLoadedExtensions()).toEqual([]);
        const refusal = manager
          .getPendingScanRefusals()
          .get('aaa-refusal')
          ?.get('explore');
        expect(refusal).toBeInstanceOf(SubagentError);

        const subagents = new SubagentManager(
          {
            getProjectRoot: () => tempWorkspaceDir,
            getActiveExtensions: () =>
              manager.getLoadedExtensions().filter((e) => e.isActive),
            getAgentsSettings: () => ({}),
            getSdkMode: () => false,
            isSafeMode: () => false,
          } as unknown as Config,
          {
            getPendingExtensionRefusals: () =>
              manager.getPendingScanRefusals().values(),
          },
        );
        await expect(subagents.loadSubagent('explore')).rejects.toBe(refusal);

        // The next committed full refresh supersedes the pending records.
        fs.unlinkSync(dangling);
        await manager.refreshCache();
        expect(manager.getPendingScanRefusals().size).toBe(0);
      });

      it('drops the pending refusals of an uninstalled extension', async () => {
        // A pending refusal outlives the failed refresh that recorded it so
        // dispatch keeps refusing the name, but uninstalling the extension
        // removes its agents for good — the record must not keep a
        // same-named builtin blocked past the uninstall.
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'aaa-refusal',
        });
        const agentsDir = path.join(extDir, 'agents');
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(
          path.join(agentsDir, 'explore.md'),
          '---\nname: explore\ndescription: Explore agent\nexecutor: {kind: invalid, command: runner}\n---\nExplore carefully.',
        );
        // Seed the store policy so the uninstall has a matching record.
        const enabler = createExtensionManager();
        await enabler.refreshCache();

        fs.symlinkSync(
          path.join(userExtensionsDir, 'missing-target'),
          path.join(userExtensionsDir, 'zzz-dangling'),
        );

        const manager = createExtensionManager();
        await expect(manager.refreshCache()).rejects.toThrow(/zzz-dangling/);
        expect(
          manager.getPendingScanRefusals().get('aaa-refusal')?.get('explore'),
        ).toBeInstanceOf(SubagentError);

        await manager.uninstallExtensionById(
          enabler.getLoadedExtensions()[0].id,
          false,
        );
        expect(manager.getPendingScanRefusals().has('aaa-refusal')).toBe(false);
      });
    });
  });

  describe('enableExtension / disableExtension', () => {
    /** `ready()` with one loaded extension (`my-extension` unless named). */
    async function readyOne(name?: string) {
      addExt(name ? { name } : {});
      return ready();
    }
    const setWorkspace = (
      manager: ExtensionManager,
      id: string,
      activation: 'enabled' | 'disabled',
      workspace = tempWorkspaceDir,
    ) => manager.setExtensionWorkspaceActivation(id, workspace, activation);
    const disableInWorkspace = (manager: ExtensionManager, name: string) =>
      manager.disableExtension(name, SettingScope.Workspace, tempWorkspaceDir);
    /** One of each V2 activation mutation, in a fixed order. */
    async function mutateActivations(manager: ExtensionManager, id: string) {
      await manager.setExtensionDefaultActivation(id, 'disabled');
      await manager.setExtensionActivationScope(id, {
        scope: 'workspace',
        workspacePath: tempWorkspaceDir,
      });
      await setWorkspace(manager, id, 'disabled');
      await manager.clearExtensionWorkspaceActivation(id, tempWorkspaceDir);
    }
    const isEnabled = (manager: ExtensionManager, cwd?: string) =>
      manager.isEnabled('my-extension', cwd);

    it('sets multiple default activations with one generation and refresh', async () => {
      addExt({ name: 'first-default-extension' });
      addExt({ name: 'second-default-extension' });
      const { manager, extensions: loaded } = await ready();
      const extensions = loaded.filter((extension) =>
        extension.name.endsWith('default-extension'),
      );
      expect(extensions).toHaveLength(2);
      const initial = await manager.getExtensionStoreSnapshot();
      const refreshTools = stubRefreshTools(manager);

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
      addExt({ name: 'first-workspace-extension' });
      addExt({ name: 'second-workspace-extension' });
      const { manager, extensions: loaded } = await ready();
      const extensions = loaded.filter((extension) =>
        extension.name.endsWith('workspace-extension'),
      );
      expect(extensions).toHaveLength(2);
      const setAll = (activation: 'disabled' | 'inherit') =>
        manager.setExtensionWorkspaceActivations(
          extensions.map(({ name }) => name),
          tempWorkspaceDir,
          activation,
        );
      await setAll('disabled');
      expect(extensions.every((extension) => !extension.isActive)).toBe(true);
      const initial = await manager.getExtensionStoreSnapshot();
      const refreshTools = stubRefreshTools(manager);

      const snapshot = await setAll('inherit');

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
      const { manager } = await ready();
      const initial = await manager.getExtensionStoreSnapshot();
      const refreshTools = stubRefreshTools(manager);
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
      const { manager, extension: loaded } = await readyOne(
        'available-extension',
      );
      const declaredName = 'future-extension';
      const declaredId = hashValue(declaredName);
      const initial = await manager.getExtensionStoreSnapshot();
      const refreshTools = stubRefreshTools(manager);
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
      const { manager, extension } = await readyOne();
      const isActive = () => manager.getLoadedExtensions()[0]?.isActive;

      await manager.setExtensionDefaultActivation(extension.id, 'disabled');
      expect(isActive()).toBe(false);

      await setWorkspace(manager, extension.id, 'enabled');
      expect(isActive()).toBe(true);

      await manager.clearExtensionWorkspaceActivation(
        extension.id,
        tempWorkspaceDir,
      );
      expect(isActive()).toBe(false);
    });

    it('refreshes runtime tools after V2 activation changes', async () => {
      const { manager, extension } = await readyOne();
      const refreshTools = stubRefreshTools(manager);

      await mutateActivations(manager, extension.id);

      expect(refreshTools).toHaveBeenCalledTimes(4);
    });

    it('returns a committed warning when activation runtime refresh fails', async () => {
      const { manager, extension } = await readyOne();
      failRefreshTools(manager, 'refresh failed');

      const result = await manager.setExtensionDefaultActivation(
        extension.id,
        'disabled',
      );

      expect(result.warnings).toEqual([refreshFailed('refresh failed')]);
      expect(result.extensions[extension.id]?.defaultActivation).toBe(
        'disabled',
      );
    });

    it('derives activation from the supplied store snapshot', async () => {
      const { manager, extension } = await readyOne();

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
      const { manager, extension } = await readyOne();

      const workspaceSnapshot = await manager.setExtensionActivationScope(
        extension.id,
        { scope: 'workspace', workspacePath: tempWorkspaceDir },
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
      const { manager, events, extension } = await readyOne();

      await mutateActivations(manager, extension.id);

      expect(events).toEqual(
        lifecycle(
          'setExtensionDefaultActivation',
          'setExtensionActivationScope',
          'setExtensionWorkspaceActivation',
          'clearExtensionWorkspaceActivation',
        ),
      );
    });

    it('keeps the V2 state in sync after a legacy scope mutation', async () => {
      const { manager, extension } = await readyOne();

      await disableInWorkspace(manager, extension.name);

      await expect(
        manager.getExtensionActivation(extension.id, tempWorkspaceDir),
      ).resolves.toMatchObject({
        effective: 'disabled',
        source: 'workspace_override',
      });
    });

    it('keeps other workspace overrides during a legacy workspace mutation', async () => {
      const { manager, extension } = await readyOne();
      const otherWorkspace = path.join(os.tmpdir(), 'other-workspace');
      await setWorkspace(manager, extension.id, 'enabled', otherWorkspace);

      await disableInWorkspace(manager, extension.name);

      const snapshot = await manager.getExtensionStoreSnapshot();
      expect(snapshot.extensions[extension.id]?.workspaceOverrides).toEqual({
        [otherWorkspace]: 'enabled',
        [fs.realpathSync.native(tempWorkspaceDir)]: 'disabled',
      });
    });

    it('clears only child workspace overrides during a legacy user mutation', async () => {
      const { manager, extension } = await readyOne();
      const outsideWorkspace = path.join(os.tmpdir(), 'outside-workspace');
      await setWorkspace(manager, extension.id, 'enabled');
      await setWorkspace(manager, extension.id, 'disabled', outsideWorkspace);

      await manager.disableExtension(extension.name, SettingScope.User);

      const snapshot = await manager.getExtensionStoreSnapshot();
      expect(snapshot.extensions[extension.id]?.workspaceOverrides).toEqual({
        [outsideWorkspace]: 'disabled',
      });
    });

    it('should emit mutation lifecycle events around extension changes', async () => {
      const { manager, events } = await readyOne();

      await manager.disableExtension('my-extension', SettingScope.User);

      expect(events).toEqual(lifecycle('disableExtension'));
    });

    it('should not emit mutation lifecycle events when validation fails', async () => {
      const manager = createExtensionManager();
      const events: ExtensionMutationEvent[] = [];
      manager.addMutationListener((event) => events.push(event));

      const missing = 'Extension with name missing-extension does not exist.';
      await expect(
        manager.disableExtension('missing-extension', SettingScope.User),
      ).rejects.toThrow(missing);

      await expect(
        manager.enableExtension('missing-extension', SettingScope.User),
      ).rejects.toThrow(missing);

      await expect(manager.addSource('   ')).rejects.toThrow(
        'Marketplace source cannot be empty.',
      );

      // Imported dynamically (not at file top) so this suite's './github.js'
      // mock keeps its registration order relative to the real marketplace
      // module graph. Loopback port 1 fails instantly (ECONNREFUSED) — never
      // touches the network, unlike an example.com fixture which performs a
      // real DNS lookup and HTTP GET from this suite.
      const { InsecureArchiveUrlError } = await import('./marketplace.js');
      await expect(
        manager.addSource('http://127.0.0.1:1/plugin.zip'),
      ).rejects.toBeInstanceOf(InsecureArchiveUrlError);

      // The reason the user sees — the offending URL plus the git@/SSH and
      // local-path remedies — must survive the marketplace.ts → addSource
      // boundary, not just the error type. A later edit that re-wraps the
      // probe failure with a stripped-down message goes red here.
      await expect(
        manager.addSource('http://127.0.0.1:1/plugin.zip'),
      ).rejects.toThrow(/Archive URLs must use https:\/\/ \(got /);

      // Non-archive probe failures must keep the marketplace-specific
      // guidance rather than surfacing the raw install-source error.
      await expect(
        manager.addSource('invalid-format-no-slash'),
      ).rejects.toThrow(/No marketplace found at/);

      expect(events).toEqual([]);
    });

    it.each([
      ['should disable an extension at the user scope', 1],
      ['should handle disabling the same extension twice', 2],
    ])('%s', async (_title, times) => {
      const { manager } = await readyOne();

      for (let i = 0; i < times; i++) {
        await manager.disableExtension('my-extension', SettingScope.User);
      }
      expect(isEnabled(manager, tempWorkspaceDir)).toBe(false);
    });

    it('should disable an extension at the workspace scope', async () => {
      const { manager } = await readyOne();

      await disableInWorkspace(manager, 'my-extension');

      expect(isEnabled(manager, tempHomeDir)).toBe(true);
      expect(isEnabled(manager, tempWorkspaceDir)).toBe(false);
    });

    it('should throw an error if you request system scope', async () => {
      const { manager } = await readyOne();

      await expect(
        manager.disableExtension('my-extension', SettingScope.System),
      ).rejects.toThrow('System and SystemDefaults scopes are not supported.');
    });

    it.each([
      ['should enable an extension at the user scope', SettingScope.User],
      [
        'should enable an extension at the workspace scope',
        SettingScope.Workspace,
      ],
    ])('%s', async (_title, scope) => {
      const { manager } = await readyOne('ext1');
      const cwd = scope === SettingScope.User ? undefined : tempWorkspaceDir;

      await manager.disableExtension('ext1', scope);
      expect(manager.isEnabled('ext1', cwd)).toBe(false);

      await manager.enableExtension('ext1', scope);
      expect(manager.isEnabled('ext1', cwd)).toBe(true);
    });
  });

  describe('telemetry config for lifecycle events', () => {
    function getLoggedTelemetryConfig(mock: {
      mock: { calls: unknown[][] };
    }): Config {
      expect(mock.mock.calls.length).toBeGreaterThan(0);
      return mock.mock.calls[0]![0] as Config;
    }

    it('honors usageStatisticsEnabled=false so the RUM logger gate stays closed', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });

      const manager = createExtensionManager({ usageStatisticsEnabled: false });
      await manager.refreshCache();
      await manager.disableExtension('ext1', SettingScope.User);

      // QwenLogger.getInstance(config) is the only opt-out gate; it closes
      // only when config.getUsageStatisticsEnabled() is false.
      const config = getLoggedTelemetryConfig(mockLogExtensionDisable);
      expect(config.getUsageStatisticsEnabled()).toBe(false);
    });

    it('honors usageStatisticsEnabled=true explicitly', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });

      const manager = createExtensionManager({ usageStatisticsEnabled: true });
      await manager.refreshCache();
      await manager.disableExtension('ext1', SettingScope.User);

      const config = getLoggedTelemetryConfig(mockLogExtensionDisable);
      expect(config.getUsageStatisticsEnabled()).toBe(true);
    });

    it('forwards the resolved proxy so RUM uploads use it', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });

      const dispatcherBefore = getGlobalDispatcher();
      const manager = createExtensionManager({
        proxy: 'http://127.0.0.1:7890',
      });
      await manager.refreshCache();
      await manager.disableExtension('ext1', SettingScope.User);

      const config = getLoggedTelemetryConfig(mockLogExtensionDisable);
      expect(config.getProxy()).toBe('http://127.0.0.1:7890');
      // The throwaway telemetry Config must NOT install the process-global
      // undici dispatcher: in `qwen serve` one process hosts many
      // workspaces, and a per-event global install would re-route the
      // daemon's own plain `fetch` through a proxy another workspace
      // configured. Give the (unguarded) async installer every chance to
      // run, then assert the dispatcher is untouched.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(getGlobalDispatcher()).toBe(dispatcherBefore);
    });

    it('keeps usage statistics enabled by default when the option is omitted', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();
      await manager.disableExtension('ext1', SettingScope.User);

      const config = getLoggedTelemetryConfig(mockLogExtensionDisable);
      expect(config.getUsageStatisticsEnabled()).toBe(true);
      expect(config.getProxy()).toBeUndefined();
    });

    it('does not abort the mutation when the proxy is a value a session Config would reject', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });

      // normalizeProxyUrl throws for SOCKS proxies; that throw must not
      // escape the throwaway telemetry Config and fail the extension
      // command, so the upload falls back to a direct connection.
      const manager = createExtensionManager({
        proxy: 'socks5h://127.0.0.1:1080',
      });
      await manager.refreshCache();

      await manager.disableExtension('ext1', SettingScope.User);
      expect(manager.isEnabled('ext1')).toBe(false);

      const config = getLoggedTelemetryConfig(mockLogExtensionDisable);
      expect(config.getProxy()).toBeUndefined();
    });
  });

  describe('preference-only operations', () => {
    it('should not emit mutation lifecycle events for preference changes', () => {
      const manager = createExtensionManager();
      const events: ExtensionMutationEvent[] = [];
      manager.addMutationListener((event) => events.push(event));

      expect(manager.toggleFavorite('my-extension')).toBe(true);
      writeTree(userExtensionsDir, {
        'marketplaces.json': [
          {
            name: 'marketplace',
            source: 'owner/repo',
            type: 'github',
            addedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
      expect(manager.markSourceUpdated('marketplace')).toMatchObject({
        name: 'marketplace',
      });

      expect(events).toEqual([]);
    });
  });

  describe('updateExtension', () => {
    const writeMyExtension = (version: string) => (destination: string) =>
      writeManifest(destination, { name: 'my-extension', version });
    /** An installed `my-extension` 1.0.0 whose local archive extracts 2.0.0. */
    async function readyArchiveUpdate(file: string) {
      const archivePath = archive(file, writeMyExtension('2.0.0'));
      const extensionPath = addExt({
        installMetadata: {
          type: 'local',
          source: archivePath,
          originSource: 'QwenCode',
        },
      });
      return { archivePath, extensionPath, ...(await ready()) };
    }
    const readManifest = (dir: string) =>
      JSON.parse(readText(dir, EXTENSIONS_CONFIG_FILENAME));
    const expectLastState = (
      callback: ReturnType<typeof vi.fn>,
      state: ExtensionUpdateState,
    ) => expect(callback).toHaveBeenLastCalledWith('my-extension', state);
    /** A prepared 1.0.0 archive install whose staged manifest is then replaced. */
    async function expectStagedCommitRejected(
      file: string,
      name: string,
      stagedManifest: string,
      message: string,
    ) {
      const manager = createExtensionManager();
      const prepared = await prepare(manager, archive(file, name));
      writeTree(prepared.stagingDirectory, {
        [EXTENSIONS_CONFIG_FILENAME]: stagedManifest,
      });
      const before = await manager.getExtensionStoreSnapshot();

      try {
        await expect(manager.commitPreparedExtension(prepared)).rejects.toThrow(
          message,
        );
      } finally {
        await manager.disposePreparedExtension(prepared);
      }

      expect(await manager.getExtensionStoreSnapshot()).toEqual(before);
      expect(fs.existsSync(prepared.destinationDirectory)).toBe(false);
    }

    it('fails before Git access when managed credentials are unavailable', async () => {
      addExt({
        installMetadata: {
          type: 'git',
          source: 'https://git.example.com/team/extension.git',
          gitCommit: 'sample-commit',
          credentialPersistence: 'stored',
          installId: 'a'.repeat(64),
        },
      });
      const { manager, extension } = await ready({ networkPolicy: 'public' });

      await expect(update(manager, extension)).rejects.toMatchObject({
        code: 'extension_credential_unavailable',
      });
      expect(mockGit.clone).not.toHaveBeenCalled();
      expect(mockGit.listRemote).not.toHaveBeenCalled();
    });

    it('emits a terminal ERROR callback when the install-metadata read hits resource exhaustion', async () => {
      // loadInstallMetadata rethrows resource exhaustion; the call in
      // updateExtension runs after the UPDATING callback and outside the
      // try whose catch emits the terminal ERROR, so an escaping throw
      // would pin the update row at "Updating…" for the rest of the
      // session.
      createExtension({
        extensionsDir: userExtensionsDir,
        installMetadata: {
          type: 'git',
          source: 'https://github.com/owner/repo',
          gitCommit: '0123456789abcdef0123456789abcdef01234567',
        },
      });
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;
      const states: ExtensionUpdateState[] = [];

      fsProbe.failReadFileSyncFor = INSTALL_METADATA_FILENAME;
      try {
        await expect(
          manager.updateExtension(
            extension,
            ExtensionUpdateState.UPDATE_AVAILABLE,
            (_name, state) => {
              states.push(state);
            },
          ),
        ).rejects.toThrow('EMFILE');
      } finally {
        fsProbe.failReadFileSyncFor = undefined;
      }
      expect(states).toEqual([
        ExtensionUpdateState.UPDATING,
        ExtensionUpdateState.ERROR,
      ]);
    });

    it('updates an old-Git public GitHub extension through a new archive SHA', async () => {
      const source = 'https://github.com/owner/repo';
      addExt({
        installMetadata: { type: 'git', source, gitCommit: FALLBACK_SHA },
      });
      const newSha = '89abcdef0123456789abcdef0123456789abcdef';
      oldGitFallback(writeMyExtension('2.0.0'), newSha);
      const { manager, extension } = await ready({ networkPolicy: 'public' });

      await update(manager, extension);

      expect(manager.getLoadedExtensions()[0]?.installMetadata).toMatchObject({
        source,
        type: 'git',
        gitCommit: newSha,
      });
      // The manager mutates installMetadata in place (gitCommit gets the new
      // SHA after the call), so pin only the immutable identity fields.
      expectArchiveFallbackFor(source);
      expect(mockGit.clone).not.toHaveBeenCalled();
    });

    it('applies the update network policy without mutating cached metadata', async () => {
      const source = 'https://github.com/owner/repo.git';
      addExt({ installMetadata: { type: 'git', source } });
      mockGit.version.mockResolvedValue({ major: 2, minor: 52 });
      mockGit.env.mockReturnValue(mockGit);
      remote(source);
      mockGit.listRemote.mockResolvedValue('same-hash\tHEAD');
      mockGit.revparse.mockResolvedValue('same-hash');
      const { manager, extension } = await ready({ networkPolicy: 'public' });
      expect(extension.installMetadata?.networkPolicy).toBeUndefined();

      await manager.checkForAllExtensionUpdates(() => {});

      expect(extension.installMetadata?.networkPolicy).toBeUndefined();
      expect(mockGit.version).toHaveBeenCalled();
      expect(mockGit.env).toHaveBeenCalled();
      expect(mockGit.listRemote).toHaveBeenCalledWith([source, 'HEAD']);
    });

    it('rejects a stale direct update after the artifact changes', async () => {
      const archivePath = archive('direct-update.zip', 'my-extension');
      const { manager } = await ready();
      const metadata = { type: 'local' as const, source: archivePath };
      const installed = await install(manager, metadata);
      const concurrentStore = new ExtensionStore();
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeMyExtension('2.0.0')(destination);
          const before = await concurrentStore.readSnapshot();
          const staging = await concurrentStore.createStagingDirectory();
          writeMyExtension('concurrent')(staging);
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
        reinstall(manager, metadata, installed.config, tempWorkspaceDir),
      ).rejects.toMatchObject({ code: 'extension_conflict' });
      expect(readManifest(installed.path)).toMatchObject({
        version: 'concurrent',
      });
    });

    /** `extension` as if already reloaded at 2.0.0. */
    const at2 = (extension: Extension) => ({
      ...extension,
      version: '2.0.0',
      config: { ...extension.config, version: '2.0.0' },
    });

    it('marks a direct update reload failure as already committed', async () => {
      const { archivePath, extensionPath, manager, extension } =
        await readyArchiveUpdate('direct-reload.zip');
      vi.spyOn(manager, 'loadExtension')
        .mockResolvedValueOnce(at2(extension))
        .mockResolvedValueOnce(null);

      await expect(
        reinstall(manager, archivePath, extension.config, tempWorkspaceDir),
      ).rejects.toMatchObject({
        code: 'extension_committed_with_warnings',
        committed: true,
      });
      expect(readManifest(extensionPath)).toMatchObject({ version: '2.0.0' });
    });

    it('rejects an invalid staged extension before commit', async () => {
      await expectStagedCommitRejected(
        'install-reload.zip',
        'my-extension',
        '{ invalid json',
        'Failed to load extension config',
      );
    });

    it('rejects staged identity changes before commit', async () => {
      await expectStagedCommitRejected(
        'identity-change.zip',
        'original-name',
        JSON.stringify({ name: 'changed-name', version: '1.0.0' }),
        'Prepared extension identity changed before commit.',
      );
    });

    it('reports a committed update reload failure as needing restart', async () => {
      const { manager, extension } =
        await readyArchiveUpdate('reload-failure.zip');
      const updatedExtension = at2(extension);
      vi.spyOn(manager, 'loadExtension')
        .mockResolvedValueOnce(updatedExtension)
        .mockResolvedValueOnce(updatedExtension)
        .mockResolvedValueOnce(null);
      const callback = vi.fn();

      await expect(update(manager, extension, callback)).resolves.toEqual({
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

      expectLastState(callback, ExtensionUpdateState.UPDATED_NEEDS_RESTART);
      expect(manager.getLoadedExtensions()).toEqual([]);
    });

    it('reports a committed update runtime warning as needing restart', async () => {
      const { manager, extension } =
        await readyArchiveUpdate('refresh-update.zip');
      failRefreshToolsOnce(manager, 'runtime stale');
      const callback = vi.fn();

      await update(manager, extension, callback);

      expectLastState(callback, ExtensionUpdateState.UPDATED_NEEDS_RESTART);
    });

    it('surfaces a committed settings compatibility warning distinctly', async () => {
      const { manager, extension } = await readyArchiveUpdate(
        'settings-update.zip',
      );
      const internals = manager as unknown as {
        prepareExtensionUpdateFromState(
          extension: Extension,
        ): Promise<PreparedExtensionMutation>;
      };
      const prepared =
        await internals.prepareExtensionUpdateFromState(extension);
      stubCommitSettings(prepared, rejectingWith('legacy sync unavailable'));
      vi.spyOn(
        internals,
        'prepareExtensionUpdateFromState',
      ).mockResolvedValueOnce(prepared);
      const callback = vi.fn();

      await expect(update(manager, extension, callback)).resolves.toMatchObject(
        {
          warnings: [
            {
              code: 'extension_settings_legacy_sync_failed',
              error: 'legacy sync unavailable',
            },
          ],
        },
      );
      expectLastState(callback, ExtensionUpdateState.UPDATED_WITH_WARNINGS);
    });

    it('should end mutation lifecycle events when temp directory creation fails', async () => {
      const { manager, events, extension } =
        await readyArchiveUpdate('update.zip');
      const callback = vi.fn();
      vi.spyOn(ExtensionStorage, 'createTmpDir').mockRejectedValueOnce(
        new Error('disk full'),
      );

      await expect(update(manager, extension, callback)).rejects.toThrow(
        'disk full',
      );

      expect(events).toEqual(lifecycle('updateExtension'));
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
    /** Migrates `extension` with an install that commits with `warning`. */
    function migrateCommittedWith(warning: { code: string; error: string }) {
      const manager = createExtensionManager();
      vi.spyOn(manager, 'installExtension').mockRejectedValueOnce(
        Object.assign(new Error('committed with warnings'), {
          code: 'extension_committed_with_warnings',
          committed: true,
          identity: { id: 'migration-id', name: 'migration-extension' },
          warnings: [warning],
        }),
      );
      return manager.performWorkspaceExtensionMigration(
        [extension],
        async () => {},
      );
    }

    it('reports a committed extension that could not be reloaded', async () => {
      await expect(
        migrateCommittedWith({
          code: 'extension_reload_failed',
          error: 'invalid manifest',
        }),
      ).resolves.toEqual(['migration-extension']);
    });

    it('does not retry a committed extension for recoverable warnings', async () => {
      await expect(
        migrateCommittedWith(refreshFailed('refresh delayed')),
      ).resolves.toEqual([]);
    });
  });

  describe('validateExtensionOverrides', () => {
    /** Extensions ext1..extN, loaded with the given CLI overrides. */
    async function readyExts(count: number, overrides?: string[]) {
      for (let i = 1; i <= count; i++) addExt({ name: `ext${i}` });
      return ready(overrides ? { enabledExtensionOverrides: overrides } : {});
    }
    const isActive = (extensions: Extension[], name: string) =>
      extensions.find((e) => e.name === name)?.isActive;

    it('should mark all extensions as active if no enabled extensions are provided', async () => {
      const { extensions } = await readyExts(2);

      expect(extensions).toHaveLength(2);
      expect(extensions.every((e) => e.isActive)).toBe(true);
    });

    it('should mark only the enabled extensions as active', async () => {
      const { extensions } = await readyExts(3, ['ext1', 'ext3']);

      expect(isActive(extensions, 'ext1')).toBe(true);
      expect(isActive(extensions, 'ext2')).toBe(false);
      expect(isActive(extensions, 'ext3')).toBe(true);
    });

    it('should mark all extensions as inactive when "none" is provided', async () => {
      const { manager, extensions } = await readyExts(2, ['none']);

      expect(extensions.every((e) => !e.isActive)).toBe(true);
      await expect(
        manager.getExtensionActivation(extensions[0]!.id),
      ).resolves.toMatchObject({
        effective: 'disabled',
        source: 'cli_override',
      });
    });

    it('should treat "none" as disabling all only when it is the sole override', async () => {
      const { manager, extensions } = await readyExts(2, ['none', 'ext1']);

      expect(manager.isEnabled('ext1')).toBe(true);
      expect(isActive(extensions, 'ext1')).toBe(true);
      expect(isActive(extensions, 'ext2')).toBe(false);
    });

    it('should handle case-insensitivity', async () => {
      const { extensions } = await readyExts(1, ['EXT1']);

      expect(isActive(extensions, 'ext1')).toBe(true);
    });

    it('should log an error for unknown extensions', async () => {
      const { manager, extensions } = await readyExts(1, ['ext4']);

      expect(() =>
        manager.validateExtensionOverrides(extensions),
      ).not.toThrow();
    });
  });

  describe('loadExtensionConfig', () => {
    /** Loads one `test-extension` whose `test-server` MCP server has `env`. */
    async function loadWithServerEnv(env: Record<string, string>) {
      writeManifest(path.join(userExtensionsDir, 'test-extension'), {
        name: 'test-extension',
        version: '1.0.0',
        mcpServers: {
          'test-server': { command: 'node', args: ['server.js'], env },
        },
      });
      return (await ready()).extensions;
    }

    it('should resolve environment variables in extension configuration', async () => {
      vi.stubEnv('TEST_API_KEY', 'test-api-key-123');
      vi.stubEnv('TEST_DB_URL', 'postgresql://localhost:5432/testdb');

      const extensions = await loadWithServerEnv({
        API_KEY: '$TEST_API_KEY',
        DATABASE_URL: '${TEST_DB_URL}',
        STATIC_VALUE: 'no-substitution',
      });

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
    });

    it('should handle missing environment variables gracefully', async () => {
      const extensions = await loadWithServerEnv({
        MISSING_VAR: '$UNDEFINED_ENV_VAR',
        MISSING_VAR_BRACES: '${ALSO_UNDEFINED}',
      });

      expect(extensions).toHaveLength(1);
      const serverConfig = extensions[0].config.mcpServers!['test-server'];
      expect(serverConfig.env).toBeDefined();
      expect(serverConfig.env!['MISSING_VAR']).toBe('$UNDEFINED_ENV_VAR');
      expect(serverConfig.env!['MISSING_VAR_BRACES']).toBe('${ALSO_UNDEFINED}');
    });
    describe('refreshTools', () => {
      it('refreshTools should return early if config is not set', async () => {
        const manager = createExtensionManager();
        await expect(manager.refreshTools()).resolves.not.toThrow();
      });

      it('refreshTools should call all refresh methods', async () => {
        const mockRefreshCache = vi.fn();
        const mockReinitializeMcpServers = vi.fn();
        const mockReloadHooks = vi.fn();
        const mockRefreshHierarchicalMemory = vi.fn();
        const mockSettingsMcpServers = { server: { command: 'cmd' } };

        const manager = createExtensionManager();
        manager.setConfig({
          getLlmClient: () => ({
            isInitialized: () => false,
            setTools: vi.fn(),
          }),
          getSettingsMcpServers: () => mockSettingsMcpServers,
          reinitializeMcpServers: mockReinitializeMcpServers,
          getSkillManager: () => ({ refreshCache: mockRefreshCache }),
          getSubagentManager: () => ({ refreshCache: mockRefreshCache }),
          getHookSystem: () => ({ reload: mockReloadHooks }),
          refreshHierarchicalMemory: mockRefreshHierarchicalMemory,
        } as unknown as Config);

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
      const accepts = (...names: string[]) =>
        names.forEach((name) => expect(() => validateName(name)).not.toThrow());
      const rejects = (...names: string[]) =>
        names.forEach((name) =>
          expect(() => validateName(name)).toThrow('Invalid extension name'),
        );

      it('should accept valid extension names', () => {
        accepts('my-extension', 'Extension123', 'test-ext-1', 'UPPERCASE');
      });

      it('should accept names with underscores and dots', () => {
        accepts('my_extension', 'my.extension', 'my_ext.v1', 'ext_1.2.3');
      });

      it('should reject names with invalid characters', () => {
        rejects('my extension', 'my@ext');
      });

      it('should reject empty names', () => {
        rejects('');
      });
    });

    describe('hashValue', () => {
      it('should generate consistent hash for same input', () => {
        expect(hashValue('test-input')).toBe(hashValue('test-input'));
      });

      it('should generate different hashes for different inputs', () => {
        expect(hashValue('input-1')).not.toBe(hashValue('input-2'));
      });

      it('should generate a valid SHA256 hash', () => {
        expect(hashValue('test')).toMatch(/^[a-f0-9]{64}$/);
      });
    });

    describe('getExtensionId', () => {
      const testExt = (): ExtensionConfig => ({
        name: 'test-ext',
        version: '1.0.0',
      });

      it('uses a persisted install id instead of the source', () => {
        const installId = 'a'.repeat(64);
        expect(
          getExtensionId(testExt(), {
            type: 'git',
            source: 'https://example.com/repo',
            installId,
            credentialPersistence: 'stored',
          }),
        ).toBe(installId);
      });

      it('ignores install ids on unmanaged metadata', () => {
        const source = 'https://example.com/repo';
        expect(
          getExtensionId(testExt(), {
            type: 'git',
            source,
            installId: 'a'.repeat(64),
          }),
        ).toBe(getExtensionId(testExt(), { type: 'git', source }));
      });

      it('rejects an invalid persisted install id', () => {
        expect(() =>
          getExtensionId(testExt(), {
            type: 'snapshot',
            source: 'snapshot',
            installId: '../invalid',
          }),
        ).toThrow('Stored extension install id is invalid');
      });

      it('should use hashed name when no install metadata', () => {
        expect(getExtensionId(testExt())).toBe(hashValue('test-ext'));
      });

      it('should use hashed source for local install', () => {
        expect(
          getExtensionId(testExt(), { type: 'local', source: '/path/to/ext' }),
        ).toBe(hashValue('/path/to/ext'));
      });

      it('gives same-named uploads distinct ids', () => {
        const upload = (source: string) =>
          getExtensionId(testExt(), { type: 'local', source });

        expect(upload('upload:v1:first:extension.zip')).not.toBe(
          upload('upload:v1:second:extension.zip'),
        );
      });

      it.each([
        [
          'should use GitHub URL for git install',
          'test-ext',
          'https://github.com/owner/repo',
        ],
        // For non-GitHub git servers, fall back to using the source URL directly
        [
          'should use source as-is for non-GitHub git URLs (e.g., GitLab)',
          'test-ext',
          'https://gitlab.company.com/team/extension-repo',
        ],
        [
          'keeps the repo-only id when no plugin name is recorded',
          'solo-ext',
          'https://github.com/owner/solo',
        ],
      ])('%s', (_title, name, source) => {
        expect(
          getExtensionId({ name, version: '1.0.0' }, { type: 'git', source }),
        ).toBe(hashValue(source));
      });

      it('gives plugins from the same repository distinct ids (#7568)', () => {
        const repo = 'https://github.com/dotnet/skills';
        const idFor = (pluginName: string) =>
          getExtensionId(
            { name: pluginName, version: '1.0.0' },
            {
              type: 'git',
              source: repo,
              pluginName,
            },
          );
        const dotnetId = idFor('dotnet');
        const dotnetTestId = idFor('dotnet-test');

        expect(dotnetId).toBe(hashValue(`${repo}:dotnet`));
        expect(dotnetTestId).toBe(hashValue(`${repo}:dotnet-test`));
        expect(dotnetId).not.toBe(dotnetTestId);
      });
    });
  });

  describe('hooks loading and processing', () => {
    const hookEntry = (description: string, command: string) => ({
      description,
      hooks: [{ type: 'command', command }],
    });
    /** A hooks object with one PreToolUse command. */
    const pre = (description: string, command: string) => ({
      PreToolUse: [hookEntry(description, command)],
    });
    const pluginRootScript = '${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh';
    /** Writes extension `name` (manifest merged with `config`, plus `files`) and loads it. */
    async function loadHooks(
      name: string,
      config: object,
      files: Record<string, unknown> = {},
    ) {
      writeTree(path.join(userExtensionsDir, name), {
        ...files,
        [EXTENSIONS_CONFIG_FILENAME]: { name, version: '1.0.0', ...config },
      });
      return (await ready()).extensions;
    }
    /** Checks the single extension's first `event` hook command. */
    function expectHook(
      extensions: Extension[],
      event: 'PreToolUse' | 'PostToolUse',
      command: string,
      checkEventCount = true,
    ) {
      expect(extensions).toHaveLength(1);
      expect(extensions[0].hooks).toBeDefined();
      if (checkEventCount) {
        expect(extensions[0].hooks![event]).toHaveLength(1);
      }
      expect(
        (extensions[0].hooks![event]![0].hooks![0] as { command: string })
          .command,
      ).toBe(command);
    }
    const dirOf = (name: string) => path.join(userExtensionsDir, name);

    it('should load hooks from qwen-extension.json', async () => {
      const extensions = await loadHooks('hooks-extension', {
        hooks: pre('Run before tool start', 'echo "hello"'),
      });

      expectHook(extensions, 'PreToolUse', 'echo "hello"');
    });

    it('should load hooks from hooks/hooks.json when not in main config', async () => {
      const command = `echo "installed in ${dirOf('hooks-from-file-extension')}"`;
      const extensions = await loadHooks(
        'hooks-from-file-extension',
        {},
        {
          'hooks/hooks.json': {
            PostToolUse: [hookEntry('Run after install', command)],
          },
        },
      );

      expectHook(extensions, 'PostToolUse', command);
    });

    it('should substitute ${CLAUDE_PLUGIN_ROOT} variable in hooks', async () => {
      const extensions = await loadHooks('hooks-var-extension', {
        hooks: pre('Run before start with var', pluginRootScript),
      });

      expectHook(
        extensions,
        'PreToolUse',
        `${dirOf('hooks-var-extension')}/scripts/setup.sh`,
      );
    });

    it('should load hooks from config.hooks string path', async () => {
      const extensions = await loadHooks(
        'hooks-from-config-path',
        { hooks: 'custom-hooks/hooks.json' },
        {
          'custom-hooks/hooks.json': pre(
            'Run from custom path',
            'echo "custom hooks path"',
          ),
        },
      );

      expectHook(extensions, 'PreToolUse', 'echo "custom hooks path"');
    });

    it('should prefer config.hooks string path over hooks/hooks.json', async () => {
      const extensions = await loadHooks(
        'hooks-prefer-config-path',
        { hooks: 'custom/my-hooks.json' },
        {
          'hooks/hooks.json': pre('From hooks directory', 'echo "hooks dir"'),
          'custom/my-hooks.json': pre('From config path', 'echo "config path"'),
        },
      );

      expectHook(extensions, 'PreToolUse', 'echo "config path"', false);
    });

    it('should substitute ${CLAUDE_PLUGIN_ROOT} in hooks file from config.hooks string path', async () => {
      const extensions = await loadHooks(
        'hooks-var-from-config-path',
        { hooks: 'my-hooks/hooks.json' },
        {
          'my-hooks/hooks.json': pre('Run with variable', pluginRootScript),
        },
      );

      expectHook(
        extensions,
        'PreToolUse',
        `${dirOf('hooks-var-from-config-path')}/scripts/setup.sh`,
      );
    });
  });
});
