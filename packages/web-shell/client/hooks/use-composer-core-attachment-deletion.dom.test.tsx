/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import { useComposerCore, type UseComposerCoreReturn } from './useComposerCore';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: UseComposerCoreReturn | null = null;

function Harness() {
  const composer = useComposerCore({
    onSubmit: vi.fn(),
    commands: [],
    editorTheme: {},
  });
  latest = composer;
  return (
    <div data-web-shell-composer-surface {...composer.imageTransferHandlers}>
      <div ref={composer.containerRef} />
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
        <Harness />
      </I18nProvider>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
  localStorage.clear();
  vi.restoreAllMocks();
});

async function pasteImages(images: File[]) {
  const reads: Promise<void>[] = [];
  const readAsDataURL = FileReader.prototype.readAsDataURL;
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (
    this: FileReader,
    blob: Blob,
  ) {
    reads.push(
      new Promise((resolve) => {
        this.addEventListener('loadend', () => resolve(), { once: true });
      }),
    );
    readAsDataURL.call(this, blob);
  });
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', {
    value: {
      files: images,
      items: images.map((image) => ({
        kind: 'file',
        type: 'image/png',
        getAsFile: () => image,
      })),
      types: ['Files'],
      getData: () => '',
    },
  });
  await act(async () => {
    container!.querySelector('.cm-content')!.dispatchEvent(paste);
    // Ingestion queues reads asynchronously. Keep their real events inside act.
    await vi.waitFor(() => expect(reads).toHaveLength(images.length));
    await Promise.all(reads);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(latest!.pendingImageBatchCount).toBe(0);
  expect(latest!.pastedImages).toHaveLength(images.length);
}

function pressKey(key: string) {
  act(() => {
    latest!.viewRef.current!.focus();
    container!.querySelector('.cm-content')!.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        code: key,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

describe('useComposerCore issue #10794 attachment deletion', () => {
  it.each(['Backspace', 'Delete'])(
    'removes a removable tag before an image with %s',
    async (key) => {
      await mount();
      await pasteImages([
        new File(['png'], 'photo.png', { type: 'image/png' }),
      ]);
      act(() => latest!.addTags([{ id: 'orders', value: 'orders' }]));
      pressKey(key);
      expect(latest!.composerTags).toEqual([]);
      expect(latest!.pastedImages).toHaveLength(1);
      pressKey(key);
      expect(latest!.pastedImages).toEqual([]);
    },
  );

  it.each(['Backspace', 'Delete'])(
    'preserves non-removable tags while deleting an image with %s',
    async (key) => {
      await mount();
      await pasteImages([
        new File(['png'], 'photo.png', { type: 'image/png' }),
      ]);
      act(() =>
        latest!.addTags([{ id: 'fixed', value: 'fixed', removable: false }]),
      );
      pressKey(key);
      expect(latest!.composerTags).toHaveLength(1);
      expect(latest!.pastedImages).toEqual([]);
    },
  );

  it.each(['Backspace', 'Delete'])(
    'preserves committed images during an in-flight paste with %s',
    async (key) => {
      await mount();
      await pasteImages([
        new File(['first'], 'first.png', { type: 'image/png' }),
      ]);
      const first = latest!.pastedImages[0];
      vi.restoreAllMocks();
      const readAsDataURL = FileReader.prototype.readAsDataURL;
      let resumeRead: (() => void) | undefined;
      let readSettled!: Promise<void>;
      vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(
        function (this: FileReader, blob: Blob) {
          readSettled = new Promise((resolve) =>
            this.addEventListener('loadend', () => resolve(), { once: true }),
          );
          resumeRead = () => readAsDataURL.call(this, blob);
        },
      );
      let pendingPaste!: Promise<void>;
      await act(async () => {
        pendingPaste = Promise.resolve(
          latest!.ingestFiles([
            new File(['second'], 'second.png', { type: 'image/png' }),
          ]),
        );
        await vi.waitFor(() => expect(resumeRead).toBeDefined());
      });
      expect(latest!.pendingImageBatchCount).toBe(1);
      pressKey(key);
      expect(latest!.pastedImages).toEqual([first]);
      await act(async () => {
        resumeRead!();
        await pendingPaste;
        await readSettled;
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(latest!.pendingImageBatchCount).toBe(0);
      expect(latest!.pastedImages).toHaveLength(2);
      pressKey(key);
      expect(latest!.pastedImages).toEqual([first]);
    },
  );

  it.each(['Backspace', 'Delete'])(
    'removes a pasted image from an empty composer with %s',
    async (key) => {
      await mount();
      await pasteImages([
        new File(['png'], 'photo.png', { type: 'image/png' }),
      ]);
      expect(latest!.getText()).toBe('');
      pressKey(key);
      expect(latest!.pastedImages).toEqual([]);
    },
  );

  it.each(['Backspace', 'Delete'])(
    'removes only the last image with %s',
    async (key) => {
      await mount();
      await pasteImages([
        new File(['first'], 'first.png', { type: 'image/png' }),
        new File(['second'], 'second.png', { type: 'image/png' }),
      ]);
      const first = latest!.pastedImages[0];
      pressKey(key);
      expect(latest!.pastedImages).toEqual([first]);
      pressKey(key);
      expect(latest!.pastedImages).toEqual([]);
    },
  );

  it.each(['Backspace', 'Delete'])(
    'preserves images when text exists with %s',
    async (key) => {
      await mount();
      await pasteImages([
        new File(['png'], 'photo.png', { type: 'image/png' }),
      ]);
      act(() => {
        latest!.handle.setText('hello');
        latest!.viewRef.current!.dispatch({ selection: { anchor: 0 } });
      });
      pressKey(key);
      expect(latest!.pastedImages).toHaveLength(1);
    },
  );

  it.each(['Backspace', 'Delete'])(
    'removes the last file before an image with %s',
    async (key) => {
      await mount();
      await pasteImages([
        new File(['png'], 'photo.png', { type: 'image/png' }),
      ]);
      act(() => {
        expect(
          latest!.ingestFiles([
            new File(['first'], 'first.txt', { type: 'text/plain' }),
            new File(['second'], 'second.txt', { type: 'text/plain' }),
          ]),
        ).toBe(true);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(latest!.pastedFiles).toHaveLength(2);
      pressKey(key);
      expect(latest!.pastedFiles.map((file) => file.name)).toEqual([
        'first.txt',
      ]);
      expect(latest!.pastedImages).toHaveLength(1);
      pressKey(key);
      expect(latest!.pastedFiles).toEqual([]);
      expect(latest!.pastedImages).toHaveLength(1);
    },
  );
});
