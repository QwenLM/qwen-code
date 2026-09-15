/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChannelFactory } from '@qwen-code/acp-bridge';
import type { BridgeExecutionSelection } from '@qwen-code/acp-bridge/bridgeOptions';
import { isScheduledTaskRunSource } from '@qwen-code/acp-bridge/sessionSource';
import {
  getShellConfiguration,
  QWEN_DIR,
  SessionExecutionEngineError,
  SessionService,
  type SessionExecutionEngine,
  type ShellConfiguration,
} from '@qwen-code/qwen-code-core';
import { type CliArgs } from '../config/config.js';
import { loadProjectMcpServers } from '../config/mcpJson.js';
import { readSettingsSnapshot } from '../config/settings.js';
import { createManagedAgentChannelFactory } from './managed-agent-channel.js';
import type { ManagedRuntimeProvider } from './managed-runtime-provider.js';
import type { WorkspaceGenerationGuard } from './workspace-registry.js';

const DEFERRED_SPAWN_SOURCE_TYPES = new Set([
  'channel',
  'scheduled_task',
  'managed-gateway',
  'qwen-live',
  'standalone',
  'side_task',
]);

const ORDINARY_SPAWN_SOURCE_TYPES = new Set(['default', 'api']);

const EXTENSION_CONTROL_FILES = new Set(['extension-enablement.json']);
const EXTENSION_STORE_FILES = new Set(['state.json', 'state.previous.json']);
const EXTENSION_STORE_DIRS = new Set(['transactions']);

export interface DaemonExecutionEngineOptions {
  workspaceCwd: string;
  sessionRuntimeBaseDir: string;
  runtimeEnvironment: Readonly<NodeJS.ProcessEnv>;
  workspaceTrusted: boolean;
  generationGuard: WorkspaceGenerationGuard;
  argv: CliArgs;
  workspaceId: string;
  tenantId?: string;
  legacyFactory: ChannelFactory;
  resolveToolRuntimeProvider: () => ManagedRuntimeProvider | undefined;
  shellConfiguration?: ShellConfiguration;
  platform?: NodeJS.Platform;
}

export function daemonManagedHostArgv(opts: {
  experimentalLsp?: boolean;
  restoreAskUserQuestion?: boolean;
}): CliArgs {
  return {
    acp: true,
    experimentalLsp: opts.experimentalLsp === true ? true : undefined,
    restoreAskUserQuestion:
      opts.restoreAskUserQuestion === true ? true : undefined,
  } as CliArgs;
}

export function createDaemonExecutionEngines(
  options: DaemonExecutionEngineOptions,
): {
  legacy: ChannelFactory;
  managed: ChannelFactory;
  select(context: BridgeExecutionSelection): Promise<SessionExecutionEngine>;
} {
  const workspaceCwd = options.workspaceCwd;
  const sessionRuntimeBaseDir = options.sessionRuntimeBaseDir;
  const runtimeEnvironment = Object.freeze({ ...options.runtimeEnvironment });
  const workspaceTrusted = options.workspaceTrusted;
  const argv = structuredClone(options.argv);
  const workspaceId = options.workspaceId;
  const tenantId = options.tenantId ?? workspaceId;
  const shellConfiguration = structuredClone(
    options.shellConfiguration ?? getShellConfiguration(),
  );
  const platform = options.platform ?? process.platform;
  const resolveToolRuntimeProvider = options.resolveToolRuntimeProvider;
  const managed = createManagedAgentChannelFactory({
    workspaceCwd,
    sessionRuntimeBaseDir,
    runtimeEnvironment,
    workspaceTrusted,
    generationGuard: options.generationGuard,
    argv,
    toolRuntime: {
      resolveProvider: resolveToolRuntimeProvider,
      tenantId,
      workspaceId,
      shellConfiguration,
      platform,
    },
  });
  const select = async (
    context: BridgeExecutionSelection,
  ): Promise<SessionExecutionEngine> => {
    if (context.operation !== 'spawn') {
      return selectRestoreEngine({
        sessionId: context.request.sessionId,
        workspaceCwd,
        sessionRuntimeBaseDir,
        runtimeEnvironment,
        workspaceTrusted,
      });
    }
    return selectSpawnEngine(context, {
      workspaceCwd,
      runtimeEnvironment,
      workspaceTrusted,
    });
  };
  return Object.freeze({
    legacy: options.legacyFactory,
    managed,
    select,
  });
}

