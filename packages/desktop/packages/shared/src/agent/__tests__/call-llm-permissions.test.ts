/**
 * Tests for call_llm tool permission handling across permission modes.
 *
 * call_llm is a session-scoped MCP tool (mcp__session__call_llm) that should
 * be allowed in ALL permission modes including safe/Explore, since it's a
 * read-only operation (secondary LLM call, no side effects).
 */
import { describe, it, expect } from 'bun:test';
import { shouldAllowToolInMode, type PermissionMode } from '../../agent/mode-manager.ts';

describe('call_llm permission mode handling', () => {
  const toolName = 'mcp__session__call_llm';
  const input = { prompt: 'Summarize this file', model: 'haiku' };

  it('is allowed in safe (Explore) mode', () => {
    const result = shouldAllowToolInMode(toolName, input, 'safe');
    expect(result.allowed).toBe(true);
  });

  it('is allowed in ask mode', () => {
    const result = shouldAllowToolInMode(toolName, input, 'ask');
    expect(result.allowed).toBe(true);
  });

  it('is allowed in allow-all (Execute) mode', () => {
    const result = shouldAllowToolInMode(toolName, input, 'allow-all');
    expect(result.allowed).toBe(true);
  });

  it('does not require permission prompt in ask mode', () => {
    const result = shouldAllowToolInMode(toolName, input, 'ask');
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.requiresPermission).toBeFalsy();
    }
  });
});
