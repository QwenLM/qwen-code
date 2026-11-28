/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { type ReactNode } from 'react';
import { type Styles } from '../styles.js';

export type Props = {
  /**
   * Content to render inside the static render zone.
   */
  readonly children: ReactNode;
  /**
   * Width constraint for the render area.
   */
  readonly width: number;
  /**
   * Optional styles to apply to the container.
   */
  readonly style?: Styles;
};

/**
 * Compat shim for ink's `<StaticRender>` component.
 *
 * The real ink `<StaticRender>` renders content into a fixed-width "static"
 * output zone above the live render area. The ink engine does not have that
 * zone, so this shim renders children inside a plain column flex-box with the
 * given width applied via `width` style, giving equivalent layout for typical
 * static-content use cases.
 */
export function StaticRender({ children, width, style }: Props): ReactNode {
  return (
    <ink-box style={{ flexDirection: 'column', width, ...style }}>
      {children}
    </ink-box>
  );
}

export default StaticRender;
