/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { LspServerConfig } from './types.js';
import { lspServerConfigHash } from './configHash.js';

const baseConfig: LspServerConfig = {
  name: 'tsserver',
  languages: ['typescript'],
  command: 'typescript-language-server',
  args: ['--stdio'],
  transport: 'stdio',
  env: { B: '2', A: '1' },
  settings: { beta: true, alpha: { z: 1, a: 2 } },
  rootUri: 'file:///workspace',
  workspaceFolder: '/workspace',
  trustRequired: true,
};

describe('lspServerConfigHash', () => {
  it('ignores object key order', () => {
    const reordered: LspServerConfig = {
      ...baseConfig,
      env: { A: '1', B: '2' },
      settings: { alpha: { a: 2, z: 1 }, beta: true },
    };

    expect(lspServerConfigHash(reordered)).toBe(
      lspServerConfigHash(baseConfig),
    );
  });

  it('treats argument order as semantic', () => {
    expect(
      lspServerConfigHash({
        ...baseConfig,
        args: ['--stdio', '--log'],
      }),
    ).not.toBe(
      lspServerConfigHash({
        ...baseConfig,
        args: ['--log', '--stdio'],
      }),
    );
  });

  it('changes when runtime config fields change', () => {
    expect(
      lspServerConfigHash({
        ...baseConfig,
        command: 'other-server',
      }),
    ).not.toBe(lspServerConfigHash(baseConfig));

    expect(
      lspServerConfigHash({
        ...baseConfig,
        trustRequired: false,
      }),
    ).not.toBe(lspServerConfigHash(baseConfig));
  });
});
