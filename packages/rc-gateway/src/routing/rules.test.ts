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
    fresh('rules:\n  - match: { scopeIn: [owner] }\n    route: { drop: true }');
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
