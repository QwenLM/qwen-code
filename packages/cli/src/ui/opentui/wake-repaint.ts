/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wake / resume repaint for the OpenTUI renderer (ink parity).
 *
 * The ink tree installs `useWakeRepaint` (ui/hooks/use-wake-repaint.ts):
 * after the process resumes from a suspend / sleep (macOS display sleep, lid
 * close, `Ctrl+Z` + `fg`) the terminal's screen buffer may be stale, so it
 * forces a repaint. Detection is two-pronged — a heartbeat timer whose gap
 * reveals a frozen event loop, and `SIGCONT` for job-control resumes. The
 * OpenTUI branch had no equivalent, so a resumed session showed a torn
 * frame. This is the hook-free port: same thresholds, returns a disposer.
 */

// How often the heartbeat timer fires.
const HEARTBEAT_INTERVAL_MS = 5_000;

// A gap between consecutive heartbeats larger than this means the event loop
// was frozen (sleep / suspend). 2× the interval leaves margin for jitter.
const WAKE_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 2;

/**
 * Arms wake-repaint detection, invoking `repaint` whenever the process
 * resumes after a suspend. Returns a disposer that clears the timer and
 * removes the signal listener.
 */
export function startWakeRepaint(repaint: () => void): () => void {
  let lastTick = Date.now();

  const timer = setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastTick;
    lastTick = now;
    if (elapsed > WAKE_THRESHOLD_MS) {
      repaint();
    }
  }, HEARTBEAT_INTERVAL_MS);
  // Never keep the process alive just for this timer.
  timer.unref?.();

  const onSigcont = () => {
    lastTick = Date.now();
    repaint();
  };
  process.on('SIGCONT', onSigcont);

  return () => {
    clearInterval(timer);
    process.removeListener('SIGCONT', onSigcont);
  };
}
