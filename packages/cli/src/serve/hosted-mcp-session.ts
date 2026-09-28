/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { FunctionDeclaration } from '@google/genai';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type { ExtensionRun } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import {
  parseMcpConfiguration,
  parseMcpOperation,
  type McpConfiguration,
  type McpOperation,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-record.js';
import {
  MANAGED_MCP_TOOL,
  type ManagedMcpCatalog,
  type ManagedMcpControl,
  type ManagedMcpInvoke,
  type ManagedMcpOperationView,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
import {
  HostedWorkspaceBroker,
  type HostedWorkspaceBrokerOptions,
} from './hosted-workspace-broker.js';

export const HOSTED_MCP_PROFILE = 'hosted-workspace-mcp/1';

export interface HostedMcpServerPin {
  readonly serverId: string;
  readonly serverRevision: number;
  readonly definitionDigest: string;
}

export function parseHostedMcpServers(
  value: unknown,
): readonly HostedMcpServerPin[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error('MCP profile requires 1–32 server definitions.');
  }
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Invalid MCP definition pin.');
    const pin = entry as Record<string, unknown>;
    if (
      Object.keys(pin).sort().join(',') !==
        'definitionDigest,serverId,serverRevision' ||
      typeof pin['serverId'] !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(pin['serverId']) ||
      !Number.isSafeInteger(pin['serverRevision']) ||
      Number(pin['serverRevision']) < 1 ||
      typeof pin['definitionDigest'] !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(pin['definitionDigest']) ||
      ids.has(pin['serverId'])
    )
      throw new Error('Invalid MCP definition pin.');
    ids.add(pin['serverId']);
    return Object.freeze({
      serverId: pin['serverId'],
      serverRevision: Number(pin['serverRevision']),
      definitionDigest: pin['definitionDigest'],
    });
  });
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class HostedMcpRecoveryRequiredError extends Error {
  constructor() {
    super('MCP requires reconciliation of its original operation.');
  }
}

type ResourceRequest = Exclude<
  ManagedMcpInvoke['request'],
  { kind: 'tool_call' }
>;

export class HostedMcpSession {
  readonly broker: HostedWorkspaceBroker;
  private ready?: Promise<void>;
  private acquired = false;
  private readonly bindings = new Map<
    string,
    { configuration: McpConfiguration; catalog: ManagedMcpCatalog }
  >();
  private readonly catalogs = new Map<
    string,
    { configuration: McpConfiguration; catalog: ManagedMcpCatalog }
  >();

  constructor(
    options: HostedWorkspaceBrokerOptions,
    private readonly session: ManagedSession,
    readonly servers: readonly HostedMcpServerPin[],
  ) {
    const configurations = this.configurations();
    const owners = new Set(
      configurations
        .filter((entry) => entry.releaseState !== 'released')
        .map((entry) => entry.runtimeSessionId),
    );
    if (owners.size > 1) throw new HostedMcpRecoveryRequiredError();
    const previous = configurations.length
      ? digest(
          configurations.map((entry) => entry.configurationId).sort(),
        ).slice(0, 32)
      : undefined;
    this.broker = new HostedWorkspaceBroker(
      options,
      session.authority.sessionHeader.sessionKey,
      owners.values().next().value ??
        `mcp:${session.authority.sessionHeader.sessionKey.sessionId}${previous ? `:${previous}` : ''}`,
    );
  }

  ensureReady(): Promise<void> {
    this.ready ??= this.initialize().catch((cause: unknown) => {
      this.ready = undefined;
      throw cause;
    });
    return this.ready;
  }

