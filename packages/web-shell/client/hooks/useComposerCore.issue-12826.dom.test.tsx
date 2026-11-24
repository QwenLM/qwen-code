/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom
//
// Reproduction for https://github.com/QwenLM/qwen-code/issues/12826
// "Calls to EditorView.update are not allowed while an update is in progress"
// when submitting a prompt that contains an inline @file chip.
//
// Mechanism (verified against react-dom 19.2.4 source):
//  - commitAccepted() dispatches a doc-clearing transaction, which destroys
//    the inline tag chip widget mid-update.
//  - ComposerTagWidget.destroy() used to call Root.unmount() synchronously.
//  - Root.unmount() ends in flushSyncWorkAcrossRoots_impl(): it flushes
//    *all* pending sync-lane React work across *all* roots synchronously,
//    while CodeMirror's update cycle is still in progress. Any commit-phase
//    work in that flush which touches the editor re-enters it and throws.
//  - The reporter's stack (React frames rS/hwe/db directly beneath
//    EditorView.dispatch) has exactly that shape.
//
// What was checked against the real host, and what was not:
//  - packages/vscode-ide-companion IS in this tree at the reporter's version
//    (0.24.6), and its esbuild config emits the reported dist/webview.js.
//    It passes no renderComposerTag / renderComposerTagTooltip /
//    composerTagIcons / onComposerTagClick (zero occurrences package-wide),
//    and its own addTags call passes no placement, so it never reaches the
//    inline branch. A real inline @file chip therefore comes from web-shell
//    itself (ChatEditor's handleAddMenuInsertReference and file-reference
//    paths, both placement:'inline') and gets its React root from the
//    built-in preview-icon branch in toDOM(), never from a host
//    renderContent. The 'does not re-enter the editor for a chip built by the
//    built-in file-icon branch' test below covers that branch; the two 'defers
//    a failed inline tag ...' tests cover the host-renderer catch paths, which
//    that host never reaches.
//  - NOT resolved: the specific commit-phase frame that dispatched into the
//    editor in the reporter's minified stack (webview.js:680:8046). The
//    panel has no useLayoutEffect and web-shell exposes no onSubmit prop
//    (only prepareSubmit), so the harness models that *class* of frame —
//    React commit-phase work dispatching into the editor mid-update — rather
//    than replicating an identified call site.
//
// The harness:
//  - onSubmit synchronously queues React state, as web-shell's own transcript
//    update does on submit, so a re-render is pending when the composer
//    commits. This is the load-bearing part of the reproduction.
//  - A layout effect stands in for the unresolved frame above, recording the
//    editor's update phase when it runs and optionally dispatching into it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useLayoutEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Transaction } from '@codemirror/state';
import { I18nProvider } from '../i18n';
import { useComposerCore, type UseComposerCoreReturn } from './useComposerCore';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: UseComposerCoreReturn | null = null;

// CodeMirror keeps its update phase in a private field; read it only to
// observe whether host React work ran while an update was in progress.
const CM_IDLE = 0;
type ViewWithUpdateState = { updateState: number };

const observedUpdateStates: number[] = [];
const hostDispatchErrors: unknown[] = [];
let hostSyncsIntoEditor = false;
// The Companion panel passes no tag render props at all, so its @file chip
// React root comes from the built-in preview-icon branch in toDOM() rather
// than from a host renderContent. Flip this to build chips that way.
let hostPassesTagRenderProps = true;
// Counts cleanups inside the chip subtree so a test can observe that the
// deferred Root.unmount() in destroy() actually ran. The widget nulls its
// root fields synchronously and they are private, so the deferral is only
// observable from inside the rendered subtree.
let chipUnmounts = 0;

function ChipProbe() {
  useEffect(
    () => () => {
      chipUnmounts += 1;
    },
    [],
  );
  return <span data-testid="chip-content">chip</span>;
}

// Same trick for the tooltip root, which is the one the tooltip-catch
// deferral releases. Opt-in per test: the renderer has to keep returning a
// string for the others, because tooltipText is derived only from a
// string/number tooltip and the sibling suite pins the chip.title fallback
// that depends on it.
let tooltipRendersProbe = false;
let tooltipUnmounts = 0;

