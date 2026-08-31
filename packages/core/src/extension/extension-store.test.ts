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
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExtensionConflictError,
  ExtensionStore,
  ExtensionStoreCorruptError,
} from './extension-store.js';
import { mockCompromisedLock } from '../test-utils/mock-compromised-lock.js';

describe('ExtensionStore', () => {
  let root: string;
  let extensionsDir: string;
  let storeDir: string;
  let enablementPath: string;
  const workspacePath = (...segments: string[]) =>
    path.resolve('/workspace', ...segments);
  const legacyWorkspaceRule = (workspace: string) =>
    `/${workspace.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}/`;

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

  const readQuarantinedJournal = async (journal: string): Promise<string> => {
    const prefix = `${path.basename(journal)}.corrupt-`;
    const quarantined = (await fsp.readdir(path.dirname(journal))).find(
      (name) => name.startsWith(prefix),
    );
    expect(quarantined).toBeDefined();
    return await fsp.readFile(
      path.join(path.dirname(journal), quarantined!),
      'utf8',
    );
  };

  it('derives a stable contained Agent Plugin data directory', () => {
    const store = makeStore();
    const extensionId = 'a'.repeat(64);

    expect(store.agentPluginDataRoot(extensionId)).toBe(
      path.join(storeDir, 'plugin-data', 'agent-plugins', extensionId),
    );
    expect(() => store.agentPluginDataRoot('../escape')).toThrow(
      'Invalid extension id',
    );
  });

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

  it('rejects loaded extension names that differ only by case', async () => {
    const store = makeStore();
    const projection = JSON.stringify({
      unrelated: { overrides: ['!/unrelated/*'] },
    });
    await fsp.writeFile(enablementPath, projection);

    await expect(
      store.ensureInitialized([
        { id: 'a1'.repeat(32), name: 'Demo' },
        { id: 'a2'.repeat(32), name: 'demo' },
      ]),
    ).rejects.toBeInstanceOf(ExtensionConflictError);

    expect(fs.existsSync(path.join(storeDir, 'state.json'))).toBe(false);
    expect(await fsp.readFile(enablementPath, 'utf8')).toBe(projection);
  });

  it('preserves exact workspace overrides when the global default changes', async () => {
    const store = makeStore();
    const id = 'b'.repeat(64);
    await store.ensureInitialized([{ id, name: 'demo' }]);
    await store.setWorkspaceActivation(
      { id, name: 'demo' },
      workspacePath('a'),
      'enabled',
    );

    const snapshot = await store.setDefaultActivation(
      { id, name: 'demo' },
      'disabled',
    );

    expect(snapshot.generation).toBe(2);
    expect(snapshot.extensions[id]?.workspaceOverrides).toEqual({
      [workspacePath('a')]: 'enabled',
    });
    expect(
      store.getActivation(snapshot, id, 'demo', workspacePath('a')),
    ).toMatchObject({ effective: 'enabled', source: 'workspace_override' });
  });

  it('changes multiple workspace activations in one generation', async () => {
    const store = makeStore();
    const identities = [
      { id: 'b1'.repeat(32), name: 'first' },
      { id: 'b2'.repeat(32), name: 'second' },
    ];
    const initial = await store.ensureInitialized(identities);

    const snapshot = await store.setWorkspaceActivations(
      identities,
      workspacePath('batch'),
      'disabled',
    );

    expect(snapshot.generation).toBe(initial.generation + 1);
    for (const identity of identities) {
      expect(
        store.getActivation(
          snapshot,
          identity.id,
          identity.name,
          workspacePath('batch'),
        ),
      ).toMatchObject({
        effective: 'disabled',
        source: 'workspace_override',
      });
    }
  });

  it('changes multiple default activations in one generation', async () => {
    const store = makeStore();
    const identities = [
      { id: 'b7'.repeat(32), name: 'first' },
      { id: 'b8'.repeat(32), name: 'second' },
    ];
    const initial = await store.ensureInitialized(identities);

    const snapshot = await store.setDefaultActivations(identities, 'disabled');

    expect(snapshot.generation).toBe(initial.generation + 1);
    for (const identity of identities) {
      expect(snapshot.extensions[identity.id]?.defaultActivation).toBe(
        'disabled',
      );
    }
  });

  it('clears multiple workspace activations in one generation', async () => {
    const store = makeStore();
    const identities = [
      { id: 'b9'.repeat(32), name: 'first' },
      { id: 'ba'.repeat(32), name: 'second' },
    ];
    await store.ensureInitialized(identities);
    for (const identity of identities) {
      await store.setLegacyPathActivation(
        identity,
        workspacePath('batch'),
        'disabled',
      );
    }
    const before = await store.setWorkspaceActivations(
      identities,
      workspacePath('batch'),
      'enabled',
    );

    const outcome = await store.clearWorkspaceActivations(
      identities,
      workspacePath('batch'),
    );
    const snapshot = outcome.snapshot;

    expect(outcome.updated).toBe(true);
    expect(snapshot.generation).toBe(before.generation + 1);
    for (const identity of identities) {
      expect(
        store.getActivation(
          snapshot,
          identity.id,
          identity.name,
          workspacePath('batch'),
        ),
      ).toMatchObject({
        workspace: 'inherit',
        effective: 'enabled',
        source: 'default',
      });
    }
  });

  it('does not declare an unknown identity when clearing workspace activation', async () => {
    const store = makeStore();
    const identity = { id: 'cb'.repeat(32), name: 'future' };
    const initial = await store.ensureInitialized([]);

    const outcome = await store.clearWorkspaceActivations(
      [identity],
      workspacePath('batch'),
    );

    expect(outcome.updated).toBe(false);
    expect(outcome.snapshot.generation).toBe(initial.generation);
    expect(outcome.snapshot.extensions[identity.id]).toBeUndefined();

    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'qwen-extension.json'), '{}');
    const installed = await store.commitArtifact({
      operation: 'install',
      identity,
      stagingDirectory: staging,
      destinationDirectory: path.join(extensionsDir, identity.name),
      initialActivation: {
        scope: 'workspace',
        workspacePath: workspacePath('install'),
      },
    });

    expect(installed.extensions[identity.id]).toMatchObject({
      defaultActivation: 'disabled',
      workspaceOverrides: { [workspacePath('install')]: 'enabled' },
    });
  });

  it('declares a missing identity in the same batch generation', async () => {
    const store = makeStore();
    const installed = { id: 'b3'.repeat(32), name: 'installed' };
    const declared = { id: 'b4'.repeat(32), name: 'declared' };
    const initial = await store.ensureInitialized([installed]);

    const snapshot = await store.setWorkspaceActivations(
      [installed, declared],
      workspacePath('batch'),
      'disabled',
    );

    expect(snapshot.generation).toBe(initial.generation + 1);
    expect(snapshot.extensions[installed.id]?.workspaceOverrides).toEqual({
      [workspacePath('batch')]: 'disabled',
    });
    expect(snapshot.extensions[declared.id]).toEqual({
      name: declared.name,
      declarationOnly: true,
      defaultActivation: 'enabled',
      workspaceOverrides: { [workspacePath('batch')]: 'disabled' },
    });
  });

  it('does not commit a batch when an identity name mismatches', async () => {
    const store = makeStore();
    const installed = { id: 'bb'.repeat(32), name: 'installed' };
    const initial = await store.ensureInitialized([installed]);

    await expect(
      store.setDefaultActivations(
        [{ id: installed.id, name: 'different' }],
        'disabled',
      ),
    ).rejects.toThrow(
      `Extension id ${installed.id} belongs to "installed", not "different".`,
    );

    const snapshot = await store.readSnapshot();
    expect(snapshot.generation).toBe(initial.generation);
    expect(snapshot.extensions[installed.id]?.defaultActivation).toBe(
      'enabled',
    );
  });

  it('declares a batch before the store is initialized', async () => {
    const store = makeStore();
    const identity = { id: 'bc'.repeat(32), name: 'declared' };
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({
        [identity.name]: { overrides: ['!/legacy/*'] },
        unrelated: { overrides: ['!/unrelated/*'] },
      }),
    );

    const snapshot = await store.setDefaultActivations([identity], 'disabled');

    expect(snapshot.generation).toBe(1);
    expect(snapshot.extensions[identity.id]).toEqual({
      name: identity.name,
      declarationOnly: true,
      defaultActivation: 'disabled',
      workspaceOverrides: {},
      legacyPathRules: ['!/legacy/*'],
    });
    expect(snapshot.legacyProjectionRemainder).toEqual({
      unrelated: { overrides: ['!/unrelated/*'] },
    });
    expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual({
      unrelated: { overrides: ['!/unrelated/*'] },
      [identity.name]: { overrides: ['!/*', '!/legacy/*'] },
    });

    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'qwen-extension.json'), '{}');
    const installedIdentity = { id: 'bd'.repeat(32), name: identity.name };
    const installed = await store.commitArtifact({
      operation: 'install',
      identity: installedIdentity,
      stagingDirectory: staging,
      destinationDirectory: path.join(extensionsDir, identity.name),
      initialActivation: { scope: 'user' },
    });

    expect(installed.extensions[identity.id]).toBeUndefined();
    expect(installed.extensions[installedIdentity.id]).toMatchObject({
      name: identity.name,
      defaultActivation: 'disabled',
    });
    expect(installed.legacyProjectionRemainder).toEqual({
      unrelated: { overrides: ['!/unrelated/*'] },
    });
    expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual({
      unrelated: { overrides: ['!/unrelated/*'] },
      [identity.name]: { overrides: ['!/*', '!/legacy/*'] },
    });
  });

  it('imports legacy rules case-insensitively for a batch declaration', async () => {
    const store = makeStore();
    const identity = { id: 'c0'.repeat(32), name: 'declared' };
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({
        Declared: { overrides: ['!/legacy/*'] },
      }),
    );

    const snapshot = await store.setDefaultActivations([identity], 'disabled');

    expect(snapshot.extensions[identity.id]).toMatchObject({
      name: identity.name,
      declarationOnly: true,
      defaultActivation: 'disabled',
      legacyPathRules: ['!/legacy/*'],
    });
    expect(snapshot.legacyProjectionRemainder).toBeUndefined();
    expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual({
      [identity.name]: { overrides: ['!/*', '!/legacy/*'] },
    });
  });

  it.each([
    { demo: {} },
    { demo: { overrides: '!/legacy/*' } },
    {
      Demo: { overrides: ['!/upper/*'] },
      demo: { overrides: ['!/lower/*'] },
    },
    null,
  ])('rejects a malformed live V1 projection %#', async (projection) => {
    const store = makeStore();
    const original = JSON.stringify(projection);
    await fsp.writeFile(enablementPath, original);

    await expect(
      store.setDefaultActivations(
        [{ id: 'cf'.repeat(32), name: 'demo' }],
        'disabled',
      ),
    ).rejects.toMatchObject({ code: 'extension_store_corrupt' });

    await expect(
      fsp.stat(path.join(storeDir, 'state.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.readFile(enablementPath, 'utf8')).resolves.toBe(original);
  });

  it('keeps a newer V1 removal from resurrecting a persisted remainder', async () => {
    const store = makeStore();
    const identity = { id: 'ce'.repeat(32), name: 'declared' };
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({ unrelated: { overrides: ['!/unrelated/*'] } }),
    );
    const declared = await store.setDefaultActivations([identity], 'enabled');
    expect(declared.legacyProjectionRemainder).toEqual({
      unrelated: { overrides: ['!/unrelated/*'] },
    });
    await fsp.writeFile(enablementPath, '{}');
    const stateStat = await fsp.stat(path.join(storeDir, 'state.json'));
    const newer = new Date(stateStat.mtimeMs + 10_000);
    await fsp.utimes(enablementPath, newer, newer);

    const reconciled = await store.ensureInitialized([]);

    expect(reconciled.generation).toBe(declared.generation + 1);
    expect(reconciled.legacyProjectionRemainder).toBeUndefined();
    expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual({});
  });

  it('imports a persisted legacy remainder while repairing an older projection', async () => {
    const store = makeStore();
    const trigger = { id: 'c1'.repeat(32), name: 'trigger' };
    const discovered = { id: 'c2'.repeat(32), name: 'future' };
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({
        Future: { overrides: ['!/future/*'] },
        unrelated: { overrides: ['!/unrelated/*'] },
      }),
    );
    const declared = await store.setDefaultActivations([trigger], 'enabled');
    await fsp.writeFile(enablementPath, '{}');
    await fsp.utimes(enablementPath, new Date(0), new Date(0));

    const snapshot = await store.ensureInitialized([discovered]);

    expect(snapshot.generation).toBe(declared.generation + 1);
    expect(snapshot.extensions[discovered.id]).toMatchObject({
      name: discovered.name,
      defaultActivation: 'enabled',
      workspaceOverrides: {},
      legacyPathRules: ['!/future/*'],
    });
    expect(snapshot.legacyProjectionRemainder).toEqual({
      unrelated: { overrides: ['!/unrelated/*'] },
    });
    expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual({
      unrelated: { overrides: ['!/unrelated/*'] },
      [discovered.name]: { overrides: ['!/future/*'] },
    });
  });

  it('preserves an authoritative V2 remainder during a batch mutation', async () => {
    const store = makeStore();
    const trigger = { id: 'c3'.repeat(32), name: 'trigger' };
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({
        future: { overrides: ['!/future/*'] },
        unrelated: { overrides: ['!/unrelated/*'] },
      }),
    );
    const declared = await store.setDefaultActivations([trigger], 'enabled');
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({ unrelated: { overrides: ['!/unrelated/*'] } }),
    );
    const stateStat = await fsp.stat(path.join(storeDir, 'state.json'));
    const older = new Date(stateStat.mtimeMs - 10_000);
    await fsp.utimes(enablementPath, older, older);

    const updated = await store.setDefaultActivations([trigger], 'disabled');

    expect(updated.generation).toBe(declared.generation + 1);
    expect(updated.legacyProjectionRemainder).toEqual({
      future: { overrides: ['!/future/*'] },
      unrelated: { overrides: ['!/unrelated/*'] },
    });
    expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual({
      future: { overrides: ['!/future/*'] },
      unrelated: { overrides: ['!/unrelated/*'] },
      [trigger.name]: { overrides: ['!/*'] },
    });
  });

  it('imports a newer V1 rule during a batch mutation', async () => {
    const store = makeStore();
    const identity = { id: 'c4'.repeat(32), name: 'demo' };
    const initialized = await store.ensureInitialized([identity]);
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({
        demo: { overrides: ['!/legacy/*'] },
        future: { overrides: ['!/future/*'] },
      }),
    );
    const stateStat = await fsp.stat(path.join(storeDir, 'state.json'));
    const newer = new Date(stateStat.mtimeMs + 10_000);
    await fsp.utimes(enablementPath, newer, newer);

    const updated = await store.setDefaultActivations([identity], 'disabled');

    expect(updated.generation).toBe(initialized.generation + 1);
    expect(updated.extensions[identity.id]).toMatchObject({
      defaultActivation: 'disabled',
      legacyPathRules: ['!/legacy/*'],
    });
    expect(updated.legacyProjectionRemainder).toEqual({
      future: { overrides: ['!/future/*'] },
    });
    expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual({
      demo: { overrides: ['!/*', '!/legacy/*'] },
      future: { overrides: ['!/future/*'] },
    });
  });

  it('keeps singular activation mutations installed-only', async () => {
    const store = makeStore();
    const identity = { id: 'bd'.repeat(32), name: 'declared' };
    const declared = await store.setDefaultActivations([identity], 'disabled');

    await expect(
      store.setDefaultActivation(identity, 'enabled'),
    ).rejects.toMatchObject({ code: 'extension_conflict' });

    expect(await store.readSnapshot()).toEqual(declared);
  });

  it('rejects an empty batch without materializing store state', async () => {
    const legacy = {
      demo: { overrides: ['!/work/*', '/work/enabled/*'] },
    };
    await fsp.writeFile(enablementPath, JSON.stringify(legacy));
    const store = makeStore();

    await expect(store.setDefaultActivations([], 'disabled')).rejects.toThrow(
      'At least one extension identity is required.',
    );

    expect(fs.existsSync(path.join(storeDir, 'state.json'))).toBe(false);
    expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual(
      legacy,
    );
  });

  it('re-keys a policy to a new id for the same name after an id-formula change', async () => {
    const store = makeStore();
    const oldId = 'a'.repeat(64);
    const newId = 'b'.repeat(64);
    await store.ensureInitialized([{ id: oldId, name: 'dotnet' }]);
    await store.setDefaultActivation({ id: oldId, name: 'dotnet' }, 'disabled');
    await store.setWorkspaceActivation(
      { id: oldId, name: 'dotnet' },
      workspacePath('a'),
      'enabled',
    );

    const snapshot = await store.ensureInitialized([
      { id: newId, name: 'dotnet' },
    ]);

    expect(snapshot.extensions[oldId]).toBeUndefined();
    expect(snapshot.extensions[newId]).toMatchObject({
      name: 'dotnet',
      defaultActivation: 'disabled',
      workspaceOverrides: { [workspacePath('a')]: 'enabled' },
    });
  });

  it('re-keys across a case mismatch and normalizes the stored name', async () => {
    const store = makeStore();
    const oldId = 'a'.repeat(64);
    const newId = 'b'.repeat(64);
    const oldIdentity = { id: oldId, name: 'DotNet' };
    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'version'), 'dotnet');
    await store.commitArtifact({
      operation: 'install',
      identity: oldIdentity,
      stagingDirectory: staging,
      destinationDirectory: path.join(extensionsDir, oldIdentity.name),
      initialActivation: { scope: 'user' },
    });
    await store.setDefaultActivation({ id: oldId, name: 'DotNet' }, 'disabled');

    const snapshot = await store.ensureInitialized([
      { id: newId, name: 'dotnet' },
    ]);

    expect(snapshot.extensions[oldId]).toBeUndefined();
    expect(snapshot.extensions[newId]).toMatchObject({
      name: 'dotnet',
      artifactDirectory: 'DotNet',
      defaultActivation: 'disabled',
    });

    const internals = store as unknown as {
      pathExists(filePath: string): Promise<boolean>;
    };
    const pathExists = internals.pathExists.bind(store);
    vi.spyOn(internals, 'pathExists').mockImplementation(async (filePath) =>
      filePath === path.join(extensionsDir, 'dotnet')
        ? false
        : await pathExists(filePath),
    );
    const uninstalled = await store.commitArtifact({
      operation: 'uninstall',
      identity: { id: newId, name: 'dotnet' },
      destinationDirectory: path.join(extensionsDir, 'dotnet'),
    });

    expect(uninstalled.extensions[newId]).toBeUndefined();
    expect(fs.existsSync(path.join(extensionsDir, 'DotNet'))).toBe(false);
  });

  it('adopts a manifest rename and its declared activation', async () => {
    const store = makeStore();
    const identity = { id: 'd1'.repeat(32), name: 'before' };
    const declaration = { id: 'd2'.repeat(32), name: 'after' };
    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'version'), 'before');
    await store.commitArtifact({
      operation: 'install',
      identity,
      stagingDirectory: staging,
      destinationDirectory: path.join(extensionsDir, identity.name),
      initialActivation: { scope: 'user' },
    });
    const declared = await store.setDefaultActivations(
      [declaration],
      'disabled',
    );

    const renamed = await store.ensureInitialized([
      { id: identity.id, name: declaration.name },
    ]);

    expect(renamed.generation).toBe(declared.generation + 1);
    expect(renamed.extensions[declaration.id]).toBeUndefined();
    expect(renamed.extensions[identity.id]).toMatchObject({
      name: 'after',
      artifactDirectory: 'before',
      defaultActivation: 'disabled',
    });
    expect(renamed.extensions[identity.id]?.declarationOnly).toBeUndefined();
    expect(renamed.extensions[identity.id]?.artifactGeneration).toBeDefined();
    expect(fs.existsSync(path.join(extensionsDir, 'before'))).toBe(true);
    expect(fs.existsSync(path.join(extensionsDir, 'after'))).toBe(false);
    expect(renamed.legacyProjectionRemainder).toBeUndefined();
    expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual({
      after: { overrides: ['!/*'] },
    });

    const activated = await store.setDefaultActivations(
      [{ id: identity.id, name: 'after' }],
      'enabled',
    );
    expect(activated.extensions[identity.id]?.declarationOnly).toBeUndefined();

    const uninstalled = await store.commitArtifact({
      operation: 'uninstall',
      identity: { id: identity.id, name: 'after' },
      destinationDirectory: path.join(extensionsDir, 'after'),
    });
    expect(uninstalled.extensions[identity.id]).toBeUndefined();
    expect(fs.existsSync(path.join(extensionsDir, 'before'))).toBe(false);
    expect(fs.existsSync(path.join(extensionsDir, 'after'))).toBe(false);
    expect((await store.ensureInitialized([])).extensions).toEqual({});
  });

  it('removes an obsolete old name from a newer V1 projection on rename', async () => {
    const store = makeStore();
    const identity = { id: 'd3'.repeat(32), name: 'before' };
    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'version'), 'before');
    await store.commitArtifact({
      operation: 'install',
      identity,
      stagingDirectory: staging,
      destinationDirectory: path.join(extensionsDir, identity.name),
      initialActivation: { scope: 'user' },
    });
    const disabled = await store.setDefaultActivation(identity, 'disabled');
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({
        before: { overrides: ['!/*'] },
        future: { overrides: ['!/future/*'] },
      }),
    );
    const stateStat = await fsp.stat(path.join(storeDir, 'state.json'));
    const newer = new Date(stateStat.mtimeMs + 10_000);
    await fsp.utimes(enablementPath, newer, newer);

    const renamed = await store.ensureInitialized([
      { id: identity.id, name: 'after' },
    ]);

    expect(renamed.generation).toBe(disabled.generation + 1);
    expect(renamed.extensions[identity.id]).toMatchObject({
      name: 'after',
      defaultActivation: 'disabled',
    });
    expect(renamed.legacyProjectionRemainder).toEqual({
      future: { overrides: ['!/future/*'] },
    });
    expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual({
      after: { overrides: ['!/*'] },
      future: { overrides: ['!/future/*'] },
    });
  });

  it('re-keys only the orphaned policy when a sibling plugin installs fresh', async () => {
    const store = makeStore();
    const repoOnlyId = 'a'.repeat(64);
    const dotnetId = 'b'.repeat(64);
    const dotnetTestId = 'c'.repeat(64);
    await store.ensureInitialized([{ id: repoOnlyId, name: 'dotnet' }]);

    const snapshot = await store.ensureInitialized([
      { id: dotnetId, name: 'dotnet' },
      { id: dotnetTestId, name: 'dotnet-test' },
    ]);

    expect(snapshot.extensions[repoOnlyId]).toBeUndefined();
    expect(snapshot.extensions[dotnetId]?.name).toBe('dotnet');
    expect(snapshot.extensions[dotnetTestId]?.name).toBe('dotnet-test');
  });

  it('does not re-key a policy still owned by another loaded extension', async () => {
    const store = makeStore();
    const demoId = 'a'.repeat(64);
    const otherId = 'b'.repeat(64);
    await store.ensureInitialized([{ id: demoId, name: 'demo' }]);

    const snapshot = await store.ensureInitialized([
      { id: demoId, name: 'demo' },
      { id: otherId, name: 'other' },
    ]);

    expect(snapshot.extensions[demoId]?.name).toBe('demo');
    expect(snapshot.extensions[otherId]?.name).toBe('other');
  });

  it('uses an inherit mask when clearing an override matched by a legacy rule', async () => {
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({
        demo: {
          overrides: [`!${legacyWorkspaceRule(workspacePath())}*`],
        },
      }),
    );
    const store = makeStore();
    const id = 'c'.repeat(64);
    await store.ensureInitialized([{ id, name: 'demo' }]);

    const snapshot = await store.clearWorkspaceActivation(
      { id, name: 'demo' },
      workspacePath('a'),
    );

    expect(snapshot.extensions[id]?.workspaceOverrides).toEqual({
      [workspacePath('a')]: 'inherit',
    });
    expect(
      store.getActivation(snapshot, id, 'demo', workspacePath('a')),
    ).toEqual({
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
        workspacePath('a'),
        'enabled',
      ),
      second.setWorkspaceActivation(
        { id, name: 'demo' },
        workspacePath('b'),
        'disabled',
      ),
    ]);

    const snapshot = await first.readSnapshot();
    expect(snapshot.generation).toBe(2);
    expect(snapshot.extensions[id]?.workspaceOverrides).toEqual({
      [workspacePath('a')]: 'enabled',
      [workspacePath('b')]: 'disabled',
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

  it('registers a lock-compromised handler and completes when the store lock is compromised', async () => {
    const store = makeStore();
    const identity = { id: 'd4'.repeat(32), name: 'demo' };
    const { lockSpy, getOnCompromised } = mockCompromisedLock();

    try {
      await expect(store.ensureInitialized([identity])).resolves.toMatchObject({
        generation: 0,
      });
      expect(getOnCompromised()).toBeTypeOf('function');
    } finally {
      lockSpy.mockRestore();
    }
  });

  it('serializes mutations from two Node processes sharing QWEN_HOME', async () => {
    const id = 'd2'.repeat(32);
    const store = makeStore();
    await store.ensureInitialized([{ id, name: 'demo' }]);
    const moduleUrl = new URL('./extension-store.ts', import.meta.url).href;
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
      runChild(workspacePath('process-a'), 'enabled'),
      runChild(workspacePath('process-b'), 'disabled'),
    ]);

    const snapshot = await store.readSnapshot();
    expect(snapshot.generation).toBe(2);
    expect(snapshot.extensions[id]?.workspaceOverrides).toEqual({
      [workspacePath('process-a')]: 'enabled',
      [workspacePath('process-b')]: 'disabled',
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
      workspacePath('a'),
      'enabled',
    );

    const projection = JSON.parse(
      await fsp.readFile(enablementPath, 'utf8'),
    ) as Record<string, { overrides: string[] }>;
    expect(projection['demo']?.overrides).toEqual([
      '!/*',
      legacyWorkspaceRule(workspacePath('a')),
    ]);
  });

  it.runIf(process.platform !== 'win32')(
    'writes the V1 projection in the exact legacy literal format',
    async () => {
      // The derived `legacyWorkspaceRule` helper builds both the fixture and the
      // expectation in the cross-platform tests, so a change to the real V1
      // format could move both sides together and still pass. Pin the exact
      // literals here, where the workspace path is a stable POSIX string.
      const store = makeStore();
      const id = 'f'.repeat(64);
      await store.ensureInitialized([{ id, name: 'demo' }]);

      await store.setDefaultActivation({ id, name: 'demo' }, 'disabled');
      await store.setWorkspaceActivation(
        { id, name: 'demo' },
        workspacePath('a'),
        'enabled',
      );

      const projection = JSON.parse(
        await fsp.readFile(enablementPath, 'utf8'),
      ) as Record<string, { overrides: string[] }>;
      expect(projection['demo']?.overrides).toEqual(['!/*', '/workspace/a/']);
    },
  );

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

  it('preserves an unknown entry added by a newer V1 writer', async () => {
    const store = makeStore();
    const id = 'e4'.repeat(32);
    const initialized = await store.ensureInitialized([{ id, name: 'demo' }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({ future: { overrides: ['/workspace/future'] } }),
    );

    const imported = await store.ensureInitialized([{ id, name: 'demo' }]);

    expect(imported.generation).toBe(initialized.generation + 1);
    expect(imported.legacyProjectionRemainder).toEqual({
      future: { overrides: ['/workspace/future'] },
    });
    expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual({
      future: { overrides: ['/workspace/future'] },
    });
  });

  it('merges newly discovered extensions while repairing an older V1 projection', async () => {
    const store = makeStore();
    const first = { id: 'e8'.repeat(32), name: 'first' };
    const second = { id: 'e9'.repeat(32), name: 'second' };
    const initialized = await store.ensureInitialized([first]);
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({ stale: { overrides: ['!/workspace/*'] } }),
    );
    await fsp.utimes(enablementPath, new Date(0), new Date(0));

    const repaired = await store.ensureInitialized([first, second]);

    expect(repaired.generation).toBe(initialized.generation + 1);
    expect(repaired.extensions[second.id]).toMatchObject({
      name: second.name,
      defaultActivation: 'enabled',
      workspaceOverrides: {},
    });
    expect(repaired.extensions[second.id]?.legacyPathRules).toBeUndefined();
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
      workspacePath('enabled'),
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
      workspaceOverrides: { [workspacePath('enabled')]: 'enabled' },
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
      workspacePath('enabled'),
      'enabled',
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({
        demo: {
          overrides: [
            '!/*',
            legacyWorkspaceRule(workspacePath('enabled')),
            '!/workspace/legacy/*',
          ],
        },
      }),
    );

    const imported = await store.ensureInitialized([identity]);

    expect(imported.extensions[identity.id]?.legacyPathRules).toEqual([
      '!/workspace/legacy/*',
    ]);
  });

  it('imports an opposite V1 workspace rule into structured activation', async () => {
    const store = makeStore();
    const identity = { id: 'ea'.repeat(32), name: 'demo' };
    await store.ensureInitialized([identity]);
    await store.setWorkspaceActivation(identity, workspacePath(), 'enabled');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({
        demo: { overrides: [`!${legacyWorkspaceRule(workspacePath())}`] },
      }),
    );

    const imported = await store.ensureInitialized([identity]);

    expect(imported.extensions[identity.id]).toMatchObject({
      workspaceOverrides: { [workspacePath()]: 'disabled' },
    });
    expect(imported.extensions[identity.id]?.legacyPathRules).toBeUndefined();
    expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual({
      demo: { overrides: [`!${legacyWorkspaceRule(workspacePath())}`] },
    });
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

  it('rejects an artifact directory that resolves to the extensions root', async () => {
    const identity = { id: 'ee'.repeat(32), name: 'demo' };
    const unrelated = path.join(extensionsDir, 'unrelated');
    const sentinel = path.join(extensionsDir, 'sentinel');
    await fsp.mkdir(path.join(extensionsDir, identity.name), {
      recursive: true,
    });
    await fsp.mkdir(unrelated);
    await fsp.writeFile(sentinel, 'keep');
    await fsp.mkdir(storeDir, { recursive: true });
    await fsp.writeFile(
      path.join(storeDir, 'state.json'),
      JSON.stringify({
        version: 2,
        generation: 1,
        legacyProjectionHash: '0'.repeat(64),
        extensions: {
          [identity.id]: {
            name: identity.name,
            artifactDirectory: '.',
            artifactGeneration: 1,
            defaultActivation: 'enabled',
            workspaceOverrides: {},
          },
        },
      }),
    );
    const store = makeStore();

    await expect(
      store.commitArtifact({
        operation: 'uninstall',
        identity,
        destinationDirectory: path.join(extensionsDir, identity.name),
      }),
    ).rejects.toBeInstanceOf(ExtensionStoreCorruptError);
    expect(fs.existsSync(path.join(extensionsDir, identity.name))).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(true);
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
        workspacePath: workspacePath('a'),
      },
    });

    expect(snapshot.generation).toBe(1);
    expect(snapshot.extensions[identity.id]).toMatchObject({
      artifactGeneration: 1,
      defaultActivation: 'disabled',
      workspaceOverrides: { [workspacePath('a')]: 'enabled' },
    });
    await expect(
      fsp.readFile(
        path.join(extensionsDir, 'demo', 'qwen-extension.json'),
        'utf8',
      ),
    ).resolves.toBe('{}');
    expect(fs.existsSync(staging)).toBe(false);
  });

  it('promotes a declaration without replacing its activation policy', async () => {
    const store = makeStore();
    const identity = { id: 'f1'.repeat(32), name: 'demo' };
    const declared = await store.setDefaultActivations([identity], 'disabled');
    await store.setWorkspaceActivations(
      [identity],
      workspacePath('enabled'),
      'enabled',
    );
    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'qwen-extension.json'), '{}');

    const installed = await store.commitArtifact({
      operation: 'install',
      identity,
      stagingDirectory: staging,
      destinationDirectory: path.join(extensionsDir, identity.name),
      initialActivation: { scope: 'user' },
    });

    expect(installed.generation).toBe(declared.generation + 2);
    expect(installed.extensions[identity.id]).toEqual({
      name: identity.name,
      artifactGeneration: installed.generation,
      defaultActivation: 'disabled',
      workspaceOverrides: { [workspacePath('enabled')]: 'enabled' },
    });
  });

  it('migrates matching persisted legacy rules during a normal install', async () => {
    const store = makeStore();
    const trigger = { id: 'f8'.repeat(32), name: 'trigger' };
    const installedIdentity = { id: 'f9'.repeat(32), name: 'future' };
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({
        Future: { overrides: ['!/future/*'] },
        unrelated: { overrides: ['!/unrelated/*'] },
      }),
    );
    await store.setDefaultActivations([trigger], 'enabled');
    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'qwen-extension.json'), '{}');

    const installed = await store.commitArtifact({
      operation: 'install',
      identity: installedIdentity,
      stagingDirectory: staging,
      destinationDirectory: path.join(extensionsDir, installedIdentity.name),
      initialActivation: { scope: 'user' },
    });

    expect(installed.extensions[installedIdentity.id]).toMatchObject({
      name: installedIdentity.name,
      defaultActivation: 'enabled',
      workspaceOverrides: {},
      legacyPathRules: ['!/future/*'],
    });
    expect(installed.legacyProjectionRemainder).toEqual({
      unrelated: { overrides: ['!/unrelated/*'] },
    });
    expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual({
      unrelated: { overrides: ['!/unrelated/*'] },
      [installedIdentity.name]: { overrides: ['!/future/*'] },
    });
  });

  it('preserves unknown legacy rules from first initialization until install', async () => {
    const store = makeStore();
    const installed = { id: 'e8'.repeat(32), name: 'installed' };
    const future = { id: 'e9'.repeat(32), name: 'future' };
    await fsp.writeFile(
      enablementPath,
      JSON.stringify({
        installed: { overrides: ['!/installed/*'] },
        future: { overrides: ['!/future/*'] },
      }),
    );

    const initialized = await store.ensureInitialized([installed]);

    expect(initialized.legacyProjectionRemainder).toEqual({
      future: { overrides: ['!/future/*'] },
    });
    expect(JSON.parse(await fsp.readFile(enablementPath, 'utf8'))).toEqual({
      future: { overrides: ['!/future/*'] },
      installed: { overrides: ['!/installed/*'] },
    });

    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'qwen-extension.json'), '{}');
    const snapshot = await store.commitArtifact({
      operation: 'install',
      identity: future,
      stagingDirectory: staging,
      destinationDirectory: path.join(extensionsDir, future.name),
      initialActivation: { scope: 'user' },
    });

    expect(snapshot.extensions[future.id]?.legacyPathRules).toEqual([
      '!/future/*',
    ]);
    expect(snapshot.legacyProjectionRemainder).toBeUndefined();
  });

  it('promotes a declaration discovered outside the artifact transaction', async () => {
    const store = makeStore();
    const identity = { id: 'f7'.repeat(32), name: 'demo' };
    const declared = await store.setDefaultActivations([identity], 'disabled');
    const destination = path.join(extensionsDir, identity.name);
    await fsp.mkdir(destination);

    const discovered = await store.ensureInitialized([identity]);

    expect(discovered.generation).toBe(declared.generation + 1);
    expect(discovered.extensions[identity.id]).toEqual({
      name: identity.name,
      artifactGeneration: discovered.generation,
      preserveActivationOnNextInstall: true,
      defaultActivation: 'disabled',
      workspaceOverrides: {},
    });

    await fsp.rm(destination, { recursive: true });
    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'qwen-extension.json'), '{}');
    const reinstalled = await store.commitArtifact({
      operation: 'install',
      identity,
      stagingDirectory: staging,
      destinationDirectory: destination,
      initialActivation: { scope: 'user' },
    });

    expect(reinstalled.extensions[identity.id]).toMatchObject({
      artifactGeneration: reinstalled.generation,
      defaultActivation: 'disabled',
    });
    expect(
      reinstalled.extensions[identity.id]?.preserveActivationOnNextInstall,
    ).toBeUndefined();
  });

  it('targets an existing policy by name when the supplied id is provisional', async () => {
    const store = makeStore();
    const installed = { id: 'f2'.repeat(32), name: 'demo' };
    const initial = await store.ensureInitialized([installed]);

    const snapshot = await store.setDefaultActivations(
      [{ id: 'f4'.repeat(32), name: 'DEMO' }],
      'disabled',
    );

    expect(snapshot.generation).toBe(initial.generation + 1);
    expect(snapshot.extensions[installed.id]?.defaultActivation).toBe(
      'disabled',
    );
    expect(snapshot.extensions['f4'.repeat(32)]).toBeUndefined();
  });

  it('re-keys an explicit name declaration to the discovered id', async () => {
    const store = makeStore();
    const declared = { id: 'f5'.repeat(32), name: 'demo' };
    const discovered = { id: 'f6'.repeat(32), name: 'demo' };
    const initial = await store.setDefaultActivations([declared], 'disabled');
    const destination = path.join(extensionsDir, discovered.name);
    await fsp.mkdir(destination);

    const promoted = await store.ensureInitialized([discovered]);

    expect(promoted.generation).toBe(initial.generation + 1);
    expect(promoted.extensions[declared.id]).toBeUndefined();
    expect(promoted.extensions[discovered.id]).toEqual({
      name: discovered.name,
      artifactGeneration: promoted.generation,
      preserveActivationOnNextInstall: true,
      defaultActivation: 'disabled',
      workspaceOverrides: {},
    });

    await fsp.rm(destination, { recursive: true });
    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'qwen-extension.json'), '{}');
    const reinstalled = await store.commitArtifact({
      operation: 'install',
      identity: discovered,
      stagingDirectory: staging,
      destinationDirectory: destination,
      initialActivation: { scope: 'user' },
    });

    expect(reinstalled.extensions[discovered.id]).toMatchObject({
      artifactGeneration: reinstalled.generation,
      defaultActivation: 'disabled',
    });
    expect(
      reinstalled.extensions[discovered.id]?.preserveActivationOnNextInstall,
    ).toBeUndefined();
  });

  it('promotes a declaration when only the discovered name casing changes', async () => {
    const store = makeStore();
    const identity = { id: 'f7'.repeat(32), name: 'Demo' };
    const declared = await store.setDefaultActivations([identity], 'disabled');

    const promoted = await store.ensureInitialized([
      { id: identity.id, name: 'demo' },
    ]);

    expect(promoted.generation).toBe(declared.generation + 1);
    expect(promoted.extensions[identity.id]).toEqual({
      name: 'demo',
      artifactGeneration: promoted.generation,
      preserveActivationOnNextInstall: true,
      defaultActivation: 'disabled',
      workspaceOverrides: {},
    });
  });

  it('keeps a case-renamed installed extension attached to its artifact', async () => {
    const store = makeStore();
    const installedIdentity = { id: 'da'.repeat(32), name: 'Demo' };
    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'qwen-extension.json'), '{}');
    await store.commitArtifact({
      operation: 'install',
      identity: installedIdentity,
      stagingDirectory: staging,
      destinationDirectory: path.join(extensionsDir, installedIdentity.name),
      initialActivation: { scope: 'user' },
    });

    const renamedIdentity = { ...installedIdentity, name: 'demo' };
    await store.ensureInitialized([renamedIdentity]);
    const internals = store as unknown as {
      pathExists(filePath: string): Promise<boolean>;
    };
    const pathExists = internals.pathExists.bind(store);
    vi.spyOn(internals, 'pathExists').mockImplementation(async (filePath) =>
      filePath === path.join(extensionsDir, renamedIdentity.name)
        ? false
        : await pathExists(filePath),
    );
    const toggled = await store.setDefaultActivations(
      [renamedIdentity],
      'disabled',
    );

    expect(toggled.extensions[installedIdentity.id]).toMatchObject({
      name: renamedIdentity.name,
      defaultActivation: 'disabled',
      artifactGeneration: expect.any(Number),
    });
    expect(
      toggled.extensions[installedIdentity.id]?.declarationOnly,
    ).toBeUndefined();
  });

  it('preserves the original error when rollback also fails', async () => {
    const store = makeStore();
    const identity = { id: 'fa'.repeat(32), name: 'demo' };
    await store.ensureInitialized([]);
    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'qwen-extension.json'), '{}');
    const primaryError = new Error('state write failed');
    const rollbackError = new Error('rollback failed');
    const internals = store as unknown as {
      writeSnapshotUnlocked(snapshot: unknown): Promise<void>;
      rollbackJournal(journal: unknown): Promise<void>;
    };
    vi.spyOn(internals, 'writeSnapshotUnlocked').mockRejectedValueOnce(
      primaryError,
    );
    vi.spyOn(internals, 'rollbackJournal').mockRejectedValueOnce(rollbackError);

    let thrown: unknown;
    try {
      await store.commitArtifact({
        operation: 'install',
        identity,
        stagingDirectory: staging,
        destinationDirectory: path.join(extensionsDir, identity.name),
        initialActivation: { scope: 'user' },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      primaryError,
      rollbackError,
    ]);
    const journals = await fsp.readdir(path.join(storeDir, 'transactions'));
    expect(journals.filter((name) => name.endsWith('.json'))).toHaveLength(1);
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

  it('rejects installing a renamed extension with an existing id', async () => {
    const store = makeStore();
    const id = '98'.repeat(32);
    const original = { id, name: 'original' };
    const install = await store.createStagingDirectory();
    await fsp.writeFile(path.join(install, 'version'), 'one');
    await store.commitArtifact({
      operation: 'install',
      identity: original,
      stagingDirectory: install,
      destinationDirectory: path.join(extensionsDir, original.name),
      initialActivation: { scope: 'user' },
    });
    const renamed = await store.createStagingDirectory();
    await fsp.writeFile(path.join(renamed, 'version'), 'two');

    await expect(
      store.commitArtifact({
        operation: 'install',
        identity: { id, name: 'renamed' },
        stagingDirectory: renamed,
        destinationDirectory: path.join(extensionsDir, 'renamed'),
        initialActivation: { scope: 'user' },
      }),
    ).rejects.toBeInstanceOf(ExtensionConflictError);
    await expect(
      fsp.readFile(path.join(extensionsDir, original.name, 'version'), 'utf8'),
    ).resolves.toBe('one');
    expect(fs.existsSync(path.join(extensionsDir, 'renamed'))).toBe(false);
  });

  it('rejects a stale prepared update without replacing the artifact', async () => {
    const store = makeStore();
    const identity = { id: '92'.repeat(32), name: 'demo' };
    const destination = path.join(extensionsDir, 'demo');
    const devTree = path.join(extensionsDir, '..', 'demo-dev-tree');
    const install = await store.createStagingDirectory();
    await fsp.writeFile(path.join(install, 'version'), 'one');
    const installed = await store.commitArtifact({
      operation: 'install',
      identity,
      stagingDirectory: install,
      destinationDirectory: destination,
      initialActivation: { scope: 'user' },
      linkedSource: devTree,
    });
    expect(installed.extensions[identity.id]?.linkedSource).toBe(devTree);
    const firstUpdate = await store.createStagingDirectory();
    await fsp.writeFile(path.join(firstUpdate, 'version'), 'two');
    const updated = await store.commitArtifact({
      operation: 'update',
      identity,
      stagingDirectory: firstUpdate,
      destinationDirectory: destination,
      expectedArtifactGeneration: installed.generation,
    });
    expect(updated.extensions[identity.id]?.linkedSource).toBeUndefined();
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
        workspacePath: workspacePath('a'),
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

  it('preserves batch activation declared after an artifact disappears', async () => {
    const store = makeStore();
    const identity = { id: '9b'.repeat(32), name: 'retained-policy' };
    const destination = path.join(extensionsDir, identity.name);
    const devTree = path.join(extensionsDir, '..', 'retained-dev-tree');
    const initialStaging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(initialStaging, 'version'), 'old artifact');
    const committed = await store.commitArtifact({
      operation: 'install',
      identity,
      stagingDirectory: initialStaging,
      destinationDirectory: destination,
      initialActivation: { scope: 'user' },
      linkedSource: devTree,
    });
    expect(committed.extensions[identity.id]?.linkedSource).toBe(devTree);
    await fsp.rm(destination, { recursive: true });
    const provisional = { id: '9c'.repeat(32), name: identity.name };

    await store.setDefaultActivations([provisional], 'disabled');
    const declared = await store.setWorkspaceActivations(
      [provisional],
      workspacePath('disabled'),
      'disabled',
    );

    expect(declared.extensions[identity.id]).toMatchObject({
      name: identity.name,
      declarationOnly: true,
      defaultActivation: 'disabled',
      workspaceOverrides: {
        [workspacePath('disabled')]: 'disabled',
      },
    });
    expect(
      declared.extensions[identity.id]?.artifactGeneration,
    ).toBeUndefined();
    expect(declared.extensions[identity.id]?.linkedSource).toBeUndefined();

    const staging = await store.createStagingDirectory();
    await fsp.writeFile(path.join(staging, 'version'), 'new artifact');
    const installed = await store.commitArtifact({
      operation: 'install',
      identity,
      stagingDirectory: staging,
      destinationDirectory: destination,
      initialActivation: { scope: 'user' },
    });

    expect(installed.extensions[identity.id]).toEqual({
      name: identity.name,
      artifactGeneration: installed.generation,
      defaultActivation: 'disabled',
      workspaceOverrides: {
        [workspacePath('disabled')]: 'disabled',
      },
    });
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
    await store.setWorkspaceActivation(
      identity,
      workspacePath('a'),
      'disabled',
    );
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
      [workspacePath('a')]: 'disabled',
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

  it('rejects uninstalling a declaration without deleting its policy', async () => {
    const store = makeStore();
    const identity = { id: 'b5'.repeat(32), name: 'declared' };
    const declared = await store.setDefaultActivations([identity], 'disabled');

    await expect(
      store.commitArtifact({
        operation: 'uninstall',
        identity,
        destinationDirectory: path.join(extensionsDir, identity.name),
      }),
    ).rejects.toThrow(`Extension "${identity.name}" is not installed.`);

    expect(await store.readSnapshot()).toEqual(declared);
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

  it('quarantines a corrupt transaction journal and continues', async () => {
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
    expect(await readQuarantinedJournal(journal)).toBe('{not-json');
  });

  it('quarantines a corrupt journal while recovering corrupt state', async () => {
    const store = makeStore();
    const identity = { id: 'd6'.repeat(32), name: 'demo' };
    await store.ensureInitialized([identity]);
    await store.setDefaultActivation(identity, 'disabled');
    await fsp.writeFile(path.join(storeDir, 'state.json'), '{not-json');
    const journal = path.join(storeDir, 'transactions', 'corrupt.json');
    await fsp.writeFile(journal, '{also-not-json');

    await expect(store.readSnapshot()).resolves.toMatchObject({
      generation: 0,
      extensions: {
        [identity.id]: { defaultActivation: 'enabled' },
      },
    });
    expect(fs.existsSync(journal)).toBe(false);
    expect(await readQuarantinedJournal(journal)).toBe('{also-not-json');
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
      await expect(
        store.setDefaultActivation(identity, 'disabled'),
      ).resolves.toMatchObject({ generation: 1 });
      expect(await fsp.readFile(sentinel, 'utf8')).toBe('preserve');
      expect(fs.existsSync(journal)).toBe(false);
      expect(JSON.parse(await readQuarantinedJournal(journal))).toMatchObject({
        transactionId:
          kind === 'transaction-id' ? 'different-id' : transactionId,
      });
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

  it('rolls back an artifact-swapped transaction when current state is corrupt', async () => {
    const store = makeStore();
    const identity = { id: 'f4'.repeat(32), name: 'demo' };
    await store.ensureInitialized([identity]);
    const targetSnapshot = await store.setDefaultActivation(
      identity,
      'disabled',
    );
    const transactionId = 'recover-corrupt-artifact-swap';
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
    await fsp.writeFile(path.join(storeDir, 'state.json'), '{broken');

    const recovered = await store.readSnapshot();

    expect(recovered.generation).toBe(0);
    expect(recovered.extensions[identity.id]?.defaultActivation).toBe(
      'enabled',
    );
    await expect(
      fsp.readFile(path.join(destination, 'version'), 'utf8'),
    ).resolves.toBe('old');
    expect(fs.existsSync(journal)).toBe(false);
  });

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

      expect(recovered.generation).toBe(0);
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
