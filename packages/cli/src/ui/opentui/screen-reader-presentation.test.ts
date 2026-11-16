/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@opentui/core', () => {
  class Renderable {
    visible = true;
    isDestroyed = false;
    id = '';
    children: Renderable[] = [];
    getChildren() {
      return this.children;
    }
    findDescendantById(id: string): Renderable | undefined {
      for (const node of this.children) {
        if (node.id === id) return node;
        const found = node.findDescendantById(id);
        if (found) return found;
      }
      return undefined;
    }
  }
  class TextBufferRenderable extends Renderable {
    plainText = '';
  }
  class EditBufferRenderable extends TextBufferRenderable {
    focused = false;
    cursorOffset = 0;
  }
  class TextareaRenderable extends EditBufferRenderable {
    placeholder = '';
  }
  class MarkdownRenderable extends Renderable {
    content = '';
  }
  class SelectRenderable extends Renderable {
    options = [
      { name: 'Allow once', description: 'Run command' },
      { name: 'Deny', description: 'Cancel' },
    ];
    selected = 1;
    getSelectedIndex() {
      return this.selected;
    }
    getSelectedOption() {
      return this.options[this.selected];
    }
  }
  class TextTableRenderable extends Renderable {
    content = [[[{ text: 'Name' }], [{ text: 'Value' }]]];
  }
  return {
    Renderable,
    TextBufferRenderable,
    EditBufferRenderable,
    TextareaRenderable,
    MarkdownRenderable,
    SelectRenderable,
    TextTableRenderable,
  };
});

import {
  Renderable,
  TextBufferRenderable,
  EditBufferRenderable,
  SelectRenderable,
  TextareaRenderable,
} from '@opentui/core';
import {
  ScreenReaderPresentation,
  readScreenReaderControls,
} from './screen-reader-presentation.js';
import { ScreenReaderOutputWriter } from './a11y-screen-reader.js';

function text(value: string) {
  const node = Object.assign(Object.create(TextBufferRenderable.prototype), {
    plainText: value,
    visible: true,
    id: '',
    isDestroyed: false,
    children: [],
  }) as TextBufferRenderable;
  return node;
}

function box(children: Renderable[]) {
  return Object.assign(Object.create(Renderable.prototype), {
    children,
    visible: true,
    id: '',
    isDestroyed: false,
  }) as Renderable;
}

