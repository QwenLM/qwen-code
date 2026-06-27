import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import i18next from 'i18next';
import { setupI18n } from '@craft-agent/shared/i18n/setupI18n';
import { formatSessionRelativeTime } from '../session';

const NOW = Date.parse('2026-05-29T12:00:00.000Z');
const originalDateNow = Date.now;

beforeAll(async () => {
  setupI18n();
  await i18next.changeLanguage('en');
  Date.now = () => NOW;
});

afterAll(() => {
  Date.now = originalDateNow;
});

describe('formatSessionRelativeTime', () => {
  it('shows Just now for sessions less than one minute old', () => {
    expect(formatSessionRelativeTime(NOW - 59_999)).toBe('Just now');
  });

  it('shows minutes once a session is at least one minute old', () => {
    expect(formatSessionRelativeTime(NOW - 60_000)).toBe('1m');
    expect(formatSessionRelativeTime(NOW - 59 * 60_000)).toBe('59m');
  });

  it('switches to hours after one hour', () => {
    expect(formatSessionRelativeTime(NOW - 60 * 60_000)).toBe('1h');
  });
});
