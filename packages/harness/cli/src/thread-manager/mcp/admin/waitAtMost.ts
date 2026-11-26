/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Settles like `work`, or resolves `undefined` once `ms` pass first. The work
 * itself is not cancelled; the timer does not keep the process alive.
 */
export async function waitAtMost<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    const handle = setTimeout(() => resolve(undefined), ms);
    handle.unref?.();
    timer = handle;
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
