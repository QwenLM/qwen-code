/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_FIXED_ENV_PREFIX } from '../config/brand.js';

/** Replaces characters that are unsafe in a persisted task path segment. */
export function sanitizeTaskPathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-');
}

export function resolveTaskListId(options: {
  sessionId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = options.env ?? process.env;
  return sanitizeTaskPathSegment(
    env[`${BRAND_FIXED_ENV_PREFIX}TASK_LIST_ID`] || options.sessionId,
  );
}
