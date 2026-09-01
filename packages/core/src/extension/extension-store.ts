/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { Mutex } from 'async-mutex';
import { Storage } from '../config/storage.js';
import { atomicWriteJSON, renameWithRetry } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { Override, type AllExtensionsEnablementConfig } from './override.js';

const debugLogger = createDebugLogger('EXTENSION_STORE');

export type ExtensionActivation = 'enabled' | 'disabled';
export type WorkspaceActivation = ExtensionActivation | 'inherit';

export interface ExtensionPolicy {
  name: string;
  artifactDirectory?: string;
  artifactGeneration?: number;
  declarationOnly?: true;
  preserveActivationOnNextInstall?: true;
  defaultActivation: ExtensionActivation;
  workspaceOverrides: Record<string, WorkspaceActivation>;
  skillWorkspaceOverrides?: Record<string, Record<string, boolean>>;
  legacyPathRules?: string[];
  /** Out-of-band link grant: set only by commitArtifact during a CLI link
   *  install. The loader trusts link-mode (symlinks, `..`) only when this
   *  field exists, never from the extension's own install metadata. */
  linkedSource?: string;
}

export interface ExtensionStoreSnapshot {
  version: 2;
  generation: number;
  legacyProjectionHash: string;
  legacyProjectionRemainder?: AllExtensionsEnablementConfig;
  extensions: Record<string, ExtensionPolicy>;
}

export interface ExtensionStoreBatchMutationOutcome {
  snapshot: ExtensionStoreSnapshot;
  updated: boolean;
}

export interface ExtensionIdentity {
  id: string;
  name: string;
}

export interface ExtensionActivationResult {
  default: ExtensionActivation;
  workspace: WorkspaceActivation;
  effective: ExtensionActivation;
  source:
    | 'cli_override'
    | 'workspace_override'
    | 'legacy_path_rule'
    | 'default';
}

export interface ExtensionStoreOptions {
  extensionsDir?: string;
  storeDir?: string;
  enablementPath?: string;
}

export type InitialExtensionActivation =
  | { scope: 'user' }
  | { scope: 'workspace'; workspacePath: string };

export interface CommitExtensionArtifactInput {
  operation: 'install' | 'update' | 'uninstall';
  identity: ExtensionIdentity;
  destinationDirectory: string;
  stagingDirectory?: string;
  initialActivation?: InitialExtensionActivation;
  expectedArtifactGeneration?: number;
  /** Recorded by the installer for type:'link' installs; the loader treats
   *  this as the only out-of-band trust signal for link-mode semantics. */
  linkedSource?: string;
}

interface ExtensionTransactionJournal {
  version: 1;
  transactionId: string;
  operation: CommitExtensionArtifactInput['operation'];
  phase: 'prepared' | 'artifact_swapped' | 'state_committed';
  destinationDirectory: string;
  stagingDirectory?: string;
  backupDirectory: string;
  previousGeneration: number;
  targetGeneration: number;
  targetSnapshot: ExtensionStoreSnapshot;
}

export class ExtensionStoreCorruptError extends Error {
  readonly code = 'extension_store_corrupt';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExtensionStoreCorruptError';
  }
}

export class ExtensionStoreBusyError extends Error {
  readonly code = 'extension_store_busy';

  constructor(storeDir: string, options?: ErrorOptions) {
    super(`Extension store is busy at ${storeDir}.`, options);
    this.name = 'ExtensionStoreBusyError';
  }
}

class UnsafeRecoveredJournalError extends ExtensionStoreCorruptError {}

export class ExtensionConflictError extends Error {
  readonly code = 'extension_conflict';

  constructor(message: string) {
    super(message);
    this.name = 'ExtensionConflictError';
  }
}

const storeMutexes = new Map<string, Mutex>();

function getStoreMutex(storeDir: string): Mutex {
  let mutex = storeMutexes.get(storeDir);
  if (!mutex) {
    mutex = new Mutex();
    storeMutexes.set(storeDir, mutex);
  }
  return mutex;
}

function normalizeRulePath(workspacePath: string): string {
  let normalized = workspacePath.replace(/\\/g, '/');
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  if (!normalized.endsWith('/')) normalized = `${normalized}/`;
  return normalized;
}

function canonicalizeWorkspacePath(workspacePath: string): string {
  const resolved = path.resolve(workspacePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolved;
    throw error;
  }
}

function projectionHash(projection: AllExtensionsEnablementConfig): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(projection))
    .digest('hex');
}

function validLegacyProjection(
  projection: unknown,
): projection is AllExtensionsEnablementConfig {
  if (
    !projection ||
    Array.isArray(projection) ||
    typeof projection !== 'object'
  ) {
    return false;
  }
  const names = new Set<string>();
  return Object.entries(projection).every(([name, config]) => {
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) return false;
    names.add(normalizedName);
    return (
      !!config &&
      !Array.isArray(config) &&
      typeof config === 'object' &&
      Array.isArray((config as { overrides?: unknown }).overrides) &&
      (config as { overrides: unknown[] }).overrides.every(
        (rule) => typeof rule === 'string',
      )
    );
  });
}

function findLegacyRules(
  projection: AllExtensionsEnablementConfig,
  name: string,
): readonly string[] {
  const normalizedName = name.toLowerCase();
  return (
    Object.entries(projection).find(
      ([candidate]) => candidate.toLowerCase() === normalizedName,
    )?.[1].overrides ?? []
  );
}

function assertIdentity(identity: ExtensionIdentity): void {
  if (!/^[a-f0-9]{64}$/.test(identity.id)) {
    throw new Error(`Invalid extension id "${identity.id}".`);
  }
  if (!/^[a-zA-Z0-9-_.]+$/.test(identity.name)) {
    throw new Error('Invalid extension name.');
  }
}

function setLegacyPathActivation(
  policy: ExtensionPolicy,
  scopePath: string,
  activation: ExtensionActivation,
): void {
  const canonicalScope = canonicalizeWorkspacePath(scopePath);
  const scope = Override.fromInput(canonicalScope, true);
  for (const workspacePath of Object.keys(policy.workspaceOverrides)) {
    if (scope.matchesPath(normalizeRulePath(workspacePath))) {
      delete policy.workspaceOverrides[workspacePath];
    }
  }
  const nextRule = Override.fromInput(
    activation === 'disabled' ? `!${canonicalScope}` : canonicalScope,
    true,
  );
  const rules = (policy.legacyPathRules ?? []).filter((rule) => {
    const existing = Override.fromFileRule(rule);
    return (
      !existing.conflictsWith(nextRule) &&
      !existing.isEqualTo(nextRule) &&
      !existing.isChildOf(nextRule)
    );
  });
  rules.push(nextRule.output());
  policy.legacyPathRules = rules;
}

function clearWorkspaceActivation(
  policy: ExtensionPolicy,
  workspacePath: string,
  canonicalWorkspace = canonicalizeWorkspacePath(workspacePath),
): void {
  const legacyCandidates = [
    normalizeRulePath(workspacePath),
    normalizeRulePath(canonicalWorkspace),
  ];
  const legacyMatches = (policy.legacyPathRules ?? []).some((rule) => {
    const override = Override.fromFileRule(rule);
    return legacyCandidates.some((candidate) =>
      override.matchesPath(candidate),
    );
  });
  if (legacyMatches) {
    policy.workspaceOverrides[canonicalWorkspace] = 'inherit';
  } else {
    delete policy.workspaceOverrides[canonicalWorkspace];
  }
}

