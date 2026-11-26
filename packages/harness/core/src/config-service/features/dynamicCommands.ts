/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { coreEvents } from '../../utils/events.js';
import { runLogger } from '../../utils/runLogger.js';
import { getConfigValue, subscribeConfigValue } from '../index.js';
import { parseBoolean } from './gateParseUtils.js';

export const DYNAMIC_COMMANDS_GATE = 'dynamic_commands';

export type DynamicCommandAuthMode = 'bearer' | 'wasm' | 'none';

export interface DynamicCommandEndpointConfig {
  domain: string;
  path: string;
  method?: string;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  auth?: DynamicCommandAuthMode;
}

export interface DynamicCommandErrorMessages {
  detail?: string;
  interaction?: string;
}

export interface DynamicCommandDisplayConfig {
  /** Copy templates rendered as one informational message. */
  lines: string[];
  /** Detail response paths that must exist before any copy is rendered. */
  requiredFields?: string[];
}

export interface DynamicCommandDefinition {
  name: string;
  description: string;
  startTime: string;
  endTime: string;
  content?: string;
  detail?: DynamicCommandEndpointConfig[];
  interaction?: DynamicCommandEndpointConfig;
  confirmationPrompt?: string;
  loadingMessage?: string;
  /** Configured copy shown for an explicit ineligible result with no detail text. */
  ineligibleMessage?: string;
  requiresCanClaim?: boolean;
  errorMessages?: DynamicCommandErrorMessages;
  display?: DynamicCommandDisplayConfig;
  displayName?: string;
  altNames?: string[];
  argumentHint?: string;
  argNames?: string[];
  allowedTools?: string[];
  model?: string;
  effort?: string;
  whenToUse?: string;
  hidden?: boolean;
  autoExecute?: boolean;
  takesArgs?: boolean;
}

interface CommandSchedule {
  startTime: string;
  endTime: string;
  startMs: number;
  endMs: number;
}

export interface DynamicCommandsConfig {
  commands: DynamicCommandDefinition[];
}

const DEFAULT_DYNAMIC_COMMANDS_CONFIG: DynamicCommandsConfig = { commands: [] };

let currentGateValue: DynamicCommandsConfig = DEFAULT_DYNAMIC_COMMANDS_CONFIG;
let currentRawGateValue: unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map(asString)
    .filter((item): item is string => item !== undefined);
  return items.length > 0 ? items : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const stringValue = asString(item);
    if (stringValue !== undefined) {
      out[key] = stringValue;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function parseAuthMode(value: unknown): DynamicCommandAuthMode | undefined {
  const booleanValue = parseBoolean(value);
  if (booleanValue !== undefined) return booleanValue ? 'bearer' : 'none';

  const mode = asString(value)?.toLowerCase();
  return mode === 'bearer' || mode === 'wasm' || mode === 'none'
    ? mode
    : undefined;
}

function parseErrorMessages(
  value: unknown,
): DynamicCommandErrorMessages | undefined {
  if (!isRecord(value)) return undefined;

  const detail = asString(value['detail']);
  const interaction = asString(value['interaction']);
  return detail || interaction
    ? {
        ...(detail ? { detail } : {}),
        ...(interaction ? { interaction } : {}),
      }
    : undefined;
}

function parseDisplayConfig(
  value: unknown,
): DynamicCommandDisplayConfig | undefined {
  if (!isRecord(value)) return undefined;

  const lines = asStringArray(value['lines']);
  if (!lines) return undefined;

  const requiredFieldsValue =
    value['requiredFields'] ?? value['required_fields'];
  const requiredFields = asStringArray(requiredFieldsValue);
  if (requiredFieldsValue !== undefined && !requiredFields) return undefined;

  return {
    lines,
    ...(requiredFields ? { requiredFields } : {}),
  };
}

function asCommandName(value: unknown): string | undefined {
  const name = asString(value)?.replace(/^\/+/, '');
  if (!name || /\s/.test(name)) return undefined;
  return /^[a-zA-Z0-9:_-]+$/.test(name) ? name : undefined;
}

function readCommandContent(record: Record<string, unknown>): string | undefined {
  return asString(record['content']) ?? asString(record['prompt']);
}

function readCommandSchedule(
  record: Record<string, unknown>,
): CommandSchedule | undefined {
  const startTime = asString(
    record['startTime'] ??
      record['start_time'] ??
      record['startAt'] ??
      record['start_at'],
  );
  const endTime = asString(
    record['endTime'] ?? record['end_time'] ?? record['endAt'] ?? record['end_at'],
  );
  if (!startTime || !endTime) return undefined;

  const startMs = Date.parse(startTime);
  const endMs = Date.parse(endTime);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
    return undefined;
  }

  return { startTime, endTime, startMs, endMs };
}

