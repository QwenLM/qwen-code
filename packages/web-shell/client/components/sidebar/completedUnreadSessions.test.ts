// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  getCompletedUnreadStorageKey,
  readCompletedUnreadIds,
  writeCompletedUnreadIds,
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
  writeCompletedUnreadIds(key, ids);
  expect(readCompletedUnreadIds(key)).toEqual(ids);
  expect(
    readCompletedUnreadIds(getCompletedUnreadStorageKey('https://other.test')),
  ).toEqual(new Set());
  writeCompletedUnreadIds(key, new Set());
  expect(readCompletedUnreadIds(key)).toEqual(new Set());
});

it.each(['{invalid', '{}', 'null', '123'])(
  'ignores malformed stored data: %s',
  (raw) => {
    const key = getCompletedUnreadStorageKey();
    localStorage.setItem(key, raw);
    expect(readCompletedUnreadIds(key)).toEqual(new Set());
  },
);

it('ignores invalid entries in a stored array', () => {
  const key = getCompletedUnreadStorageKey();
  localStorage.setItem(
    key,
    JSON.stringify([null, 1, '', '/workspace\0session']),
  );
  expect(readCompletedUnreadIds(key)).toEqual(new Set(['/workspace\0session']));
});

it('keeps storage failures from breaking the sidebar', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('Storage disabled', 'SecurityError');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Storage full', 'QuotaExceededError');
  });
  const key = getCompletedUnreadStorageKey();
  expect(readCompletedUnreadIds(key)).toEqual(new Set());
  expect(() =>
    writeCompletedUnreadIds(key, new Set(['session'])),
  ).not.toThrow();
});
