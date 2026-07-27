// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceButton } from './VoiceButton';
import type {
  UseVoiceCaptureOptions,
  UseVoiceCaptureReturn,
} from './useVoiceCapture';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  settingsVersion: 0,
  workspaceVoice: vi.fn(),
  onFinal: undefined as UseVoiceCaptureOptions['onFinal'] | undefined,
  workspace: {
    baseUrl: 'http://127.0.0.1:1234',
    token: undefined as string | undefined,
    capabilities: { features: ['voice_transcribe'] },
    client: {
      workspaceVoice: vi.fn(),
    },
  },
  capture: {
    status: 'idle' as UseVoiceCaptureReturn['status'],
    interimText: '',
    audioLevel: 0,
    errorMessage: undefined as string | undefined,
    start: vi.fn(),
    stop: vi.fn(),
    abort: vi.fn(),
  },
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useWorkspace: () => mocks.workspace,
  useWorkspaceEventSignals: () => ({
    settingsVersion: mocks.settingsVersion,
  }),
}));

vi.mock('./useVoiceCapture', () => ({
  useVoiceCapture: (options: UseVoiceCaptureOptions): UseVoiceCaptureReturn => {
    mocks.onFinal = options.onFinal;
    return mocks.capture as unknown as UseVoiceCaptureReturn;
  },
}));

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function voiceStatus(enabled: boolean) {
  return {
    v: 1 as const,
    workspaceCwd: '/tmp/workspace',
    enabled,
    mode: 'hold' as const,
    language: 'en',
    voiceModel: null,
    availableVoiceModels: [],
  };
}

function mount(disabled: boolean, onActiveChange?: (active: boolean) => void) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <VoiceButton
        disabled={disabled}
        onInsert={() => {}}
        onActiveChange={onActiveChange}
      />,
    );
  });
  mounted.push({ root, container });
  return { root, container };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function render(disabled: boolean): Promise<HTMLButtonElement> {
  const { container } = mount(disabled);
  await flush();
  const button = container.querySelector('button');
  if (!button) throw new Error('VoiceButton did not render');
  return button;
}

