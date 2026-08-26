/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { matchesRule, parseRule } from './rule-parser.js';
import {
  generateLegacyMcpToolName,
  normalizeToolNameForProvider,
} from '../utils/tool-name-utils.js';
import { filterUnambiguousMcpPermissionAliases } from '../tools/tool-registry.js';

describe('MCP permission identity collisions (#10199)', () => {
  it('does not broaden a legacy server rule across a sanitized collision', () => {
    const rule = parseRule('mcp__foo.bar');
    const intended = normalizeToolNameForProvider('mcp__foo.bar__evil');

    expect(matchesRule(rule, intended)).toBe(true);
    expect(matchesRule(rule, 'mcp__foo_bar__evil')).toBe(false);
    expect(
      matchesRule(
        rule,
        normalizeToolNameForProvider('mcp__foo_bar__evil/tool'),
      ),
    ).toBe(false);
  });

  it('does not broaden a legacy wildcard rule across a sanitized collision', () => {
    const rule = parseRule('mcp__foo.bar__*');
    const intended = normalizeToolNameForProvider('mcp__foo.bar__evil');

    expect(matchesRule(rule, intended)).toBe(true);
    expect(matchesRule(rule, 'mcp__foo_bar__evil')).toBe(false);
    expect(
      matchesRule(
        rule,
        normalizeToolNameForProvider('mcp__foo_bar__evil/tool'),
      ),
    ).toBe(false);
  });

  it('keeps ordinary safe server and intra-segment wildcard rules working', () => {
    expect(matchesRule(parseRule('mcp__chrome'), 'mcp__chrome__navigate')).toBe(
      true,
    );
    expect(
      matchesRule(parseRule('mcp__chrome__use_*'), 'mcp__chrome__use_browser'),
    ).toBe(true);
  });

  it('drops a legacy exact alias owned by two modern tools', () => {
    const sharedAlias = 'mcp__srv__foo_bar';
    const first = normalizeToolNameForProvider('mcp__srv__foo/bar');
    const second = normalizeToolNameForProvider('mcp__srv__foo:bar');
    const tools = [
      { name: first, permissionAliases: [sharedAlias] },
      { name: second, permissionAliases: [sharedAlias] },
    ];

    expect(
      filterUnambiguousMcpPermissionAliases(first, [sharedAlias], tools),
    ).toEqual([]);
    expect(
      filterUnambiguousMcpPermissionAliases(second, [sharedAlias], tools),
    ).toEqual([]);
  });

  it('keeps a unique legacy exact alias', () => {
    const legacyName = 'mcp__srv__foo.bar';
    const registeredName = normalizeToolNameForProvider(legacyName);
    expect(
      filterUnambiguousMcpPermissionAliases(
        registeredName,
        [legacyName],
        [{ name: registeredName, permissionAliases: [legacyName] }],
      ),
    ).toEqual([legacyName]);
  });

  it('keeps a unique legacy truncated alias', () => {
    const rawName = `mcp__server__${'x'.repeat(80)}`;
    const legacyName = generateLegacyMcpToolName(rawName);
    const registeredName = normalizeToolNameForProvider(rawName);

    expect(
      filterUnambiguousMcpPermissionAliases(
        registeredName,
        [legacyName],
        [{ name: registeredName, permissionAliases: [legacyName] }],
      ),
    ).toEqual([legacyName]);
  });
});
