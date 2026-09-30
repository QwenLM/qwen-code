/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Override } from './override.js';

describe('Override', () => {
  it('should create an override from input', () => {
    const override = Override.fromInput('/path/to/dir', true);
    expect(override.baseRule).toBe(`/path/to/dir/`);
    expect(override.isDisable).toBe(false);
    expect(override.includeSubdirs).toBe(true);
  });

  it('should create a disable override from input', () => {
    const override = Override.fromInput('!/path/to/dir', false);
    expect(override.baseRule).toBe(`/path/to/dir/`);
    expect(override.isDisable).toBe(true);
    expect(override.includeSubdirs).toBe(false);
  });

  it('should create an override from a file rule', () => {
    const override = Override.fromFileRule('/path/to/dir');
    expect(override.baseRule).toBe('/path/to/dir');
    expect(override.isDisable).toBe(false);
    expect(override.includeSubdirs).toBe(false);
  });

  it('should create a disable override from a file rule', () => {
    const override = Override.fromFileRule('!/path/to/dir/');
    expect(override.isDisable).toBe(true);
    expect(override.baseRule).toBe('/path/to/dir/');
    expect(override.includeSubdirs).toBe(false);
  });

  it('should create an override with subdirs from a file rule', () => {
    const override = Override.fromFileRule('/path/to/dir/*');
    expect(override.baseRule).toBe('/path/to/dir/');
    expect(override.isDisable).toBe(false);
    expect(override.includeSubdirs).toBe(true);
  });

  it('should correctly identify conflicting overrides', () => {
    const override1 = Override.fromInput('/path/to/dir', true);
    const override2 = Override.fromInput('/path/to/dir', false);
    expect(override1.conflictsWith(override2)).toBe(true);
  });

  it('should correctly identify non-conflicting overrides', () => {
    const override1 = Override.fromInput('/path/to/dir', true);
    const override2 = Override.fromInput('/path/to/another/dir', true);
    expect(override1.conflictsWith(override2)).toBe(false);
  });

  it('should correctly identify equal overrides', () => {
    const override1 = Override.fromInput('/path/to/dir', true);
    const override2 = Override.fromInput('/path/to/dir', true);
    expect(override1.isEqualTo(override2)).toBe(true);
  });

  it('should correctly identify unequal overrides', () => {
    const override1 = Override.fromInput('/path/to/dir', true);
    const override2 = Override.fromInput('!/path/to/dir', true);
    expect(override1.isEqualTo(override2)).toBe(false);
  });

  it('should generate the correct regex', () => {
    const override = Override.fromInput('/path/to/dir', true);
    const regex = override.asRegex();
    expect(regex.test('/path/to/dir/')).toBe(true);
    expect(regex.test('/path/to/dir/subdir')).toBe(true);
    expect(regex.test('/path/to/another/dir')).toBe(false);
  });

  it('should correctly identify child overrides', () => {
    const parent = Override.fromInput('/path/to/dir', true);
    const child = Override.fromInput('/path/to/dir/subdir', false);
    expect(child.isChildOf(parent)).toBe(true);
  });

  it('should correctly identify child overrides with glob', () => {
    const parent = Override.fromInput('/path/to/dir/*', true);
    const child = Override.fromInput('/path/to/dir/subdir', false);
    expect(child.isChildOf(parent)).toBe(true);
  });

  it('should correctly identify non-child overrides', () => {
    const parent = Override.fromInput('/path/to/dir', true);
    const other = Override.fromInput('/path/to/another/dir', false);
    expect(other.isChildOf(parent)).toBe(false);
  });

  it('should generate the correct output string', () => {
    const override = Override.fromInput('/path/to/dir', true);
    expect(override.output()).toBe(`/path/to/dir/*`);
  });

  it('should generate the correct output string for a disable override', () => {
    const override = Override.fromInput('!/path/to/dir', false);
    expect(override.output()).toBe(`!/path/to/dir/`);
  });

  it('should disable a path based on a disable override rule', () => {
    const override = Override.fromInput('!/path/to/dir', false);
    expect(override.output()).toBe(`!/path/to/dir/`);
  });
});
