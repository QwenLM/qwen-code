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

const CLIPPING_OVERFLOW = /^(auto|scroll|hidden|clip|overlay)$/;

/**
 * The highest viewport y at which a popover positioned inside `anchor` is still
 * painted: below the top edge of every ancestor that clips its overflow, and
 * below the host's declared safe top.
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