async function selectRestoreEngine(input: {
  sessionId: string;
  workspaceCwd: string;
  sessionRuntimeBaseDir: string;
  runtimeEnvironment: Readonly<NodeJS.ProcessEnv>;
  workspaceTrusted: boolean;
}): Promise<SessionExecutionEngine> {
  const service = new SessionService(input.workspaceCwd, {
    runtimeBaseDir: input.sessionRuntimeBaseDir,
  });
  const state = await service.readExecutionEngine(input.sessionId);
  if (!state) {
    throw new SessionExecutionEngineError(
      input.sessionId,
      'ownership was not verified',
    );
  }
  if (state.status !== 'verified') {
    throw new SessionExecutionEngineError(input.sessionId, state.reason);
  }
  if (state.engine === 'legacy') return 'legacy';
  if (
    !isSpawnCompatible({
      workspaceCwd: input.workspaceCwd,
      runtimeEnvironment: input.runtimeEnvironment,
      workspaceTrusted: input.workspaceTrusted,
    })
  ) {
    throw new SessionExecutionEngineError(
      input.sessionId,
      'belongs to managed, cannot execute with the current configuration',
    );
  }
  return 'managed';
}

function selectSpawnEngine(
  context: Extract<BridgeExecutionSelection, { operation: 'spawn' }>,
  input: {
    workspaceCwd: string;
    runtimeEnvironment: Readonly<NodeJS.ProcessEnv>;
    workspaceTrusted: boolean;
  },
): SessionExecutionEngine {
  if (context.daemonOwnedStandalone) return 'legacy';
  const request = context.request;
  if (request.parentSessionId) return 'legacy';
  if (request.worktree || request.branch) return 'legacy';
  if (!isOrdinarySpawnSource(request)) return 'legacy';
  if (path.resolve(request.workspaceCwd) !== path.resolve(input.workspaceCwd)) {
    return 'legacy';
  }
  if (!input.workspaceTrusted) return 'legacy';
  return isSpawnCompatible(input) ? 'managed' : 'legacy';
}

function isOrdinarySpawnSource(request: {
  sourceType?: string;
  sourceId?: string;
}): boolean {
  if (isScheduledTaskRunSource(request)) return false;
  const sourceType = request.sourceType;
  if (sourceType === undefined) return true;
  if (DEFERRED_SPAWN_SOURCE_TYPES.has(sourceType)) return false;
  return ORDINARY_SPAWN_SOURCE_TYPES.has(sourceType);
}

function isSpawnCompatible(input: {
  workspaceCwd: string;
  runtimeEnvironment: Readonly<NodeJS.ProcessEnv>;
  workspaceTrusted: boolean;
}): boolean {
  if (!input.workspaceTrusted) return false;
  try {
    const settings = readSettingsSnapshot(input.workspaceCwd, {
      runtimeEnvironment: input.runtimeEnvironment,
      workspaceTrusted: input.workspaceTrusted,
    });
    if (hasNamedEntries(settings.merged.mcpServers)) return false;
    const projectMcp = loadProjectMcpServers(input.workspaceCwd);
    if (projectMcp.errors.length > 0) return false;
    if (hasNamedEntries(projectMcp.servers)) return false;
    if (hasNamedEntries(settings.getUserHooks())) return false;
    if (hasNamedEntries(settings.getProjectHooks())) return false;
    return areExtensionInputsEmpty(
      input.workspaceCwd,
      input.runtimeEnvironment,
    );
  } catch {
    return false;
  }
}

