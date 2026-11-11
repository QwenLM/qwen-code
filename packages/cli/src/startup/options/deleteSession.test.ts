/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exitWithInputError } from './exitLifecycle.js';
import { runDeleteSessionOption } from './deleteSession.js';
import { deleteSession } from '../../utils/sessions.js';

vi.mock('./exitLifecycle.js', () => ({
  exitSuccessfully: vi.fn(),
  exitWithInputError: vi.fn(),
}));
vi.mock('../../utils/sessions.js', () => ({
  deleteSession: vi.fn(),
}));

describe('runDeleteSessionOption', () => {
  type OptionContext = Parameters<typeof runDeleteSessionOption>[0];
  type OptionCoordinator = Parameters<typeof runDeleteSessionOption>[1];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exitWithInputError).mockResolvedValue(undefined as never);
  });

  it('exits with an input error without an identifier', async () => {
    const config = {};
    const startupCoordinator = {} as OptionCoordinator;
    const context = {
      phase: 'configured',
      config,
    } as unknown as OptionContext;

    await runDeleteSessionOption(context, startupCoordinator, undefined);

    expect(exitWithInputError).toHaveBeenCalledWith(
      config,
      startupCoordinator,
      '--delete-session requires a session identifier',
      'gemini.deleteSession',
    );
    expect(deleteSession).not.toHaveBeenCalled();
  });
});
