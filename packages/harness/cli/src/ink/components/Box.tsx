/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

/// <reference path="../types.d.ts" />
import { c as _c } from 'react/compiler-runtime';
import { type Ref } from 'react';
import type { Except } from 'type-fest';
import type { DOMElement } from '../dom.js';
import type { ClickEvent } from '../events/click-event.js';
import type { FocusEvent } from '../events/focus-event.js';
import type { KeyboardEvent } from '../events/keyboard-event.js';
import type { Styles } from '../styles.js';
import * as warn from '../warn.js';
export type Props = Except<Styles, 'textWrap'> & {
  ref?: Ref<DOMElement>;
  /**
   * Tab order index. Nodes with `tabIndex >= 0` participate in
   * Tab/Shift+Tab cycling; `-1` means programmatically focusable only.
   */
  tabIndex?: number;
  /**
   * Focus this element when it mounts. Like the HTML `autofocus`
   * attribute — the FocusManager calls `focus(node)` during the
   * reconciler's `commitMount` phase.
   */
  autoFocus?: boolean;
  /**
   * Fired on left-button click (press + release without drag). Only works
   * inside `<AlternateScreen>` where mouse tracking is enabled — no-op
   * otherwise. The event bubbles from the deepest hit Box up through
   * ancestors; call `event.stopImmediatePropagation()` to stop bubbling.
   */
  onClick?: (event: ClickEvent) => void;
  onFocus?: (event: FocusEvent) => void;
  onFocusCapture?: (event: FocusEvent) => void;
  onBlur?: (event: FocusEvent) => void;
  onBlurCapture?: (event: FocusEvent) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  onKeyDownCapture?: (event: KeyboardEvent) => void;
  /**
   * Fired when the mouse moves into this Box's rendered rect. Like DOM
   * `mouseenter`, does NOT bubble — moving between children does not
   * re-fire on the parent. Only works inside `<AlternateScreen>` where
   * mode-1003 mouse tracking is enabled.
   */
  onMouseEnter?: () => void;
  /** Fired when the mouse moves out of this Box's rendered rect. */
  onMouseLeave?: () => void;
  /**
   * Rows the content is scrolled down by. Only meaningful with
   * `overflowY="scroll"`. The reconciler writes it to the DOM node's
   * `scrollTop` when the prop value changes; between changes the renderer
   * may adjust the node's own `scrollTop` (clamping, at-bottom follow) and
   * that adjustment is kept.
   */
  scrollTop?: number;
  /**
   * Keep the viewport pinned to the bottom as content grows. Only
   * meaningful with `overflowY="scroll"`.
   */
  stickyScroll?: boolean;
};

/**
 * `<Box>` is an essential Ink component to build your layout. It's like `<div style="display: flex">` in the browser.
 */
