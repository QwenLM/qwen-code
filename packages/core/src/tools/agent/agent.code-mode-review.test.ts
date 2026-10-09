/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
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
});
