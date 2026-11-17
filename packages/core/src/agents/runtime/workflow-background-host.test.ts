/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Config, type ConfigParameters } from '../../config/config.js';
import { ideContextStore } from '../../ide/ideContext.js';
import { WorkflowTool } from '../../tools/workflow/workflow.js';
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
  afterEach(() => ideContextStore.clear());

  it.each([
    ['folder trust off', {}, true],
    ['trusted workspace', { folderTrust: true, trustedFolder: true }, true],
    ['untrusted workspace', { folderTrust: true, trustedFolder: false }, false],
    ['bare mode', { bareMode: true }, false],
  ] as const)('%s', (_label, params, expected) => {
    expect(hostSupportsBackgroundWorkflows(acpConfig(params))).toBe(expected);
  });

  it.each([
    ['refuses', false, false],
    ['allows', true, true],
  ] as const)(
    '%s a workspace a trust rule below the IDE root decides as trusted=%s',
    (_label, fileTrust, expected) => {
      const ideRoot = path.dirname(realpathSync('/tmp'));
      const config = acpConfig({
        folderTrust: true,
        trustedFolder: fileTrust,
        trustFileDecisionBelowIdeRoot: (dir, root) =>
          dir === '/tmp' && root === ideRoot ? fileTrust : undefined,
      });
      ideContextStore.set({ workspaceState: { isTrusted: !fileTrust } }, [
        ideRoot,
      ]);

      expect(hostSupportsBackgroundWorkflows(config)).toBe(expected);
    },
  );

  it('refuses once a settings reload turns workflows off mid-session', () => {
    const config = acpConfig();
    expect(hostSupportsBackgroundWorkflows(config)).toBe(true);
    config.setWorkflowsEnabled(false);
    expect(hostSupportsBackgroundWorkflows(config)).toBe(false);
  });

  it('requires a foreground run in a Qwen Session Agent', () => {
    const config = acpConfig();
    config.setSessionSource('agent');
    config.markSessionAgentSession();
    config.getWorkflowRunRegistry().setCompletionCallback(() => {});
    const tool = new WorkflowTool(config);

    expect(() => tool.build({ script: 'return 1' })).not.toThrow();
    expect(() =>
      tool.build({ script: 'return 1', run_in_background: true }),
    ).toThrow(/Qwen Session Agents must run workflows in the foreground/);
  });
});
