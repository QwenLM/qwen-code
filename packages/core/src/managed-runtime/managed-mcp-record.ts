/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isExtensionRunStart,
  isExtensionRunSuccessor,
  parseExtensionRun,
  type ExtensionRun,
} from './managed-extension-record.js';
import {
  assertManagedSessionDurableRef,
  assertManagedSessionSequence,
  assertManagedSessionStableId,
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';

export interface McpConfiguration {
  readonly configurationId: string;
  readonly runtimeSessionId: string;
  readonly serverId: string;
  readonly serverRevision: number;
  readonly configRevision: number;
  readonly catalogRevision: number | null;
  readonly connectionGeneration: number | null;
  readonly catalogRef: ManagedSessionDurableRef | null;
  readonly releaseState: 'active' | 'releasing' | 'drained' | 'released';
  readonly run: ExtensionRun;
}

export interface McpOperation {
  readonly operationId: string;
  readonly configurationId: string;
  readonly serverId: string;
  readonly serverRevision: number;
  readonly configRevision: number;
  readonly catalogRevision: number;
  readonly connectionGeneration: number;
  readonly operationKind: 'resource_read' | 'prompt_get';
  readonly cancelRequested: boolean;
  readonly argsRef: ManagedSessionDurableRef;
  readonly resultRef: ManagedSessionDurableRef | null;
  readonly run: ExtensionRun;
}

const CONFIG_KEYS = [
  'configurationId',
  'runtimeSessionId',
  'serverId',
  'serverRevision',
  'configRevision',
  'catalogRevision',
  'connectionGeneration',
  'catalogRef',
  'releaseState',
  'run',
] as const;
const OPERATION_KEYS = [
  'operationId',
  'configurationId',
  'serverId',
  'serverRevision',
  'configRevision',
  'catalogRevision',
  'connectionGeneration',
  'operationKind',
  'cancelRequested',
  'argsRef',
  'resultRef',
  'run',
] as const;
const CONFIG_FIXED = [
  'configurationId',
  'runtimeSessionId',
  'serverId',
  'serverRevision',
  'configRevision',
] as const;

function fail(message: string): never {
  throw new ManagedSessionRecordError(message);
}

function closed<Key extends string>(
  value: unknown,
  keys: readonly Key[],
): Record<Key, ManagedSessionJsonValue> {
  if (
    typeof value !== 'object' ||
    value === null ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key as Key))
  ) {
    fail(`MCP record must have exactly the keys ${keys.join(', ')}.`);
  }
  return { ...value } as Record<Key, ManagedSessionJsonValue>;
}

function revision(value: ManagedSessionJsonValue, label: string): number {
  const parsed = assertManagedSessionSequence(value, label);
  if (parsed < 1) fail(`${label} must be positive.`);
  return parsed;
}

function ref(value: ManagedSessionJsonValue, label: string) {
  return Object.freeze(assertManagedSessionDurableRef(value, label));
}

function pinnedRun(value: unknown, serverId: string, serverRevision: number) {
  const run = parseExtensionRun(value);
  if (
    run.definition?.definitionId !== serverId ||
    run.definition.definitionRevision !== serverRevision ||
    run.delivery !== null ||
    run.deliveryId !== null ||
    run.dispatchId !== null
  ) {
    fail('MCP run must pin its server definition and have no delivery.');
  }
  return run;
}

function canRelease(run: ExtensionRun): boolean {
  return (
    (run.execution === 'settled' &&
      (run.state === 'settled' || run.state === 'failed')) ||
    (run.execution === 'not_started_proven' && run.state === 'cancelled')
  );
}

export function parseMcpConfiguration(value: unknown): McpConfiguration {
  const body = closed(value, CONFIG_KEYS);
  const serverId = assertManagedSessionStableId(body.serverId, 'serverId');
  const serverRevision = revision(body.serverRevision, 'serverRevision');
  const run = pinnedRun(body.run, serverId, serverRevision);
  if (
    body.releaseState !== 'active' &&
    body.releaseState !== 'releasing' &&
    body.releaseState !== 'drained' &&
    body.releaseState !== 'released'
  ) {
    fail('MCP releaseState must be active, releasing, drained or released.');
  }
  const parsed: McpConfiguration = {
    configurationId: assertManagedSessionStableId(
      body.configurationId,
      'configurationId',
    ),
    runtimeSessionId: assertManagedSessionStableId(
      body.runtimeSessionId,
      'runtimeSessionId',
    ),
    serverId,
    serverRevision,
    configRevision: revision(body.configRevision, 'configRevision'),
    catalogRevision:
      body.catalogRevision === null
        ? null
        : revision(body.catalogRevision, 'catalogRevision'),
    connectionGeneration:
      body.connectionGeneration === null
        ? null
        : revision(body.connectionGeneration, 'connectionGeneration'),
    catalogRef:
      body.catalogRef === null ? null : ref(body.catalogRef, 'catalogRef'),
    releaseState: body.releaseState,
    run,
  };
  if (run.effectId !== parsed.configurationId || run.executionCallId !== null) {
    fail(
      'MCP configuration must identify its physical request through effectId.',
    );
  }
  if (parsed.releaseState !== 'active' && !canRelease(run)) {
    fail('Only a conclusively completed MCP configuration can be released.');
  }
  const published = parsed.catalogRef !== null;
  if (
    published !== (parsed.catalogRevision !== null) ||
    published !== (parsed.connectionGeneration !== null) ||
    published !== (run.state === 'settled') ||
    (published && (run.execution !== 'settled' || run.runtime === null))
  ) {
    fail(
      'MCP configuration publishes its catalog and connection exactly on settlement.',
    );
  }
  return Object.freeze(parsed);
}

