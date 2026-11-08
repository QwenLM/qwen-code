/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  assertManagedSessionDurableRef,
  ManagedSessionRecordError,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';
import type { ManagedHookCatalogPin } from './managed-hook-protocol.js';
import type { ManagedPackageContributions } from '../extension/managed-package.js';
import type { OperationGrant } from './managed-extension-record.js';

export interface ManagedExtensionCommandControl {
  readonly kind: 'extension-command';
  readonly operationId: string;
  readonly action: 'execute' | 'status' | 'cancel';
  readonly grant: OperationGrant;
  readonly toolName: 'read_file' | 'shell';
  readonly input: Readonly<Record<string, unknown>>;
  readonly revision: number;
  readonly extensionId: string;
}

export interface ManagedExtensionPin {
  readonly extensionId: string;
  readonly packageRevision: number;
  readonly packageDigest: string;
  readonly settingsRevision?: number;
}

export interface ManagedExtensionApplyCommand {
  readonly operationId: string;
  readonly actorKey: string;
  readonly expectedRevision: number;
  readonly extensions: readonly ManagedExtensionPin[];
  readonly mcpChange?: ManagedExtensionMcpChange;
}

export interface ManagedExtensionMcpPin {
  readonly serverId: string;
  readonly serverRevision: number;
  readonly definitionDigest: string;
}

export interface ManagedExtensionMcpSelection extends ManagedExtensionMcpPin {
  readonly state: 'enabled' | 'disabled' | 'removed';
}

export interface ManagedExtensionMcpChange {
  readonly action:
    | 'add'
    | 'edit'
    | 'remove'
    | 'enable'
    | 'disable'
    | 'reload'
    | 'restart';
  readonly serverId: string;
  readonly expectedRevision: number;
  readonly servers: readonly ManagedExtensionMcpSelection[];
}

export interface ManagedExtensionPackageView {
  readonly pin: ManagedExtensionPin;
  readonly assetRoot: string;
  readonly contributionsRef: ManagedSessionDurableRef;
}

export interface ManagedExtensionEffectiveBundle {
  readonly kind: 'managed-extension-config-bundle';
  readonly formatVersion: 1;
  readonly configRevision: number;
  readonly executionMode: 'linux-cgroup' | 'developer-process-group';
  readonly mcpRevision: number;
  readonly independentMcpSelections: readonly ManagedExtensionMcpSelection[];
  readonly mcpChange?: ManagedExtensionMcpChange;
  readonly baseMcpServers: readonly ManagedExtensionMcpPin[];
  readonly baseHookCatalog: ManagedHookCatalogPin | null;
  readonly packages: readonly ManagedExtensionPackageView[];
  readonly mcpServers: readonly ManagedExtensionMcpPin[];
  readonly hookCatalog: ManagedHookCatalogPin | null;
}

export interface ManagedExtensionPreparedPackage {
  readonly pin: ManagedExtensionPin;
  readonly assetRoot: string;
  readonly contributions: ManagedPackageContributions;
}

export interface ManagedExtensionPrepareResult {
  readonly operationId: string;
  readonly state: 'prepared';
  readonly expectedRevision: number;
  readonly revision: number;
  readonly executionMode: 'linux-cgroup' | 'developer-process-group';
  readonly packages: readonly ManagedExtensionPreparedPackage[];
  readonly mcpServers: readonly ManagedExtensionMcpPin[];
  readonly hookCatalog: ManagedHookCatalogPin | null;
}

export type ManagedExtensionRuntimeControl =
  | {
      readonly kind: 'extension-prepare';
      readonly operationId: string;
      readonly command: ManagedExtensionApplyCommand;
      readonly expectedRevision: number;
      readonly extensions: readonly ManagedExtensionPin[];
      readonly baseMcpServers: readonly ManagedExtensionMcpPin[];
      readonly baseHookCatalog: ManagedHookCatalogPin | null;
    }
  | {
      readonly kind: 'extension-activate';
      readonly operationId: string;
      readonly expectedRevision: number;
      readonly revision: number;
    }
  | { readonly kind: 'extension-status'; readonly operationId: string }
  | {
      readonly kind: 'extension-reconcile';
      readonly operationId: string;
      readonly expectedRevision: number;
      readonly revision: number;
    }
  | {
      readonly kind: 'extension-asset-read';
      readonly operationId: string;
      readonly revision: number;
      readonly extensionId: string;
      readonly path: string;
    }
  | {
      readonly kind: 'extension-asset-glob';
      readonly operationId: string;
      readonly revision: number;
      readonly extensionId: string;
      readonly pattern: string;
    };

