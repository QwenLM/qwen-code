/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AvailableCommand } from '@agentclientprotocol/sdk';
import { SkillError } from '@qwen-code/qwen-code-core';

export const STATUS_SCHEMA_VERSION = 1 as const;

/**
 * Closed enumeration of structured error categories surfaced on diagnostic
 * status cells. Cells produced by `/workspace/preflight`, `/workspace/env`,
 * and (eventually) the MCP guardrails route share this taxonomy so SDK
 * consumers can branch on a known set rather than parsing free-form strings.
 */
export const SERVE_ERROR_KINDS = [
  'missing_binary',
  'blocked_egress',
  'auth_env_error',
  'init_timeout',
  'protocol_error',
  'missing_file',
  'parse_error',
] as const;

export type ServeErrorKind = (typeof SERVE_ERROR_KINDS)[number];

/**
 * Typed timeout raised by `withTimeout` in the bridge. Lets the diagnostic
 * mapping helper recognize init/heartbeat/extMethod timeouts via `instanceof`
 * instead of regex-matching message strings.
 */
export class BridgeTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`HttpAcpBridge ${label} timed out after ${timeoutMs}ms`);
    this.name = 'BridgeTimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

export const SERVE_STATUS_EXT_METHODS = {
  workspaceMcp: 'qwen/status/workspace/mcp',
  workspaceSkills: 'qwen/status/workspace/skills',
  workspaceProviders: 'qwen/status/workspace/providers',
  sessionContext: 'qwen/status/session/context',
  sessionSupportedCommands: 'qwen/status/session/supported_commands',
} as const;

export type ServeStatus =
  | 'ok'
  | 'warning'
  | 'error'
  | 'disabled'
  | 'not_started'
  | 'unknown';

export interface ServeStatusCell {
  kind: string;
  status: ServeStatus;
  error?: string;
  errorKind?: ServeErrorKind;
  hint?: string;
}

export type ServeMcpDiscoveryState =
  | 'not_started'
  | 'in_progress'
  | 'completed';

export type ServeMcpServerRuntimeStatus =
  | 'connected'
  | 'connecting'
  | 'disconnected';

export type ServeMcpTransport =
  | 'stdio'
  | 'sse'
  | 'http'
  | 'websocket'
  | 'sdk'
  | 'unknown';

export interface ServeWorkspaceMcpServerStatus extends ServeStatusCell {
  kind: 'mcp_server';
  name: string;
  mcpStatus?: ServeMcpServerRuntimeStatus;
  transport: ServeMcpTransport;
  disabled: boolean;
  description?: string;
  extensionName?: string;
}

export interface ServeWorkspaceMcpStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  workspaceCwd: string;
  initialized: boolean;
  discoveryState?: ServeMcpDiscoveryState;
  servers: ServeWorkspaceMcpServerStatus[];
  errors?: ServeStatusCell[];
}

export type ServeSkillLevel = 'project' | 'user' | 'extension' | 'bundled';

export interface ServeWorkspaceSkillStatus extends ServeStatusCell {
  kind: 'skill';
  name: string;
  description: string;
  level: ServeSkillLevel;
  modelInvocable: boolean;
  argumentHint?: string;
  model?: string;
  extensionName?: string;
}

export interface ServeWorkspaceSkillsStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  workspaceCwd: string;
  initialized: boolean;
  skills: ServeWorkspaceSkillStatus[];
  errors?: ServeStatusCell[];
}

export interface ServeWorkspaceProviderCurrent {
  authType?: string;
  modelId?: string;
}

export interface ServeWorkspaceProviderModel {
  modelId: string;
  baseModelId: string;
  name: string;
  description?: string | null;
  contextLimit?: number;
  isCurrent: boolean;
  isRuntime: boolean;
}

export interface ServeWorkspaceProviderStatus extends ServeStatusCell {
  kind: 'model_provider';
  authType: string;
  current: boolean;
  models: ServeWorkspaceProviderModel[];
}

export interface ServeWorkspaceProvidersStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  workspaceCwd: string;
  initialized: boolean;
  current?: ServeWorkspaceProviderCurrent;
  providers: ServeWorkspaceProviderStatus[];
  errors?: ServeStatusCell[];
}

export interface ServeSessionContextStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  sessionId: string;
  workspaceCwd: string;
  state: {
    models?: unknown;
    modes?: unknown;
    configOptions?: unknown[] | null;
    [key: string]: unknown;
  };
}

export interface ServeSessionSupportedCommandsStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  sessionId: string;
  availableCommands: AvailableCommand[];
  availableSkills: string[];
}

