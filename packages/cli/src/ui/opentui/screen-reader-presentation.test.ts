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
    getTextRange(start: number, end: number): string {
      if ([...this.plainText].some((char) => char.codePointAt(0)! > 127)) {
        throw new Error(
          'Configure a captured native prefix for non-ASCII fixtures',
        );
      }
      return this.plainText.slice(start, end);
    }
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
import { foldLiveEvent, type LiveAssistantItem } from './live-session-model.js';
import { setLanguageAsync } from '../../i18n/index.js';

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
  it.each([
    ['user', '用户'],
    ['assistant', '助手'],
    ['thinking', '思考'],
    ['tool', '工具'],
    ['task', '任务'],
    ['image', '图像'],
    ['compaction', '压缩'],
    ['info', '信息'],
    ['error', '错误'],
    ['warning', '警告'],
    ['retry', '重试'],
    ['stop-hook', '停止钩子'],
    ['away-recap', '离开摘要'],
    ['user-shell', '用户命令'],
    ['advisor', '顾问'],
    ['arena-agent', '竞技场智能体'],
    ['arena-session', '竞技场会话'],
    ['goal', '目标'],
  ])(
    'localizes the actual %s history label without changing its body or identity',
    async (kind, label) => {
      await setLanguageAsync('zh');
      try {
        const row = box([text('Original user content')]);
        row.id = `screen-reader-item-${kind}:entry`;
        const history = box([row]);
        history.id = 'screen-reader-history';
        const root = box([history]);
        const events = new EventEmitter();
        let output = '';
        const presentation = new ScreenReaderPresentation(
          new ScreenReaderOutputWriter((chunk) => {
            output += chunk;
          }),
        );
        presentation.setHistory({}, [{ kind, id: 'entry' }]);
        const stop = presentation.observeFrames(events, () => root);
        try {
          events.emit('frame');
          expect(output).toBe(`${label}：Original user content\n`);
          expect(row.id).toBe(`screen-reader-item-${kind}:entry`);
        } finally {
          stop();
        }
      } finally {
        await setLanguageAsync('en');
      }
    },
  );

  it('localizes semantic announcements without changing user text, owner dedupe or protected reads', async () => {
    await setLanguageAsync('zh');
    try {
      const caret = text(' ');
      caret.id = 'screen-reader-caret-active-5';
      const field = box([text('> '), text('hello'), caret, text('world')]);
      field.id = 'screen-reader-input-line';
      expect(readScreenReaderControls(field)).toBe(
        '输入已聚焦。光标：5\n> hello world',
      );
      const secret = box([]);
      secret.id = 'screen-reader-protected-input';
      Object.defineProperty(secret, 'getChildren', {
        value: () => {
          throw new Error('secret children');
        },
      });
      expect(readScreenReaderControls(secret)).toBe('受保护的输入');
      const native = Object.create(
        EditBufferRenderable.prototype,
      ) as EditBufferRenderable;
      Object.defineProperties(native, {
        id: { value: '' },
        visible: { value: true },
        isDestroyed: { value: false },
        focused: { value: true },
        plainText: { value: '你好🙂' },
        cursorOffset: { value: 6 },
        getTextRange: { value: () => '你好🙂' },
      });
      expect(readScreenReaderControls(native)).toBe(
        '已聚焦的输入：你好🙂\n光标：3',
      );
      const toggle = text('User label');
      toggle.id = 'screen-reader-auth-toggle-focused-on';
      expect(readScreenReaderControls(toggle)).toBe(
        '已聚焦，开关已开启：User label',
      );
      const choice = text('User choice');
      choice.id = 'screen-reader-selected-option';
      let output = '';
      const events = new EventEmitter();
      const row = box([text('User body')]);
      row.id = 'screen-reader-item-assistant:reply';
      const history = box([row]);
      history.id = 'screen-reader-history';
      const dialog = box([choice]);
      dialog.id = 'screen-reader-dialog';
      const root = box([history, dialog]);
      const presentation = new ScreenReaderPresentation(
        new ScreenReaderOutputWriter((chunk) => {
          output += chunk;
        }),
      );
      const owner = {};
      presentation.setHistory(owner, [{ kind: 'assistant', id: 'reply' }]);
      const stop = presentation.observeFrames(events, () => root);
      try {
        events.emit('frame');
        expect(output).toContain('对话框\n');
        expect(output).toContain('已选择 User choice');
        const first = output;
        choice.id = 'screen-reader-unselected-option';
        events.emit('frame');
        expect(output).toBe(first);
        Object.defineProperty(row.getChildren()[0], 'plainText', {
          value: 'Corrected user body',
          configurable: true,
        });
        events.emit('frame');
        expect(output).toContain('修订 助手：Corrected user body');
        dialog.id = '';
        events.emit('frame');
        expect(output).toContain('对话框已关闭。');
        presentation.setHistory(owner, []);
        expect(output).toContain('对话已清空。');
      } finally {
        stop();
      }
    } finally {
      await setLanguageAsync('en');
    }
  });

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

  it.each([
    ['question-tab', '▸ Q2', '  Q2', 'Q2'],
    ['question-tab', '▸ ▸ Deploy', '  ▸ Deploy', '▸ Deploy'],
    ['submit-tab', '▸ Submit', ' Submit', 'Submit'],
    ['attachment', '> a.txt', '📎 a.txt', 'a.txt'],
    ['attachment', '> > user.txt', '📎 > user.txt', '> user.txt'],
  ])(
    'normalizes only the known %s marker across selection',
    (kind, active, inactive, label) => {
      const row = text(active);
      row.id = `screen-reader-selected-${kind}`;
      const events = new EventEmitter();
      let output = '';
      const presentation = new ScreenReaderPresentation(
        new ScreenReaderOutputWriter((chunk) => {
          output += chunk;
        }),
      );
      presentation.observeFrames(events, () => box([row]));
      events.emit('frame');
      expect(output).toBe(`Selected ${label}\n`);
      row.id = `screen-reader-unselected-${kind}`;
      Object.defineProperty(row, 'plainText', {
        value: inactive,
        configurable: true,
      });
      events.emit('frame');
      expect(output).toBe(`Selected ${label}\n`);
    },
  );

  it('announces only explicitly disabled producer options as disabled', () => {
    const disabled = text('Marketplaces');
    disabled.id = 'screen-reader-unselected-option-disabled';
    expect(readScreenReaderControls(disabled)).toBe('Disabled Marketplaces');
    const enabled = text('Add new');
    enabled.id = 'screen-reader-unselected-option';
    expect(readScreenReaderControls(enabled)).toBe('Add new');
    disabled.id = 'screen-reader-selected-option-disabled';
    Object.defineProperty(disabled, 'plainText', {
      value: '› Marketplaces',
      configurable: true,
    });
    expect(readScreenReaderControls(disabled)).toBe(
      'Selected Disabled Marketplaces',
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

  it.each([
    { phase: 'end', offset: 6, prefix: '你好🙂', codePoints: 3 },
    { phase: 'home', offset: 0, prefix: '', codePoints: 0 },
    { phase: 'right', offset: 2, prefix: '你', codePoints: 1 },
  ])(
    'announces the captured public native prefix position at $phase',
    ({ offset, prefix, codePoints }) => {
      const getTextRange = vi.fn((start: number, end: number) => {
        expect(start).toBe(0);
        expect(end).toBe(offset);
        return prefix;
      });
      const input = Object.assign(
        Object.create(EditBufferRenderable.prototype),
        {
          plainText: '你好🙂',
          cursorOffset: offset,
          focused: true,
          visible: true,
          isDestroyed: false,
          id: '',
          getTextRange,
        },
      ) as EditBufferRenderable;
      expect(readScreenReaderControls(input)).toBe(
        `Focused Input: 你好🙂\nCursor: ${codePoints}`,
      );
      expect(getTextRange).toHaveBeenCalledExactlyOnceWith(0, offset);
      expect(input.cursorOffset).toBe(offset);
    },
  );

  it('prunes a protected native editor before reading its value, cursor or native range', () => {
    const input = Object.assign(Object.create(EditBufferRenderable.prototype), {
      id: 'screen-reader-protected-input',
      visible: true,
      isDestroyed: false,
      focused: true,
    }) as EditBufferRenderable;
    Object.defineProperties(input, {
      plainText: {
        get: () => {
          throw new Error('secret value');
        },
      },
      cursorOffset: {
        get: () => {
          throw new Error('secret cursor');
        },
      },
      getTextRange: {
        value: () => {
          throw new Error('secret prefix');
        },
      },
    });
    expect(readScreenReaderControls(input)).toBe('Protected input');
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

  it('announces actual software input focus and ASCII caret while retaining inline spaces', () => {
    const caret = text(' ');
    caret.id = 'screen-reader-caret-active-5';
    const field = box([text('> '), text('hello'), caret, text('world')]);
    field.id = 'screen-reader-input-line';
    expect(readScreenReaderControls(field)).toBe(
      'Focused input. Cursor: 5\n> hello world',
    );
    caret.id = 'screen-reader-caret-inactive-5';
    expect(readScreenReaderControls(field)).toBe(
      'Unfocused input.\n> hello world',
    );
    field.id = 'screen-reader-protected-input';
    Object.defineProperty(field, 'getChildren', {
      value: () => {
        throw new Error('protected children must not be read');
      },
    });
    expect(readScreenReaderControls(field)).toBe('Protected input');
  });

  it('reads explicit advanced toggle focus and checked state independently of color', () => {
    const toggle = text('Enable thinking');
    toggle.id = 'screen-reader-auth-toggle-focused-on';
    expect(readScreenReaderControls(toggle)).toBe(
      'Focused Toggle on: Enable thinking',
    );
    toggle.id = 'screen-reader-auth-toggle-unfocused-off';
    expect(readScreenReaderControls(toggle)).toBe(
      'Toggle off: Enable thinking',
    );
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

  it('publishes settled assistant subtree text once without replaying streaming prefixes, and resets the owner', () => {
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
    const item: LiveAssistantItem = {
      kind: 'assistant',
      id: 'reply',
      text: 'Canonical text is not the displayed Mod text',
      streaming: true,
    };
    presentation.setHistory(ownerA, [item]);
    expect(output).toBe('');
    events.emit('frame');
    expect(output).toBe('');
    Object.defineProperty(row.getChildren()[0], 'plainText', {
      value: 'Mod rewritten Hello',
      configurable: true,
    });
    presentation.setHistory(ownerA, [item]);
    events.emit('frame');
    expect(output).toBe('');
    Object.defineProperty(row.getChildren()[0], 'plainText', {
      value: 'Mod rewritten Hello world!',
      configurable: true,
    });
    const settled: LiveAssistantItem = { ...item, streaming: false };
    presentation.setHistory(ownerA, [settled]);
    events.emit('frame');
    expect(output).toBe('assistant: Mod rewritten Hello world!\n');
    const done = output;
    events.emit('frame');
    expect(output).toBe(done);
    presentation.setHistory(ownerA, []);
    expect(output).toContain('Conversation cleared.');
    presentation.setHistory({}, [{ kind: 'assistant', id: 'reply' }]);
    events.emit('frame');
    presentation.setHistory(ownerA, [{ kind: 'assistant', id: 'reply' }]);
    events.emit('frame');
    expect(output).not.toContain('\nlo\n');
    expect(
      output.match(/^assistant: Mod rewritten Hello world!$/gm),
    ).toHaveLength(3);
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

  it.each(['tool', 'thinking'])(
    'waits for %s settlement while leaving the real permission dialog live',
    (kind) => {
      let output = '';
      const events = new EventEmitter();
      const row = box([text('partial body')]);
      row.id = `screen-reader-item-${kind}:pending`;
      const history = box([row]);
      history.id = 'screen-reader-history';
      const dialog = text('Allow execution of actual command?');
      dialog.id = 'screen-reader-dialog';
      const presentation = new ScreenReaderPresentation(
        new ScreenReaderOutputWriter((chunk) => {
          output += chunk;
        }),
      );
      const owner = {};
      presentation.setHistory(owner, [{ kind, id: 'pending', done: false }]);
      presentation.observeFrames(events, () => box([history, dialog]));
      events.emit('frame');
      expect(output).toContain('Allow execution of actual command?');
      expect(output).not.toContain('partial body');
      presentation.setHistory(owner, [{ kind, id: 'pending', done: true }]);
      events.emit('frame');
      events.emit('frame');
      expect(output.match(/partial body/g)).toHaveLength(1);
    },
  );

  it('announces the actual mounted range on navigation and rejects stale range rows after clear or owner replacement', () => {
    let output = '';
    const events = new EventEmitter();
    const range = text('History items 1-1 of 2');
    range.id = 'screen-reader-history-window';
    const first = text('first actual row');
    first.id = 'screen-reader-item-user:first';
    const last = text('last actual row');
    last.id = 'screen-reader-item-user:last';
    const history = box([range, first]);
    history.id = 'screen-reader-history';
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    presentation.observeFrames(events, () => box([history]));
    const owner = {};
    presentation.setHistory(owner, [
      { kind: 'user', id: 'first' },
      { kind: 'user', id: 'last' },
    ]);
    events.emit('frame');
    Object.assign(range, { plainText: 'History items 2-2 of 2' });
    history.getChildren()[1] = last;
    events.emit('frame');
    Object.assign(range, { plainText: 'History items 1-1 of 2' });
    history.getChildren()[1] = first;
    events.emit('frame');
    expect(output.match(/History items 1-1 of 2/g)).toHaveLength(2);
    expect(output.match(/user: first actual row/g)).toHaveLength(1);
    expect(output).toContain('user: last actual row');
    presentation.setHistory(owner, []);
    const cleared = output;
    events.emit('frame');
    presentation.setHistory({}, []);
    events.emit('frame');
    expect(output).toBe(cleared);
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

  it('speaks a subagent task card once across its real progress ticks', () => {
    let output = '';
    const events = new EventEmitter();
    const row = box([text('researcher bench frames')]);
    const history = box([row]);
    history.id = 'screen-reader-history';
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    const owner = {};
    let items = foldLiveEvent([], {
      type: 'task-start',
      id: 's1',
      name: 'researcher',
      description: 'bench frames',
    });
    row.id = `screen-reader-item-task:${items[0]!.id}`;
    presentation.setHistory(owner, items);
    presentation.observeFrames(events, () => box([history]));
    events.emit('frame');
    expect(output).toBe('task: researcher bench frames\n');
    for (const line of ['↳ grep', '↳ read', '↳ write']) {
      items = foldLiveEvent(items, { type: 'task-progress', id: 's1', line });
      Object.defineProperty(row.getChildren()[0], 'plainText', {
        value: `researcher bench frames ${line}`,
        configurable: true,
      });
      presentation.setHistory(owner, items);
      events.emit('frame');
    }
    expect(output).toBe('task: researcher bench frames\n');
  });

  it('speaks a retry countdown once instead of once per redrawn second', () => {
    let output = '';
    const events = new EventEmitter();
    const row = box([text('rate limited ↻ 5s')]);
    const history = box([row]);
    history.id = 'screen-reader-history';
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    const owner = {};
    const items = foldLiveEvent([], {
      type: 'retry-countdown',
      attempt: 1,
      maxRetries: 3,
      delayMs: 5000,
      message: 'rate limited',
    });
    row.id = `screen-reader-item-retry:${items[0]!.id}`;
    presentation.setHistory(owner, items);
    presentation.observeFrames(events, () => box([history]));
    events.emit('frame');
    const spoken = output;
    expect(spoken).toContain('rate limited');
    for (const remaining of ['4s', '3s', '2s']) {
      Object.defineProperty(row.getChildren()[0], 'plainText', {
        value: `rate limited ↻ ${remaining}`,
        configurable: true,
      });
      presentation.setHistory(owner, items);
      events.emit('frame');
    }
    expect(output).toBe(spoken);
  });

  it('keeps the edited composer out of the append-only record', () => {
    let output = '';
    const events = new EventEmitter();
    const prompt = Object.assign(Object.create(TextareaRenderable.prototype), {
      plainText: '',
      placeholder: '',
      cursorOffset: 0,
      focused: true,
      visible: true,
      isDestroyed: false,
      id: 'screen-reader-prompt',
      children: [],
    }) as TextareaRenderable;
    const writer = new ScreenReaderOutputWriter((chunk) => {
      output += chunk;
    });
    const appendStatic = vi.spyOn(writer, 'appendStatic');
    const presentation = new ScreenReaderPresentation(writer);
    presentation.observeFrames(events, () => box([prompt]));
    for (const char of 'abcdefghij') {
      Object.assign(prompt, {
        plainText: prompt.plainText + char,
        cursorOffset: prompt.cursorOffset + 1,
      });
      events.emit('frame');
    }
    for (const offset of [4, 7, 0]) {
      Object.assign(prompt, { cursorOffset: offset });
      events.emit('frame');
    }
    expect(
      appendStatic.mock.calls.filter(([text]) => text.includes('Prompt:')),
    ).toHaveLength(0);
    expect(output).toContain('Focused Prompt: abcdefghij');
    expect(output).toContain('Cursor: 0');
  });

  it('speaks the navigation help once while the announced range changes', () => {
    let output = '';
    const events = new EventEmitter();
    const range = text('History items 1-1 of 2');
    range.id = 'screen-reader-history-window';
    const help = text(
      'Shift+Up/Down or PageUp/Down to read history; Ctrl+Home/End for first/latest.',
    );
    help.id = 'screen-reader-history-help';
    const item = text('first actual row');
    item.id = 'screen-reader-item-user:first';
    const history = box([range, help, item]);
    history.id = 'screen-reader-history';
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    const owner = {};
    presentation.setHistory(owner, [
      { kind: 'user', id: 'first' },
      { kind: 'user', id: 'last' },
    ]);
    presentation.observeFrames(events, () => box([history]));
    events.emit('frame');
    Object.assign(range, { plainText: 'History items 2-2 of 2' });
    events.emit('frame');
    Object.assign(range, { plainText: 'History items 1-2 of 2' });
    events.emit('frame');
    expect(output.match(/Shift\+Up\/Down/g)).toHaveLength(1);
    expect(output.match(/History items/g)).toHaveLength(3);
  });

  it('keeps an unchanged settled control across a remount of its renderable', () => {
    let output = '';
    const events = new EventEmitter();
    const footer = () => {
      const model = text('model-x');
      model.id = 'screen-reader-footer-status-0';
      const worktree = text('Worktree: main (issue-123)');
      worktree.id = 'screen-reader-footer-worktree';
      const loading = text('Working. Escape to cancel.');
      loading.id = 'screen-reader-loading';
      return box([model, worktree, loading]);
    };
    let root = footer();
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    presentation.observeFrames(events, () => root);
    events.emit('frame');
    const first = output;
    expect(first.match(/model-x/g)).toHaveLength(1);
    root = footer();
    events.emit('frame');
    expect(output).toBe(first);
  });

  it('keeps rows that share a state id distinct across frames', () => {
    let output = '';
    const events = new EventEmitter();
    const toggle = (label: string) => {
      const row = text(label);
      row.id = 'screen-reader-auth-toggle-unfocused-off';
      return row;
    };
    const root = box([toggle('Image'), toggle('Video'), toggle('Audio')]);
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    presentation.observeFrames(events, () => root);
    events.emit('frame');
    events.emit('frame');
    expect(output.match(/Toggle off: Image/g)).toHaveLength(1);
    expect(output.match(/Toggle off: Video/g)).toHaveLength(1);
    expect(output.match(/Toggle off: Audio/g)).toHaveLength(1);
  });

  it('does not announce a clear when a different empty session opens', () => {
    let output = '';
    const events = new EventEmitter();
    const row = box([text('Hello from session A')]);
    row.id = 'screen-reader-item-assistant:reply';
    const history = box([row]);
    history.id = 'screen-reader-history';
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    presentation.setHistory({}, [{ kind: 'assistant', id: 'reply' }]);
    presentation.observeFrames(events, () => box([history]));
    events.emit('frame');
    expect(output).toBe('assistant: Hello from session A\n');
    presentation.setHistory({}, []);
    expect(output).toBe('assistant: Hello from session A\n');
  });

  it('reseeds silently instead of replaying the conversation on a language switch', async () => {
    let output = '';
    const events = new EventEmitter();
    const row = box([text('Hello world')]);
    row.id = 'screen-reader-item-user:greeting';
    const history = box([row]);
    history.id = 'screen-reader-history';
    const loading = text('Working. Escape to cancel.');
    loading.id = 'screen-reader-loading';
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    presentation.setHistory({}, [{ kind: 'user', id: 'greeting' }]);
    presentation.observeFrames(events, () => box([history, loading]));
    events.emit('frame');
    const english = output;
    expect(english).toBe('user: Hello world\nWorking. Escape to cancel.\n');
    await setLanguageAsync('de');
    try {
      Object.assign(loading, {
        plainText: 'Wird ausgeführt. Escape zum Abbrechen.',
      });
      events.emit('frame');
      expect(output).toBe(english);
      events.emit('frame');
      expect(output).toBe(english);
    } finally {
      await setLanguageAsync('en');
    }
  });

  it('strips the cursor and checkmark a toggle row paints as furniture', () => {
    const on = text('\u203a \u25c9\ufe0e Image');
    on.id = 'screen-reader-auth-toggle-focused-on';
    expect(readScreenReaderControls(on)).toBe('Focused Toggle on: Image');
    const off = text('  \u25cb\ufe0e Video');
    off.id = 'screen-reader-auth-toggle-unfocused-off';
    expect(readScreenReaderControls(off)).toBe('Toggle off: Video');
  });

  it('speaks an empty input lane as a placeholder rather than as its value', () => {
    const glyph = text('> ');
    glyph.id = 'screen-reader-input-glyph';
    const caret = text('Search\u2026');
    caret.id = 'screen-reader-caret-active-0';
    const field = box([glyph, caret]);
    field.id = 'screen-reader-input-line-placeholder';
    expect(readScreenReaderControls(field)).toBe(
      'Focused input. Cursor: 0\nPlaceholder: Search\u2026',
    );
    // The same text typed as a query is a value, not a placeholder.
    field.id = 'screen-reader-input-line';
    expect(readScreenReaderControls(field)).toBe(
      'Focused input. Cursor: 0\nSearch\u2026',
    );
  });

  it('keeps a history row that arrives on the language-switch frame audible', async () => {
    let output = '';
    const events = new EventEmitter();
    const greeting = box([text('Hello world')]);
    greeting.id = 'screen-reader-item-user:greeting';
    const history = box([greeting]);
    history.id = 'screen-reader-history';
    let root = box([history]);
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    const owner = {};
    presentation.setHistory(owner, [{ kind: 'user', id: 'greeting' }]);
    presentation.observeFrames(events, () => root);
    events.emit('frame');
    await setLanguageAsync('de');
    try {
      const settled = box([text('A turn settles on the switch frame')]);
      settled.id = 'screen-reader-item-user:settled';
      const wider = box([greeting, settled]);
      wider.id = 'screen-reader-history';
      root = box([wider]);
      presentation.setHistory(owner, [
        { kind: 'user', id: 'greeting' },
        { kind: 'user', id: 'settled' },
      ]);
      events.emit('frame');
      events.emit('frame');
      expect(output).toContain('A turn settles on the switch frame');
    } finally {
      await setLanguageAsync('en');
    }
  });

  it('keeps a control that mounts on the language-switch frame audible', async () => {
    let output = '';
    const events = new EventEmitter();
    const row = box([text('Hello world')]);
    row.id = 'screen-reader-item-user:greeting';
    const history = box([row]);
    history.id = 'screen-reader-history';
    let root = box([history]);
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    presentation.setHistory({}, [{ kind: 'user', id: 'greeting' }]);
    presentation.observeFrames(events, () => root);
    events.emit('frame');
    await setLanguageAsync('de');
    try {
      const loading = text('Wird ausgef\u00fchrt. Escape zum Abbrechen.');
      loading.id = 'screen-reader-loading';
      root = box([history, loading]);
      events.emit('frame');
      events.emit('frame');
      expect(output).toContain('Wird ausgef\u00fchrt. Escape zum Abbrechen.');
    } finally {
      await setLanguageAsync('en');
    }
  });

  it('keeps a history range that first appears on the language-switch frame audible', async () => {
    let output = '';
    const events = new EventEmitter();
    const row = box([text('Hello world')]);
    row.id = 'screen-reader-item-user:greeting';
    const history = box([row]);
    history.id = 'screen-reader-history';
    let root = box([history]);
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    presentation.setHistory({}, [{ kind: 'user', id: 'greeting' }]);
    presentation.observeFrames(events, () => root);
    events.emit('frame');
    await setLanguageAsync('de');
    try {
      const range = text('Historieneintr\u00e4ge 1-1 von 1');
      range.id = 'screen-reader-history-window';
      const withRange = box([range, row]);
      withRange.id = 'screen-reader-history';
      root = box([withRange]);
      events.emit('frame');
      events.emit('frame');
      expect(output).toContain('Historieneintr\u00e4ge 1-1 von 1');
    } finally {
      await setLanguageAsync('en');
    }
  });

  it('does not re-speak an unchanged footer after a frame without it', () => {
    let output = '';
    const events = new EventEmitter();
    const footer = () => {
      const model = text('model-x');
      model.id = 'screen-reader-footer-status-0';
      const worktree = text('Worktree: main (issue-123)');
      worktree.id = 'screen-reader-footer-worktree';
      return box([model, worktree]);
    };
    let root: Renderable = footer();
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    presentation.observeFrames(events, () => root);
    events.emit('frame');
    // The shell unmounts the whole footer behind a dialog or the completion
    // menu, then mounts the same rows again.
    root = box([]);
    events.emit('frame');
    root = footer();
    events.emit('frame');
    expect(output.match(/model-x/g)).toHaveLength(1);
    expect(output.match(/Worktree: main/g)).toHaveLength(1);
  });

  it('re-announces a transient footer row that unmounts and returns unchanged', () => {
    let output = '';
    const events = new EventEmitter();
    const row = (id: string, value: string) => {
      const node = text(value);
      node.id = id;
      return node;
    };
    const status = () => row('screen-reader-footer-status-0', 'model-x');
    const armed = () =>
      box([
        status(),
        row('screen-reader-footer-exit', 'Press Ctrl+C again to exit.'),
        row('screen-reader-footer-queue', '2 queued'),
      ]);
    let root: Renderable = armed();
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    presentation.observeFrames(events, () => root);
    events.emit('frame');
    // The guard window lapses and the queue drains while the footer stays up.
    root = box([status()]);
    events.emit('frame');
    root = armed();
    events.emit('frame');
    expect(output.match(/Press Ctrl\+C again to exit\./g)).toHaveLength(2);
    expect(output.match(/2 queued/g)).toHaveLength(2);
    expect(output.match(/model-x/g)).toHaveLength(1);
  });

  it('keeps a timer-driven readout on the dynamic block, not the scrollback', () => {
    const events = new EventEmitter();
    const clock = text('12:00:01');
    clock.id = 'screen-reader-live-status-0';
    const writer = new ScreenReaderOutputWriter(() => {});
    const appendStatic = vi.spyOn(writer, 'appendStatic');
    const updateDynamic = vi.spyOn(writer, 'updateDynamic');
    const presentation = new ScreenReaderPresentation(writer);
    presentation.observeFrames(events, () => box([clock]));
    events.emit('frame');
    Object.assign(clock, { plainText: '12:00:02' });
    events.emit('frame');
    Object.assign(clock, { plainText: '12:00:03' });
    events.emit('frame');
    expect(appendStatic).not.toHaveBeenCalled();
    expect(updateDynamic.mock.calls.map(([value]) => value)).toEqual([
      '12:00:01',
      '12:00:02',
      '12:00:03',
    ]);
  });

  it('appends an untagged timer-driven row at most once across changing frames', () => {
    const events = new EventEmitter();
    const elapsed = text('1.0s');
    const writer = new ScreenReaderOutputWriter(() => {});
    const appendStatic = vi.spyOn(writer, 'appendStatic');
    const presentation = new ScreenReaderPresentation(writer);
    presentation.observeFrames(events, () => box([elapsed]));
    events.emit('frame');
    Object.assign(elapsed, { plainText: '2.0s' });
    events.emit('frame');
    Object.assign(elapsed, { plainText: '3.0s' });
    events.emit('frame');
    expect(appendStatic).toHaveBeenCalledTimes(1);
    expect(appendStatic).toHaveBeenCalledWith('1.0s');
  });

  it('speaks a changed control row once its text settles on the next frame', () => {
    const events = new EventEmitter();
    const status = text('model-x');
    status.id = 'screen-reader-footer-status-0';
    const writer = new ScreenReaderOutputWriter(() => {});
    const appendStatic = vi.spyOn(writer, 'appendStatic');
    const presentation = new ScreenReaderPresentation(writer);
    presentation.observeFrames(events, () => box([status]));
    events.emit('frame');
    Object.assign(status, { plainText: 'model-y' });
    events.emit('frame');
    expect(appendStatic).toHaveBeenCalledTimes(1);
    events.emit('frame');
    expect(appendStatic).toHaveBeenCalledTimes(2);
    expect(appendStatic).toHaveBeenLastCalledWith('model-y');
    events.emit('frame');
    expect(appendStatic).toHaveBeenCalledTimes(2);
  });

  it('keeps the de-selection suppression across the settle frame', () => {
    const events = new EventEmitter();
    const row = text('\u203a Option A');
    row.id = 'screen-reader-selected-option';
    const writer = new ScreenReaderOutputWriter(() => {});
    const appendStatic = vi.spyOn(writer, 'appendStatic');
    const presentation = new ScreenReaderPresentation(writer);
    presentation.observeFrames(events, () => box([row]));
    events.emit('frame');
    expect(appendStatic).toHaveBeenCalledWith('Selected Option A');
    row.id = 'screen-reader-unselected-option';
    Object.assign(row, { plainText: '  Option A' });
    events.emit('frame');
    events.emit('frame');
    expect(appendStatic).toHaveBeenCalledTimes(1);
    row.id = 'screen-reader-selected-option';
    Object.assign(row, { plainText: '\u203a Option A' });
    events.emit('frame');
    events.emit('frame');
    expect(appendStatic).toHaveBeenCalledTimes(2);
    expect(appendStatic).toHaveBeenLastCalledWith('Selected Option A');
  });

  it('reseeds a closing history with fresh ids without replaying spoken rows', () => {
    let output = '';
    const events = new EventEmitter();
    const live = box([text('The actual reply')]);
    live.id = 'screen-reader-item-assistant:as1';
    const liveHistory = box([live]);
    liveHistory.id = 'screen-reader-history';
    let root = box([liveHistory]);
    const presentation = new ScreenReaderPresentation(
      new ScreenReaderOutputWriter((chunk) => {
        output += chunk;
      }),
    );
    const owner = {};
    presentation.setHistory(owner, [{ kind: 'assistant', id: 'as1' }]);
    presentation.observeFrames(events, () => root);
    events.emit('frame');
    expect(output).toBe('assistant: The actual reply\n');
    const closing = box([text('The actual reply')]);
    closing.id = 'screen-reader-item-assistant:as99';
    const summary = box([text('Agent powering down. Goodbye!')]);
    summary.id = 'screen-reader-item-info:quit1';
    const closingHistory = box([closing, summary]);
    closingHistory.id = 'screen-reader-history';
    root = box([closingHistory]);
    presentation.setHistory(
      owner,
      [
        { kind: 'assistant', id: 'as99' },
        { kind: 'info', id: 'quit1' },
      ],
      true,
    );
    events.emit('frame');
    expect(output.match(/^assistant: The actual reply$/gm)).toHaveLength(1);
    expect(output).toContain('info: Agent powering down. Goodbye!');
    events.emit('frame');
    expect(output.match(/^assistant: The actual reply$/gm)).toHaveLength(1);
    expect(output.match(/Agent powering down/g)).toHaveLength(1);
  });

  it('keeps a re-mounted session preview out of the permanent scrollback', () => {
    const events = new EventEmitter();
    // The picker mounts a fresh transcript subtree per Space press, so the
    // preview's rows arrive as new instances every time it is re-opened.
    const preview = () => {
      const node = box([text('Session Preview'), text('PREVIEW_BODY')]);
      node.id = 'screen-reader-live-preview';
      return node;
    };
    const dialog = box([preview()]) as Renderable & {
      children: Renderable[];
    };
    dialog.id = 'screen-reader-dialog';
    const root = box([dialog]);
    const writer = new ScreenReaderOutputWriter(() => {});
    const appendStatic = vi.spyOn(writer, 'appendStatic');
    const updateDynamic = vi.spyOn(writer, 'updateDynamic');
    const presentation = new ScreenReaderPresentation(writer);
    presentation.observeFrames(events, () => root);
    events.emit('frame');
    expect(appendStatic.mock.calls.map(([value]) => value)).toEqual(['Dialog']);
    expect(updateDynamic).toHaveBeenLastCalledWith(
      'Session Preview\nPREVIEW_BODY',
    );
    dialog.children = [];
    events.emit('frame');
    dialog.children = [preview()];
    events.emit('frame');
    expect(appendStatic.mock.calls.map(([value]) => value)).toEqual(['Dialog']);
  });
});
