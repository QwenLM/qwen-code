/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface GenAiContentAttributes {
  inputMessages?: JsonObject[];
  systemInstructions?: JsonObject[];
  toolDefinitions?: JsonObject[];
}

interface CanonicalPart extends JsonObject {
  type: string;
}

interface PartWithRole {
  part: CanonicalPart;
  role?: string;
}

interface StreamPart {
  type: string;
  content?: string;
  id?: string;
  name?: string;
  arguments?: string;
  argumentsFromStart?: boolean;
  value?: CanonicalPart;
}

interface StreamCandidate {
  role: string;
  parts: Map<string, StreamPart>;
  finishReason?: string;
}

const DRAFT_07_TYPES = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function jsonValue(
  value: unknown,
  seen: Set<object> = new Set(),
): JsonValue | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      return jsonValue(toJSON.call(value), seen);
    }
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (const item of value) {
        const converted = jsonValue(item, seen);
        if (converted === undefined) return undefined;
        result.push(converted);
      }
      return result;
    }
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      const converted = jsonValue(item, seen);
      if (converted === undefined) return undefined;
      Object.defineProperty(result, key, {
        value: converted,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function modality(mimeType: string | undefined): string | undefined {
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('video/')) return 'video';
  if (mimeType?.startsWith('audio/')) return 'audio';
  if (mimeType?.startsWith('text/') || mimeType?.startsWith('application/')) {
    return 'document';
  }
  return undefined;
}

function isDataUri(value: string): boolean {
  return /^data:/i.test(value);
}

function dataUriBlob(
  uri: string,
  contentModality: string,
  fallbackMimeType: string | null,
): CanonicalPart | undefined {
  if (!isDataUri(uri)) return undefined;
  const separator = uri.indexOf(',');
  if (separator < 0) return undefined;
  const metadata = uri.slice(5, separator);
  const metadataParts = metadata.split(';');
  if (!metadataParts.slice(1).some((part) => part.toLowerCase() === 'base64')) {
    return undefined;
  }
  const mimeType = metadataParts[0] || fallbackMimeType;
  return {
    type: 'blob',
    mime_type: mimeType,
    modality: contentModality,
    content: uri.slice(separator + 1),
  };
}

function uriPart(
  uri: string,
  contentModality: string,
  mimeType: string | null = null,
): CanonicalPart {
  return {
    type: 'uri',
    mime_type: mimeType,
    modality: contentModality,
    uri,
  };
}

function parseArguments(value: unknown): JsonValue | undefined {
  if (typeof value !== 'string') return jsonValue(value);
  try {
    return jsonValue(JSON.parse(value));
  } catch {
    return value;
  }
}

function genericPart(
  value: Record<string, unknown>,
): CanonicalPart | undefined {
  const type = string(value['type']);
  if (!type) return undefined;
  const converted = jsonValue(value);
  if (!converted || Array.isArray(converted) || typeof converted !== 'object') {
    return undefined;
  }
  return { ...converted, type };
}

function openAiPart(value: unknown): PartWithRole | undefined {
  if (typeof value === 'string') {
    return { part: { type: 'text', content: value } };
  }
  const item = record(value);
  if (!item) return undefined;
  const type = string(item['type']);
  if (type === 'text' || type === 'input_text' || type === 'output_text') {
    const content = string(item['text']) ?? string(item['content']);
    return content === undefined
      ? undefined
      : { part: { type: 'text', content } };
  }
  if (
    type === 'reasoning' ||
    type === 'thinking' ||
    type === 'reasoning_content'
  ) {
    const content = string(item['text']) ?? string(item['content']);
    return content === undefined
      ? undefined
      : { part: { type: 'reasoning', content } };
  }
  if (type === 'image_url') {
    const image = record(item['image_url']);
    const uri = string(image?.['url']) ?? string(item['image_url']);
    if (!uri) return undefined;
    const blob = dataUriBlob(uri, 'image', null);
    if (isDataUri(uri) && !blob) return undefined;
    return {
      part: blob ?? uriPart(uri, 'image'),
    };
  }
  if (type === 'video_url') {
    const video = record(item['video_url']);
    const uri = string(video?.['url']) ?? string(item['video_url']);
    if (!uri) return undefined;
    const blob = dataUriBlob(uri, 'video', null);
    if (isDataUri(uri) && !blob) return undefined;
    return {
      part: blob ?? uriPart(uri, 'video'),
    };
  }
  if (type === 'input_audio') {
    const audio = record(item['input_audio']);
    const content = string(audio?.['data']);
    if (content === undefined) return undefined;
    const format = string(audio?.['format']);
    const mimeType =
      format === 'mp3' ? 'audio/mpeg' : format ? `audio/${format}` : null;
    const blob = dataUriBlob(content, 'audio', mimeType);
    if (isDataUri(content) && !blob) return undefined;
    return {
      part: blob ?? {
        type: 'blob',
        mime_type: mimeType,
        modality: 'audio',
        content,
      },
    };
  }
  if (type === 'file') {
    const file = record(item['file']);
    const fileId = string(file?.['file_id']) ?? string(item['file_id']);
    if (fileId) {
      return {
        part: {
          type: 'file',
          mime_type: null,
          modality: 'document',
          file_id: fileId,
        },
      };
    }
    const fileData = string(file?.['file_data']) ?? string(item['file_data']);
    if (!fileData) return undefined;
    const blob = dataUriBlob(fileData, 'document', null);
    if (blob) return { part: blob };
    if (isDataUri(fileData)) return undefined;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(fileData)) {
      return { part: uriPart(fileData, 'document') };
    }
    return {
      part: {
        type: 'blob',
        mime_type: null,
        modality: 'document',
        content: fileData,
      },
    };
  }
  if (type === 'tool_result' || type === 'tool_call_response') {
    const response = jsonValue(item['response'] ?? item['content']);
    if (response === undefined) return undefined;
    return {
      role: 'tool',
      part: {
        type: 'tool_call_response',
        ...(string(item['tool_call_id']) || string(item['id'])
          ? { id: string(item['tool_call_id']) ?? string(item['id'])! }
          : {}),
        response,
      },
    };
  }
  const part = genericPart(item);
  return part ? { part } : undefined;
}

