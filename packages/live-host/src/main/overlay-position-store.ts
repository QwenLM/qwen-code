import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { isOverlayPosition, type OverlayPosition } from './overlay-position.ts';

export function readOverlayPosition(path: string): OverlayPosition | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isOverlayPosition(value)
      ? { x: Math.round(value.x), y: Math.round(value.y) }
      : undefined;
  } catch {
    return undefined;
  }
}

export function saveOverlayPosition(
  path: string,
  point: OverlayPosition,
): void {
  if (!isOverlayPosition(point))
    throw new TypeError('Invalid overlay position');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporary,
      JSON.stringify({ x: Math.round(point.x), y: Math.round(point.y) }),
      { flag: 'wx', mode: 0o600 },
    );
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* Rename already consumed the temporary file. */
    }
  }
}
