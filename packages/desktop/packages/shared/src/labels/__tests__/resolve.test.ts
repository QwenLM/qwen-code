import { describe, it, expect } from 'bun:test';
import { resolveSessionLabels } from '../resolve.ts';
import type { LabelConfig } from '../types.ts';

// ----- Fixture -----
// Represents a real workspace label config with every valueType shape:
// - boolean (no valueType) → `bug`, `subagent`
// - valueType: 'string'    → `parent-task`, `subtask-id`, `link`
// - valueType: 'number'    → `priority`, `effort`
// - valueType: 'date'      → `due`
// Nested child used to exercise flattenLabels traversal.
const LABELS: LabelConfig[] = [
  { id: 'bug', name: 'Bug' },
  { id: 'subagent', name: 'Subagent' },
  { id: 'parent-task', name: 'Parent Task', valueType: 'string' },
  { id: 'subtask-id', name: 'Subtask ID', valueType: 'string' },
  { id: 'link', name: 'Link', valueType: 'string' },
  { id: 'priority', name: 'Priority', valueType: 'number' },
  {
    id: 'work',
    name: 'Work',
    children: [
      { id: 'effort', name: 'Effort', valueType: 'number' },
    ],
  },
  { id: 'due', name: 'Due', valueType: 'date' },
];

describe('resolveSessionLabels', () => {
  describe('plain (boolean) labels', () => {
    it('resolves an exact ID', () => {
      const r = resolveSessionLabels(['bug'], LABELS);
      expect(r.resolved).toEqual(['bug']);
      expect(r.unknown).toEqual([]);
    });

    it('resolves by display name (case-insensitive)', () => {
      const r = resolveSessionLabels(['Bug', 'SUBAGENT'], LABELS);
      expect(r.resolved).toEqual(['bug', 'subagent']);
      expect(r.unknown).toEqual([]);
    });

    it('marks unknown labels with reason', () => {
      const r = resolveSessionLabels(['nonexistent'], LABELS);
      expect(r.resolved).toEqual([]);
      expect(r.unknown).toEqual(['nonexistent']);
      expect(r.reasons['nonexistent']).toBe('unknown label');
    });
  });

  describe('valued labels (oss#566 scenarios)', () => {
    it('resolves string-typed values', () => {
      const r = resolveSessionLabels(
        ['parent-task::TASK-123', 'subtask-id::SUB-001'],
        LABELS,
      );
      expect(r.resolved).toEqual(['parent-task::TASK-123', 'subtask-id::SUB-001']);
      expect(r.unknown).toEqual([]);
    });

    it('resolves a mixed batch (the exact #566 repro)', () => {
      const r = resolveSessionLabels(
        ['subagent', 'parent-task::TASK-123', 'subtask-id::SUB-001'],
        LABELS,
      );
      expect(r.resolved).toEqual(['subagent', 'parent-task::TASK-123', 'subtask-id::SUB-001']);
      expect(r.unknown).toEqual([]);
    });

    it('resolves number-typed values', () => {
      const r = resolveSessionLabels(['priority::3', 'effort::0.5'], LABELS);
      expect(r.resolved).toEqual(['priority::3', 'effort::0.5']);
      expect(r.unknown).toEqual([]);
    });

    it('resolves date-typed values', () => {
      const r = resolveSessionLabels(['due::2026-01-30'], LABELS);
      expect(r.resolved).toEqual(['due::2026-01-30']);
      expect(r.unknown).toEqual([]);
    });

    it('resolves valued label matched by display name (case-insensitive)', () => {
      const r = resolveSessionLabels(['Priority::5'], LABELS);
      expect(r.resolved).toEqual(['priority::5']);
    });

    it('preserves values that contain "::"', () => {
      const r = resolveSessionLabels(['link::https://a::b'], LABELS);
      expect(r.resolved).toEqual(['link::https://a::b']);
    });

    it('resolves a valued label without the value (valueType is opt-in, not required)', () => {
      const r = resolveSessionLabels(['priority'], LABELS);
      expect(r.resolved).toEqual(['priority']);
    });
  });

  describe('rejections', () => {
    it('rejects valued input on a boolean label', () => {
      const r = resolveSessionLabels(['subagent::hello'], LABELS);
      expect(r.resolved).toEqual([]);
      expect(r.unknown).toEqual(['subagent::hello']);
      expect(r.reasons['subagent::hello']).toBe(
        'label "subagent" doesn\'t accept a value (no valueType configured)',
      );
    });

    it('rejects number values that are not valid numbers', () => {
      const r = resolveSessionLabels(['priority::high'], LABELS);
      expect(r.resolved).toEqual([]);
      expect(r.unknown).toEqual(['priority::high']);
      expect(r.reasons['priority::high']).toBe(
        'label "priority" expects a number value, got "high"',
      );
    });

    it('rejects number values that use scientific notation', () => {
      const r = resolveSessionLabels(['priority::3e5'], LABELS);
      expect(r.unknown).toEqual(['priority::3e5']);
    });

    it('rejects invalid ISO dates (e.g., Feb 30)', () => {
      const r = resolveSessionLabels(['due::2026-02-30'], LABELS);
      expect(r.unknown).toEqual(['due::2026-02-30']);
      expect(r.reasons['due::2026-02-30']).toContain('expects a date value');
    });

    it('rejects non-ISO date formats', () => {
      const r = resolveSessionLabels(['due::Jan-30-2026'], LABELS);
      expect(r.unknown).toEqual(['due::Jan-30-2026']);
    });

    it('rejects unknown base ID even when input has a ::value', () => {
      const r = resolveSessionLabels(['nonexistent::42'], LABELS);
      expect(r.unknown).toEqual(['nonexistent::42']);
      expect(r.reasons['nonexistent::42']).toBe(
        'label "nonexistent" is not configured',
      );
    });
  });

  describe('mixed batches', () => {
    it('partially resolves — valid entries pass, invalid entries reported', () => {
      const r = resolveSessionLabels(
        ['bug', 'priority::high', 'parent-task::TASK-1', 'unknown'],
        LABELS,
      );
      expect(r.resolved).toEqual(['bug', 'parent-task::TASK-1']);
      expect(r.unknown).toEqual(['priority::high', 'unknown']);
      expect(Object.keys(r.reasons)).toEqual(['priority::high', 'unknown']);
    });

    it('empty input produces empty output', () => {
      const r = resolveSessionLabels([], LABELS);
      expect(r.resolved).toEqual([]);
      expect(r.unknown).toEqual([]);
    });

    it('always exposes all available IDs', () => {
      const r = resolveSessionLabels(['anything'], LABELS);
      expect(r.available).toEqual([
        'bug', 'subagent', 'parent-task', 'subtask-id', 'link',
        'priority', 'work', 'effort', 'due',
      ]);
    });
  });

  describe('nested label trees', () => {
    it('resolves a nested child label', () => {
      const r = resolveSessionLabels(['effort::2'], LABELS);
      expect(r.resolved).toEqual(['effort::2']);
    });
  });
});
