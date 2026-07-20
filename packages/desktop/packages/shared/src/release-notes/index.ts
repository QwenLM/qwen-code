/**
 * Release Notes Utilities
 *
 * Loads release notes from bundled assets and syncs them to ~/.craft-agent/release-notes/.
 * Follows the same pattern as docs/index.ts.
 *
 * Source content lives in apps/electron/resources/release-notes/*.md.
 */

import { join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { getBundledAssetsDir } from '../utils/paths.ts';
import { debug } from '../utils/debug.ts';

const CONFIG_DIR = join(homedir(), '.craft-agent');
const RELEASE_NOTES_DIR = join(CONFIG_DIR, 'release-notes');

let releaseNotesInitialized = false;

function getAssetsDir(): string {
  return getBundledAssetsDir('release-notes')
    ?? join(process.cwd(), 'resources', 'release-notes');
}

/**
 * Load bundled release notes from asset files.
 * Returns { filename → content } map.
 */
function loadBundledReleaseNotes(): Record<string, string> {
  const assetsDir = getAssetsDir();
  const notes: Record<string, string> = {};

  // Try bundled assets first, fall back to ~/.craft-agent/release-notes/
  // (Docker/remote server may not have CRAFT_BUNDLED_ASSETS_ROOT set,
  // but initializeReleaseNotes() copies files to the config dir at startup)
  let dir = assetsDir;
  if (!existsSync(dir)) {
    dir = RELEASE_NOTES_DIR;
  }

  let files: string[];
  try {
    files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md')) : [];
  } catch {
    console.warn(`[release-notes] Could not read release notes dir: ${dir}`);
    return notes;
  }

  for (const filename of files) {
    const filePath = join(dir, filename);
    try {
      notes[filename] = readFileSync(filePath, 'utf-8');
    } catch (error) {
      console.error(`[release-notes] Failed to load ${filename}:`, error);
    }
  }

  return notes;
}

let _bundledNotes: Record<string, string> | null = null;

function getBundledReleaseNotes(): Record<string, string> {
  if (_bundledNotes === null) {
    _bundledNotes = loadBundledReleaseNotes();
  }
  return _bundledNotes;
}

/**
 * Initialize release notes directory with bundled content.
 * Call at app startup alongside initializeDocs().
 */
export function initializeReleaseNotes(): void {
  if (releaseNotesInitialized) return;
  releaseNotesInitialized = true;

  if (!existsSync(RELEASE_NOTES_DIR)) {
    mkdirSync(RELEASE_NOTES_DIR, { recursive: true });
  }

  const bundledNotes = getBundledReleaseNotes();
  for (const [filename, content] of Object.entries(bundledNotes)) {
    const notePath = join(RELEASE_NOTES_DIR, filename);
    writeFileSync(notePath, content, 'utf-8');
  }

  debug(`[release-notes] Synced ${Object.keys(bundledNotes).length} release notes`);
}

/**
 * Parse version from filename (e.g., "0.4.1.md" → "0.4.1").
 */
function parseVersion(filename: string): string {
  return filename.replace(/\.md$/, '');
}

/**
 * Compare semver strings for sorting (descending — newest first).
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  }
  return 0;
}

/** Maximum number of release notes to display in the UI. */
const MAX_DISPLAY_NOTES = 10;

export interface ReleaseNote {
  version: string;
  content: string;
}

/**
 * Get release notes sorted newest-first, limited to the most recent 10.
 */
export function getReleaseNotesList(): ReleaseNote[] {
  const notes = getBundledReleaseNotes();
  return Object.entries(notes)
    .map(([filename, content]) => ({
      version: parseVersion(filename),
      content,
    }))
    .sort((a, b) => compareSemver(a.version, b.version))
    .slice(0, MAX_DISPLAY_NOTES);
}

/**
 * Get the latest release note version string.
 */
export function getLatestReleaseVersion(): string | undefined {
  const list = getReleaseNotesList();
  return list[0]?.version;
}

/**
 * Get all release notes combined into a single markdown string.
 * Each version is separated by a horizontal rule.
 */
export function getCombinedReleaseNotes(): string {
  const list = getReleaseNotesList();
  return list.map(n => {
    // Auto-inject version header if the content doesn't start with one
    if (!n.content.trimStart().startsWith('# ')) {
      return `# v${n.version}\n\n${n.content}`;
    }
    return n.content;
  }).join('\n\n---\n\n');
}
