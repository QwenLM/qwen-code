/**
 * Tests for send_developer_feedback tool permission handling across permission modes.
 *
 * send_developer_feedback is a session-scoped MCP tool that should be allowed
 * in ALL permission modes, including safe/Explore, so product issues can be
 * reported without requiring mode switches.
 */
import { describe, it, expect } from 'bun:test';
import { shouldAllowToolInMode } from '../../agent/mode-manager.ts';

describe('send_developer_feedback permission mode handling', () => {
  const toolName = 'mcp__session__send_developer_feedback';
  const input = { message: 'Feedback content' };

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
