// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceButton } from './VoiceButton';
import type {
  UseVoiceCaptureOptions,
  UseVoiceCaptureReturn,
} from './useVoiceCapture';
import type { VoiceWorkspaceTarget } from './voice-workspace-target';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  settingsVersion: 0,
  connection: {
    sessionId: 'session-1',
    workspaceCwd: '/tmp/workspace',
  },
  workspaceVoice: vi.fn(),
  onFinal: undefined as UseVoiceCaptureOptions['onFinal'] | undefined,
  qualifiedWorkspaceVoice: vi.fn(),
  workspaceById: vi.fn(),
  captureOptions: undefined as UseVoiceCaptureOptions | undefined,
  workspace: {
    baseUrl: 'http://127.0.0.1:1234',
    token: undefined as string | undefined,
    capabilities: { features: ['voice_transcribe'] },
    refreshCapabilities: vi.fn(),
    client: {
      workspaceVoice: vi.fn(),
      workspaceById: vi.fn(),
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

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => mocks.connection,
  useWorkspace: () => mocks.workspace,
  useWorkspaceEventSignals: () => ({
    settingsVersion: mocks.settingsVersion,
  }),
}));

vi.mock('./useVoiceCapture', () => ({
  useVoiceCapture: (options: UseVoiceCaptureOptions): UseVoiceCaptureReturn => {
    mocks.onFinal = options.onFinal;
    mocks.captureOptions = options;
    return mocks.capture as unknown as UseVoiceCaptureReturn;
  },
}));

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function voiceStatus(
  enabled: boolean,
  workspaceCwd = '/tmp/workspace',
  mode: 'hold' | 'tap' = 'hold',
) {
  return {
    v: 1 as const,
    workspaceCwd,
    enabled,
    mode,
    language: 'en',
    voiceModel: null,
    availableVoiceModels: [],
  };
}

function mount(
  disabled: boolean,
  target: VoiceWorkspaceTarget | undefined = legacyTarget,
  onActiveChange?: (active: boolean) => void,
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <VoiceButton
        disabled={disabled}
        onInsert={() => {}}
        target={target}
        onActiveChange={onActiveChange}
      />,
    );
  });
  mounted.push({ root, container });
  return { root, container };
}

const legacyTarget = {
  route: 'legacy-primary' as const,
  cwd: '/tmp/workspace',
  workspaceKey: 'primary',
  ownerKey: 'primary:session-1',
  sessionId: 'session-1',
  streamPath: 'voice/stream' as const,
};

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

const click = (button: HTMLButtonElement, detail = 1) => {
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
  });
};

const pointer = (
  button: HTMLButtonElement,
  type: 'pointerdown' | 'pointerup' | 'pointercancel',
  pointerId = 1,
  mouseButton = 0,
  timeStamp?: number,
) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: mouseButton,
  });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  if (timeStamp !== undefined) {
    Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  }
  act(() => {
    button.dispatchEvent(event);
  });
};

