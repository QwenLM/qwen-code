/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExtensionManager, SettingScope } from './extensionManager.js';
import { ExtensionConflictError, ExtensionStore } from './extension-store.js';
import { getAgentPluginSchemaStatus } from './agent-plugins-v1/manifest.js';
import { EXTENSIONS_CONFIG_FILENAME } from './variables.js';
import { SubagentManager } from '../subagents/subagent-manager.js';
import { SubagentError } from '../subagents/types.js';
import type { Config } from '../config/config.js';

const probe = vi.hoisted(() => ({
  readFile: undefined as string | undefined,
  pluginRealpath: false,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: Object.assign(
      (...args: Parameters<typeof actual.realpathSync>) =>
        actual.realpathSync(...args),
      {
        native: (...args: Parameters<typeof actual.realpathSync.native>) => {
          if (probe.pluginRealpath && String(args[0]).endsWith('plugin.json')) {
            throw Object.assign(new Error('ENOMEM injected'), {
              code: 'ENOMEM',
            });
          }
          return actual.realpathSync.native(...args);
        },
      },
    ),
  };
});
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (probe.readFile && String(args[0]).includes(probe.readFile)) {
        return Promise.reject(
          Object.assign(new Error('EMFILE injected'), { code: 'EMFILE' }),
        );
      }
      return actual.readFile(...args);
    },
  };
});

