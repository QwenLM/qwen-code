/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ManagedMcpRecipe {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
  url?: string;
  httpUrl?: string;
  headers?: Record<string, string>;
  type?: 'stdio' | 'sse' | 'http';
}

export class ManagedMcpRecipeError extends Error {
  constructor() {
    super('Invalid Managed MCP recipe.');
    this.name = 'ManagedMcpRecipeError';
  }
}

const fields = new Set([
  'command',
  'args',
  'env',
  'timeout',
  'url',
  'httpUrl',
  'headers',
  'type',
]);

function text(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0');
}

function strings(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, item]) => text(key) && key.length > 0 && text(item),
    )
  );
}

export function parseManagedMcpRecipe(
  value: unknown,
  options: { allowPlaceholders?: boolean } = {},
): ManagedMcpRecipe {
  const invalid = (): never => {
    throw new ManagedMcpRecipeError();
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const recipe = value as Record<string, unknown>;
  if (
    Object.keys(recipe).some((key) => !fields.has(key)) ||
    (recipe['timeout'] !== undefined &&
      (!Number.isSafeInteger(recipe['timeout']) ||
        Number(recipe['timeout']) < 1 ||
        Number(recipe['timeout']) > 600_000)) ||
    (recipe['type'] !== undefined &&
      !['stdio', 'sse', 'http'].includes(String(recipe['type'])))
  )
    invalid();
  if (recipe['command'] !== undefined) {
    if (
      !text(recipe['command']) ||
      !recipe['command'].trim() ||
      recipe['url'] !== undefined ||
      recipe['httpUrl'] !== undefined ||
      recipe['headers'] !== undefined ||
      (recipe['type'] !== undefined && recipe['type'] !== 'stdio') ||
      (recipe['args'] !== undefined &&
        (!Array.isArray(recipe['args']) || !recipe['args'].every(text))) ||
      (recipe['env'] !== undefined && !strings(recipe['env']))
    )
      invalid();
  } else {
    const url = recipe['httpUrl'] ?? recipe['url'];
    if (
      !text(url) ||
      !url.trim() ||
      (recipe['url'] !== undefined && recipe['httpUrl'] !== undefined) ||
      recipe['args'] !== undefined ||
      recipe['env'] !== undefined ||
      recipe['type'] === 'stdio' ||
      (recipe['headers'] !== undefined && !strings(recipe['headers']))
    )
      invalid();
    if (!(options.allowPlaceholders && /\$\{[^}]+\}/u.test(url as string))) {
      try {
        const parsed = new URL(url as string);
        if (
          !['http:', 'https:'].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          parsed.hash
        )
          invalid();
      } catch {
        invalid();
      }
    }
    if (
      recipe['headers'] !== undefined &&
      Object.entries(recipe['headers'] as Record<string, string>).some(
        ([key, item]) =>
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(key) || /[\r\n]/u.test(item),
      )
    )
      invalid();
  }
  return structuredClone(recipe) as ManagedMcpRecipe;
}
