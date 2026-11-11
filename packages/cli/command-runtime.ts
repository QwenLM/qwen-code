/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Existing host services for standalone product commands; the root entry stays lightweight. */
export { exitCli } from './src/utils/exitCli.js';
export {
  downloadFile,
  verifySHA256,
  enforceHTTPS,
} from './src/installation/update/manifest.js';
