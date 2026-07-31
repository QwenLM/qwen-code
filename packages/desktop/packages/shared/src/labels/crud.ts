/**
 * Label CRUD Operations
 *
 * Create, Read, Update, Delete, Move, Reorder operations for the label tree.
 * All operations work on the nested JSON tree structure.
 * Delete cascade strips the label (and descendants) from all sessions.
 */

import { loadLabelConfig, saveLabelConfig, isValidLabelId, isValidLabelIdFormat } from './storage.ts';
import { findLabelById, collectAllIds, getDescendantIds, getLabelDisplayName } from './tree.ts';
import { extractLabelId, parseLabelEntry, formatLabelEntry } from './values.ts';
import type { LabelConfig, CreateLabelInput, UpdateLabelInput } from './types.ts';

/**
 * Generate URL-safe slug from name
 */
function generateLabelSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 30);
}

/**
 * Create a new label.
 * Inserts into the specified parent's children array, or at root level.
 * Generates a globally unique slug from the name.
 */
export function createLabel(
  workspaceRootPath: string,
  input: CreateLabelInput
): LabelConfig {
  const config = loadLabelConfig(workspaceRootPath);

  // Generate unique ID across the entire tree
  const existingIds = collectAllIds(config.labels);
  let id = generateLabelSlug(input.name);
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `${generateLabelSlug(input.name)}-${suffix}`;
    suffix++;
  }

  const label: LabelConfig = {
    id,
    name: input.name,
    color: input.color,
    ...(input.valueType && { valueType: input.valueType }),
  };

  if (input.parentId) {
    // Insert as child of the specified parent
    const parent = findLabelById(config.labels, input.parentId);
    if (!parent) {
      throw new Error(`Parent label '${input.parentId}' not found`);
    }
    if (!parent.children) parent.children = [];
    parent.children.push(label);
  } else {
    // Insert at root level
    config.labels.push(label);
  }

  saveLabelConfig(workspaceRootPath, config);
  return label;
}

/**
 * Ensure all label entries reference labels that exist in the workspace config.
 * For each entry, if the label ID doesn't exist, auto-creates it with a
 * titlecased name derived from the slug. Returns resolved entries with the
 * actual created IDs (handles any slug mismatch from createLabel).
 *
 * Entries with invalid ID format are passed through unchanged.
 */
export function ensureLabelsExist(
  workspaceRootPath: string,
  labels: string[]
): string[] {
  return labels.map(label => {
    const { id: labelId, rawValue } = parseLabelEntry(label)

    if (isValidLabelId(workspaceRootPath, labelId)) return label
    if (!isValidLabelIdFormat(labelId)) return label

    // getLabelDisplayName with empty tree falls back to titlecased slug
    const name = getLabelDisplayName([], labelId)

    const created = createLabel(workspaceRootPath, {
      name,
      color: 'foreground/50',
    })

    // Return entry with the actual created ID (handles slug mismatch)
    return formatLabelEntry(created.id, rawValue)
  })
}

/**
 * Update an existing label (name, color, valueType).
 * Cannot change the ID or hierarchy position.
 * @throws Error if label not found
 */
export function updateLabel(
  workspaceRootPath: string,
  labelId: string,
  updates: UpdateLabelInput
): LabelConfig {
  const config = loadLabelConfig(workspaceRootPath);
  const label = findLabelById(config.labels, labelId);

  if (!label) {
    throw new Error(`Label '${labelId}' not found`);
  }

  if (updates.name !== undefined) label.name = updates.name;
  if (updates.color !== undefined) label.color = updates.color;
  // valueType: set to new value, or delete to revert to boolean label
  if (updates.valueType !== undefined) label.valueType = updates.valueType || undefined;

  saveLabelConfig(workspaceRootPath, config);
  return label;
}

/**
 * Delete a label and all its descendants.
 * Strips removed labels from all sessions that reference them.
 * @returns Number of sessions that had labels stripped
 */
export function deleteLabel(
  workspaceRootPath: string,
  labelId: string
): { stripped: number } {
  const config = loadLabelConfig(workspaceRootPath);

  // Collect all IDs that will be removed (the label + all descendants)
  const descendantIds = getDescendantIds(config.labels, labelId);
  const removedIds = [labelId, ...descendantIds];

  // Remove the node from its parent's children array (or from root)
  const removed = removeNodeFromTree(config.labels, labelId);
  if (!removed) {
    throw new Error(`Label '${labelId}' not found`);
  }

  saveLabelConfig(workspaceRootPath, config);

  // Strip all removed IDs from sessions
  let stripped = 0;
  for (const id of removedIds) {
    stripped += stripLabelFromSessions(workspaceRootPath, id);
  }

  return { stripped };
}

