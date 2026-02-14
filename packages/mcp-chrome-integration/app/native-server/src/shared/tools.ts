/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Tool } from '@modelcontextprotocol/sdk/types.js';

// Re-export tool names
export { TOOL_NAMES } from './tool-names.js';

// Import all schemas
import { BASIC_SCHEMAS } from './browser-basic-schemas.js';
import { ELEMENT_SCHEMAS } from './browser-element-schemas.js';
import { PAGE_SCHEMAS } from './browser-page-schemas.js';
import { NETWORK_SCHEMAS } from './browser-network-schemas.js';
import { BOOKMARK_SCHEMAS } from './browser-bookmark-schemas.js';
import { ADVANCED_SCHEMAS } from './browser-advanced-schemas.js';
import { PERFORMANCE_SCHEMAS } from './browser-performance-schemas.js';

// Re-export schema modules
export { BASIC_SCHEMAS } from './browser-basic-schemas.js';
export { ELEMENT_SCHEMAS } from './browser-element-schemas.js';
export { PAGE_SCHEMAS } from './browser-page-schemas.js';
export { NETWORK_SCHEMAS } from './browser-network-schemas.js';
export { BOOKMARK_SCHEMAS } from './browser-bookmark-schemas.js';
export { ADVANCED_SCHEMAS } from './browser-advanced-schemas.js';
export { PERFORMANCE_SCHEMAS } from './browser-performance-schemas.js';

export const TOOL_SCHEMAS: Tool[] = [
  ...BASIC_SCHEMAS,
  ...ELEMENT_SCHEMAS,
  ...PAGE_SCHEMAS,
  ...NETWORK_SCHEMAS,
  ...BOOKMARK_SCHEMAS,
  ...ADVANCED_SCHEMAS,
  ...PERFORMANCE_SCHEMAS,
];
