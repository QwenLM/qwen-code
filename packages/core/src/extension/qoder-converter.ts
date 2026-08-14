/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MCPServerConfig } from '../config/config.js';
import type { ExtensionConfig } from './extensionManager.js';
import {
  buildQwenExtensionFromPlugin,
  normalizeMcpServers,
  type ClaudePluginConfig,
} from './claude-converter.js';
import { EXTENSIONS_CONFIG_FILENAME } from './variables.js';
import {
  readExtensionManifest,
  readExtraJsonFile,
  resolvePluginRelativeFile,
} from './path-confinement.js';
import { stripAnsiAndControl } from '../utils/textUtils.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('QODER_CONVERTER');

export const QODER_PLUGIN_MANIFEST = '.qoder-plugin/plugin.json';

type QoderPluginConfig = Omit<ClaudePluginConfig, 'version'> & {
  version?: string;
  displayName?: string;
  contextFileName?: string | string[];
};

function loadQoderConfig(extensionDir: string): QoderPluginConfig {
  // readExtensionManifest throws on a symlink escape, unparseable body, or
  // non-object body; returns null when absent.
  const manifest = readExtensionManifest(extensionDir, QODER_PLUGIN_MANIFEST);
  if (!manifest) {
    throw new Error(
      `Qoder plugin configuration not found at ${path.join(extensionDir, QODER_PLUGIN_MANIFEST)}`,
    );
  }

  const config = manifest as QoderPluginConfig;
  if (typeof config.name !== 'string' || config.name.length === 0) {
    throw new Error('Qoder plugin config must have name field');
  }
  return {
    ...config,
    version:
      typeof config.version === 'string' && config.version.length > 0
        ? config.version
        : '1.0.0',
    displayName:
      typeof config.displayName === 'string' ? config.displayName : undefined,
    description:
      typeof config.description === 'string' ? config.description : undefined,
  };
}

function loadMcpServersFile(
  extensionDir: string,
  relativePath: string,
  requireWrapper: boolean,
): Record<string, MCPServerConfig> | undefined {
  // requireWrapper=false → author's explicit reference; a defective file
  // throws a precise error rather than silently installing zero servers.
  // requireWrapper=true → auto-detected `.mcp.json` fallback; tolerated.
  const parsed = readExtraJsonFile(extensionDir, relativePath);
  if (!parsed) {
    if (!requireWrapper) {
      const safePath = stripAnsiAndControl(relativePath);
      throw new Error(
        `Invalid Qoder MCP configuration at ${safePath}: file could not be read`,
      );
    }
    return undefined;
  }
  const safeMcpPath = stripAnsiAndControl(relativePath);

  const hasWrapper = Object.prototype.hasOwnProperty.call(parsed, 'mcpServers');
  const servers = hasWrapper
    ? parsed['mcpServers']
    : requireWrapper
      ? undefined
      : parsed;
  if (
    typeof servers !== 'object' ||
    servers === null ||
    Array.isArray(servers)
  ) {
    debugLogger.warn(
      `Invalid Qoder MCP configuration at ${safeMcpPath}: expected an "mcpServers" object`,
    );
    return undefined;
  }

  return normalizeMcpServers(servers as Record<string, unknown>, safeMcpPath);
}

function resolveMcpServers(
  extensionDir: string,
  configured: QoderPluginConfig['mcpServers'],
): Record<string, MCPServerConfig> | undefined {
  if (typeof configured === 'string') {
    return loadMcpServersFile(extensionDir, configured, false);
  }
  if (configured !== undefined && configured !== null) {
    if (typeof configured !== 'object' || Array.isArray(configured)) {
      throw new Error('Qoder plugin mcpServers must be an object or file path');
    }
    return normalizeMcpServers(
      configured as Record<string, unknown>,
      path.join(extensionDir, QODER_PLUGIN_MANIFEST),
    );
  }
  return loadMcpServersFile(extensionDir, '.mcp.json', true);
}

function resolveContextFiles(
  extensionDir: string,
  configured: string | string[] | undefined,
): string[] | undefined {
  const configuredFiles = configured
    ? Array.isArray(configured)
      ? configured
      : [configured]
    : [];
  const contextFiles: string[] = [];
  const seen = new Set<string>();
  const addContextFile = (relativePath: string, prepend = false): void => {
    const resolved = resolvePluginRelativeFile(extensionDir, relativePath);
    if (!resolved) return;
    try {
      if (!fs.statSync(resolved).isFile()) return;
    } catch {
      return;
    }
    const normalized = path.relative(path.resolve(extensionDir), resolved);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      if (prepend) contextFiles.unshift(normalized);
      else contextFiles.push(normalized);
    }
  };

  for (const file of configuredFiles) {
    if (typeof file === 'string') addContextFile(file);
  }
  addContextFile('system-prompt.md');
  if (contextFiles.length > 0) {
    addContextFile('QWEN.md', true);
  }
  return contextFiles.length > 0 ? contextFiles : undefined;
}

export async function convertQoderPlugin(
  extensionDir: string,
): Promise<{ config: ExtensionConfig; convertedDir: string }> {
  const config = loadQoderConfig(extensionDir);
  config.mcpServers = resolveMcpServers(extensionDir, config.mcpServers);
  const converted = await buildQwenExtensionFromPlugin(
    extensionDir,
    config as ClaudePluginConfig,
  );
  const contextFileName = resolveContextFiles(
    converted.convertedDir,
    config.contextFileName,
  );
  const qwenConfig: ExtensionConfig = {
    ...converted.config,
    displayName: config.displayName,
    contextFileName,
  };
  try {
    fs.writeFileSync(
      path.join(converted.convertedDir, EXTENSIONS_CONFIG_FILENAME),
      JSON.stringify(qwenConfig, null, 2),
      'utf-8',
    );
  } catch (error) {
    fs.rmSync(converted.convertedDir, { recursive: true, force: true });
    throw error;
  }
  return { ...converted, config: qwenConfig };
}
