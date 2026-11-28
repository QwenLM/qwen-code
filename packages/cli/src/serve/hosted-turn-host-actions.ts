/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionDeclaration } from '@google/genai';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { assertManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';

export const HOSTED_TURN_HOST_ACTIONS_FEATURE =
  'hosted-turn-host-actions/1' as const;

export const MAX_HOST_ACTIONS_PER_TURN = 16;
export const MAX_HOST_ACTIONS_WIRE_BYTES = 48 * 1024;
export const MAX_HOST_ACTION_DESCRIPTION_BYTES = 4 * 1024;
export const MAX_HOST_ACTION_SCHEMA_BYTES = 16 * 1024;

const ACTION_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;

const RESERVED_TOOL_NAMES = new Set([
  'read_file',
  'write_file',
  'edit',
  'glob',
  'skill',
  'run_shell_command',
  'web_fetch',
  'todo_write',
  'agent',
  'workflow',
  'send_message',
  'ask_user_question',
  'exit_plan_mode',
  'monitor',
  'loop_wakeup',
  'cron_create',
  'cron_list',
  'cron_delete',
  'team_create',
  'team_delete',
  'managed_automation_gate',
]);

const ALLOWED_SCHEMA_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
]);

const ALLOWED_SCHEMA_KEYWORDS = new Set([
  'type',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minLength',
  'maxLength',
  'enum',
]);

export interface HostedTurnHostActionSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface HostedTurnHostActionLane {
  readonly actions: readonly HostedTurnHostActionSpec[];
  readonly writer?: () => Promise<{
    writerId: string;
    writerGeneration: number;
  }>;
}

function hasDisallowedControl(text: string, allowWhitespace: boolean): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      if (
        code <= 0xdbff &&
        i + 1 < text.length &&
        text.charCodeAt(i + 1) >= 0xdc00 &&
        text.charCodeAt(i + 1) <= 0xdfff
      ) {
        i += 1;
        continue;
      }
      return true;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      if (allowWhitespace && (code === 0x0a || code === 0x09)) continue;
      return true;
    }
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeSchemaNode(
  raw: unknown,
  root: boolean,
  depth: number,
): Record<string, unknown> {
  if (depth > 8 || !isPlainObject(raw))
    throw new Error('Invalid Hosted Turn host action schema.');
  const type = raw['type'];
  if (typeof type !== 'string' || !ALLOWED_SCHEMA_TYPES.has(type))
    throw new Error('Invalid Hosted Turn host action schema type.');
  if (root && type !== 'object')
    throw new Error('Root Hosted Turn host action schema must be an object.');

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_SCHEMA_KEYWORDS.has(key))
      throw new Error(`Unsupported host action schema keyword: ${key}`);
  }

  const normalized: Record<string, unknown> = { type };
  if (raw['description'] !== undefined) {
    const desc = raw['description'];
    if (
      typeof desc !== 'string' ||
      desc.length > 2048 ||
      hasDisallowedControl(desc, true)
    )
      throw new Error('Invalid host action schema description.');
    normalized['description'] = desc;
  }

  if (type === 'object') {
    const props = raw['properties'];
    if (!isPlainObject(props))
      throw new Error('Object host action schema requires properties.');
    const normalizedProps: Record<string, unknown> = {};
    for (const key of Object.keys(props).sort()) {
      if (!key || key.length > 128 || hasDisallowedControl(key, false))
        throw new Error('Invalid host action property name.');
      normalizedProps[key] = normalizeSchemaNode(props[key], false, depth + 1);
    }
    normalized['properties'] = normalizedProps;
    if (raw['required'] !== undefined) {
      const req = raw['required'];
      if (!Array.isArray(req))
        throw new Error('Schema required must be an array.');
      const seen = new Set<string>();
      const required: string[] = [];
      for (const entry of req) {
        if (
          typeof entry !== 'string' ||
          !Object.hasOwn(normalizedProps, entry) ||
          seen.has(entry)
        )
          throw new Error('Schema required contains invalid property.');
        seen.add(entry);
        required.push(entry);
      }
      normalized['required'] = required;
    }
    if (
      raw['additionalProperties'] !== undefined &&
      typeof raw['additionalProperties'] !== 'boolean'
    )
      throw new Error('Schema additionalProperties must be a boolean.');
    normalized['additionalProperties'] = raw['additionalProperties'] === true;
  } else if (type === 'array') {
    normalized['items'] = normalizeSchemaNode(raw['items'], false, depth + 1);
  } else if (type === 'string') {
    for (const bound of ['minLength', 'maxLength'] as const) {
      if (raw[bound] !== undefined) {
        const num = raw[bound];
        if (
          typeof num !== 'number' ||
          !Number.isSafeInteger(num) ||
          num < 0 ||
          num > 1_048_576
        )
          throw new Error(`Invalid host action schema ${bound}.`);
        normalized[bound] = num;
      }
    }
    if (
      typeof normalized['minLength'] === 'number' &&
      typeof normalized['maxLength'] === 'number' &&
      normalized['minLength'] > normalized['maxLength']
    )
      throw new Error('Schema minLength exceeds maxLength.');
    if (raw['enum'] !== undefined) {
      const values = raw['enum'];
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.length > 64 ||
        values.some(
          (item) =>
            typeof item !== 'string' || hasDisallowedControl(item, true),
        )
      )
        throw new Error('Invalid host action string enum.');
      normalized['enum'] = [...values];
    }
  }

  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(normalized).sort()) {
    ordered[key] = normalized[key];
  }
  return ordered;
}

