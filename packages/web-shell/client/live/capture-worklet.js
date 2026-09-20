/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live Voice microphone capture, on the audio rendering thread.
 *
 * Loaded with `audioWorklet.addModule()` from a same-origin URL, so it has to
 * stay a single import-free classic-compatible file: no bundling, no TypeScript,
 * nothing from the rest of the client. It collects the 128-sample render quanta
 * into frames, converts each frame to little-endian PCM16 and measures its RMS
 * here, and posts `{ pcm, level }` with the buffer transferred. The main thread
 * is left with one WebSocket send per frame, so a busy page delays audio
 * instead of glitching it, which is what the ScriptProcessorNode path does.
 *
 * The PCM conversion and the RMS must stay identical to `floatToPcm16` in
 * `../voice/capture-utils.ts`; `capture-worklet.test.ts` pins the two together.
 */
/* global AudioWorkletProcessor, registerProcessor */

class QwenLiveCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const frameSize = options?.processorOptions?.frameSize;
    this.frameSize =
      Number.isInteger(frameSize) && frameSize > 0 ? frameSize : 1024;
    this.frame = new Float32Array(this.frameSize);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    // No input connected yet, or the source ended: keep the node alive.
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(
        this.frameSize - this.filled,
        channel.length - offset,
      );
      this.frame.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.frameSize) {
        this.flush();
      }
    }
    return true;
  }

  flush() {
    const input = this.frame;
    const pcm = new Int16Array(input.length);
    let sumSquares = 0;
    for (let i = 0; i < input.length; i++) {
      let s = input[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      sumSquares += s * s;
    }
    this.filled = 0;
    this.port.postMessage(
      { pcm: pcm.buffer, level: Math.sqrt(sumSquares / input.length) },
      [pcm.buffer],
    );
  }
}

registerProcessor('qwen-live-capture', QwenLiveCaptureProcessor);
