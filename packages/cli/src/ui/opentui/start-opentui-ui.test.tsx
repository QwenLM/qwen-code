/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

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
  createCliRenderer: vi.fn(async () => mocks.state.renderer),
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));
vi.mock('@opentui/react', () => ({
  createRoot: vi.fn(() => mocks.state.root),
  useKeyboard: () => {},
  useTerminalDimensions: () => ({ width: 120, height: 40 }),
}));
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());

vi.mock('./opentui-runtime.js', () => ({
  OpenTuiRuntime: {
    create: vi.fn(() => mocks.state.runtime),
  },
}));
vi.mock('./opentui-app-shell.js', () => ({ OpenTuiApp: () => null }));
vi.mock('./transcript-view.js', () => ({
  OpenTuiTranscriptView: () => null,
}));
vi.mock('./live-turn.js', () => ({
  useOpenTuiLiveTurn: () => ({
    items: [],
    streaming: false,
    waitingCalls: [],
    queueLength: 0,
    popQueue: () => null,
    submit: () => {},
    interrupt: () => {},
    resetTranscript: () => {},
    applyEvent: () => {},
    settleWaitingCall: () => {},
  }),
}));
vi.mock('../handleAutoUpdate.js', () => ({
  setUpdateHandler: () => ({ cleanup: () => {} }),
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
}));
vi.mock('./resume-session.js', () => ({
  resumeEventsFromConfig: () => null,
}));

import { startOpenTuiUI } from './start-opentui-ui.js';
import { createCliRenderer } from '@opentui/core';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import type { InitializationResult } from '../../core/initializer.js';

function buildConfig(): Config {
  return {
    getSessionId: () => 'test-session-id',
    getTargetDir: () => '/tmp/project',
    getApprovalMode: () => 'default',
    getChatRecordingService: () => null,
    isTelemetryInitializationDeferred: () => false,
    getHookSystem: () => null,
    getTranscriptPath: () => '/tmp/project/transcript.jsonl',
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
    mocks.state.renderer.destroy.mockClear();
    mocks.state.root.unmount.mockClear();
    mocks.state.runtime.shutdown.mockClear();
  });

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
});
