/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  }),
}));

import { matchesHookPattern } from './hook-matcher.js';

describe('matchesHookPattern', () => {
  beforeEach(() => {
    warn.mockClear();
  });

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

  it('decides a pipe-separated list entry by entry', () => {
    expect(matchesHookPattern('Bash|*', 'write_file')).toBe(true);
    expect(matchesHookPattern('read_.*|edit', 'read_file')).toBe(true);
    expect(matchesHookPattern('read_.*|edit', 'write_file')).toBe(false);
  });

  it('ignores empty list entries instead of matching everything', () => {
    expect(matchesHookPattern('write_file|edit|', 'run_shell_command')).toBe(
      false,
    );
    expect(matchesHookPattern('write_file||edit', 'run_shell_command')).toBe(
      false,
    );
    expect(matchesHookPattern('|', 'run_shell_command')).toBe(false);
    expect(matchesHookPattern('write_file|edit|', 'edit')).toBe(true);
  });

  it('still reads a group that spans the pipe as one regex', () => {
    expect(matchesHookPattern('a(b|c)', 'ab')).toBe(true);
  });

  it('drops a stray pipe before reading a group that spans the pipe', () => {
    expect(matchesHookPattern('read_(file|edit)|', 'read_file')).toBe(true);
    expect(matchesHookPattern('read_(file|edit)|', 'write_file')).toBe(false);
  });

  it('never matches a list entry on its own as a regex', () => {
    expect(matchesHookPattern('notes\\|todo\\.md', 'docs/todo.md')).toBe(false);
    expect(matchesHookPattern('notes\\|todo\\.md', 'docs/notes|todo.md')).toBe(
      true,
    );
  });

  it('trims list entries before rebuilding the regular expression', () => {
    expect(matchesHookPattern('read_.* | edit', 'read_file')).toBe(true);
    expect(matchesHookPattern('read_.* | write_.*', 'write_file')).toBe(true);
    expect(matchesHookPattern('read_.* | write_.*', 'run_shell_command')).toBe(
      false,
    );
  });

  it('never splits a list on an escaped pipe', () => {
    expect(matchesHookPattern('notes\\|', 'x/notes|y')).toBe(true);
    expect(matchesHookPattern('a\\||b', 'b')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(matchesHookPattern('foo\\|bar', 'bar')).toBe(false);
  });

  it('keeps a pipe inside a character class or group, with its spaces', () => {
    expect(matchesHookPattern('foo[ |]bar', 'foo bar')).toBe(true);
    expect(matchesHookPattern('foo[ |]bar', 'foo|bar')).toBe(true);
    expect(matchesHookPattern('a(b | c)', 'a c')).toBe(true);
    expect(matchesHookPattern('a(b | c)', 'ac')).toBe(false);
  });

  it('splits on a pipe that follows an escaped backslash', () => {
    const paths = 'C:\\\\temp\\\\|D:\\\\data\\\\|';
    expect(matchesHookPattern(paths, 'ANYTHING_AT_ALL')).toBe(false);
    expect(matchesHookPattern(paths, 'D:\\data\\notes.md')).toBe(true);
    expect(matchesHookPattern('a\\\\|', 'ANYTHING_AT_ALL')).toBe(false);
  });

  it('compiles a matcher that starts with ^ or ( exactly as written', () => {
    expect(matchesHookPattern('^write_file|', 'run_shell_command')).toBe(true);
    expect(matchesHookPattern('(write_file)|', 'run_shell_command')).toBe(true);
  });

  it('warns only about a matcher that does not compile as a whole', () => {
    expect(matchesHookPattern('a(b|c)', 'ab')).toBe(true);
    expect(matchesHookPattern('read_(file|edit)', 'read_file')).toBe(true);
    expect(warn).not.toHaveBeenCalled();

    expect(matchesHookPattern('[invalid(regex', 'bash')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
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
