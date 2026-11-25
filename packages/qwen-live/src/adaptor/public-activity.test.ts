/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { publicActivity } from './public-activity.js';

describe('public backend activity', () => {
  it('projects public text, plans and tool text without thought or arbitrary payloads', () => {
    expect(
      publicActivity(
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '\u001b[31mHello' },
        },
        'j1',
      ),
    ).toEqual({
      type: 'activity',
      jobRef: 'j1',
      kind: 'message',
      text: 'Hello',
    });
    expect(
      publicActivity({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'private thought' },
      }),
    ).toBeUndefined();
    expect(
      publicActivity({
        sessionUpdate: 'plan',
        entries: [{ content: 'Test', status: 'in_progress' }, null],
      })?.text,
    ).toBe('[in_progress] Test');
    const result = publicActivity({
      sessionUpdate: 'tool_call_update',
      title: 'Tests',
      status: 'completed',
      rawOutput: { secret: 'private raw' },
      content: [
        { type: 'content', content: { type: 'text', text: 'All passed' } },
        { type: 'content', content: { type: 'image', data: 'private binary' } },
        { type: 'diff', path: 'private path', newText: 'private diff' },
      ],
    });
    expect(result?.text).toBe('Tests\n[completed]\nAll passed');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('bounds every public activity without serializing untrusted nested structures', () => {
    const result = publicActivity({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'x'.repeat(100_000) },
    });
    expect(result?.text.length).toBe(8192);
    expect(
      publicActivity({ sessionUpdate: 'plan', entries: [1, null, {}] }),
    ).toBeUndefined();
  });
});
