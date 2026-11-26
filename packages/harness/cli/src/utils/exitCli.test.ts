/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { exitCli } from './exitCli.js';
import { gracefulExit } from './cleanup.js';

vi.mock('./cleanup.js', () => ({
  gracefulExit: vi.fn().mockResolvedValue(undefined),
}));

describe('exitCli', () => {
  it('should gracefully exit with default exit code 0', async () => {
    await exitCli();
    expect(gracefulExit).toHaveBeenCalledWith(0, {
      exitReason: 'natural_end',
    });
  });

  it('should gracefully exit with the specified exit code', async () => {
    await exitCli(1);
    expect(gracefulExit).toHaveBeenCalledWith(1, {
      exitReason: 'error',
    });
  });
});
