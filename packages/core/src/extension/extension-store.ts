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
  artifactGeneration?: number;
  defaultActivation: ExtensionActivation;
  workspaceOverrides: Record<string, WorkspaceActivation>;
  legacyPathRules?: string[];
}

export interface ExtensionStoreSnapshot {
  version: 2;
  generation: number;
  legacyProjectionHash: string;
  extensions: Record<string, ExtensionPolicy>;
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

function assertIdentity(identity: ExtensionIdentity): void {
  if (!/^[a-f0-9]{64}$/.test(identity.id)) {
    throw new Error(`Invalid extension id "${identity.id}".`);
  }
  if (!/^[a-zA-Z0-9-_.]+$/.test(identity.name)) {
    throw new Error('Invalid extension name.');
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
      (parsed.artifactGeneration === undefined ||
        (Number.isSafeInteger(parsed.artifactGeneration) &&
          parsed.artifactGeneration >= 0)) &&
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
    const existing = await this.readSnapshotUnlocked();
    const legacy = await this.readLegacyProjection();
    if (existing) {
      let changed = false;
      if (existing.legacyProjectionHash !== projectionHash(legacy)) {
        if (!(await this.legacyProjectionIsNewerThanState())) {
          try {
            await this.writeLegacyProjectionUnlocked(existing);
          } catch {
            // state.json remains authoritative; a later access retries repair.
          }
          return existing;
        }
        for (const identity of extensions) {
          assertIdentity(identity);
          const rules = legacy[identity.name]?.overrides ?? [];
          const existingPolicy = existing.extensions[identity.id];
          if (existingPolicy) {
            const previousRules = existingPolicy.legacyPathRules ?? [];
            const policyChanged =
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
      } else {
        for (const identity of extensions) {
          assertIdentity(identity);
          if (existing.extensions[identity.id]) continue;
          const rules = legacy[identity.name]?.overrides ?? [];
          existing.extensions[identity.id] = {
            name: identity.name,
            defaultActivation: 'enabled',
            workspaceOverrides: {},
            ...(rules.length > 0 ? { legacyPathRules: [...rules] } : {}),
          };
          changed = true;
        }
      }
      if (changed) {
        existing.generation += 1;
        await this.writeSnapshotUnlocked(existing);
      }
      return existing;
    }
    const policies: Record<string, ExtensionPolicy> = {};
    for (const identity of extensions) {
      assertIdentity(identity);
      const rules = legacy[identity.name]?.overrides ?? [];
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
      const destinationExists = await this.pathExists(
        input.destinationDirectory,
      );
      if (input.operation === 'install' && destinationExists) {
        throw new ExtensionConflictError(
          `Extension "${input.identity.name}" is installed.`,
        );
      }
      if (input.operation !== 'install' && !destinationExists) {
        throw new ExtensionConflictError(
          `Extension "${input.identity.name}" is not installed.`,
        );
      }
      if (input.operation === 'install' && !input.initialActivation) {
        throw new Error('Install requires an initial activation.');
      }
      if (input.operation !== 'uninstall') {
        const nameConflict = Object.entries(snapshot.extensions).find(
          ([extensionId, policy]) =>
            extensionId !== input.identity.id &&
            policy.name.toLowerCase() === input.identity.name.toLowerCase(),
        );
        if (nameConflict) {
          throw new ExtensionConflictError(
            `Extension name "${input.identity.name}" conflicts with an installed extension.`,
          );
        }
      }

      const currentPolicy = snapshot.extensions[input.identity.id];
      if (input.operation === 'install' && currentPolicy) {
        throw new ExtensionConflictError(
          `Extension id ${input.identity.id} is already installed.`,
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
        const initial = input.initialActivation!;
        targetSnapshot.extensions[input.identity.id] = {
          name: input.identity.name,
          artifactGeneration: targetSnapshot.generation + 1,
          defaultActivation: initial.scope === 'user' ? 'enabled' : 'disabled',
          workspaceOverrides:
            initial.scope === 'workspace'
              ? {
                  [canonicalizeWorkspacePath(initial.workspacePath)]: 'enabled',
                }
              : {},
        };
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
        targetSnapshot.extensions[input.identity.id]!.artifactGeneration =
          targetSnapshot.generation + 1;
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
        destinationDirectory: input.destinationDirectory,
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
          await renameWithRetry(
            input.destinationDirectory,
            backupDirectory,
            3,
            50,
          );
        }
        if (input.operation !== 'uninstall') {
          await renameWithRetry(
            input.stagingDirectory!,
            input.destinationDirectory,
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
          await this.rollbackJournal(journal);
          await fsp.rm(journalPath, { force: true });
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
    const candidate = normalizeRulePath(canonicalWorkspace);
    for (const rule of policy.legacyPathRules ?? []) {
      const override = Override.fromFileRule(rule);
      if (!override.matchesPath(candidate)) continue;
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

  async clearWorkspaceActivation(
    identity: ExtensionIdentity,
    workspacePath: string,
  ): Promise<ExtensionStoreSnapshot> {
    return await this.mutate(identity, (policy) => {
      const canonicalWorkspace = canonicalizeWorkspacePath(workspacePath);
      const candidate = normalizeRulePath(canonicalWorkspace);
      const legacyMatches = (policy.legacyPathRules ?? []).some((rule) =>
        Override.fromFileRule(rule).matchesPath(candidate),
      );
      if (legacyMatches) {
        policy.workspaceOverrides[canonicalWorkspace] = 'inherit';
      } else {
        delete policy.workspaceOverrides[canonicalWorkspace];
      }
    });
  }

  async setLegacyPathActivation(
    identity: ExtensionIdentity,
    scopePath: string,
    activation: ExtensionActivation,
  ): Promise<ExtensionStoreSnapshot> {
    const canonicalScope = canonicalizeWorkspacePath(scopePath);
    return await this.mutate(identity, (policy) => {
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
      const policy = snapshot.extensions[identity.id] ?? {
        name: identity.name,
        defaultActivation: 'enabled' as const,
        workspaceOverrides: {},
        ...this.legacyRulesFor(identity.name),
      };
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

  private legacyRulesFor(
    extensionName: string,
  ): Pick<ExtensionPolicy, 'legacyPathRules'> | Record<string, never> {
    try {
      const legacy = JSON.parse(
        fs.readFileSync(this.enablementPath, 'utf8'),
      ) as AllExtensionsEnablementConfig;
      const rules = legacy[extensionName]?.overrides;
      return rules?.length ? { legacyPathRules: [...rules] } : {};
    } catch {
      return {};
    }
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
      return JSON.parse(
        await fsp.readFile(this.enablementPath, 'utf8'),
      ) as AllExtensionsEnablementConfig;
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
    const extensionsRoot = path.resolve(this.extensionsDir);
    const destination = path.resolve(input.destinationDirectory);
    if (
      path.dirname(destination) !== extensionsRoot ||
      destination === extensionsRoot
    ) {
      throw new Error('Extension destination must be a direct child.');
    }
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
        recoveryGeneration: previous.generation + 1,
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
      if (
        !(error instanceof ExtensionStoreCorruptError) ||
        error instanceof UnsafeRecoveredJournalError
      ) {
        throw error;
      }
      const quarantinePath = `${journalPath}.${crypto.randomUUID()}.corrupt`;
      await renameWithRetry(journalPath, quarantinePath, 3, 50);
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
