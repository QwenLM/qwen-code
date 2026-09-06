export type DisplayWorkArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function overlayPosition(
  workArea: DisplayWorkArea,
  width: number,
  height: number,
  margin = 20,
): { x: number; y: number } {
  return {
    x: Math.round(workArea.x + Math.max(0, workArea.width - width - margin)),
    y: Math.round(workArea.y + Math.max(0, workArea.height - height - margin)),
  };
}