function Box(t0: any) {
  const $ = _c(46);
  let autoFocus;
  let children;
  let flexDirection;
  let flexGrow;
  let flexShrink;
  let flexWrap;
  let onBlur;
  let onBlurCapture;
  let onClick;
  let onFocus;
  let onFocusCapture;
  let onKeyDown;
  let onKeyDownCapture;
  let onMouseEnter;
  let onMouseLeave;
  let ref;
  let scrollTop;
  let stickyScroll;
  let style;
  let tabIndex;
  if ($[0] !== t0) {
    const {
      children: t1,
      flexWrap: t2,
      flexDirection: t3,
      flexGrow: t4,
      flexShrink: t5,
      ref: t6,
      tabIndex: t7,
      autoFocus: t8,
      onClick: t9,
      onFocus: t10,
      onFocusCapture: t11,
      onBlur: t12,
      onBlurCapture: t13,
      onMouseEnter: t14,
      onMouseLeave: t15,
      onKeyDown: t16,
      onKeyDownCapture: t17,
      scrollTop: t19,
      stickyScroll: t20,
      ...t18
    } = t0;
    children = t1;
    ref = t6;
    tabIndex = t7;
    autoFocus = t8;
    onClick = t9;
    onFocus = t10;
    onFocusCapture = t11;
    onBlur = t12;
    onBlurCapture = t13;
    onMouseEnter = t14;
    onMouseLeave = t15;
    onKeyDown = t16;
    onKeyDownCapture = t17;
    scrollTop = t19;
    stickyScroll = t20;
    style = t18;
    flexWrap = t2 === undefined ? 'nowrap' : t2;
    flexDirection = t3 === undefined ? 'row' : t3;
    flexGrow = t4 === undefined ? 0 : t4;
    flexShrink = t5 === undefined ? 1 : t5;
    warn.ifNotInteger(style.margin, 'margin');
    warn.ifNotInteger(style.marginX, 'marginX');
    warn.ifNotInteger(style.marginY, 'marginY');
    warn.ifNotInteger(style.marginTop, 'marginTop');
    warn.ifNotInteger(style.marginBottom, 'marginBottom');
    warn.ifNotInteger(style.marginLeft, 'marginLeft');
    warn.ifNotInteger(style.marginRight, 'marginRight');
    warn.ifNotInteger(style.padding, 'padding');
    warn.ifNotInteger(style.paddingX, 'paddingX');
    warn.ifNotInteger(style.paddingY, 'paddingY');
    warn.ifNotInteger(style.paddingTop, 'paddingTop');
    warn.ifNotInteger(style.paddingBottom, 'paddingBottom');
    warn.ifNotInteger(style.paddingLeft, 'paddingLeft');
    warn.ifNotInteger(style.paddingRight, 'paddingRight');
    warn.ifNotInteger(style.gap, 'gap');
    warn.ifNotInteger(style.columnGap, 'columnGap');
    warn.ifNotInteger(style.rowGap, 'rowGap');
    $[0] = t0;
    $[1] = autoFocus;
    $[2] = children;
    $[3] = flexDirection;
    $[4] = flexGrow;
    $[5] = flexShrink;
    $[6] = flexWrap;
    $[7] = onBlur;
    $[8] = onBlurCapture;
    $[9] = onClick;
    $[10] = onFocus;
    $[11] = onFocusCapture;
    $[12] = onKeyDown;
    $[13] = onKeyDownCapture;
    $[14] = onMouseEnter;
    $[15] = onMouseLeave;
    $[16] = ref;
    $[17] = style;
    $[18] = tabIndex;
    $[42] = scrollTop;
    $[43] = stickyScroll;
  } else {
    autoFocus = $[1];
    children = $[2];
    flexDirection = $[3];
    flexGrow = $[4];
    flexShrink = $[5];
    flexWrap = $[6];
    onBlur = $[7];
    onBlurCapture = $[8];
    onClick = $[9];
    onFocus = $[10];
    onFocusCapture = $[11];
    onKeyDown = $[12];
    onKeyDownCapture = $[13];
    onMouseEnter = $[14];
    onMouseLeave = $[15];
    ref = $[16];
    style = $[17];
    tabIndex = $[18];
    scrollTop = $[42];
    stickyScroll = $[43];
  }
  const t1 = style.overflowX ?? style.overflow ?? 'visible';
  const t2 = style.overflowY ?? style.overflow ?? 'visible';
  let t3;
  if (
    $[19] !== flexDirection ||
    $[20] !== flexGrow ||
    $[21] !== flexShrink ||
    $[22] !== flexWrap ||
    $[23] !== style ||
    $[24] !== t1 ||
    $[25] !== t2
  ) {
    t3 = {
      flexWrap,
      flexDirection,
      flexGrow,
      flexShrink,
      ...style,
      overflowX: t1,
      overflowY: t2,
    };
    $[19] = flexDirection;
    $[20] = flexGrow;
    $[21] = flexShrink;
    $[22] = flexWrap;
    $[23] = style;
    $[24] = t1;
    $[25] = t2;
    $[26] = t3;
  } else {
    t3 = $[26];
  }
  let t4;
  if (
    $[27] !== autoFocus ||
    $[28] !== children ||
    $[29] !== onBlur ||
    $[30] !== onBlurCapture ||
    $[31] !== onClick ||
    $[32] !== onFocus ||
    $[33] !== onFocusCapture ||
    $[34] !== onKeyDown ||
    $[35] !== onKeyDownCapture ||
    $[36] !== onMouseEnter ||
    $[37] !== onMouseLeave ||
    $[38] !== ref ||
    $[39] !== t3 ||
    $[40] !== tabIndex ||
    $[44] !== scrollTop ||
    $[45] !== stickyScroll
  ) {
    t4 = (
      <ink-box
        ref={ref}
        tabIndex={tabIndex}
        autoFocus={autoFocus}
        scrollTop={scrollTop}
        stickyScroll={stickyScroll}
        onClick={onClick}
        onFocus={onFocus}
        onFocusCapture={onFocusCapture}
        onBlur={onBlur}
        onBlurCapture={onBlurCapture}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onKeyDown={onKeyDown}
        onKeyDownCapture={onKeyDownCapture}
        style={t3}
      >
        {children}
      </ink-box>
    );
    $[27] = autoFocus;
    $[28] = children;
    $[29] = onBlur;
    $[30] = onBlurCapture;
    $[31] = onClick;
    $[32] = onFocus;
    $[33] = onFocusCapture;
    $[34] = onKeyDown;
    $[35] = onKeyDownCapture;
    $[36] = onMouseEnter;
    $[37] = onMouseLeave;
    $[38] = ref;
    $[39] = t3;
    $[40] = tabIndex;
    $[41] = t4;
    $[44] = scrollTop;
    $[45] = stickyScroll;
  } else {
    t4 = $[41];
  }
  return t4;
}
export default Box;
