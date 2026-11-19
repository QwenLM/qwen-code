/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  parseManagedPermissionRules,
  nonEmptyManagedPermissionRules,
} from './managed-permission-rules.js';

const rules = (
  allow: string[] = [],
  ask: string[] = [],
  deny: string[] = [],
) => ({ allow, ask, deny });

describe('portable Managed permission rules', () => {
  it('copies supported tool, shell, domain and producer MCP patterns', () => {
    const input = rules([
      'Read',
      'Bash(git status*)',
      'Shell(echo $(date))',
      'WebFetch(domain:*.example.com)',
      'mcp__server__*',
      'mcp__server',
    ]);
    const parsed = parseManagedPermissionRules(input);
    expect(parsed).toEqual(input);
    input.allow.push('Write');
    expect(parsed.allow).not.toContain('Write');
    expect(nonEmptyManagedPermissionRules(rules())).toBeUndefined();
  });
  it.each([
    null,
    [],
    {},
    { allow: [], ask: [] },
    { ...rules(), extra: [] },
    rules(['Read(./secret)']),
    rules(['Agent(model:fast)']),
    rules(['Bash()']),
    rules(['Bash( git status)']),
    rules(['Read ']),
    rules(['Read', 'Read']),
    rules(['Bash(echo\nsecret)']),
    rules(['mcp__server*__tool']),
    rules(['mcp__*']),
    rules(['WebFetch(domain:)']),
    rules(['WebFetch(domain:a/path)']),
    rules(['Bash(' + 'x'.repeat(510) + ')']),
    rules(Array.from({ length: 33 }, (_, index) => `tool${index}`)),
    rules(
      Array.from({ length: 32 }, (_, index) => `a${index}`),
      Array.from({ length: 32 }, (_, index) => `b${index}`),
      ['Write'],
    ),
    rules(
      Array.from(
        { length: 20 },
        (_, index) => `Bash(${index}${'x'.repeat(450)})`,
      ),
    ),
    rules(['Bash(' + '中'.repeat(170) + ')']),
  ])('rejects unsupported or oversized policy %j', (value) => {
    expect(() => parseManagedPermissionRules(value)).toThrow(
      'Invalid portable',
    );
  });
});