  private async initialize(): Promise<void> {
    for (const pin of this.servers) {
      const history = this.session.authority
        .extensionRecordsInDomain('mcp_configuration')
        .map((entry) => parseMcpConfiguration(entry.record))
        .filter((entry) => entry.serverId === pin.serverId)
        .sort((a, b) => a.configRevision - b.configRevision);
      const latest = history
        .filter((entry) => entry.run.state !== 'failed')
        .at(-1);
      const previous = latest?.releaseState === 'released' ? undefined : latest;
      const effective = latest?.run.definition;
      await this.install(
        effective
          ? {
              serverId: pin.serverId,
              serverRevision: effective.definitionRevision,
              definitionDigest: effective.definitionDigest,
            }
          : pin,
        previous,
        randomUUID(),
        (history.at(-1)?.configRevision ?? 0) + 1,
      );
    }
  }

  async configure(
    operationId: string,
    pin: HostedMcpServerPin,
    expectedRevision: number,
  ): Promise<void> {
    await this.ensureReady();
    if (!this.servers.some((server) => server.serverId === pin.serverId))
      throw new Error('MCP server is not allowed by this Session.');
    const previous = this.session.authority.extensionRecord(
      'mcp_configuration',
      operationId,
    );
    if (previous) {
      const saved = parseMcpConfiguration(previous.record);
      if (
        saved.serverId !== pin.serverId ||
        saved.serverRevision !== pin.serverRevision ||
        saved.run.definition?.definitionDigest !== pin.definitionDigest ||
        saved.configRevision !== expectedRevision + 1
      )
        throw new Error('MCP configuration identity conflicts.');
      await this.install(pin, saved);
      return;
    }
    const currentRevision = Math.max(
      0,
      ...this.configurations()
        .filter((entry) => entry.serverId === pin.serverId)
        .map((entry) => entry.configRevision),
    );
    if (currentRevision !== expectedRevision)
      throw new Error('MCP configuration revision conflicts.');
    try {
      await this.install(pin, undefined, operationId, expectedRevision + 1);
    } catch (cause) {
      this.ready = undefined;
      throw cause;
    }
  }

  private async install(
    pin: HostedMcpServerPin,
    previous?: McpConfiguration,
    operationId: string = randomUUID(),
    configRevision = 1,
  ): Promise<void> {
    let configuration: McpConfiguration;
    let operation: ManagedMcpOperationView;
    if (previous) {
      if (previous.releaseState !== 'active')
        throw new HostedMcpRecoveryRequiredError();
      configuration = previous;
    } else {
      const configurationId = operationId;
      configuration = {
        configurationId,
        runtimeSessionId: this.broker.runtimeSessionId,
        serverId: pin.serverId,
        serverRevision: pin.serverRevision,
        configRevision,
        catalogRevision: null,
        connectionGeneration: null,
        catalogRef: null,
        releaseState: 'active',
        run: this.run(configurationId, pin),
      };
      await this.commitConfiguration(configuration);
    }
    if (configuration.run.execution === 'intent') {
      await this.acquireOwner();
      const runtime = this.broker.runtime!;
      configuration = {
        ...configuration,
        run: {
          ...configuration.run,
          state: 'running',
          execution: 'dispatch_started',
          runtime: {
            runtimeBindingId: runtime.bindingId,
            generation: runtime.generation,
          },
        },
      };
      await this.commitConfiguration(configuration);
      operation = await this.dispatch({
        kind: 'mcp-configure',
        sessionKey: this.key,
        operationId: configuration.configurationId,
        serverId: pin.serverId,
        serverRevision: pin.serverRevision,
        definitionDigest: pin.definitionDigest,
        configRevision: configuration.configRevision,
        grant: this.grant('mcp_configuration', configuration.configurationId),
      });
    } else {
      operation = await this.lookup(configuration.configurationId);
    }
    if (operation.state !== 'settled') {
      if (configuration.run.state !== 'settled')
        await this.commitConfiguration({
          ...configuration,
          run: {
            ...configuration.run,
            state:
              operation.state === 'running' ? 'waiting' : 'recovery_blocked',
            execution:
              operation.state === 'running'
                ? 'dispatch_started'
                : 'outcome_unknown',
            reason: operation.state === 'running' ? null : 'outcome_unknown',
          },
        });
      throw new HostedMcpRecoveryRequiredError();
    }
    if (operation.error || !operation.catalog) {
      if (configuration.run.state !== 'settled')
        await this.commitConfiguration({
          ...configuration,
          run: {
            ...configuration.run,
            state: 'failed',
            execution: 'settled',
            reason: null,
          },
        });
      throw new Error('Runtime MCP configuration failed.');
    }
    const catalog = operation.catalog;
    if (
      catalog.serverId !== pin.serverId ||
      catalog.serverRevision !== pin.serverRevision ||
      catalog.definitionDigest !== pin.definitionDigest ||
      catalog.configRevision !== configuration.configRevision
    )
      throw new HostedMcpRecoveryRequiredError();
    if (configuration.catalogRef) {
      const saved = JSON.parse(
        (await this.session.resources.read(configuration.catalogRef)).toString(
          'utf8',
        ),
      ) as unknown;
      if (digest(saved) !== digest(catalog))
        throw new HostedMcpRecoveryRequiredError();
    } else {
      const catalogRef = await this.publish('managed-mcp-catalog', catalog);
      configuration = {
        ...configuration,
        catalogRef,
        catalogRevision: catalog.catalogRevision,
        connectionGeneration: catalog.connectionGeneration,
        run: {
          ...configuration.run,
          state: 'settled',
          execution: 'settled',
          reason: null,
        },
      };
      await this.commitConfiguration(configuration);
    }
    if (
      (this.catalogs.get(pin.serverId)?.configuration.configRevision ?? 0) <=
      configuration.configRevision
    )
      this.catalogs.set(pin.serverId, { configuration, catalog });
    this.bindings.set(configuration.configurationId, {
      configuration,
      catalog,
    });
  }

