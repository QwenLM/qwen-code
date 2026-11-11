/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

type ThrottledFunction<TArgs extends unknown[]> = ((...args: TArgs) => void) & {
  cancel: () => void;
  flush: () => void;
};

export default function throttle<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  _wait = 0,
): ThrottledFunction<TArgs> {
  void _wait;

  let lastArgs: TArgs | null = null;

  const wrapped = ((...args: TArgs) => {
    lastArgs = args;
    fn(...args);
  }) as ThrottledFunction<TArgs>;

  wrapped.cancel = () => {
    lastArgs = null;
  };

  wrapped.flush = () => {
    if (lastArgs) {
      fn(...lastArgs);
      lastArgs = null;
    }
  };

  return wrapped;
}
