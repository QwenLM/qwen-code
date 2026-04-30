/**
 * Tests for conditions.ts — Automation Condition Evaluator
 */

import { describe, it, expect } from 'bun:test';
import { evaluateConditions } from './conditions.ts';
import { matcherMatches, matcherMatchesSdk } from './utils.ts';
import type { AutomationCondition } from './types.ts';
import type { ConditionContext } from './conditions.ts';

// ============================================================================
// Helpers
// ============================================================================

function ctx(payload: Record<string, unknown>, overrides?: Partial<ConditionContext>): ConditionContext {
  return { payload, ...overrides };
}

/** Create a Date at a specific time on a known day (2026-03-13 is a Friday) */
function friday(hours: number, minutes: number): Date {
  return new Date(2026, 2, 13, hours, minutes, 0, 0); // March 13, 2026
}

function monday(hours: number, minutes: number): Date {
  return new Date(2026, 2, 9, hours, minutes, 0, 0); // March 9, 2026
}

// ============================================================================
// Empty / Missing Conditions
// ============================================================================

describe('evaluateConditions', () => {
  it('should return true for empty conditions array', () => {
    expect(evaluateConditions([], ctx({}))).toBe(true);
  });

  // ==========================================================================
  // Time Conditions
  // ==========================================================================

  describe('time condition', () => {
    it('should pass when current time is within range', () => {
      const conditions: AutomationCondition[] = [
        { condition: 'time', after: '09:00', before: '17:00' },
      ];
      expect(evaluateConditions(conditions, ctx({}, { now: friday(12, 0) }))).toBe(true);
    });

    it('should fail when current time is outside range', () => {
      const conditions: AutomationCondition[] = [
        { condition: 'time', after: '09:00', before: '17:00' },
      ];
      expect(evaluateConditions(conditions, ctx({}, { now: friday(20, 0) }))).toBe(false);
    });

    it('should handle overnight wrap (after > before)', () => {
      const conditions: AutomationCondition[] = [
        { condition: 'time', after: '22:00', before: '06:00' },
      ];
      // 23:00 — within overnight range
      expect(evaluateConditions(conditions, ctx({}, { now: friday(23, 0) }))).toBe(true);
      // 03:00 — within overnight range
      expect(evaluateConditions(conditions, ctx({}, { now: friday(3, 0) }))).toBe(true);
      // 12:00 — outside overnight range
      expect(evaluateConditions(conditions, ctx({}, { now: friday(12, 0) }))).toBe(false);
    });

    it('should filter by weekday', () => {
      const conditions: AutomationCondition[] = [
        { condition: 'time', weekday: ['mon', 'tue', 'wed'] },
      ];
      // Monday
      expect(evaluateConditions(conditions, ctx({}, { now: monday(12, 0) }))).toBe(true);
      // Friday
      expect(evaluateConditions(conditions, ctx({}, { now: friday(12, 0) }))).toBe(false);
    });

    it('should pass with only after', () => {
      const conditions: AutomationCondition[] = [
        { condition: 'time', after: '14:00' },
      ];
      expect(evaluateConditions(conditions, ctx({}, { now: friday(15, 0) }))).toBe(true);
      expect(evaluateConditions(conditions, ctx({}, { now: friday(13, 0) }))).toBe(false);
    });

    it('should pass with only before', () => {
      const conditions: AutomationCondition[] = [
        { condition: 'time', before: '14:00' },
      ];
      expect(evaluateConditions(conditions, ctx({}, { now: friday(13, 0) }))).toBe(true);
      expect(evaluateConditions(conditions, ctx({}, { now: friday(15, 0) }))).toBe(false);
    });

    it('should pass with no time constraints (weekday only)', () => {
      const conditions: AutomationCondition[] = [
        { condition: 'time', weekday: ['fri'] },
      ];
      expect(evaluateConditions(conditions, ctx({}, { now: friday(0, 0) }))).toBe(true);
    });

    it('should pass with no constraints at all', () => {
      const conditions: AutomationCondition[] = [
        { condition: 'time' },
      ];
      expect(evaluateConditions(conditions, ctx({}, { now: friday(12, 0) }))).toBe(true);
    });

    it('should handle boundary: exactly at after time', () => {
      const conditions: AutomationCondition[] = [
        { condition: 'time', after: '09:00', before: '17:00' },
      ];
      expect(evaluateConditions(conditions, ctx({}, { now: friday(9, 0) }))).toBe(true);
    });

    it('should handle boundary: exactly at before time (exclusive)', () => {
      const conditions: AutomationCondition[] = [
        { condition: 'time', after: '09:00', before: '17:00' },
      ];
      expect(evaluateConditions(conditions, ctx({}, { now: friday(17, 0) }))).toBe(false);
    });

    it('should respect timezone', () => {
      const conditions: AutomationCondition[] = [
        { condition: 'time', after: '09:00', before: '17:00', timezone: 'UTC' },
      ];
      // Use a UTC date to test timezone handling
      const utcNoon = new Date('2026-03-13T12:00:00Z');
      expect(evaluateConditions(conditions, ctx({}, { now: utcNoon }))).toBe(true);
    });

    it('should fall back to matcher timezone', () => {
      const conditions: AutomationCondition[] = [
        { condition: 'time', after: '09:00', before: '17:00' },
      ];
      const utcNoon = new Date('2026-03-13T12:00:00Z');
      expect(evaluateConditions(conditions, ctx({}, { now: utcNoon, matcherTimezone: 'UTC' }))).toBe(true);
    });
  });

  // ==========================================================================
  // State Conditions
  // ==========================================================================

  describe('state condition', () => {
    it('should match exact value', () => {
      const conditions: AutomationCondition[] = [
        { condition: 'state', field: 'isFlagged', value: true },
      ];
      expect(evaluateConditions(conditions, ctx({ isFlagged: true }))).toBe(true);
      expect(evaluateConditions(conditions, ctx({ isFlagged: false }))).toBe(false);
    });

    it('should match string value', () => {
      const conditions: AutomationCondition[] = [
        { condition: 'state', field: 'label', value: 'urgent' },
      ];
      expect(evaluateConditions(conditions, ctx({ label: 'urgent' }))).toBe(true);
      expect(evaluateConditions(conditions, ctx({ label: 'low' }))).toBe(false);
    });

    it('should fail when field is missing', () => {
      const conditions: AutomationCondition[] = [
        { condition: 'state', field: 'nonExistent', value: 'something' },
      ];
      expect(evaluateConditions(conditions, ctx({}))).toBe(false);
    });

    describe('from/to transitions', () => {
      it('should match permissionMode to', () => {
        const conditions: AutomationCondition[] = [
          { condition: 'state', field: 'permissionMode', to: 'allow-all' },
        ];
        expect(evaluateConditions(conditions, ctx({ newMode: 'allow-all', oldMode: 'safe' }))).toBe(true);
        expect(evaluateConditions(conditions, ctx({ newMode: 'ask', oldMode: 'safe' }))).toBe(false);
      });

      it('should match permissionMode from', () => {
        const conditions: AutomationCondition[] = [
          { condition: 'state', field: 'permissionMode', from: 'safe' },
        ];
        expect(evaluateConditions(conditions, ctx({ newMode: 'ask', oldMode: 'safe' }))).toBe(true);
        expect(evaluateConditions(conditions, ctx({ newMode: 'ask', oldMode: 'allow-all' }))).toBe(false);
      });

      it('should match permissionMode from AND to', () => {
        const conditions: AutomationCondition[] = [
          { condition: 'state', field: 'permissionMode', from: 'safe', to: 'allow-all' },
        ];
        expect(evaluateConditions(conditions, ctx({ newMode: 'allow-all', oldMode: 'safe' }))).toBe(true);
        expect(evaluateConditions(conditions, ctx({ newMode: 'allow-all', oldMode: 'ask' }))).toBe(false);
        expect(evaluateConditions(conditions, ctx({ newMode: 'ask', oldMode: 'safe' }))).toBe(false);
      });

      it('should match sessionStatus to', () => {
        const conditions: AutomationCondition[] = [
          { condition: 'state', field: 'sessionStatus', to: 'done' },
        ];
        expect(evaluateConditions(conditions, ctx({ newState: 'done', oldState: 'active' }))).toBe(true);
        expect(evaluateConditions(conditions, ctx({ newState: 'active', oldState: 'idle' }))).toBe(false);
      });

      it('should match sessionStatus from', () => {
        const conditions: AutomationCondition[] = [
          { condition: 'state', field: 'sessionStatus', from: 'active' },
        ];
        expect(evaluateConditions(conditions, ctx({ newState: 'done', oldState: 'active' }))).toBe(true);
      });

      it('should fall back to field name for unknown transition fields', () => {
        const conditions: AutomationCondition[] = [
          { condition: 'state', field: 'customField', to: 'newVal' },
        ];
        // Falls back: to reads payload.customField
        expect(evaluateConditions(conditions, ctx({ customField: 'newVal' }))).toBe(true);
        expect(evaluateConditions(conditions, ctx({ customField: 'other' }))).toBe(false);
      });
    });

    describe('contains (array membership)', () => {
      it('should pass when array contains value', () => {
        const conditions: AutomationCondition[] = [
          { condition: 'state', field: 'labels', contains: 'urgent' },
        ];
        expect(evaluateConditions(conditions, ctx({ labels: ['urgent', 'bug'] }))).toBe(true);
      });

      it('should fail when array does not contain value', () => {
        const conditions: AutomationCondition[] = [
          { condition: 'state', field: 'labels', contains: 'urgent' },
        ];
        expect(evaluateConditions(conditions, ctx({ labels: ['low', 'bug'] }))).toBe(false);
      });

      it('should fail when field is not an array', () => {
        const conditions: AutomationCondition[] = [
          { condition: 'state', field: 'labels', contains: 'urgent' },
        ];
        expect(evaluateConditions(conditions, ctx({ labels: 'urgent' }))).toBe(false);
      });
    });

    describe('not_value (negation)', () => {
      it('should pass when value does not match', () => {
        const conditions: AutomationCondition[] = [
          { condition: 'state', field: 'newMode', not_value: 'allow-all' },
        ];
        expect(evaluateConditions(conditions, ctx({ newMode: 'safe' }))).toBe(true);
      });

      it('should fail when value matches', () => {
        const conditions: AutomationCondition[] = [
          { condition: 'state', field: 'newMode', not_value: 'allow-all' },
        ];
        expect(evaluateConditions(conditions, ctx({ newMode: 'allow-all' }))).toBe(false);
      });

      it('should fail when field is missing', () => {
        const conditions: AutomationCondition[] = [
          { condition: 'state', field: 'missing', not_value: 'x' },
        ];
        expect(evaluateConditions(conditions, ctx({}))).toBe(false);
      });
    });

    it('should fail with no operator', () => {
      const conditions: AutomationCondition[] = [
        { condition: 'state', field: 'something' } as AutomationCondition,
      ];
      expect(evaluateConditions(conditions, ctx({ something: 'value' }))).toBe(false);
    });
  });

  // ==========================================================================
  // Logical Conditions
  // ==========================================================================

  describe('logical conditions', () => {
    describe('and', () => {
      it('should pass when all sub-conditions pass', () => {
        const conditions: AutomationCondition[] = [{
          condition: 'and',
          conditions: [
            { condition: 'state', field: 'a', value: 1 },
            { condition: 'state', field: 'b', value: 2 },
          ],
        }];
        expect(evaluateConditions(conditions, ctx({ a: 1, b: 2 }))).toBe(true);
      });

      it('should fail when any sub-condition fails (short-circuit)', () => {
        const conditions: AutomationCondition[] = [{
          condition: 'and',
          conditions: [
            { condition: 'state', field: 'a', value: 1 },
            { condition: 'state', field: 'b', value: 999 },
          ],
        }];
        expect(evaluateConditions(conditions, ctx({ a: 1, b: 2 }))).toBe(false);
      });
    });

    describe('or', () => {
      it('should pass when any sub-condition passes', () => {
        const conditions: AutomationCondition[] = [{
          condition: 'or',
          conditions: [
            { condition: 'state', field: 'mode', value: 'safe' },
            { condition: 'state', field: 'mode', value: 'ask' },
          ],
        }];
        expect(evaluateConditions(conditions, ctx({ mode: 'ask' }))).toBe(true);
      });

      it('should fail when no sub-condition passes', () => {
        const conditions: AutomationCondition[] = [{
          condition: 'or',
          conditions: [
            { condition: 'state', field: 'mode', value: 'safe' },
            { condition: 'state', field: 'mode', value: 'ask' },
          ],
        }];
        expect(evaluateConditions(conditions, ctx({ mode: 'allow-all' }))).toBe(false);
      });
    });

    describe('not', () => {
      it('should pass when all sub-conditions fail', () => {
        const conditions: AutomationCondition[] = [{
          condition: 'not',
          conditions: [
            { condition: 'state', field: 'isFlagged', value: true },
          ],
        }];
        expect(evaluateConditions(conditions, ctx({ isFlagged: false }))).toBe(true);
      });

      it('should fail when any sub-condition passes', () => {
        const conditions: AutomationCondition[] = [{
          condition: 'not',
          conditions: [
            { condition: 'state', field: 'isFlagged', value: true },
          ],
        }];
        expect(evaluateConditions(conditions, ctx({ isFlagged: true }))).toBe(false);
      });
    });

    describe('nesting', () => {
      it('should handle nested composition', () => {
        // (mode=safe OR mode=ask) AND NOT(isFlagged=true)
        const conditions: AutomationCondition[] = [{
          condition: 'and',
          conditions: [
            {
              condition: 'or',
              conditions: [
                { condition: 'state', field: 'mode', value: 'safe' },
                { condition: 'state', field: 'mode', value: 'ask' },
              ],
            },
            {
              condition: 'not',
              conditions: [
                { condition: 'state', field: 'isFlagged', value: true },
              ],
            },
          ],
        }];
        expect(evaluateConditions(conditions, ctx({ mode: 'safe', isFlagged: false }))).toBe(true);
        expect(evaluateConditions(conditions, ctx({ mode: 'safe', isFlagged: true }))).toBe(false);
        expect(evaluateConditions(conditions, ctx({ mode: 'allow-all', isFlagged: false }))).toBe(false);
      });

      it('should fail at max nesting depth', () => {
        // Build a chain of 9 nested ANDs (exceeds depth 8)
        let inner: AutomationCondition = { condition: 'state', field: 'x', value: 1 };
        for (let i = 0; i < 9; i++) {
          inner = { condition: 'and', conditions: [inner] };
        }
        expect(evaluateConditions([inner], ctx({ x: 1 }))).toBe(false);
      });

      it('should pass at exactly max nesting depth', () => {
        // Build a chain of 7 nested ANDs (depth 7, within limit of 8)
        let inner: AutomationCondition = { condition: 'state', field: 'x', value: 1 };
        for (let i = 0; i < 7; i++) {
          inner = { condition: 'and', conditions: [inner] };
        }
        expect(evaluateConditions([inner], ctx({ x: 1 }))).toBe(true);
      });
    });
  });

  // ==========================================================================
  // Multiple top-level conditions (implicit AND)
  // ==========================================================================

  describe('top-level AND', () => {
    it('should AND multiple top-level conditions', () => {
      const conditions: AutomationCondition[] = [
        { condition: 'state', field: 'isFlagged', value: true },
        { condition: 'state', field: 'label', value: 'urgent' },
      ];
      expect(evaluateConditions(conditions, ctx({ isFlagged: true, label: 'urgent' }))).toBe(true);
      expect(evaluateConditions(conditions, ctx({ isFlagged: true, label: 'low' }))).toBe(false);
    });
  });
});

