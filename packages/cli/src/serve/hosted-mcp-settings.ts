/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  assertManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  parseHostedMcpServers,
  type HostedMcpServerPin,
} from './hosted-mcp-definitions.js';
import {
  HostedMcpSession,
  HostedMcpConflictError,
  HostedMcpRecoveryRequiredError,
} from './hosted-mcp-session.js';
import {
  HostedWorkspaceBroker,
  type HostedWorkspaceBrokerOptions,
} from './hosted-workspace-broker.js';

export type HostedMcpAction =
  | 'add'
  | 'edit'
  | 'remove'
  | 'enable'
  | 'disable'
  | 'reload'
  | 'restart';
export interface HostedMcpSelection extends HostedMcpServerPin {
  readonly state: 'enabled' | 'disabled' | 'removed';
}
export interface HostedMcpCommand {
  readonly operationId: string;
  readonly actorKey: string;
  readonly action: HostedMcpAction;
  readonly serverId: string;
  readonly expectedRevision: number;
  readonly server?: HostedMcpServerPin;
}
export interface HostedMcpSettings {
  readonly revision: number;
  readonly sequence: number;
  readonly servers: readonly HostedMcpSelection[];
  readonly command: HostedMcpCommand;
}
export interface HostedMcpCommandStatus {
  readonly operationId: string;
  readonly action: HostedMcpAction;
  readonly serverId: string;
  readonly revision: number;
  readonly state: 'pending' | 'settled' | 'failed' | 'recovery_required';
  readonly error?: { readonly code: string };
}

export function selectedMcpServers(
  previous: readonly HostedMcpSelection[],
  command: HostedMcpCommand,
): readonly HostedMcpSelection[] {
  const selected = new Map(previous.map((pin) => [pin.serverId, pin]));
  const current = selected.get(command.serverId);
  const present = current && current.state !== 'removed';
  if ((command.action === 'add') === Boolean(present))
    throw new HostedMcpConflictError('MCP server selection conflicts.');
  if (command.action === 'add' || command.action === 'edit') {
    if (
      !command.server ||
      (current && command.server.serverRevision < current.serverRevision)
    )
      throw new HostedMcpConflictError('MCP definition revision conflicts.');
    selected.set(command.serverId, {
      ...command.server,
      state:
        command.action === 'edit' && current?.state === 'disabled'
          ? 'disabled'
          : 'enabled',
    });
  } else {
    if (
      !current ||
      current.state === 'removed' ||
      (command.action === 'enable'
        ? current.state !== 'disabled'
        : current.state !== 'enabled' && command.action !== 'remove')
    )
      throw new HostedMcpConflictError('MCP server state conflicts.');
    selected.set(command.serverId, {
      ...current,
      state:
        command.action === 'remove'
          ? 'removed'
          : command.action === 'disable'
            ? 'disabled'
            : 'enabled',
    });
  }
  const servers = [...selected.values()];
  if (
    servers.length > 32 ||
    servers.filter((pin) => pin.state === 'enabled').length > 16
  )
    throw new HostedMcpConflictError('MCP selection exceeds its capacity.');
  return servers;
}

export function validateHostedMcpHistory(
  admission: readonly HostedMcpServerPin[],
  history: readonly HostedMcpSettings[],
): void {
  let previous: readonly HostedMcpSelection[] = admission.map((pin) => ({
    ...pin,
    state: 'enabled',
  }));
  for (const settings of history) {
    if (
      JSON.stringify(selectedMcpServers(previous, settings.command)) !==
      JSON.stringify(settings.servers)
    )
      throw new Error('MCP settings history conflicts.');
    previous = settings.servers;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid MCP settings.');
  return value as Record<string, unknown>;
}

export function parseHostedMcpCommand(value: unknown): HostedMcpCommand {
  const command = object(value);
  const action = command['action'];
  const needsServer = action === 'add' || action === 'edit';
  const keys = [
    'operationId',
    'actorKey',
    'action',
    'serverId',
    'expectedRevision',
    ...(needsServer ? ['server'] : []),
  ];
  if (
    Object.keys(command).length !== keys.length ||
    Object.keys(command).some((key) => !keys.includes(key)) ||
    typeof command['operationId'] !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      command['operationId'],
    ) ||
    typeof command['actorKey'] !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(command['actorKey']) ||
    ![
      'add',
      'edit',
      'remove',
      'enable',
      'disable',
      'reload',
      'restart',
    ].includes(String(action)) ||
    typeof command['serverId'] !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(command['serverId']) ||
    !Number.isSafeInteger(command['expectedRevision']) ||
    Number(command['expectedRevision']) < 0 ||
    Number(command['expectedRevision']) >= Number.MAX_SAFE_INTEGER
  )
    throw new Error('Invalid MCP command.');
  const pin = needsServer
    ? parseHostedMcpServers([command['server']])[0]
    : undefined;
  if (pin && pin.serverId !== command['serverId'])
    throw new Error('MCP command server identity conflicts.');
  return {
    operationId: command['operationId'],
    actorKey: command['actorKey'],
    action: action as HostedMcpAction,
    serverId: command['serverId'],
    expectedRevision: Number(command['expectedRevision']),
    ...(pin ? { server: pin } : {}),
  };
}

