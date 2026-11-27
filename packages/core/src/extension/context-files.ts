/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AGENT_CONTEXT_FILENAME,
  DEFAULT_CONTEXT_FILENAME,
} from '../utils/memory-constants.js';
import type { Extension } from './extensionManager.js';

export function getExtensionContextFileNames(
  extension: Pick<Extension, 'config' | 'format' | 'installMetadata'>,
): string[] {
  const configured = extension.config.contextFileName;
  if (configured && configured.length !== 0) {
    return Array.isArray(configured) ? configured : [configured];
  }

  const origin = extension.installMetadata?.originSource;
  if (
    extension.format === 'agent-plugins-v1' ||
    (origin && origin !== 'QwenCode')
  ) {
    return [DEFAULT_CONTEXT_FILENAME];
  }
  return [DEFAULT_CONTEXT_FILENAME, AGENT_CONTEXT_FILENAME];
}
