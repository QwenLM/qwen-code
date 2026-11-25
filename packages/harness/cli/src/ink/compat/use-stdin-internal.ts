/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { useContext } from 'react';
import StdinContext from '../components/StdinContext.js';
import type { EventEmitter } from '../events/emitter.js';
import type { TerminalQuerier } from '../terminal-querier.js';

export type StdinInternalProps = {
  readonly stdin: NodeJS.ReadStream;
  readonly setRawMode: (value: boolean) => void;
  readonly isRawModeSupported: boolean;
  readonly internal_eventEmitter: EventEmitter;
  readonly internal_querier: TerminalQuerier | null;
};

/**
 * Internal hook that exposes the full StdinContext including `internal_eventEmitter`.
 *
 * This exists because `useStdin()` (the public compat shim) intentionally strips
 * internal fields. KeypressContext needs `internal_eventEmitter` to subscribe
 * to parsed key events from the engine's App component.
 *
 * IMPORTANT: This MUST be imported from `'ink'` (the barrel), never via a direct
 * relative path to ink internals. In test environments, vitest's module aliasing
 * can cause direct relative imports to resolve to a different module instance
 * than the one used by App's StdinContext.Provider, breaking context propagation.
 */
const useStdinInternal = (): StdinInternalProps => {
  const {
    stdin,
    setRawMode,
    isRawModeSupported,
    internal_eventEmitter,
    internal_querier,
  } = useContext(StdinContext);
  return {
    stdin,
    setRawMode,
    isRawModeSupported,
    internal_eventEmitter,
    internal_querier,
  };
};

export { useStdinInternal };
