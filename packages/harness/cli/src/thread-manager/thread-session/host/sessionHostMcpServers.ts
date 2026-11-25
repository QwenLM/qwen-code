/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SDK 注入的 in-process MCP server 注册（`initialize` 声明的 `mcpServers`；wire 键
 * `sdkMcpServers` / `sdkMcpToolOverrides` 由宿主胶水映射成中立字段 `mcpServers` /
 * `mcpToolOverrides`，宿主可另外声明中立的 `mcpServerConfigOverrides`，本模块不读
 * wire 键名。日志与错误文案里的 `sdkMcpServers` 是与 worker 对齐的既有文案，逐字保留）。
 *
 * 传输层闭包只报语义负载 `{ serverName, message }`，不构造帧：subtype、蛇形字段名
 * 与 request_id 配对归宿主。不接这段，`mcp_message` 反向请求不会出现。
 *
 * MCP 状态表是模块级单例且只按 server 名键控：两个会话注入同名 server 会互相覆盖
 * 状态与 OAuth-required 标志。
 */

import {
  runLogger,
  type Config,
  type McpToolRuntimeOverride,
} from '@qwen-code/core';
import { isStringProp } from '../../support/protocolError.js';
import type { ThreadHostRequests } from '../contract/hostContext.js';
import type { ThreadSessionDeclarations } from '../contract/threadSessionTypes.js';

/** 键存在且值为布尔。 */
function isBooleanProp<K extends string>(
  obj: Record<string, unknown>,
  key: K,
): obj is Record<string, unknown> & Record<K, boolean> {
  const val = obj[key];
  return key in obj && typeof val === 'boolean';
}

export interface HostMcpServersParams {
  readonly config: Config;
  /** `initialize` 的中立声明袋；只读 `mcpServers` / `mcpToolOverrides` / `mcpServerConfigOverrides`。 */
  readonly declarations: ThreadSessionDeclarations;
  /** 宿主反向请求通道；由会话提供，新会话直接转发 host.requests.sendMcpMessage。 */
  readonly sendMcpMessage: ThreadHostRequests['sendMcpMessage'];
}

/**
 * 注册 SDK 声明的 in-process MCP server；没声明时为空操作。注册失败只 warn 不抛，
 * 单个 server 连不上不该让整个 initialize 失败。
 */
export async function registerHostMcpServers(
  params: HostMcpServersParams,
): Promise<void> {
  const { config, declarations, sendMcpMessage } = params;

  const raw = declarations.mcpServers;
  if (!Array.isArray(raw)) return;

  const serverNames = raw.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
  if (serverNames.length === 0) return;

  // 工具级覆盖（改名 / 强制加载）只认已声明的 server，其余整条丢弃。
  const toolOverridesByServer: Record<
    string,
    Record<string, McpToolRuntimeOverride>
  > = {};
  const rawOverrides = declarations.mcpToolOverrides;
  if (
    rawOverrides &&
    typeof rawOverrides === 'object' &&
    !Array.isArray(rawOverrides)
  ) {
    for (const [serverName, rawServerOverrides] of Object.entries(
      rawOverrides,
    )) {
      if (
        !serverNames.includes(serverName) ||
        !rawServerOverrides ||
        typeof rawServerOverrides !== 'object' ||
        Array.isArray(rawServerOverrides)
      ) {
        continue;
      }
      const serverOverrides: Record<string, McpToolRuntimeOverride> = {};
      for (const [toolName, rawToolOverride] of Object.entries(
        rawServerOverrides,
      )) {
        if (
          !rawToolOverride ||
          typeof rawToolOverride !== 'object' ||
          Array.isArray(rawToolOverride)
        ) {
          continue;
        }
        const rawToolOverrideRecord = rawToolOverride as Record<
          string,
          unknown
        >;
        const exposedName = isStringProp(rawToolOverrideRecord, 'exposedName')
          ? rawToolOverrideRecord.exposedName
          : undefined;
        const alwaysLoad = isBooleanProp(rawToolOverrideRecord, 'alwaysLoad')
          ? rawToolOverrideRecord.alwaysLoad
          : undefined;
        if (exposedName !== undefined || alwaysLoad !== undefined) {
          serverOverrides[toolName] = { exposedName, alwaysLoad };
        }
      }
      if (Object.keys(serverOverrides).length > 0) {
        toolOverridesByServer[serverName] = serverOverrides;
      }
    }
  }

  const mcpManager = config.getMcpClientManager?.();
  if (!mcpManager) {
    runLogger.warn(
      '[thread-session] sdkMcpServers received but mcpManager is unavailable — skipping registration.',
    );
    return;
  }

  // Only declared servers with a plain-object payload are forwarded.
  const configOverridesByServer: Record<string, Record<string, unknown>> = {};
  const rawConfigOverrides = declarations.mcpServerConfigOverrides;
  if (
    rawConfigOverrides &&
    typeof rawConfigOverrides === 'object' &&
    !Array.isArray(rawConfigOverrides)
  ) {
    for (const [serverName, rawOverride] of Object.entries(
      rawConfigOverrides,
    )) {
      if (
        !serverNames.includes(serverName) ||
        !rawOverride ||
        typeof rawOverride !== 'object' ||
        Array.isArray(rawOverride)
      ) {
        continue;
      }
      configOverridesByServer[serverName] = {
        ...(rawOverride as Record<string, unknown>),
      };
    }
  }

  // 每次调用经宿主发一次 mcp_message 反向请求并等结果；帧形（subtype、蛇形字段名）
  // 与 request_id 相关性配对全部是宿主的私事（见文件头）。不传 options.signal：
  // core 的传输层回调（SendMcpMessageCallback）本来就没有 per-call 取消信号，
  // 缺省时在途请求由宿主按会话级信号兜（hostContext.ts 的约定）。
  const transport = async (serverName: string, message: unknown) => {
    const response = await sendMcpMessage({ serverName, message });
    if (
      !response ||
      typeof response !== 'object' ||
      !('mcp_response' in response)
    ) {
      throw new Error(
        `SDK returned malformed mcp_message response for "${serverName}": missing mcp_response`,
      );
    }
    return response.mcp_response as never;
  };

  try {
    runLogger.log('[thread-session] registering SDK MCP servers', {
      sessionId: config.getSessionId?.(),
      serverNames,
    });
    const result = await mcpManager.registerSdkMcpClients(
      serverNames,
      transport,
      toolOverridesByServer,
      configOverridesByServer,
    );
    runLogger.log(
      `[thread-session] Registered SDK MCP servers: connected=[${result.connectedServers.join(', ')}] failed=[${result.failedServers.join(', ')}] blocked=[${result.blockedServers.join(', ')}]`,
    );
  } catch (error) {
    runLogger.warn(
      '[thread-session] Failed to register SDK MCP servers:',
      error,
    );
  }
}
