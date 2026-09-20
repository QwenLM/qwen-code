/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, type RefObject } from 'react';
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
// voice rather than flickering once per frame.
const DECAY_PER_FRAME = 0.85;

export function LiveLevelMeter({
  level,
  muted,
  label,
}: {
  level: RefObject<number>;
  /** Input is muted: hold the meter at zero instead of animating it. */
  muted: boolean;
  label: string;
}): React.JSX.Element {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const paint = (value: number) =>
      barRef.current?.style.setProperty(LIVE_LEVEL_PROPERTY, value.toFixed(3));
    if (muted) {
      paint(0);
      return undefined;
    }
    let shown = 0;
    let frame = requestAnimationFrame(function tick() {
      const raw = Math.min(1, Math.max(0, level.current * LEVEL_GAIN));
      shown = raw > shown ? raw : shown * DECAY_PER_FRAME;
      paint(shown);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [level, muted]);

  return (
    <div
      className={styles.levelMeter}
      data-muted={muted}
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
