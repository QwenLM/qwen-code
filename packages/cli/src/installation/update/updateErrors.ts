/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Step an update attempt failed in, reported as error_stage. */
export type UpdateStage =
  | 'check'
  | 'lock'
  | 'manifest'
  | 'download'
  | 'checksum'
  | 'extract'
  | 'install'
  | 'link'
  | 'cleanup'
  | 'brew_update'
  | 'brew_upgrade'
  | 'package_manager';

const errorStages = new WeakMap<object, UpdateStage>();

/**
 * Remember the step an error was thrown from, so the caller's terminal event
 * reports the same stage as the updater's own. The innermost tag wins.
 */
export function tagUpdateStage<T>(error: T, stage: UpdateStage): T {
  if (typeof error === 'object' && error !== null && !errorStages.has(error)) {
    errorStages.set(error, stage);
  }
  return error;
}

export function readUpdateStage(error: unknown): UpdateStage | undefined {
  return typeof error === 'object' && error !== null
    ? errorStages.get(error)
    : undefined;
}

export function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim() ? code : undefined;
}

/**
 * Re-throw an error with extra context appended in brackets. The original
 * message stays at the front so substring-based classifiers keep matching, and
 * name / code are carried over so error_code still resolves.
 */
export function withErrorContext(error: unknown, context: string): Error {
  const base = error instanceof Error ? error : new Error(String(error));
  if (!context) return base;
  const annotated = new Error(`${base.message} [${context}]`, { cause: base });
  annotated.name = base.name;
  const code = (base as { code?: unknown }).code;
  if (code !== undefined) (annotated as { code?: unknown }).code = code;
  return annotated;
}
