/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { pendingPromptDraft } from './pending-prompt-draft.js';

describe('pendingPromptDraft', () => {
  it('captures full blocks and business context independently of the caller', () => {
    const request = {
      sessionId: 'session',
      prompt: [{ type: 'text' as const, text: 'original' }],
      _meta: { context: { selection: [] as string[] } },
    };
    const draft = pendingPromptDraft(request);
    request.prompt[0].text = 'changed';
    request._meta.context.selection.push('later');
    expect(draft).toEqual({
      prompt: [{ type: 'text', text: 'original' }],
      _meta: { context: { selection: [] } },
    });
  });

  it.each(['clientId', 'authorization', 'internal', 'unknownBusiness'])(
    'does not echo unsupported metadata %s or claim completeness',
    (key) => {
      expect(
        pendingPromptDraft({
          sessionId: 'session',
          prompt: [{ type: 'text', text: 'hello' }],
          _meta: { [key]: 'value' },
        }),
      ).toBeUndefined();
    },
  );
});
