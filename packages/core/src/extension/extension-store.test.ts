/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExtensionConflictError,
  ExtensionStore,
  ExtensionStoreCorruptError,
} from './extension-store.js';

describe('ExtensionStore', () => {
  let root: string;
  let extensionsDir: string;
  let storeDir: string;
  let enablementPath: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-extension-store-'));
    extensionsDir = path.join(root, 'extensions');
    storeDir = path.join(root, 'extension-store');
    enablementPath = path.join(extensionsDir, 'extension-enablement.json');
    await fsp.mkdir(extensionsDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const makeStore = () =>
    new ExtensionStore({ extensionsDir, storeDir, enablementPath });

  it('imports V1 rules without materializing workspace overrides', async () => {
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({
        demo: { overrides: ['!/work/*', '/work/enabled/*'] },
      }),
    );
    const store = makeStore();

    const snapshot = await store.ensureInitialized([
      { id: 'a'.repeat(64), name: 'demo' },
    ]);

    expect(snapshot.generation).toBe(0);
    expect(snapshot.extensions['a'.repeat(64)]).toEqual({
      name: 'demo',
      defaultActivation: 'enabled',
      workspaceOverrides: {},
      legacyPathRules: ['!/work/*', '/work/enabled/*'],
    });
    expect(
      store.getActivation(snapshot, 'a'.repeat(64), 'demo', '/work/disabled'),
    ).toMatchObject({ effective: 'disabled', source: 'legacy_path_rule' });
    expect(
      store.getActivation(snapshot, 'a'.repeat(64), 'demo', '/work/enabled'),
    ).toMatchObject({ effective: 'enabled', source: 'legacy_path_rule' });
  });

  it('preserves exact workspace overrides when the global default changes', async () => {
    const store = makeStore();
    const id = 'b'.repeat(64);
    await store.ensureInitialized([{ id, name: 'demo' }]);
    await store.setWorkspaceActivation(
      { id, name: 'demo' },
      '/workspace/a',
      'enabled',
    );

    const snapshot = await store.setDefaultActivation(
      { id, name: 'demo' },
      'disabled',
    );

    expect(snapshot.generation).toBe(2);
    expect(snapshot.extensions[id]?.workspaceOverrides).toEqual({
      '/workspace/a': 'enabled',
    });
    expect(
      store.getActivation(snapshot, id, 'demo', '/workspace/a'),
    ).toMatchObject({ effective: 'enabled', source: 'workspace_override' });
  });

  it('uses an inherit mask when clearing an override matched by a legacy rule', async () => {
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({ demo: { overrides: ['!/workspace/*'] } }),
    );
    const store = makeStore();
    const id = 'c'.repeat(64);
    await store.ensureInitialized([{ id, name: 'demo' }]);

    const snapshot = await store.clearWorkspaceActivation(
      { id, name: 'demo' },
      '/workspace/a',
    );

    expect(snapshot.extensions[id]?.workspaceOverrides).toEqual({
      '/workspace/a': 'inherit',
    });
    expect(store.getActivation(snapshot, id, 'demo', '/workspace/a')).toEqual({
      default: 'enabled',
      workspace: 'inherit',
      effective: 'enabled',
      source: 'default',
    });
  });

  it('serializes writes from independent store instances without losing updates', async () => {
    const id = 'd'.repeat(64);
    const first = makeStore();
    const second = makeStore();
    await first.ensureInitialized([{ id, name: 'demo' }]);

    await Promise.all([
      first.setWorkspaceActivation(
        { id, name: 'demo' },
        '/workspace/a',
        'enabled',
      ),
      second.setWorkspaceActivation(
        { id, name: 'demo' },
        '/workspace/b',
        'disabled',
      ),
    ]);

    const snapshot = await first.readSnapshot();
    expect(snapshot.generation).toBe(2);
    expect(snapshot.extensions[id]?.workspaceOverrides).toEqual({
      '/workspace/a': 'enabled',
      '/workspace/b': 'disabled',
    });
  });

  it('preserves a committed result when lock release reports an error', async () => {
    const store = makeStore();
    const identity = { id: 'd3'.repeat(32), name: 'demo' };
    await store.ensureInitialized([identity]);
    const lock = lockfile.lock.bind(lockfile);
    const lockSpy = vi
      .spyOn(lockfile, 'lock')
      .mockImplementation(async (...args) => {
        const release = await lock(...args);
        return async () => {
          await release();
          throw new Error('release failed');
        };
      });

    try {
      await expect(
        store.setDefaultActivation(identity, 'disabled'),
      ).resolves.toMatchObject({ generation: 1 });
    } finally {
      lockSpy.mockRestore();
    }

    await expect(store.readSnapshot()).resolves.toMatchObject({
      generation: 1,
      extensions: {
        [identity.id]: { defaultActivation: 'disabled' },
      },
    });
  });

  it('serializes mutations from two Node processes sharing QWEN_HOME', async () => {
    const id = 'd2'.repeat(32);
    const store = makeStore();
    await store.ensureInitialized([{ id, name: 'demo' }]);
    const moduleUrl = pathToFileURL(
      path.resolve('src/extension/extension-store.ts'),
    ).href;
    const runChild = async (workspacePath: string, activation: string) => {
      const source = `
        import { ExtensionStore } from ${JSON.stringify(moduleUrl)};
        const store = new ExtensionStore(${JSON.stringify({ extensionsDir, storeDir, enablementPath })});
        await store.setWorkspaceActivation(
          ${JSON.stringify({ id, name: 'demo' })},
          ${JSON.stringify(workspacePath)},
          ${JSON.stringify(activation)},
        );
      `;
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '--eval', source],
          { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] },
        );
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`child exited ${code}: ${stderr}`));
        });
      });
    };

    await Promise.all([
      runChild('/workspace/process-a', 'enabled'),
      runChild('/workspace/process-b', 'disabled'),
    ]);

    const snapshot = await store.readSnapshot();
    expect(snapshot.generation).toBe(2);
    expect(snapshot.extensions[id]?.workspaceOverrides).toEqual({
      '/workspace/process-a': 'enabled',
      '/workspace/process-b': 'disabled',
    });
  });

  it('holds mutation commits while a consistent artifact snapshot is read', async () => {
    const id = 'd3'.repeat(32);
    const store = makeStore();
    await store.ensureInitialized([{ id, name: 'demo' }]);
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const reading = store.readConsistent(async () => {
      readStarted();
      await readGate;
      return {
        value: 'complete-artifact-scan',
        extensions: [{ id, name: 'demo' }],
      };
    });
    await started;
    let mutationSettled = false;
    const mutation = store
      .setDefaultActivation({ id, name: 'demo' }, 'disabled')
      .finally(() => {
        mutationSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mutationSettled).toBe(false);

    releaseRead();
    await expect(reading).resolves.toMatchObject({
      value: 'complete-artifact-scan',
      snapshot: { generation: 0 },
    });
    await expect(mutation).resolves.toMatchObject({ generation: 1 });
  });

  it.runIf(process.platform !== 'win32')(
    'uses one workspace key for symlink and real paths',
    async () => {
      const store = makeStore();
      const id = 'd1'.repeat(32);
      const realWorkspace = path.join(root, 'real-workspace');
      const linkedWorkspace = path.join(root, 'linked-workspace');
      await fsp.mkdir(realWorkspace);
      await fsp.symlink(realWorkspace, linkedWorkspace);
      await store.ensureInitialized([{ id, name: 'demo' }]);

      const snapshot = await store.setWorkspaceActivation(
        { id, name: 'demo' },
        linkedWorkspace,
        'disabled',
      );

      expect(snapshot.extensions[id]?.workspaceOverrides).toEqual({
        [fs.realpathSync.native(realWorkspace)]: 'disabled',
      });
      expect(
        store.getActivation(snapshot, id, 'demo', realWorkspace),
      ).toMatchObject({
        effective: 'disabled',
        source: 'workspace_override',
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'matches legacy rules against symlink and canonical workspace paths',
    async () => {
      const realWorkspace = path.join(root, 'legacy-real-workspace');
      const linkedWorkspace = path.join(root, 'legacy-linked-workspace');
      await fsp.mkdir(realWorkspace);
      await fsp.symlink(realWorkspace, linkedWorkspace);
      await fsp.writeFile(
        enablementPath,
        JSON.stringify({
          demo: { overrides: [`!${linkedWorkspace}/*`] },
        }),
      );
      const store = makeStore();
      const identity = { id: 'd2'.repeat(32), name: 'demo' };
      let snapshot = await store.ensureInitialized([identity]);

      expect(
        store.getActivation(
          snapshot,
          identity.id,
          identity.name,
          linkedWorkspace,
        ),
      ).toMatchObject({
        effective: 'disabled',
        source: 'legacy_path_rule',
      });

      snapshot = await store.setWorkspaceActivation(
        identity,
        linkedWorkspace,
        'enabled',
      );
      expect(
        store.getActivation(
          snapshot,
          identity.id,
          identity.name,
          linkedWorkspace,
        ),
      ).toMatchObject({
        effective: 'enabled',
        source: 'workspace_override',
      });

      snapshot = await store.clearWorkspaceActivation(
        identity,
        linkedWorkspace,
      );
      expect(
        store.getActivation(
          snapshot,
          identity.id,
          identity.name,
          linkedWorkspace,
        ),
      ).toMatchObject({
        effective: 'enabled',
        source: 'default',
      });
    },
  );

  it('writes a V1 projection after every policy mutation', async () => {
    const store = makeStore();
    const id = 'e'.repeat(64);
    await store.ensureInitialized([{ id, name: 'demo' }]);

    await store.setDefaultActivation({ id, name: 'demo' }, 'disabled');
    await store.setWorkspaceActivation(
      { id, name: 'demo' },
      '/workspace/a',
      'enabled',
    );

    const projection = JSON.parse(
      await fsp.readFile(enablementPath, 'utf8'),
    ) as Record<string, { overrides: string[] }>;
    expect(projection['demo']?.overrides).toEqual(['!/*', '/workspace/a/']);
  });

  it('repairs an older V1 projection without changing generation', async () => {
    const store = makeStore();
    const id = 'e1'.repeat(32);
    await store.ensureInitialized([{ id, name: 'demo' }]);
    const changed = await store.setDefaultActivation(
      { id, name: 'demo' },
      'disabled',
    );
    await fsp.writeFile(enablementPath, '{}');
    const stateStat = await fsp.stat(path.join(storeDir, 'state.json'));
    const older = new Date(stateStat.mtimeMs - 1_000);
    await fsp.utimes(enablementPath, older, older);

    const repaired = await store.ensureInitialized([{ id, name: 'demo' }]);

    expect(repaired.generation).toBe(changed.generation);
    expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual({
      demo: { overrides: ['!/*'] },
    });
  });

  it('fails closed when state and a different V1 projection have equal mtimes', async () => {
    const store = makeStore();
    const id = 'e6'.repeat(32);
    await store.ensureInitialized([{ id, name: 'demo' }]);
    await store.setDefaultActivation({ id, name: 'demo' }, 'disabled');
    await fsp.writeFile(enablementPath, '{}');
    const sameTime = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    await Promise.all([
      fsp.utimes(path.join(storeDir, 'state.json'), sameTime, sameTime),
      fsp.utimes(enablementPath, sameTime, sameTime),
    ]);

    await expect(
      store.ensureInitialized([{ id, name: 'demo' }]),
    ).rejects.toBeInstanceOf(ExtensionStoreCorruptError);
    expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual({});
  });

  it('keeps V2 reads available when an older V1 projection cannot be repaired', async () => {
    const store = makeStore();
    const id = 'e5'.repeat(32);
    await store.ensureInitialized([{ id, name: 'demo' }]);
    const changed = await store.setDefaultActivation(
      { id, name: 'demo' },
      'disabled',
    );
    await fsp.writeFile(enablementPath, '{}');
    const stateStat = await fsp.stat(path.join(storeDir, 'state.json'));
    const older = new Date(stateStat.mtimeMs - 1_000);
    await fsp.utimes(enablementPath, older, older);

    const projectionAgeSpy = vi
      .spyOn(
        store as unknown as {
          legacyProjectionIsNewerThanState(): Promise<boolean>;
        },
        'legacyProjectionIsNewerThanState',
      )
      .mockImplementationOnce(async () => {
        await fsp.rm(enablementPath);
        await fsp.mkdir(enablementPath);
        return false;
      });
    try {
      const readable = await store.ensureInitialized([{ id, name: 'demo' }]);
      expect(readable).toEqual(changed);
      expect((await fsp.stat(enablementPath)).isDirectory()).toBe(true);
    } finally {
      projectionAgeSpy.mockRestore();
    }

    await fsp.rm(enablementPath, { recursive: true });
    await fsp.writeFile(enablementPath, '{}');
    await fsp.utimes(enablementPath, older, older);
    await store.ensureInitialized([{ id, name: 'demo' }]);
    expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual({
      demo: { overrides: ['!/*'] },
    });
  });

  it('imports a newer V1 projection as a sequential downgrade write', async () => {
    const store = makeStore();
    const id = 'e2'.repeat(32);
    await store.ensureInitialized([{ id, name: 'demo' }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({ demo: { overrides: ['!/workspace/*'] } }),
    );

    const imported = await store.ensureInitialized([{ id, name: 'demo' }]);

    expect(imported.generation).toBe(1);
    expect(imported.extensions[id]?.legacyPathRules).toEqual(['!/workspace/*']);
  });

  it('repairs an unchanged newer V1 projection without changing generation', async () => {
    const store = makeStore();
    const id = 'e4'.repeat(32);
    const initialized = await store.ensureInitialized([{ id, name: 'demo' }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({ stale: { overrides: ['/workspace/unused'] } }),
    );

    const repaired = await store.ensureInitialized([{ id, name: 'demo' }]);

    expect(repaired.generation).toBe(initialized.generation);
    expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual({});
  });

  it('preserves artifact generation across a sequential downgrade write', async () => {
    const store = makeStore();
    const identity = { id: 'e3'.repeat(32), name: 'demo' };
    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'version'), 'one');
    const installed = await store.commitArtifact({
      operation: 'install',
      identity,
      stagingDirectory: staging,
      destinationDirectory: path.join(extensionsDir, identity.name),
      initialActivation: { scope: 'user' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({ demo: { overrides: ['!/workspace/*'] } }),
    );

    const imported = await store.ensureInitialized([identity]);

    expect(imported.extensions[identity.id]?.artifactGeneration).toBe(
      installed.extensions[identity.id]?.artifactGeneration,
    );
    expect(imported.extensions[identity.id]).toMatchObject({
      defaultActivation: 'enabled',
      workspaceOverrides: {},
      legacyPathRules: ['!/workspace/*'],
    });
  });

  it('preserves V2 activation policy across a sequential downgrade write', async () => {
    const store = makeStore();
    const identity = { id: 'e4'.repeat(32), name: 'demo' };
    await store.ensureInitialized([identity]);
    await store.setDefaultActivation(identity, 'disabled');
    await store.setWorkspaceActivation(
      identity,
      '/workspace/enabled',
      'enabled',
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({ demo: { overrides: ['!/workspace/legacy/*'] } }),
    );

    const imported = await store.ensureInitialized([identity]);

    expect(imported.extensions[identity.id]).toMatchObject({
      defaultActivation: 'disabled',
      workspaceOverrides: { '/workspace/enabled': 'enabled' },
      legacyPathRules: ['!/workspace/legacy/*'],
    });
  });

  it('does not import generated V2 rules as legacy rules', async () => {
    const store = makeStore();
    const identity = { id: 'e5'.repeat(32), name: 'demo' };
    await store.ensureInitialized([identity]);
    await store.setDefaultActivation(identity, 'disabled');
    await store.setWorkspaceActivation(
      identity,
      '/workspace/enabled',
      'enabled',
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({
        demo: {
          overrides: ['!/*', '/workspace/enabled/', '!/workspace/legacy/*'],
        },
      }),
    );

    const imported = await store.ensureInitialized([identity]);

    expect(imported.extensions[identity.id]?.legacyPathRules).toEqual([
      '!/workspace/legacy/*',
    ]);
  });

  it('imports newer V1 rules for policies omitted from a partial refresh', async () => {
    const store = makeStore();
    const first = { id: 'e6'.repeat(32), name: 'first' };
    const second = { id: 'e7'.repeat(32), name: 'second' };
    await store.ensureInitialized([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({
        first: { overrides: ['!/workspace/first/*'] },
        second: { overrides: ['!/workspace/second/*'] },
      }),
    );

    const imported = await store.ensureInitialized([first]);

    expect(imported.extensions[first.id]?.legacyPathRules).toEqual([
      '!/workspace/first/*',
    ]);
    expect(imported.extensions[second.id]?.legacyPathRules).toEqual([
      '!/workspace/second/*',
    ]);
  });

  it('fails closed when the V2 state is corrupt', async () => {
    await fsp.mkdir(storeDir, { recursive: true });
    await fsp.writeFile(path.join(storeDir, 'state.json'), '{not-json');
    const store = makeStore();

    await expect(store.readSnapshot()).rejects.toBeInstanceOf(
      ExtensionStoreCorruptError,
    );
    expect(fs.existsSync(path.join(storeDir, 'state.json'))).toBe(true);
  });

  it('commits an installed artifact and its initial activation together', async () => {
    const store = makeStore();
    const identity = { id: 'f'.repeat(64), name: 'demo' };
    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'qwen-extension.json'), '{}');

    const snapshot = await store.commitArtifact({
      operation: 'install',
      identity,
      stagingDirectory: staging,
      destinationDirectory: path.join(extensionsDir, 'demo'),
      initialActivation: {
        scope: 'workspace',
        workspacePath: '/workspace/a',
      },
    });

    expect(snapshot.generation).toBe(1);
    expect(snapshot.extensions[identity.id]).toMatchObject({
      artifactGeneration: 1,
      defaultActivation: 'disabled',
      workspaceOverrides: { '/workspace/a': 'enabled' },
    });
    await expect(
      fsp.readFile(
        path.join(extensionsDir, 'demo', 'qwen-extension.json'),
        'utf8',
      ),
    ).resolves.toBe('{}');
    expect(fs.existsSync(staging)).toBe(false);
  });

  it('changes artifact generation only for artifact commits', async () => {
    const store = makeStore();
    const identity = { id: '91'.repeat(32), name: 'demo' };
    const destination = path.join(extensionsDir, 'demo');
    const install = await store.createStagingDirectory();
    await fsp.writeFile(path.join(install, 'version'), 'one');
    const installed = await store.commitArtifact({
      operation: 'install',
      identity,
      stagingDirectory: install,
      destinationDirectory: destination,
      initialActivation: { scope: 'user' },
    });

    const activated = await store.setDefaultActivation(identity, 'disabled');
    expect(activated.generation).toBe(installed.generation + 1);
    expect(activated.extensions[identity.id]?.artifactGeneration).toBe(
      installed.generation,
    );

    const update = await store.createStagingDirectory();
    await fsp.writeFile(path.join(update, 'version'), 'two');
    const updated = await store.commitArtifact({
      operation: 'update',
      identity,
      stagingDirectory: update,
      destinationDirectory: destination,
      expectedArtifactGeneration: installed.generation,
    });
    expect(updated.extensions[identity.id]?.artifactGeneration).toBe(
      updated.generation,
    );
  });

  it('does not recreate activation policy after uninstall', async () => {
    const store = makeStore();
    const identity = { id: '97'.repeat(32), name: 'demo' };
    const destination = path.join(extensionsDir, identity.name);
    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'version'), 'one');
    await store.commitArtifact({
      operation: 'install',
      identity,
      stagingDirectory: staging,
      destinationDirectory: destination,
      initialActivation: { scope: 'user' },
    });
    await store.commitArtifact({
      operation: 'uninstall',
      identity,
      destinationDirectory: destination,
    });

    await expect(
      store.setDefaultActivation(identity, 'disabled'),
    ).rejects.toMatchObject({ code: 'extension_conflict' });
    await expect(store.readSnapshot()).resolves.toMatchObject({
      extensions: {},
    });
  });

  it('rejects a stale prepared update without replacing the artifact', async () => {
    const store = makeStore();
    const identity = { id: '92'.repeat(32), name: 'demo' };
    const destination = path.join(extensionsDir, 'demo');
    const install = await store.createStagingDirectory();
    await fsp.writeFile(path.join(install, 'version'), 'one');
    const installed = await store.commitArtifact({
      operation: 'install',
      identity,
      stagingDirectory: install,
      destinationDirectory: destination,
      initialActivation: { scope: 'user' },
    });
    const firstUpdate = await store.createStagingDirectory();
    await fsp.writeFile(path.join(firstUpdate, 'version'), 'two');
    await store.commitArtifact({
      operation: 'update',
      identity,
      stagingDirectory: firstUpdate,
      destinationDirectory: destination,
      expectedArtifactGeneration: installed.generation,
    });
    const staleUpdate = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staleUpdate, 'version'), 'stale');

    await expect(
      store.commitArtifact({
        operation: 'update',
        identity,
        stagingDirectory: staleUpdate,
        destinationDirectory: destination,
        expectedArtifactGeneration: installed.generation,
      }),
    ).rejects.toBeInstanceOf(ExtensionConflictError);
    await expect(
      fsp.readFile(path.join(destination, 'version'), 'utf8'),
    ).resolves.toBe('two');
  });

  it('rebases prepared updates for different artifacts', async () => {
    const store = makeStore();
    const first = { id: '95'.repeat(32), name: 'first' };
    const second = { id: '96'.repeat(32), name: 'second' };
    const install = async (identity: typeof first) => {
      const staging = await store.createStagingDirectory();
      await fsp.writeFile(path.join(staging, 'version'), 'one');
      return await store.commitArtifact({
        operation: 'install',
        identity,
        stagingDirectory: staging,
        destinationDirectory: path.join(extensionsDir, identity.name),
        initialActivation: { scope: 'user' },
      });
    };
    const firstInstalled = await install(first);
    const secondInstalled = await install(second);
    const firstUpdate = await store.createStagingDirectory();
    const secondUpdate = await store.createStagingDirectory();
    await fsp.writeFile(path.join(firstUpdate, 'version'), 'first-updated');
    await fsp.writeFile(path.join(secondUpdate, 'version'), 'second-updated');

    await store.commitArtifact({
      operation: 'update',
      identity: first,
      stagingDirectory: firstUpdate,
      destinationDirectory: path.join(extensionsDir, first.name),
      expectedArtifactGeneration:
        firstInstalled.extensions[first.id]!.artifactGeneration,
    });
    await store.commitArtifact({
      operation: 'update',
      identity: second,
      stagingDirectory: secondUpdate,
      destinationDirectory: path.join(extensionsDir, second.name),
      expectedArtifactGeneration:
        secondInstalled.extensions[second.id]!.artifactGeneration,
    });

    await expect(
      fsp.readFile(path.join(extensionsDir, first.name, 'version'), 'utf8'),
    ).resolves.toBe('first-updated');
    await expect(
      fsp.readFile(path.join(extensionsDir, second.name, 'version'), 'utf8'),
    ).resolves.toBe('second-updated');
  });

  it('replaces stale policy state when its artifact is absent', async () => {
    const store = makeStore();
    const identity = { id: '93'.repeat(32), name: 'existing-policy' };
    const destination = path.join(extensionsDir, identity.name);
    const initialStaging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(initialStaging, 'version'), 'old artifact');
    await store.commitArtifact({
      operation: 'install',
      identity,
      stagingDirectory: initialStaging,
      destinationDirectory: destination,
      initialActivation: {
        scope: 'workspace',
        workspacePath: '/workspace/a',
      },
    });
    await fsp.rm(destination, { recursive: true });
    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'version'), 'new artifact');

    const snapshot = await store.commitArtifact({
      operation: 'install',
      identity,
      stagingDirectory: staging,
      destinationDirectory: destination,
      initialActivation: { scope: 'user' },
    });

    expect(snapshot.extensions[identity.id]).toMatchObject({
      defaultActivation: 'enabled',
      workspaceOverrides: {},
    });
    await expect(
      fsp.readFile(path.join(destination, 'version'), 'utf8'),
    ).resolves.toBe('new artifact');
  });

  it('rejects update when the artifact has no matching policy', async () => {
    const store = makeStore();
    const identity = { id: '94'.repeat(32), name: 'orphan-artifact' };
    const destination = path.join(extensionsDir, identity.name);
    await fsp.mkdir(destination, { recursive: true });
    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'version'), 'new artifact');

    await expect(
      store.commitArtifact({
        operation: 'update',
        identity,
        stagingDirectory: staging,
        destinationDirectory: destination,
        expectedArtifactGeneration: 0,
      }),
    ).rejects.toMatchObject({ code: 'extension_conflict' });
  });

  it('atomically replaces an artifact while preserving activation policy', async () => {
    const store = makeStore();
    const identity = { id: 'a1'.repeat(32), name: 'demo' };
    const destination = path.join(extensionsDir, 'demo');
    await fsp.mkdir(destination);
    await fsp.writeFile(path.join(destination, 'version'), 'old');
    await store.ensureInitialized([identity]);
    await store.setWorkspaceActivation(identity, '/workspace/a', 'disabled');
    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'version'), 'new');

    const snapshot = await store.commitArtifact({
      operation: 'update',
      identity,
      stagingDirectory: staging,
      destinationDirectory: destination,
    });

    expect(await fsp.readFile(path.join(destination, 'version'), 'utf8')).toBe(
      'new',
    );
    expect(snapshot.extensions[identity.id]?.workspaceOverrides).toEqual({
      '/workspace/a': 'disabled',
    });
  });

  it('moves an uninstalled artifact out of view before removing its policy', async () => {
    const store = makeStore();
    const identity = { id: 'b1'.repeat(32), name: 'demo' };
    const destination = path.join(extensionsDir, 'demo');
    await fsp.mkdir(destination);
    await fsp.writeFile(path.join(destination, 'version'), 'old');
    await store.ensureInitialized([identity]);

    const snapshot = await store.commitArtifact({
      operation: 'uninstall',
      identity,
      destinationDirectory: destination,
    });

    expect(fs.existsSync(destination)).toBe(false);
    expect(snapshot.extensions[identity.id]).toBeUndefined();
  });

  it('idempotently handles concurrent uninstalls when the artifact is absent', async () => {
    const store = makeStore();
    const identity = { id: 'b4'.repeat(32), name: 'demo' };
    const destination = path.join(extensionsDir, 'demo');
    await store.ensureInitialized([identity]);

    const [uninstalled, repeated] = await Promise.all([
      store.commitArtifact({
        operation: 'uninstall',
        identity,
        destinationDirectory: destination,
      }),
      store.commitArtifact({
        operation: 'uninstall',
        identity,
        destinationDirectory: destination,
      }),
    ]);

    expect(uninstalled.extensions[identity.id]).toBeUndefined();
    expect(repeated).toEqual(uninstalled);
  });

  it('allows uninstalling an extension from a snapshot with duplicate names', async () => {
    const store = makeStore();
    const identity = { id: 'b2'.repeat(32), name: 'demo' };
    const duplicateId = 'b3'.repeat(32);
    const destination = path.join(extensionsDir, identity.name);
    await fsp.mkdir(destination);
    const snapshot = await store.ensureInitialized([
      identity,
      { id: duplicateId, name: 'other' },
    ]);
    snapshot.extensions[duplicateId]!.name = identity.name;
    await fsp.writeFile(
      path.join(storeDir, 'state.json'),
      JSON.stringify(snapshot),
    );

    const uninstalled = await store.commitArtifact({
      operation: 'uninstall',
      identity,
      destinationDirectory: destination,
    });

    expect(uninstalled.extensions[identity.id]).toBeUndefined();
    expect(uninstalled.extensions[duplicateId]?.name).toBe(identity.name);
  });

  it('rolls back an artifact-swapped transaction before the commit point', async () => {
    const store = makeStore();
    const identity = { id: 'c1'.repeat(32), name: 'demo' };
    const initial = await store.ensureInitialized([identity]);
    const targetSnapshot = structuredClone(initial);
    targetSnapshot.generation = 1;
    const transactionId = 'recover-before-commit';
    const destination = path.join(extensionsDir, 'demo');
    const backup = path.join(storeDir, 'rollback', transactionId);
    const journal = path.join(
      storeDir,
      'transactions',
      `${transactionId}.json`,
    );
    await fsp.mkdir(destination);
    await fsp.writeFile(path.join(destination, 'version'), 'new');
    await fsp.mkdir(backup);
    await fsp.writeFile(path.join(backup, 'version'), 'old');
    await fsp.writeFile(
      journal,
      JSON.stringify({
        version: 1,
        transactionId,
        operation: 'update',
        phase: 'artifact_swapped',
        destinationDirectory: destination,
        stagingDirectory: path.join(
          storeDir,
          'staging',
          'recover-before-commit',
        ),
        backupDirectory: backup,
        previousGeneration: 0,
        targetGeneration: 1,
        targetSnapshot,
      }),
    );

    await store.ensureInitialized([identity]);

    expect(await fsp.readFile(path.join(destination, 'version'), 'utf8')).toBe(
      'old',
    );
    expect(fs.existsSync(journal)).toBe(false);
  });

  it.each([
    {
      name: 'prepared install',
      operation: 'install' as const,
      phase: 'prepared' as const,
      stagingExists: true,
      destinationVersion: undefined,
      backupVersion: undefined,
      expectedDestinationVersion: undefined,
    },
    {
      name: 'artifact-swapped install',
      operation: 'install' as const,
      phase: 'artifact_swapped' as const,
      stagingExists: false,
      destinationVersion: 'new',
      backupVersion: undefined,
      expectedDestinationVersion: undefined,
    },
    {
      name: 'artifact-swapped uninstall',
      operation: 'uninstall' as const,
      phase: 'artifact_swapped' as const,
      stagingExists: false,
      destinationVersion: undefined,
      backupVersion: 'old',
      expectedDestinationVersion: 'old',
    },
  ])('rolls back a fabricated $name journal', async (scenario) => {
    const store = makeStore();
    const identity = { id: 'c4'.repeat(32), name: 'demo' };
    const initial = await store.ensureInitialized([identity]);
    const targetSnapshot = structuredClone(initial);
    targetSnapshot.generation = 1;
    const transactionId = scenario.name.replaceAll(' ', '-');
    const destination = path.join(extensionsDir, identity.name);
    const staging = path.join(storeDir, 'staging', transactionId);
    const backup = path.join(storeDir, 'rollback', transactionId);
    const journal = path.join(
      storeDir,
      'transactions',
      `${transactionId}.json`,
    );
    if (scenario.stagingExists) {
      await fsp.mkdir(staging);
      await fsp.writeFile(path.join(staging, 'version'), 'staged');
    }
    if (scenario.destinationVersion) {
      await fsp.mkdir(destination);
      await fsp.writeFile(
        path.join(destination, 'version'),
        scenario.destinationVersion,
      );
    }
    if (scenario.backupVersion) {
      await fsp.mkdir(backup);
      await fsp.writeFile(path.join(backup, 'version'), scenario.backupVersion);
    }
    await fsp.writeFile(
      journal,
      JSON.stringify({
        version: 1,
        transactionId,
        operation: scenario.operation,
        phase: scenario.phase,
        destinationDirectory: destination,
        ...(scenario.operation === 'install'
          ? { stagingDirectory: staging }
          : {}),
        backupDirectory: backup,
        previousGeneration: 0,
        targetGeneration: 1,
        targetSnapshot,
      }),
    );

    const recovered = await store.readSnapshot();

    expect(recovered.generation).toBe(0);
    if (scenario.expectedDestinationVersion) {
      await expect(
        fsp.readFile(path.join(destination, 'version'), 'utf8'),
      ).resolves.toBe(scenario.expectedDestinationVersion);
    } else {
      expect(fs.existsSync(destination)).toBe(false);
    }
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.existsSync(backup)).toBe(false);
    expect(fs.existsSync(journal)).toBe(false);
  });

  it('recovers an artifact-swapped transaction before reading a snapshot', async () => {
    const store = makeStore();
    const identity = { id: 'c2'.repeat(32), name: 'demo' };
    const initial = await store.ensureInitialized([identity]);
    const targetSnapshot = structuredClone(initial);
    targetSnapshot.generation = 1;
    const transactionId = 'recover-before-read';
    const destination = path.join(extensionsDir, 'demo');
    const backup = path.join(storeDir, 'rollback', transactionId);
    const journal = path.join(
      storeDir,
      'transactions',
      `${transactionId}.json`,
    );
    await fsp.mkdir(destination);
    await fsp.writeFile(path.join(destination, 'version'), 'new');
    await fsp.mkdir(backup);
    await fsp.writeFile(path.join(backup, 'version'), 'old');
    await fsp.writeFile(
      journal,
      JSON.stringify({
        version: 1,
        transactionId,
        operation: 'update',
        phase: 'artifact_swapped',
        destinationDirectory: destination,
        stagingDirectory: path.join(storeDir, 'staging', transactionId),
        backupDirectory: backup,
        previousGeneration: 0,
        targetGeneration: 1,
        targetSnapshot,
      }),
    );

    const snapshot = await store.readSnapshot();

    expect(snapshot.generation).toBe(0);
    expect(await fsp.readFile(path.join(destination, 'version'), 'utf8')).toBe(
      'old',
    );
    expect(fs.existsSync(journal)).toBe(false);
  });

  it('keeps an artifact when state reached the target generation before the journal phase', async () => {
    const store = makeStore();
    const identity = { id: 'c3'.repeat(32), name: 'demo' };
    const initial = await store.ensureInitialized([identity]);
    const targetSnapshot = structuredClone(initial);
    targetSnapshot.generation = 1;
    const transactionId = 'recover-after-state-write';
    const destination = path.join(extensionsDir, identity.name);
    const backup = path.join(storeDir, 'rollback', transactionId);
    const journal = path.join(
      storeDir,
      'transactions',
      `${transactionId}.json`,
    );
    await fsp.mkdir(destination);
    await fsp.writeFile(path.join(destination, 'version'), 'new');
    await fsp.mkdir(backup);
    await fsp.writeFile(path.join(backup, 'version'), 'old');
    await fsp.writeFile(
      path.join(storeDir, 'state.json'),
      JSON.stringify(targetSnapshot),
    );
    await fsp.writeFile(
      journal,
      JSON.stringify({
        version: 1,
        transactionId,
        operation: 'update',
        phase: 'artifact_swapped',
        destinationDirectory: destination,
        stagingDirectory: path.join(storeDir, 'staging', transactionId),
        backupDirectory: backup,
        previousGeneration: 0,
        targetGeneration: 1,
        targetSnapshot,
      }),
    );

    const recovered = await store.readSnapshot();

    expect(recovered.generation).toBe(1);
    expect(await fsp.readFile(path.join(destination, 'version'), 'utf8')).toBe(
      'new',
    );
    expect(fs.existsSync(backup)).toBe(false);
    expect(fs.existsSync(journal)).toBe(false);
  });

  it('finishes cleanup after a committed transaction', async () => {
    const store = makeStore();
    const identity = { id: 'd1'.repeat(32), name: 'demo' };
    await store.ensureInitialized([identity]);
    const targetSnapshot = await store.setDefaultActivation(
      identity,
      'disabled',
    );
    const transactionId = 'recover-after-commit';
    const destination = path.join(extensionsDir, 'demo');
    const backup = path.join(storeDir, 'rollback', transactionId);
    const journal = path.join(
      storeDir,
      'transactions',
      `${transactionId}.json`,
    );
    await fsp.mkdir(destination);
    await fsp.writeFile(path.join(destination, 'version'), 'new');
    await fsp.mkdir(backup);
    await fsp.writeFile(path.join(backup, 'version'), 'old');
    await fsp.writeFile(
      journal,
      JSON.stringify({
        version: 1,
        transactionId,
        operation: 'update',
        phase: 'state_committed',
        destinationDirectory: destination,
        stagingDirectory: path.join(
          storeDir,
          'staging',
          'recover-after-commit',
        ),
        backupDirectory: backup,
        previousGeneration: 0,
        targetGeneration: 1,
        targetSnapshot,
      }),
    );

    await store.ensureInitialized([identity]);

    expect(await fsp.readFile(path.join(destination, 'version'), 'utf8')).toBe(
      'new',
    );
    expect(fs.existsSync(backup)).toBe(false);
    expect(fs.existsSync(journal)).toBe(false);
  });

  it('keeps committed cleanup failures from blocking store operations', async () => {
    const store = makeStore();
    const identity = { id: 'd2'.repeat(32), name: 'demo' };
    await store.ensureInitialized([identity]);
    const targetSnapshot = await store.setDefaultActivation(
      identity,
      'disabled',
    );
    const transactionId = 'recover-cleanup-failure';
    const destination = path.join(extensionsDir, 'demo');
    const backup = path.join(storeDir, 'rollback', transactionId);
    const journal = path.join(
      storeDir,
      'transactions',
      `${transactionId}.json`,
    );
    await fsp.mkdir(destination);
    await fsp.mkdir(backup);
    await fsp.writeFile(
      journal,
      JSON.stringify({
        version: 1,
        transactionId,
        operation: 'update',
        phase: 'state_committed',
        destinationDirectory: destination,
        stagingDirectory: path.join(storeDir, 'staging', transactionId),
        backupDirectory: backup,
        previousGeneration: 0,
        targetGeneration: 1,
        targetSnapshot,
      }),
    );
    const rm = fsp.rm.bind(fsp);
    const rmSpy = vi
      .spyOn(fsp, 'rm')
      .mockImplementation(async (target, opts) => {
        if (target === backup) throw new Error('cleanup denied');
        return await rm(target, opts);
      });

    try {
      await expect(store.readSnapshot()).resolves.toMatchObject({
        generation: 1,
      });
      await expect(
        store.setDefaultActivation(identity, 'enabled'),
      ).resolves.toMatchObject({ generation: 2 });
      expect(fs.existsSync(journal)).toBe(true);
    } finally {
      rmSpy.mockRestore();
    }

    await store.readSnapshot();
    expect(fs.existsSync(backup)).toBe(false);
    expect(fs.existsSync(journal)).toBe(false);
  });

  it('quarantines a corrupt journal without blocking store operations', async () => {
    const store = makeStore();
    const identity = { id: 'd4'.repeat(32), name: 'demo' };
    await store.ensureInitialized([identity]);
    const transactionsDir = path.join(storeDir, 'transactions');
    const journal = path.join(transactionsDir, 'corrupt.json');
    await fsp.writeFile(journal, '{not-json');

    await expect(store.readSnapshot()).resolves.toMatchObject({
      generation: 0,
    });
    await expect(
      store.setDefaultActivation(identity, 'disabled'),
    ).resolves.toMatchObject({ generation: 1 });

    expect(fs.existsSync(journal)).toBe(false);
    expect(
      (await fsp.readdir(transactionsDir)).some(
        (name) => name.startsWith('corrupt.json.') && name.endsWith('.corrupt'),
      ),
    ).toBe(true);
  });

  it.each(['destination', 'backup', 'staging', 'transaction-id'] as const)(
    'quarantines a journal with a hostile %s path',
    async (kind) => {
      const store = makeStore();
      const identity = { id: 'd5'.repeat(32), name: 'demo' };
      const initial = await store.ensureInitialized([identity]);
      const targetSnapshot = structuredClone(initial);
      targetSnapshot.generation = 1;
      const transactionId = `hostile-${kind}`;
      const outside = path.join(root, 'outside');
      const sentinel = path.join(outside, 'sentinel');
      await fsp.mkdir(outside);
      await fsp.writeFile(sentinel, 'preserve');
      const journal = path.join(
        storeDir,
        'transactions',
        `${transactionId}.json`,
      );
      await fsp.writeFile(
        journal,
        JSON.stringify({
          version: 1,
          transactionId:
            kind === 'transaction-id' ? 'different-id' : transactionId,
          operation: 'update',
          phase: 'artifact_swapped',
          destinationDirectory:
            kind === 'destination'
              ? outside
              : path.join(extensionsDir, identity.name),
          stagingDirectory:
            kind === 'staging'
              ? outside
              : path.join(storeDir, 'staging', transactionId),
          backupDirectory:
            kind === 'backup'
              ? outside
              : path.join(storeDir, 'rollback', transactionId),
          previousGeneration: 0,
          targetGeneration: 1,
          targetSnapshot,
        }),
      );

      await expect(store.readSnapshot()).resolves.toMatchObject({
        generation: 0,
      });
      expect(await fsp.readFile(sentinel, 'utf8')).toBe('preserve');
      expect(fs.existsSync(journal)).toBe(false);
      expect(
        (await fsp.readdir(path.dirname(journal))).some(
          (name) =>
            name.startsWith(`${path.basename(journal)}.`) &&
            name.endsWith('.corrupt'),
        ),
      ).toBe(true);
    },
  );

  it.each(['corrupt', 'missing'] as const)(
    'recovers committed state from a journal when state.json is %s',
    async (stateCondition) => {
      const store = makeStore();
      const identity = { id: 'f1'.repeat(32), name: 'demo' };
      await store.ensureInitialized([identity]);
      const targetSnapshot = await store.setDefaultActivation(
        identity,
        'disabled',
      );
      const transactionId = 'recover-corrupt-commit';
      const destination = path.join(extensionsDir, 'demo');
      const backup = path.join(storeDir, 'rollback', transactionId);
      const journal = path.join(
        storeDir,
        'transactions',
        `${transactionId}.json`,
      );
      await fsp.mkdir(destination);
      await fsp.mkdir(backup);
      await fsp.writeFile(
        journal,
        JSON.stringify({
          version: 1,
          transactionId,
          operation: 'update',
          phase: 'state_committed',
          destinationDirectory: destination,
          stagingDirectory: path.join(
            storeDir,
            'staging',
            'recover-corrupt-commit',
          ),
          backupDirectory: backup,
          previousGeneration: 0,
          targetGeneration: 1,
          targetSnapshot,
        }),
      );
      if (stateCondition === 'corrupt') {
        await fsp.writeFile(path.join(storeDir, 'state.json'), '{broken');
      } else {
        await fsp.rm(path.join(storeDir, 'state.json'));
      }

      const recovered = await store.ensureInitialized([identity]);

      expect(recovered.generation).toBe(1);
      expect(recovered.extensions[identity.id]?.defaultActivation).toBe(
        'disabled',
      );
      expect(fs.existsSync(journal)).toBe(false);
    },
  );

  it.each(['corrupt', 'missing'] as const)(
    'recovers state and projection from state.previous.json when state.json is %s',
    async (stateCondition) => {
      const store = makeStore();
      const identity = { id: 'f2'.repeat(32), name: 'demo' };
      await store.ensureInitialized([identity]);
      await store.setDefaultActivation(identity, 'disabled');
      if (stateCondition === 'corrupt') {
        await fsp.writeFile(path.join(storeDir, 'state.json'), '{broken');
      } else {
        await fsp.rm(path.join(storeDir, 'state.json'));
      }
      await fsp.writeFile(
        enablementPath,
        JSON.stringify({ demo: { overrides: ['!/*'] } }),
      );

      const recovered = await store.ensureInitialized([identity]);

      expect(recovered.generation).toBe(1);
      expect(recovered.extensions[identity.id]?.defaultActivation).toBe(
        'enabled',
      );
      expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual(
        {},
      );
    },
  );

  it('fails closed when current and previous state are corrupt', async () => {
    const store = makeStore();
    const identity = { id: 'f3'.repeat(32), name: 'demo' };
    await store.ensureInitialized([identity]);
    await store.setDefaultActivation(identity, 'disabled');
    await fsp.writeFile(path.join(storeDir, 'state.json'), '{broken');
    await fsp.writeFile(
      path.join(storeDir, 'state.previous.json'),
      '{also-broken',
    );

    await expect(store.ensureInitialized([identity])).rejects.toBeInstanceOf(
      ExtensionStoreCorruptError,
    );
  });
});