function anthropicPart(value: unknown): PartWithRole | undefined {
  if (typeof value === 'string') {
    return { part: { type: 'text', content: value } };
  }
  const item = record(value);
  if (!item) return undefined;
  const type = string(item['type']);
  if (type === 'text') {
    const content = string(item['text']);
    return content === undefined
      ? undefined
      : { part: { type: 'text', content } };
  }
  if (type === 'thinking') {
    const content = string(item['thinking']) ?? string(item['text']);
    return content === undefined
      ? undefined
      : { part: { type: 'reasoning', content } };
  }
  if (type === 'redacted_thinking') {
    const part = genericPart(item);
    return part ? { part } : undefined;
  }
  if (type === 'tool_use') {
    const name = string(item['name']);
    if (!name) return undefined;
    const argumentsValue = jsonValue(item['input']);
    return {
      part: {
        type: 'tool_call',
        ...(string(item['id']) ? { id: string(item['id'])! } : {}),
        name,
        ...(argumentsValue !== undefined ? { arguments: argumentsValue } : {}),
      },
    };
  }
  if (type === 'tool_result') {
    const response = jsonValue(item['content']);
    if (response === undefined) return undefined;
    return {
      role: 'tool',
      part: {
        type: 'tool_call_response',
        ...(string(item['tool_use_id'])
          ? { id: string(item['tool_use_id'])! }
          : {}),
        response,
      },
    };
  }
  if (type === 'image' || type === 'document') {
    const source = record(item['source']);
    const sourceType = string(source?.['type']);
    const mimeType = string(source?.['media_type']);
    const data = string(source?.['data']);
    if (sourceType === 'base64' && data !== undefined) {
      return {
        part: {
          type: 'blob',
          mime_type: mimeType ?? null,
          modality: type === 'image' ? 'image' : 'document',
          content: data,
        },
      };
    }
    const uri = string(source?.['url']);
    if (uri) {
      return {
        part: {
          type: 'uri',
          mime_type: mimeType ?? null,
          modality: type === 'image' ? 'image' : 'document',
          uri,
        },
      };
    }
  }
  const part = genericPart(item);
  return part ? { part } : undefined;
}

function geminiPart(value: unknown): PartWithRole | undefined {
  if (typeof value === 'string') {
    return { part: { type: 'text', content: value } };
  }
  const item = record(value);
  if (!item) return undefined;
  const text = string(item['text']);
  if (text !== undefined) {
    return {
      part: {
        type: item['thought'] === true ? 'reasoning' : 'text',
        content: text,
      },
    };
  }
  const call = record(item['functionCall']);
  if (call) {
    const name = string(call['name']);
    if (!name) return undefined;
    const argumentsValue = jsonValue(call['args']);
    return {
      part: {
        type: 'tool_call',
        ...(string(call['id']) ? { id: string(call['id'])! } : {}),
        name,
        ...(argumentsValue !== undefined ? { arguments: argumentsValue } : {}),
      },
    };
  }
  const response = record(item['functionResponse']);
  if (response) {
    const responseValue = jsonValue(response['response']);
    if (responseValue === undefined) return undefined;
    return {
      role: 'tool',
      part: {
        type: 'tool_call_response',
        ...(string(response['id']) ? { id: string(response['id'])! } : {}),
        response: responseValue,
      },
    };
  }
  const inlineData = record(item['inlineData']);
  if (inlineData) {
    const content = string(inlineData['data']);
    if (content === undefined) return undefined;
    const mimeType = string(inlineData['mimeType']);
    const contentModality = modality(mimeType);
    if (!contentModality) return undefined;
    return {
      part: {
        type: 'blob',
        mime_type: mimeType ?? null,
        modality: contentModality,
        content,
      },
    };
  }
  const fileData = record(item['fileData']);
  if (fileData) {
    const uri = string(fileData['fileUri']);
    if (!uri) return undefined;
    const mimeType = string(fileData['mimeType']);
    const contentModality = modality(mimeType);
    if (!contentModality) return undefined;
    return {
      part: {
        type: 'uri',
        mime_type: mimeType ?? null,
        modality: contentModality,
        uri,
      },
    };
  }
  const explicitType = string(item['type']);
  const part = explicitType ? genericPart(item) : undefined;
  return part ? { part } : undefined;
}

