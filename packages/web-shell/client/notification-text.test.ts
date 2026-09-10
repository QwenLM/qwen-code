import { describe, expect, it } from 'vitest';
import {
  notificationExcerpt,
  notificationTextLines,
  MAX_NOTIFICATION_SOURCE_LENGTH,
} from './notification-text';

describe('notification text', () => {
  it('keeps literal markup and code instead of guessing HTML tags', () => {
    expect(notificationExcerpt('```html\n<br>\n```', 120)).toBe('<br>');
    expect(notificationExcerpt('Use <OldType> and <Component />', 120)).toBe(
      'Use <OldType> and <Component />',
    );
  });
  it('preserves Markdown-like syntax inside code', () => {
    expect(notificationExcerpt('```py\nx = 2 ** 3 ** 4\n```', 120)).toBe(
      'x = 2 ** 3 ** 4',
    );
    expect(
      notificationExcerpt('Use `[name](value)` and ```inline```', 120),
    ).toBe('Use [name](value) and inline');
  });
  it('reads a bounded prefix even when markup has no closing delimiters', () => {
    for (const prefix of ['<', '[', '`']) {
      expect(
        notificationExcerpt(prefix.repeat(1000000), 120).length,
      ).toBeLessThanOrEqual(120);
    }
    expect(
      notificationTextLines(
        'x'.repeat(MAX_NOTIFICATION_SOURCE_LENGTH) + 'unread',
      ).join(''),
    ).toBe('x'.repeat(MAX_NOTIFICATION_SOURCE_LENGTH));
  });
  it('cleans a document before choosing a title line', () => {
    expect(
      notificationTextLines(
        '```ts\nexport const a = 1;\n```\nPlease review.',
      )[0],
    ).toBe('export const a = 1;');
  });
});
