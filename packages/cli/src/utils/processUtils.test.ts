/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RELAUNCH_EXIT_CODE,
  UPDATE_RELAUNCH_STATE_PATH_ENV_VAR,
  UPDATE_RELAUNCH_EXIT_CODE,
  UPDATE_RELAUNCH_SUPPORTED_ENV_VAR,
  canRelaunchForUpdate,
  prepareUpdateRelaunch,
  relaunchApp,
  relaunchForUpdate,
} from './processUtils.js';
import * as cleanup from './cleanup.js';
import type { Config } from '@qwen-code/qwen-code-core';

describe('processUtils', () => {
  const processExit = vi
    .spyOn(process, 'exit')
    .mockReturnValue(undefined as never);
  const runExitCleanup = vi.spyOn(cleanup, 'runExitCleanup');
  const originalSend = process.send;
  const originalSupported = process.env[UPDATE_RELAUNCH_SUPPORTED_ENV_VAR];
  const originalStatePath = process.env[UPDATE_RELAUNCH_STATE_PATH_ENV_VAR];

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env[UPDATE_RELAUNCH_SUPPORTED_ENV_VAR];
    delete process.env[UPDATE_RELAUNCH_STATE_PATH_ENV_VAR];
  });

  afterEach(() => {
    process.send = originalSend;
    if (originalSupported === undefined) {
      delete process.env[UPDATE_RELAUNCH_SUPPORTED_ENV_VAR];
    } else {
      process.env[UPDATE_RELAUNCH_SUPPORTED_ENV_VAR] = originalSupported;
    }
    if (originalStatePath === undefined) {
      delete process.env[UPDATE_RELAUNCH_STATE_PATH_ENV_VAR];
    } else {
      process.env[UPDATE_RELAUNCH_STATE_PATH_ENV_VAR] = originalStatePath;
    }
  });

  it('should run cleanup and exit with the relaunch code', async () => {
    await relaunchApp();
    expect(runExitCleanup).toHaveBeenCalledTimes(1);
    expect(processExit).toHaveBeenCalledWith(RELAUNCH_EXIT_CODE);
  });

  it('should run cleanup and exit with the update relaunch code', async () => {
    await relaunchForUpdate();
    expect(runExitCleanup).toHaveBeenCalledTimes(1);
    expect(processExit).toHaveBeenCalledWith(UPDATE_RELAUNCH_EXIT_CODE);
  });

  it('detects an update relaunch supervisor', () => {
    process.env[UPDATE_RELAUNCH_SUPPORTED_ENV_VAR] = 'true';
    process.env[UPDATE_RELAUNCH_STATE_PATH_ENV_VAR] = '/tmp/relaunch.json';

    expect(canRelaunchForUpdate()).toBe(true);
  });

  it('does not infer a supervisor from IPC alone', () => {
    process.send = vi.fn();

    expect(canRelaunchForUpdate()).toBe(false);
  });

  it('writes the resumed session before exiting for an update', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-update-state-'));
    const statePath = path.join(dir, 'state.json');
    process.env[UPDATE_RELAUNCH_SUPPORTED_ENV_VAR] = 'true';
    process.env[UPDATE_RELAUNCH_STATE_PATH_ENV_VAR] = statePath;

    try {
      await relaunchForUpdate('123e4567-e89b-12d3-a456-426614174000');

      expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual({
        sessionId: '123e4567-e89b-12d3-a456-426614174000',
        skipInitialPrompt: true,
      });
      expect(processExit).toHaveBeenCalledWith(UPDATE_RELAUNCH_EXIT_CODE);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('only resumes sessions that have a durable transcript', async () => {
    const getSessionLocation = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('active');
    const config = {
      getChatRecordingService: () => ({ flush: vi.fn() }),
      getSessionId: () => '123e4567-e89b-12d3-a456-426614174000',
      getSessionService: () => ({ getSessionLocation }),
    } as unknown as Config;

    await expect(prepareUpdateRelaunch(config, false)).resolves.toEqual({
      skipInitialPrompt: false,
    });
    await expect(prepareUpdateRelaunch(config, true)).resolves.toEqual({
      sessionId: '123e4567-e89b-12d3-a456-426614174000',
      skipInitialPrompt: true,
    });
    getSessionLocation.mockResolvedValueOnce(undefined);
    await expect(prepareUpdateRelaunch(config, true)).resolves.toBeNull();
  });

  it('does not resume a stale transcript when recording is disabled', async () => {
    const getSessionLocation = vi.fn().mockResolvedValue('active');
    const config = {
      getChatRecordingService: () => undefined,
      getSessionId: () => '123e4567-e89b-12d3-a456-426614174000',
      getSessionService: () => ({ getSessionLocation }),
    } as unknown as Config;

    await expect(prepareUpdateRelaunch(config, true)).resolves.toBeNull();
    expect(getSessionLocation).not.toHaveBeenCalled();
  });

  it('preserves whether a fresh initial prompt was already consumed', async () => {
    const config = {
      getChatRecordingService: () => ({ flush: vi.fn() }),
      getSessionId: () => '123e4567-e89b-12d3-a456-426614174000',
      getSessionService: () => ({
        getSessionLocation: vi.fn().mockResolvedValue(undefined),
      }),
    } as unknown as Config;

    await expect(prepareUpdateRelaunch(config, false, true)).resolves.toEqual({
      skipInitialPrompt: true,
    });
  });
});