export const MANAGED_EXTENSION_MAX_PACKAGES = 32;

export function parseManagedExtensionEffectiveBundle(
  value: unknown,
): ManagedExtensionEffectiveBundle {
  const bundle = object(value, 'effective extension configuration');
  keys(
    bundle,
    [
      'kind',
      'formatVersion',
      'configRevision',
      'executionMode',
      'mcpRevision',
      'independentMcpSelections',
      'baseMcpServers',
      'baseHookCatalog',
      'packages',
      'mcpServers',
      'hookCatalog',
    ],
    ['mcpChange'],
    'effective extension configuration',
  );
  if (
    bundle['kind'] !== 'managed-extension-config-bundle' ||
    bundle['formatVersion'] !== 1 ||
    !['linux-cgroup', 'developer-process-group'].includes(
      String(bundle['executionMode']),
    ) ||
    !revision(bundle['configRevision'], 0) ||
    !revision(bundle['mcpRevision'], 0) ||
    !Array.isArray(bundle['packages']) ||
    bundle['packages'].length > MANAGED_EXTENSION_MAX_PACKAGES
  )
    invalid('effective extension configuration');
  const packages = bundle['packages'].map(
    (value): ManagedExtensionPackageView => {
      const entry = object(value, 'package view');
      keys(entry, ['pin', 'assetRoot', 'contributionsRef'], [], 'package view');
      const pin = parseManagedExtensionPin(entry['pin']);
      if (entry['assetRoot'] !== `extension://${pin.extensionId}/`)
        invalid('package asset root');
      const contributionsRef = assertManagedSessionDurableRef(
        entry['contributionsRef'] as ManagedSessionJsonValue,
        'package contributions',
      );
      if (
        contributionsRef.kind !== 'managed-extension-contributions' ||
        contributionsRef.schemaVersion !== 1
      )
        invalid('package contributions');
      return { pin, assetRoot: entry['assetRoot'] as string, contributionsRef };
    },
  );
  if (
    new Set(packages.map((entry) => entry.pin.extensionId)).size !==
    packages.length
  )
    invalid('duplicate package view');
  return {
    kind: 'managed-extension-config-bundle',
    formatVersion: 1,
    configRevision: bundle['configRevision'] as number,
    executionMode: bundle[
      'executionMode'
    ] as ManagedExtensionEffectiveBundle['executionMode'],
    mcpRevision: bundle['mcpRevision'] as number,
    independentMcpSelections: mcpSelections(bundle['independentMcpSelections']),
    ...(bundle['mcpChange'] === undefined
      ? {}
      : { mcpChange: mcpChange(bundle['mcpChange']) }),
    baseMcpServers: mcpPins(bundle['baseMcpServers']),
    baseHookCatalog: hookPin(bundle['baseHookCatalog']),
    packages,
    mcpServers: mcpPins(bundle['mcpServers']),
    hookCatalog: hookPin(bundle['hookCatalog']),
  };
}

function mcpPins(value: unknown): readonly ManagedExtensionMcpPin[] {
  if (!Array.isArray(value) || value.length > 32) invalid('MCP selection');
  const pins = value.map((value): ManagedExtensionMcpPin => {
    const pin = object(value, 'MCP pin');
    keys(
      pin,
      ['serverId', 'serverRevision', 'definitionDigest'],
      [],
      'MCP pin',
    );
    const identity = parseManagedExtensionPin({
      extensionId: pin['serverId'],
      packageRevision: pin['serverRevision'],
      packageDigest: pin['definitionDigest'],
    });
    return {
      serverId: identity.extensionId,
      serverRevision: identity.packageRevision,
      definitionDigest: identity.packageDigest,
    };
  });
  if (new Set(pins.map((pin) => pin.serverId)).size !== pins.length)
    invalid('duplicate MCP pin');
  return pins;
}

function hookPin(value: unknown): ManagedHookCatalogPin | null {
  if (value === null) return null;
  const pin = object(value, 'Hook catalog pin');
  keys(
    pin,
    ['catalogId', 'catalogRevision', 'definitionDigest'],
    [],
    'Hook catalog pin',
  );
  const identity = parseManagedExtensionPin({
    extensionId: pin['catalogId'],
    packageRevision: pin['catalogRevision'],
    packageDigest: pin['definitionDigest'],
  });
  return {
    catalogId: identity.extensionId,
    catalogRevision: identity.packageRevision,
    definitionDigest: identity.packageDigest,
  };
}

