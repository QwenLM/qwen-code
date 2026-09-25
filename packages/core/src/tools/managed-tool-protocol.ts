/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { FunctionDeclaration } from '@google/genai';
import type { PermissionDecision } from '../permissions/types.js';
import type { InputModalities } from '../core/contentGenerator.js';
import type {
  Kind,
  ToolCallConfirmationDetails,
  ToolConfirmationPayload,
  ToolLocation,
} from './tools.js';

const MAX_JSON_BYTES = 256 * 1024;
const MAX_JSON_DEPTH = 64;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const IDENTITY_KEYS = [
  'sessionId',
  'promptId',
  'callId',
  'capabilityDigest',
  'policyRevision',
] as const;

export interface ManagedToolCallIdentity {
  readonly sessionId: string;
  readonly promptId: string;
  readonly callId: string;
  readonly capabilityDigest: string;
  readonly policyRevision: string;
}

export interface ManagedToolInvocationReference
  extends ManagedToolCallIdentity {
  readonly invocationId: string;
  readonly argsDigest: string;
}

export interface ManagedToolContentModification {
  readonly source: ManagedToolInvocationReference;
  readonly newContent: string;
}

export interface ManagedToolMediaContext {
  readonly inputModalities: Readonly<InputModalities>;
}

export interface ManagedToolDescriptor {
  readonly name: string;
  readonly displayName: string;
  readonly kind: Kind;
  readonly description: string;
  readonly schema: FunctionDeclaration;
  readonly permissionAliases?: readonly string[];
  readonly canUpdateOutput: boolean;
  readonly isOutputMarkdown?: boolean;
  readonly shouldDefer?: boolean;
  readonly alwaysLoad?: boolean;
  readonly searchHint?: string;
  readonly maxOutputChars?: number | 'unlimited';
  readonly truncateKeep?: 'head' | 'tail' | 'both';
  readonly isMcp?: boolean;
  readonly mcpServerName?: string;
  readonly mcpToolName?: string;
}

export interface ManagedToolPrepareResponse
  extends ManagedToolInvocationReference {
  readonly params: Record<string, unknown>;
  readonly description: string;
  readonly locations: ToolLocation[];
  readonly defaultPermission: PermissionDecision;
  readonly requiresUserInteraction: boolean;
  readonly toolUseId: string;
}

type WorkspaceConfirmation = Extract<
  ToolCallConfirmationDetails,
  { type: 'edit' | 'exec' | 'mcp' | 'info' }
>;

export type ManagedToolConfirmationDetails = {
  [T in WorkspaceConfirmation['type']]: Omit<
    Extract<WorkspaceConfirmation, { type: T }>,
    'onConfirm'
  >;
}[WorkspaceConfirmation['type']];

export class ManagedToolProtocolError extends Error {
  readonly code = 'managed_tool_invalid_request';

  constructor(message = 'Managed Tool invocation data is invalid.') {
    super(message);
    this.name = 'ManagedToolProtocolError';
  }
}

