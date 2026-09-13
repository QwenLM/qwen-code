/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  resolveBuiltinToolName,
  ToolDisplayNames,
  ToolNames,
} from './tool-names.js';

describe('resolveBuiltinToolName', () => {
  it('maps a tool name, its display name and legacy aliases to the tool name', () => {
    expect(resolveBuiltinToolName(ToolNames.SHELL)).toBe(ToolNames.SHELL);
    expect(resolveBuiltinToolName(ToolDisplayNames.SHELL)).toBe(
      ToolNames.SHELL,
    );
    expect(resolveBuiltinToolName('replace')).toBe(ToolNames.EDIT);
    expect(resolveBuiltinToolName('SearchFiles')).toBe(ToolNames.GREP);
  });

  it('knows every built-in tool by both of its names', () => {
    const displayNames = ToolDisplayNames as Record<string, string>;
    for (const [key, name] of Object.entries(ToolNames)) {
      expect(resolveBuiltinToolName(name)).toBe(name);
      if (displayNames[key] !== undefined) {
        expect(resolveBuiltinToolName(displayNames[key])).toBeDefined();
      }
    }
  });

  it('does not recognise MCP tools, other spellings or typos', () => {
    for (const name of ['Bash', 'run_shell', 'mcp__github', 'EDIT']) {
      expect(resolveBuiltinToolName(name)).toBeUndefined();
    }
  });
});
