/**
 * Tests for browser tool permission handling across permission modes.
 *
 * browser_tool should be allowed in safe/Plan mode because it is
 * an interactive browsing operation and does not mutate local files/system state.
 */
import { describe, it, expect } from 'bun:test';
import { shouldAllowToolInMode } from '../../agent/mode-manager.ts';

const browserToolNames = [
  'browser_tool',
  'mcp__session__browser_tool',
  // Legacy alias compatibility (older sessions/tests)
  'browser_snapshot',
  'browser_open',
  'mcp__session__browser_snapshot',
  'mcp__session__browser_open',
] as const;

describe('browser tools permission mode handling', () => {
  it('allows browser_tool in safe mode', () => {
    for (const toolName of browserToolNames) {
      const result = shouldAllowToolInMode(toolName, {}, 'safe');
      expect(result.allowed).toBe(true);
    }
  });

  it('allows browser_tool in ask mode without requiring permission', () => {
    for (const toolName of browserToolNames) {
      const result = shouldAllowToolInMode(toolName, {}, 'ask');
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.requiresPermission).toBeFalsy();
      }
    }
  });

  it('allows browser_tool in allow-all mode', () => {
    for (const toolName of browserToolNames) {
      const result = shouldAllowToolInMode(toolName, {}, 'allow-all');
      expect(result.allowed).toBe(true);
    }
  });
});
