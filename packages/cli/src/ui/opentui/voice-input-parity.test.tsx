/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useMemo, useRef } from 'react';
import type { KeyEvent } from '@opentui/core';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import type { TextBuffer } from '../components/shared/text-buffer.js';
import { getCachedStringWidth } from '../utils/textUtils.js';
import { OpenTuiApp } from './opentui-app-shell.js';
import { OpenTuiInputPrompt } from './input-prompt.js';
import { useVim, type VimBuffer } from '../hooks/vim.js';
import { createVimBuffer } from './vim-buffer.js';
import {
  VimModeProvider,
  useVimModeState,
} from '../contexts/VimModeContext.js';
import type { OpenTuiComposerHandle } from './input-submission.js';
import type { VoiceStreamCallbacks } from '../voice/voice-stream-session.js';

const mocks = vi.hoisted(() => {
  const handlers = new Set<(key: KeyEvent) => void>();
  const start = vi.fn<() => Promise<void>>();
  const stop = vi.fn();
  const warmup = vi.fn();
  const microphoneStatus = vi.fn();
  const transcribe = vi.fn();
  const refine = vi.fn();
  const fastModel = vi.fn();
  const audioLevel = vi.fn();
  const drain = vi.fn();
  const stream = vi.fn();
  const streamConfig = vi.fn();
  const networkAllowed = vi.fn();
  const clipboardHasImage = vi.fn();
  const saveClipboardImage = vi.fn();
  const state = {
    buffer: null as TextBuffer | null,
    closeDialog: null as (() => void) | null,
    dimensions: { width: 80, height: 24 },
  };
  const renderer = {
    widthMethod: 'unicode',
    addInputHandler: vi.fn(),
    removeInputHandler: vi.fn(),
    keyInput: { on: vi.fn(), off: vi.fn() },
  };

  async function buildJsxRuntime() {
    const React = await import('react');
    const FakeTextarea = React.forwardRef(
      (_props: Record<string, unknown>, ref: React.Ref<unknown>) => {
        const editor = React.useMemo(() => {
          let text = '';
          let cursor = { row: 0, col: 0, offset: 0 };
          return {
            width: 78,
            get plainText() {
              return text;
            },
            get logicalCursor() {
              return cursor;
            },
            get cursorOffset() {
              return cursor.offset;
            },
            setText(value: string) {
              text = value;
            },
            setCursor(row: number, col: number) {
              cursor = { row, col, offset: col };
            },
            getSelection: () => null,
            clearSelection: vi.fn(),
            editBuffer: {
              getTextRange: (from: number, to: number) => text.slice(from, to),
            },
            scrollY: 0,
            visualCursor: { visualRow: 0 },
            editorView: { getTotalVirtualLineCount: () => 1 },
          };
        }, []);
        React.useImperativeHandle(ref, () => editor, [editor]);
        return null;
      },
    );
    FakeTextarea.displayName = 'VoiceTestTextarea';
    const jsx = (
      type: unknown,
      props: { children?: unknown; key?: React.Key } | null,
      key?: React.Key,
    ) => {
      const config = key === undefined ? props : { ...props, key };
      if (type === 'textarea') return React.createElement(FakeTextarea, config);
      if (typeof type === 'string')
        return React.createElement(
          type === 'text' ? 'span' : 'div',
          key === undefined ? null : { key },
          config?.children as React.ReactNode,
        );
      return React.createElement(
        type as React.ElementType,
        config as Record<string, unknown>,
        config?.children as React.ReactNode,
      );
    };
    return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
  }
  return {
    handlers,
    start,
    stop,
    warmup,
    microphoneStatus,
    transcribe,
    refine,
    fastModel,
    audioLevel,
    drain,
    stream,
    streamConfig,
    networkAllowed,
    clipboardHasImage,
    saveClipboardImage,
    state,
    renderer,
    buildJsxRuntime,
  };
});

