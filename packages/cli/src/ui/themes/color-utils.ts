/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '@qwen-code/qwen-code-core';

// Mapping from common CSS color names (lowercase) to hex codes (lowercase)
// Excludes names directly supported by Ink
export const CSS_NAME_TO_HEX_MAP: Readonly<Record<string, string>> = {
  aliceblue: '#f0f8ff',
  antiquewhite: '#faebd7',
  aqua: '#00ffff',
  aquamarine: '#7fffd4',
  azure: '#f0ffff',
  beige: '#f5f5dc',
  bisque: '#ffe4c4',
  blanchedalmond: '#ffebcd',
  blueviolet: '#8a2be2',
  brown: '#a52a2a',
  burlywood: '#deb887',
  cadetblue: '#5f9ea0',
  chartreuse: '#7fff00',
  chocolate: '#d2691e',
  coral: '#ff7f50',
  cornflowerblue: '#6495ed',
  cornsilk: '#fff8dc',
  crimson: '#dc143c',
  darkblue: '#00008b',
  darkcyan: '#008b8b',
  darkgoldenrod: '#b8860b',
  darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9',
  darkgreen: '#006400',
  darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b',
  darkolivegreen: '#556b2f',
  darkorange: '#ff8c00',
  darkorchid: '#9932cc',
  darkred: '#8b0000',
  darksalmon: '#e9967a',
  darkseagreen: '#8fbc8f',
  darkslateblue: '#483d8b',
  darkslategray: '#2f4f4f',
  darkslategrey: '#2f4f4f',
  darkturquoise: '#00ced1',
  darkviolet: '#9400d3',
  deeppink: '#ff1493',
  deepskyblue: '#00bfff',
  dimgray: '#696969',
  dimgrey: '#696969',
  dodgerblue: '#1e90ff',
  firebrick: '#b22222',
  floralwhite: '#fffaf0',
  forestgreen: '#228b22',
  fuchsia: '#ff00ff',
  gainsboro: '#dcdcdc',
  ghostwhite: '#f8f8ff',
  gold: '#ffd700',
  goldenrod: '#daa520',
  greenyellow: '#adff2f',
  honeydew: '#f0fff0',
  hotpink: '#ff69b4',
  indianred: '#cd5c5c',
  indigo: '#4b0082',
  ivory: '#fffff0',
  khaki: '#f0e68c',
  lavender: '#e6e6fa',
  lavenderblush: '#fff0f5',
  lawngreen: '#7cfc00',
  lemonchiffon: '#fffacd',
  lightblue: '#add8e6',
  lightcoral: '#f08080',
  lightcyan: '#e0ffff',
  lightgoldenrodyellow: '#fafad2',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  lightgreen: '#90ee90',
  lightpink: '#ffb6c1',
  lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa',
  lightskyblue: '#87cefa',
  lightslategray: '#778899',
  lightslategrey: '#778899',
  lightsteelblue: '#b0c4de',
  lightyellow: '#ffffe0',
  lime: '#00ff00',
  limegreen: '#32cd32',
  linen: '#faf0e6',
  maroon: '#800000',
  mediumaquamarine: '#66cdaa',
  mediumblue: '#0000cd',
  mediumorchid: '#ba55d3',
  mediumpurple: '#9370db',
  mediumseagreen: '#3cb371',
  mediumslateblue: '#7b68ee',
  mediumspringgreen: '#00fa9a',
  mediumturquoise: '#48d1cc',
  mediumvioletred: '#c71585',
  midnightblue: '#191970',
  mintcream: '#f5fffa',
  mistyrose: '#ffe4e1',
  moccasin: '#ffe4b5',
  navajowhite: '#ffdead',
  navy: '#000080',
  oldlace: '#fdf5e6',
  olive: '#808000',
  olivedrab: '#6b8e23',
  orange: '#ffa500',
  orangered: '#ff4500',
  orchid: '#da70d6',
  palegoldenrod: '#eee8aa',
  palegreen: '#98fb98',
  paleturquoise: '#afeeee',
  palevioletred: '#db7093',
  papayawhip: '#ffefd5',
  peachpuff: '#ffdab9',
  peru: '#cd853f',
  pink: '#ffc0cb',
  plum: '#dda0dd',
  powderblue: '#b0e0e6',
  purple: '#800080',
  rebeccapurple: '#663399',
  rosybrown: '#bc8f8f',
  royalblue: '#4169e1',
  saddlebrown: '#8b4513',
  salmon: '#fa8072',
  sandybrown: '#f4a460',
  seagreen: '#2e8b57',
  seashell: '#fff5ee',
  sienna: '#a0522d',
  silver: '#c0c0c0',
  skyblue: '#87ceeb',
  slateblue: '#6a5acd',
  slategray: '#708090',
  slategrey: '#708090',
  snow: '#fffafa',
  springgreen: '#00ff7f',
  steelblue: '#4682b4',
  tan: '#d2b48c',
  teal: '#008080',
  thistle: '#d8bfd8',
  tomato: '#ff6347',
  turquoise: '#40e0d0',
  violet: '#ee82ee',
  wheat: '#f5deb3',
  whitesmoke: '#f5f5f5',
  yellowgreen: '#9acd32',
};

