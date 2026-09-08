import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import ts from 'typescript';
import * as geometry from '../subagents-position.ts';
import type { SubagentsSnapshot } from '@qwen-code/qwen-live/subagents';
import type { SubagentsWindowState } from '../../shared/subagents-api.ts';

const snapshot: SubagentsSnapshot = {
  revision: 1,
  counts: {
    running: 1,
    completed: 0,
    needsAttention: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
  },
  omitted: 0,
  tasks: [
    {
      id: 'harness:1',
      kind: 'harness',
      title: 'Task',
      status: 'running',
      request: 'User request',
      createdAt: 1,
      updatedAt: 1,
      activity: 'Running tests',
      output: 'output',
      events: [],
    },
  ],
};
function fixture(
  hoverRegions?: Array<{ x: number; y: number; width: number; height: number }>,
) {
  type Handler = (...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const windows: Window[] = [];
  const events: Array<{ action: string; window?: Window }> = [];
  let now = 10_000;
  let cursor = { x: 1800, y: 800 };
  const anchor = { x: 1750, y: 780, width: 156, height: 156 };
  let workArea = { x: 0, y: 30, width: 2048, height: 1028 };
  type Timer = { at: number; callback: () => void; unref: () => void };
  const timers = new Set<Timer>();
  class Window {
    visible = false;
    destroyed = false;
    loading = true;
    focused = 0;
    bounds: { x: number; y: number; width: number; height: number };
    events = new Map<string, Handler>();
    readonly moves: unknown[] = [];
    readonly sent: unknown[] = [];
    readonly backgrounds: string[] = [];
    webContents = {
      isDestroyed: () => this.destroyed,
      isLoadingMainFrame: () => this.loading,
      send: (channel: string, state: unknown) => {
        assert.equal(channel, 'live:subagents:state');
        this.sent.push(state);
        events.push({ action: 'publish', window: this });
      },
      setWindowOpenHandler: () => {},
      on: (name: string, fn: Handler) => this.events.set(name, fn),
    };
    constructor(readonly options: Record<string, unknown>) {
      this.bounds = {
        x: Number(options.x),
        y: Number(options.y),
        width: Number(options.width),
        height: Number(options.height),
      };
      windows.push(this);
      events.push({ action: 'create', window: this });
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setBackgroundColor(color: string) {
      this.backgrounds.push(color);
    }
    on(name: string, fn: Handler) {
      this.events.set(name, fn);
    }
    loadFile() {
      return Promise.resolve();
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    getBounds() {
      return { ...this.bounds };
    }
    setBounds(bounds: Window['bounds']) {
      this.bounds = { ...bounds };
      this.moves.push(bounds);
      events.push({ action: 'place', window: this });
    }
    show() {
      this.visible = true;
      events.push({ action: 'show', window: this });
    }
    showInactive() {
      this.visible = true;
      events.push({ action: 'showInactive', window: this });
    }
    focus() {
      this.focused++;
      events.push({ action: 'focus', window: this });
    }
    hide() {
      this.visible = false;
      events.push({ action: 'hide', window: this });
    }
    close() {
      this.events.get('close')?.();
      this.destroy();
    }
    destroy() {
      this.destroyed = true;
      this.visible = false;
      events.push({ action: 'destroy', window: this });
      this.events.get('closed')?.();
    }
    ready() {
      this.loading = false;
      this.events.get('did-finish-load')?.();
    }
  }
  const tree = ts.createSourceFile(
    'subagents-windows.ts',
    readFileSync(new URL('../subagents-windows.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = tree.statements.find(
    (node) =>
      ts.isClassDeclaration(node) && node.name?.text === 'SubagentsWindows',
  );
  assert(declaration);
  const source = ts.transpileModule(
    declaration.getText(tree).replace('export class', 'class') +
      '\nSubagentsWindows;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const Controller = runInNewContext(source, {
    BrowserWindow: Window,
    ipcMain: {
      handle: (name: string, fn: Handler) => handlers.set(name, fn),
      on: (name: string, fn: Handler) => handlers.set(name, fn),
      removeHandler: (name: string) => handlers.delete(name),
      removeAllListeners: (name: string) => handlers.delete(name),
    },
    screen: {
      getDisplayMatching: () => ({ workArea }),
      getPrimaryDisplay: () => ({ workArea }),
      getCursorScreenPoint: () => ({ ...cursor }),
    },
    ...geometry,
    join: (...values: string[]) => values.join('/'),
    Date: class extends Date {
      static override now() {
        return now;
      }
    },
    setTimeout: (callback: () => void, delay: number) => {
      const timer = { at: now + delay, callback, unref: () => {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer: Timer) => timers.delete(timer),
  }) as new (options: unknown) => {
    update: (
      lang: string,
      connected: boolean,
      snapshot?: SubagentsSnapshot,
      instanceId?: string,
    ) => void;
    setOrbHovered: (value: boolean) => void;
    setOrbKeyboardHeld: (value: boolean) => void;
    setDragging: (value: boolean) => void;
    setBlocked: (value: boolean) => void;
    setTheme: (theme: string, appearance: string) => void;
    dispose: () => void;
    displaysChanged: () => void;
    dismissPeek: () => void;
  };
  const controller = new Controller({
    baseDirectory: '/fixture',
    anchor: () => anchor,
    ...(hoverRegions ? { hoverRegions: () => hoverRegions } : {}),
  });
  const invoke = (
    name: string,
    window: Window | undefined,
    ...args: unknown[]
  ) => handlers.get(name)?.({ sender: window?.webContents ?? {} }, ...args);
  return {
    controller,
    windows,
    invoke,
    events,
    anchor,
    timers,
    state: (window: Window) =>
      invoke('live:subagents:get-state', window) as SubagentsWindowState,
    setCursor: (point: typeof cursor) => {
      cursor = point;
    },
    setWorkArea: (area: typeof workArea) => {
      workArea = area;
    },
    advance: (milliseconds: number) => {
      const end = now + milliseconds;
      for (;;) {
        const next = [...timers].sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > end) break;
        timers.delete(next);
        now = next.at;
        next.callback();
      }
      now = end;
    },
  };
}
describe('Subagents native lifecycle', () => {
  it('does not treat transparent placement padding as a hovered control', () => {
    const f = fixture([{ x: 1800, y: 800, width: 20, height: 20 }]);
    f.controller.update('en', true, snapshot, 'one');
    f.controller.setOrbHovered(true);
    const window = f.windows[0]!;
    window.ready();
    f.advance(2_000);
    assert(window.visible);
    f.setCursor({ x: 1760, y: 790 });
    f.advance(1_100);
    assert.equal(window.visible, false);
    f.controller.dispose();
  });
  it('does not create surfaces for legacy state and never shows after a delayed load is blocked', () => {
    const f = fixture();
    f.controller.update('en', true);
    f.controller.setOrbHovered(true);
    assert.equal(f.windows.length, 0);
    f.controller.update('en', true, snapshot, 'one');
    f.controller.setOrbHovered(true);
    const summary = f.windows[0]!;
    f.controller.setBlocked(true);
    summary.ready();
    assert.equal(summary.visible, false);
    f.controller.dispose();
  });
  it('uses native cursor containment and a 1000 ms backstop even when pointer-leave is lost', () => {
    const f = fixture();
    f.controller.update('en', true, snapshot, 'one');
    f.controller.setOrbHovered(true);
    const summary = f.windows[0]!;
    summary.ready();
    assert(summary.visible);
    f.advance(2_000);
    assert(summary.visible);
    f.setCursor({ x: summary.bounds.x + 20, y: summary.bounds.y + 20 });
    f.invoke('live:subagents:hover', summary, true);
    f.controller.setOrbHovered(false);
    f.advance(2_000);
    assert(summary.visible);
    f.setCursor({ x: 10, y: 10 });
    f.advance(100);
    f.advance(999);
    assert(summary.visible);
    f.advance(1);
    assert.equal(summary.visible, false);
    assert.equal(f.timers.size, 0);
    f.controller.dispose();
  });
  it('resets the outside grace on native re-entry and distinguishes keyboard hold from hover', () => {
    const f = fixture();
    f.controller.update('en', true, snapshot, 'one');
    f.controller.setOrbHovered(true);
    const summary = f.windows[0]!;
    summary.ready();
    f.setCursor({ x: 10, y: 10 });
    f.advance(900);
    f.setCursor({ x: f.anchor.x + 10, y: f.anchor.y + 10 });
    f.advance(100);
    f.setCursor({ x: 10, y: 10 });
    f.advance(1_000);
    assert(summary.visible);
    f.invoke('live:subagents:keyboard', summary, true);
    f.controller.setOrbKeyboardHeld(false);
    f.advance(3_000);
    assert(summary.visible);
    summary.events.get('blur')?.();
    f.advance(1_100);
    assert.equal(summary.visible, false);
    f.controller.setOrbKeyboardHeld(true);
    assert(summary.visible);
    f.advance(3_000);
    assert(summary.visible);
    f.controller.setOrbKeyboardHeld(false);
    f.advance(1_100);
    assert.equal(summary.visible, false);
    f.controller.dispose();
  });
  it('reuses one borderless window for summary, pinned list, detail and back without moving the orb', () => {
    const f = fixture();
    const originalAnchor = { ...f.anchor };
    f.controller.update('en', true, snapshot, 'one');
    f.controller.setOrbHovered(true);
    const window = f.windows[0]!;
    window.ready();
    assert.equal(window.options.frame, false);
    assert.equal(window.options.resizable, false);
    assert.equal(window.bounds.width, 132);
    assert.equal(window.bounds.height, 62);
    const start = f.events.length;
    f.invoke('live:subagents:expand', window);
    assert.equal(f.state(window).mode, 'list');
    assert.equal(window.bounds.width, 330);
    assert.deepEqual(
      f.events.slice(start).map((event) => event.action),
      ['place', 'publish', 'show', 'focus'],
    );
    f.invoke('live:subagents:detail', window, 'harness:1');
    assert.equal(f.windows.length, 1);
    assert.equal(f.state(window).mode, 'detail');
    assert.equal(f.state(window).selectedId, 'harness:1');
    assert.equal(window.bounds.width, 330);
    assert.equal(window.bounds.height, 430);
    assert(window.bounds.x + window.bounds.width < f.anchor.x);
    window.setBounds({ x: 240, y: 150, width: 330, height: 430 });
    const moves = window.moves.length;
    f.controller.update('zh-CN', true, { ...snapshot, revision: 2 }, 'one');
    assert.equal(window.moves.length, moves);
    f.invoke('live:subagents:back', window);
    assert.equal(f.state(window).mode, 'list');
    assert.equal(f.state(window).selectedId, undefined);
    assert.equal(window.bounds.width, 330);
    assert.equal(window.bounds.x, 240);
    assert.equal(window.bounds.y, 150);
    assert.equal(f.windows.length, 1);
    assert.deepEqual(f.anchor, originalAnchor);
    f.controller.dispose();
  });
  it('keeps list and detail pinned through blur, outside cursor, drag, blocked state and disconnect until close', () => {
    const f = fixture();
    f.controller.update('en', true, snapshot, 'one');
    f.controller.setOrbHovered(true);
    const window = f.windows[0]!;
    window.ready();
    for (const mode of ['list', 'detail'] as const) {
      if (mode === 'list') f.invoke('live:subagents:expand', window);
      else f.invoke('live:subagents:detail', window, 'harness:1');
      f.controller.setOrbHovered(false);
      f.invoke('live:subagents:hover', window, false);
      window.events.get('blur')?.();
      f.setCursor({ x: 10, y: 10 });
      f.controller.setDragging(true);
      f.controller.setBlocked(true);
      f.controller.dismissPeek();
      f.controller.update('en', false);
      f.advance(5_000);
      assert(window.visible);
      assert.equal(f.state(window).mode, mode);
      assert.equal(f.state(window).connected, false);
      assert.equal(f.timers.size, 0);
      f.controller.setDragging(false);
      f.controller.setBlocked(false);
      f.controller.update('en', true, snapshot, 'one');
    }
    f.invoke('live:subagents:close', window);
    assert.equal(window.visible, false);
    assert.equal(window.destroyed, false);
    assert.equal(f.state(window).mode, 'summary');
    assert.equal(f.state(window).selectedId, undefined);
    f.controller.update('en', true, { ...snapshot, revision: 3 }, 'one');
    f.advance(5_000);
    assert.equal(window.visible, false);
    f.controller.setOrbHovered(true);
    assert(window.visible);
    assert.equal(window.bounds.width, 132);
    assert.equal(f.windows.length, 1);
    f.controller.dispose();
  });
  it('hides only the unpinned peek for orb drag or display changes and clamps a pinned window', () => {
    const f = fixture();
    f.controller.update('en', true, snapshot, 'one');
    f.controller.setOrbHovered(true);
    const window = f.windows[0]!;
    window.ready();
    f.controller.setDragging(true);
    assert.equal(window.visible, false);
    f.controller.setDragging(false);
    f.advance(2_000);
    assert.equal(window.visible, false);
    f.controller.setOrbHovered(true);
    f.controller.displaysChanged();
    assert.equal(window.visible, false);
    f.controller.setOrbHovered(true);
    f.invoke('live:subagents:expand', window);
    f.setWorkArea({ x: 0, y: 0, width: 800, height: 600 });
    f.controller.displaysChanged();
    assert(window.visible);
    assert(window.bounds.x + window.bounds.width <= 800);
    assert(window.bounds.y + window.bounds.height <= 600);
    f.controller.dispose();
  });
  it('native Escape closes the pinned panel without destroying its reusable window', () => {
    const f = fixture();
    f.controller.update('en', true, snapshot, 'one');
    f.controller.setOrbHovered(true);
    const summary = f.windows[0]!;
    summary.ready();
    f.invoke('live:subagents:detail', summary, 'harness:1');
    let prevented = false;
    summary.events.get('before-input-event')?.(
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      { type: 'keyDown', key: 'Escape' },
    );
    assert(prevented);
    assert.equal(summary.visible, false);
    assert.equal(summary.destroyed, false);
    f.controller.setOrbHovered(true);
    assert(summary.visible);
    assert.equal(f.state(summary).mode, 'summary');
    f.controller.dispose();
  });
  it('updates theme in every mode without moving, resizing or focusing the surface', () => {
    const f = fixture();
    f.controller.update('en', true, snapshot, 'one');
    f.controller.setOrbHovered(true);
    const window = f.windows[0]!;
    window.ready();
    for (const mode of ['summary', 'list', 'detail'] as const) {
      if (mode === 'list') f.invoke('live:subagents:expand', window);
      if (mode === 'detail')
        f.invoke('live:subagents:detail', window, 'harness:1');
      const bounds = { ...window.bounds };
      const start = f.events.length;
      f.controller.setTheme('system', 'light');
      assert.equal(f.state(window).resolvedTheme, 'light');
      assert.equal(window.backgrounds.at(-1), '#f7f7fc');
      f.controller.setTheme('dark', 'dark');
      assert.equal(f.state(window).theme, 'dark');
      assert.equal(f.state(window).resolvedTheme, 'dark');
      assert.equal(window.backgrounds.at(-1), '#1b1b29');
      assert.deepEqual(
        f.events.slice(start).map((event) => event.action),
        ['publish', 'publish'],
      );
      assert.deepEqual(window.bounds, bounds);
    }
    f.controller.dispose();
  });
  it('rejects foreign IPC, invalid ids and clears detail selection when daemon identity changes', () => {
    const f = fixture();
    f.controller.update('en', true, snapshot, 'one');
    f.controller.setOrbHovered(true);
    const summary = f.windows[0]!;
    summary.ready();
    assert.throws(() =>
      f.invoke('live:subagents:detail', undefined, 'harness:1'),
    );
    f.invoke('live:subagents:detail', summary, 'missing');
    f.invoke('live:subagents:detail', summary, 'x'.repeat(129));
    f.invoke('live:subagents:expand', undefined);
    assert.equal(f.state(summary).mode, 'summary');
    assert.throws(() => f.invoke('live:subagents:get-state', undefined));
    assert.equal(f.windows.length, 1);
    f.invoke('live:subagents:detail', summary, 'harness:1');
    assert.equal(f.windows.length, 1);
    f.controller.update('en', false);
    assert.equal(
      (summary.sent.at(-1) as { connected: boolean }).connected,
      false,
    );
    assert.equal(f.state(summary).selectedId, 'harness:1');
    f.invoke('live:subagents:close', undefined);
    assert(summary.visible);
    f.controller.update('en', true, snapshot, 'two');
    assert.equal(
      (summary.sent.at(-1) as { selectedId?: string }).selectedId,
      undefined,
    );
    assert.equal(f.state(summary).mode, 'summary');
    assert.equal(summary.visible, false);
    f.controller.dispose();
    assert(f.windows.every((window) => window.destroyed));
    assert.equal(f.timers.size, 0);
    f.controller.setOrbHovered(true);
    assert.equal(f.windows.length, 1);
    assert.equal(f.invoke('live:subagents:get-state', summary), undefined);
  });
});
