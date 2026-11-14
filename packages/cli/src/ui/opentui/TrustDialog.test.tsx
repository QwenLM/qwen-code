/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, type ReactNode, type Key } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { LoadedSettings } from '../../config/settings.js';
import type { OpenTuiAppHost } from './opentui-host.js';
import { catalogKey } from '../../test-utils/opentui-catalog.js';

const mock = vi.hoisted(() => ({
  keys: [] as Array<(key: unknown) => void>,
  paste: [] as Array<(key: unknown) => void>,
  evaluate: vi.fn(),
  write: vi.fn(),
  load: vi.fn(),
  restart: vi.fn(),
  reveal: vi.fn(),
  scrollBy: vi.fn(),
  requestRender: vi.fn(),
  after: undefined as (() => void) | undefined,
  resized: undefined as (() => void) | undefined,
}));
vi.mock('@opentui/react', async () => {
  const { catalogHooks } = await import('../../test-utils/opentui-catalog.js');
  return catalogHooks(mock.keys, mock.paste, () => ({
    width: 120,
    height: 40,
  }));
});
const buildRuntime = vi.hoisted(() => async () => {
  const React = await import('react');
  const { catalogRuntime } = await import(
    '../../test-utils/opentui-catalog.js'
  );
  const base = catalogRuntime();
  const Scroll = React.forwardRef<
    unknown,
    {
      children?: ReactNode;
      height?: number;
      renderAfter?: () => void;
      onSizeChange?: () => void;
    }
  >((props, ref) => {
    mock.after = props.renderAfter;
    mock.resized = props.onSizeChange;
    React.useImperativeHandle(ref, () => ({
      scrollChildIntoView: mock.reveal,
      scrollBy: mock.scrollBy,
      requestRender: mock.requestRender,
    }));
    return React.createElement(
      'div',
      { 'data-body-rows': props.height },
      props.children,
    );
  });
  Scroll.displayName = 'TrustScroll';
  const jsx = (
    type: unknown,
    props: Record<string, unknown> | null,
    key?: Key,
  ) => base.jsx(type === 'scrollbox' ? Scroll : type, props, key);
  return { ...base, jsx, jsxs: jsx, jsxDEV: jsx };
});
vi.mock('@opentui/react/jsx-runtime', () => buildRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => buildRuntime());
vi.mock(
  '@opentui/core',
  async () =>
    (await import('../../test-utils/opentui-catalog.js')).catalogNativeCore,
);
vi.mock('../../config/trustedFolders.js', () => ({
  TrustLevel: {
    TRUST_FOLDER: 'TRUST_FOLDER',
    TRUST_PARENT: 'TRUST_PARENT',
    DO_NOT_TRUST: 'DO_NOT_TRUST',
  },
  loadTrustedFolders: mock.load,
  isWorkspaceTrusted: mock.evaluate,
}));
vi.mock('../../utils/processUtils.js', () => ({ relaunchApp: mock.restart }));

import { OpenTuiTrustDialog } from './TrustDialog.js';

const cwd = process.cwd();
let session = 'session-a';
let target = `${cwd}/.qwen/settings.json`;
let disk: Record<string, string>;
function fixture() {
  const config = {
    getWorkingDir: () => cwd,
    getSessionId: () => session,
  } as unknown as Config;
  const settings = {
    merged: { security: { folderTrust: { enabled: true } } },
    workspace: {
      get path() {
        return target;
      },
    },
  } as unknown as LoadedSettings;
  const host = {
    config,
    settings,
    addItem: vi.fn(),
  } as unknown as OpenTuiAppHost;
  return { config, settings, host, onClose: vi.fn() };
}
function key(name: string, sequence = '') {
  act(() => {
    for (const handler of [...mock.keys]) handler(catalogKey(name, sequence));
  });
}
function chooseNotTrusted() {
  key('down');
  key('down');
  key('return', '\r');
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.keys.length = 0;
  mock.paste.length = 0;
  session = 'session-a';
  target = `${cwd}/.qwen/settings.json`;
  disk = { [cwd]: 'TRUST_FOLDER', '/unrelated': 'DO_NOT_TRUST' };
  mock.load.mockImplementation(() => ({
    user: { config: disk },
    setValue: mock.write,
  }));
  mock.write.mockImplementation((path: string, value: string) => {
    disk[path] = value;
  });
  mock.evaluate.mockImplementation(
    (_settings: unknown, preview: Record<string, string> | undefined) => ({
      isTrusted: (preview ?? disk)[cwd] !== 'DO_NOT_TRUST',
      source: 'file',
    }),
  );
  mock.restart.mockResolvedValue(undefined);
});

