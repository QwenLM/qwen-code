/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Core Utilities - Unified Export Module
 *
 * This module provides a single entry point for all core utilities.
 * Prefer importing from this module instead of individual files.
 *
 * Example:
 *   import { isInBundledMode, feature } from './utils/index.js';
 */

// Runtime detection utilities
export {
  isInBundledMode,
  isRunningWithBun,
  isDevelopmentMode,
  getRuntimeMode,
  getBuildTarget,
  getEmbeddedFile,
  listEmbeddedFiles,
} from './bundledMode.js';

// Feature flags
export {
  feature,
  getEnabledFeatures,
  type FeatureName,
} from './bundle-features.js';

// Fast mode utilities
export {
  isFastModeAvailable,
  getFastModeUnavailableReason,
  fastSpawn,
} from './fastMode.js';
