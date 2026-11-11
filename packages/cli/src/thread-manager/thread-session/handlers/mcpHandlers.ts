/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP 控制面能力组：8 个 `mcp_*` 能力（set_servers / reconnect / toggle / status /
 * inject_token / authenticate / oauth_callback_url / clear_auth）。
 *
 * 本组不实现语义，全部委托 `McpControlModule.handle`，与共享实现同一份代码，错误文案即
 * wire 契约。入参是宿主解析好的产品语义值；返回 `ThreadMcpResult`，`ok:false` 不抛异常，
 * 只有控制面未装配或共享模块不认领 subtype 才抛 `ThreadCapabilityError`。
 *
 * 进程级副作用与共享实现一致：`mcp_toggle` 的停用记录与 OAuth 凭据按进程 / 用户级存放。
 */

import { isRecord } from '@qwen-code/core';
import type { McpControlModule } from '../host/sessionMcpControl.js';
import type { ThreadCallContext } from '../contract/hostContext.js';
import type { ThreadMcpResult } from '../contract/threadSessionTypes.js';
import {
  ThreadCapabilityError,
  type ThreadSessionInternals,
} from '../contract/handlerContract.js';

/**
 * 取会话的 MCP 控制面；engine 未装配或非 stream-json 输出时不存在，
 * 文案与共享模块的「manager 缺失」保持同一口径。
 */
function requireMcpControl(session: ThreadSessionInternals): McpControlModule {
  const mcpControl = session.mcpControl;
  if (!mcpControl) {
    throw new ThreadCapabilityError(
      'MCP client manager is not available in this session',
    );
  }
  return mcpControl;
}

/**
 * 委托共享模块执行一个 `mcp_*` subtype 并原样交回结果。undefined 表示共享模块不认领
 * 自己名下的 subtype——派发器与能力面失配，属内部不变量被破坏。
 */
async function dispatch(
  session: ThreadSessionInternals,
  subtype: string,
  request: Record<string, unknown>,
): Promise<ThreadMcpResult> {
  const result = await requireMcpControl(session).handle(subtype, request);
  if (result === undefined) {
    throw new ThreadCapabilityError(
      `MCP control module did not claim subtype "${subtype}"`,
    );
  }
  return result;
}

/**
 * payload 型能力的请求体：宿主给的对象原样透传；不是对象时给空对象，让共享模块的字段
 * 校验产出标准错误文案，不在这里另造一套。
 */
function asRequest(payload: unknown): Record<string, unknown> {
  return isRecord(payload) ? payload : {};
}

/** `mcp_set_servers`：整体替换动态 MCP server 桶并重启连接，回 `{added, removed, errors}`。 */
export async function setMcpServers(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  servers: readonly unknown[],
): Promise<ThreadMcpResult> {
  return dispatch(session, 'mcp_set_servers', { servers });
}

/** `mcp_reconnect`：重启单个 server。serverName 缺失时由共享模块回标准错误。 */
export async function reconnectMcp(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  serverName?: string,
): Promise<ThreadMcpResult> {
  return dispatch(session, 'mcp_reconnect', { serverName });
}

/** `mcp_toggle`：会话级启停一个 server（不落持久设置）。 */
export async function toggleMcp(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  serverName: string,
  enabled: boolean,
): Promise<ThreadMcpResult> {
  return dispatch(session, 'mcp_toggle', { serverName, enabled });
}

/** `mcp_status`：每个已配置 server 的连接状态与已发现工具。 */
export async function mcpStatus(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
): Promise<ThreadMcpResult> {
  return dispatch(session, 'mcp_status', {});
}

/** `mcp_inject_token`：写入宿主带外取得的 OAuth token 并重启该 server。 */
export async function injectMcpToken(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  payload: unknown,
): Promise<ThreadMcpResult> {
  return dispatch(session, 'mcp_inject_token', asRequest(payload));
}

/** `mcp_authenticate`：host-driven OAuth 的发起入口，回 authUrl 或静默完成。 */
export async function authenticateMcp(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  payload: unknown,
): Promise<ThreadMcpResult> {
  return dispatch(session, 'mcp_authenticate', asRequest(payload));
}

/** `mcp_oauth_callback_url`：宿主提交粘贴的回调 URL，完成在途 OAuth flow。 */
export async function mcpOAuthCallbackUrl(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  payload: unknown,
): Promise<ThreadMcpResult> {
  return dispatch(session, 'mcp_oauth_callback_url', asRequest(payload));
}

/** `mcp_clear_auth`：删除已存 OAuth 凭据并重连（host 侧的 sign out）。 */
export async function clearMcpAuth(
  session: ThreadSessionInternals,
  _ctx: ThreadCallContext,
  payload: unknown,
): Promise<ThreadMcpResult> {
  return dispatch(session, 'mcp_clear_auth', asRequest(payload));
}
