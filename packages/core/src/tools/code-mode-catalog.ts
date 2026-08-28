/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyDeclarativeTool } from './tools.js';
import type { ToolRegistry } from './tool-registry.js';
import { isCodeModeCallableTool } from './tool-exposure.js';

export interface CodeModeToolCatalogEntry {
  name: string;
  originalName: string;
  description: string;
  deferred: boolean;
  parametersJsonSchema: unknown;
}

export interface CodeModeToolCatalog {
  tools: CodeModeToolCatalogEntry[];
  warnings: string[];
  description: string;
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function normalizeCodeModeToolName(name: string): string {
  let normalized = name.replace(/[^A-Za-z0-9_$]/g, '_');
  if (!/^[A-Za-z_$]/.test(normalized)) normalized = `_${normalized}`;
  return normalized || '_';
}

function schemaType(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return 'unknown';
  const value = schema as Record<string, unknown>;
  if ('const' in value) return JSON.stringify(value['const']);
  if (Array.isArray(value['enum'])) {
    return (
      value['enum'].map((item) => JSON.stringify(item)).join(' | ') || 'never'
    );
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(value[key])) {
      return value[key].map(schemaType).join(' | ') || 'unknown';
    }
  }
  if (Array.isArray(value['allOf'])) {
    return value['allOf'].map(schemaType).join(' & ') || 'unknown';
  }
  if (Array.isArray(value['type'])) {
    return value['type']
      .map((type) => schemaType({ ...value, type }))
      .join(' | ');
  }
  switch (value['type']) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return `Array<${schemaType(value['items'])}>`;
    case 'object': {
      const properties =
        value['properties'] && typeof value['properties'] === 'object'
          ? (value['properties'] as Record<string, unknown>)
          : {};
      const required = new Set(
        Array.isArray(value['required'])
          ? value['required'].filter(
              (item): item is string => typeof item === 'string',
            )
          : [],
      );
      const fields = Object.keys(properties)
        .sort(compareNames)
        .map(
          (name) =>
            `${JSON.stringify(name)}${required.has(name) ? '' : '?'}: ${schemaType(properties[name])};`,
        );
      if (
        value['additionalProperties'] &&
        value['additionalProperties'] !== false
      ) {
        fields.push(
          `[key: string]: ${value['additionalProperties'] === true ? 'unknown' : schemaType(value['additionalProperties'])};`,
        );
      }
      return `{ ${fields.join(' ')} }`;
    }
    default:
      return 'unknown';
  }
}

function toEntry(
  tool: AnyDeclarativeTool,
  registry: ToolRegistry,
): CodeModeToolCatalogEntry {
  return {
    name: normalizeCodeModeToolName(tool.name),
    originalName: tool.name,
    description: tool.description,
    deferred: registry.isDeferredTool(tool.name),
    parametersJsonSchema: tool.schema.parametersJsonSchema ?? {},
  };
}

export function buildCodeModeToolCatalog(
  registry: ToolRegistry,
): CodeModeToolCatalog {
  const warnings: string[] = [];
  const claimed = new Map<string, string>();
  const tools: CodeModeToolCatalogEntry[] = [];
  const candidates = registry
    .getAllTools()
    .filter((tool) => isCodeModeCallableTool(tool.name))
    .sort((a, b) => compareNames(a.name, b.name));

  for (const tool of candidates) {
    const entry = toEntry(tool, registry);
    const owner = claimed.get(entry.name);
    if (owner) {
      warnings.push(
        `Code mode tool name collision: ${JSON.stringify(tool.name)} normalizes to ${JSON.stringify(entry.name)}, already claimed by ${JSON.stringify(owner)}; keeping the first tool.`,
      );
      continue;
    }
    claimed.set(entry.name, tool.name);
    tools.push(entry);
  }

  const declarations = tools
    .filter((tool) => !tool.deferred)
    .map(
      (tool) =>
        `  ${tool.name}(args: ${schemaType(tool.parametersJsonSchema)}): Promise<unknown>;`,
    )
    .join('\n');
  const allTools = JSON.stringify(
    tools.map(({ name, description }) => ({ name, description })),
    null,
    2,
  );
  const description = `Execute JavaScript in a fresh isolated runtime.

Call registered tools with await tools.<name>(args). Promise.all is supported. ALL_TOOLS is a frozen list of every callable tool, including deferred tools whose full input declaration may be omitted below. Use text(value) to append output and exit(value) to stop successfully. The runtime has no Node.js, require, process, filesystem, network, import, console, WebAssembly, Atomics, or shared memory. Unawaited work is discarded when the script finishes.

Available helpers:
  text(value: unknown): void;
  exit(value?: unknown): never;

Callable tool inputs:
interface CodeModeTools {
${declarations}
}

ALL_TOOLS = ${allTools}`;

  return { tools, warnings, description };
}