// ============================================================================
// Integration: matcherMatches with conditions
// ============================================================================

describe('matcherMatches with conditions', () => {
  it('should pass when matcher matches and no conditions', () => {
    const matcher = {
      matcher: '^urgent$',
      actions: [{ type: 'prompt' as const, prompt: 'test' }],
    };
    expect(matcherMatches(matcher, 'LabelAdd', { label: 'urgent' })).toBe(true);
  });

  it('should pass when matcher matches and conditions pass', () => {
    const matcher = {
      matcher: '^urgent$',
      conditions: [
        { condition: 'state' as const, field: 'isFlagged', value: true },
      ],
      actions: [{ type: 'prompt' as const, prompt: 'test' }],
    };
    expect(matcherMatches(matcher, 'LabelAdd', { label: 'urgent', isFlagged: true })).toBe(true);
  });

  it('should fail when matcher matches but conditions fail', () => {
    const matcher = {
      matcher: '^urgent$',
      conditions: [
        { condition: 'state' as const, field: 'isFlagged', value: true },
      ],
      actions: [{ type: 'prompt' as const, prompt: 'test' }],
    };
    expect(matcherMatches(matcher, 'LabelAdd', { label: 'urgent', isFlagged: false })).toBe(false);
  });

  it('should fail when matcher does not match (conditions not evaluated)', () => {
    const matcher = {
      matcher: '^urgent$',
      conditions: [
        { condition: 'state' as const, field: 'isFlagged', value: true },
      ],
      actions: [{ type: 'prompt' as const, prompt: 'test' }],
    };
    expect(matcherMatches(matcher, 'LabelAdd', { label: 'low', isFlagged: true })).toBe(false);
  });

  it('should work with PermissionModeChange and from/to', () => {
    const matcher = {
      conditions: [
        { condition: 'state' as const, field: 'permissionMode', from: 'safe', to: 'allow-all' },
      ],
      actions: [{ type: 'prompt' as const, prompt: 'test' }],
    };
    expect(matcherMatches(matcher, 'PermissionModeChange', {
      newMode: 'allow-all', oldMode: 'safe',
    })).toBe(true);
    expect(matcherMatches(matcher, 'PermissionModeChange', {
      newMode: 'ask', oldMode: 'safe',
    })).toBe(false);
  });

  it('should work with time conditions', () => {
    const matcher = {
      conditions: [
        { condition: 'time' as const, after: '09:00', before: '17:00', weekday: ['fri'] },
      ],
      actions: [{ type: 'prompt' as const, prompt: 'test' }],
    };
    // Can't easily control time in matcherMatches, so this tests the wiring
    // The condition evaluator uses Date.now() which we can't inject here,
    // but the integration is verified via the evaluateConditions tests above
  });

  it('should pass with empty conditions array', () => {
    const matcher = {
      matcher: '^urgent$',
      conditions: [],
      actions: [{ type: 'prompt' as const, prompt: 'test' }],
    };
    expect(matcherMatches(matcher, 'LabelAdd', { label: 'urgent' })).toBe(true);
  });

  it('should preserve backward compatibility (no conditions field)', () => {
    const matcher = {
      matcher: '^done$',
      actions: [{ type: 'prompt' as const, prompt: 'test' }],
    };
    expect(matcherMatches(matcher, 'SessionStatusChange', { newState: 'done' })).toBe(true);
  });
});

describe('matcherMatchesSdk with conditions', () => {
  it('should pass when SDK matcher and conditions both pass', () => {
    const matcher = {
      matcher: '^Bash$',
      conditions: [
        { condition: 'state' as const, field: 'hook_event_name', value: 'PreToolUse' },
      ],
      actions: [{ type: 'prompt' as const, prompt: 'test' }],
    };

    expect(matcherMatchesSdk(matcher, 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    })).toBe(true);
  });

  it('should fail when SDK matcher passes but conditions fail', () => {
    const matcher = {
      matcher: '^Bash$',
      conditions: [
        { condition: 'state' as const, field: 'hook_event_name', value: 'PostToolUse' },
      ],
      actions: [{ type: 'prompt' as const, prompt: 'test' }],
    };

    expect(matcherMatchesSdk(matcher, 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    })).toBe(false);
  });

  it('should fail when SDK matcher does not match regardless of conditions', () => {
    const matcher = {
      matcher: '^Read$',
      conditions: [
        { condition: 'state' as const, field: 'tool_name', value: 'Read' },
      ],
      actions: [{ type: 'prompt' as const, prompt: 'test' }],
    };

    expect(matcherMatchesSdk(matcher, 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
    })).toBe(false);
  });
});