  getCatalogs(): readonly ManagedMcpCatalog[] {
    return [...this.catalogs.values()].map(({ catalog }) => catalog);
  }

  hasPendingOperations(): boolean {
    return this.session.authority
      .extensionRecordsInDomain('mcp_operation')
      .some(
        (entry) =>
          !['settled', 'failed', 'cancelled'].includes(entry.run.state),
      );
  }

  get recoveryBlocked(): boolean {
    return (
      this.hasPendingOperations() ||
      this.configurations().some(
        (entry) =>
          !['settled', 'failed'].includes(entry.run.state) ||
          entry.releaseState === 'releasing',
      )
    );
  }

  tools(): FunctionDeclaration[] {
    return [...this.catalogs.values()].flatMap(({ catalog }) =>
      catalog.discovery.tools === 'complete' ||
      catalog.discovery.tools === 'partial'
        ? catalog.tools.map((tool) => ({
            name: this.toolName(catalog, tool.name),
            description: tool.description,
            parametersJsonSchema: tool.inputSchema,
          }))
        : [],
    );
  }

  toolInput(
    name: string,
    args: Record<string, unknown>,
    operationId: string,
  ): { toolName: string; input: ManagedMcpInvoke } | undefined {
    for (const { catalog, configuration } of this.bindings.values()) {
      const tool = catalog.tools.find(
        (candidate) => this.toolName(catalog, candidate.name) === name,
      );
      if (!tool) continue;
      return {
        toolName: MANAGED_MCP_TOOL,
        input: {
          kind: 'mcp-invoke',
          sessionKey: this.key,
          operationId,
          serverId: catalog.serverId,
          serverRevision: catalog.serverRevision,
          configRevision: catalog.configRevision,
          catalogRevision: catalog.catalogRevision,
          connectionGeneration: catalog.connectionGeneration,
          grant: this.grant('mcp_configuration', configuration.configurationId),
          request: { kind: 'tool_call', name: tool.name, arguments: args },
        },
      };
    }
    return undefined;
  }