const debugLogger = createDebugLogger('COLOR_UTILS');

// Define the set of Ink's named colors for quick lookup
export const INK_SUPPORTED_NAMES = new Set([
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'cyan',
  'magenta',
  'white',
  'gray',
  'grey',
  'blackbright',
  'redbright',
  'greenbright',
  'yellowbright',
  'bluebright',
  'cyanbright',
  'magentabright',
  'whitebright',
]);

/**
 * Checks if a color string is valid (hex, Ink-supported color name, or CSS color name).
 * This function uses the same validation logic as the Theme class's _resolveColor method
 * to ensure consistency between validation and resolution.
 * @param color The color string to validate.
 * @returns True if the color is valid.
 */
export function isValidColor(color: string): boolean {
  const lowerColor = color.toLowerCase();

  // 1. Check if it's a hex code
  if (lowerColor.startsWith('#')) {
    return /^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(color);
  }

  // 2. Check if it's an Ink supported name
  if (INK_SUPPORTED_NAMES.has(lowerColor)) {
    return true;
  }

  // 3. Check if it's a known CSS name we can map to hex
  if (CSS_NAME_TO_HEX_MAP[lowerColor]) {
    return true;
  }

  // 4. Not a valid color
  return false;
}

/**
 * Resolves a CSS color value (name or hex) into an Ink-compatible color string.
 * @param colorValue The raw color string (e.g., 'blue', '#ff0000', 'darkkhaki').
 * @returns An Ink-compatible color string (hex or name), or undefined if not resolvable.
 */
export function resolveColor(colorValue: string): string | undefined {
  const lowerColor = colorValue.toLowerCase();

  // 1. Check if it's already a hex code and valid
  if (lowerColor.startsWith('#')) {
    if (/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(colorValue)) {
      return lowerColor;
    } else {
      return undefined;
    }
  }
  // 2. Check if it's an Ink supported name (lowercase)
  else if (INK_SUPPORTED_NAMES.has(lowerColor)) {
    return lowerColor; // Use Ink name directly
  }
  // 3. Check if it's a known CSS name we can map to hex
  else if (CSS_NAME_TO_HEX_MAP[lowerColor]) {
    return CSS_NAME_TO_HEX_MAP[lowerColor]; // Use mapped hex
  }

  // 4. Could not resolve
  debugLogger.warn(
    `[ColorUtils] Could not resolve color "${colorValue}" to an Ink-compatible format.`,
  );
  return undefined;
}

