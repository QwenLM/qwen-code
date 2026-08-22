/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  applySkillAllowedTools,
  collectAvailableSkillEntries,
  clearCollectedSkillEntriesCache,
  reconcileLoadedSkillTracking,
  unloadSkillsFromEntries,
  buildSkillLlmContent,
} from './skill-utils.js';
import type { PermissionManager } from '../permissions/permission-manager.js';
import type { SkillManager } from '../skills/skill-manager.js';
import type { Config } from '../config/config.js';
import type { ToolRegistry } from './tool-registry.js';
import type { Content } from '@google/genai';

function mockPermissionManager(): {
  pm: PermissionManager;
  addSessionAllowRule: ReturnType<typeof vi.fn>;
} {
  const addSessionAllowRule = vi.fn();
  return {
    pm: { addSessionAllowRule } as unknown as PermissionManager,
    addSessionAllowRule,
  };
}

describe('applySkillAllowedTools', () => {
  it('adds one session allow rule per entry, verbatim and in order', () => {
    const { pm, addSessionAllowRule } = mockPermissionManager();

    applySkillAllowedTools(pm, ['Bash(git *)', 'Edit', 'mcp__server__tool']);

    expect(addSessionAllowRule).toHaveBeenCalledTimes(3);
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(1, 'Bash(git *)');
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(2, 'Edit');
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(3, 'mcp__server__tool');
  });

  it('no-ops when allowedTools is undefined', () => {
    const { pm, addSessionAllowRule } = mockPermissionManager();
    applySkillAllowedTools(pm, undefined);
    expect(addSessionAllowRule).not.toHaveBeenCalled();
  });

  it('no-ops when allowedTools is empty', () => {
    const { pm, addSessionAllowRule } = mockPermissionManager();
    applySkillAllowedTools(pm, []);
    expect(addSessionAllowRule).not.toHaveBeenCalled();
  });

  it('no-ops without throwing when there is no permission manager', () => {
    expect(() => applySkillAllowedTools(null, ['Bash(git *)'])).not.toThrow();
    expect(() =>
      applySkillAllowedTools(undefined, ['Bash(git *)']),
    ).not.toThrow();
  });

  it('delegates malformed-entry handling to the permission manager (does not pre-filter)', () => {
    // The permission manager is the single authority on rule validity; the
    // helper forwards every entry and lets addSessionAllowRule log/skip bad
    // ones. This keeps validation in one place.
    const { pm, addSessionAllowRule } = mockPermissionManager();
    applySkillAllowedTools(pm, ['Bash(unbalanced', 'Read']);
    expect(addSessionAllowRule).toHaveBeenCalledTimes(2);
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(1, 'Bash(unbalanced');
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(2, 'Read');
  });
});

