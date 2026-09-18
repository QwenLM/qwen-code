/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ManagedExtensionReadOnlyError,
  ExtensionManager,
  ExtensionUpdateState,
  type ExtensionConfig,
  type ExtensionManagerOptions,
} from './extensionManager.js';
import { ExtensionStore } from './extension-store.js';
import { loadSubagentFromDir } from '../subagents/subagent-manager.js';
import type { SubagentConfig, SubagentError } from '../subagents/types.js';
import { resolveManagedExtensionsDir } from './managed-extension-dir.js';
import { checkForExtensionUpdate } from './github.js';
import {
  EXTENSIONS_CONFIG_FILENAME,
  INSTALL_METADATA_FILENAME,
  recursivelyHydrateStrings,
  type JsonValue,
} from './variables.js';

function inventory(root: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(root, file), fs.readFileSync(file, 'base64')];
      }),
  );
}

describe('managed extensions', () => {
  let temporary: string;
  let managed: string;
  let user: string;
  let workspace: string;
  let store: ExtensionStore;

  function writeExtension(
    root: string,
    directory: string,
    config: Partial<ExtensionConfig> = {},
  ): string {
    const extensionPath = path.join(root, directory);
    fs.mkdirSync(extensionPath, { recursive: true });
    fs.writeFileSync(
      path.join(extensionPath, EXTENSIONS_CONFIG_FILENAME),
      JSON.stringify({
        name: directory,
        version: '1.0.0',
        ...config,
      }),
    );
    return extensionPath;
  }

  function manager(
    options: Partial<ExtensionManagerOptions> = {},
  ): ExtensionManager {
    return new ExtensionManager({
      workspaceDir: workspace,
      extensionStore: store,
      managedExtensionsDir: managed,
      isWorkspaceTrusted: true,
      ...options,
    });
  }

  beforeEach(() => {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-managed-'));
    managed = path.join(temporary, 'managed');
    workspace = path.join(temporary, 'workspace');
    user = path.join(temporary, 'home', 'extensions');
    fs.mkdirSync(managed);
    fs.mkdirSync(workspace);
    vi.stubEnv('QWEN_HOME', path.join(temporary, 'home'));
    vi.stubEnv('QWEN_CODE_FORCE_FILE_STORAGE', 'true');
    store = new ExtensionStore({
      extensionsDir: user,
      storeDir: path.join(temporary, 'home', 'extension-store'),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  it('loads a read-only collection without installation and keeps all writes in user state', async () => {
    const extensionPath = writeExtension(managed, 'package-folder', {
      name: 'portable',
      mcpServers: {
        test: {
          command: '${extensionPath}/server',
          args: ['${CLAUDE_PLUGIN_ROOT}'],
        },
      },
    });
    fs.mkdirSync(path.join(extensionPath, 'skills', 'test'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(extensionPath, 'skills', 'test', 'SKILL.md'),
      '---\nname: test\ndescription: Test skill\n---\nRead ${extensionPath}/data and ${CLAUDE_PLUGIN_ROOT}/bin.',
    );
    fs.writeFileSync(path.join(extensionPath, 'QWEN.md'), 'Extension context');
    const before = inventory(managed);
    fs.chmodSync(extensionPath, 0o555);
    fs.chmodSync(managed, 0o555);
    try {
      const subject = manager();
      await subject.refreshCache();
      const [extension] = subject.getLoadedExtensions();
      expect(extension).toMatchObject({
        name: 'portable',
        source: 'managed',
        version: '1.0.0',
        isActive: true,
        path: extensionPath,
      });
      expect(extension.installMetadata).toBeUndefined();
      expect(extension.mcpServers?.['test']).toMatchObject({
        command: `${extensionPath}/server`,
        args: [extensionPath],
      });
      expect(extension.contextFiles).toEqual([
        path.join(extensionPath, 'QWEN.md'),
      ]);
      expect(extension.skills?.[0].body).toBe(
        `Read ${extensionPath}/data and ${extensionPath}/bin.`,
      );
      await subject.setExtensionDefaultActivation(extension.id, 'disabled');
      await subject.refreshCache();
      expect(subject.getLoadedExtensions()[0].isActive).toBe(false);
      expect(inventory(managed)).toEqual(before);
      expect(
        fs.existsSync(path.join(user, 'portable', INSTALL_METADATA_FILENAME)),
      ).toBe(false);
    } finally {
      fs.chmodSync(managed, 0o755);
      fs.chmodSync(extensionPath, 0o755);
    }
  });

  it.each([
    String.raw`C:\Users\Tester\extensions`,
    String.raw`C:\extensions\example`,
    `/prepared/double"and'single`,
  ])(
    'hydrates parsed subagent values without interpreting root characters as YAML: %s',
    async (extensionRoot) => {
      const agents = path.join(managed, '${extensionPath}', 'agents');
      fs.mkdirSync(agents, { recursive: true });
      const markdown = [
        '---',
        'name: portable-agent',
        'description: "Helper from ${CLAUDE_PLUGIN_ROOT}"',
        'executor:',
        '  kind: acp',
        '  command: "${CLAUDE_PLUGIN_ROOT}/runner"',
        '  args: ["${extensionPath}/argument"]',
        'mcpServers:',
        '  helper:',
        '    command: "${extensionPath}/server"',
        'hooks:',
        '  SessionStart:',
        '    - hooks:',
        '        - type: command',
        '          command: "${CLAUDE_PLUGIN_ROOT}/hook"',
        '---',
        'Read ${extensionPath}/data.',
      ].join('\n');
      const file = path.join(agents, 'portable.md');
      fs.writeFileSync(file, markdown);
      const refusals = new Map<string, SubagentError>();
      const loaded = await loadSubagentFromDir(
        agents,
        refusals,
        (config) =>
          recursivelyHydrateStrings(config as unknown as JsonValue, {
            extensionPath: extensionRoot,
            CLAUDE_PLUGIN_ROOT: extensionRoot,
          }) as unknown as SubagentConfig,
      );
      expect(refusals.size).toBe(0);
      expect(loaded).toEqual([
        expect.objectContaining({
          filePath: file,
          level: 'extension',
          description: `Helper from ${extensionRoot}`,
          systemPrompt: `Read ${extensionRoot}/data.`,
          executor: {
            kind: 'acp',
            command: `${extensionRoot}/runner`,
            args: [`${extensionRoot}/argument`],
          },
          mcpServers: { helper: { command: `${extensionRoot}/server` } },
          hooks: {
            SessionStart: [
              {
                hooks: [{ type: 'command', command: `${extensionRoot}/hook` }],
              },
            ],
          },
        }),
      ]);
      expect(fs.readFileSync(file, 'utf8')).toBe(markdown);
    },
  );

  it('hydrates managed subagent markdown and workflow declaration paths in memory', async () => {
    const extensionPath = writeExtension(managed, 'portable', {
      workflows: '${extensionPath}/actions/review.js',
    });
    fs.mkdirSync(path.join(extensionPath, 'agents'));
    fs.mkdirSync(path.join(extensionPath, 'actions'));
    fs.writeFileSync(
      path.join(extensionPath, 'agents', 'helper.md'),
      [
        '---',
        'name: helper',
        'description: Helper from ${CLAUDE_PLUGIN_ROOT}',
        'mcpServers:',
        '  helper:',
        '    command: "${CLAUDE_PLUGIN_ROOT}/server"',
        'hooks:',
        '  SessionStart:',
        '    - hooks:',
        '        - type: command',
        '          command: "${extensionPath}/hook"',
        '---',
        'Read ${extensionPath}/data and ${CLAUDE_PLUGIN_ROOT}/guide.',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(extensionPath, 'agents', 'runner.md'),
      [
        '---',
        'name: runner',
        'description: External runner',
        'executor:',
        '  kind: acp',
        '  command: "${CLAUDE_PLUGIN_ROOT}/runner"',
        '  args: ["${extensionPath}/argument"]',
        '---',
        'Use the configured executor.',
      ].join('\n'),
    );
    const workflow = path.join(extensionPath, 'actions', 'review.js');
    fs.writeFileSync(
      workflow,
      "export const meta = { name: 'review', description: 'Review work' };\nreturn 1;\n",
    );
    const before = inventory(managed);
    const subject = manager();
    await subject.refreshCache();
    const [extension] = subject.getLoadedExtensions();
    expect(extension.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'helper',
          description: `Helper from ${extensionPath}`,
          systemPrompt: `Read ${extensionPath}/data and ${extensionPath}/guide.`,
          mcpServers: { helper: { command: `${extensionPath}/server` } },
          hooks: {
            SessionStart: [
              {
                hooks: [{ type: 'command', command: `${extensionPath}/hook` }],
              },
            ],
          },
        }),
        expect.objectContaining({
          name: 'runner',
          executor: {
            kind: 'acp',
            command: `${extensionPath}/runner`,
            args: [`${extensionPath}/argument`],
          },
        }),
      ]),
    );
    expect(extension.workflows).toEqual([
      expect.objectContaining({
        name: 'portable:review',
        scriptPath: fs.realpathSync(workflow),
      }),
    ]);
    expect(inventory(managed)).toEqual(before);
  });

  it('resolves ownership before activation and preserves preferences across version and root changes', async () => {
    writeExtension(user, 'old-user', { name: 'PORTABLE', version: 'user' });
    const extensionPath = writeExtension(managed, 'deployed', {
      name: 'portable',
    });
    const warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const subject = manager();
    await subject.refreshCache();
    expect(subject.getLoadedExtensions()).toHaveLength(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('shadowed'));
    const first = subject.getLoadedExtensions()[0];
    await subject.setExtensionDefaultActivation(first.id, 'disabled');
    expect(await subject.loadExtensionByName('PORTABLE')).toMatchObject({
      source: 'managed',
      isActive: false,
    });
    await subject.refreshCache({ names: ['PORTABLE'] });
    expect(subject.getLoadedExtensions()).toEqual([
      expect.objectContaining({
        id: first.id,
        isActive: false,
        source: 'managed',
      }),
    ]);
    writeExtension(managed, 'deployed', { name: 'portable', version: '2.0.0' });
    const relocated = path.join(temporary, 'relocated');
    fs.renameSync(managed, relocated);
    const restarted = manager({ managedExtensionsDir: relocated });
    await restarted.refreshCache();
    expect(restarted.getLoadedExtensions()[0]).toMatchObject({
      id: first.id,
      version: '2.0.0',
      isActive: false,
    });
    await restarted.setExtensionDefaultActivation(first.id, 'enabled');
    expect(restarted.getLoadedExtensions()[0].isActive).toBe(true);
    expect(fs.existsSync(extensionPath)).toBe(false);
    expect(
      fs.existsSync(path.join(user, 'old-user', EXTENSIONS_CONFIG_FILENAME)),
    ).toBe(true);
  });

  it('rejects duplicate managed names on full, filtered and by-name discovery', async () => {
    writeExtension(managed, 'first', { name: 'duplicate' });
    writeExtension(managed, 'second', { name: 'DUPLICATE' });
    const subject = manager();
    await expect(subject.refreshCache()).rejects.toThrow(
      /Duplicate managed extension name.*(?:first.*second|second.*first)/,
    );
    await expect(
      subject.refreshCache({ names: ['unrelated'] }),
    ).rejects.toThrow('Duplicate managed extension name');
    await expect(subject.loadExtensionByName('unrelated')).rejects.toThrow(
      'Duplicate managed extension name',
    );
  });

  it('ignores managed install sidecars and resolves external hook file variables in memory', async () => {
    const extensionPath = writeExtension(managed, 'portable');
    const redirect = writeExtension(temporary, 'redirect', {
      name: 'unexpected',
    });
    fs.writeFileSync(
      path.join(extensionPath, INSTALL_METADATA_FILENAME),
      JSON.stringify({ type: 'link', source: redirect }),
    );
    fs.mkdirSync(path.join(extensionPath, 'hooks'));
    fs.writeFileSync(
      path.join(extensionPath, 'hooks', 'hooks.json'),
      JSON.stringify({
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: '${extensionPath}/hook ${CLAUDE_PLUGIN_ROOT}',
              },
            ],
          },
        ],
      }),
    );
    const before = inventory(managed);
    const subject = manager();
    await subject.refreshCache();
    const [extension] = subject.getLoadedExtensions();
    expect(extension).toMatchObject({
      name: 'portable',
      path: extensionPath,
      source: 'managed',
    });
    expect(extension.hooks?.SessionStart?.[0].hooks[0]).toMatchObject({
      command: `${extensionPath}/hook ${extensionPath}`,
    });
    expect(await checkForExtensionUpdate(extension, subject)).toBe(
      ExtensionUpdateState.NOT_UPDATABLE,
    );
    expect(inventory(managed)).toEqual(before);
  });

  it('fingerprints additions, version changes and removals without duplicate contributions', async () => {
    fs.mkdirSync(user, { recursive: true });
    const subject = manager();
    await subject.refreshCache();
    expect(await subject.refreshCacheIfSourcesChanged()).toBe(false);
    const extensionPath = writeExtension(managed, 'portable');
    expect(await subject.refreshCacheIfSourcesChanged()).toBe(true);
    expect(await subject.refreshCacheIfSourcesChanged()).toBe(false);
    writeExtension(managed, 'portable', { version: '2.0.0-expanded' });
    expect(await subject.refreshCacheIfSourcesChanged()).toBe(true);
    expect(subject.getLoadedExtensions()).toEqual([
      expect.objectContaining({ version: '2.0.0-expanded' }),
    ]);
    await subject.refreshCache();
    expect(subject.getLoadedExtensions()).toHaveLength(1);
    fs.rmSync(extensionPath, { recursive: true });
    expect(await subject.refreshCacheIfSourcesChanged()).toBe(true);
    expect(subject.getLoadedExtensions()).toEqual([]);
  });

  it('re-reads managed skill content and removes deleted contributions during explicit refresh', async () => {
    const extensionPath = writeExtension(managed, 'portable');
    const skillDirectory = path.join(extensionPath, 'skills', 'test');
    fs.mkdirSync(skillDirectory, { recursive: true });
    const skillFile = path.join(skillDirectory, 'SKILL.md');
    const writeSkill = (body: string) =>
      fs.writeFileSync(
        skillFile,
        `---\nname: test\ndescription: Test skill\n---\n${body}`,
      );
    writeSkill('First content');
    const subject = manager();
    await subject.refreshCache();
    expect(subject.getLoadedExtensions()[0].skills?.[0].body).toBe(
      'First content',
    );
    writeSkill('Updated content');
    await subject.refreshCache();
    expect(subject.getLoadedExtensions()[0].skills).toEqual([
      expect.objectContaining({ body: 'Updated content' }),
    ]);
    await subject.refreshCache();
    expect(subject.getLoadedExtensions()[0].skills).toHaveLength(1);
    fs.rmSync(skillDirectory, { recursive: true });
    await subject.refreshCache();
    expect(subject.getLoadedExtensions()[0].skills).toEqual([]);
  });

  it('uses existing invalid-manifest diagnostics without dropping valid managed packages', async () => {
    writeExtension(managed, 'valid');
    const invalid = writeExtension(managed, 'invalid');
    fs.writeFileSync(path.join(invalid, EXTENSIONS_CONFIG_FILENAME), '{');
    const subject = manager();
    await subject.refreshCache();
    expect(
      subject.getLoadedExtensions().map((extension) => extension.name),
    ).toEqual(['valid']);
  });

  it('rejects every managed artifact mutation and keeps shadowed user files unchanged', async () => {
    writeExtension(managed, 'portable');
    writeExtension(user, 'portable', { version: 'user' });
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const subject = manager();
    await subject.refreshCache();
    const [extension] = subject.getLoadedExtensions();
    const before = inventory(managed);
    const userBefore = inventory(path.join(user, 'portable'));
    await expect(
      subject.uninstallExtension('portable', false),
    ).rejects.toBeInstanceOf(ManagedExtensionReadOnlyError);
    await expect(
      subject.uninstallExtensionById(extension.id, false),
    ).rejects.toBeInstanceOf(ManagedExtensionReadOnlyError);
    await expect(
      manager().uninstallExtensionById(extension.id, false),
    ).rejects.toBeInstanceOf(ManagedExtensionReadOnlyError);
    await expect(
      subject.prepareExtensionUpdate({ extension }),
    ).rejects.toBeInstanceOf(ManagedExtensionReadOnlyError);
    await expect(
      subject.updateExtension(
        extension,
        ExtensionUpdateState.UPDATE_AVAILABLE,
        vi.fn(),
      ),
    ).rejects.toBeInstanceOf(ManagedExtensionReadOnlyError);
    const replacement = writeExtension(temporary, 'replacement', {
      name: 'portable',
    });
    await expect(
      manager().installExtension({ type: 'local', source: replacement }),
    ).rejects.toBeInstanceOf(ManagedExtensionReadOnlyError);
    expect(inventory(managed)).toEqual(before);
    expect(inventory(path.join(user, 'portable'))).toEqual(userBefore);
  });

  it('never deletes a shadowed user artifact through a stale managed id after the managed disappears', async () => {
    const extensionPath = writeExtension(managed, 'portable');
    const userPath = writeExtension(user, 'portable', { version: 'user' });
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const subject = manager();
    await subject.refreshCache();
    const managedId = subject.getLoadedExtensions()[0].id;
    fs.rmSync(extensionPath, { recursive: true });
    await expect(
      manager().uninstallExtensionById(managedId, false),
    ).rejects.toBeInstanceOf(ManagedExtensionReadOnlyError);
    await expect(
      manager({ managedExtensionsDir: undefined }).uninstallExtensionById(
        managedId,
        false,
      ),
    ).rejects.toBeInstanceOf(ManagedExtensionReadOnlyError);
    expect(fs.existsSync(path.join(userPath, EXTENSIONS_CONFIG_FILENAME))).toBe(
      true,
    );
  });

  it('rechecks managed ownership when committing a previously prepared user install', async () => {
    const replacement = writeExtension(temporary, 'replacement', {
      name: 'portable',
    });
    const subject = manager();
    await subject.refreshCache();
    const prepared = await subject.prepareExtensionInstall({
      installMetadata: { type: 'local', source: replacement },
      initialActivation: { scope: 'user' },
    });
    writeExtension(managed, 'portable');
    try {
      await expect(
        subject.commitPreparedExtension(prepared),
      ).rejects.toBeInstanceOf(ManagedExtensionReadOnlyError);
      expect(fs.existsSync(path.join(user, 'portable'))).toBe(false);
    } finally {
      await subject.disposePreparedExtension(prepared);
    }
  });

  it('update-all reports managed skips while continuing user updates', async () => {
    writeExtension(managed, 'portable');
    writeExtension(user, 'updatable');
    const subject = manager();
    await subject.refreshCache();
    const update = vi.spyOn(subject, 'updateExtension').mockResolvedValue({
      name: 'updatable',
      originalVersion: '1',
      updatedVersion: '2',
    });
    const callback = vi.fn();
    const states = new Map(
      subject
        .getLoadedExtensions()
        .map((extension) => [
          extension.name,
          { status: ExtensionUpdateState.UPDATE_AVAILABLE, processed: true },
        ]),
    );
    expect(
      await subject.updateAllUpdatableExtensions(states, callback),
    ).toEqual([
      { name: 'updatable', originalVersion: '1', updatedVersion: '2' },
    ]);
    expect(callback).toHaveBeenCalledWith(
      'portable',
      ExtensionUpdateState.NOT_UPDATABLE,
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].source).toBe('user');
  });

  it('retains CLI name selection and leaves unspecified managed roots unused', async () => {
    writeExtension(managed, 'portable');
    writeExtension(user, 'personal');
    const selected = manager({ enabledExtensionOverrides: ['portable'] });
    await selected.refreshCache();
    expect(
      selected
        .getLoadedExtensions()
        .map(({ name, isActive }) => [name, isActive]),
    ).toEqual([
      ['portable', true],
      ['personal', false],
    ]);
    const omitted = manager({ managedExtensionsDir: undefined });
    await omitted.refreshCache();
    expect(omitted.getLoadedExtensions()).toEqual([
      expect.objectContaining({ name: 'personal', source: 'user' }),
    ]);
  });

  it('rejects overlapping managed and writable state paths, including symlink aliases', () => {
    fs.mkdirSync(user, { recursive: true });
    expect(() => manager({ managedExtensionsDir: user })).toThrow(
      'must not overlap writable extension state',
    );
    expect(() => manager({ managedExtensionsDir: temporary })).toThrow(
      'must not overlap writable extension state',
    );
    const nested = path.join(user, 'nested');
    fs.mkdirSync(nested);
    expect(() => manager({ managedExtensionsDir: nested })).toThrow(
      'must not overlap writable extension state',
    );
    const alias = path.join(temporary, 'alias');
    fs.symlinkSync(
      user,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => manager({ managedExtensionsDir: alias })).toThrow(
      'must not overlap writable extension state',
    );
    expect(() =>
      manager({
        extensionStore: new ExtensionStore({
          extensionsDir: user,
          storeDir: path.join(managed, 'new-state'),
        }),
      }),
    ).toThrow('must not overlap writable extension state');
  });

  it.each(['omitted', 'absolute', 'explicit-cwd'] as const)(
    'does not read the process cwd for a %s managed root',
    (kind) => {
      const cwd = vi.spyOn(process, 'cwd').mockImplementation(() => {
        throw Object.assign(new Error('Startup cwd was removed'), {
          code: 'ENOENT',
        });
      });
      let result: string | undefined;
      let failure: unknown;
      let calls = 0;
      try {
        result = resolveManagedExtensionsDir(
          kind === 'omitted'
            ? undefined
            : kind === 'absolute'
              ? managed
              : 'managed',
          kind === 'explicit-cwd' ? temporary : undefined,
        );
      } catch (error) {
        failure = error;
      } finally {
        calls = cwd.mock.calls.length;
        cwd.mockRestore();
      }
      expect(failure).toBeUndefined();
      expect(calls).toBe(0);
      expect(result).toBe(kind === 'omitted' ? undefined : managed);
    },
  );

  it('rejects invalid roots clearly and allows an empty root', async () => {
    expect(resolveManagedExtensionsDir('managed', temporary)).toBe(managed);
    expect(resolveManagedExtensionsDir(undefined)).toBeUndefined();
    expect(() => resolveManagedExtensionsDir('')).toThrow(
      'one non-empty directory',
    );
    expect(() =>
      resolveManagedExtensionsDir(['first', 'second'] as unknown as string),
    ).toThrow('one non-empty directory');
    expect(() =>
      manager({ managedExtensionsDir: path.join(temporary, 'missing') }),
    ).toThrow(/Invalid --managed-extensions.*missing/);
    const file = path.join(temporary, 'file');
    fs.writeFileSync(file, 'not a directory');
    expect(() => manager({ managedExtensionsDir: file })).toThrow(
      /Invalid --managed-extensions.*not a directory/,
    );
    await manager().refreshCache();
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      fs.chmodSync(managed, 0);
      try {
        expect(() => manager()).toThrow(/Invalid --managed-extensions.*EACCES/);
      } finally {
        fs.chmodSync(managed, 0o755);
      }
    }
  });
});
