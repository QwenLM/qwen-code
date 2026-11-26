/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  PermissionModes,
  rulesForToolName,
  type PermissionRules,
  type ToolCheckContext,
} from '../../../permissions/manager/decision/index.js';
import { createWebFetchToolChecker } from './web-fetch-checker.js';
import { withToolLevelRules } from '../rule-precedence.js';
import type { ToolPermissionReason } from '../checker-reasons.js';

function rules(overrides: Partial<PermissionRules> = {}): PermissionRules {
  return { allow: {}, deny: {}, ask: {}, ...overrides };
}

function contextFor(
  toolName: string,
  ruleSet: PermissionRules,
): ToolCheckContext<ToolPermissionReason> {
  return {
    mode: PermissionModes.Default,
    rules: ruleSet,
    cwd: '/repo',
    additionalDirectories: [],
    rulesForTool: rulesForToolName(ruleSet, toolName),
    toolUseId: 'tu-1',
  };
}

describe('web fetch tool check', () => {
  const neverPreapproved = () => false;
  const checker = createWebFetchToolChecker('WebFetch', neverPreapproved);

  it('asks by default and offers to remember the host it names', async () => {
    const result = await checker.check(
      { url: 'https://example.com/page' },
      contextFor('WebFetch', rules()),
    );
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.suggestions).toEqual([
        expect.objectContaining({
          rules: [{ toolName: 'WebFetch', ruleContent: 'example.com' }],
        }),
      ]);
    }
  });

  it('allows the same host once the suggested rule is persisted', async () => {
    const first = await checker.check(
      { url: 'https://example.com/page' },
      contextFor('WebFetch', rules()),
    );
    expect(first.kind).toBe('ask');
    if (first.kind !== 'ask') return;
    const suggestion = first.suggestions?.[0];
    const rule = suggestion?.type === 'addRules' ? suggestion.rules[0] : undefined;
    if (!rule) throw new Error('Expected an allow-rule suggestion');

    const persisted = rules({
      allow: {
        localSettings: [`${rule.toolName}(${rule.ruleContent})`],
      },
    });
    const second = await checker.check(
      { url: 'https://example.com/other' },
      contextFor('WebFetch', persisted),
    );
    expect(second.kind).toBe('allow');
  });

  it('lets a tool-level allow cover every host', async () => {
    // `WebFetch(*)` normalises to the tool-level rule `WebFetch`; it is what
    // the old prompt persisted, so it must fill the default ask.
    const wrapped = withToolLevelRules('WebFetch', checker);
    for (const ruleString of ['WebFetch', 'WebFetch(*)']) {
      const ruleSet = rules({ allow: { localSettings: [ruleString] } });
      for (const url of ['https://example.com/a', 'https://other.test/b']) {
        const result = await wrapped.check(
          { url },
          contextFor('WebFetch', ruleSet),
        );
        expect(result.kind).toBe('allow');
      }
    }
  });

  it('allows via a host rule and via a host-with-path rule', async () => {
    const hostRule = rules({ allow: { userSettings: ['WebFetch(example.com)'] } });
    expect(
      (
        await checker.check(
          { url: 'https://example.com/a' },
          contextFor('WebFetch', hostRule),
        )
      ).kind,
    ).toBe('allow');

    const pathRule = rules({
      allow: { userSettings: ['WebFetch(example.com/docs)'] },
    });
    expect(
      (
        await checker.check(
          { url: 'https://example.com/docs' },
          contextFor('WebFetch', pathRule),
        )
      ).kind,
    ).toBe('allow');
    expect(
      (
        await checker.check(
          { url: 'https://example.com/other' },
          contextFor('WebFetch', pathRule),
        )
      ).kind,
    ).toBe('ask');
  });

  it('lets a user rule outrank the preapproved list', async () => {
    const alwaysPreapproved = () => true;
    const strict = createWebFetchToolChecker('WebFetch', alwaysPreapproved);
    const ruleSet = rules({ deny: { userSettings: ['WebFetch(example.com)'] } });
    const result = await strict.check(
      { url: 'https://example.com/a' },
      contextFor('WebFetch', ruleSet),
    );
    expect(result.kind).toBe('deny');
  });

  it('allows a preapproved host when no rule covers it', async () => {
    const lenient = createWebFetchToolChecker('WebFetch', () => true);
    const result = await lenient.check(
      { url: 'https://docs.example.com/a' },
      contextFor('WebFetch', rules()),
    );
    expect(result.kind).toBe('allow');
    expect(result.extra?.decisionPoint).toBe(
      'web_fetch.preapproved_host.allow',
    );
  });

  it('refuses a call with no url', async () => {
    const result = await checker.check({}, contextFor('WebFetch', rules()));
    expect(result.kind).toBe('deny');
    expect(result.extra?.decisionPoint).toBe('web_fetch.no_url.deny');
  });
});
