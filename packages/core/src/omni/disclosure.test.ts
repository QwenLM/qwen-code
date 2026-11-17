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
  OMNI_RESOURCE_PATH_TEXT_PREFIX,
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
    // Its 【媒体资源】 marker (not the path form's 【媒体路径】) keeps it out
    // of the path parser.
    expect(parseResourcePathText(text)).toBeUndefined();
  });

  it('path form parses as a path, not a handle', () => {
    const p = '/workspace/kf/clip-keyframe-0001.jpg';
    const text = formatResourcePathText(p);
    expect(parseResourcePathText(text)).toBe(p);
    expect(parseResourceHandleText(text)).toBeUndefined();
  });

  it('shows a path with a full-width separator VERBATIM (re-readable, R2-6)', () => {
    // The guidance promises a displayed local path can be re-read or handed
    // straight to a tool — true only if the model-visible payload IS the real
    // on-disk path. So a `：` in the name rides verbatim under the path
    // marker, never escaped: an escaped `odd\：name` would fail fs.lstat with
    // ENOENT, and the round-trip parse returns the same bytes.
    const p = '/tmp/odd：name/frame.jpg';
    const text = formatResourcePathText(p);
    expect(text).toBe(`${OMNI_RESOURCE_PATH_TEXT_PREFIX}${p}`);
    expect(parseResourceHandleText(text)).toBeUndefined();
    expect(parseResourcePathText(text)).toBe(p);
  });

  it('does not misread a path ending in a handle-shaped suffix as a handle', () => {
    // A file literally named `.../clip：media-3-9f2cabcd` (full-width colon is
    // a legal filename char). Disambiguation is by MARKER, not escaping: the
    // path form's 【媒体路径】 marker means parseResourceHandleText (which keys
    // on 【媒体资源】) never sees it, so the whole payload is the path. The
    // genuine handle form of the same suffix still parses as a handle.
    const pathText = formatResourcePathText('/tmp/clip：media-3-9f2cabcd');
    expect(parseResourceHandleText(pathText)).toBeUndefined();
    expect(parseResourcePathText(pathText)).toBe('/tmp/clip：media-3-9f2cabcd');
    const handleText = formatResourceHandleText('clip', 'media-3-9f2cabcd');
    expect(parseResourceHandleText(handleText)).toBe('media-3-9f2cabcd');
    expect(parseResourcePathText(handleText)).toBeUndefined();
  });

  it('non-annotation text parses as neither form', () => {
    expect(parseResourcePathText('just some text')).toBeUndefined();
    expect(parseResourceHandleText('just some text')).toBeUndefined();
  });

  it('does NOT consume prefixed prose that is not an absolute path', () => {
    // Ordinary text that merely begins with a resource marker — a pasted
    // line, an @-mentioned document whose first line is `【媒体路径】清单` — must
    // not be mistaken for a path annotation, or the exporter would delete it
    // from request text and fabricate a phantom media entry keyed on it. The
    // path parser's isAbsolutePathLike guard rejects the non-path payload.
    expect(parseResourcePathText('【媒体路径】清单')).toBeUndefined();
    expect(parseResourcePathText('【媒体路径】see attached')).toBeUndefined();
    expect(
      parseResourcePathText('【媒体路径】relative/path.mp4'),
    ).toBeUndefined();
    expect(parseResourceHandleText('【媒体资源】清单')).toBeUndefined();
  });

  it('accepts absolute paths on any OS shape (POSIX / Windows drive / UNC)', () => {
    for (const p of [
      '/movies/film.mkv',
      'C:\\Users\\jane\\clip.mp4',
      'D:/media/clip.mp4',
      '\\\\host\\share\\clip.mp4',
    ]) {
      const text = formatResourcePathText(p);
      expect(parseResourcePathText(text)).toBe(p);
    }
  });
});
