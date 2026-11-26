/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import stableStringify from 'json-stable-stringify';
import type { McpServerRegistration } from './mcpManager.js';
import type { McpPluginOwner, MCPServerConfig } from './mcpServerConfig.js';
import { mcpServerKey, pluginMcpSourceId } from './server-key.js';

/**
 * The pool registrations for the MCP servers a plugin declares. Sessions and
 * the daemon's warm-up both build them here, so a plugin loaded with the same
 * config always lands on the same pool key and shares one connection, while a
 * different config — another install, project `pluginConfigs`, another
 * `--plugin-dir` — gets its own key instead of reconnecting someone else's.
 *
 * `defaultRootsDir` roots a server whose owner has no path.
 */
export function pluginMcpRegistrations(
  owner: McpPluginOwner,
  defaultRootsDir: string,
): McpServerRegistration[] {
  const plugin = {
    name: owner.name,
    path: owner.path,
    id: owner.id,
    ...(owner.version !== undefined && { version: owner.version }),
  };
  const rootsDir = owner.path ?? defaultRootsDir;
  return Object.entries(owner.mcpServers ?? {}).map(([name, server]) => {
    const config: MCPServerConfig = {
      ...server,
      plugin,
      // A relative working directory is the plugin's, not the host process's.
      ...(typeof server.cwd === 'string' && !isAbsolute(server.cwd)
        ? { cwd: resolve(rootsDir, server.cwd) }
        : {}),
    };
    const source = pluginMcpSourceId(owner.id, configDigest(config, rootsDir));
    return { key: mcpServerKey(source, name), config, rootsDir };
  });
}

/**
 * Short stable hash of what the pool compares to decide a registration
 * changed (`scope` is runtime-only, as there).
 */
function configDigest(config: MCPServerConfig, rootsDir: string): string {
  const { scope: _scope, ...compared } = config;
  return createHash('sha256')
    .update(stableStringify({ config: compared, rootsDir }) ?? '')
    .digest('hex')
    .slice(0, 8);
}