export async function readHostedMcpSettings(
  session: ManagedSession,
): Promise<readonly HostedMcpSettings[]> {
  const latest = session.authority.domainRecord('config_install');
  if (!latest) return [];
  let ref: typeof latest.recordRef | undefined = latest.recordRef;
  let revision = latest.revision;
  const history: HostedMcpSettings[] = [];
  const seen = new Set<string>();
  const sequences = new Map(
    session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .filter(
        (event) =>
          event.kind === 'domain.committed' &&
          event.payload['domain'] === 'config_install',
      )
      .map((event) => [
        (event.payload['recordRef'] as { resourceId: string }).resourceId,
        event.sequence,
      ]),
  );
  while (ref) {
    if (
      ref.kind !== 'managed-config_install' ||
      ref.schemaVersion !== 1 ||
      seen.has(ref.resourceId)
    )
      throw new Error('Invalid MCP settings history.');
    seen.add(ref.resourceId);
    const body = object(
      JSON.parse((await session.resources.read(ref)).toString('utf8')),
    );
    if (
      Object.keys(body).sort().join(',') !==
        'command,kind,operationId,previousRecordRef,revision,schemaVersion,servers' ||
      body['kind'] !== 'hosted-mcp-settings' ||
      body['schemaVersion'] !== 1 ||
      body['revision'] !== revision ||
      !Array.isArray(body['servers']) ||
      body['servers'].length > 32
    )
      throw new Error('Invalid MCP settings.');
    const command = parseHostedMcpCommand(body['command']);
    if (
      command.operationId !== body['operationId'] ||
      command.expectedRevision + 1 !== revision
    )
      throw new Error('MCP settings command revision conflicts.');
    const ids = new Set<string>();
    const servers = body['servers'].map(
      (value: unknown): HostedMcpSelection => {
        const { state, ...pin } = object(value);
        const [parsed] = parseHostedMcpServers([pin]);
        if (
          !['enabled', 'disabled', 'removed'].includes(String(state)) ||
          ids.has(parsed.serverId)
        )
          throw new Error('Invalid MCP selection.');
        ids.add(parsed.serverId);
        return { ...parsed, state: state as HostedMcpSelection['state'] };
      },
    );
    const sequence = sequences.get(ref.resourceId);
    if (sequence === undefined)
      throw new Error('MCP settings intent is missing.');
    history.push({ revision, sequence, command, servers });
    if (body['previousRecordRef'] === null) {
      if (revision !== 1) throw new Error('Missing MCP settings predecessor.');
      ref = undefined;
    } else {
      ref = assertManagedSessionDurableRef(
        body['previousRecordRef'] as ManagedSessionJsonValue,
        'MCP settings predecessor',
      );
      revision--;
    }
  }
  return history.reverse();
}

export async function commitHostedMcpSettings(
  session: ManagedSession,
  command: HostedMcpCommand,
  servers: readonly HostedMcpSelection[],
): Promise<HostedMcpSettings> {
  const content = {
    kind: 'hosted-mcp-settings',
    schemaVersion: 1,
    servers,
    command,
  };
  const receipt = await session.authority.commitDomainRecord(
    {
      operation: 'manageMcp',
      commandId: command.operationId,
      sessionKey: session.authority.sessionHeader.sessionKey,
      contentDigest: createHash('sha256')
        .update(JSON.stringify(command))
        .digest('hex'),
    },
    { domain: 'config_install', content },
    { class: 'trusted_entry' },
  );
  if (receipt.revision !== command.expectedRevision + 1)
    throw new Error('MCP settings revision conflicts.');
  return {
    revision: receipt.revision,
    sequence: receipt.receipt.firstSequence,
    servers,
    command,
  };
}

