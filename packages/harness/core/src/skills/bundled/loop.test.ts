/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BundledSkillRegistration,
  BundledSkillRegistrar,
} from './index.js';

vi.mock('./loop-md.js', () => ({
  hasLoopMd: vi.fn(async () => true),
}));

async function renderNoArgsBody(): Promise<string> {
  vi.resetModules();
  const { registerLoopSkill } = await import('./loop.js');
  let definition: BundledSkillRegistration | undefined;
  registerLoopSkill({
    registerBundledSkill(candidate) {
      definition = candidate;
    },
  } as BundledSkillRegistrar);

  expect(definition?.getBody).toBeTypeOf('function');
  return definition!.getBody!('');
}

describe('loop skill config directory paths', () => {
  beforeEach(() => {
    vi.stubEnv('BRAND_ENV_PREFIX', 'EXAMPLE_');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('points the no-args prompt at the configured project config directory', async () => {
    vi.stubEnv('EXAMPLE_CONFIG_DIR_NAME', 'abc');

    const body = await renderNoArgsBody();

    expect(body).toContain('`abc/loop.md`');
    expect(body).not.toContain('.qwen/loop.md');
  });
});
