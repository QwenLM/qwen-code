/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The package has exactly one entry point, and that is load-bearing rather than
 * stylistic. Several modules behind this entry keep process-wide mutable state:
 * the Skill load-error sink drained by `drainSkillLoadErrors`, the checked-dir
 * cache behind `clearCheckedSkillDirs`, and the internal-write table behind
 * `markInternalWrite`. The bundler inlines each entry's whole dependency graph,
 * so a second entry would ship a second copy of that state — a consumer mixing
 * entries would mark a write in one table and look it up in the other.
 */

// Resource lifecycle
export { ProjectResource } from './resource/core/projectResource.js';
export { UserResource } from './resource/core/userResource.js';
export { ResourceService } from './resource/core/resourceService.js';
export type { ResourceHandle } from './resource/core/resourceService.js';
export type {
  ProjectResourceOptions,
  ResourceAgentSettings,
  ResourceSkillSettings,
  ResourceWorkspaceContext,
} from './resource/core/projectResource.js';
export type { UserResourceOptions } from './resource/core/userResource.js';
export type {
  AgentResourceSnapshot,
  AgentResourceView,
  OutputStyleResourceSnapshot,
  OutputStyleResourceView,
  SkillResourceSnapshot,
  SkillResourceView,
} from './resource/core/resourceViews.js';
export type {
  ResourceChangeEvent,
  ResourceKind,
  ResourceOperation,
  ResourceSource,
} from './resource/core/types.js';

// File watching
export {
  ChokidarFileWatcher,
  FileSystemWatcher,
  createFileWatcher,
  createNoopFileWatcher,
  NoopFileWatcher,
} from './file-watcher/fileWatcher.js';
export type {
  FileChangeEvent,
  FileChangeListener,
  FileChangeOperation,
  FileWatcher,
  FileWatcherOptions,
  WatchRequest,
} from './file-watcher/fileWatcher.js';
export { markInternalWrite } from './file-watcher/internalWrites.js';

// Skill file I/O
export {
  drainSkillLoadErrors,
  extractDescriptionFromBody,
  FRONTMATTER_REGEX,
  loadSkillFromFile,
  loadSkillsFromCommandsDir,
  loadSkillsFromDir,
  parseFrontmatter,
  resolveSkillDir,
} from './resource/kinds/skills/skillLoader.js';
export type {
  LoadSkillsFromDirOptions,
  SkillScanLimits,
} from './resource/kinds/skills/skillLoader.js';
export {
  clearCheckedSkillDirs,
  discoverSkillDirsForPaths,
} from './resource/kinds/skills/discoverSkillDirs.js';
export type { DiscoverSkillDirsOptions } from './resource/kinds/skills/discoverSkillDirs.js';
export type {
  EffortLevel,
  EffortValue,
  FrontmatterShell,
  ParsedFrontmatter,
  SkillArgument,
  SkillDefinition,
  SkillLoadError,
  SkillSource,
} from './resource/kinds/skills/types.js';

// Agent file I/O
export {
  AgentLoadError,
  loadAgentFromFile,
  loadAgentsFromDirectory,
  loadAgentsFromPath,
  parseAgentMarkdown,
} from './resource/kinds/agents/agentLoader.js';
export type { AgentLoadOptions } from './resource/kinds/agents/agentLoader.js';
export { AGENT_COLORS, AGENT_KINDS } from './resource/kinds/agents/types.js';
export type {
  AgentColor,
  AgentEffortValue,
  AgentHook,
  AgentHooks,
  AgentKind,
  AgentLoadResult,
  AgentMcpServerConfig,
  AgentMcpServerSpec,
  AgentPathLoadResult,
  AgentResourceDefinition,
  AgentResourceLoadError,
  AgentResourceSource,
} from './resource/kinds/agents/types.js';

// OutputStyle file I/O
export {
  loadOutputStylesFromDir,
  loadOutputStylesFromPath,
} from './resource/kinds/outputStyles/outputStyleLoader.js';
export type {
  OutputStyleConfig,
  OutputStyleSource,
  OutputStyleLoadError,
  OutputStyleLoadOptions,
} from './resource/kinds/outputStyles/types.js';

// Settings raw file sources
export {
  SettingsFileSource,
  UserSettingsSource,
  invalidateSettingsFileSources,
  invalidateUserSettingsSources,
} from './settings/settingsFileSource.js';
export type { SettingsFileChangeEvent } from './settings/settingsFileSource.js';
export { mutateSettingsFile } from './settings/settingsPersistence.js';
export type {
  SettingsFileMutation,
  SettingsMutationOptions,
  SettingsWriteResult,
} from './settings/settingsPersistence.js';

// Scoped settings for independently migrated command and session consumers.
export { SettingsService } from './settings/settingsService.js';
export type {
  SettingsValues,
  SettingsSource,
  ResolveSettingsOptions,
  InitializeSettingsOptions,
  SettingsRuntimeContext,
  SettingsDefinition,
  SettingsFieldDefinition,
  SettingsFile,
  SettingsError,
  SettingsMutationEditor,
  SettingsScope,
} from './settings/settingsTypes.js';

export {
  deleteCommentJsonProperty,
  getCommentJsonProperty,
  setCommentJsonProperty,
  toPlainJsonValue,
  type CommentJsonPath,
  type CommentedRecord,
} from './settings/commentJson.js';

export { resolveEnvVarsInObject } from './settings/settingsEnvironment.js';

export { LoadedSettings, SettingScope } from './settings/loadedSettings.js';
export type {
  LoadableSettingScope,
  LoadedSettingsFile,
  LoadedSettingsError,
  LoadedSettingsSnapshot,
  LoadedSettingsHost,
  SettingsFileSources,
} from './settings/loadedSettings.js';

export * from './settings/permissionMode.js';

export * from './settings/settingsSchema.js';

export { AuthType, AuthProviderType } from './settings/settingsEnums.js';
export type { SessionRetentionSettings } from './settings/settingsValueTypes.js';

export {
  originalHookSettingsPath,
  rememberHookArrayRemoval,
} from './settings/hookSettingsProvenance.js';
