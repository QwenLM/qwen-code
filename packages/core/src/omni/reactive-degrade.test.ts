/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Content, Part } from '@google/genai';
import { ToolNames } from '../tools/tool-names.js';
import type { NormalizedFixedPolicy } from './policy/types.js';
import {
  applyOssMediaReplacements,
  buildLadderPolicy,
  collectOssMediaRefs,
  contentsHaveOssMedia,
  getObservedServerInputLimit,
  recordObservedServerInputLimit,
  resetObservedServerInputLimitsForTests,
  type OssMediaReplacement,
} from './reactive-degrade.js';
import { OMNI_DISCLOSURE_TEXT_PREFIX } from './disclosure.js';

afterEach(() => {
  resetObservedServerInputLimitsForTests();
});

function videoGuardPolicy(
  overrides?: Partial<NormalizedFixedPolicy>,
): NormalizedFixedPolicy {
  return {
    id: 'video-downscale',
    priority: 0,
    mediaTypes: ['video'],
    origins: ['user', 'tool', 'policy'],
    onConditionUnavailable: 'skip',
    toolName: ToolNames.OMNI_DOWNSCALE_VIDEO,
    arguments: {},
    maxRunsPerLineage: 1,
    onFailure: 'continue',
    output: {
      reprocessMedia: false,
      source: 'omit',
      artifacts: { '*': 'include' },
    },
    stage: 'transport_guard',
    ...overrides,
  };
}

function ossContents(): Content[] {
  return [
    {
      role: 'user',
      parts: [
        { text: 'analyze this' },
        {
          fileData: {
            fileUri: 'oss://bucket/clip',
            mimeType: 'video/mp4',
            displayName: 'movie.mkv',
          },
        },
        {
          fileData: {
            fileUri: 'oss://bucket/frame1',
            mimeType: 'image/jpeg',
            displayName: 'frame1.jpg',
          },
        },
      ],
    },
    {
      role: 'model',
      parts: [{ text: 'ok' }],
    },
  ];
}

/** A tool result carrying media (and a text sibling) on
 * `functionResponse.parts` — qwen-code's extension to the \@google/genai
 * schema (see `coreToolScheduler.createFunctionResponsePart`), which is
 * why the nested array is typed as `Part[]` and cast on assembly. */
function nestedToolResultPart(): Part {
  const nestedParts: Part[] = [
    { text: 'tool output' },
    {
      fileData: {
        fileUri: 'oss://bucket/nested',
        mimeType: 'video/mp4',
        displayName: 'nested.mp4',
      },
    },
  ];
  const functionResponse = {
    name: 'some_tool',
    response: {},
    parts: nestedParts,
  };
  return { functionResponse } as Part;
}

describe('collectOssMediaRefs', () => {
  it('collects distinct oss:// media parts with display names', () => {
    const refs = collectOssMediaRefs(ossContents());
    expect(refs).toEqual([
      {
        fileUri: 'oss://bucket/clip',
        mimeType: 'video/mp4',
        displayName: 'movie.mkv',
      },
      {
        fileUri: 'oss://bucket/frame1',
        mimeType: 'image/jpeg',
        displayName: 'frame1.jpg',
      },
    ]);
  });

  it('dedups repeated URIs and skips non-oss fileData', () => {
    const contents: Content[] = [
      {
        role: 'user',
        parts: [
          { fileData: { fileUri: 'oss://bucket/a', mimeType: 'video/mp4' } },
          { fileData: { fileUri: 'oss://bucket/a', mimeType: 'video/mp4' } },
          {
            fileData: {
              fileUri: 'https://example.com/x.mp4',
              mimeType: 'video/mp4',
            },
          },
        ],
      },
    ];
    const refs = collectOssMediaRefs(contents);
    expect(refs).toHaveLength(1);
    expect(refs[0].fileUri).toBe('oss://bucket/a');
    // No displayName on the part: falls back to the URI basename.
    expect(refs[0].displayName).toBe('a');
  });

  it('contentsHaveOssMedia mirrors the collector', () => {
    expect(contentsHaveOssMedia(ossContents())).toBe(true);
    expect(
      contentsHaveOssMedia([{ role: 'user', parts: [{ text: 'hi' }] }]),
    ).toBe(false);
  });

  it('sees media nested in functionResponse.parts (tool-result deliveries)', () => {
    const contents: Content[] = [
      { role: 'user', parts: [nestedToolResultPart()] },
    ];
    expect(contentsHaveOssMedia(contents)).toBe(true);
    expect(collectOssMediaRefs(contents)).toEqual([
      {
        fileUri: 'oss://bucket/nested',
        mimeType: 'video/mp4',
        displayName: 'nested.mp4',
      },
    ]);
  });
});

