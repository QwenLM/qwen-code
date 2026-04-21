/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * YAML Parsing Wrapper
 *
 * Uses Bun.YAML (built-in, zero-cost) when running under Bun,
 * otherwise falls back to the `yaml` npm package.
 * The package is lazy-required inside the non-Bun branch
 * so native Bun builds never load the ~270KB yaml parser.
 */

import { isRunningWithBun } from './bundledMode.js';
// Import base parser for sync fallback in Node.js
import {
  parse as parseBase,
  stringify as stringifyBase,
} from './yaml-parser-base.js';

// Lazy-loaded yaml module for Node.js async fallback
let yamlModule: typeof import('yaml') | null = null;

async function getYamlModule(): Promise<typeof import('yaml')> {
  if (!yamlModule) {
    yamlModule = await import('yaml');
  }
  return yamlModule;
}

/**
 * Parse YAML string to JavaScript object.
 * Optimized for Bun runtime with built-in YAML parser.
 * Note: In Node.js, this returns a Promise due to dynamic import.
 * For sync parsing in Node.js, use parseYamlSync or the base parser.
 */
export async function parseYaml(input: string): Promise<unknown> {
  // Bun 内置 YAML 解析器 - 零成本
  if (isRunningWithBun()) {
    return Bun.YAML.parse(input);
  }

  // Node.js fallback - dynamic import yaml 包
  const yaml = await getYamlModule();
  return yaml.parse(input);
}

/**
 * Parse YAML string synchronously.
 * Falls back to base parser in Node.js (limited features).
 */
export function parseYamlSync(input: string): unknown {
  if (isRunningWithBun()) {
    return Bun.YAML.parse(input);
  }

  // Use base parser for sync operation in Node.js
  return parseBase(input);
}

/**
 * Stringify JavaScript object to YAML.
 * Optimized for Bun runtime with built-in YAML parser.
 * Note: In Node.js, this returns a Promise due to dynamic import.
 */
export async function stringifyYaml(
  input: unknown,
  options?: { lineWidth?: number; minContentWidth?: number },
): Promise<string> {
  if (isRunningWithBun()) {
    return Bun.YAML.stringify(input as Record<string, unknown>);
  }

  const yaml = await getYamlModule();
  return yaml.stringify(input as Record<string, unknown>, options);
}

/**
 * Parse YAML frontmatter from Markdown content.
 * Optimized for Bun runtime.
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatter = parseYamlSync(match[1]) as Record<string, unknown>;
  const body = match[2];

  return { frontmatter, body };
}

/**
 * Create frontmatter string from object and body.
 */
export function createFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const yamlStr = isRunningWithBun()
    ? Bun.YAML.stringify(frontmatter)
    : stringifyBase(frontmatter);
  return `---\n${yamlStr}---\n${body}`;
}

// Export original parse/stringify for backwards compatibility
export { parse, stringify } from './yaml-parser-base.js';
