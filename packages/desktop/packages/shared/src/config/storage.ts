import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'fs';
import { join, dirname, basename, resolve, relative, isAbsolute } from 'path';
import { homedir } from 'os';
import { getCredentialManager } from '../credentials/index.ts';
import { getOrCreateLatestSession, type SessionConfig } from '../sessions/index.ts';
import {
  discoverWorkspacesInDefaultLocation,
  ensureDefaultWorkspacesDir,
  generateSlug,
  generateUniqueWorkspacePath,
  getDefaultWorkspacesDir,
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  createWorkspaceAtPath,
  isValidWorkspace,
} from '../workspaces/storage.ts';
import { findIconFile } from '../utils/icon.ts';
import { extractWorkspaceSlugFromPath } from '../utils/workspace-slug.ts';
import { initializeDocs } from '../docs/index.ts';
import { expandPath, toPortablePath, getBundledAssetsDir } from '../utils/paths.ts';
import { debug } from '../utils/debug.ts';
import { readJsonFileSync } from '../utils/files.ts';
import { CONFIG_DIR } from './paths.ts';
import type { StoredAttachment, StoredMessage } from '@craft-agent/core/types';
import type { Plan } from '../agent/plan-types.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import { isValidThinkingLevel, normalizeThinkingLevel } from '../agent/thinking-levels.ts';
import { parsePermissionMode, PERMISSION_MODE_ORDER, normalizeCyclablePermissionModes } from '../agent/mode-types.ts';
import { type ConfigDefaults } from './config-defaults-schema.ts';
import { isValidThemeFile } from './validators.ts';

// Re-export CONFIG_DIR for convenience (centralized in paths.ts)
export { CONFIG_DIR } from './paths.ts';

// Re-export base types from core (single source of truth)
export type {
  WorkspaceInfo,
  Workspace,
  McpAuthType,
  OAuthCredentials,
} from '@craft-agent/core/types';

// Import for local use
import type { Workspace } from '@craft-agent/core/types';

// Import LLM connection types and constants
import type { LlmConnection } from './llm-connections.ts';
import { QWEN_CODE_CONNECTION_SLUG, type LlmProviderType } from './llm-connections.ts';

// Config stored in JSON file (credentials stored in encrypted file, not here)
export interface StoredConfig {
  // LLM Connections (authoritative source for auth and model config)
  llmConnections?: LlmConnection[];
  defaultLlmConnection?: string;  // Slug of default connection for new sessions
  defaultThinkingLevel?: ThinkingLevel;  // App-level default thinking level for new sessions

  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;  // Currently active session (primary scope)
  // Notifications
  notificationsEnabled?: boolean;  // Desktop notifications for task completion (default: true)
  // Appearance
  colorTheme?: string;  // ID of selected preset theme (e.g., 'dracula', 'nord'). Default: 'default'
  // Auto-update
  dismissedUpdateVersion?: string;  // Version that user dismissed (skip notifications for this version)
  // Input settings
  autoCapitalisation?: boolean;  // Auto-capitalize first letter when typing (default: true)
  sendMessageKey?: 'enter' | 'cmd-enter';  // Key to send messages (default: 'enter')
  spellCheck?: boolean;  // Enable spell check in input (default: false)
  // Power settings
  keepAwakeWhileRunning?: boolean;  // Prevent screen sleep while sessions are running (default: false)
  // Tool metadata
  richToolDescriptions?: boolean;  // Add intent/action metadata to all tool calls (default: true)
  // Pet companion
  selectedPetId?: string;  // ID of the selected pet companion (default: 'qwen')
  petEnabled?: boolean;  // Show the floating pet companion (default: true)
  petWindowBounds?: { x: number; y: number };  // Saved position of the floating pet window
  // Tools
  browserToolEnabled?: boolean;  // Enable built-in browser tool (default: true). Disable for Playwright/Puppeteer.
  // Prompt caching & context
  extendedPromptCache?: boolean;  // Use 1h prompt cache TTL instead of 5m (default: false)
  enable1MContext?: boolean;  // Enable extended context for supported models (default: false)
  // Network proxy
  networkProxy?: import('./types.ts').NetworkProxySettings;
  // Windows: path to Git Bash (bash.exe) for backend subprocesses
  gitBashPath?: string;
  // User chose "Setup later" during onboarding — skip showing onboarding on next launch
  setupDeferred?: boolean;
  // Server mode — embedded remote server settings
  serverConfig?: import('./server-config.ts').ServerConfig;
  // One-shot migration markers. Used by migrations that should run at most
  // once per user (e.g. restoring a previously-removed model to connection
  // lists without re-adding it if the user later removes it deliberately).
  migrationsApplied?: string[];
}

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const CONFIG_DEFAULTS_FILE = join(CONFIG_DIR, 'config-defaults.json');
const WORKSPACES_DIR = join(CONFIG_DIR, 'workspaces');

export const DEFAULT_CONVERSATION_WORKSPACE_NAME = 'Qwen';
export const DEFAULT_CONVERSATION_WORKSPACE_KIND = 'conversation' as const;
export const DEFAULT_CONVERSATION_WORKSPACE_PATH_ENV = 'QWEN_DEFAULT_WORKSPACE_DIR';

// Track if config-defaults have been synced this session (prevents re-sync on hot reload)
let configDefaultsSynced = false;

/**
 * Sync config-defaults.json from bundled assets.
 * Always writes on launch to ensure defaults are up-to-date with the running version.
 * Follows the same pattern as docs, themes, and other bundled assets.
 *
 * Source of truth: apps/electron/resources/config-defaults.json
 */
/** Minimal config-defaults used when bundled assets aren't available (CI, standalone server). */
const FALLBACK_CONFIG_DEFAULTS: ConfigDefaults = {
  version: '1.0',
  description: 'Default configuration values for Qwen Code',
  defaults: {
    notificationsEnabled: true,
    colorTheme: 'default',
    autoCapitalisation: true,
    sendMessageKey: 'enter',
    spellCheck: false,
    keepAwakeWhileRunning: false,
    richToolDescriptions: true,
    extendedPromptCache: false,
    browserToolEnabled: true,
  },
  workspaceDefaults: {
    thinkingLevel: 'medium',
    permissionMode: 'allow-all',
    cyclablePermissionModes: [...PERMISSION_MODE_ORDER],
    localMcpServers: { enabled: true },
  },
};

function syncConfigDefaults(): void {
  if (configDefaultsSynced) return;
  configDefaultsSynced = true;

  // Get bundled config-defaults.json from resources folder
  const bundledDir = getBundledAssetsDir('.');
  if (!bundledDir) {
    debug('[config] No bundled assets dir found - using fallback config-defaults');
    if (!existsSync(CONFIG_DEFAULTS_FILE)) {
      writeFileSync(CONFIG_DEFAULTS_FILE, JSON.stringify(FALLBACK_CONFIG_DEFAULTS, null, 2), 'utf-8');
    }
    return;
  }

  const bundledFile = join(bundledDir, 'config-defaults.json');
  if (!existsSync(bundledFile)) {
    debug('[config] Bundled config-defaults.json not found at: ' + bundledFile + ' - using fallback');
    if (!existsSync(CONFIG_DEFAULTS_FILE)) {
      writeFileSync(CONFIG_DEFAULTS_FILE, JSON.stringify(FALLBACK_CONFIG_DEFAULTS, null, 2), 'utf-8');
    }
    return;
  }

  // Sync from bundled file (same pattern as docs)
  const content = readFileSync(bundledFile, 'utf-8');
  writeFileSync(CONFIG_DEFAULTS_FILE, content, 'utf-8');
  debug('[config] Synced config-defaults.json from bundled assets');
}

/**
 * Load config defaults from ~/.craft-agent/config-defaults.json
 * This file is synced from bundled assets on every launch.
 */
export function loadConfigDefaults(): ConfigDefaults {
  if (!existsSync(CONFIG_DEFAULTS_FILE)) {
    throw new Error('config-defaults.json not found at ' + CONFIG_DEFAULTS_FILE + '. Ensure ensureConfigDir() was called at startup.');
  }

  const defaults = readJsonFileSync<ConfigDefaults>(CONFIG_DEFAULTS_FILE);

  const parsedPermissionMode =
    typeof defaults.workspaceDefaults?.permissionMode === 'string'
      ? parsePermissionMode(defaults.workspaceDefaults.permissionMode)
      : null;
  defaults.workspaceDefaults.permissionMode = parsedPermissionMode ?? 'allow-all';

  defaults.workspaceDefaults.cyclablePermissionModes = normalizeCyclablePermissionModes(
    defaults.workspaceDefaults?.cyclablePermissionModes,
  );

  return defaults;
}

/**
 * Ensure config-defaults.json exists and is up-to-date.
 * Syncs from bundled assets on every launch (like docs, themes, permissions).
 */
export function ensureConfigDefaults(): void {
  syncConfigDefaults();
}

let configDirInitialized = false;

export function ensureConfigDir(): void {
  if (configDirInitialized) return;

  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  // Initialize bundled docs (creates ~/.craft-agent/docs/ with sources.md, agents.md, permissions.md)
  initializeDocs();

  // Initialize config defaults
  ensureConfigDefaults();

  // Initialize tool icons (CLI tool icons for turn card display)
  ensureToolIcons();

  configDirInitialized = true;
}