describe('buildLadderPolicy', () => {
  it('merges the rung over the configured arguments for the default tool', () => {
    const policy = buildLadderPolicy(
      videoGuardPolicy({ arguments: { crf: 30 } }),
      'video',
      1,
    );
    expect(policy.arguments).toEqual({ crf: 30, maxHeight: 360, fps: 0.5 });
    expect(policy.id).toBe('video-downscale.reactive-1');
    expect(policy.when).toBeUndefined();
    expect(policy.output.source).toBe('omit');
    expect(policy.output.reprocessMedia).toBe(false);
  });

  it('escalates fps down the rungs and clamps past the last rung', () => {
    const fpsAt = (attempt: number) =>
      buildLadderPolicy(videoGuardPolicy(), 'video', attempt).arguments['fps'];
    expect(fpsAt(0)).toBe(2);
    expect(fpsAt(1)).toBe(0.5);
    expect(fpsAt(2)).toBe(0.25);
    expect(fpsAt(7)).toBe(0.25); // clamped: upstream no-progress check stops the loop
  });

  it('keeps a custom guard tool untouched (no foreign arguments injected)', () => {
    const custom = videoGuardPolicy({
      toolName: ToolNames.OMNI_EXTRACT_KEYFRAMES,
      arguments: { maxFrames: 4 },
    });
    const policy = buildLadderPolicy(custom, 'video', 1);
    expect(policy.arguments).toEqual({ maxFrames: 4 });
  });
});

describe('applyOssMediaReplacements', () => {
  it('swaps fileUri/mimeType in place and inserts the disclosure before the media', () => {
    const contents = ossContents();
    const replacements = new Map<string, OssMediaReplacement>([
      [
        'oss://bucket/clip',
        {
          fileUri: 'oss://bucket/clip-degraded',
          mimeType: 'video/mp4',
          disclosureText: `${OMNI_DISCLOSURE_TEXT_PREFIX}movie.mkv：降质重试`,
        },
      ],
    ]);
    const replaced = applyOssMediaReplacements(contents, replacements);
    expect(replaced).toBe(1);
    const parts = contents[0].parts!;
    // [text, disclosure, degraded clip, untouched frame]
    expect(parts).toHaveLength(4);
    expect(parts[1].text).toContain(OMNI_DISCLOSURE_TEXT_PREFIX);
    expect(parts[2].fileData?.fileUri).toBe('oss://bucket/clip-degraded');
    expect(parts[2].fileData?.displayName).toBe('movie.mkv'); // preserved
    expect(parts[3].fileData?.fileUri).toBe('oss://bucket/frame1'); // untouched
    // Model content untouched.
    expect(contents[1].parts).toEqual([{ text: 'ok' }]);
  });

  it('replaces every occurrence of the same URI across contents', () => {
    const contents: Content[] = [
      {
        role: 'user',
        parts: [{ fileData: { fileUri: 'oss://bucket/a', mimeType: 'v' } }],
      },
      {
        role: 'user',
        parts: [{ fileData: { fileUri: 'oss://bucket/a', mimeType: 'v' } }],
      },
    ];
    const replaced = applyOssMediaReplacements(
      contents,
      new Map([
        [
          'oss://bucket/a',
          {
            fileUri: 'oss://bucket/a2',
            mimeType: 'video/mp4',
            disclosureText: 'd',
          },
        ],
      ]),
    );
    expect(replaced).toBe(2);
    for (const content of contents) {
      expect(content.parts![1].fileData?.fileUri).toBe('oss://bucket/a2');
    }
  });

  it('is a no-op when nothing matches', () => {
    const contents = ossContents();
    const before = JSON.parse(JSON.stringify(contents));
    expect(applyOssMediaReplacements(contents, new Map())).toBe(0);
    expect(contents).toEqual(before);
  });

  it('swaps nested tool-result media inside the SAME functionResponse.parts array (D8)', () => {
    const contents: Content[] = [
      { role: 'user', parts: [nestedToolResultPart()] },
    ];
    const replaced = applyOssMediaReplacements(
      contents,
      new Map([
        [
          'oss://bucket/nested',
          {
            fileUri: 'oss://bucket/nested-degraded',
            mimeType: 'video/mp4',
            disclosureText: 'd',
          },
        ],
      ]),
    );
    expect(replaced).toBe(1);
    // Top level still holds exactly the functionResponse wrapper — the
    // swap must not hoist nested media out of the tool result.
    expect(contents[0].parts).toHaveLength(1);
    const nested = contents[0].parts![0].functionResponse?.parts as Part[];
    expect(nested).toHaveLength(3);
    expect(nested[0]).toEqual({ text: 'tool output' });
    expect(nested[1]).toEqual({ text: 'd' }); // disclosure directly before the media
    expect(nested[2].fileData?.fileUri).toBe('oss://bucket/nested-degraded');
    expect(nested[2].fileData?.displayName).toBe('nested.mp4'); // preserved
  });
});

describe('observed server input limits', () => {
  it('records the tightest observed limit per model', () => {
    recordObservedServerInputLimit('m', 262144);
    recordObservedServerInputLimit('m', 196608);
    recordObservedServerInputLimit('m', 250000); // looser: ignored
    expect(getObservedServerInputLimit('m')).toBe(196608);
    expect(getObservedServerInputLimit('other')).toBeUndefined();
  });

  it('ignores invalid limits', () => {
    recordObservedServerInputLimit('m', 0);
    recordObservedServerInputLimit('m', Number.NaN);
    expect(getObservedServerInputLimit('m')).toBeUndefined();
  });
});