function hasNamedEntries(value: Record<string, unknown> | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

function areExtensionInputsEmpty(
  workspaceCwd: string,
  env: Readonly<NodeJS.ProcessEnv>,
): boolean {
  const globalQwenDir = resolveGlobalQwenDir(env);
  return (
    classifyExtensionsDir(path.join(globalQwenDir, 'extensions')) === 'empty' &&
    classifyExtensionsDir(path.join(workspaceCwd, QWEN_DIR, 'extensions')) ===
      'empty' &&
    classifyExtensionStore(path.join(globalQwenDir, 'extension-store')) ===
      'empty'
  );
}

function resolveGlobalQwenDir(env: Readonly<NodeJS.ProcessEnv>): string {
  const envDir = env['QWEN_HOME'];
  if (envDir) return path.resolve(envDir);
  const homeDir = os.homedir();
  if (!homeDir) return path.join(os.tmpdir(), QWEN_DIR);
  return path.join(homeDir, QWEN_DIR);
}

function classifyExtensionsDir(dir: string): 'empty' | 'unknown' {
  const listing = listDirectory(dir);
  if (listing === 'missing') return 'empty';
  if (listing === 'unknown') return 'unknown';
  for (const entry of listing) {
    const fullPath = path.join(dir, entry.name);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(fullPath);
    } catch {
      return 'unknown';
    }
    if (stats.isSymbolicLink()) {
      try {
        stats = fs.statSync(fullPath);
      } catch {
        return 'unknown';
      }
    }
    if (stats.isDirectory()) return 'unknown';
    if (!stats.isFile()) return 'unknown';
    if (!EXTENSION_CONTROL_FILES.has(entry.name)) return 'unknown';
  }
  return 'empty';
}

function classifyExtensionStore(dir: string): 'empty' | 'unknown' {
  const listing = listDirectory(dir);
  if (listing === 'missing') return 'empty';
  if (listing === 'unknown') return 'unknown';
  for (const entry of listing) {
    if (entry.name === 'lock.lock') return 'unknown';
    const fullPath = path.join(dir, entry.name);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(fullPath);
    } catch {
      return 'unknown';
    }
    if (stats.isSymbolicLink()) return 'unknown';
    if (stats.isDirectory()) {
      if (!EXTENSION_STORE_DIRS.has(entry.name)) return 'unknown';
      continue;
    }
    if (!stats.isFile() || !EXTENSION_STORE_FILES.has(entry.name)) {
      return 'unknown';
    }
  }
  const transactions = listDirectory(path.join(dir, 'transactions'));
  if (transactions === 'unknown') return 'unknown';
  if (transactions !== 'missing' && transactions.length > 0) return 'unknown';
  const statePath = path.join(dir, 'state.json');
  const previousPath = path.join(dir, 'state.previous.json');
  let stateRaw: string | undefined;
  try {
    stateRaw = fs.readFileSync(statePath, 'utf8');
  } catch (error) {
    if (!isNotFound(error)) return 'unknown';
    try {
      fs.statSync(previousPath);
      return 'unknown';
    } catch (previousError) {
      return isNotFound(previousError) ? 'empty' : 'unknown';
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stateRaw) as unknown;
  } catch {
    return 'unknown';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'unknown';
  }
  const extensions = (parsed as { extensions?: unknown }).extensions;
  if (
    extensions &&
    typeof extensions === 'object' &&
    !Array.isArray(extensions) &&
    Object.keys(extensions).length > 0
  ) {
    return 'unknown';
  }
  return 'empty';
}

function listDirectory(dir: string): fs.Dirent[] | 'missing' | 'unknown' {
  try {
    const stats = fs.lstatSync(dir);
    if (stats.isSymbolicLink()) {
      const target = fs.statSync(dir);
      if (!target.isDirectory()) return 'unknown';
    } else if (!stats.isDirectory()) {
      return 'unknown';
    }
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return isNotFound(error) ? 'missing' : 'unknown';
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
