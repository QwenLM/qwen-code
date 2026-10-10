/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, type RefObject } from 'react';
import type { LiveInputLevel } from './useLiveBrowserHost';
import styles from './LiveVoiceButton.module.css';

/**
 * Microphone level while this tab is the Live Voice endpoint: the one thing
 * that tells a caller whether the daemon is hearing them at all, when a call
 * that looks connected produces no answer.
 *
 * Reads a ref on an animation frame and writes the DOM directly. Turning ~16
 * audio frames a second into React state would re-render the whole dialog at
 * that rate and compete with the capture callback for the main thread.
 */
export const LIVE_LEVEL_PROPERTY = '--live-input-level';
// Raw speech RMS sits well under 0.2; the same gain dictation's meter uses.
const LEVEL_GAIN = 8;
// Peak-and-decay: rises instantly, falls smoothly, so the bar reads as a
// voice rather than flickering once per audio frame. Expressed per 60 Hz
// frame and scaled by elapsed time: decaying once per animation frame would
// fall 2.4x faster on a 144 Hz display and saw-tooth between audio frames.
const DECAY_PER_60HZ_FRAME = 0.85;
const FRAME_60HZ_MS = 1000 / 60;
// Audio frames arrive every 64 ms. After a few missed ones the capture
// callback has stopped (suspended AudioContext, device change) and the last
// level is no longer a measurement.
const STALE_AFTER_MS = 250;

export function LiveLevelMeter({
  level,
  muted,
  label,
  droppingLabel,
  onDroppingChange,
}: {
  level: RefObject<LiveInputLevel>;
  /** Input is muted: hold the meter at zero instead of animating it. */
  muted: boolean;
  label: string;
  /** Shown while frames are being dropped instead of sent. */
  droppingLabel: string;
  /**
   * Called when the dropping state flips, never per frame. The bar is
   * decorative and hidden from assistive technology; "the daemon is not
   * hearing you" is status, and the dialog says it in text.
   */
  onDroppingChange?: (dropping: boolean) => void;
}): React.JSX.Element {
  const onDroppingChangeRef = useRef(onDroppingChange);
  onDroppingChangeRef.current = onDroppingChange;
  const meterRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let painted = -1;
    const paint = (value: number) => {
      // Silence would otherwise rewrite the same property 60 times a second.
      if (Math.abs(value - painted) < 0.005) return;
      painted = value;
      barRef.current?.style.setProperty(LIVE_LEVEL_PROPERTY, value.toFixed(3));
    };
    let shownDropping: boolean | undefined;
    const paintDropping = (dropping: boolean) => {
      if (dropping === shownDropping) return;
      // Not on the first paint: "not dropping" is the state the dialog
      // already assumes, and announcing it would be noise.
      if (shownDropping !== undefined || dropping) {
        onDroppingChangeRef.current?.(dropping);
      }
      shownDropping = dropping;
      const meter = meterRef.current;
      if (!meter) return;
      meter.dataset['dropping'] = String(dropping);
      meter.title = dropping ? droppingLabel : label;
    };
    if (muted) {
      paint(0);
      paintDropping(false);
      return undefined;
    }
    let shown = 0;
    let previous: number | undefined;
    let frame = requestAnimationFrame(function tick(now) {
      const input = level.current;
      const live = now - input.at <= STALE_AFTER_MS;
      const raw = live ? Math.min(1, Math.max(0, input.level * LEVEL_GAIN)) : 0;
      const elapsed = previous === undefined ? FRAME_60HZ_MS : now - previous;
      previous = now;
      const decayed =
        shown * Math.pow(DECAY_PER_60HZ_FRAME, elapsed / FRAME_60HZ_MS);
      shown = raw > decayed ? raw : decayed;
      // Settle at exactly zero instead of decaying forever towards it.
      if (shown < 0.005) shown = 0;
      paint(shown);
      paintDropping(live && input.dropping);
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      // Muting, or the meter going away, ends the report with it.
      if (shownDropping) onDroppingChangeRef.current?.(false);
    };
  }, [level, muted, label, droppingLabel]);

  return (
    <div
      ref={meterRef}
      className={styles.levelMeter}
      data-muted={muted}
      data-dropping="false"
      data-live-level-meter
      // Decorative: the call state beside it is the accessible information,
      // and a value changing 60 times a second is noise to a screen reader.
      aria-hidden="true"
      title={label}
    >
      <div ref={barRef} className={styles.levelMeterFill} />
    </div>
  );
}
