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
  ExtensionDirectoryLockedError,
  ExtensionStore,
  ExtensionStoreCorruptError,
  type ExtensionIdentity,
  type ExtensionStoreSnapshot,
  type InitialExtensionActivation,
} from './extension-store.js';
import {
  EXTENSIONS_CONFIG_FILENAME,
  INSTALL_METADATA_FILENAME,
} from './variables.js';
import { AGENT_PLUGIN_MANIFEST } from './agent-plugins-v1/manifest.js';
import { mockCompromisedLock } from '../test-utils/mock-compromised-lock.js';

/**
 * Seam for tests that need `fs.rename` to fail the way a Windows directory
 * lock fails. Returning an error intercepts that call; returning undefined lets
 * the real rename run, so unrelated atomic writes stay untouched.
 */
const renameFault = vi.hoisted(() => ({
  inspect: undefined as
    | ((src: string, dest: string) => Error | undefined)
    | undefined,
}));

/**
 * Seam for tests that need an atomic JSON write to fail - the journal marker
 * is the load-bearing one. Inspecting the target path intercepts that write
 * only; everything else keeps the real implementation.
 */
const atomicWriteFault = vi.hoisted(() => ({
  inspect: undefined as ((target: string) => Error | undefined) | undefined,
}));

vi.mock('../utils/atomicFileWrite.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/atomicFileWrite.js')>();
  return {
    ...actual,
    atomicWriteJSON: async (
      target: string,
      data: unknown,
      options?: Parameters<typeof actual.atomicWriteJSON>[2],
    ) => {
      const injected = atomicWriteFault.inspect?.(String(target));
      if (injected) throw injected;
      await actual.atomicWriteJSON(target, data, options);
    },
    renameWithRetry: async (
      src: string,
      dest: string,
      retries: number,
      delayMs: number,
      impl?: (s: string, d: string) => Promise<void>,
    ) => {
      const injected = renameFault.inspect?.(src, dest);
      if (injected) throw injected;
      await actual.renameWithRetry(src, dest, retries, delayMs, impl);
    },
  };
});

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
        // The fault covers both names the backup can be removed under: the
        // teardown demotes it to `.partial` before deleting.
        if (target === backup || String(target) === `${backup}.partial`) {
          throw new Error('cleanup denied');
        }
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

  describe('locked extension directory', () => {
    const originalPlatform = process.platform;

    const lockError = (src: string) =>
      Object.assign(new Error('EPERM: operation not permitted, rename'), {
        code: 'EPERM',
        path: src,
      });

    afterEach(() => {
      renameFault.inspect = undefined;
      atomicWriteFault.inspect = undefined;
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    const installDemo = async (
      store: ExtensionStore,
      identity: { id: string; name: string },
      destination: string,
    ) => {
      const staging = await store.createStagingDirectory();
      await fsp.writeFile(path.join(staging, 'version'), 'one');
      await fsp.writeFile(
        path.join(staging, EXTENSIONS_CONFIG_FILENAME),
        '{"name":"demo"}',
      );
      await fsp.mkdir(path.join(staging, 'skills'));
      await fsp.writeFile(path.join(staging, 'skills', 'keep.md'), 'one');
      await store.commitArtifact({
        operation: 'install',
        identity,
        stagingDirectory: staging,
        destinationDirectory: destination,
        initialActivation: { scope: 'user' },
      });
      // Present only in the installed copy, so a successful swap must prune it.
      await fsp.writeFile(path.join(destination, 'stale.md'), 'one');
    };

    const stageUpdate = async (store: ExtensionStore) => {
      const staging = await store.createStagingDirectory();
      await fsp.writeFile(path.join(staging, 'version'), 'two');
      await fsp.writeFile(
        path.join(staging, EXTENSIONS_CONFIG_FILENAME),
        '{"name":"demo"}',
      );
      await fsp.mkdir(path.join(staging, 'skills'));
      await fsp.writeFile(path.join(staging, 'skills', 'keep.md'), 'two');
      await fsp.writeFile(path.join(staging, 'added.md'), 'two');
      return staging;
    };

    const leftoverJournals = async () =>
      (await fsp.readdir(path.join(storeDir, 'transactions'))).filter((name) =>
        name.endsWith('.json'),
      );

    /** The snapshot a planted journal claims the store is moving to. */
    const targetSnapshotFor = async (
      store: ExtensionStore,
      identity: { id: string; name: string },
    ) => {
      const initial = await store.ensureInitialized([identity]);
      const target = structuredClone(initial);
      target.generation = 1;
      return target;
    };

    /** Forces the persisted retry window due on named journals: rewrites the
     *  marker to expire now. Pass them in oldest-first order when the rewrite
     *  order sets the mtimes a case depends on. */
    const expireJournalWindow = async (...journalPaths: string[]) => {
      for (const journalPath of journalPaths) {
        const due = JSON.parse(
          await fsp.readFile(journalPath, 'utf8'),
        ) as Record<string, unknown>;
        await fsp.writeFile(
          journalPath,
          JSON.stringify({ ...due, rollbackRetryAt: 1 }),
        );
      }
    };

    /** Writes a planted journal, plus the backup tree it names when given. */
    const plantJournal = async (
      journal: Record<string, unknown> & { transactionId: string },
      backupFiles: Record<string, string> = {},
      journalDirectory = path.join(storeDir, 'transactions'),
    ) => {
      if (Object.keys(backupFiles).length > 0) {
        const backup = String(journal['backupDirectory']);
        await fsp.mkdir(backup, { recursive: true });
        for (const [name, content] of Object.entries(backupFiles)) {
          await fsp.writeFile(path.join(backup, name), content);
        }
      }
      await fsp.writeFile(
        path.join(journalDirectory, `${journal.transactionId}.json`),
        JSON.stringify({ version: 1, ...journal }),
      );
    };

    it('swaps by copy when the backup rename is locked on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'b1'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      const staging = await stageUpdate(store);

      const blocked: string[] = [];
      renameFault.inspect = (src) => {
        if (src !== destination) return undefined;
        blocked.push(src);
        return lockError(src);
      };

      await store.commitArtifact({
        operation: 'update',
        identity,
        stagingDirectory: staging,
        destinationDirectory: destination,
      });

      expect(blocked).toEqual([destination]);
      expect(
        await fsp.readFile(path.join(destination, 'version'), 'utf8'),
      ).toBe('two');
      expect(
        await fsp.readFile(path.join(destination, 'skills', 'keep.md'), 'utf8'),
      ).toBe('two');
      expect(
        await fsp.readFile(path.join(destination, 'added.md'), 'utf8'),
      ).toBe('two');
      expect(fs.existsSync(path.join(destination, 'stale.md'))).toBe(false);
      expect(await fsp.readdir(path.join(storeDir, 'staging'))).toEqual([]);
      expect(await fsp.readdir(path.join(storeDir, 'rollback'))).toEqual([]);
      expect(await leftoverJournals()).toEqual([]);
    });

    it('does not fall back to a copy outside Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const store = makeStore();
      const identity = { id: 'b2'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      const staging = await stageUpdate(store);
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;

      await expect(
        store.commitArtifact({
          operation: 'update',
          identity,
          stagingDirectory: staging,
          destinationDirectory: destination,
        }),
      ).rejects.toMatchObject({ code: 'EPERM' });

      expect(
        await fsp.readFile(path.join(destination, 'version'), 'utf8'),
      ).toBe('one');
      expect(fs.existsSync(path.join(destination, 'stale.md'))).toBe(true);
      expect(fs.existsSync(path.join(destination, 'added.md'))).toBe(false);
      expect(await fsp.readdir(path.join(storeDir, 'rollback'))).toEqual([]);
      expect(await leftoverJournals()).toEqual([]);
    });

    it('uninstalls by emptying the directory when the rename is locked', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'b3'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;

      const snapshot = await store.commitArtifact({
        operation: 'uninstall',
        identity,
        destinationDirectory: destination,
      });

      expect(snapshot.extensions[identity.id]).toBeUndefined();
      expect(fs.existsSync(destination)).toBe(false);
      expect(await fsp.readdir(path.join(storeDir, 'rollback'))).toEqual([]);
      expect(await leftoverJournals()).toEqual([]);
    });

    it('names the directory when a copy-swap step is blocked', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'e2'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      const staging = await stageUpdate(store);
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;
      const internals = store as unknown as {
        emptyDirectory: (directory: string) => Promise<void>;
        pruneStalePaths: (
          stagingDirectory: string,
          destinationDirectory: string,
        ) => Promise<void>;
      };
      const emptied = vi.spyOn(internals, 'emptyDirectory');
      vi.spyOn(internals, 'pruneStalePaths').mockRejectedValueOnce(
        lockError(destination),
      );
      const installed = (await fsp.readdir(destination)).sort();

      const failure: unknown = await store
        .commitArtifact({
          operation: 'update',
          identity,
          stagingDirectory: staging,
          destinationDirectory: destination,
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ExtensionDirectoryLockedError);
      expect((failure as Error).message).toContain(destination);
      expect(
        await fsp.readFile(path.join(destination, 'version'), 'utf8'),
      ).toBe('one');
      expect(
        await fsp.readFile(path.join(destination, 'stale.md'), 'utf8'),
      ).toBe('one');
      expect(fs.existsSync(path.join(destination, 'added.md'))).toBe(false);
      // Restored, not emptied: an undeletable entry cannot leave a hole.
      expect(emptied).not.toHaveBeenCalled();
      expect((await fsp.readdir(destination)).sort()).toEqual(installed);
      expect(await fsp.readdir(path.join(storeDir, 'rollback'))).toEqual([]);
      expect(await leftoverJournals()).toEqual([]);
    });

    it('refuses a destination that resolves outside the extensions directory', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'f1'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      const staging = await stageUpdate(store);
      // A junction relocates the installed extension out of the store.
      const relocated = path.join(root, 'relocated-demo');
      await fsp.rename(destination, relocated);
      await fsp.writeFile(path.join(relocated, 'canary.txt'), 'user data');
      await fsp.symlink(relocated, destination, 'junction');
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;

      await expect(
        store.commitArtifact({
          operation: 'update',
          identity,
          stagingDirectory: staging,
          destinationDirectory: destination,
        }),
      ).rejects.toThrow(/resolves outside the extensions directory/);
      await expect(
        store.commitArtifact({
          operation: 'uninstall',
          identity,
          destinationDirectory: destination,
        }),
      ).rejects.toThrow(/resolves outside the extensions directory/);

      expect(
        await fsp.readFile(path.join(relocated, 'canary.txt'), 'utf8'),
      ).toBe('user data');
      expect(await fsp.readFile(path.join(relocated, 'version'), 'utf8')).toBe(
        'one',
      );
    });

    it('refuses a linked destination root the walks cannot enter', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'f3'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      const staging = await stageUpdate(store);
      // A junction that stays inside the root, so containment alone admits it.
      const relocated = path.join(extensionsDir, 'demo-data');
      await fsp.rename(destination, relocated);
      await fsp.writeFile(path.join(relocated, 'canary.txt'), 'user data');
      await fsp.symlink(relocated, destination, 'junction');
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;

      await expect(
        store.commitArtifact({
          operation: 'update',
          identity,
          stagingDirectory: staging,
          destinationDirectory: destination,
        }),
      ).rejects.toThrow(/is not a directory this store can replace/);
      await expect(
        store.commitArtifact({
          operation: 'uninstall',
          identity,
          destinationDirectory: destination,
        }),
      ).rejects.toThrow(/is not a directory this store can replace/);

      expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
      expect(
        await fsp.readFile(path.join(relocated, 'canary.txt'), 'utf8'),
      ).toBe('user data');
      expect(await fsp.readFile(path.join(relocated, 'version'), 'utf8')).toBe(
        'one',
      );
    });

    it.runIf(process.platform !== 'win32')(
      'keeps a relative symlink target across a copy swap',
      async () => {
        // The copy path is win32-gated; the real filesystem stays POSIX here, so
        // a relative symlink needs no Windows privilege.
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const store = makeStore();
        const identity = { id: 'f4'.repeat(32), name: 'demo' };
        const destination = path.join(extensionsDir, 'demo');
        await store.ensureInitialized([identity]);
        await installDemo(store, identity, destination);
        const staging = await stageUpdate(store);
        // Present in both trees, so the prune keeps it and the copy replaces it.
        await fsp.symlink(
          'keep.md',
          path.join(destination, 'skills', 'link.md'),
        );
        await fsp.symlink('keep.md', path.join(staging, 'skills', 'link.md'));
        renameFault.inspect = (src) =>
          src === destination ? lockError(src) : undefined;

        await store.commitArtifact({
          operation: 'update',
          identity,
          stagingDirectory: staging,
          destinationDirectory: destination,
        });

        // A rewritten target would be an absolute path into the staging
        // directory, which the commit removes.
        expect(
          await fsp.readlink(path.join(destination, 'skills', 'link.md')),
        ).toBe('keep.md');
        expect(
          await fsp.readFile(
            path.join(destination, 'skills', 'link.md'),
            'utf8',
          ),
        ).toBe('two');
      },
    );

    it('keeps the store usable when a copy-mode rollback cannot complete', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'f5'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      const staging = await stageUpdate(store);
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;
      const internals = store as unknown as {
        copyTree: (source: string, target: string) => Promise<void>;
      };
      const copyTree = internals.copyTree.bind(store);
      vi.spyOn(internals, 'copyTree').mockImplementation(
        async (source: string, target: string) => {
          // Only the backup copy reads; the apply copy and the rollback that
          // repeats it both write over the file the holder keeps.
          if (source === destination) return await copyTree(source, target);
          throw lockError(source);
        },
      );

      const failure: unknown = await store
        .commitArtifact({
          operation: 'update',
          identity,
          stagingDirectory: staging,
          destinationDirectory: destination,
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      // The journal survives, so a later operation retries it instead of every
      // operation failing until the holder releases.
      const [journalName] = await leftoverJournals();
      expect(journalName).toBeDefined();
      // A mutation that touches no artifact is not blocked by the holder, so it
      // advances the generation; the marked journal must still be rolled back
      // rather than cleaned up as a commit.
      await store.setWorkspaceActivations([identity], root, 'disabled');
      await expect(store.readSnapshot()).resolves.toBeDefined();
      expect(
        fs.existsSync(
          path.join(storeDir, 'rollback', journalName.replace(/\.json$/, '')),
        ),
      ).toBe(true);
      expect(await leftoverJournals()).toHaveLength(1);
    });

    it('surfaces a rollback failure that is not a lock', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'f9'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      const staging = await stageUpdate(store);
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;
      const internals = store as unknown as {
        copyTree: (source: string, target: string) => Promise<void>;
      };
      const copyTree = internals.copyTree.bind(store);
      vi.spyOn(internals, 'copyTree').mockImplementation(
        async (source: string, target: string) => {
          if (source === destination) return await copyTree(source, target);
          throw Object.assign(new Error('EIO: i/o error, copyfile'), {
            code: 'EIO',
          });
        },
      );

      const failure: unknown = await store
        .commitArtifact({
          operation: 'update',
          identity,
          stagingDirectory: staging,
          destinationDirectory: destination,
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      // Only a lock is absorbed; anything else still stops the caller.
      await expect(store.readSnapshot()).rejects.toMatchObject({ code: 'EIO' });
      // Inside the fault's window nothing was restored, so a read is refused
      // with the unresolved-transaction text instead of being served.
      await expect(store.readSnapshot()).rejects.toBeInstanceOf(
        ExtensionConflictError,
      );
    });

    it('refuses a second transaction while one is still unresolved', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'f7'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;
      const internals = store as unknown as {
        copyTree: (source: string, target: string) => Promise<void>;
      };
      const copyTree = internals.copyTree.bind(store);
      vi.spyOn(internals, 'copyTree').mockImplementation(
        async (source: string, target: string) => {
          if (source === destination) return await copyTree(source, target);
          throw lockError(source);
        },
      );
      await store
        .commitArtifact({
          operation: 'update',
          identity,
          stagingDirectory: await stageUpdate(store),
          destinationDirectory: destination,
        })
        .catch(() => undefined);
      expect(await leftoverJournals()).toHaveLength(1);

      const refusal: unknown = await store
        .commitArtifact({
          operation: 'update',
          identity,
          stagingDirectory: await stageUpdate(store),
          destinationDirectory: destination,
        })
        .catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(ExtensionDirectoryLockedError);
      // The retry names the directory the user can act on.
      expect((refusal as Error).message).toContain(destination);
      expect(await leftoverJournals()).toHaveLength(1);
    });

    it('restores the installed tree when a copy-mode uninstall cannot empty it', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'f8'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;
      const internals = store as unknown as {
        emptyDirectory: (directory: string) => Promise<void>;
      };
      // The holder lets one child go and refuses the next, so the wipe cannot
      // pass for "nothing was deleted" when the restore is skipped.
      vi.spyOn(internals, 'emptyDirectory').mockImplementation(
        async (directory: string) => {
          const [first] = await fsp.readdir(directory);
          await fsp.rm(path.join(directory, first!), {
            recursive: true,
            force: true,
          });
          throw lockError(directory);
        },
      );
      const installed = (await fsp.readdir(destination)).sort();

      const failure: unknown = await store
        .commitArtifact({
          operation: 'uninstall',
          identity,
          destinationDirectory: destination,
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ExtensionDirectoryLockedError);
      // The husk must not survive: the rollback restores the installed tree.
      expect((await fsp.readdir(destination)).sort()).toEqual(installed);
      expect(
        await fsp.readFile(path.join(destination, 'version'), 'utf8'),
      ).toBe('one');
      expect(
        await fsp.readFile(path.join(destination, 'stale.md'), 'utf8'),
      ).toBe('one');
      expect(
        await fsp.readFile(path.join(destination, 'skills', 'keep.md'), 'utf8'),
      ).toBe('one');
      expect(await fsp.readdir(path.join(storeDir, 'rollback'))).toEqual([]);
      expect(await leftoverJournals()).toEqual([]);
    });

    it('falls back to mtime order when a stack claims one generation', async () => {
      const store = makeStore();
      const identity = { id: 'f6'.repeat(32), name: 'demo' };
      const initial = await store.ensureInitialized([identity]);
      const targetSnapshot = structuredClone(initial);
      targetSnapshot.generation = 1;
      const destination = path.join(extensionsDir, 'demo');
      const transactionsDir = path.join(storeDir, 'transactions');
      const rollbackDir = path.join(storeDir, 'rollback');
      await fsp.mkdir(path.join(destination, 'skills'), { recursive: true });
      await fsp.writeFile(path.join(destination, 'version'), 'torn');
      const plant = async (
        transactionId: string,
        backupVersion: string,
        mtimeSeconds: number,
        blocked = false,
      ) => {
        const backup = path.join(rollbackDir, transactionId);
        await fsp.mkdir(path.join(backup, 'skills'), { recursive: true });
        await fsp.writeFile(path.join(backup, 'version'), backupVersion);
        const journalPath = path.join(transactionsDir, `${transactionId}.json`);
        await fsp.writeFile(
          journalPath,
          JSON.stringify({
            version: 1,
            transactionId,
            operation: 'update',
            phase: 'prepared',
            destinationDirectory: destination,
            stagingDirectory: path.join(storeDir, 'staging', transactionId),
            backupDirectory: backup,
            swapStrategy: 'copy',
            previousGeneration: 0,
            targetGeneration: 1,
            ...(blocked
              ? { rollbackBlocked: true, rollbackRetryAt: Date.now() + 3_000 }
              : {}),
            targetSnapshot,
          }),
        );
        await fsp.utimes(journalPath, mtimeSeconds, mtimeSeconds);
      };
      // Directory order lists the intact one first; mtime order lists it last.
      await plant('aa-intact-old', 'one', 1_000);
      await plant('zz-torn-new', 'torn', 2_000);

      await store.ensureInitialized([identity]);

      expect(
        await fsp.readFile(path.join(destination, 'version'), 'utf8'),
      ).toBe('one');
      expect(await fsp.readdir(rollbackDir)).toEqual([]);
      expect(await leftoverJournals()).toEqual([]);

      // The pass that establishes this order also rewrites the journals it
      // ordered: with both already blocked, it can only mark the older one,
      // which moves that journal's mtime to the front.
      await plant('aa-intact-old', 'one', 1_000, true);
      await plant('zz-torn-new', 'torn', 2_000, true);
      await store.readSnapshot();
      // Every journal the store orders must carry its own key: otherwise the
      // order survives only on the files some other write happened to touch.
      const journalFields = async (name: string) =>
        JSON.parse(
          await fsp.readFile(path.join(transactionsDir, name), 'utf8'),
        ) as Record<string, unknown>;
      expect(await journalFields('aa-intact-old.json')).toMatchObject({
        orderMs: 1_000_000,
      });
      expect(await journalFields('zz-torn-new.json')).toMatchObject({
        orderMs: 2_000_000,
      });
      await expireJournalWindow(
        path.join(transactionsDir, 'zz-torn-new.json'),
        path.join(transactionsDir, 'aa-intact-old.json'),
      );
      // The same pass stamps both journals, so only a clock tick separates
      // their mtimes; pin the inversion instead of racing the timestamp
      // granularity of the filesystem under test.
      const nowSeconds = Date.now() / 1000;
      await fsp.utimes(
        path.join(transactionsDir, 'zz-torn-new.json'),
        nowSeconds,
        nowSeconds,
      );
      await fsp.utimes(
        path.join(transactionsDir, 'aa-intact-old.json'),
        nowSeconds + 10,
        nowSeconds + 10,
      );
      await store.readSnapshot();
      expect(
        await fsp.readFile(path.join(destination, 'version'), 'utf8'),
      ).toBe('one');
    });

    it('updates by copy when an entry changes kind', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'f2'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      const staging = await stageUpdate(store);
      // `docs` is a file here and a directory in the staged version.
      await fsp.writeFile(path.join(destination, 'docs'), 'one');
      await fsp.mkdir(path.join(staging, 'docs'));
      await fsp.writeFile(path.join(staging, 'docs', 'a.md'), 'two');
      // And `skills/keep.md` is a directory here, a file in the staged version.
      await fsp.rm(path.join(destination, 'skills', 'keep.md'));
      await fsp.mkdir(path.join(destination, 'skills', 'keep.md'));
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;

      await store.commitArtifact({
        operation: 'update',
        identity,
        stagingDirectory: staging,
        destinationDirectory: destination,
      });

      expect(
        await fsp.readFile(path.join(destination, 'docs', 'a.md'), 'utf8'),
      ).toBe('two');
      expect(
        await fsp.readFile(path.join(destination, 'version'), 'utf8'),
      ).toBe('two');
      expect(
        await fsp.readFile(path.join(destination, 'skills', 'keep.md'), 'utf8'),
      ).toBe('two');
      expect(fs.existsSync(path.join(destination, 'stale.md'))).toBe(false);
    });

    it('removes a backup the interrupted swap left half-copied', async () => {
      const store = makeStore();
      const identity = { id: 'e4'.repeat(32), name: 'demo' };
      const initial = await store.ensureInitialized([identity]);
      const targetSnapshot = structuredClone(initial);
      targetSnapshot.generation = 1;
      const transactionId = 'interrupted-copy-swap';
      const destination = path.join(extensionsDir, 'demo');
      const backup = path.join(storeDir, 'rollback', transactionId);
      const partialBackup = `${backup}.partial`;
      await fsp.mkdir(path.join(destination, 'skills'), { recursive: true });
      await fsp.writeFile(path.join(destination, 'version'), 'old');
      // The copy died before the backup was published; only `.partial` exists,
      // and its content differs from the intact destination so restoring it
      // over the destination cannot pass for leaving it alone.
      await fsp.mkdir(path.join(partialBackup, 'skills'), { recursive: true });
      await fsp.writeFile(path.join(partialBackup, 'version'), 'half');
      await fsp.writeFile(
        path.join(storeDir, 'transactions', `${transactionId}.json`),
        JSON.stringify({
          version: 1,
          transactionId,
          operation: 'update',
          phase: 'prepared',
          destinationDirectory: destination,
          stagingDirectory: path.join(storeDir, 'staging', transactionId),
          backupDirectory: backup,
          swapStrategy: 'copy',
          previousGeneration: 0,
          targetGeneration: 1,
          targetSnapshot,
        }),
      );

      await store.ensureInitialized([identity]);

      expect(fs.existsSync(partialBackup)).toBe(false);
      expect(await fsp.readdir(path.join(storeDir, 'rollback'))).toEqual([]);
      expect(await leftoverJournals()).toEqual([]);
      expect(
        await fsp.readFile(path.join(destination, 'version'), 'utf8'),
      ).toBe('old');
    });

    it('restores a copy-swap transaction by copying the backup back', async () => {
      const store = makeStore();
      const identity = { id: 'b4'.repeat(32), name: 'demo' };
      const initial = await store.ensureInitialized([identity]);
      const targetSnapshot = structuredClone(initial);
      targetSnapshot.generation = 1;
      const transactionId = 'recover-copy-swap';
      const destination = path.join(extensionsDir, 'demo');
      const backup = path.join(storeDir, 'rollback', transactionId);
      await fsp.mkdir(path.join(destination, 'skills'), { recursive: true });
      await fsp.writeFile(path.join(destination, 'version'), 'half');
      await fsp.writeFile(path.join(destination, 'skills', 'new.md'), 'new');
      await fsp.mkdir(path.join(backup, 'skills'), { recursive: true });
      await fsp.writeFile(path.join(backup, 'version'), 'old');
      await fsp.writeFile(path.join(backup, 'skills', 'old.md'), 'old');
      await fsp.writeFile(
        path.join(storeDir, 'transactions', `${transactionId}.json`),
        JSON.stringify({
          version: 1,
          transactionId,
          operation: 'update',
          phase: 'artifact_swapped',
          destinationDirectory: destination,
          stagingDirectory: path.join(storeDir, 'staging', transactionId),
          backupDirectory: backup,
          swapStrategy: 'copy',
          previousGeneration: 0,
          targetGeneration: 1,
          targetSnapshot,
        }),
      );

      await store.ensureInitialized([identity]);

      expect(
        await fsp.readFile(path.join(destination, 'version'), 'utf8'),
      ).toBe('old');
      expect(
        await fsp.readFile(path.join(destination, 'skills', 'old.md'), 'utf8'),
      ).toBe('old');
      expect(fs.existsSync(path.join(destination, 'skills', 'new.md'))).toBe(
        false,
      );
    });

    it('quarantines a journal with an unrecognised swap strategy', async () => {
      const store = makeStore();
      const identity = { id: 'b5'.repeat(32), name: 'demo' };
      const targetSnapshot = await targetSnapshotFor(store, identity);
      const transactionId = 'bad-swap-strategy';
      const journal = path.join(
        storeDir,
        'transactions',
        `${transactionId}.json`,
      );
      await plantJournal({
        transactionId,
        operation: 'update',
        phase: 'prepared',
        destinationDirectory: path.join(extensionsDir, 'demo'),
        stagingDirectory: path.join(storeDir, 'staging', transactionId),
        backupDirectory: path.join(storeDir, 'rollback', transactionId),
        swapStrategy: 'sideways',
        previousGeneration: 0,
        targetGeneration: 1,
        targetSnapshot,
      });
      // The retry window is validated too: a journal that cannot say when it
      // may be retried again must not be replayed on the self-healing path.
      const badRetries = 'bad-retry-count';
      const retryJournal = path.join(
        storeDir,
        'transactions',
        `${badRetries}.json`,
      );
      await plantJournal({
        transactionId: badRetries,
        operation: 'update',
        phase: 'prepared',
        destinationDirectory: path.join(extensionsDir, 'demo'),
        stagingDirectory: path.join(storeDir, 'staging', badRetries),
        backupDirectory: path.join(storeDir, 'rollback', badRetries),
        rollbackRetryAt: 'soon',
        previousGeneration: 0,
        targetGeneration: 1,
        targetSnapshot,
      });

      await store.ensureInitialized([identity]);

      expect(fs.existsSync(journal)).toBe(false);
      expect(JSON.parse(await readQuarantinedJournal(journal))).toMatchObject({
        transactionId,
        swapStrategy: 'sideways',
      });
      expect(fs.existsSync(retryJournal)).toBe(false);
      expect(
        JSON.parse(await readQuarantinedJournal(retryJournal)),
      ).toMatchObject({ transactionId: badRetries, rollbackRetryAt: 'soon' });
    });

    it('commits while a committed journal awaits cleanup', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'ab'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      const rollbackRoot = path.join(storeDir, 'rollback');
      // Post-commit teardown of rollback/<id> never completes, so its journal
      // survives the commit that owns it.
      const rm = fsp.rm.bind(fsp);
      const rmSpy = vi
        .spyOn(fsp, 'rm')
        .mockImplementation(async (target, opts) => {
          if (String(target).startsWith(rollbackRoot)) {
            throw lockError(String(target));
          }
          return await rm(target, opts);
        });

      try {
        await store.commitArtifact({
          operation: 'update',
          identity,
          stagingDirectory: await stageUpdate(store),
          destinationDirectory: destination,
        });
        const staging = await store.createStagingDirectory();
        await fsp.writeFile(path.join(staging, 'version'), 'three');
        // A transaction that committed is not a pending one.
        await store.commitArtifact({
          operation: 'update',
          identity,
          stagingDirectory: staging,
          destinationDirectory: destination,
        });
      } finally {
        rmSpy.mockRestore();
      }

      expect(
        await fsp.readFile(path.join(destination, 'version'), 'utf8'),
      ).toBe('three');
    });

    const defeatRenameRestore = async (platform: string) => {
      Object.defineProperty(process, 'platform', { value: platform });
      const store = makeStore();
      const identity = { id: 'ac'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      const staging = await stageUpdate(store);
      const internals = store as unknown as {
        writeSnapshotUnlocked: (snapshot: unknown) => Promise<void>;
      };
      vi.spyOn(internals, 'writeSnapshotUnlocked').mockRejectedValueOnce(
        new Error('ENOSPC: no space left on device, write'),
      );
      // Only the restore direction is held; the swap itself stays on rename.
      const rollbackRoot = path.join(storeDir, 'rollback');
      renameFault.inspect = (src, dest) =>
        dest === destination && src.startsWith(rollbackRoot)
          ? lockError(src)
          : undefined;

      const failure: unknown = await store
        .commitArtifact({
          operation: 'update',
          identity,
          stagingDirectory: staging,
          destinationDirectory: destination,
        })
        .catch((error: unknown) => error);
      return { store, destination, failure };
    };

    it('does not absorb a rename-mode restore the holder defeated', async () => {
      const { store, destination, failure } =
        await defeatRenameRestore('win32');

      expect(failure).toBeInstanceOf(AggregateError);
      // The rollback empties the destination first, so this holder leaves a
      // hole: the store must not report the extension as installed.
      expect(fs.existsSync(destination)).toBe(false);
      const readFailure: unknown = await store
        .readSnapshot()
        .catch((error: unknown) => error);
      expect(readFailure).toBeInstanceOf(ExtensionDirectoryLockedError);
      expect(
        (readFailure as { cause?: NodeJS.ErrnoException }).cause?.code,
      ).toBe('EPERM');
      expect(await leftoverJournals()).toHaveLength(1);
    });

    it('leaves the raw errno off Windows, where a lock is not the likely cause', async () => {
      const { store, destination } = await defeatRenameRestore('linux');

      expect(fs.existsSync(destination)).toBe(false);
      await expect(store.readSnapshot()).rejects.toMatchObject({
        code: 'EPERM',
      });
    });

    it('retries a cleanup the holder defeated instead of blocking the next update', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'ad'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      const staging = await stageUpdate(store);
      const rollbackRoot = path.join(storeDir, 'rollback');
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;
      const internals = store as unknown as {
        copyTree: (
          source: string,
          target: string,
          budget: unknown,
        ) => Promise<void>;
      };
      const copyTree = internals.copyTree.bind(store);
      const restored: string[] = [];
      vi.spyOn(internals, 'copyTree').mockImplementation(
        async (source: string, target: string, budget: unknown) => {
          if (source.startsWith(rollbackRoot)) restored.push(source);
          // Only the apply copy is held; the backup copy and the restore are not.
          if (source === staging) throw lockError(source);
          return await copyTree(source, target, budget);
        },
      );
      // The backup the restore left behind is held for the rest of the
      // commit: every removal under the rollback root after the swap's own
      // pre-clean passes through - the demoted `.partial` name included.
      const rm = fsp.rm.bind(fsp);
      let holdBackup = true;
      let rollbackRemovals = 0;
      let rollbackRmCalls = 0;
      const rmSpy = vi
        .spyOn(fsp, 'rm')
        .mockImplementation(async (target, opts) => {
          const targetPath = String(target);
          if (targetPath.startsWith(rollbackRoot)) {
            rollbackRemovals += 1;
            rollbackRmCalls += 1;
            if (holdBackup && rollbackRmCalls > 1) {
              throw lockError(targetPath);
            }
          }
          return await rm(target, opts);
        });

      try {
        const failure: unknown = await store
          .commitArtifact({
            operation: 'update',
            identity,
            stagingDirectory: staging,
            destinationDirectory: destination,
          })
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ExtensionDirectoryLockedError);
        // The restore landed before the cleanup was held.
        expect(
          await fsp.readFile(path.join(destination, 'version'), 'utf8'),
        ).toBe('one');
        const [journalName] = await leftoverJournals();
        const journal = JSON.parse(
          await fsp.readFile(
            path.join(storeDir, 'transactions', journalName!),
            'utf8',
          ),
        ) as { cleanupPending?: boolean; rollbackBlocked?: boolean };
        // A rollback that already restored owes the cleanup, not the rollback.
        expect(journal.cleanupPending).toBe(true);
        expect(journal.rollbackBlocked).toBeUndefined();
        expect(
          fs.existsSync(
            path.join(rollbackRoot, journalName!.replace(/\.json$/, '')),
          ),
        ).toBe(true);

        const restoresBefore = restored.length;
        const removalsBefore = rollbackRemovals;
        await store.readSnapshot();
        await store.readSnapshot();
        // The settled rollback is neither copied again nor re-walked: the
        // cleanup mark wrote the same window, so a held teardown costs reads
        // nothing inside it.
        expect(restored).toHaveLength(restoresBefore);
        expect(rollbackRemovals).toBe(removalsBefore);

        const expireWindow = async () => {
          const [journalName] = await leftoverJournals();
          await expireJournalWindow(
            path.join(storeDir, 'transactions', journalName!),
          );
        };
        // An expired window admits one retry; still held, it re-marks, so
        // later reads pay nothing again until the next expiry.
        await expireWindow();
        await store.readSnapshot();
        expect(rollbackRemovals).toBeGreaterThan(removalsBefore);
        const reMarked = JSON.parse(
          await fsp.readFile(
            path.join(storeDir, 'transactions', (await leftoverJournals())[0]!),
            'utf8',
          ),
        ) as { rollbackRetryAt?: number };
        expect(reMarked.rollbackRetryAt!).toBeGreaterThan(Date.now());

        // Once the holder lets go, the backup is removed and the next update is
        // not refused for a transaction that is already settled.
        holdBackup = false;
        await expireWindow();
        await store.readSnapshot();
        expect(await leftoverJournals()).toEqual([]);
        expect(await fsp.readdir(rollbackRoot)).toEqual([]);
        const staging2 = await store.createStagingDirectory();
        await fsp.writeFile(path.join(staging2, 'version'), 'two');
        await store.commitArtifact({
          operation: 'update',
          identity,
          stagingDirectory: staging2,
          destinationDirectory: destination,
        });
        expect(await fsp.readdir(rollbackRoot)).toEqual([]);
        expect(await leftoverJournals()).toEqual([]);
      } finally {
        rmSpy.mockRestore();
        vi.restoreAllMocks();
      }
    });

    it('retries a copy step the holder released', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'ae'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      const staging = await stageUpdate(store);
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;
      const cpSpy = vi
        .spyOn(fsp, 'cp')
        .mockRejectedValueOnce(lockError(destination));

      try {
        await store.commitArtifact({
          operation: 'update',
          identity,
          stagingDirectory: staging,
          destinationDirectory: destination,
        });
        // The fault fired: the swap really ran through the copied tree.
        expect(cpSpy).toHaveBeenCalled();
      } finally {
        cpSpy.mockRestore();
      }

      expect(
        await fsp.readFile(path.join(destination, 'version'), 'utf8'),
      ).toBe('two');
      expect(fs.existsSync(path.join(destination, 'stale.md'))).toBe(false);
      expect(await fsp.readdir(path.join(storeDir, 'rollback'))).toEqual([]);
      expect(await leftoverJournals()).toEqual([]);
    });

    it('retries a destination removal the holder released', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'af'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;
      const rm = fsp.rm.bind(fsp);
      let heldRoot = false;
      const rmSpy = vi
        .spyOn(fsp, 'rm')
        .mockImplementation(async (target, opts) => {
          if (!heldRoot && String(target) === destination) {
            heldRoot = true;
            throw lockError(destination);
          }
          return await rm(target, opts);
        });

      try {
        const snapshot = await store.commitArtifact({
          operation: 'uninstall',
          identity,
          destinationDirectory: destination,
        });
        expect(snapshot.extensions[identity.id]).toBeUndefined();
      } finally {
        rmSpy.mockRestore();
      }

      expect(heldRoot).toBe(true);
      expect(fs.existsSync(destination)).toBe(false);
      expect(await fsp.readdir(path.join(storeDir, 'rollback'))).toEqual([]);
      expect(await leftoverJournals()).toEqual([]);
    });

    it('recovers a transactions root that is a link', async () => {
      const store = makeStore();
      const identity = { id: 'ba'.repeat(32), name: 'demo' };
      const targetSnapshot = await targetSnapshotFor(store, identity);
      const transactionId = 'linked-transactions';
      const destination = path.join(extensionsDir, 'demo');
      await fsp.mkdir(destination, { recursive: true });
      await fsp.writeFile(path.join(destination, 'version'), 'torn');
      // A relocated store: the transactions root is a junction to a real
      // directory. Recovery reads journals through it, as the merge base did;
      // refusing to enumerate a link belongs to the walks that delete.
      const transactionsDir = path.join(storeDir, 'transactions');
      const movedTransactions = path.join(storeDir, 'moved-transactions');
      await fsp.mkdir(movedTransactions, { recursive: true });
      await fsp.rm(transactionsDir, { recursive: true, force: true });
      await fsp.symlink(movedTransactions, transactionsDir, 'junction');
      await plantJournal(
        {
          transactionId,
          operation: 'update',
          phase: 'prepared',
          destinationDirectory: destination,
          stagingDirectory: path.join(storeDir, 'staging', transactionId),
          backupDirectory: path.join(storeDir, 'rollback', transactionId),
          previousGeneration: 0,
          targetGeneration: 1,
          targetSnapshot,
        },
        { version: 'old', [EXTENSIONS_CONFIG_FILENAME]: '{"name":"demo"}' },
        movedTransactions,
      );

      await store.readSnapshot();

      expect(
        await fsp.readFile(path.join(destination, 'version'), 'utf8'),
      ).toBe('old');
      expect(
        fs.existsSync(path.join(movedTransactions, `${transactionId}.json`)),
      ).toBe(false);
    });

    it('bounds the retries one swap spends on held entries', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'bb'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      const staleNames = Array.from(
        { length: 16 },
        (_, index) => `stale-${index}.md`,
      );
      const stalePaths = new Set(
        staleNames.map((name) => path.join(destination, name)),
      );
      for (const name of staleNames) {
        await fsp.writeFile(path.join(destination, name), 'one');
      }
      const staging = await stageUpdate(store);
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;
      // Every stale entry is held for its first two attempts.
      const held = new Map<string, number>();
      const attempts: string[] = [];
      const rm = fsp.rm.bind(fsp);
      const rmSpy = vi
        .spyOn(fsp, 'rm')
        .mockImplementation(async (target, opts) => {
          const targetPath = String(target);
          if (stalePaths.has(targetPath)) {
            attempts.push(targetPath);
            const seen = (held.get(targetPath) ?? 0) + 1;
            held.set(targetPath, seen);
            if (seen <= 2) throw lockError(targetPath);
          }
          return await rm(target, opts);
        });
      const internals = store as unknown as {
        retryLock: (
          step: () => Promise<unknown>,
          budget: { remainingMs: number },
        ) => Promise<unknown>;
      };
      const budgets = new Set<{ remainingMs: number }>();
      const retryLock = internals.retryLock.bind(store);
      const retrySpy = vi
        .spyOn(internals, 'retryLock')
        .mockImplementation(async (step, budget) => {
          budgets.add(budget);
          return await retryLock(step, budget);
        });

      try {
        const failure: unknown = await store
          .commitArtifact({
            operation: 'update',
            identity,
            stagingDirectory: staging,
            destinationDirectory: destination,
          })
          .catch((error: unknown) => error);

        // The allowance is spent instead of holding the store lock for a
        // backoff per entry, so the swap ends in the actionable error.
        expect(failure).toBeInstanceOf(ExtensionDirectoryLockedError);
        expect(attempts.length).toBeLessThan(2 * staleNames.length);
        // One allowance per store operation, not one per entry it walks.
        expect(budgets.size).toBe(1);
      } finally {
        retrySpy.mockRestore();
        rmSpy.mockRestore();
      }
    });

    // Nothing to restore from is the one refusal both platforms must report,
    // each with its own honest text: the held-handle diagnosis only where a
    // lock error means a holder, never invented from inside the window.
    for (const { platform, id, firstRead, secondRead } of [
      {
        platform: 'linux',
        id: 'c1',
        firstRead: (failure: unknown) =>
          expect(failure).toMatchObject({ code: 'EPERM' }),
        secondRead: (failure: unknown) =>
          expect(failure).toBeInstanceOf(ExtensionConflictError),
      },
      {
        platform: 'win32',
        id: 'ca',
        firstRead: (failure: unknown) => {
          expect(failure).toBeInstanceOf(ExtensionDirectoryLockedError);
          expect(
            (failure as { cause?: NodeJS.ErrnoException }).cause?.code,
          ).toBe('EPERM');
        },
        secondRead: (failure: unknown) =>
          expect(failure).toBeInstanceOf(ExtensionDirectoryLockedError),
      },
    ]) {
      it(`stops the caller on an install rollback with no backup to retry from on ${platform}`, async () => {
        Object.defineProperty(process, 'platform', { value: platform });
        const store = makeStore();
        const identity = { id: id.repeat(32), name: 'demo' };
        const targetSnapshot = await targetSnapshotFor(store, identity);
        const transactionId = `install-blocked-${platform}`;
        const destination = path.join(extensionsDir, 'demo');
        // A crashed install leaves the half-written tree and its journal
        // behind, with no backup and no staging directory left. The manifest
        // makes the destination look loadable, so refusal can only come from
        // the missing backup.
        await fsp.mkdir(destination, { recursive: true });
        await fsp.writeFile(path.join(destination, 'version'), 'two');
        await fsp.writeFile(
          path.join(destination, EXTENSIONS_CONFIG_FILENAME),
          '{"name":"demo"}',
        );
        await plantJournal({
          transactionId,
          operation: 'install',
          phase: 'prepared',
          destinationDirectory: destination,
          stagingDirectory: path.join(storeDir, 'staging', transactionId),
          backupDirectory: path.join(storeDir, 'rollback', transactionId),
          previousGeneration: 0,
          targetGeneration: 1,
          targetSnapshot,
        });
        const rm = fsp.rm.bind(fsp);
        let destinationRemovals = 0;
        const rmSpy = vi
          .spyOn(fsp, 'rm')
          .mockImplementation(async (target, opts) => {
            if (String(target) === destination) {
              destinationRemovals += 1;
              throw lockError(destination);
            }
            return await rm(target, opts);
          });

        try {
          // Nothing can restore this destination, so the store must not adopt
          // the leftover tree as an installed extension and carry on.
          const first: unknown = await store
            .readSnapshot()
            .catch((error: unknown) => error);
          firstRead(first);
          expect(await leftoverJournals()).toHaveLength(1);
          // The refusal still got its mark and window: the next read rejects
          // from the window check without re-attempting the doomed restore.
          const attempted = destinationRemovals;
          expect(attempted).toBeGreaterThan(0);
          const second: unknown = await store
            .readSnapshot()
            .catch((error: unknown) => error);
          secondRead(second);
          expect(destinationRemovals).toBe(attempted);
          const [name] = await leftoverJournals();
          const journal = JSON.parse(
            await fsp.readFile(
              path.join(storeDir, 'transactions', name!),
              'utf8',
            ),
          ) as { rollbackBlocked?: boolean; rollbackRetryAt?: number };
          expect(journal).toMatchObject({
            rollbackBlocked: true,
            rollbackRetryAt: expect.any(Number),
          });
        } finally {
          rmSpy.mockRestore();
        }
      });
    }

    it('stops the caller when a copy-mode uninstall leaves no manifest behind', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'c2'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;
      const internals = store as unknown as {
        emptyDirectory: (directory: string, budget: unknown) => Promise<void>;
        copyTree: (
          source: string,
          target: string,
          budget: unknown,
        ) => Promise<void>;
      };
      // The wipe deletes everything, the manifest included, then the holder
      // refuses the root - and the restore that could put it back is held too.
      vi.spyOn(internals, 'emptyDirectory').mockImplementation(
        async (directory: string) => {
          for (const name of await fsp.readdir(directory)) {
            await fsp.rm(path.join(directory, name), {
              recursive: true,
              force: true,
            });
          }
          throw lockError(directory);
        },
      );
      const copyTree = internals.copyTree.bind(store);
      vi.spyOn(internals, 'copyTree').mockImplementation(
        async (source: string, target: string, budget: unknown) => {
          // The backup copy lands; the restore that would put the manifest
          // back is held.
          if (source === destination) {
            return await copyTree(source, target, budget);
          }
          throw lockError(source);
        },
      );

      try {
        await expect(
          store.commitArtifact({
            operation: 'uninstall',
            identity,
            destinationDirectory: destination,
          }),
        ).rejects.toBeInstanceOf(AggregateError);
        // Absorbing this would keep the manifest-less husk the design forbids.
        await expect(store.readSnapshot()).rejects.toBeInstanceOf(
          ExtensionDirectoryLockedError,
        );
        expect(
          fs.existsSync(path.join(destination, EXTENSIONS_CONFIG_FILENAME)),
        ).toBe(false);
        expect(await leftoverJournals()).toHaveLength(1);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('marks a cleanup that failed for another reason before rethrowing it', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'c3'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      const staging = await stageUpdate(store);
      const rollbackRoot = path.join(storeDir, 'rollback');
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;
      const internals = store as unknown as {
        copyTree: (
          source: string,
          target: string,
          budget: unknown,
        ) => Promise<void>;
      };
      const copyTree = internals.copyTree.bind(store);
      const restored: string[] = [];
      vi.spyOn(internals, 'copyTree').mockImplementation(
        async (source: string, target: string, budget: unknown) => {
          if (source.startsWith(rollbackRoot)) restored.push(source);
          if (source === staging) throw lockError(source);
          return await copyTree(source, target, budget);
        },
      );
      // The backup removal dies mid-way on a non-lock error once the demote
      // has renamed the backup, leaving a half-deleted one behind.
      const rm = fsp.rm.bind(fsp);
      let faulted = false;
      const rmSpy = vi
        .spyOn(fsp, 'rm')
        .mockImplementation(async (target, opts) => {
          const targetPath = String(target);
          if (
            !faulted &&
            targetPath.endsWith('.partial') &&
            fs.existsSync(targetPath)
          ) {
            faulted = true;
            const [first] = await fsp.readdir(targetPath);
            await rm(path.join(targetPath, first!), {
              recursive: true,
              force: true,
            });
            throw Object.assign(new Error('EIO: i/o error, rm'), {
              code: 'EIO',
            });
          }
          return await rm(target, opts);
        });

      try {
        const failure: unknown = await store
          .commitArtifact({
            operation: 'update',
            identity,
            stagingDirectory: staging,
            destinationDirectory: destination,
          })
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AggregateError);
        expect(
          (failure as { errors: Array<{ code?: string }> }).errors[1].code,
        ).toBe('EIO');
        const [journalName] = await leftoverJournals();
        const journal = JSON.parse(
          await fsp.readFile(
            path.join(storeDir, 'transactions', journalName!),
            'utf8',
          ),
        ) as { cleanupPending?: boolean; rollbackBlocked?: boolean };
        // The restore is done, so the step owed is the cleanup: a later pass
        // must not restore again from the half-deleted backup.
        expect(journal.cleanupPending).toBe(true);
        expect(journal.rollbackBlocked).toBeUndefined();
        const restoresBefore = restored.length;
        await store.readSnapshot();
        expect(restored).toHaveLength(restoresBefore);
        expect(await leftoverJournals()).toEqual([]);
        expect(
          await fsp.readFile(path.join(destination, 'version'), 'utf8'),
        ).toBe('one');
      } finally {
        rmSpy.mockRestore();
        vi.restoreAllMocks();
      }
    });

    it('retries the journal unlink a holder released', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'c4'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      const staging = await stageUpdate(store);
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;
      const internals = store as unknown as {
        copyTree: (
          source: string,
          target: string,
          budget: unknown,
        ) => Promise<void>;
      };
      const copyTree = internals.copyTree.bind(store);
      vi.spyOn(internals, 'copyTree').mockImplementation(
        async (source: string, target: string, budget: unknown) => {
          if (source === staging) throw lockError(source);
          return await copyTree(source, target, budget);
        },
      );
      // An indexer holds the journal file itself for one attempt.
      const rm = fsp.rm.bind(fsp);
      const transactionsRoot = path.join(storeDir, 'transactions');
      let heldJournal = false;
      const rmSpy = vi
        .spyOn(fsp, 'rm')
        .mockImplementation(async (target, opts) => {
          const targetPath = String(target);
          if (!heldJournal && targetPath.startsWith(transactionsRoot)) {
            heldJournal = true;
            throw lockError(targetPath);
          }
          return await rm(target, opts);
        });

      try {
        const failure: unknown = await store
          .commitArtifact({
            operation: 'update',
            identity,
            stagingDirectory: staging,
            destinationDirectory: destination,
          })
          .catch((error: unknown) => error);

        // The rollback completed, so this is the swap failure and not a
        // "rollback recovery did not complete" aggregate.
        expect(failure).toBeInstanceOf(ExtensionDirectoryLockedError);
        expect(heldJournal).toBe(true);
        expect(await leftoverJournals()).toEqual([]);
        expect(await fsp.readdir(path.join(storeDir, 'rollback'))).toEqual([]);
        expect(
          await fsp.readFile(path.join(destination, 'version'), 'utf8'),
        ).toBe('one');
      } finally {
        rmSpy.mockRestore();
        vi.restoreAllMocks();
      }
    });

    // Every step of a swap that a descendant handle can defeat has to report the
    // extension directory, not a raw errno and not an internal rollback path.
    const heldSwapSteps: Array<{
      name: string;
      id: string;
      /** Whether the failed swap leaves nothing of its own behind. */
      residue: boolean;
      hold: (
        store: ExtensionStore,
        staging: string,
        destination: string,
      ) => void;
    }> = [
      {
        name: 'staged rename',
        id: 'c5',
        residue: true,
        // Rename mode: only the staging -> destination hop is held.
        hold: (_store, staging, destination) => {
          renameFault.inspect = (src, dest) =>
            src === staging && dest === destination
              ? lockError(src)
              : undefined;
        },
      },
      {
        name: 'half-copied backup cleanup',
        id: 'c6',
        residue: false,
        // The removal of the half-copied backup's `.partial` is held for good.
        hold: (_store, _staging, destination) => {
          renameFault.inspect = (src) =>
            src === destination ? lockError(src) : undefined;
          const rm = fsp.rm.bind(fsp);
          vi.spyOn(fsp, 'rm').mockImplementation(async (target, opts) => {
            if (String(target).endsWith('.partial'))
              throw lockError(String(target));
            return await rm(target, opts);
          });
        },
      },
      {
        name: 'backup copy',
        id: 'c7',
        residue: true,
        // A scanner holding one installed file makes the backup copy EBUSY, the
        // row the design measured for a handle that withholds delete sharing.
        hold: (store, _staging, destination) => {
          renameFault.inspect = (src) =>
            src === destination ? lockError(src) : undefined;
          const internals = store as unknown as {
            copyTree: (source: string) => Promise<void>;
          };
          vi.spyOn(internals, 'copyTree').mockImplementation(
            async (source: string) => {
              if (source === destination) {
                throw Object.assign(
                  new Error('EBUSY: resource busy or locked, copyfile'),
                  { code: 'EBUSY', path: source },
                );
              }
            },
          );
        },
      },
      {
        name: 'backup publish rename',
        id: 'c8',
        residue: true,
        // The copy is complete but the one rename that publishes it is held.
        hold: (_store, _staging, destination) => {
          renameFault.inspect = (src) =>
            src === destination || src.endsWith('.partial')
              ? lockError(src)
              : undefined;
        },
      },
    ];

    for (const step of heldSwapSteps) {
      it(`reports the locked directory when the ${step.name} is held`, async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const store = makeStore();
        const identity = { id: step.id.repeat(32), name: 'demo' };
        const destination = path.join(extensionsDir, 'demo');
        await store.ensureInitialized([identity]);
        await installDemo(store, identity, destination);
        const staging = await stageUpdate(store);
        step.hold(store, staging, destination);

        const failure: unknown = await store
          .commitArtifact({
            operation: 'update',
            identity,
            stagingDirectory: staging,
            destinationDirectory: destination,
          })
          .catch((error: unknown) => error);

        try {
          expect(failure).toBeInstanceOf(ExtensionDirectoryLockedError);
          expect((failure as Error).message).toContain(destination);
          expect((failure as Error).message).not.toContain(
            path.join('extension-store', 'rollback'),
          );
          expect(
            await fsp.readFile(path.join(destination, 'version'), 'utf8'),
          ).toBe('one');
          if (step.residue) {
            // A swap that never landed leaves nothing behind.
            expect(await fsp.readdir(path.join(storeDir, 'rollback'))).toEqual(
              [],
            );
            expect(await leftoverJournals()).toEqual([]);
          } else {
            // Nothing was copied yet, but the `.partial` removal keeps failing,
            // so the journal stays and owes only the cleanup a later operation
            // repeats.
            const [name] = await leftoverJournals();
            expect(name).toBeDefined();
            const journal = JSON.parse(
              await fsp.readFile(
                path.join(storeDir, 'transactions', name!),
                'utf8',
              ),
            ) as Record<string, unknown>;
            expect(journal).toMatchObject({ cleanupPending: true });
            expect(await fsp.readdir(path.join(storeDir, 'rollback'))).toEqual(
              [],
            );
          }
        } finally {
          vi.restoreAllMocks();
        }
      });
    }

    it('leaves the staged rename errno raw off Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const store = makeStore();
      const identity = { id: 'c9'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      const staging = await stageUpdate(store);
      // The hop the win32 rows report as locked keeps its raw errno off
      // Windows, where the hint would blame sessions that cannot fix a denial.
      renameFault.inspect = (src, dest) =>
        src === staging && dest === destination ? lockError(src) : undefined;

      const failure: unknown = await store
        .commitArtifact({
          operation: 'update',
          identity,
          stagingDirectory: staging,
          destinationDirectory: destination,
        })
        .catch((error: unknown) => error);

      expect(failure).not.toBeInstanceOf(ExtensionDirectoryLockedError);
      expect(failure).toMatchObject({ code: 'EPERM' });
      // The rename-mode rollback still put the installed tree back.
      expect(
        await fsp.readFile(path.join(destination, 'version'), 'utf8'),
      ).toBe('one');
    });

    it('retries a backup removal the holder released', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'd8'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      const rollbackRoot = path.join(storeDir, 'rollback');
      // An indexer holds one removal under the rollback area for one attempt
      // - whichever runs first, the teardown absorbs it inside the commit.
      const rm = fsp.rm.bind(fsp);
      let held = false;
      const rmSpy = vi
        .spyOn(fsp, 'rm')
        .mockImplementation(async (target, opts) => {
          const targetPath = String(target);
          if (!held && targetPath.startsWith(rollbackRoot)) {
            held = true;
            throw lockError(targetPath);
          }
          return await rm(target, opts);
        });

      try {
        await store.commitArtifact({
          operation: 'update',
          identity,
          stagingDirectory: await stageUpdate(store),
          destinationDirectory: destination,
        });
        expect(held).toBe(true);
      } finally {
        rmSpy.mockRestore();
      }

      // Absorbed inside the teardown: the commit is clean instead of leaving a
      // journal that owes a removal.
      expect(await leftoverJournals()).toEqual([]);
      expect(await fsp.readdir(rollbackRoot)).toEqual([]);
    });

    // Without the restore's own kind-conflict pass, `fsp.cp` refuses to put
    // a file back where the defeated apply left a directory, and the journal
    // re-fails on every later read with an errno nobody can act on.
    it('restores an entry whose kind the defeated apply copy changed', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'e7'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      // v1 ships docs as a file; the update would make it a directory.
      await fsp.writeFile(path.join(destination, 'docs'), 'one');
      const staging = await store.createStagingDirectory();
      await fsp.writeFile(path.join(staging, 'version'), 'two');
      await fsp.writeFile(
        path.join(staging, EXTENSIONS_CONFIG_FILENAME),
        '{"name":"demo"}',
      );
      await fsp.mkdir(path.join(staging, 'docs'), { recursive: true });
      await fsp.writeFile(path.join(staging, 'docs', 'page.md'), 'two');
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;
      const internals = store as unknown as {
        copyTree: (
          source: string,
          target: string,
          budget: unknown,
        ) => Promise<void>;
      };
      const copyTree = internals.copyTree.bind(store);
      vi.spyOn(internals, 'copyTree').mockImplementation(
        async (source: string, target: string, budget: unknown) => {
          if (source === staging) {
            // The apply dies right where the kind conflict now stands: the
            // file is gone and its directory replacement is half there.
            await fsp.rm(path.join(target, 'docs'), { force: true });
            await fsp.mkdir(path.join(target, 'docs'), { recursive: true });
            throw lockError(source);
          }
          return await copyTree(source, target, budget);
        },
      );

      try {
        await expect(
          store.commitArtifact({
            operation: 'update',
            identity,
            stagingDirectory: staging,
            destinationDirectory: destination,
          }),
        ).rejects.toBeInstanceOf(ExtensionDirectoryLockedError);
      } finally {
        vi.restoreAllMocks();
      }
      // The rollback put the file back over the half-made directory.
      expect((await fsp.stat(path.join(destination, 'docs'))).isFile()).toBe(
        true,
      );
      expect(await fsp.readFile(path.join(destination, 'docs'), 'utf8')).toBe(
        'one',
      );
      expect(await fsp.readdir(path.join(storeDir, 'rollback'))).toEqual([]);
      expect(await leftoverJournals()).toEqual([]);
    });

    it('waits a window before retrying a blocked rollback', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'd1'.repeat(32), name: 'demo' };
      const other = { id: 'd2'.repeat(32), name: 'other' };
      const destination = path.join(extensionsDir, 'demo');
      const otherDir = path.join(extensionsDir, 'other');
      await store.ensureInitialized([identity, other]);
      await installDemo(store, identity, destination);
      const otherStaging = await store.createStagingDirectory();
      await fsp.writeFile(path.join(otherStaging, 'version'), 'one');
      await fsp.writeFile(
        path.join(otherStaging, EXTENSIONS_CONFIG_FILENAME),
        '{"name":"other"}',
      );
      await store.commitArtifact({
        operation: 'install',
        identity: other,
        stagingDirectory: otherStaging,
        destinationDirectory: otherDir,
        initialActivation: { scope: 'user' },
      });
      const staging = await stageUpdate(store);
      const rollbackRoot = path.join(storeDir, 'rollback');
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;
      const internals = store as unknown as {
        copyTree: (
          source: string,
          target: string,
          budget: unknown,
        ) => Promise<void>;
      };
      const copyTree = internals.copyTree.bind(store);
      const restored: string[] = [];
      // The restore is held while the flag says so, so the case can also
      // watch the journal heal once the holder lets go.
      let holdRestore = true;
      vi.spyOn(internals, 'copyTree').mockImplementation(
        async (source: string, target: string, budget: unknown) => {
          if (source.startsWith(rollbackRoot)) restored.push(source);
          if (
            holdRestore &&
            (source.startsWith(rollbackRoot) || source === staging)
          ) {
            throw lockError(source);
          }
          return await copyTree(source, target, budget);
        },
      );

      try {
        const failure: unknown = await store
          .commitArtifact({
            operation: 'update',
            identity,
            stagingDirectory: staging,
            destinationDirectory: destination,
          })
          .catch((error: unknown) => error);

        // The rollback itself was defeated too, so the caller gets both.
        expect(failure).toBeInstanceOf(AggregateError);
        const attempted = restored.length;
        expect(attempted).toBeGreaterThan(0);

        const readJournal = async () => {
          const [name] = await leftoverJournals();
          return {
            journalPath: path.join(storeDir, 'transactions', name!),
            journal: JSON.parse(
              await fsp.readFile(
                path.join(storeDir, 'transactions', name!),
                'utf8',
              ),
            ) as { rollbackRetryAt?: number; rollbackBlocked?: boolean },
          };
        };
        // The first recovery attempt is what marks the journal, with a window...
        await store.readSnapshot();
        const marked = await readJournal();
        expect(marked.journal.rollbackBlocked).toBe(true);
        expect(marked.journal.rollbackRetryAt!).toBeGreaterThan(Date.now());
        // ...and reads inside the window leave the tree alone, so a permanently
        // held directory cannot make every read re-copy it under the store lock.
        const settled = restored.length;
        await store.readSnapshot();
        await store.readSnapshot();
        expect(restored).toHaveLength(settled);
        // Once the window passes recovery tries again, so the destination is not
        // wedged after the holder lets go.
        await expireJournalWindow(marked.journalPath);
        await store.readSnapshot();
        expect(restored.length).toBeGreaterThan(settled);

        // A marked journal with no window at all - the shape left by a build
        // that predates rollbackRetryAt - is treated as due, never as skipped
        // forever: absent means now.
        const reMarked = await readJournal();
        const legacy = { ...reMarked.journal } as Record<string, unknown>;
        delete legacy['rollbackRetryAt'];
        await fsp.writeFile(reMarked.journalPath, JSON.stringify(legacy));
        const beforeLegacy = restored.length;
        await store.readSnapshot();
        expect(restored.length).toBeGreaterThan(beforeLegacy);
        expect((await readJournal()).journal.rollbackRetryAt!).toBeGreaterThan(
          Date.now(),
        );

        // A deadline further out than any window this code writes is a moved
        // clock, not a live window: the retry must come due, not wedge.
        const skewed = await readJournal();
        await fsp.writeFile(
          skewed.journalPath,
          JSON.stringify({
            ...skewed.journal,
            rollbackRetryAt: Date.now() + 10 * 60 * 1000,
          }),
        );
        const beforeSkew = restored.length;
        await store.readSnapshot();
        expect(restored.length).toBeGreaterThan(beforeSkew);
        const reMarkedAfterClamp = await readJournal();
        expect(
          reMarkedAfterClamp.journal.rollbackRetryAt! - Date.now(),
        ).toBeLessThanOrEqual(6000);

        // The destination still refuses a new transaction with the actionable
        // text, and only that destination: another extension is unaffected.
        await expect(
          store.commitArtifact({
            operation: 'update',
            identity,
            stagingDirectory: await stageUpdate(store),
            destinationDirectory: destination,
          }),
        ).rejects.toBeInstanceOf(ExtensionDirectoryLockedError);
        const otherUpdate = await store.createStagingDirectory();
        await fsp.writeFile(path.join(otherUpdate, 'version'), 'two');
        await fsp.writeFile(
          path.join(otherUpdate, EXTENSIONS_CONFIG_FILENAME),
          '{"name":"other"}',
        );
        await store.commitArtifact({
          operation: 'update',
          identity: other,
          stagingDirectory: otherUpdate,
          destinationDirectory: otherDir,
        });
        expect(await fsp.readFile(path.join(otherDir, 'version'), 'utf8')).toBe(
          'two',
        );

        // With the holder gone, a plain read still defers inside the window,
        // but a mutation of this destination forces its own retry: the
        // restore lands, the journal and backup clear, and commits resume -
        // self-heal, not a wedge until expiry.
        holdRestore = false;
        await store.readSnapshot();
        expect(await leftoverJournals()).toHaveLength(1);
        await store.commitArtifact({
          operation: 'update',
          identity,
          stagingDirectory: await stageUpdate(store),
          destinationDirectory: destination,
        });
        expect(await leftoverJournals()).toEqual([]);
        expect(await fsp.readdir(rollbackRoot)).toEqual([]);
        expect(
          await fsp.readFile(path.join(destination, 'version'), 'utf8'),
        ).toBe('two');
      } finally {
        vi.restoreAllMocks();
      }
    });

    // Stacked journals for one destination: replay order decides which
    // backup the tree ends on, and the key must be one a pass cannot move -
    // marking a journal rewrites its mtime.
    const plantStackedPair = async (store: ExtensionStore) => {
      const identity = { id: 'da'.repeat(32), name: 'demo' };
      const snapshot = await targetSnapshotFor(store, identity);
      const destination = path.join(extensionsDir, 'demo');
      await fsp.mkdir(destination, { recursive: true });
      await fsp.writeFile(
        path.join(destination, EXTENSIONS_CONFIG_FILENAME),
        '{"name":"demo"}',
      );
      await fsp.writeFile(path.join(destination, 'version'), 'three');
      // T2 stacks on T1, so its backup holds the post-T1 tree. T1 is planted
      // last and ends up the newest by mtime.
      // The on-disk snapshot sits at generation 1 after initialization, so
      // the stacked pair spans generations 1->2 and 2->3.
      await plantJournal(
        {
          transactionId: 'stack-t2',
          operation: 'update',
          phase: 'prepared',
          destinationDirectory: destination,
          stagingDirectory: path.join(storeDir, 'staging', 'stack-t2'),
          backupDirectory: path.join(storeDir, 'rollback', 'stack-t2'),
          swapStrategy: 'copy',
          previousGeneration: 2,
          targetGeneration: 3,
          targetSnapshot: { ...snapshot, generation: 3 },
        },
        { [EXTENSIONS_CONFIG_FILENAME]: '{"name":"demo"}', version: 'two' },
      );
      await plantJournal(
        {
          transactionId: 'stack-t1',
          operation: 'update',
          phase: 'prepared',
          destinationDirectory: destination,
          stagingDirectory: path.join(storeDir, 'staging', 'stack-t1'),
          backupDirectory: path.join(storeDir, 'rollback', 'stack-t1'),
          swapStrategy: 'copy',
          previousGeneration: 1,
          targetGeneration: 2,
          targetSnapshot: { ...snapshot, generation: 2 },
        },
        { [EXTENSIONS_CONFIG_FILENAME]: '{"name":"demo"}', version: 'one' },
      );
      return { identity, destination, snapshot };
    };

    const holdStackedRestores = (
      store: ExtensionStore,
      rollbackRoot: string,
      staging: () => string | undefined,
    ) => {
      const internals = store as unknown as {
        copyTree: (
          source: string,
          target: string,
          budget: unknown,
        ) => Promise<void>;
      };
      const copyTree = internals.copyTree.bind(store);
      const state = { holdRestore: true, holdApply: false };
      vi.spyOn(internals, 'copyTree').mockImplementation(
        async (source: string, target: string, budget: unknown) => {
          if (state.holdRestore && source.startsWith(rollbackRoot)) {
            throw lockError(source);
          }
          if (state.holdApply && source === staging()) {
            throw lockError(source);
          }
          return await copyTree(source, target, budget);
        },
      );
      return state;
    };

    it('replays stacked journals newest-first through recovery and the guard', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const { identity, destination } = await plantStackedPair(store);
      const rollbackRoot = path.join(storeDir, 'rollback');
      let stagingDir: string | undefined;
      const state = holdStackedRestores(store, rollbackRoot, () => stagingDir);
      try {
        // Pass 1 defeats both rollbacks and marks both journals - the last
        // mark moves its journal to the front of any mtime-ordered replay.
        await store.readSnapshot();
        expect((await leftoverJournals()).sort()).toEqual([
          'stack-t1.json',
          'stack-t2.json',
        ]);

        // Guard path: the forced retry follows recovery's newest-first
        // order, not bare readdir. With the holder gone the commit unwinds
        // T2 then T1, and only its own defeated apply fails.
        state.holdRestore = false;
        stagingDir = await stageUpdate(store);
        state.holdApply = true;
        renameFault.inspect = (src) =>
          src === destination ? lockError(src) : undefined;
        await expect(
          store.commitArtifact({
            operation: 'update',
            identity,
            stagingDirectory: stagingDir,
            destinationDirectory: destination,
          }),
        ).rejects.toBeInstanceOf(ExtensionDirectoryLockedError);
        expect(await leftoverJournals()).toEqual([]);
        expect(await fsp.readdir(rollbackRoot)).toEqual([]);
        expect(
          await fsp.readFile(path.join(destination, 'version'), 'utf8'),
        ).toBe('one');

        // Recovery path: a fresh stack, marked by a pass that left T1 the
        // newest mtime, must still unwind T2 before T1 once due - even with
        // a pending journal for a second destination interleaved between
        // them. A comparator that switches keys on destination equality is
        // not a valid ordering, and V8 then emits the pair oldest-first for
        // some readdir orders, so pin one such order for the witness.
        state.holdApply = false;
        state.holdRestore = true;
        const { snapshot } = await plantStackedPair(store);
        const otherDir = path.join(extensionsDir, 'other');
        await fsp.mkdir(otherDir, { recursive: true });
        await fsp.writeFile(
          path.join(otherDir, EXTENSIONS_CONFIG_FILENAME),
          '{"name":"other"}',
        );
        await fsp.writeFile(path.join(otherDir, 'version'), 'b-old');
        await plantJournal(
          {
            transactionId: 'stack-o',
            operation: 'update',
            phase: 'prepared',
            destinationDirectory: otherDir,
            stagingDirectory: path.join(storeDir, 'staging', 'stack-o'),
            backupDirectory: path.join(storeDir, 'rollback', 'stack-o'),
            swapStrategy: 'copy',
            previousGeneration: 3,
            targetGeneration: 4,
            targetSnapshot: { ...snapshot, generation: 4 },
          },
          {
            [EXTENSIONS_CONFIG_FILENAME]: '{"name":"other"}',
            version: 'b-old',
          },
        );
        await store.readSnapshot();
        // Expire oldest-first so the rewrites leave T1 the newest mtime.
        await expireJournalWindow(
          path.join(storeDir, 'transactions', 'stack-t2.json'),
          path.join(storeDir, 'transactions', 'stack-o.json'),
          path.join(storeDir, 'transactions', 'stack-t1.json'),
        );
        state.holdRestore = false;
        const readdir = fsp.readdir.bind(fsp);
        const transactionsRoot = path.join(storeDir, 'transactions');
        const readdirSpy = vi
          .spyOn(fsp, 'readdir')
          .mockImplementation(async (dir, opts) =>
            String(dir) === transactionsRoot
              ? (['stack-t1.json', 'stack-o.json', 'stack-t2.json'] as never)
              : (readdir(
                  dir as Parameters<typeof readdir>[0],
                  opts as Parameters<typeof readdir>[1],
                ) as unknown as never),
          );
        try {
          await store.readSnapshot();
        } finally {
          readdirSpy.mockRestore();
        }
        expect(await leftoverJournals()).toEqual([]);
        expect(await fsp.readdir(rollbackRoot)).toEqual([]);
        expect(
          await fsp.readFile(path.join(destination, 'version'), 'utf8'),
        ).toBe('one');
        expect(await fsp.readFile(path.join(otherDir, 'version'), 'utf8')).toBe(
          'b-old',
        );

        // Older journal of a deferred destination must not apply: hold only T2's
        // restore, T1 stays marked but untouched and its backup survives.
        await plantStackedPair(store);
        const internals2 = store as unknown as {
          copyTree: (
            source: string,
            target: string,
            budget: unknown,
          ) => Promise<void>;
        };
        const copyTree2 = internals2.copyTree.bind(store);
        const rollbackRoot2 = path.join(storeDir, 'rollback');
        vi.spyOn(internals2, 'copyTree').mockImplementation(
          async (source: string, target: string, budget: unknown) => {
            if (source === path.join(rollbackRoot2, 'stack-t2')) {
              throw lockError(source);
            }
            return await copyTree2(source, target, budget);
          },
        );
        await store.readSnapshot();
        expect((await leftoverJournals()).sort()).toEqual([
          'stack-t1.json',
          'stack-t2.json',
        ]);
        expect(
          await fsp.stat(path.join(rollbackRoot2, 'stack-t1')),
        ).toBeDefined();
        expect(
          await fsp.readFile(path.join(destination, 'version'), 'utf8'),
        ).toBe('three');
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('keeps an owed journal whose restore fails for a non-lock reason and heals it once the fault clears', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const { destination } = await plantStackedPair(store);
      const rollbackRoot = path.join(storeDir, 'rollback');
      const internals = store as unknown as {
        copyTree: (
          source: string,
          target: string,
          budget: unknown,
        ) => Promise<void>;
      };
      const copyTree = internals.copyTree.bind(store);
      let restoreAttempts = 0;
      const fault = vi
        .spyOn(internals, 'copyTree')
        .mockImplementation(
          async (source: string, target: string, budget: unknown) => {
            if (source === path.join(rollbackRoot, 'stack-t2')) {
              restoreAttempts += 1;
              const error = new Error('ENOENT') as NodeJS.ErrnoException;
              error.code = 'ENOENT';
              error.path = source;
              throw error;
            }
            return await copyTree(source, target, budget);
          },
        );
      // The caller sees the raw errno, and the journal keeps its name: a failed
      // attempt says nothing about the file, so the owed journal and the
      // residue only it can reach stay where they are.
      const first: unknown = await store
        .readSnapshot()
        .catch((error: unknown) => error);
      expect((first as NodeJS.ErrnoException).code).toBe('ENOENT');
      expect((await leftoverJournals()).sort()).toEqual([
        'stack-t1.json',
        'stack-t2.json',
      ]);
      expect(await fsp.stat(path.join(rollbackRoot, 'stack-t2'))).toBeDefined();

      // A later caller does not repeat the failing restore - the owed step
      // waits out one window - and is refused meanwhile: nothing was restored,
      // so the destination is not the artifact the snapshot names.
      await expect(store.readSnapshot()).rejects.toBeInstanceOf(
        ExtensionConflictError,
      );
      expect(restoreAttempts).toBe(1);

      // Clearing the fault is all a later pass needs to finish the unwind and
      // reclaim the residue.
      fault.mockRestore();
      await expireJournalWindow(
        path.join(storeDir, 'transactions', 'stack-t1.json'),
        path.join(storeDir, 'transactions', 'stack-t2.json'),
      );
      await store.readSnapshot();
      expect(await leftoverJournals()).toEqual([]);
      expect(await fsp.readdir(rollbackRoot)).toEqual([]);
      expect(
        await fsp.readFile(path.join(destination, 'version'), 'utf8'),
      ).toBe('one');
    });

    it('throws when the marker write fails for an older sibling of a deferred journal', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const { destination } = await plantStackedPair(store);
      const rollbackRoot = path.join(storeDir, 'rollback');
      const internals = store as unknown as {
        copyTree: (
          source: string,
          target: string,
          budget: unknown,
        ) => Promise<void>;
      };
      const copyTree = internals.copyTree.bind(store);
      vi.spyOn(internals, 'copyTree').mockImplementation(
        async (source: string, target: string, budget: unknown) => {
          if (source === path.join(rollbackRoot, 'stack-t2')) {
            throw lockError(source);
          }
          return await copyTree(source, target, budget);
        },
      );
      atomicWriteFault.inspect = (target) =>
        target.endsWith('stack-t1.json') ? lockError(target) : undefined;
      try {
        const thrown = await store
          .readSnapshot()
          .catch((error: unknown) => error);
        expect((thrown as NodeJS.ErrnoException).code).toBe('EPERM');
        const t2 = JSON.parse(
          await fsp.readFile(
            path.join(storeDir, 'transactions', 'stack-t2.json'),
            'utf8',
          ),
        );
        expect(t2.rollbackBlocked).toBe(true);
        const t1 = JSON.parse(
          await fsp.readFile(
            path.join(storeDir, 'transactions', 'stack-t1.json'),
            'utf8',
          ),
        );
        expect(t1.rollbackBlocked).toBeUndefined();
        expect(
          await fsp.stat(path.join(rollbackRoot, 'stack-t1')),
        ).toBeDefined();
        expect(
          await fsp.readFile(path.join(destination, 'version'), 'utf8'),
        ).toBe('three');
      } finally {
        atomicWriteFault.inspect = undefined;
        vi.restoreAllMocks();
      }
    });

    it('does not promote an older sibling when the newer journal cannot retry', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const { destination } = await plantStackedPair(store);
      // Drop a backup entry so canRetryRollback answers false for T2.
      await fsp.unlink(path.join(destination, EXTENSIONS_CONFIG_FILENAME));
      const rollbackRoot = path.join(storeDir, 'rollback');
      const internals = store as unknown as {
        copyTree: (
          source: string,
          target: string,
          budget: unknown,
        ) => Promise<void>;
      };
      const copyTree = internals.copyTree.bind(store);
      vi.spyOn(internals, 'copyTree').mockImplementation(
        async (source: string, target: string, budget: unknown) => {
          if (source === path.join(rollbackRoot, 'stack-t2')) {
            throw lockError(source);
          }
          return await copyTree(source, target, budget);
        },
      );
      try {
        const thrown = await store
          .readSnapshot()
          .catch((error: unknown) => error);
        expect(thrown).toBeInstanceOf(ExtensionDirectoryLockedError);
        expect(await leftoverJournals()).toEqual([
          'stack-t1.json',
          'stack-t2.json',
        ]);
        expect(
          await fsp.stat(path.join(rollbackRoot, 'stack-t1')),
        ).toBeDefined();
        expect(
          await fsp.stat(path.join(rollbackRoot, 'stack-t2')),
        ).toBeDefined();
        expect(
          await fsp.readFile(path.join(destination, 'version'), 'utf8'),
        ).toBe('three');
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('keeps a rollback-completed journal when only teardown fails', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const { destination } = await plantStackedPair(store);
      const rollbackRoot = path.join(storeDir, 'rollback');
      const internals = store as unknown as {
        removeTransactionTeardown: (
          journal: unknown,
          journalPath: string,
          budget: unknown,
        ) => Promise<void>;
      };
      vi.spyOn(internals, 'removeTransactionTeardown').mockImplementation(
        async () => {
          const error = new Error('EIO') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        },
      );
      try {
        const thrown = await store
          .readSnapshot()
          .catch((error: unknown) => error);
        expect((thrown as NodeJS.ErrnoException).code).toBe('EIO');
        const t2 = JSON.parse(
          await fsp.readFile(
            path.join(storeDir, 'transactions', 'stack-t2.json'),
            'utf8',
          ),
        );
        expect(t2.cleanupPending).toBe(true);
        expect(t2.phase).toBe('prepared');
        const t1 = JSON.parse(
          await fsp.readFile(
            path.join(storeDir, 'transactions', 'stack-t1.json'),
            'utf8',
          ),
        );
        expect(t1.cleanupPending).toBeUndefined();
        expect(await leftoverJournals()).toEqual([
          'stack-t1.json',
          'stack-t2.json',
        ]);
        expect(
          await fsp.stat(path.join(rollbackRoot, 'stack-t2')),
        ).toBeDefined();
        expect(
          await fsp.readFile(path.join(destination, 'version'), 'utf8'),
        ).toBe('two');
        vi.restoreAllMocks();
        await store.readSnapshot();
        expect(await leftoverJournals()).toEqual([]);
        expect(await fsp.readdir(rollbackRoot)).toEqual([]);
        expect(
          await fsp.readFile(path.join(destination, 'version'), 'utf8'),
        ).toBe('one');
      } finally {
        vi.restoreAllMocks();
      }
    });

    // The gate's question is the backup comparison, not the manifest name:
    // a half-wiped uninstall keeps a manifest standing beside a deleted
    // payload, and a plugin or link root loads fine carrying neither name.
    const gateStates: Array<{
      label: string;
      id: string;
      operation: 'update' | 'uninstall';
      destinationFiles: Record<string, string>;
      destinationDirs?: string[];
      backupFiles: Record<string, string>;
      absorbs: boolean;
      /** A journal already marked inside its window is judged without
       *  touching the tree - the only route that sees the state as it is. */
      premarkedWithinWindow?: boolean;
    }> = [
      {
        label: 'a tree the held restore already made identical',
        id: 'e1',
        operation: 'update',
        destinationFiles: {
          [EXTENSIONS_CONFIG_FILENAME]: '{"name":"demo"}',
          version: 'one',
        },
        backupFiles: {
          [EXTENSIONS_CONFIG_FILENAME]: '{"name":"demo"}',
          version: 'one',
        },
        absorbs: true,
      },
      {
        label: 'an unconverted plugin.json root',
        id: 'e2',
        operation: 'update',
        destinationFiles: { [AGENT_PLUGIN_MANIFEST]: '{"name":"demo"}' },
        backupFiles: { [AGENT_PLUGIN_MANIFEST]: '{"name":"demo"}' },
        absorbs: true,
      },
      {
        label: "a link install's metadata-only root",
        id: 'e3',
        operation: 'uninstall',
        destinationFiles: {
          [INSTALL_METADATA_FILENAME]: '{"type":"link","source":"../src"}',
        },
        backupFiles: {
          [INSTALL_METADATA_FILENAME]: '{"type":"link","source":"../src"}',
        },
        absorbs: true,
      },
      {
        label: 'a half-wiped uninstall whose manifest survived',
        id: 'e4',
        operation: 'uninstall',
        destinationFiles: { [EXTENSIONS_CONFIG_FILENAME]: '{"name":"demo"}' },
        backupFiles: {
          [EXTENSIONS_CONFIG_FILENAME]: '{"name":"demo"}',
          'readme.md': 'one',
        },
        absorbs: false,
      },
      {
        label: 'an entry whose kind the restore did not finish',
        id: 'e5',
        operation: 'update',
        destinationFiles: {
          [EXTENSIONS_CONFIG_FILENAME]: '{"name":"demo"}',
        },
        destinationDirs: ['docs'],
        backupFiles: {
          [EXTENSIONS_CONFIG_FILENAME]: '{"name":"demo"}',
          docs: 'file, not directory',
        },
        absorbs: false,
      },
      {
        label: 'a restore the prune could not finish taking away',
        id: 'e7',
        operation: 'update',
        // The update added a file; the restore put every old entry back and
        // only the prune of this extra one is held. The tree is loadable.
        destinationFiles: {
          [EXTENSIONS_CONFIG_FILENAME]: '{"name":"demo"}',
          version: 'one',
          'added.md': 'two, still standing',
        },
        backupFiles: {
          [EXTENSIONS_CONFIG_FILENAME]: '{"name":"demo"}',
          version: 'one',
        },
        absorbs: true,
      },
      {
        label: 'a marked journal whose entry changed kind inside the window',
        id: 'e6',
        operation: 'update',
        destinationFiles: {
          [EXTENSIONS_CONFIG_FILENAME]: '{"name":"demo"}',
        },
        destinationDirs: ['docs'],
        backupFiles: {
          [EXTENSIONS_CONFIG_FILENAME]: '{"name":"demo"}',
          docs: 'file, not directory',
        },
        absorbs: false,
        premarkedWithinWindow: true,
      },
    ];

    for (const state of gateStates) {
      it(`decides the blocked-rollback retry on ${state.label}`, async () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const store = makeStore();
        const identity = { id: state.id.repeat(32), name: 'demo' };
        const targetSnapshot = await targetSnapshotFor(store, identity);
        const destination = path.join(extensionsDir, 'demo');
        const transactionId = `gate-${state.id}`;
        const backupDirectory = path.join(storeDir, 'rollback', transactionId);
        await fsp.mkdir(destination, { recursive: true });
        for (const [name, content] of Object.entries(state.destinationFiles)) {
          await fsp.writeFile(path.join(destination, name), content);
        }
        for (const name of state.destinationDirs ?? []) {
          await fsp.mkdir(path.join(destination, name), { recursive: true });
        }
        await plantJournal(
          {
            transactionId,
            operation: state.operation,
            phase: 'prepared',
            destinationDirectory: destination,
            ...(state.operation === 'uninstall'
              ? {}
              : {
                  stagingDirectory: path.join(
                    storeDir,
                    'staging',
                    transactionId,
                  ),
                }),
            backupDirectory,
            swapStrategy: 'copy',
            ...(state.premarkedWithinWindow
              ? {
                  rollbackBlocked: true,
                  rollbackRetryAt: Date.now() + 3000,
                }
              : {}),
            previousGeneration: 0,
            targetGeneration: 1,
            targetSnapshot,
          },
          state.backupFiles,
        );
        const rollbackRoot = path.join(storeDir, 'rollback');
        const internals = store as unknown as {
          copyTree: (
            source: string,
            target: string,
            budget: unknown,
          ) => Promise<void>;
        };
        const copyTree = internals.copyTree.bind(store);
        // The restore is held either way, so only the gate can tell an
        // artifact that is already whole from one still missing content.
        vi.spyOn(internals, 'copyTree').mockImplementation(
          async (source: string, target: string, budget: unknown) => {
            if (source.startsWith(rollbackRoot)) throw lockError(source);
            return await copyTree(source, target, budget);
          },
        );

        const read: unknown = await store
          .readSnapshot()
          .catch((error: unknown) => error);
        vi.restoreAllMocks();
        if (state.absorbs) {
          // A thrown error is defined too - assert the resolved snapshot.
          expect(read).toMatchObject({ generation: expect.any(Number) });
        } else {
          expect(read).toBeInstanceOf(ExtensionDirectoryLockedError);
        }
        // Either way the attempt got its mark and window, and the journal
        // keeps owning the backup until a retry can finish the restore.
        expect(await leftoverJournals()).toEqual([`${transactionId}.json`]);
        const journal = JSON.parse(
          await fsp.readFile(
            path.join(storeDir, 'transactions', `${transactionId}.json`),
            'utf8',
          ),
        ) as { rollbackBlocked?: boolean; rollbackRetryAt?: number };
        expect(journal.rollbackBlocked).toBe(true);
        expect(journal.rollbackRetryAt!).toBeGreaterThan(Date.now());
      });
    }

    it('spends one retry allowance per recovery pass', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'd3'.repeat(32), name: 'demo' };
      const targetSnapshot = await targetSnapshotFor(store, identity);
      const destination = path.join(extensionsDir, 'demo');
      await fsp.mkdir(destination, { recursive: true });
      await fsp.writeFile(path.join(destination, 'version'), 'torn');
      await fsp.writeFile(
        path.join(destination, EXTENSIONS_CONFIG_FILENAME),
        '{"name":"demo"}',
      );
      // Stacked transactions for one destination, more of them than one
      // allowance can cover, so a per-journal allowance would show up as
      // attempts the pass should not have spent.
      const transactionIds = ['pass-1', 'pass-2', 'pass-3', 'pass-4', 'pass-5'];
      for (const transactionId of transactionIds) {
        await plantJournal(
          {
            transactionId,
            operation: 'update',
            phase: 'prepared',
            destinationDirectory: destination,
            stagingDirectory: path.join(storeDir, 'staging', transactionId),
            backupDirectory: path.join(storeDir, 'rollback', transactionId),
            swapStrategy: 'copy',
            previousGeneration: 0,
            targetGeneration: 1,
            targetSnapshot,
          },
          { version: 'old', [EXTENSIONS_CONFIG_FILENAME]: '{}' },
        );
      }
      const internals = store as unknown as {
        copyTree: (
          source: string,
          target: string,
          budget: unknown,
        ) => Promise<void>;
        retryLock: (
          step: () => Promise<unknown>,
          budget: { remainingMs: number },
        ) => Promise<unknown>;
      };
      const budgets = new Set<{ remainingMs: number }>();
      const retryLock = internals.retryLock.bind(store);
      vi.spyOn(internals, 'retryLock').mockImplementation(
        async (step, budget) => {
          budgets.add(budget);
          return await retryLock(step, budget);
        },
      );
      const rollbackRoot = path.join(storeDir, 'rollback');
      // The fault is on the primitive, not on the method wrapping it, so the
      // retries really run and draw on the pass's allowance.
      let copies = 0;
      vi.spyOn(fsp, 'cp').mockImplementation(async () => {
        copies += 1;
        throw lockError(rollbackRoot);
      });

      try {
        await store.readSnapshot();
      } finally {
        vi.restoreAllMocks();
      }

      // One allowance for the pass, not one per journal it replays: the retries
      // stop when it is spent, while every journal is still reached and marked.
      expect(budgets.size).toBe(1);
      expect(copies).toBeLessThan(4 * transactionIds.length);
      const marked = await Promise.all(
        transactionIds.map(async (transactionId) =>
          JSON.parse(
            await fsp.readFile(
              path.join(storeDir, 'transactions', `${transactionId}.json`),
              'utf8',
            ),
          ),
        ),
      );
      expect(marked).toHaveLength(transactionIds.length);
      for (const journal of marked) {
        expect(journal).toMatchObject({ rollbackBlocked: true });
      }
    });

    it('refuses a second transaction for a journal it could not mark', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'd4'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;
      const internals = store as unknown as {
        copyTree: (
          source: string,
          target: string,
          budget: unknown,
        ) => Promise<void>;
        recordPendingStep: (
          journal: unknown,
          journalPath: string,
          step: string,
          error: unknown,
        ) => Promise<boolean>;
      };
      // A marker that cannot land must never read as absorbed: a later pass
      // would treat the unmarked journal as settled once generation advanced.
      vi.spyOn(internals, 'recordPendingStep').mockResolvedValue(false);
      const copyTree = internals.copyTree.bind(store);
      const staging = await stageUpdate(store);
      const rollbackRoot = path.join(storeDir, 'rollback');
      // The swap fails and so does the rollback that would undo it.
      vi.spyOn(internals, 'copyTree').mockImplementation(
        async (source: string, target: string, budget: unknown) => {
          if (source.startsWith(rollbackRoot) || source === staging) {
            throw lockError(source);
          }
          return await copyTree(source, target, budget);
        },
      );

      try {
        await store
          .commitArtifact({
            operation: 'update',
            identity,
            stagingDirectory: staging,
            destinationDirectory: destination,
          })
          .catch(() => undefined);
        expect(await leftoverJournals()).toHaveLength(1);
        // Recovery runs first and refuses to give up on the unmarkable
        // journal: staying loud is what keeps the backup alive.
        await expect(
          store.commitArtifact({
            operation: 'update',
            identity,
            stagingDirectory: await stageUpdate(store),
            destinationDirectory: destination,
          }),
        ).rejects.toMatchObject({ code: 'EPERM' });
        await expect(
          store.setWorkspaceActivations(
            [{ id: 'd4'.repeat(32), name: 'demo' }],
            root,
            'disabled',
          ),
        ).rejects.toMatchObject({ code: 'EPERM' });
        await expect(store.readSnapshot()).rejects.toMatchObject({
          code: 'EPERM',
        });
        // The backup survives precisely because no pass may absorb what it
        // cannot mark.
        expect((await fsp.readdir(rollbackRoot)).length).toBeGreaterThan(0);
        const [name] = await leftoverJournals();
        const journal = JSON.parse(
          await fsp.readFile(
            path.join(storeDir, 'transactions', name!),
            'utf8',
          ),
        ) as Record<string, unknown>;
        expect(journal['rollbackBlocked']).toBeUndefined();
        expect(journal['cleanupPending']).toBeUndefined();
        expect(
          await fsp.readFile(path.join(destination, 'version'), 'utf8'),
        ).toBe('one');
      } finally {
        vi.restoreAllMocks();
      }
    });

    // Demote-before-delete is what makes an unmarkable cleanup safe to
    // replay: a later pass finds no backup under its own name and leaves the
    // live tree alone instead of pruning it against the gutted one.
    it('never restores from a backup its cleanup already half-deleted', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'cb'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      const staging = await stageUpdate(store);
      const rollbackRoot = path.join(storeDir, 'rollback');
      const transactionsRoot = path.join(storeDir, 'transactions');
      // Once the rollback is underway the marker write fails too: nothing can
      // record the journal as deferred, so every pass must stay loud.
      let markerFault = false;
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;
      atomicWriteFault.inspect = (target) =>
        markerFault && target.startsWith(transactionsRoot)
          ? lockError(target)
          : undefined;
      const internals = store as unknown as {
        copyTree: (
          source: string,
          target: string,
          budget: unknown,
        ) => Promise<void>;
      };
      const copyTree = internals.copyTree.bind(store);
      vi.spyOn(internals, 'copyTree').mockImplementation(
        async (source: string, target: string, budget: unknown) => {
          if (source === staging) {
            markerFault = true;
            throw lockError(source);
          }
          return await copyTree(source, target, budget);
        },
      );
      // The backup's removal - under whichever name the teardown reaches it
      // - dies after taking one child with it, and every later removal of a
      // rollback or journal path is held for good.
      const rm = fsp.rm.bind(fsp);
      let maimed = false;
      const rmSpy = vi
        .spyOn(fsp, 'rm')
        .mockImplementation(async (target, opts) => {
          const targetPath = String(target);
          if (
            !maimed &&
            targetPath.startsWith(rollbackRoot) &&
            fs.existsSync(targetPath)
          ) {
            maimed = true;
            await rm(path.join(targetPath, 'skills'), {
              recursive: true,
              force: true,
            });
            throw lockError(targetPath);
          }
          if (
            maimed &&
            (targetPath.startsWith(rollbackRoot) ||
              targetPath.startsWith(transactionsRoot))
          ) {
            throw lockError(targetPath);
          }
          return await rm(target, opts);
        });

      try {
        const failure: unknown = await store
          .commitArtifact({
            operation: 'update',
            identity,
            stagingDirectory: staging,
            destinationDirectory: destination,
          })
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        const replay: unknown = await store
          .readSnapshot()
          .catch((error: unknown) => error);
        expect(replay).toMatchObject({ code: 'EPERM' });
        // The replayed pass found no backup to restore from, so it never
        // pruned the live tree against the gutted one.
        expect(
          await fsp.readFile(
            path.join(destination, 'skills', 'keep.md'),
            'utf8',
          ),
        ).toBe('one');
      } finally {
        rmSpy.mockRestore();
        vi.restoreAllMocks();
      }
      await expect(store.readSnapshot()).resolves.toBeDefined();
      expect(await leftoverJournals()).toEqual([]);
      expect(await fsp.readdir(rollbackRoot)).toEqual([]);
    });

    it('unlinks a nested junction the new version does not carry', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'd5'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      // A heavy subtree relocated off the extensions root, as an installer or
      // a user would do; the prune must unlink the junction, not walk it.
      const relocated = path.join(root, 'relocated-subtree');
      await fsp.mkdir(relocated, { recursive: true });
      await fsp.writeFile(path.join(relocated, 'canary.txt'), 'user data');
      await fsp.symlink(
        relocated,
        path.join(destination, 'nested'),
        'junction',
      );
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;

      await store.commitArtifact({
        operation: 'update',
        identity,
        stagingDirectory: await stageUpdate(store),
        destinationDirectory: destination,
      });

      expect(fs.existsSync(path.join(destination, 'nested'))).toBe(false);
      expect(
        await fsp.readFile(path.join(relocated, 'canary.txt'), 'utf8'),
      ).toBe('user data');
    });

    it('restores a junctioned destination without writing through it', async () => {
      const store = makeStore();
      const identity = { id: 'd6'.repeat(32), name: 'demo' };
      const targetSnapshot = await targetSnapshotFor(store, identity);
      const transactionId = 'junctioned-restore';
      const destination = path.join(extensionsDir, 'demo');
      // The destination became a junction after the journal was written: the
      // restore has to replace the link, not copy through it.
      const relocated = path.join(root, 'relocated-live');
      await fsp.mkdir(relocated, { recursive: true });
      await fsp.writeFile(path.join(relocated, 'canary.txt'), 'user data');
      await fsp.symlink(relocated, destination, 'junction');
      await plantJournal(
        {
          transactionId,
          operation: 'update',
          phase: 'prepared',
          destinationDirectory: destination,
          stagingDirectory: path.join(storeDir, 'staging', transactionId),
          backupDirectory: path.join(storeDir, 'rollback', transactionId),
          swapStrategy: 'copy',
          previousGeneration: 0,
          targetGeneration: 1,
          targetSnapshot,
        },
        { version: 'old', [EXTENSIONS_CONFIG_FILENAME]: '{}' },
      );

      await store.readSnapshot();

      const restoredRoot = await fsp.lstat(destination);
      expect(restoredRoot.isDirectory()).toBe(true);
      expect(
        await fsp.readFile(path.join(destination, 'version'), 'utf8'),
      ).toBe('old');
      expect(
        await fsp.readFile(path.join(relocated, 'canary.txt'), 'utf8'),
      ).toBe('user data');
      expect(await leftoverJournals()).toEqual([]);
    });

    it('raises the locked directory error when the destination root cannot be removed', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const store = makeStore();
      const identity = { id: 'd7'.repeat(32), name: 'demo' };
      const destination = path.join(extensionsDir, 'demo');
      await store.ensureInitialized([identity]);
      await installDemo(store, identity, destination);
      renameFault.inspect = (src) =>
        src === destination ? lockError(src) : undefined;
      // A child process with its working directory on the extension reports
      // EBUSY for good, so this is the case the actionable text exists for.
      const rm = fsp.rm.bind(fsp);
      const rmSpy = vi
        .spyOn(fsp, 'rm')
        .mockImplementation(async (target, opts) => {
          if (String(target) === destination) {
            throw Object.assign(
              new Error('EBUSY: resource busy or locked, rmdir'),
              { code: 'EBUSY', path: destination },
            );
          }
          return await rm(target, opts);
        });

      try {
        const failure: unknown = await store
          .commitArtifact({
            operation: 'uninstall',
            identity,
            destinationDirectory: destination,
          })
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ExtensionDirectoryLockedError);
        // The emptied tree is restored from the backup before the report.
        expect(
          await fsp.readFile(path.join(destination, 'version'), 'utf8'),
        ).toBe('one');
        expect(
          fs.existsSync(path.join(destination, EXTENSIONS_CONFIG_FILENAME)),
        ).toBe(true);
        expect(await fsp.readdir(path.join(storeDir, 'rollback'))).toEqual([]);
        expect(await leftoverJournals()).toEqual([]);
      } finally {
        rmSpy.mockRestore();
      }
    });
  });
});

