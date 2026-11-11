/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { composeRewakeNotification } from './hookEventHandler.js';

describe('composeRewakeNotification', () => {
  const baseArgs = {
    hookName: 'security-scan',
    message: 'found 1 finding',
  };

  it('uses default prefix and summary when no overrides', () => {
    const { value, summary, prefix } = composeRewakeNotification(baseArgs);
    expect(prefix).toBe('Stop hook blocking error from command "security-scan":');
    expect(summary).toBe('Stop hook feedback');
    expect(value).toContain('<task-notification>');
    expect(value).toContain('<summary>Stop hook feedback</summary>');
    expect(value).toContain('</task-notification>');
    expect(value).toContain(
      '<system-reminder>Stop hook blocking error from command "security-scan": found 1 finding</system-reminder>',
    );
  });

  it('respects rewakeMessage override (prefix only)', () => {
    const { value, prefix } = composeRewakeNotification({
      ...baseArgs,
      rewakeMessage: '[krypton-security] background review:',
    });
    expect(prefix).toBe('[krypton-security] background review:');
    expect(value).toContain(
      '<system-reminder>[krypton-security] background review: found 1 finding</system-reminder>',
    );
    // Default summary still applied.
    expect(value).toContain('<summary>Stop hook feedback</summary>');
  });

  it('respects rewakeSummary override (summary only)', () => {
    const { value, summary } = composeRewakeNotification({
      ...baseArgs,
      rewakeSummary: 'Commit security review found issues',
    });
    expect(summary).toBe('Commit security review found issues');
    expect(value).toContain(
      '<summary>Commit security review found issues</summary>',
    );
    // Default prefix still applied.
    expect(value).toContain(
      'Stop hook blocking error from command "security-scan":',
    );
  });

  it('respects both overrides simultaneously', () => {
    const { value, prefix, summary } = composeRewakeNotification({
      ...baseArgs,
      rewakeMessage: 'CUSTOM PREFIX:',
      rewakeSummary: 'CUSTOM SUMMARY',
    });
    expect(prefix).toBe('CUSTOM PREFIX:');
    expect(summary).toBe('CUSTOM SUMMARY');
    expect(value).toContain('<summary>CUSTOM SUMMARY</summary>');
    expect(value).toContain(
      '<system-reminder>CUSTOM PREFIX: found 1 finding</system-reminder>',
    );
  });

  it('collapses internal whitespace in rewakeSummary', () => {
    const { summary, value } = composeRewakeNotification({
      ...baseArgs,
      rewakeSummary: '  multi\n  line\tsummary   with    spaces  ',
    });
    expect(summary).toBe('multi line summary with spaces');
    expect(value).toContain('<summary>multi line summary with spaces</summary>');
  });

  it('truncates rewakeSummary to 300 characters after collapse', () => {
    const long = 'a'.repeat(500);
    const { summary } = composeRewakeNotification({
      ...baseArgs,
      rewakeSummary: long,
    });
    expect(summary).toHaveLength(300);
    expect(summary).toBe('a'.repeat(300));
  });

  it('truncates after collapse, not before', () => {
    // 200 spaces + 200 'a' → after collapse is "a a a..." sized close to 200,
    // well under 300; this verifies collapse runs before slice.
    const input = ' '.repeat(200) + 'tail';
    const { summary } = composeRewakeNotification({
      ...baseArgs,
      rewakeSummary: input,
    });
    expect(summary).toBe('tail');
  });

  it('escapes XML-significant characters in rewakeSummary', () => {
    const { value } = composeRewakeNotification({
      ...baseArgs,
      rewakeSummary: 'before <script>alert("x")</script> & after',
    });
    expect(value).toContain(
      '<summary>before &lt;script&gt;alert("x")&lt;/script&gt; &amp; after</summary>',
    );
    // Make sure raw `<` `>` `&` did not leak into the summary block.
    expect(value).not.toContain('<summary>before <script>');
  });

  it('does NOT escape XML chars in rewakeMessage / message (model-facing free text)', () => {
    const { value } = composeRewakeNotification({
      ...baseArgs,
      rewakeMessage: 'CUSTOM <prefix>:',
      message: 'detail with <tag>',
    });
    // Prefix and message land inside <system-reminder>, not <summary>; the
    // model is fine with raw angle brackets there.
    expect(value).toContain(
      '<system-reminder>CUSTOM <prefix>: detail with <tag></system-reminder>',
    );
  });
});
