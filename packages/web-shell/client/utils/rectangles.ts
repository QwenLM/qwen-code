export const BROWSER_LAYOUT_TOLERANCE_PX = 0.5;

export type Rectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// The default is strict disjointness; browser tests name their pixel allowance.
export function rectanglesAreDisjoint(
  first: Rectangle,
  second: Rectangle,
  epsilonPx = 0,
): boolean {
  return (
    first.x + first.width <= second.x + epsilonPx ||
    second.x + second.width <= first.x + epsilonPx ||
    first.y + first.height <= second.y + epsilonPx ||
    second.y + second.height <= first.y + epsilonPx
  );
}