function messages(
  values: unknown,
  convertPart: (value: unknown) => PartWithRole | undefined,
  roleMap: (role: string) => string,
): JsonObject[] | undefined {
  const items = Array.isArray(values) ? values : [values];
  const result: JsonObject[] = [];
  for (const value of items) {
    if (typeof value === 'string') {
      result.push({
        role: 'user',
        parts: [{ type: 'text', content: value }],
      });
      continue;
    }
    const message = record(value);
    const rawRole = string(message?.['role']);
    if (!message || !rawRole) return undefined;
    const role = roleMap(rawRole);
    const content = message['content'] ?? message['parts'];
    const rawParts =
      content === undefined || content === null
        ? []
        : Array.isArray(content)
          ? content
          : [content];
    let currentRole = role;
    let currentParts: CanonicalPart[] = [];
    let emitted = false;
    const flush = () => {
      if (currentParts.length === 0) return;
      result.push({
        role: currentRole,
        parts: currentParts,
        ...(string(message['name']) ? { name: string(message['name'])! } : {}),
      });
      currentParts = [];
      emitted = true;
    };
    const reasoning =
      string(message['reasoning_content']) ??
      string(message['reasoning']) ??
      string(message['thinking']);
    if (reasoning !== undefined) {
      currentParts.push({ type: 'reasoning', content: reasoning });
    }
    for (const rawPart of rawParts) {
      const converted = convertPart(rawPart);
      if (!converted) return undefined;
      const nextRole = converted.role ?? role;
      if (currentParts.length > 0 && nextRole !== currentRole) flush();
      currentRole = nextRole;
      currentParts.push(converted.part);
    }
    const refusal = string(message['refusal']);
    if (refusal !== undefined) {
      currentParts.push({ type: 'refusal', content: refusal });
    }
    const audio = record(message['audio']);
    if (audio) {
      const converted = record(jsonValue(audio));
      if (!converted) return undefined;
      currentParts.push({ ...converted, type: 'audio' });
    }
    if (Array.isArray(message['tool_calls'])) {
      if (currentParts.length > 0 && currentRole !== role) flush();
      currentRole = role;
      for (const value of message['tool_calls']) {
        const toolCall = record(value);
        const fn = record(toolCall?.['function']);
        const name = string(fn?.['name']);
        if (!toolCall || !fn || !name) return undefined;
        const argumentsValue = parseArguments(fn['arguments']);
        currentParts.push({
          type: 'tool_call',
          ...(string(toolCall['id']) ? { id: string(toolCall['id'])! } : {}),
          name,
          ...(argumentsValue !== undefined
            ? { arguments: argumentsValue }
            : {}),
        });
      }
    }
    if (
      role === 'tool' &&
      currentParts.length > 0 &&
      currentParts.every((part) => part.type === 'text')
    ) {
      currentParts = currentParts.map((part) => ({
        type: 'tool_call_response',
        ...(string(message['tool_call_id'])
          ? { id: string(message['tool_call_id'])! }
          : {}),
        response: part['content'] ?? null,
      }));
    }
    flush();
    if (!emitted) {
      result.push({
        role,
        parts: [],
        ...(string(message['name']) ? { name: string(message['name'])! } : {}),
      });
    }
  }
  return result;
}

function systemParts(
  value: unknown,
  convertPart: (value: unknown) => PartWithRole | undefined,
): JsonObject[] | undefined {
  if (value === undefined || value === null) return undefined;
  const content = record(value)?.['parts'] ?? value;
  const values = Array.isArray(content) ? content : [content];
  const result: JsonObject[] = [];
  for (const item of values) {
    const part = convertPart(item);
    if (!part || part.role) return undefined;
    result.push(part.part);
  }
  return result;
}

