/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { isSystemReminderContent } from '../core/environmentContext.js';
import {
  isManualDreamToolGuardTurn,
  MANUAL_DREAM_TOOL_GUARD_MARKER,
  preserveManualDreamToolGuardMarker,
} from './manual-dream-turn-policy.js';

describe('manual dream turn policy provenance', () => {
  const dreamPrompt: Content = {
    role: 'user',
    parts: [
      { text: MANUAL_DREAM_TOOL_GUARD_MARKER },
      { text: 'consolidate memory' },
    ],
  };

  it('does not masquerade as a system reminder', () => {
    expect(
      isSystemReminderContent({
        role: 'user',
        parts: [{ text: MANUAL_DREAM_TOOL_GUARD_MARKER }],
      }),
    ).toBe(false);
  });

  it('finds the owning marker through a tool-result chain', () => {
    expect(
      isManualDreamToolGuardTurn([
        dreamPrompt,
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'read-1', name: 'read_file', args: {} } },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'read-1',
                name: 'read_file',
                response: { output: 'memory' },
              },
            },
          ],
        },
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'write-1', name: 'write_file', args: {} } },
          ],
        },
      ]),
    ).toBe(true);
  });

  it('does not cross a later ordinary user prompt', () => {
    expect(
      isManualDreamToolGuardTurn([
        dreamPrompt,
        { role: 'model', parts: [{ text: 'dream complete' }] },
        { role: 'user', parts: [{ text: 'ordinary new prompt' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'write-1', name: 'write_file', args: {} } },
          ],
        },
      ]),
    ).toBe(false);
  });

  it('marks an automatic continuation so a later recovery keeps the guard', () => {
    const continuation = preserveManualDreamToolGuardMarker(
      [dreamPrompt, { role: 'model', parts: [{ text: 'not finished' }] }],
      [{ text: 'Stop hook feedback: keep working' }],
    );

    expect(continuation).toEqual([
      { text: MANUAL_DREAM_TOOL_GUARD_MARKER },
      { text: 'Stop hook feedback: keep working' },
    ]);
    expect(
      isManualDreamToolGuardTurn([
        dreamPrompt,
        { role: 'model', parts: [{ text: 'not finished' }] },
        { role: 'user', parts: continuation },
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'write-1', name: 'write_file', args: {} } },
          ],
        },
      ]),
    ).toBe(true);
  });

  it('does not mark an automatic continuation from an ordinary turn', () => {
    const continuation = [{ text: 'Please continue.' }];

    expect(
      preserveManualDreamToolGuardMarker(
        [
          { role: 'user', parts: [{ text: 'ordinary prompt' }] },
          { role: 'model', parts: [{ text: 'not finished' }] },
        ],
        continuation,
      ),
    ).toEqual(continuation);
  });

  it('places the marker after leading tool responses', () => {
    const toolResponse = {
      functionResponse: {
        id: 'read-1',
        name: 'read_file',
        response: { output: 'memory' },
      },
    };

    const continuation = preserveManualDreamToolGuardMarker(
      [dreamPrompt, { role: 'model', parts: [{ text: 'not finished' }] }],
      [toolResponse, { text: 'late same-turn input' }],
    );

    expect(continuation).toEqual([
      toolResponse,
      { text: MANUAL_DREAM_TOOL_GUARD_MARKER },
      { text: 'late same-turn input' },
    ]);
    expect(
      isManualDreamToolGuardTurn([
        { role: 'user', parts: continuation },
        { role: 'model', parts: [{ text: 'continuing' }] },
      ]),
    ).toBe(true);
  });
});
