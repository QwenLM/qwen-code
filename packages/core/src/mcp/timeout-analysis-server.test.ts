/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';

describe('Timeout Analysis MCP Server', () => {
  it('should export startTimeoutServer function', async () => {
    const { startTimeoutServer } = await import('./timeout-analysis-server.js');
    expect(typeof startTimeoutServer).toBe('function');
  });

  it('should start the server without errors', async () => {
    const { startTimeoutServer } = await import('./timeout-analysis-server.js');
    await expect(startTimeoutServer()).resolves.not.toThrow();
  });
});
