import { describe, expect, it } from 'bun:test';
import {
  byteOffsetToUtf16Index,
  contentBadgesToTextElements,
  textElementsToContentBadges,
  utf16IndexToByteOffset,
} from '../text-elements.ts';
import type { ContentBadge } from '../../types/message.ts';

describe('text element byte ranges', () => {
  it('round-trips UTF-16 indices through UTF-8 byte offsets', () => {
    const text = '你好 [skill:commit]';
    const start = text.indexOf('[skill:commit]');
    const end = start + '[skill:commit]'.length;

    const byteStart = utf16IndexToByteOffset(text, start);
    const byteEnd = utf16IndexToByteOffset(text, end);

    expect(byteStart).toBe(7);
    expect(byteOffsetToUtf16Index(text, byteStart)).toBe(start);
    expect(byteOffsetToUtf16Index(text, byteEnd)).toBe(end);
  });

  it('converts badges to semantic text elements and back', () => {
    const content = 'run /commit on src/index.ts';
    const badges: ContentBadge[] = [
      {
        type: 'command',
        label: 'commit',
        rawText: '/commit',
        start: 4,
        end: 11,
      },
      {
        type: 'file',
        label: 'index.ts',
        rawText: 'src/index.ts',
        filePath: '/repo/src/index.ts',
        start: 15,
        end: 27,
      },
    ];

    const textElements = contentBadgesToTextElements(content, badges);

    expect(textElements).toEqual([
      {
        type: 'slash_command',
        byte_range: { start: 4, end: 11 },
        placeholder: '/commit',
        label: 'commit',
        target: 'commit',
      },
      {
        type: 'file',
        byte_range: { start: 15, end: 27 },
        placeholder: 'src/index.ts',
        label: 'index.ts',
        target: '/repo/src/index.ts',
      },
    ]);
    expect(textElementsToContentBadges(content, textElements)).toEqual(badges);
  });
});