function parseState(
  content: string,
  statePath: string,
): ExtensionStoreSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new ExtensionStoreCorruptError(
      `Extension store state is corrupt at ${statePath}.`,
      { cause: error },
    );
  }
  const candidate = value as Partial<ExtensionStoreSnapshot> | null;
  const validPolicy = (extensionId: string, policy: unknown): boolean => {
    if (
      !/^[a-f0-9]{64}$/.test(extensionId) ||
      !policy ||
      typeof policy !== 'object'
    ) {
      return false;
    }
    const parsed = policy as Partial<ExtensionPolicy>;
    return (
      typeof parsed.name === 'string' &&
      /^[a-zA-Z0-9-_.]+$/.test(parsed.name) &&
      (parsed.artifactDirectory === undefined ||
        (typeof parsed.artifactDirectory === 'string' &&
          /^[a-zA-Z0-9-_.]+$/.test(parsed.artifactDirectory) &&
          parsed.artifactDirectory !== '.' &&
          parsed.artifactDirectory !== '..')) &&
      (parsed.artifactGeneration === undefined ||
        (Number.isSafeInteger(parsed.artifactGeneration) &&
          parsed.artifactGeneration >= 0)) &&
      (parsed.linkedSource === undefined ||
        (typeof parsed.linkedSource === 'string' &&
          parsed.linkedSource.length > 0 &&
          !/[\u0000-\u001f\u007f]/.test(parsed.linkedSource))) &&
      (parsed.declarationOnly === undefined ||
        parsed.declarationOnly === true) &&
      (parsed.preserveActivationOnNextInstall === undefined ||
        parsed.preserveActivationOnNextInstall === true) &&
      (parsed.defaultActivation === 'enabled' ||
        parsed.defaultActivation === 'disabled') &&
      !!parsed.workspaceOverrides &&
      !Array.isArray(parsed.workspaceOverrides) &&
      typeof parsed.workspaceOverrides === 'object' &&
      Object.values(parsed.workspaceOverrides).every(
        (activation) =>
          activation === 'enabled' ||
          activation === 'disabled' ||
          activation === 'inherit',
      ) &&
      (parsed.skillWorkspaceOverrides === undefined ||
        (parsed.skillWorkspaceOverrides !== null &&
          typeof parsed.skillWorkspaceOverrides === 'object' &&
          !Array.isArray(parsed.skillWorkspaceOverrides) &&
          Object.values(parsed.skillWorkspaceOverrides).every(
            (states) =>
              states !== null &&
              typeof states === 'object' &&
              !Array.isArray(states) &&
              Object.values(states).every(
                (enabled) => typeof enabled === 'boolean',
              ),
          ))) &&
      (parsed.legacyPathRules === undefined ||
        (Array.isArray(parsed.legacyPathRules) &&
          parsed.legacyPathRules.every((rule) => typeof rule === 'string')))
    );
  };
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    candidate.version !== 2 ||
    !Number.isSafeInteger(candidate.generation) ||
    candidate.generation! < 0 ||
    typeof candidate.legacyProjectionHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate.legacyProjectionHash) ||
    (candidate.legacyProjectionRemainder !== undefined &&
      !validLegacyProjection(candidate.legacyProjectionRemainder)) ||
    !candidate.extensions ||
    Array.isArray(candidate.extensions) ||
    typeof candidate.extensions !== 'object' ||
    !Object.entries(candidate.extensions).every(([id, policy]) =>
      validPolicy(id, policy),
    )
  ) {
    throw new ExtensionStoreCorruptError(
      `Extension store state has an invalid schema at ${statePath}.`,
    );
  }
  return value as ExtensionStoreSnapshot;
}

export class ExtensionStore {
  readonly extensionsDir: string;
  readonly storeDir: string;
  readonly enablementPath: string;
  private readonly statePath: string;
  private readonly previousStatePath: string;
  private readonly lockPath: string;

  constructor(options: ExtensionStoreOptions = {}) {
    this.extensionsDir =
      options.extensionsDir ?? Storage.getUserExtensionsDir();
    this.storeDir =
      options.storeDir ??
      path.join(Storage.getGlobalQwenDir(), 'extension-store');
    this.enablementPath =
      options.enablementPath ??
      path.join(this.extensionsDir, 'extension-enablement.json');
    this.statePath = path.join(this.storeDir, 'state.json');
    this.previousStatePath = path.join(this.storeDir, 'state.previous.json');
    this.lockPath = path.join(this.storeDir, 'lock');
  }

  agentPluginDataRoot(extensionId: string): string {
    if (!/^[a-f0-9]{64}$/.test(extensionId)) {
      throw new Error(`Invalid extension id "${extensionId}".`);
    }
    return path.join(
      this.storeDir,
      'plugin-data',
      'agent-plugins',
      extensionId,
    );
  }

  async ensureInitialized(
    extensions: readonly ExtensionIdentity[],
  ): Promise<ExtensionStoreSnapshot> {
    return await this.withLock(
      async () => await this.ensureInitializedUnlocked(extensions),
    );
  }

  async readConsistent<T>(
    readArtifacts: () => Promise<{
      value: T;
      extensions: readonly ExtensionIdentity[];
    }>,
  ): Promise<{ value: T; snapshot: ExtensionStoreSnapshot }> {
    return await this.withLock(async () => {
      const { value, extensions } = await readArtifacts();
      const snapshot = await this.ensureInitializedUnlocked(extensions);
      return { value, snapshot };
    });
  }