  async invoke(
    operationId: string,
    serverId: string,
    request: ResourceRequest,
  ): Promise<ManagedMcpOperationView> {
    if (
      request.kind === 'resource_read'
        ? !request.uri.trim()
        : !request.name.trim()
    )
      throw new Error('MCP request requires a nonempty name or URI.');
    const old = this.session.authority.extensionRecord(
      'mcp_operation',
      operationId,
    );
    let record: McpOperation;
    let response: ManagedMcpOperationView;
    if (old) {
      record = parseMcpOperation(old.record);
      if (
        record.argsRef.digest !== digest(request) ||
        record.serverId !== serverId
      )
        throw new Error('MCP operation identity conflicts.');
    } else {
      await this.ensureReady();
      const installed = this.catalogs.get(serverId);
      if (!installed)
        throw new Error('MCP server is not bound to this Session.');
      const { catalog, configuration } = installed;
      const argsRef = await this.publish('managed-mcp-arguments', request);
      record = {
        operationId,
        configurationId: configuration.configurationId,
        serverId,
        serverRevision: catalog.serverRevision,
        configRevision: catalog.configRevision,
        connectionGeneration: catalog.connectionGeneration,
        catalogRevision: catalog.catalogRevision,
        operationKind: request.kind,
        argsRef,
        resultRef: null,
        cancelRequested: false,
        run: this.run(operationId, {
          serverId,
          serverRevision: configuration.serverRevision,
          definitionDigest: configuration.run.definition!.definitionDigest,
        }),
      };
      await this.commitOperation(record);
    }
    let saved = await this.localOperationView(record);
    if (saved) return saved;
    if (record.run.execution === 'intent') {
      await this.acquireOwner();
      record = parseMcpOperation(
        this.session.authority.extensionRecord('mcp_operation', operationId)!
          .record,
      );
      saved = await this.localOperationView(record);
      if (saved) return saved;
    }
    if (record.run.execution === 'intent') {
      record = {
        ...record,
        run: { ...record.run, state: 'running', execution: 'dispatch_started' },
      };
      await this.commitOperation(record);
      response = await this.dispatch({
        kind: 'mcp-invoke',
        sessionKey: this.key,
        operationId,
        serverId,
        serverRevision: record.serverRevision,
        configRevision: record.configRevision,
        connectionGeneration: record.connectionGeneration,
        catalogRevision: record.catalogRevision,
        grant: this.grant('mcp_operation', operationId),
        request,
      });
    } else response = await this.lookup(operationId);
    return this.accept(record, response);
  }

  private async localOperationView(
    record: McpOperation,
  ): Promise<ManagedMcpOperationView | undefined> {
    if (record.resultRef)
      return JSON.parse(
        (await this.session.resources.read(record.resultRef)).toString('utf8'),
      ) as ManagedMcpOperationView;
    if (record.run.execution === 'not_started_proven')
      return {
        operationId: record.operationId,
        state: 'settled',
        error: { code: 'managed_mcp_cancelled' },
      };
    return undefined;
  }

  async status(operationId: string): Promise<ManagedMcpOperationView> {
    const saved = this.session.authority.extensionRecord(
      'mcp_operation',
      operationId,
    );
    if (!saved) throw new Error('MCP operation was not found.');
    const record = parseMcpOperation(saved.record);
    const local = await this.localOperationView(record);
    if (local) return local;
    if (record.run.execution === 'intent')
      return { operationId, state: 'running' };
    return this.accept(record, await this.lookup(operationId));
  }

