/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const highlightsPath = resolve(
  scriptDir,
  '../packages/cli/src/ui/components/whats-new-content.json',
);

function loadHighlights() {
  return JSON.parse(readFileSync(highlightsPath, 'utf8'));
}

function getHighlightVersion(version) {
  return version.replace(/^v/, '').replace(/-preview\.\d+$/, '');
}

function isNightlyVersion(version) {
  return version.replace(/^v/, '').includes('-nightly.');
}

export function assertReleaseHighlights(
  version,
  highlightsByVersion = loadHighlights(),
) {
  if (isNightlyVersion(version)) {
    return;
  }

  const highlightVersion = getHighlightVersion(version);
  const highlights = highlightsByVersion[highlightVersion];
  const isValid =
    Array.isArray(highlights) &&
    highlights.length >= 3 &&
    highlights.length <= 5 &&
    highlights.every(
      (highlight) =>
        typeof highlight === 'string' && highlight.trim().length > 0,
    );

  if (!isValid) {
    throw new Error(
      `Expected 3-5 curated What's New highlights for release version ${highlightVersion}. Add them to packages/cli/src/ui/components/whats-new-content.json before releasing.`,
    );
  }
}
