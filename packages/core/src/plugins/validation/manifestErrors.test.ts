/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { formatZodIssues } from './manifestErrors.js';

const relativePath = z.string().refine((path) => path.startsWith('./'), {
  message: 'Path must start with ./',
});

describe('formatZodIssues', () => {
  it('compacts repeated array issues into precise index ranges', () => {
    const result = z
      .object({
        commands: z.array(relativePath),
        skills: z.array(relativePath),
      })
      .safeParse({
        commands: ['commands/review.md'],
        skills: Array.from({ length: 10 }, (_, i) => `skills/skill-${i}`),
      });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(formatZodIssues(result.error)).toBe(
      'commands[0]: Path must start with ./; skills[0-9]: Path must start with ./',
    );
  });

  it('preserves non-array issue paths', () => {
    const result = z.object({ name: z.string() }).safeParse({ name: 42 });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(formatZodIssues(result.error)).toContain('name:');
  });

  it('preserves the position of grouped array issues', () => {
    const result = z
      .object({
        commands: z.array(relativePath),
        name: z.string(),
        skills: z.array(relativePath),
      })
      .safeParse({
        commands: ['commands/review.md'],
        name: 42,
        skills: ['skills/reviewer'],
      });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(formatZodIssues(result.error)).toMatch(
      /^commands\[0\]: Path must start with \.\/; name: .*; skills\[0\]: Path must start with \.\//,
    );
  });
});
