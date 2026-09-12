import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { MemoryPanel } from '../../renderer/memory-panel.ts';
import type { HostPublicState } from '../../shared/host-api.ts';
import type { MemoryAction, MemoryState } from '../../shared/protocol.ts';

const memory: MemoryState = {
  enabled: true,
  visualEnabled: false,
  libraryId: 'default',
  model: 'qwen3.7-plus',
  libraries: [{ id: 'default', name: 'Default' }],
  locked: false,
};
const state: HostPublicState = {
  connection: 'ready',
  memory,
  live: { v: 1, available: true, state: 'idle', shortcut: 'Command+E' },
  permissions: {
    microphone: 'granted',
    camera: 'granted',
    accessibility: 'granted',
    screenRecording: 'granted',
  },
  selfChecks: {
    audioInput: true,
    audioOutput: true,
    globalShortcut: true,
    appshot: true,
  },
  visualReady: true,
};
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const task of cleanup.splice(0).reverse()) task();
});

function setup(
  handler: (action: MemoryAction) => Promise<MemoryState> = async () => memory,
) {
  const dom = new JSDOM(
    '<!doctype html><html><body><main id="app"></main></body></html>',
  );
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: dom.window.document,
  });
  cleanup.push(() => {
    dom.window.close();
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const calls: MemoryAction[] = [];
  const panel = new MemoryPanel({
    memoryAction: async (action) => {
      calls.push(action);
      return handler(action);
    },
  });
  dom.window.document.body.append(panel.element);
  panel.update(state);
  const button = (text: string) => {
    const result = Array.from(panel.element.querySelectorAll('button')).find(
      (item) => item.textContent === text,
    );
    assert(result, `Missing ${text} button`);
    return result;
  };
  const input = (selector: string) => {
    const result = panel.element.querySelector<HTMLInputElement>(selector);
    assert(result, `Missing ${selector} input`);
    return result;
  };
  const change = (target: HTMLInputElement, value: string) => {
    target.value = value;
    target.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  return { dom, panel, calls, button, input, change };
}

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('memory settings panel', () => {
  it('embeds in Settings and retains drafts while disconnected controls are disabled', () => {
    const { panel, button, input, change } = setup();
    assert.equal(panel.element.getAttribute('role'), 'group');
    assert.equal(panel.element.hasAttribute('aria-modal'), false);
    button('Rename').click();
    change(input('#memory-library-name'), 'Unsaved name');
    panel.update({ ...state, connection: 'disconnected', memory: undefined });
    assert.equal(panel.element.hidden, true);
    assert.equal(button('Save').disabled, true);
    panel.update({ ...state, memory: undefined });
    assert.equal(panel.element.hidden, true);
    panel.update(state);
    assert.equal(panel.element.hidden, false);
    assert.equal(input('#memory-library-name').value, 'Unsaved name');
    assert.equal(button('Save').disabled, false);
  });

  it('preserves an in-progress rename and focus across call-state and orb redraws', () => {
    const { dom, panel, button, input, change } = setup();
    button('Rename').click();
    const name = input('#memory-library-name');
    change(name, 'My personal memory');
    name.setSelectionRange(3, 8);
    for (const callState of ['thinking', 'speaking', 'listening'] as const) {
      dom.window.document
        .querySelector('#app')
        ?.replaceChildren(dom.window.document.createElement('div'));
      panel.update({
        ...state,
        memory: { ...memory, locked: true },
        live: { ...state.live, state: callState, caption: 'new caption' },
      });
      assert.equal(name.value, 'My personal memory');
      assert.equal(dom.window.document.activeElement, name);
      assert.equal(name.selectionStart, 3);
      assert.equal(name.selectionEnd, 8);
      assert.equal(name.disabled, false);
    }
    assert.equal(button('New').disabled, true);
    assert.equal(button('Rename').disabled, false);
    assert.equal(input('[aria-label="Consolidation model"]').disabled, true);
    assert.match(panel.element.textContent ?? '', /End the current call/);
  });

  it('shows only the acknowledged toggle and disables duplicate actions while saving', async () => {
    let complete: (next: MemoryState) => void = () => undefined;
    const { dom, panel, calls, button } = setup(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const enabled = panel.element.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    assert(enabled);
    enabled.checked = false;
    enabled.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.deepEqual(calls, [{ action: 'set_enabled', enabled: false }]);
    assert.equal(enabled.checked, true);
    assert.equal(enabled.disabled, true);
    assert.equal(button('New').disabled, true);
    complete({ ...memory, enabled: false });
    await settled();
    assert.equal(enabled.checked, false);
    assert.equal(enabled.disabled, false);
  });

  it('selects a new library from the daemon result and renames by stable id', async () => {
    const created = {
      ...memory,
      libraryId: 'lib_work',
      libraries: [...memory.libraries, { id: 'lib_work', name: 'Work' }],
    };
    const { panel, calls, button, input, change } = setup(async (action) => {
      if (action.action === 'create') return created;
      return {
        ...created,
        libraries: [memory.libraries[0]!, { id: 'lib_work', name: 'Projects' }],
      };
    });
    button('New').click();
    change(input('#memory-library-name'), 'Work');
    button('Save').click();
    await settled();
    assert.deepEqual(calls[0], { action: 'create', name: 'Work' });
    assert.equal(panel.element.querySelector('select')?.value, 'lib_work');
    button('Rename').click();
    assert.equal(panel.element.querySelector('select')?.disabled, true);
    change(input('#memory-library-name'), 'Projects');
    button('Save').click();
    await settled();
    assert.deepEqual(calls[1], {
      action: 'rename',
      libraryId: 'lib_work',
      name: 'Projects',
    });
    assert.equal(
      panel.element.querySelector('select')?.selectedOptions[0]?.textContent,
      'Projects',
    );
  });

  it('preserves model drafts on state updates, saves explicitly, and retains failed name edits', async () => {
    const { panel, calls, button, input, change } = setup(async (action) => {
      if (action.action === 'set_model')
        return { ...memory, model: action.model };
      throw new Error('Could not save library name');
    });
    const model = input('[aria-label="Consolidation model"]');
    change(model, 'custom-model');
    panel.update({ ...state, live: { ...state.live, caption: 'updated' } });
    assert.equal(model.value, 'custom-model');
    assert.equal(calls.length, 0);
    button('Save model').click();
    await settled();
    assert.deepEqual(calls[0], { action: 'set_model', model: 'custom-model' });
    assert.equal(model.value, 'custom-model');
    button('Rename').click();
    change(input('#memory-library-name'), 'Unsaved name');
    button('Save').click();
    await settled();
    assert.equal(input('#memory-library-name').value, 'Unsaved name');
    assert.match(
      panel.element.querySelector('[role="status"]')?.textContent ?? '',
      /Could not save/,
    );
    panel.update({ ...state, connection: 'disconnected', memory: undefined });
    assert.equal(button('Save').disabled, true);
    assert.match(panel.element.textContent ?? '', /Connect to Qwen Live/);
  });
});
