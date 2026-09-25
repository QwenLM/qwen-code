// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  getCompletedUnreadStorageKey,
  readCompletedUnreadIds,
  updateCompletedUnreadIds,
} from './completedUnreadSessions';
import { useCompletedUnreadSessions } from './useCompletedUnreadSessions';

const roots: Root[] = [];
const key = getCompletedUnreadStorageKey('https://daemon.test');

function mount(storageKey = key, beforeSubscribe?: () => void) {
  let result: ReturnType<typeof useCompletedUnreadSessions>;
  function Harness({ currentKey }: { currentKey: string }) {
    result = useCompletedUnreadSessions(currentKey);
    useLayoutEffect(() => beforeSubscribe?.(), []);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  const render = (currentKey: string) =>
    act(() => root.render(<Harness currentKey={currentKey} />));
  render(storageKey);
  return {
    get result() {
      return result;
    },
    render,
  };
}

function remoteChange(id: string, unread: boolean) {
  const entryKey = `${key}\0${id}`;
  if (unread) localStorage.setItem(entryKey, '1');
  else localStorage.removeItem(entryKey);
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: entryKey,
      newValue: unread ? '1' : null,
      storageArea: localStorage,
    }),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.restoreAllMocks();
  localStorage.clear();
});

it('restores markers and synchronizes mounted sidebars in the same tab', () => {
  updateCompletedUnreadIds(key, { add: ['existing'] });
  const first = mount();
  const second = mount();
  expect(first.result[0]).toEqual(new Set(['existing']));
  act(() => first.result[1]({ add: ['new'] }));
  expect(second.result[0]).toEqual(new Set(['existing', 'new']));
  act(() => second.result[1]({ remove: ['existing'] }));
  expect(first.result[0]).toEqual(new Set(['new']));
});

it('catches changes between the initial render and subscription', () => {
  const sidebar = mount(key, () => {
    localStorage.setItem(`${key}\0during-mount`, '1');
  });
  expect(sidebar.result[0]).toEqual(new Set(['during-mount']));
});

it('reflects remote adds and clears without persisting a stale local snapshot', () => {
  const sidebar = mount();
  act(() => remoteChange('remote', true));
  expect(sidebar.result[0]).toEqual(new Set(['remote']));
  act(() => remoteChange('remote', false));
  act(() => sidebar.result[1]({ add: ['local'] }));
  expect(sidebar.result[0]).toEqual(new Set(['local']));
  expect(readCompletedUnreadIds(key)).toEqual(new Set(['local']));
});

it('ignores stale queued event values after a newer clear', () => {
  const sidebar = mount();
  act(() => sidebar.result[1]({ add: ['session'] }));
  act(() => sidebar.result[1]({ remove: ['session'] }));
  act(() => {
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: `${key}\0session`,
        newValue: '1',
        storageArea: localStorage,
      }),
    );
  });
  expect(sidebar.result[0]).toEqual(new Set());
  expect(readCompletedUnreadIds(key)).toEqual(new Set());
});

it('rereads current storage for a queued clear event', () => {
  const sidebar = mount();
  act(() => sidebar.result[1]({ add: ['session'] }));
  localStorage.clear();
  localStorage.setItem(`${key}\0newer`, '1');
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));
  expect(sidebar.result[0]).toEqual(new Set(['newer']));
});

it('keeps an old async updater scoped to its original daemon', () => {
  updateCompletedUnreadIds(key, { add: ['session'] });
  const sidebar = mount();
  const originalUpdate = sidebar.result[1];
  const otherKey = getCompletedUnreadStorageKey('https://other.test');
  updateCompletedUnreadIds(otherKey, { add: ['session'] });
  sidebar.render(otherKey);
  act(() => originalUpdate({ remove: ['session'] }));
  expect(sidebar.result[0]).toEqual(new Set(['session']));
  expect(readCompletedUnreadIds(otherKey)).toEqual(new Set(['session']));
  expect(readCompletedUnreadIds(key)).toEqual(new Set());
});

it('retains the same set and updater for a no-op change', () => {
  const sidebar = mount();
  const original = sidebar.result;
  act(() => sidebar.result[1]({ remove: ['absent'] }));
  expect(sidebar.result[0]).toBe(original[0]);
  expect(sidebar.result[1]).toBe(original[1]);
});

it('keeps memory behavior when reads and writes are blocked', () => {
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new DOMException('Storage disabled', 'SecurityError');
  });
  const sidebar = mount();
  act(() => sidebar.result[1]({ add: ['session'] }));
  expect(sidebar.result[0]).toEqual(new Set(['session']));
  act(() => sidebar.result[1]({ remove: ['session'] }));
  expect(sidebar.result[0]).toEqual(new Set());
});

it('does not replace memory-only markers with stale storage after quota failure', () => {
  const sidebar = mount();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Storage full', 'QuotaExceededError');
  });
  act(() => sidebar.result[1]({ add: ['session'] }));
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));
  expect(sidebar.result[0]).toEqual(new Set(['session']));
});