describe('collectAvailableSkillEntries memoize cache', () => {
  function mockSkillManager(): SkillManager {
    return {
      listSkills: vi.fn().mockResolvedValue([]),
      isSkillActive: vi.fn().mockReturnValue(false),
    } as unknown as SkillManager;
  }

  function mockConfig(): Config {
    return {
      getDisabledSkillNames: vi.fn().mockReturnValue(new Set<string>()),
      getModelInvocableCommandsProvider: vi.fn().mockReturnValue(null),
    } as unknown as Config;
  }

  afterEach(() => {
    clearCollectedSkillEntriesCache();
    vi.useRealTimers();
  });

  it('returns the same promise on cache hit within TTL', async () => {
    vi.useFakeTimers();
    const sm = mockSkillManager();
    const cfg = mockConfig();

    const r1 = collectAvailableSkillEntries(sm, cfg);
    const r2 = collectAvailableSkillEntries(sm, cfg);

    // The underlying scan should run only once.
    expect(sm.listSkills).toHaveBeenCalledTimes(1);
    // Both calls resolve to the exact same result object.
    const [v1, v2] = await Promise.all([r1, r2]);
    expect(v1).toBe(v2);
  });

  it('rescans after TTL expires', async () => {
    vi.useFakeTimers();
    const sm = mockSkillManager();
    const cfg = mockConfig();

    await collectAvailableSkillEntries(sm, cfg);
    vi.advanceTimersByTime(2001);
    await collectAvailableSkillEntries(sm, cfg);

    expect(sm.listSkills).toHaveBeenCalledTimes(2);
  });

  it('evicts cache entry on rejection so next caller retries', async () => {
    vi.useFakeTimers();
    const sm = mockSkillManager();
    const cfg = mockConfig();

    (sm.listSkills as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([]);

    const p1 = collectAvailableSkillEntries(sm, cfg);
    await expect(p1).rejects.toThrow('boom');

    // Flush microtask queue so the .catch() eviction handler runs.
    await vi.runAllTimersAsync();

    const p2 = collectAvailableSkillEntries(sm, cfg);
    await expect(p2).resolves.toBeDefined();
    expect(sm.listSkills).toHaveBeenCalledTimes(2);
  });

  it('clearCollectedSkillEntriesCache evicts the entry', async () => {
    vi.useFakeTimers();
    const sm = mockSkillManager();
    const cfg = mockConfig();

    await collectAvailableSkillEntries(sm, cfg);
    clearCollectedSkillEntriesCache(sm);
    await collectAvailableSkillEntries(sm, cfg);

    expect(sm.listSkills).toHaveBeenCalledTimes(2);
  });
});

describe('residency provenance gating (R3-1)', () => {
  // Both text markers are public constants and every command-delegation
  // output flows through the same functionResponse{name:'skill'} shape,
  // so marker text alone cannot prove a body — only membership in
  // SkillTool's recorded outputs can. When provenance is available the
  // marker check must fail CLOSED: a fresh process (empty set) trusts no
  // marker, which is safe because its tracker starts empty too.
  function registryFor(tool: unknown): ToolRegistry {
    const getTool = vi.fn().mockReturnValue(tool);
    return { getTool } as unknown as ToolRegistry;
  }

  function provenanceTracker(genuine: Set<string>) {
    const unloadSkills = vi.fn();
    const clearLoadedSkills = vi.fn();
    const trackSkills = vi.fn();
    return {
      registry: registryFor({
        unloadSkills,
        clearLoadedSkills,
        trackSkills,
        getGenuineSkillBodyOutputs: () => genuine,
      }),
      unloadSkills,
      clearLoadedSkills,
      trackSkills,
    };
  }

  const skillCall = (id: string, name: string): Content => ({
    role: 'model',
    parts: [{ functionCall: { id, name: 'skill', args: { skill: name } } }],
  });

  const skillBody = (id: string, output: string): Content => ({
    role: 'user',
    parts: [{ functionResponse: { id, name: 'skill', response: { output } } }],
  });

  it('reconcile does NOT re-admit a marker-spoofed body (injection)', () => {
    // A same-named command result copying the two markers must not be
    // tracked by any reconcile door — tracking it with no real body is
    // the dedup-guard deadlock this PR exists to eliminate.
    const spoof = buildSkillLlmContent('/demo', 'rogue command output');
    const { registry, clearLoadedSkills, trackSkills } = provenanceTracker(
      new Set(),
    );
    const history: Content[] = [
      skillCall('s0', 'demo'),
      skillBody('s0', spoof),
    ];

    reconcileLoadedSkillTracking(history, registry, 'test');

    expect(clearLoadedSkills).toHaveBeenCalledOnce();
    expect(trackSkills).not.toHaveBeenCalled();
  });

  it('reconcile tracks a body SkillTool actually produced', () => {
    const body = buildSkillLlmContent('/demo', 'real body');
    const { registry, trackSkills } = provenanceTracker(new Set([body]));
    const history: Content[] = [skillCall('s0', 'demo'), skillBody('s0', body)];

    reconcileLoadedSkillTracking(history, registry, 'test');

    expect(trackSkills).toHaveBeenCalledWith(['demo']);
  });

  it('a spoofed stripped response cannot un-track a skill with a resident body (R4-1)', () => {
    // Strip classification is by call id, not output shape (a stubbed
    // body must still count as dropped). The resident-sibling filter is
    // what keeps that fail-open rule precise: with a REAL proven body
    // still in history, a popped marker-copying response under the same
    // call id must un-track nothing.
    const body = buildSkillLlmContent('/demo', 'real body');
    const spoof = buildSkillLlmContent('/demo', 'rogue command output');
    const { registry, unloadSkills, clearLoadedSkills } = provenanceTracker(
      new Set([body]),
    );
    const history: Content[] = [
      skillCall('s0', 'demo'),
      skillBody('s0', body),
      skillCall('s1', 'demo'),
    ];

    unloadSkillsFromEntries(
      [skillBody('s1', spoof)],
      history,
      registry,
      'test',
    );

    expect(clearLoadedSkills).not.toHaveBeenCalled();
    expect(unloadSkills).not.toHaveBeenCalled();
  });

  it('un-tracks a skill whose stripped body was persistence-stubbed (R4-1)', () => {
    // The scheduler's persistence gate rewrites large genuine bodies
    // into `<persisted-output>` stubs before they enter history. The
    // stub matches no marker and no recorded provenance string, yet its
    // skill WAS tracked at return time — the strip must classify by
    // call id or the skill stays tracked with no resident body (the
    // #6762 deadlock).
    const genuine = buildSkillLlmContent('/demo', 'big body'.repeat(100));
    const stub =
      '<persisted-output path="/tmp/x.txt">truncated</persisted-output>';
    const { registry, unloadSkills, clearLoadedSkills } = provenanceTracker(
      new Set([genuine]),
    );
    const history: Content[] = [skillCall('s0', 'demo')];

    unloadSkillsFromEntries([skillBody('s0', stub)], history, registry, 'test');

    expect(clearLoadedSkills).not.toHaveBeenCalled();
    expect(unloadSkills).toHaveBeenCalledWith(['demo']);
  });

  it('targeted unload and blanket clear still hold in provenance mode with a non-empty set (R4-8)', () => {
    // Production runs exclusively in provenance mode — pin the strip's
    // targeted arm there, not only in marker-only mode.
    const body = buildSkillLlmContent('/demo', 'resident-less body');
    const tracker = provenanceTracker(new Set([body]));
    const history: Content[] = [skillCall('s0', 'demo')];

    unloadSkillsFromEntries(
      [skillBody('s0', body)],
      history,
      tracker.registry,
      'test',
    );
    expect(tracker.unloadSkills).toHaveBeenCalledWith(['demo']);
    expect(tracker.clearLoadedSkills).not.toHaveBeenCalled();

    const tracker2 = provenanceTracker(new Set([body]));
    unloadSkillsFromEntries(
      [skillBody('missing', body)],
      [{ role: 'user', parts: [{ text: 'hi' }] }],
      tracker2.registry,
      'test',
    );
    expect(tracker2.clearLoadedSkills).toHaveBeenCalledOnce();
    expect(tracker2.unloadSkills).not.toHaveBeenCalled();
  });

  it('reconcile tracks neither name for an ambiguous resident body (R4-6)', () => {
    // One call id reused for two distinct skill names is unresolvable:
    // tracking either name could pin a body to the wrong skill.
    const body = buildSkillLlmContent('/demo', 'ambiguous body');
    const { registry, clearLoadedSkills, trackSkills } = provenanceTracker(
      new Set([body]),
    );
    const history: Content[] = [
      skillCall('amb', 'alpha'),
      skillCall('amb', 'beta'),
      skillBody('amb', body),
    ];

    reconcileLoadedSkillTracking(history, registry, 'test');

    expect(clearLoadedSkills).toHaveBeenCalledOnce();
    expect(trackSkills).not.toHaveBeenCalled();
  });
});

describe('reconcileLoadedSkillTracking', () => {
  it('ends with exactly the resident names — clear-before-track order (R3-11)', () => {
    // State-based oracle backed by a REAL Set: swapping clear/track order
    // inside reconcile would end with an EMPTY tracker while bodies stay
    // resident, and every order-blind mock assertion would stay green.
    const loaded = new Set<string>(['stale']);
    const tool = {
      unloadSkills: (names: Iterable<string>) => {
        for (const n of names) loaded.delete(n);
      },
      clearLoadedSkills: () => loaded.clear(),
      trackSkills: (names: Iterable<string>) => {
        for (const n of names) loaded.add(n);
      },
    };
    const registry = {
      getTool: vi.fn().mockReturnValue(tool),
    } as unknown as ToolRegistry;
    const body = buildSkillLlmContent('/demo', 'resident body');
    const history: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: { id: 's0', name: 'skill', args: { skill: 'demo' } },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 's0',
              name: 'skill',
              response: { output: body },
            },
          },
        ],
      },
    ];

    reconcileLoadedSkillTracking(history, registry, 'test');

    expect([...loaded]).toEqual(['demo']);
  });
});