export function parseManagedExtensionPin(value: unknown): ManagedExtensionPin {
  const pin = object(value, 'extension pin');
  keys(
    pin,
    ['extensionId', 'packageRevision', 'packageDigest'],
    ['settingsRevision'],
    'extension pin',
  );
  if (
    typeof pin['extensionId'] !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(pin['extensionId']) ||
    !revision(pin['packageRevision'], 1) ||
    typeof pin['packageDigest'] !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(pin['packageDigest']) ||
    (pin['settingsRevision'] !== undefined &&
      !revision(pin['settingsRevision'], 1))
  )
    invalid('extension pin');
  return Object.freeze({
    extensionId: pin['extensionId'],
    packageRevision: pin['packageRevision'] as number,
    packageDigest: pin['packageDigest'],
    ...(pin['settingsRevision'] === undefined
      ? {}
      : { settingsRevision: pin['settingsRevision'] as number }),
  });
}

export function parseManagedExtensionPins(
  value: unknown,
): readonly ManagedExtensionPin[] {
  if (!Array.isArray(value) || value.length > MANAGED_EXTENSION_MAX_PACKAGES)
    invalid('extension selection');
  const pins = value.map(parseManagedExtensionPin);
  if (new Set(pins.map((pin) => pin.extensionId)).size !== pins.length)
    invalid('duplicate extension selection');
  return Object.freeze(pins);
}

export function parseManagedExtensionApplyCommand(
  value: unknown,
): ManagedExtensionApplyCommand {
  const command = object(value, 'extension apply command');
  keys(
    command,
    ['operationId', 'actorKey', 'expectedRevision', 'extensions'],
    ['mcpChange'],
    'extension apply command',
  );
  if (
    typeof command['operationId'] !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      command['operationId'],
    ) ||
    typeof command['actorKey'] !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(command['actorKey']) ||
    !revision(command['expectedRevision'], 0) ||
    command['expectedRevision'] === Number.MAX_SAFE_INTEGER
  )
    invalid('extension apply command');
  return Object.freeze({
    operationId: command['operationId'],
    actorKey: command['actorKey'],
    expectedRevision: command['expectedRevision'] as number,
    extensions: parseManagedExtensionPins(command['extensions']),
    ...(command['mcpChange'] === undefined
      ? {}
      : { mcpChange: mcpChange(command['mcpChange']) }),
  });
}

function mcpSelections(
  value: unknown,
): readonly ManagedExtensionMcpSelection[] {
  if (!Array.isArray(value) || value.length > 32) invalid('MCP selection');
  const selected = value.map((value): ManagedExtensionMcpSelection => {
    const candidate = object(value, 'MCP selection');
    const { state, ...pin } = candidate;
    if (!['enabled', 'disabled', 'removed'].includes(String(state)))
      invalid('MCP state');
    return {
      ...mcpPins([pin])[0],
      state: state as ManagedExtensionMcpSelection['state'],
    };
  });
  if (
    new Set(selected.map((entry) => entry.serverId)).size !== selected.length ||
    selected.filter((entry) => entry.state === 'enabled').length > 16
  )
    invalid('MCP selection');
  return selected;
}

function mcpChange(value: unknown): ManagedExtensionMcpChange {
  const change = object(value, 'MCP change');
  keys(
    change,
    ['action', 'serverId', 'expectedRevision', 'servers'],
    [],
    'MCP change',
  );
  if (
    ![
      'add',
      'edit',
      'remove',
      'enable',
      'disable',
      'reload',
      'restart',
    ].includes(String(change['action'])) ||
    typeof change['serverId'] !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(change['serverId']) ||
    !revision(change['expectedRevision'], 0)
  )
    invalid('MCP change');
  const servers = mcpSelections(change['servers']);
  if (!servers.some((entry) => entry.serverId === change['serverId']))
    invalid('MCP change');
  return {
    action: change['action'] as ManagedExtensionMcpChange['action'],
    serverId: change['serverId'],
    expectedRevision: change['expectedRevision'] as number,
    servers,
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(label);
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    invalid(label);
}

function revision(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function invalid(label: string): never {
  throw new ManagedSessionRecordError(`Invalid Managed ${label}.`);
}
