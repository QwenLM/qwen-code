/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export * from './types.js';
export * from './base-token-storage.js';
export * from './hybrid-token-storage.js';
export * from './keychain-token-storage.js';
import {
  BRAND_OAUTH_SERVICE,
  ENV_FORCE_ENCRYPTED_FILE_STORAGE,
} from '../../config/brand.js';

export const DEFAULT_SERVICE_NAME = BRAND_OAUTH_SERVICE;
export const FORCE_ENCRYPTED_FILE_ENV_VAR = ENV_FORCE_ENCRYPTED_FILE_STORAGE;