describe('extension scan recovery', () => {
  let root: string;
  let extensionsDir: string;
  let store: ExtensionStore;
  let manager: ExtensionManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr12107-probe-'));
    extensionsDir = path.join(root, 'extensions');
    fs.mkdirSync(extensionsDir);
    vi.stubEnv('QWEN_HOME', root);
    store = new ExtensionStore({
      extensionsDir,
      storeDir: path.join(root, 'store'),
    });
    manager = new ExtensionManager({
      extensionStore: store,
      workspaceDir: root,
      isWorkspaceTrusted: true,
    });
  });
  afterEach(() => {
    probe.readFile = undefined;
    probe.pluginRealpath = false;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(relative: string, text: string) {
    const target = path.join(extensionsDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  function extension(name: string, extra: Record<string, unknown> = {}) {
    write(
      `${name}/${EXTENSIONS_CONFIG_FILENAME}`,
      JSON.stringify({ name, version: '1.0.0', ...extra }),
    );
    return path.join(extensionsDir, name);
  }
  function refusal(name: string, agent = 'explore') {
    write(
      `${name}/agents/${agent}.md`,
      `---\nname: ${agent}\ndescription: Test agent\nexecutor: {kind: invalid, command: runner}\n---\nRefuse this agent.`,
    );
  }
  function skill(name: string) {
    write(
      `${name}/skills/s1/SKILL.md`,
      '---\nname: s1\ndescription: A skill\n---\nUse this skill.',
    );
  }
  function dangling() {
    const file = path.join(extensionsDir, 'zzz-dangling');
    fs.symlinkSync(path.join(root, 'missing'), file);
    return file;
  }
  function subagents() {
    return new SubagentManager(
      {
        getProjectRoot: () => root,
        getActiveExtensions: () =>
          manager.getLoadedExtensions().filter((entry) => entry.isActive),
        getAgentsSettings: () => ({}),
        getSdkMode: () => false,
        isSafeMode: () => false,
      } as unknown as Config,
      {
        getPendingExtensionRefusals: () =>
          manager.getPendingScanRefusals().values(),
      },
    );
  }

  it('calls the rejection callback after a commit conflict', async () => {
    const rejected = vi.fn();
    await expect(
      store.readConsistent(
        async () => ({
          value: null,
          extensions: [
            { id: 'd5'.repeat(32), name: 'dup' },
            { id: 'd6'.repeat(32), name: 'dup' },
          ],
        }),
        rejected,
      ),
    ).rejects.toBeInstanceOf(ExtensionConflictError);
    expect(rejected).toHaveBeenCalledOnce();
  });

  it('preserves resource exhaustion from plugin realpath', () => {
    const ext = extension('healthy');
    expect(getAgentPluginSchemaStatus(ext)).toBe('unrelated');
    probe.pluginRealpath = true;
    expect(() => getAgentPluginSchemaStatus(ext)).toThrow('ENOMEM');
  });

  it('retains earlier refusals after a shorter retry', async () => {
    extension('aaa-refusal');
    refusal('aaa-refusal');
    refusal('aaa-refusal', 'coder');
    dangling();
    await expect(manager.refreshCache()).rejects.toThrow('zzz-dangling');
    expect(
      [...manager.getPendingScanRefusals().get('aaa-refusal')!.keys()].sort(),
    ).toEqual(['coder', 'explore']);
    probe.readFile = 'coder.md';
    await expect(manager.refreshCache()).rejects.toThrow();
    expect(
      [...manager.getPendingScanRefusals().get('aaa-refusal')!.keys()].sort(),
    ).toEqual(['coder', 'explore']);
  });

  it('excludes unrequested extension refusals', async () => {
    extension('aaa-unrequested');
    refusal('aaa-unrequested');
    extension('zzz-selected');
    skill('zzz-selected');
    probe.readFile = `${path.sep}zzz-selected${path.sep}`;
    await expect(
      manager.refreshCache({ names: ['zzz-selected'] }),
    ).rejects.toThrow('EMFILE');
    expect(manager.getPendingScanRefusals().has('aaa-unrequested')).toBe(false);
    expect(
      manager
        .getLoadedExtensions()
        .some((entry) => entry.name === 'aaa-unrequested'),
    ).toBe(false);
  });

  it('preserves commands under distinct aliases of the same directory', async () => {
    const ext = extension('diamond');
    write('diamond/commands/original/deploy.md', 'Deploy carefully.');
    fs.symlinkSync(
      path.join(ext, 'commands/original'),
      path.join(ext, 'commands/alias'),
    );
    fs.symlinkSync(
      path.join(ext, 'commands/original'),
      path.join(ext, 'commands/second-alias'),
    );
    await manager.refreshCache();
    expect(manager.getLoadedExtensions()[0].commands?.sort()).toEqual([
      'alias:deploy',
      'original:deploy',
      'second-alias:deploy',
    ]);
  });

  it('waits for the named sibling before merging refusals', async () => {
    extension('refusal-ext');
    refusal('refusal-ext');
    const load = manager.loadExtensionByName.bind(manager);
    let sibling: ReturnType<typeof load> | undefined;
    vi.spyOn(manager, 'loadExtensionByName').mockImplementation(
      async (name, cwd, ledger) => {
        if (name === 'fast-failure') throw new Error('fast failure');
        sibling = (async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return load(name, cwd, ledger);
        })();
        return sibling;
      },
    );
    await expect(
      manager.refreshCache({ names: ['fast-failure', 'refusal-ext'] }),
    ).rejects.toThrow('fast failure');
    await sibling;
    expect(
      manager.getPendingScanRefusals().get('refusal-ext')?.has('explore'),
    ).toBe(true);
  });

  it('does not expose an active hollow extension on a fresh store', async () => {
    extension('aaa-refusal', { mcpServers: { server: { command: 'node' } } });
    refusal('aaa-refusal');
    skill('aaa-refusal');
    write('aaa-refusal/commands/deploy.md', 'Deploy carefully.');
    probe.readFile = `${path.sep}skills${path.sep}`;
    await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
    const entry = manager
      .getLoadedExtensions()
      .find((item) => item.name === 'aaa-refusal');
    expect(entry?.isActive ?? false).toBe(false);
    expect(
      manager.getPendingScanRefusals().get('aaa-refusal')?.has('explore'),
    ).toBe(true);
  });

  it('does not activate a failed scan during an unrelated store mutation', async () => {
    extension('other');
    await manager.refreshCache();
    extension('aaa-refusal');
    refusal('aaa-refusal');
    const seeder = new ExtensionManager({
      extensionStore: store,
      workspaceDir: root,
      isWorkspaceTrusted: true,
    });
    await seeder.refreshCache();
    dangling();
    const activation = vi
      .spyOn(store, 'getActivation')
      .mockImplementation(() => {
        throw new Error('cannot derive activation');
      });
    await expect(manager.refreshCache()).rejects.toThrow('zzz-dangling');
    activation.mockRestore();
    await manager.setExtensionDefaultActivations(['other'], 'enabled');
    const entry = manager
      .getLoadedExtensions()
      .find((item) => item.name === 'aaa-refusal');
    expect(entry?.isActive ?? false).toBe(false);
  });

  it('withdraws only the pending name covered by a successful named refresh', async () => {
    extension('aaa-refusal');
    refusal('aaa-refusal');
    extension('bbb-refusal');
    refusal('bbb-refusal', 'coder');
    const link = dangling();
    await expect(manager.refreshCache()).rejects.toThrow('zzz-dangling');
    fs.unlinkSync(link);
    write(
      'aaa-refusal/agents/explore.md',
      '---\nname: explore\ndescription: Repaired agent\n---\nExplore carefully.',
    );
    await manager.refreshCache({ names: ['aaa-refusal'] });
    expect(manager.getPendingScanRefusals().has('aaa-refusal')).toBe(false);
    expect(manager.getPendingScanRefusals().has('bbb-refusal')).toBe(true);
  });

  it('preserves refusals for a skipped extension without publishing it', async () => {
    extension('aaa-broken', { hooks: { PreToolUse: [null] } });
    refusal('aaa-broken');
    dangling();
    await expect(manager.refreshCache()).rejects.toThrow('zzz-dangling');
    expect(
      manager.getLoadedExtensions().map((entry) => entry.name),
    ).not.toContain('aaa-broken');
    await expect(subagents().loadSubagent('explore')).rejects.toBeInstanceOf(
      SubagentError,
    );
  });

  it('refuses activating an incomplete entry or restores its real resources', async () => {
    extension('aaa-refusal', { mcpServers: { server: { command: 'node' } } });
    refusal('aaa-refusal');
    skill('aaa-refusal');
    await manager.refreshCache();
    manager = new ExtensionManager({
      extensionStore: store,
      workspaceDir: root,
      isWorkspaceTrusted: true,
    });
    probe.readFile = `${path.sep}skills${path.sep}`;
    await expect(manager.refreshCache()).rejects.toThrow('EMFILE');
    probe.readFile = undefined;
    try {
      await manager.enableExtension('aaa-refusal', SettingScope.User);
    } catch (error) {
      expect(String(error)).toContain('does not exist');
      return;
    }
    const entry = manager
      .getLoadedExtensions()
      .find((item) => item.name === 'aaa-refusal');
    expect(entry?.skills).toHaveLength(1);
    expect(entry?.config.mcpServers).toBeDefined();
  });

  it.each(['malformed manifest', 'unreadable agents directory'])(
    'retains a refusal after a commit with %s',
    async (mode) => {
      const ext = extension('aaa-refusal');
      refusal('aaa-refusal');
      const link = dangling();
      await expect(manager.refreshCache()).rejects.toThrow('zzz-dangling');
      fs.unlinkSync(link);
      if (mode === 'malformed manifest') {
        write(`aaa-refusal/${EXTENSIONS_CONFIG_FILENAME}`, '{ broken JSON');
      } else {
        fs.renameSync(
          path.join(ext, 'agents'),
          path.join(ext, 'agents-unreadable'),
        );
        write('aaa-refusal/agents', 'not a directory');
      }
      await manager.refreshCache();
      expect(
        manager.getPendingScanRefusals().get('aaa-refusal')?.has('explore'),
      ).toBe(true);
      await expect(subagents().loadSubagent('explore')).rejects.toBeInstanceOf(
        SubagentError,
      );
    },
  );

  it('withdraws a refusal after the extension directory disappears', async () => {
    const ext = extension('aaa-refusal');
    refusal('aaa-refusal');
    const link = dangling();
    await expect(manager.refreshCache()).rejects.toThrow('zzz-dangling');
    fs.unlinkSync(link);
    fs.rmSync(ext, { recursive: true });
    await manager.refreshCache();
    expect(manager.getPendingScanRefusals().has('aaa-refusal')).toBe(false);
    expect((await subagents().loadSubagent('explore'))?.isBuiltin).toBe(true);
  });

  it('withdraws a pending refusal after a prepared install', async () => {
    const old = extension('aaa-refusal');
    refusal('aaa-refusal');
    extension('bbb-refusal');
    refusal('bbb-refusal', 'coder');
    const link = dangling();
    await expect(manager.refreshCache()).rejects.toThrow('zzz-dangling');
    fs.unlinkSync(link);
    fs.rmSync(old, { recursive: true });
    const source = path.join(root, 'install-source');
    fs.mkdirSync(source);
    fs.writeFileSync(
      path.join(source, EXTENSIONS_CONFIG_FILENAME),
      JSON.stringify({ name: 'aaa-refusal', version: '2.0.0' }),
    );
    const installed = await manager.installExtension({ type: 'local', source });
    expect(installed.version).toBe('2.0.0');
    expect(manager.getPendingScanRefusals().has('aaa-refusal')).toBe(false);
    expect(manager.getPendingScanRefusals().has('bbb-refusal')).toBe(true);
  });

  it('keeps dispatch refused after a cold prepared install re-records the invalid executor', async () => {
    const old = extension('aaa-refusal');
    refusal('aaa-refusal');
    const link = dangling();
    await expect(manager.refreshCache()).rejects.toThrow('zzz-dangling');
    fs.unlinkSync(link);
    const source = path.join(root, 'still-refused-source');
    fs.cpSync(old, source, { recursive: true });
    fs.rmSync(old, { recursive: true });
    await manager.installExtension({ type: 'local', source });
    expect(manager.getPendingScanRefusals().has('aaa-refusal')).toBe(false);
    expect(manager.getLoadedExtensions().map((entry) => entry.name)).toContain(
      'aaa-refusal',
    );
    await expect(subagents().loadSubagent('explore')).rejects.toBeInstanceOf(
      SubagentError,
    );
  });

  it('withdraws a pending refusal after a legacy update', async () => {
    const source = path.join(root, 'update-source');
    fs.mkdirSync(source);
    fs.writeFileSync(
      path.join(source, EXTENSIONS_CONFIG_FILENAME),
      JSON.stringify({ name: 'aaa-refusal', version: '1.0.0' }),
    );
    await manager.refreshCache();
    const installed = await manager.installExtension({ type: 'local', source });
    refusal('aaa-refusal');
    extension('bbb-refusal');
    refusal('bbb-refusal', 'coder');
    const link = dangling();
    await expect(manager.refreshCache()).rejects.toThrow('zzz-dangling');
    fs.unlinkSync(link);
    fs.writeFileSync(
      path.join(source, EXTENSIONS_CONFIG_FILENAME),
      JSON.stringify({ name: 'aaa-refusal', version: '2.0.0' }),
    );
    const updated = await manager.installExtension(
      { type: 'local', source },
      undefined,
      undefined,
      undefined,
      installed.config,
    );
    expect(updated.version).toBe('2.0.0');
    expect(manager.getPendingScanRefusals().has('aaa-refusal')).toBe(false);
    expect(manager.getPendingScanRefusals().has('bbb-refusal')).toBe(true);
  });

  it('retains a refusal on a generic agent parse failure until repair', async () => {
    extension('aaa-refusal');
    refusal('aaa-refusal');
    const link = dangling();
    await expect(manager.refreshCache()).rejects.toThrow('zzz-dangling');
    fs.unlinkSync(link);
    write('aaa-refusal/agents/explore.md', 'incomplete agent file');
    await manager.refreshCache();
    await expect(subagents().loadSubagent('explore')).rejects.toBeInstanceOf(
      SubagentError,
    );
    write(
      'aaa-refusal/agents/explore.md',
      '---\nname: explore\ndescription: Repaired agent\n---\nExplore carefully.',
    );
    await manager.refreshCache();
    expect(manager.getPendingScanRefusals().has('aaa-refusal')).toBe(false);
    expect((await subagents().loadSubagent('explore'))?.level).toBe(
      'extension',
    );
  });

  it('withdraws a pending refusal when a complete rescan finds no agents directory', async () => {
    const ext = extension('aaa-refusal');
    refusal('aaa-refusal');
    const link = dangling();
    await expect(manager.refreshCache()).rejects.toThrow('zzz-dangling');
    fs.unlinkSync(link);
    fs.rmSync(path.join(ext, 'agents'), { recursive: true });
    await manager.refreshCache();
    expect(manager.getPendingScanRefusals().has('aaa-refusal')).toBe(false);
    expect((await subagents().loadSubagent('explore'))?.isBuiltin).toBe(true);
  });

  it('keeps a completed sibling complete or absent after a rejected batch', async () => {
    extension('aaa-refusal', {
      mcpServers: { server: { command: 'node' } },
      contextFileName: 'QWEN.md',
    });
    refusal('aaa-refusal');
    skill('aaa-refusal');
    write('aaa-refusal/QWEN.md', 'Project context.');
    write('aaa-refusal/commands/deploy.md', 'Deploy carefully.');
    dangling();
    await expect(manager.refreshCache()).rejects.toThrow('zzz-dangling');
    expect(
      manager.getPendingScanRefusals().get('aaa-refusal')?.has('explore'),
    ).toBe(true);
    const entry = manager
      .getLoadedExtensions()
      .find((item) => item.name === 'aaa-refusal');
    if (entry) {
      expect(entry.skills).toHaveLength(1);
      expect(entry.config.mcpServers).toBeDefined();
      expect(entry.contextFiles).toHaveLength(1);
      expect(entry.commands).toEqual(['deploy']);
    }
  });
});
