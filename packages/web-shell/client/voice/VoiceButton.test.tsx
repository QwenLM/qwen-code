// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceButton } from './VoiceButton';
import type { UseVoiceCaptureReturn } from './useVoiceCapture';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  workspace: {
    baseUrl: 'http://127.0.0.1:1234',
    token: undefined as string | undefined,
    capabilities: { features: ['voice_transcribe'] },
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
}));

vi.mock('./useVoiceCapture', () => ({
  useVoiceCapture: (): UseVoiceCaptureReturn =>
    mocks.capture as unknown as UseVoiceCaptureReturn,
}));

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function render(disabled: boolean): HTMLButtonElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<VoiceButton disabled={disabled} onInsert={() => {}} />);
  });
  mounted.push({ root, container });
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
});

describe('VoiceButton', () => {
  it('lets a disabled composer stop active dictation', () => {
    mocks.capture.status = 'recording';
    const button = render(true);

    expect(button.disabled).toBe(false);
    click(button);

    expect(mocks.capture.stop).toHaveBeenCalledOnce();
  });

  it('lets a disabled composer abort a connecting dictation', () => {
    mocks.capture.status = 'connecting';
    const button = render(true);

    expect(button.disabled).toBe(false);
    click(button);

    expect(mocks.capture.abort).toHaveBeenCalledOnce();
  });

  it('keeps disabled idle dictation from starting', () => {
    const button = render(true);

    expect(button.disabled).toBe(true);

    expect(mocks.capture.start).not.toHaveBeenCalled();
  });
});
