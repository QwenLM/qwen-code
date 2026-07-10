/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadRoutingConfig,
  loadRoutingConfigFile,
  compileRouting,
  RoutingError,
  type RoutingSubscription,
} from './rules.js';

describe('loadRoutingConfig', () => {
  it('parses a valid drop-rule document', () => {
    const cfg = loadRoutingConfig(`
version: 1
rules:
  - id: silence-completions
    match:
      kind: task.completed
    route:
      drop: true
`);
    expect(cfg.version).toBe(1);
    expect(cfg.rules).toHaveLength(1);
    expect(cfg.rules[0]).toMatchObject({
      id: 'silence-completions',
      match: { kind: 'task.completed' },
      route: { drop: true },
    });
  });

  it('empty/blank document → no rules', () => {
    expect(loadRoutingConfig('')).toEqual({ rules: [] });
    expect(loadRoutingConfig('{}')).toEqual({ rules: [] });
  });

  it('keeps a string-list kind and a sessionTag', () => {
    const cfg = loadRoutingConfig(`
rules:
  - match:
      kind: [task.completed, permission.required]
      sessionTag: "*scratch*"
    route: { drop: true }
`);
    expect(cfg.rules[0].match.kind).toEqual([
      'task.completed',
      'permission.required',
    ]);
    expect(cfg.rules[0].match.sessionTag).toBe('*scratch*');
  });

  it('ignores unknown top-level + rule fields (forward-compat)', () => {
    const cfg = loadRoutingConfig(`
foo: bar
rules:
  - id: r1
    match: { kind: task.completed }
    route: { drop: true }
    extra: nope
`);
    expect(cfg.rules[0]).toMatchObject({ id: 'r1', route: { drop: true } });
  });

  it('non-object document → RoutingError', () => {
    expect(() => loadRoutingConfig('- a\n- b')).toThrow(RoutingError);
    expect(() => loadRoutingConfig('hello')).toThrow(RoutingError);
  });

  it('rules not a sequence → RoutingError', () => {
    expect(() => loadRoutingConfig('rules: {}')).toThrow(RoutingError);
  });

  it('rule without object match/route → RoutingError', () => {
    expect(() =>
      loadRoutingConfig('rules:\n  - route: { drop: true }'),
    ).toThrow(RoutingError);
    expect(() => loadRoutingConfig('rules:\n  - match: { kind: x }')).toThrow(
      RoutingError,
    );
  });

  it('match.kind not a string/list → RoutingError', () => {
    expect(() =>
      loadRoutingConfig(
        'rules:\n  - match: { kind: 7 }\n    route: { drop: true }',
      ),
    ).toThrow(RoutingError);
    expect(() =>
      loadRoutingConfig(
        'rules:\n  - match: { kind: [a, 7] }\n    route: { drop: true }',
      ),
    ).toThrow(RoutingError);
  });

  it('route.drop not a boolean → RoutingError', () => {
    expect(() =>
      loadRoutingConfig(
        'rules:\n  - match: { kind: x }\n    route: { drop: "yes" }',
      ),
    ).toThrow(RoutingError);
  });

  it('keeps scopeIn/tokenIdsIn as string and as string-list', () => {
    const cfg = loadRoutingConfig(`
rules:
  - match:
      scopeIn: share
      tokenIdsIn: [t1, t2]
    route: { drop: true }
`);
    expect(cfg.rules[0].match.scopeIn).toBe('share');
    expect(cfg.rules[0].match.tokenIdsIn).toEqual(['t1', 't2']);
  });

  it('malformed scopeIn/tokenIdsIn → RoutingError', () => {
    expect(() =>
      loadRoutingConfig(
        'rules:\n  - match: { scopeIn: 7 }\n    route: { drop: true }',
      ),
    ).toThrow(RoutingError);
    expect(() =>
      loadRoutingConfig(
        'rules:\n  - match: { tokenIdsIn: [a, 7] }\n    route: { drop: true }',
      ),
    ).toThrow(RoutingError);
  });
});

