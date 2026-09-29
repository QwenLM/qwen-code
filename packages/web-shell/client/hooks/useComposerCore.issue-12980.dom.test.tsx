/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom
//
// Reproduction for https://github.com/QwenLM/qwen-code/issues/12980
// "reference chip attaches to earlier matching plain text after submit".
//
// The composer knows each inline chip's real CodeMirror range, but the
// submit path dropped it and createInputAnnotationsFromComposerTags
// re-located every tag with content.indexOf(serialized, cursor), so plain
// text spelled like a chip's serialized text won the annotation. With
// `literal @foo then @foo` the inline chip sits at [18, 22) yet the
// generated annotation covered [8, 12), so the user-message bubble rendered
// the typed text as the chip and the selected reference as plain text.

import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonInputAnnotation } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../i18n';
import { splitComposerTagContentByAnnotations } from '../utils/composerTag';
import { useComposerCore, type UseComposerCoreReturn } from './useComposerCore';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: UseComposerCoreReturn | null = null;
let submittedText: string | null = null;
let submittedAnnotations: readonly DaemonInputAnnotation[] = [];

function Harness() {
  const composer = useComposerCore({
    onSubmit: (text, _images, _files, _commitAccepted, metadata) => {
      submittedText = text;
      submittedAnnotations = metadata?.inputAnnotations ?? [];
      return true;
    },
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

function appendPlainText(text: string) {
  const view = latest!.viewRef.current!;
  act(() => {
    view.dispatch({
      changes: { from: view.state.doc.length, insert: text },
    });
  });
}

function addFileChipAtEnd(serialized: string) {
  act(() => {
    latest!.handle.addTags(
      [{ id: `file:${serialized}`, kind: 'file', value: serialized }],
      { placement: 'inline', position: 'end' },
    );
  });
}

function addTopFileChip(serialized: string) {
  act(() => {
    latest!.handle.addTags(
      [{ id: `file:${serialized}`, kind: 'file', value: serialized }],
      { placement: 'top' },
    );
  });
}

function setShellMode(enabled: boolean) {
  act(() => {
    latest!.setShellMode(enabled);
  });
}

async function submit() {
  await act(async () => {
    latest!.submitText();
  });
}

function annotationRanges() {
  return submittedAnnotations.map(({ start, end }) => [start, end]);
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
  submittedText = null;
  submittedAnnotations = [];
  document.body.innerHTML = '';
});

describe('useComposerCore issue #12980 inline chip annotation offsets', () => {
  it('attaches the annotation to the inline chip, not earlier matching plain text', async () => {
    await mount();
    appendPlainText('literal @foo then ');
    addFileChipAtEnd('@foo');
    expect(latest!.viewRef.current!.state.doc.toString()).toBe(
      'literal @foo then @foo ',
    );

    await submit();

    expect(submittedText).toBe('literal @foo then @foo');
    expect(annotationRanges()).toEqual([[18, 22]]);
    // The bubble must keep the typed look-alike plain and render the
    // selected reference as the chip.
    expect(
      splitComposerTagContentByAnnotations(
        submittedText!,
        submittedAnnotations,
      ),
    ).toEqual([
      { type: 'text', text: 'literal @foo then ' },
      {
        type: 'reference',
        tag: expect.objectContaining({ id: 'file:@foo' }),
      },
    ]);
  });

  it('keeps annotating a chip that has no plain-text look-alike (control)', async () => {
    await mount();
    appendPlainText('see ');
    addFileChipAtEnd('@foo');

    await submit();

    expect(submittedText).toBe('see @foo');
    expect(annotationRanges()).toEqual([[4, 8]]);
  });

  it('keeps annotating the chip when it precedes matching plain text (control)', async () => {
    await mount();
    addFileChipAtEnd('@foo');
    appendPlainText('then @foo');

    await submit();

    expect(submittedText).toBe('@foo then @foo');
    expect(annotationRanges()).toEqual([[0, 4]]);
  });

  it('shifts the chip past a top tag prefix', async () => {
    await mount();
    addTopFileChip('@top');
    appendPlainText('literal @foo then ');
    addFileChipAtEnd('@foo');
    expect(latest!.viewRef.current!.state.doc.toString()).toBe(
      'literal @foo then @foo ',
    );

    await submit();

    // The top tag is serialized ahead of the editor text, so the prompt is
    // '@top' + blank separator + text and promptPrefixLength is 6. The chip's
    // editor range [18, 22) must land on [24, 28), not on the plain-text
    // look-alike at [14, 18).
    expect(submittedText).toBe('@top\n\nliteral @foo then @foo');
    expect(annotationRanges()).toEqual([
      [0, 4],
      [24, 28],
    ]);
    expect(
      splitComposerTagContentByAnnotations(
        submittedText!,
        submittedAnnotations,
      ),
    ).toEqual([
      {
        type: 'reference',
        tag: expect.objectContaining({ id: 'file:@top' }),
      },
      { type: 'text', text: '\n\nliteral @foo then ' },
      {
        type: 'reference',
        tag: expect.objectContaining({ id: 'file:@foo' }),
      },
    ]);
  });

  it('shifts the chip past the shell-mode "!" prefix', async () => {
    await mount();
    setShellMode(true);
    appendPlainText('literal @foo then ');
    addFileChipAtEnd('@foo');

    await submit();

    // Shell mode prepends '!', so promptPrefixLength is 1 and the chip's
    // editor range [18, 22) must land on [19, 23).
    expect(submittedText).toBe('!literal @foo then @foo');
    expect(annotationRanges()).toEqual([[19, 23]]);
  });
});
