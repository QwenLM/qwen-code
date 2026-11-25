/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCodeModeSupported } from './settings.js';

afterEach(() => vi.unstubAllEnvs());

describe('CodeMode platform availability', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'supports %s on x64 and arm64',
    (platform) => {
      vi.stubEnv('CLI_OHOS_BUILD', undefined);
      expect(isCodeModeSupported(platform, 'x64')).toBe(true);
      expect(isCodeModeSupported(platform, 'arm64')).toBe(true);
    },
  );
  it('excludes HarmonyOS even when its runtime identifies as Linux', () => {
    vi.stubEnv('CLI_OHOS_BUILD', 'true');
    expect(isCodeModeSupported('linux', 'arm64')).toBe(false);
  });
  it('does not advertise unsupported OS or CPU targets', () => {
    vi.stubEnv('CLI_OHOS_BUILD', undefined);
    expect(isCodeModeSupported('freebsd', 'x64')).toBe(false);
    expect(isCodeModeSupported('linux', 'arm')).toBe(false);
    expect(isCodeModeSupported('win32', 'ia32')).toBe(false);
  });
});
