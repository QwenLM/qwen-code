/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { resolveContainedExistingPath } from './paths.js';

export const AGENT_PLUGIN_MANIFEST = 'plugin.json';
export const AGENT_PLUGIN_SCHEMA =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const AGENT_PLUGIN_SCHEMA_PREFIX = 'https://agent-plugins.org/schemas/';
export const DEFAULT_AGENT_PLUGIN_VERSION = '1.0.0';

const debugLogger = createDebugLogger('AGENT_PLUGINS_V1');
const MANIFEST_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);
const AUTHOR_FIELDS = new Set(['name', 'email', 'url']);

export type AgentPluginSchemaStatus = 'supported' | 'unsupported' | 'unrelated';

export interface AgentPluginExtensionConfig {
  name: string;
  version: string;
  displayName: string;
  description?: string;
}

export function getAgentPluginSchemaStatus(
  pluginRoot: string,
): AgentPluginSchemaStatus {
  const manifestPath = path.join(pluginRoot, AGENT_PLUGIN_MANIFEST);
  let resolvedManifestPath: string;
  try {
    resolvedManifestPath = resolveContainedExistingPath(
      pluginRoot,
      manifestPath,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'unrelated' : 'supported';
  }

  let value: unknown;
  try {
    if (!fs.statSync(resolvedManifestPath).isFile()) return 'unrelated';
    value = JSON.parse(
      fs.readFileSync(resolvedManifestPath, 'utf8'),
    ) as unknown;
  } catch {
    return 'unrelated';
  }
  if (!isRecord(value) || typeof value['$schema'] !== 'string') {
    return 'unrelated';
  }
  if (value['$schema'] === AGENT_PLUGIN_SCHEMA) return 'supported';
  return value['$schema'].startsWith(AGENT_PLUGIN_SCHEMA_PREFIX)
    ? 'unsupported'
    : 'unrelated';
}

export function loadAgentPluginManifest(
  pluginRoot: string,
): AgentPluginExtensionConfig {
  const manifestPath = path.join(pluginRoot, AGENT_PLUGIN_MANIFEST);
  const resolvedManifestPath = resolveContainedExistingPath(
    pluginRoot,
    manifestPath,
  );
  if (!fs.statSync(resolvedManifestPath).isFile()) {
    throw new Error('Agent Plugins root plugin.json must be a regular file.');
  }

  const value = JSON.parse(
    fs.readFileSync(resolvedManifestPath, 'utf8'),
  ) as unknown;
  if (!isRecord(value)) {
    throw new Error('Agent Plugins root plugin.json must contain an object.');
  }

  for (const field of Object.keys(value)) {
    if (!MANIFEST_FIELDS.has(field)) {
      debugLogger.warn(
        `Ignoring unknown Agent Plugins manifest field "${field}".`,
      );
    }
  }

  const schema = value['$schema'];
  if (typeof schema !== 'string') {
    throw new Error('Agent Plugins manifest is missing string "$schema".');
  }
  if (schema !== AGENT_PLUGIN_SCHEMA) {
    throw new Error(
      schema.startsWith(AGENT_PLUGIN_SCHEMA_PREFIX)
        ? `Unsupported Agent Plugins schema "${schema}". Supported schema: "${AGENT_PLUGIN_SCHEMA}".`
        : `Root plugin.json is not an Agent Plugins v1 manifest. Expected "$schema" "${AGENT_PLUGIN_SCHEMA}".`,
    );
  }

  const name = value['name'];
  if (typeof name !== 'string' || !isValidPluginName(name)) {
    throw new Error(
      'Agent Plugins name must be 1-64 lowercase letters, numbers, dots, or hyphens without leading, trailing, or consecutive separators.',
    );
  }

  validateOptionalString(value, 'version');
  validateOptionalString(value, 'description');
  validateOptionalString(value, 'homepage');
  validateOptionalString(value, 'repository');
  validateOptionalString(value, 'license');
  validateAuthor(value['author']);
  validateKeywords(value['keywords']);

  if (value['extensions'] !== undefined && !isRecord(value['extensions'])) {
    debugLogger.warn('Ignoring non-object Agent Plugins extensions field.');
  }

  const version = optionalTrimmedString(value['version']);
  const description = optionalTrimmedString(value['description']);
  return {
    name,
    version: version ?? DEFAULT_AGENT_PLUGIN_VERSION,
    displayName: name,
    ...(description ? { description } : {}),
  };
}

function isValidPluginName(name: string): boolean {
  return (
    name.length <= 64 &&
    /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name)
  );
}

function validateOptionalString(
  value: Record<string, unknown>,
  field: string,
): void {
  if (value[field] !== undefined && typeof value[field] !== 'string') {
    throw new Error(`Agent Plugins manifest "${field}" must be a string.`);
  }
}

function validateAuthor(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new Error('Agent Plugins manifest "author" must be an object.');
  }
  for (const [field, fieldValue] of Object.entries(value)) {
    if (!AUTHOR_FIELDS.has(field)) {
      throw new Error(`Unknown Agent Plugins author field "${field}".`);
    }
    if (typeof fieldValue !== 'string') {
      throw new Error(
        `Agent Plugins author field "${field}" must be a string.`,
      );
    }
  }
}

function validateKeywords(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(
      'Agent Plugins manifest "keywords" must be an array of strings.',
    );
  }
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
