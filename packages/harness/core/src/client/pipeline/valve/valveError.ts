/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Options carried by a {@link ValveError}. */
export interface ValveErrorOptions extends ErrorOptions {
  /** The valve whose own work failed. */
  readonly valveName: string;
  /** Which step of the valve's work failed, e.g. `sign` or `decrypt`. */
  readonly step: string;
}

/**
 * Marks one valve's own work as the source of a failure.
 *
 * This is an attribution type, not a wrapping type: never rethrow a
 * downstream valve's error as a ValveError — that rewrites a transport
 * failure into the current valve's failure and inverts the diagnosis.
 * Downstream errors propagate untouched; only wrap errors thrown by work
 * this valve performs itself.
 */
export class ValveError extends Error {
  readonly valveName: string;
  readonly step: string;

  constructor(message: string, options: ValveErrorOptions) {
    super(message, options);
    this.name = 'ValveError';
    this.valveName = options.valveName;
    this.step = options.step;
  }
}
