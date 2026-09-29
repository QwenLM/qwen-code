import type { DisplayWorkArea, OverlayPosition } from './overlay-position.ts';

export type WindowSize = { width: number; height: number };
export type SubagentsSide = 'left' | 'right' | 'above' | 'below';

export function fitSubagentsBounds(
  point: OverlayPosition,
  size: WindowSize,
  area: DisplayWorkArea,
): DisplayWorkArea {
  const width = Math.min(size.width, Math.max(1, area.width - 16));
  const height = Math.min(size.height, Math.max(1, area.height - 16));
  return {
    x: Math.round(
      Math.min(area.x + area.width - width - 8, Math.max(area.x + 8, point.x)),
    ),
    y: Math.round(
      Math.min(
        area.y + area.height - height - 8,
        Math.max(area.y + 8, point.y),
      ),
    ),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function subagentsSidecarBounds(
  orb: DisplayWorkArea,
  size: WindowSize,
  area: DisplayWorkArea,
  preferred?: SubagentsSide,
): { bounds: DisplayWorkArea; side: SubagentsSide } {
  const gap = 12;
  const free = {
    left: orb.x - area.x - gap - 8,
    right: area.x + area.width - orb.x - orb.width - gap - 8,
    above: orb.y - area.y - gap - 8,
    below: area.y + area.height - orb.y - orb.height - gap - 8,
  };
  const side =
    preferred &&
    free[preferred] >=
      (preferred === 'left' || preferred === 'right' ? size.width : size.height)
      ? preferred
      : free.left >= size.width
        ? 'left'
        : free.right >= size.width
          ? 'right'
          : free.above >= size.height
            ? 'above'
            : free.below >= size.height
              ? 'below'
              : free.left >= free.right
                ? 'left'
                : 'right';
  const point = {
    x:
      side === 'left'
        ? orb.x - size.width - gap
        : side === 'right'
          ? orb.x + orb.width + gap
          : orb.x + (orb.width - size.width) / 2,
    y:
      side === 'above'
        ? orb.y - size.height - gap
        : side === 'below'
          ? orb.y + orb.height + gap
          : orb.y + (orb.height - size.height) / 2,
  };
  return { bounds: fitSubagentsBounds(point, size, area), side };
}