function TooltipProbe() {
  useEffect(
    () => () => {
      tooltipUnmounts += 1;
    },
    [],
  );
  return null;
}

function CompanionLikeHarness() {
  const [messages, setMessages] = useState<string[]>([]);
  const composer = useComposerCore({
    onSubmit: (text: string) => {
      // The host appends the user message: synchronous setState from inside
      // the composer's submit pipeline, exactly like the Companion panel.
      setMessages((current) => [...current, text]);
      return true;
    },
    commands: [],
    editorTheme: {},
    ...(hostPassesTagRenderProps
      ? {
          renderComposerTag: () => <ChipProbe />,
          renderComposerTagTooltip: () =>
            tooltipRendersProbe ? <TooltipProbe /> : 'a file reference',
        }
      : {}),
  });
  latest = composer;

  useLayoutEffect(() => {
    if (messages.length === 0) return;
    const view = composer.viewRef.current;
    if (!view) return;
    observedUpdateStates.push(
      (view as unknown as ViewWithUpdateState).updateState,
    );
    if (hostSyncsIntoEditor) {
      // Hosts sync prop/state changes into the editor. Any dispatch landing
      // here while CodeMirror is mid-update throws the reported error.
      try {
        view.dispatch({ annotations: Transaction.addToHistory.of(false) });
      } catch (error) {
        hostDispatchErrors.push(error);
      }
    }
  }, [messages, composer]);

  return (
    <div>
      <div ref={composer.containerRef} />
      <output data-testid="messages">{messages.join('|')}</output>
    </div>
  );
}

async function mount() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <CompanionLikeHarness />
      </I18nProvider>,
    );
  });
}

function addFileChip(value: string) {
  act(() => {
    latest!.handle.addTags([{ id: `file:${value}`, kind: 'file', value }], {
      placement: 'inline',
    });
  });
}