function canonicalJson(value: unknown, maxBytes = MAX_JSON_BYTES): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new ManagedToolProtocolError('Invalid Managed Tool JSON size limit.');
  }
  const ancestors = new Set<object>();
  const chunks: string[] = [];
  let bytes = 0;
  const append = (chunk: string) => {
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes > maxBytes) {
      throw new ManagedToolProtocolError(
        'Managed Tool JSON exceeds size limit.',
      );
    }
    chunks.push(chunk);
  };
  const appendString = (text: string) => {
    if (Buffer.byteLength(text, 'utf8') > maxBytes - bytes) {
      throw new ManagedToolProtocolError(
        'Managed Tool JSON exceeds size limit.',
      );
    }
    append(JSON.stringify(text));
  };
  const visit = (input: unknown, depth: number): void => {
    if (depth > MAX_JSON_DEPTH) {
      throw new ManagedToolProtocolError(
        'Managed Tool JSON exceeds depth limit.',
      );
    }
    if (input === null) {
      append('null');
    } else if (typeof input === 'string') {
      appendString(input);
    } else if (typeof input === 'boolean') {
      append(input ? 'true' : 'false');
    } else if (typeof input === 'number' && Number.isFinite(input)) {
      append(JSON.stringify(input));
    } else if (typeof input === 'object') {
      if (
        ancestors.has(input) ||
        (!Array.isArray(input) &&
          Object.getPrototypeOf(input) !== Object.prototype &&
          Object.getPrototypeOf(input) !== null)
      ) {
        throw new ManagedToolProtocolError();
      }
      ancestors.add(input);
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const keys = Reflect.ownKeys(descriptors);
      if (
        keys.some((key) => {
          if (typeof key !== 'string') return true;
          if (Array.isArray(input) && key === 'length') return false;
          const descriptor = descriptors[key];
          return !descriptor.enumerable || !('value' in descriptor);
        })
      ) {
        throw new ManagedToolProtocolError();
      }
      if (Array.isArray(input)) {
        if (
          keys.length !== input.length + 1 ||
          keys.some(
            (key) =>
              key !== 'length' &&
              (typeof key !== 'string' ||
                !/^(0|[1-9][0-9]*)$/.test(key) ||
                Number(key) >= input.length),
          )
        ) {
          throw new ManagedToolProtocolError();
        }
        append('[');
        for (let index = 0; index < input.length; index++) {
          if (index > 0) append(',');
          visit(descriptors[String(index)].value, depth + 1);
        }
        append(']');
      } else {
        append('{');
        Object.keys(descriptors)
          .sort()
          .forEach((key, index) => {
            if (index > 0) append(',');
            appendString(key);
            append(':');
            visit(descriptors[key].value, depth + 1);
          });
        append('}');
      }
      ancestors.delete(input);
    } else {
      throw new ManagedToolProtocolError();
    }
  };
  visit(value, 0);
  return chunks.join('');
}

export function managedToolDigest(
  value: unknown,
  maxBytes = MAX_JSON_BYTES,
): string {
  return createHash('sha256')
    .update(canonicalJson(value, maxBytes))
    .digest('hex');
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManagedToolProtocolError();
  }
  return value as Record<string, unknown>;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return record(JSON.parse(canonicalJson(value)));
}

function assertKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (Object.keys(input).some((key) => !keys.includes(key))) {
    throw new ManagedToolProtocolError();
  }
}

function boundedId(value: unknown, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes('\0')
  ) {
    throw new ManagedToolProtocolError();
  }
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new ManagedToolProtocolError();
  }
  return value;
}

function identityFields(
  input: Record<string, unknown>,
): ManagedToolCallIdentity {
  const sessionId = boundedId(input['sessionId'], 256);
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new ManagedToolProtocolError();
  return {
    sessionId: sessionId.toLowerCase(),
    promptId: boundedId(input['promptId'], 128),
    callId: boundedId(input['callId'], 512),
    capabilityDigest: digest(input['capabilityDigest']),
    policyRevision: boundedId(input['policyRevision'], 256),
  };
}

export function parseManagedToolCallIdentity(
  value: unknown,
): ManagedToolCallIdentity {
  const input = jsonRecord(value);
  assertKeys(input, IDENTITY_KEYS);
  return identityFields(input);
}

export function parseManagedToolInvocationReference(
  value: unknown,
): ManagedToolInvocationReference {
  const input = jsonRecord(value);
  assertKeys(input, [...IDENTITY_KEYS, 'invocationId', 'argsDigest']);
  return {
    ...identityFields(input),
    invocationId: boundedId(input['invocationId'], 128),
    argsDigest: digest(input['argsDigest']),
  };
}

export function parseManagedToolContentModification(
  value: unknown,
): ManagedToolContentModification {
  const input = jsonRecord(value);
  assertKeys(input, ['source', 'newContent']);
  if (typeof input['newContent'] !== 'string')
    throw new ManagedToolProtocolError();
  return {
    source: parseManagedToolInvocationReference(input['source']),
    newContent: input['newContent'],
  };
}

export function parseManagedToolMediaContext(
  value: unknown,
): ManagedToolMediaContext {
  const input = jsonRecord(value);
  assertKeys(input, ['inputModalities']);
  const modalities = record(input['inputModalities']);
  assertKeys(modalities, ['image', 'pdf', 'audio', 'video']);
  if (
    Object.values(modalities).some((enabled) => typeof enabled !== 'boolean')
  ) {
    throw new ManagedToolProtocolError();
  }
  return { inputModalities: modalities as InputModalities };
}

