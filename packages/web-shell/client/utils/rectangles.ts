export type Rectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function rectanglesAreDisjoint(
  first: Rectangle,
  second: Rectangle,
): boolean {
  return (
    first.x + first.width <= second.x + 0.5 ||
    second.x + second.width <= first.x + 0.5 ||
    first.y + first.height <= second.y + 0.5 ||
    second.y + second.height <= first.y + 0.5
  );
}
