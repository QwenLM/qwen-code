/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createReadOnlyTeammateToolConfig } from '../subagent-plan-tool-policy.js';
import { ToolNames } from '../../../tools/tool-names.js';

describe('read-only teammate tool policy', () => {
  it('excludes mutation tools from declaration and execution', () => {
    const config = createReadOnlyTeammateToolConfig();

    for (const tools of [config.tools, config.executionAllowedTools]) {
      expect(tools).toEqual([
        ToolNames.READ_FILE,
        ToolNames.GREP,
        ToolNames.GLOB,
        ToolNames.LS,
        ToolNames.SEND_MESSAGE,
        ToolNames.TASK_LIST,
        ToolNames.TASK_UPDATE,
      ]);
      expect(tools).not.toContain(ToolNames.SHELL);
      expect(tools).not.toContain(ToolNames.MEMORY);
      expect(tools).not.toContain(ToolNames.CREATE_SUB_SESSION);
    }
  });
});