export function serializeManagedToolConfirmation(
  details: ToolCallConfirmationDetails,
): ManagedToolConfirmationDetails {
  if (details.type === 'plan' || details.type === 'ask_user_question') {
    throw new ManagedToolProtocolError('Confirmation belongs to the Gateway.');
  }
  const base = {
    title: details.title,
    ...(details.hideAlwaysAllow !== undefined
      ? { hideAlwaysAllow: details.hideAlwaysAllow }
      : {}),
    ...(details.autoModeFallback !== undefined
      ? {
          autoModeFallback: {
            reason: details.autoModeFallback.reason,
            message: details.autoModeFallback.message,
          },
        }
      : {}),
  };
  let result: ManagedToolConfirmationDetails;
  switch (details.type) {
    case 'edit':
      result = {
        ...base,
        type: 'edit',
        fileName: details.fileName,
        filePath: details.filePath,
        fileDiff: details.fileDiff,
        originalContent: details.originalContent,
        newContent: details.newContent,
        ...(details.isModifying !== undefined
          ? { isModifying: details.isModifying }
          : {}),
        ...(details.hideModify !== undefined
          ? { hideModify: details.hideModify }
          : {}),
        ...(details.skipIdeDiff !== undefined
          ? { skipIdeDiff: details.skipIdeDiff }
          : {}),
        ...(details.warnings !== undefined
          ? { warnings: details.warnings }
          : {}),
      };
      break;
    case 'exec':
      result = {
        ...base,
        type: 'exec',
        command: details.command,
        rootCommand: details.rootCommand,
        ...(details.permissionRules !== undefined
          ? { permissionRules: details.permissionRules }
          : {}),
        ...(details.warnings !== undefined
          ? { warnings: details.warnings }
          : {}),
      };
      break;
    case 'mcp':
      result = {
        ...base,
        type: 'mcp',
        serverName: details.serverName,
        toolName: details.toolName,
        toolDisplayName: details.toolDisplayName,
        ...(details.permissionRules !== undefined
          ? { permissionRules: details.permissionRules }
          : {}),
      };
      break;
    case 'info':
      result = {
        ...base,
        type: 'info',
        prompt: details.prompt,
        ...(details.renderPromptAsPlainText !== undefined
          ? { renderPromptAsPlainText: details.renderPromptAsPlainText }
          : {}),
        ...(details.urls !== undefined ? { urls: details.urls } : {}),
        ...(details.permissionRules !== undefined
          ? { permissionRules: details.permissionRules }
          : {}),
      };
      break;
    default:
      throw new ManagedToolProtocolError(
        'Confirmation belongs to the Gateway.',
      );
  }
  return JSON.parse(canonicalJson(result)) as ManagedToolConfirmationDetails;
}

export function parseManagedToolConfirmationPayload(
  value: unknown,
): ToolConfirmationPayload | undefined {
  if (value === undefined) return undefined;
  const input = jsonRecord(value);
  assertKeys(input, [
    'newContent',
    'cancelMessage',
    'permissionRules',
    'answers',
    'updatedInput',
  ]);
  const result: ToolConfirmationPayload = {};
  for (const key of ['newContent', 'cancelMessage'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string') throw new ManagedToolProtocolError();
      result[key] = input[key];
    }
  }
  const rules = input['permissionRules'];
  if (rules !== undefined) {
    if (
      !Array.isArray(rules) ||
      rules.some((rule) => typeof rule !== 'string')
    ) {
      throw new ManagedToolProtocolError();
    }
    result.permissionRules = rules;
  }
  if (input['answers'] !== undefined) {
    const answers = record(input['answers']);
    if (Object.values(answers).some((answer) => typeof answer !== 'string')) {
      throw new ManagedToolProtocolError();
    }
    result.answers = answers as Record<string, string>;
  }
  if (input['updatedInput'] !== undefined) {
    result.updatedInput = record(input['updatedInput']);
  }
  return result;
}
