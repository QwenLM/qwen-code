/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MCPServerConfig } from '../../config/config.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import {
  isPathWithin,
  resolveContainedExistingPath,
  resolveContainedPotentialPath,
  resolveExistingPathPrefix,
} from './paths.js';

export const AGENT_PLUGIN_MCP_SCHEMA =
  'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

const debugLogger = createDebugLogger('AGENT_PLUGINS_V1');
const CLIENT_OWNED_HEADERS = new Set([
  'accept',
  'authorization',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'host',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
]);

export async function loadAgentPluginMcpServers(
  pluginRoot: string,
  pluginDataRoot: string,
  options: { createDataDir?: boolean } = {},
): Promise<Record<string, MCPServerConfig>> {
  const mcpPath = path.join(pluginRoot, 'mcp.json');
  let contents: string;
  try {
    const resolvedMcpPath = resolveContainedExistingPath(pluginRoot, mcpPath);
    if (!(await fs.promises.stat(resolvedMcpPath)).isFile()) {
      debugLogger.warn(
        'Agent Plugins mcp.json is not a regular file; disabling MCP.',
      );
      return {};
    }
    contents = await fs.promises.readFile(resolvedMcpPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    debugLogger.warn(
      `Disabling Agent Plugins MCP: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }

  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
    validateMcpFile(value);
  } catch (error) {
    debugLogger.warn(
      `Disabling Agent Plugins MCP: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }

  const servers: Record<string, MCPServerConfig> = {};
  for (const [name, entry] of Object.entries(value['mcpServers'])) {
    try {
      Object.defineProperty(servers, name, {
        value: normalizeServer(entry, pluginRoot, pluginDataRoot),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } catch (error) {
      debugLogger.warn(
        `Skipping Agent Plugins MCP server "${name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (
    options.createDataDir &&
    Object.values(servers).some((server) => server.command)
  ) {
    try {
      await fs.promises.mkdir(pluginDataRoot, { recursive: true });
      const resolvedPluginDataRoot = await fs.promises.realpath(pluginDataRoot);
      for (const server of Object.values(servers)) {
        if (
          server.command &&
          server.cwd &&
          isPathWithin(resolvedPluginDataRoot, server.cwd)
        ) {
          await fs.promises.mkdir(server.cwd, { recursive: true });
        }
      }
    } catch (error) {
      debugLogger.warn(
        `Failed to create Agent Plugins data directory; disabling stdio MCP servers: ${error instanceof Error ? error.message : String(error)}`,
      );
      for (const [name, server] of Object.entries(servers)) {
        if (server.command) delete servers[name];
      }
    }
  }
  return servers;
}

export function validateAgentPluginStdioRuntimePaths(
  server: MCPServerConfig,
): void {
  if (!server.agentPluginV1 || !server.command) return;
  const pluginRoot = server.env?.['PLUGIN_ROOT'];
  const pluginDataRoot = server.env?.['PLUGIN_DATA'];
  if (!pluginRoot || !pluginDataRoot) {
    throw new Error('Agent Plugins stdio server is missing runtime roots.');
  }

  if (path.isAbsolute(server.command)) {
    const command = resolveContainedExistingPath(pluginRoot, server.command);
    if (!fs.statSync(command).isFile()) {
      throw new Error('Agent Plugins stdio command must be a regular file.');
    }
  }

  if (server.cwd) {
    let cwd: string;
    try {
      cwd = resolveContainedExistingPath(pluginRoot, server.cwd);
    } catch {
      cwd = resolveContainedExistingPath(pluginDataRoot, server.cwd);
    }
    if (!fs.statSync(cwd).isDirectory()) {
      throw new Error('Agent Plugins stdio cwd must be a directory.');
    }
  }
}

function validateMcpFile(value: unknown): asserts value is Record<
  string,
  unknown
> & {
  mcpServers: Record<string, unknown>;
} {
  if (!isRecord(value)) {
    throw new Error('Agent Plugins mcp.json must contain an object.');
  }
  const unknown = Object.keys(value).filter(
    (field) => field !== '$schema' && field !== 'mcpServers',
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown Agent Plugins MCP field "${unknown[0]}".`);
  }
  if (value['$schema'] !== AGENT_PLUGIN_MCP_SCHEMA) {
    throw new Error(
      `Unsupported Agent Plugins MCP schema "${String(value['$schema'])}".`,
    );
  }
  if (!isRecord(value['mcpServers'])) {
    throw new Error('Agent Plugins mcpServers must be an object.');
  }
}

function normalizeServer(
  value: unknown,
  pluginRoot: string,
  pluginDataRoot: string,
): MCPServerConfig {
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    throw new Error('MCP server must be an object with a string type.');
  }
  switch (value['type']) {
    case 'stdio':
      return normalizeStdioServer(value, pluginRoot, pluginDataRoot);
    case 'streamable-http':
      return normalizeHttpServer(value);
    case 'sse':
      throw new Error('Legacy SSE transport is not supported.');
    default:
      throw new Error(`Unsupported MCP transport "${value['type']}".`);
  }
}

function normalizeStdioServer(
  value: Record<string, unknown>,
  pluginRoot: string,
  pluginDataRoot: string,
): MCPServerConfig {
  assertOnlyFields(value, ['type', 'command', 'args', 'env', 'cwd']);
  const commandValue = value['command'];
  if (typeof commandValue !== 'string' || commandValue.length === 0) {
    throw new Error('Stdio command must be a non-empty string.');
  }

  const args = value['args'] ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('Stdio args must be an array of strings.');
  }
  const configuredEnv = value['env'] ?? {};
  if (
    !isRecord(configuredEnv) ||
    Object.values(configuredEnv).some((entry) => typeof entry !== 'string')
  ) {
    throw new Error('Stdio env values must be strings.');
  }
  for (const key of Object.keys(configuredEnv)) {
    if (reservedEnvironmentName(key)) {
      throw new Error(`Stdio env cannot override reserved variable "${key}".`);
    }
  }
  const cwdValue = value['cwd'] ?? '${PLUGIN_ROOT}';
  if (typeof cwdValue !== 'string') {
    throw new Error('Stdio cwd must be a string.');
  }

  const pluginRootResolved = fs.realpathSync.native(pluginRoot);
  const pluginDataResolved = resolveExistingPathPrefix(pluginDataRoot);
  const rootString = pluginRootResolved;
  const dataString = pluginDataResolved;
  const command = normalizeCommand(commandValue, pluginRootResolved);
  const expandedArgs = args.map((arg) =>
    expandPluginVariables(arg, rootString, dataString),
  );
  const env = Object.fromEntries(
    Object.entries(configuredEnv).map(([key, entry]) => [
      key,
      expandPluginVariables(entry as string, rootString, dataString),
    ]),
  );
  env['PLUGIN_ROOT'] = rootString;
  env['PLUGIN_DATA'] = dataString;

  return {
    command,
    args: expandedArgs,
    env,
    cwd: normalizeCwd(
      cwdValue,
      pluginRootResolved,
      pluginDataResolved,
      rootString,
      dataString,
    ),
    agentPluginV1: true,
  };
}

function normalizeCommand(command: string, pluginRoot: string): string {
  const bare =
    !command.includes('/') &&
    !command.includes('\\') &&
    path.win32.parse(command).root === '';
  if (bare) return command;
  if (!command.startsWith('./') || command.includes('\\')) {
    throw new Error(
      'Stdio command must be a bare executable name or a contained ./ path.',
    );
  }
  return resolveContainedPotentialPath(
    pluginRoot,
    path.resolve(pluginRoot, command.slice(2)),
  );
}

function normalizeCwd(
  cwd: string,
  pluginRoot: string,
  pluginDataRoot: string,
  rootString: string,
  dataString: string,
): string {
  if (cwd.includes('\\')) {
    throw new Error('Stdio cwd must use portable forward-slash paths.');
  }
  let allowedRoot: string;
  if (cwd === './' || cwd.startsWith('./')) {
    allowedRoot = pluginRoot;
  } else if (cwd === '${PLUGIN_ROOT}' || cwd.startsWith('${PLUGIN_ROOT}/')) {
    allowedRoot = pluginRoot;
  } else if (cwd === '${PLUGIN_DATA}' || cwd.startsWith('${PLUGIN_DATA}/')) {
    allowedRoot = pluginDataRoot;
  } else {
    throw new Error(
      'Stdio cwd must be a contained ./, ${PLUGIN_ROOT}, or ${PLUGIN_DATA} path.',
    );
  }

  const expanded = expandPluginVariables(cwd, rootString, dataString);
  const resolvedAllowedRoot = resolveExistingPathPrefix(allowedRoot);
  const resolved = resolveExistingPathPrefix(
    path.isAbsolute(expanded)
      ? expanded
      : path.resolve(resolvedAllowedRoot, expanded),
  );
  if (!isPathWithin(resolvedAllowedRoot, resolved)) {
    throw new Error('Expanded stdio cwd escapes its allowed root.');
  }
  return resolved;
}

function normalizeHttpServer(value: Record<string, unknown>): MCPServerConfig {
  assertOnlyFields(value, ['type', 'url', 'headers']);
  const rawUrl = value['url'];
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    throw new Error('Streamable HTTP url must be a non-empty string.');
  }
  validateHttpUrl(rawUrl);

  const rawHeaders = value['headers'];
  if (rawHeaders !== undefined && !isRecord(rawHeaders)) {
    throw new Error('Streamable HTTP headers must be an object.');
  }
  const headers = rawHeaders ? normalizeHeaders(rawHeaders) : undefined;
  return {
    httpUrl: rawUrl,
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    agentPluginV1: true,
  };
}

function validateHttpUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new Error(
      `Invalid Streamable HTTP url: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.hostname
  ) {
    throw new Error('Streamable HTTP url must be absolute HTTP or HTTPS.');
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error(
      'Streamable HTTP url must not contain user information or a fragment.',
    );
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    throw new Error('Non-loopback Streamable HTTP endpoints must use HTTPS.');
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;
  const ipv4 = normalized.split('.').map(Number);
  return (
    ipv4.length === 4 &&
    ipv4.every(
      (part, index) =>
        Number.isInteger(part) &&
        part >= 0 &&
        part <= 255 &&
        (index !== 0 || part === 127),
    )
  );
}

function normalizeHeaders(
  value: Record<string, unknown>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== 'string') {
      throw new Error(`HTTP header "${name}" must have a string value.`);
    }
    const lowercaseName = name.toLowerCase();
    if (seen.has(lowercaseName)) {
      throw new Error(`Duplicate case-insensitive HTTP header "${name}".`);
    }
    seen.add(lowercaseName);
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      throw new Error(`Invalid HTTP header name "${name}".`);
    }
    for (const character of rawValue) {
      const code = character.charCodeAt(0);
      if (code <= 8 || (code >= 10 && code <= 31) || code === 127) {
        throw new Error(`Invalid HTTP header value for "${name}".`);
      }
    }
    if (!CLIENT_OWNED_HEADERS.has(lowercaseName)) {
      Object.defineProperty(normalized, name, {
        value: rawValue,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return normalized;
}

function assertOnlyFields(
  value: Record<string, unknown>,
  fields: string[],
): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) throw new Error(`Unknown MCP server field "${unknown}".`);
}

function reservedEnvironmentName(name: string): boolean {
  return process.platform === 'win32'
    ? name.toUpperCase() === 'PLUGIN_ROOT' ||
        name.toUpperCase() === 'PLUGIN_DATA'
    : name === 'PLUGIN_ROOT' || name === 'PLUGIN_DATA';
}

function expandPluginVariables(
  value: string,
  pluginRoot: string,
  pluginData: string,
): string {
  return value.replace(/\$\{PLUGIN_ROOT\}|\$\{PLUGIN_DATA\}/g, (match) =>
    match === '${PLUGIN_ROOT}' ? pluginRoot : pluginData,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
