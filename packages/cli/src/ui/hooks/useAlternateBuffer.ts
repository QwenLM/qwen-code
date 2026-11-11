/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useConfig } from '../contexts/ConfigContext.js';
import { isAlternateBufferEnabled } from '../../utils/alternateBuffer.js';

export { isAlternateBufferEnabled } from '../../utils/alternateBuffer.js';

// This is read from Config so that the UI reads the same value per application session
export const useAlternateBuffer = (): boolean => {
  const config = useConfig();
  return isAlternateBufferEnabled(config);
};
