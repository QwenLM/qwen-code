/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { canonicalPath } from './internalWrites.js';

export interface EntryGuard {
  /** Entry path in the caller's requested namespace. */
  entry: string;
  /** Same entry expressed below the canonical parent anchor. */
  matchedEntry: string;
  /** Canonical existing parent watched non-recursively. */
  anchor: string;
}

export interface RegistrationAnchor {
  anchor: string;
  flat: boolean;
}

export interface ResolvedWatchTarget {
  requested: string;
  /** Canonical (realpath) form of `requested`; events match here. */
  matched: string;
  anchor: string;
  /** Canonical form of `anchor`. */
  anchorMatched: string;
  /** Flat (depth 0) watch backing the target anchor. */
  flat: boolean;
  /** True while the requested path does not exist yet. */
  fallback: boolean;
  /** Flat parent watches for the target entry and symlink ancestors. */
  entryGuards: EntryGuard[];
}

export function anchorKey(anchor: string, flat: boolean): string {
  return `${flat ? 'f' : 'r'}:${anchor}`;
}

export function isUnder(child: string, parent: string): boolean {
  return child.startsWith(parent + sep);
}

export function resolveSignalPath(anchor: string, filename: string): string {
  const candidate = resolve(
    isAbsolute(filename) ? filename : join(anchor, filename),
  );
  return candidate === anchor || isUnder(candidate, anchor)
    ? candidate
    : anchor;
}

function nearestExistingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function findEntryGuards(
  requested: string,
  logicalRoot?: string,
): EntryGuard[] {
  const root = logicalRoot ? resolve(logicalRoot) : undefined;
  const guardAncestors =
    root !== undefined && (requested === root || isUnder(requested, root));
  if (requested === root) return [];

  const entries: string[] = [];
  let current = requested;
  while (true) {
    const parent = dirname(current);
    if (parent === current) break;
    entries.push(current);
    if (!guardAncestors || parent === root) break;
    current = parent;
  }

  const guards: EntryGuard[] = [];
  for (const entry of entries) {
    try {
      if (!lstatSync(entry).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const parent = dirname(entry);
    if (parent === entry || !existsSync(parent)) continue;
    const anchor = canonicalPath(parent);
    guards.push({
      entry,
      matchedEntry: join(anchor, basename(entry)),
      anchor,
    });
  }
  return guards;
}

/** Picks the narrowest anchor that still observes the requested path. */
export function resolveWatchTarget(
  path: string,
  logicalRoot?: string,
): ResolvedWatchTarget {
  const requested = resolve(path);
  const matched = canonicalPath(requested);
  const entryGuards = findEntryGuards(requested, logicalRoot);
  if (existsSync(requested)) {
    return {
      requested,
      matched,
      anchor: matched,
      anchorMatched: matched,
      flat: false,
      fallback: false,
      entryGuards,
    };
  }
  const anchor = canonicalPath(nearestExistingAncestor(dirname(requested)));
  return {
    requested,
    matched,
    anchor,
    anchorMatched: anchor,
    flat: true,
    fallback: true,
    entryGuards,
  };
}

export function registrationAnchors(
  target: ResolvedWatchTarget,
): RegistrationAnchor[] {
  const anchors = new Map<string, RegistrationAnchor>();
  const add = (anchor: RegistrationAnchor): void => {
    anchors.set(anchorKey(anchor.anchor, anchor.flat), anchor);
  };
  add({ anchor: target.anchor, flat: target.flat });
  for (const guard of target.entryGuards) {
    add({ anchor: guard.anchor, flat: true });
  }
  return [...anchors.values()];
}

export function signalRegistrationAnchors(
  target: ResolvedWatchTarget,
): RegistrationAnchor[] {
  const anchors = new Map<string, RegistrationAnchor>();
  const add = (anchor: RegistrationAnchor): void => {
    anchors.set(anchorKey(anchor.anchor, anchor.flat), anchor);
  };
  for (const anchor of registrationAnchors(target)) add(anchor);

  // A recursive watch on the target observes its contents, while a flat
  // parent guard reliably observes deletion/recreation of the target entry.
  // This is intentionally one level only; `logicalRoot` is never traversed.
  const requestedParent = dirname(target.requested);
  if (existsSync(requestedParent)) {
    add({ anchor: canonicalPath(requestedParent), flat: true });
  }
  return [...anchors.values()];
}
