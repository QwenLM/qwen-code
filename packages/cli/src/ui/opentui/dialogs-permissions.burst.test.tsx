/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Burst safety of the two free-text fields in `/permissions`. The renderer
 * hands every key of one stdin read to the handler the last render registered,
 * so a pasted path followed by Enter used to submit the buffer as it stood
 * before the paste — i.e. nothing — and the dialog stayed put.
 */

import { act, render, screen } from '@testing-library/react';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingScope } from '../../config/settings.js';

interface RawKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  option?: boolean;
  super?: boolean;
  shift?: boolean;
  paste?: boolean;
}

const mocks = vi.hoisted(() => {
  const state = {
    keyboardHandlers: [] as Array<(key: RawKey) => void>,
    pasteHandlers: [] as Array<
      (event: { bytes: Uint8Array; preventDefault: () => void }) => void
    >,
    width: 100,
  };
  async function buildJsxRuntime() {
    const React = await import('react');
    const jsx = (
      type: unknown,
      props: { children?: unknown } | null,
      key?: React.Key,
    ) => {
      const config = key === undefined ? props : { ...props, key };
      const children = (config?.children ?? null) as React.ReactNode;
      if (type === 'box' || type === 'text') {
        // Keep the layout primitives as an attribute so a frame's declared
        // geometry is readable without booting the native renderer.
        const captured = JSON.stringify(
          Object.fromEntries(
            Object.entries(config ?? {}).filter(
              ([k, v]) =>
                k !== 'children' &&
                (typeof v === 'string' ||
                  typeof v === 'number' ||
                  typeof v === 'boolean'),
            ),
          ),
        );
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          {
            ...(key === undefined ? {} : { key }),
            'data-p': captured,
          },
          children,
        );
      }
      return React.createElement(
        type as React.ElementType,
        config as Record<string, unknown>,
        children,
      );
    };
    return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
  }
  return { state, buildJsxRuntime };
});

vi.mock('@opentui/react', async () => {
  const React = await import('react');
  return {
    useAppContext: (
      await import('../../test-utils/opentui-catalog.js')
    ).catalogAppContext(mocks.state.keyboardHandlers),
    useKeyboard: (handler: (key: RawKey) => void) => {
      const latest = React.useRef(handler);
      latest.current = handler;
      const stable = React.useRef<((key: RawKey) => void) | undefined>(
        undefined,
      );
      if (!stable.current) {
        stable.current = (key: RawKey) =>
          latest.current({ ...key, sequence: key.sequence ?? '' });
        mocks.state.keyboardHandlers.push(stable.current);
      }
    },
    usePaste: (
      handler: (event: {
        bytes: Uint8Array;
        preventDefault: () => void;
      }) => void,
    ) => {
      const latest = React.useRef(handler);
      latest.current = handler;
      React.useEffect(() => {
        const fn = (event: { bytes: Uint8Array; preventDefault: () => void }) =>
          latest.current(event);
        mocks.state.pasteHandlers.push(fn);
        return () => {
          const index = mocks.state.pasteHandlers.indexOf(fn);
          if (index >= 0) mocks.state.pasteHandlers.splice(index, 1);
        };
      }, []);
    },
    useTerminalDimensions: () => ({ width: mocks.state.width, height: 40 }),
  };
});
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
  decodePasteBytes: (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8'),
}));
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('./key-map.js', () => ({
  toOriginalKey: (key: RawKey) => ({
    name: key.name ?? '',
    ctrl: !!key.ctrl,
    meta: !!(key.meta || key.option || key.super),
    shift: !!key.shift,
    paste: !!key.paste,
    sequence: key.sequence ?? '',
  }),
}));

import { OpenTuiPermissionsDialog } from './dialogs-permissions.js';
import { getCachedStringWidth } from '../utils/textUtils.js';

