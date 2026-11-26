/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export { AppFramework } from './src/framework/appFramework.js';
export type {
  FrameworkInitInput,
  FrameworkMode,
} from './src/framework/appFramework.js';
export type { EntryFramework } from './src/framework/entryFramework.js';
export { disposeInOrder } from './src/framework/resourceInitialization.js';
export { createMcpManagerSettings } from './src/mcp/framework.js';
export { AsyncInitializer } from './src/framework/asyncInitializer.js';
export { TuiAppFramework } from './src/framework/tuiAppFramework.js';
export type {
  AppContainerComponent,
  AppContainerProps,
} from './src/ui/AppContainerProps.js';
export { AcpAppFramework } from './src/framework/acpAppFramework.js';
export { SdkAppFramework } from './src/framework/sdkAppFramework.js';
export { HeadlessAppFramework } from './src/framework/headlessAppFramework.js';
export { DaemonAppFramework } from './src/framework/daemonAppFramework.js';
export { RemoteWorkerAppFramework } from './src/framework/remoteWorkerAppFramework.js';
export { CommandAppFramework } from './src/framework/commandAppFramework.js';
export type { ConfiguredStartupContext } from './src/startup/startupContext.js';
export type { StartupCoordinator } from './src/startup/startupCoordinator.js';
export { resolveProxyFromSettings } from './src/utils/proxySettings.js';

export { AppPluginRegistry } from './src/app-plugins/registry.js';
export type {
  SessionPort,
  SessionChange,
  SessionMessageInput,
  SessionSubmitOptions,
  SessionMessageState,
  SessionMessageSource,
  SessionEvent,
  SessionRestoreState,
  AssistantStreamDelta,
  SessionUserContent,
  SessionToolResult,
} from './src/session/sessionPort.js';

export { createSessionMessageChannel } from './src/session/sessionMessageChannel.js';
export type { SessionMessageChannel } from './src/session/sessionMessageChannel.js';

export type {
  SessionHandle,
  SessionState,
  SessionActivityState,
  SessionUpdate,
  SessionApproval,
  SessionAccessState,
  SessionSettingsChange,
  SessionHistoryRecord,
  SessionModeChoice,
  SessionSettings,
} from './src/session/session.js';
export type {
  LocalSessionHandle,
  SessionExecutionState,
  SessionExecutionUpdate,
} from './src/session/localSession.js';
export type { SessionModelInfo } from './src/session/sessionModels.js';
export { parseSessionModels } from './src/session/sessionModels.js';
export { projectSessionListedModels } from './src/session/buildSessionModelList.js';

/** Shared configuration loading for product-owned command actions. */
export { loadCliConfig } from './src/config/config.js';
export {
  getSettingsResolveOptions,
  restoreLoadedEnvironment,
} from './src/config/settings.js';
