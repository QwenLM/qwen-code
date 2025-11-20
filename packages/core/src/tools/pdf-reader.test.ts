/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { PDFReaderTool } from './pdf-reader.js';
import { makeFakeConfig } from '../test-utils/config.js';
import type { Config } from '../config/config.js';

describe('PDFReaderTool', () => {
  let config: Config;

  beforeEach(() => {
    config = makeFakeConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should have the correct name', () => {
    const tool = new PDFReaderTool(config);
    expect(tool.name).toBe('pdf_reader');
  });

  it('should have the correct display name', () => {
    const tool = new PDFReaderTool(config);
    expect(tool.displayName).toBe('PDFReader');
  });

  it('should validate required file_path parameter', () => {
    const tool = new PDFReaderTool(config);

    // Test undefined parameter - validation happens at the schema level first
    expect(tool.validateToolParams({})).not.toBeNull(); // Should return an error message

    // Test empty string parameter
    expect(tool.validateToolParams({ file_path: '' })).not.toBeNull(); // Should return an error message

    // Test non-string parameter
    expect(tool.validateToolParams({ file_path: 123 })).not.toBeNull(); // Should return an error message
  });

  it('should validate absolute path requirement', () => {
    const tool = new PDFReaderTool(config);

    // Test relative path
    expect(tool.validateToolParams({ file_path: 'document.pdf' })).toContain(
      'must be absolute',
    );
  });

  it('should validate PDF file extension', () => {
    const tool = new PDFReaderTool(config);

    // Test non-PDF file
    const fakePath = path.join(config.getTargetDir(), 'document.txt');
    expect(tool.validateToolParams({ file_path: fakePath })).toContain(
      'must be a PDF file',
    );
  });

  it('should return error for relative path in validation', () => {
    const tool = new PDFReaderTool(config);

    // Test relative path
    const result = tool.validateToolParams({ file_path: 'document.pdf' });
    expect(result).not.toBeNull(); // Should return an error message about absolute path
  });

  it('should pass validation for valid PDF file path', () => {
    const tool = new PDFReaderTool(config);

    const validPath = path.join(config.getTargetDir(), 'document.pdf');
    expect(tool.validateToolParams({ file_path: validPath })).toBeNull();
  });

  it('should handle invalid parameters and return error', () => {
    const tool = new PDFReaderTool(config);
    // Just test the validation part
    const result = tool.validateToolParams({} as Record<string, unknown>);

    expect(result).not.toBeNull(); // Should return an error message
  });
});
