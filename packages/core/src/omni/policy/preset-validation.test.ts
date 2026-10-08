/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import stripJsonComments from 'strip-json-comments';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeOmniProcessingConfig } from './config.js';
import { OmniDownsampleImageTool } from './tools/downsample-image.js';
import { OmniDownscaleVideoTool } from './tools/downscale-video.js';
import { OmniDownsampleAudioTool } from './tools/downsample-audio.js';
import { OmniExtractKeyframesTool } from './tools/extract-keyframes.js';
import { OmniExtractAudioTool } from './tools/extract-audio.js';
import { OmniTranscribeAudioTool } from './tools/transcribe-audio.js';
import { OmniOcrImageTool } from './tools/ocr-image.js';
import { OmniClipVideoTool } from './tools/clip-video.js';
import { OmniClipAudioTool } from './tools/clip-audio.js';
import { OmniUnderstandVideoSegmentsTool } from './tools/understand-video-segments.js';
import { OmniCaptionImageTool } from './tools/caption-image.js';

/**
 * Guards the shipped fixedPolicy preset
 * (docs/users/features/omni-fixed-policies-preset.json): the file users
 * copy into settings.json must keep normalizing cleanly against the real
 * tool registry as tools and the DSL evolve.
 */
describe('omni-fixed-policies-preset.json', () => {
  it('normalizes against the real tool registry without errors', () => {
    const presetPath = path.resolve(
      process.cwd(),
      '../../docs/users/features/omni-fixed-policies-preset.json',
    );
    const parsed = JSON.parse(
      stripJsonComments(fs.readFileSync(presetPath, 'utf8')),
    ) as { omni: { processing: Record<string, unknown> } };

    const tools = [
      new OmniDownsampleImageTool(),
      new OmniDownscaleVideoTool({}),
      new OmniDownsampleAudioTool({}),
      new OmniExtractKeyframesTool({}),
      new OmniExtractAudioTool({}),
      new OmniTranscribeAudioTool(),
      new OmniOcrImageTool(),
      new OmniClipVideoTool({}),
      new OmniClipAudioTool({}),
      new OmniUnderstandVideoSegmentsTool(),
      new OmniCaptionImageTool(),
    ];
    const lookup = {
      getTool: (name: string) => tools.find((t) => t.name === name),
    };

    const normalized = normalizeOmniProcessingConfig(
      parsed.omni.processing,
      lookup,
    );

    // 11 policies: design-doc 4.1–4.9 with 4.1 expanded into its 3-step
    // extract → downsample → transcribe chain.
    expect(normalized.fixedPolicies).toHaveLength(11);
    // Documented execution order: chain starters before chain followers,
    // independent degradations below them, >10MB fallbacks last.
    const priorityOf = (id: string): number =>
      normalized.fixedPolicies.find((p) => p.id === id)?.priority ?? -1;
    expect(priorityOf('long-video-extract-audio')).toBeGreaterThan(
      priorityOf('long-video-transcribe'),
    );
    expect(priorityOf('long-video-audio-downsample')).toBeGreaterThan(
      priorityOf('long-video-transcribe'),
    );
    expect(priorityOf('long-video-transcribe')).toBeGreaterThan(
      priorityOf('oversize-audio-transcribe'),
    );
    expect(priorityOf('large-image-downsample')).toBeGreaterThan(
      priorityOf('oversize-image-downsample'),
    );
    // Memory-gated policies evaluate the memory.* namespace.
    expect(
      normalized.fixedPolicies.find((p) => p.id === 'long-video-extract-audio')
        ?.when,
    ).toEqual([
      'all',
      ['>', ['field', 'resource.durationMs'], 1800000],
      ['==', ['field', 'memory.hasTranscript'], 0],
    ]);

    expect(() =>
      normalizeOmniProcessingConfig(
        {
          policyTools: {
            omni_clip_video: { settings: { softClipBudget: 1 } },
          },
        },
        lookup,
      ),
    ).not.toThrow();
  });
});