beforeEach(() => {
  mocks.settingsVersion = 0;
  mocks.connection.sessionId = 'session-1';
  mocks.connection.workspaceCwd = '/tmp/workspace';
  mocks.workspace.capabilities.features = ['voice_transcribe'];
  mocks.workspace.refreshCapabilities.mockReset();
  mocks.workspace.refreshCapabilities.mockResolvedValue(undefined);
  mocks.workspace.client = {
    workspaceVoice: mocks.workspaceVoice,
    workspaceById: mocks.workspaceById,
  };
  mocks.workspaceVoice.mockReset();
  mocks.workspaceVoice.mockResolvedValue(voiceStatus(true));
  mocks.onFinal = undefined;
  mocks.qualifiedWorkspaceVoice.mockReset();
  mocks.qualifiedWorkspaceVoice.mockResolvedValue(
    voiceStatus(true, '/tmp/secondary'),
  );
  mocks.workspaceById.mockReset();
  mocks.workspaceById.mockReturnValue({
    workspaceVoice: mocks.qualifiedWorkspaceVoice,
  });
  mocks.captureOptions = undefined;
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
    expect(warn).toHaveBeenCalledWith(
      '[web-shell] Voice status probe failed:',
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('does not request workspace voice without the daemon capability', async () => {
    mocks.workspace.capabilities.features = [];
    const { container } = mount(false);
    await flush();

    expect(container.querySelector('button')).toBeNull();
    expect(mocks.workspaceVoice).not.toHaveBeenCalled();
  });

  it('uses the qualified status and stream path without legacy capability tags', async () => {
    mocks.workspace.capabilities.features = ['workspace_qualified_voice'];
    const target: VoiceWorkspaceTarget = {
      route: 'workspace-qualified',
      cwd: '/tmp/secondary',
      workspaceKey: 'secondary',
      ownerKey: 'secondary:session-2',
      sessionId: 'session-2',
      selector: { kind: 'id', value: 'secondary-id' },
      streamPath: 'workspaces/secondary-id/voice/stream',
    };
    mocks.connection.sessionId = 'session-2';
    mocks.connection.workspaceCwd = '/tmp/secondary';

    const { container } = mount(false, target);
    await flush();

    expect(container.querySelector('button')).not.toBeNull();
    expect(mocks.workspaceById).toHaveBeenCalledWith('secondary-id');
    expect(mocks.qualifiedWorkspaceVoice).toHaveBeenCalledOnce();
    expect(mocks.workspaceVoice).not.toHaveBeenCalled();
    expect(mocks.captureOptions?.target).toEqual({
      ownerKey: target.ownerKey,
      streamPath: target.streamPath,
    });
  });

  it('reloads workspace voice when settings change', async () => {
    mocks.workspaceVoice.mockResolvedValue(voiceStatus(false));
    const { root, container } = mount(false);
    await flush();
    expect(container.querySelector('button')).toBeNull();

    mocks.settingsVersion = 1;
    mocks.workspaceVoice.mockResolvedValue(voiceStatus(true));
    act(() => {
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          target={legacyTarget}
        />,
      );
    });
    expect(container.querySelector('button')).toBeNull();
    await flush();
    expect(container.querySelector('button')).not.toBeNull();

    mocks.settingsVersion = 2;
    mocks.workspaceVoice.mockResolvedValue(voiceStatus(false));
    act(() => {
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          target={legacyTarget}
        />,
      );
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
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          target={legacyTarget}
        />,
      );
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
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          target={legacyTarget}
        />,
      );
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
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          target={legacyTarget}
        />,
      );
    });
    expect(mocks.capture.abort).not.toHaveBeenCalled();

    mocks.settingsVersion = 1;
    mocks.workspaceVoice.mockReturnValue(new Promise(() => undefined));
    act(() => {
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          target={legacyTarget}
        />,
      );
    });

    expect(container.querySelector('button')).toBeNull();
    expect(mocks.capture.abort).toHaveBeenCalledOnce();
    expect(mocks.captureOptions?.target).toEqual({
      ownerKey: legacyTarget.ownerKey,
      streamPath: legacyTarget.streamPath,
    });
  });

  it('keeps recording when an equivalent target object is rebuilt', async () => {
    const { root, container } = mount(false);
    await flush();
    expect(container.querySelector('button')).not.toBeNull();

    mocks.capture.status = 'recording';
    act(() => {
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          target={{ ...legacyTarget }}
        />,
      );
    });

    expect(container.querySelector('button')).not.toBeNull();
    expect(mocks.workspaceVoice).toHaveBeenCalledOnce();
    expect(mocks.capture.abort).not.toHaveBeenCalled();
  });

  it('keeps the capture owner while an unexpected close revalidates status', async () => {
    const { container } = mount(false);
    await flush();
    expect(container.querySelector('button')).not.toBeNull();
    mocks.workspaceVoice.mockReturnValue(new Promise(() => undefined));

    act(() => {
      mocks.captureOptions?.onUnexpectedClose?.({
        code: 1006,
        reason: 'network',
      });
    });

    expect(container.querySelector('button')).toBeNull();
    expect(mocks.captureOptions?.target).toEqual({
      ownerKey: legacyTarget.ownerKey,
      streamPath: legacyTarget.streamPath,
    });
  });

  it('keeps the status gate and retry visible after a capacity close', async () => {
    mocks.capture.status = 'error';
    mocks.capture.errorMessage = 'Voice is busy';
    const { container } = mount(false);
    await flush();
    expect(container.querySelector('button')).not.toBeNull();
    expect(mocks.workspaceVoice).toHaveBeenCalledOnce();

    act(() => {
      mocks.captureOptions?.onUnexpectedClose?.({
        code: 1013,
        reason: 'capacity',
      });
    });

    expect(container.querySelector('button')).not.toBeNull();
    expect(mocks.workspaceVoice).toHaveBeenCalledOnce();
    expect(mocks.captureOptions?.target).toEqual({
      ownerKey: legacyTarget.ownerKey,
      streamPath: legacyTarget.streamPath,
    });
  });

  it('ignores a completed capability refresh from a previous owner', async () => {
    mocks.workspace.capabilities.features = ['workspace_qualified_voice'];
    mocks.qualifiedWorkspaceVoice.mockResolvedValue(
      voiceStatus(true, '/tmp/secondary-a'),
    );
    let resolveRefresh: () => void = () => undefined;
    mocks.workspace.refreshCapabilities.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const targetA: VoiceWorkspaceTarget = {
      route: 'workspace-qualified',
      cwd: '/tmp/secondary-a',
      workspaceKey: 'secondary-a',
      ownerKey: 'secondary-a:session-a',
      sessionId: 'session-a',
      selector: { kind: 'id', value: 'secondary-a' },
      streamPath: 'workspaces/secondary-a/voice/stream',
    };
    const targetB: VoiceWorkspaceTarget = {
      route: 'workspace-qualified',
      cwd: '/tmp/secondary-b',
      workspaceKey: 'secondary-b',
      ownerKey: 'secondary-b:session-b',
      sessionId: 'session-b',
      selector: { kind: 'id', value: 'secondary-b' },
      streamPath: 'workspaces/secondary-b/voice/stream',
    };
    const { root, container } = mount(false, targetA);
    await flush();
    expect(container.querySelector('button')).not.toBeNull();

    act(() => {
      mocks.captureOptions?.onUnexpectedClose?.({
        code: 1012,
        reason: 'workspace removed',
      });
    });
    expect(mocks.workspace.refreshCapabilities).toHaveBeenCalledOnce();

    mocks.connection.sessionId = 'session-b';
    mocks.connection.workspaceCwd = '/tmp/secondary-b';
    mocks.qualifiedWorkspaceVoice.mockResolvedValue(
      voiceStatus(true, '/tmp/secondary-b'),
    );
    act(() => {
      root.render(
        <VoiceButton disabled={false} onInsert={() => {}} target={targetB} />,
      );
    });
    await flush();
    expect(container.querySelector('button')).not.toBeNull();

    mocks.capture.status = 'recording';
    act(() => {
      root.render(
        <VoiceButton disabled={false} onInsert={() => {}} target={targetB} />,
      );
    });
    mocks.capture.abort.mockClear();
    const statusRequestCount = mocks.qualifiedWorkspaceVoice.mock.calls.length;

    await act(async () => {
      resolveRefresh();
      await Promise.resolve();
    });

    expect(container.querySelector('button')).not.toBeNull();
    expect(mocks.capture.abort).not.toHaveBeenCalled();
    expect(mocks.qualifiedWorkspaceVoice).toHaveBeenCalledTimes(
      statusRequestCount,
    );
    expect(mocks.captureOptions?.target).toEqual({
      ownerKey: targetB.ownerKey,
      streamPath: targetB.streamPath,
    });
  });

  it('revalidates the same owner after a successful 1012 refresh', async () => {
    const { container } = mount(false);
    await flush();
    expect(container.querySelector('button')).not.toBeNull();
    mocks.workspaceVoice.mockResolvedValue(voiceStatus(false));

    act(() => {
      mocks.captureOptions?.onUnexpectedClose?.({
        code: 1012,
        reason: 'daemon restart',
      });
    });
    await flush();

    expect(mocks.workspace.refreshCapabilities).toHaveBeenCalledOnce();
    expect(mocks.workspaceVoice).toHaveBeenCalledTimes(2);
    expect(container.querySelector('button')).toBeNull();
  });

  it('revalidates the same owner when a 1012 refresh fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.workspace.refreshCapabilities.mockRejectedValue(
      new Error('refresh failed'),
    );
    const { root, container } = mount(false);
    await flush();
    expect(container.querySelector('button')).not.toBeNull();
    mocks.workspaceVoice.mockRejectedValueOnce(
      new Error('voice status still unavailable'),
    );

    act(() => {
      mocks.captureOptions?.onUnexpectedClose?.({
        code: 1012,
        reason: 'workspace removed',
      });
    });
    await flush();

    expect(mocks.workspace.refreshCapabilities).toHaveBeenCalledOnce();
    expect(mocks.workspaceVoice).toHaveBeenCalledTimes(2);
    expect(container.querySelector('button')).toBeNull();

    mocks.settingsVersion += 1;
    act(() => {
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          target={legacyTarget}
        />,
      );
    });
    await flush();

    expect(mocks.workspaceVoice).toHaveBeenCalledTimes(3);
    expect(container.querySelector('button')).not.toBeNull();
    expect(mocks.captureOptions?.target).toEqual({
      ownerKey: legacyTarget.ownerKey,
      streamPath: legacyTarget.streamPath,
    });
    warn.mockRestore();
  });

  it('lets a disabled composer stop active dictation', async () => {
    mocks.workspaceVoice.mockResolvedValue(
      voiceStatus(true, '/tmp/workspace', 'tap'),
    );
    mocks.capture.status = 'recording';
    const button = await render(true);

    expect(button.disabled).toBe(false);
    click(button);

    expect(mocks.capture.stop).toHaveBeenCalledOnce();
  });

  it('lets a disabled composer abort a connecting dictation', async () => {
    mocks.workspaceVoice.mockResolvedValue(
      voiceStatus(true, '/tmp/workspace', 'tap'),
    );
    mocks.capture.status = 'connecting';
    const button = await render(true);
    mocks.capture.abort.mockClear();

    expect(button.disabled).toBe(false);
    click(button);

    expect(mocks.capture.abort).toHaveBeenCalledOnce();
  });

  it('holds to start and releases to stop dictation', async () => {
    const { root, container } = mount(false);
    await flush();
    let button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');
    const heldButton = button;

    pointer(button, 'pointerdown', 1, 0, 1_000);
    expect(mocks.capture.start).toHaveBeenCalledOnce();

    mocks.capture.status = 'recording';
    act(() => {
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          target={legacyTarget}
        />,
      );
    });
    button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');
    // The recording pill reuses the icon button's DOM node, so the pointer
    // capture set on pointerdown survives the status change and the release
    // still lands on this element.
    expect(button).toBe(heldButton);
    pointer(button, 'pointerup', 1, 0, 1_500);
    click(button);

    expect(mocks.capture.stop).toHaveBeenCalledOnce();
  });

  it('keeps the hold click suppressed after a rejected pointerdown', async () => {
    const { root, container } = mount(false);
    await flush();
    let button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');

    pointer(button, 'pointerdown', 1, 0, 1_000);
    mocks.capture.status = 'connecting';
    act(() => {
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          target={legacyTarget}
        />,
      );
    });
    button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');
    pointer(button, 'pointerdown', 2, 0, 1_100);
    pointer(button, 'pointerup', 1, 0, 1_500);
    click(button);

    expect(mocks.capture.stop).toHaveBeenCalledOnce();
    expect(mocks.capture.abort).not.toHaveBeenCalled();
  });

  it('keeps a quick hold active as a tap', async () => {
    const { root, container } = mount(false);
    await flush();
    let button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');
    pointer(button, 'pointerdown', 1, 0, 1_000);

    mocks.capture.status = 'recording';
    act(() => {
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          target={legacyTarget}
        />,
      );
    });
    button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');
    pointer(button, 'pointerup', 1, 0, 1_100);
    click(button);

    expect(mocks.capture.stop).not.toHaveBeenCalled();
    expect(mocks.capture.abort).not.toHaveBeenCalled();
    click(button);
    expect(mocks.capture.stop).toHaveBeenCalledOnce();
  });

  it('honours a stop click after a quick hold released outside', async () => {
    const { root, container } = mount(false);
    await flush();
    let button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');
    pointer(button, 'pointerdown', 1, 0, 1_000);

    mocks.capture.status = 'recording';
    act(() => {
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          target={legacyTarget}
        />,
      );
    });
    button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');
    // Release outside: pointer capture delivers pointerup to the button, but
    // the trailing click lands elsewhere — ignoreNextClickRef leaks.
    mocks.capture.stop.mockClear();
    pointer(button, 'pointerup', 1, 0, 1_100);
    const outside = document.createElement('button');
    click(outside);

    // A real click on the button must still stop the recording.
    button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');
    pointer(button, 'pointerdown', 1, 0, 2_000);
    click(button);
    expect(mocks.capture.stop).toHaveBeenCalledOnce();
  });

  it('aborts a hold when the pointer is cancelled', async () => {
    const { root, container } = mount(false);
    await flush();
    let button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');
    pointer(button, 'pointerdown');

    mocks.capture.status = 'connecting';
    act(() => {
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          target={legacyTarget}
        />,
      );
    });
    button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');
    pointer(button, 'pointercancel');

    expect(mocks.capture.abort).toHaveBeenCalledOnce();
  });

  it('aborts a hold cancelled during recording', async () => {
    const { root, container } = mount(false);
    await flush();
    let button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');
    pointer(button, 'pointerdown');

    mocks.capture.status = 'recording';
    act(() => {
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          target={legacyTarget}
        />,
      );
    });
    button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');
    pointer(button, 'pointercancel');

    expect(mocks.capture.abort).toHaveBeenCalledOnce();
  });

  it('ignores a pointerup from a different pointer', async () => {
    const { root, container } = mount(false);
    await flush();
    let button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');
    pointer(button, 'pointerdown', 1);

    mocks.capture.status = 'recording';
    act(() => {
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          target={legacyTarget}
        />,
      );
    });
    button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');
    pointer(button, 'pointerup', 2);

    expect(mocks.capture.stop).not.toHaveBeenCalled();
  });

  it('ignores a pointercancel from a different pointer', async () => {
    const { root, container } = mount(false);
    await flush();
    let button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');
    pointer(button, 'pointerdown', 1);

    mocks.capture.status = 'connecting';
    act(() => {
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          target={legacyTarget}
        />,
      );
    });
    button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');
    pointer(button, 'pointercancel', 2);

    expect(mocks.capture.abort).not.toHaveBeenCalled();
  });

  it('keeps click-to-toggle behavior in tap mode', async () => {
    mocks.workspaceVoice.mockResolvedValue(
      voiceStatus(true, '/tmp/workspace', 'tap'),
    );
    const { root, container } = mount(false);
    await flush();
    let button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');

    click(button);
    expect(mocks.capture.start).toHaveBeenCalledOnce();

    mocks.capture.status = 'recording';
    act(() => {
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          target={legacyTarget}
        />,
      );
    });
    button = container.querySelector('button');
    if (!button) throw new Error('VoiceButton did not render');
    click(button);

    expect(mocks.capture.stop).toHaveBeenCalledOnce();
  });

  it('ignores pointer hold in tap mode', async () => {
    mocks.workspaceVoice.mockResolvedValue(
      voiceStatus(true, '/tmp/workspace', 'tap'),
    );
    const button = await render(false);
    pointer(button, 'pointerdown');
    expect(mocks.capture.start).not.toHaveBeenCalled();
  });

  it('ignores mouse click in hold mode', async () => {
    const button = await render(false);

    click(button); // detail defaults to 1 (real pointer click)

    expect(mocks.capture.start).not.toHaveBeenCalled();
  });

  it('allows keyboard activation in hold mode', async () => {
    const button = await render(false);

    click(button, 0);

    expect(mocks.capture.start).toHaveBeenCalledOnce();
  });

  it('ignores a non-primary pointer in hold mode', async () => {
    const button = await render(false);
    pointer(button, 'pointerdown', 1, 2);
    expect(mocks.capture.start).not.toHaveBeenCalled();
  });

  it('reports whether voice capture is active', async () => {
    const onActiveChange = vi.fn();
    const { root } = mount(false, legacyTarget, onActiveChange);
    await flush();
    expect(onActiveChange).toHaveBeenLastCalledWith(false);

    mocks.capture.status = 'connecting';
    act(() => {
      root.render(
        <VoiceButton
          disabled={false}
          onInsert={() => {}}
          target={legacyTarget}
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
          target={legacyTarget}
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
