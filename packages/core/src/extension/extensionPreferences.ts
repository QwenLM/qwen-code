/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('EXT_PREFERENCES');

/**
 * Install/visibility scope intent recorded for an extension. This mirrors the
 * Claude Code plugin scopes so the Installed view can group extensions the way
 * the user installed them:
 * - `user`    -> Global (User Scope), available everywhere.
 * - `project` -> Project (All Collaborators), enabled for the current workspace.
 * - `local`   -> Local (Only You), enabled for the current workspace privately.
 *
 * Enable/disable state itself still lives in `extension-enablement.json`; this
 * value only records *where the user chose to install* an extension so the UI
 * can render the same grouping Claude Code does.
 */
export type ExtensionScope = 'user' | 'project' | 'local';

export interface ExtensionPreferences {
  /** Names of extensions/MCP servers the user has favorited. */
  favorites: string[];
  /** Per-extension scope intent, keyed by extension name. */
  scopes: Record<string, ExtensionScope>;
}

/** Always returns fresh containers so callers can safely mutate the result. */
function emptyPreferences(): ExtensionPreferences {
  return { favorites: [], scopes: {} };
}

/**
 * Persists user preferences for extensions (favorites, scope intent) that are
 * orthogonal to the enable/disable enablement config. Backed by a single JSON
 * file so it is cheap to read/write and easy to reason about.
 */
export class ExtensionPreferencesStore {
  constructor(private readonly filePath: string) {}

  read(): ExtensionPreferences {
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(content) as Partial<ExtensionPreferences>;
      return {
        favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
        scopes:
          parsed.scopes && typeof parsed.scopes === 'object'
            ? parsed.scopes
            : {},
      };
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return emptyPreferences();
      }
      debugLogger.error('Error reading extension preferences:', error);
      return emptyPreferences();
    }
  }

  private write(prefs: ExtensionPreferences): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    atomicWriteFileSync(this.filePath, JSON.stringify(prefs, null, 2));
  }

  isFavorite(name: string): boolean {
    return this.read().favorites.includes(name);
  }

  getFavorites(): string[] {
    return this.read().favorites;
  }

  /**
   * Toggles the favorite state for an item and returns the new state.
   */
  toggleFavorite(name: string): boolean {
    const prefs = this.read();
    const index = prefs.favorites.indexOf(name);
    let nowFavorite: boolean;
    if (index >= 0) {
      prefs.favorites.splice(index, 1);
      nowFavorite = false;
    } else {
      prefs.favorites.push(name);
      nowFavorite = true;
    }
    this.write(prefs);
    return nowFavorite;
  }

  getScope(name: string): ExtensionScope | undefined {
    return this.read().scopes[name];
  }

  getScopes(): Record<string, ExtensionScope> {
    return this.read().scopes;
  }

  setScope(name: string, scope: ExtensionScope): void {
    const prefs = this.read();
    prefs.scopes[name] = scope;
    this.write(prefs);
  }

  /** Removes all preference state for an extension (used on uninstall). */
  clear(name: string): void {
    const prefs = this.read();
    const favIndex = prefs.favorites.indexOf(name);
    let changed = false;
    if (favIndex >= 0) {
      prefs.favorites.splice(favIndex, 1);
      changed = true;
    }
    if (prefs.scopes[name]) {
      delete prefs.scopes[name];
      changed = true;
    }
    if (changed) {
      this.write(prefs);
    }
  }
}
