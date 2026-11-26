/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import { CodeModeTool, CodeModeWaitTool } from './code-mode.js';
import { ToolRegistry } from './tool-registry.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { permissionRulesFromStartup } from '../permissions/settings/startup-rules.js';
import { buildModelStreamTools } from '../qoder/tools/function-declarations.js';
import { requestPrefixFacts } from '../utils/requestPrefixDiagnostics.js';

afterEach(() => vi.restoreAllMocks());

it.each(['on', 'only'] as const)(
  'retains the CodeMode companion for an explicit allowlist in %s mode',
  (mode) => {
    const config = makeFakeConfig();
    const deny =
      permissionRulesFromStartup({ coreTools: ['CodeMode'] }).deny.cliArg ?? [];
    vi.spyOn(config, 'getExcludeTools').mockReturnValue(new Set(deny));
    vi.spyOn(config, 'getCodeModeExposure').mockReturnValue(mode);
    const registry = new ToolRegistry(config, true);
    registry.registerTool(new CodeModeTool(config));
    registry.registerTool(new CodeModeWaitTool(config));
    expect(
      registry
        .getModelFunctionDeclarations()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['CodeMode', 'CodeModeWait']);
  },
);

it('preserves an explicit companion denial even when CodeMode is allowlisted', () => {
  const deny = permissionRulesFromStartup({
    coreTools: ['CodeMode'],
    disallowedTools: ['CodeModeWait'],
  }).deny.cliArg;
  expect(deny).toContain('CodeModeWait');
});

it.each(['on', 'only'] as const)(
  'keeps --tools empty when CodeMode %s becomes enabled for a later session',
  (mode) => {
    const config = makeFakeConfig();
    const deny =
      permissionRulesFromStartup({ coreTools: [] }).deny.cliArg ?? [];
    vi.spyOn(config, 'getExcludeTools').mockReturnValue(new Set(deny));
    vi.spyOn(config, 'getCodeModeExposure').mockReturnValue(mode);
    const registry = new ToolRegistry(config, true);
    registry.registerTool(new CodeModeTool(config));
    registry.registerTool(new CodeModeWaitTool(config));
    const tools = buildModelStreamTools(
      registry.getModelFunctionDeclarations(),
    );
    // A failure reports only a digest and size, never the schema descriptions.
    const facts = requestPrefixFacts({ messages: [], tools });
    expect({
      hash: facts['tools_sha256'],
      bytes: facts['tools_bytes'],
    }).toEqual({
      hash: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      bytes: 2,
    });
  },
);
