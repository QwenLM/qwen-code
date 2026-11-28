/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LoadedSettings, LoadedSettingsHost } from './loadedSettings.js';
import type { Settings, MergedSettings } from './settingsSchema.js';
import type { CommentJsonPath } from './commentJson.js';
import type { ZodType } from 'zod';

/** Command-facing values; the supplied product schema validates known fields. */
export interface SettingsValues {
  [key: string]: unknown;
  security?: { [key: string]: unknown; folderTrust?: { enabled?: boolean } };
  permissions?: {
    [key: string]: unknown;
    trustDirectories?: string[];
    additionalDirectories?: string[];
  };
  mcpServers?: Record<string, Record<string, unknown>>;
  mcp?: {
    [key: string]: unknown;
    allowed?: string[];
    excluded?: string[];
    enableAllProjectMcpServers?: boolean;
    enabledProjectMcpServers?: string[];
    disabledProjectMcpServers?: string[];
  };
  skills?: {
    [key: string]: unknown;
    enabled?: boolean;
    loadFromAgentsDirectory?: boolean;
    disabled?: string[];
    disableShellExecution?: boolean;
  };
  enabledPlugins?: Record<string, boolean>;
  extraKnownMarketplaces?: Record<
    string,
    { source: string; type: string; ref?: string }
  >;
  strictKnownMarketplaces?: boolean;
  blockedMarketplaces?: string[];
  skillOverrides?: Record<string, string>;
}

export type SettingsSource = 'user' | 'project' | 'local';

export interface InitializeSettingsOptions {
  userConfigDir: string;
  /** Explicit host-bound file, including nonstandard filenames. */
  userSettingsPath?: string;
  /** Project-relative config directory; defaults to .qwen. */
  projectConfigDirName?: string;
  /** 企业托管策略文件；只读，不参与普通设置合并。 */
  policySettingsPath?: string;
}

export interface SettingsRuntimeContext {
  /** Effective host home directory; defaults to the OS home. */
  homeDir?: string;
  onWriteError?: (operation: 'save' | 'update', error: unknown) => void;
  onSettingsChanged?: () => void;
  /** Called only after a transaction changes a file on disk. */
  onSettingsPersisted?: () => void;
  headless?: boolean | (() => boolean);
  /** Product compatibility rules and effects; file loading stays in the service. */
  hideUntrustedProject?: boolean;
  /** Sessions retain file-source TTL; command reads request fresh project text. */
  refreshProjectSources?: boolean;
  /** Session trust is adopted explicitly; command projections recompute it. */
  recomputeTrust?: boolean;
  resolveTrust?: (settings: Settings, projectPath: string, headless: boolean) => boolean;
  mergeSettings?: LoadedSettingsHost['merge'];
  normalizeDisplaySettings?: (settings: Settings) => void;
  loadEnvironment?: (
    settings: MergedSettings,
    projectPath: string,
    /** Only explicit non-interactive reads override the host env trust policy. */
    trustedOverride?: boolean,
  ) => void;
  onResolved?: (settings: LoadedSettings) => void;
  /** Preserve the host's fatal-configuration error classification. */
  createFatalError?: (message: string) => Error;
  onWarning?: LoadedSettingsHost['onWarning'];
  onError?: LoadedSettingsHost['onError'];
  onInfrastructureError?: LoadedSettingsHost['onInfrastructureError'];
  /** .env is applied only when an environment object is provided. */
  environment?: NodeJS.ProcessEnv;
}

export interface ResolveSettingsOptions {
  /** Per-read execution mode; omitted reads retain the host default. */
  headless?: boolean;
  /** Project root, not its configuration directory. */
  projectPath: string;
  /** Defaults to all sources; [] excludes all file layers. */
  sources?: readonly SettingsSource[];
  /** Parsed overrides or an explicit file path (relative to projectPath). */
  flagSettings?: SettingsValues | string;
}

export interface SettingsFile {
  path: string;
  settings: SettingsValues;
  /** Normalized file values before validation recovery and environment expansion. */
  originalSettings: SettingsValues;
  rawJson?: string;
  /** Disabled sources must not become writable when adopted by a session. */
  readOnly?: boolean;
  loadRejected?: boolean;
}

export interface SettingsError {
  path: string;
  message: string;
  severity: 'warning';
}

export type SettingsScope = SettingsSource | Capitalize<SettingsSource>;
export interface SettingsMutationEditor {
  get(path: CommentJsonPath): unknown;
  set(path: CommentJsonPath, value: unknown): boolean;
  delete(path: CommentJsonPath): boolean;
  update(
    path: CommentJsonPath,
    updater: (current: unknown) => unknown,
  ): boolean;
}

/** Product schema data, shared with the existing CLI schema during migration. */
export interface SettingsDefinition {
  validation: ZodType;
  schema: Record<string, SettingsFieldDefinition>;
}
export interface SettingsFieldDefinition {
  default?: unknown;
  properties?: Record<string, SettingsFieldDefinition>;
  mergeStrategy?: 'replace' | 'concat' | 'union' | 'shallow_merge';
  additionalProperties?: {
    type?: string;
    ref?: string;
    mergeStrategy?: 'replace' | 'concat' | 'union' | 'shallow_merge';
  };
}
