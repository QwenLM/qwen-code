/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { AgentCore } from '../../agents/runtime/agent-core.js';
import { buildChildMessage } from './fork-subagent.js';
import { makeFakeConfig } from '../../test-utils/config.js';
import { MockTool } from '../../test-utils/mock-tool.js';
import { ToolRegistry } from '../tool-registry.js';
import { ExecTool } from '../exec.js';
import { ToolMode, getToolExposure } from '../code-mode.js';
import { ToolNames } from '../tool-names.js';

describe('Code-mode fork restriction matches declared call surfaces', () => {
  it.each([ToolMode.CodeMode, ToolMode.CodeModeOnly])(
    'only advertises possible direct calls in %s',
    (mode) => {
      const config = makeFakeConfig({ toolMode: mode });
      const registry = new ToolRegistry(config);
      registry.registerTool(new ExecTool(config));
      registry.registerTool(new MockTool({ name: ToolNames.READ_FILE }));
      registry.registerTool(new MockTool({ name: ToolNames.TOOL_SEARCH }));
      const declarationNames = new Set(
        registry
          .getFunctionDeclarationsFiltered([
            ToolNames.EXEC,
            ToolNames.READ_FILE,
            ToolNames.TOOL_SEARCH,
          ])
          .map((declaration) => declaration.name),
      );
      const message = buildChildMessage(
        'Inspect the implementation',
        [ToolNames.READ_FILE, ToolNames.TOOL_SEARCH],
        undefined,
        [ToolNames.READ_FILE],
        mode,
      );
      // The producer renders the same list under two wordings: the
      // "direct-call" one presents every listed name as directly callable,
      // while the plain one bounds only declared direct-only control tools.
      // Which wording matched decides how strict the per-name check may be.
      const directClaim = message.match(
        /(?:direct-call )?allowlist: (\[[^\n]*\])/,
      );
      expect(
        directClaim,
        'fork message carries a machine-readable direct-call claim',
      ).not.toBeNull();
      if (!directClaim) {
        throw new Error('fork message carries no direct-call allowlist claim');
      }
      const generalClaim = directClaim[0].startsWith('direct-call');
      const claimedDirectTools: string[] = JSON.parse(directClaim[1]);

      expect(declarationNames.has(ToolNames.EXEC)).toBe(true);
      expect(message).toContain(
        'Inside exec, only these exact nested tool names are permitted: ["read_file"]',
      );
      let asserted = 0;
      for (const name of claimedDirectTools) {
        // Under the plain wording a code-mode-callable entry is reachable
        // only through exec; it is not a direct-call claim.
        if (
          !generalClaim &&
          name !== ToolNames.EXEC &&
          getToolExposure(name) !== 'direct-only'
        ) {
          continue;
        }
        asserted += 1;
        expect(
          declarationNames.has(name),
          `${name} is not directly declared`,
        ).toBe(true);
      }
      // The invariant this file is named for must run in both rows.
      expect(asserted).toBeGreaterThan(0);
      if (mode === ToolMode.CodeMode) {
        expect(generalClaim).toBe(true);
        expect(claimedDirectTools).toContain(ToolNames.READ_FILE);
      } else {
        expect(generalClaim).toBe(false);
        expect(declarationNames.has(ToolNames.READ_FILE)).toBe(false);
        expect(claimedDirectTools).toContain(ToolNames.TOOL_SEARCH);
      }
    },
  );

  it('declares, executes, and names exec for a hybrid fork that omits it', async () => {
    // The fork shape agent.ts builds for fork_tools: ["read_file"] in hybrid
    // code mode: the parent's declared names stay as the tool list while the
    // execution allowlist narrows to the requested ones.
    const config = makeFakeConfig({ toolMode: ToolMode.CodeMode });
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registry.registerTool(new ExecTool(config));
    registry.registerTool(new MockTool({ name: ToolNames.READ_FILE }));
    registry.registerTool(new MockTool({ name: ToolNames.WRITE_FILE }));
    const core = new AgentCore(
      'hybrid-fork',
      config,
      { systemPrompt: '' },
      { model: 'test-model' },
      { max_turns: 1 },
      {
        tools: [ToolNames.EXEC, ToolNames.READ_FILE],
        executionAllowedTools: [ToolNames.READ_FILE],
      },
    );

    // Scoping the unconditional exec carve-out in isToolExecutionAllowed back
    // to CodeModeOnly turns both of these red.
    const declarations = await core.prepareTools();
    expect(declarations.map((declaration) => declaration.name)).toContain(
      ToolNames.EXEC,
    );
    expect(
      (
        core as unknown as { isToolExecutionAllowed: (t: string) => boolean }
      ).isToolExecutionAllowed.call(core, ToolNames.EXEC),
    ).toBe(true);

    // The child message must not claim the allowlist bounds exec: the gate
    // admits it for every code mode and every fork_tools value.
    const message = buildChildMessage(
      'Inspect the implementation',
      [ToolNames.READ_FILE],
      undefined,
      undefined,
      ToolMode.CodeMode,
    );
    const sentence = message
      .split('\n')
      .find((line) => line.includes('allowlist'));
    expect(sentence).toBeDefined();
    expect(sentence).toContain(JSON.stringify([ToolNames.READ_FILE]));
    expect(sentence).toContain(ToolNames.EXEC);
  });
});
