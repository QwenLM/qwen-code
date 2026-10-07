/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

/**
 * Fallback-contract tests for the OpenTUI entry (Batch 6): startup must
 * return `false` instead of crashing whenever the OpenTUI boot cannot
 * complete — renderer creation, runtime sidecar I/O, or anything past it —
 * so llm.tsx falls back to ink. The happy path pins the teardown-cleanup
 * ordering the exit path relies on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    renderer: {
      destroy: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    },
    root: {
      render: vi.fn(),
      unmount: vi.fn(),
    },
    runtime: {
      writeRuntimeSidecar: vi.fn(async () => {}),
      startPressureMonitor: vi.fn(),
      shutdown: vi.fn(async () => {}),
    },
    sidecarRejects: false,
    cleanups: [] as Array<() => void | Promise<void>>,
    stderrLines: [] as string[],
    /** Records the warm-up/renderer order — the warm-up only fixes the
     * web-tree-sitter UMD probe if it wins the race against the renderer
     * constructor installing `globalThis.window`. */
    bootOrder: [] as string[],
    warmupRejects: false,
    waitingCalls: [] as Array<{ callId: string }>,
    appProps: null as { renderMain?: () => unknown } | null,
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
  createCliRenderer: vi.fn(async () => {
    mocks.state.bootOrder.push('renderer');
    return mocks.state.renderer;
  }),
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
  CliRenderEvents: { FOCUS: 'focus', BLUR: 'blur' },
}));
vi.mock('@opentui/react', () => ({
  createRoot: vi.fn(() => mocks.state.root),
  useKeyboard: () => {},
  useRenderer: () => mocks.state.renderer,
  useTerminalDimensions: () => ({ width: 120, height: 40 }),
}));
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());

// Only the warm-up entry point is replaced: the real one pulls in the
// tree-sitter WASM runtime, which this contract test has no use for.
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  initShellAstParser: () => {
    mocks.state.bootOrder.push('warmup');
    return mocks.state.warmupRejects
      ? Promise.reject(new Error('wasm unavailable'))
      : Promise.resolve();
  },
}));
vi.mock('./opentui-runtime.js', () => ({
  OpenTuiRuntime: {
    create: vi.fn(() => mocks.state.runtime),
  },
}));
vi.mock('./opentui-app-shell.js', () => ({
  OpenTuiApp: (props: { renderMain?: () => unknown }) => {
    mocks.state.appProps = props;
    return null;
  },
}));
vi.mock('./transcript-view.js', () => ({
  OpenTuiTranscriptView: () => null,
}));
vi.mock('./live-turn.js', () => ({
  useOpenTuiLiveTurn: () => ({
    items: [],
    streaming: false,
    streamingCharsRef: { current: 0 },
    isReceivingContent: false,
    waitingCalls: mocks.state.waitingCalls,
    messageQueue: [],
    popQueue: () => null,
    submit: () => {},
    interrupt: () => {},
    resetTranscript: () => {},
    applyEvent: () => {},
    settleWaitingCall: () => {},
  }),
}));
vi.mock('../handleAutoUpdate.js', () => ({
  setUpdateHandler: () => ({ cleanup: () => {}, flush: () => {} }),
}));
vi.mock('../hooks/useLogger.js', () => ({ useLogger: () => null }));
vi.mock('../../startup/startup-prefetch.js', () => ({
  startPostRenderPrefetches: () => {},
}));
vi.mock('../../utils/version.js', () => ({
  getCliVersion: async () => '1.0.0',
}));
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: (line: string) => {
    mocks.state.stderrLines.push(line);
  },
  writeStdoutLine: () => {},
  writeStderrLineSafe: () => {},
}));
vi.mock('../../utils/cleanup.js', () => ({
  registerCleanup: (fn: () => void | Promise<void>) => {
    mocks.state.cleanups.push(fn);
    return () => {};
  },
}));
vi.mock('./exit-lifecycle.js', () => ({
  EXIT_CODE_INTERRUPT: 130,
  exitSession: vi.fn(),
}));
vi.mock('./early-input.js', () => ({
  drainCapturedInputAsText: () => '',
  injectCapturedInput: () => () => {},
  armCapturedInputInjection: () => () => {},
}));
vi.mock('./resume-session.js', () => ({
  resumeEventsFromConfig: () => null,
}));

