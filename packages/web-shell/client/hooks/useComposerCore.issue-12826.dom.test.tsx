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
//    renderContent. The last test below covers that branch.
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

import { afterEach, describe, expect, it } from 'vitest';
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
          renderComposerTagTooltip: () => 'a file reference',
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
});