/** The layout primitives the jsx mock captured on the element. */
function layoutOf(node: Element | null): Record<string, unknown> {
  return JSON.parse(node?.getAttribute('data-p') ?? '{}') as Record<
    string,
    unknown
  >;
}

/** One stdin read: every key hits the same handler closure, no render between. */
function burst(keys: RawKey[]) {
  if (mocks.state.keyboardHandlers.length === 0) {
    throw new Error('no keyboard handler registered');
  }
  act(() => {
    for (const key of keys) {
      for (const handler of [...mocks.state.keyboardHandlers]) {
        handler({ ...key });
      }
    }
  });
}

/** One key per stdin read, which is what a slow typist produces. */
function press(key: RawKey) {
  burst([key]);
}

function text(char: string): RawKey {
  return { name: char, sequence: char };
}

const ENTER: RawKey = { name: 'return', sequence: '\r' };
const TAB: RawKey = { name: 'tab', sequence: '\t' };

function renderDialog(availableTerminalHeight?: number) {
  const onAddRule = vi.fn();
  const onAddDirectory = vi.fn();
  render(
    <OpenTuiPermissionsDialog
      availableTerminalHeight={availableTerminalHeight}
      rules={[]}
      directories={[]}
      initialDirectories={[]}
      onAddRule={onAddRule}
      onDeleteRule={vi.fn()}
      onAddDirectory={onAddDirectory}
      onRemoveDirectory={vi.fn()}
      onExit={vi.fn()}
    />,
  );
  return { onAddRule, onAddDirectory };
}

/** Open the rule form on the Allow tab: 'Add a new rule…' is the first row. */
function openRuleInput() {
  press(ENTER);
  expect(screen.getByText('Enter permission rule…')).toBeTruthy();
}

/** Open the directory form: Workspace is the fourth tab, its first row adds. */
function openDirInput() {
  press(TAB);
  press(TAB);
  press(TAB);
  press(ENTER);
  expect(screen.getByText('Enter directory path…')).toBeTruthy();
}

beforeEach(() => {
  mocks.state.keyboardHandlers.length = 0;
  mocks.state.pasteHandlers.length = 0;
  mocks.state.width = 100;
  document.body.innerHTML = '';
});

describe('OpenTuiPermissionsDialog region budget', () => {
  it('windows the rule list to the region, so Enter only commits a painted row', () => {
    // Region nineteen pays the rule view's chrome — tab bar 1, description
    // and margin 2, search box and margin 4, spacer 1, footer hint 2 — and
    // leaves the list nine rows, not the constant fifteen whose tail the
    // region's clip took while the keys kept committing the clipped rows.
    const rules = Array.from({ length: 20 }, (_, i) => ({
      raw: `WebFetch(domain-${i}.example.com)`,
      toolName: 'WebFetch',
      type: 'allow' as const,
      scope: 'user',
    }));
    render(
      <OpenTuiPermissionsDialog
        rules={rules}
        directories={[]}
        initialDirectories={[]}
        onAddRule={vi.fn()}
        onDeleteRule={vi.fn()}
        onAddDirectory={vi.fn()}
        onRemoveDirectory={vi.fn()}
        onExit={vi.fn()}
        availableTerminalHeight={19}
      />,
    );

    // The window is the nine rows the region pays for: 'Add a new rule…'
    // plus the first eight rules; the ninth rule does not paint.
    expect(screen.getByText('WebFetch(domain-7.example.com)')).toBeTruthy();
    expect(screen.queryByText('WebFetch(domain-8.example.com)')).toBeNull();

    // Eight downs land on the window's last painted row, and Enter commits
    // exactly that rule's confirmation.
    for (let i = 0; i < 8; i++) press({ name: 'down' });
    press(ENTER);
    expect(screen.getByText('Delete allow rule?')).toBeTruthy();
    expect(
      screen.getAllByText('WebFetch(domain-7.example.com)').length,
    ).toBeGreaterThan(0);
  });
});

