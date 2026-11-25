/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer tests for `peer_mention`.
 */

import { describe, expect, it } from 'vitest';
import { PeerMentionAttachment } from './types.js';

const { normalizeAttachmentForAPI } = await import('./normalize.js');

function render(
  overrides: Partial<ReturnType<PeerMentionAttachment['toTranscript']>> = {},
): string {
  const messages = normalizeAttachmentForAPI(
    new PeerMentionAttachment({
      type: 'peer_mention',
      mention: 'reviewer',
      status: 'resolved',
      candidates: [{ label: 'reviewer', detail: '' }],
      total: 1,
      ...overrides,
    }),
  );
  expect(messages).toHaveLength(1);
  const content = messages[0]?.content;
  const block = content && typeof content !== 'string' ? content[0] : undefined;
  if (block?.type !== 'text') {
    throw new Error('应输出标准 peer mention 提醒文本');
  }
  return block.text;
}

describe('normalizeAttachmentForAPI: peer_mention', () => {
  it('[AC6] names the label and the tool, and forbids an unasked send', () => {
    const text = render();
    expect(text).toContain('"reviewer"');
    expect(text).toContain('SendMessage');
    expect(text).toContain('to: "reviewer"');
    expect(text).toContain(
      "Do not message it unless the user's message actually asks you to",
    );
  });

  it('[AC6] addresses the label, not the token the user typed', () => {
    const text = render({
      mention: 'peer-cli-4',
      candidates: [{ label: 'peer-cli-4-f9', detail: '' }],
    });
    expect(text).toContain('to: "peer-cli-4-f9"');
    expect(text).toContain('@peer-cli-4');
  });

  it('[AC7] lists candidates and demands confirmation', () => {
    const text = render({
      status: 'ask',
      mention: 'peer-cli-4',
      candidates: [
        {
          label: 'peer-cli-4-f9',
          detail: 'interactive, idle, cwd /home/dev/a',
        },
        {
          label: 'peer-cli-4-94',
          detail: 'interactive, busy, cwd /home/dev/b',
        },
      ],
      total: 2,
    });
    // One line per option, each carrying what tells it from its namesake —
    // two bare labels are not a question anyone can answer.
    expect(text).toContain(
      '- "peer-cli-4-f9" (interactive, idle, cwd /home/dev/a)',
    );
    expect(text).toContain(
      '- "peer-cli-4-94" (interactive, busy, cwd /home/dev/b)',
    );
    expect(text).toContain('Ask the user which one they meant');
    expect(text).toContain('self-chosen and unverified');
    expect(text).not.toContain('showing');
  });

  it('omits the parenthetical when there is no detail to give', () => {
    const text = render({
      status: 'ask',
      mention: 'twin',
      candidates: [
        { label: 'twin-a', detail: '' },
        { label: 'twin-b', detail: '' },
      ],
      total: 2,
    });
    expect(text).toContain('- "twin-a"\n- "twin-b"');
  });

  it('[AC7] reports the overflow when more matched than are listed', () => {
    const text = render({
      status: 'ask',
      mention: 'peer-cli-4',
      candidates: [
        { label: 'a', detail: '' },
        { label: 'b', detail: '' },
        { label: 'c', detail: '' },
      ],
      total: 5,
    });
    expect(text).toContain('5 sessions answer to that name; showing 3');
  });

  it('[AC14] renders inside a system reminder that the payload cannot close', () => {
    // Both fields are vetted upstream, so nothing here can carry a closing tag;
    // this pins that the reminder wrapper is what the text lands in.
    const text = render();
    expect(text).toContain('<system-reminder>');
    expect(text).toContain('</system-reminder>');
    expect(text.match(/<\/system-reminder>/g)).toHaveLength(1);
  });
});
