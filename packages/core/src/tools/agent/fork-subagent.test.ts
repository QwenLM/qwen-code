/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { describe, expect, it } from 'vitest';
import {
  buildInheritedSubagentHistory,
  normalizeForkTurns,
} from './fork-subagent.js';

describe('buildInheritedSubagentHistory', () => {
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

  it('defaults to none and normalizes explicit values', () => {
    expect(normalizeForkTurns(undefined)).toBe('none');
    expect(normalizeForkTurns('all')).toBe('all');
    expect(normalizeForkTurns('none')).toBe('none');
    expect(normalizeForkTurns('3')).toBe(3);
  });

  it('inherits all conversation history without duplicating startup context', () => {
    expect(
      buildInheritedSubagentHistory([startup, firstUser, firstModel], 'all'),
    ).toEqual([firstUser, firstModel]);
  });

  it('returns no parent history for none', () => {
    expect(
      buildInheritedSubagentHistory([startup, firstUser, firstModel], 'none'),
    ).toEqual([]);
  });

  it('counts real user turns rather than tool responses', () => {
    expect(
      buildInheritedSubagentHistory(
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
    expect(
      buildInheritedSubagentHistory([startup, firstUser, firstModel], 3),
    ).toEqual([firstUser, firstModel]);
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
      buildInheritedSubagentHistory(
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
      buildInheritedSubagentHistory(
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
      buildInheritedSubagentHistory(
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
      buildInheritedSubagentHistory(
        [startup, firstUser, toolCall, mixedToolResponse, firstModel],
        1,
      ),
    ).toEqual([firstUser, toolCall, mixedToolResponse, firstModel]);
  });

  it('closes open function calls before the child task user turn', () => {
    const result = buildInheritedSubagentHistory(
      [startup, firstUser, toolCall],
      'all',
    );

    expect(result).toEqual([
      firstUser,
      toolCall,
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-1',
              name: 'read_file',
              response: { output: 'Delegated to child agent.' },
            },
          },
        ],
      },
      { role: 'model', parts: [{ text: 'Acknowledged.' }] },
    ]);
  });

  it('preserves a trailing function response and appends a model boundary', () => {
    expect(
      buildInheritedSubagentHistory(
        [startup, firstUser, toolCall, toolResult],
        'all',
      ),
    ).toEqual([
      firstUser,
      toolCall,
      toolResult,
      { role: 'model', parts: [{ text: 'Acknowledged.' }] },
    ]);
  });

  it('drops an unanswered trailing user turn', () => {
    expect(
      buildInheritedSubagentHistory(
        [startup, firstUser, firstModel, secondUser],
        'all',
      ),
    ).toEqual([firstUser, firstModel]);
  });
});
