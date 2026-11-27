/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_IGNORE_FILE, BRAND_KEYCHAIN_PREFIX } from './brand.js';

export interface FileFilteringOptions {
  respectGitIgnore: boolean;
  respectBrandIgnore: boolean;
  /** @deprecated Recursive @ completion no longer limits its candidate set. */
  maxFileCount?: number;
  searchTimeout?: number;
  customIgnoreFilePaths: string[];
}

// For memory files
export const DEFAULT_MEMORY_FILE_FILTERING_OPTIONS: FileFilteringOptions = {
  respectGitIgnore: false,
  respectBrandIgnore: true,
  maxFileCount: 20000,
  searchTimeout: 5000,
  customIgnoreFilePaths: [],
};

// For all other files
export const DEFAULT_FILE_FILTERING_OPTIONS: FileFilteringOptions = {
  respectGitIgnore: true,
  respectBrandIgnore: true,
  maxFileCount: 20000,
  searchTimeout: 5000,
  customIgnoreFilePaths: [],
};

// Generic exclusion file name (canonical name from brand.ts)
export const BRAND_IGNORE_FILE_NAME = BRAND_IGNORE_FILE;

// Extension integrity constants
export const INTEGRITY_FILENAME = 'extension_integrity.json';
export const INTEGRITY_KEY_FILENAME = 'integrity.key';
export const KEYCHAIN_SERVICE_NAME = `${BRAND_KEYCHAIN_PREFIX}-extension-integrity`;
export const SECRET_KEY_ACCOUNT = 'secret-key';
