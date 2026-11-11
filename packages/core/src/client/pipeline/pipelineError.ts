/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Options carried by a {@link PipelineError}. */
export interface PipelineErrorOptions extends ErrorOptions {
  /** The pipeline that failed. */
  readonly pipelineName: string;
}

/**
 * Answers "why did this pipeline stop" — a terminal envelope for framework
 * level failures (empty pipeline, initial output creation) or for shared
 * components that must attribute a failure to one pipeline.
 *
 * Weaker than {@link ValveError} by design: re-wrapping a ValveError as a
 * PipelineError adds no information, so only raise one at a genuine pipeline
 * boundary. Transport retry bookkeeping lives in its own error types.
 */
export class PipelineError extends Error {
  readonly pipelineName: string;

  constructor(message: string, options: PipelineErrorOptions) {
    super(message, options);
    this.name = 'PipelineError';
    this.pipelineName = options.pipelineName;
  }
}
