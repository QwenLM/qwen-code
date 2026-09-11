/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { matchesHookPattern } from './hook-matcher.js';

describe('matchesHookPattern', () => {
  it.each(['', '  ', '*', '.*'])('matches everything with %j', (matcher) => {
    expect(matchesHookPattern(matcher, 'anything')).toBe(true);
  });

  it('matches the subject exactly', () => {
    expect(matchesHookPattern('idle_prompt', 'idle_prompt')).toBe(true);
    expect(matchesHookPattern('idle_prompt', 'auth_success')).toBe(false);
  });

  it('matches entries of a pipe-separated list exactly, ignoring spaces', () => {
    expect(
      matchesHookPattern('permission_prompt | idle_prompt', 'idle_prompt'),
    ).toBe(true);
    expect(
      matchesHookPattern('permission_prompt|idle_prompt', 'auth_success'),
    ).toBe(false);
  });

  it('treats other matchers as unanchored regular expressions', () => {
    expect(matchesHookPattern('read', 'read_file')).toBe(true);
    expect(matchesHookPattern('^elicitation_', 'elicitation_dialog')).toBe(
      true,
    );
    expect(matchesHookPattern('^(write|edit)$', 'write_file')).toBe(false);
  });

  it('matches aliases exactly but never through a regex', () => {
    const aliases = ['WriteFile', 'write_file'];
    expect(matchesHookPattern('WriteFile', 'write_file', { aliases })).toBe(
      true,
    );
    expect(
      matchesHookPattern('Edit|WriteFile', 'write_file', { aliases }),
    ).toBe(true);
    expect(matchesHookPattern('^Write', 'write_file', { aliases })).toBe(false);
  });

  it('does not throw on an invalid regex and still allows an exact match', () => {
    expect(matchesHookPattern('[invalid(regex', 'bash')).toBe(false);
    expect(matchesHookPattern('[invalid(regex', '[invalid(regex')).toBe(true);
  });
});
