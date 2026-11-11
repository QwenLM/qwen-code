/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Config, type ConfigParameters } from '../../config/config.js';
import { hostSupportsBackgroundWorkflows } from './workflow-runner.js';

// A real `Config`, parameterised the way the CLI builds an `--acp` child:
// `folderTrust` carries the folder-trust feature toggle and `trustedFolder`
// the resolved workspace decision.
function acpConfig(params: Partial<ConfigParameters> = {}): Config {
  return new Config({
    cwd: '/tmp',
    targetDir: '/tmp',
    model: 'test-model',
    embeddingModel: 'test-embedding-model',
    sandbox: undefined,
    debugMode: false,
    interactive: false,
    experimentalZedIntegration: true,
    workflowsEnabled: true,
    ...params,
  });
}

describe('hostSupportsBackgroundWorkflows on a real ACP Config', () => {
  it.each([
    ['folder trust off', {}, true],
    ['trusted workspace', { folderTrust: true, trustedFolder: true }, true],
    ['untrusted workspace', { folderTrust: true, trustedFolder: false }, false],
    ['bare mode', { bareMode: true }, false],
  ] as const)('%s', (_label, params, expected) => {
    expect(hostSupportsBackgroundWorkflows(acpConfig(params))).toBe(expected);
  });

  it('refuses once a settings reload turns workflows off mid-session', () => {
    const config = acpConfig();
    expect(hostSupportsBackgroundWorkflows(config)).toBe(true);
    config.setWorkflowsEnabled(false);
    expect(hostSupportsBackgroundWorkflows(config)).toBe(false);
  });
});
