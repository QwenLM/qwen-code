/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

/**
 * Ink engine type declarations.
 *
 * Defines JSX intrinsic elements (ink-box, ink-text, etc.) and module
 * augmentations for third-party packages that ship without types.
 *
 * Engine source files reference this via
 *   /// <reference path="./types.d.ts" />
 * and tsconfig also picks it up via the `src/**\/*.d.ts` include pattern.
 */
import type { ReactNode, Ref } from 'react';
import type { ClickEvent } from './events/click-event.js';
import type { FocusEvent } from './events/focus-event.js';
import type { KeyboardEvent } from './events/keyboard-event.js';
import type { Styles, TextStyles } from './styles.js';
import type { DOMElement } from './dom.js';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': {
        ref?: Ref<DOMElement>;
        tabIndex?: number;
        autoFocus?: boolean;
        onClick?: (event: ClickEvent) => void;
        onFocus?: (event: FocusEvent) => void;
        onFocusCapture?: (event: FocusEvent) => void;
        onBlur?: (event: FocusEvent) => void;
        onBlurCapture?: (event: FocusEvent) => void;
        onMouseEnter?: () => void;
        onMouseLeave?: () => void;
        onKeyDown?: (event: KeyboardEvent) => void;
        onKeyDownCapture?: (event: KeyboardEvent) => void;
        style?: Styles;
        scrollTop?: number;
        stickyScroll?: boolean;
        children?: ReactNode;
      };
      'ink-text': {
        style?: Styles;
        textStyles?: TextStyles;
        children?: ReactNode;
      };
      'ink-link': {
        href?: string;
        children?: ReactNode;
      };
      'ink-raw-ansi': {
        rawText?: string;
        rawWidth?: number;
        rawHeight?: number;
      };
    }
  }
}

declare module 'react/compiler-runtime' {
  // Use `any[]` (not `unknown[]`) so indexed access `$[n]` propagates as `any`
  // into compiled component return types; with `unknown`, compiled `function
  // Box(t0) { ... }` gets inferred return type `unknown`, which then trips
  // TS2786 ("cannot be used as a JSX component") wherever Box is rendered.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function c(size: number): any[];
}

export {};