  private async accept(
    record: McpOperation,
    response: ManagedMcpOperationView,
  ): Promise<ManagedMcpOperationView> {
    record = parseMcpOperation(
      this.session.authority.extensionRecord(
        'mcp_operation',
        record.operationId,
      )!.record,
    );
    const local = await this.localOperationView(record);
    if (local) return local;
    if (response.state === 'running') return response;
    if (response.state !== 'settled') {
      await this.commitOperation({
        ...record,
        run: {
          ...record.run,
          state: 'recovery_blocked',
          execution: 'outcome_unknown',
          reason: 'outcome_unknown',
        },
      });
      return response;
    }
    const resultRef = await this.publish('managed-mcp-response', response);
    await this.commitOperation({
      ...record,
      resultRef,
      run: {
        ...record.run,
        state: response.error ? 'failed' : 'settled',
        execution: 'settled',
        reason: null,
      },
    });
    return response;
  }

  async cancel(operationId: string): Promise<ManagedMcpOperationView> {
    const saved = this.session.authority.extensionRecord(
      'mcp_operation',
      operationId,
    );
    if (!saved) throw new Error('MCP operation was not found.');
    const record = parseMcpOperation(saved.record);
    const local = await this.localOperationView(record);
    if (local) return local;
    if (
      this.session.authority.extensionRecord('mcp_operation', operationId)!
        .revision !== saved.revision
    )
      return this.cancel(operationId);
    if (record.run.execution === 'intent') {
      await this.commitOperation({
        ...record,
        cancelRequested: true,
        run: {
          ...record.run,
          state: 'cancelled',
          execution: 'not_started_proven',
          reason: null,
        },
      });
      return this.status(operationId);
    }
    await this.commitOperation({ ...record, cancelRequested: true });
    await this.acquireOwner();
    return this.accept(
      record,
      await this.broker.control({
        kind: 'mcp-cancel',
        sessionKey: this.key,
        operationId,
        targetOperationId: operationId,
      }),
    );
  }

  async close(): Promise<void> {
    if (this.hasPendingOperations()) throw new HostedMcpRecoveryRequiredError();
    const configurations = this.configurations().filter(
      (entry) => entry.releaseState !== 'released',
    );
    if (!this.acquired && !configurations.length) return;
    if (
      configurations.length &&
      configurations.every((entry) => entry.releaseState === 'releasing')
    ) {
      try {
        await this.broker.release();
        await this.markReleased(configurations);
        return;
      } catch {
        // A lost release reply can be confirmed only by the original owner.
      }
    }
    if (configurations.some((entry) => entry.releaseState === 'active')) {
      await this.acquireOwner();
    }
    for (let configuration of configurations) {
      if (
        configuration.run.state === 'failed' &&
        configuration.run.execution === 'settled'
      ) {
        if (configuration.releaseState === 'active')
          await this.commitConfiguration({
            ...configuration,
            releaseState: 'releasing',
          });
        continue;
      }
      if (
        configuration.connectionGeneration === null ||
        configuration.run.state !== 'settled'
      )
        throw new HostedMcpRecoveryRequiredError();
      const operationId = `${configuration.configurationId}:release`;
      let response: ManagedMcpOperationView;
      if (configuration.releaseState === 'releasing') {
        response = await this.lookup(operationId);
      } else {
        configuration = { ...configuration, releaseState: 'releasing' };
        await this.commitConfiguration(configuration);
        response = await this.dispatch({
          kind: 'mcp-release',
          sessionKey: this.key,
          operationId,
          serverId: configuration.serverId,
          serverRevision: configuration.serverRevision,
          connectionGeneration: configuration.connectionGeneration!,
          grant: this.grant('mcp_configuration', configuration.configurationId),
        });
      }
      if (response.state !== 'settled' || response.error)
        throw new HostedMcpRecoveryRequiredError();
    }
    await this.broker.release();
    await this.markReleased(configurations);
  }

  private async markReleased(
    configurations: readonly McpConfiguration[],
  ): Promise<void> {
    for (const configuration of configurations)
      await this.commitConfiguration({
        ...configuration,
        releaseState: 'released',
      });
    this.acquired = false;
  }

  private configurations(): McpConfiguration[] {
    return this.session.authority
      .extensionRecordsInDomain('mcp_configuration')
      .map((entry) => parseMcpConfiguration(entry.record));
  }

