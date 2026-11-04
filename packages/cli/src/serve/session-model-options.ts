/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SESSION_MODEL_PERSIST_DEFAULT_META_KEY } from '@qwen-code/acp-bridge/bridgeTypes';

export function parseSessionModelMetadata(params: Record<string, unknown>): {
  metadata?: Record<string, unknown>;
  error?: string;
} {
  const persistDefault = params['persistDefault'];
  if (persistDefault !== undefined && typeof persistDefault !== 'boolean') {
    return { error: '`persistDefault` must be a boolean when provided' };
  }
  const rawMetadata = params['_meta'];
  if (
    rawMetadata !== undefined &&
    (rawMetadata === null ||
      typeof rawMetadata !== 'object' ||
      Array.isArray(rawMetadata))
  ) {
    return { error: '`_meta` must be an object when provided' };
  }
  const metadata = rawMetadata as Record<string, unknown> | undefined;
  const legacy = metadata?.[SESSION_MODEL_PERSIST_DEFAULT_META_KEY];
  if (legacy !== undefined && typeof legacy !== 'boolean') {
    return { error: 'Model persistence metadata must be a boolean' };
  }
  if (
    persistDefault !== undefined &&
    legacy !== undefined &&
    persistDefault !== legacy
  ) {
    return {
      error: '`persistDefault` conflicts with model persistence metadata',
    };
  }
  return persistDefault === undefined
    ? { ...(metadata ? { metadata } : {}) }
    : {
        metadata: {
          ...metadata,
          [SESSION_MODEL_PERSIST_DEFAULT_META_KEY]: persistDefault,
        },
      };
}