describe('OpenTuiTrustDialog', () => {
  it('renders all three real choices and Escape writes nothing', () => {
    const props = fixture();
    render(<OpenTuiTrustDialog {...props} />);
    for (const label of [
      'Trust this folder',
      'Trust parent folder',
      "Don't trust",
    ])
      expect(screen.getByText(label)).toBeTruthy();
    key('escape', '\x1b');
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(mock.write).not.toHaveBeenCalled();
    expect(mock.restart).not.toHaveBeenCalled();
  });

  it('writes a same-effective parent decision immediately, preserving unrelated rules', () => {
    const props = fixture();
    render(<OpenTuiTrustDialog {...props} />);
    key('down');
    key('return', '\r');
    expect(mock.write).toHaveBeenCalledWith(cwd, 'TRUST_PARENT');
    expect(disk['/unrelated']).toBe('DO_NOT_TRUST');
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(mock.restart).not.toHaveBeenCalled();
    expect(mock.evaluate.mock.calls.every((args) => args[2] === cwd)).toBe(
      true,
    );
  });

  it('defers an effective change and Escape never commits it', () => {
    const props = fixture();
    render(<OpenTuiTrustDialog {...props} />);
    chooseNotTrusted();
    expect(screen.getByText(/Press 'r' to restart CLI now/)).toBeTruthy();
    expect(mock.write).not.toHaveBeenCalled();
    key('escape', '\x1b');
    key('r', 'r');
    expect(mock.write).not.toHaveBeenCalled();
    expect(mock.restart).not.toHaveBeenCalled();
  });

  it('commits once before calling real relaunch entry and ignores more restart keys', () => {
    const props = fixture();
    render(<OpenTuiTrustDialog {...props} />);
    chooseNotTrusted();
    expect(mock.write).not.toHaveBeenCalled();
    key('r', 'r');
    key('r', 'r');
    expect(mock.write).toHaveBeenCalledExactlyOnceWith(cwd, 'DO_NOT_TRUST');
    expect(mock.restart).toHaveBeenCalledTimes(1);
    expect(mock.write.mock.invocationCallOrder[0]).toBeLessThan(
      mock.restart.mock.invocationCallOrder[0],
    );
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('clears an older pending choice even when a superseding immediate write fails', () => {
    const props = fixture();
    render(<OpenTuiTrustDialog {...props} />);
    chooseNotTrusted();
    mock.write.mockImplementation(() => {
      throw new Error('disk full');
    });
    key('up');
    key('return', '\r');
    expect(screen.queryByText(/Press 'r' to restart CLI now/)).toBeNull();
    expect(
      screen.getByText(/Could not update workspace trust: disk full/),
    ).toBeTruthy();
    key('r', 'r');
    expect(mock.write).toHaveBeenCalledTimes(1);
    expect(mock.restart).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('reports deferred commit failure without relaunch or closing', () => {
    const props = fixture();
    render(<OpenTuiTrustDialog {...props} />);
    chooseNotTrusted();
    mock.write.mockImplementation(() => {
      throw new Error('held lock');
    });
    key('r', 'r');
    expect(
      screen.getByText(/Could not update workspace trust: held lock/),
    ).toBeTruthy();
    expect(mock.restart).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it.each(['ide', 'file'])(
    'retains %s inheritance warning and persists without restart when effective trust stays true',
    (source) => {
      disk[cwd] = 'DO_NOT_TRUST';
      mock.evaluate.mockReturnValue({ isTrusted: true, source });
      const props = fixture();
      render(<OpenTuiTrustDialog {...props} />);
      key('return', '\r');
      expect(mock.write).toHaveBeenCalledWith(cwd, 'DO_NOT_TRUST');
      expect(props.host.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'warning',
          text: expect.stringContaining(
            source === 'ide' ? 'connected IDE' : 'parent folder',
          ),
        }),
        expect.any(Number),
      );
      expect(mock.restart).not.toHaveBeenCalled();
    },
  );

  it('uses existing disabled-trust policy result without fabricating restart', () => {
    const props = fixture();
    props.settings.merged.security = { folderTrust: { enabled: false } };
    delete disk[cwd];
    mock.evaluate.mockReturnValue({ isTrusted: true, source: undefined });
    render(<OpenTuiTrustDialog {...props} />);
    expect(
      screen.queryByText(/inherits trust from a parent folder/),
    ).toBeNull();
    chooseNotTrusted();
    expect(mock.write).toHaveBeenCalledWith(cwd, 'DO_NOT_TRUST');
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(mock.restart).not.toHaveBeenCalled();
    expect(props.host.addItem).not.toHaveBeenCalled();
  });

  it('renders a read failure and refuses writes', () => {
    mock.load.mockImplementation(() => {
      throw new Error('invalid file');
    });
    render(<OpenTuiTrustDialog {...fixture()} />);
    expect(screen.getByText(/invalid file/)).toBeTruthy();
    key('return', '\r');
    key('r', 'r');
    expect(mock.write).not.toHaveBeenCalled();
    expect(mock.restart).not.toHaveBeenCalled();
  });

  it.each(['session', 'target'])(
    'permanently cancels a getter-only %s replacement, then allows a fresh render',
    (field) => {
      const props = fixture();
      const view = render(<OpenTuiTrustDialog {...props} />);
      chooseNotTrusted();
      if (field === 'session') session = 'session-b';
      else target = '/other/settings.json';
      key('r', 'r');
      session = 'session-a';
      target = `${cwd}/.qwen/settings.json`;
      key('r', 'r');
      expect(mock.write).not.toHaveBeenCalled();
      expect(mock.restart).not.toHaveBeenCalled();
      view.rerender(<OpenTuiTrustDialog {...props} />);
      chooseNotTrusted();
      key('r', 'r');
      expect(mock.restart).toHaveBeenCalledTimes(1);
    },
  );

  it('old callbacks cannot write or restart after Config replacement or unmount', () => {
    const props = fixture();
    const view = render(<OpenTuiTrustDialog {...props} />);
    chooseNotTrusted();
    const old = [...mock.keys];
    const next = fixture();
    view.rerender(<OpenTuiTrustDialog {...next} />);
    act(() => {
      for (const fn of old) fn(catalogKey('r', 'r'));
    });
    expect(mock.write).not.toHaveBeenCalled();
    const live = [...mock.keys];
    view.unmount();
    act(() => {
      for (const fn of live) fn(catalogKey('return', '\r'));
    });
    expect(mock.write).not.toHaveBeenCalled();
    expect(mock.restart).not.toHaveBeenCalled();
  });

  it('does not restart or close a successor when the synchronous commit notifies an owner change', () => {
    const props = fixture();
    render(<OpenTuiTrustDialog {...props} />);
    chooseNotTrusted();
    mock.write.mockImplementation((path: string, level: string) => {
      disk[path] = level;
      session = 'successor';
    });
    key('r', 'r');
    expect(disk[cwd]).toBe('DO_NOT_TRUST');
    expect(mock.restart).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('invalidates pending trust when the selected settings object changes', () => {
    const props = fixture();
    const view = render(<OpenTuiTrustDialog {...props} />);
    chooseNotTrusted();
    const old = [...mock.keys];
    const replacement = { ...props.settings } as LoadedSettings;
    const host = { ...props.host, settings: replacement } as OpenTuiAppHost;
    view.rerender(
      <OpenTuiTrustDialog {...props} settings={replacement} host={host} />,
    );
    act(() => {
      for (const fn of old) fn(catalogKey('r', 'r'));
    });
    expect(mock.write).not.toHaveBeenCalled();
    expect(mock.restart).not.toHaveBeenCalled();
  });

  it('rejects a mismatched host without falling back to its primary Config', () => {
    const props = fixture();
    const next = fixture();
    render(<OpenTuiTrustDialog {...props} host={next.host} />);
    expect(
      screen.getByText('Workspace trust owner is unavailable.'),
    ).toBeTruthy();
    expect(mock.load).not.toHaveBeenCalled();
    key('r', 'r');
    expect(mock.write).not.toHaveBeenCalled();
  });

  it('does not commit a pending change for another process workspace', () => {
    const props = fixture();
    props.config.getWorkingDir = () => '/';
    disk['/'] = 'TRUST_FOLDER';
    mock.evaluate.mockImplementation(
      (_s: unknown, preview: Record<string, string> | undefined) => ({
        isTrusted: (preview ?? disk)['/'] !== 'DO_NOT_TRUST',
        source: 'file',
      }),
    );
    render(<OpenTuiTrustDialog {...props} />);
    chooseNotTrusted();
    key('r', 'r');
    expect(screen.getByText(/selected workspace cannot restart/)).toBeTruthy();
    expect(mock.write).not.toHaveBeenCalled();
    expect(mock.restart).not.toHaveBeenCalled();
  });

  it('reveals focus only after native render, once per navigation/size, without stealing PageDown', () => {
    const props = fixture();
    const view = render(
      <OpenTuiTrustDialog {...props} availableTerminalHeight={12} />,
    );
    const paint = () =>
      act(() => {
        mock.after?.();
      });
    expect(view.container.querySelector('[data-body-rows="8"]')).toBeTruthy();
    expect(mock.reveal).not.toHaveBeenCalled();
    paint();
    expect(mock.reveal).toHaveBeenLastCalledWith('trust-choice-TRUST_FOLDER');
    mock.reveal.mockClear();
    paint();
    expect(mock.reveal).not.toHaveBeenCalled();
    key('down');
    expect(mock.reveal).not.toHaveBeenCalled();
    paint();
    expect(mock.reveal).toHaveBeenLastCalledWith('trust-choice-TRUST_PARENT');
    key('down');
    paint();
    key('return', '\r');
    expect(mock.reveal).toHaveBeenLastCalledWith('trust-choice-DO_NOT_TRUST');
    mock.reveal.mockClear();
    key('pagedown', '\x1b[6~');
    expect(mock.scrollBy).toHaveBeenLastCalledWith(8);
    view.rerender(
      <OpenTuiTrustDialog {...props} availableTerminalHeight={12} />,
    );
    paint();
    expect(mock.reveal).not.toHaveBeenCalled();
    key('pageup', '\x1b[5~');
    expect(mock.scrollBy).toHaveBeenLastCalledWith(-8);
    act(() => {
      mock.resized?.();
    });
    expect(mock.reveal).not.toHaveBeenCalled();
    paint();
    expect(mock.reveal).toHaveBeenCalledExactlyOnceWith(
      'trust-choice-DO_NOT_TRUST',
    );
    paint();
    expect(mock.reveal).toHaveBeenCalledTimes(1);
    expect(mock.write).not.toHaveBeenCalled();
    expect(mock.restart).not.toHaveBeenCalled();
  });

  it('reports committed truth when relaunch itself rejects', async () => {
    mock.restart.mockRejectedValue(new Error('exec unavailable'));
    render(<OpenTuiTrustDialog {...fixture()} />);
    chooseNotTrusted();
    await act(async () => {
      key('r', 'r');
      await Promise.resolve();
    });
    expect(disk[cwd]).toBe('DO_NOT_TRUST');
    expect(
      screen.getByText(
        /Trust was saved, but the CLI could not restart: exec unavailable/,
      ),
    ).toBeTruthy();
  });
});
