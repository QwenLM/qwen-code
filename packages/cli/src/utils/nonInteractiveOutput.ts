/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  type SDKMessage,
  CUSTOM_MODEL_PROVIDER_CONFIG_WIRE,
  DEFAULT_OUTPUT_STYLE_NAME,
  WIRE_PROTOCOL_VERSION,
  cloneUsage,
  getResultErrorCode,
  isAbortError,
  MCPServerStatus,
  mcpServerRequiresOAuth,
  runLogger,
  SYNTHETIC_MODEL,
} from '@qwen-code/core';
import { randomUUID } from 'node:crypto';
import {
  createBestEffortNonInteractiveCommandService,
  createNonInteractiveCommandService,
} from '../nonInteractiveCliCommands.js';
import { getSdkPermissionMode } from '../session/permissionMode.js';

import { formatAuthenticationErrorMessage } from './errors.js';

const COMMAND_CATALOG_STARTUP_WAIT_MS = 5000;

export const WIRE_PROTOCOL_CAPABILITIES = [
  'interrupt_receipt_v1',
  'interrupt_cancel_queued_v1',
  'msg_lifecycle_v1',
  'session_rewind_v1',
  'background_tasks_v1',
  'side_question_v1',
  'custom_context_v1',
  'goal_v1',
  'goal_max_turns_v1',
  'goal_max_turns_unlimited_v1',
  'goal_resume_v1',
  'skill_evolution_v1',
  'plan_mode_v1',
  'session_store_fork_barrier_v1',
  'host_action',
  CUSTOM_MODEL_PROVIDER_CONFIG_WIRE.capability.management,
  'commands_changed_v1',
  'reload_skills_v1',
  'selected_skills_v1',
] as const;

export function extractResultErrors(msg: SDKMessage): string {
  const errors =
    'errors' in msg && Array.isArray(msg.errors)
      ? msg.errors
      : ['Unknown error'];
  return errors.join('; ');
}

export function getHeadlessResultExitCode(msg: SDKMessage): number | undefined {
  if (msg.type !== 'result') {
    return undefined;
  }
  return msg.is_error ? 1 : 0;
}

/**
 * Sets `process.exitCode` based on a stream-json result message.
 * Centralises the exit-code derivation used in every stream-json consumer.
 */
export function setStreamJsonResultExitCode(msg: SDKMessage): void {
  const exitCode = getHeadlessResultExitCode(msg);
  if (typeof exitCode === 'number') {
    process.exitCode = exitCode;
  } else if (msg.type === 'result' && msg.subtype !== 'success') {
    const errorMsg = extractResultErrors(msg);
    process.exitCode = errorMsg.includes('Operation aborted') ? 130 : 1;
  }
}

export function writeHeadlessTextResult(
  msg: Extract<SDKMessage, { type: 'result' }>,
  stdout: NodeJS.WriteStream,
): void {
  switch (msg.subtype) {
    case 'success': {
      const resultText =
        'result' in msg && typeof msg.result === 'string' ? msg.result : '';
      stdout.write(resultText.endsWith('\n') ? resultText : resultText + '\n');
      if (msg.is_error) {
        process.exitCode = 1;
      }
      return;
    }
    case 'error_during_execution':
    case 'error_max_turns':
      stdout.write(extractResultErrors(msg));
      process.exitCode = 1;
      return;
    default:
      return;
  }
}

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

export async function buildStreamJsonInitMessage(
  config: Config,
  signal?: AbortSignal,
  options?: { hiddenToolName?: string },
): Promise<SDKMessage> {
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

  const commandService = await createCommandServiceForProtocolMetadata(config, signal);
  const slashCommands = commandService
    .getCommands()
    .map((command) => command.name);
  const agentNames = config.getAgentRegistry?.()?.getAllAgentNames() ?? [];

  const plugins = config
    .getEnabledPlugins()
    .map((plugin) => ({ name: plugin.name, path: plugin.path }));

  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'none',
    protocol_version: WIRE_PROTOCOL_VERSION,
    cwd: config.getTargetDir(),
    tools: config
      .getToolRegistry()
      .getAllToolNames()
      .filter((toolName) => toolName !== options?.hiddenToolName),
    mcp_servers: mcpServers,
    model: config.getModel() || 'auto',
    permissionMode: getSdkPermissionMode(config),
    slash_commands: slashCommands,
    output_style: config.getOutputStyle?.()?.name ?? DEFAULT_OUTPUT_STYLE_NAME,
    agents: agentNames,
    skills,
    plugins,
    capabilities: [...WIRE_PROTOCOL_CAPABILITIES],
    fast_mode_state: 'off',
    uuid: randomUUID(),
    session_id: config.getSessionId(),
  } as SDKMessage;
}

export function buildSyntheticAssistantErrorMessage(
  config: Config,
  message: string,
): SDKMessage {
  return {
    type: 'assistant',
    message: {
      id: randomUUID(),
      container: null,
      model: SYNTHETIC_MODEL,
      role: 'assistant',
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      type: 'message',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: {
          web_search_requests: 0,
          web_fetch_requests: 0,
        },
        service_tier: null,
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 0,
        },
        inference_geo: null,
        iterations: null,
        speed: null,
      },
      content: [{ type: 'text', text: message, citations: null }],
      context_management: null,
    },
    parent_tool_use_id: null,
    session_id: config.getSessionId(),
    uuid: randomUUID(),
    error: 'authentication_failed',
  } as SDKMessage;
}

export function buildSyntheticErrorResultMessage(
  config: Config,
  error: unknown,
  options?: { terminalReason?: string },
): SDKMessage {
  const errorCode = getResultErrorCode(error);
  const message = formatAuthenticationErrorMessage(error);
  return {
    type: 'result',
    subtype: 'success',
    is_error: true,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    result: message,
    stop_reason: 'stop_sequence',
    session_id: config.getSessionId(),
    total_cost_usd: 0,
    total_credits: 0,
    usage: cloneUsage(),
    modelUsage: {},
    permission_denials: [],
    ...(errorCode !== undefined ? { error_code: errorCode } : {}),
    ...(options?.terminalReason
      ? { terminal_reason: options.terminalReason }
      : {}),
    uuid: randomUUID(),
  } as SDKMessage;
}
