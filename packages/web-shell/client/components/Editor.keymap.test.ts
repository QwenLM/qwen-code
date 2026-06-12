// @vitest-environment jsdom
//
// Regression test for the Editor submit/newline keymap. Mounts a real
// CodeMirror EditorView with the same bindings as Editor.tsx and dispatches
// real keydown events, asserting that:
//   - Enter submits (does not insert a newline)
//   - Shift+Enter / Ctrl+J / Mod(Cmd/Ctrl)+Enter / Alt(Option)+Enter insert '\n'
// This locks the resolution of the 'Alt-Enter' and 'Mod-Enter' key strings so
// Option/Cmd+Enter newline input cannot silently regress.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Prec } from '@codemirror/state';

function mountEditor() {
  let submitted = false;
  const insertNewline = (view: EditorView) => {
    view.dispatch(view.state.replaceSelection('\n'));
    return true;
  };
  const submitKeymap = keymap.of([
    {
      key: 'Enter',
      run: () => {
        submitted = true;
        return true;
      },
    },
    { key: 'Shift-Enter', run: insertNewline },
    { key: 'Ctrl-j', run: insertNewline },
    { key: 'Mod-Enter', run: insertNewline },
    { key: 'Alt-Enter', run: insertNewline },
  ]);
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ extensions: [Prec.highest(submitKeymap)] }),
    parent,
  });
  return {
    view,
    getSubmitted: () => submitted,
    resetSubmitted: () => {
      submitted = false;
    },
    cleanup: () => {
      view.destroy();
      parent.remove();
    },
  };
}

function press(
  view: EditorView,
  init: { key: string; code: string } & KeyboardEventInit,
) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
  );
}

describe('Editor newline keymap (runtime)', () => {
  let h: ReturnType<typeof mountEditor>;
  beforeEach(() => {
    h = mountEditor();
  });
  afterEach(() => {
    h.cleanup();
  });

  it('Enter submits without inserting a newline', () => {
    press(h.view, { key: 'Enter', code: 'Enter' });
    expect(h.getSubmitted()).toBe(true);
    expect(h.view.state.doc.toString()).toBe('');
  });

  it('Shift+Enter inserts a newline and does not submit', () => {
    press(h.view, { key: 'Enter', code: 'Enter', shiftKey: true });
    expect(h.getSubmitted()).toBe(false);
    expect(h.view.state.doc.toString()).toBe('\n');
  });

  it('Ctrl+J inserts a newline and does not submit', () => {
    press(h.view, { key: 'j', code: 'KeyJ', ctrlKey: true });
    expect(h.getSubmitted()).toBe(false);
    expect(h.view.state.doc.toString()).toBe('\n');
  });

  it('Alt/Option+Enter inserts a newline and does not submit', () => {
    press(h.view, { key: 'Enter', code: 'Enter', altKey: true });
    expect(h.getSubmitted()).toBe(false);
    expect(h.view.state.doc.toString()).toBe('\n');
  });

  it('Mod+Enter (Cmd on mac / Ctrl elsewhere) inserts a newline', () => {
    // CodeMirror's `Mod-` prefix resolves to exactly one modifier per platform
    // (Meta on mac, Ctrl elsewhere). Dispatch the platform-correct one so the
    // assertion fails if Ctrl+Enter is ever broken on non-mac (and vice versa).
    const isMac = /Mac/i.test(navigator.platform ?? '');
    press(h.view, {
      key: 'Enter',
      code: 'Enter',
      metaKey: isMac,
      ctrlKey: !isMac,
    });
    expect(h.getSubmitted()).toBe(false);
    expect(h.view.state.doc.toString()).toBe('\n');
  });
});
