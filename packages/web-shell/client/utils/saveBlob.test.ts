// @vitest-environment jsdom

import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleNativeDownload, saveBlob } from './saveBlob.js';

type Reply = {
  v: number;
  id: string;
  state: string;
  offset?: number;
  error?: string;
};

function installBridge(finish = true) {
  let listener: ((event: MessageEvent) => void) | undefined;
  let id = '';
  const frames: Uint8Array[] = [];
  const reply = (state: string, extra: Partial<Reply> = {}) =>
    listener?.(
      new MessageEvent('message', {
        data: JSON.stringify({ v: 1, id, state, ...extra }),
      }),
    );
  const bridge = {
    postMessage: vi.fn((message: string | ArrayBuffer) => {
      if (typeof message === 'string') {
        const command = JSON.parse(message) as {
          v: number;
          id: string;
          op: string;
          mime?: string;
        };
        id = command.id;
        if (
          command.v !== 1 ||
          (command.op === 'begin' && typeof command.mime !== 'string')
        ) {
          reply('error', { error: 'Invalid download metadata.' });
          return;
        }
        if (command.op === 'begin') reply('ready');
        if (command.op === 'finish') {
          reply('choosing');
          if (finish) reply('saved');
        }
      } else {
        const frame = new Uint8Array(message);
        frames.push(frame);
        reply('chunk', {
          offset: new DataView(message).getUint32(32) + frame.length - 36,
        });
      }
    }),
    addEventListener: vi.fn(
      (_type: string, next: (event: MessageEvent) => void) => {
        listener = next;
      },
    ),
    removeEventListener: vi.fn(() => {
      listener = undefined;
    }),
  };
  Object.assign(window, { qwenAndroidDownloadV1: bridge });
  return { bridge, frames, reply };
}