export function parseHostedTurnHostActions(
  value: unknown,
): readonly HostedTurnHostActionSpec[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_HOST_ACTIONS_PER_TURN
  )
    throw new Error('Invalid Hosted Turn host actions.');

  const names = new Set<string>();
  const actions: HostedTurnHostActionSpec[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || Object.keys(item).length !== 3)
      throw new Error('Invalid Hosted Turn host action entry.');
    const name = item['name'];
    const description = item['description'];
    if (
      typeof name !== 'string' ||
      !ACTION_NAME_PATTERN.test(name) ||
      RESERVED_TOOL_NAMES.has(name) ||
      name.startsWith('mcp_') ||
      names.has(name)
    )
      throw new Error('Invalid or duplicate Hosted Turn host action name.');
    if (
      typeof description !== 'string' ||
      !description.trim() ||
      Buffer.byteLength(description, 'utf8') >
        MAX_HOST_ACTION_DESCRIPTION_BYTES ||
      hasDisallowedControl(description, true)
    )
      throw new Error('Invalid Hosted Turn host action description.');
    const inputSchema = normalizeSchemaNode(item['inputSchema'], true, 0);
    if (
      Buffer.byteLength(JSON.stringify(inputSchema), 'utf8') >
      MAX_HOST_ACTION_SCHEMA_BYTES
    )
      throw new Error('Hosted Turn host action schema exceeds byte cap.');
    names.add(name);
    actions.push({ name, description, inputSchema });
  }
  if (
    Buffer.byteLength(JSON.stringify(actions), 'utf8') >
    MAX_HOST_ACTIONS_WIRE_BYTES
  )
    throw new Error('Hosted Turn host actions exceed wire byte cap.');
  return actions;
}

export async function readHostedTurnHostActions(
  session: ManagedSession,
  promptId: string,
): Promise<readonly HostedTurnHostActionSpec[] | undefined> {
  const accepted = session.authority
    .eventsInSequenceRange(1, session.authority.committedSequence)
    .findLast(
      (event) =>
        event.kind === 'input.accepted' &&
        event.payload['inputId'] === promptId,
    );
  if (accepted?.payload['source'] !== 'hosted-harness') return undefined;
  const rawRef = accepted?.payload['admissionRef'];
  if (rawRef === undefined) return undefined;
  const ref = assertManagedSessionDurableRef(rawRef, 'host actions admission');
  if (
    ref.kind !== 'managed-admission' ||
    ref.schemaVersion !== 1 ||
    ref.byteLength > 64 * 1024
  )
    throw new Error('Invalid Hosted Turn host actions admission.');
  const admission: unknown = JSON.parse(
    (await session.resources.read(ref)).toString('utf8'),
  );
  if (!isPlainObject(admission))
    throw new Error('Invalid Hosted Turn host actions admission.');
  if (admission['hostActions'] === undefined) return undefined;
  if (admission['promptId'] !== promptId)
    throw new Error('Hosted Turn host actions belong to another input.');
  return parseHostedTurnHostActions(admission['hostActions']);
}