describe('unloadSkillsFromEntries', () => {
  function registryFor(tool: unknown): ToolRegistry {
    const getTool = vi.fn().mockReturnValue(tool);
    return { getTool } as unknown as ToolRegistry;
  }

  function trackerMocks() {
    const unloadSkills = vi.fn();
    const clearLoadedSkills = vi.fn();
    const trackSkills = vi.fn();
    return {
      registry: registryFor({ unloadSkills, clearLoadedSkills, trackSkills }),
      unloadSkills,
      clearLoadedSkills,
    };
  }

  const skillCall = (id: string, name: string): Content => ({
    role: 'model',
    parts: [{ functionCall: { id, name: 'skill', args: { skill: name } } }],
  });

  const skillBody = (id: string | undefined, body: string): Content => ({
    role: 'user',
    parts: [
      {
        functionResponse: {
          id,
          name: 'skill',
          response: { output: buildSkillLlmContent('/demo', body) },
        },
      },
    ],
  });

  it('blanket-clears when a stripped body has an unresolvable call id (R1-6)', () => {
    // The branch the strip invariant leans on most: an unresolvable
    // stripped body must never leave its skill tracked — tracked with
    // no resident body is the dedup-guard deadlock this PR exists to
    // prevent, and dropping this arm leaves the suite green.
    const { registry, unloadSkills, clearLoadedSkills } = trackerMocks();
    const stripped = [skillBody('missing', 'gone body')];
    // History holds no functionCall with id 'missing'.
    const history: Content[] = [{ role: 'user', parts: [{ text: 'hi' }] }];

    unloadSkillsFromEntries(stripped, history, registry, 'test');

    expect(clearLoadedSkills).toHaveBeenCalledOnce();
    expect(unloadSkills).not.toHaveBeenCalled();
  });

  it('keeps tracking when the stripped body has a resident sibling (R1-11)', () => {
    // Resident shield: the skill still has ANOTHER body in history. The
    // targeted un-track must exclude it — un-tracking would disarm the
    // dedup guard with a body in context and the next invoke would
    // inject a full duplicate.
    const { registry, unloadSkills, clearLoadedSkills } = trackerMocks();
    const history: Content[] = [
      skillCall('s0', 'demo'),
      skillBody('s0', 'resident body'),
      skillCall('s1', 'demo'),
    ];
    // The trailing body was stripped; its call id still pairs in history.
    const stripped = [skillBody('s1', 'stripped body')];

    unloadSkillsFromEntries(stripped, history, registry, 'test');

    expect(clearLoadedSkills).not.toHaveBeenCalled();
    expect(unloadSkills).not.toHaveBeenCalled();
  });

  it('blanket-clears on a mixed batch when ANY stripped body is unresolvable (R3-8)', () => {
    // Documented mixed-batch policy: even though 'ok' resolves, the
    // unresolvable sibling forces the wholesale clear — targeted unload
    // here would leave the unresolvable body's skill tracked with no
    // resident body (the deadlock direction).
    const { registry, unloadSkills, clearLoadedSkills } = trackerMocks();
    const history: Content[] = [
      skillCall('ok', 'demo'),
      { role: 'user', parts: [{ text: 'hi' }] },
    ];
    const stripped = [
      skillBody('ok', 'resolvable body'),
      skillBody('missing', 'unresolvable body'),
    ];

    unloadSkillsFromEntries(stripped, history, registry, 'test');

    expect(clearLoadedSkills).toHaveBeenCalledOnce();
    expect(unloadSkills).not.toHaveBeenCalled();
  });

  it('blanket-clears when one call id resolves to two distinct skill names (R4-5)', () => {
    // Ambiguous ids are unresolvable by policy (`resolved?.length === 1`):
    // a provider reusing one call id across two skill calls must fall
    // back to the wholesale clear, never a targeted unload of just the
    // first name (which would leave the second tracked with no body —
    // the deadlock this PR exists to eliminate).
    const { registry, unloadSkills, clearLoadedSkills } = trackerMocks();
    const history: Content[] = [
      skillCall('amb', 'alpha'),
      skillCall('amb', 'beta'),
    ];
    const stripped = [skillBody('amb', 'ambiguous body')];

    unloadSkillsFromEntries(stripped, history, registry, 'test');

    expect(clearLoadedSkills).toHaveBeenCalledOnce();
    expect(unloadSkills).not.toHaveBeenCalled();
  });
});
