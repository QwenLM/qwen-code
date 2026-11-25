/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

/* eslint-disable custom-rules/no-top-level-side-effects */
import ws from 'ws';

const customGlobal = globalThis as Record<string, unknown>;

// These globals must exist before importing `react-devtools-core` because
// it references `window`, `self`, and `WebSocket` at module evaluation time.
customGlobal['WebSocket'] ||= ws;
customGlobal['window'] ||= globalThis;
customGlobal['self'] ||= globalThis;

// Filter out Ink's internal wrapper components from the DevTools tree
// so users only see their own components.
(globalThis as any).__REACT_DEVTOOLS_COMPONENT_FILTERS__ = [
  {
    // ComponentFilterElementType – hide host components
    type: 1,
    // ElementTypeHostComponent
    value: 7,
    isEnabled: true,
  },
  {
    // ComponentFilterDisplayName
    type: 2,
    value: 'InternalApp',
    isEnabled: true,
    isValid: true,
  },
  {
    // ComponentFilterDisplayName
    type: 2,
    value: 'InternalAppContext',
    isEnabled: true,
    isValid: true,
  },
  {
    // ComponentFilterDisplayName
    type: 2,
    value: 'InternalStdoutContext',
    isEnabled: true,
    isValid: true,
  },
  {
    // ComponentFilterDisplayName
    type: 2,
    value: 'InternalStdinContext',
    isEnabled: true,
    isValid: true,
  },
  {
    // ComponentFilterDisplayName
    type: 2,
    value: 'TerminalFocusContext',
    isEnabled: true,
    isValid: true,
  },
];
