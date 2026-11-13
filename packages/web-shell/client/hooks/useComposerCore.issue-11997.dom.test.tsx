/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom
//
// Reproduction for https://github.com/QwenLM/qwen-code/issues/11997
// "label-only composer / user-message tags have zero padding-right".
//
// A tag whose `removable` is false gets no remove button, so nothing holds the
// chip's right edge. The label/value boxes were built with the four-value
// shorthand `padding:3px 0 3px 7px` — right component 0 — so a label-only chip
// drew its text flush against the border. The trailing text box now carries the
// right inset itself, and the label keeps 0 when a value follows it so the two
// boxes are not pushed apart.

import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WebShellComposerTag } from '../customization';
import { I18nProvider } from '../i18n';
import { useComposerCore, type UseComposerCoreReturn } from './useComposerCore';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: UseComposerCoreReturn | null = null;

function Harness() {
  const composer = useComposerCore({
    onSubmit: () => true,
    commands: [],
    editorTheme: {},
  });
  latest = composer;
  return <div ref={composer.containerRef} />;
}

async function mount() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <Harness />
      </I18nProvider>,
    );
  });
}

function addInlineTag(tag: Partial<WebShellComposerTag>) {
  act(() => {
    latest!.handle.addTags(
      [
        {
          id: 'demo',
          label: 'Task',
          serialized: '/some-skill',
          ...tag,
        } as WebShellComposerTag,
      ],
      { placement: 'inline', position: 'end' },
    );
  });
}

/** The label/value/fallback boxes the inline chip builds are the only spans in
    the chip that carry the padding shorthand, so `padding-top` finds exactly
    the text boxes and never the chip or its remove button. */
function textBoxes(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>('span')).filter(
    (box) => box.style.paddingTop === '3px',
  );
}

const rightInsets = (boxes: HTMLElement[]) =>
  boxes.map((box) => box.style.paddingRight);

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
  document.body.innerHTML = '';
});

describe('useComposerCore issue #11997 label-only chip right padding', () => {
  it('insets the label of a non-removable label-only chip', async () => {
    await mount();
    addInlineTag({ label: 'Task', removable: false });

    const boxes = textBoxes();
    expect(boxes.map((box) => box.textContent)).toEqual(['Task']);
    expect(rightInsets(boxes)).toEqual(['7px']);
  });

  it('leaves the right edge to the remove button when the tag is removable', async () => {
    await mount();
    addInlineTag({ label: 'Task' });

    const boxes = textBoxes();
    expect(boxes.map((box) => box.textContent)).toEqual(['Task']);
    expect(rightInsets(boxes)).toEqual(['0px']);
    expect(document.body.querySelector('button')).not.toBeNull();
  });

  it('insets the value, not the label, when a non-removable chip has both', async () => {
    await mount();
    addInlineTag({ label: 'Task', value: '/some-skill', removable: false });

    const boxes = textBoxes();
    expect(boxes.map((box) => box.textContent)).toEqual([
      'Task',
      '/some-skill',
    ]);
    expect(rightInsets(boxes)).toEqual(['0px', '7px']);
  });
});
