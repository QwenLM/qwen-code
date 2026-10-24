// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  getCompletedUnreadStorageKey,
  readCompletedUnreadIds,
  updateCompletedUnreadIds,
} from './completedUnreadSessions';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it('normalizes the daemon URL while keeping distinct server paths isolated', () => {
  expect(getCompletedUnreadStorageKey()).toBe(
    getCompletedUnreadStorageKey(window.location.origin),
  );
  expect(getCompletedUnreadStorageKey('https://daemon.test/a/')).toBe(
    getCompletedUnreadStorageKey('https://daemon.test/a'),
  );
  expect(getCompletedUnreadStorageKey('https://daemon.test/a')).not.toBe(
    getCompletedUnreadStorageKey('https://daemon.test/b'),
  );
});

it('round trips workspace/session identities without changing their scope', () => {
  const key = getCompletedUnreadStorageKey('https://daemon.test');
  const ids = new Set(['/workspace/a\0session', '/workspace/b\0session']);
  updateCompletedUnreadIds(key, { add: ids });
  expect(readCompletedUnreadIds(key)).toEqual(ids);
  expect(
    readCompletedUnreadIds(getCompletedUnreadStorageKey('https://other.test')),
  ).toEqual(new Set());
  updateCompletedUnreadIds(key, { remove: ids });
  expect(readCompletedUnreadIds(key)).toEqual(new Set());
  expect(localStorage.length).toBe(0);
});

it('preserves concurrent additions without rewriting other session keys', () => {
  const key = getCompletedUnreadStorageKey();
  // Both tabs began with an empty snapshot and only write their own completion.
  updateCompletedUnreadIds(key, { add: ['first'] });
  updateCompletedUnreadIds(key, { add: ['second'] });
  expect(readCompletedUnreadIds(key)).toEqual(new Set(['first', 'second']));
});

it('does not resurrect a cleared marker when another tab adds a completion', () => {
  const key = getCompletedUnreadStorageKey();
  updateCompletedUnreadIds(key, { add: ['read-session'] });
  updateCompletedUnreadIds(key, { remove: ['read-session'] });
  // The other tab still had read-session in memory, but writes only its change.
  updateCompletedUnreadIds(key, { add: ['new-completion'] });
  expect(readCompletedUnreadIds(key)).toEqual(new Set(['new-completion']));
});

it('ignores malformed entries and unrelated browser data', () => {
  const key = getCompletedUnreadStorageKey();
  localStorage.setItem(`${key}\0`, '1');
  localStorage.setItem(`${key}\0bad-value`, '{}');
  localStorage.setItem(`${key}/other\0session`, '1');
  localStorage.setItem('unrelated', '1');
  updateCompletedUnreadIds(key, { add: ['', '/workspace\0session'] });
  expect(readCompletedUnreadIds(key)).toEqual(new Set(['/workspace\0session']));
});

it('reports inaccessible storage without throwing', () => {
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new DOMException('Storage disabled', 'SecurityError');
  });
  const key = getCompletedUnreadStorageKey();
  expect(readCompletedUnreadIds(key)).toBeNull();
  expect(() =>
    updateCompletedUnreadIds(key, { add: ['session'], remove: ['other'] }),
  ).not.toThrow();
});
