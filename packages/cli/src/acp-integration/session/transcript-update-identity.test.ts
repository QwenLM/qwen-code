/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { TranscriptUpdateIdentityProjector } from './transcript-update-identity.js';

function textUpdate(
  sessionUpdate:
    | 'user_message_chunk'
    | 'agent_message_chunk'
    | 'agent_thought_chunk',
  text: string,
): SessionUpdate {
  return {
    sessionUpdate,
    content: { type: 'text', text },
  } as SessionUpdate;
}

function segmentId(update: SessionUpdate): string | undefined {
  return (
    update._meta as { qwenTranscript?: { segmentId?: string } } | undefined
  )?.qwenTranscript?.segmentId;
}

describe('TranscriptUpdateIdentityProjector', () => {
  it('reuses one stable identity for streaming deltas in the same lane', () => {
    const projector = new TranscriptUpdateIdentityProjector();
    const first = projector.project(
      textUpdate('agent_message_chunk', 'first '),
      'session-a########1',
    );
    const second = projector.project(
      textUpdate('agent_message_chunk', 'second'),
      'session-a########1',
    );

    expect(segmentId(first)).toMatch(/^live:[0-9a-f]{32}$/);
    expect(segmentId(second)).toBe(segmentId(first));
  });

  it('starts a new deterministic segment after a lane or tool boundary', () => {
    const run = (): string[] => {
      const projector = new TranscriptUpdateIdentityProjector();
      const promptId = 'session-a########1';
      const assistant = projector.project(
        textUpdate('agent_message_chunk', 'answer'),
        promptId,
      );
      const thought = projector.project(
        textUpdate('agent_thought_chunk', 'thinking'),
        promptId,
      );
      projector.project(
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'read-1',
          title: 'Read',
          status: 'pending',
        } as SessionUpdate,
        promptId,
      );
      const resumed = projector.project(
        textUpdate('agent_message_chunk', 'done'),
        promptId,
      );
      return [assistant, thought, resumed].map((update) => segmentId(update)!);
    };

    const first = run();
    expect(new Set(first)).toHaveLength(3);
    expect(run()).toEqual(first);
  });

  it('gives consecutive discrete messages distinct deterministic segments', () => {
    const run = (): string[] => {
      const projector = new TranscriptUpdateIdentityProjector();
      return ['first', 'second'].map(
        (text) =>
          segmentId(
            projector.project(
              {
                ...textUpdate('agent_message_chunk', text),
                _meta: { qwenDiscreteMessage: true },
              } as SessionUpdate,
              'session-a########1',
            ),
          )!,
      );
    };

    const first = run();
    expect(new Set(first)).toHaveLength(2);
    expect(run()).toEqual(first);
  });

  it('preserves persisted replay identity and unrelated metadata', () => {
    const projector = new TranscriptUpdateIdentityProjector();
    const update = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'history' },
      _meta: {
        timestamp: 1,
        qwenTranscript: { segmentId: 'record-1:0' },
      },
    } as SessionUpdate;

    expect(projector.project(update, undefined)).toBe(update);
    expect(projector.project(update, 'session-a########1')).toBe(update);
  });

  it('continues an explicitly identified live segment', () => {
    const projector = new TranscriptUpdateIdentityProjector();
    const promptId = 'session-a########1';
    const first = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'first ' },
      _meta: { qwenTranscript: { segmentId: 'native-segment' } },
    } as SessionUpdate;

    expect(projector.project(first, promptId)).toBe(first);
    expect(
      segmentId(
        projector.project(
          textUpdate('agent_message_chunk', 'second'),
          promptId,
        ),
      ),
    ).toBe('native-segment');
  });

  it('does not invent identity without a stable prompt source', () => {
    const projector = new TranscriptUpdateIdentityProjector();
    const update = textUpdate('agent_message_chunk', 'unscoped');

    expect(projector.project(update, undefined)).toBe(update);
    expect(segmentId(update)).toBeUndefined();
  });
});
