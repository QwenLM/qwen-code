/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { compileRouting, type RoutingConfig } from './rules.js';
import {
  parseRoutingTest,
  evaluateRoutingTest,
  formatRoutingTest,
} from './test.js';

describe('parseRoutingTest', () => {
  it('reads the event from a positional JSON arg', () => {
    const r = parseRoutingTest(
      ['{"kind":"permission.required","sessionName":"api"}'],
      null,
    );
    expect(r).toEqual({
      ok: true,
      request: {
        event: { kind: 'permission.required', sessionName: 'api' },
        subs: [],
        resolved: false,
      },
    });
  });

  it('reads the event from stdin when no positional is given', () => {
    const r = parseRoutingTest([], '{"kind":"session.idle"}');
    expect(r.ok && r.request.event).toEqual({ kind: 'session.idle' });
  });

  it('prefers a positional over stdin', () => {
    const r = parseRoutingTest(['{"kind":"a"}'], '{"kind":"b"}');
    expect(r.ok && r.request.event.kind).toBe('a');
  });

  it('parses --sub specs (scopes, @tokenId, multiple) and --resolved', () => {
    const r = parseRoutingTest(
      [
        '{"kind":"x"}',
        '--sub=session:read,approve@tok1',
        '--sub=session:read',
        '--resolved',
      ],
      null,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.resolved).toBe(true);
    expect(r.request.subs).toEqual([
      {
        label: 'session:read,approve@tok1',
        scopes: ['session:read', 'approve'],
        tokenId: 'tok1',
      },
      { label: 'session:read', scopes: ['session:read'] },
    ]);
  });

  it('ignores unknown flags (lenient)', () => {
    const r = parseRoutingTest(['{"kind":"x"}', '--bogus=1'], null);
    expect(r.ok).toBe(true);
  });

  it('errors (exit 2) when no event is supplied', () => {
    const r = parseRoutingTest([], null);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('no event JSON');
  });

  it('errors on unparseable JSON', () => {
    const r = parseRoutingTest(['not json'], null);
    expect(!r.ok && r.error).toContain('not valid JSON');
  });

  it('errors on a non-object event (array)', () => {
    const r = parseRoutingTest(['[1,2]'], null);
    expect(!r.ok && r.error).toContain('must be an object');
  });

  it('errors when kind is missing or empty', () => {
    expect(parseRoutingTest(['{"sessionName":"x"}'], null).ok).toBe(false);
    expect(parseRoutingTest(['{"kind":""}'], null).ok).toBe(false);
  });
});

// An event-global drop (kind only) and a per-subscription drop (kind + scopeIn).
const CONFIG: RoutingConfig = {
  rules: [
    {
      id: 'mute-perms',
      match: { kind: 'permission.required' },
      route: { drop: true },
    },
    {
      id: 'mute-readers-idle',
      match: { kind: 'session.idle', scopeIn: ['session:read'] },
      route: { drop: true },
    },
  ],
};

describe('evaluateRoutingTest', () => {
  const matcher = compileRouting(CONFIG);

  it('event-global drop suppresses ALL subscriptions', () => {
    const r = evaluateRoutingTest(
      matcher,
      {
        event: { kind: 'permission.required' },
        subs: [
          { label: 'phone', scopes: ['session:read'] },
          { label: 'laptop', scopes: ['session:read', 'approve'] },
        ],
        resolved: false,
      },
      2,
    );
    expect(r.perSubEvaluated).toBe(true);
    expect(r.decisions.every((d) => d.decision === 'suppress')).toBe(true);
    expect(r.decisions[0]).toMatchObject({
      ruleId: 'mute-perms',
      scope: 'event_global',
    });
  });

  it('per-subscription drop suppresses only the matching sub', () => {
    const r = evaluateRoutingTest(
      matcher,
      {
        event: { kind: 'session.idle' },
        subs: [
          { label: 'reader', scopes: ['session:read'] },
          { label: 'approver', scopes: ['approve'] },
        ],
        resolved: false,
      },
      2,
    );
    expect(r.decisions[0]).toMatchObject({
      label: 'reader',
      decision: 'suppress',
      ruleId: 'mute-readers-idle',
      scope: 'per_subscription',
    });
    expect(r.decisions[1]).toMatchObject({
      label: 'approver',
      decision: 'send',
    });
  });

  it('no --sub: a single event-global row, perSubEvaluated false', () => {
    const send = evaluateRoutingTest(
      matcher,
      { event: { kind: 'session.idle' }, subs: [], resolved: false },
      2,
    );
    expect(send.perSubEvaluated).toBe(false);
    expect(send.decisions).toEqual([
      { label: '(all subscriptions)', decision: 'send' },
    ]);

    const suppress = evaluateRoutingTest(
      matcher,
      { event: { kind: 'permission.required' }, subs: [], resolved: false },
      2,
    );
    expect(suppress.decisions[0]).toMatchObject({
      decision: 'suppress',
      scope: 'event_global',
    });
  });

  it('an undefined matcher (no routing file) sends everything', () => {
    const r = evaluateRoutingTest(
      undefined,
      {
        event: { kind: 'permission.required' },
        subs: [{ label: 'phone', scopes: ['session:read'] }],
        resolved: false,
      },
      0,
    );
    expect(r.rulesLoaded).toBe(false);
    expect(r.decisions[0].decision).toBe('send');
  });
});

describe('formatRoutingTest', () => {
  const matcher = compileRouting(CONFIG);

  it('renders routing-layer-prefixed rows + the scope NOTE', () => {
    const out = formatRoutingTest(
      evaluateRoutingTest(
        matcher,
        {
          event: { kind: 'permission.required', sessionName: 'api' },
          subs: [{ label: 'phone', scopes: ['session:read'] }],
          resolved: false,
        },
        2,
      ),
    );
    expect(out).toContain('kind=permission.required session=api rules=2');
    expect(out).toContain('routing-layer: would_suppress');
    expect(out).toContain('rule=mute-perms (event_global)');
    // The honesty footer must be present and name the downstream gates.
    expect(out).toContain('ONLY routing.yaml drop rules');
    expect(out).toContain('rate limiter');
  });

  it('shows the no-rules-loaded note for an undefined matcher', () => {
    const out = formatRoutingTest(
      evaluateRoutingTest(
        undefined,
        { event: { kind: 'x' }, subs: [], resolved: false },
        0,
      ),
    );
    expect(out).toContain('no routing rules loaded');
    expect(out).toContain('routing-layer: would_send');
  });

  it('notes when per-subscription rules were not evaluated', () => {
    const out = formatRoutingTest(
      evaluateRoutingTest(
        matcher,
        { event: { kind: 'session.idle' }, subs: [], resolved: false },
        2,
      ),
    );
    expect(out).toContain('per-subscription drop rules not evaluated');
  });
});