/**
 * Reorder labels within a parent's children (or root level).
 * Provide the full ordered list of sibling IDs at that level.
 * @param parentId - null for root level, or the parent label's ID
 * @param orderedIds - New order of child IDs at that level
 */
export function reorderLabels(
  workspaceRootPath: string,
  parentId: string | null,
  orderedIds: string[]
): void {
  const config = loadLabelConfig(workspaceRootPath);

  // Get the target array (root labels or a parent's children)
  let siblings: LabelConfig[];
  if (parentId) {
    const parent = findLabelById(config.labels, parentId);
    if (!parent) throw new Error(`Parent label '${parentId}' not found`);
    if (!parent.children) throw new Error(`Parent label '${parentId}' has no children`);
    siblings = parent.children;
  } else {
    siblings = config.labels;
  }

  // Validate that orderedIds match the current siblings
  const siblingIds = new Set(siblings.map(l => l.id));
  for (const id of orderedIds) {
    if (!siblingIds.has(id)) {
      throw new Error(`Invalid label ID for reorder: '${id}'`);
    }
  }

  // Build a map for quick lookup, then reorder the array in place
  const map = new Map(siblings.map(l => [l.id, l]));
  const reordered = orderedIds.map(id => map.get(id)!);

  // Replace the array contents (preserving the same reference for root)
  if (parentId) {
    const parent = findLabelById(config.labels, parentId)!;
    parent.children = reordered;
  } else {
    config.labels.length = 0;
    config.labels.push(...reordered);
  }

  saveLabelConfig(workspaceRootPath, config);
}

/**
 * Move a label to a different parent (or to root level).
 * The label keeps its ID and children intact.
 * @param newParentId - null to move to root, or target parent's ID
 */
export function moveLabel(
  workspaceRootPath: string,
  labelId: string,
  newParentId: string | null
): void {
  const config = loadLabelConfig(workspaceRootPath);

  // Prevent moving a label into its own descendant (would create a cycle)
  if (newParentId) {
    const descendants = getDescendantIds(config.labels, labelId);
    if (descendants.includes(newParentId)) {
      throw new Error(`Cannot move label '${labelId}' into its own descendant '${newParentId}'`);
    }
  }

  // Remove from current location (preserving the node reference)
  const node = removeNodeFromTree(config.labels, labelId);
  if (!node) {
    throw new Error(`Label '${labelId}' not found`);
  }

  // Insert into new location
  if (newParentId) {
    const newParent = findLabelById(config.labels, newParentId);
    if (!newParent) throw new Error(`Target parent '${newParentId}' not found`);
    if (!newParent.children) newParent.children = [];
    newParent.children.push(node);
  } else {
    config.labels.push(node);
  }

  saveLabelConfig(workspaceRootPath, config);
}

// ============================================================
// Internal Helpers
// ============================================================

/**
 * Remove a node from the tree by ID. Returns the removed node or null.
 * Mutates the tree in place (removes from parent's children or root array).
 */
function removeNodeFromTree(labels: LabelConfig[], targetId: string): LabelConfig | null {
  // Check root level
  const rootIndex = labels.findIndex(l => l.id === targetId);
  if (rootIndex !== -1) {
    return labels.splice(rootIndex, 1)[0]!;
  }

  // Recurse into children
  for (const node of labels) {
    if (node.children) {
      const childIndex = node.children.findIndex(c => c.id === targetId);
      if (childIndex !== -1) {
        return node.children.splice(childIndex, 1)[0]!;
      }
      const found = removeNodeFromTree(node.children, targetId);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Strip a deleted label from all sessions.
 * Removes entries matching the label ID, including valued entries (e.g., "priority::3").
 * Uses extractLabelId to match both "bug" and "priority::3" style entries.
 */
function stripLabelFromSessions(
  workspaceRootPath: string,
  deletedLabelId: string
): number {
  // Dynamic import to avoid circular dependency with sessions module
  const { listSessions, updateSessionMetadata } = require('../sessions/storage.ts');

  const sessions = listSessions(workspaceRootPath);
  let strippedCount = 0;

  for (const session of sessions) {
    // Check if any entry matches the deleted label ID (handles both boolean and valued entries)
    if (session.labels && session.labels.some((entry: string) => extractLabelId(entry) === deletedLabelId)) {
      const updatedLabels = session.labels.filter((entry: string) => extractLabelId(entry) !== deletedLabelId);
      updateSessionMetadata(workspaceRootPath, session.id, { labels: updatedLabels });
      strippedCount++;
    }
  }

  return strippedCount;
}
