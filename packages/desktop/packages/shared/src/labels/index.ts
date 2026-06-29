/**
 * Labels Module
 *
 * Configurable session labels for workspaces.
 * Labels are additive tags (many-per-session), unlike statuses which are exclusive.
 * Hierarchy is encoded as a nested JSON tree (children arrays).
 *
 * This barrel is browser-safe (no Node.js dependencies).
 * For filesystem operations, import from '@craft-agent/shared/labels/storage'.
 */

// Types
export * from './types.ts';

// Tree utilities (recursive operations on the nested label tree)
export * from './tree.ts';

// Value utilities (parse/format label::value entries)
export * from './values.ts';

// Session label resolution (validate user input against configured labels)
export * from './resolve.ts';

// Auto-labels: import directly from '@craft-agent/shared/labels/auto' to keep
// regex evaluation code out of the renderer bundle (backend-only concern).
