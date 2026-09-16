/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI /hooks dialog: the view helpers (event summaries, matcher groups,
 * banner, detail fields) and the drill-down through the dialog's keyboard
 * handlers. The native renderer is faked the same way as
 * dialogs-extensions.test.tsx: box/text render as div/span and every
 * useKeyboard consumer receives each key.
 */

import { formatHookTimeout } from '../components/hooks/hook-timeout-label.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => {
  const state = {
    keyboardHandlers: [] as Array<(key: unknown) => void>,
  };
  async function buildJsxRuntime() {
    const React = await import('react');
    const jsx = (
      type: unknown,
      props: { children?: unknown; key?: React.Key } | null,
      key?: React.Key,
    ) => {
      const config = key === undefined ? props : { ...props, key };
      const children = (config?.children ?? null) as React.ReactNode;
      if (type === 'box' || type === 'text') {
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          key === undefined ? null : { key },
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

vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

vi.mock('@opentui/react', async () => {
  const React = await import('react');
  return {
    useKeyboard: (handler: (key: unknown) => void) => {
      const ref = React.useRef(handler);
      ref.current = handler;
      React.useEffect(() => {
        const fn = (key: unknown) => ref.current(key);
        mocks.state.keyboardHandlers.push(fn);
        return () => {
          const index = mocks.state.keyboardHandlers.indexOf(fn);
          if (index >= 0) mocks.state.keyboardHandlers.splice(index, 1);
        };
      }, []);
    },
    useRenderer: () => ({
      addInputHandler: () => {},
      removeInputHandler: () => {},
    }),
  };
});

vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('./theme.js', () => ({
  C: new Proxy({}, { get: () => '#ffffff' }),
}));

import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { HooksListingRow } from '@qwen-code/qwen-code-core/hooks/hooks-listing.js';
import {
  HookEventName,
  HookType,
  HooksConfigSource,
  type HookConfig,
} from '@qwen-code/qwen-code-core/hooks/types.js';
import type { LoadedSettings } from '../../config/settings.js';
import { DISPLAY_HOOK_EVENTS } from '../components/hooks/constants.js';
import {
  OpenTuiHooksDialog,
  hookDetailFields,
  hooksBannerText,
  openHookEvent,
  previousHooksDialogView,
  selectHookRows,
  summarizeHookEvents,
  summarizeHookMatchers,
} from './dialogs-hooks.js';

function row(
  overrides: Partial<HooksListingRow> & { config?: HookConfig } = {},
): HooksListingRow {
  const config: HookConfig = overrides.config ?? {
    type: HookType.Command,
    command: './lint.sh',
  };
  return {
    eventName: HookEventName.PreToolUse,
    source: HooksConfigSource.User,
    origin: 'registry',
    enabled: true,
    hookType: config.type,
    displayText: './lint.sh',
    commandText: './lint.sh',
    ...overrides,
    config,
  };
}

const settingsWith = (merged: Record<string, unknown> = {}): LoadedSettings =>
  ({ merged }) as unknown as LoadedSettings;

describe('hooks dialog helpers', () => {
  it('summarizes every displayed event with its hook count', () => {
    const summaries = summarizeHookEvents([
      row(),
      row(),
      row({ eventName: HookEventName.Stop }),
    ]);

    expect(summaries.map((summary) => summary.event)).toEqual(
      DISPLAY_HOOK_EVENTS,
    );
    expect(
      summaries.find((summary) => summary.event === HookEventName.PreToolUse)
        ?.count,
    ).toBe(2);
    expect(
      summaries.find((summary) => summary.event === HookEventName.Stop)?.count,
    ).toBe(1);
  });

  it('groups an event by normalized matcher in first-seen order', () => {
    const rows = [
      row({ matcher: 'write_file' }),
      row(),
      row({ matcher: '  write_file ' }),
      row({ eventName: HookEventName.Stop }),
    ];

    expect(summarizeHookMatchers(rows, HookEventName.PreToolUse)).toEqual([
      { matcher: 'write_file', count: 2 },
      { matcher: '*', count: 1 },
    ]);
    expect(selectHookRows(rows, HookEventName.PreToolUse, '*')).toEqual([
      rows[1],
    ]);
    expect(selectHookRows(rows, HookEventName.Stop)).toEqual([rows[3]]);
  });

  it('skips the matcher step for events without matcher support', () => {
    expect(openHookEvent(HookEventName.PreToolUse)).toEqual({
      step: 'matchers',
      event: HookEventName.PreToolUse,
    });
    expect(openHookEvent(HookEventName.Stop)).toEqual({
      step: 'handlers',
      event: HookEventName.Stop,
    });
  });

  it('walks back one step at a time and closes from the event list', () => {
    const detail = {
      step: 'detail' as const,
      event: HookEventName.PreToolUse,
      matcher: '*',
      index: 0,
    };
    const handlers = previousHooksDialogView(detail);
    expect(handlers).toEqual({
      step: 'handlers',
      event: HookEventName.PreToolUse,
      matcher: '*',
    });
    const matchers = previousHooksDialogView(handlers!);
    expect(matchers).toEqual({
      step: 'matchers',
      event: HookEventName.PreToolUse,
    });
    expect(previousHooksDialogView(matchers!)).toEqual({ step: 'events' });
    expect(previousHooksDialogView({ step: 'events' })).toBeUndefined();
    expect(
      previousHooksDialogView({
        step: 'handlers',
        event: HookEventName.Stop,
      }),
    ).toEqual({ step: 'events' });
  });

  it('names the mode that turned hooks off, safe mode first', () => {
    const base = {
      rows: [],
      allDisabled: true,
      safeMode: false,
      bareMode: false,
    };
    expect(hooksBannerText({ ...base, safeMode: true, bareMode: true })).toBe(
      'Safe mode is on, so no hooks run in this session.',
    );
    expect(hooksBannerText({ ...base, bareMode: true })).toBe(
      'Bare mode is on, so no hooks run in this session.',
    );
    expect(hooksBannerText(base)).toBe(
      'All hooks are disabled by the disableAllHooks setting.',
    );
    expect(hooksBannerText({ ...base, allDisabled: false })).toBeUndefined();
  });

  it('shows timeouts in the unit each hook type reads them in', () => {
    expect(formatHookTimeout(row({ timeout: 10 }))).toBe('10 s');
    expect(formatHookTimeout(row({ timeout: 5000 }))).toBe('5000 ms');
    expect(
      formatHookTimeout(
        row({
          hookType: HookType.Http,
          timeout: 5000,
          config: { type: HookType.Http, url: 'https://h' },
        }),
      ),
    ).toBe('5000 s');
    expect(
      formatHookTimeout(
        row({
          hookType: HookType.Function,
          timeout: 50,
          config: {
            type: HookType.Function,
            callback: async () => undefined,
            errorMessage: 'x',
          },
        }),
      ),
    ).toBe('50 ms');
  });

  it('lists the matcher only for events that support one', () => {
    const toolFields = new Map(hookDetailFields(row({ matcher: 'Bash' })));
    expect(toolFields.get('Matcher:')).toBe('Bash');

    const stopFields = new Map(
      hookDetailFields(
        row({
          eventName: HookEventName.Stop,
          enabled: false,
          runsInBackground: true,
          sequential: true,
          statusMessage: 'Checking…',
          skillRoot: '/skills/review',
        }),
      ),
    );
    expect(stopFields.has('Matcher:')).toBe(false);
    expect(stopFields.get('Status:')).toBe('disabled');
    expect(stopFields.get('Options:')).toBe('runs in background, sequential');
    expect(stopFields.get('Status message:')).toBe('Checking…');
    expect(stopFields.get('Skill:')).toBe('/skills/review');
    expect(stopFields.get('Command:')).toBe('./lint.sh');
  });
});

function baseKeyEvent(overrides: Record<string, unknown> = {}) {
  return {
    name: 'a',
    sequence: 'a',
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    hyper: false,
    eventType: 'press',
    preventDefault: () => {},
    stopPropagation: () => {},
    ...overrides,
  };
}

async function press(name: string): Promise<void> {
  await act(async () => {
    for (const handler of [...mocks.state.keyboardHandlers]) {
      handler(baseKeyEvent({ name, sequence: name }));
    }
  });
}

function configWith(options: {
  entries?: Array<{
    config: HookConfig;
    eventName: HookEventName;
    matcher?: string;
    enabled?: boolean;
  }>;
  disableAll?: boolean;
}): Config {
  const hookSystem = {
    getAllHooks: () =>
      (options.entries ?? []).map((entry) => ({
        source: HooksConfigSource.User,
        enabled: true,
        ...entry,
      })),
    getSessionHooksManager: () => ({ getAllSessionHooks: () => [] }),
  };
  return {
    getHookSystem: () => hookSystem,
    getDisableAllHooks: () => options.disableAll ?? false,
    isSafeMode: () => false,
    getBareMode: () => false,
    getSessionId: () => 'session-1',
  } as unknown as Config;
}

describe('OpenTuiHooksDialog', () => {
  beforeEach(() => {
    mocks.state.keyboardHandlers.length = 0;
  });

  it('drills from an event through its matcher to a hook and back out', async () => {
    const onClose = vi.fn();
    render(
      <OpenTuiHooksDialog
        config={configWith({
          entries: [
            {
              eventName: HookEventName.PreToolUse,
              matcher: 'run_shell_command',
              config: {
                type: HookType.Command,
                command: './guard.sh',
                timeout: 10,
              },
            },
          ],
        })}
        settings={settingsWith()}
        onClose={onClose}
      />,
    );

    expect(screen.getByText('PreToolUse')).toBeTruthy();
    expect(screen.getByText(/^\s*\(1\)$/)).toBeTruthy();

    await press('return');
    expect(screen.getByText('PreToolUse - Matchers')).toBeTruthy();
    expect(screen.getByText('run_shell_command')).toBeTruthy();

    await press('return');
    expect(screen.getByText('[command] ./guard.sh')).toBeTruthy();

    await press('return');
    expect(screen.getByText('Hook details')).toBeTruthy();
    expect(screen.getByText('10 s')).toBeTruthy();

    await press('escape');
    expect(screen.getByText('[command] ./guard.sh')).toBeTruthy();
    await press('escape');
    expect(screen.getByText('PreToolUse - Matchers')).toBeTruthy();
    await press('escape');
    expect(screen.getByText(/^\s*\(1\)$/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    await press('escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens a hook list straight away for an event without matchers', async () => {
    render(
      <OpenTuiHooksDialog
        config={configWith({
          entries: [
            {
              eventName: HookEventName.Stop,
              config: { type: HookType.Command, command: './verify.sh' },
            },
          ],
        })}
        settings={settingsWith()}
        onClose={vi.fn()}
      />,
    );

    const stopIndex = DISPLAY_HOOK_EVENTS.indexOf(HookEventName.Stop);
    for (let i = 0; i < stopIndex; i++) await press('down');
    await press('return');

    expect(screen.queryByText('Stop - Matchers')).toBeNull();
    expect(screen.getByText('[command] ./verify.sh')).toBeTruthy();
  });

  it('says so when an event has no hooks', async () => {
    render(
      <OpenTuiHooksDialog
        config={configWith({})}
        settings={settingsWith()}
        onClose={vi.fn()}
      />,
    );

    await press('return');

    expect(
      screen.getByText('No hooks configured for this event.'),
    ).toBeTruthy();
  });

  it('shows the disabled banner and a caller notice', () => {
    render(
      <OpenTuiHooksDialog
        config={configWith({ disableAll: true })}
        settings={settingsWith()}
        onClose={vi.fn()}
        notice="Hook registry reloaded."
      />,
    );

    expect(
      screen.getByText(
        'All hooks are disabled by the disableAllHooks setting.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Hook registry reloaded.')).toBeTruthy();
  });

  it('falls back to the settings switch when there is no config', () => {
    render(
      <OpenTuiHooksDialog
        settings={settingsWith({ disableAllHooks: true })}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        'All hooks are disabled by the disableAllHooks setting.',
      ),
    ).toBeTruthy();
  });
});
