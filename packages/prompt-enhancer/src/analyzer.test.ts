/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { PromptAnalyzer } from './analyzer.js';

describe('PromptAnalyzer', () => {
  const analyzer = new PromptAnalyzer();

  describe('analyze', () => {
    it('should detect code-creation intent', () => {
      const result = analyzer.analyze(
        'Create a new function to handle user authentication',
      );
      expect(result.intent).toBe('code-creation');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should detect bug-fix intent', () => {
      const result = analyzer.analyze('Fix the login bug in auth.ts');
      expect(result.intent).toBe('bug-fix');
    });

    it('should detect review intent', () => {
      const result = analyzer.analyze(
        'Review this pull request for security issues',
      );
      expect(result.intent).toBe('review');
    });

    it('should detect ask intent for questions', () => {
      const result = analyzer.analyze('How do I use React hooks?');
      expect(result.intent).toBe('ask');
    });

    it('should detect unknown intent for vague prompts', () => {
      const result = analyzer.analyze('stuff');
      expect(result.intent).toBe('unknown');
    });
  });

  describe('specificity scoring', () => {
    it('should give low score for vague prompts', () => {
      const result = analyzer.analyze('fix it');
      expect(result.specificity).toBeLessThan(5);
    });

    it('should give higher score for specific prompts with file paths', () => {
      const result = analyzer.analyze(
        'Fix the bug in /src/auth/login.ts on line 42',
      );
      expect(result.specificity).toBeGreaterThan(5);
    });

    it('should give bonus for code snippets', () => {
      const result = analyzer.analyze('Fix this: `console.log("test")`');
      expect(result.specificity).toBeGreaterThan(2);
    });
  });

  describe('gap detection', () => {
    it('should identify missing file paths', () => {
      const result = analyzer.analyze('Create a component');
      expect(result.gaps).toContain('No file paths specified');
    });

    it('should identify missing context', () => {
      const result = analyzer.analyze('Fix the bug');
      expect(result.gaps).toContain('No project context provided');
    });

    it('should identify missing constraints', () => {
      const result = analyzer.analyze('Add feature');
      expect(result.gaps).toContain('No constraints or requirements specified');
    });

    it('should identify missing success criteria', () => {
      const result = analyzer.analyze('Do something');
      expect(result.gaps).toContain('No success criteria defined');
    });
  });

  describe('suggestions', () => {
    it('should provide suggestions for improvement', () => {
      const result = analyzer.analyze('fix bug');
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it('should suggest adding file paths for code creation', () => {
      const result = analyzer.analyze('Create component');
      expect(result.suggestions).toContain(
        'Specify the file path(s) where changes should be made',
      );
    });
  });

  describe('context detection', () => {
    it('should detect when context is provided', () => {
      const result = analyzer.analyze('In my project, we are using React');
      expect(result.hasContext).toBe(true);
    });

    it('should detect when context is missing', () => {
      const result = analyzer.analyze('Create function');
      expect(result.hasContext).toBe(false);
    });
  });

  describe('constraints detection', () => {
    it('should detect when constraints are provided', () => {
      const result = analyzer.analyze('Create function without using lodash');
      expect(result.hasConstraints).toBe(true);
    });

    it('should detect when constraints are missing', () => {
      const result = analyzer.analyze('Add feature');
      expect(result.hasConstraints).toBe(false);
    });
  });

  describe('success criteria detection', () => {
    it('should detect when success criteria are provided', () => {
      const result = analyzer.analyze('Fix bug so that login works correctly');
      expect(result.hasSuccessCriteria).toBe(true);
    });

    it('should detect when success criteria are missing', () => {
      const result = analyzer.analyze('Fix bug');
      expect(result.hasSuccessCriteria).toBe(false);
    });
  });
});
