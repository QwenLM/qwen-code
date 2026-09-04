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
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(import.meta.dirname, 'AppContainer.tsx'),
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
});
