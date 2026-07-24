/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { normalizeForkTurns, selectForkHistory } from './fork-subagent.js';

describe('selectForkHistory', () => {
  const startup: Content = {
    role: 'user',
    parts: [{ text: '<system-reminder>\nstartup\n</system-reminder>' }],
  };
  const firstUser: Content = {
    role: 'user',
    parts: [{ text: 'first question' }],
  };
  const firstModel: Content = {
    role: 'model',
    parts: [{ text: 'first answer' }],
  };
  const toolCall: Content = {
    role: 'model',
    parts: [
      {
        functionCall: {
          id: 'call-1',
          name: 'read_file',
          args: { path: 'a.ts' },
        },
      },
    ],
  };
  const toolResult: Content = {
    role: 'user',
    parts: [
      {
        functionResponse: {
          id: 'call-1',
          name: 'read_file',
          response: { output: 'file contents' },
        },
      },
    ],
  };
  const secondUser: Content = {
    role: 'user',
    parts: [{ text: 'second question' }],
  };
  const secondModel: Content = {
    role: 'model',
    parts: [{ text: 'second answer' }],
  };

  it('defaults to all and normalizes explicit values', () => {
    expect(normalizeForkTurns(undefined)).toBe('all');
    expect(normalizeForkTurns('all')).toBe('all');
    expect(normalizeForkTurns('3')).toBe(3);
  });

  it('preserves all history when no bounded window is requested', () => {
    expect(selectForkHistory([startup, firstUser, firstModel], 'all')).toEqual([
      startup,
      firstUser,
      firstModel,
    ]);
  });

  it('counts real user turns rather than tool responses', () => {
    expect(
      selectForkHistory(
        [
          startup,
          firstUser,
          toolCall,
          toolResult,
          firstModel,
          secondUser,
          secondModel,
        ],
        1,
      ),
    ).toEqual([secondUser, secondModel]);
  });

  it('keeps all available context when fewer turns exist than requested', () => {
    expect(selectForkHistory([startup, firstUser, firstModel], 3)).toEqual([
      firstUser,
      firstModel,
    ]);
  });

  it('returns empty when no real user turns exist after the synthetic prefix', () => {
    expect(selectForkHistory([startup], 1)).toEqual([]);
  });

  it('does not count or inherit a compacted-history prefix for a numeric window', () => {
    const compactedSummary: Content = {
      role: 'user',
      parts: [{ text: 'Resume the prior task from this summary.' }],
    };
    const compactedAck: Content = {
      role: 'model',
      parts: [{ text: 'Got it. Thanks for the additional context!' }],
    };

    expect(
      selectForkHistory(
        [startup, compactedSummary, compactedAck, firstUser, firstModel],
        3,
      ),
    ).toEqual([firstUser, firstModel]);
  });

  it('does not count pure reminders as user turns', () => {
    const reminder: Content = {
      role: 'user',
      parts: [{ text: '<system-reminder>\nchanged tools\n</system-reminder>' }],
    };

    expect(
      selectForkHistory(
        [startup, firstUser, firstModel, reminder, secondUser, secondModel],
        1,
      ),
    ).toEqual([secondUser, secondModel]);
  });

  it('does not count empty user content as a real turn', () => {
    const emptyUser: Content = { role: 'user', parts: [] };
    const emptyAck: Content = {
      role: 'model',
      parts: [{ text: 'ignored empty input' }],
    };

    expect(
      selectForkHistory(
        [startup, firstUser, firstModel, emptyUser, emptyAck],
        1,
      ),
    ).toEqual([firstUser, firstModel, emptyUser, emptyAck]);
  });

  it('does not count a tool response mixed with a pure reminder', () => {
    const mixedToolResponse: Content = {
      role: 'user',
      parts: [
        ...toolResult.parts!,
        { text: '<system-reminder>\nchanged tools\n</system-reminder>' },
      ],
    };

    expect(
      selectForkHistory(
        [startup, firstUser, toolCall, mixedToolResponse, firstModel],
        1,
      ),
    ).toEqual([firstUser, toolCall, mixedToolResponse, firstModel]);
  });

  it('does not share nested mutable parts with the parent history', () => {
    const nestedImage = {
      inlineData: { mimeType: 'image/png', data: 'c2hvdA==' },
    };
    const toolResultWithImage: Content = {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'call-1',
            name: 'read_file',
            response: { output: 'captured' },
            parts: [nestedImage],
          },
        },
      ],
    };

    const inherited = selectForkHistory(
      [startup, firstUser, toolCall, toolResultWithImage, firstModel],
      'all',
    );
    const inheritedNestedImage =
      inherited[3]?.parts?.[0]?.functionResponse?.parts?.[0];

    expect(inheritedNestedImage).toEqual(nestedImage);
    expect(inheritedNestedImage).not.toBe(nestedImage);
  });
});
