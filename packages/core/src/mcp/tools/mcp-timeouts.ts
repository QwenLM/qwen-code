/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MCPServerConfig } from '../../config/config.js';
import { BRAND_FIXED_ENV_PREFIX } from '../../config/brand.js';

export const ENV_MCP_TOOL_IDLE_TIMEOUT = `${BRAND_FIXED_ENV_PREFIX}MCP_TOOL_IDLE_TIMEOUT`;

export const MCP_REQUEST_TIMEOUT_DEFAULT_MSEC = 30_000;
export const MCP_TOOL_HARD_TIMEOUT_DEFAULT_MSEC = 100_000_000;

/**
 * Connect/discovery request timeout. Per-server `timeout` is intentionally
 * reserved for tool calls and never overrides this value.
 */
export const MCP_CONNECT_TIMEOUT_MSEC = MCP_REQUEST_TIMEOUT_DEFAULT_MSEC;

/**
 * Default hard wall-clock limit for a tool call when neither the server nor
 * MCP_TOOL_TIMEOUT provides a value.
 */
export const MCP_CALL_TIMEOUT_MSEC = MCP_TOOL_HARD_TIMEOUT_DEFAULT_MSEC;
export const MCP_TOOL_TIMEOUT_MIN_MSEC = 1_000;
export const MCP_TOOL_TIMEOUT_MAX_MSEC = 2_147_483_647;
export const MCP_STDIO_TOOL_IDLE_TIMEOUT_DEFAULT_MSEC = 1_800_000;
export const MCP_REMOTE_TOOL_IDLE_TIMEOUT_DEFAULT_MSEC = 300_000;
export const MCP_TOOL_IDLE_TIMEOUT_MESSAGE = 'MCP tool idle timeout';

type McpTimeoutConfig = Pick<
  MCPServerConfig,
  'command' | 'httpUrl' | 'timeout' | 'type' | 'url'
>;

function parseEnvInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validServerTimeout(timeout: number | undefined): number | undefined {
  return timeout !== undefined &&
    Number.isFinite(timeout) &&
    timeout >= MCP_TOOL_TIMEOUT_MIN_MSEC
    ? timeout
    : undefined;
}

function clampToolTimeout(timeout: number): number {
  return Math.min(
    Math.max(timeout, MCP_TOOL_TIMEOUT_MIN_MSEC),
    MCP_TOOL_TIMEOUT_MAX_MSEC,
  );
}

/**
 * Resolves the timeout for MCP initialize and discovery requests.
 * Per-server tool timeout configuration intentionally does not participate.
 */
export function resolveMcpRequestTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = parseEnvInteger(env['MCP_TIMEOUT']);
  return configured !== undefined && configured > 0
    ? configured
    : MCP_REQUEST_TIMEOUT_DEFAULT_MSEC;
}

/**
 * Resolves the hard wall-clock limit for one MCP tool call.
 * Progress notifications never extend this deadline.
 */
export function resolveMcpToolHardTimeoutMs(
  config: Pick<MCPServerConfig, 'timeout'> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const serverTimeout = validServerTimeout(config?.timeout);
  const envTimeout = parseEnvInteger(env['MCP_TOOL_TIMEOUT']);
  const candidate =
    serverTimeout ??
    (envTimeout !== undefined && envTimeout > 0 ? envTimeout : undefined) ??
    MCP_TOOL_HARD_TIMEOUT_DEFAULT_MSEC;

  return clampToolTimeout(candidate);
}

function inferIdleTimeoutDefault(config: McpTimeoutConfig | undefined): number {
  const type = config?.type as string | undefined;
  if (type === 'sdk' || type === 'sse-ide' || type === 'ws-ide') return 0;
  if (
    type === 'http' ||
    type === 'sse' ||
    type === 'ws' ||
    config?.httpUrl !== undefined ||
    config?.url !== undefined
  ) {
    return MCP_REMOTE_TOOL_IDLE_TIMEOUT_DEFAULT_MSEC;
  }
  return MCP_STDIO_TOOL_IDLE_TIMEOUT_DEFAULT_MSEC;
}

/**
 * Resolves the no-response/no-progress watchdog for one MCP tool call.
 * A configured server timeout can extend the transport default, but the idle
 * deadline never exceeds the hard tool-call deadline.
 */
export function resolveMcpToolIdleTimeoutMs(
  config: McpTimeoutConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const defaultIdle = inferIdleTimeoutDefault(config);
  if (defaultIdle === 0) return 0;

  const envIdle = parseEnvInteger(env[ENV_MCP_TOOL_IDLE_TIMEOUT]);
  if (envIdle === 0) return 0;

  const baseIdle = envIdle !== undefined && envIdle > 0 ? envIdle : defaultIdle;
  const serverTimeout = validServerTimeout(config?.timeout) ?? 0;
  const hardTimeout = resolveMcpToolHardTimeoutMs(config, env);

  return Math.min(
    Math.max(baseIdle, serverTimeout, MCP_TOOL_TIMEOUT_MIN_MSEC),
    hardTimeout,
  );
}

/**
 * Resettable idle watchdog for one MCP tool call. The hard wall-clock timeout
 * remains owned by the MCP SDK and is deliberately unaffected by activity.
 */
export class McpToolIdleWatchdog {
  private readonly abortController = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pauseDepth = 0;

  constructor(private readonly timeoutMs: number) {
    this.arm();
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  touch(): void {
    if (this.pauseDepth > 0 || this.abortController.signal.aborted) return;
    this.arm();
  }

  pause(): void {
    this.pauseDepth += 1;
    this.clearTimer();
  }

  resume(): void {
    if (this.pauseDepth === 0) return;
    this.pauseDepth -= 1;
    if (this.pauseDepth === 0) this.arm();
  }

  dispose(): void {
    this.clearTimer();
  }

  private arm(): void {
    this.clearTimer();
    if (this.timeoutMs <= 0 || this.abortController.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.abortController.abort(
        new Error(`${MCP_TOOL_IDLE_TIMEOUT_MESSAGE} after ${this.timeoutMs}ms`),
      );
    }, this.timeoutMs);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
