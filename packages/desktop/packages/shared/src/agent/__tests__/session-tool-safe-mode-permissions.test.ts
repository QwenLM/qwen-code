/**
 * Regression tests for metadata-driven session tool safe-mode classification.
 */
import { describe, it, expect } from 'bun:test';
import { shouldAllowToolInMode } from '../../agent/mode-manager.ts';

function withDeveloperFeedbackEnabled(run: () => void) {
  const previousFlag = process.env.CRAFT_FEATURE_DEVELOPER_FEEDBACK;
  process.env.CRAFT_FEATURE_DEVELOPER_FEEDBACK = '1';
  try {
    run();
  } finally {
    if (previousFlag === undefined) {
      delete process.env.CRAFT_FEATURE_DEVELOPER_FEEDBACK;
    } else {
      process.env.CRAFT_FEATURE_DEVELOPER_FEEDBACK = previousFlag;
    }
  }
}

describe('session tool safe-mode classification', () => {
  it('allows read-only session tools in safe mode', () => {
    const allowedTools = [
      'mcp__session__call_llm',
      'mcp__session__browser_tool',
      'mcp__session__script_sandbox',
    ] as const;

    for (const toolName of allowedTools) {
      const result = shouldAllowToolInMode(toolName, {}, 'safe');
      expect(result.allowed).toBe(true);
    }
  });

  it('allows developer feedback in safe mode when the feature is enabled', () => {
    withDeveloperFeedbackEnabled(() => {
      const result = shouldAllowToolInMode(
        'mcp__session__send_developer_feedback',
        {},
        'safe'
      );

      expect(result.allowed).toBe(true);
    });
  });

  it('blocks mutating/auth session tools in safe mode', () => {
    const blockedTools = [
      'mcp__session__source_oauth_trigger',
      'mcp__session__source_credential_prompt',
      'mcp__session__spawn_session',
      'mcp__session__update_user_preferences',
    ] as const;

    for (const toolName of blockedTools) {
      const result = shouldAllowToolInMode(toolName, {}, 'safe');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('Session configuration changes are blocked in');
      }
    }
  });
});