  private async ensureInitializedUnlocked(
    extensions: readonly ExtensionIdentity[],
  ): Promise<ExtensionStoreSnapshot> {
    const loadedNames = new Map<string, ExtensionIdentity>();
    for (const identity of extensions) {
      assertIdentity(identity);
      const normalizedName = identity.name.toLowerCase();
      const existingIdentity = loadedNames.get(normalizedName);
      if (
        existingIdentity &&
        (existingIdentity.id !== identity.id ||
          existingIdentity.name !== identity.name)
      ) {
        throw new ExtensionConflictError(
          `Extension name "${identity.name}" conflicts with loaded extension "${existingIdentity.name}".`,
        );
      }
      loadedNames.set(normalizedName, identity);
    }
    const existing = await this.readSnapshotUnlocked();
    const legacy = await this.readLegacyProjection();
    if (existing) {
      let changed = false;
      const renamedPolicyNames = new Set<string>();
      const importUnmappedLegacy =
        existing.legacyProjectionHash === projectionHash(legacy);
      let legacyProjectionIsNewer = false;
      // An id-formula change (e.g. #7568 added the plugin name to the hash)
      // leaves installed extensions pointing at ids the store has never
      // seen. Without this re-key, the blocks below would mint a fresh
      // default policy under the new id — resetting activation state — and
      // strand the old policy as an orphan that later trips the
      // name-conflict guard on update/uninstall. Names are unique in the
      // store (enforced case-insensitively on every commit), so a loaded
      // identity whose id is unknown safely claims the policy stored under
      // its name, provided no loaded extension still owns that entry.
      const loadedIds = new Set(extensions.map((identity) => identity.id));
      for (const identity of extensions) {
        assertIdentity(identity);
        const directPolicy = existing.extensions[identity.id];
        if (directPolicy) {
          if (directPolicy.name !== identity.name) {
            const nameOwner = Object.entries(existing.extensions).find(
              ([id, policy]) =>
                id !== identity.id &&
                policy.name.toLowerCase() === identity.name.toLowerCase(),
            );
            if (nameOwner && !nameOwner[1].declarationOnly) {
              throw new ExtensionConflictError(
                `Extension name "${identity.name}" conflicts with an installed extension.`,
              );
            }
            if (!directPolicy.declarationOnly) {
              directPolicy.artifactDirectory ??= directPolicy.name;
            }
            if (
              directPolicy.name.toLowerCase() !== identity.name.toLowerCase()
            ) {
              renamedPolicyNames.add(directPolicy.name.toLowerCase());
            }
            if (nameOwner) {
              const [declarationId, declaration] = nameOwner;
              directPolicy.defaultActivation = declaration.defaultActivation;
              directPolicy.workspaceOverrides = {
                ...declaration.workspaceOverrides,
              };
              if (declaration.legacyPathRules) {
                directPolicy.legacyPathRules = [...declaration.legacyPathRules];
              } else {
                delete directPolicy.legacyPathRules;
              }
              delete existing.extensions[declarationId];
              changed = true;
            }
            directPolicy.name = identity.name;
            changed = true;
          }
          if (directPolicy.declarationOnly) {
            delete directPolicy.declarationOnly;
            directPolicy.artifactGeneration = existing.generation + 1;
            directPolicy.preserveActivationOnNextInstall = true;
            changed = true;
          }
          continue;
        }
        const staleEntry = Object.entries(existing.extensions).find(
          ([id, policy]) =>
            !loadedIds.has(id) &&
            policy.name.toLowerCase() === identity.name.toLowerCase(),
        );
        if (staleEntry) {
          const [staleId, policy] = staleEntry;
          if (!policy.declarationOnly && policy.name !== identity.name) {
            policy.artifactDirectory ??= policy.name;
          }
          if (policy.declarationOnly) {
            delete policy.declarationOnly;
            policy.artifactGeneration = existing.generation + 1;
            policy.preserveActivationOnNextInstall = true;
          }
          delete existing.extensions[staleId];
          policy.name = identity.name;
          existing.extensions[identity.id] = policy;
          changed = true;
        }
      }
      if (existing.legacyProjectionHash !== projectionHash(legacy)) {
        legacyProjectionIsNewer = await this.legacyProjectionIsNewerThanState();
        if (!legacyProjectionIsNewer) {
          try {
            await this.writeLegacyProjectionUnlocked(existing);
          } catch {
            // state.json remains authoritative; a later access retries repair.
          }
          for (const identity of extensions) {
            assertIdentity(identity);
            if (existing.extensions[identity.id]) continue;
            const rules = findLegacyRules(
              existing.legacyProjectionRemainder ?? {},
              identity.name,
            );
            existing.extensions[identity.id] = {
              name: identity.name,
              defaultActivation: 'enabled',
              workspaceOverrides: {},
              ...(rules.length > 0 ? { legacyPathRules: [...rules] } : {}),
            };
            changed = true;
          }
        } else {
          const identities = new Map(
            Object.entries(existing.extensions).map(([id, policy]) => [
              id,
              { id, name: policy.name },
            ]),
          );
          for (const identity of extensions)
            identities.set(identity.id, identity);
          for (const identity of identities.values()) {
            assertIdentity(identity);
            const existingPolicy = existing.extensions[identity.id];
            const { rules, activationChanged } = this.importLegacyProjection(
              findLegacyRules(legacy, identity.name),
              existingPolicy,
            );
            if (existingPolicy) {
              const previousRules = existingPolicy.legacyPathRules ?? [];
              const policyChanged =
                activationChanged ||
                existingPolicy.name !== identity.name ||
                previousRules.length !== rules.length ||
                previousRules.some((rule, index) => rule !== rules[index]);
              if (!policyChanged) continue;
              existingPolicy.name = identity.name;
              if (rules.length > 0) {
                existingPolicy.legacyPathRules = [...rules];
              } else {
                delete existingPolicy.legacyPathRules;
              }
              changed = true;
            } else {
              existing.extensions[identity.id] = {
                name: identity.name,
                defaultActivation: 'enabled',
                workspaceOverrides: {},
                ...(rules.length > 0 ? { legacyPathRules: [...rules] } : {}),
              };
              changed = true;
            }
          }
          if (!changed) {
            try {
              await this.writeLegacyProjectionUnlocked(existing);
            } catch {
              // state.json remains authoritative; a later access retries repair.
            }
          }
        }
      } else {
        for (const identity of extensions) {
          assertIdentity(identity);
          if (existing.extensions[identity.id]) continue;
          const rules = findLegacyRules(legacy, identity.name);
          existing.extensions[identity.id] = {
            name: identity.name,
            defaultActivation: 'enabled',
            workspaceOverrides: {},
            ...(rules.length > 0 ? { legacyPathRules: [...rules] } : {}),
          };
          changed = true;
        }
      }
      let remainderSource = legacyProjectionIsNewer
        ? legacy
        : importUnmappedLegacy
          ? legacy
          : (existing.legacyProjectionRemainder ?? {});
      if (renamedPolicyNames.size > 0) {
        remainderSource = Object.fromEntries(
          Object.entries(remainderSource).filter(
            ([name]) => !renamedPolicyNames.has(name.toLowerCase()),
          ),
        );
      }
      changed =
        this.updateLegacyProjectionRemainder(existing, remainderSource) ||
        changed;
      if (changed) {
        existing.generation += 1;
        await this.writeSnapshotUnlocked(existing);
      }
      return existing;
    }
    const policies: Record<string, ExtensionPolicy> = {};
    for (const identity of extensions) {
      assertIdentity(identity);
      const rules = findLegacyRules(legacy, identity.name);
      policies[identity.id] = {
        name: identity.name,
        defaultActivation: 'enabled',
        workspaceOverrides: {},
        ...(rules.length > 0 ? { legacyPathRules: [...rules] } : {}),
      };
    }
    const snapshot: ExtensionStoreSnapshot = {
      version: 2,
      generation: 0,
      legacyProjectionHash: projectionHash(legacy),
      extensions: policies,
    };
    this.updateLegacyProjectionRemainder(snapshot, legacy);
    await this.writeSnapshotUnlocked(snapshot);
    return snapshot;
  }

  async createStagingDirectory(): Promise<string> {
    await this.prepareDirectories();
    const stagingRoot = path.join(this.storeDir, 'staging');
    await fsp.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    return await fsp.mkdtemp(path.join(stagingRoot, 'transaction-'));
  }

