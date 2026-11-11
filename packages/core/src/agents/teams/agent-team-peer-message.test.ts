/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  formatAgentMessage,
  formatTeammateMessage,
  parseTeammateMessage,
} from './agent-team-peer-message.js';

describe('teammate message envelope', () => {
  it('formats ordinary peer messages with the agent-message envelope', () => {
    const formatted = formatAgentMessage({
      from: 'reviewer<&"',
      text: 'Found <agent-message> and </agent-message> in input.',
    });

    expect(formatted).toBe(
      '<agent-message from="reviewer&lt;&amp;&quot;">\n' +
        'Found <\\agent-message> and <\\/agent-message> in input.\n' +
        '</agent-message>',
    );
    expect(parseTeammateMessage(formatted)).toEqual({
      from: 'reviewer<&"',
      text: 'Found <agent-message> and </agent-message> in input.',
    });
  });

  it('round-trips attributes and guards teammate tags in message content', () => {
    const formatted = formatTeammateMessage({
      from: 'reviewer<&"',
      color: 'blue',
      summary: 'Review "API" & tests',
      text: 'Found <teammate-message> and </teammate-message> in input.',
    });

    expect(formatted).toContain('teammate_id="reviewer&lt;&amp;&quot;"');
    expect(formatted).toContain(
      'Found <\\teammate-message> and <\\/teammate-message> in input.',
    );
    expect(parseTeammateMessage(formatted)).toEqual({
      from: 'reviewer<&"',
      color: 'blue',
      summary: 'Review "API" & tests',
      text: 'Found <teammate-message> and </teammate-message> in input.',
    });
  });
});
