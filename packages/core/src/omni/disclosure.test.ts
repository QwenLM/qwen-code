/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  formatDisclosureText,
  isDisclosureText,
  isKeyframeTimestampLabel,
  OMNI_DISCLOSURE_TEXT_PREFIX,
} from './disclosure.js';

describe('isKeyframeTimestampLabel', () => {
  it('matches bare MM:SS and H:MM:SS markers only', () => {
    expect(isKeyframeTimestampLabel('<00:11>')).toBe(true);
    expect(isKeyframeTimestampLabel('<02:49>')).toBe(true);
    expect(isKeyframeTimestampLabel('<1:02:03>')).toBe(true);
    expect(isKeyframeTimestampLabel('<12:34:56>')).toBe(true);
  });

  it('rejects the first-frame header and non-marker text', () => {
    expect(
      isKeyframeTimestampLabel('原视频 720s/1922×1080 → 关键帧\n<00:11>'),
    ).toBe(false);
    expect(isKeyframeTimestampLabel('<00:11> 关键帧')).toBe(false);
    expect(isKeyframeTimestampLabel('00:11')).toBe(false);
    expect(isKeyframeTimestampLabel('<scene>')).toBe(false);
  });
});

describe('formatDisclosureText', () => {
  it('delivers a bare timestamp marker WITHOUT the degradation prefix', () => {
    expect(formatDisclosureText('video.mp4', '<00:34>')).toBe('<00:34>');
  });

  it('prefixes a normal (non-marker) disclosure, including the header', () => {
    const header = '原视频 720s/1922×1080 → 关键帧，缩放至 336×196\n<00:11>';
    const out = formatDisclosureText('video.mp4', header);
    expect(out.startsWith(OMNI_DISCLOSURE_TEXT_PREFIX)).toBe(true);
    expect(out).toContain('video.mp4');
    expect(out).toContain('<00:11>');
  });
});

describe('isDisclosureText', () => {
  it('recognizes both prefixed disclosures and bare timestamp markers', () => {
    expect(isDisclosureText(formatDisclosureText('v.mp4', 'x → y'))).toBe(true);
    // Bare markers carry no prefix but must migrate with their image.
    expect(isDisclosureText('<00:34>')).toBe(true);
  });

  it('does not treat ordinary model text as a disclosure', () => {
    expect(isDisclosureText('the blue box says Figs in a Blanket')).toBe(false);
  });
});
