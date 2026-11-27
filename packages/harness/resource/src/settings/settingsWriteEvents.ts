/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Connect file transactions to every live process-owned Settings source store. */
export interface SettingsWriteObserver {
  onSettingsFileWritten(
    path: string,
    rawJson: string | undefined,
    changed: boolean,
    writeId?: string,
  ): void;
  onSettingsFileInvalidated?(path: string): void;
}

const observers = new Set<WeakRef<SettingsWriteObserver>>();

export function registerSettingsWriteObserver(
  observer: SettingsWriteObserver,
): () => void {
  const reference = new WeakRef(observer);
  observers.add(reference);
  return () => observers.delete(reference);
}

export function publishSettingsFileWrite(
  path: string,
  rawJson: string | undefined,
  changed: boolean,
  writeId?: string,
): void {
  for (const reference of observers) {
    const observer = reference.deref();
    if (!observer) {
      observers.delete(reference);
      continue;
    }
    try {
      observer.onSettingsFileWritten(path, rawJson, changed, writeId);
    } catch {
      // The file was already committed; observer errors cannot fail the write.
    }
  }
}

export function publishSettingsFileInvalidation(path: string): void {
  for (const reference of observers) {
    const observer = reference.deref();
    if (!observer) {
      observers.delete(reference);
      continue;
    }
    try {
      observer.onSettingsFileInvalidated?.(path);
    } catch {
      // Invalidation is best-effort and must not replace the persistence error.
    }
  }
}
