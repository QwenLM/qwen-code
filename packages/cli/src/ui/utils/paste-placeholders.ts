/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export function expandPendingPastePlaceholders(
  value: string,
  pendingPastes: ReadonlyMap<string, string>,
): string {
  if (pendingPastes.size === 0) {
    return value;
  }
  const placeholders = Array.from(pendingPastes.keys()).sort(
    (a, b) => b.length - a.length,
  );
  const escapedPlaceholders = placeholders.map((placeholderValue) =>
    placeholderValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  const placeholderRegex = new RegExp(escapedPlaceholders.join('|'), 'g');
  return value.replace(
    placeholderRegex,
    (matchedPlaceholder) =>
      pendingPastes.get(matchedPlaceholder) ?? matchedPlaceholder,
  );
}

export function restorePasteDraft(
  text: string,
  restored: ReadonlyMap<string, string>,
  pending: ReadonlyMap<string, string>,
): { text: string; pasteExpansions: Map<string, string> } {
  const pasteExpansions = new Map(pending);
  const reserved = new Set([...pending.keys(), ...restored.keys()]);
  const renamed = new Map<string, string>();
  for (const [placeholder, body] of restored) {
    let target = placeholder;
    if (pasteExpansions.has(target) && pasteExpansions.get(target) !== body) {
      const base = placeholder.replace(/ #\d+$/, '');
      let id = 2;
      while (reserved.has(`${base} #${id}`)) id++;
      target = `${base} #${id}`;
      reserved.add(target);
    }
    renamed.set(placeholder, target);
    pasteExpansions.set(target, body);
  }
  return {
    text: expandPendingPastePlaceholders(text, renamed),
    pasteExpansions,
  };
}
