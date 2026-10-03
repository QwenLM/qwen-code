/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { createAbortController } from '@qwen-code/qwen-code-core/utils/abortController.js';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HookRegistry } from '@qwen-code/qwen-code-core/hooks/hookRegistry.js';
import { HookRunner } from '@qwen-code/qwen-code-core/hooks/hookRunner.js';
import { interpolateUrl } from '@qwen-code/qwen-code-core/hooks/envInterpolator.js';
import { HookCommandIsolationUnavailableError } from '@qwen-code/qwen-code-core/hooks/hook-command-cgroup.js';
import {
  HookEventName,
  HooksConfigSource,
  getHookKey,
  type HookDefinition,
  type FunctionHookConfig,
  HookType,
  type CommandHookConfig,
  type FunctionHookCallback,
  type HookConfig,
  type HookExecutionResult,
  type HttpHookConfig,
  type PromptHookConfig,
} from '@qwen-code/qwen-code-core/hooks/types.js';
import { parseOperationGrant } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-record.js';
import { ManagedOperationGrantGate } from '@qwen-code/qwen-code-core/managed-runtime/managed-operation-grant-gate.js';
import {
  MANAGED_HOOK_MAX_RUNNING,
  type ManagedHookCatalog,
  type ManagedHookCatalogPin,
  type ManagedHookControl,
  type ManagedHookDescriptor,
  type ManagedHookExecute,
  type ManagedHookOperationView,
  type RegisteredHandlerRef,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import type { ManagedSessionKey } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';

export interface ManagedHookDefinition
  extends Omit<ManagedHookDescriptor, 'config' | 'handler' | 'plannerKey'> {
  readonly config:
    | CommandHookConfig
    | HttpHookConfig
    | PromptHookConfig
    | {
        readonly type: 'function';
        readonly name?: string;
        readonly timeout: number;
      };
  readonly handler?: RegisteredHandlerRef & {
    readonly modulePath: string;
    readonly exportName: string;
  };
}

export interface ManagedHookManifest {
  readonly version: 1;
  readonly catalogs: ReadonlyArray<
    ManagedHookCatalogPin & {
      readonly tenantId: string;
      readonly workspaceId: string;
      readonly hooks: readonly ManagedHookDefinition[];
    }
  >;
}

export class ManagedHookError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const identifier = /^[a-zA-Z0-9:_.-]{1,512}$/u;
const MAX_OPERATIONS = 4096;
const MAX_BYTES = 60 * 1024;
const FUNCTION_SETTLEMENT_GRACE_MS = 1000;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ManagedHookError('managed_hook_invalid');
  return value as Record<string, unknown>;
}
function closed(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new ManagedHookError('managed_hook_invalid');
}
function text(value: unknown): value is string {
  return typeof value === 'string' && identifier.test(value);
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function pin(value: unknown): ManagedHookCatalogPin {
  const parsed = object(value);
  closed(parsed, ['catalogId', 'catalogRevision', 'definitionDigest']);
  if (
    !text(parsed['catalogId']) ||
    !positive(parsed['catalogRevision']) ||
    typeof parsed['definitionDigest'] !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(parsed['definitionDigest'])
  )
    throw new ManagedHookError('managed_hook_invalid');
  return parsed as unknown as ManagedHookCatalogPin;
}
function scope(key: ManagedSessionKey) {
  return `${key.tenantId}\0${key.workspaceId}\0${key.sessionId}`;
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function quotaExceeded(operationId: string): ManagedHookOperationView {
  return {
    operationId,
    state: 'settled',
    result: {
      success: false,
      outcome: 'non_blocking_error',
      duration: 0,
      error: 'Managed hook execution quota exceeded before dispatch.',
    },
  };
}

export function parseManagedHookControl(value: unknown): ManagedHookControl {
  const control = object(value);
  const key = object(control['sessionKey']);
  closed(key, ['tenantId', 'workspaceId', 'sessionId']);
  if (
    !['tenantId', 'workspaceId', 'sessionId'].every((field) =>
      text(key[field]),
    ) ||
    !text(control['operationId'])
  )
    throw new ManagedHookError('managed_hook_invalid');
  if (control['kind'] === 'hook-status' || control['kind'] === 'hook-cancel') {
    closed(control, ['kind', 'sessionKey', 'operationId', 'targetOperationId']);
    if (!text(control['targetOperationId']))
      throw new ManagedHookError('managed_hook_invalid');
  } else if (control['kind'] === 'hook-catalog') {
    closed(control, ['kind', 'sessionKey', 'operationId', 'pin']);
    pin(control['pin']);
  } else if (control['kind'] === 'hook-execute') {
    closed(control, [
      'kind',
      'sessionKey',
      'operationId',
      'pin',
      'hookId',
      'input',
      'grant',
    ]);
    pin(control['pin']);
    const input = object(control['input']);
    if (
      !text(control['hookId']) ||
      input['session_id'] !== key['sessionId'] ||
      typeof input['cwd'] !== 'string' ||
      typeof input['transcript_path'] !== 'string' ||
      typeof input['timestamp'] !== 'string' ||
      (input['messages'] !== undefined &&
        (!Array.isArray(input['messages']) ||
          input['messages'].some(
            (value) =>
              !value || typeof value !== 'object' || Array.isArray(value),
          ))) ||
      !Object.values(HookEventName).includes(
        input['hook_event_name'] as HookEventName,
      )
    )
      throw new ManagedHookError('managed_hook_invalid');
    try {
      parseOperationGrant(control['grant']);
    } catch {
      throw new ManagedHookError('managed_hook_grant_invalid');
    }
  } else throw new ManagedHookError('managed_hook_invalid');
  return structuredClone(control) as unknown as ManagedHookControl;
}

export function loadManagedHookManifest(path?: string): ManagedHookManifest {
  if (!path) return { version: 1, catalogs: [] };
  try {
    const bytes = readFileSync(path);
    if (bytes.length > 1024 * 1024) throw new Error('too large');
    return parseManifest(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new ManagedHookError('managed_hook_manifest_invalid');
  }
}

function parseManifest(value: unknown): ManagedHookManifest {
  const manifest = object(value);
  closed(manifest, ['version', 'catalogs']);
  if (manifest['version'] !== 1 || !Array.isArray(manifest['catalogs']))
    throw new ManagedHookError('managed_hook_manifest_invalid');
  const pins = new Set<string>();
  for (const raw of manifest['catalogs']) {
    const catalog = object(raw);
    closed(catalog, [
      'tenantId',
      'workspaceId',
      'catalogId',
      'catalogRevision',
      'definitionDigest',
      'hooks',
    ]);
    pin({
      catalogId: catalog['catalogId'],
      catalogRevision: catalog['catalogRevision'],
      definitionDigest: catalog['definitionDigest'],
    });
    if (
      !text(catalog['tenantId']) ||
      !text(catalog['workspaceId']) ||
      !Array.isArray(catalog['hooks']) ||
      catalog['hooks'].length > 128
    )
      throw new ManagedHookError('managed_hook_manifest_invalid');
    const identity = JSON.stringify([
      catalog['tenantId'],
      catalog['workspaceId'],
      catalog['catalogId'],
      catalog['catalogRevision'],
    ]);
    if (pins.has(identity))
      throw new ManagedHookError('managed_hook_definition_conflict');
    pins.add(identity);
    const ids = new Set<string>();
    for (const rawHook of catalog['hooks']) {
      const hook = object(rawHook);
      closed(hook, [
        'hookId',
        'eventName',
        'matcher',
        'sequential',
        'onceKey',
        'failClosed',
        'async',
        'config',
        'handler',
        'source',
        'sourceTrusted',
        'enabled',
        'agentScope',
        'owner',
      ]);
      const config = object(hook['config']);
      if (
        (hook['source'] !== undefined &&
          !Object.values(HooksConfigSource).includes(
            hook['source'] as HooksConfigSource,
          )) ||
        ['sourceTrusted', 'enabled'].some(
          (key) => hook[key] !== undefined && typeof hook[key] !== 'boolean',
        ) ||
        (hook['agentScope'] !== undefined && !text(hook['agentScope']))
      )
        throw new ManagedHookError('managed_hook_manifest_invalid');
      if (hook['owner'] !== undefined) {
        const owner = object(hook['owner']);
        closed(owner, ['sessionId', 'agentId']);
        if (
          !text(owner['sessionId']) ||
          !(owner['agentId'] === null || text(owner['agentId']))
        )
          throw new ManagedHookError('managed_hook_manifest_invalid');
      }
      if (
        (hook['source'] === HooksConfigSource.Session &&
          hook['owner'] === undefined) ||
        (hook['agentScope'] !== undefined &&
          (hook['source'] !== HooksConfigSource.Session ||
            object(hook['owner'])['agentId'] === null))
      )
        throw new ManagedHookError('managed_hook_manifest_invalid');
      if (
        !text(hook['hookId']) ||
        ids.has(hook['hookId'] as string) ||
        !Object.values(HookEventName).includes(
          hook['eventName'] as HookEventName,
        ) ||
        !['sequential', 'failClosed', 'async'].every(
          (key) => typeof hook[key] === 'boolean',
        ) ||
        !(hook['onceKey'] === null || text(hook['onceKey'])) ||
        (hook['matcher'] !== undefined &&
          typeof hook['matcher'] !== 'string') ||
        (config['name'] !== undefined && typeof config['name'] !== 'string') ||
        (config['timeout'] !== undefined &&
          (!positive(config['timeout']) || Number(config['timeout']) > 600_000))
      )
        throw new ManagedHookError('managed_hook_manifest_invalid');
      ids.add(hook['hookId'] as string);
      if (config['type'] === 'command') {
        closed(config, ['type', 'name', 'command', 'timeout', 'env', 'shell']);
        if (
          typeof config['command'] !== 'string' ||
          !config['command'] ||
          config['command'].includes('\0') ||
          (config['shell'] !== undefined &&
            !['bash', 'powershell'].includes(String(config['shell'])))
        )
          throw new ManagedHookError('managed_hook_manifest_invalid');
      } else if (config['type'] === 'http') {
        closed(config, [
          'type',
          'name',
          'url',
          'headers',
          'allowedEnvVars',
          'timeout',
        ]);
        const url = new URL(String(config['url']));
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          (config['allowedEnvVars'] !== undefined &&
            (!Array.isArray(config['allowedEnvVars']) ||
              !config['allowedEnvVars'].every(
                (item) => typeof item === 'string',
              )))
        )
          throw new ManagedHookError('managed_hook_manifest_invalid');
      } else if (config['type'] === 'prompt') {
        closed(config, ['type', 'name', 'prompt', 'model', 'timeout']);
        if (
          typeof config['prompt'] !== 'string' ||
          !config['prompt'] ||
          (config['model'] !== undefined && typeof config['model'] !== 'string')
        )
          throw new ManagedHookError('managed_hook_manifest_invalid');
      } else if (config['type'] === 'function') {
        closed(config, ['type', 'name', 'timeout']);
        const handler = object(hook['handler']);
        closed(handler, [
          'handlerId',
          'handlerRevision',
          'modulePath',
          'exportName',
        ]);
        if (
          !text(handler['handlerId']) ||
          !positive(handler['handlerRevision']) ||
          typeof handler['modulePath'] !== 'string' ||
          !isAbsolute(handler['modulePath']) ||
          !text(handler['exportName']) ||
          !positive(config['timeout'])
        )
          throw new ManagedHookError('managed_hook_manifest_invalid');
      } else throw new ManagedHookError('managed_hook_manifest_invalid');
      if (config['type'] !== 'function' && hook['handler'] !== undefined)
        throw new ManagedHookError('managed_hook_manifest_invalid');
      if (hook['async'] && config['type'] !== 'command')
        throw new ManagedHookError('managed_hook_manifest_invalid');
      for (const field of ['env', 'headers']) {
        if (
          config[field] !== undefined &&
          Object.entries(object(config[field])).some(
            ([key, value]) =>
              key.includes('\0') ||
              typeof value !== 'string' ||
              value.includes('\0'),
          )
        )
          throw new ManagedHookError('managed_hook_manifest_invalid');
      }
    }
  }
  return structuredClone(manifest) as unknown as ManagedHookManifest;
}

interface Operation {
  runtimeSessionId: string;
  fingerprint: string;
  sessionKey: ManagedSessionKey;
  view: ManagedHookOperationView;
  controller: AbortController;
  done?: Promise<void>;
}

export class ManagedHookRuntime {
  private readonly manifest: ManagedHookManifest;
  private readonly operations = new Map<string, Operation>();
  private readonly gates = new ManagedOperationGrantGate();
  private readonly shutdown = createAbortController();
  private closing = false;
  private admissionSealed = false;
  private lifecycleStarted = false;
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
    manifest: ManagedHookManifest,
  ) {
    this.manifest = parseManifest(manifest);
  }

  sealAdmission(): void {
    this.admissionSealed = true;
  }

  getDrainInspection(): {
    hasActivity: boolean;
    pendingStarts: number;
    pendingInvocations: number;
  } {
    return {
      hasActivity: this.lifecycleStarted,
      pendingStarts: this.pendingStarts,
      pendingInvocations: [...this.operations.values()].filter(
        (entry) => entry.view.state !== 'settled',
      ).length,
    };
  }

  private requireAdmission(): void {
    if (this.closing || this.admissionSealed)
      throw new ManagedHookError('managed_hook_closed');
  }

  async control(
    runtimeSessionId: string,
    value: unknown,
  ): Promise<ManagedHookOperationView> {
    this.pendingStarts++;
    try {
      return await this.controlAdmitted(runtimeSessionId, value);
    } finally {
      this.pendingStarts--;
    }
  }

  private async controlAdmitted(
    runtimeSessionId: string,
    value: unknown,
  ): Promise<ManagedHookOperationView> {
    const control = parseManagedHookControl(value);
    if (
      control.sessionKey.tenantId !== this.workspace.tenantId ||
      control.sessionKey.workspaceId !== this.workspace.workspaceId
    )
      throw new ManagedHookError('managed_hook_scope_conflict');
    if (control.kind === 'hook-status' || control.kind === 'hook-cancel') {
      const existing = this.operations.get(
        `${scope(control.sessionKey)}\0${control.targetOperationId}`,
      );
      if (!existing || existing.runtimeSessionId !== runtimeSessionId)
        return {
          operationId: control.targetOperationId,
          state: 'outcome_unknown',
        };
      if (control.kind === 'hook-cancel') existing.controller.abort();
      return structuredClone(existing.view);
    }
    const { pin: expected } = control;
    const catalog = this.manifest.catalogs.find(
      (entry) =>
        entry.tenantId === control.sessionKey.tenantId &&
        entry.workspaceId === control.sessionKey.workspaceId &&
        entry.catalogId === expected.catalogId &&
        entry.catalogRevision === expected.catalogRevision &&
        entry.definitionDigest === expected.definitionDigest,
    );
    if (!catalog)
      throw new ManagedHookError('managed_hook_catalog_unavailable');
    const key = `${scope(control.sessionKey)}\0${control.operationId}`;
    const { grant: _grant, ...effect } =
      control.kind === 'hook-execute'
        ? control
        : { ...control, grant: undefined };
    const digest = fingerprint(effect);
    const existing = this.operations.get(key);
    if (existing) {
      if (
        existing.runtimeSessionId !== runtimeSessionId ||
        existing.fingerprint !== digest
      )
        throw new ManagedHookError('managed_hook_operation_conflict');
      return structuredClone(existing.view);
    }
    this.requireAdmission();
    this.lifecycleStarted = true;
    const directory = await this.sessionDirectory(runtimeSessionId);
    this.requireAdmission();
    if (!directory)
      throw new ManagedHookError('managed_hook_session_unavailable');
    if (control.kind === 'hook-catalog') {
      const exposed: ManagedHookCatalog = {
        ...expected,
        hooks: await this.descriptors(catalog.hooks),
      };
      this.requireAdmission();
      if (Buffer.byteLength(JSON.stringify(exposed)) > MAX_BYTES)
        throw new ManagedHookError('managed_hook_catalog_limit');
      return {
        operationId: control.operationId,
        state: 'settled',
        catalog: exposed,
      };
    }
    const definition = catalog.hooks.find(
      (entry) => entry.hookId === control.hookId,
    );
    if (
      !definition ||
      definition.eventName !== control.input.hook_event_name ||
      definition.sourceTrusted === false ||
      definition.enabled === false ||
      (definition.owner &&
        (definition.owner.sessionId !== control.sessionKey.sessionId ||
          (definition.agentScope !== undefined &&
            definition.owner.agentId !== (control.input.agent_id ?? null))))
    )
      throw new ManagedHookError('managed_hook_definition_unavailable');
    if (definition.config.type === 'prompt')
      throw new ManagedHookError('managed_hook_requires_harness');
    const grant = control.grant;
    if (
      scope(grant.sessionKey) !== scope(control.sessionKey) ||
      grant.domain !== 'hook_execution' ||
      grant.operationId !== control.operationId ||
      grant.workspaceGeneration !== this.workspace.workspaceGeneration
    )
      throw new ManagedHookError('managed_hook_grant_invalid');
    if (this.operations.has(key))
      return this.control(runtimeSessionId, control);
    this.requireAdmission();
    if (this.operations.size >= MAX_OPERATIONS)
      return {
        operationId: control.operationId,
        state: 'settled',
        result: {
          success: false,
          outcome: 'blocking',
          duration: 0,
          output: {
            continue: false,
            decision: 'block',
            reason: 'Managed Hook receipt capacity is exhausted.',
            ...(definition.eventName === HookEventName.PermissionRequest
              ? {
                  hookSpecificOutput: {
                    decision: {
                      behavior: 'deny',
                      interrupt: true,
                      message: 'Managed Hook receipt capacity is exhausted.',
                    },
                  },
                }
              : {}),
          },
        },
      };
    try {
      this.gates.install(grant);
    } catch {
      throw new ManagedHookError('managed_hook_grant_invalid');
    }
    if (
      !this.gates.admits(
        control.sessionKey,
        control.operationId,
        'execute',
        Date.now(),
      )
    )
      throw new ManagedHookError('managed_hook_grant_invalid');
    const atRunningLimit =
      [...this.operations.values()].filter(
        (entry) => entry.view.state !== 'settled',
      ).length >= MANAGED_HOOK_MAX_RUNNING;
    const entry: Operation = {
      runtimeSessionId,
      fingerprint: digest,
      sessionKey: control.sessionKey,
      controller: new AbortController(),
      view: atRunningLimit
        ? quotaExceeded(control.operationId)
        : { operationId: control.operationId, state: 'running' },
    };
    this.operations.set(key, entry);
    if (!atRunningLimit)
      entry.done = this.execute(entry, definition, control, directory);
    return structuredClone(entry.view);
  }

  private async descriptors(
    definitions: readonly ManagedHookDefinition[],
  ): Promise<ManagedHookDescriptor[]> {
    const native = new Map<HookConfig, ManagedHookDefinition>();
    const sources = new Map<
      HooksConfigSource,
      Partial<Record<HookEventName, HookDefinition[]>>
    >();
    const agentHooks: Array<{
      definition: ManagedHookDefinition;
      config: HookConfig;
    }> = [];
    const sessionHooks: Array<{
      definition: ManagedHookDefinition;
      config: HookConfig;
    }> = [];
    for (const definition of definitions) {
      if (definition.enabled === false || definition.sourceTrusted === false)
        continue;
      const config: HookConfig =
        definition.config.type === 'function'
          ? {
              ...definition.config,
              type: HookType.Function,
              id: definition.handler!.handlerId,
              callback: async () => undefined,
              errorMessage: 'Managed hook handler failed.',
            }
          : { ...definition.config };
      native.set(config, definition);
      const source = definition.source ?? HooksConfigSource.System;
      if (source === HooksConfigSource.Session) {
        (definition.agentScope ? agentHooks : sessionHooks).push({
          definition,
          config,
        });
        continue;
      }
      const grouped = sources.get(source) ?? {};
      (grouped[definition.eventName] ??= []).push({
        matcher: definition.matcher,
        sequential: definition.sequential,
        hooks: [config],
      });
      sources.set(source, grouped);
    }
    const registry = new HookRegistry({
      getProjectRoot: () => '',
      isTrustedFolder: () => true,
      getSystemHooks: () => sources.get(HooksConfigSource.System),
      getUserHooks: () => sources.get(HooksConfigSource.User),
      getProjectHooks: () => sources.get(HooksConfigSource.Project),
      getExtensions: () => [
        { isActive: true, hooks: sources.get(HooksConfigSource.Extensions) },
      ],
    });
    await registry.initialize();
    for (const { definition, config } of agentHooks) {
      registry.addAgentHooks(
        {
          [definition.eventName]: [
            {
              matcher: definition.matcher,
              sequential: definition.sequential,
              hooks: [config],
            },
          ],
        },
        definition.agentScope!,
        {
          owner: {
            sessionId: definition.owner!.sessionId,
            agentId: definition.owner!.agentId!,
          },
        },
      );
    }
    const expose = (
      definition: ManagedHookDefinition,
      config: HookConfig,
      deduplicate: boolean,
    ): ManagedHookDescriptor => {
      const { handler, config: _recipe, ...descriptor } = definition;
      return {
        ...descriptor,
        source: definition.source ?? HooksConfigSource.System,
        ...(deduplicate ? { plannerKey: fingerprint(getHookKey(config)) } : {}),
        config:
          config.type === HookType.Prompt
            ? (definition.config as PromptHookConfig)
            : {
                type: config.type,
                ...(config.name ? { name: config.name } : {}),
              },
        ...(handler
          ? {
              handler: {
                handlerId: handler.handlerId,
                handlerRevision: handler.handlerRevision,
              },
            }
          : {}),
      };
    };
    return [
      ...Object.values(HookEventName).flatMap((event) =>
        registry
          .getHooksForEvent(event)
          .map((entry) =>
            expose(native.get(entry.config)!, entry.config, true),
          ),
      ),
      ...sessionHooks.map(({ definition, config }) =>
        expose(definition, config, false),
      ),
    ];
  }

  hasHolds(runtimeSessionId: string): boolean {
    return [...this.operations.values()].some(
      (entry) =>
        entry.runtimeSessionId === runtimeSessionId &&
        entry.view.state !== 'settled',
    );
  }

  async close(): Promise<void> {
    this.closing = true;
    this.shutdown.abort();
    for (const entry of this.operations.values()) entry.controller.abort();
    await Promise.all([...this.operations.values()].map((entry) => entry.done));
  }

  private async execute(
    entry: Operation,
    definition: ManagedHookDefinition,
    control: ManagedHookExecute,
    directory: string,
  ): Promise<void> {
    let dispatched = false;
    let functionCompletion: Promise<boolean> | undefined;
    try {
      let config: HookConfig;
      if (definition.config.type === 'function') {
        const handler = definition.handler!;
        let registered: Record<string, unknown>;
        try {
          const module: Record<string, unknown> = await import(
            pathToFileURL(handler.modulePath).href
          );
          registered = object(module[handler.exportName]);
          if (
            registered['handlerRevision'] !== handler.handlerRevision ||
            typeof registered['callback'] !== 'function' ||
            (registered['onHookSuccess'] !== undefined &&
              typeof registered['onHookSuccess'] !== 'function')
          )
            throw new Error('handler revision unavailable');
        } catch {
          throw new ManagedHookError('managed_hook_handler_unavailable');
        }
        const callback = registered['callback'] as FunctionHookCallback;
        config = {
          ...definition.config,
          type: HookType.Function,
          id: handler.handlerId,
          callback: (input, context) => {
            const pending = Promise.resolve().then(() => {
              this.requireAdmission();
              return callback(input, context);
            });
            functionCompletion = pending.then(
              () => true,
              () => true,
            );
            return pending;
          },
          errorMessage: 'Managed hook handler failed.',
          ...(registered['onHookSuccess']
            ? {
                onHookSuccess: registered[
                  'onHookSuccess'
                ] as FunctionHookConfig['onHookSuccess'],
              }
            : {}),
        };
      } else if (definition.config.type === 'command') {
        config = { ...definition.config, async: false };
      } else {
        config = definition.config;
      }
      const currentDirectory = await this.sessionDirectory(
        entry.runtimeSessionId,
      );
      this.requireAdmission();
      if (
        !this.gates.admits(
          control.sessionKey,
          control.operationId,
          'execute',
          Date.now(),
        ) ||
        currentDirectory !== directory
      )
        throw new ManagedHookError('managed_hook_grant_invalid');
      if (entry.controller.signal.aborted) {
        entry.view = {
          operationId: control.operationId,
          state: 'settled',
          result: { success: false, outcome: 'cancelled', duration: 0 },
        };
        return;
      }
      const runner = new HookRunner(
        config.type === HookType.Http
          ? [interpolateUrl(config.url, config.allowedEnvVars ?? [])]
          : undefined,
      );
      dispatched = true;
      const result = await runner.executeHook(
        config,
        definition.eventName,
        {
          ...control.input,
          cwd: directory,
          session_id: control.sessionKey.sessionId,
        },
        {
          signal: entry.controller.signal,
          ...(Array.isArray(
            (control.input as unknown as Record<string, unknown>)['messages'],
          )
            ? {
                messages: (
                  control.input as unknown as {
                    messages: Array<Record<string, unknown>>;
                  }
                ).messages,
              }
            : {}),
          ...('tool_use_id' in control.input &&
          typeof control.input.tool_use_id === 'string'
            ? { toolUseID: control.input.tool_use_id }
            : {}),
        },
        config.type === HookType.Command
          ? {
              waitForProcessTree: true,
              cgroupRoot: process.env['QWEN_MANAGED_HOOK_CGROUP_ROOT'],
              environment: {
                PATH: process.env['PATH'] ?? '',
                HOME: directory,
                USERPROFILE: directory,
                ...(process.env['SystemRoot']
                  ? { SYSTEMROOT: process.env['SystemRoot'] }
                  : {}),
              },
            }
          : config.type === HookType.Http
            ? {
                trackHttpRequest: true,
                // Preserve the response as completion proof after user cancel.
                httpRequestSignal: this.shutdown.signal,
              }
            : undefined,
      );
      if (result.error instanceof HookCommandIsolationUnavailableError) {
        entry.view = {
          operationId: control.operationId,
          state: 'settled',
          error: { code: 'managed_hook_command_isolation_unavailable' },
        };
        return;
      }
      let functionSettled = true;
      if (
        config.type === HookType.Function &&
        (result.outcome === 'timeout' || result.outcome === 'cancelled') &&
        functionCompletion
      ) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        functionSettled = await Promise.race([
          functionCompletion,
          new Promise<boolean>((resolve) => {
            timer = setTimeout(
              () => resolve(false),
              FUNCTION_SETTLEMENT_GRACE_MS,
            );
          }),
        ]);
        clearTimeout(timer);
      }
      const uncertain =
        (config.type === HookType.Command &&
          result.processTreeDrained !== true) ||
        (config.type === HookType.Function && !functionSettled) ||
        (config.type === HookType.Http &&
          (!result.httpRequestState ||
            result.httpRequestState === 'outcome_unknown'));
      if (uncertain) {
        entry.view = {
          operationId: control.operationId,
          state: 'outcome_unknown',
          error: { code: 'managed_hook_outcome_unknown' },
        };
        return;
      }
      this.settle(entry, result);
    } catch (error) {
      if (
        !dispatched &&
        error instanceof ManagedHookError &&
        error.code === 'managed_hook_grant_invalid'
      ) {
        entry.view = {
          operationId: control.operationId,
          state: 'settled',
          result: {
            success: false,
            outcome: 'non_blocking_error',
            duration: 0,
            error: 'Managed hook authorization expired before dispatch.',
          },
        };
        return;
      }
      if (!dispatched && !(error instanceof ManagedHookError)) {
        entry.view = {
          operationId: control.operationId,
          state: 'settled',
          result: {
            success: false,
            outcome: 'non_blocking_error',
            duration: 0,
            error: 'Managed hook failed before dispatch.',
          },
        };
        return;
      }
      entry.view = {
        operationId: control.operationId,
        state: dispatched ? 'outcome_unknown' : 'settled',
        error: {
          code:
            error instanceof ManagedHookError
              ? error.code
              : 'managed_hook_execution_failed',
        },
      };
    }
  }

  private settle(entry: Operation, result: HookExecutionResult) {
    const view: ManagedHookOperationView = {
      operationId: entry.view.operationId,
      state: 'settled',
      result: {
        success: result.success,
        outcome:
          result.outcome ?? (result.success ? 'success' : 'non_blocking_error'),
        duration: result.duration,
        ...(result.output ? { output: result.output } : {}),
        ...(result.stdout ? { stdout: result.stdout } : {}),
        ...(result.stderr ? { stderr: result.stderr } : {}),
        ...(result.error ? { error: 'Managed hook execution failed.' } : {}),
      },
    };
    entry.view =
      Buffer.byteLength(JSON.stringify(view)) <= MAX_BYTES
        ? view
        : {
            operationId: entry.view.operationId,
            state: 'settled',
            result: {
              success: false,
              outcome: 'non_blocking_error',
              duration: result.duration,
              error: 'Managed hook output exceeds the size limit.',
            },
          };
  }
}