export function createIdleWorkspaceMcpStatus(
  workspaceCwd: string,
): ServeWorkspaceMcpStatus {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: false,
    discoveryState: 'not_started',
    servers: [],
  };
}

export function createIdleWorkspaceSkillsStatus(
  workspaceCwd: string,
): ServeWorkspaceSkillsStatus {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: false,
    skills: [],
  };
}

export function createIdleWorkspaceProvidersStatus(
  workspaceCwd: string,
): ServeWorkspaceProvidersStatus {
  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: false,
    providers: [],
  };
}

/**
 * Discriminant for diagnostic cells emitted by `/workspace/env`.
 * `env_var` cells are presence-only (the daemon never echoes secret values
 * even when redacted). The other kinds expose non-sensitive values like
 * runtime tag, platform, redacted proxy host, and sandbox profile name.
 */
export type ServeEnvKind =
  | 'runtime'
  | 'platform'
  | 'sandbox'
  | 'proxy'
  | 'env_var';

export interface ServeEnvCell extends ServeStatusCell {
  kind: ServeEnvKind;
  /** Stable identifier within the kind (e.g. env-var name, proxy var name). */
  name: string;
  present?: boolean;
  /** Non-sensitive value; ALWAYS omitted for kind='env_var'. */
  value?: string;
}

export interface ServeWorkspaceEnvStatus {
  v: typeof STATUS_SCHEMA_VERSION;
  workspaceCwd: string;
  /** Always true — the daemon answers env without consulting ACP. */
  initialized: true;
  /** Whether an ACP channel is currently live; informational only. */
  acpChannelLive: boolean;
  cells: ServeEnvCell[];
  errors?: ServeStatusCell[];
}

const SKILL_PARSE_CODES: ReadonlySet<string> = new Set([
  'PARSE_ERROR',
  'INVALID_CONFIG',
  'INVALID_NAME',
]);

const SKILL_FILE_CODES: ReadonlySet<string> = new Set([
  'FILE_ERROR',
  'NOT_FOUND',
]);

const FS_MISSING_CODES: ReadonlySet<string> = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
]);

// `ModelConfigError` subclasses live inside core's models module and are not
// re-exported on the public package surface. We classify them by the `name`
// field that each subclass sets via `this.name = new.target.name`.
const MODEL_CONFIG_ERROR_NAMES: ReadonlySet<string> = new Set([
  'StrictMissingCredentialsError',
  'StrictMissingModelIdError',
  'MissingApiKeyError',
  'MissingModelError',
  'MissingBaseUrlError',
  'MissingAnthropicBaseUrlEnvError',
]);

/**
 * Map a thrown domain error onto one of the closed `ServeErrorKind` literals
 * so diagnostic cells can render structured remediation. Recognition is
 * `instanceof`-first; message-string heuristics are a last-resort fallback for
 * legacy throw sites that have not yet been retyped.
 *
 * Returns `undefined` when no rule matches; callers should leave `errorKind`
 * unset rather than coercing an unrelated error into a misleading category.
 */
export function mapDomainErrorToErrorKind(
  err: unknown,
): ServeErrorKind | undefined {
  if (err instanceof BridgeTimeoutError) return 'init_timeout';
  if (err instanceof SkillError) {
    if (SKILL_PARSE_CODES.has(err.code)) return 'parse_error';
    if (SKILL_FILE_CODES.has(err.code)) return 'missing_file';
    return undefined;
  }
  if (err instanceof SyntaxError) return 'parse_error';
  if (!(err instanceof Error)) return undefined;
  if (MODEL_CONFIG_ERROR_NAMES.has(err.name)) return 'auth_env_error';
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && FS_MISSING_CODES.has(code)) {
    return 'missing_file';
  }
  // TODO(follow-up): convert the two throw sites that produce these
  // messages (`getChannelClosedReject` in `httpAcpBridge.ts` and the
  // `defaultSpawnChannelFactory` "Cannot determine CLI entry path" Error)
  // to typed classes (`BridgeChannelClosedError`, `MissingCliEntryError`)
  // and replace the regex match with `instanceof`. Until then a foreign
  // error message that happens to contain either phrase will misclassify;
  // the false-positive surface is small (the phrases are bridge-specific)
  // but the cleaner fix belongs in the same wave as PR 22's bridge
  // extraction.
  const msg = err.message;
  if (/agent channel closed/i.test(msg)) return 'protocol_error';
  if (/Cannot determine CLI entry path/i.test(msg)) return 'missing_binary';
  return undefined;
}
