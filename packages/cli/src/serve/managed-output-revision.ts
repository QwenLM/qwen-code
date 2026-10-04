/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// H3 of #12827: the only ordering fact a funnel needs from a manifest is
// its revision; read it without the full contract so the forward check
// never depends on the manifest's other fields. A manifest that carries
// no integer revision cannot be compared, so it is refused rather than
// guessed.

/** The manifest's declared revision, or a refusal. */
export function manifestRevision(bytes: Buffer, label: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not JSON.`);
  }
  const revision =
    parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)['revision']
      : undefined;
  if (
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new Error(`${label} names no revision.`);
  }
  return revision;
}