describe('loadRoutingConfig deferred-field warning (fresh module per case)', () => {
  it('warns ONCE when a rule uses an unhonored match/route field', async () => {
    vi.resetModules();
    const { loadRoutingConfig: fresh } = await import('./rules.js');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fresh(`
rules:
  - match: { kind: task.completed, policy.action: allow }
    route: { drop: true, urgency: high }
  - match: { sessionTag: "*x*" }
    route: { drop: true }
`);
    fresh(
      'rules:\n  - match: { originatingClientScope: owner }\n    route: { drop: true }',
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const msg = spy.mock.calls[0][0] as string;
    expect(msg).toContain('route.urgency');
    spy.mockRestore();
  });

  it('does NOT warn for a clean kind/sessionTag + drop doc', async () => {
    vi.resetModules();
    const { loadRoutingConfig: fresh } = await import('./rules.js');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fresh(`
rules:
  - match: { kind: task.completed, sessionTag: "*x*" }
    route: { drop: true }
`);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does NOT warn for now-honored scopeIn/tokenIdsIn (cycle 33)', async () => {
    vi.resetModules();
    const { loadRoutingConfig: fresh } = await import('./rules.js');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fresh(`
rules:
  - match: { scopeIn: [share], tokenIdsIn: [t1] }
    route: { drop: true }
`);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('loadRoutingConfigFile', () => {
  it('absent file → null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-routing-'));
    await expect(
      loadRoutingConfigFile(join(dir, 'missing.yaml')),
    ).resolves.toBeNull();
  });

  it('present but malformed → rejects RoutingError', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-routing-'));
    const p = join(dir, 'routing.yaml');
    writeFileSync(p, 'rules: not-a-sequence');
    await expect(loadRoutingConfigFile(p)).rejects.toThrow(RoutingError);
  });
});

describe('compileRouting / firstDrop', () => {
  const matcher = (yaml: string) => compileRouting(loadRoutingConfig(yaml));

  it('kind equality matches, mismatch falls through', () => {
    const m = matcher(`
rules:
  - id: drop-completions
    match: { kind: task.completed }
    route: { drop: true }
`);
    expect(m.firstDrop({ kind: 'task.completed' })).toBe('drop-completions');
    expect(m.firstDrop({ kind: 'permission.required' })).toBeNull();
  });

  it('kind list membership', () => {
    const m = matcher(`
rules:
  - id: r
    match: { kind: [task.completed, mention] }
    route: { drop: true }
`);
    expect(m.firstDrop({ kind: 'mention' })).toBe('r');
    expect(m.firstDrop({ kind: 'permission.required' })).toBeNull();
  });

  it('absent kind matches any kind', () => {
    const m = matcher(`
rules:
  - id: drop-session
    match: { sessionTag: "*scratch*" }
    route: { drop: true }
`);
    expect(
      m.firstDrop({ kind: 'permission.required', sessionName: 'scratch-1' }),
    ).toBe('drop-session');
    expect(
      m.firstDrop({ kind: 'task.completed', sessionName: 'prod' }),
    ).toBeNull();
  });

  it('sessionTag present but no sessionName → no drop (safe direction)', () => {
    const m = matcher(`
rules:
  - match: { sessionTag: "*x*" }
    route: { drop: true }
`);
    expect(m.firstDrop({ kind: 'task.completed' })).toBeNull();
  });

  it('AND across kind + sessionTag', () => {
    const m = matcher(`
rules:
  - id: r
    match: { kind: task.completed, sessionTag: "*demo*" }
    route: { drop: true }
`);
    expect(
      m.firstDrop({ kind: 'task.completed', sessionName: 'demo-app' }),
    ).toBe('r');
    // kind matches but sessionTag doesn't
    expect(
      m.firstDrop({ kind: 'task.completed', sessionName: 'prod' }),
    ).toBeNull();
  });

  it('first matching drop rule wins; unnamed → <unnamed>', () => {
    const m = matcher(`
rules:
  - match: { kind: task.completed }
    route: { drop: true }
  - id: second
    match: { kind: task.completed }
    route: { drop: true }
`);
    expect(m.firstDrop({ kind: 'task.completed' })).toBe('<unnamed>');
  });

  it('an explicit empty-string id still suppresses (reported as <unnamed>)', () => {
    // Regression: `id: ""` must not make firstDrop return a falsy '' that the
    // notifier's truthiness gate would skip — it must still suppress.
    const m = matcher(`
rules:
  - id: ""
    match: { kind: task.completed }
    route: { drop: true }
`);
    expect(m.firstDrop({ kind: 'task.completed' })).toBe('<unnamed>');
  });

  it('a non-drop rule never suppresses', () => {
    const m = matcher(`
rules:
  - id: not-a-drop
    match: { kind: task.completed }
    route: { drop: false }
  - id: no-drop-field
    match: { kind: task.completed }
    route: { urgency: high }
`);
    expect(m.firstDrop({ kind: 'task.completed' })).toBeNull();
  });
});

describe('compileRouting / firstDropForSubscription (cycle 33)', () => {
  const matcher = (yaml: string) => compileRouting(loadRoutingConfig(yaml));
  const sub = (
    tokenId: string,
    scopes: readonly string[],
  ): RoutingSubscription => ({ tokenId, scopes });
  const PERM = { kind: 'permission.required' as const };

  it('scopeIn drops a sub whose token holds a listed scope, not one without', () => {
    const m = matcher(`
rules:
  - id: mute-guests
    match: { scopeIn: [share] }
    route: { drop: true }
`);
    expect(
      m.firstDropForSubscription?.(PERM, sub('g', ['session:read', 'share'])),
    ).toBe('mute-guests');
    expect(
      m.firstDropForSubscription?.(PERM, sub('a', ['session:read', 'approve'])),
    ).toBeNull();
  });

  it('tokenIdsIn drops only the listed token ids', () => {
    const m = matcher(`
rules:
  - id: mute-devices
    match: { tokenIdsIn: [t1] }
    route: { drop: true }
`);
    expect(m.firstDropForSubscription?.(PERM, sub('t1', ['approve']))).toBe(
      'mute-devices',
    );
    expect(
      m.firstDropForSubscription?.(PERM, sub('t2', ['approve'])),
    ).toBeNull();
  });

  it('AND across kind + scopeIn (both must match)', () => {
    const m = matcher(`
rules:
  - id: r
    match: { kind: permission.required, scopeIn: [share] }
    route: { drop: true }
`);
    // share but wrong kind → no drop
    expect(
      m.firstDropForSubscription?.(
        { kind: 'task.completed' },
        sub('g', ['share']),
      ),
    ).toBeNull();
    // right kind but no share → no drop
    expect(
      m.firstDropForSubscription?.(PERM, sub('a', ['approve'])),
    ).toBeNull();
    // both → drop
    expect(m.firstDropForSubscription?.(PERM, sub('g', ['share']))).toBe('r');
  });

  it('empty scopeIn / tokenIdsIn drops nobody (D5)', () => {
    const ms = matcher(`
rules:
  - id: r
    match: { scopeIn: [] }
    route: { drop: true }
`);
    expect(ms.firstDropForSubscription?.(PERM, sub('g', ['share']))).toBeNull();
    const mt = matcher(`
rules:
  - id: r
    match: { tokenIdsIn: [] }
    route: { drop: true }
`);
    expect(mt.firstDropForSubscription?.(PERM, sub('g', ['share']))).toBeNull();
  });

  it('first matching per-sub drop wins; unnamed → <unnamed>', () => {
    const m = matcher(`
rules:
  - match: { scopeIn: [share] }
    route: { drop: true }
  - id: second
    match: { scopeIn: [share] }
    route: { drop: true }
`);
    expect(m.firstDropForSubscription?.(PERM, sub('g', ['share']))).toBe(
      '<unnamed>',
    );
  });

  it('SAFETY: a per-sub rule never suppresses the whole fan-out (firstDrop=null)', () => {
    const m = matcher(`
rules:
  - id: mute-guests
    match: { kind: permission.required, scopeIn: [share] }
    route: { drop: true }
`);
    expect(m.firstDrop({ kind: 'permission.required' })).toBeNull();
  });

  it('a pure event-global rule is NOT applied per-subscription', () => {
    const m = matcher(`
rules:
  - id: global
    match: { kind: permission.required }
    route: { drop: true }
`);
    // It lives in the global pass only.
    expect(m.firstDrop({ kind: 'permission.required' })).toBe('global');
    expect(m.firstDropForSubscription?.(PERM, sub('g', ['share']))).toBeNull();
  });
});

describe('compileRouting / deferred operators (originatingClientScope, policy.*, subActor, suppressIfWorkingDevice)', () => {
  const matcher = (yaml: string) => compileRouting(loadRoutingConfig(yaml));

  it('originatingClientScope: drops when the originating scope matches', () => {
    const m = matcher(`
rules:
  - id: drop-share
    match: { originatingClientScope: share }
    route: { drop: true }
`);
    expect(
      m.firstDrop({
        kind: 'permission.required',
        originatingClientScope: 'share',
      }),
    ).toBe('drop-share');
    expect(
      m.firstDrop({
        kind: 'permission.required',
        originatingClientScope: 'owner',
      }),
    ).toBeNull();
    expect(m.firstDrop({ kind: 'permission.required' })).toBeNull();
  });

  it('originatingClientScope: list membership', () => {
    const m = matcher(`
rules:
  - id: r
    match: { originatingClientScope: [share, approve] }
    route: { drop: true }
`);
    expect(m.firstDrop({ kind: 'x', originatingClientScope: 'approve' })).toBe(
      'r',
    );
    expect(
      m.firstDrop({ kind: 'x', originatingClientScope: 'write' }),
    ).toBeNull();
  });

  it('policy.decisionSource: drops when the policy source matches', () => {
    const m = matcher(`
rules:
  - id: r
    match: { policy.decisionSource: file }
    route: { drop: true }
`);
    expect(m.firstDrop({ kind: 'x', policyDecisionSource: 'file' })).toBe('r');
    expect(
      m.firstDrop({ kind: 'x', policyDecisionSource: 'default' }),
    ).toBeNull();
  });

  it('policy.action: drops when the policy action matches', () => {
    const m = matcher(`
rules:
  - id: r
    match: { policy.action: deny }
    route: { drop: true }
`);
    expect(m.firstDrop({ kind: 'x', policyAction: 'deny' })).toBe('r');
    expect(m.firstDrop({ kind: 'x', policyAction: 'allow' })).toBeNull();
  });

  it('subActor: drops when the sub-actor matches', () => {
    const m = matcher(`
rules:
  - id: r
    match: { subActor: telegram:42 }
    route: { drop: true }
`);
    expect(m.firstDrop({ kind: 'x', subActor: 'telegram:42' })).toBe('r');
    expect(m.firstDrop({ kind: 'x', subActor: 'telegram:99' })).toBeNull();
    expect(m.firstDrop({ kind: 'x' })).toBeNull();
  });

  it('suppressIfWorkingDevice: true → per-sub drop when isWorkingDevice=true', () => {
    const m = matcher(`
rules:
  - id: r
    match: { kind: permission.required, suppressIfWorkingDevice: true }
    route: { drop: true }
`);
    const sub = { tokenId: 't1', scopes: ['approve'] as const };
    // working device → drop
    expect(
      m.firstDropForSubscription?.({ kind: 'permission.required' }, sub, true),
    ).toBe('r');
    // not working device → no drop
    expect(
      m.firstDropForSubscription?.({ kind: 'permission.required' }, sub, false),
    ).toBeNull();
    expect(
      m.firstDropForSubscription?.({ kind: 'permission.required' }, sub),
    ).toBeNull();
  });

  it('suppressIfWorkingDevice: false → matches only when isWorkingDevice=false', () => {
    const m = matcher(`
rules:
  - id: r
    match: { suppressIfWorkingDevice: false }
    route: { drop: true }
`);
    const sub = { tokenId: 't1', scopes: ['approve'] as const };
    expect(m.firstDropForSubscription?.({ kind: 'x' }, sub, false)).toBe('r');
    expect(m.firstDropForSubscription?.({ kind: 'x' }, sub, true)).toBeNull();
  });

  it('suppressIfWorkingDevice: true is NOT in the global (event-wide) drop (per-sub only)', () => {
    const m = matcher(`
rules:
  - id: r
    match: { kind: permission.required, suppressIfWorkingDevice: true }
    route: { drop: true }
`);
    // hasPerSubMatch → goes to perSubDropRules only; firstDrop should be null
    expect(m.firstDrop({ kind: 'permission.required' })).toBeNull();
  });

  it('AND across deferred fields + kind', () => {
    const m = matcher(`
rules:
  - id: r
    match: { kind: x, originatingClientScope: share, subActor: bot:1 }
    route: { drop: true }
`);
    expect(
      m.firstDrop({
        kind: 'x',
        originatingClientScope: 'share',
        subActor: 'bot:1',
      }),
    ).toBe('r');
    expect(
      m.firstDrop({ kind: 'x', originatingClientScope: 'share' }),
    ).toBeNull(); // subActor absent
    expect(m.firstDrop({ kind: 'x', subActor: 'bot:1' })).toBeNull(); // scope absent
  });

  it('deferred fields no longer trigger the "unhonored" console warning', async () => {
    vi.resetModules();
    const { loadRoutingConfig: fresh } = await import('./rules.js');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fresh(`
rules:
  - match:
      kind: permission.required
      originatingClientScope: share
      policy.decisionSource: file
      policy.action: deny
      subActor: bot:1
      suppressIfWorkingDevice: true
    route: { drop: true }
`);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('compileRouting / urgencyAtLeast (cycle 96)', () => {
  const matcher = (yaml: string) => compileRouting(loadRoutingConfig(yaml));

  it('drops only events whose kind-derived urgency ≥ the threshold', () => {
    const m = matcher(`
rules:
  - id: shed-high
    match: { urgencyAtLeast: high }
    route: { drop: true }
`);
    // permission.required is HIGH → dropped; task.completed is LOW → kept.
    expect(m.firstDrop({ kind: 'permission.required' })).toBe('shed-high');
    expect(m.firstDrop({ kind: 'task.completed' })).toBeNull();
  });

  it('urgencyAtLeast: low matches every kind (floor)', () => {
    const m = matcher(`
rules:
  - id: shed-all
    match: { urgencyAtLeast: low }
    route: { drop: true }
`);
    expect(m.firstDrop({ kind: 'permission.required' })).toBe('shed-all');
    expect(m.firstDrop({ kind: 'task.completed' })).toBe('shed-all');
  });

  it('ANDs urgency with kind/sessionTag', () => {
    const m = matcher(`
rules:
  - id: combo
    match: { kind: permission.required, urgencyAtLeast: high }
    route: { drop: true }
`);
    expect(m.firstDrop({ kind: 'permission.required' })).toBe('combo');
    // kind mismatch → no drop even though it'd satisfy urgency on its own.
    expect(m.firstDrop({ kind: 'task.completed' })).toBeNull();
  });

  it('rejects an invalid urgency level', () => {
    expect(() =>
      loadRoutingConfig(`
rules:
  - match: { urgencyAtLeast: critical }
    route: { drop: true }
`),
    ).toThrow(RoutingError);
  });
});
