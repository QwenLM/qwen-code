/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_AGENT_SDK_ENTRYPOINT } from "../config/brand.js";

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('isSDKMode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('detects SDK mode from the SDK protocol env', async () => {
    vi.stubEnv('QODERCLI_SITE', 'global');
    vi.stubEnv(ENV_AGENT_SDK_ENTRYPOINT, 'sdk-ts');
    vi.resetModules();

    const { isSDKMode } = await import('./headless.js');

    expect(isSDKMode()).toBe(true);
  });

  it('keeps SDK mode detection independent from site selection', async () => {
    vi.stubEnv('QODERCLI_SITE', 'cn');
    vi.stubEnv(ENV_AGENT_SDK_ENTRYPOINT, 'sdk-ts');
    vi.resetModules();

    const { isSDKMode } = await import('./headless.js');

    expect(isSDKMode()).toBe(true);
  });
});