import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { startOpenTuiUI } from './start-opentui-ui.js';
import { createCliRenderer } from '@opentui/core';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import type { InitializationResult } from '../../core/initializer.js';

function buildConfig(authType: 'qwen-oauth' | 'none' = 'qwen-oauth'): Config {
  return {
    getSessionId: () => 'test-session-id',
    getTargetDir: () => '/tmp/project',
    getApprovalMode: () => 'default',
    isInteractive: () => false,
    getSdkMode: () => false,
    getAuthType: () => (authType === 'none' ? undefined : authType),
    getChatRecordingService: () => null,
    isTelemetryInitializationDeferred: () => false,
    getHookSystem: () => null,
    getTranscriptPath: () => '/tmp/project/transcript.jsonl',
    initialize: vi.fn(async () => {}),
    trackSessionRegistration: vi.fn(),
    unregisterSessionRegistry: vi.fn(),
  } as unknown as Config;
}

const settings = {
  merged: { ui: { hideWindowTitle: true } },
} as unknown as LoadedSettings;

describe('startOpenTuiUI fallback contract', () => {
  beforeEach(() => {
    mocks.state.sidecarRejects = false;
    mocks.state.cleanups = [];
    mocks.state.stderrLines = [];
    mocks.state.bootOrder = [];
    mocks.state.warmupRejects = false;
    mocks.state.waitingCalls = [];
    mocks.state.appProps = null;
    mocks.state.renderer.destroy.mockClear();
    mocks.state.root.unmount.mockClear();
    mocks.state.root.render.mockClear();
    mocks.state.runtime.shutdown.mockClear();
  });

  // root.render is mocked, so the tree is never executed; the boot-computed
  // initialDialog is read straight off the captured SessionStatsProvider
  // element (children = the OpenTuiEntryApp element).
  function renderedInitialDialog(): unknown {
    const calls = mocks.state.root.render.mock.calls;
    const provider = calls[calls.length - 1]?.[0] as
      | { props?: { children?: { props?: Record<string, unknown> } } }
      | undefined;
    return provider?.props?.children?.props?.['initialDialog'];
  }

  it('returns false when the renderer cannot be created', async () => {
    vi.mocked(createCliRenderer).mockRejectedValueOnce(
      new Error('no native FFI'),
    );
    const started = await startOpenTuiUI(
      buildConfig(),
      settings,
      [],
      '/tmp/project',
      {} as InitializationResult,
    );
    expect(started).toBe(false);
    expect(mocks.state.stderrLines[0]).toContain('falling back to ink');
    expect(mocks.state.cleanups).toHaveLength(0);
  });

  it('tears the renderer down and returns false when the boot body throws', async () => {
    mocks.state.sidecarRejects = true;
    mocks.state.runtime.writeRuntimeSidecar.mockRejectedValueOnce(
      new Error('disk exploded'),
    );
    const started = await startOpenTuiUI(
      buildConfig(),
      settings,
      [],
      '/tmp/project',
      {} as InitializationResult,
    );
    expect(started).toBe(false);
    expect(mocks.state.root.unmount).toHaveBeenCalled();
    expect(mocks.state.renderer.destroy).toHaveBeenCalled();
    expect(mocks.state.runtime.shutdown).toHaveBeenCalled();
    expect(mocks.state.stderrLines[0]).toContain('disk exploded');
    expect(mocks.state.cleanups).toHaveLength(0);
  });

  it('boots, arms the teardown cleanups, and returns true on success', async () => {
    const config = buildConfig();
    const started = await startOpenTuiUI(
      config,
      settings,
      [],
      '/tmp/project',
      {} as InitializationResult,
    );
    expect(started).toBe(true);
    expect(mocks.state.stderrLines).toHaveLength(0);
    expect(mocks.state.cleanups.length).toBeGreaterThanOrEqual(3);
    expect(config.trackSessionRegistration).toHaveBeenCalled();
  });

  it('threads the boot auth auto-open into the shell (U-6)', async () => {
    // Unauthenticated: ink useAuth opens the dialog with no error message.
    expect(
      await startOpenTuiUI(
        buildConfig('none'),
        settings,
        [],
        '/tmp/project',
        {} as InitializationResult,
      ),
    ).toBe(true);
    expect(mocks.state.stderrLines).toEqual([]);
    expect(renderedInitialDialog()).toEqual({ dialog: 'auth' });

    // Startup auth failure: ink useInitializationAuthError opens once with
    // the message; here it is one-shot by construction (computed at boot).
    expect(
      await startOpenTuiUI(buildConfig(), settings, [], '/tmp/project', {
        authError: 'Failed to login. Message: bad key',
        themeError: null,
        shouldOpenAuthDialog: false,
        memoryFileCount: 0,
      } as InitializationResult),
    ).toBe(true);
    expect(mocks.state.stderrLines).toEqual([]);
    expect(renderedInitialDialog()).toEqual({
      dialog: 'auth',
      initialError: 'Failed to login. Message: bad key',
    });

    // Authenticated and error-free: no auto-open.
    expect(
      await startOpenTuiUI(
        buildConfig(),
        settings,
        [],
        '/tmp/project',
        {} as InitializationResult,
      ),
    ).toBe(true);
    expect(mocks.state.stderrLines).toEqual([]);
    expect(renderedInitialDialog()).toBeNull();
  });

  // The transcript itself is mocked away, so the two props Decision 36 adds are
  // read off the element the entry's own render seam returns: they are the only
  // production wiring of the parked-call marker and of the args setting. Both
  // are computed inside the entry component, which is why this case mounts the
  // captured tree — and why this file runs in jsdom — while every other case
  // here reads that tree's elements without executing them.
  it('threads the parked call and the args setting into the transcript', async () => {
    mocks.state.waitingCalls = [{ callId: 'q1' }, { callId: 'q2' }];
    const started = await startOpenTuiUI(
      buildConfig(),
      {
        merged: {
          ui: {
            hideWindowTitle: true,
            showToolCallArgs: true,
            mouseTracking: false,
          },
        },
      } as unknown as LoadedSettings,
      [],
      '/tmp/project',
      {} as InitializationResult,
    );
    expect(started).toBe(true);

    // The entry mounts useTerminalFocus, which writes the ?1004 mode escape.
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const calls = mocks.state.root.render.mock.calls;
    render(calls[calls.length - 1]?.[0] as ReactElement);
    write.mockRestore();
    // renderMain draws the transcript inside a box, and the mocked JSX
    // runtime turns that box into a plain element, so the transcript's own
    // props sit one level below the returned element.
    const main = mocks.state.appProps?.renderMain?.() as
      | { props?: { children?: { props?: Record<string, unknown> } } }
      | undefined;
    const props = main?.props?.children?.props;
    expect(props?.['awaitingCallId']).toBe('q1');
    expect(props?.['showToolCallArgs']).toBe(true);
    expect(props?.['mouseTracking']).toBe(false);
    // The renderer takes no pointer events when the setting is off.
    expect(createCliRenderer).toHaveBeenLastCalledWith(
      expect.objectContaining({ useMouse: false }),
    );
  });

  it('warms the shell AST parser before the renderer is created', async () => {
    expect(
      await startOpenTuiUI(
        buildConfig(),
        settings,
        [],
        '/tmp/project',
        {} as InitializationResult,
      ),
    ).toBe(true);
    expect(mocks.state.bootOrder).toEqual(['warmup', 'renderer']);
  });

  it('still boots when the shell AST warm-up fails', async () => {
    mocks.state.warmupRejects = true;
    expect(
      await startOpenTuiUI(
        buildConfig(),
        settings,
        [],
        '/tmp/project',
        {} as InitializationResult,
      ),
    ).toBe(true);
    expect(mocks.state.bootOrder).toEqual(['warmup', 'renderer']);
    expect(mocks.state.stderrLines).toHaveLength(0);
  });
});
