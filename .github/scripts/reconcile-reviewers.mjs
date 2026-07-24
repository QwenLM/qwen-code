#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reconcile the requested-reviewer set for a PR.
 *
 * Pure set-arithmetic extracted from the core-review-router workflow so
 * the logic can be unit-tested.  The workflow fetches data from the
 * GitHub API, passes it here as JSON, and executes the returned
 * add/remove/marker instructions.
 *
 * Usage (called by the core-review-router workflow):
 *   node .github/scripts/reconcile-reviewers.mjs \
 *     --desired '["a","b"]' \
 *     --reviewed '["c"]' \
 *     --current '["a","c"]' \
 *     --marker-body '<!-- core-review-router:managed {"desired":["a"]} -->' \
 *     --maintainers '["a","b","c"]'
 *
 * Outputs a JSON object to stdout:
 *   {
 *     "toAdd": ["b"],
 *     "toRemove": [],
 *     "unchanged": false,
 *     "markerBody": "<!-- core-review-router:managed {\"desired\":[\"a\",\"b\"]} -->"
 *   }
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const MARKER = '<!-- core-review-router:managed';

/**
 * Parse the desired set from a marker comment body.
 * Returns [] on any malformed or missing input.
 */
export function parseMarker(body) {
  if (!body || !body.startsWith(MARKER)) return [];
  try {
    const after = body.slice(MARKER.length);
    const json = after.split(' -->')[0].trim();
    const parsed = JSON.parse(json);
    return Array.isArray(parsed.desired) ? parsed.desired : [];
  } catch {
    return [];
  }
}

/**
 * Compute the reviewer reconciliation.
 *
 * @param {object} opts
 * @param {string[]} opts.desired   - Reviewers chosen by the classifier.
 * @param {string[]} opts.reviewed  - Users who already submitted a review.
 * @param {string[]} opts.current   - Currently requested reviewers.
 * @param {string}   [opts.markerBody] - Full body of the marker comment (or empty).
 * @param {string[]} opts.maintainers - All maintainer logins.
 * @returns {{ toAdd: string[], toRemove: string[], unchanged: boolean, markerBody: string }}
 */
export function reconcile({ desired, reviewed, current, markerBody, maintainers }) {
  const reviewedSet = new Set(reviewed);
  const effectiveDesired = desired.filter((r) => !reviewedSet.has(r)).sort();

  const prevDesired = parseMarker(markerBody);
  const currentSet = new Set(current);
  const drift = prevDesired.filter(
    (r) => !currentSet.has(r) && !reviewedSet.has(r),
  );

  const driftSet = new Set(drift);
  const preDriftDesired = effectiveDesired;
  const finalDesired = effectiveDesired.filter((r) => !driftSet.has(r)).sort();

  const maintainerSet = new Set(maintainers);
  const managed = current.filter((r) => maintainerSet.has(r)).sort();

  const desiredSet = new Set(finalDesired);
  const managedSet = new Set(managed);
  const toRemove = managed.filter((r) => !desiredSet.has(r));
  const toAdd = finalDesired.filter((r) => !managedSet.has(r));
  const unchanged = toRemove.length === 0 && toAdd.length === 0;

  const newMarkerBody = `${MARKER} {"desired":${JSON.stringify(preDriftDesired)}} -->`;

  return { toAdd, toRemove, unchanged, markerBody: newMarkerBody };
}

// --- CLI entry point ---
const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { values } = parseArgs({
    options: {
      desired: { type: 'string', default: '[]' },
      reviewed: { type: 'string', default: '[]' },
      current: { type: 'string', default: '[]' },
      'marker-body': { type: 'string', default: '' },
      maintainers: { type: 'string', default: '[]' },
    },
  });

  const result = reconcile({
    desired: JSON.parse(values.desired),
    reviewed: JSON.parse(values.reviewed),
    current: JSON.parse(values.current),
    markerBody: values['marker-body'],
    maintainers: JSON.parse(values.maintainers),
  });
  console.log(JSON.stringify(result));
}