export function parseMcpOperation(value: unknown): McpOperation {
  const body = closed(value, OPERATION_KEYS);
  const serverId = assertManagedSessionStableId(body.serverId, 'serverId');
  const serverRevision = revision(body.serverRevision, 'serverRevision');
  const run = pinnedRun(body.run, serverId, serverRevision);
  const operationId = assertManagedSessionStableId(
    body.operationId,
    'operationId',
  );
  if (
    body.operationKind !== 'resource_read' &&
    body.operationKind !== 'prompt_get'
  ) {
    fail('MCP operationKind must be resource_read or prompt_get.');
  }
  if (run.effectId !== operationId || run.executionCallId !== null) {
    fail('MCP operation must identify its physical request through effectId.');
  }
  if (typeof body.cancelRequested !== 'boolean') {
    fail('MCP cancelRequested must be boolean.');
  }
  const parsed: McpOperation = {
    operationId,
    configurationId: assertManagedSessionStableId(
      body.configurationId,
      'configurationId',
    ),
    serverId,
    serverRevision,
    configRevision: revision(body.configRevision, 'configRevision'),
    catalogRevision: revision(body.catalogRevision, 'catalogRevision'),
    connectionGeneration: revision(
      body.connectionGeneration,
      'connectionGeneration',
    ),
    operationKind: body.operationKind,
    cancelRequested: body.cancelRequested,
    argsRef: ref(body.argsRef, 'argsRef'),
    resultRef:
      body.resultRef === null ? null : ref(body.resultRef, 'resultRef'),
    run,
  };
  if (
    (run.state === 'settled' && parsed.resultRef === null) ||
    (parsed.resultRef !== null &&
      (run.execution !== 'settled' || run.runtime === null))
  ) {
    fail(
      'MCP result requires a settled physical response; successful operations need a result.',
    );
  }
  return Object.freeze(parsed);
}

function accepts(check: () => boolean): boolean {
  try {
    return check();
  } catch (error) {
    if (error instanceof ManagedSessionRecordError) return false;
    throw error;
  }
}

export function isMcpConfigurationStart(value: unknown): boolean {
  return accepts(() => isExtensionRunStart(parseMcpConfiguration(value).run));
}

export function isMcpOperationStart(value: unknown): boolean {
  return accepts(() => {
    const record = parseMcpOperation(value);
    return (
      isExtensionRunStart(record.run) &&
      record.resultRef === null &&
      !record.cancelRequested
    );
  });
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isMcpConfigurationSuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  return accepts(() => {
    const before = parseMcpConfiguration(previous);
    const after = parseMcpConfiguration(next);
    return (
      CONFIG_FIXED.every((key) => same(before[key], after[key])) &&
      isExtensionRunSuccessor(before.run, after.run) &&
      (before.releaseState === after.releaseState ||
        (canRelease(before.run) &&
          before.releaseState === 'active' &&
          after.releaseState === 'releasing') ||
        (before.releaseState === 'releasing' &&
          after.releaseState === 'drained') ||
        (before.releaseState === 'drained' &&
          after.releaseState === 'released') ||
        (before.releaseState === 'releasing' &&
          after.releaseState === 'released')) &&
      (before.catalogRef === null ||
        same(
          { ...before, releaseState: null },
          { ...after, releaseState: null },
        ))
    );
  });
}

export function isMcpOperationSuccessor(
  previous: unknown,
  next: unknown,
): boolean {
  return accepts(() => {
    const before = parseMcpOperation(previous);
    const after = parseMcpOperation(next);
    return (
      OPERATION_KEYS.filter(
        (key) =>
          key !== 'run' && key !== 'resultRef' && key !== 'cancelRequested',
      ).every((key) => same(before[key], after[key])) &&
      isExtensionRunSuccessor(before.run, after.run) &&
      (!before.cancelRequested || after.cancelRequested) &&
      (before.resultRef === null || same(before.resultRef, after.resultRef)) &&
      (!['settled', 'failed', 'cancelled'].includes(before.run.state) ||
        same(before, after))
    );
  });
}
