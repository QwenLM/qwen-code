// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { pushInputHistoryEntry, useInputHistory } from './useInputHistory';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let history: ReturnType<typeof useInputHistory>;

function Harness({
  storageKey,
  fallback,
}: {
  storageKey: string;
  fallback?: string;
}) {
  history = useInputHistory(storageKey, fallback);
  return null;
}

function render(storageKey = 'workspace', fallback?: string) {
  if (!root) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  act(() =>
    root!.render(<Harness storageKey={storageKey} fallback={fallback} />),
  );
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  vi.restoreAllMocks();
  localStorage.clear();
});

it.each([
  'navigateUp',
  'searchReverse',
  'getReverseMatches',
  'getLastEntry',
] as const)(
  '%s reads acceptance saved after the workspace became known',
  (read) => {
    render('legacy');
    render('workspace', 'legacy');
    pushInputHistoryEntry('legacy', 'first input');

    let result: string | string[] | null = null;
    act(() => {
      result =
        read === 'getLastEntry' ? history[read]() : history[read]('first');
    });
    expect(result).toEqual(
      read === 'getReverseMatches' ? ['first input'] : 'first input',
    );
    expect(localStorage.getItem('workspace')).toBeNull();
  },
);

it('includes delayed fallback acceptance when the next input is sent directly', () => {
  render('workspace', 'legacy');
  pushInputHistoryEntry('legacy', 'first input');
  act(() => history.push('second input'));
  expect(JSON.parse(localStorage.getItem('workspace')!)).toEqual([
    'first input',
    'second input',
  ]);
});

it('keeps a browsing snapshot and draft until the next navigation cycle', () => {
  pushInputHistoryEntry('workspace', 'first');
  pushInputHistoryEntry('workspace', 'second');
  render();
  act(() => expect(history.navigateUp('working draft')).toBe('second'));
  pushInputHistoryEntry('workspace', 'third');
  expect(history.getReverseMatches('')).toEqual(['third', 'second', 'first']);
  expect(history.getLastEntry()).toBe('third');
  act(() => expect(history.navigateUp('second')).toBe('first'));
  act(() => expect(history.navigateDown()).toBe('second'));
  act(() => expect(history.navigateDown()).toBe('working draft'));
  act(() => expect(history.navigateUp('working draft')).toBe('third'));
});

it('returns to the draft when a duplicate push arrives mid-browse', () => {
  pushInputHistoryEntry('workspace', 'a');
  pushInputHistoryEntry('workspace', 'b');
  render();
  act(() => expect(history.navigateUp('my draft')).toBe('b'));
  pushInputHistoryEntry('workspace', 'x');
  act(() => history.push('x'));
  act(() => expect(history.navigateDown()).toBe('my draft'));
  act(() => expect(history.navigateDown()).toBeNull());
});

it('uses workspace history ahead of fallback and respects disabled fallback', () => {
  pushInputHistoryEntry('workspace', 'workspace input');
  render('workspace', 'legacy');
  pushInputHistoryEntry('legacy', 'unrelated input');
  expect(history.getReverseMatches('')).toEqual(['workspace input']);
  render('standalone');
  expect(history.getReverseMatches('')).toEqual([]);
});

it('preserves unsaved input when storage still contains an older history', () => {
  pushInputHistoryEntry('workspace', 'old input');
  render();
  const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  act(() => history.push('unsaved input'));
  expect(history.getLastEntry()).toBe('unsaved input');
  act(() => expect(history.navigateUp('draft')).toBe('unsaved input'));
  act(() => expect(history.navigateDown()).toBe('draft'));
  act(() => history.push('another unsaved input'));
  expect(history.getReverseMatches('')).toEqual([
    'another unsaved input',
    'unsaved input',
    'old input',
  ]);
  save.mockRestore();
  act(() => history.push('another unsaved input'));
  expect(JSON.parse(localStorage.getItem('workspace')!)).toEqual([
    'old input',
    'unsaved input',
    'another unsaved input',
  ]);
});

it('keeps in-memory history when reading storage becomes unavailable', () => {
  pushInputHistoryEntry('workspace', 'saved input');
  render();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('Access denied', 'SecurityError');
  });
  act(() => expect(history.navigateUp('draft')).toBe('saved input'));
  act(() => expect(history.navigateDown()).toBe('draft'));
  act(() => history.push('new input'));
  expect(history.getLastEntry()).toBe('new input');
});

it('does not carry unsaved history into another workspace', () => {
  pushInputHistoryEntry('other', 'other input');
  render();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  act(() => history.push('unsaved workspace input'));
  render('other');
  expect(history.getReverseMatches('')).toEqual(['other input']);
});

it('re-reads storage after a workspace switch that follows a failed save', () => {
  render();
  const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  act(() => history.push('unsaved input'));
  save.mockRestore();
  render('other');
  pushInputHistoryEntry('other', 'late acceptance');
  expect(history.getReverseMatches('')).toEqual(['late acceptance']);
});
