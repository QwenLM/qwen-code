/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Mode Memory — gives each mode its own isolated conversation memory.
 *
 * The ModeMemoryManager records memory entries per mode, supports search
 * across modes, tag-based filtering, and import/export for sharing memories
 * between projects.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MODE_MEMORY');

/**
 * A single memory entry for a mode.
 */
export interface ModeMemoryEntry {
  /** Unique identifier for this entry */
  id: string;

  /** When this entry was recorded */
  timestamp: Date;

  /** Name of the mode this entry belongs to */
  modeName: string;

  /** Short summary of what was discussed */
  summary: string;

  /** Important decisions made during this session */
  keyDecisions: string[];

  /** Files that were modified */
  filesTouched: string[];

  /** Artifacts created (docs, designs, etc.) */
  artifacts: string[];

  /** Tags for searchability */
  tags: string[];
}

/**
 * A block of memories belonging to a single mode.
 */
export interface ModeMemoryBlock {
  /** Mode name */
  modeName: string;

  /** All memory entries for this mode */
  entries: ModeMemoryEntry[];

  /** Total number of entries */
  totalEntries: number;

  /** Last time this memory block was accessed */
  lastAccessed: Date;
}

/**
 * Serialized memory data for persistence.
 */
interface MemoryData {
  blocks: Array<{
    modeName: string;
    entries: Array<{
      id: string;
      timestamp: string;
      modeName: string;
      summary: string;
      keyDecisions: string[];
      filesTouched: string[];
      artifacts: string[];
      tags: string[];
    }>;
    totalEntries: number;
    lastAccessed: string;
  }>;
}

/**
 * Entry counter for generating unique IDs.
 */
let entryIdCounter = 0;

/**
 * Generates a unique entry ID.
 */
function generateEntryId(): string {
  entryIdCounter++;
  return `mem-${Date.now()}-${entryIdCounter}`;
}

/**
 * Checks if an entry matches all of the given tags.
 */
function entryMatchesTags(entry: ModeMemoryEntry, tags: string[]): boolean {
  return tags.some((tag) => entry.tags.includes(tag));
}

/**
 * Checks if an entry matches a text query (case-insensitive).
 */
function entryMatchesQuery(entry: ModeMemoryEntry, query: string): boolean {
  const lowerQuery = query.toLowerCase();

  if (entry.summary.toLowerCase().includes(lowerQuery)) {
    return true;
  }

  if (entry.keyDecisions.some((d) => d.toLowerCase().includes(lowerQuery))) {
    return true;
  }

  if (entry.filesTouched.some((f) => f.toLowerCase().includes(lowerQuery))) {
    return true;
  }

  if (entry.artifacts.some((a) => a.toLowerCase().includes(lowerQuery))) {
    return true;
  }

  if (entry.tags.some((t) => t.toLowerCase().includes(lowerQuery))) {
    return true;
  }

  return false;
}

/**
 * Manages per-mode conversation memory with persistence, search, and
 * import/export capabilities.
 */
export class ModeMemoryManager {
  private memories: Map<string, ModeMemoryBlock> = new Map();
  private persistPath: string | null = null;

  /**
   * Create a new ModeMemoryManager.
   *
   * @param persistPath - Optional file path to persist memory data to
   */
  constructor(persistPath?: string) {
    if (persistPath) {
      this.persistPath = persistPath;
    }
  }

  /**
   * Record a memory entry for a mode.
   *
   * @param modeName - Name of the mode
   * @param entry - Entry data (without id and timestamp)
   */
  recordEntry(
    modeName: string,
    entry: Omit<ModeMemoryEntry, 'id' | 'timestamp'>,
  ): ModeMemoryEntry {
    const fullEntry: ModeMemoryEntry = {
      id: generateEntryId(),
      timestamp: new Date(),
      modeName,
      ...entry,
    };

    let block = this.memories.get(modeName);
    if (!block) {
      block = {
        modeName,
        entries: [],
        totalEntries: 0,
        lastAccessed: new Date(),
      };
      this.memories.set(modeName, block);
    }

    block.entries.push(fullEntry);
    block.totalEntries = block.entries.length;
    block.lastAccessed = new Date();

    debugLogger.debug(
      `Recorded memory entry for mode "${modeName}": ${fullEntry.summary}`,
    );

    // Auto-persist if a path is configured
    if (this.persistPath) {
      this.persist(this.persistPath).catch((err) => {
        debugLogger.warn('Failed to auto-persist memory:', err);
      });
    }

    return fullEntry;
  }

