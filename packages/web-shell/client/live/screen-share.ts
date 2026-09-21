/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The screen the user shares with a Live call, and the single frame the model
 * gets when it asks to look.
 *
 * Sharing and looking are deliberately separate. `getDisplayMedia` needs a user
 * gesture, and the model asks in the middle of a turn, so the stream is opened
 * once by a click and kept; each request then pulls one frame from it. The user
 * decides what is shareable, the model decides when a look is worth it, and
 * stopping the share ends both.
 */

/** The daemon rejects anything larger; see MAX_HOST_VISUAL_IMAGE_BYTES. */
const MAX_IMAGE_BYTES = 190 * 1024;

/**
 * Native resolution is kept when it fits, which it does for the screens people
 * actually ask about: a 1080p editor or terminal lands near 120 KiB at q=0.9,
 * and reads back verbatim. Only a dense screen needs shrinking.
 */
const MAX_START_EDGE = 2560;

/** Below this a screenshot stops being worth sending at all. */
const MIN_EDGE = 480;

/**
 * Highest first. Pixels buy far more legibility than JPEG quality does, so a
 * frame that does not fit at the top gives quality away to keep its size.
 *
 * Measured on a glyph-packed 1080p editor and terminal, every candidate filling
 * the same 190 KiB: at 871x490 q=0.75 two vision models misread the stack trace
 * and one invented a symbol; at 959x539 q=0.90 both still got the line numbers
 * wrong; at 1494x840 q=0.45 both transcribed every character correctly. Below
 * that quality the artefacts start costing what the extra pixels win, which is
 * where this ladder stops.
 */
const QUALITY_STEPS = [0.9, 0.75, 0.6, 0.45] as const;

/** Cheap insurance against a pathological image pinning the main thread. */
const MAX_ENCODES = 8;

export interface LiveScreenFrame {
  image: string;
  width: number;
  height: number;
}

export interface LiveScreenShareHandle {
  readonly label: string;
  stop(): void;
  grab(): Promise<LiveScreenFrame>;
}

export type LiveScreenShareEnded = () => void;

/**
 * Browsers without `getDisplayMedia`, and any page outside a secure context,
 * never offer the share at all rather than failing at the first request.
 */
export function canShareScreen(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
    (typeof window === 'undefined' || window.isSecureContext !== false)
  );
}

function encode(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality),
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary);
}

/**
 * Must be called from a user gesture: `getDisplayMedia` rejects without one.
 */
export async function startScreenShare(
  onEnded: LiveScreenShareEnded,
): Promise<LiveScreenShareHandle> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  });
  const [track] = stream.getVideoTracks();
  if (!track) {
    for (const other of stream.getTracks()) other.stop();
    throw new Error('The shared screen carried no video.');
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  // Kept in the document, because a detached element is not reliably decoded
  // and `display: none` stops decoding outright — either way `drawImage` would
  // quietly yield a blank frame. One transparent pixel is invisible instead.
  video.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
  video.setAttribute('aria-hidden', 'true');
  document.body.appendChild(video);
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    track.onended = null;
    for (const other of stream.getTracks()) other.stop();
    video.srcObject = null;
    video.remove();
  };
  // The browser's own "Stop sharing" control ends the track behind our back.
  track.onended = () => {
    stop();
    onEnded();
  };

  try {
    await video.play();
    // Chromium reports 0x0 until the first frame is decoded.
    if (!video.videoWidth || !video.videoHeight) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('The shared screen produced no frame.')),
          5_000,
        );
        video.addEventListener(
          'loadeddata',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  } catch (error) {
    stop();
    throw error;
  }

  const canvas = document.createElement('canvas');

  const grab = async (): Promise<LiveScreenFrame> => {
    if (stopped) throw new Error('The screen is no longer shared.');
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) {
      throw new Error('The shared screen produced no frame.');
    }
    const longest = Math.max(sourceWidth, sourceHeight);
    const cap = Math.min(1, MAX_START_EDGE / longest);
    let encodes = 0;

    /**
     * One encode. The bytes are returned raw: base64 is only worth paying for
     * on the frame that is actually sent, and a first pass over a dense 4K
     * screen can be several megabytes of it.
     */
    const at = async (
      scale: number,
      quality: number,
    ): Promise<{ bytes: Uint8Array; width: number; height: number }> => {
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This browser cannot read the screen.');
      context.imageSmoothingQuality = 'high';
      context.drawImage(video, 0, 0, width, height);
      encodes += 1;
      const blob = await encode(canvas, quality);
      if (stopped) throw new Error('The screen is no longer shared.');
      if (!blob) throw new Error('The screen could not be encoded.');
      return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
    };

    const deliver = (attempt: {
      bytes: Uint8Array;
      width: number;
      height: number;
    }): LiveScreenFrame => ({
      image: toBase64(attempt.bytes),
      width: attempt.width,
      height: attempt.height,
    });

    /** The largest scale at this quality that fits, or nothing that does. */
    const largestThatFits = async (quality: number) => {
      let scale = cap;
      while (encodes < MAX_ENCODES) {
        const attempt = await at(scale, quality);
        if (attempt.bytes.byteLength <= MAX_IMAGE_BYTES) return attempt;
        // JPEG size tracks pixel count closely enough to aim the next try
        // rather than stepping blindly down a ladder of sizes.
        scale *= Math.sqrt(MAX_IMAGE_BYTES / attempt.bytes.byteLength) * 0.95;
        if (longest * scale < MIN_EDGE) return undefined;
      }
      return undefined;
    };

    // The common screen fits as it is, and gets the one encode it used to.
    const native = await at(cap, QUALITY_STEPS[0]);
    if (native.bytes.byteLength <= MAX_IMAGE_BYTES) return deliver(native);

    // It does not fit, so spend quality on keeping pixels. Lower quality is
    // never larger at the same scale, so the most pixels are always available
    // at the bottom of the ladder — no need to walk the steps between.
    const floor = QUALITY_STEPS[QUALITY_STEPS.length - 1]!;
    const roomiest = await largestThatFits(floor);
    if (!roomiest) throw new Error('The screen was too detailed to send.');

    // If the bottom step did not have to shrink at all, the limit was never
    // about pixels, and the quality it gave away buys nothing. Take it back.
    if (roomiest.width >= Math.round(sourceWidth * cap)) {
      // The top step is skipped: the probe above already ruled it out.
      // No encode budget check here: this loop is bounded by the quality
      // ladder itself, and `largestThatFits` has already spent at most one
      // step. A guard that cannot fire is a claim a reader has to go and
      // disprove.
      for (const quality of QUALITY_STEPS.slice(1, -1)) {
        const attempt = await at(cap, quality);
        if (attempt.bytes.byteLength <= MAX_IMAGE_BYTES)
          return deliver(attempt);
      }
    }
    return deliver(roomiest);
  };

  return {
    label: track.label || 'screen',
    stop,
    grab,
  };
}