export function hostedTurnHostActionDeclarations(
  actions: readonly HostedTurnHostActionSpec[],
): FunctionDeclaration[] {
  return actions.map((action) => ({
    name: action.name,
    description: action.description,
    parametersJsonSchema: action.inputSchema,
  }));
}

function validateValueAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  depth: number,
): unknown {
  if (depth > 16) throw new Error(`${path} exceeds maximum nesting depth.`);
  if (value === null || value === undefined)
    throw new Error(`${path} is required and cannot be null.`);
  const type = schema['type'];
  switch (type) {
    case 'string': {
      if (typeof value !== 'string' || hasDisallowedControl(value, true))
        throw new Error(`${path} must be a valid string.`);
      const minLength = schema['minLength'];
      const maxLength = schema['maxLength'];
      if (typeof minLength === 'number' && value.length < minLength)
        throw new Error(`${path} must be at least ${minLength} characters.`);
      if (typeof maxLength === 'number' && value.length > maxLength)
        throw new Error(`${path} must be at most ${maxLength} characters.`);
      const allowed = schema['enum'];
      if (Array.isArray(allowed) && !allowed.includes(value))
        throw new Error(
          `${path} must be one of ${allowed.map((entry) => JSON.stringify(entry)).join(', ')}.`,
        );
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean')
        throw new Error(`${path} must be a boolean.`);
      return value;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value))
        throw new Error(`${path} must be an integer.`);
      return value;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error(`${path} must be a finite number.`);
      return value;
    }
    case 'array': {
      if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
      const itemSchema = schema['items'] as Record<string, unknown>;
      return value.map((entry, index) =>
        validateValueAgainstSchema(
          itemSchema,
          entry,
          `${path}[${index}]`,
          depth + 1,
        ),
      );
    }
    case 'object': {
      if (!isPlainObject(value)) throw new Error(`${path} must be an object.`);
      const props = schema['properties'] as Record<
        string,
        Record<string, unknown>
      >;
      const required = (schema['required'] as readonly string[]) ?? [];
      const allowAdditional = schema['additionalProperties'] === true;
      for (const reqKey of required) {
        if (!Object.hasOwn(value, reqKey) || value[reqKey] === undefined)
          throw new Error(`Missing required argument "${reqKey}".`);
      }
      const result: Record<string, unknown> = {};
      for (const [key, entryValue] of Object.entries(value)) {
        if (entryValue === undefined) continue;
        const propSchema = props[key];
        if (!propSchema) {
          if (!allowAdditional)
            throw new Error(`Unsupported argument ${JSON.stringify(key)}.`);
          result[key] = entryValue;
        } else {
          result[key] = validateValueAgainstSchema(
            propSchema,
            entryValue,
            key,
            depth + 1,
          );
        }
      }
      return result;
    }
    default:
      throw new Error(`Unsupported schema type at ${path}.`);
  }
}

export function validateHostedTurnHostActionArgs(
  spec: HostedTurnHostActionSpec,
  rawArgs: Record<string, unknown>,
): { input: Record<string, unknown>; error?: string } {
  try {
    const validated = validateValueAgainstSchema(
      spec.inputSchema,
      rawArgs,
      spec.name,
      0,
    ) as Record<string, unknown>;
    return { input: validated };
  } catch (cause) {
    const detail =
      cause instanceof Error ? cause.message : 'Invalid arguments.';
    return {
      input: { ...rawArgs },
      error: `Host action ${spec.name} received invalid arguments: ${detail} Correct the arguments and retry.`,
    };
  }
}
