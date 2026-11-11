/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Type definitions for the auto-memory system.
 *
 * The auto-memory system stores structured memory entries as individual
 * Markdown files with YAML frontmatter. Four memory types are supported:
 *   - user:      User profile, preferences, expertise
 *   - feedback:  User corrections and confirmed patterns
 *   - project:   Project context not derivable from code
 *   - reference: Pointers to external systems and resources
 */

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryEntry {
  /** The display name of the memory (from frontmatter). */
  name: string;
  /** A short description of the memory (from frontmatter). */
  description: string;
  /** The category of this memory. */
  type: MemoryType;
  /** Absolute path to the memory file on disk. */
  filePath?: string;
  /** The body content of the memory file (after frontmatter). */
  content: string;
}
