/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  imageDimensionsForTokenBudget,
  IMAGE_TOKEN_BUDGET_TIERS,
  OMNI_PATCH_GRID_FACTOR,
  pixelsPerToken,
  smartResize,
  tokenBudgetToPixels,
  VIDEO_FRAME_TOKEN_BUDGET_TIERS,
  videoFrameDimensionsForTokenBudget,
} from './smart-resize.js';

describe('smart-resize', () => {
  it('defaults to the 28px patch grid (Qwen-VL family)', () => {
    expect(OMNI_PATCH_GRID_FACTOR).toBe(28);
    expect(pixelsPerToken()).toBe(784);
  });

  it('maps budget tiers to pixel budgets via tokens × factor²', () => {
    expect(tokenBudgetToPixels('small', IMAGE_TOKEN_BUDGET_TIERS)).toBe(
      256 * 784,
    );
    expect(tokenBudgetToPixels('normal', IMAGE_TOKEN_BUDGET_TIERS)).toBe(
      1024 * 784,
    );
    expect(tokenBudgetToPixels('large', VIDEO_FRAME_TOKEN_BUDGET_TIERS)).toBe(
      1024 * 784,
    );
  });

  it('snaps both dimensions to multiples of the grid factor', () => {
    const { width, height } = smartResize(1000, 700, { maxPixels: 512 * 784 });
    expect(width % 28).toBe(0);
    expect(height % 28).toBe(0);
    expect(width * height).toBeLessThanOrEqual(512 * 784 + 28 * 28);
  });

  it('downscales into the pixel budget, preserving aspect ratio on the grid', () => {
    const { width, height } = smartResize(4000, 2000, { maxPixels: 256 * 784 });
    expect(width * height).toBeLessThanOrEqual(256 * 784 + 28 * 28);
    // 2:1 aspect survives the grid rounding within one cell.
    expect(width / height).toBeGreaterThan(1.8);
    expect(width / height).toBeLessThan(2.2);
  });

  it('upsamples tiny images onto the grid (minPixels floor)', () => {
    const { width, height } = smartResize(20, 20, {
      minPixels: 256 * 784,
      maxPixels: 1024 * 784,
    });
    expect(width * height).toBeGreaterThanOrEqual(256 * 784 - 28 * 28 * 2);
    expect(width % 28).toBe(0);
    expect(height % 28).toBe(0);
  });

  it('keeps in-budget images near their native size, grid-snapped', () => {
    const { width, height } = smartResize(500, 400, {
      minPixels: 0,
      maxPixels: 1024 * 784,
    });
    expect(Math.abs(width - 500)).toBeLessThanOrEqual(28);
    expect(Math.abs(height - 400)).toBeLessThanOrEqual(28);
  });

  it('never emits a dimension below one grid cell', () => {
    const { width, height } = smartResize(1, 1, { maxPixels: 10 });
    expect(width).toBeGreaterThanOrEqual(28);
    expect(height).toBeGreaterThanOrEqual(28);
  });

  it('clamps a degenerate min>max configuration instead of oscillating', () => {
    const { width, height } = smartResize(100, 100, {
      minPixels: 1000 * 784,
      maxPixels: 10 * 784,
    });
    expect(width % 28).toBe(0);
    expect(height % 28).toBe(0);
  });

  it('imageDimensionsForTokenBudget lands the large tier at ~2048 tokens', () => {
    const { width, height, budgetPixels } = imageDimensionsForTokenBudget(
      8000,
      6000,
      'large',
    );
    expect(budgetPixels).toBe(2048 * 784);
    expect((width * height) / 784).toBeLessThanOrEqual(2048 + 2);
    expect(width % 28).toBe(0);
    expect(height % 28).toBe(0);
  });

  it('videoFrameDimensionsForTokenBudget applies the smaller video tiers', () => {
    const { width, height, budgetPixels } = videoFrameDimensionsForTokenBudget(
      1920,
      1080,
      'small',
    );
    expect(budgetPixels).toBe(80 * 784);
    // Grid rounding (16:9 → 308×168) may land a few cells above the exact
    // budget — the contract is "on the grid, near the budget", not "never
    // a cell over".
    expect((width * height) / 784).toBeLessThanOrEqual(80 + 8);
    expect(width % 28).toBe(0);
    expect(height % 28).toBe(0);
  });
});
