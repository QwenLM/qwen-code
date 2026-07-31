/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for toolcall utility functions
 */

import { describe, it, expect } from 'vitest';
import { extractCommandOutput, formatValue } from './utils.js';

describe('extractCommandOutput', () => {
  it('should extract output from JSON format', () => {
    const input = JSON.stringify({ output: 'Hello World' });
    expect(extractCommandOutput(input)).toBe('Hello World');
  });

  it('should handle uppercase Output in JSON', () => {
    const input = JSON.stringify({ Output: 'Test Output' });
    expect(extractCommandOutput(input)).toBe('Test Output');
  });

  it('should extract output from structured text format', () => {
    const input = `Command: lsof -i :5173
Directory: (root)
Output: COMMAND   PID    USER   FD   TYPE
node    59117 jinjing   17u  IPv6
Error: (none)
Exit Code: 0`;

    const output = extractCommandOutput(input);
    expect(output).toContain('COMMAND   PID    USER');
    expect(output).toContain('node    59117 jinjing');
    expect(output).not.toContain('Command:');
    expect(output).not.toContain('Error:');
  });

  it('should handle multiline output correctly', () => {
    const input = `Command: ps aux
Directory: /home/user
Output: USER       PID %CPU %MEM
root         1  0.0  0.1
user      1234  1.5  2.3
Error: (none)
Exit Code: 0`;

    const output = extractCommandOutput(input);
    expect(output).toContain('USER       PID %CPU %MEM');
    expect(output).toContain('root         1');
    expect(output).toContain('user      1234');
  });

  it('should skip (none) output', () => {
    const input = `Command: test
Output: (none)
Error: (none)`;

    const output = extractCommandOutput(input);
    expect(output).toBe(input); // Should return original if output is (none)
  });

  it('should return original text if no structured format found', () => {
    const input = 'Just some random text';
    expect(extractCommandOutput(input)).toBe(input);
  });

  it('should handle empty output gracefully', () => {
    const input = `Command: test
Output: 
Error: (none)`;

    const output = extractCommandOutput(input);
    // Should return original since output is empty
    expect(output).toBe(input);
  });

  it('should extract from regex match when Output: is present', () => {
    const input = `Some text before
Output: This is the output
Error: Some error`;

    expect(extractCommandOutput(input)).toBe('This is the output');
  });

  it('should handle JSON objects in output field', () => {
    const input = JSON.stringify({
      output: { key: 'value', nested: { data: 'test' } },
    });

    const output = extractCommandOutput(input);
    expect(output).toContain('"key"');
    expect(output).toContain('"value"');
  });
});

describe('formatValue', () => {
  it('should return empty string for null or undefined', () => {
    expect(formatValue(null)).toBe('');
    expect(formatValue(undefined)).toBe('');
  });

  it('should extract output from string using extractCommandOutput', () => {
    const input = `Command: test
Output: Hello World
Error: (none)`;

    const output = formatValue(input);
    expect(output).toContain('Hello World');
  });

  it('should handle Error objects', () => {
    const error = new Error('Test error message');
    expect(formatValue(error)).toBe('Test error message');
  });

  it('should handle error-like objects', () => {
    const errorObj = { message: 'Custom error', stack: 'stack trace' };
    expect(formatValue(errorObj)).toBe('Custom error');
  });

  it('should stringify objects', () => {
    const obj = { key: 'value', number: 42 };
    const output = formatValue(obj);
    expect(output).toContain('"key"');
    expect(output).toContain('"value"');
    expect(output).toContain('42');
  });

  it('should convert primitives to string', () => {
    expect(formatValue(123)).toBe('123');
    expect(formatValue(true)).toBe('true');
    expect(formatValue(false)).toBe('false');
  });
});
