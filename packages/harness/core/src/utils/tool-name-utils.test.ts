/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('tool-name-utils', () => {
  let sanitizeToolName: typeof import('./tool-name-utils.js').sanitizeToolName;
  let getOriginalToolName: typeof import('./tool-name-utils.js').getOriginalToolName;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./tool-name-utils.js');
    sanitizeToolName = mod.sanitizeToolName;
    getOriginalToolName = mod.getOriginalToolName;
  });

  it('returns name unchanged when already valid and <= 64 chars', () => {
    expect(sanitizeToolName('simple_tool')).toBe('simple_tool');
  });

  it('replaces characters outside [a-zA-Z0-9_-]', () => {
    const result = sanitizeToolName('my-tool.name');
    expect(result).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('returns names with hyphens unchanged (no hash suffix)', () => {
    const name = 'mcp__qw-builtin__qw_mcp_list';
    expect(sanitizeToolName(name)).toBe(name);
    expect(getOriginalToolName(name)).toBe(name);
  });

  it('truncates long names to 64 chars', () => {
    const longName = 'a'.repeat(100);
    const result = sanitizeToolName(longName);
    expect(result.length).toBeLessThanOrEqual(64);
  });

  it('appends a 6-char base36 hash suffix when modified', () => {
    const result = sanitizeToolName('mcp__server.name__tool');
    expect(result).toMatch(/_[0-9a-z]{6}$/);
  });

  it('reverse lookup returns original name', () => {
    const original = 'my-server/my-tool';
    const sanitized = sanitizeToolName(original);
    expect(getOriginalToolName(sanitized)).toBe(original);
  });

  it('returns same result for repeated calls with the same name', () => {
    const name = 'some.tool.with.dots';
    const first = sanitizeToolName(name);
    const second = sanitizeToolName(name);
    expect(first).toBe(second);
  });

  it('short identity mapping survives unrelated long-name sanitization', () => {
    const shortName = 'foo_bar';
    expect(sanitizeToolName(shortName)).toBe(shortName);
    expect(getOriginalToolName(shortName)).toBe(shortName);

    const long = sanitizeToolName('something.totally.different/' + 'x'.repeat(80));
    expect(long).not.toBe(shortName);
    expect(getOriginalToolName(shortName)).toBe(shortName);
  });

  it('identity path does not clobber a prior hash-suffixed reverse mapping', () => {
    const hashedOriginal = 'foo-bar.';
    const sanitized = sanitizeToolName(hashedOriginal);
    expect(sanitized).not.toBe(hashedOriginal);
    expect(getOriginalToolName(sanitized)).toBe(hashedOriginal);

    // Now feed in a literal name that already equals the hashed wire form.
    // Without the identity-branch collision check, this would overwrite the
    // reverse mapping and silently break reverse lookup for hashedOriginal.
    const colliding = sanitized;
    const collidingSanitized = sanitizeToolName(colliding);
    expect(collidingSanitized).not.toBe(sanitized);
    expect(getOriginalToolName(sanitized)).toBe(hashedOriginal);
    expect(getOriginalToolName(collidingSanitized)).toBe(colliding);
  });

  it('produces distinct sanitized names for two long names sharing a long prefix', () => {
    const prefix = 'x'.repeat(80);
    const nameA = prefix + '_aaa';
    const nameB = prefix + '_bbb';

    const sanitizedA = sanitizeToolName(nameA);
    const sanitizedB = sanitizeToolName(nameB);

    expect(sanitizedA).not.toBe(sanitizedB);
    expect(sanitizedA.length).toBeLessThanOrEqual(64);
    expect(sanitizedB.length).toBeLessThanOrEqual(64);
    expect(getOriginalToolName(sanitizedA)).toBe(nameA);
    expect(getOriginalToolName(sanitizedB)).toBe(nameB);
  });

  it('handles many long names without producing duplicates', () => {
    const names = Array.from({ length: 50 }, (_, i) =>
      'very_long_mcp_server_tool_name_that_exceeds_sixty_four_characters_' + i,
    );

    const sanitizedSet = new Set<string>();
    for (const name of names) {
      const sanitized = sanitizeToolName(name);
      expect(sanitized.length).toBeLessThanOrEqual(64);
      expect(sanitizedSet.has(sanitized)).toBe(false);
      sanitizedSet.add(sanitized);
      expect(getOriginalToolName(sanitized)).toBe(name);
    }
  });
});
