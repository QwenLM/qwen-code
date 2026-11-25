/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { load } from 'js-yaml';
import { yamlRepair, repairYamlFrontmatter } from './yaml-repair.js';

describe('yamlRepair', () => {
  // ---- Normal YAML (no change needed) ----
  it('preserves valid YAML', () => {
    const yaml = 'name: test\ndescription: hello world';
    expect(yamlRepair(yaml)).toBe(yaml);
  });

  // ---- Tab → space normalization ----
  it('converts tab indentation to spaces', () => {
    const yaml = 'name: test\n\tchild: value';
    const repaired = yamlRepair(yaml);
    expect(repaired).not.toContain('\t');
    expect(repaired).toContain('  child: value');
  });

  // ---- Value with colon-space ----
  it('quotes values containing colon-space', () => {
    const yaml = 'description: this: has a colon';
    const repaired = yamlRepair(yaml);
    const parsed = load(repaired) as Record<string, unknown>;
    expect(parsed['description']).toBe('this: has a colon');
  });

  // ---- Value with hash ----
  it('quotes values containing hash', () => {
    const yaml = 'description: hello #world';
    const repaired = yamlRepair(yaml);
    const parsed = load(repaired) as Record<string, unknown>;
    expect(parsed['description']).toBe('hello #world');
  });

  // ---- Value starting with special character ----
  it('quotes values starting with special characters', () => {
    const yaml = 'value: {not a mapping}';
    const repaired = yamlRepair(yaml);
    const parsed = load(repaired) as Record<string, unknown>;
    expect(parsed['value']).toBe('{not a mapping}');
  });

  // ---- Already quoted values ----
  it('does not double-quote already quoted values', () => {
    const yaml = 'name: "already quoted"';
    expect(yamlRepair(yaml)).toBe(yaml);
  });

  it('does not double-quote single-quoted values', () => {
    const yaml = "name: 'already quoted'";
    expect(yamlRepair(yaml)).toBe(yaml);
  });

  // ---- Multiline block scalar → collapsed to quoted string ----
  it('collapses multiline block scalar to quoted string', () => {
    const yaml = 'description: |\n  line one\n  line two';
    const repaired = yamlRepair(yaml);
    const parsed = load(repaired) as Record<string, unknown>;
    expect(parsed['description']).toContain('line one');
    expect(parsed['description']).toContain('line two');
  });

  // ---- Trailing whitespace ----
  it('strips trailing whitespace', () => {
    const yaml = 'name: test   \ndescription: hello   ';
    const repaired = yamlRepair(yaml);
    expect(repaired).toBe('name: test\ndescription: hello');
  });

  // ---- Comment preservation ----
  it('preserves comments', () => {
    const yaml = '# This is a comment\nname: test';
    expect(yamlRepair(yaml)).toBe(yaml);
  });

  // ---- Colon at end of value ----
  it('quotes values ending with colon', () => {
    const yaml = 'status: pending:';
    const repaired = yamlRepair(yaml);
    const parsed = load(repaired) as Record<string, unknown>;
    expect(parsed['status']).toBe('pending:');
  });
});

describe('repairYamlFrontmatter', () => {
  it('repairs frontmatter content', () => {
    const yaml = 'description: this: needs repair';
    const repaired = repairYamlFrontmatter(yaml);
    const parsed = load(repaired) as Record<string, unknown>;
    expect(parsed['description']).toBe('this: needs repair');
  });
});