describe('ExtensionStore.inspectEmptiness', () => {
  let root: string;
  let extensionsDir: string;
  let storeDir: string;
  const identity = { id: 'a'.repeat(64), name: 'demo' };

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qwen-extension-empty-'));
    extensionsDir = path.join(root, 'extensions');
    storeDir = path.join(root, 'extension-store');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(root, { recursive: true, force: true });
  });

  const makeStore = () =>
    new ExtensionStore({
      extensionsDir,
      storeDir,
      enablementPath: path.join(extensionsDir, 'extension-enablement.json'),
    });

  // Every entry under the root with its bytes and identity, to prove a read
  // leaves the tree exactly as it found it.
  const describeTree = async (): Promise<string[]> => {
    const lines: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of (await fsp.readdir(directory)).sort()) {
        const entryPath = path.join(directory, entry);
        const stats = await fsp.lstat(entryPath, { bigint: true });
        const identityText = `${stats.ino}:${stats.mtimeNs}:${stats.ctimeNs}`;
        if (stats.isDirectory()) {
          lines.push(`${path.relative(root, entryPath)}/ ${identityText}`);
          await walk(entryPath);
        } else if (stats.isFile()) {
          lines.push(
            `${path.relative(root, entryPath)} ${identityText} ${await fsp.readFile(entryPath, 'utf8')}`,
          );
        } else {
          lines.push(`${path.relative(root, entryPath)} link ${identityText}`);
        }
      }
    };
    await walk(root);
    return lines;
  };

  const inspectReadOnly = async () => {
    const before = await describeTree();
    const result = await makeStore().inspectEmptiness();
    expect(await describeTree()).toEqual(before);
    return result;
  };

  it('proves an absent store empty', async () => {
    await expect(inspectReadOnly()).resolves.toEqual({ status: 'empty' });
  });

  it('proves an initialized empty store empty', async () => {
    await makeStore().ensureInitialized([]);

    await expect(inspectReadOnly()).resolves.toEqual({ status: 'empty' });
  });

  it('accepts the files an idle reader and extension control files leave', async () => {
    // A locked read of an absent state prepares the lock file and the
    // transaction directories without writing a state.
    await makeStore().readSnapshot();
    await fsp.writeFile(
      path.join(extensionsDir, 'extension-preferences.json'),
      '{}',
    );
    await fsp.writeFile(path.join(extensionsDir, 'marketplaces.json'), '{}');
    await fsp.mkdir(path.join(storeDir, 'plugin-data'));
    expect(await fsp.readdir(storeDir)).not.toContain('state.json');

    await expect(inspectReadOnly()).resolves.toEqual({ status: 'empty' });
  });

  it('accepts journals recovery quarantined and leftovers of interrupted state writes', async () => {
    await makeStore().ensureInitialized([]);
    await fsp.writeFile(path.join(storeDir, 'transactions', 'torn.json'), '{');
    // The next store operation quarantines the torn journal for good.
    await makeStore().ensureInitialized([]);
    expect(await fsp.readdir(path.join(storeDir, 'transactions'))).toEqual([
      expect.stringMatching(/^torn\.json\.corrupt-/),
    ]);
    await fsp.writeFile(
      path.join(storeDir, 'state.json.0123456789ab.tmp'),
      '{',
    );
    await fsp.writeFile(
      path.join(storeDir, 'transactions', 'journal.json.0123456789ab.tmp'),
      '{',
    );

    await expect(inspectReadOnly()).resolves.toEqual({ status: 'empty' });
  });

  it('reports an enablement file that is not a regular file as unknown', async () => {
    // A FIFO would block the read, and a device's times change whenever any
    // process writes to it. A directory shows the same check, placed outside
    // the extensions directory, where it would count as an extension.
    const enablementPath = path.join(root, 'enablement.json');
    const store = new ExtensionStore({
      extensionsDir,
      storeDir,
      enablementPath,
    });
    await store.ensureInitialized([]);
    await fsp.rm(enablementPath, { force: true });
    await fsp.mkdir(enablementPath);
    const before = await describeTree();

    await expect(store.inspectEmptiness()).resolves.toEqual({
      status: 'unknown',
      reason: 'the extension enablement file is not a regular file',
    });
    expect(await describeTree()).toEqual(before);
  });

  it('ignores entries the file system adds, such as .DS_Store', async () => {
    await makeStore().ensureInitialized([]);
    for (const directory of [
      storeDir,
      path.join(storeDir, 'staging'),
      path.join(storeDir, 'rollback'),
    ]) {
      await fsp.writeFile(path.join(directory, '.DS_Store'), '');
    }

    await expect(inspectReadOnly()).resolves.toEqual({ status: 'empty' });
  });

  it('proves a store that keeps legacy rules for absent extensions empty', async () => {
    await fsp.mkdir(extensionsDir, { recursive: true });
    await fsp.writeFile(
      path.join(extensionsDir, 'extension-enablement.json'),
      JSON.stringify({ demo: { overrides: ['/w/'] } }),
    );
    // Every later initialization keeps the rules until "demo" is installed.
    await makeStore().ensureInitialized([]);
    await makeStore().ensureInitialized([]);
    const state = JSON.parse(
      await fsp.readFile(path.join(storeDir, 'state.json'), 'utf8'),
    );
    expect(state.extensions).toEqual({});
    expect(Object.keys(state.legacyProjectionRemainder)).toEqual(['demo']);

    await expect(inspectReadOnly()).resolves.toEqual({ status: 'empty' });
  });

  it.each([
    [
      'an extension directory',
      async () => {
        await fsp.mkdir(path.join(extensionsDir, 'demo'), { recursive: true });
      },
      'an extension directory is present',
    ],
    [
      'a link to an extension directory',
      async () => {
        await fsp.mkdir(path.join(root, 'elsewhere'));
        await fsp.mkdir(extensionsDir, { recursive: true });
        await fsp.symlink(
          path.join(root, 'elsewhere'),
          path.join(extensionsDir, 'demo'),
          'dir',
        );
      },
      'an extension directory is present',
    ],
    [
      'an extension recorded by the store',
      async () => {
        await makeStore().ensureInitialized([identity]);
      },
      'the extension store records extensions',
    ],
  ])('reports %s as installed', async (_name, arrange, reason) => {
    await arrange();

    await expect(inspectReadOnly()).resolves.toEqual({
      status: 'installed',
      reason,
    });
  });

  it.each([
    [
      'a held lock',
      async () => {
        await makeStore().ensureInitialized([]);
        await fsp.mkdir(path.join(storeDir, 'lock.lock'));
      },
      'the extension store is locked',
    ],
    [
      'a transaction in progress',
      async () => {
        await makeStore().ensureInitialized([]);
        await fsp.writeFile(
          path.join(storeDir, 'transactions', 'journal.json'),
          '{}',
        );
      },
      'an extension store transaction is in progress or awaits recovery',
    ],
    [
      'an interrupted install',
      async () => {
        const staging = await makeStore().createStagingDirectory();
        await fsp.writeFile(path.join(staging, 'qwen-extension.json'), '{}');
      },
      'an extension install or removal is in progress or was interrupted',
    ],
    [
      'a corrupt enablement file',
      async () => {
        await makeStore().ensureInitialized([]);
        await fsp.writeFile(
          path.join(extensionsDir, 'extension-enablement.json'),
          '{',
        );
      },
      'the extension enablement file is corrupt',
    ],
    [
      'a previous state without a current one',
      async () => {
        await makeStore().ensureInitialized([]);
        await fsp.rename(
          path.join(storeDir, 'state.json'),
          path.join(storeDir, 'state.previous.json'),
        );
      },
      'the extension store state was replaced incompletely',
    ],
    [
      'a corrupt state',
      async () => {
        await makeStore().ensureInitialized([]);
        await fsp.writeFile(path.join(storeDir, 'state.json'), '{');
      },
      'the extension store state is corrupt',
    ],
    [
      'a projection that disagrees with the state',
      async () => {
        await makeStore().ensureInitialized([]);
        await fsp.writeFile(
          path.join(extensionsDir, 'extension-enablement.json'),
          JSON.stringify({ demo: { overrides: [] } }),
        );
      },
      'the extension enablement projection needs reconciliation',
    ],
    [
      'enablement records without a state',
      async () => {
        await fsp.mkdir(extensionsDir, { recursive: true });
        await fsp.writeFile(
          path.join(extensionsDir, 'extension-enablement.json'),
          JSON.stringify({ demo: { overrides: [] } }),
        );
      },
      'extension enablement exists without a store state',
    ],
    [
      'an unexpected store entry',
      async () => {
        await makeStore().ensureInitialized([]);
        await fsp.writeFile(path.join(storeDir, 'staging-note'), '');
      },
      'the extension store holds an unexpected entry',
    ],
    [
      'a file named like the state that the store never writes',
      async () => {
        await makeStore().ensureInitialized([]);
        await fsp.writeFile(path.join(storeDir, 'state.json.bak'), '{}');
      },
      'the extension store holds an unexpected entry',
    ],
    [
      'a link in place of a transaction directory',
      async () => {
        await makeStore().ensureInitialized([]);
        await fsp.mkdir(path.join(root, 'elsewhere'));
        await fsp.rm(path.join(storeDir, 'rollback'), { recursive: true });
        await fsp.symlink(
          path.join(root, 'elsewhere'),
          path.join(storeDir, 'rollback'),
          'dir',
        );
      },
      'the extension store holds an unexpected entry',
    ],
    [
      'a dangling link in the extensions directory',
      async () => {
        await fsp.mkdir(extensionsDir, { recursive: true });
        await fsp.symlink(
          path.join(root, 'gone'),
          path.join(extensionsDir, 'demo'),
          'dir',
        );
      },
      'the extension store could not be read (ENOENT)',
    ],
    [
      'a transaction name that is not a directory',
      async () => {
        await makeStore().ensureInitialized([]);
        await fsp.rm(path.join(storeDir, 'rollback'), { recursive: true });
        await fsp.writeFile(path.join(storeDir, 'rollback'), '');
      },
      'the extension store could not be read (ENOTDIR)',
    ],
    [
      'an extensions path that is not a directory',
      async () => {
        await fsp.writeFile(extensionsDir, '');
      },
      'the extension store could not be read (ENOTDIR)',
    ],
  ])('reports %s as unknown', async (_name, arrange, reason) => {
    await arrange();

    await expect(inspectReadOnly()).resolves.toEqual({
      status: 'unknown',
      reason,
    });
  });

  it('reports a store that changes while it is read as unknown', async () => {
    const store = makeStore();
    await store.ensureInitialized([]);
    const readFile = fsp.readFile.bind(fsp);
    vi.spyOn(fsp, 'readFile').mockImplementationOnce(async (...args) => {
      await fsp.writeFile(
        path.join(storeDir, 'transactions', 'journal.json'),
        '{}',
      );
      return await readFile(...(args as Parameters<typeof readFile>));
    });

    await expect(store.inspectEmptiness()).resolves.toEqual({
      status: 'unknown',
      reason: 'the extension store changed while it was read',
    });
  });
});
