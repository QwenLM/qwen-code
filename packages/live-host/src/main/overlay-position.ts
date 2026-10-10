export type DisplayWorkArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OverlayPosition = { x: number; y: number };

export function isOverlayPosition(value: unknown): value is OverlayPosition {
  if (typeof value !== 'object' || value === null) return false;
  const point = value as Record<string, unknown>;
  return [point.x, point.y].every(
    (coordinate) =>
      typeof coordinate === 'number' &&
      Number.isFinite(coordinate) &&
      Math.abs(coordinate) <= 1_000_000,
  );
}

export function clampOverlayPosition(
  point: OverlayPosition,
  workArea: DisplayWorkArea,
  visible: DisplayWorkArea,
): OverlayPosition {
  return {
    x: Math.round(
      Math.max(
        workArea.x - visible.x,
        Math.min(
          point.x,
          workArea.x + Math.max(0, workArea.width - visible.width) - visible.x,
        ),
      ),
    ),
    y: Math.round(
      Math.max(
        workArea.y - visible.y,
        Math.min(
          point.y,
          workArea.y +
            Math.max(0, workArea.height - visible.height) -
            visible.y,
        ),
      ),
    ),
  };
}

export function overlayPosition(
  workArea: DisplayWorkArea,
  visible: DisplayWorkArea,
  margin = 20,
): { x: number; y: number } {
  return {
    x: Math.round(
      workArea.x +
        Math.max(0, workArea.width - visible.width - margin) -
        visible.x,
    ),
    y: Math.round(
      workArea.y +
        Math.max(0, workArea.height - visible.height - margin) -
        visible.y,
    ),
  };
}
