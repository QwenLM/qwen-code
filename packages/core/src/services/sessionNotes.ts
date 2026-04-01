/**
 * @license
 * Copyright 2025 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';

const logger = createDebugLogger('SESSION_NOTES');

const SESSION_NOTES_FILENAME = 'session-notes.md';

const TEMPLATE = `# Session Notes

## Current State
_Where things stand right now — vital for continuity after compaction_

## Task Specification
_What was asked for and acceptance criteria_

## Files and Functions
_Which files and functions were touched or are relevant_

## Errors and Corrections
_Problems hit and how they were resolved_

## Learnings
_Insights gained that apply beyond this session_

## Worklog
_Chronological record of significant actions_
`;

/**
 * Section names in the session notes file. Content lives BELOW the
 * italic description line under each heading.
 */
export type SessionNoteSection =
  | 'Current State'
  | 'Task Specification'
  | 'Files and Functions'
  | 'Errors and Corrections'
  | 'Learnings'
  | 'Worklog';

/**
 * Get the path to the session notes file for the project.
 */
export function getSessionNotesPath(projectDir: string): string {
  return path.join(projectDir, '.proto', SESSION_NOTES_FILENAME);
}

/**
 * Read the full session notes file. Returns null if it doesn't exist.
 */
export async function readSessionNotes(
  projectDir: string,
): Promise<string | null> {
  const filePath = getSessionNotesPath(projectDir);
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Initialize the session notes file from the template. Creates the
 * `.proto/` directory if needed. Overwrites any existing file.
 */
export async function initSessionNotes(projectDir: string): Promise<void> {
  const filePath = getSessionNotesPath(projectDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, TEMPLATE, 'utf-8');
  logger.debug('Session notes initialized');
}

/**
 * Update a specific section of the session notes. Replaces all content
 * between the section heading (+ italic description) and the next `## `
 * heading. Creates the file from template if it doesn't exist.
 */
export async function updateSessionNoteSection(
  projectDir: string,
  section: SessionNoteSection,
  content: string,
): Promise<void> {
  const filePath = getSessionNotesPath(projectDir);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    raw = TEMPLATE;
  }

  const heading = `## ${section}`;
  const headingIdx = raw.indexOf(heading);
  if (headingIdx === -1) {
    logger.warn(`Section "${section}" not found in session notes`);
    return;
  }

  // Find the end of the italic description line (first blank line after heading)
  const afterHeading = raw.indexOf('\n', headingIdx);
  if (afterHeading === -1) return;

  // Skip the italic description line
  const descLineEnd = raw.indexOf('\n', afterHeading + 1);
  if (descLineEnd === -1) return;

  // Find the next section heading (## ) or end of file
  const nextHeading = raw.indexOf('\n## ', descLineEnd);
  const sectionEnd = nextHeading === -1 ? raw.length : nextHeading;

  // Replace the content between description and next heading
  const before = raw.slice(0, descLineEnd + 1);
  const after = raw.slice(sectionEnd);
  const updated = `${before}\n${content.trim()}\n${after}`;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, updated, 'utf-8');
}

/**
 * Clear the session notes file by resetting to the template.
 */
export async function clearSessionNotes(projectDir: string): Promise<void> {
  await initSessionNotes(projectDir);
}
