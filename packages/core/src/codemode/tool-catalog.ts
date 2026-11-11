/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionDeclaration } from '@google/genai';
import { estimateTextTokens } from '../utils/tokenCalculation.js';
import { truncateString } from '../utils/textUtils.js';
import { isRecord } from '../utils/markdownUtils.js';

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const MAX_DEPTH = 6;
const MAX_DOC_CHARS = 300;


export function propertyKey(key: string): string {
  return IDENTIFIER.test(key) ? key : JSON.stringify(key);
}

/** `tools.Read` for identifiers, `tools["mcp__a__b"]` otherwise. */
export function toolAccessor(name: string): string {
  return IDENTIFIER.test(name)
    ? `tools.${name}`
    : `tools[${JSON.stringify(name)}]`;
}

function docLine(text: unknown): string {
  if (typeof text !== 'string' || !text.trim()) return '';
  return text.replace(/\s+/g, ' ').trim().replace(/\*\//g, '*\\/');
}

function doc(text: unknown, indent: string, note?: string): string {
  const body = [truncateString(docLine(text), MAX_DOC_CHARS, '…'), docLine(note)]
    .filter(Boolean)
    .join(' ');
  return body ? `${indent}/** ${body} */\n` : '';
}

/** Bounded JSON Schema → TypeScript type rendering for model-facing signatures. */
export function schemaToTs(
  schema: unknown,
  options: { docs: boolean; indent?: string; depth?: number },
): string {
  const indent = options.indent ?? '';
  const depth = options.depth ?? 0;
  if (!isRecord(schema) || depth > MAX_DEPTH) return 'unknown';
  const next = (value: unknown, extra = '') =>
    schemaToTs(value, { ...options, indent: indent + extra, depth: depth + 1 });
  if ('const' in schema) return JSON.stringify(schema['const']) ?? 'unknown';
  if (Array.isArray(schema['enum']))
    return (
      schema['enum'].map((item) => JSON.stringify(item)).join(' | ') || 'never'
    );
  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = schema[key];
    if (Array.isArray(variants) && variants.length)
      return [...new Set(variants.map((item) => next(item)))].join(' | ');
  }
  if (Array.isArray(schema['allOf']) && schema['allOf'].length)
    return schema['allOf'].map((item) => next(item)).join(' & ');
  const type = schema['type'];
  if (Array.isArray(type))
    return [
      ...new Set(type.map((item) => next({ ...schema, type: item }))),
    ].join(' | ');
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const item = next(schema['items']);
      return /^[\w"]+$/.test(item) ? `${item}[]` : `Array<${item}>`;
    }
    case 'object':
    case undefined:
      break;
    default:
      return 'unknown';
  }
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const keys = Object.keys(properties);
  const additional = schema['additionalProperties'];
  if (!keys.length) {
    if (type === undefined && !('additionalProperties' in schema))
      return 'unknown';
    return isRecord(additional)
      ? `Record<string, ${next(additional)}>`
      : 'Record<string, unknown>';
  }
  const required = new Set(
    Array.isArray(schema['required']) ? schema['required'] : [],
  );
  const inner = `${indent}  `;
  const lines = keys.map((key) => {
    const value = properties[key];
    const optional = required.has(key) ? '' : '?';
    return `${options.docs && isRecord(value) ? doc(value['description'], inner) : ''}${inner}${propertyKey(key)}${optional}: ${next(value, '  ')};`;
  });
  if (isRecord(additional))
    lines.push(`${inner}[key: string]: ${next(additional, '  ')};`);
  return `{\n${lines.join('\n')}\n${indent}}`;
}

function inputSchema(tool: FunctionDeclaration): unknown {
  return tool.parametersJsonSchema ?? tool.parameters ?? {};
}

/** Input-only signature, shared by the catalog and invalid-argument repair hints. */
export function describeProgrammaticInput(tool: FunctionDeclaration): string {
  return `${toolAccessor(tool.name ?? '')}(args: ${schemaToTs(inputSchema(tool), { docs: false })})`;
}

/** The direct declaration already describes arguments; put the resolved type beside them. */
export function describeProgrammaticResult(
  name: string,
  outputSchema: Record<string, unknown>,
  note?: string,
): string {
  const output = schemaToTs(outputSchema, { docs: false }).replace(
    /\n\s*/g,
    ' ',
  );
  return `CodeMode: ${toolAccessor(name)}(args) resolves to ${output}.${note ? ` ${note}` : ''}`;
}

/** Full description for runtime lookup, using the same schemas as the prompt catalog. */
export function describeProgrammaticTool(
  tool: FunctionDeclaration,
  outputSchema: Record<string, unknown>,
  note?: string,
): string {
  return [
    tool.description,
    `${describeProgrammaticInput(tool)}: Promise<${schemaToTs(outputSchema, { docs: false })}>`,
    note,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * One `declare const tools` member. With `docs`, the tool and property
 * descriptions are inlined because the direct declaration is hidden.
 */
export function describeProgrammaticContract(
  tool: FunctionDeclaration,
  outputSchema: Record<string, unknown>,
  docs: boolean,
  note?: string,
): string {
  const indent = '  ';
  const input = schemaToTs(inputSchema(tool), { docs, indent });
  const output = schemaToTs(outputSchema, { docs: false, indent });
  return `${docs ? doc(tool.description, indent, note) : ''}${indent}${propertyKey(tool.name ?? '')}(args: ${input}): Promise<${output}>;`;
}

/** Whole signatures only: omitted tools remain discoverable at runtime. */
export function renderToolCatalog(members: string[], maxTokens = 4000): string {
  if (!members.length) return 'declare const tools: {};';
  const omitted =
    '\nAdditional tools are available. Use ALL_TOOLS, describeTool(name), or searchTools(query) for their complete signatures.';
  const render = (selected: string[]) =>
    `declare const tools: {\n${selected.join('\n')}\n};`;
  // Token estimates are per character, so each member adds its own cost plus one separator.
  let tokens =
    estimateTextTokens(render([]) + omitted) - estimateTextTokens('\n');
  const selected = members.filter((member) => {
    const cost = estimateTextTokens(`${member}\n`);
    if (tokens + cost > maxTokens) return false;
    tokens += cost;
    return true;
  });
  return render(selected) + (selected.length < members.length ? omitted : '');
}