describe('screen-reader semantic presentation', () => {
  it('reads real selection state without using colors, and excludes hidden controls', () => {
    const selected = Object.assign(Object.create(SelectRenderable.prototype), {
      options: [
        { name: 'Allow once', description: 'Run command' },
        { name: 'Deny', description: 'Cancel' },
      ],
      selected: 1,
      visible: true,
      id: '',
      isDestroyed: false,
    }) as SelectRenderable;
    const hidden = text('secret hidden page');
    hidden.visible = false;
    const tab = text('General');
    tab.id = 'screen-reader-selected-tab';
    expect(
      readScreenReaderControls(
        box([text('Permission required'), selected, tab, hidden]),
      ),
    ).toBe(
      'Permission required\n1. Allow once: Run command\nSelected 2. Deny: Cancel\nSelected General',
    );
  });

  it('does not invent selection for user-controlled arrow text', () => {
    expect(readScreenReaderControls(text('› user text'))).toBe('› user text');
    expect(readScreenReaderControls(text('───'))).toBe('───');
  });

  it('announces the actual editable value and cursor while keeping original input owner', () => {
    const input = Object.assign(Object.create(EditBufferRenderable.prototype), {
      plainText: 'hello',
      cursorOffset: 2,
      focused: true,
      visible: true,
      id: '',
      isDestroyed: false,
    }) as EditBufferRenderable;
    expect(readScreenReaderControls(box([input]))).toBe(
      'Focused Input: hello\nCursor: 2',
    );
    expect(input.plainText).toBe('hello');
  });

  it('identifies the actual empty composer placeholder without treating a suggestion as submitted text', () => {
    const prompt = Object.assign(Object.create(TextareaRenderable.prototype), {
      plainText: '',
      placeholder: 'Type your message or @path/to/file',
      cursorOffset: 0,
      focused: true,
      visible: true,
      id: 'screen-reader-prompt',
      isDestroyed: false,
    }) as TextareaRenderable;
    expect(readScreenReaderControls(prompt)).toBe(
      'Focused Prompt: \nPlaceholder: Type your message or @path/to/file\nCursor: 0',
    );
  });

  it('keeps a software-cursor input line intact including the space under its caret', () => {
    const field = box([text('> '), text('hello'), text(' '), text('world')]);
    field.id = 'screen-reader-input-line';
    expect(readScreenReaderControls(field)).toBe('> hello world');
  });

  it('keeps inline spaces while pruning hidden and protected child values', () => {
    const hidden = text('hidden');
    hidden.visible = false;
    Object.defineProperty(hidden, 'plainText', {
      get: () => {
        throw new Error('hidden getter');
      },
    });
    const secret = text('secret');
    Object.defineProperty(secret, 'plainText', {
      get: () => {
        throw new Error('secret getter');
      },
    });
    const protectedField = box([secret]);
    protectedField.id = 'screen-reader-protected-input';
    const field = box([text('left '), hidden, protectedField, text(' right')]);
    field.id = 'screen-reader-input-line';
    expect(readScreenReaderControls(field)).toBe('left Protected input right');
  });

  it('never reads a protected input value, even when a child getter would expose it', () => {
    const secret = text('raw-secret');
    Object.defineProperty(secret, 'plainText', {
      get: () => {
        throw new Error('must not read secret');
      },
    });
    const field = box([secret]);
    field.id = 'screen-reader-protected-input';
    expect(readScreenReaderControls(field)).toBe('Protected input');
  });

  it('announces dialog closure and actual focus return without erasing existing output', () => {
    let output = '';
    const events = new EventEmitter();
    const area = box([text('Approval required')]);
    area.id = 'screen-reader-dialog';
    const root = box([area]);
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    presentation.observeFrames(events, () => root);
    events.emit('frame');
    expect(output).toBe('Dialog\nApproval required\n');
    area.id = 'screen-reader-composer';
    const prompt = Object.assign(
      Object.create(EditBufferRenderable.prototype),
      {
        plainText: '',
        cursorOffset: 0,
        focused: true,
        visible: true,
        id: 'screen-reader-prompt',
        isDestroyed: false,
        children: [],
      },
    ) as EditBufferRenderable;
    area.getChildren()[0] = prompt;
    events.emit('frame');
    expect(output).toContain('Dialog closed. Focus: prompt.');
    const once = output;
    events.emit('frame');
    expect(output).toBe(once);
    expect(output).not.toContain('\u001b');
  });

  it('publishes actual history subtree text once, preserves rewritten content, and resets the owner', () => {
    let output = '';
    const events = new EventEmitter();
    const row = box([text('Mod rewritten Hel')]);
    row.id = 'screen-reader-item-assistant:reply';
    const history = box([row]);
    history.id = 'screen-reader-history';
    const root = box([history]);
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    presentation.observeFrames(events, () => root);
    const ownerA = {};
    presentation.setHistory(ownerA, [{ kind: 'assistant', id: 'reply' }]);
    expect(output).toBe('');
    events.emit('frame');
    expect(output).toBe('assistant: Mod rewritten Hel\n');
    Object.defineProperty(row.getChildren()[0], 'plainText', {
      value: 'Mod rewritten Hello',
      configurable: true,
    });
    events.emit('frame');
    const done = output;
    events.emit('frame');
    expect(output).toBe(done);
    expect(output).toBe(
      'assistant: Mod rewritten Hel\nRevision assistant: Mod rewritten Hello\n',
    );
    presentation.setHistory(ownerA, []);
    expect(output).toContain('Conversation cleared.');
    presentation.setHistory({}, [{ kind: 'assistant', id: 'reply' }]);
    events.emit('frame');
    presentation.setHistory(ownerA, [{ kind: 'assistant', id: 'reply' }]);
    events.emit('frame');
    expect(output).not.toContain('\nlo\n');
    expect(output.match(/^assistant: Mod rewritten Hello$/gm)).toHaveLength(2);
  });

  it('announces a same-ID correction without repeating unchanged controls, and resets control cache for a new owner', () => {
    let output = '';
    const events = new EventEmitter();
    const row = box([text('Initial reply')]);
    row.id = 'screen-reader-item-assistant:reply';
    const history = box([row]);
    history.id = 'screen-reader-history';
    const root = box([history, text('Help available')]);
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    const owner = {};
    presentation.setHistory(owner, [{ kind: 'assistant', id: 'reply' }]);
    presentation.observeFrames(events, () => root);
    events.emit('frame');
    Object.defineProperty(row.getChildren()[0], 'plainText', {
      value: 'Corrected reply',
      configurable: true,
    });
    events.emit('frame');
    expect(output).toContain('Revision assistant: Corrected reply');
    expect(output.match(/Help available/g)).toHaveLength(1);
    presentation.setHistory({}, [{ kind: 'assistant', id: 'reply' }]);
    events.emit('frame');
    expect(output.match(/Help available/g)).toHaveLength(2);
    expect(output).not.toContain('\u001b');
  });

  it('keeps separate displayed tool segments that share a call ID', () => {
    let output = '';
    const events = new EventEmitter();
    const first = box([text('First segment')]);
    first.id = 'screen-reader-item-tool:call:first';
    const second = box([text('Second segment')]);
    second.id = 'screen-reader-item-tool:call:second';
    const history = box([first, second]);
    history.id = 'screen-reader-history';
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    presentation.setHistory({}, [
      { kind: 'tool', id: 'call', renderId: 'first' },
      { kind: 'tool', id: 'call', renderId: 'second' },
    ]);
    presentation.observeFrames(events, () => box([history]));
    events.emit('frame');
    expect(output).toBe('tool: First segment\ntool: Second segment\n');
  });

  it('updates controls only on completed frames and detaches the exact callback', () => {
    let output = '';
    const events = new EventEmitter();
    const controls = box([text('Help: Enter selects, Escape closes')]);
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    const detach = presentation.observeFrames(events, () => controls);
    expect(output).toBe('');
    events.emit('frame');
    expect(output).toContain('Help: Enter selects, Escape closes');
    const once = output;
    events.emit('frame');
    expect(output).toBe(once);
    const queued = events.listeners('frame')[0]!;
    detach();
    controls.getChildren()[0] = text('stale');
    events.emit('frame');
    queued();
    expect(output).not.toContain('stale');
    expect(events.listenerCount('frame')).toBe(0);
  });

  it('sanitizes the actual permission description without reading secret hidden content or invoking actions', () => {
    let output = '';
    const events = new EventEmitter();
    const row = box([
      text('Shell pending: echo hello'),
      text('\u001b]52;c;secret\u0007result'),
    ]);
    row.id = 'screen-reader-item-tool:t';
    const history = box([row]);
    history.id = 'screen-reader-history';
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    presentation.setHistory({}, [{ kind: 'tool', id: 't' }]);
    presentation.observeFrames(events, () => box([history]));
    events.emit('frame');
    expect(output).toContain('pending');
    expect(output).toContain('echo hello');
    expect(output).toContain('result');
    expect(output).not.toContain('secret');
    expect(output).not.toContain('\u001b');
  });
});
