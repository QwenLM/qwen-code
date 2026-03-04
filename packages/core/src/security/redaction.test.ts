/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { RedactionManager } from './redaction.js';
import type { Content } from '@google/genai';

const asContents = (text: string): Content[] => [
  {
    role: 'user',
    parts: [{ text }],
  },
];

describe('redaction', () => {
  it('redacts configured keywords and restores placeholders', () => {
    const manager = new RedactionManager({
      enabled: true,
      keywords: { 'example-secret-123': 'API_KEY' },
    });

    const redacted = manager.redactContents(
      asContents('key=example-secret-123'),
    );
    const redactedText = (redacted as Content[])[0].parts?.[0].text ?? '';

    expect(redactedText).not.toContain('example-secret-123');
    expect(redactedText).toMatch(/__VG_API_KEY_[a-f0-9]{12}(?:_\\d+)?__/);

    const restored = manager.restoreString(redactedText);
    expect(restored).toContain('example-secret-123');
  });

  it('supports built-in patterns with capture groups (china_phone)', () => {
    const manager = new RedactionManager({
      enabled: true,
      builtins: ['china_phone'],
    });

    const redacted = manager.redactContents(asContents('a13800138000b'));
    const text = (redacted as Content[])[0].parts?.[0].text ?? '';

    expect(text).toMatch(/^a__VG_CHINA_PHONE_[a-f0-9]{12}(?:_\\d+)?__b$/);
  });

  it('restores placeholders across chunk boundaries (stream)', () => {
    const manager = new RedactionManager({
      enabled: true,
      keywords: { 'example-secret-123': 'API_KEY' },
    });

    const redacted = manager.redactContents(asContents('example-secret-123'));
    const placeholder = (
      (redacted as Content[])[0].parts?.[0].text ?? ''
    ).trim();

    expect(placeholder).toMatch(/__VG_API_KEY_[a-f0-9]{12}(?:_\\d+)?__/);

    const restorer = manager.createStreamRestorer();
    expect(restorer.feed('hello ')).toBe('hello ');
    expect(restorer.feed(placeholder.slice(0, 5))).toBe('');
    expect(restorer.feed(placeholder.slice(5))).toBe('example-secret-123');
    expect(restorer.flush()).toBe('');
  });

  it('redacts functionCall args but never mutates tool names', () => {
    const manager = new RedactionManager({
      enabled: true,
      keywords: { 'example-secret-123': 'API_KEY' },
    });

    const contents: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'write_file',
              args: {
                path: 'example-secret-123',
                content: 'example-secret-123',
              },
            },
          },
        ],
      },
    ];

    const redacted = manager.redactContents(contents) as Content[];
    const fn = redacted[0].parts?.[0].functionCall;

    expect(fn?.name).toBe('write_file');
    expect((fn?.args as { path?: string })?.path).toMatch(
      /__VG_API_KEY_[a-f0-9]{12}(?:_\\d+)?__/,
    );
  });
});
