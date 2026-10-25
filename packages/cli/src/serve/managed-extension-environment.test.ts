/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, it } from 'vitest';
import { managedExtensionEnvironment } from './managed-extension-environment.js';

it('inherits only execution essentials and the selected extension settings', () => {
  const inherited = {
    PATH: '/bin',
    HOME: '/private/operator',
    LANG: 'en_US.UTF-8',
    QWEN_MANAGED_TOKEN: 'runtime-token',
    OTHER_EXTENSION_SECRET: 'other-secret',
    NODE_OPTIONS: '--require /private/preload.js',
  };
  expect(
    managedExtensionEnvironment(inherited, '/workspace/session', {
      SELECTED_SECRET: 'selected',
      QWEN_EXTENSION_ROOT: '/private/package',
    }),
  ).toEqual({
    PATH: '/bin',
    LANG: 'en_US.UTF-8',
    HOME: '/workspace/session',
    USERPROFILE: '/workspace/session',
    SELECTED_SECRET: 'selected',
    QWEN_EXTENSION_ROOT: '/private/package',
  });
  expect(inherited.HOME).toBe('/private/operator');
});
