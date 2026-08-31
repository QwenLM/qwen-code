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

function matchesRawMcpRule(ruleText: string, rawToolName: string): boolean {
  const registeredName = normalizeToolNameForProvider(rawToolName);
  return matchesRule(
    parseRule(ruleText),
    registeredName,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    [rawToolName],
  );
}

describe('MCP permission identity collisions (#10199)', () => {
  it('binds server and wildcard rules to the exact raw server identity', () => {
    const rawToolName = 'mcp__foo.bar__evil';

    expect(matchesRawMcpRule('mcp__foo.bar', rawToolName)).toBe(true);
    expect(matchesRawMcpRule('mcp__foo.bar__*', rawToolName)).toBe(true);
    expect(matchesRawMcpRule('mcp__foo_bar', rawToolName)).toBe(false);
    expect(matchesRawMcpRule('mcp__foo_bar__*', rawToolName)).toBe(false);

    expect(matchesRawMcpRule('mcp__foo.bar', 'mcp__foo_bar__evil')).toBe(false);
    expect(matchesRawMcpRule('mcp__foo.bar__*', 'mcp__foo_bar__evil')).toBe(
      false,
    );
  });

  it('fails closed for unsafe server spellings when raw identity is unavailable', () => {
    const providerSafeName = 'mcp__foo_bar__evil';

    expect(matchesRule(parseRule('mcp__foo.bar'), providerSafeName)).toBe(
      false,
    );
    expect(matchesRule(parseRule('mcp__foo.bar__*'), providerSafeName)).toBe(
      false,
    );
  });

  it('keeps raw server rules working when the tool segment is provider-unsafe', () => {
    const rawToolName = 'mcp__foo.bar__do.it';

    expect(matchesRawMcpRule('mcp__foo.bar', rawToolName)).toBe(true);
    expect(matchesRawMcpRule('mcp__foo.bar__*', rawToolName)).toBe(true);
  });

  it('keeps raw server rules working for names that require provider truncation', () => {
    const rawToolName = `mcp__foo.bar__${'x'.repeat(90)}`;

    expect(normalizeToolNameForProvider(rawToolName)).not.toBe(rawToolName);
    expect(matchesRawMcpRule('mcp__foo.bar', rawToolName)).toBe(true);
    expect(matchesRawMcpRule('mcp__foo.bar__*', rawToolName)).toBe(true);
  });

  it('does not accept a forged public hash suffix as proof of raw identity', () => {
    const trustedRawName = 'mcp__foo.bar__evil';
    const forgedRawName = normalizeToolNameForProvider(trustedRawName);

    expect(forgedRawName).not.toBe(trustedRawName);
    expect(matchesRawMcpRule('mcp__foo.bar', forgedRawName)).toBe(false);
    expect(matchesRawMcpRule('mcp__foo.bar__*', forgedRawName)).toBe(false);
  });

  it('keeps ordinary safe server and intra-segment wildcard rules working', () => {
    expect(matchesRawMcpRule('mcp__chrome', 'mcp__chrome__navigate')).toBe(
      true,
    );
    expect(
      matchesRawMcpRule('mcp__chrome__use_*', 'mcp__chrome__use_browser'),
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

  it('drops a legacy alias that is another tool registered name', () => {
    const sharedName = 'mcp__srv__foo_bar';
    const hashedName = normalizeToolNameForProvider('mcp__srv__foo/bar');
    const tools = [
      { name: hashedName, permissionAliases: [sharedName] },
      { name: sharedName, permissionAliases: [] },
    ];

    expect(
      filterUnambiguousMcpPermissionAliases(hashedName, [sharedName], tools),
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

  it('matches an exact unsafe raw tool rule through authoritative identity', () => {
    const rawToolName = 'mcp__srv__foo/bar';
    expect(matchesRawMcpRule(rawToolName, rawToolName)).toBe(true);
  });
});
