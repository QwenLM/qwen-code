/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Gapless playback of the 24 kHz PCM16 frames a Live Voice call streams down.
 *
 * Frames are scheduled back to back on the AudioContext clock rather than
 * played as they arrive, so network jitter does not become audible gaps. When
 * playback underruns the schedule restarts from "now": latency must not pile
 * up over a long answer. `clear` is the barge-in path — the daemon sends it
 * the moment the user starts talking over the model.
 */
export const LIVE_OUTPUT_SAMPLE_RATE = 24_000;

// Lead time for the first frame after silence. Small enough to be inaudible,
// large enough that the next frame usually lands before this one ends.
const START_LEAD_SECONDS = 0.04;

interface ScheduledSource {
  epoch: number;
  node: AudioBufferSourceNode;
}

export type PcmPlayerContext = Pick<
  AudioContext,
  'currentTime' | 'destination' | 'createBuffer' | 'createBufferSource'
>;

export class PcmPlayer {
  private readonly scheduled = new Set<ScheduledSource>();
  private nextStartTime = 0;
  private muted = false;

  constructor(private readonly context: PcmPlayerContext) {}

  /** Number of frames scheduled and not yet finished. */
  get pending(): number {
    return this.scheduled.size;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.clear();
  }

  /** Queue one little-endian PCM16 mono frame belonging to `epoch`. */
  enqueue(epoch: number, pcm16: ArrayBuffer): void {
    if (this.muted) return;
    const sampleCount = Math.floor(pcm16.byteLength / 2);
    if (sampleCount === 0) return;
    const view = new DataView(pcm16);
    const buffer = this.context.createBuffer(
      1,
      sampleCount,
      LIVE_OUTPUT_SAMPLE_RATE,
    );
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      channel[i] = view.getInt16(i * 2, true) / 0x8000;
    }

    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.context.destination);
    const now = this.context.currentTime;
    const startAt =
      this.nextStartTime > now ? this.nextStartTime : now + START_LEAD_SECONDS;
    this.nextStartTime = startAt + buffer.duration;

    const entry: ScheduledSource = { epoch, node };
    this.scheduled.add(entry);
    node.onended = () => {
      this.scheduled.delete(entry);
    };
    node.start(startAt);
  }

  /**
   * Drop everything still queued — for one call `epoch`, or for all of them.
   * Audio of a different epoch is left alone: a `clear` for the call that just
   * ended must not cut into the next one.
   */
  clear(epoch?: number): void {
    let cleared = false;
    for (const entry of [...this.scheduled]) {
      if (epoch !== undefined && entry.epoch !== epoch) continue;
      this.scheduled.delete(entry);
      entry.node.onended = null;
      try {
        entry.node.stop();
      } catch {
        /* already finished */
      }
      entry.node.disconnect();
      cleared = true;
    }
    if (cleared && this.scheduled.size === 0) this.nextStartTime = 0;
  }
}
