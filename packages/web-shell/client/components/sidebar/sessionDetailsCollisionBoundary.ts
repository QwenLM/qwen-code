export function resolveSessionDetailsCollisionBoundary(
  sidebar: HTMLElement | null,
): HTMLElement | null {
  return sidebar?.closest<HTMLElement>('[data-web-shell-root]') ?? sidebar;
}