const click = (button: HTMLButtonElement) => {
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

beforeEach(() => {
  mocks.settingsVersion = 0;
  mocks.workspace.capabilities.features = ['voice_transcribe'];
  mocks.workspace.client = {
    workspaceVoice: mocks.workspaceVoice,
  };
  mocks.workspaceVoice.mockReset();
  mocks.workspaceVoice.mockResolvedValue(voiceStatus(true));
  mocks.onFinal = undefined;
  mocks.capture.status = 'idle';
  mocks.capture.interimText = '';
  mocks.capture.audioLevel = 0;
  mocks.capture.errorMessage = undefined;
  mocks.capture.start.mockReset();
  mocks.capture.stop.mockReset();
  mocks.capture.abort.mockReset();
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
});

describe('VoiceButton', () => {
  it('renders only when workspace voice is enabled', async () => {
    expect(await render(false)).not.toBeNull();

    mocks.workspaceVoice.mockResolvedValue(voiceStatus(false));
    const { container } = mount(false);
    await flush();

    expect(container.querySelector('button')).toBeNull();
  });

  it('stays hidden while the workspace voice request is pending or fails', async () => {
    let rejectVoice: (reason?: unknown) => void = () => undefined;
    mocks.workspaceVoice.mockReturnValue(
      new Promise((_, reject) => {
        rejectVoice = reject;
      }),
    );
    const { container } = mount(false);

    expect(container.querySelector('button')).toBeNull();

    await act(async () => {
      rejectVoice(new Error('voice status unavailable'));
      await Promise.resolve();
    });
    expect(container.querySelector('button')).toBeNull();
  });

  it('does not request workspace voice without the daemon capability', async () => {
    mocks.workspace.capabilities.features = [];
    const { container } = mount(false);
    await flush();

    expect(container.querySelector('button')).toBeNull();
    expect(mocks.workspaceVoice).not.toHaveBeenCalled();
  });

  it('reloads workspace voice when settings change', async () => {
    mocks.workspaceVoice.mockResolvedValue(voiceStatus(false));
    const { root, container } = mount(false);
    await flush();
    expect(container.querySelector('button')).toBeNull();

    mocks.settingsVersion = 1;
    mocks.workspaceVoice.mockResolvedValue(voiceStatus(true));
    act(() => {
      root.render(<VoiceButton disabled={false} onInsert={() => {}} />);
    });
    expect(container.querySelector('button')).toBeNull();
    await flush();
    expect(container.querySelector('button')).not.toBeNull();

    mocks.settingsVersion = 2;
    mocks.workspaceVoice.mockResolvedValue(voiceStatus(false));
    act(() => {
      root.render(<VoiceButton disabled={false} onInsert={() => {}} />);
    });
    expect(container.querySelector('button')).toBeNull();
    await flush();
    expect(container.querySelector('button')).toBeNull();
  });

  it('ignores a stale workspace voice response', async () => {
    let resolveFirst: (value: ReturnType<typeof voiceStatus>) => void = () =>
      undefined;
    mocks.workspaceVoice.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    const { root, container } = mount(false);

    mocks.settingsVersion = 1;
    mocks.workspaceVoice.mockResolvedValueOnce(voiceStatus(false));
    act(() => {
      root.render(<VoiceButton disabled={false} onInsert={() => {}} />);
    });
    await flush();

    await act(async () => {
      resolveFirst(voiceStatus(true));
      await Promise.resolve();
    });
    expect(container.querySelector('button')).toBeNull();
  });

  it('waits for the current workspace client voice status', async () => {
    const { root, container } = mount(false);
    await flush();
    expect(container.querySelector('button')).not.toBeNull();

    let resolveNext: (value: ReturnType<typeof voiceStatus>) => void = () =>
      undefined;
    const workspaceVoice = vi.fn(
      () =>
        new Promise<ReturnType<typeof voiceStatus>>((resolve) => {
          resolveNext = resolve;
        }),
    );
    mocks.workspace.client = { workspaceVoice };
    act(() => {
      root.render(<VoiceButton disabled={false} onInsert={() => {}} />);
    });

    expect(container.querySelector('button')).toBeNull();
    expect(workspaceVoice).toHaveBeenCalledOnce();

    await act(async () => {
      resolveNext(voiceStatus(true));
      await Promise.resolve();
    });
    expect(container.querySelector('button')).not.toBeNull();
  });

  it('aborts active capture when the voice gate reloads', async () => {
    const { root, container } = mount(false);
    await flush();
    expect(container.querySelector('button')).not.toBeNull();

    mocks.capture.status = 'recording';
    act(() => {
      root.render(<VoiceButton disabled={false} onInsert={() => {}} />);
    });
    expect(mocks.capture.abort).not.toHaveBeenCalled();

    mocks.settingsVersion = 1;
    mocks.workspaceVoice.mockReturnValue(new Promise(() => undefined));
    act(() => {
      root.render(<VoiceButton disabled={false} onInsert={() => {}} />);
    });

    expect(container.querySelector('button')).toBeNull();
    expect(mocks.capture.abort).toHaveBeenCalledOnce();
  });

  it('lets a disabled composer stop active dictation', async () => {
    mocks.capture.status = 'recording';
    const button = await render(true);

    expect(button.disabled).toBe(false);
    click(button);

    expect(mocks.capture.stop).toHaveBeenCalledOnce();
  });

  it('lets a disabled composer abort a connecting dictation', async () => {
    mocks.capture.status = 'connecting';
    const button = await render(true);

    expect(button.disabled).toBe(false);
    click(button);

    expect(mocks.capture.abort).toHaveBeenCalledOnce();
  });

  it('reports whether voice capture is active', async () => {
    const onActiveChange = vi.fn();
    const { root } = mount(false, onActiveChange);
    await flush();
    expect(onActiveChange).toHaveBeenLastCalledWith(false);

    mocks.capture.status = 'connecting';
    act(() => {
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          onActiveChange={onActiveChange}
        />,
      );
    });
    expect(onActiveChange).toHaveBeenLastCalledWith(true);

    mocks.capture.status = 'idle';
    act(() => {
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          onActiveChange={onActiveChange}
        />,
      );
    });
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
  });

  it('clears the no-speech notice after two seconds', async () => {
    vi.useFakeTimers();
    const { container } = mount(false);
    await flush();

    act(() => {
      mocks.onFinal?.('');
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'voice.noSpeech',
    );

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('keeps disabled idle dictation from starting', async () => {
    const button = await render(true);

    expect(button.disabled).toBe(true);

    expect(mocks.capture.start).not.toHaveBeenCalled();
  });
});
