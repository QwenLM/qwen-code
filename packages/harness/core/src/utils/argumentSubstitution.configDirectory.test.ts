/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('skill config directory substitution', () => {
  beforeEach(() => {
    vi.stubEnv('BRAND_ENV_PREFIX', 'QWEN_');
    vi.stubEnv('BRAND_FIXED_ENV_PREFIX', 'QWEN_');
  });

  afterEach(async () => {
    const paths = await import('./paths.js');
    paths.setConfigHomeDirOverride(undefined);
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('expands a complete user path before replacing the bare directory name', async () => {
    const userRoot = path.join(os.tmpdir(), '配置 root $&');
    vi.stubEnv('QWEN_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('QWEN_CONFIG_DIR', userRoot);
    vi.resetModules();
    const { substituteSkillBody } = await import('./argumentSubstitution.js');

    const result = substituteSkillBody(
      {
        body: [
          'user=~/${QWEN_USER_CONFIG_DIR}/skills',
          'user-name=${QWEN_USER_CONFIG_DIR}',
          'project=${QWEN_CONFIG_DIR}/skills',
        ].join('\n'),
      },
      { skillDir: '/skills/test', sessionId: 'session-1' },
    );

    expect(result).toContain(`user=${path.join(userRoot, 'skills')}`);
    expect(result).toContain('user-name=abc');
    expect(result).toContain('project=abc/skills');
    expect(result).not.toContain('~/abc/skills');
  });

  it('honors the in-process complete-root override', async () => {
    const flagRoot = path.join(os.tmpdir(), 'flag 配置 root $&');
    vi.stubEnv('QWEN_CONFIG_DIR_NAME', 'abc');
    vi.stubEnv('QWEN_CONFIG_DIR', path.join(os.tmpdir(), 'env-root'));
    vi.resetModules();
    const paths = await import('./paths.js');
    paths.setConfigHomeDirOverride(flagRoot);
    const { substituteSkillBody } = await import('./argumentSubstitution.js');

    const result = substituteSkillBody(
      { body: '~/${QWEN_USER_CONFIG_DIR}/agents' },
      { skillDir: '/skills/test', sessionId: 'session-1' },
    );

    expect(result).toBe(path.join(flagRoot, 'agents'));
  });

  it.each([
    ['Qwen', 'QWEN_', 'QWEN_', '.qwen', '.qwen'],
    ['Example', 'EXAMPLE_', 'EXAMPLE_', '.qwen', '.qwen'],
    ['ExampleCN', 'EXAMPLE_CN_', 'EXAMPLE_', '.qwen', '.qwen-cn'],
  ])(
    'uses the %s entry defaults for branded placeholders',
    async (_product, prefix, templatePrefix, projectDir, userDir) => {
      vi.stubEnv('BRAND_ENV_PREFIX', prefix);
      vi.stubEnv('BRAND_FIXED_ENV_PREFIX', templatePrefix);
      vi.stubEnv(`${prefix}CONFIG_DIR`, undefined);
      vi.stubEnv(`${prefix}CONFIG_DIR_NAME`, undefined);
      vi.stubEnv(`${prefix}CLI_HOME`, undefined);
      vi.stubEnv('PROJECT_CONFIG_DIR', 'unrelated-shell-value');
      vi.stubEnv('USER_CONFIG_DIR', 'unrelated-shell-value');
      vi.resetModules();
      vi.stubEnv('BRAND_USER_CONFIG_DIR_NAME', userDir);
      vi.stubEnv('BRAND_PROJECT_CONFIG_DIR_NAME', projectDir);
      const { substituteSkillBody } = await import('./argumentSubstitution.js');
      const variable = (name: string) => '${' + templatePrefix + name + '}';

      expect(
        substituteSkillBody(
          {
            body: `project=${variable('CONFIG_DIR')}/agents user=~/${variable('USER_CONFIG_DIR')}/skills`,
          },
          { skillDir: '/skills/test', sessionId: 'session-1' },
        ),
      ).toBe(`project=${projectDir}/agents user=~/${userDir}/skills`);

      const otherPrefix = templatePrefix === 'QWEN_' ? 'EXAMPLE_' : 'QWEN_';
      const unsupported = [
        '${PROJECT_CONFIG_DIR}',
        '${USER_CONFIG_DIR}',
        '~/${USER_CONFIG_DIR}/skills',
        '${CONFIG_DIR}',
        '${' + otherPrefix + 'CONFIG_DIR}',
        '~/${' + otherPrefix + 'USER_CONFIG_DIR}/skills',
        '${EXAMPLE_CN_CONFIG_DIR}',
        '${EXAMPLE_CN_USER_CONFIG_DIR}',
      ].join('\n');
      expect(
        substituteSkillBody(
          { body: unsupported },
          { skillDir: '/skills/test', sessionId: 'session-1' },
        ),
      ).toBe(unsupported);

      vi.stubEnv(`${prefix}CONFIG_DIR_NAME`, 'team 配置');
      vi.resetModules();
      const configured = await import('./argumentSubstitution.js');
      expect(
        configured.substituteSkillBody(
          { body: variable('CONFIG_DIR') + ' ' + variable('USER_CONFIG_DIR') },
          { skillDir: '/skills/test', sessionId: 'session-1' },
        ),
      ).toBe('team 配置 team 配置');
    },
  );
});