export class HostedMcpManager {
  private history: readonly HostedMcpSettings[] = [];

  constructor(
    private readonly session: ManagedSession,
    private readonly admission: readonly HostedMcpServerPin[],
    private readonly options: HostedWorkspaceBrokerOptions,
    public mcp?: HostedMcpSession,
    private readonly hookBroker?: () => HostedWorkspaceBroker | undefined,
  ) {}

  private inventoryBroker(): {
    broker: HostedWorkspaceBroker;
    originalOwner: boolean;
  } {
    const configurations =
      this.session.authority.extensionRecordsInDomain('mcp_configuration');
    const hooks =
      this.session.authority.extensionRecordsInDomain('hook_execution');
    const broker =
      this.mcp?.broker ??
      this.hookBroker?.() ??
      new HostedWorkspaceBroker(
        this.options,
        this.session.authority.sessionHeader.sessionKey,
        'mcp-management-inventory',
      );
    const originalOwner = [...configurations, ...hooks].some(
      (entry) =>
        object(entry.record)['runtimeSessionId'] === broker.runtimeSessionId &&
        entry.run.runtime !== null,
    );
    return { broker, originalOwner };
  }

  async open(): Promise<void> {
    await this.session.authority.settlePendingAppend();
    this.history = await readHostedMcpSettings(this.session);
    validateHostedMcpHistory(this.admission, this.history);
  }

  status(operationId: string): HostedMcpCommandStatus | undefined {
    const settings = this.history.find(
      (entry) => entry.command.operationId === operationId,
    );
    if (!settings) return undefined;
    return (
      this.mcp?.managementStatus(settings) ?? {
        operationId,
        action: settings.command.action,
        serverId: settings.command.serverId,
        revision: settings.revision,
        state: 'pending',
      }
    );
  }

  async snapshot(
    inventory = true,
    operationId = this.history.at(-1)?.command.operationId,
  ) {
    const settings = this.history.at(-1);
    const { broker, originalOwner } = this.inventoryBroker();
    return {
      sessionId: this.session.authority.sessionHeader.sessionKey.sessionId,
      revision: settings?.revision ?? 0,
      supported: true,
      availableServers: inventory
        ? await broker.mcpDefinitions(originalOwner)
        : [],
      servers:
        settings?.servers ??
        this.admission.map((pin) => ({ ...pin, state: 'enabled' as const })),
      ...(operationId ? { operation: this.status(operationId)! } : {}),
    };
  }

  async submit(command: HostedMcpCommand): Promise<void> {
    const replay = this.history.find(
      (entry) => entry.command.operationId === command.operationId,
    );
    if (replay) {
      if (JSON.stringify(replay.command) !== JSON.stringify(command))
        throw new HostedMcpConflictError('MCP command identity conflicts.');
      const status = this.status(command.operationId)!;
      if (status.state === 'settled' || status.state === 'failed') return;
      if (this.history.at(-1) !== replay)
        throw new HostedMcpRecoveryRequiredError();
      this.mcp ??= new HostedMcpSession(
        this.options,
        this.session,
        this.admission,
        replay,
        this.hookBroker?.(),
      );
      await this.mcp.manage(replay);
      return;
    }
    const previous = this.history.at(-1);
    if (command.expectedRevision !== (previous?.revision ?? 0))
      throw new HostedMcpConflictError('MCP settings revision conflicts.');
    if (
      (previous &&
        !['settled', 'failed'].includes(
          this.status(previous.command.operationId)!.state,
        )) ||
      this.mcp?.hasPendingOperations() ||
      this.mcp?.hasUnsettledConfigurations ||
      (!previous && this.mcp?.recoveryBlocked)
    )
      throw new HostedMcpRecoveryRequiredError();
    const servers = selectedMcpServers(
      previous?.servers ??
        this.admission.map((pin) => ({ ...pin, state: 'enabled' as const })),
      command,
    );
    const { broker, originalOwner } = this.inventoryBroker();
    const available = await broker.mcpDefinitions(originalOwner);
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
    const settings = await commitHostedMcpSettings(
      this.session,
      command,
      servers,
    );
    this.history = [...this.history, settings];
    this.mcp ??= new HostedMcpSession(
      this.options,
      this.session,
      this.admission,
      settings,
      this.hookBroker?.(),
    );
    await this.mcp.manage(settings);
  }
}
