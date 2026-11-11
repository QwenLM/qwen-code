/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `system/init` 的数据部分（会话能力快照）与 wire 装帧分离：
 * 会话只产快照，宿主编解码器负责信封与字段名。
 * 能力位清单与命令目录继续从 cli 共享，避免出现第二份会漂移的 wire 契约。
 */

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_OUTPUT_STYLE_NAME,
  getVersion,
  isAbortError,
  MCPServerStatus,
  mcpServerRequiresOAuth,
  runLogger,
  WIRE_PROTOCOL_VERSION,
  type Config,
  type SDKMessage,
} from '@qwen-code/core';
import {
  createBestEffortNonInteractiveCommandService,
  createNonInteractiveCommandService,
} from '../../../nonInteractiveCliCommands.js';
import { WIRE_PROTOCOL_CAPABILITIES } from '../../../utils/nonInteractiveOutput.js';
import { getSdkPermissionMode } from '../../../session/permissionMode.js';

/**
 * 会话能力快照：`system/init` 帧的**数据部分**，不含任何 wire 信封。
 *
 * `hostContext.ts` 的 `ThreadSessionSnapshot` 是它在出站事件上的同构声明（会话产快照、
 * 宿主装帧，两边靠结构兼容对接）。加字段必须两处同改，否则一边多出的字段静默丢失。
 */
export interface SessionInitSnapshot {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: string;
  readonly permissionMode: string;
  readonly tools: readonly string[];
  readonly mcpServers: ReadonlyArray<{ name: string; status: string }>;
  readonly slashCommands: readonly string[];
  readonly skills: readonly string[];
  readonly agents: readonly string[];
  readonly plugins: ReadonlyArray<{ name: string; path: string }>;
  readonly outputStyle: string;
  readonly apiKeySource: string | undefined;
  readonly version: string;
}

const COMMAND_CATALOG_STARTUP_WAIT_MS = 5000;

function commandCatalogStartupSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(COMMAND_CATALOG_STARTUP_WAIT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function createCommandServiceForProtocolMetadata(
  config: Config,
  signal?: AbortSignal,
) {
  try {
    return await createNonInteractiveCommandService(
      config,
      commandCatalogStartupSignal(signal),
    );
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    if (!isAbortError(error)) {
      runLogger.warn(
        '[stream-json] Command catalog startup readiness failed; using currently available commands:',
        error,
      );
    }
    return createBestEffortNonInteractiveCommandService(
      config,
      signal ?? new AbortController().signal,
    );
  }
}

/** 采集会话能力快照。只产数据，wire 信封归 `renderStreamJsonInitMessage`。 */
export async function collectSessionInitSnapshot(
  config: Config,
  signal?: AbortSignal,
  options?: { hiddenToolName?: string },
): Promise<SessionInitSnapshot> {
  const mcpServers: Array<{ name: string; status: string }> = [];
  const mcpManager = config.getMcpClientManager?.();
  if (mcpManager) {
    const serverConfigs = mcpManager.getMcpServers();
    for (const name of Object.keys(serverConfigs)) {
      const client = mcpManager.getClientByName(name);
      const rawStatus = client?.getStatus?.() ?? 'disconnected';
      const status =
        mcpServerRequiresOAuth.has(name) &&
        rawStatus !== MCPServerStatus.CONNECTED
          ? 'needs-auth'
          : rawStatus;
      mcpServers.push({
        name,
        status,
      });
    }
  }

  const skills = config
    .getSkillManager()
    .getSkills()
    .map((skill) => skill.name);

  const [commandService, version] = await Promise.all([
    createCommandServiceForProtocolMetadata(config, signal),
    getVersion(),
  ]);
  const slashCommands = commandService
    .getCommands()
    .map((command) => command.name);
  const agentNames = config.getAgentRegistry?.()?.getAllAgentNames() ?? [];

  const plugins = config
    .getEnabledPlugins()
    .map((plugin) => ({ name: plugin.name, path: plugin.path }));

  return {
    sessionId: config.getSessionId(),
    cwd: config.getTargetDir(),
    model: config.getModel() || 'auto',
    permissionMode: getSdkPermissionMode(config),
    tools: config
      .getToolRegistry()
      .getAllToolNames()
      .filter((toolName) => toolName !== options?.hiddenToolName),
    mcpServers,
    slashCommands,
    skills,
    agents: agentNames,
    plugins,
    outputStyle: config.getOutputStyle?.()?.name ?? DEFAULT_OUTPUT_STYLE_NAME,
    apiKeySource: 'none',
    version,
  };
}

/**
 * 把快照渲染成 `system/init` 帧。wire 信封与协议常量（`protocol_version`、
 * `capabilities`、`fast_mode_state`、`uuid`、`session_id`）只在这里出现。
 *
 * `model` 回显会话内部 key；目录展示名是产品数据，由宿主在发帧前投影。
 */
export function renderStreamJsonInitMessage(
  snapshot: SessionInitSnapshot,
): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: snapshot.apiKeySource,
    protocol_version: WIRE_PROTOCOL_VERSION,
    cwd: snapshot.cwd,
    tools: [...snapshot.tools],
    mcp_servers: snapshot.mcpServers.map((server) => ({ ...server })),
    model: snapshot.model,
    permissionMode: snapshot.permissionMode,
    slash_commands: [...snapshot.slashCommands],
    output_style: snapshot.outputStyle,
    agents: [...snapshot.agents],
    skills: [...snapshot.skills],
    plugins: snapshot.plugins.map((plugin) => ({ ...plugin })),
    capabilities: [...WIRE_PROTOCOL_CAPABILITIES],
    fast_mode_state: 'off',
    uuid: randomUUID(),
    session_id: snapshot.sessionId,
  } as SDKMessage;
}
