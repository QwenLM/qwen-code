/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  VERDICT_TOOL_NAME,
  buildReportVerdictFunctionDeclaration,
} from './reportVerdictTool.js';

describe('reportVerdictTool', () => {
  describe('VERDICT_TOOL_NAME', () => {
    it('should be "report_verdict"', () => {
      expect(VERDICT_TOOL_NAME).toBe('report_verdict');
    });
  });

  describe('buildReportVerdictFunctionDeclaration', () => {
    it('should return a FunctionDeclaration with the correct name', () => {
      const declaration = buildReportVerdictFunctionDeclaration();
      expect(declaration.name).toBe('report_verdict');
    });

    it('should have a non-empty description', () => {
      const declaration = buildReportVerdictFunctionDeclaration();
      expect(declaration.description).toBeTruthy();
      expect(declaration.description!.length).toBeGreaterThan(10);
    });

    it('should use parametersJsonSchema with object type', () => {
      const declaration = buildReportVerdictFunctionDeclaration();
      const schema = declaration.parametersJsonSchema as Record<
        string,
        unknown
      >;
      expect(schema).toBeDefined();
      expect(schema['type']).toBe('object');
    });

    it('should define ok as a required boolean property', () => {
      const declaration = buildReportVerdictFunctionDeclaration();
      const schema = declaration.parametersJsonSchema as Record<
        string,
        unknown
      >;
      const properties = schema['properties'] as Record<
        string,
        Record<string, unknown>
      >;
      expect(properties['ok']).toBeDefined();
      expect(properties['ok']['type']).toBe('boolean');
      expect(schema['required']).toContain('ok');
    });

    it('should define reason as an optional string property', () => {
      const declaration = buildReportVerdictFunctionDeclaration();
      const schema = declaration.parametersJsonSchema as Record<
        string,
        unknown
      >;
      const properties = schema['properties'] as Record<
        string,
        Record<string, unknown>
      >;
      expect(properties['reason']).toBeDefined();
      expect(properties['reason']['type']).toBe('string');
      expect(schema['required']).not.toContain('reason');
    });

    it('should disallow additional properties', () => {
      const declaration = buildReportVerdictFunctionDeclaration();
      const schema = declaration.parametersJsonSchema as Record<
        string,
        unknown
      >;
      expect(schema['additionalProperties']).toBe(false);
    });

    it('should return a new object each time', () => {
      const first = buildReportVerdictFunctionDeclaration();
      const second = buildReportVerdictFunctionDeclaration();
      expect(first).not.toBe(second);
      expect(first).toEqual(second);
    });
  });
});
