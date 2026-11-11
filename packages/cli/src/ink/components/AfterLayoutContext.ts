/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { createContext } from 'react';
import type { AfterLayoutRegistry } from '../layout-effects.js';

/**
 * The owning Ink root's after-layout registry. Null outside an Ink tree, in
 * which case `useAfterLayout` degrades to a plain per-commit layout effect.
 */
const AfterLayoutContext = createContext<AfterLayoutRegistry | null>(null);
AfterLayoutContext.displayName = 'InternalAfterLayoutContext';

export default AfterLayoutContext;