describe('OpenTuiPermissionsDialog charged runs', () => {
  it('lays the search box out as the one content row the chrome charge pays for', () => {
    // The budget charges the search box four rows — margin, two borders, one
    // content row. Stacked, its two texts would paint five rows, and the rule
    // list's last windowed row would be one the region never paid for.
    renderDialog();
    const placeholder = screen.getByText('Search…');
    expect(layoutOf(placeholder.parentElement)).toMatchObject({
      flexDirection: 'row',
      borderStyle: 'rounded',
    });
  });

  it('charges the workspace description the rows it wraps into', () => {
    // The workspace tab's description is 87 columns — two rows at 80 — and
    // the flat one-row charge used to hand the directory list a row the
    // region never paid for: the window is one row smaller now.
    mocks.state.width = 80;
    const dirs = Array.from({ length: 10 }, (_, i) => `/ws/dir-${i}`);
    render(
      <OpenTuiPermissionsDialog
        rules={[]}
        directories={dirs.slice(2)}
        initialDirectories={dirs.slice(0, 2)}
        onAddRule={vi.fn()}
        onDeleteRule={vi.fn()}
        onAddDirectory={vi.fn()}
        onRemoveDirectory={vi.fn()}
        onExit={vi.fn()}
        availableTerminalHeight={15}
      />,
    );
    press(TAB);
    press(TAB);
    press(TAB);

    // 15 - 4 chrome - 2 description rows - 2 initial-directory rows = 7:
    // 'Add directory…' plus six directories paint, the seventh does not.
    expect(screen.getByText('/ws/dir-7')).toBeTruthy();
    expect(screen.queryByText('/ws/dir-8')).toBeNull();
  });

  it('clips a rule row to the width the window charges for it', () => {
    // A rule raw wider than the row wraps into a second physical row the
    // window charged as one; ink truncates the label, and so does the port.
    mocks.state.width = 80;
    const longRule = `WebFetch(domain:${'a'.repeat(70)})`;
    render(
      <OpenTuiPermissionsDialog
        rules={[
          {
            raw: longRule,
            toolName: 'WebFetch',
            type: 'allow' as const,
            scope: 'user',
          },
        ]}
        directories={[]}
        initialDirectories={[]}
        onAddRule={vi.fn()}
        onDeleteRule={vi.fn()}
        onAddDirectory={vi.fn()}
        onRemoveDirectory={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    const row = screen.getByText(/^WebFetch\(domain:/);
    // Area width 76, minus the `›` box (2) and the one-digit number box (3).
    expect(getCachedStringWidth(row.textContent ?? '')).toBeLessThanOrEqual(71);
    expect(row.textContent).toMatch(/…$/);
  });
});

describe('OpenTuiPermissionsDialog text-field bursts', () => {
  it('submits the rule a burst typed in, not the empty buffer it started from', () => {
    const { onAddRule } = renderDialog();
    openRuleInput();

    burst([...'WebFetch'.split('').map(text), ENTER]);

    expect(screen.queryByText('Enter permission rule…')).toBeNull();
    expect(screen.getByText('Where should this rule be saved?')).toBeTruthy();
    // The scope step then reports the whole burst as the rule text.
    press(ENTER);
    expect(onAddRule).toHaveBeenCalledWith(
      'WebFetch',
      'allow',
      SettingScope.Workspace,
    );
  });

  it('edits inside a burst: a trailing character and its backspace cancel out', () => {
    const { onAddRule } = renderDialog();
    openRuleInput();

    burst([...'WebFetchx'.split('').map(text), { name: 'backspace' }, ENTER]);

    expect(screen.getByText('Where should this rule be saved?')).toBeTruthy();
    press(ENTER);
    expect(onAddRule).toHaveBeenCalledWith(
      'WebFetch',
      'allow',
      SettingScope.Workspace,
    );
  });

  it('validates the whole pasted path, not the empty buffer', () => {
    const { onAddDirectory } = renderDialog();
    openDirInput();

    burst([text('.'), ENTER]);

    expect(onAddDirectory).toHaveBeenCalledTimes(1);
    expect(onAddDirectory).toHaveBeenCalledWith(
      fs.realpathSync(nodePath.resolve('.')),
    );
    expect(screen.queryByText('Enter directory path…')).toBeNull();
  });
});

function readWithTrailingPaste(keys: RawKey[], value: string) {
  act(() => {
    for (const key of keys)
      for (const handler of [...mocks.state.keyboardHandlers]) handler(key);
    for (const handler of [...mocks.state.pasteHandlers]) {
      handler({ bytes: Buffer.from(value), preventDefault: vi.fn() });
    }
  });
}

describe('Permissions field ownership across reads', () => {
  it('keeps a submitted rule unchanged by trailing keys and paste in the same read', () => {
    const { onAddRule } = renderDialog();
    openRuleInput();
    readWithTrailingPaste(
      [...'WebFetch'.split('').map(text), ENTER, text('X')],
      'PASTE',
    );
    expect(screen.getByText('Where should this rule be saved?')).toBeTruthy();
    expect(onAddRule).not.toHaveBeenCalled();
    press(ENTER);
    expect(onAddRule).toHaveBeenCalledExactlyOnceWith(
      'WebFetch',
      'allow',
      SettingScope.Workspace,
    );
  });

  it('does not reopen or edit a cancelled form from trailing input in one read', () => {
    const { onAddRule } = renderDialog();
    openRuleInput();
    readWithTrailingPaste([{ name: 'escape' }, ENTER, text('X')], 'PASTE');
    expect(screen.queryByText('Where should this rule be saved?')).toBeNull();
    expect(screen.queryByText('Enter permission rule…')).toBeNull();
    expect(onAddRule).not.toHaveBeenCalled();
    press(ENTER);
    expect(screen.getByText('Enter permission rule…')).toBeTruthy();
  });

  it('does not submit the old path when Tab and Enter share a read', () => {
    const parent = fs.mkdtempSync(nodePath.join(tmpdir(), 'permission-tab-'));
    fs.mkdirSync(nodePath.join(parent, 'alpha'));
    try {
      const { onAddDirectory } = renderDialog();
      openDirInput();
      burst((parent + '/').split('').map(text));
      expect(screen.getByText(/^alpha\/\s+directory$/)).toBeTruthy();
      burst([TAB, ENTER]);
      expect(onAddDirectory).not.toHaveBeenCalled();
      expect(screen.getByText('Add directory to workspace')).toBeTruthy();
      press(ENTER);
      expect(onAddDirectory).toHaveBeenCalledExactlyOnceWith(
        fs.realpathSync(nodePath.join(parent, 'alpha')),
      );
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('keeps an invalid rule editable so it can be repaired', () => {
    const { onAddRule } = renderDialog();
    openRuleInput();
    readWithTrailingPaste([], 'Bash(');
    press(ENTER);
    expect(
      screen.getByText(/Malformed rule: unbalanced parentheses/),
    ).toBeTruthy();
    expect(onAddRule).not.toHaveBeenCalled();
    burst([...'ls)'.split('').map(text), ENTER]);
    expect(screen.getByText('Bash(ls)')).toBeTruthy();
    press(ENTER);
    expect(onAddRule).toHaveBeenCalledExactlyOnceWith(
      'Bash(ls)',
      'allow',
      SettingScope.Workspace,
    );
  });

  it('clears a prior directory error when Tab accepts a real completion', () => {
    const parent = fs.mkdtempSync(
      nodePath.join(tmpdir(), 'permission-error-tab-'),
    );
    fs.mkdirSync(nodePath.join(parent, 'alpha'));
    try {
      const { onAddDirectory } = renderDialog();
      openDirInput();
      burst([...(parent + '/alph').split('').map(text), ENTER]);
      expect(screen.getByText('Directory does not exist.')).toBeTruthy();
      expect(screen.getByText(/^alpha\/\s+directory$/)).toBeTruthy();
      burst([TAB, ENTER]);
      expect(screen.queryByText('Directory does not exist.')).toBeNull();
      expect(onAddDirectory).not.toHaveBeenCalled();
      press(ENTER);
      expect(onAddDirectory).toHaveBeenCalledExactlyOnceWith(
        fs.realpathSync(nodePath.join(parent, 'alpha')),
      );
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('keeps an invalid directory editable so it can be repaired', () => {
    const parent = fs.mkdtempSync(
      nodePath.join(tmpdir(), 'permission-repair-'),
    );
    try {
      const { onAddDirectory } = renderDialog();
      openDirInput();
      burst([...(parent + '-missing').split('').map(text), ENTER]);
      expect(onAddDirectory).not.toHaveBeenCalled();
      expect(screen.getByText('Add directory to workspace')).toBeTruthy();
      burst([
        { name: 'a', ctrl: true },
        { name: 'k', ctrl: true },
        ...parent.split('').map(text),
        ENTER,
      ]);
      expect(onAddDirectory).toHaveBeenCalledExactlyOnceWith(
        fs.realpathSync(parent),
      );
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('does not Tab-select a candidate hidden by the region height', () => {
    const parent = fs.mkdtempSync(
      nodePath.join(tmpdir(), 'permission-height-'),
    );
    fs.mkdirSync(nodePath.join(parent, 'alpha'));
    try {
      const { onAddDirectory } = renderDialog(12);
      openDirInput();
      burst((parent + '/').split('').map(text));
      expect(screen.queryByText(/^alpha\/\s+directory$/)).toBeNull();
      press({ name: 'down' });
      press(TAB);
      press(ENTER);
      // Explicit Enter still adds the typed parent; it must not select hidden alpha.
      expect(onAddDirectory).toHaveBeenCalledExactlyOnceWith(
        fs.realpathSync(parent),
      );
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('Permissions input resize ownership', () => {
  it('ignores hidden directory input and restores its accepted value when widened', () => {
    const parent = fs.mkdtempSync(
      nodePath.join(tmpdir(), 'permission-narrow-'),
    );
    fs.mkdirSync(nodePath.join(parent, 'alpha'));
    try {
      mocks.state.width = 100;
      const onAddDirectory = vi.fn();
      const props = {
        rules: [],
        directories: [],
        initialDirectories: [],
        onAddRule: vi.fn(),
        onDeleteRule: vi.fn(),
        onAddDirectory,
        onRemoveDirectory: vi.fn(),
        onExit: vi.fn(),
      };
      const view = render(<OpenTuiPermissionsDialog {...props} />);
      openDirInput();
      burst((parent + '/').split('').map(text));
      expect(view.container.textContent).toContain(nodePath.basename(parent));
      expect(screen.getByText(/^alpha\/\s+directory$/)).toBeTruthy();
      mocks.state.width = 4;
      view.rerender(<OpenTuiPermissionsDialog {...props} />);
      expect(view.container.textContent).not.toContain(
        nodePath.basename(parent),
      );
      expect(screen.queryByText(/^alpha\/\s+directory$/)).toBeNull();
      readWithTrailingPaste(
        [{ name: 'down' }, TAB, ENTER, ...'TAINT'.split('').map(text)],
        'PASTE_TAINT',
      );
      expect(onAddDirectory).not.toHaveBeenCalled();
      mocks.state.width = 100;
      view.rerender(<OpenTuiPermissionsDialog {...props} />);
      expect(view.container.textContent).toContain(nodePath.basename(parent));
      expect(view.container.textContent).not.toContain('TAINT');
      press(ENTER);
      expect(onAddDirectory).toHaveBeenCalledExactlyOnceWith(
        fs.realpathSync(parent),
      );
    } finally {
      mocks.state.width = 100;
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

it('keeps directory editing and Escape available after its save callback throws', () => {
  const parent = fs.mkdtempSync(
    nodePath.join(tmpdir(), 'permission-save-error-'),
  );
  fs.mkdirSync(nodePath.join(parent, 'alpha'));
  try {
    const { onAddDirectory } = renderDialog();
    const error = new Error('owned directory save failure');
    onAddDirectory.mockImplementation(() => {
      throw error;
    });
    openDirInput();
    burst(parent.split('').map(text));
    expect(() => press(ENTER)).toThrow(error);
    expect(onAddDirectory).toHaveBeenNthCalledWith(1, fs.realpathSync(parent));
    expect(screen.getByText('Enter the path to the directory:')).toBeTruthy();
    burst('/alpha'.split('').map(text));
    expect(() => press(ENTER)).toThrow(error);
    expect(onAddDirectory).toHaveBeenCalledTimes(2);
    expect(onAddDirectory).toHaveBeenNthCalledWith(
      2,
      fs.realpathSync(nodePath.join(parent, 'alpha')),
    );
    press({ name: 'escape', sequence: '\x1b' });
    expect(screen.queryByText('Enter the path to the directory:')).toBeNull();
    expect(screen.getByText('Add directory…')).toBeTruthy();
    expect(onAddDirectory).toHaveBeenCalledTimes(2);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

describe('Permissions TextInput Ctrl+C ownership', () => {
  it('submits only replacement rule text after a same-read clear', () => {
    const { onAddRule } = renderDialog();
    openRuleInput();
    burst([
      ...'WebFetch'.split('').map(text),
      { name: 'c', ctrl: true, sequence: '\x03' },
      ...'Read'.split('').map(text),
      ENTER,
    ]);
    press(ENTER);
    expect(onAddRule).toHaveBeenCalledExactlyOnceWith(
      'Read',
      'allow',
      SettingScope.Workspace,
    );
  });

  it('undoes a clear as one edit before a same-read submit', () => {
    const { onAddRule } = renderDialog();
    openRuleInput();
    burst([
      ...'WebFetch'.split('').map(text),
      { name: 'c', ctrl: true, sequence: '\x03' },
      { name: 'z', ctrl: true, sequence: '\x1a' },
      ENTER,
    ]);
    press(ENTER);
    expect(onAddRule).toHaveBeenCalledExactlyOnceWith(
      'WebFetch',
      'allow',
      SettingScope.Workspace,
    );
  });

  it('validates the replacement directory after a same-read clear', () => {
    const { onAddDirectory } = renderDialog();
    openDirInput();
    burst([
      ...'definitely-missing-directory'.split('').map(text),
      { name: 'c', ctrl: true, sequence: '\x03' },
      text('.'),
      ENTER,
    ]);
    expect(onAddDirectory).toHaveBeenCalledExactlyOnceWith(
      fs.realpathSync(nodePath.resolve('.')),
    );
  });
});

it('witnesses accepted, empty and settled rule paste consumption', () => {
  const { onAddRule } = renderDialog();
  openRuleInput();
  const emit = (value: string) => {
    const event = { bytes: Buffer.from(value), preventDefault: vi.fn() };
    act(() => {
      for (const handler of [...mocks.state.pasteHandlers]) handler(event);
    });
    return event;
  };
  expect(emit('').preventDefault).not.toHaveBeenCalled();
  expect(emit('WebFetch').preventDefault).toHaveBeenCalledTimes(1);
  press(ENTER);
  expect(emit('TAIL').preventDefault).not.toHaveBeenCalled();
  press(ENTER);
  expect(onAddRule).toHaveBeenCalledExactlyOnceWith(
    'WebFetch',
    'allow',
    SettingScope.Workspace,
  );
});
