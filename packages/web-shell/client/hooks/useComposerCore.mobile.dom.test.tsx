// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import { WebShellPortalRootContext } from '../portalRoot';
import { useComposerCore, type UseComposerCoreReturn } from './useComposerCore';
import type { WebShellComposerInput } from '../customization';
import { TOUCH_COMPOSER_QUERY } from './useIsTouchComposer';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const originalMatchMedia = window.matchMedia;
const originalMaxTouchPoints = Object.getOwnPropertyDescriptor(
  Navigator.prototype,
  'maxTouchPoints',
);
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: UseComposerCoreReturn | null = null;

function mockTouchDevice() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === TOUCH_COMPOSER_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(navigator, 'maxTouchPoints', {
    value: 5,
    configurable: true,
  });
}

function Harness({
  composerInput,
  onSubmit,
  onInputTextChange,
  sessionId,
  atWorkspaceCwd,
  expanded = false,
}: {
  composerInput?: WebShellComposerInput;
  onSubmit: ReturnType<typeof vi.fn>;
  onInputTextChange?: (text: string) => void;
  sessionId?: string;
  atWorkspaceCwd?: string;
  expanded?: boolean;
}) {
  const composer = useComposerCore({
    onSubmit,
    onInputTextChange,
    commands: [],
    editorTheme: {},
    composerInput,
    composerInputVersion: composerInput ? 1 : undefined,
    sessionId,
    atWorkspaceCwd,
  });
  latest = composer;

  // Mirrors the ChatEditor render seam: the mobile backend renders a plain
  // controlled textarea at the single mount point, desktop keeps the
  // CodeMirror container div.
  return (
    <div {...composer.imageTransferHandlers} data-web-shell-composer-surface>
      {composer.mobileComposer ? (
        <textarea
          ref={composer.mobileComposer.textareaRef}
          value={composer.mobileComposer.value}
          onChange={composer.mobileComposer.onChange}
          onBlur={composer.mobileComposer.onBlur}
          placeholder={composer.mobileComposer.placeholder}
          data-web-shell-composer-editor
        />
      ) : (
        <div ref={composer.containerRef} data-web-shell-composer-editor />
      )}
      {expanded && composer.mobileComposer && (
        <textarea
          ref={composer.mobileComposer.expandedTextareaRef}
          value={composer.mobileComposer.value}
          onChange={composer.mobileComposer.onChange}
          onPasteCapture={composer.imageTransferHandlers.onPasteCapture}
          data-expanded
        />
      )}
    </div>
  );
}

async function mount({
  composerInput,
  onSubmit = vi.fn(),
  onInputTextChange,
  sessionId,
  atWorkspaceCwd,
  expanded = false,
}: {
  composerInput?: WebShellComposerInput;
  onSubmit?: ReturnType<typeof vi.fn>;
  onInputTextChange?: (text: string) => void;
  sessionId?: string;
  atWorkspaceCwd?: string;
  expanded?: boolean;
} = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <WebShellPortalRootContext.Provider value={null}>
        <I18nProvider language="en">
          <Harness
            composerInput={composerInput}
            onSubmit={onSubmit}
            onInputTextChange={onInputTextChange}
            sessionId={sessionId}
            atWorkspaceCwd={atWorkspaceCwd}
            expanded={expanded}
          />
        </I18nProvider>
      </WebShellPortalRootContext.Provider>,
    );
  });
  return { onSubmit };
}

