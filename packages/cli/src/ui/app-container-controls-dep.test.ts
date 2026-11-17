/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Source-level regression guard for the one-line fix in #5798/#5799 that the
 * behavioural tests cannot reach.
 *
 * The fix is: `liveAgentPanelLayoutKey` is listed in the dependency array of
 * the `useLayoutEffect` that measures `controlsHeight` from `mainControlsRef`.
 * Removing it silently re-introduces the non-VP overflow flicker (the footer
 * stops being re-measured when the LiveAgentPanel grows).
 *
 * Why this is a source assertion rather than a render test: the behaviour only
 * manifests on an in-place UPDATE of AppContainer, and ink-testing-library's
 * `rerender` remounts AppContainer (re-running every mount effect regardless of
 * its deps), while an external `setState` does not flush ink's reconciler. So a
 * real AppContainer always re-measures on (re)mount in tests and the missing
 * dependency is invisible to a render-based assertion — exactly why dropping it
 * leaves the mechanism tests (which use a stand-in component) green. This guard
 * pins the dependency directly, so a deps-array cleanup or an `exhaustive-deps`
 * autofix cannot quietly delete the fix.
 *
 * The same reasoning extends to the #9507 provider link: the composer layout
 * key must survive in the dependency arrays of the AgentViewContext state and
 * actions memos, or setAgentComposerLayoutKey updates never reach the
 * AppContainer measure effect guarded above. useMemo deps are invisible to
 * TypeScript, so they are pinned here at the source level as well.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(import.meta.dirname, 'AppContainer.tsx'),
  'utf8',
);

const composerSource = readFileSync(
  join(import.meta.dirname, 'components', 'agent-view', 'AgentComposer.tsx'),
  'utf8',
);

const agentViewContextSource = readFileSync(
  join(import.meta.dirname, 'contexts', 'AgentViewContext.tsx'),
  'utf8',
);

/** Extract the dependency array of the controls-height measurement effect. */
function controlsHeightEffectDeps(): string {
  const measureAt = source.indexOf('measureElement(mainControlsRef.current)');
  expect(measureAt).toBeGreaterThan(-1);
  const depsOpen = source.indexOf('}, [', measureAt);
  expect(depsOpen).toBeGreaterThan(-1);
  const depsClose = source.indexOf(']);', depsOpen);
  expect(depsClose).toBeGreaterThan(depsOpen);
  return source.slice(depsOpen, depsClose);
}

/**
 * Extract the dependency array of a useMemo in AgentViewContext.tsx. The
 * slice runs from the deps-array opening bracket to its closing bracket, so
 * it covers only the deps list, not the memoized object literal above it.
 * That is deliberate: the guarded mutation keeps the value in the literal
 * while dropping it from the deps, which must fail the assertion below even
 * though the literal still mentions the identifier.
 */
function agentViewMemoDeps(memoAnchor: string): string {
  const memoAt = agentViewContextSource.indexOf(memoAnchor);
  expect(memoAt).toBeGreaterThan(-1);
  const depsOpen = agentViewContextSource.indexOf('\n    [', memoAt);
  expect(depsOpen).toBeGreaterThan(-1);
  const depsClose = agentViewContextSource.indexOf('\n    ],', depsOpen);
  expect(depsClose).toBeGreaterThan(depsOpen);
  return agentViewContextSource.slice(depsOpen, depsClose);
}

describe('AppContainer controls-height measurement wiring', () => {
  it('measures controls height from mainControlsRef', () => {
    // Sanity: the effect we are guarding still exists and is shaped as expected.
    expect(source).toContain('measureElement(mainControlsRef.current)');
    expect(source).toContain('setControlsHeight(');
  });

  it('lists liveAgentPanelLayoutKey in the measurement effect dependencies', () => {
    const deps = controlsHeightEffectDeps();
    // Confirm we located the right deps array before the key assertion.
    expect(deps).toContain('terminalHeight');
    expect(deps).toContain('stickyTodosLayoutKey');
    // The fix: dropping this entry re-introduces the non-VP overflow flicker.
    expect(deps).toContain('liveAgentPanelLayoutKey');
  });

  it('computes liveAgentPanelLayoutKey from the live agent roster', () => {
    // The key must be derived from the roster + focus, not a constant. Match
    // whitespace-tolerantly so prettier reformatting can't break the guard.
    expect(source).toMatch(
      /liveAgentPanelLayoutKey\s*=\s*getLiveAgentPanelLayoutKey\(\s*bgTaskEntries\s*,\s*bgLivePanelFocused\s*,?\s*\)/,
    );
  });

  it('lists the agent composer layout key in the measurement effect deps', () => {
    const deps = controlsHeightEffectDeps();
    // The #9507 fix: the agent tab footer grows with its own status row /
    // queued messages / input text, none of which the other deps track;
    // dropping this entry leaves controlsHeight stale-high on the agent tab
    // and the viewport pushes the composer and tab bar off the terminal.
    expect(deps).toContain('agentViewState.agentComposerLayoutKey');
  });

  it('derives the composer layout key from the footer height-shifting state', () => {
    // The key must cover every row-count factor the agent footer renders:
    // loading row (streamingState), terminal status row, queued messages and
    // input text. Whitespace-tolerant so prettier can't break the guard.
    expect(composerSource).toMatch(
      /getAgentComposerLayoutKey\(\{\s*streamingState\s*,\s*statusLabel:\s*statusLabel\?\.text\s*\?\?\s*''\s*,\s*queuedMessageCount:\s*messageQueue\.length\s*,\s*inputText:\s*buffer\.text\s*,?\s*\}\)/,
    );
  });

  it('syncs the composer layout key to context for the measure effect', () => {
    expect(composerSource).toMatch(
      /useEffect\(\(\)\s*=>\s*\{\s*setAgentComposerLayoutKey\(composerLayoutKey\);\s*\},\s*\[composerLayoutKey,\s*setAgentComposerLayoutKey\]\)/,
    );
  });
});

describe('AgentViewContext propagation of the composer layout key (#9507)', () => {
  it('lists agentComposerLayoutKey in the state memo dependencies', () => {
    const deps = agentViewMemoDeps('const state: AgentViewState = useMemo(');
    // Sanity: this is the state memo's deps array (the literal above it
    // mirrors the same identifiers, so anchor on entries plus position).
    expect(deps).toContain('activeView');
    expect(deps).toContain('agentMessageQueues');
    // The #9507 provider link: the object literal still lists the key when
    // this dep is dropped, so nothing looks wrong — but the memoized context
    // value goes stale, setAgentComposerLayoutKey updates stop reaching the
    // AppContainer controls-height measure effect, and the composer/tab bar
    // overflow fixed in round 2 returns. TypeScript cannot see memo deps, so
    // this source guard is the only protection.
    expect(deps).toContain('agentComposerLayoutKey');
  });

  it('lists setAgentComposerLayoutKey in the actions memo dependencies', () => {
    const deps = agentViewMemoDeps(
      'const actions: AgentViewActions = useMemo(',
    );
    expect(deps).toContain('setAgentShellFocused');
    // Dropping this entry hands consumers a stale actions object whose
    // setAgentComposerLayoutKey identity predates the provider re-render.
    expect(deps).toContain('setAgentComposerLayoutKey');
  });
});
