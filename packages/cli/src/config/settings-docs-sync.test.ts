/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getSettingsSchema } from './settingsSchema.js';

type SchemaType = 'boolean' | 'string' | 'number' | 'array' | 'object';

interface SchemaNode {
  type?: string;
  default?: unknown;
  enum?: readonly unknown[];
  properties?: Record<string, SchemaNode>;
  anyOf?: readonly SchemaNode[];
  oneOf?: readonly SchemaNode[];
  jsonSchemaOverride?: SchemaNode;
}

interface DocumentedSetting {
  key: string;
  line: number;
  type: string;
  default: string;
}

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

function splitMarkdownRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cell = '';
  let escaped = false;

  for (const char of body) {
    if (escaped) {
      cell += char;
      escaped = false;
    } else if (char === '\\') {
      cell += char;
      escaped = true;
    } else if (char === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());

  return cells.map((value) => value.replace(/\\\|/g, '|'));
}

function flattenSchema(
  schema: Record<string, SchemaNode>,
  prefix = '',
  result = new Map<string, SchemaNode>(),
): Map<string, SchemaNode> {
  for (const [key, value] of Object.entries(schema)) {
    const node = value as SchemaNode;
    const path = prefix ? `${prefix}.${key}` : key;
    result.set(path, node);

    const nestedProperties =
      node.properties ?? node.jsonSchemaOverride?.properties;
    if (nestedProperties) {
      flattenSchema(nestedProperties, path, result);
    }
  }
  return result;
}

function schemaTypes(node: SchemaNode): Set<SchemaType> {
  const overrideTypes = node.jsonSchemaOverride
    ? schemaTypes(node.jsonSchemaOverride)
    : new Set<SchemaType>();
  if (overrideTypes.size > 0) {
    return overrideTypes;
  }

  for (const union of [node.anyOf, node.oneOf]) {
    if (union) {
      return new Set(union.flatMap((member) => [...schemaTypes(member)]));
    }
  }

  if (node.enum) {
    return node.enum.every((value) => typeof value === 'string')
      ? new Set<SchemaType>(['string'])
      : new Set<SchemaType>();
  }

  switch (node.type) {
    case 'boolean':
    case 'string':
    case 'number':
    case 'object':
      return new Set([node.type]);
    case 'integer':
      return new Set(['number']);
    case 'array':
      return new Set(['array']);
    case 'enum':
      return new Set(['string']);
    default:
      return new Set();
  }
}

function documentedTypes(value: string): Set<SchemaType> {
  const normalized = value
    .replace(/`/g, '')
    .replace(/\\\|/g, '|')
    .toLowerCase();
  const types = new Set<SchemaType>();

  for (const part of normalized.split(/\s*\|\s*|\s+or\s+/)) {
    if (/\bboolean\b/.test(part)) {
      types.add('boolean');
    }
    if (/(array of strings|string\[\]|array)/.test(part)) {
      types.add('array');
    } else if (/\b(string|enum)\b/.test(part)) {
      types.add('string');
    }
    if (/\bobject\b/.test(part)) {
      types.add('object');
    }
    if (/\b(integer|number)\b/.test(part)) {
      types.add('number');
    }
  }

  return types;
}

function booleanDefault(value: string): boolean | undefined | null {
  const normalized = value.replace(/`/g, '').trim();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  if (normalized === 'undefined') return undefined;
  return null;
}

function documentedSettings(): Map<string, DocumentedSetting> {
  const markdown = readFileSync(
    join(repoRoot, 'docs', 'users', 'configuration', 'settings.md'),
    'utf8',
  );
  const sectionStart = markdown.indexOf('### Available settings');
  const sectionEnd = markdown.indexOf(
    '### Example `settings.json`',
    sectionStart,
  );
  if (sectionStart < 0 || sectionEnd < 0) {
    throw new Error('Could not locate the settings reference tables');
  }

  const schema = flattenSchema(
    getSettingsSchema() as unknown as Record<string, SchemaNode>,
  );
  const result = new Map<string, DocumentedSetting>();
  const section = markdown.slice(sectionStart, sectionEnd);
  let inSettingsTable = false;

  section.split('\n').forEach((line, index) => {
    if (!line.startsWith('|')) {
      inSettingsTable = false;
      return;
    }
    const cells = splitMarkdownRow(line);
    if (/^(Setting|Property)$/.test(cells[0] ?? '') && cells[1] === 'Type') {
      inSettingsTable = true;
      return;
    }
    if (!inSettingsTable) return;

    const keyMatch = /^`([^`]+)`$/.exec(cells[0] ?? '');
    const key = keyMatch?.[1];
    if (!key || !schema.has(key)) return;

    result.set(key, {
      key,
      line: markdown.slice(0, sectionStart).split('\n').length + index,
      type: cells[1] ?? '',
      default: cells[3] ?? '',
    });
  });

  return result;
}

describe('settings reference schema sync', () => {
  it('keeps documented types and boolean defaults aligned', () => {
    const schema = flattenSchema(
      getSettingsSchema() as unknown as Record<string, SchemaNode>,
    );
    const documented = documentedSettings();
    const mismatches: string[] = [];

    for (const [key, row] of documented) {
      const node = schema.get(key);
      if (!node) continue;

      const expectedTypes = schemaTypes(node);
      const actualTypes = documentedTypes(row.type);
      if (
        expectedTypes.size === 0 ||
        actualTypes.size === 0 ||
        [...actualTypes].some((type) => !expectedTypes.has(type)) ||
        [...expectedTypes].some((type) => !actualTypes.has(type))
      ) {
        mismatches.push(
          `${row.line}: ${key} documents ${
            row.type || '(missing type)'
          }; schema has ${[...expectedTypes].join(' or ')}`,
        );
        continue;
      }

      if (expectedTypes.size === 1 && expectedTypes.has('boolean')) {
        const expectedDefault = booleanDefault(row.default);
        if (expectedDefault !== null && node.default !== expectedDefault) {
          mismatches.push(
            `${row.line}: ${key} documents default ${
              row.default || '(missing)'
            }; schema default is ${String(node.default)}`,
          );
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('keeps general.batchAutoCollect explicitly documented', () => {
    const documented = documentedSettings().get('general.batchAutoCollect');
    const schema = getSettingsSchema().general.properties.batchAutoCollect;

    expect(documented).toMatchObject({
      type: 'boolean',
      default: '`true`',
    });
    expect(schema).toMatchObject({
      type: 'boolean',
      default: true,
    });
  });
});
