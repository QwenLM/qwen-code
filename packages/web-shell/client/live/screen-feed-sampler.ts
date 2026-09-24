/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LiveScreenFrame } from './screen-share';

export function sampleScreen(options: {
  grab: () => Promise<LiveScreenFrame>;
  canSend: () => boolean;
  send: (image: string) => void;
  onError: (error: unknown) => void;
}): () => void {
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy || !options.canSend()) return;
    busy = true;
    try {
      const frame = await options.grab();
      if (stopped || !options.canSend()) return;
      options.send(frame.image);
    } catch (error) {
      if (!stopped) options.onError(error);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 1000);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
