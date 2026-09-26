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
  type ExtensionIdentity,
  type ExtensionStoreSnapshot,
  type InitialExtensionActivation,
} from './extension-store.js';
import { mockCompromisedLock } from '../test-utils/mock-compromised-lock.js';

describe('ExtensionStore', () => {
  let root: string;
  let extensionsDir: string;
  let storeDir: string;
  let statePath: string;
  let enablementPath: string;
  const workspacePath = (...segments: string[]) =>
    path.resolve('/workspace', ...segments);
  const legacyWorkspaceRule = (workspace: string) =>
    `/${workspace.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}/`;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-extension-store-'));
    extensionsDir = path.join(root, 'extensions');
    storeDir = path.join(root, 'extension-store');
    statePath = path.join(storeDir, 'state.json');
    enablementPath = path.join(extensionsDir, 'extension-enablement.json');
    await fsp.mkdir(extensionsDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const makeStore = () =>
    new ExtensionStore({ extensionsDir, storeDir, enablementPath });

  const newStore = (id: string, name = 'demo') => ({
    store: makeStore(),
    identity: { id, name },
  });

  const initStore = async (id: string, name = 'demo') => {
    const { store, identity } = newStore(id, name);
    const initial = await store.ensureInitialized([identity]);
    return { store, identity, initial };
  };

  const firstAndSecond = (
    a: string,
    b: string,
  ): [ExtensionIdentity, ExtensionIdentity] => [
    { id: a.repeat(32), name: 'first' },
    { id: b.repeat(32), name: 'second' },
  ];

  const rules = (...overrides: string[]) => ({ overrides });
  const unrelated = rules('!/unrelated/*');
  const future = rules('!/future/*');

  const readProjection = async (): Promise<
    Record<string, { overrides: string[] }>
  > => JSON.parse(await fsp.readFile(enablementPath, 'utf8'));

  const writeProjection = (projection: unknown) =>
    fsp.writeFile(enablementPath, JSON.stringify(projection));

  // Waits first so the rewritten projection is newer than state.json.
  const writeNewerProjection = async (projection: unknown) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeProjection(projection);
  };

  // Sets the projection's mtime to state.json's plus `offsetMs`.
  const shiftProjectionMtime = async (offsetMs: number) => {
    const time = new Date((await fsp.stat(statePath)).mtimeMs + offsetMs);
    await fsp.utimes(enablementPath, time, time);
    return time;
  };

  const breakState = (condition: 'corrupt' | 'missing') =>
    condition === 'corrupt'
      ? fsp.writeFile(statePath, '{broken')
      : fsp.rm(statePath);

  const readVersion = (...directory: string[]) =>
    fsp.readFile(path.join(...directory, 'version'), 'utf8');

  const mkdirWithVersion = async (directory: string, version?: string) => {
    await fsp.mkdir(directory);
    if (version !== undefined) {
      await fsp.writeFile(path.join(directory, 'version'), version);
    }
  };

  // A staging directory holding `version`, or else an empty manifest.
  const stage = async (store: ExtensionStore, version?: string) => {
    const staging = await store.createStagingDirectory();
    const file = version === undefined ? 'qwen-extension.json' : 'version';
    await fsp.writeFile(path.join(staging, file), version ?? '{}');
    return staging;
  };

  const install = async (
    store: ExtensionStore,
    identity: ExtensionIdentity,
    {
      version,
      destinationDirectory = path.join(extensionsDir, identity.name),
      initialActivation = { scope: 'user' },
    }: {
      version?: string;
      destinationDirectory?: string;
      initialActivation?: InitialExtensionActivation;
    } = {},
  ) =>
    store.commitArtifact({
      operation: 'install',
      identity,
      stagingDirectory: await stage(store, version),
      destinationDirectory,
      initialActivation,
    });

  // Stages `version` now and returns the update commit to run later.
  const prepareUpdate = async (
    store: ExtensionStore,
    identity: ExtensionIdentity,
    version: string,
  ) => {
    const stagingDirectory = await stage(store, version);
    return (expectedArtifactGeneration?: number) =>
      store.commitArtifact({
        operation: 'update',
        identity,
        stagingDirectory,
        destinationDirectory: path.join(extensionsDir, identity.name),
        ...(expectedArtifactGeneration === undefined
          ? {}
          : { expectedArtifactGeneration }),
      });
  };

  const update = async (
    store: ExtensionStore,
    identity: ExtensionIdentity,
    version: string,
    expectedGeneration?: number,
  ) => (await prepareUpdate(store, identity, version))(expectedGeneration);

  const uninstall = (store: ExtensionStore, identity: ExtensionIdentity) =>
    store.commitArtifact({
      operation: 'uninstall',
      identity,
      destinationDirectory: path.join(extensionsDir, identity.name),
    });

  // Makes the store's private pathExists report `hidden` as absent.
  const hidePath = (store: ExtensionStore, hidden: string) => {
    const internals = store as unknown as {
      pathExists(filePath: string): Promise<boolean>;
    };
    const pathExists = internals.pathExists.bind(store);
    vi.spyOn(internals, 'pathExists').mockImplementation(async (filePath) =>
      filePath === hidden ? false : await pathExists(filePath),
    );
  };

  const journalPath = (transactionId: string) =>
    path.join(storeDir, 'transactions', `${transactionId}.json`);

  const writeJournal = (
    transactionId: string,
    fields: Record<string, unknown>,
  ) =>
    fsp.writeFile(
      journalPath(transactionId),
      JSON.stringify({
        version: 1,
        transactionId,
        operation: 'update',
        ...fields,
        previousGeneration: 0,
        targetGeneration: 1,
      }),
    );

  // Lays out an interrupted update of 'demo'; with `versions` the
  // destination holds `new` and the backup holds `old`.
  const fabricateUpdate = async (
    transactionId: string,
    phase: 'artifact_swapped' | 'state_committed',
    targetSnapshot: ExtensionStoreSnapshot,
    versions = true,
  ) => {
    const destination = path.join(extensionsDir, 'demo');
    const backup = path.join(storeDir, 'rollback', transactionId);
    await mkdirWithVersion(destination, versions ? 'new' : undefined);
    await mkdirWithVersion(backup, versions ? 'old' : undefined);
    await writeJournal(transactionId, {
      phase,
      destinationDirectory: destination,
      stagingDirectory: path.join(storeDir, 'staging', transactionId),
      backupDirectory: backup,
      targetSnapshot,
    });
    return { destination, backup, journal: journalPath(transactionId) };
  };

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
    await writeProjection({ demo: rules('!/work/*', '/work/enabled/*') });
    const { store, identity, initial } = await initStore('a'.repeat(64));

    expect(initial.generation).toBe(0);
    expect(initial.extensions[identity.id]).toEqual({
      name: 'demo',
      defaultActivation: 'enabled',
      workspaceOverrides: {},
      legacyPathRules: ['!/work/*', '/work/enabled/*'],
    });
    expect(
      store.getActivation(initial, identity.id, 'demo', '/work/disabled'),
    ).toMatchObject({ effective: 'disabled', source: 'legacy_path_rule' });
    expect(
      store.getActivation(initial, identity.id, 'demo', '/work/enabled'),
    ).toMatchObject({ effective: 'enabled', source: 'legacy_path_rule' });
  });

  it('rejects loaded extension names that differ only by case', async () => {
    const store = makeStore();
    const projection = JSON.stringify({ unrelated });
    await fsp.writeFile(enablementPath, projection);

    await expect(
      store.ensureInitialized([
        { id: 'a1'.repeat(32), name: 'Demo' },
        { id: 'a2'.repeat(32), name: 'demo' },
      ]),
    ).rejects.toBeInstanceOf(ExtensionConflictError);

    expect(fs.existsSync(statePath)).toBe(false);
    expect(await fsp.readFile(enablementPath, 'utf8')).toBe(projection);
  });

  it('preserves exact workspace overrides when the global default changes', async () => {
    const { store, identity } = await initStore('b'.repeat(64));
    await store.setWorkspaceActivation(identity, workspacePath('a'), 'enabled');

    const snapshot = await store.setDefaultActivation(identity, 'disabled');

    expect(snapshot.generation).toBe(2);
    expect(snapshot.extensions[identity.id]?.workspaceOverrides).toEqual({
      [workspacePath('a')]: 'enabled',
    });
    expect(
      store.getActivation(snapshot, identity.id, 'demo', workspacePath('a')),
    ).toMatchObject({ effective: 'enabled', source: 'workspace_override' });
  });

  it('merges concurrent skill batches without splitting workspace aliases or losing other entries', async () => {
    const workspace = path.join(root, 'workspace');
    const alias = path.join(root, 'workspace-alias');
    await fsp.mkdir(workspace);
    await fsp.symlink(
      workspace,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const identity = { id: 'a1'.repeat(32), name: 'suite' };
    const other = { id: 'b1'.repeat(32), name: 'other' };
    const store = makeStore();
    const initial = await store.ensureInitialized([identity, other]);
    const set = (
      target: ExtensionStore,
      owner: ExtensionIdentity,
      where: string,
      overrides: Record<string, boolean>,
    ) => target.setSkillWorkspaceOverrides(owner, where, overrides, 0);
    // Object.fromEntries makes `__proto__` an own key, not the prototype.
    const protoAndSkillA = Object.fromEntries([
      ['__proto__', false],
      ['skill-a', false],
    ]);
    const results = await Promise.all([
      set(store, identity, workspace, protoAndSkillA),
      set(makeStore(), identity, alias, { constructor: true }),
      set(makeStore(), identity, workspacePath('other'), { 'skill-a': true }),
      set(makeStore(), other, workspace, { 'skill-a': true }),
    ]);
    expect(results.map((result) => result.generation).sort()).toEqual([
      initial.generation + 1,
      initial.generation + 2,
      initial.generation + 3,
      initial.generation + 4,
    ]);
    const snapshot = await makeStore().readSnapshot();
    expect(snapshot.extensions[identity.id]?.skillWorkspaceOverrides).toEqual({
      [await fsp.realpath(workspace)]: { ...protoAndSkillA, constructor: true },
      [workspacePath('other')]: { 'skill-a': true },
    });
    const skill = (id: string, where: string, name: string) =>
      store.getSkillWorkspaceOverride(snapshot, id, where, name);
    expect(skill(identity.id, alias, '__proto__')).toBe(false);
    expect(skill(identity.id, alias, 'Constructor')).toBe(true);
    expect(skill(identity.id, alias, 'toString')).toBeNull();
    expect(skill(other.id, workspace, 'skill-a')).toBe(true);
  });

  it('preserves skill overrides on update and rejects stale or closed-workspace commits without writing', async () => {
    const identity = { id: 'd1'.repeat(32), name: 'suite' };
    const store = makeStore();
    const destinationDirectory = path.join(extensionsDir, identity.name);
    const ws = workspacePath('a');
    const setReview = (review: boolean, gen: number, before?: () => void) =>
      store.setSkillWorkspaceOverrides(identity, ws, { review }, gen, before);
    await fsp.mkdir(destinationDirectory);
    await store.ensureInitialized([identity]);
    await setReview(false, 0);
    const updated = await store.commitArtifact({
      operation: 'update',
      identity,
      destinationDirectory,
      stagingDirectory: await store.createStagingDirectory(),
      expectedArtifactGeneration: 0,
    });
    expect(
      store.getSkillWorkspaceOverride(updated, identity.id, ws, 'review'),
    ).toBe(false);
    await expect(setReview(true, 0)).rejects.toBeInstanceOf(
      ExtensionConflictError,
    );
    const generation = updated.extensions[identity.id]!.artifactGeneration!;
    await expect(
      setReview(true, generation, () => {
        throw new Error('workspace closed');
      }),
    ).rejects.toThrow('workspace closed');
    expect(await store.readSnapshot()).toEqual(updated);
    const uninstalled = await uninstall(store, identity);
    expect(uninstalled.extensions[identity.id]).toBeUndefined();
  });

  it('changes multiple workspace activations in one generation', async () => {
    const store = makeStore();
    const identities = firstAndSecond('b1', 'b2');
    const batch = workspacePath('batch');
    const initial = await store.ensureInitialized(identities);

    const snapshot = await store.setWorkspaceActivations(
      identities,
      batch,
      'disabled',
    );

    expect(snapshot.generation).toBe(initial.generation + 1);
    for (const { id, name } of identities) {
      expect(store.getActivation(snapshot, id, name, batch)).toMatchObject({
        effective: 'disabled',
        source: 'workspace_override',
      });
    }
  });

  it('changes multiple default activations in one generation', async () => {
    const store = makeStore();
    const identities = firstAndSecond('b7', 'b8');
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
    const identities = firstAndSecond('b9', 'ba');
    const batch = workspacePath('batch');
    await store.ensureInitialized(identities);
    for (const identity of identities) {
      await store.setLegacyPathActivation(identity, batch, 'disabled');
    }
    const before = await store.setWorkspaceActivations(
      identities,
      batch,
      'enabled',
    );

    const outcome = await store.clearWorkspaceActivations(identities, batch);
    const snapshot = outcome.snapshot;

    expect(outcome.updated).toBe(true);
    expect(snapshot.generation).toBe(before.generation + 1);
    for (const { id, name } of identities) {
      expect(store.getActivation(snapshot, id, name, batch)).toMatchObject({
        workspace: 'inherit',
        effective: 'enabled',
        source: 'default',
      });
    }
  });

  it('does not declare an unknown identity when clearing workspace activation', async () => {
    const { store, identity } = newStore('cb'.repeat(32), 'future');
    const initial = await store.ensureInitialized([]);

    const outcome = await store.clearWorkspaceActivations(
      [identity],
      workspacePath('batch'),
    );

    expect(outcome.updated).toBe(false);
    expect(outcome.snapshot.generation).toBe(initial.generation);
    expect(outcome.snapshot.extensions[identity.id]).toBeUndefined();

    const installed = await install(store, identity, {
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
    const installed = { id: 'b3'.repeat(32), name: 'installed' };
    const store = makeStore();
    const initial = await store.ensureInitialized([installed]);
    const declared = { id: 'b4'.repeat(32), name: 'declared' };

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
    const installed = { id: 'bb'.repeat(32), name: 'installed' };
    const store = makeStore();
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
    const { store, identity } = newStore('bc'.repeat(32), 'declared');
    const remainder = { unrelated };
    const projection = {
      ...remainder,
      [identity.name]: rules('!/*', '!/legacy/*'),
    };
    await writeProjection({
      [identity.name]: rules('!/legacy/*'),
      ...remainder,
    });

    const snapshot = await store.setDefaultActivations([identity], 'disabled');

    expect(snapshot.generation).toBe(1);
    expect(snapshot.extensions[identity.id]).toEqual({
      name: identity.name,
      declarationOnly: true,
      defaultActivation: 'disabled',
      workspaceOverrides: {},
      legacyPathRules: ['!/legacy/*'],
    });
    expect(snapshot.legacyProjectionRemainder).toEqual(remainder);
    expect(await readProjection()).toEqual(projection);

    const installedIdentity = { id: 'bd'.repeat(32), name: identity.name };
    const installed = await install(store, installedIdentity);

    expect(installed.extensions[identity.id]).toBeUndefined();
    expect(installed.extensions[installedIdentity.id]).toMatchObject({
      name: identity.name,
      defaultActivation: 'disabled',
    });
    expect(installed.legacyProjectionRemainder).toEqual(remainder);
    expect(await readProjection()).toEqual(projection);
  });

  it('imports legacy rules case-insensitively for a batch declaration', async () => {
    const { store, identity } = newStore('c0'.repeat(32), 'declared');
    await writeProjection({ Declared: rules('!/legacy/*') });

    const snapshot = await store.setDefaultActivations([identity], 'disabled');

    expect(snapshot.extensions[identity.id]).toMatchObject({
      name: identity.name,
      declarationOnly: true,
      defaultActivation: 'disabled',
      legacyPathRules: ['!/legacy/*'],
    });
    expect(snapshot.legacyProjectionRemainder).toBeUndefined();
    expect(await readProjection()).toEqual({
      [identity.name]: rules('!/*', '!/legacy/*'),
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

    await expect(fsp.stat(statePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fsp.readFile(enablementPath, 'utf8')).resolves.toBe(original);
  });

  it('keeps a newer V1 removal from resurrecting a persisted remainder', async () => {
    const { store, identity } = newStore('ce'.repeat(32), 'declared');
    await writeProjection({ unrelated });
    const declared = await store.setDefaultActivations([identity], 'enabled');
    expect(declared.legacyProjectionRemainder).toEqual({ unrelated });
    await writeProjection({});
    await shiftProjectionMtime(10_000);

    const reconciled = await store.ensureInitialized([]);

    expect(reconciled.generation).toBe(declared.generation + 1);
    expect(reconciled.legacyProjectionRemainder).toBeUndefined();
    expect(await readProjection()).toEqual({});
  });

  // Expects `identity` to own the persisted `Future` rules while `unrelated`
  // stays in the remainder and the projection.
  const expectFutureAdopted = async (
    snapshot: ExtensionStoreSnapshot,
    identity: ExtensionIdentity,
  ) => {
    expect(snapshot.extensions[identity.id]).toMatchObject({
      name: identity.name,
      defaultActivation: 'enabled',
      workspaceOverrides: {},
      legacyPathRules: ['!/future/*'],
    });
    expect(snapshot.legacyProjectionRemainder).toEqual({ unrelated });
    expect(await readProjection()).toEqual({
      unrelated,
      [identity.name]: future,
    });
  };

  it('imports a persisted legacy remainder while repairing an older projection', async () => {
    const { store, identity: trigger } = newStore('c1'.repeat(32), 'trigger');
    const discovered = { id: 'c2'.repeat(32), name: 'future' };
    await writeProjection({ Future: future, unrelated });
    const declared = await store.setDefaultActivations([trigger], 'enabled');
    await writeProjection({});
    await fsp.utimes(enablementPath, new Date(0), new Date(0));

    const snapshot = await store.ensureInitialized([discovered]);

    expect(snapshot.generation).toBe(declared.generation + 1);
    await expectFutureAdopted(snapshot, discovered);
  });

  it('preserves an authoritative V2 remainder during a batch mutation', async () => {
    const { store, identity: trigger } = newStore('c3'.repeat(32), 'trigger');
    const remainder = { future, unrelated };
    await writeProjection(remainder);
    const declared = await store.setDefaultActivations([trigger], 'enabled');
    await writeProjection({ unrelated });
    await shiftProjectionMtime(-10_000);

    const updated = await store.setDefaultActivations([trigger], 'disabled');

    expect(updated.generation).toBe(declared.generation + 1);
    expect(updated.legacyProjectionRemainder).toEqual(remainder);
    expect(await readProjection()).toEqual({
      ...remainder,
      [trigger.name]: rules('!/*'),
    });
  });

  it('imports a newer V1 rule during a batch mutation', async () => {
    const { store, identity, initial } = await initStore('c4'.repeat(32));
    await writeProjection({ demo: rules('!/legacy/*'), future });
    await shiftProjectionMtime(10_000);

    const updated = await store.setDefaultActivations([identity], 'disabled');

    expect(updated.generation).toBe(initial.generation + 1);
    expect(updated.extensions[identity.id]).toMatchObject({
      defaultActivation: 'disabled',
      legacyPathRules: ['!/legacy/*'],
    });
    expect(updated.legacyProjectionRemainder).toEqual({ future });
    expect(await readProjection()).toEqual({
      demo: rules('!/*', '!/legacy/*'),
      future,
    });
  });

  it('keeps singular activation mutations installed-only', async () => {
    const { store, identity } = newStore('bd'.repeat(32), 'declared');
    const declared = await store.setDefaultActivations([identity], 'disabled');

    await expect(
      store.setDefaultActivation(identity, 'enabled'),
    ).rejects.toMatchObject({ code: 'extension_conflict' });

    expect(await store.readSnapshot()).toEqual(declared);
  });

  it('rejects an empty batch without materializing store state', async () => {
    const legacy = { demo: rules('!/work/*', '/work/enabled/*') };
    await writeProjection(legacy);
    const store = makeStore();

    await expect(store.setDefaultActivations([], 'disabled')).rejects.toThrow(
      'At least one extension identity is required.',
    );

    expect(fs.existsSync(statePath)).toBe(false);
    expect(await readProjection()).toEqual(legacy);
  });

  it('re-keys a policy to a new id for the same name after an id-formula change', async () => {
    const { store, identity } = await initStore('a'.repeat(64), 'dotnet');
    const newId = 'b'.repeat(64);
    await store.setDefaultActivation(identity, 'disabled');
    await store.setWorkspaceActivation(identity, workspacePath('a'), 'enabled');

    const snapshot = await store.ensureInitialized([
      { id: newId, name: 'dotnet' },
    ]);

    expect(snapshot.extensions[identity.id]).toBeUndefined();
    expect(snapshot.extensions[newId]).toMatchObject({
      name: 'dotnet',
      defaultActivation: 'disabled',
      workspaceOverrides: { [workspacePath('a')]: 'enabled' },
    });
  });

  it('re-keys across a case mismatch and normalizes the stored name', async () => {
    const { store, identity: oldIdentity } = newStore('a'.repeat(64), 'DotNet');
    const newIdentity = { id: 'b'.repeat(64), name: 'dotnet' };
    await install(store, oldIdentity, { version: 'dotnet' });
    await store.setDefaultActivation(oldIdentity, 'disabled');

    const snapshot = await store.ensureInitialized([newIdentity]);

    expect(snapshot.extensions[oldIdentity.id]).toBeUndefined();
    expect(snapshot.extensions[newIdentity.id]).toMatchObject({
      name: 'dotnet',
      artifactDirectory: 'DotNet',
      defaultActivation: 'disabled',
    });

    hidePath(store, path.join(extensionsDir, 'dotnet'));
    const uninstalled = await uninstall(store, newIdentity);

    expect(uninstalled.extensions[newIdentity.id]).toBeUndefined();
    expect(fs.existsSync(path.join(extensionsDir, 'DotNet'))).toBe(false);
  });

  it('adopts a manifest rename and its declared activation', async () => {
    const { store, identity } = newStore('d1'.repeat(32), 'before');
    const declaration = { id: 'd2'.repeat(32), name: 'after' };
    const renamedIdentity = { id: identity.id, name: declaration.name };
    await install(store, identity, { version: 'before' });
    const declared = await store.setDefaultActivations(
      [declaration],
      'disabled',
    );

    const renamed = await store.ensureInitialized([renamedIdentity]);

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
    expect(await readProjection()).toEqual({ after: rules('!/*') });

    const activated = await store.setDefaultActivations(
      [renamedIdentity],
      'enabled',
    );
    expect(activated.extensions[identity.id]?.declarationOnly).toBeUndefined();

    const uninstalled = await uninstall(store, renamedIdentity);
    expect(uninstalled.extensions[identity.id]).toBeUndefined();
    expect(fs.existsSync(path.join(extensionsDir, 'before'))).toBe(false);
    expect(fs.existsSync(path.join(extensionsDir, 'after'))).toBe(false);
    expect((await store.ensureInitialized([])).extensions).toEqual({});
  });

  it('removes an obsolete old name from a newer V1 projection on rename', async () => {
    const { store, identity } = newStore('d3'.repeat(32), 'before');
    await install(store, identity, { version: 'before' });
    const disabled = await store.setDefaultActivation(identity, 'disabled');
    await writeProjection({ before: rules('!/*'), future });
    await shiftProjectionMtime(10_000);

    const renamed = await store.ensureInitialized([
      { id: identity.id, name: 'after' },
    ]);

    expect(renamed.generation).toBe(disabled.generation + 1);
    expect(renamed.extensions[identity.id]).toMatchObject({
      name: 'after',
      defaultActivation: 'disabled',
    });
    expect(renamed.legacyProjectionRemainder).toEqual({ future });
    expect(await readProjection()).toEqual({ after: rules('!/*'), future });
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
    const { store, identity: demo } = await initStore('a'.repeat(64));
    const otherId = 'b'.repeat(64);

    const snapshot = await store.ensureInitialized([
      demo,
      { id: otherId, name: 'other' },
    ]);

    expect(snapshot.extensions[demo.id]?.name).toBe('demo');
    expect(snapshot.extensions[otherId]?.name).toBe('other');
  });

  it('uses an inherit mask when clearing an override matched by a legacy rule', async () => {
    await writeProjection({
      demo: rules(`!${legacyWorkspaceRule(workspacePath())}*`),
    });
    const { store, identity } = await initStore('c'.repeat(64));

    const snapshot = await store.clearWorkspaceActivation(
      identity,
      workspacePath('a'),
    );

    expect(snapshot.extensions[identity.id]?.workspaceOverrides).toEqual({
      [workspacePath('a')]: 'inherit',
    });
    expect(
      store.getActivation(snapshot, identity.id, 'demo', workspacePath('a')),
    ).toEqual({
      default: 'enabled',
      workspace: 'inherit',
      effective: 'enabled',
      source: 'default',
    });
  });

  it('serializes writes from independent store instances without losing updates', async () => {
    const { store: first, identity } = await initStore('d'.repeat(64));
    const second = makeStore();

    await Promise.all([
      first.setWorkspaceActivation(identity, workspacePath('a'), 'enabled'),
      second.setWorkspaceActivation(identity, workspacePath('b'), 'disabled'),
    ]);

    const snapshot = await first.readSnapshot();
    expect(snapshot.generation).toBe(2);
    expect(snapshot.extensions[identity.id]?.workspaceOverrides).toEqual({
      [workspacePath('a')]: 'enabled',
      [workspacePath('b')]: 'disabled',
    });
  });

  it('preserves a committed result when lock release reports an error', async () => {
    const { store, identity } = await initStore('d3'.repeat(32));
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
    const { store, identity } = newStore('d4'.repeat(32));
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
    const { store, identity } = await initStore('d2'.repeat(32));
    const moduleUrl = new URL('./extension-store.ts', import.meta.url).href;
    const runChild = async (workspacePath: string, activation: string) => {
      const source = `
        import { ExtensionStore } from ${JSON.stringify(moduleUrl)};
        const store = new ExtensionStore(${JSON.stringify({ extensionsDir, storeDir, enablementPath })});
        await store.setWorkspaceActivation(
          ${JSON.stringify(identity)},
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
    expect(snapshot.extensions[identity.id]?.workspaceOverrides).toEqual({
      [workspacePath('process-a')]: 'enabled',
      [workspacePath('process-b')]: 'disabled',
    });
  });

  it('holds mutation commits while a consistent artifact snapshot is read', async () => {
    const { store, identity } = await initStore('d3'.repeat(32));
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
      return { value: 'complete-artifact-scan', extensions: [identity] };
    });
    await started;
    let mutationSettled = false;
    const mutation = store
      .setDefaultActivation(identity, 'disabled')
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
      const { store, identity } = await initStore('d1'.repeat(32));
      const realWorkspace = path.join(root, 'real-workspace');
      const linkedWorkspace = path.join(root, 'linked-workspace');
      await fsp.mkdir(realWorkspace);
      await fsp.symlink(realWorkspace, linkedWorkspace);

      const snapshot = await store.setWorkspaceActivation(
        identity,
        linkedWorkspace,
        'disabled',
      );

      expect(snapshot.extensions[identity.id]?.workspaceOverrides).toEqual({
        [fs.realpathSync.native(realWorkspace)]: 'disabled',
      });
      expect(
        store.getActivation(snapshot, identity.id, 'demo', realWorkspace),
      ).toMatchObject({
        effective: 'disabled',
        source: 'workspace_override',
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'matches legacy rules against symlink and canonical workspace paths',
    async () => {
      const real = path.join(root, 'legacy-real-workspace');
      const linked = path.join(root, 'legacy-linked-workspace');
      await fsp.mkdir(real);
      await fsp.symlink(real, linked);
      await writeProjection({ demo: rules(`!${linked}/*`) });
      const { store, identity, initial } = await initStore('d2'.repeat(32));
      const expectActivation = (
        snapshot: ExtensionStoreSnapshot,
        effective: string,
        source: string,
      ) =>
        expect(
          store.getActivation(snapshot, identity.id, identity.name, linked),
        ).toMatchObject({ effective, source });

      expectActivation(initial, 'disabled', 'legacy_path_rule');

      let snapshot = await store.setWorkspaceActivation(
        identity,
        linked,
        'enabled',
      );
      expectActivation(snapshot, 'enabled', 'workspace_override');

      snapshot = await store.clearWorkspaceActivation(identity, linked);
      expectActivation(snapshot, 'enabled', 'default');
    },
  );

  // Initializes 'demo', disables it with one enabled workspace, and returns
  // the rules the V1 projection then holds for it.
  const projectedOverrides = async (id: string) => {
    const { store, identity } = await initStore(id);
    await store.setDefaultActivation(identity, 'disabled');
    await store.setWorkspaceActivation(identity, workspacePath('a'), 'enabled');
    return (await readProjection())['demo']?.overrides;
  };

  it('writes a V1 projection after every policy mutation', async () => {
    expect(await projectedOverrides('e'.repeat(64))).toEqual([
      '!/*',
      legacyWorkspaceRule(workspacePath('a')),
    ]);
  });

  it.runIf(process.platform !== 'win32')(
    'writes the V1 projection in the exact legacy literal format',
    async () => {
      // `legacyWorkspaceRule` builds both fixture and expectation in the
      // cross-platform tests, so a change to the real V1 format could move
      // both sides and still pass. Pin the literals on a stable POSIX path.
      expect(await projectedOverrides('f'.repeat(64))).toEqual([
        '!/*',
        '/workspace/a/',
      ]);
    },
  );

  it('repairs an older V1 projection without changing generation', async () => {
    const { store, identity } = await initStore('e1'.repeat(32));
    const changed = await store.setDefaultActivation(identity, 'disabled');
    await writeProjection({});
    await shiftProjectionMtime(-1_000);

    const repaired = await store.ensureInitialized([identity]);

    expect(repaired.generation).toBe(changed.generation);
    expect(await readProjection()).toEqual({ demo: rules('!/*') });
  });

  it('fails closed when state and a different V1 projection have equal mtimes', async () => {
    const { store, identity } = await initStore('e6'.repeat(32));
    await store.setDefaultActivation(identity, 'disabled');
    await writeProjection({});
    const sameTime = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    await Promise.all([
      fsp.utimes(statePath, sameTime, sameTime),
      fsp.utimes(enablementPath, sameTime, sameTime),
    ]);

    await expect(store.ensureInitialized([identity])).rejects.toBeInstanceOf(
      ExtensionStoreCorruptError,
    );
    expect(await readProjection()).toEqual({});
  });

  it('keeps V2 reads available when an older V1 projection cannot be repaired', async () => {
    const { store, identity } = await initStore('e5'.repeat(32));
    const changed = await store.setDefaultActivation(identity, 'disabled');
    await writeProjection({});
    const older = await shiftProjectionMtime(-1_000);

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
      const readable = await store.ensureInitialized([identity]);
      expect(readable).toEqual(changed);
      expect((await fsp.stat(enablementPath)).isDirectory()).toBe(true);
    } finally {
      projectionAgeSpy.mockRestore();
    }

    await fsp.rm(enablementPath, { recursive: true });
    await writeProjection({});
    await fsp.utimes(enablementPath, older, older);
    await store.ensureInitialized([identity]);
    expect(await readProjection()).toEqual({ demo: rules('!/*') });
  });

  it('imports a newer V1 projection as a sequential downgrade write', async () => {
    const { store, identity } = await initStore('e2'.repeat(32));
    await writeNewerProjection({ demo: rules('!/workspace/*') });

    const imported = await store.ensureInitialized([identity]);

    expect(imported.generation).toBe(1);
    expect(imported.extensions[identity.id]?.legacyPathRules).toEqual([
      '!/workspace/*',
    ]);
  });

  it('preserves an unknown entry added by a newer V1 writer', async () => {
    const { store, identity, initial } = await initStore('e4'.repeat(32));
    const projection = { future: rules('/workspace/future') };
    await writeNewerProjection(projection);

    const imported = await store.ensureInitialized([identity]);

    expect(imported.generation).toBe(initial.generation + 1);
    expect(imported.legacyProjectionRemainder).toEqual(projection);
    expect(await readProjection()).toEqual(projection);
  });

  it('merges newly discovered extensions while repairing an older V1 projection', async () => {
    const store = makeStore();
    const [first, second] = firstAndSecond('e8', 'e9');
    const initialized = await store.ensureInitialized([first]);
    await writeProjection({ stale: rules('!/workspace/*') });
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
    const { store, identity } = newStore('e3'.repeat(32));
    const installed = await install(store, identity, { version: 'one' });
    await writeNewerProjection({ demo: rules('!/workspace/*') });

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

  // Gives 'demo' a V2 policy, lets a newer V1 writer replace its rules with
  // `overrides`, and returns the re-initialized policy.
  const policyAfterDowngrade = async (id: string, overrides: string[]) => {
    const { store, identity } = await initStore(id);
    await store.setDefaultActivation(identity, 'disabled');
    await store.setWorkspaceActivation(
      identity,
      workspacePath('enabled'),
      'enabled',
    );
    await writeNewerProjection({ demo: { overrides } });
    return (await store.ensureInitialized([identity])).extensions[id];
  };

  it('preserves V2 activation policy across a sequential downgrade write', async () => {
    expect(
      await policyAfterDowngrade('e4'.repeat(32), ['!/workspace/legacy/*']),
    ).toMatchObject({
      defaultActivation: 'disabled',
      workspaceOverrides: { [workspacePath('enabled')]: 'enabled' },
      legacyPathRules: ['!/workspace/legacy/*'],
    });
  });

  it('does not import generated V2 rules as legacy rules', async () => {
    const imported = await policyAfterDowngrade('e5'.repeat(32), [
      '!/*',
      legacyWorkspaceRule(workspacePath('enabled')),
      '!/workspace/legacy/*',
    ]);

    expect(imported?.legacyPathRules).toEqual(['!/workspace/legacy/*']);
  });

  it('imports an opposite V1 workspace rule into structured activation', async () => {
    const { store, identity } = await initStore('ea'.repeat(32));
    const projection = {
      demo: rules(`!${legacyWorkspaceRule(workspacePath())}`),
    };
    await store.setWorkspaceActivation(identity, workspacePath(), 'enabled');
    await writeNewerProjection(projection);

    const imported = await store.ensureInitialized([identity]);

    expect(imported.extensions[identity.id]).toMatchObject({
      workspaceOverrides: { [workspacePath()]: 'disabled' },
    });
    expect(imported.extensions[identity.id]?.legacyPathRules).toBeUndefined();
    expect(await readProjection()).toEqual(projection);
  });

  it('imports newer V1 rules for policies omitted from a partial refresh', async () => {
    const store = makeStore();
    const [first, second] = firstAndSecond('e6', 'e7');
    await store.ensureInitialized([first, second]);
    await writeNewerProjection({
      first: rules('!/workspace/first/*'),
      second: rules('!/workspace/second/*'),
    });

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
    await fsp.writeFile(statePath, '{not-json');
    const store = makeStore();

    await expect(store.readSnapshot()).rejects.toBeInstanceOf(
      ExtensionStoreCorruptError,
    );
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it('rejects an artifact directory that resolves to the extensions root', async () => {
    const identity = { id: 'ee'.repeat(32), name: 'demo' };
    const unrelatedDir = path.join(extensionsDir, 'unrelated');
    const sentinel = path.join(extensionsDir, 'sentinel');
    await fsp.mkdir(path.join(extensionsDir, identity.name), {
      recursive: true,
    });
    await fsp.mkdir(unrelatedDir);
    await fsp.writeFile(sentinel, 'keep');
    await fsp.mkdir(storeDir, { recursive: true });
    await fsp.writeFile(
      statePath,
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

    await expect(uninstall(store, identity)).rejects.toBeInstanceOf(
      ExtensionStoreCorruptError,
    );
    expect(fs.existsSync(path.join(extensionsDir, identity.name))).toBe(true);
    expect(fs.existsSync(unrelatedDir)).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('commits an installed artifact and its initial activation together', async () => {
    const { store, identity } = newStore('f'.repeat(64));
    const staging = await stage(store);

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
    const { store, identity } = newStore('f1'.repeat(32));
    const declared = await store.setDefaultActivations([identity], 'disabled');
    await store.setWorkspaceActivations(
      [identity],
      workspacePath('enabled'),
      'enabled',
    );

    const installed = await install(store, identity);

    expect(installed.generation).toBe(declared.generation + 2);
    expect(installed.extensions[identity.id]).toEqual({
      name: identity.name,
      artifactGeneration: installed.generation,
      defaultActivation: 'disabled',
      workspaceOverrides: { [workspacePath('enabled')]: 'enabled' },
    });
  });

  it('migrates matching persisted legacy rules during a normal install', async () => {
    const { store, identity: trigger } = newStore('f8'.repeat(32), 'trigger');
    const installedIdentity = { id: 'f9'.repeat(32), name: 'future' };
    await writeProjection({ Future: future, unrelated });
    await store.setDefaultActivations([trigger], 'enabled');

    const installed = await install(store, installedIdentity);

    await expectFutureAdopted(installed, installedIdentity);
  });

  it('preserves unknown legacy rules from first initialization until install', async () => {
    const futureIdentity = { id: 'e9'.repeat(32), name: 'future' };
    await writeProjection({ installed: rules('!/installed/*'), future });

    const { store, initial } = await initStore('e8'.repeat(32), 'installed');

    expect(initial.legacyProjectionRemainder).toEqual({ future });
    expect(await readProjection()).toEqual({
      future,
      installed: rules('!/installed/*'),
    });

    const snapshot = await install(store, futureIdentity);

    expect(snapshot.extensions[futureIdentity.id]?.legacyPathRules).toEqual([
      '!/future/*',
    ]);
    expect(snapshot.legacyProjectionRemainder).toBeUndefined();
  });

  // Declares `declared` disabled, discovers `discovered`, and expects the
  // promoted policy to keep that activation. With `reinstall`, the artifact
  // directory exists during discovery, then disappears, and a reinstall must
  // keep the policy and drop the preserve marker.
  const promote = async (
    declared: ExtensionIdentity,
    discovered: ExtensionIdentity,
    reinstall: boolean,
  ) => {
    const store = makeStore();
    const initial = await store.setDefaultActivations([declared], 'disabled');
    const destination = path.join(extensionsDir, discovered.name);
    if (reinstall) await fsp.mkdir(destination);

    const promoted = await store.ensureInitialized([discovered]);

    expect(promoted.generation).toBe(initial.generation + 1);
    expect(promoted.extensions[discovered.id]).toEqual({
      name: discovered.name,
      artifactGeneration: promoted.generation,
      preserveActivationOnNextInstall: true,
      defaultActivation: 'disabled',
      workspaceOverrides: {},
    });
    if (!reinstall) return promoted;

    await fsp.rm(destination, { recursive: true });
    const reinstalled = await install(store, discovered);

    expect(reinstalled.extensions[discovered.id]).toMatchObject({
      artifactGeneration: reinstalled.generation,
      defaultActivation: 'disabled',
    });
    expect(
      reinstalled.extensions[discovered.id]?.preserveActivationOnNextInstall,
    ).toBeUndefined();
    return promoted;
  };

  it('promotes a declaration discovered outside the artifact transaction', async () => {
    const identity = { id: 'f7'.repeat(32), name: 'demo' };
    await promote(identity, identity, true);
  });

  it('targets an existing policy by name when the supplied id is provisional', async () => {
    const { store, identity, initial } = await initStore('f2'.repeat(32));

    const snapshot = await store.setDefaultActivations(
      [{ id: 'f4'.repeat(32), name: 'DEMO' }],
      'disabled',
    );

    expect(snapshot.generation).toBe(initial.generation + 1);
    expect(snapshot.extensions[identity.id]?.defaultActivation).toBe(
      'disabled',
    );
    expect(snapshot.extensions['f4'.repeat(32)]).toBeUndefined();
  });

  it('re-keys an explicit name declaration to the discovered id', async () => {
    const declared = { id: 'f5'.repeat(32), name: 'demo' };
    const discovered = { id: 'f6'.repeat(32), name: 'demo' };

    const promoted = await promote(declared, discovered, true);

    expect(promoted.extensions[declared.id]).toBeUndefined();
  });

  it('promotes a declaration when only the discovered name casing changes', async () => {
    const identity = { id: 'f7'.repeat(32), name: 'Demo' };
    await promote(identity, { id: identity.id, name: 'demo' }, false);
  });

  it('keeps a case-renamed installed extension attached to its artifact', async () => {
    const { store, identity } = newStore('da'.repeat(32), 'Demo');
    await install(store, identity);

    const renamed = { ...identity, name: 'demo' };
    await store.ensureInitialized([renamed]);
    hidePath(store, path.join(extensionsDir, renamed.name));
    const toggled = await store.setDefaultActivations([renamed], 'disabled');

    expect(toggled.extensions[identity.id]).toMatchObject({
      name: renamed.name,
      defaultActivation: 'disabled',
      artifactGeneration: expect.any(Number),
    });
    expect(toggled.extensions[identity.id]?.declarationOnly).toBeUndefined();
  });

  it('preserves the original error when rollback also fails', async () => {
    const { store, identity } = newStore('fa'.repeat(32));
    await store.ensureInitialized([]);
    const staging = await stage(store);
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

    const thrown = await store
      .commitArtifact({
        operation: 'install',
        identity,
        stagingDirectory: staging,
        destinationDirectory: path.join(extensionsDir, identity.name),
        initialActivation: { scope: 'user' },
      })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      primaryError,
      rollbackError,
    ]);
    const journals = await fsp.readdir(path.join(storeDir, 'transactions'));
    expect(journals.filter((name) => name.endsWith('.json'))).toHaveLength(1);
  });

  it('changes artifact generation only for artifact commits', async () => {
    const { store, identity } = newStore('91'.repeat(32));
    const installed = await install(store, identity, { version: 'one' });

    const activated = await store.setDefaultActivation(identity, 'disabled');
    expect(activated.generation).toBe(installed.generation + 1);
    expect(activated.extensions[identity.id]?.artifactGeneration).toBe(
      installed.generation,
    );

    const updated = await update(store, identity, 'two', installed.generation);
    expect(updated.extensions[identity.id]?.artifactGeneration).toBe(
      updated.generation,
    );
  });

  it('does not recreate activation policy after uninstall', async () => {
    const { store, identity } = newStore('97'.repeat(32));
    await install(store, identity, { version: 'one' });
    await uninstall(store, identity);

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
    await install(store, original, { version: 'one' });

    await expect(
      install(store, { id, name: 'renamed' }, { version: 'two' }),
    ).rejects.toBeInstanceOf(ExtensionConflictError);
    await expect(readVersion(extensionsDir, original.name)).resolves.toBe(
      'one',
    );
    expect(fs.existsSync(path.join(extensionsDir, 'renamed'))).toBe(false);
  });

  it('rejects a stale prepared update without replacing the artifact', async () => {
    const { store, identity } = newStore('92'.repeat(32));
    const installed = await install(store, identity, { version: 'one' });
    await update(store, identity, 'two', installed.generation);

    await expect(
      update(store, identity, 'stale', installed.generation),
    ).rejects.toBeInstanceOf(ExtensionConflictError);
    await expect(readVersion(extensionsDir, 'demo')).resolves.toBe('two');
  });

  it('rebases prepared updates for different artifacts', async () => {
    const store = makeStore();
    const [first, second] = firstAndSecond('95', '96');
    const firstInstalled = await install(store, first, { version: 'one' });
    const secondInstalled = await install(store, second, { version: 'one' });
    const firstUpdate = await prepareUpdate(store, first, 'first-updated');
    const secondUpdate = await prepareUpdate(store, second, 'second-updated');

    await firstUpdate(firstInstalled.extensions[first.id]!.artifactGeneration);
    await secondUpdate(
      secondInstalled.extensions[second.id]!.artifactGeneration,
    );

    await expect(readVersion(extensionsDir, first.name)).resolves.toBe(
      'first-updated',
    );
    await expect(readVersion(extensionsDir, second.name)).resolves.toBe(
      'second-updated',
    );
  });

  it('replaces stale policy state when its artifact is absent', async () => {
    const { store, identity } = newStore('93'.repeat(32), 'existing-policy');
    const destination = path.join(extensionsDir, identity.name);
    await install(store, identity, {
      version: 'old artifact',
      initialActivation: {
        scope: 'workspace',
        workspacePath: workspacePath('a'),
      },
    });
    await fsp.rm(destination, { recursive: true });

    const snapshot = await install(store, identity, {
      version: 'new artifact',
    });

    expect(snapshot.extensions[identity.id]).toMatchObject({
      defaultActivation: 'enabled',
      workspaceOverrides: {},
    });
    await expect(readVersion(destination)).resolves.toBe('new artifact');
  });

  it('preserves batch activation declared after an artifact disappears', async () => {
    const { store, identity } = newStore('9b'.repeat(32), 'retained-policy');
    const disabled = workspacePath('disabled');
    await install(store, identity, { version: 'old artifact' });
    await fsp.rm(path.join(extensionsDir, identity.name), { recursive: true });
    const provisional = { id: '9c'.repeat(32), name: identity.name };

    await store.setDefaultActivations([provisional], 'disabled');
    const declared = await store.setWorkspaceActivations(
      [provisional],
      disabled,
      'disabled',
    );

    expect(declared.extensions[identity.id]).toMatchObject({
      name: identity.name,
      declarationOnly: true,
      defaultActivation: 'disabled',
      workspaceOverrides: { [disabled]: 'disabled' },
    });
    expect(
      declared.extensions[identity.id]?.artifactGeneration,
    ).toBeUndefined();

    const installed = await install(store, identity, {
      version: 'new artifact',
    });

    expect(installed.extensions[identity.id]).toEqual({
      name: identity.name,
      artifactGeneration: installed.generation,
      defaultActivation: 'disabled',
      workspaceOverrides: { [disabled]: 'disabled' },
    });
  });

  it('rejects update when the artifact has no matching policy', async () => {
    const { store, identity } = newStore('94'.repeat(32), 'orphan-artifact');
    await fsp.mkdir(path.join(extensionsDir, identity.name), {
      recursive: true,
    });

    await expect(
      update(store, identity, 'new artifact', 0),
    ).rejects.toMatchObject({ code: 'extension_conflict' });
  });

  it('atomically replaces an artifact while preserving activation policy', async () => {
    const { store, identity } = newStore('a1'.repeat(32));
    const destination = path.join(extensionsDir, 'demo');
    await mkdirWithVersion(destination, 'old');
    await store.ensureInitialized([identity]);
    await store.setWorkspaceActivation(
      identity,
      workspacePath('a'),
      'disabled',
    );

    const snapshot = await update(store, identity, 'new');

    expect(await readVersion(destination)).toBe('new');
    expect(snapshot.extensions[identity.id]?.workspaceOverrides).toEqual({
      [workspacePath('a')]: 'disabled',
    });
  });

  it('moves an uninstalled artifact out of view before removing its policy', async () => {
    const { store, identity } = newStore('b1'.repeat(32));
    const destination = path.join(extensionsDir, 'demo');
    await mkdirWithVersion(destination, 'old');
    await store.ensureInitialized([identity]);

    const snapshot = await uninstall(store, identity);

    expect(fs.existsSync(destination)).toBe(false);
    expect(snapshot.extensions[identity.id]).toBeUndefined();
  });

  it('rejects uninstalling a declaration without deleting its policy', async () => {
    const { store, identity } = newStore('b5'.repeat(32), 'declared');
    const declared = await store.setDefaultActivations([identity], 'disabled');

    await expect(uninstall(store, identity)).rejects.toThrow(
      `Extension "${identity.name}" is not installed.`,
    );

    expect(await store.readSnapshot()).toEqual(declared);
  });

  it('idempotently handles concurrent uninstalls when the artifact is absent', async () => {
    const { store, identity } = await initStore('b4'.repeat(32));

    const [uninstalled, repeated] = await Promise.all([
      uninstall(store, identity),
      uninstall(store, identity),
    ]);

    expect(uninstalled.extensions[identity.id]).toBeUndefined();
    expect(repeated).toEqual(uninstalled);
  });

  it('allows uninstalling an extension from a snapshot with duplicate names', async () => {
    const { store, identity } = newStore('b2'.repeat(32));
    const duplicateId = 'b3'.repeat(32);
    await fsp.mkdir(path.join(extensionsDir, identity.name));
    const snapshot = await store.ensureInitialized([
      identity,
      { id: duplicateId, name: 'other' },
    ]);
    snapshot.extensions[duplicateId]!.name = identity.name;
    await fsp.writeFile(statePath, JSON.stringify(snapshot));

    const uninstalled = await uninstall(store, identity);

    expect(uninstalled.extensions[identity.id]).toBeUndefined();
    expect(uninstalled.extensions[duplicateId]?.name).toBe(identity.name);
  });

  it('rolls back an artifact-swapped transaction before the commit point', async () => {
    const { store, identity, initial } = await initStore('c1'.repeat(32));
    const { destination, journal } = await fabricateUpdate(
      'recover-before-commit',
      'artifact_swapped',
      { ...initial, generation: 1 },
    );

    await store.ensureInitialized([identity]);

    expect(await readVersion(destination)).toBe('old');
    expect(fs.existsSync(journal)).toBe(false);
  });

  it.each([
    {
      name: 'prepared install',
      operation: 'install' as const,
      phase: 'prepared' as const,
      stagingExists: true,
    },
    {
      name: 'artifact-swapped install',
      operation: 'install' as const,
      phase: 'artifact_swapped' as const,
      destinationVersion: 'new',
    },
    {
      name: 'artifact-swapped uninstall',
      operation: 'uninstall' as const,
      phase: 'artifact_swapped' as const,
      backupVersion: 'old',
      expectedDestinationVersion: 'old',
    },
  ])('rolls back a fabricated $name journal', async (scenario) => {
    const { store, identity, initial } = await initStore('c4'.repeat(32));
    const transactionId = scenario.name.replaceAll(' ', '-');
    const destination = path.join(extensionsDir, identity.name);
    const staging = path.join(storeDir, 'staging', transactionId);
    const backup = path.join(storeDir, 'rollback', transactionId);
    if (scenario.stagingExists) await mkdirWithVersion(staging, 'staged');
    if (scenario.destinationVersion) {
      await mkdirWithVersion(destination, scenario.destinationVersion);
    }
    if (scenario.backupVersion) {
      await mkdirWithVersion(backup, scenario.backupVersion);
    }
    await writeJournal(transactionId, {
      operation: scenario.operation,
      phase: scenario.phase,
      destinationDirectory: destination,
      ...(scenario.operation === 'install'
        ? { stagingDirectory: staging }
        : {}),
      backupDirectory: backup,
      targetSnapshot: { ...initial, generation: 1 },
    });

    const recovered = await store.readSnapshot();

    expect(recovered.generation).toBe(0);
    if (scenario.expectedDestinationVersion) {
      await expect(readVersion(destination)).resolves.toBe(
        scenario.expectedDestinationVersion,
      );
    } else {
      expect(fs.existsSync(destination)).toBe(false);
    }
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.existsSync(backup)).toBe(false);
    expect(fs.existsSync(journalPath(transactionId))).toBe(false);
  });

  it('recovers an artifact-swapped transaction before reading a snapshot', async () => {
    const { store, initial } = await initStore('c2'.repeat(32));
    const { destination, journal } = await fabricateUpdate(
      'recover-before-read',
      'artifact_swapped',
      { ...initial, generation: 1 },
    );

    const snapshot = await store.readSnapshot();

    expect(snapshot.generation).toBe(0);
    expect(await readVersion(destination)).toBe('old');
    expect(fs.existsSync(journal)).toBe(false);
  });

  it('keeps an artifact when state reached the target generation before the journal phase', async () => {
    const { store, initial } = await initStore('c3'.repeat(32));
    const targetSnapshot = { ...initial, generation: 1 };
    const { destination, backup, journal } = await fabricateUpdate(
      'recover-after-state-write',
      'artifact_swapped',
      targetSnapshot,
    );
    await fsp.writeFile(statePath, JSON.stringify(targetSnapshot));

    const recovered = await store.readSnapshot();

    expect(recovered.generation).toBe(1);
    expect(await readVersion(destination)).toBe('new');
    expect(fs.existsSync(backup)).toBe(false);
    expect(fs.existsSync(journal)).toBe(false);
  });

  it('finishes cleanup after a committed transaction', async () => {
    const { store, identity } = await initStore('d1'.repeat(32));
    const { destination, backup, journal } = await fabricateUpdate(
      'recover-after-commit',
      'state_committed',
      await store.setDefaultActivation(identity, 'disabled'),
    );

    await store.ensureInitialized([identity]);

    expect(await readVersion(destination)).toBe('new');
    expect(fs.existsSync(backup)).toBe(false);
    expect(fs.existsSync(journal)).toBe(false);
  });

  it('keeps committed cleanup failures from blocking store operations', async () => {
    const { store, identity } = await initStore('d2'.repeat(32));
    const { backup, journal } = await fabricateUpdate(
      'recover-cleanup-failure',
      'state_committed',
      await store.setDefaultActivation(identity, 'disabled'),
      false,
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
    const { store, identity } = await initStore('d4'.repeat(32));
    const journal = journalPath('corrupt');
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
    const { store, identity } = await initStore('d6'.repeat(32));
    await store.setDefaultActivation(identity, 'disabled');
    await fsp.writeFile(statePath, '{not-json');
    const journal = journalPath('corrupt');
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
      const { store, identity, initial } = await initStore('d5'.repeat(32));
      const transactionId = `hostile-${kind}`;
      const recordedId =
        kind === 'transaction-id' ? 'different-id' : transactionId;
      const outside = path.join(root, 'outside');
      const sentinel = path.join(outside, 'sentinel');
      await fsp.mkdir(outside);
      await fsp.writeFile(sentinel, 'preserve');
      const journal = journalPath(transactionId);
      const safe = {
        destination: path.join(extensionsDir, identity.name),
        staging: path.join(storeDir, 'staging', transactionId),
        backup: path.join(storeDir, 'rollback', transactionId),
      };
      const pick = (key: keyof typeof safe) =>
        kind === key ? outside : safe[key];
      await writeJournal(transactionId, {
        transactionId: recordedId,
        phase: 'artifact_swapped',
        destinationDirectory: pick('destination'),
        stagingDirectory: pick('staging'),
        backupDirectory: pick('backup'),
        targetSnapshot: { ...initial, generation: 1 },
      });

      await expect(store.readSnapshot()).resolves.toMatchObject({
        generation: 0,
      });
      await expect(
        store.setDefaultActivation(identity, 'disabled'),
      ).resolves.toMatchObject({ generation: 1 });
      expect(await fsp.readFile(sentinel, 'utf8')).toBe('preserve');
      expect(fs.existsSync(journal)).toBe(false);
      expect(JSON.parse(await readQuarantinedJournal(journal))).toMatchObject({
        transactionId: recordedId,
      });
    },
  );

  it.each(['corrupt', 'missing'] as const)(
    'recovers committed state from a journal when state.json is %s',
    async (stateCondition) => {
      const { store, identity } = await initStore('f1'.repeat(32));
      const { journal } = await fabricateUpdate(
        'recover-corrupt-commit',
        'state_committed',
        await store.setDefaultActivation(identity, 'disabled'),
        false,
      );
      await breakState(stateCondition);

      const recovered = await store.ensureInitialized([identity]);

      expect(recovered.generation).toBe(1);
      expect(recovered.extensions[identity.id]?.defaultActivation).toBe(
        'disabled',
      );
      expect(fs.existsSync(journal)).toBe(false);
    },
  );

  it('rolls back an artifact-swapped transaction when current state is corrupt', async () => {
    const { store, identity } = await initStore('f4'.repeat(32));
    const { destination, journal } = await fabricateUpdate(
      'recover-corrupt-artifact-swap',
      'artifact_swapped',
      await store.setDefaultActivation(identity, 'disabled'),
    );
    await breakState('corrupt');

    const recovered = await store.readSnapshot();

    expect(recovered.generation).toBe(0);
    expect(recovered.extensions[identity.id]?.defaultActivation).toBe(
      'enabled',
    );
    await expect(readVersion(destination)).resolves.toBe('old');
    expect(fs.existsSync(journal)).toBe(false);
  });

  it.each(['corrupt', 'missing'] as const)(
    'recovers state and projection from state.previous.json when state.json is %s',
    async (stateCondition) => {
      const { store, identity } = await initStore('f2'.repeat(32));
      await store.setDefaultActivation(identity, 'disabled');
      await breakState(stateCondition);
      await writeProjection({ demo: rules('!/*') });

      const recovered = await store.ensureInitialized([identity]);

      expect(recovered.generation).toBe(0);
      expect(recovered.extensions[identity.id]?.defaultActivation).toBe(
        'enabled',
      );
      expect(await readProjection()).toEqual({});
    },
  );

  it('fails closed when current and previous state are corrupt', async () => {
    const { store, identity } = await initStore('f3'.repeat(32));
    await store.setDefaultActivation(identity, 'disabled');
    await breakState('corrupt');
    await fsp.writeFile(
      path.join(storeDir, 'state.previous.json'),
      '{also-broken',
    );

    await expect(store.ensureInitialized([identity])).rejects.toBeInstanceOf(
      ExtensionStoreCorruptError,
    );
  });
});
