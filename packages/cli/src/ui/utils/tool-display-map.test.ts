/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { ToolDisplayNames, ToolNames } from '@qwen-code/qwen-code-core';
import { TOOL_DISPLAY_BY_NAME } from './tool-display-map.js';

describe('TOOL_DISPLAY_BY_NAME', () => {
  it('maps internal tool names to their user-facing display names', () => {
    expect(TOOL_DISPLAY_BY_NAME['run_shell_command']).toBe('Shell');
    expect(TOOL_DISPLAY_BY_NAME['glob']).toBe('Glob');
    expect(TOOL_DISPLAY_BY_NAME['read_file']).toBe('ReadFile');
  });

  it('has a display name for every enumerated tool (no drift)', () => {
    // The four subagent-activity surfaces fall back to the raw internal
    // name via `?? name`, so a missing display would silently leak
    // `run_shell_command` into the UI. Assert parity here so drift between
    // core's ToolNames and ToolDisplayNames fails in CI instead.
    for (const key of Object.keys(ToolNames) as Array<keyof typeof ToolNames>) {
      const internalName = ToolNames[key];
      expect(
        TOOL_DISPLAY_BY_NAME[internalName],
        `no display name for tool "${internalName}"`,
      ).toBe(ToolDisplayNames[key]);
      expect(TOOL_DISPLAY_BY_NAME[internalName]).toBeDefined();
    }
  });
});
