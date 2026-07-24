/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runMcp = vi.hoisted(() => vi.fn());

vi.mock('./mcp.js', () => ({ runMcp }));

let previousExitCode: string | number | undefined;

beforeEach(() => {
  vi.resetModules();
  runMcp.mockReset();
  previousExitCode = process.exitCode;
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
});

describe('external context startup', () => {
  it('prints sanitized configuration errors', async () => {
    const { ConfigurationError } = await import('./config.js');
    runMcp.mockRejectedValue(
      new ConfigurationError('External context config is not valid JSON.'),
    );
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await import('./main.js');

    expect(write).toHaveBeenCalledWith(
      '[external-context] External context config is not valid JSON.\n',
    );
    expect(process.exitCode).toBe(1);
  });

  it('keeps unexpected startup errors opaque', async () => {
    runMcp.mockRejectedValue(new Error('/secret/path and credential'));
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await import('./main.js');

    expect(write).toHaveBeenCalledWith(
      '[external-context] External context startup failed.\n',
    );
  });
});
