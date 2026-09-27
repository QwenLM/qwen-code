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
//    *all* pending sync-lane React work across *all* roots — including the
//    host app's pending re-render from onSubmit (new user message) —
//    synchronously, while CodeMirror's update cycle is still in progress.
//  - The reporter's stack (React frames rS/hwe/db directly beneath
//    EditorView.dispatch) shows host commit-phase work dispatching into the
//    editor during that flush. The VSCode Companion host is not in this
//    repo, so the harness models it with a layout effect that syncs host
//    state into the editor — the minimal faithful stand-in for that stack.
//
// The harness mimics the Companion host:
//  - onSubmit synchronously queues host-level React state (the new user
//    message), so a re-render is pending when the composer commits.
//  - Tag render props are fresh inline identities on every render.

import { afterEach, describe, expect, it } from 'vitest';
import { act, useLayoutEffect, useState } from 'react';
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
    // Fresh identities per render, as passed by the real host.
    renderComposerTag: () => <span data-testid="chip-content">chip</span>,
    renderComposerTagTooltip: () => 'a file reference',
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
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }),
  );
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

    const errors: unknown[] = [];
    try {
      pressEnter();
    } catch (error) {
      errors.push(error);
    }
    await act(async () => {
      await Promise.resolve();
    });

    expect(errors).toEqual([]);
    // The host's sync-into-editor dispatch never re-entered the editor.
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
    // Chip is gone after the clear (its deferred unmount has run too).
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      view.contentDOM.querySelector('[data-testid="chip-content"]'),
    ).toBeNull();
  });
});
