import { describe, expect, it } from 'vitest';
import type {
  DaemonGitRemoteInfo,
  DaemonSessionSummary,
  DaemonStandaloneSessionSummary,
} from '@qwen-code/sdk/daemon';
import { createWebShellDaemonScenario } from './e2e/utils/mockDaemon';
import { makeSidebarSession } from './test/sidebarHarness';

// The e2e notification-path cases mutate scenario.sessions in place after
// install, and installMockDaemon keeps the scenario by reference so routes
// see those mutations. That is only safe if the factory does not alias the
// caller's fixture array — otherwise one case's mutation leaks into every
// later case sharing the fixture, in the same worker and across retries.
// e2e/** is excluded from vitest, so this contract is pinned here.
const goalSession = (): DaemonSessionSummary =>
  makeSidebarSession('fixture-session', {
    displayName: 'Fixture Session',
    goal: {
      status: 'active',
      objective: 'keep the loop running',
      updatedAt: '2026-11-17T00:00:00.000Z',
    },
  });

describe('createWebShellDaemonScenario fixture ownership', () => {
  it('does not hand back the caller array', () => {
    const fixture = [goalSession()];
    const scenario = createWebShellDaemonScenario({ sessions: fixture });
    expect(scenario.sessions).not.toBe(fixture);
    expect(scenario.sessions[0]).not.toBe(fixture[0]);
  });

  it('keeps an in-place mutation out of the caller fixture', () => {
    const fixture = [goalSession()];
    const scenario = createWebShellDaemonScenario({ sessions: fixture });

    scenario.sessions[0]!.goal = undefined;

    expect(scenario.sessions[0]!.goal).toBeUndefined();
    expect(fixture[0]!.goal).toMatchObject({ status: 'active' });
  });

  it('keeps one scenario mutation out of a later scenario over the same fixture', () => {
    const fixture = [goalSession()];
    const first = createWebShellDaemonScenario({ sessions: fixture });
    const later = createWebShellDaemonScenario({ sessions: fixture });

    first.sessions[0]!.goal = undefined;

    expect(later.sessions[0]!.goal).toMatchObject({
      status: 'active',
      objective: 'keep the loop running',
    });
  });

  it('still exposes the scenario array by reference for post-install mutation', () => {
    const scenario = createWebShellDaemonScenario({
      sessions: [goalSession()],
    });
    const held = scenario.sessions;

    held[0]!.goal = { ...held[0]!.goal!, status: 'paused' };

    // Routes re-read scenario.sessions per request; the factory must not
    // snapshot or re-copy it on access, or the notification path breaks.
    expect(scenario.sessions).toBe(held);
    expect(scenario.sessions[0]!.goal).toMatchObject({ status: 'paused' });
  });

  it('does not hand back the caller standaloneSessions array', () => {
    // The standalone create and patch routes unshift and replace whole
    // elements, so array identity is the property that decides whether a
    // case's writes reach the caller's fixture. A populated fixture is what
    // lets the value assertion also pin that the caller's rows survive the
    // clone — an empty one would pass for any fresh empty array.
    const fixture: DaemonStandaloneSessionSummary[] = [
      {
        ...makeSidebarSession('standalone-fixture'),
        sourceType: 'standalone',
        context: { kind: 'standalone' },
      },
    ];
    const scenario = createWebShellDaemonScenario({
      standaloneSessions: fixture,
    });

    expect(scenario.standaloneSessions).not.toBe(fixture);
    expect(scenario.standaloneSessions[0]).not.toBe(fixture[0]);
    expect(scenario.standaloneSessions).toEqual(fixture);
  });

  it('does not hand back the caller gitRemotes array', () => {
    // materializeRemotes returns the array itself, and the add/remove routes
    // splice and push it, so identity decides whether those writes reach the
    // caller. The value assertion is what keeps an empty fixture meaning "no
    // remotes": identity alone is also satisfied by undefined, which would let
    // ??= seed the default origin row for a caller that asked for none.
    const fixture: DaemonGitRemoteInfo[] = [];
    const scenario = createWebShellDaemonScenario({ gitRemotes: fixture });

    expect(scenario.gitRemotes).not.toBe(fixture);
    expect(scenario.gitRemotes).toEqual([]);
  });

  it('keeps a mid-turn message push out of the caller fixture', () => {
    const fixture = [{ messageId: 'seed', text: 'seed text' }];
    const scenario = createWebShellDaemonScenario({
      midTurnMessages: fixture,
    });

    scenario.midTurnMessages.push({ messageId: 'sent', text: 'sent text' });

    expect(scenario.midTurnMessages).toHaveLength(2);
    expect(fixture).toEqual([{ messageId: 'seed', text: 'seed text' }]);
  });
});