function jsonIdentity(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(jsonIdentity).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${jsonIdentity(value[key]!)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hasUniqueValues(values: JsonValue[]): boolean {
  return new Set(values.map(jsonIdentity)).size === values.length;
}

function isValidRegex(value: string): boolean {
  try {
    new RegExp(value, 'u');
    return true;
  } catch {
    return false;
  }
}

function isValidUri(value: string, allowReference: boolean): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  if (/%(?![0-9A-Fa-f]{2})/.test(value)) return false;
  try {
    new URL(value, allowReference ? 'https://example.invalid/' : undefined);
    return true;
  } catch {
    return false;
  }
}

function normalizeSchema(value: unknown): JsonValue | undefined {
  const converted = jsonValue(value);
  if (converted === undefined) return undefined;
  function visitSchema(schema: JsonValue): boolean {
    return (
      typeof schema === 'boolean' ||
      (schema !== null &&
        !Array.isArray(schema) &&
        typeof schema === 'object' &&
        visit(schema))
    );
  }
  function visit(item: JsonObject): boolean {
    const schemaType = item['type'];
    if (typeof schemaType === 'string') {
      const lower = schemaType.toLowerCase();
      if (!DRAFT_07_TYPES.has(lower)) return false;
      item['type'] = lower;
    } else if (Array.isArray(schemaType)) {
      if (schemaType.length === 0) return false;
      const normalized: string[] = [];
      for (const entry of schemaType) {
        if (typeof entry !== 'string') return false;
        const lower = entry.toLowerCase();
        if (!DRAFT_07_TYPES.has(lower)) return false;
        normalized.push(lower);
      }
      if (new Set(normalized).size !== normalized.length) return false;
      item['type'] = normalized;
    } else if (schemaType !== undefined) {
      return false;
    }

    for (const key of [
      '$comment',
      'title',
      'description',
      'format',
      'contentMediaType',
      'contentEncoding',
    ]) {
      if (item[key] !== undefined && typeof item[key] !== 'string')
        return false;
    }
    for (const key of ['readOnly', 'uniqueItems']) {
      if (item[key] !== undefined && typeof item[key] !== 'boolean') {
        return false;
      }
    }
    if (
      (item['$id'] !== undefined &&
        (typeof item['$id'] !== 'string' || !isValidUri(item['$id'], true))) ||
      (item['$ref'] !== undefined &&
        (typeof item['$ref'] !== 'string' ||
          !isValidUri(item['$ref'], true))) ||
      (item['$schema'] !== undefined &&
        (typeof item['$schema'] !== 'string' ||
          !isValidUri(item['$schema'], false))) ||
      (item['pattern'] !== undefined &&
        (typeof item['pattern'] !== 'string' || !isValidRegex(item['pattern'])))
    ) {
      return false;
    }
    if (item['examples'] !== undefined && !Array.isArray(item['examples'])) {
      return false;
    }
    for (const key of [
      'maximum',
      'exclusiveMaximum',
      'minimum',
      'exclusiveMinimum',
    ]) {
      if (item[key] !== undefined && typeof item[key] !== 'number')
        return false;
    }
    if (
      item['multipleOf'] !== undefined &&
      (typeof item['multipleOf'] !== 'number' || item['multipleOf'] <= 0)
    ) {
      return false;
    }
    for (const key of [
      'maxLength',
      'minLength',
      'maxItems',
      'minItems',
      'maxProperties',
      'minProperties',
    ]) {
      const count = item[key];
      if (
        count !== undefined &&
        (typeof count !== 'number' || !Number.isInteger(count) || count < 0)
      ) {
        return false;
      }
    }

    const required = item['required'];
    if (
      required !== undefined &&
      (!Array.isArray(required) ||
        !required.every((entry) => typeof entry === 'string') ||
        new Set(required).size !== required.length)
    ) {
      return false;
    }
    const enumValues = item['enum'];
    if (
      enumValues !== undefined &&
      (!Array.isArray(enumValues) ||
        enumValues.length === 0 ||
        !hasUniqueValues(enumValues))
    ) {
      return false;
    }

    for (const key of ['properties', 'patternProperties', 'definitions']) {
      const map = item[key];
      if (map === undefined) continue;
      if (!map || Array.isArray(map) || typeof map !== 'object') return false;
      if (
        key === 'patternProperties' &&
        !Object.keys(map).every(isValidRegex)
      ) {
        return false;
      }
      for (const schema of Object.values(map)) {
        if (!visitSchema(schema)) return false;
      }
    }

    for (const key of [
      'additionalProperties',
      'additionalItems',
      'contains',
      'propertyNames',
      'not',
      'if',
      'then',
      'else',
    ]) {
      const schema = item[key];
      if (schema !== undefined && !visitSchema(schema)) return false;
    }

    const items = item['items'];
    if (items !== undefined) {
      const schemas = Array.isArray(items) ? items : [items];
      if (schemas.length === 0 || !schemas.every(visitSchema)) return false;
    }

    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      const schemas = item[key];
      if (schemas === undefined) continue;
      if (
        !Array.isArray(schemas) ||
        schemas.length === 0 ||
        !schemas.every(visitSchema)
      ) {
        return false;
      }
    }

    const dependencies = item['dependencies'];
    if (dependencies !== undefined) {
      if (
        !dependencies ||
        Array.isArray(dependencies) ||
        typeof dependencies !== 'object'
      ) {
        return false;
      }
      for (const dependency of Object.values(dependencies)) {
        if (Array.isArray(dependency)) {
          if (
            !dependency.every((entry) => typeof entry === 'string') ||
            new Set(dependency).size !== dependency.length
          ) {
            return false;
          }
        } else if (!visitSchema(dependency)) {
          return false;
        }
      }
    }
    return true;
  }
  return visitSchema(converted) ? converted : undefined;
}

function definition(
  type: unknown,
  name: unknown,
  description: unknown,
  parameters: unknown,
): JsonObject | undefined {
  if (typeof type !== 'string' || !type || typeof name !== 'string' || !name) {
    return undefined;
  }
  return {
    type,
    name,
    ...(typeof description === 'string' ? { description } : {}),
    ...(parameters !== undefined
      ? { parameters: normalizeSchema(parameters) }
      : {}),
  };
}

function compactUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as JsonObject;
}

function openAiTools(value: unknown): JsonObject[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: JsonObject[] = [];
  for (const item of value) {
    const tool = record(item);
    if (!tool) return undefined;
    const type = string(tool['type']);
    const fn = record(tool['function']);
    const entry =
      type === 'function' && fn
        ? definition(
            'function',
            fn['name'],
            fn['description'],
            fn['parameters'],
          )
        : definition(type, tool['name'], undefined, undefined);
    if (!entry) return undefined;
    result.push(compactUndefined(entry));
  }
  return result;
}

function anthropicTools(value: unknown): JsonObject[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: JsonObject[] = [];
  for (const item of value) {
    const tool = record(item);
    const entry = tool
      ? definition(
          'function',
          tool['name'],
          tool['description'],
          tool['input_schema'],
        )
      : undefined;
    if (!entry) return undefined;
    result.push(compactUndefined(entry));
  }
  return result;
}

function geminiTools(value: unknown): JsonObject[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: JsonObject[] = [];
  for (const wrapper of value) {
    const declarations = record(wrapper)?.['functionDeclarations'];
    if (!Array.isArray(declarations)) return undefined;
    for (const item of declarations) {
      const tool = record(item);
      const hasParameters = tool ? Object.hasOwn(tool, 'parameters') : false;
      const hasJsonSchema = tool
        ? Object.hasOwn(tool, 'parametersJsonSchema')
        : false;
      const parameters =
        hasParameters && hasJsonSchema
          ? undefined
          : hasJsonSchema
            ? tool?.['parametersJsonSchema']
            : tool?.['parameters'];
      const entry = tool
        ? definition('function', tool['name'], tool['description'], parameters)
        : undefined;
      if (!entry) return undefined;
      result.push(compactUndefined(entry));
    }
  }
  return result;
}

export function extractOpenAiContent(request: object): GenAiContentAttributes {
  const value = request as Record<string, unknown>;
  return {
    inputMessages: Object.hasOwn(value, 'messages')
      ? messages(value['messages'], openAiPart, (role) =>
          role === 'function' ? 'tool' : role,
        )
      : undefined,
    toolDefinitions: Object.hasOwn(value, 'tools')
      ? openAiTools(value['tools'])
      : undefined,
  };
}

export function extractAnthropicContent(
  request: object,
): GenAiContentAttributes {
  const value = request as Record<string, unknown>;
  return {
    inputMessages: Object.hasOwn(value, 'messages')
      ? messages(value['messages'], anthropicPart, (role) => role)
      : undefined,
    systemInstructions: Object.hasOwn(value, 'system')
      ? systemParts(value['system'], anthropicPart)
      : undefined,
    toolDefinitions: Object.hasOwn(value, 'tools')
      ? anthropicTools(value['tools'])
      : undefined,
  };
}

export function extractGeminiContent(request: object): GenAiContentAttributes {
  const value = request as Record<string, unknown>;
  const config = record(value['config']);
  return {
    inputMessages: Object.hasOwn(value, 'contents')
      ? messages(value['contents'], geminiPart, (role) =>
          role === 'model' ? 'assistant' : role,
        )
      : undefined,
    systemInstructions:
      config && Object.hasOwn(config, 'systemInstruction')
        ? systemParts(config['systemInstruction'], geminiPart)
        : undefined,
    toolDefinitions:
      config && Object.hasOwn(config, 'tools')
        ? geminiTools(config['tools'])
        : undefined,
  };
}

export function stringifyGenAiJson(
  value: unknown,
  maxLength: number,
  requireObject = false,
): string | undefined {
  const converted = jsonValue(value);
  if (
    converted === undefined ||
    (requireObject &&
      (converted === null ||
        Array.isArray(converted) ||
        typeof converted !== 'object'))
  ) {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(converted);
    return serialized.length <= maxLength ? serialized : undefined;
  } catch {
    return undefined;
  }
}

export class GenAiOutputAccumulator {
  private candidates = new Map<number, StreamCandidate>();
  private overflow = false;
  private observedResponse = false;
  private explicitEmpty = false;
  private estimatedLength = 2;

  constructor(
    private readonly enabled: boolean,
    private readonly maxLength: number,
  ) {}

