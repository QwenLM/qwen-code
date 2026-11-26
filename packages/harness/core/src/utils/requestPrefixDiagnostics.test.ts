/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { requestPrefixFacts } from './requestPrefixDiagnostics.js';

describe('request prefix diagnostics', () => {
  it('separates system, tools and conversation differences without exposing content', () => {
    const prompt = {
      messages: [
        { role: 'system' as const, content: 'private-system' },
        { role: 'user' as const, content: 'private-user' },
      ],
      tools: [{ name: 'private-tool', parameters: { private: true } }],
    };
    const original = JSON.stringify(prompt);
    const facts = requestPrefixFacts(prompt);
    const changed = requestPrefixFacts({
      ...prompt,
      messages: [prompt.messages[0], { role: 'user', content: 'different' }],
    });
    expect(facts['system_sha256']).toBe(changed['system_sha256']);
    expect(facts['tools_sha256']).toBe(changed['tools_sha256']);
    expect(facts['messages_sha256']).not.toBe(changed['messages_sha256']);
    expect(JSON.stringify(facts)).not.toContain('private');
    expect(JSON.stringify(prompt)).toBe(original);
    expect(facts['system_sha256']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps a bounded prefix comparable when a later suffix changes', () => {
    const facts = (suffix: string) =>
      requestPrefixFacts({
        messages: [{ role: 'user', content: 'x'.repeat(5000) + suffix }],
      });
    const first = facts('one');
    const next = facts('two');
    expect(first['messages_prefix_bytes']).toBe(4096);
    expect(first['messages_prefix_sha256']).toBe(next['messages_prefix_sha256']);
    expect(first['messages_sha256']).not.toBe(next['messages_sha256']);
  });

  it('attributes a tools or system change to the entry that changed', () => {
    const prompt = (codeModeDescription: string, reminder: string) => ({
      messages: [
        { role: 'system' as const, content: 'private-base' },
        { role: 'system' as const, content: reminder },
      ],
      tools: [
        { name: 'CodeMode', description: codeModeDescription },
        { name: 'private-mcp-tool', description: 'private-description' },
      ],
    });
    const fingerprints = (
      facts: Record<string, string | number>,
      key: string,
    ) => String(facts[key]).split(',');
    const before = requestPrefixFacts(prompt('catalog-one', 'private-a'));
    const after = requestPrefixFacts(prompt('catalog-two', 'private-b'));
    const whole = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const original = prompt('catalog-one', 'private-a');
    expect(before['tools_sha256']).toBe(whole(original.tools));
    expect(before['system_sha256']).toBe(whole(original.messages));

    const [codeBefore, mcpBefore] = fingerprints(before, 'tool_fingerprints');
    const [codeAfter, mcpAfter] = fingerprints(after, 'tool_fingerprints');
    const codeModeNameHash = createHash('sha256')
      .update('CodeMode')
      .digest('hex')
      .slice(0, 8);
    expect(codeBefore.split(':')[0]).toBe(codeModeNameHash);
    expect(codeAfter.split(':')[0]).toBe(codeModeNameHash);
    expect(codeAfter).not.toBe(codeBefore);
    expect(mcpAfter).toBe(mcpBefore);

    const [baseBefore, reminderBefore] = fingerprints(
      before,
      'system_fingerprints',
    );
    const [baseAfter, reminderAfter] = fingerprints(
      after,
      'system_fingerprints',
    );
    expect(baseAfter).toBe(baseBefore);
    expect(reminderAfter).not.toBe(reminderBefore);
    expect(JSON.stringify(after)).not.toContain('private');
    expect(JSON.stringify(after)).not.toContain('CodeMode');
  });
});