function pressEnter() {
  const view = latest!.viewRef.current!;
  // act() keeps this file free of "not wrapped in act" noise, which is
  // otherwise textually indistinguishable from a real violation. It does not
  // vacuate the reproduction: the pre-fix mutation still reddens tests 1-2.
  act(() => {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

// Root.unmount() flushes sync work across ALL roots, so an unmount that runs
// while CodeMirror is mid-update is exactly the #12826 hazard. Record the
// editor's update phase at every unmount so a test can assert the call left
// the cycle, instead of asserting its ordering against some nearby statement.
function spyRootUnmountStates() {
  const proto = Object.getPrototypeOf(root!) as Root;
  const realUnmount = proto.unmount;
  const states: number[] = [];
  const spy = vi.spyOn(proto, 'unmount').mockImplementation(function (
    this: Root,
  ) {
    const view = latest?.viewRef.current;
    if (view) {
      states.push((view as unknown as ViewWithUpdateState).updateState);
    }
    return realUnmount.call(this);
  });
  return { states, restore: () => spy.mockRestore() };
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
  latest = null;
  observedUpdateStates.length = 0;
  hostDispatchErrors.length = 0;
  hostSyncsIntoEditor = false;
  hostPassesTagRenderProps = true;
  chipUnmounts = 0;
  tooltipRendersProbe = false;
  tooltipUnmounts = 0;
  document.body.innerHTML = '';
});

describe('useComposerCore issue #12826 re-entrant update', () => {
  it('does not flush host React work into the CodeMirror update cycle on submit', async () => {
    await mount();
    const view = latest!.viewRef.current!;
    addFileChip('notes.txt');
    expect(view.state.doc.toString()).toContain('notes.txt');
    expect(
      view.contentDOM.querySelector('[data-testid="chip-content"]'),
    ).not.toBeNull();

    observedUpdateStates.length = 0;
    pressEnter();
    await act(async () => {
      await Promise.resolve();
    });

    // The host re-rendered (message appended) ...
    expect(observedUpdateStates.length).toBeGreaterThan(0);
    // ... but never from inside CodeMirror's update cycle.
    expect(observedUpdateStates).toEqual(
      observedUpdateStates.map(() => CM_IDLE),
    );
    // The composer was cleared and the chip removed.
    expect(view.state.doc.toString()).toBe('');
  });

  it('submitting an inline @file chip does not re-enter EditorView.update', async () => {
    hostSyncsIntoEditor = true;
    await mount();
    const view = latest!.viewRef.current!;
    addFileChip('notes.txt');
    expect(view.state.doc.toString()).toContain('notes.txt');

    // No try/catch here: pressEnter() cannot throw into its caller, because
    // the harness's own try/catch swallows the modelled host dispatch at its
    // origin. Assert on what the harness recorded instead.
    pressEnter();
    await act(async () => {
      await Promise.resolve();
    });

    // The host layout effect really ran (it bails while messages is empty) ...
    expect(observedUpdateStates.length).toBeGreaterThan(0);
    // ... and never from inside CodeMirror's update cycle. This is what fails
    // if host React work is flushed mid-update, even when nothing throws.
    expect(observedUpdateStates).toEqual(
      observedUpdateStates.map(() => CM_IDLE),
    );
    expect(hostDispatchErrors).toEqual([]);
    expect(view.state.doc.toString()).toBe('');
    expect(
      view.contentDOM.querySelector('[data-testid="chip-content"]'),
    ).toBeNull();
  });

  it('keeps the normal chip submit flow working (regression guard)', async () => {
    await mount();
    const view = latest!.viewRef.current!;

    addFileChip('b.ts');
    expect(view.state.doc.toString()).toContain('b.ts');

    // Captured before the submit: the act() around submitText() already
    // drains the queued microtask, so the deferral cannot be observed after.
    const unmountsBefore = chipUnmounts;
    const errors: unknown[] = [];
    try {
      await act(async () => {
        latest!.submitText();
      });
    } catch (error) {
      errors.push(error);
    }
    expect(errors).toEqual([]);
    expect(view.state.doc.toString()).toBe('');
    await act(async () => {
      await Promise.resolve();
    });
    // The chip tile leaves the editor DOM synchronously, so querying for the
    // chip content cannot distinguish "unmounted" from "still mounted in a
    // detached tile" — and emptying the deferred unmount keeps this file
    // green while every submitted chip retains its React root for the life
    // of the webview. Observe the unmount from inside the chip subtree.
    expect(chipUnmounts).toBeGreaterThan(unmountsBefore);
    expect(
      view.contentDOM.querySelector('[data-testid="chip-content"]'),
    ).toBeNull();
  });

  it('does not re-enter the editor for a chip built by the built-in file-icon branch', async () => {
    // The Companion panel passes no tag render props, so a real inline @file
    // chip gets its React root from toDOM()'s preview-icon branch rather than
    // from a host renderContent. That is the branch the reporter hit, and the
    // three tests above never build it.
    hostPassesTagRenderProps = false;
    hostSyncsIntoEditor = true;
    await mount();
    const view = latest!.viewRef.current!;
    addFileChip('notes.txt');
    expect(view.state.doc.toString()).toContain('notes.txt');
    // Self-guard: the built-in branch really did create a React root and
    // render into the chip's aria-hidden icon span. Without this the test
    // would pass vacuously if that branch stopped creating a root at all.
    expect(
      view.contentDOM.querySelector('span[aria-hidden="true"] svg'),
    ).not.toBeNull();

    pressEnter();
    await act(async () => {
      await Promise.resolve();
    });

    expect(observedUpdateStates.length).toBeGreaterThan(0);
    expect(observedUpdateStates).toEqual(
      observedUpdateStates.map(() => CM_IDLE),
    );
    expect(hostDispatchErrors).toEqual([]);
    expect(view.state.doc.toString()).toBe('');
  });

  it('defers a failed inline tag content root out of the update cycle', async () => {
    await mount();
    const view = latest!.viewRef.current!;
    const { states, restore } = spyRootUnmountStates();
    const contentAppendError = new Error('content append failed');
    const appendChild = HTMLElement.prototype.appendChild;
    // Narrow probe: toDOM()'s custom-content span is the only element carrying
    // display:inline-flex together with a min-width (the built-in file-icon
    // span has no min-width, the tooltip span is display:none). React DOM
    // itself calls appendChild during commit, so a blanket throw would break
    // the harness's own render.
    const appendChildSpy = vi
      .spyOn(HTMLElement.prototype, 'appendChild')
      .mockImplementation(function (child) {
        if (
          child instanceof HTMLElement &&
          child.style.display === 'inline-flex' &&
          child.style.minWidth !== ''
        ) {
          throw contentAppendError;
        }
        return appendChild.call(this, child);
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Captured before the chip is added: chipUnmounts is a module-level counter
    // reset per test, so the release can only be read as a before/after delta.
    const unmountsBefore = chipUnmounts;

    try {
      addFileChip('notes.txt');
      await act(async () => {
        await Promise.resolve();
      });

      // Self-guard: the throw landed in toDOM()'s renderContent catch rather
      // than in the earlier root-less one, because only the former runs after
      // renderContent() has returned a node. Both emit the same message, so
      // the error identity is what pins the site.
      expect(warn).toHaveBeenCalledWith(
        '[WebShell] inline tag renderContent failed',
        contentAppendError,
      );
      // The failed content root was released (deferred, not skipped). Only that
      // root renders <ChipProbe/>, so its cleanup counter is root-scoped, while
      // the shared unmount spy sees every root alive in the window ...
      expect(chipUnmounts).toBeGreaterThan(unmountsBefore);
      expect(states.length).toBeGreaterThan(0);
      // ... and each observed unmount ran only once CodeMirror had left its
      // update cycle.
      expect(states).toEqual(states.map(() => CM_IDLE));
      // That catch re-assigns this.contentRoot for the built-in file icon, so
      // the deferred unmount has to release the root it captured, not the
      // fresh one — otherwise the icon's subtree is torn down with it.
      expect(
        view.contentDOM.querySelector('span[aria-hidden="true"] svg'),
      ).not.toBeNull();
    } finally {
      warn.mockRestore();
      appendChildSpy.mockRestore();
      restore();
    }
  });

  it('defers a failed inline tag tooltip root out of the update cycle', async () => {
    tooltipRendersProbe = true;
    await mount();
    const view = latest!.viewRef.current!;
    const { states, restore } = spyRootUnmountStates();
    const tooltipAppendError = new Error('tooltip append failed');
    const appendChild = HTMLElement.prototype.appendChild;
    const appendChildSpy = vi
      .spyOn(HTMLElement.prototype, 'appendChild')
      .mockImplementation(function (child) {
        if (
          child instanceof HTMLElement &&
          child.getAttribute('role') === 'tooltip'
        ) {
          throw tooltipAppendError;
        }
        return appendChild.call(this, child);
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Captured before the chip is added: tooltipUnmounts is a module-level
    // counter reset per test, so the release reads as a before/after delta.
    const unmountsBefore = tooltipUnmounts;

    try {
      addFileChip('notes.txt');
      await act(async () => {
        await Promise.resolve();
      });

      expect(warn).toHaveBeenCalledWith(
        '[WebShell] inline tag tooltip render failed',
        tooltipAppendError,
      );
      expect(view.contentDOM.querySelector('[role="tooltip"]')).toBeNull();
      // Twin of the icon guard above: only the tooltip root is released here.
      // Custom content rendered fine, so the live content root must survive.
      expect(
        view.contentDOM.querySelector('[data-testid="chip-content"]'),
      ).not.toBeNull();
      // Only the failed tooltip root renders <TooltipProbe/>, so this delta
      // cannot be satisfied by an unrelated root unmounting inside the window
      // -- which is what makes dropping the deferral observable right here.
      expect(tooltipUnmounts).toBeGreaterThan(unmountsBefore);
      // That unmount went through the spied prototype, so states is non-empty
      // and this comparison cannot pass vacuously.
      expect(states).toEqual(states.map(() => CM_IDLE));
    } finally {
      warn.mockRestore();
      appendChildSpy.mockRestore();
      restore();
    }
  });
});
