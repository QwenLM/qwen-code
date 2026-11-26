/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { runLogger } from '../utils/runLogger.js';
import {
  addMarketplaceSource,
  loadKnownMarketplacesConfig,
  marketplaceSourcesEqual,
  replaceMarketplaceSource,
  type KnownMarketplace,
} from './management/marketplaceManager.js';
import {
  isLocalMarketplaceSource,
  type KnownMarketplacesFile,
  type MarketplaceSource,
} from './schemas.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A marketplace declared in settings (extraKnownMarketplaces).
 */
export interface DeclaredMarketplace {
  name: string;
  source: MarketplaceSource;
  /** When true the source was inferred as a fallback and should not be
   *  compared against the materialized source for freshness. */
  sourceIsFallback?: boolean;
}

export interface MarketplaceDiff {
  /** Declared in settings but not present in known_marketplaces.json. */
  missing: string[];
  /** Present in both but source differs. */
  sourceChanged: Array<{
    name: string;
    declaredSource: MarketplaceSource;
    materializedSource: MarketplaceSource;
  }>;
  /** Present in both with matching source. */
  upToDate: string[];
}

export interface ReconcileOptions {
  /** Return true to skip a marketplace (e.g., local paths that don't exist). */
  skip?: (name: string, source: MarketplaceSource) => boolean;
  /** Progress events for UI feedback. */
  onProgress?: (event: ReconcileProgressEvent) => void;
  /** Project root for resolving relative local paths. */
  projectRoot?: string;
}

type ReconcileAction = 'install' | 'update';

export type ReconcileProgressEvent =
  | { type: 'installing'; name: string; action?: ReconcileAction }
  | { type: 'installed'; name: string; action?: ReconcileAction }
  | {
      type: 'failed';
      name: string;
      error: string;
      action?: ReconcileAction;
    };

export interface ReconcileResult {
  installed: string[];
  updated: string[];
  failed: Array<{ name: string; error: string }>;
  upToDate: string[];
  skipped: string[];
}

// ---------------------------------------------------------------------------
// Pure diff
// ---------------------------------------------------------------------------

/**
 * Compare declared marketplaces (from settings) against materialized state
 * (known_marketplaces.json) and classify each into missing / sourceChanged / upToDate.
 */
export function diffMarketplaces(
  declared: Record<string, DeclaredMarketplace>,
  materialized: KnownMarketplacesFile,
  opts?: { projectRoot?: string },
): MarketplaceDiff {
  const missing: string[] = [];
  const sourceChanged: MarketplaceDiff['sourceChanged'] = [];
  const upToDate: string[] = [];

  for (const [name, decl] of Object.entries(declared)) {
    const mat = materialized[name] as KnownMarketplace | undefined;

    if (!mat) {
      missing.push(name);
      continue;
    }

    // If the source was inferred as a fallback, presence alone is sufficient.
    if (decl.sourceIsFallback) {
      upToDate.push(name);
      continue;
    }

    const normalizedDeclared = normalizeSource(decl.source, opts?.projectRoot);
    const normalizedMaterialized = normalizeSource(
      mat.source,
      opts?.projectRoot,
    );

    if (!marketplaceSourcesEqual(normalizedDeclared, normalizedMaterialized)) {
      sourceChanged.push({
        name,
        declaredSource: decl.source,
        materializedSource: mat.source,
      });
    } else {
      upToDate.push(name);
    }
  }

  return { missing, sourceChanged, upToDate };
}

// ---------------------------------------------------------------------------
// Reconcile (I/O)
// ---------------------------------------------------------------------------

/**
 * Reconcile declared marketplaces against materialized state.
 *
 * Idempotent: running it twice with the same inputs produces the same result.
 * Additive: never removes existing marketplaces.
 */
export async function reconcileMarketplaces(
  declared: Record<string, DeclaredMarketplace>,
  opts?: ReconcileOptions,
): Promise<ReconcileResult> {
  const materialized = loadKnownMarketplacesConfig() as KnownMarketplacesFile;
  const diff = diffMarketplaces(declared, materialized, {
    projectRoot: opts?.projectRoot,
  });

  const result: ReconcileResult = {
    installed: [],
    updated: [],
    failed: [],
    upToDate: diff.upToDate,
    skipped: [],
  };

  // Collect work items: missing + sourceChanged
  const workItems: Array<{
    name: string;
    source: MarketplaceSource;
    action: ReconcileAction;
  }> = [];

  for (const name of diff.missing) {
    const decl = declared[name];
    workItems.push({ name, source: decl.source, action: 'install' });
  }

  for (const item of diff.sourceChanged) {
    workItems.push({
      name: item.name,
      source: item.declaredSource,
      action: 'update',
    });
  }

  // Process sequentially (marketplace installs involve git clones / network)
  for (const item of workItems) {
    // Skip filter (e.g., dead local paths)
    if (opts?.skip?.(item.name, item.source)) {
      result.skipped.push(item.name);
      continue;
    }

    // Skip local sources pointing to non-existent paths
    if (
      isLocalMarketplaceSource(item.source) &&
      !existsSync(item.source.path)
    ) {
      runLogger.log(
        `[Reconciler] Skipping local marketplace "${item.name}" — path does not exist: ${item.source.path}`,
      );
      result.skipped.push(item.name);
      continue;
    }

    opts?.onProgress?.({
      type: 'installing',
      name: item.name,
      action: item.action,
    });

    try {
      if (item.action === 'update') {
        // Source changed — fetch and persist the declared replacement.
        await replaceMarketplaceSource(item.name, item.source);
        result.updated.push(item.name);
      } else {
        // New marketplace — add it
        await addMarketplaceSource(item.name, item.source);
        result.installed.push(item.name);
      }
      opts?.onProgress?.({
        type: 'installed',
        name: item.name,
        action: item.action,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      runLogger.warn(
        `[Reconciler] Failed to ${item.action} marketplace "${item.name}": ${msg}`,
      );
      result.failed.push({ name: item.name, error: msg });
      opts?.onProgress?.({
        type: 'failed',
        name: item.name,
        error: msg,
        action: item.action,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a marketplace source for comparison.
 * Resolves relative local paths to absolute so that the same directory
 * referenced from different CWDs compares equal.
 */
function normalizeSource(
  source: MarketplaceSource,
  projectRoot?: string,
): MarketplaceSource {
  if (!isLocalMarketplaceSource(source)) {
    return source;
  }

  const base = projectRoot ?? process.cwd();
  return {
    ...source,
    path: resolve(base, source.path),
  };
}
