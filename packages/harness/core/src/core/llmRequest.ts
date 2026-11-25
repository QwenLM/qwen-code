/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type PartListUnion } from '@google/genai';
import { partToString } from '../utils/partUtils.js';
export function partListUnionToString(value: PartListUnion): string {
  return partToString(value, { verbose: true });
}
