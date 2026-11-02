/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Application } from 'express';
import { minimatch } from 'minimatch';
import {
  parseManagedExtensionApplyCommand,
  parseManagedExtensionPins,
  parseManagedExtensionPin,
  type ManagedExtensionApplyCommand,
  type ManagedExtensionPin,
  type ManagedExtensionMcpPin,
  type ManagedExtensionPrepareResult,
  type ManagedExtensionRuntimeControl,
  type ManagedExtensionPreparedPackage,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-package.js';
import type { ManagedHookCatalogPin } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import type { ManagedPackageContributions } from '@qwen-code/qwen-code-core/extension/managed-package.js';
import { atomicWriteJSON } from '@qwen-code/qwen-code-core/utils/atomicFileWrite.js';
import {
  authorizeManagedRuntime,
  managedRuntimeJsonBody,
  managedRuntimeNoStore,
  type ManagedRuntimeRequestIdentity,
} from './managed-runtime-attestation-contract.js';
import { ManagedExtensionCache } from './managed-extension-cache.js';

export const MANAGED_EXTENSION_RUNTIME_ROUTE = Object.freeze({
  key: 'extensions',
  method: 'POST',
  path: '/internal/managed-runtime/v3/extensions',
});
export const MANAGED_EXTENSION_RETIRE_ROUTE = Object.freeze({
  key: 'extension-retire',
  method: 'POST',
  path: '/internal/managed-runtime/v3/extensions/retire',
});
export const MANAGED_EXTENSION_UPLOAD_ROUTE = Object.freeze({
  key: 'extension-package-upload',
  method: 'PUT',
  path: '/internal/managed-runtime/v3/extensions/packages/:digest',
});

export type ManagedRuntimeExtensionPackage = ManagedExtensionPreparedPackage;

export interface ManagedExtensionRuntimeState {
  readonly state: 'active' | 'failed' | 'outcome_unknown';
  readonly executionMode: 'linux-cgroup' | 'developer-process-group';
  readonly revision: number;
  readonly extensions: readonly ManagedExtensionPin[];
  readonly operationId: string | null;
  readonly pendingOperationId?: string;
}

interface Prepared {
  readonly ownerJournalId: string;
  readonly base: {
    readonly baseMcpServers: readonly ManagedExtensionMcpPin[];
    readonly baseHookCatalog: ManagedHookCatalogPin | null;
  };
  readonly mcpServers: readonly ManagedExtensionMcpPin[];
  readonly hookCatalog: ManagedHookCatalogPin | null;
  readonly command: ManagedExtensionApplyCommand;
  readonly packages: readonly ManagedRuntimeExtensionPackage[];
}

export interface ManagedExtensionRuntimeDependencies {
  readonly ownerJournalId?: string;
  readonly executionMode: 'linux-cgroup' | 'developer-process-group';
  readonly directory: string;
  readonly bindContext?: (
    sessionId: string,
    contextBinding: unknown,
  ) => Promise<void>;
  readonly admitted: (sessionId: string) => Promise<boolean>;
  readonly idle: (sessionId: string) => boolean;
  readonly compile: (
    directory: string,
    pin: ManagedExtensionPin,
    environment: Readonly<Record<string, string>>,
    sessionId: string,
    publishedManifest?: unknown,
  ) => Promise<ManagedPackageContributions>;
  readonly stage?: (
    sessionId: string,
    command: ManagedExtensionApplyCommand,
    packages: readonly ManagedRuntimeExtensionPackage[],
    base: {
      baseMcpServers: readonly ManagedExtensionMcpPin[];
      baseHookCatalog: ManagedHookCatalogPin | null;
      preparedMcpServers?: readonly ManagedExtensionMcpPin[];
    },
  ) => Promise<{
    mcpServers: readonly ManagedExtensionMcpPin[];
    hookCatalog: ManagedHookCatalogPin | null;
  }>;
  // This is Session scoped: closing the Runtime would also stop its siblings.
  readonly drain: (
    sessionId: string,
    command: ManagedExtensionApplyCommand,
  ) => Promise<void>;
  readonly reconcile?: (
    sessionId: string,
  ) => Promise<
    ReadonlyArray<
      import('./managed-extension-process.js').ManagedExtensionProcessReceipt
    >
  >;
  readonly install: (
    sessionId: string,
    packages: readonly ManagedRuntimeExtensionPackage[],
    command: ManagedExtensionApplyCommand,
  ) => Promise<void>;
}

export class ManagedExtensionRuntime {
  readonly cache: ManagedExtensionCache;
  private readonly prepared = new Map<string, Prepared>();
  private readonly active = new Map<string, Prepared>();
  private readonly busy = new Set<string>();
  private readonly environments = new Map<
    string,
    Readonly<Record<string, Readonly<Record<string, string>>>>
  >();
  private readonly sessionOwners = new Map<string, string>();
  private readonly ownerSessions = new Map<string, string>();

  constructor(
    private readonly dependencies: ManagedExtensionRuntimeDependencies,
  ) {
    if (!path.isAbsolute(dependencies.directory))
      throw new Error('Invalid extension Runtime directory.');
    this.cache = new ManagedExtensionCache(
      path.join(dependencies.directory, 'packages'),
    );
  }

  async status(sessionId: string): Promise<ManagedExtensionRuntimeState> {
    await this.requireSession(sessionId);
    let pendingOperationId: string | undefined;
    try {
      pendingOperationId = parseManagedExtensionApplyCommand(
        JSON.parse(
          await fs.readFile(this.pendingPath(sessionId), 'utf8'),
        ) as unknown,
      ).operationId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const pending = pendingOperationId ? { pendingOperationId } : {};
    const installed = this.active.get(sessionId);
    if (installed) return { ...this.state(installed.command), ...pending };
    try {
      const stored = JSON.parse(
        await fs.readFile(this.statePath(sessionId), 'utf8'),
      ) as unknown;
      const command = parseManagedExtensionApplyCommand(stored);
      const stopped = await fs
        .stat(`${this.operationPath(sessionId, command.operationId)}.stopped`)
        .then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        );
      return {
        ...this.state(command),
        ...(stopped ? { state: 'failed' as const } : {}),
        ...pending,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return {
          state: pendingOperationId ? 'outcome_unknown' : 'active',
          executionMode: this.dependencies.executionMode,
          revision: 0,
          extensions: [],
          operationId: null,
          ...pending,
        };
      throw error;
    }
  }

  async operationStatus(sessionId: string, operationId: string) {
    const current = await this.status(sessionId);
    try {
      const proof = JSON.parse(
        await fs.readFile(
          `${this.operationPath(sessionId, operationId)}.stopped`,
          'utf8',
        ),
      ) as Record<string, unknown>;
      if (
        proof['operationId'] !== operationId ||
        proof['executionMode'] !== this.dependencies.executionMode ||
        proof['state'] !== 'stopped'
      )
        throw new Error('Original stop proof conflicts.');
      return proof;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (current.operationId === operationId && !current.pendingOperationId)
      return current;
    const prepared =
      this.prepared.get(this.preparedKey(sessionId, operationId)) ??
      (await this.loadPrepared(sessionId, operationId));
    if (prepared && !current.pendingOperationId)
      return this.preparedView(prepared);
    return { ...current, state: 'outcome_unknown' as const, operationId };
  }

  async prepare(
    sessionId: string,
    value: unknown,
    base: {
      baseMcpServers: readonly ManagedExtensionMcpPin[];
      baseHookCatalog: ManagedHookCatalogPin | null;
      settings?: Readonly<Record<string, Readonly<Record<string, string>>>>;
      toolProfile?: string;
      packageManifests?: Readonly<Record<string, unknown>>;
    } = { baseMcpServers: [], baseHookCatalog: null },
  ): Promise<ManagedExtensionPrepareResult> {
    const command = parseManagedExtensionApplyCommand(value);
    return this.lock(sessionId, async () => {
      const status = await this.status(sessionId);
      const key = this.preparedKey(sessionId, command.operationId);
      const existing =
        this.prepared.get(key) ??
        (await this.loadPrepared(sessionId, command.operationId));
      const publicBase = {
        baseMcpServers: base.baseMcpServers,
        baseHookCatalog: base.baseHookCatalog,
      };
      if (existing) {
        if (
          JSON.stringify(existing.command) !== JSON.stringify(command) ||
          JSON.stringify(existing.base) !== JSON.stringify(publicBase)
        )
          throw new Error('Extension operation identity conflicts.');
        for (const pkg of existing.packages) {
          await this.cache.restoreMaterialized(
            pkg.pin.packageDigest,
            pkg.assetRoot,
          );
          const contributions = await this.dependencies.compile(
            pkg.assetRoot,
            pkg.pin,
            base.settings?.[pkg.pin.extensionId] ?? {},
            sessionId,
            base.packageManifests?.[pkg.pin.extensionId],
          );
          validateExtensionToolProfile(contributions, base.toolProfile);
          if (
            JSON.stringify(contributions) !== JSON.stringify(pkg.contributions)
          )
            throw new Error('Prepared extension package drifted.');
        }
        const catalogs = this.dependencies.stage
          ? await this.dependencies.stage(
              sessionId,
              command,
              existing.packages,
              { ...publicBase, preparedMcpServers: existing.mcpServers },
            )
          : { mcpServers: [], hookCatalog: null };
        if (
          JSON.stringify(catalogs.mcpServers) !==
            JSON.stringify(existing.mcpServers) ||
          JSON.stringify(catalogs.hookCatalog) !==
            JSON.stringify(existing.hookCatalog)
        )
          throw new Error('Prepared extension catalogs drifted.');
        this.environments.set(key, base.settings ?? {});
        this.prepared.set(key, existing);
        return this.preparedView(existing);
      }
      if (status.pendingOperationId)
        throw new Error('Original extension activation outcome is unknown.');
      if (status.revision !== command.expectedRevision)
        throw new Error('Extension configuration revision conflicts.');
      if (!this.dependencies.idle(sessionId))
        throw new Error('Extension configuration requires an idle Session.');
      const packages: ManagedRuntimeExtensionPackage[] = [];
      try {
        for (const pin of command.extensions) {
          const unchanged = this.active
            .get(sessionId)
            ?.packages.find(
              (entry) => JSON.stringify(entry.pin) === JSON.stringify(pin),
            );
          const assetRoot =
            unchanged?.assetRoot ??
            (await this.cache.materialize(pin.packageDigest));
          await this.cache.restoreMaterialized(pin.packageDigest, assetRoot);
          packages.push({
            pin,
            assetRoot,
            contributions: {
              skills: [],
              commands: [],
              agents: [],
              context: [],
              mcpServers: {},
              hooks: {},
              settings: [],
            },
          });
          const contributions = await this.dependencies.compile(
            assetRoot,
            pin,
            base.settings?.[pin.extensionId] ?? {},
            sessionId,
            base.packageManifests?.[pin.extensionId],
          );
          validateExtensionToolProfile(contributions, base.toolProfile);
          packages[packages.length - 1] = { pin, assetRoot, contributions };
        }
      } catch (error) {
        await Promise.all(
          packages.map((entry) =>
            this.active
              .get(sessionId)
              ?.packages.some((active) => active.assetRoot === entry.assetRoot)
              ? Promise.resolve()
              : fs.rm(entry.assetRoot, { recursive: true, force: true }),
          ),
        );
        throw error;
      }
      const catalogs = this.dependencies.stage
        ? await this.dependencies.stage(sessionId, command, packages, base)
        : { mcpServers: [], hookCatalog: null };
      if (
        !this.dependencies.stage &&
        packages.some(
          (entry) =>
            Object.keys(entry.contributions.mcpServers).length ||
            Object.keys(entry.contributions.hooks).length,
        )
      )
        throw new Error('Extension process components are unsupported.');
      const prepared: Prepared = {
        ownerJournalId: this.dependencies.ownerJournalId ?? 'in-memory',
        command,
        packages,
        base: publicBase,
        mcpServers: catalogs.mcpServers,
        hookCatalog: catalogs.hookCatalog,
      };
      const view = this.preparedView(prepared);
      await fs.mkdir(
        path.dirname(this.operationPath(sessionId, command.operationId)),
        { recursive: true, mode: 0o700 },
      );
      await atomicWriteJSON(
        this.operationPath(sessionId, command.operationId),
        prepared,
        { mode: 0o600 },
      );
      this.environments.set(key, base.settings ?? {});
      this.prepared.set(key, prepared);
      return view;
    });
  }

  async reconcile(
    sessionId: string,
    operationId: string,
    expectedRevision: number,
    revision: number,
  ) {
    return this.lock(sessionId, async () => {
      const prepared = await this.loadPrepared(sessionId, operationId);
      if (!prepared)
        throw new Error('Original extension owner journal is unavailable.');
      try {
        const proof = JSON.parse(
          await fs.readFile(
            `${this.operationPath(sessionId, operationId)}.stopped`,
            'utf8',
          ),
        ) as Record<string, unknown>;
        if (
          proof['operationId'] !== operationId ||
          proof['revision'] !== revision ||
          expectedRevision + 1 !== revision ||
          proof['executionMode'] !== this.dependencies.executionMode ||
          proof['state'] !== 'stopped'
        )
          throw new Error('Original stop proof conflicts.');
        return proof;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const command = prepared.command;
      const current = await this.status(sessionId);
      if (
        command.operationId !== operationId ||
        command.expectedRevision !== expectedRevision ||
        revision !== expectedRevision + 1 ||
        (current.pendingOperationId !== undefined &&
          current.pendingOperationId !== operationId) ||
        (current.revision !== expectedRevision &&
          (current.operationId !== operationId ||
            current.revision !== revision ||
            JSON.stringify(current.extensions) !==
              JSON.stringify(command.extensions)))
      )
        throw new Error('Original extension operation conflicts.');
      const receipts = this.dependencies.reconcile
        ? await this.dependencies.reconcile(sessionId)
        : undefined;
      if (
        !receipts ||
        receipts.length === 0 ||
        receipts.some((entry) => entry.state !== 'stopped')
      )
        return {
          operationId,
          revision,
          state: 'outcome_unknown',
          executionMode: this.dependencies.executionMode,
        };
      const proof = {
        operationId,
        revision,
        state: 'stopped' as const,
        executionMode: this.dependencies.executionMode,
        receipts,
      };
      await atomicWriteJSON(
        `${this.operationPath(sessionId, operationId)}.stopped`,
        proof,
        { mode: 0o600 },
      );
      await atomicWriteJSON(this.statePath(sessionId), command, {
        mode: 0o600,
      });
      this.active.delete(sessionId);
      await fs.rm(this.pendingPath(sessionId), { force: true });
      return proof;
    });
  }

  async activate(
    sessionId: string,
    operationId: string,
  ): Promise<ManagedExtensionRuntimeState> {
    return this.lock(sessionId, async () => {
      const status = await this.status(sessionId);
      if (status.pendingOperationId)
        throw new Error('Original extension activation outcome is unknown.');
      if (status.operationId === operationId) {
        if (!this.active.has(sessionId)) {
          const restored = this.prepared.get(
            this.preparedKey(sessionId, operationId),
          );
          if (!restored)
            throw new Error(
              'Active extension configuration requires exact reprepare.',
            );
          await this.dependencies.install(
            sessionId,
            restored.packages,
            restored.command,
          );
          this.active.set(sessionId, restored);
        }
        return status;
      }
      const prepared = this.prepared.get(
        this.preparedKey(sessionId, operationId),
      );
      if (!prepared || status.revision !== prepared.command.expectedRevision)
        throw new Error('Extension configuration was not prepared.');
      if (!this.dependencies.idle(sessionId))
        throw new Error('Extension configuration requires an idle Session.');
      await fs.mkdir(path.dirname(this.statePath(sessionId)), {
        recursive: true,
        mode: 0o700,
      });
      await atomicWriteJSON(this.pendingPath(sessionId), prepared.command, {
        mode: 0o600,
      });
      await this.dependencies.drain(sessionId, prepared.command);
      await this.requireSession(sessionId);
      if (!this.dependencies.idle(sessionId))
        throw new Error('Extension Session acquired work while draining.');
      await this.dependencies.install(
        sessionId,
        prepared.packages,
        prepared.command,
      );
      await fs.mkdir(path.dirname(this.statePath(sessionId)), {
        recursive: true,
        mode: 0o700,
      });
      await atomicWriteJSON(this.statePath(sessionId), prepared.command, {
        mode: 0o600,
      });
      this.active.set(sessionId, prepared);
      await fs.rm(this.pendingPath(sessionId));
      return this.state(prepared.command);
    });
  }

  async getToolContext(
    sessionId: string,
    configRevision: number,
    value: unknown,
  ): Promise<{
    assetRoot: string;
    environment: Readonly<Record<string, string>>;
  }> {
    await this.requireSession(sessionId);
    if (this.busy.has(sessionId))
      throw new Error('Extension configuration is changing.');
    const status = await this.status(sessionId);
    const active = this.active.get(sessionId);
    const pin = parseManagedExtensionPin(value);
    const pkg = active?.packages.find(
      (entry) => JSON.stringify(entry.pin) === JSON.stringify(pin),
    );
    if (
      !active ||
      !pkg ||
      status.pendingOperationId ||
      status.revision !== configRevision
    )
      throw new Error('Extension tool configuration is unavailable.');
    const environment = this.environments.get(
      this.preparedKey(sessionId, active.command.operationId),
    );
    if (!environment)
      throw new Error('Extension settings require exact reprepare.');
    await this.cache.verifyMaterialized(pin.packageDigest, pkg.assetRoot);
    return {
      assetRoot: pkg.assetRoot,
      environment: {
        ...environment[pin.extensionId],
        QWEN_EXTENSION_ROOT: pkg.assetRoot,
      },
    };
  }

  async bindSession(
    sessionId: string,
    runtimeSessionId: string | undefined,
    contextBinding: unknown,
  ): Promise<void> {
    if (this.dependencies.bindContext)
      await this.dependencies.bindContext(sessionId, contextBinding);
    if (runtimeSessionId === undefined) return;
    const existing = this.ownerSessions.get(runtimeSessionId);
    if (existing && existing !== sessionId)
      throw new Error('Extension Runtime owner conflicts.');
    this.ownerSessions.set(runtimeSessionId, sessionId);
    this.sessionOwners.set(sessionId, runtimeSessionId);
  }

  runtimeSessionId(sessionId: string): string {
    return this.sessionOwners.get(sessionId) ?? sessionId;
  }

  isChanging(sessionId: string): boolean {
    return this.busy.has(this.ownerSessions.get(sessionId) ?? sessionId);
  }

  async readAsset(
    sessionId: string,
    revision: number,
    extensionId: string,
    relativePath: string,
  ) {
    const root = await this.assetRoot(sessionId, revision, extensionId);
    const file = await this.contained(root, relativePath);
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 256 * 1024)
        throw new Error('Extension asset exceeds the read limit.');
      return { path: relativePath, content: await handle.readFile('utf8') };
    } finally {
      await handle.close();
    }
  }

  async globAssets(
    sessionId: string,
    revision: number,
    extensionId: string,
    pattern: string,
  ) {
    const root = await this.assetRoot(sessionId, revision, extensionId);
    if (pattern.length > 1024 || pattern.includes('\0'))
      throw new Error('Invalid extension glob.');
    const paths: string[] = [];
    const visit = async (directory: string) => {
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        const filename = path.join(directory, entry.name);
        const relative = path
          .relative(root, filename)
          .split(path.sep)
          .join('/');
        if (entry.isSymbolicLink())
          throw new Error('Extension assets contain a link.');
        if (entry.isDirectory()) await visit(filename);
        else if (
          entry.isFile() &&
          minimatch(relative, pattern, { dot: true })
        ) {
          if (paths.length === 2048)
            throw new Error('Extension glob exceeds its result limit.');
          paths.push(relative);
        }
      }
    };
    await visit(root);
    return paths.sort();
  }

  private async assetRoot(
    sessionId: string,
    revision: number,
    extensionId: string,
  ): Promise<string> {
    const status = await this.status(sessionId);
    const active = this.active.get(sessionId);
    if (this.isChanging(sessionId) || !active || status.revision !== revision)
      throw new Error('Extension configuration is unavailable.');
    const entry = active.packages.find(
      (item) => item.pin.extensionId === extensionId,
    );
    if (!entry)
      throw new Error('Extension package is not active in this Session.');
    if (status.pendingOperationId)
      throw new Error('Extension activation outcome is unknown.');
    await this.cache.verifyMaterialized(
      entry.pin.packageDigest,
      entry.assetRoot,
    );
    return fs.realpath(entry.assetRoot);
  }

  private async contained(root: string, relative: string): Promise<string> {
    if (
      !relative ||
      relative.includes('\\') ||
      relative.includes('\0') ||
      path.isAbsolute(relative)
    )
      throw new Error('Invalid extension asset path.');
    const filename = await fs.realpath(path.resolve(root, relative));
    const resolved = path.relative(root, filename);
    if (
      resolved === '..' ||
      resolved.startsWith(`..${path.sep}`) ||
      path.isAbsolute(resolved)
    )
      throw new Error('Extension asset path escapes its package.');
    return filename;
  }

  private preparedView(value: Prepared): ManagedExtensionPrepareResult {
    const result: ManagedExtensionPrepareResult = {
      operationId: value.command.operationId,
      state: 'prepared',
      expectedRevision: value.command.expectedRevision,
      revision: value.command.expectedRevision + 1,
      executionMode: this.dependencies.executionMode,
      packages: value.packages,
      mcpServers: value.mcpServers,
      hookCatalog: value.hookCatalog,
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024)
      throw new Error('Extension prepare response exceeds its size limit.');
    return result;
  }

  private state(
    command: ManagedExtensionApplyCommand,
  ): ManagedExtensionRuntimeState {
    return {
      state: 'active',
      executionMode: this.dependencies.executionMode,
      revision: command.expectedRevision + 1,
      extensions: command.extensions,
      operationId: command.operationId,
    };
  }

  private async loadPrepared(
    sessionId: string,
    operationId: string,
  ): Promise<Prepared | undefined> {
    try {
      const value = JSON.parse(
        await fs.readFile(this.operationPath(sessionId, operationId), 'utf8'),
      ) as Prepared;
      if (
        value.ownerJournalId !==
        (this.dependencies.ownerJournalId ?? 'in-memory')
      )
        throw new Error('Original extension owner journal is unavailable.');
      const command = parseManagedExtensionApplyCommand(value.command);
      if (
        command.operationId !== operationId ||
        !Array.isArray(value.packages) ||
        value.packages.length !== command.extensions.length
      )
        throw new Error('Invalid prepared extension receipt.');
      const pins = parseManagedExtensionPins(
        value.packages.map((pkg) => pkg.pin),
      );
      if (JSON.stringify(pins) !== JSON.stringify(command.extensions))
        throw new Error('Prepared extension pins conflict.');
      for (const pkg of value.packages) {
        if (
          typeof pkg.assetRoot !== 'string' ||
          path.dirname(pkg.assetRoot) !== this.cache.directory ||
          !path.basename(pkg.assetRoot).startsWith(`${pkg.pin.packageDigest}-`)
        )
          throw new Error('Invalid prepared extension asset root.');
      }
      this.preparedView(value);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private operationPath(sessionId: string, operationId: string): string {
    return `${this.statePath(sessionId)}.${createHash('sha256').update(operationId).digest('hex')}.prepared`;
  }

  private statePath(sessionId: string): string {
    return path.join(
      this.dependencies.directory,
      'sessions',
      `${createHash('sha256').update(sessionId).digest('hex')}.json`,
    );
  }

  private pendingPath(sessionId: string): string {
    return `${this.statePath(sessionId)}.pending`;
  }

  private preparedKey(sessionId: string, operationId: string): string {
    return `${sessionId}\0${operationId}`;
  }

  private async requireSession(sessionId: string): Promise<void> {
    if (!sessionId || !(await this.dependencies.admitted(sessionId)))
      throw new Error('Extension Session is unavailable.');
  }

  private async lock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    if (this.busy.has(sessionId))
      throw new Error('Extension Session configuration is changing.');
    this.busy.add(sessionId);
    try {
      await this.requireSession(sessionId);
      return await work();
    } finally {
      this.busy.delete(sessionId);
    }
  }
}

export function registerManagedExtensionRuntimeRoutes(
  app: Application,
  identity: ManagedRuntimeRequestIdentity & {
    readonly tenantId: string;
    readonly workspaceId: string;
  },
  runtime: ManagedExtensionRuntime,
): void {
  app.put(
    MANAGED_EXTENSION_UPLOAD_ROUTE.path,
    managedRuntimeNoStore,
    authorizeManagedRuntime(identity),
    async (req, res) => {
      try {
        if (req.headers['content-type'] !== 'application/gzip')
          throw new Error('Invalid package content type.');
        await runtime.cache.upload(String(req.params['digest']), req);
        res.json({ protocolVersion: 1, packageDigest: req.params['digest'] });
      } catch {
        res.status(400).json({ code: 'managed_extension_package_invalid' });
      }
    },
  );
  app.post(
    MANAGED_EXTENSION_RUNTIME_ROUTE.path,
    managedRuntimeNoStore,
    authorizeManagedRuntime(identity),
    managedRuntimeJsonBody(512 * 1024),
    async (req, res) => {
      try {
        const body = req.body as Record<string, unknown>;
        if (
          !body ||
          ![
            'contextBinding,operation,protocolVersion,sessionKey',
            'contextBinding,operation,protocolVersion,runtimeSessionId,sessionKey',
          ].includes(Object.keys(body).sort().join(',')) ||
          body['protocolVersion'] !== 1 ||
          (body['runtimeSessionId'] !== undefined &&
            typeof body['runtimeSessionId'] !== 'string')
        )
          throw new Error('Invalid extension request.');
        const runtimeSessionId = body['runtimeSessionId'] as string | undefined;
        const sessionKey = body['sessionKey'] as Record<string, unknown>;
        if (
          !sessionKey ||
          Object.keys(sessionKey).sort().join(',') !==
            'sessionId,tenantId,workspaceId' ||
          sessionKey['tenantId'] !== identity.tenantId ||
          sessionKey['workspaceId'] !== identity.workspaceId ||
          typeof sessionKey['sessionId'] !== 'string' ||
          !/^[A-Za-z0-9._:-]{1,128}$/u.test(sessionKey['sessionId'])
        )
          throw new Error('Extension Session scope conflicts.');
        const sessionId = sessionKey['sessionId'];
        await runtime.bindSession(
          sessionId,
          runtimeSessionId,
          body['contextBinding'],
        );
        const operation = body['operation'] as Record<string, unknown>;
        let result: unknown;
        if (
          operation['kind'] === 'prepare' ||
          operation['kind'] === 'extension-prepare'
        ) {
          const control = operation as unknown as Extract<
            ManagedExtensionRuntimeControl,
            { kind: 'extension-prepare' }
          >;
          const parsed = parseManagedExtensionApplyCommand(control.command);
          if (
            control.kind === 'extension-prepare' &&
            (control.operationId !== parsed.operationId ||
              control.expectedRevision !== parsed.expectedRevision ||
              JSON.stringify(control.extensions) !==
                JSON.stringify(parsed.extensions))
          )
            throw new Error('Extension prepare identity conflicts.');
          result = await runtime.prepare(
            sessionId,
            parsed,
            control.kind === 'extension-prepare'
              ? {
                  toolProfile:
                    typeof operation['toolProfile'] === 'string'
                      ? operation['toolProfile']
                      : undefined,
                  packageManifests: operation['packageManifests'] as
                    | Readonly<Record<string, unknown>>
                    | undefined,
                  baseMcpServers: control.baseMcpServers,
                  baseHookCatalog: control.baseHookCatalog,
                  settings: operation['settings'] as
                    | Readonly<Record<string, Readonly<Record<string, string>>>>
                    | undefined,
                }
              : undefined,
          );
        } else if (
          (operation['kind'] === 'activate' ||
            operation['kind'] === 'extension-activate') &&
          typeof operation['operationId'] === 'string'
        )
          result = await runtime.activate(sessionId, operation['operationId']);
        else if (
          operation['kind'] === 'extension-reconcile' &&
          typeof operation['operationId'] === 'string' &&
          Number.isSafeInteger(operation['expectedRevision']) &&
          Number.isSafeInteger(operation['revision'])
        )
          result = await runtime.reconcile(
            sessionId,
            operation['operationId'],
            Number(operation['expectedRevision']),
            Number(operation['revision']),
          );
        else if (
          operation['kind'] === 'status' ||
          operation['kind'] === 'extension-status'
        )
          result =
            typeof operation['operationId'] === 'string'
              ? await runtime.operationStatus(
                  sessionId,
                  operation['operationId'],
                )
              : await runtime.status(sessionId);
        else if (
          (operation['kind'] === 'asset-read' ||
            operation['kind'] === 'extension-asset-read') &&
          Number.isSafeInteger(operation['revision']) &&
          typeof operation['extensionId'] === 'string' &&
          typeof operation['path'] === 'string'
        )
          result = await runtime.readAsset(
            sessionId,
            Number(operation['revision']),
            operation['extensionId'],
            operation['path'],
          );
        else if (
          (operation['kind'] === 'asset-glob' ||
            operation['kind'] === 'extension-asset-glob') &&
          Number.isSafeInteger(operation['revision']) &&
          typeof operation['extensionId'] === 'string' &&
          typeof operation['pattern'] === 'string'
        )
          result = await runtime.globAssets(
            sessionId,
            Number(operation['revision']),
            operation['extensionId'],
            operation['pattern'],
          );
        else throw new Error('Invalid extension operation.');
        if (
          typeof operation['operationId'] === 'string' &&
          String(operation['kind']).includes('asset-')
        )
          result = Array.isArray(result)
            ? { operationId: operation['operationId'], paths: result }
            : { ...(result as object), operationId: operation['operationId'] };
        res.json({
          protocolVersion: 1,
          sessionKey,
          ...(runtimeSessionId ? { runtimeSessionId } : {}),
          result,
        });
      } catch {
        res
          .status(409)
          .json({ code: 'managed_extension_configuration_unavailable' });
      }
    },
  );
}

function validateExtensionToolProfile(
  value: ManagedPackageContributions,
  profile: string | undefined,
): void {
  if (profile === undefined) return;
  const shell =
    profile === 'hosted-workspace-shell/1' ||
    profile === 'hosted-workspace-team-lead/1';
  const mcp = shell || profile === 'hosted-workspace-mcp/1';
  if (!mcp && Object.keys(value.mcpServers).length)
    throw new Error('Session profile does not admit extension MCP.');
  if (
    !shell &&
    (JSON.stringify(value.hooks).includes('"type":"command"') ||
      Object.values(value.mcpServers).some(
        (recipe) => recipe && typeof recipe === 'object' && 'command' in recipe,
      ) ||
      value.commands.some((command) => /!\{|!`/u.test(command.prompt)))
  )
    throw new Error(
      'Session profile does not admit extension Shell execution.',
    );
  const base = ['read_file', 'glob'];
  if (profile !== 'hosted-workspace-read/1')
    base.push(
      'write_file',
      'edit',
      'list_directory',
      'grep_search',
      'todo_write',
    );
  if (shell) base.push('run_shell_command');
  for (const agent of value.agents)
    if (
      agent.tools?.some(
        (tool) => !base.includes(tool) && !(mcp && tool.startsWith('mcp__')),
      )
    )
      throw new Error('Extension agent tools exceed the Session profile.');
}