vi.mock('@opentui/react', async () => {
  const { useLayoutEffect } = await import('react');
  return {
    useKeyboard: (handler: (key: KeyEvent) => void) => {
      useLayoutEffect(() => {
        mocks.handlers.add(handler);
        return () => {
          mocks.handlers.delete(handler);
        };
      }, [handler]);
    },
    useRenderer: () => mocks.renderer,
    useTerminalDimensions: () => mocks.state.dimensions,
  };
});
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentui/core')>();
  return {
    ...actual,
    resolveRenderLib: () => ({
      encodeUnicode: (text: string) => ({
        data: [{ width: getCachedStringWidth(text) }],
      }),
      freeUnicode: vi.fn(),
    }),
  };
});
vi.mock('../components/shared/text-buffer.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../components/shared/text-buffer.js')
    >();
  return {
    ...actual,
    useTextBuffer: (options: Parameters<typeof actual.useTextBuffer>[0]) => {
      const buffer = actual.useTextBuffer(options);
      mocks.state.buffer = buffer;
      return buffer;
    },
  };
});

// The real voice state machine runs; audio devices and transcription never do.
vi.mock('../voice/voice-recorder.js', () => ({
  createVoiceRecorder: () => ({
    start: mocks.start,
    stop: mocks.stop,
    warmup: mocks.warmup,
    microphoneStatus: mocks.microphoneStatus,
    audioLevel: mocks.audioLevel,
    supportsStreaming: () => true,
    drain: mocks.drain,
  }),
}));
vi.mock('../voice/voice-transcriber.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../voice/voice-transcriber.js')>()),
  transcribeVoiceAudio: mocks.transcribe,
  resolveVoiceStreamConfig: mocks.streamConfig,
  assertVoiceBaseUrlNetworkAllowed: mocks.networkAllowed,
}));
vi.mock('../voice/voice-refine.js', () => ({
  refineVoiceTranscript: mocks.refine,
}));
vi.mock('../utils/clipboardUtils.js', () => ({
  clipboardHasImage: mocks.clipboardHasImage,
  saveClipboardImage: mocks.saveClipboardImage,
  readClipboardText: async () => null,
  cleanupOldClipboardImages: async () => {},
  writeOsc52: () => {
    throw new Error('Unexpected clipboard write');
  },
}));
vi.mock('../voice/voice-stream-session.js', () => ({
  openVoiceStream: () => {
    throw new Error('Unexpected streaming transport in batch voice test');
  },
}));
vi.mock('../voice/qwen-asr-realtime-session.js', () => ({
  openQwenAsrRealtimeStream: mocks.stream,
}));
vi.mock('../hooks/useShellHistory.js', () => {
  const history: string[] = [];
  return {
    useShellHistory: () => ({
      history,
      addCommandToHistory: vi.fn(),
      getPreviousCommand: () => null,
      getNextCommand: () => null,
      resetHistoryPosition: vi.fn(),
    }),
  };
});
vi.mock('@qwen-code/qwen-code-core/utils/filesearch/fileSearch.js', () => ({
  FileSearchFactory: {
    create: () => ({
      initialize: async () => {},
      search: async () => [],
      dispose: vi.fn(),
    }),
  },
}));
vi.mock('../hooks/session-completion.js', () => ({
  getSessionSuggestions: async () => [],
}));
vi.mock('../hooks/extension-mention-ref.js', () => ({
  getExtensionSuggestions: () => [],
}));
vi.mock('./slash-dispatch.js', () => ({
  loadInteractiveCommands: async () => [],
}));
vi.mock('./commands-dispatch.js', () => ({
  OpenTuiSlashDispatcher: class {
    commands = [];
    async loadCommands() {}
    async mustDeferDuringStreaming() {
      return false;
    }
    takesAsSlashCommand(text: string) {
      return text.trim() === '/theme';
    }
    async handle(text: string) {
      return text.trim() === '/theme'
        ? { kind: 'open_dialog', request: { dialog: 'theme' } }
        : false;
    }
    dispose() {}
    cancel() {}
  },
}));
vi.mock('../hooks/useMcpApproval.js', () => ({
  useMcpApproval: () => ({
    isMcpApprovalDialogOpen: false,
    pendingMcpApprovals: [],
  }),
}));
vi.mock('../hooks/useWorktreeSession.js', () => ({
  useWorktreeSession: () => null,
}));
vi.mock('../hooks/useGitBranchName.js', () => ({
  useGitBranchName: () => null,
}));
vi.mock('../hooks/useStatusLine.js', () => ({
  useStatusLineState: () => ({ lines: [] }),
}));
vi.mock('./opentui-header.js', () => ({ OpenTuiBanner: () => null }));
vi.mock('./opentui-footer.js', () => ({
  OpenTuiFooter: () => null,
  OpenTuiLoadingIndicator: () => null,
}));
vi.mock('./opentui-dialog-mount.js', () => ({
  OpenTuiDialogMount: ({ onClose }: { onClose: () => void }) => {
    mocks.state.closeDialog = onClose;
    return 'owned-theme-dialog';
  },
}));
vi.mock('./dialogs-confirm.js', () => ({
  OpenTuiToolConfirmation: () => null,
  OpenTuiShellConfirmation: () => null,
  OpenTuiActionConfirmation: () => null,
  OpenTuiMcpApprovalDialog: () => null,
}));
vi.mock('./theme.js', () => ({ C: new Proxy({}, { get: () => '#ffffff' }) }));