function parseEndpoint(value: unknown): DynamicCommandEndpointConfig | undefined {
  if (!isRecord(value)) return undefined;

  const domain = asString(value['domain'] ?? value['host'] ?? value['baseUrl']);
  const path = asString(value['path']);
  if (!domain || !path) return undefined;

  const method = asString(value['method'])?.toUpperCase();
  const params = asUnknownRecord(value['params']);
  const query = asUnknownRecord(value['query']);
  const headers = asStringRecord(value['headers']);
  const auth = parseAuthMode(value['auth']);
  if (value['auth'] !== undefined && !auth) return undefined;

  return {
    domain,
    path,
    ...(method ? { method } : {}),
    ...(params ? { params } : {}),
    ...(query ? { query } : {}),
    ...(value['body'] !== undefined ? { body: value['body'] } : {}),
    ...(headers ? { headers } : {}),
    ...(auth !== undefined ? { auth } : {}),
  };
}

function parseDetailEndpoints(
  value: unknown,
): DynamicCommandEndpointConfig[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const endpoints = value.map(parseEndpoint);
  return endpoints.every(
    (endpoint): endpoint is DynamicCommandEndpointConfig => endpoint !== undefined,
  )
    ? endpoints
    : undefined;
}

function parseCommand(
  value: unknown,
  nowMs: number,
): DynamicCommandDefinition | undefined {
  if (!isRecord(value)) return undefined;
  if (parseBoolean(value['enabled']) === false) return undefined;

  const name = asCommandName(value['name'] ?? value['commandName']);
  const schedule = readCommandSchedule(value);
  const content = readCommandContent(value) ?? asString(value['command']);
  const detail = parseDetailEndpoints(value['detail']);
  const interaction = parseEndpoint(value['interaction']);
  if (value['detail'] !== undefined && !detail) return undefined;
  if (
    !name ||
    !schedule ||
    nowMs < schedule.startMs ||
    nowMs > schedule.endMs ||
    (!content && !detail && !interaction)
  ) {
    return undefined;
  }

  const description =
    asString(value['description']) ?? `Dynamic command ${name}`;
  const confirmationPrompt = asString(
    value['confirmationPrompt'] ?? value['confirmation_prompt'],
  );
  const loadingMessage = asString(
    value['loadingMessage'] ?? value['loading_message'],
  );
  const ineligibleMessage = asString(
    value['ineligibleMessage'] ?? value['ineligible_message'],
  );
  const requiresCanClaimValue =
    value['requiresCanClaim'] !== undefined
      ? value['requiresCanClaim']
      : value['requires_can_claim'];
  const requiresCanClaim = parseBoolean(requiresCanClaimValue);
  if (
    requiresCanClaimValue !== undefined &&
    requiresCanClaim === undefined
  ) {
    return undefined;
  }
  const errorMessages = parseErrorMessages(
    value['errorMessages'] ?? value['error_messages'],
  );
  const display = parseDisplayConfig(value['display']);
  if (value['display'] !== undefined && !display) return undefined;
  const displayName = asString(value['displayName']);
  const altNames = asStringArray(value['altNames'] ?? value['aliases']);
  const argumentHint = asString(value['argumentHint']);
  const argNames = asStringArray(value['argNames'] ?? value['argumentNames']);
  const allowedTools = asStringArray(
    value['allowedTools'] ?? value['allowed_tools'],
  );
  const model = asString(value['model']);
  const effort = asString(value['effort']);
  const whenToUse = asString(value['whenToUse']);
  const hidden = parseBoolean(value['hidden']);
  const autoExecute = parseBoolean(value['autoExecute']);
  const takesArgs = parseBoolean(value['takesArgs']);

  return {
    name,
    description,
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    ...(content ? { content } : {}),
    ...(detail ? { detail } : {}),
    ...(interaction ? { interaction } : {}),
    ...(confirmationPrompt ? { confirmationPrompt } : {}),
    ...(loadingMessage ? { loadingMessage } : {}),
    ...(ineligibleMessage ? { ineligibleMessage } : {}),
    ...(requiresCanClaim !== undefined ? { requiresCanClaim } : {}),
    ...(errorMessages ? { errorMessages } : {}),
    ...(display ? { display } : {}),
    ...(displayName ? { displayName } : {}),
    ...(altNames ? { altNames } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    ...(argNames ? { argNames } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(whenToUse ? { whenToUse } : {}),
    ...(hidden !== undefined ? { hidden } : {}),
    ...(autoExecute !== undefined ? { autoExecute } : {}),
    ...(takesArgs !== undefined ? { takesArgs } : {}),
  };
}

function collectCommandCandidates(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return [...(value as unknown[])];
  if (!isRecord(value)) return undefined;
  if (parseBoolean(value['enabled']) === false) return [];

  const candidates: unknown[] = [];
  const commands = value['commands'];
  if (Array.isArray(commands)) {
    candidates.push(...(commands as unknown[]));
  }
  if (isRecord(value['command'])) {
    candidates.push(value['command']);
  }
  if (
    value['name'] !== undefined &&
    (value['content'] !== undefined ||
      value['prompt'] !== undefined ||
      asString(value['command']) !== undefined)
  ) {
    candidates.push(value);
  }
  return candidates;
}

export function parseDynamicCommandsValue(
  value: unknown,
  nowMs: number = Date.now(),
): DynamicCommandsConfig | undefined {
  if (value == null) return DEFAULT_DYNAMIC_COMMANDS_CONFIG;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return DEFAULT_DYNAMIC_COMMANDS_CONFIG;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  if (parseBoolean(value) !== undefined) {
    return DEFAULT_DYNAMIC_COMMANDS_CONFIG;
  }

  const candidates = collectCommandCandidates(value);
  if (candidates === undefined) return undefined;

  return {
    commands: candidates
      .map((candidate) => parseCommand(candidate, nowMs))
      .filter((command): command is DynamicCommandDefinition => !!command),
  };
}

function resolveCurrentGateValue(): DynamicCommandsConfig {
  const freshValue = getConfigValue(DYNAMIC_COMMANDS_GATE);
  if (freshValue !== undefined) {
    const parsed = parseDynamicCommandsValue(freshValue);
    if (parsed !== undefined) {
      currentRawGateValue = freshValue;
      currentGateValue = parsed;
      return parsed;
    }
  }
  if (currentRawGateValue !== undefined) {
    const parsed = parseDynamicCommandsValue(currentRawGateValue);
    if (parsed !== undefined) {
      currentGateValue = parsed;
      return parsed;
    }
  }
  return currentGateValue;
}

export function getDynamicCommandsConfig(): DynamicCommandsConfig {
  return resolveCurrentGateValue();
}

export function getDynamicCommandDefinitions(): DynamicCommandDefinition[] {
  return getDynamicCommandsConfig().commands;
}

export function registerDynamicCommandsFeature(): void {
  subscribeConfigValue(DYNAMIC_COMMANDS_GATE, (value) => {
    if (value === undefined) {
      return;
    }
      const parsed = parseDynamicCommandsValue(value);
      if (parsed === undefined) {
        runLogger.warn(
          '[config-service] Ignoring invalid dynamic_commands feature gate value',
          { value },
        );
        return;
      }

      currentRawGateValue = value;
      currentGateValue = parsed;
      runLogger.log('[config-service] dynamic_commands feature gate value received', {
        commandCount: parsed.commands.length,
      });
      coreEvents.emitDynamicCommandsChanged();
  });
}

export function resetDynamicCommandsForTesting(): void {
  currentGateValue = DEFAULT_DYNAMIC_COMMANDS_CONFIG;
  currentRawGateValue = undefined;
}
