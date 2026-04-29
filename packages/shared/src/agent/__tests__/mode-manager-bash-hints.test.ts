import { describe, expect, it } from 'bun:test';
import {
  getBashRejectionReason,
  formatBashRejectionMessage,
  type ModeConfig,
} from '../../agent/mode-manager.ts';

function buildConfig(overrides?: Partial<ModeConfig>): ModeConfig {
  return {
    blockedTools: new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']),
    readOnlyBashPatterns: [
      {
        regex: /^printenv\b/,
        source: '^printenv\\b',
        comment: 'Print environment variables',
      },
      {
        regex: /^sed\s+-n\b/,
        source: '^sed\\s+-n\\b',
        comment: 'sed in print-only mode (no editing)',
      },
    ],
    blockedCommandHints: [
      {
        command: 'printf',
        reason: 'printf is not in the default Plan-mode read-only allowlist.',
        context: 'Plan mode intentionally keeps a narrow command surface.',
        tryInstead: [
          'Use `echo` for simple separators and labels.',
        ],
        example: "echo '--- files ---'",
      },
      {
        command: 'sed',
        reason: 'Only print-only sed is allowed in Plan mode by default.',
        whenNotMatching: '^sed\\s+-n\\b',
        whenNotMatchingRegex: /^sed\s+-n\b/,
      },
    ],
    readOnlyMcpPatterns: [],
    allowedApiEndpoints: [],
    displayName: 'Plan mode',
    shortcutHint: 'SHIFT+TAB',
    ...overrides,
  };
}

describe('mode-manager blocked command hints', () => {
  it('adds deterministic command-specific guidance for blocked printf', () => {
    const config = buildConfig();

    const rejection = getBashRejectionReason('printf "\\n--- files ---\\n"', config);
    expect(rejection).not.toBeNull();
    expect(rejection?.type).toBe('no_safe_pattern');

    const formatted = formatBashRejectionMessage(rejection!, config);

    expect(formatted).toContain('Why: printf is not in the default Plan-mode read-only allowlist.');
    expect(formatted).toContain('Context: Plan mode intentionally keeps a narrow command surface.');
    expect(formatted).toContain('Try instead:');
    expect(formatted).toContain('Example: `echo \'--- files ---\'`');

    // If fuzzy diagnostics are shown, they must be labeled as heuristic
    expect(formatted).not.toContain('Pattern: Print environment variables');
    expect(formatted).toContain('Closest allowlist hint (heuristic): Print environment variables');
  });

  it('applies sed hint when command is not in print-only mode', () => {
    const config = buildConfig();

    const rejection = getBashRejectionReason('sed s#^#/## file.txt', config);
    expect(rejection).not.toBeNull();
    expect(rejection?.type).toBe('no_safe_pattern');

    const formatted = formatBashRejectionMessage(rejection!, config);
    expect(formatted).toContain('Why: Only print-only sed is allowed in Plan mode by default.');
  });

  it('does not reject sed -n read-only command', () => {
    const config = buildConfig();

    const rejection = getBashRejectionReason("sed -n '1,5p' file.txt", config);
    expect(rejection).toBeNull();
  });
});
