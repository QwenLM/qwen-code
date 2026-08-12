/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Part } from '@google/genai';
import { mapToDisplay, type TrackedToolCall } from './useReactToolScheduler.js';
import { MAX_INLINE_IMAGES_PER_ITEM } from '../utils/inline-image-parts.js';

// Build a minimal successful tracked tool call with the fields mapToDisplay's
// success branch reads. `displayName` drives the collapsible gate.
const makeCompleted = (
  status: 'success' | 'error' | 'cancelled',
  displayName: string,
  responseMedia: Part[] = [],
): TrackedToolCall =>
  ({
    status,
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
            ...(responseMedia.length > 0 ? { parts: responseMedia } : {}),
          },
        },
      ],
    },
  }) as unknown as TrackedToolCall;

const makeSuccess = (
  displayName: string,
  responseMedia: Part[] = [],
): TrackedToolCall => makeCompleted('success', displayName, responseMedia);

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

  it.each(['success', 'error', 'cancelled'] as const)(
    'extracts nested inline images from %s tool response parts',
    (status) => {
      const group = mapToDisplay(
        makeCompleted(status, 'Read File', [
          {
            inlineData: {
              data: 'dG9vbC1pbWFnZQ==',
              mimeType: 'image/png',
              displayName: 'result.png',
            },
          },
        ]),
      );

      expect(group.tools[0].images).toEqual([
        {
          data: 'dG9vbC1pbWFnZQ==',
          mimeType: 'image/png',
        },
      ]);
    },
  );

  it('caps tool images and reports the overflow count', () => {
    const images = Array.from(
      { length: MAX_INLINE_IMAGES_PER_ITEM + 2 },
      (_, index) => ({
        inlineData: {
          data: Buffer.from(`tool-image-${index}`).toString('base64'),
          mimeType: 'image/png',
        },
      }),
    );

    const tool = mapToDisplay(makeCompleted('success', 'Read File', images))
      .tools[0];

    expect(tool.images).toEqual(
      images
        .slice(0, MAX_INLINE_IMAGES_PER_ITEM)
        .map((part) => part.inlineData),
    );
    expect(tool.omittedImageCount).toBe(2);
  });
});
