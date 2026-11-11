/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

interface ModelNameCandidate {
  readonly key: string;
  readonly displayName: string;
  readonly aliases?: readonly string[];
}

/** Resolve user input against a catalog; internal provider lookups remain key-only. */
export function resolveModelName<T extends ModelNameCandidate>(
  models: readonly T[],
  name: string,
): { model?: T; ambiguous?: readonly T[] } {
  const exactKey = models.find((model) => model.key === name);
  if (exactKey) return { model: exactKey };
  const normalized = name.toLowerCase();
  const matchesKey = models.filter(
    (model) => model.key.toLowerCase() === normalized,
  );
  const matches = matchesKey.length
    ? matchesKey
    : models.filter(
        (model) =>
          model.aliases?.some((alias) => alias.toLowerCase() === normalized) ||
          model.displayName.toLowerCase() === normalized,
      );
  const unique = [
    ...new Map(matches.map((model) => [model.key, model])).values(),
  ];
  return unique.length > 1 ? { ambiguous: unique } : { model: unique[0] };
}
