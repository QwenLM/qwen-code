/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import type { LoadedPlugin } from '../types.js';
import {
  getPluginContentValidationError,
  hasInstallablePluginContent,
} from './pluginContentValidation.js';

function makePlugin(overrides: Record<string, unknown> = {}): LoadedPlugin {
  return {
    name: 'test-plugin',
    manifest: { name: 'test-plugin' },
    path: '/plugins/test-plugin',
    source: 'local',
    repository: 'local',
    enabled: true,
    ...overrides,
  } as unknown as LoadedPlugin;
}

const CONTENT_CASES: Array<[string, Record<string, unknown>]> = [
  ['commandsPath', { commandsPath: '/plugins/test-plugin/commands' }],
  ['agentsPath', { agentsPath: '/plugins/test-plugin/agents' }],
  ['skillsPath', { skillsPath: '/plugins/test-plugin/skills' }],
  [
    'outputStylesPath',
    { outputStylesPath: '/plugins/test-plugin/output-styles' },
  ],
  ['workflowsPath', { workflowsPath: '/plugins/test-plugin/workflows' }],
  ['binPath', { binPath: '/plugins/test-plugin/bin' }],
  ['hooksConfig', { hooksConfig: { hooks: { UserPromptSubmit: [] } } }],
  [
    'mcpServers',
    { mcpServers: { example: { command: 'node', args: ['server.js'] } } },
  ],
  ['commandsPaths', { commandsPaths: ['/plugins/test-plugin/custom-command'] }],
  ['agentsPaths', { agentsPaths: ['/plugins/test-plugin/custom-agent'] }],
  ['skillsPaths', { skillsPaths: ['/plugins/test-plugin/custom-skill'] }],
  [
    'outputStylesPaths',
    { outputStylesPaths: ['/plugins/test-plugin/custom-output-style'] },
  ],
  [
    'workflowsPaths',
    { workflowsPaths: ['/plugins/test-plugin/custom-workflow'] },
  ],
  [
    'commandsMetadata',
    { commandsMetadata: { hello: { description: 'Say hello' } } },
  ],
];

describe('pluginContentValidation', () => {
  it.each(CONTENT_CASES)('recognizes %s as installable content', (_name, content) => {
    expect(hasInstallablePluginContent(makePlugin(content))).toBe(true);
  });

  it('rejects a plugin without installable content', () => {
    expect(hasInstallablePluginContent(makePlugin())).toBe(false);
    expect(
      hasInstallablePluginContent(
        makePlugin({
          commandsPaths: [],
          agentsPaths: [],
          skillsPaths: [],
          outputStylesPaths: [],
          workflowsPaths: [],
          commandsMetadata: {},
        }),
      ),
    ).toBe(false);
  });

  it('returns no validation error when content is installable', () => {
    expect(
      getPluginContentValidationError(
        makePlugin({ skillsPath: '/plugins/test-plugin/skills' }),
        '/plugins/test-plugin',
      ),
    ).toBeUndefined();
  });

  it('reports the plugin path and expected content when none is installable', () => {
    const error = getPluginContentValidationError(
      makePlugin(),
      '/plugins/test-plugin',
    );

    expect(error).toContain('No plugin content found in "/plugins/test-plugin"');
    expect(error).toContain('commands/');
    expect(error).toContain('hooks/hooks.json');
    expect(error).toContain('.mcp.json');
  });
});
