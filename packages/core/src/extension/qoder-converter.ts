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
  assertMcpServersContainer,
  type ClaudePluginConfig,
} from './claude-converter.js';
import { EXTENSIONS_CONFIG_FILENAME } from './variables.js';
import {
  isRegularFile,
  readExtensionManifest,
  readExtraJsonFile,
  resolvePluginRelativeFile,
  type ExtraJsonNullReason,
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

// Maps a readExtraJsonFile rejection to the throw message an author of
// an explicit mcpServers reference will see.
function explicitMcpFailureMessage(
  reason: ExtraJsonNullReason,
  safePath: string,
  cause?: unknown,
): string {
  switch (reason) {
    case 'missing':
      return `Invalid Qoder MCP configuration at ${safePath}: file does not exist`;
    case 'directory':
      return `Invalid Qoder MCP configuration at ${safePath}: path is a directory, not a file`;
    case 'parse-error':
      return `Invalid Qoder MCP configuration at ${safePath}: JSON parse failed (${stripAnsiAndControl(cause instanceof Error ? cause.message : String(cause))})`;
    case 'non-object-body':
      return `Invalid Qoder MCP configuration at ${safePath}: top-level body is not a JSON object`;
    case 'absolute-symlink-escape':
      return `Invalid Qoder MCP configuration at ${safePath}: absolute path resolves through a symlink outside the extension`;
    case 'absolute-outside':
      return `Invalid Qoder MCP configuration at ${safePath}: absolute path is outside the extension directory`;
    case 'confinement-threw':
      return `Invalid Qoder MCP configuration at ${safePath}: ${stripAnsiAndControl(cause instanceof Error ? cause.message : String(cause))}`;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

function loadMcpServersFile(
  extensionDir: string,
  relativePath: string,
  requireWrapper: boolean,
): Record<string, MCPServerConfig> | undefined {
  // requireWrapper=false → author's explicit reference; a defective file
  // throws a precise error naming the actual failure mode.
  // requireWrapper=true → auto-detected `.mcp.json` fallback; tolerated.
  const parsed = readExtraJsonFile(
    extensionDir,
    relativePath,
    false,
    requireWrapper
      ? null
      : (_reason, ctx) => {
          throw new Error(
            explicitMcpFailureMessage(
              _reason,
              ctx.safeFileRef,
              ctx.cause,
            ),
          );
        },
  );
  if (!parsed) {
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
    // Mode-agnostic warn-and-skip: both auto-detected `.mcp.json` and
    // explicit references with a defective wrapper (top-level server
    // map, scalar, array) install with zero servers and surface a
    // debug-only warn. Matches the sibling claude converter's
    // convertClaudePluginStandalone convention.
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
  pluginName: string,
): Record<string, MCPServerConfig> | undefined {
  if (typeof configured === 'string') {
    return loadMcpServersFile(extensionDir, configured, false);
  }
  if (configured !== undefined && configured !== null) {
    return normalizeMcpServers(
      assertMcpServersContainer(
        configured,
        'Invalid MCP configuration: mcpServers must be an object',
        pluginName,
      ) as Record<string, unknown>,
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
    if (!resolved || !isRegularFile(resolved)) return;
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
  config.mcpServers = resolveMcpServers(
    extensionDir,
    config.mcpServers,
    config.name,
  );
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