  async commitArtifact(
    input: CommitExtensionArtifactInput,
  ): Promise<ExtensionStoreSnapshot> {
    assertIdentity(input.identity);
    this.assertArtifactPaths(input);
    return await this.withLock(async () => {
      const snapshot =
        (await this.readSnapshotUnlocked()) ?? this.emptySnapshot();
      const transactionId = crypto.randomUUID();
      const transactionsDir = path.join(this.storeDir, 'transactions');
      const backupDirectory = path.join(
        this.storeDir,
        'rollback',
        transactionId,
      );
      const journalPath = path.join(transactionsDir, `${transactionId}.json`);
      const currentPolicy = snapshot.extensions[input.identity.id];
      const destinationDirectory =
        input.operation !== 'install' && currentPolicy?.artifactDirectory
          ? path.join(this.extensionsDir, currentPolicy.artifactDirectory)
          : input.destinationDirectory;
      this.assertArtifactDestination(destinationDirectory);
      const destinationExists = await this.pathExists(destinationDirectory);
      if (input.operation === 'install' && destinationExists) {
        throw new ExtensionConflictError(
          `Extension "${input.identity.name}" is installed.`,
        );
      }
      if (input.operation === 'update' && !destinationExists) {
        throw new ExtensionConflictError(
          `Extension "${input.identity.name}" is not installed.`,
        );
      }
      if (input.operation === 'install' && !input.initialActivation) {
        throw new Error('Install requires an initial activation.');
      }
      const nameConflict = Object.entries(snapshot.extensions).find(
        ([extensionId, policy]) =>
          extensionId !== input.identity.id &&
          policy.name.toLowerCase() === input.identity.name.toLowerCase(),
      );
      const currentPolicyIsAdoptable =
        input.operation === 'install' &&
        !!currentPolicy &&
        (currentPolicy.declarationOnly ||
          (currentPolicy.preserveActivationOnNextInstall &&
            !(await this.extensionArtifactExists(currentPolicy))));
      const nameConflictIsAdoptable =
        input.operation === 'install' &&
        !currentPolicy &&
        !!nameConflict &&
        (nameConflict[1].declarationOnly ||
          (nameConflict[1].preserveActivationOnNextInstall &&
            !(await this.extensionArtifactExists(nameConflict[1]))));
      if (
        input.operation !== 'uninstall' &&
        nameConflict &&
        !nameConflictIsAdoptable
      ) {
        throw new ExtensionConflictError(
          `Extension name "${input.identity.name}" conflicts with an installed extension.`,
        );
      }

      if (
        currentPolicy &&
        currentPolicy.name.toLowerCase() !== input.identity.name.toLowerCase()
      ) {
        throw new ExtensionConflictError(
          `Extension id belongs to "${currentPolicy.name}", not "${input.identity.name}".`,
        );
      }
      if (input.operation === 'uninstall' && !currentPolicy) {
        if (!destinationExists) return snapshot;
        throw new ExtensionConflictError(
          `Extension "${input.identity.name}" has no matching policy.`,
        );
      }
      if (input.operation === 'uninstall' && currentPolicy.declarationOnly) {
        throw new ExtensionConflictError(
          `Extension "${input.identity.name}" is not installed.`,
        );
      }
      if (input.operation === 'update' && !currentPolicy) {
        throw new ExtensionConflictError(
          `Extension "${input.identity.name}" is not installed.`,
        );
      }
      if (
        input.operation === 'update' &&
        input.expectedArtifactGeneration !== undefined &&
        (currentPolicy?.artifactGeneration ?? 0) !==
          input.expectedArtifactGeneration
      ) {
        throw new ExtensionConflictError(
          `Extension "${input.identity.name}" changed while its update was being prepared.`,
        );
      }

      const targetSnapshot = structuredClone(snapshot);
      if (input.operation === 'install') {
        const declarationEntry = currentPolicyIsAdoptable
          ? ([input.identity.id, currentPolicy] as const)
          : nameConflictIsAdoptable
            ? nameConflict!
            : undefined;
        if (declarationEntry) {
          const [declarationId] = declarationEntry;
          const policy = targetSnapshot.extensions[declarationId]!;
          delete targetSnapshot.extensions[declarationId];
          delete policy.declarationOnly;
          delete policy.preserveActivationOnNextInstall;
          delete policy.artifactDirectory;
          policy.name = input.identity.name;
          policy.artifactGeneration = targetSnapshot.generation + 1;
          delete policy.linkedSource;
          if (input.linkedSource !== undefined) {
            policy.linkedSource = input.linkedSource;
          }
          targetSnapshot.extensions[input.identity.id] = policy;
        } else {
          const initial = input.initialActivation!;
          const rules = findLegacyRules(
            snapshot.legacyProjectionRemainder ?? {},
            input.identity.name,
          );
          targetSnapshot.extensions[input.identity.id] = {
            name: input.identity.name,
            artifactGeneration: targetSnapshot.generation + 1,
            defaultActivation:
              initial.scope === 'user' ? 'enabled' : 'disabled',
            workspaceOverrides:
              initial.scope === 'workspace'
                ? {
                    [canonicalizeWorkspacePath(initial.workspacePath)]:
                      'enabled',
                  }
                : {},
            ...(input.linkedSource !== undefined
              ? { linkedSource: input.linkedSource }
              : {}),
            ...(rules.length > 0 ? { legacyPathRules: [...rules] } : {}),
          };
        }
        this.updateLegacyProjectionRemainder(
          targetSnapshot,
          targetSnapshot.legacyProjectionRemainder ?? {},
        );
      } else if (input.operation === 'uninstall') {
        delete targetSnapshot.extensions[input.identity.id];
      } else {
        const policy = targetSnapshot.extensions[input.identity.id];
        if (policy && policy.name !== input.identity.name) {
          throw new ExtensionConflictError(
            `Extension update changed name from "${policy.name}" to "${input.identity.name}".`,
          );
        }
        targetSnapshot.extensions[input.identity.id] = policy!;
        delete targetSnapshot.extensions[input.identity.id]!
          .preserveActivationOnNextInstall;
        targetSnapshot.extensions[input.identity.id]!.artifactGeneration =
          targetSnapshot.generation + 1;
        delete targetSnapshot.extensions[input.identity.id]!.linkedSource;
        if (input.linkedSource !== undefined) {
          targetSnapshot.extensions[input.identity.id]!.linkedSource =
            input.linkedSource;
        }
      }
      targetSnapshot.generation = snapshot.generation + 1;
      targetSnapshot.legacyProjectionHash = projectionHash(
        this.buildLegacyProjection(targetSnapshot),
      );

      const journal: ExtensionTransactionJournal = {
        version: 1,
        transactionId,
        operation: input.operation,
        phase: 'prepared',
        destinationDirectory,
        ...(input.stagingDirectory
          ? { stagingDirectory: input.stagingDirectory }
          : {}),
        backupDirectory,
        previousGeneration: snapshot.generation,
        targetGeneration: targetSnapshot.generation,
        targetSnapshot,
      };
      await atomicWriteJSON(journalPath, journal, {
        mode: 0o600,
        forceMode: true,
        noFollow: true,
      });

      let stateCommitted = false;
      try {
        if (destinationExists) {
          await renameWithRetry(destinationDirectory, backupDirectory, 3, 50);
        }
        if (input.operation !== 'uninstall') {
          await renameWithRetry(
            input.stagingDirectory!,
            destinationDirectory,
            3,
            50,
          );
        }
        journal.phase = 'artifact_swapped';
        await atomicWriteJSON(journalPath, journal, {
          mode: 0o600,
          forceMode: true,
          noFollow: true,
        });

        await this.writeSnapshotUnlocked(targetSnapshot);
        stateCommitted = true;
        journal.phase = 'state_committed';
        try {
          await atomicWriteJSON(journalPath, journal, {
            mode: 0o600,
            forceMode: true,
            noFollow: true,
          });
        } catch {
          // The snapshot generation is enough for recovery to recognize the
          // commit even if this advisory phase update could not be persisted.
        }
      } catch (error) {
        if (!stateCommitted) {
          try {
            await this.rollbackJournal(journal);
            await fsp.rm(journalPath, { force: true });
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              'Extension transaction failed and rollback recovery did not complete.',
              { cause: error },
            );
          }
        }
        throw error;
      }

      try {
        await this.cleanupCommittedJournal(journal, journalPath);
      } catch {
        // The committed state is authoritative. Recovery retries cleanup on
        // the next store operation without reporting a false mutation failure.
      }
      return targetSnapshot;
    });
  }

  async readSnapshot(): Promise<ExtensionStoreSnapshot> {
    return await this.withLock(async () => {
      const snapshot = await this.readSnapshotUnlocked();
      if (!snapshot) return this.emptySnapshot();
      return snapshot;
    });
  }

  /**
   * Reads the snapshot WITHOUT taking the read lock. Call only from inside a
   * withLock/readConsistent callback (the lock is already held there; a
   * separate readSnapshot() would self-deadlock) or from a context where the
   * store cannot be mutating concurrently. A missing store resolves to the
   * empty snapshot; a corrupt store throws ExtensionStoreCorruptError,
   * exactly like readSnapshot.
   */
  async peekSnapshot(): Promise<ExtensionStoreSnapshot> {
    return (await this.readSnapshotUnlocked()) ?? this.emptySnapshot();
  }

  getActivation(
    snapshot: ExtensionStoreSnapshot,
    extensionId: string,
    extensionName: string,
    workspacePath: string,
  ): ExtensionActivationResult {
    const policy = snapshot.extensions[extensionId];
    if (!policy || policy.name !== extensionName) {
      return {
        default: 'enabled',
        workspace: 'inherit',
        effective: 'enabled',
        source: 'default',
      };
    }
    const canonicalWorkspace = canonicalizeWorkspacePath(workspacePath);
    const exact = policy.workspaceOverrides[canonicalWorkspace];
    if (exact === 'enabled' || exact === 'disabled') {
      return {
        default: policy.defaultActivation,
        workspace: exact,
        effective: exact,
        source: 'workspace_override',
      };
    }
    if (exact === 'inherit') {
      return {
        default: policy.defaultActivation,
        workspace: 'inherit',
        effective: policy.defaultActivation,
        source: 'default',
      };
    }
    let effective = policy.defaultActivation;
    let matched = false;
    const legacyCandidates = [
      normalizeRulePath(workspacePath),
      normalizeRulePath(canonicalWorkspace),
    ];
    for (const rule of policy.legacyPathRules ?? []) {
      const override = Override.fromFileRule(rule);
      if (
        !legacyCandidates.some((candidate) => override.matchesPath(candidate))
      ) {
        continue;
      }
      effective = override.isDisable ? 'disabled' : 'enabled';
      matched = true;
    }
    return {
      default: policy.defaultActivation,
      workspace: 'inherit',
      effective,
      source: matched ? 'legacy_path_rule' : 'default',
    };
  }

  async setDefaultActivation(
    identity: ExtensionIdentity,
    activation: ExtensionActivation,
  ): Promise<ExtensionStoreSnapshot> {
    return await this.mutate(identity, (policy) => {
      policy.defaultActivation = activation;
    });
  }

  async setDefaultActivations(
    identities: readonly ExtensionIdentity[],
    activation: ExtensionActivation,
  ): Promise<ExtensionStoreSnapshot> {
    const outcome = await this.mutateMany(identities, (policy) => {
      policy.defaultActivation = activation;
    });
    return outcome.snapshot;
  }

  async setActivationScope(
    identity: ExtensionIdentity,
    activation: InitialExtensionActivation,
  ): Promise<ExtensionStoreSnapshot> {
    return await this.mutate(identity, (policy) => {
      policy.defaultActivation =
        activation.scope === 'user' ? 'enabled' : 'disabled';
      policy.workspaceOverrides =
        activation.scope === 'workspace'
          ? {
              [canonicalizeWorkspacePath(activation.workspacePath)]: 'enabled',
            }
          : {};
      delete policy.legacyPathRules;
    });
  }

  async setWorkspaceActivation(
    identity: ExtensionIdentity,
    workspacePath: string,
    activation: ExtensionActivation,
  ): Promise<ExtensionStoreSnapshot> {
    return await this.mutate(identity, (policy) => {
      policy.workspaceOverrides[canonicalizeWorkspacePath(workspacePath)] =
        activation;
    });
  }

  getSkillWorkspaceOverride(
    snapshot: ExtensionStoreSnapshot,
    extensionId: string,
    workspacePath: string,
    skillName: string,
  ): boolean | null {
    const states =
      snapshot.extensions[extensionId]?.skillWorkspaceOverrides?.[
        canonicalizeWorkspacePath(workspacePath)
      ];
    const name = skillName.trim().toLowerCase();
    return states && Object.hasOwn(states, name) ? states[name]! : null;
  }

  async setSkillWorkspaceOverrides(
    identity: ExtensionIdentity,
    workspacePath: string,
    states: Readonly<Record<string, boolean>>,
    expectedArtifactGeneration: number,
    beforeCommit?: () => void,
  ): Promise<ExtensionStoreSnapshot> {
    const workspace = canonicalizeWorkspacePath(workspacePath);
    return await this.mutate(identity, (policy) => {
      if ((policy.artifactGeneration ?? 0) !== expectedArtifactGeneration) {
        throw new ExtensionConflictError(
          `Extension "${identity.name}" changed while its skill states were being prepared.`,
        );
      }
      beforeCommit?.();
      policy.skillWorkspaceOverrides = {
        ...policy.skillWorkspaceOverrides,
        [workspace]: {
          ...policy.skillWorkspaceOverrides?.[workspace],
          ...states,
        },
      };
    });
  }

  async setWorkspaceActivations(
    identities: readonly ExtensionIdentity[],
    workspacePath: string,
    activation: ExtensionActivation,
  ): Promise<ExtensionStoreSnapshot> {
    const canonicalWorkspace = canonicalizeWorkspacePath(workspacePath);
    const outcome = await this.mutateMany(identities, (policy) => {
      policy.workspaceOverrides[canonicalWorkspace] = activation;
    });
    return outcome.snapshot;
  }

  async clearWorkspaceActivation(
    identity: ExtensionIdentity,
    workspacePath: string,
  ): Promise<ExtensionStoreSnapshot> {
    return await this.mutate(identity, (policy) => {
      clearWorkspaceActivation(policy, workspacePath);
    });
  }

  async clearWorkspaceActivations(
    identities: readonly ExtensionIdentity[],
    workspacePath: string,
  ): Promise<ExtensionStoreBatchMutationOutcome> {
    const canonicalWorkspace = canonicalizeWorkspacePath(workspacePath);
    return await this.mutateMany(
      identities,
      (policy) => {
        clearWorkspaceActivation(policy, workspacePath, canonicalWorkspace);
      },
      false,
    );
  }

  async setLegacyPathActivation(
    identity: ExtensionIdentity,
    scopePath: string,
    activation: ExtensionActivation,
  ): Promise<ExtensionStoreSnapshot> {
    return await this.mutate(identity, (policy) => {
      setLegacyPathActivation(policy, scopePath, activation);
    });
  }

  private async mutate(
    identity: ExtensionIdentity,
    update: (policy: ExtensionPolicy) => void,
  ): Promise<ExtensionStoreSnapshot> {
    assertIdentity(identity);
    return await this.withLock(async () => {
      const snapshot =
        (await this.readSnapshotUnlocked()) ?? this.emptySnapshot();
      const policy = snapshot.extensions[identity.id];
      if (!policy) {
        throw new ExtensionConflictError(
          `Extension "${identity.name}" is not installed.`,
        );
      }
      if (policy.declarationOnly) {
        throw new ExtensionConflictError(
          `Extension "${identity.name}" is not installed.`,
        );
      }
      if (policy.name !== identity.name) {
        throw new Error(
          `Extension id ${identity.id} belongs to "${policy.name}", not "${identity.name}".`,
        );
      }
      update(policy);
      snapshot.extensions[identity.id] = policy;
      snapshot.generation += 1;
      await this.writeSnapshotUnlocked(snapshot);
      return snapshot;
    });
  }

  private async mutateMany(
    identities: readonly ExtensionIdentity[],
    update: (policy: ExtensionPolicy) => void,
    declareUnknown = true,
  ): Promise<ExtensionStoreBatchMutationOutcome> {
    identities.forEach(assertIdentity);
    if (identities.length === 0) {
      throw new Error('At least one extension identity is required.');
    }
    return await this.withLock(async () => {
      const existing = await this.readSnapshotUnlocked();
      const snapshot = existing ?? this.emptySnapshot();
      const legacy = await this.readLegacyProjection();
      let legacyForImport = legacy;
      let legacyForRemainder = legacy;
      if (
        existing &&
        existing.legacyProjectionHash !== projectionHash(legacy)
      ) {
        if (await this.legacyProjectionIsNewerThanState()) {
          for (const policy of Object.values(snapshot.extensions)) {
            const { rules } = this.importLegacyProjection(
              findLegacyRules(legacy, policy.name),
              policy,
            );
            if (rules.length > 0) {
              policy.legacyPathRules = [...rules];
            } else {
              delete policy.legacyPathRules;
            }
          }
          legacyForRemainder = legacy;
        } else {
          legacyForImport = snapshot.legacyProjectionRemainder ?? {};
          legacyForRemainder = snapshot.legacyProjectionRemainder ?? {};
        }
      }
      const policies: ExtensionPolicy[] = [];
      for (const identity of identities) {
        let policy = snapshot.extensions[identity.id];
        if (!policy) {
          const existingByName = Object.values(snapshot.extensions).find(
            (existing) =>
              existing.name.toLowerCase() === identity.name.toLowerCase(),
          );
          if (existingByName) {
            policy = existingByName;
          } else if (!declareUnknown) {
            continue;
          } else {
            const rules = findLegacyRules(legacyForImport, identity.name);
            policy = {
              name: identity.name,
              declarationOnly: true,
              defaultActivation: 'enabled',
              workspaceOverrides: {},
              ...(rules.length > 0 ? { legacyPathRules: [...rules] } : {}),
            };
            snapshot.extensions[identity.id] = policy;
          }
        }
        if (
          !policy.declarationOnly &&
          policy.artifactGeneration !== undefined &&
          !(await this.extensionArtifactExists(policy))
        ) {
          delete policy.artifactGeneration;
          delete policy.preserveActivationOnNextInstall;
          delete policy.linkedSource;
          policy.declarationOnly = true;
        }
        if (policy.name.toLowerCase() !== identity.name.toLowerCase()) {
          throw new ExtensionConflictError(
            `Extension id ${identity.id} belongs to "${policy.name}", not "${identity.name}".`,
          );
        }
        policies.push(policy);
      }
      if (policies.length === 0) {
        return { snapshot, updated: false };
      }
      for (const policy of policies) update(policy);
      this.updateLegacyProjectionRemainder(snapshot, legacyForRemainder);
      snapshot.generation += 1;
      await this.writeSnapshotUnlocked(snapshot);
      return { snapshot, updated: true };
    });
  }

  private async extensionArtifactExists(
    policy: ExtensionPolicy,
  ): Promise<boolean> {
    const directory = policy.artifactDirectory ?? policy.name;
    if (await this.pathExists(path.join(this.extensionsDir, directory))) {
      return true;
    }
    let entries: string[];
    try {
      entries = await fsp.readdir(this.extensionsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    const normalizedName = directory.toLowerCase();
    return entries.some((entry) => entry.toLowerCase() === normalizedName);
  }

  private emptySnapshot(): ExtensionStoreSnapshot {
    return {
      version: 2,
      generation: 0,
      legacyProjectionHash: projectionHash({}),
      extensions: {},
    };
  }

  private async readSnapshotUnlocked(): Promise<ExtensionStoreSnapshot | null> {
    let content: string;
    try {
      content = await fsp.readFile(this.statePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return parseState(content, this.statePath);
  }

  private async readLegacyProjection(): Promise<AllExtensionsEnablementConfig> {
    try {
      const projection: unknown = JSON.parse(
        await fsp.readFile(this.enablementPath, 'utf8'),
      );
      if (!validLegacyProjection(projection)) {
        throw new ExtensionStoreCorruptError(
          `Extension enablement projection has an invalid schema at ${this.enablementPath}.`,
        );
      }
      return projection;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      if (error instanceof SyntaxError) {
        throw new ExtensionStoreCorruptError(
          `Extension enablement projection is corrupt at ${this.enablementPath}.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private buildLegacyProjection(
    snapshot: ExtensionStoreSnapshot,
  ): AllExtensionsEnablementConfig {
    const projection = Object.create(null) as AllExtensionsEnablementConfig;
    const representedNames = new Set(
      Object.values(snapshot.extensions).map((policy) =>
        policy.name.toLowerCase(),
      ),
    );
    for (const [name, config] of Object.entries(
      snapshot.legacyProjectionRemainder ?? {},
    )) {
      if (representedNames.has(name.toLowerCase())) continue;
      projection[name] = { overrides: [...config.overrides] };
    }
    for (const policy of Object.values(snapshot.extensions)) {
      const overrides: string[] = [];
      if (policy.defaultActivation === 'disabled') overrides.push('!/*');
      overrides.push(...(policy.legacyPathRules ?? []));
      for (const [workspacePath, activation] of Object.entries(
        policy.workspaceOverrides,
      )) {
        const effective =
          activation === 'inherit' ? policy.defaultActivation : activation;
        overrides.push(
          Override.fromInput(
            effective === 'disabled' ? `!${workspacePath}` : workspacePath,
            false,
          ).output(),
        );
      }
      if (overrides.length > 0) projection[policy.name] = { overrides };
    }
    return projection;
  }

  private updateLegacyProjectionRemainder(
    snapshot: ExtensionStoreSnapshot,
    legacy: AllExtensionsEnablementConfig,
  ): boolean {
    const representedNames = new Set(
      Object.values(snapshot.extensions).map((policy) =>
        policy.name.toLowerCase(),
      ),
    );
    const remainder = Object.create(null) as AllExtensionsEnablementConfig;
    for (const [name, config] of Object.entries(legacy)) {
      if (representedNames.has(name.toLowerCase())) continue;
      remainder[name] = { overrides: [...config.overrides] };
    }
    const previous = snapshot.legacyProjectionRemainder ?? {};
    if (Object.keys(remainder).length > 0) {
      snapshot.legacyProjectionRemainder = remainder;
    } else {
      delete snapshot.legacyProjectionRemainder;
    }
    return projectionHash(previous) !== projectionHash(remainder);
  }

  private importLegacyProjection(
    incomingRules: readonly string[],
    policy: ExtensionPolicy | undefined,
  ): { rules: string[]; activationChanged: boolean } {
    if (!policy) return { rules: [...incomingRules], activationChanged: false };
    const generatedRules: Array<{
      rule: Override;
      workspacePath?: string;
    }> = [];
    if (policy.defaultActivation === 'disabled') {
      generatedRules.push({
        rule: Override.fromFileRule('!/*'),
      });
    }
    for (const [workspacePath, activation] of Object.entries(
      policy.workspaceOverrides,
    )) {
      const effective =
        activation === 'inherit' ? policy.defaultActivation : activation;
      generatedRules.push({
        rule: Override.fromInput(
          effective === 'disabled' ? `!${workspacePath}` : workspacePath,
          false,
        ),
        workspacePath,
      });
    }
    let activationChanged = false;
    const consumed = new Set<number>();
    const rules = incomingRules.filter((rule) => {
      const incoming = Override.fromFileRule(rule);
      const exactIndex = generatedRules.findIndex(
        (generated, index) =>
          !consumed.has(index) && generated.rule.isEqualTo(incoming),
      );
      if (exactIndex >= 0) {
        consumed.add(exactIndex);
        return false;
      }
      const oppositeIndex = generatedRules.findIndex(
        (generated, index) =>
          !consumed.has(index) &&
          generated.rule.baseRule === incoming.baseRule &&
          generated.rule.includeSubdirs === incoming.includeSubdirs &&
          generated.rule.isDisable !== incoming.isDisable,
      );
      if (oppositeIndex < 0) return true;
      consumed.add(oppositeIndex);
      const opposite = generatedRules[oppositeIndex];
      if (opposite.workspacePath) {
        policy.workspaceOverrides[opposite.workspacePath] = incoming.isDisable
          ? 'disabled'
          : 'enabled';
      } else {
        policy.defaultActivation = 'enabled';
      }
      activationChanged = true;
      return false;
    });
    return { rules, activationChanged };
  }

  private async writeSnapshotUnlocked(
    snapshot: ExtensionStoreSnapshot,
  ): Promise<void> {
    await this.prepareDirectories();
    const projection = this.buildLegacyProjection(snapshot);
    snapshot.legacyProjectionHash = projectionHash(projection);
    try {
      const previous = parseState(
        await fsp.readFile(this.statePath, 'utf8'),
        this.statePath,
      );
      await atomicWriteJSON(this.previousStatePath, previous, {
        mode: 0o600,
        forceMode: true,
        noFollow: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await atomicWriteJSON(this.statePath, snapshot, {
      mode: 0o600,
      forceMode: true,
      noFollow: true,
    });
    try {
      await this.writeLegacyProjectionUnlocked(snapshot, projection);
    } catch {
      // state.json is the commit point. A later V2-aware store access repairs
      // a stale projection instead of reporting a mutation failure after the
      // authoritative state has already changed.
    }
  }

  private async writeLegacyProjectionUnlocked(
    snapshot: ExtensionStoreSnapshot,
    projection = this.buildLegacyProjection(snapshot),
  ): Promise<void> {
    await atomicWriteJSON(this.enablementPath, projection, {
      mode: 0o600,
      forceMode: true,
      noFollow: true,
    });
  }

  private async legacyProjectionIsNewerThanState(): Promise<boolean> {
    try {
      const [state, projection] = await Promise.all([
        fsp.stat(this.statePath, { bigint: true }),
        fsp.stat(this.enablementPath, { bigint: true }),
      ]);
      if (projection.mtimeNs === state.mtimeNs) {
        throw new ExtensionStoreCorruptError(
          `Extension store state and projection disagree at the same timestamp in ${this.storeDir}.`,
        );
      }
      return projection.mtimeNs > state.mtimeNs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async prepareDirectories(): Promise<void> {
    await fsp.mkdir(this.extensionsDir, { recursive: true, mode: 0o700 });
    await fsp.mkdir(this.storeDir, { recursive: true, mode: 0o700 });
    const privateDirectories = [
      this.storeDir,
      ...['staging', 'rollback', 'transactions'].map((directory) =>
        path.join(this.storeDir, directory),
      ),
    ];
    await Promise.all(
      privateDirectories.slice(1).map((directory) =>
        fsp.mkdir(directory, {
          recursive: true,
          mode: 0o700,
        }),
      ),
    );
    await Promise.all(
      privateDirectories.map((directory) => fsp.chmod(directory, 0o700)),
    );
    const handle = await fsp.open(this.lockPath, 'a', 0o600);
    try {
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
  }

  private async withLock<T>(run: () => Promise<T>): Promise<T> {
    return await getStoreMutex(this.storeDir).runExclusive(async () => {
      await this.prepareDirectories();
      let release: () => Promise<void>;
      try {
        release = await lockfile.lock(this.lockPath, {
          stale: 60_000,
          update: 5_000,
          retries: {
            retries: 60,
            factor: 1.2,
            minTimeout: 50,
            maxTimeout: 500,
            randomize: true,
          },
          onCompromised: (err) => {
            debugLogger.warn('extension store lock compromised:', err);
          },
        });
      } catch (error) {
        throw new ExtensionStoreBusyError(this.storeDir, { cause: error });
      }
      try {
        await this.recoverCorruptStateUnlocked();
        await this.recoverTransactionsUnlocked();
        return await run();
      } finally {
        try {
          await release();
        } catch (error) {
          debugLogger.warn('Failed to release extension store lock:', error);
        }
      }
    });
  }

  private assertArtifactPaths(input: CommitExtensionArtifactInput): void {
    this.assertArtifactDestination(input.destinationDirectory);
    if (input.operation === 'uninstall') {
      if (input.stagingDirectory !== undefined) {
        throw new Error('Uninstall does not accept a staging directory.');
      }
      return;
    }
    if (!input.stagingDirectory) {
      throw new Error(`${input.operation} requires a staging directory.`);
    }
    const stagingRoot = path.resolve(this.storeDir, 'staging');
    const staging = path.resolve(input.stagingDirectory);
    if (path.dirname(staging) !== stagingRoot) {
      throw new Error('Extension staging directory is outside the store.');
    }
  }

  private assertArtifactDestination(destinationDirectory: string): void {
    const extensionsRoot = path.resolve(this.extensionsDir);
    const destination = path.resolve(destinationDirectory);
    if (
      path.dirname(destination) !== extensionsRoot ||
      destination === extensionsRoot
    ) {
      throw new Error('Extension destination must be a direct child.');
    }
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fsp.access(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async recoverTransactionsUnlocked(): Promise<void> {
    const transactionsDir = path.join(this.storeDir, 'transactions');
    const names = await fsp.readdir(transactionsDir);
    const snapshot = await this.readSnapshotUnlocked();
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const journalPath = path.join(transactionsDir, name);
      const journal = await this.readRecoverableJournalUnlocked(journalPath);
      if (!journal) continue;
      if (
        journal.phase === 'state_committed' ||
        (snapshot?.generation ?? -1) >= journal.targetGeneration
      ) {
        try {
          await this.cleanupCommittedJournal(journal, journalPath);
        } catch {
          // The authoritative state is already committed. Keep the journal so
          // a later store operation can retry cleanup without blocking reads
          // or unrelated mutations.
        }
      } else {
        await this.rollbackJournal(journal);
        await fsp.rm(journalPath, { force: true });
      }
    }
  }

  private async recoverCorruptStateUnlocked(): Promise<void> {
    let stateMissing = false;
    try {
      const snapshot = await this.readSnapshotUnlocked();
      if (snapshot) return;
      stateMissing = true;
    } catch (error) {
      if (!(error instanceof ExtensionStoreCorruptError)) throw error;
    }

    const candidates: Array<{
      snapshot: ExtensionStoreSnapshot;
      recoveryGeneration: number;
    }> = [];
    const transactionsDir = path.join(this.storeDir, 'transactions');
    for (const name of await fsp.readdir(transactionsDir)) {
      if (!name.endsWith('.json')) continue;
      const journal = await this.readRecoverableJournalUnlocked(
        path.join(transactionsDir, name),
      );
      if (journal?.phase === 'state_committed') {
        candidates.push({
          snapshot: journal.targetSnapshot,
          recoveryGeneration: journal.targetGeneration,
        });
      }
    }

    let backupError: unknown;
    try {
      const previous = parseState(
        await fsp.readFile(this.previousStatePath, 'utf8'),
        this.previousStatePath,
      );
      candidates.push({
        snapshot: previous,
        recoveryGeneration: previous.generation,
      });
    } catch (error) {
      backupError = error;
    }

    const latest = candidates.sort(
      (left, right) => right.recoveryGeneration - left.recoveryGeneration,
    )[0];
    if (latest) {
      const recovered = {
        ...latest.snapshot,
        generation: latest.recoveryGeneration,
      };
      await atomicWriteJSON(this.statePath, recovered, {
        mode: 0o600,
        forceMode: true,
        noFollow: true,
      });
      await this.writeLegacyProjectionUnlocked(recovered);
      return;
    }
    if (
      stateMissing &&
      (backupError as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
    ) {
      return;
    }
    throw new ExtensionStoreCorruptError(
      `Extension store state and recovery data are corrupt at ${this.storeDir}.`,
      { cause: backupError },
    );
  }

  private async readJournalUnlocked(
    journalPath: string,
  ): Promise<ExtensionTransactionJournal> {
    try {
      const journal = JSON.parse(
        await fsp.readFile(journalPath, 'utf8'),
      ) as ExtensionTransactionJournal;
      if (
        journal.version !== 1 ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(journal.transactionId) ||
        !['install', 'update', 'uninstall'].includes(journal.operation) ||
        !['prepared', 'artifact_swapped', 'state_committed'].includes(
          journal.phase,
        ) ||
        !Number.isSafeInteger(journal.previousGeneration) ||
        journal.targetGeneration !== journal.previousGeneration + 1
      ) {
        throw new Error('invalid transaction journal schema');
      }
      journal.targetSnapshot = parseState(
        JSON.stringify(journal.targetSnapshot),
        journalPath,
      );
      if (journal.targetSnapshot.generation !== journal.targetGeneration) {
        throw new Error('transaction target generation does not match');
      }
      this.assertRecoveredJournalPaths(journal, journalPath);
      return journal;
    } catch (error) {
      if (error instanceof ExtensionStoreCorruptError) throw error;
      throw new ExtensionStoreCorruptError(
        `Extension transaction journal is corrupt at ${journalPath}.`,
        { cause: error },
      );
    }
  }

  private async readRecoverableJournalUnlocked(
    journalPath: string,
  ): Promise<ExtensionTransactionJournal | undefined> {
    try {
      return await this.readJournalUnlocked(journalPath);
    } catch (error) {
      if (!(error instanceof ExtensionStoreCorruptError)) throw error;
      const quarantinePath = `${journalPath}.corrupt-${crypto.randomUUID()}`;
      try {
        await fsp.rename(journalPath, quarantinePath);
      } catch (quarantineError) {
        throw new ExtensionStoreCorruptError(
          `Extension transaction journal is corrupt and could not be quarantined at ${journalPath}.`,
          {
            cause: new AggregateError([error, quarantineError]),
          },
        );
      }
      debugLogger.warn(
        `Quarantined corrupt extension transaction journal at ${quarantinePath}:`,
        error,
      );
      return undefined;
    }
  }

  private assertRecoveredJournalPaths(
    journal: ExtensionTransactionJournal,
    journalPath: string,
  ): void {
    const extensionsRoot = path.resolve(this.extensionsDir);
    const rollbackRoot = path.resolve(this.storeDir, 'rollback');
    const stagingRoot = path.resolve(this.storeDir, 'staging');
    const transactionsRoot = path.resolve(this.storeDir, 'transactions');
    if (
      path.dirname(path.resolve(journalPath)) !== transactionsRoot ||
      path.basename(journalPath) !== `${journal.transactionId}.json` ||
      path.dirname(path.resolve(journal.destinationDirectory)) !==
        extensionsRoot ||
      path.dirname(path.resolve(journal.backupDirectory)) !== rollbackRoot ||
      (journal.stagingDirectory !== undefined &&
        path.dirname(path.resolve(journal.stagingDirectory)) !== stagingRoot) ||
      (journal.operation === 'uninstall' &&
        journal.stagingDirectory !== undefined) ||
      (journal.operation !== 'uninstall' && !journal.stagingDirectory)
    ) {
      throw new UnsafeRecoveredJournalError(
        `Extension transaction ${journal.transactionId} contains unsafe paths.`,
      );
    }
  }

  private async rollbackJournal(
    journal: ExtensionTransactionJournal,
  ): Promise<void> {
    const hasBackup = await this.pathExists(journal.backupDirectory);
    if (
      hasBackup ||
      (journal.operation === 'install' &&
        !(journal.stagingDirectory
          ? await this.pathExists(journal.stagingDirectory)
          : false))
    ) {
      await fsp.rm(journal.destinationDirectory, {
        recursive: true,
        force: true,
      });
    }
    if (hasBackup) {
      await renameWithRetry(
        journal.backupDirectory,
        journal.destinationDirectory,
        3,
        50,
      );
    }
    if (journal.stagingDirectory) {
      await fsp.rm(journal.stagingDirectory, {
        recursive: true,
        force: true,
      });
    }
  }

  private async cleanupCommittedJournal(
    journal: ExtensionTransactionJournal,
    journalPath: string,
  ): Promise<void> {
    await fsp.rm(journal.backupDirectory, {
      recursive: true,
      force: true,
    });
    if (journal.stagingDirectory) {
      await fsp.rm(journal.stagingDirectory, {
        recursive: true,
        force: true,
      });
    }
    await fsp.rm(journalPath, { force: true });
  }
}
