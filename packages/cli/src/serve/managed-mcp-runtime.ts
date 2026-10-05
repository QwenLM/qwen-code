/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema,
  ReadResourceResultSchema,
  GetPromptResultSchema,
  ListToolsResultSchema,
  ListResourcesResultSchema,
  ListPromptsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ManagedOperationGrantGate } from '@qwen-code/qwen-code-core/managed-runtime/managed-operation-grant-gate.js';
import { parseOperationGrant } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import {
  MANAGED_MCP_MAX_CONNECTIONS,
  type ManagedMcpCatalog,
  type ManagedMcpConfigure,
  type ManagedMcpControl,
  type ManagedMcpInvoke,
  type ManagedMcpOperationView,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
import type { ManagedSessionKey } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';

export interface ManagedMcpDefinition {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly serverId: string;
  readonly serverRevision: number;
  readonly definitionDigest: string;
  readonly transport: 'stdio' | 'streamable-http' | 'sse';
  readonly command?: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
}

export interface ManagedMcpManifest {
  readonly version: 1;
  readonly servers: readonly ManagedMcpDefinition[];
}

interface Connection {
  readonly runtimeSessionId: string;
  readonly sessionKey: ManagedSessionKey;
  readonly definition: ManagedMcpDefinition;
  readonly client: Client;
  readonly transport: Transport;
  readonly pending: Map<string, Operation>;
  readonly drained: Set<() => void>;
  readonly closeDone: Promise<void>;
  readonly configRevision: number;
  readonly configurationOperationId: string;
  readonly generation: number;
  readonly catalogChanges: Record<'tools' | 'resources' | 'prompts', number>;
  retiring: boolean;
  closed: boolean;
  catalog?: ManagedMcpCatalog;
  catalogWork?: Promise<void>;
  closing?: Promise<void>;
}

interface Operation {
  readonly fingerprint: string;
  readonly runtimeSessionId: string;
  readonly control: ManagedMcpControl;
  view: ManagedMcpOperationView;
  connection?: Connection;
  awaitingReply?: boolean;
  done: Promise<void>;
  resolve: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class ManagedMcpError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const MAX_INFLIGHT = 32;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 60 * 1024;
const MAX_CATALOG_CATEGORY_BYTES = 16 * 1024;
const MAX_CATALOG_PAGES = 64;
const TIMEOUT_MS = 25_000;
const REQUEST_TIMEOUT_MS = 600_000;
const identifier = /^[A-Za-z0-9._:-]{1,128}$/u;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ManagedMcpError('managed_mcp_invalid');
  return value as Record<string, unknown>;
}

function closed(
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new ManagedMcpError('managed_mcp_invalid');
}

function positive(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function strings(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

function scope(key: ManagedSessionKey): string {
  return `${key.tenantId}\0${key.workspaceId}\0${key.sessionId}`;
}

function bindingKey(
  runtimeSessionId: string,
  serverId: string,
  revision: number,
  generation: number,
): string {
  return `${runtimeSessionId}\0${serverId}\0${revision}\0${generation}`;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function parseManagedMcpControl(value: unknown): ManagedMcpControl {
  const control = object(value);
  const key = object(control['sessionKey']);
  closed(key, ['tenantId', 'workspaceId', 'sessionId']);
  if (
    ['tenantId', 'workspaceId', 'sessionId'].some(
      (name) =>
        typeof key[name] !== 'string' || !identifier.test(key[name] as string),
    ) ||
    typeof control['operationId'] !== 'string' ||
    !identifier.test(control['operationId'])
  )
    throw new ManagedMcpError('managed_mcp_invalid');
  const base = ['kind', 'sessionKey', 'operationId'];
  if (control['kind'] === 'mcp-status' || control['kind'] === 'mcp-cancel') {
    closed(control, [...base, 'targetOperationId']);
    if (
      typeof control['targetOperationId'] !== 'string' ||
      !identifier.test(control['targetOperationId'])
    )
      throw new ManagedMcpError('managed_mcp_invalid');
    return structuredClone(control) as unknown as ManagedMcpControl;
  }
  if (
    !['mcp-configure', 'mcp-discover', 'mcp-invoke', 'mcp-release'].includes(
      String(control['kind']),
    ) ||
    typeof control['serverId'] !== 'string' ||
    !identifier.test(control['serverId']) ||
    !positive(control['serverRevision'])
  )
    throw new ManagedMcpError('managed_mcp_invalid');
  const server = [...base, 'serverId', 'serverRevision', 'grant'];
  if (control['kind'] === 'mcp-configure') {
    closed(control, [...server, 'configRevision', 'definitionDigest']);
    if (
      !positive(control['configRevision']) ||
      typeof control['definitionDigest'] !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(control['definitionDigest'])
    )
      throw new ManagedMcpError('managed_mcp_invalid');
  } else {
    if (!positive(control['connectionGeneration']))
      throw new ManagedMcpError('managed_mcp_invalid');
    if (control['kind'] === 'mcp-invoke') {
      closed(control, [
        ...server,
        'configRevision',
        'connectionGeneration',
        'catalogRevision',
        'request',
      ]);
      if (
        !positive(control['configRevision']) ||
        !positive(control['catalogRevision'])
      )
        throw new ManagedMcpError('managed_mcp_invalid');
      const request = object(control['request']);
      if (request['kind'] === 'resource_read') {
        closed(request, ['kind', 'uri']);
        if (typeof request['uri'] !== 'string' || request['uri'].length === 0)
          throw new ManagedMcpError('managed_mcp_invalid');
      } else if (
        request['kind'] === 'tool_call' ||
        request['kind'] === 'prompt_get'
      ) {
        closed(request, ['kind', 'name', 'arguments']);
        if (typeof request['name'] !== 'string' || request['name'].length === 0)
          throw new ManagedMcpError('managed_mcp_invalid');
        object(request['arguments']);
        if (request['kind'] === 'prompt_get' && !strings(request['arguments']))
          throw new ManagedMcpError('managed_mcp_invalid');
      } else throw new ManagedMcpError('managed_mcp_invalid');
    } else closed(control, [...server, 'connectionGeneration']);
  }
  try {
    parseOperationGrant(control['grant']);
  } catch {
    throw new ManagedMcpError('managed_mcp_grant_invalid');
  }
  return structuredClone(control) as unknown as ManagedMcpControl;
}

export function loadManagedMcpManifest(
  file: string | undefined,
): ManagedMcpManifest {
  if (!file) return { version: 1, servers: [] };
  try {
    const bytes = readFileSync(file);
    if (bytes.length > MAX_MANIFEST_BYTES)
      throw new ManagedMcpError('managed_mcp_manifest_invalid');
    return parseManifest(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    throw error instanceof ManagedMcpError
      ? error
      : new ManagedMcpError('managed_mcp_manifest_invalid');
  }
}

function parseManifest(value: unknown): ManagedMcpManifest {
  const manifest = object(value);
  closed(manifest, ['version', 'servers']);
  if (manifest['version'] !== 1 || !Array.isArray(manifest['servers']))
    throw new ManagedMcpError('managed_mcp_manifest_invalid');
  const keys = new Set<string>();
  for (const item of manifest['servers']) {
    const definition = object(item);
    closed(definition, [
      'tenantId',
      'workspaceId',
      'serverId',
      'serverRevision',
      'definitionDigest',
      'transport',
      'command',
      'args',
      'env',
      'url',
      'headers',
      'timeoutMs',
    ]);
    if (
      ['tenantId', 'workspaceId', 'serverId'].some(
        (key) =>
          typeof definition[key] !== 'string' ||
          !identifier.test(definition[key] as string),
      ) ||
      !positive(definition['serverRevision']) ||
      typeof definition['definitionDigest'] !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(definition['definitionDigest'])
    )
      throw new ManagedMcpError('managed_mcp_manifest_invalid');
    if (
      definition['timeoutMs'] !== undefined &&
      (!positive(definition['timeoutMs']) ||
        Number(definition['timeoutMs']) > REQUEST_TIMEOUT_MS)
    )
      throw new ManagedMcpError('managed_mcp_manifest_invalid');
    const id = `${definition['tenantId']}\0${definition['workspaceId']}\0${definition['serverId']}\0${definition['serverRevision']}`;
    if (keys.has(id))
      throw new ManagedMcpError('managed_mcp_definition_conflict');
    keys.add(id);
    if (definition['transport'] === 'stdio') {
      if (
        typeof definition['command'] !== 'string' ||
        !definition['command'] ||
        definition['command'].includes('\0') ||
        definition['url'] !== undefined ||
        definition['headers'] !== undefined ||
        (definition['args'] !== undefined &&
          (!Array.isArray(definition['args']) ||
            !definition['args'].every(
              (arg) => typeof arg === 'string' && !arg.includes('\0'),
            ))) ||
        (definition['env'] !== undefined &&
          (!strings(definition['env']) ||
            Object.entries(definition['env']).some(
              ([key, value]) => key.includes('\0') || value.includes('\0'),
            )))
      )
        throw new ManagedMcpError('managed_mcp_manifest_invalid');
    } else if (
      definition['transport'] === 'streamable-http' ||
      definition['transport'] === 'sse'
    ) {
      if (
        typeof definition['url'] !== 'string' ||
        definition['command'] !== undefined ||
        definition['args'] !== undefined ||
        definition['env'] !== undefined ||
        (definition['headers'] !== undefined && !strings(definition['headers']))
      )
        throw new ManagedMcpError('managed_mcp_manifest_invalid');
      const url = new URL(definition['url']);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new ManagedMcpError('managed_mcp_manifest_invalid');
    } else throw new ManagedMcpError('managed_mcp_transport_unsupported');
  }
  return structuredClone(manifest) as unknown as ManagedMcpManifest;
}

export class ManagedMcpRuntime {
  private readonly definitions: ManagedMcpManifest;
  private readonly connections = new Map<string, Connection>();
  private readonly operations = new Map<string, Operation>();
  private readonly gates = new ManagedOperationGrantGate();
  private generation = 0;
  private closing = false;
  private admissionSealed = false;
  private grantInstalled = false;
  private pendingStarts = 0;

  constructor(
    private readonly workspace: {
      tenantId: string;
      workspaceId: string;
      workspaceGeneration: string;
    },
    private readonly sessionDirectory: (
      runtimeSessionId: string,
    ) => Promise<string | undefined>,
    manifest: ManagedMcpManifest,
  ) {
    this.definitions = parseManifest(manifest);
  }

  sealAdmission(): void {
    this.admissionSealed = true;
  }

  getDrainInspection(): {
    pendingStarts: number;
    pendingInvocations: number;
    hasActivity: boolean;
  } {
    return {
      pendingStarts: this.pendingStarts,
      pendingInvocations: [...this.operations.values()].filter(
        (operation) =>
          operation.view.state === 'running' ||
          operation.connection?.pending.has(operation.control.operationId),
      ).length,
      hasActivity:
        this.grantInstalled ||
        this.operations.size > 0 ||
        this.connections.size > 0,
    };
  }

  private assertAdmission(control: ManagedMcpControl): void {
    if (this.admissionSealed && control.kind !== 'mcp-release')
      throw new ManagedMcpError('managed_mcp_closed');
  }

  async control(
    runtimeSessionId: string,
    value: unknown,
    allowTool = false,
  ): Promise<ManagedMcpOperationView> {
    const control = parseManagedMcpControl(value);
    this.assertScope(control.sessionKey);
    if (
      control.kind === 'mcp-invoke' &&
      control.request.kind === 'tool_call' &&
      !allowTool
    )
      throw new ManagedMcpError('managed_mcp_tool_requires_execution');
    if (control.kind === 'mcp-status' || control.kind === 'mcp-cancel') {
      const existing = this.operations.get(
        `${scope(control.sessionKey)}\0${control.targetOperationId}`,
      );
      if (!existing || existing.runtimeSessionId !== runtimeSessionId)
        return {
          operationId: control.targetOperationId,
          state: 'outcome_unknown',
        };
      // SDK servers suppress replies after native cancellation. Keep observing
      // the original request so cancellation cannot destroy settlement evidence.
      return structuredClone(existing.view);
    }
    if (!('grant' in control)) throw new ManagedMcpError('managed_mcp_invalid');
    const key = `${scope(control.sessionKey)}\0${control.operationId}`;
    const { grant: _grant, ...effect } = control;
    const content = fingerprint(effect);
    const existing = this.operations.get(key);
    if (existing) {
      if (
        existing.runtimeSessionId !== runtimeSessionId ||
        existing.fingerprint !== content
      )
        throw new ManagedMcpError('managed_mcp_operation_conflict');
      return structuredClone(existing.view);
    }
    if (this.closing) throw new ManagedMcpError('managed_mcp_closed');
    this.assertAdmission(control);
    const phase = control.kind.slice(4);
    const grant = parseOperationGrant(control.grant);
    if (
      ((control.kind === 'mcp-configure' ||
        (control.kind === 'mcp-invoke' &&
          control.request.kind !== 'tool_call')) &&
        grant.operationId !== control.operationId) ||
      scope(grant.sessionKey) !== scope(control.sessionKey) ||
      grant.workspaceGeneration !== this.workspace.workspaceGeneration ||
      grant.domain !==
        (control.kind === 'mcp-invoke' && control.request.kind !== 'tool_call'
          ? 'mcp_operation'
          : 'mcp_configuration')
    )
      throw new ManagedMcpError('managed_mcp_grant_invalid');
    try {
      this.gates.install(grant);
      this.grantInstalled = true;
    } catch {
      throw new ManagedMcpError('managed_mcp_grant_invalid');
    }
    if (
      !this.gates.admits(
        control.sessionKey,
        grant.operationId,
        phase,
        Date.now(),
      )
    )
      throw new ManagedMcpError('managed_mcp_grant_invalid');
    let directory: string | undefined;
    if (control.kind !== 'mcp-release') {
      this.pendingStarts++;
      try {
        directory = await this.sessionDirectory(runtimeSessionId);
      } finally {
        this.pendingStarts--;
      }
    }
    if (!directory && control.kind !== 'mcp-release')
      throw new ManagedMcpError('managed_mcp_session_unavailable');
    // Another identical request may have entered while its directory was checked.
    if (this.operations.has(key))
      return this.control(runtimeSessionId, control, allowTool);
    this.assertAdmission(control);
    if (
      this.closing ||
      !this.gates.admits(
        control.sessionKey,
        grant.operationId,
        phase,
        Date.now(),
      )
    )
      throw new ManagedMcpError('managed_mcp_grant_invalid');
    let resolve: () => void = () => undefined;
    const done = new Promise<void>((complete) => {
      resolve = complete;
    });
    const operation: Operation = {
      fingerprint: content,
      runtimeSessionId,
      control,
      view: { operationId: control.operationId, state: 'running' },
      done,
      resolve,
    };
    this.operations.set(key, operation);
    if (control.kind === 'mcp-invoke') {
      this.invoke(operation, control);
    } else {
      void this.configureOrMaintain(operation, directory).catch(
        (error: unknown) => {
          this.settled(operation, {
            error: {
              code:
                error instanceof ManagedMcpError
                  ? error.code
                  : 'managed_mcp_connection_failed',
            },
          });
        },
      );
    }
    return structuredClone(operation.view);
  }

  async invokeTool(
    runtimeSessionId: string,
    input: unknown,
  ): Promise<ManagedMcpOperationView> {
    const control = parseManagedMcpControl(input);
    if (control.kind !== 'mcp-invoke' || control.request.kind !== 'tool_call')
      throw new ManagedMcpError('managed_mcp_invalid');
    await this.control(runtimeSessionId, control, true);
    const operation = this.operations.get(
      `${scope(control.sessionKey)}\0${control.operationId}`,
    )!;
    await operation.done;
    return structuredClone(operation.view);
  }

  hasHolds(runtimeSessionId: string): boolean {
    return [...this.connections.values()].some(
      (entry) =>
        entry.runtimeSessionId === runtimeSessionId &&
        (!entry.closed || entry.pending.size > 0),
    );
  }

  toolStatus(
    runtimeSessionId: string,
    input: unknown,
  ): ManagedMcpOperationView {
    const control = parseManagedMcpControl(input);
    const operation = this.operations.get(
      `${scope(control.sessionKey)}\0${control.operationId}`,
    );
    return operation?.runtimeSessionId === runtimeSessionId
      ? structuredClone(operation.view)
      : { operationId: control.operationId, state: 'outcome_unknown' };
  }

  cancelTool(runtimeSessionId: string, input: unknown): void {
    const control = parseManagedMcpControl(input);
    void this.control(runtimeSessionId, {
      kind: 'mcp-cancel',
      sessionKey: control.sessionKey,
      operationId: control.operationId,
      targetOperationId: control.operationId,
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(
      [...this.connections.values()].map((entry) =>
        this.closeConnection(entry),
      ),
    );
  }

  private assertScope(key: ManagedSessionKey): void {
    if (
      key.tenantId !== this.workspace.tenantId ||
      key.workspaceId !== this.workspace.workspaceId
    )
      throw new ManagedMcpError('managed_mcp_scope_conflict');
  }

  private connection(
    operation: Operation,
    control: Exclude<ManagedMcpControl, ManagedMcpConfigure>,
  ): Connection {
    if (!('serverId' in control) || !('connectionGeneration' in control))
      throw new ManagedMcpError('managed_mcp_invalid');
    const connection = this.connections.get(
      bindingKey(
        operation.runtimeSessionId,
        control.serverId,
        control.serverRevision,
        control.connectionGeneration,
      ),
    );
    if (
      !connection ||
      (connection.closed && control.kind !== 'mcp-release') ||
      scope(connection.sessionKey) !== scope(control.sessionKey) ||
      !('connectionGeneration' in control) ||
      connection.generation !== control.connectionGeneration
    )
      throw new ManagedMcpError('managed_mcp_binding_conflict');
    if (
      'grant' in control &&
      (control.kind !== 'mcp-invoke' || control.request.kind === 'tool_call') &&
      control.grant.operationId !== connection.configurationOperationId
    )
      throw new ManagedMcpError('managed_mcp_grant_invalid');
    return connection;
  }

  private async configureOrMaintain(
    operation: Operation,
    directory: string | undefined,
  ): Promise<void> {
    const control = operation.control;
    if (control.kind === 'mcp-configure') {
      const definition = this.definitions.servers.find(
        (item) =>
          item.tenantId === control.sessionKey.tenantId &&
          item.workspaceId === control.sessionKey.workspaceId &&
          item.serverId === control.serverId &&
          item.serverRevision === control.serverRevision,
      );
      if (
        !definition ||
        definition.definitionDigest !== control.definitionDigest
      )
        throw new ManagedMcpError('managed_mcp_definition_unavailable');
      const siblings = [...this.connections.values()].filter(
        (entry) =>
          entry.runtimeSessionId === operation.runtimeSessionId &&
          entry.definition.serverId === control.serverId,
      );
      if (
        siblings.some(
          (entry) =>
            entry.configRevision >= control.configRevision ||
            entry.definition.serverRevision > control.serverRevision,
        )
      )
        throw new ManagedMcpError('managed_mcp_revision_conflict');
      if (
        [...this.connections.values()].filter((entry) => !entry.closed)
          .length >= MANAGED_MCP_MAX_CONNECTIONS
      )
        throw new ManagedMcpError('managed_mcp_connection_quota');
      const transport =
        definition.transport === 'stdio'
          ? new StdioClientTransport({
              command: definition.command!,
              args: definition.args,
              cwd: directory!,
              stderr: 'pipe',
              env: {
                ...Object.fromEntries(
                  DEFAULT_INHERITED_ENV_VARS.map((key) => [key, '']),
                ),
                PATH: process.env['PATH'] ?? '',
                HOME: directory!,
                USERPROFILE: directory!,
                ...(process.env['SystemRoot']
                  ? { SYSTEMROOT: process.env['SystemRoot'] }
                  : {}),
                ...definition.env,
              },
            })
          : definition.transport === 'streamable-http'
            ? new StreamableHTTPClientTransport(new URL(definition.url!), {
                requestInit: { headers: definition.headers, redirect: 'error' },
              })
            : new SSEClientTransport(new URL(definition.url!), {
                requestInit: { headers: definition.headers, redirect: 'error' },
                eventSourceInit: {
                  fetch: (url, init) =>
                    fetch(url, {
                      ...init,
                      redirect: 'error',
                    }),
                },
              });
      const client = new Client(
        { name: 'qwen-managed-mcp', version: '1' },
        { capabilities: {} },
      );
      if (transport instanceof StdioClientTransport)
        transport.stderr?.on('data', () => undefined);
      let confirmClose: () => void = () => undefined;
      const closeDone = new Promise<void>((resolve) => {
        confirmClose = resolve;
      });
      const connection: Connection = {
        runtimeSessionId: operation.runtimeSessionId,
        sessionKey: control.sessionKey,
        definition,
        client,
        transport,
        pending: new Map(),
        drained: new Set(),
        closeDone,
        configRevision: control.configRevision,
        configurationOperationId: control.grant.operationId,
        generation: ++this.generation,
        catalogChanges: { tools: 0, resources: 0, prompts: 0 },
        retiring: false,
        closed: false,
      };
      operation.connection = connection;
      this.connections.set(
        bindingKey(
          operation.runtimeSessionId,
          control.serverId,
          control.serverRevision,
          connection.generation,
        ),
        connection,
      );
      client.onclose = () => {
        connection.closed = true;
        confirmClose();
        for (const pending of connection.pending.values())
          this.unknown(pending, 'managed_mcp_connection_lost');
      };
      client.onerror = () => {
        connection.retiring = true;
        if (connection.pending.size === 0)
          void this.closeConnection(connection).catch(() => undefined);
      };
      try {
        await client.connect(transport, { timeout: TIMEOUT_MS });
        const onmessage = transport.onmessage!;
        transport.onmessage = (message) => {
          if ('method' in message) {
            const changed = {
              'notifications/tools/list_changed': 'tools',
              'notifications/resources/list_changed': 'resources',
              'notifications/prompts/list_changed': 'prompts',
            } as const;
            const kind = Object.hasOwn(changed, message.method)
              ? changed[message.method as keyof typeof changed]
              : undefined;
            if (kind) {
              connection.catalogChanges[kind]++;
              if (connection.catalog)
                connection.catalog = {
                  ...connection.catalog,
                  catalogRevision: connection.catalog.catalogRevision + 1,
                  discovery: {
                    ...connection.catalog.discovery,
                    [kind]: 'stale',
                  },
                };
            }
          }
          if (
            'id' in message &&
            typeof message.id === 'string' &&
            !('method' in message)
          ) {
            const pending = connection.pending.get(message.id);
            if (pending) this.receive(pending, message);
            return;
          }
          onmessage(message);
        };
        await this.discover(connection);
        for (const sibling of siblings) {
          sibling.retiring = true;
          if (sibling.pending.size === 0)
            await this.closeConnection(sibling).catch(() => undefined);
        }
        this.settled(operation, { catalog: connection.catalog! });
      } catch {
        try {
          await this.closeConnection(connection);
        } catch {
          this.unknown(operation, 'managed_mcp_drain_unknown');
          return;
        }
        throw new ManagedMcpError('managed_mcp_connection_failed');
      }
    } else if (control.kind === 'mcp-discover') {
      const connection = this.connection(operation, control);
      if (connection.retiring)
        throw new ManagedMcpError('managed_mcp_retiring');
      if (
        !connection.catalog ||
        Object.values(connection.catalog.discovery).some(
          (state) => state === 'stale' || state === 'failed',
        )
      )
        await this.discover(connection);
      this.settled(operation, { catalog: connection.catalog! });
    } else if (control.kind === 'mcp-release') {
      const connection = this.connection(operation, control);
      connection.retiring = true;
      operation.timer = setTimeout(
        () => this.unknown(operation, 'managed_mcp_drain_unknown'),
        TIMEOUT_MS,
      );
      while (connection.pending.size > 0) {
        await new Promise<void>((resolve) => connection.drained.add(resolve));
      }
      try {
        await this.closeConnection(connection);
      } catch {
        this.unknown(operation, 'managed_mcp_drain_unknown');
        void connection.closeDone.then(() =>
          this.settled(operation, { response: { released: true } }),
        );
        return;
      }
      this.settled(operation, { response: { released: true } });
    }
  }

  private async discover(connection: Connection): Promise<void> {
    connection.catalogWork = (connection.catalogWork ?? Promise.resolve()).then(
      () => this.refreshCatalog(connection),
    );
    return connection.catalogWork;
  }

  private async refreshCatalog(connection: Connection): Promise<void> {
    const previous = connection.catalog;
    const changes = { ...connection.catalogChanges };
    const lists = await Promise.all([
      this.list(connection.client, 'tools', ListToolsResultSchema),
      this.list(connection.client, 'resources', ListResourcesResultSchema),
      this.list(connection.client, 'prompts', ListPromptsResultSchema),
    ]);
    const values = lists.map((result, index) =>
      result.state === 'failed' &&
      previous &&
      [
        previous.discovery.tools,
        previous.discovery.resources,
        previous.discovery.prompts,
      ][index] !== 'failed'
        ? {
            values: [previous.tools, previous.resources, previous.prompts][
              index
            ],
            state: 'stale' as const,
          }
        : result,
    );
    const catalog: ManagedMcpCatalog = {
      serverId: connection.definition.serverId,
      serverRevision: connection.definition.serverRevision,
      definitionDigest: connection.definition.definitionDigest,
      configRevision: connection.configRevision,
      connectionGeneration: connection.generation,
      catalogRevision: connection.catalog?.catalogRevision ?? 0,
      tools: values[0].values as ManagedMcpCatalog['tools'],
      resources: values[1].values as ManagedMcpCatalog['resources'],
      prompts: values[2].values as ManagedMcpCatalog['prompts'],
      discovery: {
        tools:
          changes.tools === connection.catalogChanges.tools
            ? values[0].state
            : 'stale',
        resources:
          changes.resources === connection.catalogChanges.resources
            ? values[1].state
            : 'stale',
        prompts:
          changes.prompts === connection.catalogChanges.prompts
            ? values[2].state
            : 'stale',
      },
    };
    if (fingerprint(catalog) !== fingerprint(connection.catalog ?? null))
      connection.catalog = {
        ...catalog,
        catalogRevision: catalog.catalogRevision + 1,
      };
  }

  private async list(
    client: Client,
    kind: 'tools' | 'resources' | 'prompts',
    schema:
      | typeof ListToolsResultSchema
      | typeof ListResourcesResultSchema
      | typeof ListPromptsResultSchema,
  ) {
    const values: Array<Record<string, unknown>> = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    try {
      do {
        if (cursors.size >= MAX_CATALOG_PAGES) throw new Error('pages');
        const result = await client.request(
          { method: `${kind}/list`, params: cursor ? { cursor } : {} },
          schema,
          { timeout: TIMEOUT_MS },
        );
        const entries = (result as Record<string, unknown>)[kind] as Array<
          Record<string, unknown>
        >;
        for (const entry of entries) {
          const fields =
            kind === 'tools'
              ? ['name', 'description', 'inputSchema']
              : kind === 'resources'
                ? ['name', 'uri', 'description', 'mimeType']
                : ['name', 'description', 'arguments'];
          const value = Object.fromEntries(
            fields
              .filter((name) => entry[name] !== undefined)
              .map((name) => [name, entry[name]]),
          );
          if (
            Buffer.byteLength(JSON.stringify([...values, value])) >
            MAX_CATALOG_CATEGORY_BYTES
          )
            throw new Error('limit');
          values.push(value);
        }
        cursor = result.nextCursor as string | undefined;
        if (cursor && cursors.has(cursor)) throw new Error('cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return { values, state: 'complete' as const };
    } catch (error) {
      if (objectOrUndefined(error)?.['code'] === -32601 && values.length === 0)
        return { values, state: 'complete' as const };
      return {
        values,
        state: values.length > 0 ? ('partial' as const) : ('failed' as const),
      };
    }
  }

  private invoke(operation: Operation, control: ManagedMcpInvoke): void {
    let connection: Connection;
    try {
      connection = this.connection(operation, control);
      const catalog = connection.catalog;
      if (
        connection.retiring ||
        !catalog ||
        catalog.configRevision !== control.configRevision ||
        catalog.catalogRevision !== control.catalogRevision
      )
        throw new ManagedMcpError('managed_mcp_catalog_conflict');
      const request = control.request;
      const permitted =
        request.kind === 'tool_call'
          ? ['complete', 'partial'].includes(catalog.discovery.tools) &&
            catalog.tools.some((tool) => tool.name === request.name)
          : request.kind === 'resource_read'
            ? ['complete', 'partial'].includes(catalog.discovery.resources) &&
              catalog.resources.some((resource) => resource.uri === request.uri)
            : ['complete', 'partial'].includes(catalog.discovery.prompts) &&
              catalog.prompts.some((prompt) => prompt.name === request.name);
      if (!permitted)
        throw new ManagedMcpError('managed_mcp_capability_unavailable');
      if (
        [...this.connections.values()].reduce(
          (count, entry) =>
            count +
            (entry.closed
              ? 0
              : [...entry.pending.values()].filter(
                  (pending) => pending.awaitingReply,
                ).length),
          0,
        ) >= MAX_INFLIGHT
      )
        throw new ManagedMcpError('managed_mcp_inflight_quota');
      operation.connection = connection;
      operation.awaitingReply = true;
      connection.pending.set(control.operationId, operation);
      operation.timer = setTimeout(
        () => this.unknown(operation, 'managed_mcp_timeout'),
        connection.definition.timeoutMs ?? REQUEST_TIMEOUT_MS,
      );
      const method =
        request.kind === 'tool_call'
          ? 'tools/call'
          : request.kind === 'resource_read'
            ? 'resources/read'
            : 'prompts/get';
      const params =
        request.kind === 'resource_read'
          ? { uri: request.uri }
          : { name: request.name, arguments: request.arguments };
      void connection.transport
        .send({ jsonrpc: '2.0', id: control.operationId, method, params })
        .catch(() => this.unknown(operation, 'managed_mcp_send_unknown'));
    } catch (error) {
      this.settled(operation, {
        error: {
          code:
            error instanceof ManagedMcpError
              ? error.code
              : 'managed_mcp_invalid',
        },
      });
    }
  }

  private receive(
    operation: Operation,
    message: { result?: unknown; error?: unknown },
  ): void {
    operation.awaitingReply = false;
    const control = operation.control as ManagedMcpInvoke;
    if (message.error !== undefined) {
      this.settled(operation, { error: { code: 'managed_mcp_remote_error' } });
    } else {
      try {
        const schema =
          control.request.kind === 'tool_call'
            ? CallToolResultSchema
            : control.request.kind === 'resource_read'
              ? ReadResourceResultSchema
              : GetPromptResultSchema;
        const result = schema.parse(message.result);
        if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) {
          this.settled(operation, {
            error: { code: 'managed_mcp_output_limit' },
          });
          return;
        }
        this.settled(operation, {
          response: result as Record<string, unknown>,
        });
      } catch {
        this.unknown(operation, 'managed_mcp_response_invalid');
      }
    }
  }

  private settled(
    operation: Operation,
    result: Pick<ManagedMcpOperationView, 'catalog' | 'response' | 'error'>,
  ): void {
    if (operation.timer) clearTimeout(operation.timer);
    operation.connection?.pending.delete(operation.control.operationId);
    if (operation.connection?.pending.size === 0) {
      for (const resolve of operation.connection.drained) resolve();
      operation.connection.drained.clear();
      if (operation.connection.retiring && !operation.connection.closed)
        void this.closeConnection(operation.connection).catch(() => undefined);
    }
    operation.view = {
      operationId: operation.control.operationId,
      state: 'settled',
      ...result,
    };
    operation.resolve();
  }

  private unknown(operation: Operation, code: string): void {
    if (operation.view.state === 'settled') return;
    if (operation.timer) clearTimeout(operation.timer);
    operation.view = {
      operationId: operation.control.operationId,
      state: 'outcome_unknown',
      error: { code },
    };
    operation.resolve();
  }

  private closeConnection(connection: Connection): Promise<void> {
    if (connection.closed) return Promise.resolve();
    connection.closing ??= this.drainConnection(connection).finally(() => {
      connection.closing = undefined;
    });
    return connection.closing;
  }

  private async drainConnection(connection: Connection): Promise<void> {
    connection.retiring = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          if (connection.transport instanceof StreamableHTTPClientTransport) {
            let terminationTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              // Remote session deletion is advisory once all requests settled.
              await Promise.race([
                connection.transport.terminateSession().catch(() => undefined),
                new Promise<void>((resolve) => {
                  terminationTimer = setTimeout(resolve, 1_000);
                }),
              ]);
            } finally {
              if (terminationTimer) clearTimeout(terminationTimer);
            }
          }
          await connection.client.close();
          await connection.closeDone;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ManagedMcpError('managed_mcp_drain_unknown')),
            5_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function objectOrUndefined(
  value: unknown,
): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}
