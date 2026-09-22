/**
 * The top clearance a host declares for upward-opening popovers through
 * `--web-shell-popover-safe-top`, or `undefined` when it declares none. A
 * declared `0px` stays 0 instead of falling back to a default.
 */
export function readPopoverSafeTop(element: Element): number | undefined {
  const value = Number.parseFloat(
    getComputedStyle(element).getPropertyValue('--web-shell-popover-safe-top'),
  );
  return Number.isFinite(value) ? value : undefined;
}

// Shared floor for the two upward-opening popovers (the history search panel
// and the @ reference panel), so raising it for one raises it for both.
export const POPOVER_MIN_HEIGHT = 96;

const CLIPPING_OVERFLOW = /^(auto|scroll|hidden|clip|overlay)$/;

/**
 * The highest viewport y at which a popover positioned inside `anchor` is still
 * painted: below the top edge of every ancestor that clips its overflow, and
 * below the host's declared safe top.
 *
 * With no declared safe top the bound starts at 0, because an in-flow popover
 * is already bounded by the clipping ancestors this walk measures. A popover
 * portaled out of that chain has no clipping ancestor to measure and needs a
 * numeric allowance instead — see AtMentionPanel's
 * `readPopoverSafeTop(anchor) ?? 48`. Keep the two defaults distinct: folding
 * the 48 in here would steal room from in-flow popovers, and folding the 0
 * into AtMentionPanel would let it rise under a host header that declares
 * nothing.
 */
export function popoverTopEdge(anchor: Element): number {
  let top = readPopoverSafeTop(anchor) ?? 0;
  for (
    let node = anchor.parentElement;
    node && node !== document.body;
    node = node.parentElement
  ) {
    if (CLIPPING_OVERFLOW.test(getComputedStyle(node).overflowY)) {
      top = Math.max(top, node.getBoundingClientRect().top);
    }
  }
  return top;
}
