export function resolveSessionDetailsCollisionBoundary(
  anchor: HTMLElement | null,
): HTMLElement | null {
  return (
    anchor?.closest<HTMLElement>('[data-web-shell-root]') ??
    anchor?.closest<HTMLElement>('aside') ??
    null
  );
}
