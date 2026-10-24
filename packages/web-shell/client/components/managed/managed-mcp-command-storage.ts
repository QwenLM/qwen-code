import type { ManagedMcpManagementCommand } from './managed-mcp-management-types';

export interface ManagedMcpCommandAttempt {
  command: ManagedMcpManagementCommand;
  requestId: string;
  idempotencyKey: string;
  operationId?: string;
}

export type ManagedMcpCommandTarget = readonly [
  providerKey: string,
  actorScope: string,
  clientId: string,
  workspaceId: string,
  sessionId: string,
];

function storageKey(target: ManagedMcpCommandTarget) {
  return `qwen-managed-mcp-command:v1:${JSON.stringify(target)}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function closed(value: Record<string, unknown>, fields: string[]) {
  return Object.keys(value).every((field) => fields.includes(field));
}

function token(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function validAttempt(value: unknown): value is ManagedMcpCommandAttempt {
  if (
    !record(value) ||
    !closed(value, ['command', 'requestId', 'idempotencyKey', 'operationId']) ||
    !token(value.requestId) ||
    !token(value.idempotencyKey) ||
    (value.operationId !== undefined &&
      (typeof value.operationId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          value.operationId,
        ))) ||
    !record(value.command)
  )
    return false;
  const command = value.command;
  if (
    !closed(command, ['action', 'serverId', 'expectedRevision', 'server']) ||
    typeof command.action !== 'string' ||
    ![
      'add',
      'edit',
      'remove',
      'enable',
      'disable',
      'reload',
      'restart',
    ].includes(command.action) ||
    typeof command.serverId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(command.serverId) ||
    !Number.isSafeInteger(command.expectedRevision) ||
    Number(command.expectedRevision) < 0 ||
    Number(command.expectedRevision) >= Number.MAX_SAFE_INTEGER
  )
    return false;
  const pin = command.server;
  if (command.action !== 'add' && command.action !== 'edit')
    return pin === undefined;
  return (
    record(pin) &&
    closed(pin, ['serverId', 'serverRevision', 'definitionDigest']) &&
    pin.serverId === command.serverId &&
    Number.isSafeInteger(pin.serverRevision) &&
    Number(pin.serverRevision) >= 1 &&
    typeof pin.definitionDigest === 'string' &&
    /^[0-9a-f]{64}$/.test(pin.definitionDigest)
  );
}

export function restoreManagedMcpCommand(
  target: ManagedMcpCommandTarget,
): ManagedMcpCommandAttempt | undefined {
  try {
    const raw = sessionStorage.getItem(storageKey(target));
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (
      record(value) &&
      closed(value, ['target', 'attempt']) &&
      JSON.stringify(value.target) === JSON.stringify(target) &&
      validAttempt(value.attempt)
    )
      return value.attempt;
    sessionStorage.removeItem(storageKey(target));
  } catch {
    // Storage can be disabled by the embedding host.
  }
  return undefined;
}

export function saveManagedMcpCommand(
  target: ManagedMcpCommandTarget,
  attempt: ManagedMcpCommandAttempt | undefined,
): void {
  try {
    if (attempt)
      sessionStorage.setItem(
        storageKey(target),
        JSON.stringify({ target, attempt }),
      );
    else sessionStorage.removeItem(storageKey(target));
  } catch {
    // The Hook retains the same command in memory when storage is unavailable.
  }
}
