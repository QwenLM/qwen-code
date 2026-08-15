const TITLE_SCROLL_SPEED_PX_PER_S = 38;

/**
 * Measures the title inside `row` and refreshes the hover-scroll CSS
 * variables plus the overflow flag that gates the right-edge fade mask.
 * Rows call this on every pointer entry so a renamed or resized label never
 * animates with a stale distance.
 */
export function measureSessionTitleScroll(row: HTMLElement): void {
  const title = row.querySelector<HTMLElement>(
    '[data-web-shell-session-title]',
  );
  if (!title) return;
  const label = title.firstElementChild;
  const distance = Math.max(0, (label?.scrollWidth ?? 0) - title.clientWidth);
  title.style.setProperty('--session-title-scroll-distance', `${distance}px`);
  title.style.setProperty(
    '--session-title-scroll-duration',
    `${distance / TITLE_SCROLL_SPEED_PX_PER_S}s`,
  );
  title.toggleAttribute('data-web-shell-title-overflow', distance > 0);
}
