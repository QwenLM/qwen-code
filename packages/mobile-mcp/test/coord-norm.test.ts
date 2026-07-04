import { test, expect } from '@playwright/test';

// We need to test coord-norm functions. Since the module uses process.env,
// we manipulate env vars in each test.

// Dynamic import to allow env var manipulation before module evaluation.
async function loadCoordNorm(env: Record<string, string | undefined> = {}) {
  const origEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    origEnv[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }

  // Force re-import by clearing require cache
  const modulePath = require.resolve('../src/coord-norm');
  delete require.cache[modulePath];
  const mod = require('../src/coord-norm');

  return {
    mod,
    restore: () => {
      for (const [k, v] of Object.entries(origEnv)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
      delete require.cache[modulePath];
    },
  };
}

// ── Scalar conversion tests ──

test('normToPx maps midpoint', async () => {
  const { mod, restore } = await loadCoordNorm();
  try {
    expect(mod.normToPx(500, 800, 1000)).toBe(400);
  } finally {
    restore();
  }
});

test('normToPx maps edges', async () => {
  const { mod, restore } = await loadCoordNorm();
  try {
    expect(mod.normToPx(0, 800, 1000)).toBe(0);
    expect(mod.normToPx(1000, 800, 1000)).toBe(800);
  } finally {
    restore();
  }
});

test('normToPx rounds to nearest', async () => {
  const { mod, restore } = await loadCoordNorm();
  try {
    // 333/1000 * 800 = 266.4 → 266
    expect(mod.normToPx(333, 800, 1000)).toBe(266);
  } finally {
    restore();
  }
});

test('pxToNorm is inverse at midpoint', async () => {
  const { mod, restore } = await loadCoordNorm();
  try {
    expect(mod.pxToNorm(400, 800, 1000)).toBe(500);
    expect(mod.pxToNorm(800, 800, 1000)).toBe(1000);
  } finally {
    restore();
  }
});

test('normToPx respects custom scale (999)', async () => {
  const { mod, restore } = await loadCoordNorm();
  try {
    expect(mod.normToPx(999, 800, 999)).toBe(800);
    // Same input under scale 1000: 999/1000*800 = 799.2 → 799
    expect(mod.normToPx(999, 800, 1000)).toBe(799);
  } finally {
    restore();
  }
});

test('pxToNorm handles zero dim', async () => {
  const { mod, restore } = await loadCoordNorm();
  try {
    expect(mod.pxToNorm(400, 0, 1000)).toBe(0);
  } finally {
    restore();
  }
});

// ── denormalizeArgs tests ──

test('denormalizeArgs click uses width for x, height for y', async () => {
  const { mod, restore } = await loadCoordNorm();
  try {
    const args: any = { device: 'd1', x: 500, y: 500 };
    mod.denormalizeArgs(
      'mobile_click_on_screen_at_coordinates',
      args,
      800,
      600,
    );
    expect(args.x).toBe(400); // 500/1000 * 800
    expect(args.y).toBe(300); // 500/1000 * 600
  } finally {
    restore();
  }
});

test('denormalizeArgs swipe converts x, y, and distance by direction', async () => {
  const { mod, restore } = await loadCoordNorm();
  try {
    const argsDown: any = {
      device: 'd1',
      x: 500,
      y: 500,
      distance: 200,
      direction: 'down',
    };
    mod.denormalizeArgs('mobile_swipe_on_screen', argsDown, 800, 600);
    expect(argsDown.x).toBe(400);
    expect(argsDown.y).toBe(300);
    expect(argsDown.distance).toBe(120); // 200/1000 * 600 (height for down)

    const argsRight: any = {
      device: 'd1',
      x: 500,
      y: 500,
      distance: 200,
      direction: 'right',
    };
    mod.denormalizeArgs('mobile_swipe_on_screen', argsRight, 800, 600);
    expect(argsRight.distance).toBe(160); // 200/1000 * 800 (width for right)
  } finally {
    restore();
  }
});

test('denormalizeArgs leaves non-coord tools untouched', async () => {
  const { mod, restore } = await loadCoordNorm();
  try {
    const args: any = { device: 'd1', direction: 'down' };
    mod.denormalizeArgs('mobile_press_button', args, 800, 600);
    expect(args).toEqual({ device: 'd1', direction: 'down' });
  } finally {
    restore();
  }
});

test('denormalizeArgs ignores missing coord fields', async () => {
  const { mod, restore } = await loadCoordNorm();
  try {
    const args: any = { device: 'd1' };
    mod.denormalizeArgs(
      'mobile_click_on_screen_at_coordinates',
      args,
      800,
      600,
    );
    expect(args.x).toBeUndefined();
    expect(args.y).toBeUndefined();
  } finally {
    restore();
  }
});

// ── Output normalization tests ──

test('normalizeElementResult rewrites element coordinates', async () => {
  const { mod, restore } = await loadCoordNorm();
  try {
    const elements = [
      {
        type: 'button',
        coordinates: { x: 400, y: 300, width: 80, height: 60 },
      },
    ];
    const input = 'Found these elements on screen: ' + JSON.stringify(elements);
    const result = mod.normalizeElementResult(
      'mobile_list_elements_on_screen',
      input,
      800,
      600,
    );
    const parsed = JSON.parse(
      result.replace('Found these elements on screen: ', ''),
    );
    expect(parsed[0].coordinates.x).toBe(500); // 400/800*1000
    expect(parsed[0].coordinates.y).toBe(500); // 300/600*1000
    expect(parsed[0].coordinates.width).toBe(100); // 80/800*1000
    expect(parsed[0].coordinates.height).toBe(100); // 60/600*1000
  } finally {
    restore();
  }
});

test('normalizeScreenSizeResult rewrites to scale', async () => {
  const { mod, restore } = await loadCoordNorm();
  try {
    const result = mod.normalizeScreenSizeResult(
      'mobile_get_screen_size',
      'Screen size is 1080x2400 pixels',
    );
    expect(result).toContain('1000x1000');
  } finally {
    restore();
  }
});

test('normalizeScreenSizeResult leaves non-screen-size tools alone', async () => {
  const { mod, restore } = await loadCoordNorm();
  try {
    const result = mod.normalizeScreenSizeResult(
      'mobile_tap',
      'Tapped at 100, 200',
    );
    expect(result).toBe('Tapped at 100, 200');
  } finally {
    restore();
  }
});

// ── Screen size cache tests ──

test('screen size cache round-trip', async () => {
  const { mod, restore } = await loadCoordNorm();
  try {
    mod.cacheScreenSize('test-device', 1080, 2400);
    const size = mod.getCachedScreenSize('test-device');
    expect(size).toEqual({ width: 1080, height: 2400 });
  } finally {
    restore();
  }
});

test('screen size cache returns undefined for unknown device', async () => {
  const { mod, restore } = await loadCoordNorm();
  try {
    expect(mod.getCachedScreenSize('nonexistent')).toBeUndefined();
  } finally {
    restore();
  }
});

test('ingestScreenSizeFromResult parses response', async () => {
  const { mod, restore } = await loadCoordNorm();
  try {
    mod.ingestScreenSizeFromResult('dev1', 'Screen size is 1080x2400 pixels');
    const size = mod.getCachedScreenSize('dev1');
    expect(size).toEqual({ width: 1080, height: 2400 });
  } finally {
    restore();
  }
});

// ── Config tests ──

test('isNormalized returns false by default', async () => {
  const { mod, restore } = await loadCoordNorm({
    MOBILE_MCP_COORDINATE_SPACE: undefined,
  });
  try {
    expect(mod.isNormalized()).toBe(false);
  } finally {
    restore();
  }
});

test('isNormalized returns true when MOBILE_MCP_COORDINATE_SPACE=1', async () => {
  const { mod, restore } = await loadCoordNorm({
    MOBILE_MCP_COORDINATE_SPACE: '1',
  });
  try {
    expect(mod.isNormalized()).toBe(true);
  } finally {
    restore();
  }
});

test('coordinateScale defaults to 1000', async () => {
  const { mod, restore } = await loadCoordNorm({
    MOBILE_MCP_COORDINATE_SCALE: undefined,
  });
  try {
    expect(mod.coordinateScale()).toBe(1000);
  } finally {
    restore();
  }
});

test('coordinateScale reads custom value', async () => {
  const { mod, restore } = await loadCoordNorm({
    MOBILE_MCP_COORDINATE_SCALE: '999',
  });
  try {
    expect(mod.coordinateScale()).toBe(999);
  } finally {
    restore();
  }
});

// ── Description rewriting tests ──

test("rewriteDescription replaces 'in pixels' with normalized wording", async () => {
  const { mod, restore } = await loadCoordNorm();
  try {
    const result = mod.rewriteDescription(
      'Click on the screen at x,y in pixels',
    );
    expect(result).toContain('0-1000 normalized coordinates');
    expect(result).not.toContain('in pixels');
  } finally {
    restore();
  }
});

test('coordParamDesc is passthrough when not normalized', async () => {
  const { mod, restore } = await loadCoordNorm({
    MOBILE_MCP_COORDINATE_SPACE: '0',
  });
  try {
    const desc = 'The x coordinate, in pixels';
    expect(mod.coordParamDesc(desc)).toBe(desc);
  } finally {
    restore();
  }
});

test('coordParamDesc rewrites when normalized', async () => {
  const { mod, restore } = await loadCoordNorm({
    MOBILE_MCP_COORDINATE_SPACE: '1',
  });
  try {
    const result = mod.coordParamDesc('The x coordinate, in pixels');
    expect(result).toContain('0-1000 normalized');
  } finally {
    restore();
  }
});
