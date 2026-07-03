// coord-norm.ts — Opt-in 0–1000 relative-coordinate shim for mobile-mcp.
//
// Mirrors packages/cua-driver's coord_norm.rs design. Default off = pixel
// passthrough (zero behavior change). When on, input coordinates are
// denormalized from 0–scale to device pixels/points before reaching the
// backend, and output coordinates are normalized back.
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

export function pxToNorm(px: number, dim: number, scale: number): number {
  if (dim === 0) return 0;
  return Math.round((px / dim) * scale);
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
      const dim = isX ? screenWidth : screenHeight;
      args[field] = normToPx(args[field], dim, scale);
    }
  }

  // swipe distance: scale by the axis matching the swipe direction
  if (
    toolName === 'mobile_swipe_on_screen' &&
    typeof args.distance === 'number'
  ) {
    const dir = args.direction;
    const dim = dir === 'up' || dir === 'down' ? screenHeight : screenWidth;
    args.distance = normToPx(args.distance, dim, scale);
  }
}

// ── Output: normalize element coordinates and screen size ────────────────────

export function normalizeElementResult(
  toolName: string,
  response: string,
  screenWidth: number,
  screenHeight: number,
): string {
  if (toolName !== 'mobile_list_elements_on_screen') return response;

  const scale = coordinateScale();
  const prefix = 'Found these elements on screen: ';
  if (!response.startsWith(prefix)) return response;

  try {
    const elements = JSON.parse(response.substring(prefix.length));
    for (const el of elements) {
      if (el.coordinates) {
        el.coordinates.x = pxToNorm(el.coordinates.x, screenWidth, scale);
        el.coordinates.y = pxToNorm(el.coordinates.y, screenHeight, scale);
        el.coordinates.width = pxToNorm(
          el.coordinates.width,
          screenWidth,
          scale,
        );
        el.coordinates.height = pxToNorm(
          el.coordinates.height,
          screenHeight,
          scale,
        );
      }
    }
    return prefix + JSON.stringify(elements);
  } catch (err) {
    console.error('[coord-norm] Failed to normalize element coordinates:', err);
    return response;
  }
}

export function normalizeScreenSizeResult(
  toolName: string,
  response: string,
): string {
  if (toolName !== 'mobile_get_screen_size') return response;
  const scale = coordinateScale();
  return `Screen size is ${scale}x${scale} (normalized 0-${scale} coordinate space)`;
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