// Basic Ink color names that resolveColor passes through as names rather than
// hex. Needed so interpolateColor can blend them numerically.
const INK_NAME_TO_HEX: Readonly<Record<string, string>> = {
  black: '#000000',
  red: '#ff0000',
  green: '#00ff00',
  yellow: '#ffff00',
  blue: '#0000ff',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  white: '#ffffff',
  gray: '#808080',
  grey: '#808080',
  blackbright: '#808080',
  redbright: '#ff8080',
  greenbright: '#80ff80',
  yellowbright: '#ffff80',
  bluebright: '#8080ff',
  cyanbright: '#80ffff',
  magentabright: '#ff80ff',
  whitebright: '#ffffff',
};

/**
 * Resolves any accepted color string to a 6-digit hex (#rrggbb), or undefined
 * if it cannot be parsed into RGB.
 */
function toHex(color: string): string | undefined {
  const resolved = (resolveColor(color) ?? color).toLowerCase();
  if (resolved.startsWith('#')) {
    if (/^#[0-9a-f]{3}$/.test(resolved)) {
      return `#${resolved
        .slice(1)
        .split('')
        .map((c) => c + c)
        .join('')}`;
    }
    if (/^#[0-9a-f]{6}$/.test(resolved)) {
      return resolved;
    }
    return undefined;
  }
  return INK_NAME_TO_HEX[resolved];
}

/**
 * Linearly blends two colors in RGB space.
 * @param color1 Returned (unchanged) when factor <= 0.
 * @param color2 Returned (unchanged) when factor >= 1.
 * @param factor Blend amount in [0, 1] from color1 toward color2.
 * @returns A #rrggbb hex string, or '' if either color cannot be parsed.
 */
export function interpolateColor(
  color1: string,
  color2: string,
  factor: number,
): string {
  if (factor <= 0) {
    return color1;
  }
  if (factor >= 1) {
    return color2;
  }
  const h1 = toHex(color1);
  const h2 = toHex(color2);
  if (!h1 || !h2) {
    return '';
  }
  const r1 = parseInt(h1.slice(1, 3), 16);
  const g1 = parseInt(h1.slice(3, 5), 16);
  const b1 = parseInt(h1.slice(5, 7), 16);
  const r2 = parseInt(h2.slice(1, 3), 16);
  const g2 = parseInt(h2.slice(3, 5), 16);
  const b2 = parseInt(h2.slice(5, 7), 16);
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * factor);
  const toByte = (n: number) =>
    Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${toByte(lerp(r1, r2))}${toByte(lerp(g1, g2))}${toByte(lerp(b1, b2))}`;
}

/**
 * Computes a subtle band color by shifting the background brightness toward
 * white (dark themes) or black (light themes) by `factor` (default 0.06).
 * No hue change — just a brightness nudge, so the band is nearly invisible.
 * Automatically detects dark/light from the background color luminance.
 * Returns '' if the background color cannot be resolved.
 */
export function subtleBandColor(bgColor: string, factor = 0.06): string {
  const hex = toHex(bgColor);
  if (!hex) {
    return '';
  }
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const isDark = (r * 299 + g * 587 + b * 114) / 1000 < 128;
  const target = isDark ? '#ffffff' : '#000000';
  return interpolateColor(hex, target, factor);
}

/**
 * Detects whether the terminal supports 24-bit (true) color, required for the
 * blended half-line background band. Result is cached at module scope since
 * terminal color capability does not change during the process lifetime.
 */
let _supportsTrueColor: boolean | undefined;
export function supportsTrueColor(): boolean {
  if (_supportsTrueColor !== undefined) return _supportsTrueColor;
  const colorterm = process.env['COLORTERM'];
  if (
    colorterm === 'truecolor' ||
    colorterm === '24bit' ||
    colorterm === 'kmscon'
  ) {
    return (_supportsTrueColor = true);
  }
  if (process.stdout.getColorDepth && process.stdout.getColorDepth() >= 24) {
    return (_supportsTrueColor = true);
  }
  return (_supportsTrueColor = false);
}
