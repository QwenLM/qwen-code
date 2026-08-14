/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { installOpenTuiWindowTitle } from './window-title.js';

function makeSettings(ui: Record<string, unknown> = {}): LoadedSettings {
  return { merged: { ui } } as unknown as LoadedSettings;
}

function makeConfig(targetDir: string): Config {
  return { getTargetDir: () => targetDir } as unknown as Config;
}

describe('installOpenTuiWindowTitle', () => {
  let writeSpy: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    delete process.env['CLI_TITLE'];
    delete process.env['TMUX'];
    delete process.env['STY'];
    delete process.env['ZELLIJ'];
    delete process.env['DVTM'];
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('writes the computed title on install', () => {
    const dispose = installOpenTuiWindowTitle(
      makeSettings(),
      makeConfig('/work/myproj'),
    );
    expect(dispose).not.toBeNull();
    const calls = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(calls).toContain('myproj');
    dispose?.();
  });

  it('clears the title on process exit', () => {
    const dispose = installOpenTuiWindowTitle(
      makeSettings(),
      makeConfig('/work/myproj'),
    );
    writeSpy.mockClear();
    process.emit('exit', 0);
    const calls = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    // Clearing writes an empty-title OSC sequence.
    expect(calls).toContain('\x1b]2;');
    dispose?.();
  });

  it('returns null and writes nothing when the title is hidden', () => {
    const dispose = installOpenTuiWindowTitle(
      makeSettings({ hideWindowTitle: true }),
      makeConfig('/work/myproj'),
    );
    expect(dispose).toBeNull();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('returns null when showStatusInTitle is false', () => {
    const dispose = installOpenTuiWindowTitle(
      makeSettings({ showStatusInTitle: false }),
      makeConfig('/work/myproj'),
    );
    expect(dispose).toBeNull();
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