  /**
   * Get all memories for a mode.
   *
   * @param modeName - Mode name
   * @returns Memory block or null if no memory for this mode
   */
  getMemory(modeName: string): ModeMemoryBlock | null {
    const block = this.memories.get(modeName);
    if (!block) {
      return null;
    }

    // Update last accessed
    block.lastAccessed = new Date();

    return {
      ...block,
      entries: [...block.entries],
    };
  }

  /**
   * Search memories across all modes.
   *
   * @param query - Text query to match
   * @param modeName - Optional mode name to filter by
   * @returns Matching entries sorted by relevance (newest first)
   */
  search(query: string, modeName?: string): ModeMemoryEntry[] {
    const lowerQuery = query.toLowerCase();
    const results: ModeMemoryEntry[] = [];

    for (const [name, block] of this.memories.entries()) {
      if (modeName && name !== modeName) {
        continue;
      }

      for (const entry of block.entries) {
        if (entryMatchesQuery(entry, lowerQuery)) {
          results.push(entry);
        }
      }
    }

    // Sort by timestamp descending (newest first)
    results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    debugLogger.debug(
      `Search "${query}" returned ${results.length} results`,
    );

    return results;
  }

  /**
   * Get recent entries across all modes.
   *
   * @param limit - Maximum number of entries to return (default 20)
   * @returns Recent entries sorted by timestamp
   */
  getRecent(limit = 20): ModeMemoryEntry[] {
    const all: ModeMemoryEntry[] = [];

    for (const block of this.memories.values()) {
      all.push(...block.entries);
    }

    all.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    return all.slice(0, limit);
  }

  /**
   * Get entries by tags.
   *
   * @param tags - Tags to match (entry must have at least one)
   * @param modeName - Optional mode name to filter by
   * @returns Matching entries sorted by timestamp
   */
  getByTags(tags: string[], modeName?: string): ModeMemoryEntry[] {
    if (tags.length === 0) {
      return [];
    }

    const results: ModeMemoryEntry[] = [];

    for (const [name, block] of this.memories.entries()) {
      if (modeName && name !== modeName) {
        continue;
      }

      for (const entry of block.entries) {
        if (entryMatchesTags(entry, tags)) {
          results.push(entry);
        }
      }
    }

    results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    return results;
  }

