/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canShareScreen, startScreenShare } from './screen-share';

const MAX_IMAGE_BYTES = 190 * 1024;

/** Captured before any spy replaces it. */
const createElement = document.createElement;

interface FakeCanvas {
  width: number;
  height: number;
  getContext: ReturnType<typeof vi.fn>;
  toBlob: (
    callback: (blob: Blob | null) => void,
    type: string,
    quality: number,
  ) => void;
}

/** Every encode attempt: what was drawn, and at what quality. */
const attempts: Array<{
  width: number;
  height: number;
  quality: number;
  bytes: number;
}> = [];

/**
 * Stands in for JPEG: a size that falls with both quality and pixel count, so
 * the ladder has something realistic to converge against.
 */
let bytesFor = (width: number, height: number, quality: number): number =>
  Math.round(width * height * quality * 0.02);

const track = {
  label: 'Terminal — build.log',
  stop: vi.fn(),
  onended: null as null | (() => void),
};
const stream = {
  getVideoTracks: () => [track],
  getTracks: () => [track],
};
const getDisplayMedia = vi.fn();
let video: HTMLVideoElement;

/**
 * A real element, so appending and removing it exercise the same DOM the
 * browser would; only the parts jsdom has no media stack for are stubbed.
 */
function fakeVideo(width = 1920, height = 1080): HTMLVideoElement {
  const element = createElement.call(document, 'video') as HTMLVideoElement;
  Object.defineProperty(element, 'videoWidth', { value: width });
  Object.defineProperty(element, 'videoHeight', { value: height });
  element.play = vi.fn(async () => {});
  return element;
}

function fakeCanvas(): FakeCanvas {
  const canvas: FakeCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      imageSmoothingQuality: '',
      drawImage: vi.fn(),
    })),
    toBlob: (callback, _type, quality) => {
      const bytes = bytesFor(canvas.width, canvas.height, quality);
      attempts.push({
        width: canvas.width,
        height: canvas.height,
        quality,
        bytes,
      });
      callback({
        arrayBuffer: () => Promise.resolve(new Uint8Array(bytes).buffer),
      } as unknown as Blob);
    },
  };
  return canvas;
}

beforeEach(() => {
  attempts.length = 0;
  bytesFor = (width, height, quality) =>
    Math.round(width * height * quality * 0.02);
  track.stop.mockReset();
  track.onended = null;
  getDisplayMedia.mockReset();
  getDisplayMedia.mockResolvedValue(stream);
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getDisplayMedia },
    configurable: true,
  });
  Object.defineProperty(window, 'isSecureContext', {
    value: true,
    configurable: true,
  });
  video = fakeVideo();
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag === 'video') return video;
    if (tag === 'canvas') return fakeCanvas() as unknown as HTMLElement;
    return createElement.call(document, tag);
  }) as typeof document.createElement);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('canShareScreen', () => {
  it('is false without getDisplayMedia', () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {},
      configurable: true,
    });
    expect(canShareScreen()).toBe(false);
  });

  it('is false outside a secure context, where the call would reject', () => {
    Object.defineProperty(window, 'isSecureContext', {
      value: false,
      configurable: true,
    });
    expect(canShareScreen()).toBe(false);
  });

  it('is true where a screen can be asked for', () => {
    expect(canShareScreen()).toBe(true);
  });
});

describe('startScreenShare', () => {
  it('asks for video only: a Live call already owns the microphone', async () => {
    await startScreenShare(() => {});
    expect(getDisplayMedia).toHaveBeenCalledWith({
      video: true,
      audio: false,
    });
  });

  it('keeps native resolution when it already fits', async () => {
    const share = await startScreenShare(() => {});

    const frame = await share.grab();

    expect(frame).toMatchObject({ width: 1920, height: 1080 });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ width: 1920, quality: 0.9 });
  });

  it('caps a very large display before the first encode', async () => {
    video = fakeVideo(5120, 2880);
    const share = await startScreenShare(() => {});

    const frame = await share.grab();

    expect(Math.max(frame.width, frame.height)).toBeLessThanOrEqual(2560);
  });

  it('gives back a frame within the daemon limit and stops there', async () => {
    // Dense enough that the first attempt overshoots.
    bytesFor = (width, height, quality) =>
      Math.round(width * height * quality * 0.25);
    const share = await startScreenShare(() => {});

    const frame = await share.grab();

    const last = attempts.at(-1)!;
    expect(last.bytes).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(frame.width).toBe(last.width);
    // Aimed by the overshoot rather than walked down a fixed ladder.
    expect(attempts.length).toBeLessThanOrEqual(3);
    expect(attempts[1]!.width).toBeLessThan(attempts[0]!.width);
    expect(attempts[1]!.quality).toBeLessThan(attempts[0]!.quality);
  });

  it('refuses rather than sending a screen nothing could read', async () => {
    // No scale within reach gets under the limit.
    bytesFor = () => MAX_IMAGE_BYTES * 40;
    const share = await startScreenShare(() => {});

    await expect(share.grab()).rejects.toThrow('too detailed');
  });

  it('reports the share ending and refuses later frames', async () => {
    const onEnded = vi.fn();
    const share = await startScreenShare(onEnded);

    track.onended?.();

    expect(onEnded).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalled();
    await expect(share.grab()).rejects.toThrow('no longer shared');
  });

  it('stops every track once, however often it is stopped', async () => {
    const onEnded = vi.fn();
    const share = await startScreenShare(onEnded);

    share.stop();
    share.stop();

    expect(track.stop).toHaveBeenCalledTimes(1);
    // Stopping on our side is not an ending to report back to the page.
    expect(onEnded).not.toHaveBeenCalled();
  });

  it('leaves nothing of itself in the page', async () => {
    const share = await startScreenShare(() => {});
    // It has to be in the document while sharing: a detached element is not
    // reliably decoded, and `drawImage` would return a blank frame.
    expect(video.isConnected).toBe(true);

    share.stop();

    expect(video.isConnected).toBe(false);
    expect(video.srcObject).toBeNull();
  });

  it('names what is shared so the dialog can show it', async () => {
    const share = await startScreenShare(() => {});
    expect(share.label).toBe('Terminal — build.log');
  });

  it('releases the stream when the display produces no video track', async () => {
    getDisplayMedia.mockResolvedValue({
      getVideoTracks: () => [],
      getTracks: () => [track],
    });

    await expect(startScreenShare(() => {})).rejects.toThrow(
      'carried no video',
    );
    expect(track.stop).toHaveBeenCalled();
  });
});
