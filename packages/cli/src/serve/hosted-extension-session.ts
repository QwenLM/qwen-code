/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  publishManagedExtensionContributions,
  readManagedExtensionContributions,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-contributions.js';
import {
  isManagedExtensionConfig,
  managedConfigBinding,
  managedExtensionCompensationOperationId,
  parseManagedConfigInstallRecord,
  type ManagedConfigInstallContent,
  type ManagedConfigInstallRecord,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-config-install.js';
import {
  parseManagedExtensionApplyCommand,
  parseManagedExtensionEffectiveBundle,
  type ManagedExtensionEffectiveBundle,
  type ManagedExtensionMcpSelection,
  type ManagedExtensionPrepareResult,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-package.js';
import type { ManagedPackageContributions } from '@qwen-code/qwen-code-core/extension/managed-package.js';
import type { ManagedHookCatalogPin } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  HostedWorkspaceBroker,
  type HostedWorkspaceBrokerOptions,
} from './hosted-workspace-broker.js';
import {
  MANAGED_EXTENSION_LINUX_CAPABILITY_DIGEST,
  MANAGED_EXTENSION_DEVELOPER_CAPABILITY_DIGEST,
} from './managed-extension-profile.js';
import {
  selectedMcpServers,
  type HostedMcpCommand,
} from './hosted-mcp-settings.js';
import { HostedMcpConflictError } from './hosted-mcp-session.js';

export interface HostedExtensionPackage {
  readonly extensionId: string;
  readonly contributions: ManagedPackageContributions;
}

export interface HostedExtensionCallbacks {
  validate(packages: readonly HostedExtensionPackage[]): void;
  drain(
    bundle: ManagedExtensionEffectiveBundle,
    forceMcpServerId?: string,
  ): Promise<void>;
  enable(
    bundle: ManagedExtensionEffectiveBundle,
    packages: readonly HostedExtensionPackage[],
    operationId: string,
  ): Promise<void>;
}

interface RuntimeOwner {
  readonly rootSnapshotRef: ManagedSessionDurableRef;
  readonly runtimeSessionId: string;
  readonly executionMode: ManagedExtensionEffectiveBundle['executionMode'];
  readonly runtime: {
    readonly bindingId: string;
    readonly generation: string;
    readonly workspaceGeneration: string;
  };
}

export class HostedExtensionRevisionConflict extends HostedMcpConflictError {}

export class HostedExtensionRecoveryRequired extends Error {
  constructor() {
    super('The original extension configuration requires recovery.');
  }
}

/** All durable facts use the Session's existing config_install chain. */
export class HostedExtensionSession {
  private history: ManagedConfigInstallRecord[] = [];

  constructor(
    private readonly session: ManagedSession,
    private readonly brokerOptions: HostedWorkspaceBrokerOptions,
    private readonly baseline: {
      readonly mcpRevision: number;
      readonly mcpServers: readonly ManagedExtensionMcpSelection[];
      readonly hookCatalog: ManagedHookCatalogPin | null;
    },
    private readonly callbacks: HostedExtensionCallbacks,
  ) {}

  async open(): Promise<void> {
    await this.session.authority.settlePendingAppend();
    let current =
      this.session.authority.domainRecord('config_install')?.recordRef;
    const history: ManagedConfigInstallRecord[] = [];
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current.resourceId))
        throw new HostedExtensionRecoveryRequired();
      seen.add(current.resourceId);
      const value = await this.read<unknown>(current);
      if (!isManagedExtensionConfig(value)) break;
      const record = parseManagedConfigInstallRecord(value);
      history.push(record);
      current = record.previousRecordRef ?? undefined;
    }
    this.history = history.reverse();
  }

  get enabled(): boolean {
    return this.history.length > 0;
  }
  get activeBundleRef(): ManagedSessionDurableRef | undefined {
    return (
      this.history.findLast((entry) => entry.phase === 'active')?.bundleRef ??
      undefined
    );
  }

  get pending(): boolean {
    const latest = this.history.at(-1);
    return (
      !!latest &&
      latest.phase !== 'active' &&
      !(latest.phase === 'failed' && latest.mode === 'apply')
    );
  }

  async active(): Promise<ManagedExtensionEffectiveBundle | undefined> {
    const active = this.history.findLast((entry) => entry.phase === 'active');
    const previous = this.history[0]?.previousBundleRef;
    const ref = active?.bundleRef ?? previous;
    return ref ? this.bundle(ref) : undefined;
  }

  async packages(
    bundle: ManagedExtensionEffectiveBundle,
  ): Promise<readonly HostedExtensionPackage[]> {
    return Promise.all(
      bundle.packages.map(async (entry) => ({
        extensionId: entry.pin.extensionId,
        contributions: await readManagedExtensionContributions(
          this.session.resources,
          entry.contributionsRef,
        ),
      })),
    );
  }

  async snapshot(operationId?: string) {
    const latest = this.history.at(-1);
    const selected = operationId
      ? this.history.findLast(
          (entry) => entry.command.operationId === operationId,
        )
      : latest;
    if (operationId && !selected)
      throw new Error('Extension operation was not found.');
    const active = await this.active();
    const requested = latest?.bundleRef
      ? await this.bundle(latest.bundleRef)
      : latest?.restoresBundleRef
        ? await this.bundle(latest.restoresBundleRef)
        : undefined;
    return {
      sessionId: this.session.authority.sessionHeader.sessionKey.sessionId,
      supported: true,
      revision:
        latest &&
        ['committed', 'active', 'recovery_required'].includes(latest.phase)
          ? latest.configRevision
          : (latest?.previousConfigRevision ?? 0),
      extensions: active?.packages.map((entry) => entry.pin) ?? [],
      requestedExtensions:
        requested?.packages.map((entry) => entry.pin) ??
        latest?.command.extensions ??
        [],
      ...(selected
        ? {
            operation: {
              operationId: selected.command.operationId,
              state: selected.phase,
              mode: selected.mode,
              revision: selected.configRevision,
              ...(selected.error ? { error: selected.error } : {}),
            },
          }
        : {}),
    };
  }

  async submit(value: unknown): Promise<void> {
    const command = parseManagedExtensionApplyCommand(value);
    const prior = this.history.findLast(
      (entry) => entry.command.operationId === command.operationId,
    );
    if (prior) {
      if (JSON.stringify(prior.command) !== JSON.stringify(command))
        throw new HostedMcpConflictError(
          'Extension operation identity conflicts.',
        );
      if (['active', 'failed'].includes(prior.phase)) return;
      if (this.history.at(-1) !== prior)
        throw new HostedExtensionRecoveryRequired();
      await this.continue(command.operationId);
      return;
    }
    if (this.pending) throw new HostedExtensionRecoveryRequired();
    const active = await this.active();
    if (command.expectedRevision !== (active?.configRevision ?? 0))
      throw new HostedExtensionRevisionConflict(
        'Extension configuration revision conflicts.',
      );
    const broker = await this.runtime(command.operationId);
    const executionMode = this.executionMode(broker);
    const baseline =
      active ??
      parseManagedExtensionEffectiveBundle({
        kind: 'managed-extension-config-bundle',
        formatVersion: 1,
        configRevision: 0,
        executionMode,
        mcpRevision: this.baseline.mcpRevision,
        independentMcpSelections: this.baseline.mcpServers,
        baseMcpServers: this.baseline.mcpServers
          .filter((pin) => pin.state === 'enabled')
          .map(({ state: _state, ...pin }) => pin),
        baseHookCatalog: this.baseline.hookCatalog,
        packages: [],
        mcpServers: this.baseline.mcpServers
          .filter((pin) => pin.state === 'enabled')
          .map(({ state: _state, ...pin }) => pin),
        hookCatalog: this.baseline.hookCatalog,
      });
    if (baseline.executionMode !== executionMode)
      throw new HostedExtensionRecoveryRequired();
    const previousBundleRef = await this.publish(
      'managed-extension-config-bundle',
      baseline,
    );
    const owner: RuntimeOwner = {
      rootSnapshotRef: this.session.authority.sessionHeader.rootSnapshotRef,
      runtimeSessionId: broker.runtimeSessionId,
      executionMode,
      runtime: {
        bindingId: broker.runtime!.bindingId,
        generation: broker.runtime!.generation,
        workspaceGeneration: broker.runtime!.workspaceGeneration,
      },
    };
    const rootSnapshotRef = await this.publish('managed-extension-root', owner);
    await this.commit({
      kind: 'hosted-extension-config',
      formatVersion: 1,
      command,
      mode: 'apply',
      phaseOperationId: command.operationId,
      configRevision: command.expectedRevision + 1,
      previousConfigRevision: command.expectedRevision,
      phase: 'preparing',
      previousBundleRef,
      restoresBundleRef: null,
      bundleRef: null,
      rootSnapshotRef,
      stageAckRefs: [],
      enableAckRefs: [],
      error: null,
    });
    await this.continue(command.operationId);
  }

  async bootstrap(value: unknown): Promise<void> {
    const command = parseManagedExtensionApplyCommand(value);
    if (command.expectedRevision !== 0 || command.mcpChange)
      throw new Error('Invalid initial extension selection.');
    await this.submit(command);
    const active = await this.active();
    if (
      !this.activeBundleRef ||
      !active ||
      active.configRevision < 1 ||
      this.pending
    )
      throw new HostedExtensionRecoveryRequired();
  }

  async continue(operationId: string): Promise<void> {
    let latest = this.history.at(-1);
    if (!latest || latest.command.operationId !== operationId)
      throw new HostedExtensionRecoveryRequired();
    if (
      latest.phase === 'active' ||
      (latest.phase === 'failed' && latest.mode === 'apply')
    )
      return;
    if (latest.phase === 'failed') throw new HostedExtensionRecoveryRequired();
    const broker = await this.runtime(operationId, latest.rootSnapshotRef);
    if (latest.phase === 'preparing') {
      try {
        latest = await this.prepare(latest, broker);
      } catch (cause) {
        if (latest.mode === 'apply')
          await this.commit({
            ...this.content(latest),
            phase: 'failed',
            error: { code: 'extension_prepare_failed' },
          });
        throw cause;
      }
    }
    if (latest.phase === 'prepared')
      latest = await this.commit({
        ...this.content(latest),
        phase: 'committed',
      });
    if (latest.phase !== 'committed' && latest.phase !== 'recovery_required')
      throw new HostedExtensionRecoveryRequired();
    const current = latest;
    try {
      const phaseOperationId = current.phaseOperationId;
      const status = await broker.extensionControl({
        kind: 'extension-status',
        operationId: phaseOperationId,
      });
      if (status['state'] === 'prepared') {
        await this.prepareRuntime(current, broker);
        await this.callbacks.drain(
          await this.bundle(current.bundleRef!),
          current.mode === 'apply' &&
            ['reload', 'restart'].includes(
              current.command.mcpChange?.action ?? '',
            )
            ? current.command.mcpChange?.serverId
            : undefined,
        );
        await broker.extensionControl({
          kind: 'extension-activate',
          operationId: phaseOperationId,
          expectedRevision: current.previousConfigRevision,
          revision: current.configRevision,
        });
      } else if (
        status['state'] !== 'active' ||
        status['revision'] !== current.configRevision
      ) {
        throw new HostedExtensionRecoveryRequired();
      }
      const enabled = await broker.extensionControl({
        kind: 'extension-status',
        operationId: phaseOperationId,
      });
      if (
        enabled['state'] !== 'active' ||
        enabled['revision'] !== current.configRevision ||
        enabled['executionMode'] !== this.executionMode(broker)
      )
        throw new HostedExtensionRecoveryRequired();
      const bundle = await this.bundle(current.bundleRef!);
      await this.callbacks.enable(
        bundle,
        await this.packages(bundle),
        current.phaseOperationId,
      );
      const runtimeAck = await this.publish('managed-extension-enable-ack', {
        operationId,
        revision: current.configRevision,
        executionMode: bundle.executionMode,
        side: 'runtime',
      });
      const harnessAck = await this.publish('managed-extension-enable-ack', {
        operationId,
        revision: current.configRevision,
        bundleRef: current.bundleRef,
        side: 'harness',
      });
      await this.commit({
        ...this.content(current),
        phase: 'active',
        enableAckRefs: [runtimeAck, harnessAck],
        error: null,
      });
    } catch (cause) {
      if (current.phase !== 'recovery_required')
        await this.commit({
          ...this.content(current),
          phase: 'recovery_required',
          error: { code: 'extension_recovery_required' },
        });
      throw cause;
    }
  }

  async recoverPrevious(operationId: string): Promise<void> {
    const latest = this.history.at(-1);
    if (!latest || latest.command.operationId !== operationId)
      throw new HostedExtensionRecoveryRequired();
    if (latest.mode === 'recoverPrevious') {
      await this.continue(operationId);
      return;
    }
    if (
      latest.phase !== 'recovery_required' ||
      !latest.bundleRef ||
      !latest.previousBundleRef
    )
      throw new HostedExtensionRecoveryRequired();
    const broker = await this.runtime(operationId, latest.rootSnapshotRef);
    const proof = await broker.extensionControl({
      kind: 'extension-reconcile',
      operationId,
      expectedRevision: latest.previousConfigRevision,
      revision: latest.configRevision,
    });
    if (
      proof['state'] !== 'stopped' ||
      proof['revision'] !== latest.configRevision ||
      proof['executionMode'] !== this.executionMode(broker) ||
      !Array.isArray(proof['receipts']) ||
      !proof['receipts'].length
    )
      throw new HostedExtensionRecoveryRequired();
    await this.callbacks.drain(await this.bundle(latest.previousBundleRef));
    await this.commit({
      ...this.content(latest),
      mode: 'recoverPrevious',
      phaseOperationId: managedExtensionCompensationOperationId(operationId),
      configRevision: latest.configRevision + 1,
      previousConfigRevision: latest.configRevision,
      previousBundleRef: latest.bundleRef,
      restoresBundleRef: latest.previousBundleRef,
      bundleRef: null,
      phase: 'preparing',
      stageAckRefs: [],
      enableAckRefs: [],
      error: null,
    });
    await this.continue(operationId);
  }

  async runtimeOwner(): Promise<RuntimeOwner | undefined> {
    const latest = this.history.findLast((entry) => entry.phase === 'active');
    return latest ? this.read<RuntimeOwner>(latest.rootSnapshotRef) : undefined;
  }

  async submitMcp(command: HostedMcpCommand): Promise<void> {
    const replay = this.history.findLast(
      (entry) => entry.command.operationId === command.operationId,
    );
    if (replay) {
      const change = replay.command.mcpChange;
      const server = change?.servers.find(
        (entry) => entry.serverId === command.serverId,
      );
      if (
        !change ||
        replay.command.actorKey !== command.actorKey ||
        change.action !== command.action ||
        change.serverId !== command.serverId ||
        change.expectedRevision !== command.expectedRevision ||
        (command.server &&
          (!server ||
            command.server.serverRevision !== server.serverRevision ||
            command.server.definitionDigest !== server.definitionDigest))
      )
        throw new HostedMcpConflictError('MCP command identity conflicts.');
      await this.submit(replay.command);
      return;
    }
    const active = await this.active();
    if (!active || this.pending) throw new HostedExtensionRecoveryRequired();
    if (command.expectedRevision !== active.mcpRevision)
      throw new HostedMcpConflictError('MCP settings revision conflicts.');
    if (
      active.mcpServers.some((pin) => pin.serverId === command.serverId) &&
      !active.independentMcpSelections.some(
        (pin) => pin.serverId === command.serverId,
      )
    )
      throw new HostedMcpConflictError(
        'Manage this MCP server through its extension.',
      );
    const servers = selectedMcpServers(
      active.independentMcpSelections,
      command,
    );
    const broker = await this.runtime(command.operationId);
    const available = await broker.mcpDefinitions();
    const selected = servers.find((pin) => pin.serverId === command.serverId)!;
    if (
      (selected.state === 'enabled' || command.action === 'edit') &&
      !available.some(
        (pin) =>
          pin.serverId === selected.serverId &&
          pin.serverRevision === selected.serverRevision &&
          pin.definitionDigest === selected.definitionDigest,
      )
    )
      throw new HostedMcpConflictError(
        'MCP definition is not published for this Workspace.',
      );
    await this.submit({
      operationId: command.operationId,
      actorKey: command.actorKey,
      expectedRevision: active.configRevision,
      extensions: active.packages.map((entry) => entry.pin),
      mcpChange: {
        action: command.action,
        serverId: command.serverId,
        expectedRevision: command.expectedRevision,
        servers,
      },
    });
  }

  async mcpSnapshot(operationId?: string, inventory = true) {
    const active = await this.active();
    if (!active) throw new HostedExtensionRecoveryRequired();
    const record = operationId
      ? this.history.findLast(
          (entry) => entry.command.operationId === operationId,
        )
      : this.history.findLast((entry) => entry.command.mcpChange !== undefined);
    if (operationId && !record?.command.mcpChange)
      throw new Error('MCP operation was not found.');
    const broker = new HostedWorkspaceBroker(
      this.brokerOptions,
      this.session.authority.sessionHeader.sessionKey,
      'mcp-management-inventory',
    );
    const change = record?.command.mcpChange;
    return {
      sessionId: this.session.authority.sessionHeader.sessionKey.sessionId,
      revision: active.mcpRevision,
      supported: true,
      availableServers: inventory ? await broker.mcpDefinitions() : [],
      servers: active.independentMcpSelections,
      ...(record && change
        ? {
            operation: {
              operationId: record.command.operationId,
              action: change.action,
              serverId: change.serverId,
              revision: change.expectedRevision + 1,
              state:
                record.phase === 'active'
                  ? 'settled'
                  : record.phase === 'failed'
                    ? 'failed'
                    : record.phase === 'recovery_required'
                      ? 'recovery_required'
                      : 'pending',
              ...(record.error ? { error: record.error } : {}),
            },
          }
        : {}),
    };
  }

  private async prepareRuntime(
    record: ManagedConfigInstallRecord,
    broker: HostedWorkspaceBroker,
  ) {
    const baseline = await this.bundle(
      record.mode === 'recoverPrevious'
        ? record.restoresBundleRef!
        : record.previousBundleRef!,
    );
    const change =
      record.mode === 'apply' ? record.command.mcpChange : undefined;
    if (change && change.expectedRevision !== baseline.mcpRevision)
      throw new HostedMcpConflictError('MCP component revision conflicts.');
    const selected = change?.servers ?? baseline.independentMcpSelections;
    const baseMcpServers = selected
      .filter((entry) => entry.state === 'enabled')
      .map(({ state: _state, ...pin }) => pin);
    const command =
      record.mode === 'apply'
        ? record.command
        : {
            operationId: record.phaseOperationId,
            actorKey: record.command.actorKey,
            expectedRevision: record.previousConfigRevision,
            extensions: baseline.packages.map((entry) => entry.pin),
          };
    const result = await broker.extensionControl({
      kind: 'extension-prepare',
      operationId: record.phaseOperationId,
      command,
      expectedRevision: record.previousConfigRevision,
      extensions: command.extensions,
      baseMcpServers,
      baseHookCatalog: baseline.baseHookCatalog,
    });
    if (
      result['state'] !== 'prepared' ||
      result['revision'] !== record.configRevision ||
      result['executionMode'] !== baseline.executionMode ||
      !Array.isArray(result['packages'])
    )
      throw new HostedExtensionRecoveryRequired();
    const prepared = result as unknown as ManagedExtensionPrepareResult;
    if (
      JSON.stringify(prepared.packages.map((entry) => entry.pin)) !==
      JSON.stringify(command.extensions)
    )
      throw new HostedExtensionRecoveryRequired();
    return { prepared, baseline, selected, baseMcpServers };
  }

  private async prepare(
    record: ManagedConfigInstallRecord,
    broker: HostedWorkspaceBroker,
  ) {
    const { prepared, baseline, selected, baseMcpServers } =
      await this.prepareRuntime(record, broker);
    const packages = await Promise.all(
      prepared.packages.map(async (entry) => ({
        pin: entry.pin,
        assetRoot: `extension://${entry.pin.extensionId}/`,
        contributionsRef: await publishManagedExtensionContributions(
          this.session.resources,
          entry.contributions,
        ),
      })),
    );
    this.callbacks.validate(
      prepared.packages.map((entry) => ({
        extensionId: entry.pin.extensionId,
        contributions: entry.contributions,
      })),
    );
    const previous =
      record.mode === 'recoverPrevious'
        ? await this.bundle(record.previousBundleRef!)
        : undefined;
    const bundle = parseManagedExtensionEffectiveBundle({
      kind: 'managed-extension-config-bundle',
      formatVersion: 1,
      configRevision: record.configRevision,
      executionMode: prepared.executionMode,
      mcpRevision: previous
        ? previous.mcpRevision + 1
        : baseline.mcpRevision + (record.command.mcpChange ? 1 : 0),
      independentMcpSelections: selected,
      ...(record.mode === 'apply' && record.command.mcpChange
        ? { mcpChange: record.command.mcpChange }
        : {}),
      baseMcpServers,
      baseHookCatalog: baseline.baseHookCatalog,
      packages,
      mcpServers: prepared.mcpServers,
      hookCatalog: prepared.hookCatalog,
    });
    const bundleRef = await this.publish(
      'managed-extension-config-bundle',
      bundle,
    );
    const runtimeAck = await this.publish('managed-extension-stage-ack', {
      operationId: record.command.operationId,
      revision: record.configRevision,
      bundleRef,
      side: 'runtime',
      executionMode: prepared.executionMode,
    });
    const harnessAck = await this.publish('managed-extension-stage-ack', {
      operationId: record.command.operationId,
      revision: record.configRevision,
      bundleRef,
      side: 'harness',
    });
    return this.commit({
      ...this.content(record),
      phase: 'prepared',
      bundleRef,
      stageAckRefs: [runtimeAck, harnessAck],
    });
  }

  private async runtime(
    operationId: string,
    rootSnapshotRef?: ManagedSessionDurableRef,
  ) {
    const owner = rootSnapshotRef
      ? await this.read<RuntimeOwner>(rootSnapshotRef)
      : undefined;
    if (
      owner &&
      JSON.stringify(owner.rootSnapshotRef) !==
        JSON.stringify(this.session.authority.sessionHeader.rootSnapshotRef)
    )
      throw new HostedExtensionRecoveryRequired();
    const id =
      owner?.runtimeSessionId ??
      `extensions-${hash([this.session.authority.sessionHeader.sessionKey, operationId])}`;
    const broker = new HostedWorkspaceBroker(
      this.brokerOptions,
      this.session.authority.sessionHeader.sessionKey,
      id,
    );
    if (owner)
      broker.expectExtensionRuntime({
        runtimeBindingId: owner.runtime.bindingId,
        generation: owner.runtime.generation,
      });
    else {
      await broker.warm();
      if (!broker.runtime) throw new HostedExtensionRecoveryRequired();
      broker.expectExtensionRuntime({
        runtimeBindingId: broker.runtime.bindingId,
        generation: broker.runtime.generation,
      });
    }
    await broker.extensionControl({ kind: 'extension-status', operationId });
    if (owner && owner.executionMode !== this.executionMode(broker))
      throw new HostedExtensionRecoveryRequired();
    return broker;
  }

  private executionMode(
    broker: HostedWorkspaceBroker,
  ): ManagedExtensionEffectiveBundle['executionMode'] {
    if (broker.capabilityDigest === MANAGED_EXTENSION_LINUX_CAPABILITY_DIGEST)
      return 'linux-cgroup';
    if (
      broker.capabilityDigest === MANAGED_EXTENSION_DEVELOPER_CAPABILITY_DIGEST
    )
      return 'developer-process-group';
    throw new Error(
      'The selected Runtime does not support extension packages.',
    );
  }

  private content(
    record: ManagedConfigInstallRecord,
  ): ManagedConfigInstallContent {
    const {
      operationId: _operationId,
      revision: _revision,
      previousRecordRef: _previous,
      ...content
    } = record;
    return content;
  }

  private async commit(content: ManagedConfigInstallContent) {
    const receipt = await this.session.authority.commitDomainRecord(
      {
        operation: `applyExtensions.${content.mode}.${content.phase}`,
        commandId: content.command.operationId,
        sessionKey: this.session.authority.sessionHeader.sessionKey,
        contentDigest: hash(content),
      },
      {
        domain: 'config_install',
        content: { ...content },
        ...(content.phase === 'committed'
          ? { configBinding: managedConfigBinding(content) }
          : {}),
      },
      { class: 'trusted_entry' },
    );
    const record = parseManagedConfigInstallRecord(
      await this.read(receipt.recordRef),
    );
    this.history.push(record);
    return record;
  }

  private async bundle(ref: ManagedSessionDurableRef) {
    if (
      ref.kind !== 'managed-extension-config-bundle' ||
      ref.schemaVersion !== 1
    )
      throw new HostedExtensionRecoveryRequired();
    return parseManagedExtensionEffectiveBundle(await this.read(ref));
  }

  private read<T>(ref: ManagedSessionDurableRef): Promise<T> {
    return this.session.resources
      .read(ref)
      .then((bytes) => JSON.parse(bytes.toString('utf8')) as T);
  }

  private publish(kind: string, value: unknown) {
    return this.session.resources.publish(
      kind,
      Buffer.from(JSON.stringify(value)),
    );
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
