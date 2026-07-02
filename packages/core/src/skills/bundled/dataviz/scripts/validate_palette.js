#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MODE_CONFIG = {
  light: {
    surface: [255, 255, 255],
    minLightness: 0.25,
    maxLightness: 0.88,
    minContrast: 2.5,
  },
  dark: {
    surface: [17, 24, 39],
    minLightness: 0.45,
    maxLightness: 0.92,
    minContrast: 2.5,
  },
};

const CVD_MATRICES = {
  protanopia: [
    [0.56667, 0.43333, 0],
    [0.55833, 0.44167, 0],
    [0, 0, 1],
  ],
  deuteranopia: [
    [0.625, 0.375, 0],
    [0.7, 0.3, 0],
    [0, 0.3, 0.7],
  ],
  tritanopia: [
    [0.95, 0.05, 0],
    [0, 0.43333, 0.56667],
    [0, 0.475, 0.525],
  ],
};

export function validatePalette(input, options = {}) {
  const mode = options.mode ?? 'light';
  const config = MODE_CONFIG[mode];
  const failures = [];
  const warnings = [];

  if (!config) {
    return {
      status: 'FAIL',
      failures: [`Unsupported mode "${mode}". Use "light" or "dark".`],
      warnings,
    };
  }

  if (input.length === 0) {
    return { status: 'FAIL', failures: ['No colors provided.'], warnings };
  }

  const colors = input.map((value, index) => {
    const rgb = parseHexColor(value);
    if (!rgb) {
      failures.push(
        `Color ${index + 1} has invalid hex color syntax: ${value}`,
      );
      return null;
    }
    const lab = rgbToLab(rgb);
    const oklch = rgbToOklch(rgb);
    return { value: normalizeHex(value), rgb, lab, oklch };
  });

  if (failures.length > 0) {
    return { status: 'FAIL', failures, warnings };
  }

  for (const color of colors) {
    if (
      color.oklch.l < config.minLightness ||
      color.oklch.l > config.maxLightness
    ) {
      failures.push(
        `${color.value} has OKLCH lightness ${format(color.oklch.l)}, outside the ${mode} mark band ${config.minLightness}-${config.maxLightness}.`,
      );
    }

    if (color.oklch.c < 0.04) {
      warnings.push(
        `${color.value} has low OKLCH chroma ${format(color.oklch.c)} and may read as gray.`,
      );
    }

    const contrast = contrastRatio(color.rgb, config.surface);
    if (contrast < config.minContrast) {
      failures.push(
        `${color.value} contrast ${format(contrast)} is below ${config.minContrast}:1 against the ${mode} chart surface.`,
      );
    }
  }

  for (const [kind, matrix] of Object.entries(CVD_MATRICES)) {
    const simulated = colors.map((color) => ({
      value: color.value,
      lab: rgbToLab(applyMatrix(color.rgb, matrix)),
    }));

    for (let i = 0; i < simulated.length; i++) {
      for (let j = i + 1; j < simulated.length; j++) {
        const distance = labDistance(simulated[i].lab, simulated[j].lab);
        if (distance < 40) {
          warnings.push(
            `${simulated[i].value} and ${simulated[j].value} are close under colorblind ${kind} simulation (DeltaE ${format(distance)}); add secondary encoding such as labels, shape, or texture.`,
          );
        }
      }
    }
  }

  return {
    status:
      failures.length > 0 ? 'FAIL' : warnings.length > 0 ? 'WARN' : 'PASS',
    failures,
    warnings,
  };
}

function parseHexColor(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(hex);
  if (short) {
    return short[1].split('').map((part) => parseInt(part + part, 16));
  }
  const long = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!long) return null;
  return [0, 2, 4].map((offset) =>
    parseInt(long[1].slice(offset, offset + 2), 16),
  );
}

function normalizeHex(value) {
  const rgb = parseHexColor(value);
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function applyMatrix(rgb, matrix) {
  const linear = rgb.map(srgbChannelToLinear);
  return matrix
    .map((row) => row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2])
    .map(linearChannelToSrgb);
}

function contrastRatio(left, right) {
  const l1 = relativeLuminance(left);
  const l2 = relativeLuminance(right);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map(srgbChannelToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgbToLab(rgb) {
  const [x, y, z] = rgbToXyz(rgb);
  const xn = 0.95047;
  const yn = 1;
  const zn = 1.08883;
  const fx = labPivot(x / xn);
  const fy = labPivot(y / yn);
  const fz = labPivot(z / zn);
  return {
    l: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

function rgbToXyz(rgb) {
  const [r, g, b] = rgb.map(srgbChannelToLinear);
  return [
    r * 0.4124564 + g * 0.3575761 + b * 0.1804375,
    r * 0.2126729 + g * 0.7151522 + b * 0.072175,
    r * 0.0193339 + g * 0.119192 + b * 0.9503041,
  ];
}

function labPivot(value) {
  return value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
}

function rgbToOklch(rgb) {
  const [r, g, b] = rgb.map(srgbChannelToLinear);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const okL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const okA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const okB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  return {
    l: okL,
    c: Math.sqrt(okA * okA + okB * okB),
  };
}

function srgbChannelToLinear(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearChannelToSrgb(channel) {
  const value = Math.max(0, Math.min(1, channel));
  const encoded =
    value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

function labDistance(left, right) {
  return Math.sqrt(
    (left.l - right.l) ** 2 + (left.a - right.a) ** 2 + (left.b - right.b) ** 2,
  );
}

function format(value) {
  return Number(value.toFixed(2)).toString();
}

function parseArgs(argv) {
  const args = [...argv];
  const palette = args.shift();
  let mode = 'light';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode') {
      mode = args[i + 1] ?? mode;
      i++;
    }
  }
  return { palette, mode };
}

function printResult(result) {
  process.stdout.write(`${result.status}\n`);
  for (const failure of result.failures) {
    process.stdout.write(`FAIL: ${failure}\n`);
  }
  for (const warning of result.warnings) {
    process.stdout.write(`WARN: ${warning}\n`);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const { palette, mode } = parseArgs(process.argv.slice(2));
  if (!palette) {
    process.stderr.write(
      "Usage: node validate_palette.js '#2563eb,#d97706,#4d7c0f' --mode light\n",
    );
    process.exit(2);
  }
  const result = validatePalette(
    palette
      .split(',')
      .map((color) => color.trim())
      .filter(Boolean),
    { mode },
  );
  printResult(result);
  process.exit(result.status === 'FAIL' ? 1 : 0);
}
