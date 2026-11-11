/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Host-owned settings/update-display types used by installation products.
 * Runtime exit and update events already live at @qwen-code/qwen-code; reuse that
 * entry. Do not add execution helpers or commercial runtime forwarding here.
 * New exports require an actual host caller and boundary review, not just a move.
 * This comment documents intent rather than enforcing access.
 */
export type { InstallationSettings } from './src/installation/settings.js';
export type { UpdateObject } from './src/ui/utils/updateCheck.js';
