/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpath } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import { ExtensionStore } from '@qwen-code/qwen-code-core/extension/extension-store.js';
import { HOOKS_CONFIG_FIELDS } from '@qwen-code/qwen-code-core/hooks/types.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import { parseApprovalModeValue } from './approval-mode-value.js';
import { loadProjectMcpServers } from './mcpJson.js';
import {
  readSettingsSnapshot,
  resolveHomeDirectory,
  type LoadedSettings,
} from './settings.js';
import {
  expandsAgainstHome,
  getGlobalQwenDirLite,
  isFullyQualifiedPath,
  passedEnvironment,
  spawnedEnvironmentView,
} from './storage-paths-lite.js';

const debugLogger = createDebugLogger('MANAGED_COMPATIBILITY');

export type ManagedCompatibility =
  | { readonly status: 'compatible' }
  | { readonly status: 'deferred' | 'unknown'; readonly reason: string };

/** A workspace runtime as its session hosts see it. */
export interface ManagedCompatibilityRuntime {
  readonly workspaceCwd: string;
  readonly workspaceTrusted: boolean;
  /**
   * The effective environment the runtime gives its session hosts. The
   * evaluation reads it once, so the hosts must be spawned with the same
   * variables.
   */
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
    return deferredResult('the workspace is not trusted');
  }
  let sameWorkspace: boolean;
  try {
    const [requested, workspace] = await Promise.all([
      realpath(request.workspaceCwd),
      realpath(runtime.workspaceCwd),
    ]);
    sameWorkspace = requested === workspace;
  } catch {
    return unknownResult(
      'the session or workspace directory could not be resolved',
    );
  }
  if (!sameWorkspace) {
    return deferredResult('the session directory is not the runtime workspace');
  }
  if (runtime.forwardedArgs.includes('--experimental-lsp')) {
    return deferredResult('the daemon enables LSP for its sessions');
  }
  if (runtime.forwardedArgs.includes('--restore-ask-user-question')) {
    return deferredResult('the daemon restores unanswered user questions');
  }
  if (runtime.forwardedArgs.length > 0) {
    return unknownResult(
      'the daemon forwards an argument the evaluation does not know',
    );
  }
  if (runtime.hasLiveMcpServers()) {
    return deferredResult('MCP servers were added to the running workspace');
  }
  // A session host resolves such a location against its own working
  // directory, which the evaluation cannot know.
  let environment: Readonly<Record<string, string>>;
  let locationDependsOnWorkingDirectory: boolean;
  try {
    // Every rule below reads this one copy, as a spawned session host
    // receives it.
    environment = passedEnvironment(runtime.environment);
    locationDependsOnWorkingDirectory =
      hasWorkingDirectoryLocation(environment);
  } catch (error) {
    // The reason names no variable or path; the log line says which failed.
    debugLogger.warn(
      'The home directory or the environment could not be read:',
      error,
    );
    return unknownResult(
      'the home directory or the environment could not be read',
    );
  }
  if (locationDependsOnWorkingDirectory) {
    return unknownResult(
      'a settings location in the environment depends on the working directory',
    );
  }

  let settings: LoadedSettings;
  try {
    settings = readSettingsSnapshot(runtime.workspaceCwd, {
      environment,
      workspaceTrusted: true,
    });
  } catch {
    return unknownResult('the settings could not be read');
  }
  const merged = settings.merged;
  if (Object.keys(merged.mcpServers ?? {}).length > 0) {
    return deferredResult('MCP servers are configured in settings');
  }
  if (merged.mcp?.serverCommand) {
    return deferredResult('an MCP server command is configured');
  }
  if (merged.tools?.discoveryCommand || merged.tools?.callCommand) {
    return deferredResult('a tool discovery or call command is configured');
  }
  if (
    [
      settings.getSystemHooks(),
      settings.getUserHooks(),
      settings.getProjectHooks(),
    ].some(hasHooks)
  ) {
    return deferredResult('hooks are configured in settings');
  }
  // Session creation parses the settings value, as boot does, before a
  // requested mode replaces it; a value it rejects fails every session.
  let settingsApprovalMode: ApprovalMode | undefined;
  if (merged.tools?.approvalMode) {
    try {
      settingsApprovalMode = parseApprovalModeValue(merged.tools.approvalMode);
    } catch {
      return unknownResult('the approval mode in settings is not valid');
    }
  }
  if ((request.approvalMode ?? settingsApprovalMode) === ApprovalMode.PLAN) {
    return deferredResult('plan mode needs tools the engine does not provide');
  }

  const projectMcp = loadProjectMcpServers(runtime.workspaceCwd, {
    strict: true,
  });
  if (projectMcp.errors.length > 0) {
    return unknownResult(
      'the project MCP file could not be read or is malformed',
    );
  }
  if (Object.keys(projectMcp.servers).length > 0) {
    return deferredResult('MCP servers are configured in the project MCP file');
  }

  const qwenDir = getGlobalQwenDirLite(environment);
  const extensions = await new ExtensionStore({
    extensionsDir: path.join(qwenDir, 'extensions'),
    storeDir: path.join(qwenDir, 'extension-store'),
  }).inspectEmptiness();
  if (extensions.status === 'installed') {
    return deferredResult('extensions are installed');
  }
  if (extensions.status === 'unknown') {
    return unknownResult(extensions.reason);
  }
  return { status: 'compatible' };
}

/**
 * Whether a variable that locates settings or the extension store gives a
 * location that depends on the working directory, among the variables a
 * spawned session host receives. Settings loading resolves the home directory
 * for the user directory and to tell whether the workspace is the home
 * directory, so an empty or relative one counts too. A `QWEN_HOME` that
 * expands against the home directory is under it; the system settings paths
 * are used as they are. Throws when the home directory cannot be looked up,
 * or cannot be resolved as settings loading resolves it, for example because
 * it does not exist.
 */
function hasWorkingDirectoryLocation(
  environment: Readonly<Record<string, string>>,
): boolean {
  const variables = spawnedEnvironmentView(environment);
  const home = os.homedir();
  // An empty home directory is not fully qualified either.
  if (!isFullyQualifiedPath(home)) return true;
  resolveHomeDirectory(home);
  const qwenHome = variables['QWEN_HOME'];
  if (
    qwenHome &&
    !expandsAgainstHome(qwenHome) &&
    !isFullyQualifiedPath(qwenHome)
  ) {
    return true;
  }
  return [
    variables['QWEN_CODE_SYSTEM_SETTINGS_PATH'],
    variables['QWEN_CODE_SYSTEM_DEFAULTS_PATH'],
  ].some(
    (location) =>
      location !== undefined &&
      location !== '' &&
      !isFullyQualifiedPath(location),
  );
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

function deferredResult(reason: string): ManagedCompatibility {
  return { status: 'deferred', reason };
}

function unknownResult(reason: string): ManagedCompatibility {
  return { status: 'unknown', reason };
}