  get finishReasons(): string[] | undefined {
    const values = [...this.candidates.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, candidate]) => candidate.finishReason)
      .filter((value): value is string => value !== undefined);
    return values.length > 0 ? values : undefined;
  }

  recordOpenAiResponse(response: object): void {
    const choices = (response as Record<string, unknown>)['choices'];
    if (!Array.isArray(choices)) return;
    this.observedResponse = true;
    this.explicitEmpty = choices.length === 0;
    for (const [position, rawChoice] of choices.entries()) {
      const choice = record(rawChoice);
      if (!choice) {
        if (this.enabled) this.markOverflow();
        continue;
      }
      const index =
        typeof choice['index'] === 'number' &&
        Number.isSafeInteger(choice['index'])
          ? choice['index']
          : position;
      const candidate = this.candidate(index);
      const message = record(choice['message']);
      if (message && this.enabled) {
        const converted = messages([message], openAiPart, () => 'assistant');
        if (converted?.[0]) this.setComplete(index, converted[0]);
        else this.markOverflow();
      } else if (this.enabled) {
        this.markOverflow();
      }
      const finishReason = string(choice['finish_reason']);
      if (finishReason) candidate.finishReason = finishReason;
    }
  }

  recordOpenAiChunk(chunk: object): void {
    const choices = (chunk as Record<string, unknown>)['choices'];
    if (!Array.isArray(choices)) return;
    this.observedResponse = true;
    if (choices.length === 0 && this.candidates.size === 0) {
      this.explicitEmpty = true;
    }
    for (const [position, rawChoice] of choices.entries()) {
      const choice = record(rawChoice);
      if (!choice) {
        if (this.enabled) this.markOverflow();
        continue;
      }
      const index =
        typeof choice['index'] === 'number' &&
        Number.isSafeInteger(choice['index'])
          ? choice['index']
          : position;
      const candidate = this.candidate(index);
      const delta = record(choice['delta']);
      const reasoning =
        string(delta?.['reasoning_content']) ??
        string(delta?.['reasoning']) ??
        string(delta?.['thinking']);
      if (reasoning !== undefined) {
        this.append(candidate, 'reasoning', 'reasoning', reasoning);
      }
      const content = string(delta?.['content']);
      if (content !== undefined) {
        this.append(candidate, 'text', 'text', content);
      }
      const refusal = string(delta?.['refusal']);
      if (refusal !== undefined) {
        this.append(candidate, 'refusal', 'refusal', refusal);
      }
      const audio = record(delta?.['audio']);
      if (audio) {
        const converted = record(jsonValue(audio));
        if (converted) {
          this.setValue(candidate, 'audio', {
            ...converted,
            type: 'audio',
          });
        } else {
          this.markOverflow();
        }
      }
      const toolCalls = delta?.['tool_calls'];
      if (Array.isArray(toolCalls)) {
        for (const [toolPosition, rawToolCall] of toolCalls.entries()) {
          const toolCall = record(rawToolCall);
          if (!toolCall) {
            this.markOverflow();
            continue;
          }
          const toolIndex =
            typeof toolCall['index'] === 'number' &&
            Number.isSafeInteger(toolCall['index'])
              ? toolCall['index']
              : toolPosition;
          const key = `tool:${toolIndex}`;
          const fn = record(toolCall['function']);
          const existing = candidate.parts.get(key);
          const part = existing ?? {
            type: 'tool_call' as const,
          };
          if (
            !existing &&
            !this.reserve(JSON.stringify({ type: 'tool_call' }).length)
          ) {
            continue;
          }
          const id = string(toolCall['id']);
          if (
            id !== undefined &&
            id !== part.id &&
            !this.reserve(id.length - (part.id?.length ?? 0))
          ) {
            continue;
          }
          const name = string(fn?.['name']);
          if (
            name !== undefined &&
            name !== part.name &&
            !this.reserve(name.length - (part.name?.length ?? 0))
          ) {
            continue;
          }
          part.id = id ?? part.id;
          part.name = name ?? part.name;
          const argumentsFragment = string(fn?.['arguments']);
          if (argumentsFragment !== undefined) {
            const next = (part.arguments ?? '') + argumentsFragment;
            if (!this.reserve(argumentsFragment.length)) continue;
            part.arguments = next;
          }
          candidate.parts.set(key, part);
        }
      }
      const finishReason = string(choice['finish_reason']);
      if (finishReason) candidate.finishReason = finishReason;
    }
  }

  recordAnthropicResponse(response: object): void {
    this.observedResponse = true;
    const value = response as Record<string, unknown>;
    const candidate = this.candidate(0);
    const content = value['content'];
    if (Array.isArray(content) && this.enabled) {
      const parts: CanonicalPart[] = [];
      for (const item of content) {
        const converted = anthropicPart(item);
        if (!converted || converted.role) {
          this.markOverflow();
          break;
        }
        parts.push(converted.part);
      }
      if (!this.overflow) {
        this.setComplete(0, { role: 'assistant', parts });
      }
    } else if (this.enabled) {
      this.markOverflow();
    }
    const finishReason = string(value['stop_reason']);
    if (finishReason) candidate.finishReason = finishReason;
  }

  recordAnthropicEvent(event: object): void {
    const value = event as Record<string, unknown>;
    const type = string(value['type']);
    if (
      type !== 'message_start' &&
      type !== 'content_block_start' &&
      type !== 'content_block_delta' &&
      type !== 'message_delta'
    ) {
      return;
    }
    this.observedResponse = true;
    const index =
      typeof value['index'] === 'number' && Number.isSafeInteger(value['index'])
        ? value['index']
        : 0;
    const candidate = this.candidate(0);
    if (type === 'content_block_start') {
      const block = record(value['content_block']);
      const blockType = string(block?.['type']);
      if (blockType === 'text') {
        this.append(
          candidate,
          `block:${index}`,
          'text',
          string(block?.['text']),
        );
      } else if (blockType === 'thinking') {
        this.append(
          candidate,
          `block:${index}`,
          'reasoning',
          string(block?.['thinking']) ?? string(block?.['data']),
        );
      } else if (blockType === 'redacted_thinking' && block) {
        const converted = anthropicPart(block);
        if (converted && !converted.role) {
          this.setValue(candidate, `block:${index}`, converted.part);
        } else {
          this.markOverflow();
        }
      } else if (blockType === 'tool_use') {
        if (!this.reserve(JSON.stringify({ type: 'tool_call' }).length)) return;
        const id = string(block?.['id']);
        const name = string(block?.['name']);
        if (!this.reserve((id?.length ?? 0) + (name?.length ?? 0))) return;
        const hasInput = block ? Object.hasOwn(block, 'input') : false;
        const input = hasInput ? jsonValue(block?.['input']) : undefined;
        if (hasInput && input === undefined) {
          this.markOverflow();
          return;
        }
        const initialArguments =
          input === undefined ? undefined : JSON.stringify(input);
        if (
          initialArguments !== undefined &&
          !this.reserve(initialArguments.length)
        ) {
          return;
        }
        candidate.parts.set(`block:${index}`, {
          type: 'tool_call',
          id,
          name,
          arguments: initialArguments,
          argumentsFromStart: initialArguments !== undefined,
        });
      } else if (blockType && block) {
        const converted = anthropicPart(block);
        if (converted && !converted.role) {
          this.setValue(candidate, `block:${index}`, converted.part);
        } else {
          this.markOverflow();
        }
      }
    } else if (type === 'content_block_delta') {
      const delta = record(value['delta']);
      const deltaType = string(delta?.['type']);
      if (deltaType === 'text_delta') {
        this.append(
          candidate,
          `block:${index}`,
          'text',
          string(delta?.['text']),
        );
      } else if (
        deltaType === 'thinking_delta' ||
        deltaType === 'signature_delta'
      ) {
        if (deltaType === 'thinking_delta') {
          this.append(
            candidate,
            `block:${index}`,
            'reasoning',
            string(delta?.['thinking']),
          );
        }
      } else if (deltaType === 'input_json_delta') {
        const part = candidate.parts.get(`block:${index}`);
        const fragment = string(delta?.['partial_json']);
        if (part?.type === 'tool_call' && fragment !== undefined) {
          const replacedLength = part.argumentsFromStart
            ? (part.arguments?.length ?? 0)
            : 0;
          if (this.reserve(fragment.length - replacedLength)) {
            if (part.argumentsFromStart) {
              part.arguments = '';
              part.argumentsFromStart = false;
            }
            part.arguments = (part.arguments ?? '') + fragment;
          }
        }
      }
    } else if (type === 'message_delta') {
      const delta = record(value['delta']);
      const finishReason = string(delta?.['stop_reason']);
      if (finishReason) candidate.finishReason = finishReason;
    }
  }

  recordGeminiResponse(response: object): void {
    const candidates = (response as Record<string, unknown>)['candidates'];
    if (!Array.isArray(candidates)) return;
    this.observedResponse = true;
    this.explicitEmpty = candidates.length === 0;
    for (const [position, rawCandidate] of candidates.entries()) {
      const candidate = record(rawCandidate);
      if (!candidate) {
        if (this.enabled) this.markOverflow();
        continue;
      }
      const index =
        typeof candidate['index'] === 'number' &&
        Number.isSafeInteger(candidate['index'])
          ? candidate['index']
          : position;
      const outputCandidate = this.candidate(index);
      const content = record(candidate['content']);
      if (content && this.enabled) {
        const converted = messages([content], geminiPart, (role) =>
          role === 'model' ? 'assistant' : role,
        );
        if (converted?.[0]) this.setComplete(index, converted[0]);
        else this.markOverflow();
      } else if (this.enabled) {
        this.setComplete(index, { role: 'assistant', parts: [] });
      }
      const finishReason = string(candidate['finishReason']);
      if (finishReason) outputCandidate.finishReason = finishReason;
    }
  }

  recordGeminiChunk(chunk: object): void {
    const candidates = (chunk as Record<string, unknown>)['candidates'];
    if (!Array.isArray(candidates)) return;
    this.observedResponse = true;
    if (candidates.length === 0 && this.candidates.size === 0) {
      this.explicitEmpty = true;
    }
    for (const [position, rawCandidate] of candidates.entries()) {
      const value = record(rawCandidate);
      if (!value) {
        if (this.enabled) this.markOverflow();
        continue;
      }
      const index =
        typeof value['index'] === 'number' &&
        Number.isSafeInteger(value['index'])
          ? value['index']
          : position;
      const candidate = this.candidate(index);
      const content = record(value['content']);
      const role = string(content?.['role']);
      if (role) candidate.role = role === 'model' ? 'assistant' : role;
      const parts = content?.['parts'];
      if (Array.isArray(parts) && this.enabled && !this.overflow) {
        for (const [partIndex, rawPart] of parts.entries()) {
          const converted = geminiPart(rawPart);
          if (!converted || converted.role) {
            this.markOverflow();
            break;
          }
          const part = converted.part;
          const type = string(part['type']);
          const key = `part:${partIndex}:${type ?? 'unknown'}`;
          if (type === 'text' || type === 'reasoning') {
            this.append(candidate, key, type, string(part['content']) ?? '');
          } else {
            this.setValue(candidate, key, part);
          }
        }
      }
      const finishReason = string(value['finishReason']);
      if (finishReason) candidate.finishReason = finishReason;
    }
  }

  finalize(success: boolean): string | undefined {
    if (!success) {
      for (const candidate of this.candidates.values()) {
        candidate.finishReason ??= 'error';
      }
    }
    if (!this.enabled || this.overflow || !this.observedResponse) {
      return undefined;
    }
    if (this.explicitEmpty && this.candidates.size === 0) {
      return stringifyGenAiJson([], this.maxLength);
    }
    const output: JsonObject[] = [];
    for (const [, candidate] of [...this.candidates.entries()].sort(
      ([left], [right]) => left - right,
    )) {
      const finishReason = candidate.finishReason;
      if (!finishReason) return undefined;
      const parts: CanonicalPart[] = [];
      for (const part of candidate.parts.values()) {
        if (part.value) {
          parts.push(part.value);
          continue;
        }
        if (part.type === 'tool_call') {
          if (!part.name) return undefined;
          const argumentsValue =
            part.arguments === undefined
              ? undefined
              : parseArguments(part.arguments);
          parts.push({
            type: 'tool_call',
            ...(part.id ? { id: part.id } : {}),
            name: part.name,
            ...(argumentsValue !== undefined
              ? { arguments: argumentsValue }
              : {}),
          });
        } else {
          parts.push({
            type: part.type,
            content: part.content ?? '',
          });
        }
      }
      output.push({
        role: candidate.role,
        parts,
        finish_reason: finishReason,
      });
    }
    return stringifyGenAiJson(output, this.maxLength);
  }

  discardContent(): void {
    this.markOverflow();
  }

  private candidate(index: number): StreamCandidate {
    let candidate = this.candidates.get(index);
    if (!candidate) {
      candidate = { role: 'assistant', parts: new Map() };
      this.candidates.set(index, candidate);
    }
    return candidate;
  }

  private setComplete(index: number, message: JsonObject): void {
    const candidate = this.candidate(index);
    candidate.role = string(message['role']) ?? 'assistant';
    candidate.parts.clear();
    const parts = message['parts'];
    if (!Array.isArray(parts)) {
      this.markOverflow();
      return;
    }
    for (const [partIndex, value] of parts.entries()) {
      const part = record(value);
      const type = string(part?.['type']);
      if (!part || !type) {
        this.markOverflow();
        return;
      }
      if (type === 'text' || type === 'reasoning') {
        candidate.parts.set(`part:${partIndex}`, {
          type,
          content: string(part['content']) ?? '',
        });
      } else if (type === 'tool_call') {
        candidate.parts.set(`part:${partIndex}`, {
          type: 'tool_call',
          id: string(part['id']),
          name: string(part['name']),
          arguments:
            part['arguments'] === undefined
              ? undefined
              : JSON.stringify(part['arguments']),
        });
      } else {
        candidate.parts.set(`part:${partIndex}`, {
          type,
          value: part as CanonicalPart,
        });
      }
    }
    const serialized = stringifyGenAiJson(message, this.maxLength);
    if (serialized === undefined) this.markOverflow();
  }

  private append(
    candidate: StreamCandidate,
    key: string,
    type: 'text' | 'reasoning' | 'refusal',
    fragment: string | undefined,
  ): void {
    if (fragment === undefined || !this.enabled || this.overflow) return;
    const part = candidate.parts.get(key);
    if (part && part.type !== type) {
      this.markOverflow();
      return;
    }
    const newPartLength = part
      ? 0
      : JSON.stringify({ type, content: '' }).length;
    if (!this.reserve(fragment.length + newPartLength)) return;
    if (part) {
      part.content = (part.content ?? '') + fragment;
    } else {
      candidate.parts.set(key, { type, content: fragment });
    }
  }

  private setValue(
    candidate: StreamCandidate,
    key: string,
    value: CanonicalPart,
  ): void {
    const previous = candidate.parts.get(key)?.value;
    const previousLength = previous ? JSON.stringify(previous).length : 0;
    if (this.reserve(JSON.stringify(value).length - previousLength)) {
      candidate.parts.set(key, { type: value.type, value });
    }
  }

  private reserve(length: number): boolean {
    if (!this.enabled || this.overflow) return false;
    this.estimatedLength += length;
    if (this.estimatedLength <= this.maxLength) return true;
    this.markOverflow();
    return false;
  }

  private markOverflow(): void {
    this.overflow = true;
    for (const candidate of this.candidates.values()) candidate.parts.clear();
  }
}
