/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Product-facing installation boundary. Native program mutations go through
 * NativeInstallationService; version-store, extraction and entry-switching
 * primitives are deliberately not exported here.
 *
 * New cross-package exports are private by default: reviewers must identify a
 * real caller, check existing entries and ensure it cannot bypass the service.
 * Source facts, PATH tools and an externally held lock remain independent.
 * These comments express intent; they do not enforce package access.
 */

export { createNativeInstallation } from './src/installation/nativeInstallationService.js';
export { createManualUpdateProgress } from './src/installation/manualUpdateProgress.js';
export type {
  NativeOperation,
  NativeStage,
  NativeEvent,
  NativeInstallationResult,
  NativeInstallationService,
  NativeInstallationDependencies,
  NativeInstallOptions,
  NativeReleaseSelection,
  ReleasePolicy,
} from './src/installation/nativeInstallationService.js';
// Finite layout input to the service; the store implementing it stays internal.
export type { NativePaths } from './src/installation/nativeVersionStore.js';
// Source facts are usable before product plugins initialize.
export {
  createInstallationSource,
  getInstallationIdentity,
  readInstallSourceMarker,
  PackageManager,
} from './src/installation/source.js';
export type {
  InstallationInfo,
  InstallationIdentity,
} from './src/installation/source.js';
// The CLI holds one lock across selection, native execution and product bookkeeping.
export { createUpdateLock } from './src/installation/update/updateLock.js';
export { compareVersions } from './src/installation/versions.js';
// Product release selection reads metadata; artifact execution stays in the service.
export {
  fetchManifest,
  fetchVersionManifest,
  fetchLatestVersion,
  pickFile,
} from './src/installation/update/manifest.js';
export { checkForUpdates } from './src/installation/update/packageVersion.js';
export {
  AUTO_UPDATE_DELAY_MS,
  AUTO_UPDATE_PAUSE_DURATION_MS,
  LOCAL_VERSION_FILENAME,
  MAX_KEPT_VERSIONS,
} from './src/installation/update/updateTypes.js';
export type {
  BinaryUpdateInfo,
  ManifestFile,
  ManifestJSON,
  UpdateType,
} from './src/installation/update/updateTypes.js';
export {
  readUpdateStage,
  readErrorCode,
  tagUpdateStage,
} from './src/installation/update/updateErrors.js';
export type { UpdateStage } from './src/installation/update/updateErrors.js';
export {
  classifyError,
  extractErrorInfo,
} from './src/installation/install/installTypes.js';
export type {
  InstallErrorCategory,
  InstallPathKind,
  InstallStep,
  PathConfigResult,
  SystemInfo,
} from './src/installation/install/installTypes.js';
// Dispatcher history belongs to the server; these tools only manage shell/registry PATH.
export {
  configurePATHUnix,
  selectRCFile,
} from './src/installation/install/pathConfig.js';
export {
  configurePATHWindows,
  MAX_USER_PATH_LENGTH,
  readRegistryPath,
  writeRegistryPath,
  broadcastSettingChange,
} from './src/installation/install/pathConfigWindows.js';
export {
  collectSystemInfo,
  detectDiskSpace,
  detectShell,
} from './src/installation/install/systemInfo.js';