function typeText(text: string) {
  act(() => {
    latest!.mobileComposer!.onChange({
      target: { value: text },
    } as React.ChangeEvent<HTMLTextAreaElement>);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  localStorage.removeItem('qwen-web-shell-history');
  localStorage.removeItem('qwen-web-shell-command-history');
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index);
    if (
      key?.startsWith('qwen-web-shell-session-draft:') ||
      key?.startsWith('qwen-web-shell-pending-task-draft:')
    ) {
      localStorage.removeItem(key);
    }
  }
  document.getElementById('web-shell-tooltip-styles')?.remove();
  root = null;
  container = null;
  latest = null;
  window.matchMedia = originalMatchMedia;
  if (originalMaxTouchPoints) {
    Object.defineProperty(
      Navigator.prototype,
      'maxTouchPoints',
      originalMaxTouchPoints,
    );
  } else {
    delete (navigator as unknown as Record<string, unknown>)['maxTouchPoints'];
  }
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

describe('useComposerCore mobile textarea backend', () => {
  it('activates on touch devices: textarea renders, CodeMirror never mounts', async () => {
    mockTouchDevice();
    await mount();
    expect(latest!.mobileComposer).not.toBeNull();
    expect(container!.querySelector('textarea')).not.toBeNull();
    expect(document.querySelector('.cm-editor')).toBeNull();
  });

  it('stays off on non-touch devices: CodeMirror mounts, mobileComposer is null', async () => {
    await mount();
    expect(latest!.mobileComposer).toBeNull();
    expect(container!.querySelector('textarea')).toBeNull();
    expect(document.querySelector('.cm-editor')).not.toBeNull();
  });

  it('respects the ?composer=codemirror escape hatch on touch devices', async () => {
    mockTouchDevice();
    window.history.replaceState({}, '', '/?composer=codemirror');
    await mount();
    expect(latest!.mobileComposer).toBeNull();
    expect(document.querySelector('.cm-editor')).not.toBeNull();
  });

  it('drives hasContent and onInputTextChange from typing', async () => {
    mockTouchDevice();
    const onInputTextChange = vi.fn();
    await mount({ onInputTextChange });
    expect(latest!.hasContent).toBe(false);
    typeText('hello');
    expect(latest!.mobileComposer!.value).toBe('hello');
    expect(latest!.hasContent).toBe(true);
    expect(onInputTextChange).toHaveBeenCalledWith('hello');
    typeText('');
    expect(latest!.hasContent).toBe(false);
  });

  it('reads the textarea height cap once instead of on every input', async () => {
    mockTouchDevice();
    const getComputedStyle = window.getComputedStyle.bind(window);
    let textareaStyleReads = 0;
    const styleSpy = vi
      .spyOn(window, 'getComputedStyle')
      .mockImplementation((element, pseudoElement) => {
        if (element instanceof HTMLTextAreaElement) {
          textareaStyleReads += 1;
        }
        return getComputedStyle(element, pseudoElement);
      });

    await mount();
    const initialStyleReads = textareaStyleReads;
    typeText('one');
    typeText('one two');
    typeText('one two three');

    expect(textareaStyleReads).toBe(initialStyleReads);
    styleSpy.mockRestore();
  });

  it('submits through the shared pipeline and clears the draft', async () => {
    mockTouchDevice();
    const { onSubmit } = await mount();
    typeText('hello world');
    act(() => latest!.submitText());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toBe('hello world');
    expect(latest!.mobileComposer!.value).toBe('');
    expect(latest!.hasContent).toBe(false);
  });

  it('passes shell-prefixed text through unchanged for App-level handling', async () => {
    mockTouchDevice();
    const { onSubmit } = await mount();
    typeText('!ls');
    act(() => latest!.submitText());
    expect(onSubmit.mock.calls[0][0]).toBe('!ls');
  });

  it('includes top tags in the submission and clears them after commit', async () => {
    mockTouchDevice();
    const { onSubmit } = await mount();
    act(() => latest!.addTags([{ id: 'orders', value: 'orders' }]));
    expect(latest!.hasInput()).toBe(true);
    act(() => latest!.submitText());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(latest!.composerTags).toHaveLength(0);
  });

  it('falls back to the top placement for inline tags', async () => {
    mockTouchDevice();
    await mount();
    act(() =>
      latest!.addTags([{ id: 'file', value: 'a.ts' }], { placement: 'inline' }),
    );
    expect(latest!.composerTags.map((tag) => tag.id)).toContain('file');
  });

  it('maps text methods onto the textarea state', async () => {
    mockTouchDevice();
    await mount();
    act(() => latest!.setText('abc'));
    expect(latest!.mobileComposer!.value).toBe('abc');
    expect(latest!.getText()).toBe('abc');

    act(() => latest!.insertText('xyz', { mode: 'replace' }));
    expect(latest!.mobileComposer!.value).toBe('xyz');

    act(() => latest!.replaceEditorText('helloworld'));
    const textarea = container!.querySelector('textarea')!;
    textarea.selectionStart = 5;
    textarea.selectionEnd = 5;
    act(() => latest!.insertText(' '));
    expect(latest!.mobileComposer!.value).toBe('hello world');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(textarea.selectionStart).toBe(6);
    expect(textarea.selectionEnd).toBe(6);

    act(() => latest!.clear());
    expect(latest!.mobileComposer!.value).toBe('');
    expect(latest!.hasInput()).toBe(false);
  });

  it('seeds the draft from composerInput', async () => {
    mockTouchDevice();
    await mount({ composerInput: { text: 'seeded' } });
    expect(latest!.mobileComposer!.value).toBe('seeded');
    expect(latest!.hasContent).toBe(true);
  });

  it('auto-submits from composerInput and clears the draft', async () => {
    mockTouchDevice();
    const onSubmit = vi.fn();
    await mount({
      composerInput: { text: 'seeded go', submit: true },
      onSubmit,
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toBe('seeded go');
    expect(latest!.mobileComposer!.value).toBe('');
  });

  it('opens history search with the current draft', async () => {
    mockTouchDevice();
    await mount();
    typeText('first message');
    act(() => latest!.submitText());
    typeText('draft');
    act(() => latest!.searchState.openHistorySearch());
    expect(latest!.searchState.searchMode).toBe(true);
    expect(latest!.searchState.searchMatches).toContain('first message');
  });

  it('submits a selected history-search match through the pipeline', async () => {
    mockTouchDevice();
    const { onSubmit } = await mount();
    typeText('first message');
    act(() => latest!.submitText());
    onSubmit.mockClear();

    act(() => latest!.searchState.openHistorySearch());
    expect(latest!.searchState.searchMatches).toContain('first message');
    act(() => latest!.searchState.submitSearchMatch('first message'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toBe('first message');
    expect(latest!.searchState.searchMode).toBe(false);
    expect(latest!.mobileComposer!.value).toBe('');
  });

  it('notifies onInputTextChange on programmatic draft changes', async () => {
    // The CodeMirror updateListener fires for programmatic dispatches too;
    // the textarea backend must match, or parent trackers go stale after
    // setText / history restore / post-submit clear.
    mockTouchDevice();
    const onInputTextChange = vi.fn();
    await mount({ onInputTextChange });
    act(() => latest!.setText('seeded'));
    expect(onInputTextChange).toHaveBeenLastCalledWith('seeded');
    act(() => latest!.submitText());
    expect(onInputTextChange).toHaveBeenLastCalledWith('');
  });

  it('suppresses programmatic mount focus on the CodeMirror path for touch devices', async () => {
    // With ?composer=codemirror a touch device still gets CodeMirror, but the
    // non-gesture mount focus must stay suppressed: on iOS it claims
    // document.activeElement without opening the keyboard, and later taps may
    // no longer fire a fresh focus event.
    mockTouchDevice();
    window.history.replaceState({}, '', '/?composer=codemirror');
    await mount();
    const content = document.querySelector('.cm-content');
    expect(content).not.toBeNull();
    expect(document.activeElement).not.toBe(content);
  });

  it('keeps the programmatic mount focus on desktop', async () => {
    await mount();
    const content = document.querySelector('.cm-content');
    expect(content).not.toBeNull();
    expect(document.activeElement).toBe(content);
  });

  it('collects image-only paste and lets mixed text/image paste natively', async () => {
    mockTouchDevice();
    await mount();
    const preventDefault = vi.fn();
    const imageItem = {
      kind: 'file',
      type: 'image/png',
      getAsFile: () =>
        new File([new Uint8Array([137, 80, 78, 71])], 'x.png', {
          type: 'image/png',
        }),
    };
    const imageEvent = new Event('paste', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(imageEvent, 'clipboardData', {
      value: {
        files: [],
        items: [imageItem],
        types: ['Files'],
        getData: () => '',
      },
    });
    await act(async () => {
      imageEvent.preventDefault = preventDefault;
      container!.querySelector('textarea')!.dispatchEvent(imageEvent);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(latest!.pastedImages).toHaveLength(1);
    expect(latest!.pastedImages[0].media_type).toBe('image/png');

    const textPreventDefault = vi.fn();
    const textEvent = new Event('paste', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(textEvent, 'clipboardData', {
      value: {
        files: [],
        items: [
          imageItem,
          { kind: 'string', type: 'text/plain', getAsFile: () => null },
        ],
        types: ['Files', 'text/plain'],
        getData: (type: string) => (type === 'text/plain' ? 'PPT 文字' : ''),
      },
    });
    act(() => {
      textEvent.preventDefault = textPreventDefault;
      container!.querySelector('textarea')!.dispatchEvent(textEvent);
    });
    expect(textPreventDefault).not.toHaveBeenCalled();
    expect(latest!.pastedImages).toHaveLength(1);
    expect(latest!.pendingImageBatchCount).toBe(0);
  });

  it.each([
    { draft: 'old draft', from: 0, to: 9, text: 'x'.repeat(8000) },
    { draft: '', from: 0, to: 0, text: '!echo ' + 'x'.repeat(8000) },
    { draft: '', from: 0, to: 0, text: '/fork ' + 'x'.repeat(8000) },
    { draft: '/fork ', from: 6, to: 6, text: 'x'.repeat(8000) },
    { draft: '/clear', from: 0, to: 0, text: 'x'.repeat(8000) },
    { draft: '/fork do something', from: 0, to: 0, text: 'x'.repeat(8000) },
    { draft: '!echo hi', from: 0, to: 0, text: 'x'.repeat(8000) },
  ])(
    'leaves replacement and command pastes to the textarea: $draft',
    async ({ draft, from, to, text }) => {
      mockTouchDevice();
      await mount();
      act(() => latest!.setText(draft));
      const textarea = container!.querySelector('textarea')!;
      textarea.setSelectionRange(from, to);
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { getData: () => text },
      });
      act(() => textarea.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      expect(latest!.pastedFiles).toEqual([]);
    },
  );

  it('folds an oversized paste in the touch textarea', async () => {
    mockTouchDevice();
    await mount();
    const preventDefault = vi.fn();
    const text = 'line\n'.repeat(250);
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: [],
        items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
        types: ['text/plain'],
        getData: () => text,
      },
    });

    act(() => {
      event.preventDefault = preventDefault;
      container!.querySelector('textarea')!.dispatchEvent(event);
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(latest!.mobileComposer!.value).toBe('');
    expect(latest!.pastedFiles).toHaveLength(1);
    expect(latest!.pastedFiles[0].name).toBe('line line line line line….txt');
    expect(latest!.pastedFiles[0].text).toBe(text);
  });

  it('inserts into the expanded caret and restores its caret without replacing the collapsed selection', async () => {
    mockTouchDevice();
    await mount({ expanded: true });
    typeText('hello world');
    const collapsed = container!.querySelector<HTMLTextAreaElement>(
      '[data-web-shell-composer-editor]',
    )!;
    const expanded =
      container!.querySelector<HTMLTextAreaElement>('[data-expanded]')!;
    act(() => {
      collapsed.setSelectionRange(3, 5);
      expanded.focus();
      expanded.setSelectionRange(11, 11);
      latest!.insertText(' dictated words ');
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(expanded.value).toBe('hello world dictated words ');
    expect(document.activeElement).toBe(expanded);
    expect([expanded.selectionStart, expanded.selectionEnd]).toEqual([27, 27]);
    act(() => {
      expanded.setSelectionRange(0, 5);
      latest!.insertText('Hi');
      latest!.focus();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(expanded.value).toBe('Hi world dictated words ');
    expect([expanded.selectionStart, expanded.selectionEnd]).toEqual([2, 2]);
    expect(document.activeElement).toBe(expanded);
  });

  it('uses the expanded selection for long paste exemptions and folds only once', async () => {
    mockTouchDevice();
    await mount({ expanded: true });
    typeText('draft');
    const expanded =
      container!.querySelector<HTMLTextAreaElement>('[data-expanded]')!;
    const collapsed = container!.querySelector<HTMLTextAreaElement>(
      '[data-web-shell-composer-editor]',
    )!;
    const paste = () => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          files: [],
          items: [],
          types: ['text/plain'],
          getData: () => 'line\n'.repeat(250),
        },
      });
      act(() => expanded.dispatchEvent(event));
      return event;
    };
    expanded.setSelectionRange(0, 5);
    collapsed.setSelectionRange(0, 0);
    expect(paste().defaultPrevented).toBe(false);
    expect(latest!.pastedFiles).toHaveLength(0);
    expanded.setSelectionRange(0, 0);
    collapsed.setSelectionRange(0, 5);
    expect(paste().defaultPrevented).toBe(true);
    expect(latest!.pastedFiles).toHaveLength(1);
    expect(expanded.value).toBe('draft');
  });

  it('moves a folded paste into the touch textarea on request', async () => {
    mockTouchDevice();
    await mount();
    const text = 'line\n'.repeat(250);
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: [],
        items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
        types: ['text/plain'],
        getData: () => text,
      },
    });
    act(() => {
      container!.querySelector('textarea')!.dispatchEvent(event);
    });
    expect(latest!.pastedFiles).toHaveLength(1);

    act(() => latest!.expandPastedText(0));

    // The touch backend inserts the text as a plain controlled-value write and
    // has no undo step of its own (see the design doc's Risks).
    expect(latest!.pastedFiles).toEqual([]);
    expect(latest!.mobileComposer!.value).toBe(text);
  });

  it('saves the draft immediately on blur before the debounce timer fires', async () => {
    mockTouchDevice();
    vi.useFakeTimers();
    await mount({
      sessionId: 'mobile-session',
      atWorkspaceCwd: '/workspace/mobile',
    });
    typeText('mobile draft text');
    expect(
      localStorage.getItem(
        'qwen-web-shell-session-draft:' + encodeURIComponent('mobile-session'),
      ),
    ).toBeNull();

    act(() => {
      container!
        .querySelector('textarea')!
        .dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(
      localStorage.getItem(
        'qwen-web-shell-session-draft:' + encodeURIComponent('mobile-session'),
      ),
    ).toBe('mobile draft text');
    vi.useRealTimers();
  });

  it('walks prompt history from navigatePrevHistory/navigateNextHistory', async () => {
    mockTouchDevice();
    await mount();
    typeText('first message');
    act(() => latest!.submitText());
    typeText('second message');
    act(() => latest!.submitText());
    typeText('working draft');
    expect(latest!.mobileComposer!.value).toBe('working draft');

    act(() => latest!.navigatePrevHistory());
    expect(latest!.mobileComposer!.value).toBe('second message');
    act(() => latest!.navigatePrevHistory());
    expect(latest!.mobileComposer!.value).toBe('first message');
    act(() => latest!.navigateNextHistory());
    expect(latest!.mobileComposer!.value).toBe('second message');
    act(() => latest!.navigateNextHistory());
    expect(latest!.mobileComposer!.value).toBe('working draft');
  });

  it('persists the draft again once the user edits after a history walk', async () => {
    mockTouchDevice();
    await mount({
      sessionId: 'mobile-session',
      atWorkspaceCwd: '/workspace/mobile',
    });
    typeText('first message');
    act(() => latest!.submitText());
    typeText('draft text');
    act(() => latest!.navigatePrevHistory());
    expect(latest!.mobileComposer!.value).toBe('first message');

    typeText('edited after walk');
    act(() => {
      container!
        .querySelector('textarea')!
        .dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(
      localStorage.getItem(
        'qwen-web-shell-session-draft:' + encodeURIComponent('mobile-session'),
      ),
    ).toBe('edited after walk');
  });
});