const extensionManager = {
  setRequestConsent: vi.fn(),
  setRequestSetting: vi.fn(),
};
const config = {
  getExtensionManager: () => extensionManager,
  getSessionId: () => 'owned-voice-session',
  getContextFilePaths: () => [],
  getAccessibility: () => ({}),
  getTargetDir: () => '/owned-voice-workspace',
  getModel: () => 'owned-chat-model',
  getFastModel: mocks.fastModel,
  onModelChange: () => () => {},
} as unknown as Config;
const getSessionStats = () => ({}) as SessionStatsState;

function voiceSettings(enabled = true, mode: 'tap' | 'hold' = 'tap') {
  return {
    merged: {
      voiceModel: 'qwen3-asr-flash',
      general: { voice: { enabled, mode, refineTranscript: false } },
    },
  } as unknown as LoadedSettings;
}

function renderVoiceApp(
  enabled = true,
  overrides: Partial<Parameters<typeof OpenTuiApp>[0]> = {},
) {
  const submit = vi.fn<(text: unknown) => boolean>(() => true);
  const transcript =
    vi.fn<NonNullable<Parameters<typeof OpenTuiApp>[0]['onTranscriptEvent']>>();
  const props = {
    config,
    settings: voiceSettings(enabled),
    logger: null,
    commands: [],
    getSessionStats,
    onSubmitPrompt: submit,
    onTranscriptEvent: transcript,
    ...overrides,
  };
  const view = render(<OpenTuiApp {...props} />);
  return {
    ...view,
    submit,
    transcript,
    updateSettings: (settings: LoadedSettings) =>
      view.rerender(<OpenTuiApp {...props} settings={settings} />),
  };
}

