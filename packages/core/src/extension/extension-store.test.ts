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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('rejects install when the identity already exists in policy state', async () => {
    const store = makeStore();
    const identity = { id: '93'.repeat(32), name: 'existing-policy' };
    await store.setDefaultActivation(identity, 'disabled');
    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'version'), 'new artifact');

    await expect(
      store.commitArtifact({
        operation: 'install',
        identity,
        stagingDirectory: staging,
        destinationDirectory: path.join(extensionsDir, identity.name),
        initialActivation: { scope: 'user' },
      }),
    ).rejects.toMatchObject({ code: 'extension_conflict' });
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

  it('recovers committed state from a journal when state.json is corrupt', async () => {
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
    await fsp.writeFile(path.join(storeDir, 'state.json'), '{broken');

    const recovered = await store.ensureInitialized([identity]);

    expect(recovered.generation).toBe(1);
    expect(recovered.extensions[identity.id]?.defaultActivation).toBe(
      'disabled',
    );
    expect(fs.existsSync(journal)).toBe(false);
  });
});
