/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { redactLogCredentials } from '@qwen-code/acp-bridge/logRedaction';
import { sanitizeLogText } from '@qwen-code/channel-base';
import { getPlugin } from '../commands/channel/channel-registry.js';
import type {
  ChannelSecretUpdate,
  ChannelSettingsMutationOptions,
  ChannelSettingsSnapshot,
  ChannelSettingsUpsertOptions,
  WorkspaceChannelSettingsStore,
} from './channel-settings-store.js';
import { isAllChannelSelectionName } from './channel-selection.js';
import { normalizeWorkerDiagnostic } from './channel-worker-diagnostics.js';
import type {
  ChannelWorkerControlState,
  ChannelWorkerManager,
  ChannelWorkerRequiredOwner,
} from './channel-worker-manager.js';
import type { ChannelWorkerSnapshot } from './channel-worker-supervisor.js';
import type { ServeChannelSelection } from './types.js';

export interface ChannelRuntimeState {
  state: 'stopped' | 'starting' | 'connected' | 'partial' | 'error';
  lastError?: string;
}

export interface ChannelSecretState {
  present: boolean;
  source?: 'literal' | 'environment';
}

export interface ChannelInstanceSnapshot {
  name: string;
  config: Record<string, unknown>;
  secrets: Record<string, ChannelSecretState>;
  webhookSecrets: Record<string, ChannelSecretState>;
  startsWithServe: boolean;
  runtime: ChannelRuntimeState;
}

export interface DaemonChannelsSnapshot {
  revision: string;
  instances: Record<string, ChannelInstanceSnapshot>;
}

export interface ChannelUpsertRequest {
  expectedRevision: string;
  config: Record<string, unknown> & { type: string };
  secrets?: Record<string, ChannelSecretUpdate>;
  webhookSecrets?: Record<string, ChannelSecretUpdate>;
}

export type RevisionRequest = ChannelSettingsMutationOptions;

export interface ChannelStartupRequest extends RevisionRequest {
  enabled: boolean;
}

export interface ChannelMutationResult {
  snapshot: DaemonChannelsSnapshot;
  instance: ChannelInstanceSnapshot;
}

export interface ChannelManagementService {
  list(): Promise<DaemonChannelsSnapshot>;
  upsert(
    name: string,
    request: ChannelUpsertRequest,
  ): Promise<ChannelMutationResult>;
  remove(
    name: string,
    request: RevisionRequest,
  ): Promise<ChannelMutationResult>;
  setStartup(
    name: string,
    request: ChannelStartupRequest,
  ): Promise<ChannelMutationResult>;
  start(name: string): Promise<ChannelMutationResult>;
  stop(name: string): Promise<ChannelMutationResult>;
  restart(name: string): Promise<ChannelMutationResult>;
}

interface ChannelManagementSettingsStore {
  snapshot(): ChannelSettingsSnapshot;
  upsert(
    name: string,
    options: ChannelSettingsUpsertOptions,
  ): Promise<ChannelSettingsSnapshot>;
  remove(
    name: string,
    options: ChannelSettingsMutationOptions,
  ): Promise<ChannelSettingsSnapshot>;
  setStartupNames(
    names: readonly string[],
    options: ChannelSettingsMutationOptions,
  ): Promise<ChannelSettingsSnapshot>;
}

export interface ChannelManagementWorkerManager {
  committedChannelNames(): string[];
  state(): ChannelWorkerControlState;
  setSelection(
    selection: ServeChannelSelection,
    requiredOwner?: ChannelWorkerRequiredOwner,
  ): Promise<unknown>;
  stopSelection(): Promise<unknown>;
  reload(): Promise<ChannelWorkerSnapshot>;
  reloadWorkspace(
    workspaceCwd: string,
    name: string,
  ): Promise<ChannelWorkerSnapshot>;
}

export interface CreateChannelManagementServiceOptions {
  workspaceCwd: string;
  store: ChannelManagementSettingsStore | WorkspaceChannelSettingsStore;
  manager: ChannelManagementWorkerManager | ChannelWorkerManager;
}

export class ChannelManagementError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelManagementError';
  }
}

function diagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeLogText(
    redactLogCredentials(normalizeWorkerDiagnostic(message)),
    512,
  );
}

function usesEnvironment(value: unknown): boolean {
  return (
    typeof value === 'string' && /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value)
  );
}

