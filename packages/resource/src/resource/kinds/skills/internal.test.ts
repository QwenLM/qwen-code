/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from './internal.js';

describe('skill logger', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('does not write to the console unless QWEN_RESOURCES_DEBUG is set', () => {
    vi.stubEnv('QWEN_RESOURCES_DEBUG', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    logger.warn('collision');
    logger.debug('trace');

    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it('writes to the console when QWEN_RESOURCES_DEBUG is set', () => {
    vi.stubEnv('QWEN_RESOURCES_DEBUG', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    logger.warn('collision');
    logger.debug('trace');

    expect(warn).toHaveBeenCalledWith('collision');
    expect(debug).toHaveBeenCalledWith('trace');
  });
});
