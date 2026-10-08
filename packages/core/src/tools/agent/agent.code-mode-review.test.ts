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
import { ToolMode } from '../code-mode.js';
import { ToolNames } from '../tool-names.js';

describe('Code-mode fork restriction matches declared call surfaces', () => {
  it.each([ToolMode.CodeMode, ToolMode.CodeModeOnly])(
    'only advertises possible direct calls in %s',
    (mode) => {
      const config = makeFakeConfig({ toolMode: mode });
      const registry = new ToolRegistry(config);
      registry.registerTool(new ExecTool(config));
      registry.registerTool(new MockTool({ name: ToolNames.READ_FILE }));
      const declarationNames = new Set(
        registry
          .getFunctionDeclarationsFiltered([
            ToolNames.EXEC,
            ToolNames.READ_FILE,
          ])
          .map((declaration) => declaration.name),
      );
      const message = buildChildMessage(
        'Inspect the implementation',
        [ToolNames.READ_FILE],
        undefined,
        [ToolNames.READ_FILE],
        mode,
      );
      const directClaim = message.match(/direct-call allowlist: (\[[^\n]*\])/);
      const claimedDirectTools: string[] = directClaim
        ? JSON.parse(directClaim[1])
        : [];

      expect(declarationNames.has(ToolNames.EXEC)).toBe(true);
      expect(message).toContain(
        'Inside exec, only these exact nested tool names are permitted: ["read_file"]',
      );
      for (const name of claimedDirectTools) {
        expect(
          declarationNames.has(name),
          `${name} is not directly declared`,
        ).toBe(true);
      }
      if (mode === ToolMode.CodeMode) {
        expect(claimedDirectTools).toContain(ToolNames.READ_FILE);
      } else {
        expect(declarationNames.has(ToolNames.READ_FILE)).toBe(false);
        expect(claimedDirectTools).not.toContain(ToolNames.READ_FILE);
      }
    },
  );
});
