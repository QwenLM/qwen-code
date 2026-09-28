/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import { ExtensionStore } from '@qwen-code/qwen-code-core/extension/extension-store.js';
import { HOOKS_CONFIG_FIELDS } from '@qwen-code/qwen-code-core/hooks/types.js';
import { parseApprovalModeValue } from './approval-mode-value.js';
import { loadProjectMcpServers } from './mcpJson.js';
import { readSettingsSnapshot, type LoadedSettings } from './settings.js';
import { getGlobalQwenDirLite } from './storage-paths-lite.js';

export type ManagedCompatibility =
  | { readonly status: 'compatible' }
  | { readonly status: 'deferred' | 'unknown'; readonly reason: string };

/** A workspace runtime as its session hosts see it. */
export interface ManagedCompatibilityRuntime {
  readonly workspaceCwd: string;
  readonly workspaceTrusted: boolean;
  /** The effective environment the runtime gives its session hosts. */
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  /** Arguments the daemon forwards to every session host. */
  readonly forwardedArgs: readonly string[];
  /**
   * Whether the running workspace holds MCP servers outside its files: added
   * at runtime or registered by a client.
   */
  readonly hasLiveMcpServers: () => boolean;
}

export interface ManagedCompatibilityRequest {
  readonly workspaceCwd: string;
  readonly approvalMode?: ApprovalMode;
}

/**
 * Whether the first-phase Managed engine can run a session of this runtime
 * exactly as configured. `deferred` means that engine does not support this
 * session or its configuration; `unknown` means something could not be
 * proven.
 * Reads only local files, and never writes, locks or repairs what it reads.
 * Reasons name the source, never configuration values.
 */
export async function evaluateManagedCompatibility(
  request: ManagedCompatibilityRequest,
  runtime: ManagedCompatibilityRuntime,
): Promise<ManagedCompatibility> {
  if (!runtime.workspaceTrusted) {
    return deferred('the workspace is not trusted');
  }
  let sameWorkspace: boolean;
  try {
    const [requested, workspace] = await Promise.all([
      realpath(request.workspaceCwd),
      realpath(runtime.workspaceCwd),
    ]);
    sameWorkspace = requested === workspace;
  } catch {
    return unknown('the session or workspace directory could not be resolved');
  }
  if (!sameWorkspace) {
    return deferred('the session directory is not the runtime workspace');
  }
  if (runtime.forwardedArgs.includes('--experimental-lsp')) {
    return deferred('the daemon enables LSP for its sessions');
  }
  if (runtime.forwardedArgs.includes('--restore-ask-user-question')) {
    return deferred('the daemon restores unanswered user questions');
  }
  if (runtime.forwardedArgs.length > 0) {
    return unknown(
      'the daemon forwards an argument the evaluation does not know',
    );
  }
  if (runtime.hasLiveMcpServers()) {
    return deferred('MCP servers were added to the running workspace');
  }

  let settings: LoadedSettings;
  try {
    settings = readSettingsSnapshot(runtime.workspaceCwd, {
      environment: runtime.environment,
      workspaceTrusted: true,
    });
  } catch {
    return unknown('the settings could not be read');
  }
  const merged = settings.merged;
  if (Object.keys(merged.mcpServers ?? {}).length > 0) {
    return deferred('MCP servers are configured in settings');
  }
  if (merged.mcp?.serverCommand) {
    return deferred('an MCP server command is configured');
  }
  if (merged.tools?.discoveryCommand || merged.tools?.callCommand) {
    return deferred('a tool discovery or call command is configured');
  }
  if (
    [
      settings.getSystemHooks(),
      settings.getUserHooks(),
      settings.getProjectHooks(),
    ].some(hasHooks)
  ) {
    return deferred('hooks are configured in settings');
  }
  // Session creation parses the settings value, as boot does, before a
  // requested mode replaces it; a value it rejects fails every session.
  let settingsApprovalMode: ApprovalMode | undefined;
  if (merged.tools?.approvalMode) {
    try {
      settingsApprovalMode = parseApprovalModeValue(merged.tools.approvalMode);
    } catch {
      return unknown('the approval mode in settings is not valid');
    }
  }
  if ((request.approvalMode ?? settingsApprovalMode) === ApprovalMode.PLAN) {
    return deferred('plan mode needs tools the engine does not provide');
  }

  const projectMcp = loadProjectMcpServers(runtime.workspaceCwd, {
    strict: true,
  });
  if (projectMcp.errors.length > 0) {
    return unknown('the project MCP file could not be read or is malformed');
  }
  if (Object.keys(projectMcp.servers).length > 0) {
    return deferred('MCP servers are configured in the project MCP file');
  }

  const qwenDir = getGlobalQwenDirLite(runtime.environment);
  const extensions = await new ExtensionStore({
    extensionsDir: path.join(qwenDir, 'extensions'),
    storeDir: path.join(qwenDir, 'extension-store'),
  }).inspectEmptiness();
  if (extensions.status === 'installed') {
    return deferred('extensions are installed');
  }
  if (extensions.status === 'unknown') {
    return unknown(extensions.reason);
  }
  return { status: 'compatible' };
}

/**
 * The hook registry skips the configuration fields of a hooks object; any
 * other entry counts unless it is an empty list.
 */
function hasHooks(hooks: Record<string, unknown> | undefined): boolean {
  return Object.entries(hooks ?? {}).some(
    ([name, definitions]) =>
      !HOOKS_CONFIG_FIELDS.includes(name) &&
      !(Array.isArray(definitions) && definitions.length === 0),
  );
}

function deferred(reason: string): ManagedCompatibility {
  return { status: 'deferred', reason };
}

function unknown(reason: string): ManagedCompatibility {
  return { status: 'unknown', reason };
}