function isPathWithin(parentPath: string, childPath: string): boolean {
  const rel = relative(resolve(parentPath), resolve(childPath));
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function isManagedWorkspacePath(rootPath: string): boolean {
  return isPathWithin(getDefaultWorkspacesDir(), rootPath);
}

function isExistingDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const PROJECT_DIRECTORY_MARKERS = [
  '.git',
  '.hg',
  '.svn',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  '.qwen',
  '.vscode',
];

function looksLikeUserProjectDirectory(rootPath: string): boolean {
  if (!isExistingDirectory(rootPath)) return false;
  return PROJECT_DIRECTORY_MARKERS.some(marker => existsSync(join(rootPath, marker)));
}

function allocateManagedWorkspacePath(workspace: Workspace, reservedPaths: Set<string>): string {
  ensureDefaultWorkspacesDir();

  const baseDir = getDefaultWorkspacesDir();
  const preferredSlug = workspace.slug || generateSlug(workspace.name || basename(workspace.rootPath));
  const preferredPath = join(baseDir, preferredSlug || workspace.id || 'workspace');
  const resolvedPreferred = resolve(preferredPath);

  if (!reservedPaths.has(resolvedPreferred) && !existsSync(preferredPath)) {
    return preferredPath;
  }

  let candidate = generateUniqueWorkspacePath(workspace.name || preferredSlug || 'Workspace', baseDir);
  let counter = 2;
  while (reservedPaths.has(resolve(candidate))) {
    candidate = join(baseDir, `${preferredSlug || 'workspace'}-${counter++}`);
  }
  return candidate;
}

function migrateExternalProjectWorkspace(
  workspace: Workspace,
  reservedPaths: Set<string>,
  forceProjectWorkingDirectory: boolean,
): boolean {
  if (isManagedWorkspacePath(workspace.rootPath)) {
    if (!isValidWorkspace(workspace.rootPath)) {
      createWorkspaceAtPath(workspace.rootPath, workspace.name, undefined, {
        ...(workspace.kind ? { kind: workspace.kind } : {}),
        ...(workspace.isProtected !== undefined ? { isProtected: workspace.isProtected } : {}),
      });
    }
    return false;
  }

  const shouldMoveToManagedStorage =
    !isValidWorkspace(workspace.rootPath) ||
    looksLikeUserProjectDirectory(workspace.rootPath) ||
    forceProjectWorkingDirectory;

  if (!shouldMoveToManagedStorage) return false;

  let projectRoot = isExistingDirectory(workspace.rootPath) ? workspace.rootPath : undefined;
  if (!projectRoot && forceProjectWorkingDirectory && !isValidWorkspace(workspace.rootPath)) {
    mkdirSync(workspace.rootPath, { recursive: true });
    projectRoot = workspace.rootPath;
  }

  const existingWorkspaceConfig = loadWorkspaceConfig(workspace.rootPath);
  const managedRootPath = allocateManagedWorkspacePath(workspace, reservedPaths);
  const defaults = {
    ...existingWorkspaceConfig?.defaults,
    ...(projectRoot ? { workingDirectory: projectRoot } : {}),
  };

  createWorkspaceAtPath(managedRootPath, workspace.name, defaults, {
    ...(workspace.kind ? { kind: workspace.kind } : {}),
    ...(workspace.isProtected !== undefined ? { isProtected: workspace.isProtected } : {}),
  });

  if (existingWorkspaceConfig) {
    saveWorkspaceConfig(managedRootPath, {
      ...existingWorkspaceConfig,
      name: workspace.name || existingWorkspaceConfig.name,
      slug: generateSlug(workspace.name || existingWorkspaceConfig.name || basename(managedRootPath)),
      defaults,
    });
  }

  reservedPaths.delete(resolve(workspace.rootPath));
  workspace.rootPath = managedRootPath;
  workspace.slug = extractWorkspaceSlugFromPath(managedRootPath, workspace.id);
  reservedPaths.add(resolve(managedRootPath));
  return true;
}

export function loadStoredConfig(): StoredConfig | null {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return null;
    }
    const config = readJsonFileSync<StoredConfig>(CONFIG_FILE);

    // Must have workspaces array
    if (!Array.isArray(config.workspaces)) {
      return null;
    }

    // Expand path variables (~ and ${HOME}) for portability
    for (const workspace of config.workspaces) {
      workspace.rootPath = expandPath(workspace.rootPath);
    }

    // Validate active workspace exists
    const activeWorkspace = config.workspaces.find(w => w.id === config.activeWorkspaceId);
    if (!activeWorkspace) {
      // Default to first workspace
      config.activeWorkspaceId = config.workspaces[0]?.id || null;
    }

    // Keep app-owned workspace state in managed storage. Existing project
    // directories are treated as a session default working directory, not as
    // the place where the app should scaffold config/status/label files.
    const reservedPaths = new Set(config.workspaces.map(w => resolve(w.rootPath)));
    let migratedWorkspacePaths = false;
    for (const workspace of config.workspaces) {
      try {
        migratedWorkspacePaths = migrateExternalProjectWorkspace(workspace, reservedPaths, false) || migratedWorkspacePaths;
      } catch (wsError) {
        debug('[config] Failed to prepare workspace', workspace.rootPath, ':', wsError instanceof Error ? wsError.message : wsError);
      }
    }

    if (migratedWorkspacePaths) {
      saveConfig(config);
    }

    return config;
  } catch (error) {
    debug('[config] loadStoredConfig failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

// Legacy credential helpers removed - use connection-aware credential lookup instead.

export function saveConfig(config: StoredConfig): void {
  ensureConfigDir();

  // Convert paths to portable form (~ prefix) for cross-machine compatibility
  const storageConfig: StoredConfig = {
    ...config,
    workspaces: config.workspaces.map(ws => ({
      ...ws,
      rootPath: toPortablePath(ws.rootPath),
    })),
  };

  writeFileSync(CONFIG_FILE, JSON.stringify(storageConfig, null, 2), 'utf-8');
}

// Legacy updateApiKey() removed - use setupLlmConnection IPC handler instead.

// Legacy getters/setters removed - use LLM connections instead:
// - getAuthType/setAuthType -> derive from getDefaultLlmConnection()/getLlmConnection()
// - legacy base URL setters -> use connection-scoped configuration
// - getCustomModel/setCustomModel -> use connection.defaultModel


/**
 * Get whether desktop notifications are enabled.
 * Defaults to true if not set.
 */
export function getNotificationsEnabled(): boolean {
  const config = loadStoredConfig();
  if (config?.notificationsEnabled !== undefined) {
    return config.notificationsEnabled;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.notificationsEnabled;
}

/**
 * Set whether desktop notifications are enabled.
 */
export function setNotificationsEnabled(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.notificationsEnabled = enabled;
  saveConfig(config);
}

/**
 * Get whether auto-capitalisation is enabled.
 * Defaults to true if not set.
 */
export function getAutoCapitalisation(): boolean {
  const config = loadStoredConfig();
  if (config?.autoCapitalisation !== undefined) {
    return config.autoCapitalisation;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.autoCapitalisation;
}

/**
 * Set whether auto-capitalisation is enabled.
 */
export function setAutoCapitalisation(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.autoCapitalisation = enabled;
  saveConfig(config);
}

/**
 * Get the key combination used to send messages.
 * Defaults to 'enter' if not set.
 */
export function getSendMessageKey(): 'enter' | 'cmd-enter' {
  const config = loadStoredConfig();
  if (config?.sendMessageKey !== undefined) {
    return config.sendMessageKey;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.sendMessageKey;
}

/**
 * Set the key combination used to send messages.
 */
export function setSendMessageKey(key: 'enter' | 'cmd-enter'): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.sendMessageKey = key;
  saveConfig(config);
}

/**
 * Get whether spell check is enabled in the input.
 */
export function getSpellCheck(): boolean {
  const config = loadStoredConfig();
  if (config?.spellCheck !== undefined) {
    return config.spellCheck;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.spellCheck;
}

/**
 * Set whether spell check is enabled in the input.
 */
export function setSpellCheck(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.spellCheck = enabled;
  saveConfig(config);
}

/**
 * Get whether screen should stay awake while sessions are running.
 * Defaults to false if not set.
 */
export function getKeepAwakeWhileRunning(): boolean {
  const config = loadStoredConfig();
  if (config?.keepAwakeWhileRunning !== undefined) {
    return config.keepAwakeWhileRunning;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.keepAwakeWhileRunning;
}

/**
 * Set whether screen should stay awake while sessions are running.
 */
export function setKeepAwakeWhileRunning(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.keepAwakeWhileRunning = enabled;
  saveConfig(config);
}

/**
 * Get whether rich tool descriptions are enabled.
 * When enabled, all tool calls include intent and display name metadata.
 * Defaults to true if not set.
 */
export function getRichToolDescriptions(): boolean {
  const config = loadStoredConfig();
  if (config?.richToolDescriptions !== undefined) {
    return config.richToolDescriptions;
  }
  return true;
}

/**
 * Set whether rich tool descriptions are enabled.
 */
export function setRichToolDescriptions(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.richToolDescriptions = enabled;
  saveConfig(config);
}

/**
 * Get the selected pet companion id. Defaults to 'qwen' if not set.
 */
export function getSelectedPetId(): string {
  const config = loadStoredConfig();
  return config?.selectedPetId ?? 'qwen';
}

/**
 * Set the selected pet companion id.
 */
export function setSelectedPetId(id: string): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.selectedPetId = id;
  saveConfig(config);
}

/**
 * Get whether the floating pet companion is shown. Defaults to true.
 */
export function getPetEnabled(): boolean {
  const config = loadStoredConfig();
  if (config?.petEnabled !== undefined) {
    return config.petEnabled;
  }
  return true;
}

/**
 * Set whether the floating pet companion is shown.
 */
export function setPetEnabled(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.petEnabled = enabled;
  saveConfig(config);
}

/**
 * Get the saved position of the floating pet window, if any.
 */
export function getPetWindowBounds(): { x: number; y: number } | undefined {
  return loadStoredConfig()?.petWindowBounds;
}

/**
 * Persist the position of the floating pet window.
 */
export function setPetWindowBounds(bounds: { x: number; y: number }): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.petWindowBounds = bounds;
  saveConfig(config);
}

/**
 * Get whether extended prompt cache (1h TTL) is enabled.
 * When enabled, the interceptor upgrades cache_control TTL from 5m to 1h.
 * Defaults to false if not set.
 */
export function getExtendedPromptCache(): boolean {
  const config = loadStoredConfig();
  return config?.extendedPromptCache ?? false;
}

/**
 * Set whether extended prompt cache (1h TTL) is enabled.
 */
export function setExtendedPromptCache(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.extendedPromptCache = enabled;
  saveConfig(config);
}

/**
 * Get whether the built-in browser tool is enabled.
 * When disabled, browser_tool is not included in session tools.
 * Defaults to true if not set.
 */
export function getBrowserToolEnabled(): boolean {
  const config = loadStoredConfig();
  if (config?.browserToolEnabled !== undefined) {
    return config.browserToolEnabled;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.browserToolEnabled;
}

/**
 * Set whether the built-in browser tool is enabled.
 */
export function setBrowserToolEnabled(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.browserToolEnabled = enabled;
  saveConfig(config);

  // Clear session tool caches so all sessions pick up the change immediately.
  // Lazy import to avoid circular dependency (storage ← session-scoped-tools ← storage).
  import('../agent/session-scoped-tools.ts').then(m => m.invalidateAllSessionToolsCaches()).catch(() => {});
}

/**
 * Get whether 1M context window is enabled.
 * When disabled, models use 200K context and the interceptor strips the context-1m beta header.
 * Defaults to false; users opt in via AI Settings → Performance.
 */
export function getEnable1MContext(): boolean {
  const config = loadStoredConfig();
  return config?.enable1MContext === true;
}

/**
 * Set whether 1M context window is enabled.
 */
export function setEnable1MContext(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.enable1MContext = enabled;
  saveConfig(config);
}

/**
 * Get persisted Git Bash path (Windows only).
 * Used by Windows backend subprocess launch.
 */
export function getGitBashPath(): string | undefined {
  const config = loadStoredConfig();
  return config?.gitBashPath;
}

/**
 * Set Git Bash path (Windows only).
 * Persists to config so it survives app restarts.
 * Returns false if the config could not be loaded (path not persisted).
 */
export function setGitBashPath(path: string): boolean {
  const config = loadStoredConfig();
  if (!config) {
    console.warn('[storage] Failed to persist Git Bash path: config could not be loaded');
    return false;
  }
  config.gitBashPath = path;
  saveConfig(config);
  return true;
}

/**
 * Clear persisted Git Bash path (Windows only).
 * Used when the stored path is stale or invalid.
 */
export function clearGitBashPath(): void {
  const config = loadStoredConfig();
  if (!config || !config.gitBashPath) return;
  delete config.gitBashPath;
  saveConfig(config);
}

// Note: getDefaultWorkingDirectory/setDefaultWorkingDirectory removed
// Working directory is now stored per-workspace in workspace config.json (defaults.workingDirectory)
// Note: getDefaultPermissionMode/getEnabledPermissionModes removed
// Permission settings are now stored per-workspace in workspace config.json (defaults.permissionMode, defaults.cyclablePermissionModes)

export function getConfigPath(): string {
  return CONFIG_FILE;
}

/**
 * Clear all configuration and credentials (for logout).
 * Deletes config file and credentials file.
 */
export async function clearAllConfig(): Promise<void> {
  // Delete config file
  if (existsSync(CONFIG_FILE)) {
    rmSync(CONFIG_FILE);
  }

  // Delete credentials file
  const credentialsFile = join(CONFIG_DIR, 'credentials.enc');
  if (existsSync(credentialsFile)) {
    rmSync(credentialsFile);
  }

  // Optionally: Delete workspace data (conversations)
  const workspacesDir = join(CONFIG_DIR, 'workspaces');
  if (existsSync(workspacesDir)) {
    rmSync(workspacesDir, { recursive: true });
  }
}

// ============================================
// Workspace Management Functions
// ============================================

/**
 * Generate a unique workspace ID.
 * Uses a random UUID-like format.
 */
export function generateWorkspaceId(): string {
  // Generate random bytes and format as UUID-like string (8-4-4-4-12)
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function isProtectedWorkspace(
  workspace: Pick<Workspace, 'kind' | 'isProtected'> | { kind?: string; isProtected?: boolean } | null | undefined,
): boolean {
  return workspace?.isProtected === true || workspace?.kind === DEFAULT_CONVERSATION_WORKSPACE_KIND;
}

function isProtectedStoredWorkspace(workspace: Workspace): boolean {
  if (isProtectedWorkspace(workspace)) return true;
  return isProtectedWorkspace(loadWorkspaceConfig(workspace.rootPath));
}

export function getDefaultConversationWorkspacePath(): string {
  return process.env[DEFAULT_CONVERSATION_WORKSPACE_PATH_ENV] || join(homedir(), 'Documents', DEFAULT_CONVERSATION_WORKSPACE_NAME);
}

export function ensureDefaultConversationWorkspace(): Workspace {
  let config = loadStoredConfig();
  if (!config) {
    config = { workspaces: [], activeWorkspaceId: null, activeSessionId: null };
  }

  const existing = config.workspaces.find(isProtectedStoredWorkspace);
  if (existing) {
    if (!config.activeWorkspaceId) {
      config.activeWorkspaceId = existing.id;
      saveConfig(config);
    }
    return getWorkspaces().find(w => w.id === existing.id) || existing;
  }

  const rootPath = getDefaultConversationWorkspacePath();
  const now = Date.now();
  const existingConfig = loadWorkspaceConfig(rootPath);

  if (!existingConfig) {
    createWorkspaceAtPath(
      rootPath,
      DEFAULT_CONVERSATION_WORKSPACE_NAME,
      { workingDirectory: rootPath },
      { kind: DEFAULT_CONVERSATION_WORKSPACE_KIND, isProtected: true },
    );
  } else {
    saveWorkspaceConfig(rootPath, {
      ...existingConfig,
      name: existingConfig.name || DEFAULT_CONVERSATION_WORKSPACE_NAME,
      slug: existingConfig.slug || generateSlug(DEFAULT_CONVERSATION_WORKSPACE_NAME),
      kind: DEFAULT_CONVERSATION_WORKSPACE_KIND,
      isProtected: true,
      defaults: {
        ...existingConfig.defaults,
        workingDirectory: existingConfig.defaults?.workingDirectory || rootPath,
      },
    });
  }

  const workspace: Workspace = {
    id: generateWorkspaceId(),
    name: DEFAULT_CONVERSATION_WORKSPACE_NAME,
    slug: extractWorkspaceSlugFromPath(rootPath, DEFAULT_CONVERSATION_WORKSPACE_NAME.toLowerCase()),
    rootPath,
    kind: DEFAULT_CONVERSATION_WORKSPACE_KIND,
    isProtected: true,
    createdAt: existingConfig?.createdAt || now,
  };

  config.workspaces.push(workspace);
  config.activeWorkspaceId = workspace.id;
  saveConfig(config);

  return getWorkspaces().find(w => w.id === workspace.id) || workspace;
}

/**
 * Find workspace icon file at workspace_root/icon.*
 * Returns absolute path to icon file if found, null otherwise
 */
export function findWorkspaceIcon(rootPath: string): string | null {
  return findIconFile(rootPath) ?? null;
}

export function getWorkspaces(): Workspace[] {
  const config = loadStoredConfig();
  const workspaces = config?.workspaces || [];

  // Resolve workspace names from folder config and local icons
  return workspaces.map(w => {
    // Read name from workspace folder config (single source of truth)
    const wsConfig = loadWorkspaceConfig(w.rootPath);
    const name = wsConfig?.name || basename(w.rootPath) || 'Untitled';

    // If workspace has a stored iconUrl that's a remote URL, use it
    // Otherwise check for local icon file
    let iconUrl = w.iconUrl;
    if (!iconUrl || (!iconUrl.startsWith('http://') && !iconUrl.startsWith('https://'))) {
      const localIcon = findWorkspaceIcon(w.rootPath);
      if (localIcon) {
        // Convert absolute path to file:// URL for Electron renderer
        // Append mtime as cache-buster so UI refreshes when icon changes
        try {
          const mtime = statSync(localIcon).mtimeMs;
          iconUrl = `file://${localIcon}?t=${mtime}`;
        } catch {
          iconUrl = `file://${localIcon}`;
        }
      }
    }

    const slug = extractWorkspaceSlugFromPath(w.rootPath, w.id);
    return {
      ...w,
      name,
      slug,
      iconUrl,
      kind: wsConfig?.kind ?? w.kind,
      isProtected: wsConfig?.isProtected ?? w.isProtected,
      pinned: wsConfig?.pinned ?? w.pinned,
    };
  });
}

export function reorderWorkspaces(orderedIds: string[]): boolean {
  const config = loadStoredConfig();
  if (!config) return false;

  const protectedWorkspaces = config.workspaces.filter(isProtectedStoredWorkspace);
  const movableWorkspaces = config.workspaces.filter(workspace => !isProtectedStoredWorkspace(workspace));
  const workspaceById = new Map(movableWorkspaces.map(workspace => [workspace.id, workspace]));
  const seen = new Set<string>();
  const reordered: Workspace[] = [];

  for (const id of orderedIds) {
    const workspace = workspaceById.get(id);
    if (!workspace || seen.has(id)) continue;
    reordered.push(workspace);
    seen.add(id);
  }

  if (reordered.length === 0 && movableWorkspaces.length > 0) {
    return false;
  }

  for (const workspace of movableWorkspaces) {
    if (!seen.has(workspace.id)) {
      reordered.push(workspace);
    }
  }

  const nextWorkspaces = [...protectedWorkspaces, ...reordered];
  const changed = nextWorkspaces.some((workspace, index) => workspace.id !== config.workspaces[index]?.id);
  if (!changed) return true;

  config.workspaces = nextWorkspaces;
  saveConfig(config);
  return true;
}

export function getActiveWorkspace(): Workspace | null {
  const config = loadStoredConfig();
  if (!config || !config.activeWorkspaceId) {
    return config?.workspaces[0] || null;
  }
  return config.workspaces.find(w => w.id === config.activeWorkspaceId) || config.workspaces[0] || null;
}

/**
 * Find a workspace by name (case-insensitive) or ID.
 * Useful for CLI -w flag to specify workspace.
 */
export function getWorkspaceByNameOrId(nameOrId: string): Workspace | null {
  const workspaces = getWorkspaces();
  return workspaces.find(w =>
    w.id === nameOrId ||
    w.name.toLowerCase() === nameOrId.toLowerCase()
  ) || null;
}

export function updateWorkspaceRemoteServer(
  workspaceId: string,
  remoteServer: { url: string; token: string; remoteWorkspaceId: string },
): void {
  const config = loadStoredConfig();
  if (!config) return;
  const ws = config.workspaces.find(w => w.id === workspaceId);
  if (!ws) throw new Error('Workspace not found');
  ws.remoteServer = remoteServer;
  saveConfig(config);
}

export function setActiveWorkspace(workspaceId: string): void {
  const config = loadStoredConfig();
  if (!config) return;

  const workspace = config.workspaces.find(w => w.id === workspaceId);
  if (!workspace) return;

  config.activeWorkspaceId = workspaceId;
  saveConfig(config);
}

/**
 * Atomically switch to a workspace and load/create a session.
 * This prevents race conditions by doing both operations together.
 *
 * @param workspaceId The ID of the workspace to switch to
 * @returns The workspace and session, or null if workspace not found
 */
export async function switchWorkspaceAtomic(workspaceId: string): Promise<{ workspace: Workspace; session: SessionConfig } | null> {
  const config = loadStoredConfig();
  if (!config) return null;

  const workspace = config.workspaces.find(w => w.id === workspaceId);
  if (!workspace) return null;

  // Get or create the latest session for this workspace
  const session = await getOrCreateLatestSession(workspace.rootPath);

  // Update active workspace in config
  config.activeWorkspaceId = workspaceId;
  workspace.lastAccessedAt = Date.now();
  saveConfig(config);

  return { workspace, session };
}

/**
 * Add a workspace to the global config.
 * @param workspace - Workspace data (must include rootPath)
 */
export function addWorkspace(workspace: Omit<Workspace, 'id' | 'createdAt' | 'slug'>): Workspace {
  const config = loadStoredConfig();
  if (!config) {
    throw new Error('No config found');
  }

  const inputRootPath = expandPath(workspace.rootPath);
  const existingByProjectPath = config.workspaces.find(w => {
    const wsConfig = loadWorkspaceConfig(w.rootPath);
    return wsConfig?.defaults?.workingDirectory === inputRootPath;
  });

  if (existingByProjectPath) {
    const existingConfig = loadWorkspaceConfig(existingByProjectPath.rootPath);
    const defaults = {
      ...existingConfig?.defaults,
      workingDirectory: inputRootPath,
    };
    if (existingConfig) {
      saveWorkspaceConfig(existingByProjectPath.rootPath, {
        ...existingConfig,
        name: workspace.name,
        slug: generateSlug(workspace.name),
        defaults,
      });
    }

    const updated: Workspace = {
      ...existingByProjectPath,
      name: workspace.name,
      ...(workspace.remoteServer && { remoteServer: workspace.remoteServer }),
    };
    const existingIndex = config.workspaces.indexOf(existingByProjectPath);
    config.workspaces[existingIndex] = updated;
    saveConfig(config);
    return updated;
  }

  const slug = extractWorkspaceSlugFromPath(inputRootPath, '');

  // Check if workspace with same rootPath already exists
  const existing = config.workspaces.find(w => w.rootPath === inputRootPath);
  if (existing) {
    // Update existing workspace with new settings
    const updated: Workspace = {
      ...existing,
      ...workspace,
      rootPath: inputRootPath,
      slug,
      id: existing.id,
      createdAt: existing.createdAt,
    };
    const existingIndex = config.workspaces.indexOf(existing);
    config.workspaces[existingIndex] = updated;
    saveConfig(config);
    return updated;
  }

  const newWorkspace: Workspace = {
    ...workspace,
    rootPath: inputRootPath,
    slug,
    id: generateWorkspaceId(),
    createdAt: Date.now(),
  };

  const reservedPaths = new Set(config.workspaces.map(w => resolve(w.rootPath)));

  const shouldStoreInManagedWorkspace =
    !isManagedWorkspacePath(newWorkspace.rootPath) &&
    (!isValidWorkspace(newWorkspace.rootPath) || looksLikeUserProjectDirectory(newWorkspace.rootPath));

  if (shouldStoreInManagedWorkspace) {
    migrateExternalProjectWorkspace(newWorkspace, reservedPaths, true);
  } else if (!isValidWorkspace(newWorkspace.rootPath)) {
    createWorkspaceAtPath(newWorkspace.rootPath, newWorkspace.name, undefined, {
      ...(newWorkspace.kind ? { kind: newWorkspace.kind } : {}),
      ...(newWorkspace.isProtected !== undefined ? { isProtected: newWorkspace.isProtected } : {}),
    });
  }

  config.workspaces.push(newWorkspace);

  // If this is the only workspace, make it active
  if (config.workspaces.length === 1) {
    config.activeWorkspaceId = newWorkspace.id;
  }

  saveConfig(config);
  return newWorkspace;
}

/**
 * Sync workspaces by discovering workspaces in the default location
 * that aren't already tracked in the global config.
 * Call this on app startup.
 */
export function syncWorkspaces(): void {
  const config = loadStoredConfig();
  if (!config) return;

  const discoveredPaths = discoverWorkspacesInDefaultLocation();
  const trackedPaths = new Set(config.workspaces.map(w => w.rootPath));

  let added = false;
  for (const rootPath of discoveredPaths) {
    if (trackedPaths.has(rootPath)) continue;

    // Load the workspace config to get name
    const wsConfig = loadWorkspaceConfig(rootPath);
    if (!wsConfig) continue;

    const newWorkspace: Workspace = {
      id: wsConfig.id || generateWorkspaceId(),
      name: wsConfig.name,
      slug: extractWorkspaceSlugFromPath(rootPath, ''),
      rootPath,
      kind: wsConfig.kind,
      isProtected: wsConfig.isProtected,
      pinned: wsConfig.pinned,
      createdAt: wsConfig.createdAt || Date.now(),
    };

    config.workspaces.push(newWorkspace);
    added = true;
  }

  if (added) {
    // If no active workspace, set to first
    if (!config.activeWorkspaceId && config.workspaces.length > 0) {
      config.activeWorkspaceId = config.workspaces[0]!.id;
    }
    saveConfig(config);
  }
}

export async function removeWorkspace(workspaceId: string): Promise<boolean> {
  const config = loadStoredConfig();
  if (!config) return false;

  const index = config.workspaces.findIndex(w => w.id === workspaceId);
  if (index === -1) return false;

  const workspace = config.workspaces[index]!;
  if (isProtectedStoredWorkspace(workspace)) {
    return false;
  }

  config.workspaces.splice(index, 1);

  // If we removed the active workspace, switch to first available
  if (config.activeWorkspaceId === workspaceId) {
    config.activeWorkspaceId = config.workspaces[0]?.id || null;
  }

  saveConfig(config);

  // Clean up credential store credentials for this workspace
  const manager = getCredentialManager();
  await manager.deleteWorkspaceCredentials(workspaceId);

  // Delete workspace data directory (sessions, plans, etc.)
  const workspaceDataDir = join(WORKSPACES_DIR, workspaceId);
  if (existsSync(workspaceDataDir)) {
    try {
      rmSync(workspaceDataDir, { recursive: true });
    } catch (error) {
      console.error(`[storage] Failed to delete workspace data directory: ${workspaceDataDir}`, error);
    }
  }

  return true;
}

// Note: renameWorkspace() was removed - workspace names are now stored only in folder config
// Use updateWorkspaceSetting('name', ...) to rename workspaces via the folder config

// ============================================
// Workspace Conversation Persistence
// ============================================

function ensureWorkspaceDir(workspaceId: string): string {
  const dir = join(WORKSPACES_DIR, workspaceId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}


// Re-export types from core for convenience
export type { StoredAttachment, StoredMessage } from '@craft-agent/core/types';

export interface WorkspaceConversation {
  messages: StoredMessage[];
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    contextTokens: number;
    costUsd: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  savedAt: number;
}

// Save workspace conversation (messages + token usage)
export function saveWorkspaceConversation(
  workspaceId: string,
  messages: StoredMessage[],
  tokenUsage: WorkspaceConversation['tokenUsage']
): void {
  const dir = ensureWorkspaceDir(workspaceId);
  const filePath = join(dir, 'conversation.json');

  const conversation: WorkspaceConversation = {
    messages,
    tokenUsage,
    savedAt: Date.now(),
  };

  try {
    writeFileSync(filePath, JSON.stringify(conversation, null, 2), 'utf-8');
  } catch (e) {
    // Handle cyclic structures or other serialization errors
    console.error(`[storage] [CYCLIC STRUCTURE] Failed to save workspace conversation:`, e);
    console.error(`[storage] Message count: ${messages.length}, message types: ${messages.map(m => m.type).join(', ')}`);
    // Try to save with sanitized messages
    try {
      const sanitizedMessages = messages.map((m, i) => {
        let safeToolInput = m.toolInput;
        if (m.toolInput) {
          try {
            JSON.stringify(m.toolInput);
          } catch (inputErr) {
            console.error(`[storage] [CYCLIC STRUCTURE] in message ${i} toolInput (tool: ${m.toolName}), keys: ${Object.keys(m.toolInput).join(', ')}, error: ${inputErr}`);
            safeToolInput = { error: '[non-serializable input]' };
          }
        }
        return { ...m, toolInput: safeToolInput };
      });
      const sanitizedConversation: WorkspaceConversation = {
        messages: sanitizedMessages,
        tokenUsage,
        savedAt: Date.now(),
      };
      writeFileSync(filePath, JSON.stringify(sanitizedConversation, null, 2), 'utf-8');
      console.error(`[storage] Saved sanitized workspace conversation successfully`);
    } catch (e2) {
      console.error(`[storage] Failed to save even sanitized workspace conversation:`, e2);
    }
  }
}

// Load workspace conversation
export function loadWorkspaceConversation(workspaceId: string): WorkspaceConversation | null {
  const filePath = join(WORKSPACES_DIR, workspaceId, 'conversation.json');

  try {
    if (!existsSync(filePath)) {
      return null;
    }
    return readJsonFileSync<WorkspaceConversation>(filePath);
  } catch {
    return null;
  }
}

// Get workspace data directory path
export function getWorkspaceDataPath(workspaceId: string): string {
  return join(WORKSPACES_DIR, workspaceId);
}

// Clear workspace conversation
export function clearWorkspaceConversation(workspaceId: string): void {
  const filePath = join(WORKSPACES_DIR, workspaceId, 'conversation.json');
  if (existsSync(filePath)) {
    writeFileSync(filePath, '{}', 'utf-8');
  }

  // Also clear any active plan (plans are session-scoped)
  clearWorkspacePlan(workspaceId);
}

// ============================================
// Plan Storage (Session-Scoped)
// Plans are stored per-workspace and cleared with /clear
// ============================================

/**
 * Save a plan for a workspace.
 * Plans are session-scoped - they persist during the session but are
 * cleared when the user runs /clear or starts a new session.
 */
export function saveWorkspacePlan(workspaceId: string, plan: Plan): void {
  const dir = ensureWorkspaceDir(workspaceId);
  const filePath = join(dir, 'plan.json');
  writeFileSync(filePath, JSON.stringify(plan, null, 2), 'utf-8');
}

/**
 * Load the current plan for a workspace.
 * Returns null if no plan exists.
 */
export function loadWorkspacePlan(workspaceId: string): Plan | null {
  const filePath = join(WORKSPACES_DIR, workspaceId, 'plan.json');

  try {
    if (!existsSync(filePath)) {
      return null;
    }
    return readJsonFileSync<Plan>(filePath);
  } catch {
    return null;
  }
}

/**
 * Clear the plan for a workspace.
 * Called when user runs /clear or cancels a plan.
 */
export function clearWorkspacePlan(workspaceId: string): void {
  const filePath = join(WORKSPACES_DIR, workspaceId, 'plan.json');
  if (existsSync(filePath)) {
    rmSync(filePath);
  }
}

// ============================================
// Session Input Drafts
// Persists composer state (text + attachments) per session across app restarts.
// Two shapes for attachments:
//  - Track P: { path, name } — absolute path captured via webUtils.getPathForFile
//    (file-picker / OS drag). Re-read on hydrate via file:readUserAttachment RPC.
//  - Track C: { path, name, content } — inline content for paste / web-drag Files
//    that never existed on disk. Hydrate reconstructs directly from the stored bytes.
// ============================================

const DRAFTS_FILE = join(CONFIG_DIR, 'drafts.json');

export interface DraftAttachmentContent {
  type: 'image' | 'pdf' | 'text' | 'office' | 'unknown';
  mimeType: string;
  size: number;
  base64?: string;
  text?: string;
  thumbnailBase64?: string;
}

export interface DraftAttachmentRef {
  path: string;
  name: string;
  /** Inline content for attachments without a real filesystem path (paste, web-drag).
   *  When present, hydrate reconstructs from these bytes and skips any disk read. */
  content?: DraftAttachmentContent;
}

export interface SessionDraft {
  text: string;
  attachments?: DraftAttachmentRef[];
}

interface DraftsData {
  drafts: Record<string, SessionDraft>;
  updatedAt: number;
}

const ATTACHMENT_CONTENT_TYPES = new Set(['image', 'pdf', 'text', 'office', 'unknown']);

function isAbsoluteDraftPath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  return false;
}

function isDraftAttachmentContent(value: unknown): value is DraftAttachmentContent {
  if (!value || typeof value !== 'object') return false;
  const c = value as DraftAttachmentContent;
  if (!ATTACHMENT_CONTENT_TYPES.has(c.type as string)) return false;
  if (typeof c.mimeType !== 'string') return false;
  if (typeof c.size !== 'number') return false;
  if (c.base64 !== undefined && typeof c.base64 !== 'string') return false;
  if (c.text !== undefined && typeof c.text !== 'string') return false;
  if (c.thumbnailBase64 !== undefined && typeof c.thumbnailBase64 !== 'string') return false;
  return true;
}

function isDraftAttachmentRef(value: unknown): value is DraftAttachmentRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as DraftAttachmentRef;
  if (typeof ref.path !== 'string' || typeof ref.name !== 'string') return false;
  if (ref.content !== undefined && !isDraftAttachmentContent(ref.content)) return false;
  // Post-migration guard: refs without content MUST have an absolute path. This rejects
  // the broken 0.8.11 shape (synthetic path === filename, no content) on first load —
  // user sees empty drafts once instead of attachments silently disappearing forever.
  if (ref.content === undefined && !isAbsoluteDraftPath(ref.path)) return false;
  return true;
}

function isSessionDraft(value: unknown): value is SessionDraft {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as SessionDraft;
  if (typeof candidate.text !== 'string') return false;
  if (candidate.attachments !== undefined) {
    if (!Array.isArray(candidate.attachments)) return false;
    if (!candidate.attachments.every(isDraftAttachmentRef)) return false;
  }
  return true;
}

function isEmptyDraft(draft: SessionDraft): boolean {
  return !draft.text && (!draft.attachments || draft.attachments.length === 0);
}

/**
 * Load all drafts from disk. Entries that don't parse as SessionDraft
 * (e.g. pre-upgrade string drafts) are discarded silently.
 */
function loadDraftsData(): DraftsData {
  try {
    if (!existsSync(DRAFTS_FILE)) {
      return { drafts: {}, updatedAt: 0 };
    }
    const raw = readJsonFileSync<{ drafts?: Record<string, unknown>; updatedAt?: number }>(DRAFTS_FILE);
    const drafts: Record<string, SessionDraft> = {};
    for (const [sessionId, value] of Object.entries(raw.drafts ?? {})) {
      if (isSessionDraft(value)) {
        drafts[sessionId] = value;
      }
    }
    return { drafts, updatedAt: raw.updatedAt ?? 0 };
  } catch {
    return { drafts: {}, updatedAt: 0 };
  }
}

function saveDraftsData(data: DraftsData): void {
  ensureConfigDir();
  data.updatedAt = Date.now();
  writeFileSync(DRAFTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Get the persisted draft for a session (text + attachment refs).
 */
export function getSessionDraft(sessionId: string): SessionDraft | null {
  const data = loadDraftsData();
  return data.drafts[sessionId] ?? null;
}

/**
 * Set the draft for a session. Empty drafts (no text and no attachments)
 * are removed from disk.
 */
export function setSessionDraft(sessionId: string, draft: SessionDraft): void {
  const data = loadDraftsData();
  if (isEmptyDraft(draft)) {
    delete data.drafts[sessionId];
  } else {
    data.drafts[sessionId] = {
      text: draft.text,
      ...(draft.attachments && draft.attachments.length > 0
        ? { attachments: draft.attachments.map(normalizeDraftAttachment) }
        : {}),
    };
  }
  saveDraftsData(data);
}

function normalizeDraftAttachment(ref: DraftAttachmentRef): DraftAttachmentRef {
  const base: DraftAttachmentRef = { path: ref.path, name: ref.name };
  if (ref.content && isDraftAttachmentContent(ref.content)) {
    const c = ref.content;
    base.content = {
      type: c.type,
      mimeType: c.mimeType,
      size: c.size,
      ...(c.base64 !== undefined ? { base64: c.base64 } : {}),
      ...(c.text !== undefined ? { text: c.text } : {}),
      ...(c.thumbnailBase64 !== undefined ? { thumbnailBase64: c.thumbnailBase64 } : {}),
    };
  }
  return base;
}

export function deleteSessionDraft(sessionId: string): void {
  const data = loadDraftsData();
  delete data.drafts[sessionId];
  saveDraftsData(data);
}

/**
 * Get all drafts as a record keyed by sessionId.
 */
export function getAllSessionDrafts(): Record<string, SessionDraft> {
  const data = loadDraftsData();
  return data.drafts;
}

// ============================================
// Theme Storage (App-level only)
// ============================================

import type { ThemeOverrides, ThemeFile, PresetTheme } from './theme.ts';
import { readdirSync } from 'fs';

const APP_THEME_FILE = join(CONFIG_DIR, 'theme.json');
const APP_THEMES_DIR = join(CONFIG_DIR, 'themes');

/**
 * Get the path to the app-level theme override file (~/.craft-agent/theme.json).
 */
export function getAppThemePath(): string {
  return APP_THEME_FILE;
}

// Track if preset themes have been synced this session (prevents re-init on hot reload)
let presetsInitialized = false;

/**
 * Get the app-level themes directory.
 * Preset themes are stored at ~/.craft-agent/themes/
 */
export function getAppThemesDir(): string {
  return APP_THEMES_DIR;
}

/**
 * Load app-level theme overrides
 */
export function loadAppTheme(): ThemeOverrides | null {
  try {
    if (!existsSync(APP_THEME_FILE)) {
      return null;
    }
    return readJsonFileSync<ThemeOverrides>(APP_THEME_FILE);
  } catch {
    return null;
  }
}

/**
 * Save app-level theme overrides
 */
export function saveAppTheme(theme: ThemeOverrides): void {
  ensureConfigDir();
  writeFileSync(APP_THEME_FILE, JSON.stringify(theme, null, 2), 'utf-8');
}


// ============================================
// Preset Themes (app-level)
// ============================================

/**
 * Sync bundled preset themes to disk on launch.
 * Preserves user customizations:
 * - If file doesn't exist → copy from bundle
 * - If file exists but is invalid/corrupt → copy from bundle (auto-heal)
 * - If file exists and is valid → skip (preserve user changes)
 *
 * User-created custom theme files (with non-bundled filenames) are untouched.
 * User color overrides live in theme.json (separate file) and are never touched.
 */
export function ensurePresetThemes(): void {
  // Skip if already initialized this session (prevents re-init on hot reload)
  if (presetsInitialized) {
    return;
  }
  presetsInitialized = true;

  const themesDir = getAppThemesDir();

  // Create themes directory if it doesn't exist
  if (!existsSync(themesDir)) {
    mkdirSync(themesDir, { recursive: true });
  }

  // Resolve bundled themes directory via shared asset resolver
  const bundledThemesDir = getBundledAssetsDir('themes');
  if (!bundledThemesDir) {
    return;
  }

  // Copy bundled preset themes to disk, preserving user customizations.
  // - If file doesn't exist → copy from bundle
  // - If file exists but is invalid/corrupt → copy from bundle (auto-heal)
  // - If file exists and is valid → skip (preserve user changes)
  try {
    const bundledFiles = readdirSync(bundledThemesDir).filter(f => f.endsWith('.json'));
    for (const file of bundledFiles) {
      const srcPath = join(bundledThemesDir, file);
      const destPath = join(themesDir, file);

      // Skip if file exists and is valid (preserve user customizations)
      if (existsSync(destPath) && isValidThemeFile(destPath)) {
        continue;
      }

      // Copy from bundle (new file or auto-heal corrupt file)
      const content = readFileSync(srcPath, 'utf-8');
      writeFileSync(destPath, content, 'utf-8');
    }
  } catch {
    // Ignore errors - themes are optional
  }
}

/**
 * Load all preset themes from app themes directory.
 * Returns array of PresetTheme objects sorted by name.
 */
export function loadPresetThemes(): PresetTheme[] {
  ensurePresetThemes();

  const themesDir = getAppThemesDir();
  if (!existsSync(themesDir)) {
    return [];
  }

  const themes: PresetTheme[] = [];

  try {
    const files = readdirSync(themesDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const id = file.replace('.json', '');
      const path = join(themesDir, file);
      try {
        const theme = readJsonFileSync<ThemeFile>(path);
        // Resolve relative backgroundImage paths to file:// URLs
        const resolvedTheme = resolveThemeBackgroundImage(theme, path);
        themes.push({ id, path, theme: resolvedTheme });
      } catch {
        // Skip invalid theme files
      }
    }
  } catch {
    return [];
  }

  // Sort by name (default first, then alphabetically)
  return themes.sort((a, b) => {
    if (a.id === 'default') return -1;
    if (b.id === 'default') return 1;
    return (a.theme.name || a.id).localeCompare(b.theme.name || b.id);
  });
}

/**
 * Get MIME type from file extension for data URL encoding.
 */
function getMimeType(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

/**
 * Resolve relative backgroundImage paths to data URLs.
 * If the backgroundImage is a relative path (no protocol), resolve it relative to the theme's directory,
 * read the file, and convert it to a data URL. This is necessary because the renderer process
 * cannot access file:// URLs directly when running on localhost in dev mode.
 * @param theme - Theme object to process
 * @param themePath - Absolute path to the theme's JSON file
 */
function resolveThemeBackgroundImage(theme: ThemeFile, themePath: string): ThemeFile {
  if (!theme.backgroundImage) {
    return theme;
  }

  // Check if it's already an absolute URL (has protocol like http://, https://, data:)
  const hasProtocol = /^[a-z][a-z0-9+.-]*:/i.test(theme.backgroundImage);
  if (hasProtocol) {
    return theme;
  }

  // It's a relative path - resolve it relative to the theme's directory
  const themeDir = dirname(themePath);
  const absoluteImagePath = join(themeDir, theme.backgroundImage);

  // Read the file and convert to data URL so renderer can use it
  // (file:// URLs are blocked in renderer when running on localhost)
  try {
    if (!existsSync(absoluteImagePath)) {
      console.warn(`Theme background image not found: ${absoluteImagePath}`);
      return theme;
    }

    const imageBuffer = readFileSync(absoluteImagePath);
    const base64 = imageBuffer.toString('base64');
    const mimeType = getMimeType(absoluteImagePath);
    const dataUrl = `data:${mimeType};base64,${base64}`;

    return {
      ...theme,
      backgroundImage: dataUrl,
    };
  } catch (error) {
    console.warn(`Failed to read theme background image: ${absoluteImagePath}`, error);
    return theme;
  }
}

/**
 * Load a specific preset theme by ID.
 * @param id - Theme ID (filename without .json)
 */
export function loadPresetTheme(id: string): PresetTheme | null {
  const themesDir = getAppThemesDir();
  const path = join(themesDir, `${id}.json`);

  if (!existsSync(path)) {
    return null;
  }

  try {
    const theme = readJsonFileSync<ThemeFile>(path);
    // Resolve relative backgroundImage paths to file:// URLs
    const resolvedTheme = resolveThemeBackgroundImage(theme, path);
    return { id, path, theme: resolvedTheme };
  } catch {
    return null;
  }
}

/**
 * Get the path to the app-level preset themes directory.
 */
export function getPresetThemesDir(): string {
  return getAppThemesDir();
}

/**
 * Reset a preset theme to its bundled default.
 * Copies the bundled version over the user's version.
 * Resolves bundled path automatically via getBundledAssetsDir('themes').
 * @param id - Theme ID to reset
 */
export function resetPresetTheme(id: string): boolean {
  // Resolve bundled themes directory via shared asset resolver
  const bundledThemesDir = getBundledAssetsDir('themes');
  if (!bundledThemesDir) {
    return false;
  }

  const bundledPath = join(bundledThemesDir, `${id}.json`);
  const themesDir = getAppThemesDir();
  const destPath = join(themesDir, `${id}.json`);

  if (!existsSync(bundledPath)) {
    return false;
  }

  try {
    const content = readFileSync(bundledPath, 'utf-8');
    if (!existsSync(themesDir)) {
      mkdirSync(themesDir, { recursive: true });
    }
    writeFileSync(destPath, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// ============================================
// Color Theme Selection (stored in config)
// ============================================

/**
 * Get the currently selected color theme ID.
 * Returns 'default' if not set.
 */
export function getColorTheme(): string {
  const config = loadStoredConfig();
  if (config?.colorTheme !== undefined) {
    return config.colorTheme;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.colorTheme;
}

/**
 * Set the color theme ID.
 */
export function setColorTheme(themeId: string): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.colorTheme = themeId;
  saveConfig(config);
}

// ============================================
// Auto-Update Dismissed Version
// ============================================

/**
 * Get the dismissed update version.
 * Returns null if no version is dismissed.
 */
export function getDismissedUpdateVersion(): string | null {
  const config = loadStoredConfig();
  return config?.dismissedUpdateVersion ?? null;
}

/**
 * Set the dismissed update version.
 * Pass the version string to dismiss notifications for that version.
 */
export function setDismissedUpdateVersion(version: string): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.dismissedUpdateVersion = version;
  saveConfig(config);
}

/**
 * Clear the dismissed update version.
 * Call this when a new version is released (or on successful update).
 */
export function clearDismissedUpdateVersion(): void {
  const config = loadStoredConfig();
  if (!config) return;
  delete config.dismissedUpdateVersion;
  saveConfig(config);
}

// ============================================
// LLM Connections
// ============================================

// Re-export types for convenience (imports are at top of file)
export type {
  LlmConnection,
  LlmProviderType,
  LlmAuthType,
  LlmConnectionWithStatus,
} from './llm-connections.ts';

function normalizeModelIds(models?: Array<{ id: string } | string>): string[] {
  if (!models) return [];
  return models
    .map(m => typeof m === 'string' ? m : m.id)
    .filter((id): id is string => !!id && id.trim().length > 0);
}

function modelSetEquals(a: string[], b: string[]): boolean {
  const as = new Set(a);
  const bs = new Set(b);
  if (as.size !== bs.size) return false;
  for (const id of as) {
    if (!bs.has(id)) return false;
  }
  return true;
}

function stripQwenRuntimeModelFields(connection: LlmConnection): void {
  if (connection.providerType !== 'qwen') return;
  delete connection.models;
  delete connection.defaultModel;
  delete connection.modelSelectionMode;
}

export function inferModelSelectionMode(
  connection: Pick<LlmConnection, 'models'>,
  providerDefaultModelIds: string[],
): 'automaticallySyncedFromProvider' | 'userDefined3Tier' {
  const currentIds = normalizeModelIds(connection.models);
  if (currentIds.length === 0) return 'automaticallySyncedFromProvider';
  return modelSetEquals(currentIds, providerDefaultModelIds)
    ? 'automaticallySyncedFromProvider'
    : 'userDefined3Tier';
}

function migrateModelDefaultsToConnections(config: StoredConfig): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configAny = config as any;
  if (!configAny.modelDefaults) return false;
  delete configAny.modelDefaults;
  return true;
}

function createQwenCodeConnection(existing?: Partial<LlmConnection>): LlmConnection {
  return {
    slug: QWEN_CODE_CONNECTION_SLUG,
    name: 'Qwen Code',
    providerType: 'qwen',
    authType: 'none',
    createdAt: existing?.createdAt ?? Date.now(),
    lastUsedAt: existing?.lastUsedAt,
  };
}

function cleanupRemovedConnectionCredentials(removedConnectionSlugs: string[]): void {
  for (const slug of removedConnectionSlugs) {
    getCredentialManager().deleteLlmCredentials(slug).catch((error) => {
      console.error(`[storage] Failed to delete credentials for removed connection '${slug}':`, error);
    });
  }
}

function clearWorkspaceDefaultConnectionReferences(): boolean {
  let changed = false;
  try {
    const workspaces = getWorkspaces();
    for (const ws of workspaces) {
      const wsConfig = loadWorkspaceConfig(ws.rootPath);
      if (wsConfig?.defaults?.defaultLlmConnection) {
        delete wsConfig.defaults.defaultLlmConnection;
        saveWorkspaceConfig(ws.rootPath, wsConfig);
        changed = true;
      }
    }
  } catch (error) {
    console.error('Failed to clean up workspace default connection references:', error);
  }
  return changed;
}

function normalizeToQwenCodeOnly(target: StoredConfig): boolean {
  const previousConnections = target.llmConnections ?? [];
  const existingQwen = previousConnections.find(c => c.slug === QWEN_CODE_CONNECTION_SLUG)
    ?? previousConnections.find(c => c.providerType === 'qwen');
  const qwenConnection = createQwenCodeConnection(existingQwen);
  const removedConnectionSlugs = previousConnections
    .filter(c => c.slug !== QWEN_CODE_CONNECTION_SLUG && c.providerType !== 'qwen')
    .map(c => c.slug);

  let changed = previousConnections.length !== 1
    || JSON.stringify(previousConnections[0] ?? null) !== JSON.stringify(qwenConnection)
    || target.defaultLlmConnection !== QWEN_CODE_CONNECTION_SLUG;

  target.llmConnections = [qwenConnection];
  target.defaultLlmConnection = QWEN_CODE_CONNECTION_SLUG;

  cleanupRemovedConnectionCredentials(removedConnectionSlugs);
  changed = clearWorkspaceDefaultConnectionReferences() || changed;
  return changed;
}

/**
 * Collapse any legacy provider configuration to the single built-in Qwen Code backend.
 * Call this on app startup before any getLlmConnections() calls.
 */
export function migrateLegacyLlmConnectionsConfig(): void {
  const config = loadStoredConfig();
  if (!config) return;

  let needsSave = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configAny = config as any;
  for (const field of [
    'authType',
    'customModel',
    'model',
    'modelDefaults',
    'providerType',
    'customEndpoint',
  ]) {
    if (field in configAny) {
      delete configAny[field];
      needsSave = true;
    }
  }

  if (normalizeToQwenCodeOnly(config)) {
    needsSave = true;
  }

  if (needsSave) {
    saveConfig(config);
  }
}

/**
 * Fix defaultLlmConnection references that point to non-existent connections.
 * This can happen when a connection is removed or was never created.
 *
 * Fixes both the global defaultLlmConnection and per-workspace defaults.
 * Called on app startup alongside other migrations.
 */
export function migrateOrphanedDefaultConnections(): void {
  const config = loadStoredConfig();
  if (!config) return;
  if (!config.llmConnections || config.llmConnections.length === 0) return;

  let changed = false;

  // Fix global default if it points to a non-existent connection
  if (ensureDefaultLlmConnection(config)) {
    changed = true;
  }

  // Fix workspace defaults that point to non-existent connections
  try {
    const workspaces = getWorkspaces();
    for (const ws of workspaces) {
      const wsConfig = loadWorkspaceConfig(ws.rootPath);
      if (wsConfig?.defaults?.defaultLlmConnection) {
        const exists = config.llmConnections.some(
          c => c.slug === wsConfig.defaults!.defaultLlmConnection
        );
        if (!exists) {
          delete wsConfig.defaults.defaultLlmConnection;
          saveWorkspaceConfig(ws.rootPath, wsConfig);
        }
      }
    }
  } catch (error) {
    console.error('Failed to clean up workspace default connection references:', error);
  }

  if (changed) {
    saveConfig(config);
  }
}

/**
 * Ensure default LLM connection is set correctly.
 * Called internally by write operations to fix inconsistent state.
 * This is NOT called on read - reads never modify config.
 */
function ensureDefaultLlmConnection(config: StoredConfig): boolean {
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return false;
  }

  const defaultExists = config.llmConnections.some(c => c.slug === config.defaultLlmConnection);
  if (!config.defaultLlmConnection || !defaultExists) {
    config.defaultLlmConnection = config.llmConnections[0]!.slug;
    return true;
  }

  return false;
}

/**
 * Migrate legacy global credentials to LLM connection-scoped credentials.
 * This ensures that credentials saved before the LLM connections system
 * are available through the new connection-based auth.
 *
 * Called on app startup (async operation, credentials use encrypted storage).
 *
 * Qwen Code uses the local backend runtime, so there are no app-managed
 * provider credentials to migrate.
 */
export async function migrateLegacyCredentials(): Promise<void> {
  const debug = (await import('../utils/debug.ts')).debug;
  debug('[storage] LLM credential migration skipped for Qwen-only backend');
}

/**
 * Get all LLM connections.
 * Returns only user-added connections (no auto-populated built-ins).
 *
 * Note: This function is read-only and never modifies config.
 * Call migrateLegacyLlmConnectionsConfig() on app startup to handle migration.
 */
export function getLlmConnections(): LlmConnection[] {
  const config = loadStoredConfig();
  if (!config) return [];

  // Return empty array if not migrated yet - caller should call migration on startup
  return config.llmConnections || [];
}

/**
 * Get a specific LLM connection by slug.
 * @param slug - Connection slug
 * @returns Connection or null if not found
 */
export function getLlmConnection(slug: string): LlmConnection | null {
  const connections = getLlmConnections();
  return connections.find(c => c.slug === slug) || null;
}

/**
 * Add a new LLM connection.
 * @param connection - Connection to add (slug must be unique)
 * @returns true if added, false if slug already exists
 */
export function addLlmConnection(connection: LlmConnection): boolean {
  const config = loadStoredConfig();
  if (!config) return false;

  // Initialize array if not yet migrated (safe default for write operations)
  if (!config.llmConnections) {
    config.llmConnections = [];
  }

  // Check for duplicate slug
  if (config.llmConnections.some(c => c.slug === connection.slug)) {
    return false;
  }

  // Add connection with timestamp
  const connectionToAdd: LlmConnection = {
    ...connection,
    createdAt: connection.createdAt || Date.now(),
  };
  stripQwenRuntimeModelFields(connectionToAdd);
  config.llmConnections.push(connectionToAdd);

  // Ensure default is set after adding first connection
  ensureDefaultLlmConnection(config);

  saveConfig(config);
  return true;
}

/**
 * Update an existing LLM connection.
 * @param slug - Connection slug to update
 * @param updates - Partial updates to apply (slug is ignored)
 * @returns true if updated, false if not found
 */
export function updateLlmConnection(slug: string, updates: Partial<Omit<LlmConnection, 'slug'>>): boolean {
  const config = loadStoredConfig();
  if (!config) return false;

  // No connections means nothing to update
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return false;
  }

  const connections = config.llmConnections;
  const index = connections.findIndex(c => c.slug === slug);
  if (index === -1) return false;

  const existing = connections[index]!;
  connections[index] = {
    slug: existing.slug,
    name: updates.name ?? existing.name,
    providerType: 'qwen',
    authType: 'none',
    createdAt: updates.createdAt ?? existing.createdAt,
    lastUsedAt: updates.lastUsedAt !== undefined ? updates.lastUsedAt : existing.lastUsedAt,
  };

  const updated = connections[index]!;
  stripQwenRuntimeModelFields(updated);

  saveConfig(config);
  return true;
}

/**
 * Delete an LLM connection.
 * @param slug - Connection slug to delete
 * @returns true if deleted, false if not found
 */
export function deleteLlmConnection(slug: string): boolean {
  const config = loadStoredConfig();
  if (!config) return false;

  // No connections means nothing to delete
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return false;
  }

  const connections = config.llmConnections;
  const index = connections.findIndex(c => c.slug === slug);
  if (index === -1) return false;

  connections.splice(index, 1);

  // If deleted connection was the default, reset to first remaining or clear
  if (config.defaultLlmConnection === slug) {
    config.defaultLlmConnection = connections.length > 0 ? connections[0]!.slug : undefined;
  }

  saveConfig(config);

  // Clean up workspace references to the deleted connection (non-blocking)
  try {
    const workspaces = getWorkspaces();
    for (const ws of workspaces) {
      const wsConfig = loadWorkspaceConfig(ws.rootPath);
      if (wsConfig?.defaults?.defaultLlmConnection === slug) {
        wsConfig.defaults.defaultLlmConnection = undefined;
        saveWorkspaceConfig(ws.rootPath, wsConfig);
      }
    }
  } catch (error) {
    console.error('Failed to clean up workspace references:', error);
  }

  // Clean up stored credentials for this connection (API keys, OAuth tokens)
  // This is fire-and-forget but we log errors for debugging
  const credentialManager = getCredentialManager();
  credentialManager.delete({ type: 'llm_api_key', connectionSlug: slug }).catch((error) => {
    console.error(`[storage] Failed to delete API key credential for connection '${slug}':`, error);
  });
  credentialManager.delete({ type: 'llm_oauth', connectionSlug: slug }).catch((error) => {
    console.error(`[storage] Failed to delete OAuth credential for connection '${slug}':`, error);
  });

  return true;
}

/**
 * Get the default LLM connection slug.
 * @returns Default connection slug, or null if no connections exist
 */
export function getDefaultLlmConnection(): string | null {
  const config = loadStoredConfig();
  if (!config) return null;

  // If no connections, return null
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return null;
  }

  return config.defaultLlmConnection || config.llmConnections[0]?.slug || null;
}

/**
 * Set the default LLM connection.
 * @param slug - Connection slug to set as default
 * @returns true if set, false if connection not found
 */
export function setDefaultLlmConnection(slug: string): boolean {
  const config = loadStoredConfig();
  if (!config) return false;

  // No connections means nothing to set as default
  if (!config.llmConnections || config.llmConnections.length === 0) {
    return false;
  }

  // Verify connection exists
  if (!config.llmConnections.some(c => c.slug === slug)) {
    return false;
  }

  config.defaultLlmConnection = slug;
  saveConfig(config);
  return true;
}

/**
 * Get the app-level default thinking level for new sessions.
 * Falls back to bundled config-defaults when unset.
 */
export function getDefaultThinkingLevel(): ThinkingLevel {
  const config = loadStoredConfig();
  if (config?.defaultThinkingLevel) {
    const normalized = normalizeThinkingLevel(config.defaultThinkingLevel);
    if (normalized) return normalized;
  }
  const defaults = loadConfigDefaults();
  return normalizeThinkingLevel(defaults.workspaceDefaults.thinkingLevel) ?? 'medium';
}

/**
 * Set the app-level default thinking level for new sessions.
 * @returns true if persisted, false if config could not be loaded
 */
export function setDefaultThinkingLevel(level: ThinkingLevel): boolean {
  const config = loadStoredConfig();
  if (!config) return false;

  config.defaultThinkingLevel = level;
  saveConfig(config);
  return true;
}

/**
 * Update the lastUsedAt timestamp for a connection.
 * @param slug - Connection slug
 */
export function touchLlmConnection(slug: string): void {
  const config = loadStoredConfig();
  if (!config) return;

  // No connections means nothing to touch
  if (!config.llmConnections) return;

  const connection = config.llmConnections.find(c => c.slug === slug);
  if (connection) {
    connection.lastUsedAt = Date.now();
    saveConfig(config);
  }
}

// ============================================
// Network Proxy Settings
// ============================================

import type { NetworkProxySettings } from './types.ts';

function normalizeProxyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeNetworkProxySettings(
  settings: NetworkProxySettings,
): NetworkProxySettings {
  return {
    enabled: Boolean(settings.enabled),
    httpProxy: normalizeProxyString(settings.httpProxy),
    httpsProxy: normalizeProxyString(settings.httpsProxy),
    noProxy: normalizeProxyString(settings.noProxy),
  };
}

/**
 * Get the current network proxy settings.
 * Returns undefined if not configured.
 */
export function getNetworkProxySettings(): NetworkProxySettings | undefined {
  const config = loadStoredConfig();
  return config?.networkProxy;
}

/**
 * Persist network proxy settings.
 * Deletes the key when disabled and all proxy fields are empty.
 */
export function setNetworkProxySettings(settings: NetworkProxySettings): void {
  const config = loadStoredConfig();
  if (!config) return;

  const normalized = normalizeNetworkProxySettings(settings);

  // Remove the key entirely when proxy is disabled and all fields are blank
  if (!normalized.enabled && !normalized.httpProxy && !normalized.httpsProxy && !normalized.noProxy) {
    delete config.networkProxy;
  } else {
    config.networkProxy = normalized;
  }

  saveConfig(config);
}

// ============================================
// Setup Deferred (user skipped onboarding)
// ============================================

export function isSetupDeferred(): boolean {
  return loadStoredConfig()?.setupDeferred === true;
}

export function setSetupDeferred(deferred: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  if (deferred) {
    config.setupDeferred = true;
  } else {
    delete config.setupDeferred;
  }
  saveConfig(config);
}

// ============================================
// Tool Icons (CLI tool icons for turn card display)
// ============================================

import { copyFileSync } from 'fs';

const TOOL_ICONS_DIR_NAME = 'tool-icons';

/**
 * Returns the path to the tool-icons directory: ~/.craft-agent/tool-icons/
 */
export function getToolIconsDir(): string {
  return join(CONFIG_DIR, TOOL_ICONS_DIR_NAME);
}

/**
 * Ensure tool-icons directory exists and has bundled defaults.
 * Resolves bundled path automatically via getBundledAssetsDir('tool-icons').
 * Copies bundled tool-icons.json and icon files on first run.
 * Only copies files that don't already exist (preserves user customizations).
 */
export function ensureToolIcons(): void {
  const toolIconsDir = getToolIconsDir();

  // Create tool-icons directory if it doesn't exist
  if (!existsSync(toolIconsDir)) {
    mkdirSync(toolIconsDir, { recursive: true });
  }

  // Resolve bundled tool-icons directory via shared asset resolver
  const bundledToolIconsDir = getBundledAssetsDir('tool-icons');
  if (!bundledToolIconsDir) {
    return;
  }

  // Copy each bundled file if it doesn't exist in the target dir
  // This includes tool-icons.json and all icon files (png, ico, svg, jpg)
  try {
    const bundledFiles = readdirSync(bundledToolIconsDir);
    for (const file of bundledFiles) {
      const destPath = join(toolIconsDir, file);
      if (!existsSync(destPath)) {
        const srcPath = join(bundledToolIconsDir, file);
        copyFileSync(srcPath, destPath);
      }
    }
  } catch {
    // Ignore errors — tool icons are optional enhancement
  }
}

// ============================================
// Server Mode Configuration
// ============================================

import { DEFAULT_SERVER_CONFIG, type ServerConfig } from './server-config.ts';
import { randomUUID } from 'crypto';

/**
 * Get the current server configuration.
 * Returns defaults if not yet configured.
 */
export function getServerConfig(): ServerConfig {
  const config = loadStoredConfig();
  return config?.serverConfig ?? { ...DEFAULT_SERVER_CONFIG };
}

/**
 * Persist server configuration.
 * Auto-generates a stable auth token on first enable if none exists.
 */
export function setServerConfig(serverConfig: ServerConfig): void {
  const config = loadStoredConfig();
  if (!config) return;

  // Generate a stable token when first enabled (or if token is missing)
  if (serverConfig.enabled && !serverConfig.token) {
    serverConfig.token = randomUUID();
  }

  config.serverConfig = serverConfig;
  saveConfig(config);
}
