import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

describe('preload overlay pointer routing', () => {
  it('admits drag-only regions and recalculates after DOM changes without pointer movement', () => {
    const source = readFileSync(
      new URL('../../preload/index.ts', import.meta.url),
      'utf8',
    );
    const script = source.slice(source.indexOf('let lastPointerInteractive'));
    const listeners = new Map<string, (event: unknown) => void>();
    const frames: Array<() => void> = [];
    const messages: boolean[] = [];
    let overDragRegion = true;
    let changed = () => {};
    const context = {
      window: {
        addEventListener: (type: string, listener: (event: unknown) => void) =>
          listeners.set(type, listener),
      },
      document: {
        elementFromPoint: () =>
          overDragRegion
            ? {
                closest: (selector: string) =>
                  selector.includes('[data-live-drag]') ? {} : null,
              }
            : null,
      },
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      ipcRenderer: {
        send: (_channel: string, interactive: boolean) =>
          messages.push(interactive),
      },
      MutationObserver: class {
        constructor(callback: () => void) {
          changed = callback;
        }
        observe() {}
        disconnect() {}
      },
      camera: { dispose: () => {} },
      audio: { dispose: () => Promise.resolve() },
    };
    runInNewContext(
      ts.transpileModule(script, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      context,
    );
    listeners.get('mousemove')?.({ clientX: 20, clientY: 30 });
    frames.shift()?.();
    assert.deepEqual(messages, [true]);
    overDragRegion = false;
    changed();
    frames.shift()?.();
    assert.deepEqual(messages, [true, false]);
    overDragRegion = true;
    changed();
    frames.shift()?.();
    listeners.get('blur')?.({});
    frames.shift()?.();
    assert.deepEqual(messages, [true, false, true, false]);
  });
});