describe('saveBlob', () => {
  afterEach(() => {
    delete (window as { qwenAndroidDownloadV1?: unknown })
      .qwenAndroidDownloadV1;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('isolates browser download clicks and defers object-URL cleanup', async () => {
    vi.useFakeTimers();
    const create = vi.fn().mockReturnValue('blob:export');
    const revoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
    const clicked: HTMLAnchorElement[] = [];
    const hostClick = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener('click', hostClick);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
      expect(this.isConnected).toBe(true);
      expect(
        this.dispatchEvent(
          new Event('click', { bubbles: true, cancelable: true }),
        ),
      ).toBe(true);
    });
    const blob = new Blob(['export']);
    try {
      await saveBlob(blob, 'session.html');
      expect(create).toHaveBeenCalledWith(blob);
      expect(clicked).toHaveLength(1);
      expect(clicked[0]?.download).toBe('session.html');
      expect(clicked[0]?.href).toBe('blob:export');
      expect(clicked[0]?.isConnected).toBe(false);
      expect(hostClick).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(999);
      expect(revoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:export');
    } finally {
      window.removeEventListener('click', hostClick);
    }
  });

  it('transfers exact binary bytes in bounded, identified, ordered frames', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    const { bridge, frames } = installBridge();
    const bytes = Uint8Array.from(
      { length: 140_123 },
      (_, index) => index % 256,
    );
    const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    await saveBlob(
      new Blob([bytes], { type: 'application/octet-stream' }),
      'binary.bin',
    );
    const begin = JSON.parse(bridge.postMessage.mock.calls[0][0] as string) as {
      v: number;
      id: string;
      op: string;
      size: number;
      name: string;
      mime: string;
    };
    expect(begin).toMatchObject({
      v: 1,
      op: 'begin',
      size: bytes.length,
      name: 'binary.bin',
      mime: 'application/octet-stream',
    });
    expect(begin.id).toMatch(/^[a-f0-9]{32}$/);
    const result = new Uint8Array(bytes.length);
    frames.forEach((frame, index) => {
      expect(frame.length).toBeLessThanOrEqual(65_572);
      expect(new TextDecoder().decode(frame.slice(0, 32))).toBe(begin.id);
      expect(new DataView(frame.buffer).getUint32(32)).toBe(index * 65_536);
      result.set(frame.slice(36), index * 65_536);
    });
    expect(result).toEqual(bytes);
    expect(frames).toHaveLength(3);
    expect(
      JSON.parse(bridge.postMessage.mock.calls.at(-1)![0] as string),
    ).toEqual({
      v: 1,
      id: begin.id,
      op: 'finish',
    });
    expect(anchor).not.toHaveBeenCalled();
    expect(bridge.removeEventListener).toHaveBeenCalledOnce();
  });

  it('supports empty files without an invalid empty binary frame', async () => {
    const { frames } = installBridge();
    await saveBlob(new Blob([]), 'empty.txt');
    expect(frames).toHaveLength(0);
  });

  it('preserves whole Unicode code points when limiting download names', async () => {
    const { bridge } = installBridge();
    const prefix = 'a'.repeat(254);
    await saveBlob(new Blob([]), `${prefix}😀suffix.txt`);
    expect(
      JSON.parse(bridge.postMessage.mock.calls[0][0] as string),
    ).toMatchObject({
      op: 'begin',
      name: `${prefix}😀`,
    });
  });

  it('rejects oversize files before opening native saving', async () => {
    const { bridge } = installBridge();
    await expect(
      saveBlob(new Blob([new Uint8Array(16 * 1024 * 1024 + 1)]), 'large'),
    ).rejects.toThrow('16 MiB');
    expect(bridge.postMessage).not.toHaveBeenCalled();
  });

  it('accepts exactly 16 MiB through 256 acknowledged chunks', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    const { bridge, frames } = installBridge();
    await expect(
      saveBlob(new Blob([new Uint8Array(16 * 1024 * 1024)]), 'max.bin'),
    ).resolves.toBeUndefined();
    expect(frames).toHaveLength(256);
    expect(frames.every((frame) => frame.length === 65_572)).toBe(true);
    expect(
      JSON.parse(bridge.postMessage.mock.calls[0][0] as string),
    ).toMatchObject({
      v: 1,
      op: 'begin',
      size: 16 * 1024 * 1024,
      mime: '',
    });
    expect(bridge.removeEventListener).toHaveBeenCalledOnce();
  });

  it('waits for the user without a picker timeout and rejects concurrent exports', async () => {
    vi.useFakeTimers();
    const { bridge, reply } = installBridge(false);
    const save = saveBlob(new Blob([]), 'empty');
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(saveBlob(new Blob([]), 'other')).rejects.toThrow(
      'still active',
    );
    expect(bridge.removeEventListener).not.toHaveBeenCalled();
    reply('cancelled');
    await save;
    const next = saveBlob(new Blob([]), 'next');
    await vi.advanceTimersByTimeAsync(0);
    reply('saved');
    await next;
  });

  it('propagates native failures without browser fallback', async () => {
    const { bridge, reply } = installBridge();
    const post = bridge.postMessage.getMockImplementation()!;
    bridge.postMessage.mockImplementation((message) => {
      if (typeof message === 'string' && message.includes('"op":"finish"'))
        reply('error', { error: 'Destination denied' });
      else post(message);
    });
    const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    await expect(saveBlob(new Blob([]), 'empty')).rejects.toThrow(
      'Destination denied',
    );
    expect(anchor).not.toHaveBeenCalled();
  });

  it('ignores foreign operation responses and times out a stalled transfer', async () => {
    vi.useFakeTimers();
    const { bridge, reply } = installBridge();
    bridge.postMessage.mockImplementation(() =>
      reply('ready', { id: 'foreign' }),
    );
    const save = saveBlob(new Blob([]), 'empty');
    void save.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(save).rejects.toThrow('timed out');
    expect(bridge.removeEventListener).toHaveBeenCalledOnce();
  });

  it('cancels native saving when its source is invalidated while the picker is open', async () => {
    vi.useFakeTimers();
    const { bridge } = installBridge(false);
    let cancelled = false;
    const isCancelled = vi.fn(() => cancelled);
    const save = saveBlob(new Blob([]), 'empty', isCancelled);
    await vi.advanceTimersByTimeAsync(0);
    cancelled = true;
    void save.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(251);
    await expect(save).rejects.toThrow('no longer active');
    expect(bridge.postMessage.mock.calls.at(-1)?.[0]).toContain(
      '"op":"cancel"',
    );
    const callsAtSettle = isCancelled.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(isCancelled).toHaveBeenCalledTimes(callsAtSettle);
    expect(bridge.removeEventListener).toHaveBeenCalledOnce();
  });

  it('rejects incorrect acknowledged offsets', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    const original = installBridge();
    const post = original.bridge.postMessage.getMockImplementation()!;
    original.bridge.postMessage.mockImplementation((message) => {
      if (typeof message === 'string') post(message);
      else original.reply('chunk', { offset: 999 });
    });
    await expect(saveBlob(new Blob(['x']), 'bad')).rejects.toThrow(
      'acknowledgement',
    );
  });

  it('retains cancellation received while a Blob chunk is being read', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    const { bridge, reply, frames } = installBridge();
    let finishRead: ((value: ArrayBuffer) => void) | undefined;
    vi.spyOn(NodeBlob.prototype, 'arrayBuffer').mockImplementation(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          finishRead = resolve;
        }),
    );
    const save = saveBlob(new Blob(['x']), 'cancelled');
    await vi.waitFor(() => expect(finishRead).toBeDefined());
    reply('cancelled');
    finishRead!(new Uint8Array([120]).buffer);
    await save;
    expect(frames).toHaveLength(0);
    expect(bridge.postMessage).toHaveBeenCalledTimes(1);
  });

  it('retains native failure received while a Blob chunk is being read', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    const { bridge, reply, frames } = installBridge();
    let finishRead: ((value: ArrayBuffer) => void) | undefined;
    vi.spyOn(NodeBlob.prototype, 'arrayBuffer').mockImplementation(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          finishRead = resolve;
        }),
    );
    const save = saveBlob(new Blob(['x']), 'failed');
    await vi.waitFor(() => expect(finishRead).toBeDefined());
    reply('error', { error: 'Destination denied' });
    finishRead!(new Uint8Array([120]).buffer);
    await expect(save).rejects.toThrow('Destination denied');
    expect(frames).toHaveLength(0);
    expect(bridge.postMessage).toHaveBeenCalledTimes(2);
    const begin = JSON.parse(bridge.postMessage.mock.calls[0][0] as string) as {
      id: string;
    };
    expect(JSON.parse(bridge.postMessage.mock.calls[1][0] as string)).toEqual({
      v: 1,
      id: begin.id,
      op: 'cancel',
    });
    expect(bridge.removeEventListener).toHaveBeenCalledOnce();
  });

  it('cancels invalidated anchor exports without reporting an error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Blob', NodeBlob);
    const { bridge, frames, reply } = installBridge();
    const post = bridge.postMessage.getMockImplementation()!;
    bridge.postMessage.mockImplementation((message) => {
      if (typeof message === 'string') post(message);
      else frames.push(new Uint8Array(message));
    });
    const anchor = document.createElement('a');
    anchor.href = 'blob:preview';
    const onError = vi.fn();
    let cancelled = false;
    handleNativeDownload(
      { currentTarget: anchor, preventDefault: vi.fn() },
      onError,
      () => cancelled,
      new Blob([new Uint8Array(65_537)]),
    );
    try {
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      cancelled = true;
      await vi.advanceTimersByTimeAsync(251);
      await vi.waitFor(() =>
        expect(bridge.postMessage.mock.calls.at(-1)?.[0]).toContain(
          '"op":"cancel"',
        ),
      );
      expect(frames).toHaveLength(1);
      expect(bridge.removeEventListener).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      reply('cancelled');
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it('uses original Blob bytes and reports missing data without a CSP-blocked fetch', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    const { frames } = installBridge();
    const anchor = document.createElement('a');
    anchor.href = 'blob:preview';
    anchor.download = 'image.png';
    const onError = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    handleNativeDownload(
      { currentTarget: anchor, preventDefault: vi.fn() },
      onError,
      undefined,
      new Blob(['image']),
    );
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(new TextDecoder().decode(frames[0].slice(36))).toBe('image');
    expect(onError).not.toHaveBeenCalled();
    handleNativeDownload(
      { currentTarget: anchor, preventDefault: vi.fn() },
      onError,
    );
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            'The original download data is unavailable. Reopen the file or save it in a browser.',
        }),
      ),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves ordinary links untouched and never fetches remote URLs through native saving', async () => {
    const anchor = document.createElement('a');
    anchor.href = 'https://example.com/file';
    const event = { currentTarget: anchor, preventDefault: vi.fn() };
    const onError = vi.fn();
    handleNativeDownload(event, onError);
    expect(event.preventDefault).not.toHaveBeenCalled();
    installBridge();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    handleNativeDownload(event, onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('decodes image data locally without a CSP-blocked data URL fetch', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    const { frames } = installBridge();
    const anchor = document.createElement('a');
    anchor.href = 'data:image/png;base64,AP8B';
    anchor.download = 'image.png';
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const onError = vi.fn();
    handleNativeDownload(
      { currentTarget: anchor, preventDefault: vi.fn() },
      onError,
    );
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(Array.from(frames[0].slice(36))).toEqual([0, 255, 1]);
    expect(onError).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('decodes percent-encoded data locally without fetching', async () => {
    vi.stubGlobal('Blob', NodeBlob);
    const { bridge, frames } = installBridge();
    const anchor = document.createElement('a');
    anchor.href = 'data:text/plain,a%20b';
    anchor.download = 'text.txt';
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const onError = vi.fn();
    handleNativeDownload(
      { currentTarget: anchor, preventDefault: vi.fn() },
      onError,
    );
    await vi.waitFor(() =>
      expect(bridge.removeEventListener).toHaveBeenCalledOnce(),
    );
    expect(frames).toHaveLength(1);
    expect(new TextDecoder().decode(frames[0].slice(36))).toBe('a b');
    expect(onError).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
