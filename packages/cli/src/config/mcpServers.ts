/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MCPServerConfig } from '@qwen-code/qwen-code-core';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadProjectMcpServers } from './mcpJson.js';
import { writeStderrLine } from '../utils/stdioHelpers.js';

/**
 * Assemble the effective MCP server map from every source in precedence order,
 * lowest → highest (later wins on a name collision):
 *
 *   1. user / default settings    (`scope` unset)
 *   2. project `.mcp.json`         (`scope: 'project'`)  ← Claude parity: project > user
 *   3. workspace / system settings (`scope: 'workspace' | 'system'`)
 *   4. `--mcp-config` CLI servers  (`scope` unset)
 *
 * `mergedSettingsServers` is `settings.merged.mcpServers`, whose entries are
 * already stamped with their winning provenance scope by `mergeSettings`
 * (issue #4615). We split that single map by scope so a checked-in `.mcp.json`
 * can override a *user*-level server while still yielding to a workspace or
 * enterprise-enforced (`system`) one. Loading `.mcp.json` is a pure read and
 * never connects.
 */
export function assembleMcpServers(
  mergedSettingsServers: Record<string, MCPServerConfig> | undefined,
  cwd: string,
  cliMcpServers?: Record<string, MCPServerConfig> | null,
): Record<string, MCPServerConfig> {
  const belowProject: Record<string, MCPServerConfig> = {};
  const aboveProject: Record<string, MCPServerConfig> = {};
  for (const [name, config] of Object.entries(mergedSettingsServers ?? {})) {
    // workspace/system settings outrank a `.mcp.json` server; user/default
    // settings sit below it.
    if (config.scope === 'workspace' || config.scope === 'system') {
      aboveProject[name] = config;
    } else {
      belowProject[name] = config;
    }
  }

  const projectResult = loadProjectMcpServers(cwd);
  for (const error of projectResult.errors) {
    writeStderrLine(`Warning: ${error}`);
  }

  const assembled = {
    ...belowProject,
    ...projectResult.servers,
    ...aboveProject,
    ...(cliMcpServers ?? {}),
  };
  setProjectMcpLiteralSource(cwd, projectResult.literalServers);
  return assembled;
}

/**
 * Canonical root key for the cross-call literal-source map. The approvals
 * file folds win32 drive-letter case (`normalizeProjectRoot` in
 * `mcpApprovals.ts`); the literal lookup must agree with that spelling or
 * a caller passing a different casing of the same root would silently
 * miss the literal and re-prompt despite an unchanged `.mcp.json`.
 */
function literalSourceRootKey(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  return os.platform() === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * The pre-expansion `.mcp.json` configs of the most recent
 * {@link assembleMcpServers} run per project root, for approval hashing
 * (#11499). Approval hashes must bind to the file's literal text: project
 * servers are loaded with `${VAR}` placeholders already resolved, so
 * hashing the live config would bind an approval to the secret's value and
 * re-prompt on token rotation, though `.mcp.json` never changed (#4615's
 * intent is that editing the file re-triggers approval, not the env).
 * Populated as a side effect of assembly because every approval consumer
 * (CLI commands, ACP, the OpenTUI dialog) already flows through it.
 */
const projectMcpLiteralSources = new Map<
  string,
  Record<string, MCPServerConfig>
>();

export function setProjectMcpLiteralSource(
  projectRoot: string,
  literalServers: Record<string, MCPServerConfig>,
): void {
  projectMcpLiteralSources.set(
    literalSourceRootKey(projectRoot),
    literalServers,
  );
}

/** FOR TESTING ONLY. */
export function resetProjectMcpLiteralSourceForTesting(): void {
  projectMcpLiteralSources.clear();
}

export function getProjectMcpLiteralSource(
  projectRoot: string,
): Record<string, MCPServerConfig> | undefined {
  return projectMcpLiteralSources.get(literalSourceRootKey(projectRoot));
}
