/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mapToDisplay, type TrackedToolCall } from './useReactToolScheduler.js';

// Build a minimal successful tracked tool call with the fields mapToDisplay's
// success branch reads. `displayName` drives the collapsible gate.
const makeSuccess = (displayName: string): TrackedToolCall =>
  ({
    status: 'success',
    request: { callId: 'call-1', name: 'read_file', args: {} },
    tool: { displayName, isOutputMarkdown: false },
    invocation: { getDescription: () => 'reading' },
    response: {
      resultDisplay: 'Read 1 file',
      responseParts: [
        {
          functionResponse: {
            id: 'call-1',
            name: 'read_file',
            response: { output: 'FULL FILE CONTENT' },
          },
        },
      ],
    },
  }) as unknown as TrackedToolCall;

describe('mapToDisplay — detailedDisplay (§4.9 live path)', () => {
  it('extracts detailedDisplay for a collapsible (read/search/list) tool', () => {
    const group = mapToDisplay(makeSuccess('Read File'));
    const tool = group.tools[0];
    // Summary stays the compact resultDisplay; full detail is derived from the
    // persisted functionResponse for the Ctrl+O transcript.
    expect(tool.resultDisplay).toBe('Read 1 file');
    expect(tool.detailedDisplay).toBe('FULL FILE CONTENT');
  });

  it('leaves detailedDisplay undefined for a non-collapsible tool', () => {
    // 'Edit' → 'edit' category → not collapsible, so the extraction is skipped
    // (the transcript never reads it for edit/write/command/agent tools).
    const group = mapToDisplay(makeSuccess('Edit'));
    expect(group.tools[0].detailedDisplay).toBeUndefined();
  });
});
