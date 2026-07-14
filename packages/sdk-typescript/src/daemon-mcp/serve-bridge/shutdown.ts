/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function createShutdownController(options: {
  close: () => Promise<void>;
  dispose: () => Promise<void>;
  exit: (code: number) => void;
  reportCloseError: (err: unknown) => void;
}): {
  shutdown: () => Promise<void>;
  markInstanceClosed: () => void;
} {
  let instanceClosed = false;
  let shutdownPromise: Promise<void> | undefined;

  const performShutdown = async (): Promise<void> => {
    if (!instanceClosed) {
      instanceClosed = true;
      try {
        await options.close();
      } catch (err) {
        options.reportCloseError(err);
      }
    }
    await options.dispose();
    options.exit(0);
  };

  const shutdown = (): Promise<void> => {
    // Defer work so a recursive onclose observes the assigned promise.
    shutdownPromise ??= Promise.resolve().then(performShutdown);
    return shutdownPromise;
  };

  return {
    shutdown,
    markInstanceClosed: () => {
      instanceClosed = true;
    },
  };
}