async function pressKey(overrides: Partial<KeyEvent>) {
  const key = {
    name: '',
    sequence: '',
    ctrl: false,
    meta: false,
    shift: false,
    eventType: 'press',
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as KeyEvent;
  await act(async () => {
    for (const handler of [...mocks.handlers]) handler(key);
  });
  return key;
}

async function space() {
  await pressKey({ name: 'space', sequence: ' ' });
}

async function typeText(text: string) {
  for (const char of text) await pressKey({ name: char, sequence: char });
}

async function openThemeDialog() {
  await typeText('/theme');
  await pressKey({ name: 'return', sequence: '\r' });
  await waitFor(() =>
    expect(screen.getByText('owned-theme-dialog')).toBeTruthy(),
  );
}

async function closeThemeDialog() {
  await act(async () => mocks.state.closeDialog!());
  expect(screen.queryByText('owned-theme-dialog')).toBeNull();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.handlers.clear();
  mocks.state.buffer = null;
  mocks.state.closeDialog = null;
  mocks.state.dimensions = { width: 80, height: 24 };
  mocks.start.mockReset().mockResolvedValue(undefined);
  mocks.stop.mockReset().mockResolvedValue({
    data: new Uint8Array([1, 2, 3]),
    mimeType: 'audio/wav',
  });
  mocks.warmup.mockReset().mockResolvedValue(undefined);
  mocks.microphoneStatus.mockReset().mockResolvedValue('granted');
  mocks.transcribe.mockReset().mockResolvedValue('VOICE_甲🙂_OWNED');
  mocks.fastModel.mockReset().mockReturnValue(null);
  mocks.refine.mockReset().mockImplementation(() => {
    throw new Error('Unexpected refinement');
  });
  mocks.audioLevel.mockReset().mockReturnValue(0);
  mocks.drain.mockReset().mockReturnValue(new Uint8Array());
  mocks.stream.mockReset().mockImplementation(() => {
    throw new Error('Unexpected realtime transport');
  });
  mocks.streamConfig.mockReset().mockImplementation(() => {
    throw new Error('Unexpected streaming config');
  });
  mocks.networkAllowed.mockReset().mockImplementation(() => {
    throw new Error('Unexpected network policy');
  });
  mocks.clipboardHasImage.mockReset().mockResolvedValue(false);
  mocks.saveClipboardImage.mockReset().mockResolvedValue(null);
});