  private async acquireOwner(): Promise<void> {
    this.acquired = true;
    await this.broker.acquire();
    const runtime = this.broker.runtime;
    if (
      !runtime ||
      this.configurations().some(
        (entry) =>
          entry.runtimeSessionId === this.broker.runtimeSessionId &&
          entry.run.runtime !== null &&
          (entry.run.runtime.runtimeBindingId !== runtime.bindingId ||
            entry.run.runtime.generation !== runtime.generation),
      )
    )
      throw new HostedMcpRecoveryRequiredError();
  }

  private get key() {
    return this.session.authority.sessionHeader.sessionKey;
  }

  private toolName(catalog: ManagedMcpCatalog, name: string): string {
    return `mcp_${digest([catalog.serverId, catalog.serverRevision, catalog.catalogRevision, catalog.connectionGeneration, name]).slice(0, 32)}`;
  }

  private run(effectId: string, pin: HostedMcpServerPin): ExtensionRun {
    const runtime = this.broker.runtime;
    return {
      state: 'admitted',
      reason: null,
      definition: {
        definitionId: pin.serverId,
        definitionRevision: pin.serverRevision,
        definitionDigest: pin.definitionDigest,
      },
      effectId,
      executionCallId: null,
      dispatchId: null,
      deliveryId: null,
      delivery: null,
      execution: 'intent',
      runtime: runtime
        ? {
            runtimeBindingId: runtime.bindingId,
            generation: runtime.generation,
          }
        : null,
    };
  }

  private grant(
    domain: 'mcp_configuration' | 'mcp_operation',
    recordId: string,
  ) {
    return this.session.authority.issueOperationGrant({
      domain,
      recordId,
      ownerId: this.session.authority.currentActivation!.workerId,
      workspaceGeneration: this.broker.runtime!.workspaceGeneration,
      phases:
        domain === 'mcp_configuration'
          ? ['configure', 'discover', 'invoke', 'release']
          : ['invoke'],
      leaseDurationMs: 300_000,
    });
  }

  private publish(kind: string, value: unknown) {
    return this.session.resources.publish(
      kind,
      Buffer.from(JSON.stringify(value)),
    );
  }

  private commitConfiguration(record: McpConfiguration) {
    return this.commit('mcp_configuration', record.configurationId, record);
  }
  private commitOperation(record: McpOperation) {
    return this.commit('mcp_operation', record.operationId, record);
  }

  private async commit(
    domain: 'mcp_configuration' | 'mcp_operation',
    id: string,
    record: unknown,
  ): Promise<void> {
    const previous = this.session.authority.extensionRecord(domain, id);
    if (previous && digest(previous.record) === digest(record)) return;
    await this.session.authority.commitExtensionRecord(
      {
        operation: 'commitMcpRecord',
        commandId: previous ? `${id}:${previous.revision + 1}` : id,
        sessionKey: this.key,
        contentDigest: digest(record),
      },
      { domain, record },
      { class: 'trusted_entry' },
    );
  }

  private async lookup(operationId: string): Promise<ManagedMcpOperationView> {
    try {
      await this.acquireOwner();
      return await this.broker.control({
        kind: 'mcp-status',
        sessionKey: this.key,
        operationId,
        targetOperationId: operationId,
      });
    } catch {
      return { operationId, state: 'outcome_unknown' };
    }
  }

  private async dispatch(
    operation: ManagedMcpControl,
  ): Promise<ManagedMcpOperationView> {
    let response: ManagedMcpOperationView;
    try {
      response = await this.broker.control(operation);
    } catch {
      response = await this.lookup(operation.operationId);
    }
    const deadline = Date.now() + 120_000;
    while (response.state === 'running' && Date.now() < deadline) {
      await delay(100);
      response = await this.lookup(operation.operationId);
    }
    return response;
  }
}
