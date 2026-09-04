import { ActionableError } from './robot';

// coord-norm.ts — Opt-in 0–1000 relative-coordinate shim for mobile-mcp.
//
// Mirrors packages/cua-driver's coord_norm.rs design. Default off = pixel
// passthrough (zero behavior change). When on, input coordinates are
// denormalized from 0–scale to device pixels/points before reaching the
// backend. Query tools (get_screen_size, list_elements) return real pixel
// values — the model learns the coordinate system from tool descriptions
// and server instructions.
//
// Env vars:
//   MOBILE_MCP_COORDINATE_SPACE  "0" (default, off) | "1" (on)
//   MOBILE_MCP_COORDINATE_SCALE  default 1000

// ── Global config (read once at module load) ─────────────────────────────────

export function isNormalized(): boolean {
  return process.env.MOBILE_MCP_COORDINATE_SPACE === '1';
}

export function coordinateScale(): number {
  const raw = parseInt(process.env.MOBILE_MCP_COORDINATE_SCALE || '1000', 10);
  return isNaN(raw) || raw <= 0 ? 1000 : raw;
}

// ── Scalar conversion ────────────────────────────────────────────────────────

export function normToPx(norm: number, dim: number, scale: number): number {
  return Math.round((norm / scale) * dim);
}

// ── Per-tool coordinate field mapping ────────────────────────────────────────

interface CoordField {
  field: string;
  isX: boolean; // true = scale by width, false = scale by height
}

const INPUT_COORD_FIELDS: Record<string, CoordField[]> = {
  mobile_click_on_screen_at_coordinates: [
    { field: 'x', isX: true },
    { field: 'y', isX: false },
  ],
  mobile_double_tap_on_screen: [
    { field: 'x', isX: true },
    { field: 'y', isX: false },
  ],
  mobile_long_press_on_screen_at_coordinates: [
    { field: 'x', isX: true },
    { field: 'y', isX: false },
  ],
  mobile_swipe_on_screen: [
    { field: 'x', isX: true },
    { field: 'y', isX: false },
  ],
};

// ── Per-device screen size cache ─────────────────────────────────────────────

const screenSizeCache = new Map<string, { width: number; height: number }>();

export function cacheScreenSize(
  deviceId: string,
  width: number,
  height: number,
): void {
  screenSizeCache.set(deviceId, { width, height });
}

export function invalidateScreenSize(deviceId: string): void {
  screenSizeCache.delete(deviceId);
}

export function getCachedScreenSize(
  deviceId: string,
): { width: number; height: number } | undefined {
  return screenSizeCache.get(deviceId);
}

// ── Input: denormalize 0–scale → pixels/points ──────────────────────────────

export function denormalizeArgs(
  toolName: string,
  args: Record<string, any>,
  screenWidth: number,
  screenHeight: number,
): void {
  const scale = coordinateScale();
  const fields = INPUT_COORD_FIELDS[toolName];
  if (!fields) return;

  for (const { field, isX } of fields) {
    if (typeof args[field] === 'number') {
      if (args[field] < 0 || args[field] > scale) {
        throw new ActionableError(
          `Coordinate '${field}' value ${args[field]} is out of the normalized range [0, ${scale}]. ` +
            `Use normalized coordinates (0-${scale}), not pixel coordinates.`,
        );
      }
      const dim = isX ? screenWidth : screenHeight;
      args[field] = normToPx(args[field], dim, scale);
    }
  }

  // swipe distance: scale by the axis matching the swipe direction
  if (
    toolName === 'mobile_swipe_on_screen' &&
    typeof args.distance === 'number'
  ) {
    if (args.distance < 0 || args.distance > scale) {
      throw new ActionableError(
        `Swipe 'distance' value ${args.distance} is out of the normalized range [0, ${scale}]. ` +
          `Use normalized coordinates (0-${scale}), not pixel values.`,
      );
    }
    const dir = args.direction;
    const dim = dir === 'up' || dir === 'down' ? screenHeight : screenWidth;
    args.distance = normToPx(args.distance, dim, scale);
  }
}

// ── Query helpers ───────────────────────────────────────────────────────────

export function hasCoordFields(toolName: string): boolean {
  return toolName in INPUT_COORD_FIELDS;
}

// ── Ingest: extract screen size from get_screen_size response ────────────────

export function ingestScreenSizeFromResult(
  deviceId: string,
  response: string,
): void {
  // Response format: "Screen size is WIDTHxHEIGHT pixels"
  const match = response.match(/Screen size is (\d+)x(\d+)/);
  if (match) {
    cacheScreenSize(deviceId, parseInt(match[1], 10), parseInt(match[2], 10));
  }
}

// ── Description rewriting ────────────────────────────────────────────────────

export function rewriteDescription(description: string): string {
  const scale = coordinateScale();
  return description.replace(
    /\bin pixels\b/g,
    `in 0-${scale} normalized coordinates`,
  );
}

export function coordParamDesc(baseDesc: string): string {
  if (!isNormalized()) return baseDesc;
  return rewriteDescription(baseDesc);
}
