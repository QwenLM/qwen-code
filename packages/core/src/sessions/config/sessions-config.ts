/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Keep the sessions entry point on Core's config-root resolution, validation
 * and cache. Import the utility directly to avoid loading the Core barrel.
 */
export {
  getConfigHomeDir,
  getConfigHomeDirOverride,
  getUserConfigDisplayPath,
  setConfigHomeDirOverride as setConfigHomeDir,
  _resetConfigHomeDirCache as resetConfigHomeDirCache,
} from '../../utils/paths.js';