describe('OpenTUI voice input through the real shell and composer', () => {
  it.each([
    { width: 1, expected: '─' },
    { width: 5, expected: '─────' },
    { width: 6, expected: '─ … ──' },
  ])(
    'keeps the active voice border within $width columns',
    async ({ width, expected }) => {
      mocks.state.dimensions = { width, height: 24 };
      const submit = vi.fn(() => true);
      const { container } = render(
        <OpenTuiInputPrompt
          config={config}
          userMessages={[]}
          onSubmit={submit}
          voice={{ settings: voiceSettings() }}
        />,
      );
      await space();
      await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
      const root = container.firstElementChild;
      const borders = Array.from(root?.children ?? []).filter(
        (node) => node.tagName === 'SPAN',
      );
      expect(borders).toHaveLength(1);
      expect(borders[0]?.textContent).toBe(expected);
      expect(getCachedStringWidth(borders[0]?.textContent ?? '')).toBe(width);
      expect(mocks.state.buffer?.text).toBe('');
      expect(mocks.stop).not.toHaveBeenCalled();
      expect(mocks.transcribe).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it('respects actual composer focus before starting the shared voice hook', async () => {
    const props = {
      config,
      userMessages: [],
      onSubmit: vi.fn(() => true),
      voice: { settings: voiceSettings() },
    };
    const view = render(<OpenTuiInputPrompt {...props} focus={false} />);
    await space();
    expect(mocks.state.buffer?.text).toBe('');
    expect(mocks.start).not.toHaveBeenCalled();
    view.rerender(<OpenTuiInputPrompt {...props} focus />);
    await space();
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Voice: recording', { exact: false })).toBeTruthy();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('keeps Space owned by real Vim NORMAL and INSERT input before voice', async () => {
    const settings = {
      merged: { general: { vimMode: true } },
      setValue: vi.fn(),
    } as unknown as LoadedSettings;
    const voice = { settings: voiceSettings() };
    const submit = vi.fn(() => true);
    const userMessages: string[] = [];
    function VimOwner() {
      const liveBuffer = useRef<VimBuffer | null>(null);
      const composer = useRef<OpenTuiComposerHandle | null>(null);
      const buffer = useMemo(
        () => createVimBuffer(() => liveBuffer.current!),
        [],
      );
      const { handleInput, vimModeEnabled } = useVim(buffer, (text) => {
        void composer.current?.submitDraft?.(text);
      });
      const { vimMode } = useVimModeState();
      return (
        <>
          <span>{`actual-mode:${vimMode}`}</span>
          <OpenTuiInputPrompt
            config={config}
            userMessages={userMessages}
            onSubmit={submit}
            voice={voice}
            composerHandle={composer}
            vim={{ buffer: liveBuffer, handleInput, enabled: vimModeEnabled }}
          />
        </>
      );
    }
    render(
      <VimModeProvider settings={settings}>
        <VimOwner />
      </VimModeProvider>,
    );
    expect(screen.getByText('actual-mode:NORMAL')).toBeTruthy();
    await space();
    expect(mocks.state.buffer?.text).toBe('');
    expect(mocks.start).not.toHaveBeenCalled();
    await typeText('i');
    expect(screen.getByText('actual-mode:INSERT')).toBeTruthy();
    await space();
    expect(mocks.state.buffer?.text).toBe(' ');
    expect(mocks.start).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('enters actual CtrlR search and edits the search query instead of recording', async () => {
    const submit = vi.fn(() => true);
    render(
      <OpenTuiInputPrompt
        config={config}
        userMessages={['HISTORY_OWNED']}
        onSubmit={submit}
        voice={{ settings: voiceSettings() }}
      />,
    );
    await pressKey({ name: 'r', sequence: '\x12', ctrl: true });
    await waitFor(() => expect(screen.getByText('(r:)')).toBeTruthy());
    expect(screen.getByText('HISTORY_OWNED')).toBeTruthy();
    await space();
    expect(mocks.state.buffer?.text).toBe(' ');
    expect(screen.getByText('(r:)')).toBeTruthy();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await pressKey({ name: 'escape', sequence: '\x1b' });
    expect(mocks.state.buffer?.text).toBe('');
    await space();
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
  });

  it('selects an actual clipboard attachment and leaves Space with its composer owner', async () => {
    mocks.clipboardHasImage.mockResolvedValue(true);
    mocks.saveClipboardImage.mockResolvedValue(
      '/owned-clipboard/VOICE_IMAGE.png',
    );
    const { submit } = renderVoiceApp();
    await pressKey({ name: 'v', sequence: '\x16', ctrl: true });
    await waitFor(() =>
      expect(screen.getByText('📎 VOICE_IMAGE.png')).toBeTruthy(),
    );
    expect(mocks.state.buffer?.text).toBe('');
    await pressKey({ name: 'up', sequence: '\x1b[A' });
    expect(screen.getByText('> VOICE_IMAGE.png')).toBeTruthy();
    await space();
    expect(mocks.state.buffer?.text).toBe(' ');
    expect(screen.getByText('📎 VOICE_IMAGE.png')).toBeTruthy();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('waits for real hook transcription then configured refinement before one exact submission', async () => {
    const transcription = deferred<string>();
    const refinement = deferred<string>();
    mocks.fastModel.mockReturnValue('owned-fast-model');
    mocks.transcribe.mockReturnValue(transcription.promise);
    mocks.refine.mockReturnValue(refinement.promise);
    const settings = {
      merged: {
        voiceModel: 'qwen3-asr-flash',
        general: {
          voice: { enabled: true, mode: 'tap', refineTranscript: true },
        },
      },
    } as unknown as LoadedSettings;
    const { submit } = renderVoiceApp(true, { settings });
    await space();
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    await space();
    expect(
      screen.getByText('Voice: transcribing', { exact: false }),
    ).toBeTruthy();
    expect(mocks.refine).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await act(async () => transcription.resolve('RAW_甲🙂'));
    await waitFor(() =>
      expect(
        screen.getByText('Voice: refining', { exact: false }),
      ).toBeTruthy(),
    );
    expect(mocks.refine).toHaveBeenCalledWith(
      config,
      'RAW_甲🙂',
      expect.any(AbortSignal),
    );
    expect(mocks.state.buffer?.text).toBe('');
    expect(submit).not.toHaveBeenCalled();
    await act(async () => refinement.resolve('REFINED_甲🙂'));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]?.[0]).toBe('REFINED_甲🙂');
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.transcribe).toHaveBeenCalledTimes(1);
    expect(mocks.state.buffer?.text).toBe('');
  });

  it('polls the actual recorder meter and projects its level without changing the prompt', async () => {
    const { submit } = renderVoiceApp();
    await space();
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    expect(screen.getByText('░░░░░░░░░░░░░░░░')).toBeTruthy();
    mocks.audioLevel.mockReturnValue(1 / 24);
    await waitFor(() =>
      expect(screen.getByText('████████░░░░░░░░')).toBeTruthy(),
    );
    expect(mocks.audioLevel).toHaveBeenCalled();
    expect(mocks.state.buffer?.text).toBe('');
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('connects the real streaming hook to interim rendering and final-only submission', async () => {
    let callbacks: VoiceStreamCallbacks | undefined;
    const session = {
      pushAudio: vi.fn(),
      finish: vi.fn().mockResolvedValue('STREAM_FINAL_甲🙂'),
      abort: vi.fn(),
    };
    const streamConfig = {
      transport: 'qwen-asr-realtime',
      baseUrl: 'https://owned.invalid',
      model: 'qwen3-asr-flash-realtime',
    };
    mocks.streamConfig.mockReturnValue(streamConfig);
    mocks.networkAllowed.mockResolvedValue(undefined);
    mocks.stream.mockImplementation(
      async (_config, supplied: VoiceStreamCallbacks) => {
        callbacks = supplied;
        return session;
      },
    );
    mocks.drain.mockReturnValueOnce(new Uint8Array([7, 8]));
    const settings = {
      merged: {
        voiceModel: 'qwen3-asr-flash-realtime',
        general: {
          voice: { enabled: true, mode: 'tap', refineTranscript: false },
        },
      },
    } as unknown as LoadedSettings;
    const { submit } = renderVoiceApp(true, { settings });
    await space();
    await waitFor(() => expect(mocks.stream).toHaveBeenCalledTimes(1));
    expect(mocks.streamConfig).toHaveBeenCalledWith({
      config,
      settings,
      voiceModel: 'qwen3-asr-flash-realtime',
    });
    expect(mocks.networkAllowed).toHaveBeenCalledWith(streamConfig);
    expect(callbacks?.onInterim).toBeTypeOf('function');
    await act(async () => callbacks!.onInterim!('INTERIM_甲🙂\x1b[31m'));
    expect(screen.getByText('INTERIM_甲🙂\\u001b[31m')).toBeTruthy();
    expect(document.body.textContent).not.toContain('\x1b');
    expect(mocks.state.buffer?.text).toBe('');
    expect(submit).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(session.pushAudio).toHaveBeenCalledWith(new Uint8Array([7, 8])),
    );
    await space();
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]?.[0]).toBe('STREAM_FINAL_甲🙂');
    expect(session.finish).toHaveBeenCalledTimes(1);
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(mocks.state.buffer?.text).toBe('');
  });

  it('starts tap recording on empty-prompt Space, then submits the exact transcription', async () => {
    const { submit } = renderVoiceApp();
    expect(mocks.state.buffer?.text).toBe('');
    expect(mocks.handlers.size).toBeGreaterThanOrEqual(2);
    await space();
    await waitFor(() =>
      expect(
        mocks.start,
        `Space must record rather than enter the composer: ${JSON.stringify(mocks.state.buffer?.text)}`,
      ).toHaveBeenCalledTimes(1),
    );
    expect(mocks.start).toHaveBeenCalledWith({
      silenceDetection: true,
      onAutoStop: expect.any(Function),
    });
    expect(mocks.state.buffer?.text).toBe('');
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByText('Voice: recording', { exact: false })).toBeTruthy();
    await space();
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.transcribe).toHaveBeenCalledWith(
      { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
      { config, settings: expect.anything(), voiceModel: 'qwen3-asr-flash' },
    );
    expect(submit.mock.calls[0]?.[0]).toBe('VOICE_甲🙂_OWNED');
    expect(mocks.state.buffer?.text).toBe('');
  });

  it('keeps ordinary Space when voice is disabled', async () => {
    const { submit } = renderVoiceApp(false);
    await space();
    expect(mocks.state.buffer?.text).toBe(' ');
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps ordinary Space after existing prompt text', async () => {
    const { submit } = renderVoiceApp();
    await act(async () => {
      mocks.state.buffer!.setText('hello');
    });
    await space();
    expect(mocks.state.buffer?.text).toBe('hello ');
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    { modifier: 'Shift', key: { shift: true } },
    { modifier: 'Ctrl', key: { ctrl: true } },
    { modifier: 'Meta', key: { meta: true } },
  ])(
    'keeps $modifier+Return in the logical draft while recording',
    async ({ key }) => {
      const { submit } = renderVoiceApp();
      await space();
      await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
      for (const char of 'VOICE_DRAFT') {
        await pressKey({ name: char, sequence: char });
      }
      expect(mocks.state.buffer?.text).toBe('VOICE_DRAFT');
      const newline = await pressKey({
        name: 'return',
        sequence: '\r',
        ...key,
      });
      expect(mocks.state.buffer?.text).toBe('VOICE_DRAFT\n');
      expect(mocks.state.buffer?.cursor).toEqual([1, 0]);
      expect(newline.preventDefault).toHaveBeenCalled();
      expect(mocks.start).toHaveBeenCalledTimes(1);
      expect(mocks.stop).not.toHaveBeenCalled();
      expect(mocks.transcribe).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
      expect(
        screen.getByText('Voice: recording', { exact: false }),
      ).toBeTruthy();
    },
  );

  it.each([
    { key: 'Escape', event: { name: 'escape', sequence: '\x1b' } },
    { key: 'Ctrl+C', event: { name: 'c', sequence: '\x03', ctrl: true } },
  ])(
    'drops a late transcript after $key cancels the actual composer',
    async ({ event }) => {
      const pending = deferred<string>();
      mocks.transcribe.mockImplementation(() => pending.promise);
      const { submit } = renderVoiceApp();
      await space();
      await space();
      await waitFor(() =>
        expect(
          screen.getByText('Voice: transcribing', { exact: false }),
        ).toBeTruthy(),
      );
      const cancel = await pressKey(event);
      await waitFor(() =>
        expect(
          screen.queryByText('Voice: transcribing', { exact: false }),
        ).toBeNull(),
      );
      expect(cancel.preventDefault).toHaveBeenCalled();
      await act(async () => {
        pending.resolve('LATE_CANCELLED_TRANSCRIPT');
        await pending.promise;
      });
      expect(mocks.state.buffer?.text).toBe('');
      expect(submit).not.toHaveBeenCalled();
      await space();
      await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
      expect(
        screen.getByText('Voice: recording', { exact: false }),
      ).toBeTruthy();
    },
  );

  it('cancels pending transcription when loaded voice settings are disabled', async () => {
    const pending = deferred<string>();
    mocks.transcribe.mockImplementation(() => pending.promise);
    const { submit, updateSettings } = renderVoiceApp();
    await space();
    await space();
    await waitFor(() =>
      expect(
        screen.getByText('Voice: transcribing', { exact: false }),
      ).toBeTruthy(),
    );
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    updateSettings(voiceSettings(false));
    await waitFor(() =>
      expect(
        screen.queryByText('Voice: transcribing', { exact: false }),
      ).toBeNull(),
    );
    await act(async () => {
      pending.resolve('LATE_DISABLED_TRANSCRIPT');
      await pending.promise;
    });
    expect(mocks.state.buffer?.text).toBe('');
    expect(submit).not.toHaveBeenCalled();
    await space();
    expect(mocks.state.buffer?.text).toBe(' ');
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(2);
  });

  it('stops capture when the actual composer unmounts without transcribing', async () => {
    const { unmount, submit } = renderVoiceApp();
    await space();
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    unmount();
    await waitFor(() => expect(mocks.stop).toHaveBeenCalledTimes(1));
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('does not write an old transcript into the composer remounted after a dialog', async () => {
    const pending = deferred<string>();
    mocks.transcribe.mockImplementation(() => pending.promise);
    const { submit } = renderVoiceApp();
    await space();
    await space();
    await waitFor(() =>
      expect(
        screen.getByText('Voice: transcribing', { exact: false }),
      ).toBeTruthy(),
    );
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    const oldBuffer = mocks.state.buffer;
    await openThemeDialog();
    await closeThemeDialog();
    expect(mocks.state.buffer).not.toBe(oldBuffer);
    await typeText('FRESH_DRAFT');
    await act(async () => {
      pending.resolve('LATE_OLD_COMPOSER_TRANSCRIPT');
      await pending.promise;
    });
    expect(mocks.state.buffer?.text).toBe('FRESH_DRAFT');
    expect(submit).not.toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalledTimes(2);
  });

  it('uses loaded hold mode to insert released dictation without submitting', async () => {
    vi.useFakeTimers();
    try {
      const { submit } = renderVoiceApp(true, {
        settings: voiceSettings(true, 'hold'),
      });
      await space();
      expect(mocks.start).toHaveBeenCalledWith({
        silenceDetection: false,
        onAutoStop: expect.any(Function),
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(mocks.state.buffer?.text).toBe('VOICE_甲🙂_OWNED');
      expect(mocks.stop).toHaveBeenCalledTimes(1);
      expect(mocks.transcribe).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps permission notices session-owned across composer remounts', async () => {
    mocks.microphoneStatus.mockResolvedValue('prompt');
    const { transcript } = renderVoiceApp();
    expect(mocks.microphoneStatus).not.toHaveBeenCalled();
    expect(transcript).not.toHaveBeenCalled();
    await space();
    await waitFor(() =>
      expect(transcript).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'info',
          text: expect.stringContaining('needs microphone access'),
        }),
      ),
    );
    await pressKey({ name: 'escape', sequence: '\x1b' });
    await openThemeDialog();
    await closeThemeDialog();
    await space();
    await waitFor(() =>
      expect(mocks.microphoneStatus).toHaveBeenCalledTimes(2),
    );
    expect(
      transcript.mock.calls.filter(([event]) =>
        JSON.stringify(event).includes('needs microphone access'),
      ),
    ).toHaveLength(1);
    await pressKey({ name: 'escape', sequence: '\x1b' });
    mocks.microphoneStatus.mockResolvedValue('denied');
    await space();
    await waitFor(() =>
      expect(transcript).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          text: expect.stringContaining('Microphone access is denied'),
        }),
      ),
    );
    expect(
      transcript.mock.calls.filter(([event]) =>
        JSON.stringify(event).includes('Microphone access is denied'),
      ),
    ).toHaveLength(1);
  });

  it('leaves Space with shell input instead of starting voice capture', async () => {
    const { submit } = renderVoiceApp();
    await typeText('!');
    expect(screen.getByText('!')).toBeTruthy();
    await space();
    expect(mocks.state.buffer?.text).toBe(' ');
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});
