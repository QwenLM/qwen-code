/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  resolveBuiltinToolName,
  resolveRegisteredToolName,
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

describe('resolveRegisteredToolName', () => {
  const registered = ['deferred_target', 'Deferred_Target', 'cron_list'];

  it('prefers an exact match over case variants', () => {
    expect(resolveRegisteredToolName('deferred_target', registered)).toBe(
      'deferred_target',
    );
    expect(resolveRegisteredToolName('Deferred_Target', registered)).toBe(
      'Deferred_Target',
    );
  });

  it('resolves a single case-insensitive match', () => {
    expect(resolveRegisteredToolName('CRON_LIST', registered)).toBe(
      'cron_list',
    );
  });

  it('returns every candidate when a request matches several by case', () => {
    expect(resolveRegisteredToolName('DEFERRED_TARGET', registered)).toEqual([
      'Deferred_Target',
      'deferred_target',
    ]);
  });

  it('does not depend on registration order (#11321)', () => {
    // ensureTool moves a lazily-built tool from the factory map to the tool
    // map, which reorders getAllToolNames(); the answer must not move with it.
    const reversed = [...registered].reverse();
    for (const requested of ['deferred_target', 'DEFERRED_TARGET']) {
      expect(resolveRegisteredToolName(requested, reversed)).toEqual(
        resolveRegisteredToolName(requested, registered),
      );
    }
  });

  it('returns undefined when nothing matches', () => {
    expect(resolveRegisteredToolName('missing', registered)).toBeUndefined();
  });
});
