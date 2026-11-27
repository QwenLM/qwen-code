/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENV_AGENT_SDK_ENTRYPOINT,
  ENV_REMOTE_WORKER,
  isRemoteWorkerMode,
} from '@qwen-code/core';
import { getHeadlessPermissionPromptMode } from './headlessPermissionPrompt.js';

describe('getHeadlessPermissionPromptMode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['sdk-ts', undefined, false, undefined],
    ['sdk-ts', 'stdio', true, undefined],
    ['sdk-ts', 'StDiO', true, undefined],
    ['sdk-ts', 'permission_check', false, 'permission_check'],
    ['', undefined, true, undefined],
  ] as const)(
    '权限通道遵循 SDK 回调声明：entrypoint=%s prompt=%s',
    (entrypoint, permissionPromptTool, installStdioPermissionHandler, namedPermissionPromptTool) => {
      vi.stubEnv(ENV_AGENT_SDK_ENTRYPOINT, entrypoint);
      vi.stubEnv(ENV_REMOTE_WORKER, '');

      expect(getHeadlessPermissionPromptMode({
        inputFormat: 'stream-json',
        permissionPromptTool,
      })).toEqual({
        useStdioPermissionPrompt: namedPermissionPromptTool === undefined,
        installStdioPermissionHandler,
        namedPermissionPromptTool,
        hasExternalPermissionHandler: true,
      });
    },
  );

  it('treats branded remote worker mode as an external permission handler', () => {
    vi.stubEnv(ENV_REMOTE_WORKER, '1');

    expect(isRemoteWorkerMode()).toBe(true);
    expect(
      getHeadlessPermissionPromptMode({
        inputFormat: 'text',
      }).hasExternalPermissionHandler,
    ).toBe(true);
  });
});
