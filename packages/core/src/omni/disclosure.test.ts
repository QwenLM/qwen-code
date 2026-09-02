/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  formatDisclosureText,
  formatResourceHandleText,
  formatResourcePathText,
  isDisclosureText,
  isKeyframeTimestampLabel,
  OMNI_DISCLOSURE_TEXT_PREFIX,
  parseResourceHandleText,
  parseResourcePathText,
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

describe('resource annotation forms', () => {
  it('handle form parses as a handle, not a path', () => {
    const text = formatResourceHandleText('pic.png', 'media-3-9f2cabcd');
    expect(parseResourceHandleText(text)).toBe('media-3-9f2cabcd');
    // The `：<resourceId>` separator disambiguates it from the path form.
    expect(parseResourcePathText(text)).toBeUndefined();
  });

  it('path form parses as a path, not a handle', () => {
    const p = '/workspace/kf/clip-keyframe-0001.jpg';
    const text = formatResourcePathText(p);
    expect(parseResourcePathText(text)).toBe(p);
    expect(parseResourceHandleText(text)).toBeUndefined();
  });

  it('round-trips a path whose basename contains the full-width separator', () => {
    // The separator (：) is escaped by the writer, so splitAnnotationBody
    // finds no UNescaped separator and the whole body reads back as a path.
    const p = '/tmp/odd：name/frame.jpg';
    const text = formatResourcePathText(p);
    expect(parseResourceHandleText(text)).toBeUndefined();
    expect(parseResourcePathText(text)).toBe(p);
  });

  it('non-annotation text parses as neither form', () => {
    expect(parseResourcePathText('just some text')).toBeUndefined();
    expect(parseResourceHandleText('just some text')).toBeUndefined();
  });
});
