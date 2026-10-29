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
import { execFile, execFileSync } from 'child_process';
import type { OpenTuiStreamEvent } from './event-adapter.js';
import type { InputPromptProps } from './input-prompt.js';
import type { HistoryItem } from '../types.js';
import { useTextBuffer } from '../components/shared/text-buffer.js';
import type { LiveHistoryItem } from './live-session-model.js';
import { createInteractiveModSession } from '../../services/interactive-mod-session.js';
import {
  ModSession,
  type ModTerminalHost,
} from '../../services/mod-session.js';

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
    liveOptions: null as unknown,
    runtime: {
      dualOutputBridge: {
        isConnected: true,
        finalizeAssistantMessage: vi.fn(),
      },
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
    waitingCalls: [] as Array<{
      callId: string;
      confirmationDetails?: { onConfirm: () => Promise<void> };
    }>,
    foregroundShellControl: {
      foregroundShell: { callId: 'live-shell', pid: 4300, turn: 7 },
      promoteShellToBackground: vi.fn(),
      writeShellInput: vi.fn(),
      resizeShell: vi.fn(),
      scrollShell: vi.fn(),
    },
    streaming: false,
    interrupt: vi.fn(),
    keyboard: [] as Array<
      (key: { name: string; ctrl: boolean; eventType?: string }) => void
    >,
    items: [] as LiveHistoryItem[],
    isCurrentHistory: vi.fn(),
    appProps: null as {
      userMessages?: readonly string[];
      startupHistory?: HistoryItem[];
      isCurrentHistory?: (snapshot: readonly LiveHistoryItem[]) => boolean;
      renderMain?: () => unknown;
      onQuit?: (messages: readonly HistoryItem[]) => void;
      onToggleVim?: () => Promise<boolean>;
      vimMode?: string;
      vim?: InputPromptProps['vim'];
      composerHandle?: {
        current: {
          getText: () => string;
          setText: (text: string) => void;
          submitDraft?: (text: string) => Promise<void>;
          invalidateImportedInput?: () => void;
        } | null;
      };
    } | null,
    seedPromptCount: null as ((count: number) => void) | null,
    transcript: [] as OpenTuiStreamEvent[],
    replayOrder: [] as string[],
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

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn();
  const execFileSync = vi.fn(() => '');
  return {
    ...actual,
    default: { ...actual, execFile, execFileSync },
    execFile,
    execFileSync,
  };
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
  useKeyboard: (
    handler: (key: { name: string; ctrl: boolean; eventType?: string }) => void,
  ) => {
    mocks.state.keyboard.push(handler);
  },
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
vi.mock('./opentui-app-shell.js', async () => {
  const { useSessionStats } = await import('../contexts/SessionContext.js');
  return {
    OpenTuiApp: (props: { renderMain?: () => unknown }) => {
      mocks.state.appProps = props;
      mocks.state.seedPromptCount = useSessionStats().seedPromptCount;
      return 'ordinary-composer';
    },
  };
});
vi.mock('./transcript-view.js', () => ({
  OpenTuiTranscriptView: ({ items }: { items: readonly LiveHistoryItem[] }) =>
    items.map((item) => ('text' in item ? item.text : '')).join('\n'),
}));
vi.mock('./live-turn.js', async (importOriginal) => ({
  foldBatch: (await importOriginal<typeof import('./live-turn.js')>())
    .foldBatch,
  useOpenTuiLiveTurn: (options: unknown) => {
    mocks.state.liveOptions = options;
    return {
      ...mocks.state.foregroundShellControl,
      items: mocks.state.items,
      isCurrentHistory: mocks.state.isCurrentHistory,
      streaming: mocks.state.streaming,
      streamingCharsRef: { current: 0 },
      isReceivingContent: false,
      waitingCalls: mocks.state.waitingCalls,
      messageQueue: [],
      popQueue: () => null,
      submit: () => {},
      interrupt: mocks.state.interrupt,
      resetTranscript: (events: OpenTuiStreamEvent[]) => {
        mocks.state.replayOrder.push('reset');
        mocks.state.transcript = [...events];
      },
      applyEvent: (event: OpenTuiStreamEvent) => {
        mocks.state.replayOrder.push(event.type);
        mocks.state.transcript.push(event);
      },
      settleWaitingCall: () => {},
    };
  },
}));
vi.mock('../handleAutoUpdate.js', () => ({
  setUpdateHandler: () => ({ cleanup: () => {}, flush: () => {} }),
}));
vi.mock('../hooks/useLogger.js', () => ({
  useLogger: () => null,
}));
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

import type { ReactElement } from 'react';
import { render, renderHook, screen } from '@testing-library/react';
import { act, cloneElement } from 'react';
import { exitSession } from './exit-lifecycle.js';
import * as sessionSwitch from './session-switch.js';
import { startOpenTuiUI } from './start-opentui-ui.js';
import { createCliRenderer } from '@opentui/core';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import type { InitializationResult } from '../../core/initializer.js';

function buildConfig(authType: 'qwen-oauth' | 'none' = 'qwen-oauth'): Config {
  return {
    getSessionId: () => 'test-session-id',
    getResumedSessionData: () => undefined,
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

const setSetting = vi.fn();
const settings = {
  setValue: setSetting,
  merged: { ui: { hideWindowTitle: true } },
} as unknown as LoadedSettings;

describe('startOpenTuiUI fallback contract', () => {
  beforeEach(() => {
    vi.mocked(execFile).mockReset();
    vi.mocked(execFileSync).mockReset().mockReturnValue('');
    setSetting.mockClear();
    mocks.state.sidecarRejects = false;
    mocks.state.cleanups = [];
    mocks.state.stderrLines = [];
    mocks.state.bootOrder = [];
    mocks.state.warmupRejects = false;
    mocks.state.waitingCalls = [];
    mocks.state.streaming = false;
    mocks.state.items = [];
    mocks.state.interrupt.mockClear();
    mocks.state.appProps = null;
    mocks.state.seedPromptCount = null;
    mocks.state.liveOptions = null;
    mocks.state.keyboard = [];
    vi.mocked(exitSession).mockClear();
    mocks.state.transcript = [];
    mocks.state.replayOrder = [];
    mocks.state.renderer.destroy.mockClear();
    mocks.state.root.unmount.mockClear();
    mocks.state.root.render.mockClear();
    mocks.state.runtime.shutdown.mockClear();
    mocks.state.runtime.dualOutputBridge.finalizeAssistantMessage.mockClear();
  });

  // root.render is mocked, so the tree is never executed; the boot-computed
  // initialDialog is read straight off the captured SessionStatsProvider
  // element through the real VimModeProvider.
  function renderedInitialDialog(): unknown {
    const calls = mocks.state.root.render.mock.calls;
    const provider = calls[calls.length - 1]?.[0] as
      | {
          props?: {
            children?: {
              props?: { children?: { props?: Record<string, unknown> } };
            };
          };
        }
      | undefined;
    return provider?.props?.children?.props?.children?.props?.['initialDialog'];
  }

  async function withEntryApp(
    check: (rerender: () => void) => void | Promise<void>,
    config = buildConfig(),
  ) {
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    let view: ReturnType<typeof render> | undefined;
    try {
      await startOpenTuiUI(
        config,
        settings,
        [],
        '/tmp/project',
        {} as InitializationResult,
      );
      const tree = mocks.state.root.render.mock.calls.at(
        -1,
      )![0] as ReactElement<{
        children: ReactElement<{ children: ReactElement }>;
      }>;
      await act(async () => {
        view = render(tree);
      });
      await check(() => {
        const vim = tree.props.children;
        view!.rerender(
          cloneElement(
            tree,
            {},
            cloneElement(vim, {}, cloneElement(vim.props.children)),
          ),
        );
      });
    } finally {
      view?.unmount();
      write.mockRestore();
    }
  }

  it('passes the actual live-turn shell owner and every control action to the app', async () => {
    await withEntryApp(() => {
      expect(mocks.state.appProps).toMatchObject({
        foregroundShellControl: mocks.state.foregroundShellControl,
      });
    });
  });

  it('starts a fresh command history without a replay reset', async () => {
    await withEntryApp(() => {
      expect(mocks.state.appProps?.startupHistory).toEqual([]);
      expect(mocks.state.appProps?.isCurrentHistory).toBe(
        mocks.state.isCurrentHistory,
      );
      expect(mocks.state.replayOrder).not.toContain('reset');
    });
  });

  it.each(['resolve', 'reject'] as const)(
    'waits for the shared init before resumed tool metadata: %s',
    async (outcome) => {
      const config = buildConfig();
      let release!: () => void;
      let reject!: (reason: Error) => void;
      const initialization = new Promise<void>((yes, no) => {
        release = yes;
        reject = no;
      });
      vi.mocked(config.initialize).mockReturnValue(initialization);
      let resumed = {
        filePath: '/tmp/project/transcript.jsonl',
        lastCompletedUuid: 'result-row',
        conversation: {
          sessionId: 'test-session-id',
          projectHash: 'project',
          startTime: '2026-10-23T00:00:00Z',
          lastUpdated: '2026-10-23T00:00:00Z',
          messages: [
            {
              uuid: 'call-row',
              parentUuid: null,
              sessionId: 'test-session-id',
              timestamp: '2026-10-23T00:00:00Z',
              cwd: '/tmp/project',
              version: 'test',
              type: 'assistant',
              provenance: 'assistant_output',
              message: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      id: 'resume-call',
                      name: 'read_file',
                      args: { file_path: '/tmp/project/owned' },
                    },
                  },
                ],
              },
            },
            {
              uuid: 'result-row',
              parentUuid: 'call-row',
              sessionId: 'test-session-id',
              timestamp: '2026-10-23T00:00:01Z',
              cwd: '/tmp/project',
              version: 'test',
              type: 'tool_result',
              provenance: 'tool_result',
              message: {
                role: 'user',
                parts: [
                  {
                    functionResponse: {
                      id: 'resume-call',
                      name: 'read_file',
                      response: { output: 'REAL_RESULT' },
                    },
                  },
                ],
              },
              toolCallResult: {
                callId: 'resume-call',
                status: 'success',
                resultDisplay: 'REAL_RESULT',
              },
            },
          ],
        },
      } as NonNullable<ReturnType<Config['getResumedSessionData']>>;
      let ready = false;
      const getTool = vi.fn(() => ({
        displayName: 'Ready registry metadata',
        build: () => ({ getDescription: () => 'actual resumed description' }),
      }));
      const registry = vi.fn(() => {
        if (!ready) throw new Error('tool registry not initialized');
        return { getTool };
      });
      Object.assign(config, {
        getResumedSessionData: () => resumed,
        getToolRegistry: registry,
        getGeminiClient: () => ({ isInitialized: () => false }),
      });
      const history = vi.spyOn(sessionSwitch, 'buildUiHistoryItems');
      mocks.state.runtime.startPressureMonitor.mockClear();
      const pending = startOpenTuiUI(
        config,
        settings,
        [],
        '/tmp/project',
        {} as InitializationResult,
      );
      try {
        await vi.waitFor(() =>
          expect(mocks.state.runtime.startPressureMonitor).toHaveBeenCalled(),
        );
        expect(config.initialize).toHaveBeenCalledOnce();
        expect(history).not.toHaveBeenCalled();
        expect(registry).not.toHaveBeenCalled();
        expect(mocks.state.root.render).not.toHaveBeenCalled();
        if (outcome === 'resolve') {
          // Real initialization can replace sessionData under the writer lease.
          resumed = structuredClone(resumed);
          const authoritative = resumed.conversation.messages[1];
          authoritative.message!.parts![0].functionResponse!.response = {
            output: 'AUTHORITATIVE_RESULT',
          };
          authoritative.toolCallResult!.resultDisplay = 'AUTHORITATIVE_RESULT';
          ready = true;
          release();
          expect(await pending).toBe(true);
          expect(history).toHaveBeenCalledExactlyOnceWith(resumed, {
            config,
            settings,
          });
          expect(getTool).toHaveBeenCalledWith('read_file');
          expect(JSON.stringify(history.mock.results[0].value)).toContain(
            'Ready registry metadata',
          );
          expect(JSON.stringify(history.mock.results[0].value)).toContain(
            'AUTHORITATIVE_RESULT',
          );
          expect(JSON.stringify(history.mock.results[0].value)).not.toContain(
            'REAL_RESULT',
          );
          expect(mocks.state.root.render).toHaveBeenCalledOnce();
        } else {
          reject(new Error('owned shared initialization rejected'));
          expect(await pending).toBe(false);
          expect(history).not.toHaveBeenCalled();
          expect(mocks.state.root.render).not.toHaveBeenCalled();
          expect(mocks.state.root.unmount).toHaveBeenCalledOnce();
          expect(mocks.state.renderer.destroy).toHaveBeenCalledOnce();
          expect(mocks.state.runtime.shutdown).toHaveBeenCalledOnce();
          expect(mocks.state.stderrLines.join('\n')).toContain(
            'owned shared initialization rejected',
          );
        }
      } finally {
        release();
        await pending;
        history.mockRestore();
      }
    },
  );

  it('still paints a fresh session while shared initialization is held', async () => {
    const config = buildConfig();
    let release!: () => void;
    vi.mocked(config.initialize).mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    let settled = false;
    const pending = startOpenTuiUI(
      config,
      settings,
      [],
      '/tmp/project',
      {} as InitializationResult,
    ).then((value) => {
      settled = value;
      return value;
    });
    try {
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(mocks.state.root.render).toHaveBeenCalledOnce();
      expect(config.initialize).toHaveBeenCalledOnce();
    } finally {
      release();
      await pending;
    }
  });

  it('uses the existing startup fallback when resumed history cannot be read', async () => {
    const config = buildConfig();
    config.getResumedSessionData = () => {
      throw new Error('owned resume failure');
    };
    expect(
      await startOpenTuiUI(
        config,
        settings,
        [],
        '/tmp/project',
        {} as InitializationResult,
      ),
    ).toBe(false);
    expect(mocks.state.root.render).not.toHaveBeenCalled();
    expect(mocks.state.root.unmount).toHaveBeenCalledOnce();
    expect(mocks.state.renderer.destroy).toHaveBeenCalledOnce();
    expect(mocks.state.runtime.shutdown).toHaveBeenCalledOnce();
    expect(mocks.state.stderrLines.join('\n')).toContain(
      'owned resume failure',
    );
  });

  it('wires /vim to the real provider, persistence and footer mode', async () => {
    await withEntryApp(async () => {
      expect(mocks.state.appProps?.vimMode).toBeUndefined();
      await act(async () => {
        expect(await mocks.state.appProps!.onToggleVim!()).toBe(true);
      });
      expect(setSetting).toHaveBeenCalledWith('User', 'general.vimMode', true);
      expect(mocks.state.appProps?.vimMode).toBe('NORMAL');
      const submitDraft = vi.fn(async () => {});
      mocks.state.appProps!.composerHandle!.current = {
        getText: () => 'owned draft',
        setText: () => {},
        submitDraft,
      };
      const owner = renderHook(() =>
        useTextBuffer({
          initialText: 'owned draft',
          viewport: { width: 40, height: 8 },
          isValidPath: () => false,
        }),
      );
      mocks.state.appProps!.vim!.buffer.current = owner.result.current;
      await act(async () => {
        expect(
          mocks.state.appProps!.vim!.handleInput({
            name: 'return',
            sequence: '\r',
            ctrl: false,
            meta: false,
            shift: false,
            paste: false,
          }),
        ).toBe(true);
      });
      expect(submitDraft).toHaveBeenCalledExactlyOnceWith('owned draft');

      await act(async () => {
        expect(await mocks.state.appProps!.onToggleVim!()).toBe(false);
      });
      expect(mocks.state.appProps?.vimMode).toBeUndefined();
    });
  });

  it('connects actual Vim paste import decisions to the current composer', async () => {
    const clipboard = vi.mocked(execFileSync).mockReturnValue('X');
    try {
      await withEntryApp(async () => {
        await act(async () => mocks.state.appProps!.onToggleVim!());
        const invalidateImportedInput = vi.fn();
        const owner = renderHook(() =>
          useTextBuffer({
            initialText: 'owned',
            viewport: { width: 40, height: 8 },
            isValidPath: () => false,
          }),
        );
        mocks.state.appProps!.composerHandle!.current = {
          getText: () => owner.result.current.text,
          setText: () => {},
          invalidateImportedInput,
        };
        mocks.state.appProps!.vim!.buffer.current = owner.result.current;
        const paste = () =>
          mocks.state.appProps!.vim!.handleInput({
            name: 'p',
            sequence: 'p',
            ctrl: false,
            meta: false,
            shift: false,
            paste: false,
          });
        await act(async () => {
          expect(paste()).toBe(true);
        });
        expect(owner.result.current.text).toBe('oXwned');
        expect(invalidateImportedInput).toHaveBeenCalledTimes(1);
        clipboard.mockReturnValue('');
        await act(async () => {
          expect(paste()).toBe(true);
        });
        expect(owner.result.current.text).toBe('oXwned');
        expect(invalidateImportedInput).toHaveBeenCalledTimes(1);
      });
    } finally {
      clipboard.mockReset().mockReturnValue('');
    }
  });

  it.each([
    { recording: true, promptCount: 1, resumeHint: true },
    { recording: true, promptCount: 0, resumeHint: false },
    { recording: false, promptCount: 1, resumeHint: false },
  ])(
    'shows supplied quit messages before the single drain: %j',
    async ({ recording, promptCount, resumeHint }) => {
      const requestShutdown = vi.fn();
      const config = {
        ...buildConfig(),
        getChatRecordingService: () => (recording ? {} : null),
        getLlmClient: () => ({ requestShutdown }),
      } as unknown as Config;
      const messages: HistoryItem[] = [
        { id: 41, type: 'user', text: '/quit' },
        { id: 42, type: 'quit', duration: '2m 3s' },
      ];
      vi.useFakeTimers();
      try {
        await withEntryApp(() => {
          act(() => mocks.state.seedPromptCount!(promptCount));
          const onQuit = mocks.state.appProps!.onQuit!;
          const history = [...mocks.state.transcript];
          act(() => onQuit(messages));
          expect(screen.queryByText('ordinary-composer')).toBeNull();
          const summary = screen.getByText(/Agent powering down\. Goodbye!/);
          expect(summary.textContent).toContain('/quit');
          expect(summary.textContent).toContain('Interaction Summary');
          expect(summary.textContent).toContain('Wall Time: 2m 3s');
          expect(
            summary.textContent?.includes('qwen --resume test-session-id'),
          ).toBe(resumeHint);
          expect(mocks.state.transcript).toEqual(history);
          expect(messages).toEqual([
            { id: 41, type: 'user', text: '/quit' },
            { id: 42, type: 'quit', duration: '2m 3s' },
          ]);
          expect(requestShutdown).toHaveBeenCalledOnce();
          expect(exitSession).not.toHaveBeenCalled();
          act(() => vi.advanceTimersByTime(99));
          act(() => onQuit([]));
          expect(exitSession).not.toHaveBeenCalled();
          act(() => vi.advanceTimersByTime(1));
          expect(exitSession).toHaveBeenCalledExactlyOnceWith(config, 0);
          act(() => onQuit(messages));
          act(() => vi.advanceTimersByTime(100));
          expect(exitSession).toHaveBeenCalledOnce();
        }, config);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('cancels the committed quit timer when the entry unmounts', async () => {
    const config = {
      ...buildConfig(),
      getLlmClient: () => ({ requestShutdown: vi.fn() }),
    } as unknown as Config;
    vi.useFakeTimers();
    try {
      await withEntryApp(() => {
        act(() =>
          mocks.state.appProps!.onQuit!([
            { id: 1, type: 'quit', duration: '1s' },
          ]),
        );
      }, config);
      act(() => vi.advanceTimersByTime(100));
      expect(exitSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exits an empty settings restart immediately without a summary or timer', async () => {
    await withEntryApp(() => {
      act(() => mocks.state.appProps!.onQuit!([]));
      expect(exitSession).toHaveBeenCalledOnce();
      expect(exitSession).toHaveBeenCalledWith(expect.anything(), 0);
      expect(screen.queryByText(/Agent powering down/)).toBeNull();
    });
  });

  it('passes the runtime bridge to the actual rendered live hook', async () => {
    await withEntryApp(() => {
      expect(mocks.state.liveOptions).toMatchObject({
        dualOutput: mocks.state.runtime.dualOutputBridge,
      });
    });
  });

  it('flushes the assistant synchronously before renderer unmount and writer shutdown', async () => {
    await startOpenTuiUI(
      buildConfig(),
      settings,
      [],
      '/tmp/project',
      {} as InitializationResult,
    );
    await mocks.state.cleanups[0]();
    const finalize =
      mocks.state.runtime.dualOutputBridge.finalizeAssistantMessage;
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.state.root.unmount.mock.invocationCallOrder[0],
    );
    expect(mocks.state.root.unmount.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.state.runtime.shutdown.mock.invocationCallOrder[0],
    );
  });

  it('reads live composer text for Ctrl+D and only arms exit after it becomes empty', async () => {
    const config = buildConfig();
    await withEntryApp(() => {
      let text = 'draft';
      const handle = mocks.state.appProps?.composerHandle;
      expect(handle).toBeDefined();
      handle!.current = {
        getText: () => text,
        setText: (value) => {
          text = value;
        },
      };
      const press = (eventType = 'press') =>
        act(() => {
          mocks.state.keyboard.at(-1)!({ name: 'd', ctrl: true, eventType });
        });
      press();
      press();
      expect(exitSession).not.toHaveBeenCalled();
      handle!.current.setText('');
      press('release');
      press();
      expect(exitSession).not.toHaveBeenCalled();
      press();
      expect(exitSession).toHaveBeenCalledExactlyOnceWith(config, 0);
    }, config);
  });

  it.each(['c', 'd'] as const)(
    'exits idle keyboard confirmation with code 0: %s',
    async (name) => {
      const config = buildConfig();
      await withEntryApp(() => {
        act(() => mocks.state.keyboard.at(-1)!({ name, ctrl: true }));
        expect(exitSession).not.toHaveBeenCalled();
        expect(mocks.state.interrupt).not.toHaveBeenCalled();
        act(() => mocks.state.keyboard.at(-1)!({ name, ctrl: true }));
        expect(exitSession).toHaveBeenCalledExactlyOnceWith(config, 0);
      }, config);
    },
  );

  it.each([
    'stream-c',
    'stream-d',
    'confirmation-c',
    'confirmation-d',
  ] as const)(
    'preserves cancellation before confirmed graceful exit: %s',
    async (mode) => {
      const config = buildConfig();
      const confirm = vi.fn(async () => {});
      mocks.state.streaming = true;
      const parked = mode.startsWith('confirmation');
      if (parked)
        mocks.state.waitingCalls = [
          { callId: 'parked', confirmationDetails: { onConfirm: confirm } },
        ];
      await withEntryApp((rerender) => {
        const name = mode.endsWith('c') ? 'c' : 'd';
        act(() => mocks.state.keyboard.at(-1)!({ name, ctrl: true }));
        expect(exitSession).not.toHaveBeenCalled();
        expect(confirm).toHaveBeenCalledTimes(
          mode === 'confirmation-c' ? 1 : 0,
        );
        expect(mocks.state.interrupt).toHaveBeenCalledTimes(parked ? 0 : 1);
        if (mode === 'stream-d') {
          mocks.state.streaming = false;
          act(rerender);
          act(() => mocks.state.keyboard.at(-1)!({ name, ctrl: true }));
          expect(exitSession).not.toHaveBeenCalled();
        }
        act(() => mocks.state.keyboard.at(-1)!({ name, ctrl: true }));
        expect(exitSession).toHaveBeenCalledExactlyOnceWith(config, 0);
        expect(confirm).toHaveBeenCalledTimes(
          mode === 'confirmation-c' ? 1 : 0,
        );
      }, config);
    },
  );

  it('feeds only real live prompt texts to the shell history owner', async () => {
    mocks.state.items = [
      { kind: 'user', id: '1', text: 'B' },
      { kind: 'user', id: '2', text: 'A' },
      { kind: 'user', id: '3', text: 'steer', sentToModel: false },
      { kind: 'user', id: '4', text: 'B' },
      { kind: 'user', id: '5', text: ' ' },
    ];
    await withEntryApp(() => {
      expect(mocks.state.appProps?.userMessages).toEqual(['B', 'A', 'B']);
    });
  });

  it.each(['assistant', 'info'] as const)(
    'keeps projected prompt identity when only %s text changes',
    async (kind) => {
      const users: LiveHistoryItem[] = [
        { kind: 'user', id: 'u1', text: 'OLDER' },
        { kind: 'user', id: 'u2', text: 'NEWER' },
      ];
      const nonUser: LiveHistoryItem =
        kind === 'assistant'
          ? { kind, id: 'reply', text: 'first', streaming: true }
          : { kind, id: 'notice', text: 'first' };
      mocks.state.items = [...users, nonUser];
      mocks.state.streaming = true;
      await withEntryApp(async (rerender) => {
        const prompts = mocks.state.appProps!.userMessages;
        expect(prompts).toEqual(['OLDER', 'NEWER']);
        mocks.state.items = [...users, { ...nonUser, text: 'first next' }];
        await act(async () => rerender());
        expect(mocks.state.appProps!.userMessages).toEqual(['OLDER', 'NEWER']);
        expect(mocks.state.appProps!.userMessages).toBe(prompts);
      });
    },
  );

  it.each([
    { change: 'user', expected: ['OLDER', 'NEWER', 'THIRD'] },
    { change: 'recallText', expected: ['EDITABLE OLDER', 'NEWER'] },
    { change: 'sentToModel', expected: ['NEWER'] },
    { change: 'order', expected: ['NEWER', 'OLDER'] },
  ] as const)(
    'updates projected prompts when $change changes',
    async ({ change, expected }) => {
      const older = { kind: 'user', id: 'u1', text: 'OLDER' } as const;
      const newer = { kind: 'user', id: 'u2', text: 'NEWER' } as const;
      mocks.state.items = [older, newer];
      await withEntryApp(async (rerender) => {
        const prompts = mocks.state.appProps!.userMessages;
        expect(prompts).toEqual(['OLDER', 'NEWER']);
        const next: Record<typeof change, LiveHistoryItem[]> = {
          user: [older, newer, { kind: 'user', id: 'u3', text: 'THIRD' }],
          recallText: [{ ...older, recallText: 'EDITABLE OLDER' }, newer],
          sentToModel: [{ ...older, sentToModel: false }, newer],
          order: [newer, older],
        };
        mocks.state.items = next[change];
        await act(async () => rerender());
        expect(mocks.state.appProps!.userMessages).toEqual(expected);
        expect(mocks.state.appProps!.userMessages).not.toBe(prompts);
      });
    },
  );

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

  it('leaves SIGINT confirmation to the application and destroys during exit cleanup', async () => {
    expect(
      await startOpenTuiUI(
        buildConfig(),
        settings,
        [],
        '/tmp/project',
        {} as InitializationResult,
      ),
    ).toBe(true);
    expect(createCliRenderer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        exitOnCtrlC: false,
        exitSignals: [
          'SIGTERM',
          'SIGQUIT',
          'SIGABRT',
          'SIGHUP',
          'SIGPIPE',
          'SIGBREAK',
          'SIGBUS',
        ],
      }),
    );
    expect(mocks.state.renderer.destroy).not.toHaveBeenCalled();

    for (const cleanup of mocks.state.cleanups) await cleanup();

    expect(mocks.state.root.unmount).toHaveBeenCalledTimes(1);
    expect(mocks.state.renderer.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.state.runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.state.root.unmount.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.state.renderer.destroy.mock.invocationCallOrder[0],
    );
    expect(
      mocks.state.renderer.destroy.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.state.runtime.shutdown.mock.invocationCallOrder[0]);
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
    const raw = '<system-reminder>literal user text</system-reminder> workflow';
    const recalledPaste = `${raw}\npasted body`;
    mocks.state.items = [
      { kind: 'user', id: 'user', text: raw },
      {
        kind: 'user',
        id: 'pasted-user',
        text: '[Pasted Content 1200 chars]',
        recallText: recalledPaste,
      },
      { kind: 'info', id: 'info', text: 'machine context' },
    ];
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
    expect(mocks.state.appProps?.userMessages).toEqual([raw, recalledPaste]);
    // The renderer takes no pointer events when the setting is off.
    expect(createCliRenderer).toHaveBeenLastCalledWith(
      expect.objectContaining({ useMouse: false }),
    );
  });

  it('retains pre-paint Mod warnings after restoring history and detaches on unmount', async () => {
    const config = buildConfig();
    config.isInteractive = () => true;
    const warning = 'tool.call and tool.check are not supported.';
    let host!: ModTerminalHost;
    const setRenderInput = vi.fn();
    const factory = vi
      .spyOn(ModSession, 'create')
      .mockImplementation((_config, _settings, output) => {
        host = output as ModTerminalHost;
        return {
          initialize: async () =>
            host.log(
              { to: 'transcript', text: warning },
              'fixture',
              config.getSessionId(),
            ),
          flushLogs: () => {},
          setRenderInput,
          close: async () => {},
        } as unknown as ModSession;
      });
    const owner = createInteractiveModSession(config, {
      merged: { experimental: { mods: true } },
    } as LoadedSettings)!;
    config.getResumedSessionData = () =>
      ({
        conversation: {
          sessionId: 'test-session-id',
          projectHash: 'project',
          startTime: '2026-10-21T00:00:00Z',
          lastUpdated: '2026-10-21T00:00:00Z',
          messages: [
            {
              uuid: 'restored',
              parentUuid: null,
              sessionId: 'test-session-id',
              timestamp: '2026-10-21T00:00:00Z',
              cwd: '/tmp/project',
              version: 'test',
              type: 'user',
              promptId: 'test-session-id########4',
              message: { role: 'user', parts: [{ text: 'restored history' }] },
            },
          ],
        },
      }) as ReturnType<Config['getResumedSessionData']>;
    mocks.state.runtime.writeRuntimeSidecar.mockImplementationOnce(async () => {
      await owner.ready;
    });
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    let view: ReturnType<typeof render> | undefined;
    try {
      expect(
        await startOpenTuiUI(
          config,
          settings,
          [],
          '/tmp/project',
          {} as InitializationResult,
        ),
      ).toBe(true);
      const calls = mocks.state.root.render.mock.calls;
      view = render(calls[calls.length - 1]?.[0] as ReactElement);
      expect(mocks.state.replayOrder).toEqual(['reset', 'info']);
      // The band's input, as Ink reports it; OpenTUI has no survey.
      expect(setRenderInput).toHaveBeenLastCalledWith(
        expect.objectContaining({
          component: 'AbovePrompt',
          viewport: { columns: 120, rows: 40, isFullscreen: false },
          props: expect.objectContaining({
            hasSurvey: false,
            isWorking: false,
            maxRows: 13,
            bodyColumns: 115,
          }),
        }),
      );
      // A turn in flight is working.
      mocks.state.streaming = true;
      const tree = calls[calls.length - 1]?.[0] as ReactElement<{
        children: ReactElement<{ children: ReactElement }>;
      }>;
      const vim = tree.props.children;
      act(() =>
        view!.rerender(
          cloneElement(
            tree,
            {},
            cloneElement(vim, {}, cloneElement(vim.props.children)),
          ),
        ),
      );
      expect(setRenderInput).toHaveBeenLastCalledWith(
        expect.objectContaining({
          props: expect.objectContaining({ isWorking: true }),
        }),
      );
      expect(mocks.state.appProps?.startupHistory).toEqual([
        expect.objectContaining({
          type: 'user',
          text: 'restored history',
          promptId: 'test-session-id########4',
        }),
      ]);
      expect(mocks.state.transcript).toEqual([
        {
          type: 'user',
          text: 'restored history',
          promptId: 'test-session-id########4',
          sentToModel: undefined,
          historyId: mocks.state.appProps?.startupHistory?.[0]?.id,
          canonicalHistoryItem: {
            id: mocks.state.appProps?.startupHistory?.[0]?.id,
            type: 'user',
            text: 'restored history',
            promptId: 'test-session-id########4',
          },
        },
        { type: 'done' },
        { type: 'info', text: `[Mod fixture] ${warning}` },
      ]);
      view.unmount();
      host.log(
        { to: 'transcript', text: 'after unmount' },
        'fixture',
        config.getSessionId(),
      );
      expect(mocks.state.transcript).toHaveLength(3);
    } finally {
      view?.unmount();
      await owner.close();
      factory.mockRestore();
      write.mockRestore();
    }
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