  /**
   * Export memory for a mode as a JSON string.
   *
   * @param modeName - Mode name
   * @returns JSON string of the mode's memory block
   */
  exportMemory(modeName: string): string {
    const block = this.memories.get(modeName);
    if (!block) {
      return JSON.stringify({ modeName, entries: [], totalEntries: 0 });
    }

    const exportData = {
      modeName: block.modeName,
      entries: block.entries.map((e) => this.serializeEntry(e)),
      totalEntries: block.totalEntries,
      exportedAt: new Date().toISOString(),
    };

    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Import memory for a mode from a JSON string.
   *
   * @param modeName - Mode name
   * @param data - JSON string to import
   */
  importMemory(modeName: string, data: string): void {
    try {
      const parsed = JSON.parse(data);

      if (!Array.isArray(parsed.entries)) {
        throw new Error('Invalid memory data: missing entries array');
      }

      let block = this.memories.get(modeName);
      if (!block) {
        block = {
          modeName,
          entries: [],
          totalEntries: 0,
          lastAccessed: new Date(),
        };
        this.memories.set(modeName, block);
      }

      const importedEntries: ModeMemoryEntry[] = parsed.entries.map(
        (e: Record<string, unknown>) => ({
          id: (e.id as string) || generateEntryId(),
          timestamp: e.timestamp
            ? new Date(e.timestamp as string)
            : new Date(),
          modeName: modeName,
          summary: (e.summary as string) || '',
          keyDecisions: Array.isArray(e.keyDecisions)
            ? (e.keyDecisions as string[])
            : [],
          filesTouched: Array.isArray(e.filesTouched)
            ? (e.filesTouched as string[])
            : [],
          artifacts: Array.isArray(e.artifacts)
            ? (e.artifacts as string[])
            : [],
          tags: Array.isArray(e.tags) ? (e.tags as string[]) : [],
        }),
      );

      block.entries.push(...importedEntries);
      block.totalEntries = block.entries.length;
      block.lastAccessed = new Date();

      debugLogger.debug(
        `Imported ${importedEntries.length} entries for mode "${modeName}"`,
      );

      // Auto-persist if a path is configured
      if (this.persistPath) {
        this.persist(this.persistPath).catch((err) => {
          debugLogger.warn('Failed to auto-persist memory after import:', err);
        });
      }
    } catch (error) {
      debugLogger.warn(
        `Failed to import memory for mode "${modeName}":`,
        error,
      );
      throw new Error(
        `Invalid memory data: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  /**
   * Clear memory for a mode.
   *
   * @param modeName - Mode name
   */
  clearMemory(modeName: string): void {
    const block = this.memories.get(modeName);
    if (!block) {
      return;
    }

    const count = block.entries.length;
    block.entries = [];
    block.totalEntries = 0;
    block.lastAccessed = new Date();

    debugLogger.debug(
      `Cleared ${count} entries for mode "${modeName}"`,
    );

    // Auto-persist if a path is configured
    if (this.persistPath) {
      this.persist(this.persistPath).catch((err) => {
        debugLogger.warn('Failed to auto-persist memory after clear:', err);
      });
    }
  }

  /**
   * Get memory statistics.
   *
   * @returns Statistics about all stored memories
   */
  getStats(): {
    totalEntries: number;
    modesWithMemory: number;
    mostActiveMode: string;
  } {
    let totalEntries = 0;
    let mostActiveMode = '';
    let maxEntries = 0;

    for (const [name, block] of this.memories.entries()) {
      totalEntries += block.totalEntries;
      if (block.totalEntries > maxEntries) {
        maxEntries = block.totalEntries;
        mostActiveMode = name;
      }
    }

    return {
      totalEntries,
      modesWithMemory: this.memories.size,
      mostActiveMode: mostActiveMode || 'none',
    };
  }

  /**
   * Get all mode names that have memory entries.
   *
   * @returns Array of mode names
   */
  getModeNames(): string[] {
    return Array.from(this.memories.keys()).sort();
  }

  /**
   * Get all unique tags across all memories.
   *
   * @returns Sorted array of unique tags
   */
  getAllTags(): string[] {
    const tags = new Set<string>();

    for (const block of this.memories.values()) {
      for (const entry of block.entries) {
        for (const tag of entry.tags) {
          tags.add(tag);
        }
      }
    }

    return Array.from(tags).sort();
  }

  /**
   * Persist all memory data to a JSON file.
   *
   * @param filePath - Absolute path to save the data (overrides constructor path)
   */
  async persist(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const data: MemoryData = {
      blocks: Array.from(this.memories.values()).map((block) => ({
        modeName: block.modeName,
        entries: block.entries.map((e) => this.serializeEntry(e)),
        totalEntries: block.totalEntries,
        lastAccessed: block.lastAccessed.toISOString(),
      })),
    };

    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    debugLogger.debug(
      `Persisted mode memory to ${filePath} (${data.blocks.length} blocks, ${data.blocks.reduce((sum, b) => sum + b.totalEntries, 0)} entries)`,
    );
  }

  /**
   * Load memory data from a JSON file.
   *
   * @param filePath - Absolute path to load the data from
   */
  async load(filePath: string): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const data: MemoryData = JSON.parse(content);

      this.memories.clear();

      for (const blockData of data.blocks) {
        const entries: ModeMemoryEntry[] = blockData.entries.map((e) => ({
          id: e.id,
          timestamp: new Date(e.timestamp),
          modeName: e.modeName,
          summary: e.summary,
          keyDecisions: e.keyDecisions,
          filesTouched: e.filesTouched,
          artifacts: e.artifacts,
          tags: e.tags,
        }));

        this.memories.set(blockData.modeName, {
          modeName: blockData.modeName,
          entries,
          totalEntries: entries.length,
          lastAccessed: new Date(blockData.lastAccessed),
        });
      }

      this.persistPath = filePath;

      debugLogger.debug(
        `Loaded mode memory from ${filePath} (${this.memories.size} blocks)`,
      );
    } catch (error) {
      debugLogger.warn(
        `Failed to load mode memory from ${filePath}:`,
        error,
      );
    }
  }

  /**
   * Clear all recorded memories.
   */
  clear(): void {
    this.memories.clear();
    debugLogger.debug('Mode memory cleared');
  }

  /**
   * Serialize a ModeMemoryEntry to a plain object.
   */
  private serializeEntry(entry: ModeMemoryEntry): MemoryData['blocks'][number]['entries'][number] {
    return {
      id: entry.id,
      timestamp: entry.timestamp.toISOString(),
      modeName: entry.modeName,
      summary: entry.summary,
      keyDecisions: entry.keyDecisions,
      filesTouched: entry.filesTouched,
      artifacts: entry.artifacts,
      tags: entry.tags,
    };
  }
}