export function createChannelManagementService(
  opts: CreateChannelManagementServiceOptions,
): ChannelManagementService {
  const diagnostics = new Map<string, string>();

  const workerFor = (name: string) => {
    const matches = opts.manager
      .state()
      .workers.filter(
        (worker) =>
          worker.adapters?.some((adapter) => adapter.name === name) ||
          worker.requestedChannels?.includes(name) ||
          worker.channels.includes(name),
      );
    return matches;
  };

  const assertOwnedRuntime = (name: string): void => {
    if (!opts.manager.committedChannelNames().includes(name)) return;
    const workers = workerFor(name);
    if (
      workers.length !== 1 ||
      workers[0]!.workspaceCwd !== opts.workspaceCwd
    ) {
      throw new ChannelManagementError(
        'channel_runtime_owner_mismatch',
        `Channel "${name}" does not have one confirmed runtime owner in this workspace.`,
      );
    }
  };

  const runtimeFor = (name: string): ChannelRuntimeState => {
    const retainedError = diagnostics.get(name);
    if (retainedError) return { state: 'error', lastError: retainedError };
    const committed = opts.manager.committedChannelNames();
    if (!committed.includes(name)) return { state: 'stopped' };
    const state = opts.manager.state();
    const workers = workerFor(name);
    if (
      workers.length !== 1 ||
      workers[0]!.workspaceCwd !== opts.workspaceCwd
    ) {
      return {
        state: 'error',
        lastError: 'Channel runtime owner is unknown or ambiguous.',
      };
    }
    const worker = workers[0]!;
    const adapter = worker.adapters?.find((item) => item.name === name);
    if (adapter?.state === 'connected') return { state: 'connected' };
    if (adapter?.state === 'error') {
      return {
        state: 'error',
        ...(adapter.error ? { lastError: adapter.error } : {}),
      };
    }
    if (
      adapter?.state === 'starting' ||
      state.transition === 'starting' ||
      state.transition === 'reconciling'
    ) {
      return { state: 'starting' };
    }
    if (worker.state === 'running') return { state: 'partial' };
    return {
      state: 'error',
      ...(worker.error ? { lastError: worker.error } : {}),
    };
  };

  const instanceFrom = async (
    name: string,
    rawConfig: Record<string, unknown>,
    startupNames: readonly string[],
  ): Promise<ChannelInstanceSnapshot> => {
    const type = typeof rawConfig['type'] === 'string' ? rawConfig['type'] : '';
    const plugin = type ? await getPlugin(type) : undefined;
    const secretKeys = new Set(
      plugin?.management?.fields
        .filter((field) => field.kind === 'secret')
        .map((field) => field.key) ?? [],
    );
    const config: Record<string, unknown> = {};
    const secrets: Record<string, ChannelSecretState> = {};
    const webhookSecrets = Object.create(null) as Record<
      string,
      ChannelSecretState
    >;
    for (const [key, value] of Object.entries(rawConfig)) {
      if (key === 'webhooks' && value && typeof value === 'object') {
        const webhooks = structuredClone(value) as Record<string, unknown>;
        const rawSources = webhooks['sources'];
        const sources = Object.create(null) as Record<string, unknown>;
        if (rawSources && typeof rawSources === 'object') {
          for (const [sourceName, rawSource] of Object.entries(rawSources)) {
            if (!rawSource || typeof rawSource !== 'object') {
              sources[sourceName] = rawSource;
              continue;
            }
            const source = { ...(rawSource as Record<string, unknown>) };
            const literal = source['secret'];
            const secretEnv = source['secretEnv'];
            delete source['secret'];
            sources[sourceName] = source;
            webhookSecrets[sourceName] = {
              present: literal !== undefined || secretEnv !== undefined,
              ...(literal !== undefined
                ? { source: 'literal' as const }
                : secretEnv !== undefined
                  ? { source: 'environment' as const }
                  : {}),
            };
          }
        }
        config[key] = { ...webhooks, sources };
        continue;
      }
      if (!secretKeys.has(key)) {
        config[key] = value;
        continue;
      }
      secrets[key] = {
        present: value !== undefined,
        ...(value !== undefined
          ? { source: usesEnvironment(value) ? 'environment' : 'literal' }
          : {}),
      };
    }
    for (const key of secretKeys) {
      secrets[key] ??= { present: false };
    }
    return {
      name,
      config,
      secrets,
      webhookSecrets,
      startsWithServe:
        startupNames.some(isAllChannelSelectionName) ||
        startupNames.includes(name),
      runtime: runtimeFor(name),
    };
  };

  const listFrom = async (
    persisted: ChannelSettingsSnapshot,
  ): Promise<DaemonChannelsSnapshot> => {
    const entries = await Promise.all(
      Object.entries(persisted.channels).map(
        async ([name, config]) =>
          [
            name,
            await instanceFrom(name, config, persisted.startupNames),
          ] as const,
      ),
    );
    return {
      revision: persisted.revision,
      instances: Object.fromEntries(entries),
    };
  };

  const resultFor = async (
    name: string,
    persisted = opts.store.snapshot(),
  ): Promise<ChannelMutationResult> => {
    const snapshot = await listFrom(persisted);
    const instance = Object.hasOwn(snapshot.instances, name)
      ? snapshot.instances[name]!
      : ({
          name,
          config: {},
          secrets: {},
          webhookSecrets: {},
          startsWithServe: false,
          runtime: runtimeFor(name),
        } satisfies ChannelInstanceSnapshot);
    return { snapshot, instance };
  };

  const stopFromNames = async (
    name: string,
    committedNames: readonly string[],
  ): Promise<void> => {
    const next = committedNames.filter((item) => item !== name);
    if (next.length === committedNames.length) return;
    if (next.length === 0) {
      await opts.manager.stopSelection();
    } else {
      await opts.manager.setSelection({ mode: 'names', names: next });
    }
  };

  const assertManageableInstanceName = (name: string): void => {
    if (isAllChannelSelectionName(name)) {
      throw new ChannelManagementError(
        'invalid_channel_instance_name',
        'Channel instance name "all" is reserved for startup selection.',
      );
    }
  };

  const service: ChannelManagementService = {
    async list() {
      return listFrom(opts.store.snapshot());
    },
    async upsert(name, request) {
      assertManageableInstanceName(name);
      const committedNames = opts.manager.committedChannelNames();
      const active = committedNames.includes(name);
      if (active) assertOwnedRuntime(name);
      const persisted = await opts.store.upsert(name, request);
      diagnostics.delete(name);
      if (active) {
        try {
          await opts.manager.reloadWorkspace(opts.workspaceCwd, name);
        } catch (error) {
          await stopFromNames(name, committedNames);
          diagnostics.set(name, diagnostic(error));
        }
      }
      return resultFor(name, persisted);
    },
    async remove(name, request) {
      if (!isAllChannelSelectionName(name)) {
        const committedNames = opts.manager.committedChannelNames();
        if (committedNames.includes(name)) {
          assertOwnedRuntime(name);
          await stopFromNames(name, committedNames);
        }
      }
      const persisted = await opts.store.remove(name, request);
      diagnostics.delete(name);
      return resultFor(name, persisted);
    },
    async setStartup(name, request) {
      assertManageableInstanceName(name);
      const current = opts.store.snapshot();
      if (!Object.hasOwn(current.channels, name)) {
        throw new ChannelManagementError(
          'channel_instance_not_found',
          `Channel "${name}" is not configured in this workspace.`,
        );
      }
      const startsAll = current.startupNames.some(isAllChannelSelectionName);
      if (startsAll && request.enabled) {
        if (current.revision !== request.expectedRevision) {
          throw new ChannelManagementError(
            'channel_settings_conflict',
            'Channel settings changed; reload before trying again.',
          );
        }
        return resultFor(name, current);
      }
      const startupNames = startsAll
        ? Object.keys(current.channels).filter(
            (item) => !isAllChannelSelectionName(item) && item !== name,
          )
        : request.enabled
          ? current.startupNames.includes(name)
            ? current.startupNames
            : [...current.startupNames, name]
          : current.startupNames.filter((item) => item !== name);
      const persisted = await opts.store.setStartupNames(startupNames, {
        expectedRevision: request.expectedRevision,
      });
      return resultFor(name, persisted);
    },
    async start(name) {
      assertManageableInstanceName(name);
      const persisted = opts.store.snapshot();
      if (!Object.hasOwn(persisted.channels, name)) {
        throw new ChannelManagementError(
          'channel_instance_not_found',
          `Channel "${name}" is not configured in this workspace.`,
        );
      }
      const committedNames = opts.manager.committedChannelNames();
      if (!committedNames.includes(name)) {
        await opts.manager.setSelection(
          {
            mode: 'names',
            names: [...committedNames, name],
          },
          { name, workspaceCwd: opts.workspaceCwd },
        );
      } else {
        assertOwnedRuntime(name);
      }
      diagnostics.delete(name);
      return resultFor(name, persisted);
    },
    async stop(name) {
      assertManageableInstanceName(name);
      const persisted = opts.store.snapshot();
      if (!Object.hasOwn(persisted.channels, name)) {
        throw new ChannelManagementError(
          'channel_instance_not_found',
          `Channel "${name}" is not configured in this workspace.`,
        );
      }
      const committedNames = opts.manager.committedChannelNames();
      if (committedNames.includes(name)) assertOwnedRuntime(name);
      await stopFromNames(name, committedNames);
      diagnostics.delete(name);
      return resultFor(name, persisted);
    },
    async restart(name) {
      assertManageableInstanceName(name);
      const persisted = opts.store.snapshot();
      if (!opts.manager.committedChannelNames().includes(name)) {
        throw new ChannelManagementError(
          'channel_worker_not_enabled',
          `Channel "${name}" is not running.`,
        );
      }
      assertOwnedRuntime(name);
      try {
        await opts.manager.reloadWorkspace(opts.workspaceCwd, name);
        diagnostics.delete(name);
      } catch (error) {
        diagnostics.set(name, diagnostic(error));
        throw error;
      }
      return resultFor(name, persisted);
    },
  };
  return service;
}
