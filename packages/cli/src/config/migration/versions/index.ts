/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Migration version registry.
 *
 * This module exports all migrations in version order.
 * Add new migrations here when introducing new schema versions.
 */

import type { Migration } from '../types.js';
import { migrateV1ToV2 } from './v1-to-v2.js';
import { migrateV2ToV3 } from './v2-to-v3.js';

/**
 * Array of all migrations in version order.
 *
 * Index 0: V1 → V2
 * Index 1: V2 → V3
 * Index 2: V3 → V4 (future)
 * etc.
 */
export const MIGRATIONS: Array<Migration<unknown, unknown>> = [
  migrateV1ToV2 as Migration<unknown, unknown>,
  migrateV2ToV3 as Migration<unknown, unknown>,
];

// Re-export individual migrations for direct use
export { migrateV1ToV2 } from './v1-to-v2.js';
export { migrateV2ToV3 } from './v2-to-v3.js';
