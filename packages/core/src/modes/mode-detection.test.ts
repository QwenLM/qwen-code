/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ModeDetector } from './mode-detection.js';

describe('ModeDetector', () => {
  let detector: ModeDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    detector = new ModeDetector();
  });

  describe('detect', () => {
    it('should suggest tester mode for "write tests" input', () => {
      const suggestions = detector.detect(
        'I need to write tests for the user service',
      );

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].mode).toBe('tester');
      expect(suggestions[0].confidence).toBe(0.9);
      expect(suggestions[0].reason).toContain('testing');
    });

    it('should suggest reviewer mode for "review this code" input', () => {
      const suggestions = detector.detect('Please review this code for issues');

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].mode).toBe('reviewer');
      expect(suggestions[0].confidence).toBe(0.9);
      expect(suggestions[0].reason).toContain('review');
    });

    it('should suggest debugger mode for "fix the bug" input', () => {
      const suggestions = detector.detect(
        'I need to fix the bug in the login flow',
      );

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].mode).toBe('debugger');
      expect(suggestions[0].confidence).toBe(0.9);
      expect(suggestions[0].reason).toContain('debug');
    });

    it('should suggest optimizer mode for "optimize performance" input', () => {
      const suggestions = detector.detect(
        'We need to optimize performance of the API',
      );

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].mode).toBe('optimizer');
      expect(suggestions[0].confidence).toBe(0.8);
      expect(suggestions[0].reason).toContain('optimization');
    });

    it('should suggest security mode for "security vulnerability" input', () => {
      const suggestions = detector.detect(
        'There is a security vulnerability in the auth module',
      );

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].mode).toBe('security');
      expect(suggestions[0].confidence).toBe(0.8);
      expect(suggestions[0].reason).toContain('security');
    });

    it('should suggest devops mode for "deploy to production" input', () => {
      const suggestions = detector.detect(
        'Deploy the Docker container to production',
      );

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].mode).toBe('devops');
      expect(suggestions[0].confidence).toBe(0.8);
    });

    it('should suggest architect mode for "design the architecture" input', () => {
      const suggestions = detector.detect(
        'Help me design the system architecture',
      );

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].mode).toBe('architect');
      expect(suggestions[0].confidence).toBe(0.8);
    });

    it('should suggest developer mode for "implement a feature" input', () => {
      const suggestions = detector.detect(
        'Implement a new feature for the application',
      );

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].mode).toBe('developer');
      expect(suggestions[0].confidence).toBe(0.7);
    });

    it('should suggest product mode for "user story" input', () => {
      const suggestions = detector.detect(
        'Write a user story for the checkout flow',
      );

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].mode).toBe('product');
      expect(suggestions[0].confidence).toBe(0.7);
    });

    it('should return multiple suggestions when input matches multiple rules', () => {
      const suggestions = detector.detect(
        'Review and fix bugs in the test suite',
      );

      const modes = suggestions.map((s) => s.mode);
      expect(modes).toContain('reviewer');
      expect(modes).toContain('debugger');
      expect(modes).toContain('tester');
    });

    it('should sort suggestions by confidence descending', () => {
      const suggestions = detector.detect(
        'Review the code, fix bugs, and optimize performance',
      );

      for (let i = 1; i < suggestions.length; i++) {
        expect(suggestions[i].confidence).toBeLessThanOrEqual(
          suggestions[i - 1].confidence,
        );
      }
    });

    it('should return empty array for empty input', () => {
      expect(detector.detect('')).toEqual([]);
      expect(detector.detect('   ')).toEqual([]);
    });

    it('should match patterns case-insensitively', () => {
      const suggestions1 = detector.detect('Write TESTS for the module');
      const suggestions2 = detector.detect('write tests for the module');

      expect(suggestions1[0].mode).toBe(suggestions2[0].mode);
      expect(suggestions1[0].confidence).toBe(suggestions2[0].confidence);
    });

    it('should detect mode for "crash" keyword', () => {
      const suggestions = detector.detect('The application crashes on startup');

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].mode).toBe('debugger');
    });

    it('should detect mode for "sql injection" keyword', () => {
      const suggestions = detector.detect(
        'Check for sql injection vulnerabilities',
      );

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].mode).toBe('security');
    });

    it('should detect mode for "kubernetes" keyword', () => {
      const suggestions = detector.detect('Deploy the service to kubernetes');

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].mode).toBe('devops');
    });

    it('should detect mode for "acceptance criteria" keyword', () => {
      const suggestions = detector.detect(
        'Define acceptance criteria for the feature',
      );

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].mode).toBe('product');
    });
  });

  describe('detectFromFiles', () => {
    it('should suggest tester mode for test file paths', () => {
      const suggestions = detector.detectFromFiles([
        'src/utils.test.ts',
        'src/services/auth.spec.js',
      ]);

      expect(suggestions.length).toBeGreaterThan(0);
      const testerSuggestion = suggestions.find((s) => s.mode === 'tester');
      expect(testerSuggestion).toBeDefined();
      expect(testerSuggestion?.confidence).toBe(0.9);
    });

    it('should suggest devops mode for Dockerfile', () => {
      const suggestions = detector.detectFromFiles([
        'Dockerfile',
        'docker-compose.yml',
      ]);

      expect(suggestions.length).toBeGreaterThan(0);
      const devopsSuggestion = suggestions.find((s) => s.mode === 'devops');
      expect(devopsSuggestion).toBeDefined();
      expect(devopsSuggestion?.confidence).toBe(0.85);
    });

    it('should suggest devops mode for CI/CD configs', () => {
      const suggestions = detector.detectFromFiles([
        '.github/workflows/ci.yml',
      ]);

      expect(suggestions.length).toBeGreaterThan(0);
      const devopsSuggestion = suggestions.find((s) => s.mode === 'devops');
      expect(devopsSuggestion).toBeDefined();
      expect(devopsSuggestion?.confidence).toBe(0.85);
    });

    it('should suggest security mode for security-related files', () => {
      const suggestions = detector.detectFromFiles([
        '.env',
        'src/auth/security.ts',
      ]);

      expect(suggestions.length).toBeGreaterThan(0);
      const securitySuggestion = suggestions.find((s) => s.mode === 'security');
      expect(securitySuggestion).toBeDefined();
      expect(securitySuggestion?.confidence).toBe(0.75);
    });

    it('should suggest architect mode for architecture docs', () => {
      const suggestions = detector.detectFromFiles([
        'docs/architecture/overview.md',
      ]);

      expect(suggestions.length).toBeGreaterThan(0);
      const architectSuggestion = suggestions.find(
        (s) => s.mode === 'architect',
      );
      expect(architectSuggestion).toBeDefined();
      expect(architectSuggestion?.confidence).toBe(0.8);
    });

    it('should suggest product mode for documentation files', () => {
      const suggestions = detector.detectFromFiles(['docs/requirements.md']);

      expect(suggestions.length).toBeGreaterThan(0);
      const productSuggestion = suggestions.find((s) => s.mode === 'product');
      expect(productSuggestion).toBeDefined();
      expect(productSuggestion?.confidence).toBe(0.7);
    });

    it('should return multiple suggestions from diverse files', () => {
      const suggestions = detector.detectFromFiles([
        'src/app.test.ts',
        'Dockerfile',
        '.env',
      ]);

      const modes = suggestions.map((s) => s.mode);
      expect(modes).toContain('tester');
      expect(modes).toContain('devops');
      expect(modes).toContain('security');
    });

    it('should sort file-based suggestions by confidence descending', () => {
      const suggestions = detector.detectFromFiles([
        'src/app.test.ts',
        'Dockerfile',
        '.env',
      ]);

      for (let i = 1; i < suggestions.length; i++) {
        expect(suggestions[i].confidence).toBeLessThanOrEqual(
          suggestions[i - 1].confidence,
        );
      }
    });

    it('should return empty array for empty file list', () => {
      expect(detector.detectFromFiles([])).toEqual([]);
    });

    it('should return empty array for null/undefined file list', () => {
      expect(detector.detectFromFiles([])).toEqual([]);
    });

    it('should not duplicate suggestions for same mode from multiple files', () => {
      const suggestions = detector.detectFromFiles([
        'src/app.test.ts',
        'src/utils.spec.ts',
        'src/services/auth.test.js',
      ]);

      const testerSuggestions = suggestions.filter((s) => s.mode === 'tester');
      expect(testerSuggestions).toHaveLength(1);
    });
  });

  describe('recordUsage and getPersonalizedSuggestions', () => {
    it('should return personalized suggestions based on usage history', () => {
      detector.recordUsage('developer', 'Implement login feature');
      detector.recordUsage('developer', 'Create user dashboard');
      detector.recordUsage('tester', 'Write tests for login');
      detector.recordUsage('reviewer', 'Review the code');

      const suggestions = detector.getPersonalizedSuggestions();

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].mode).toBe('developer');
      expect(suggestions[0].reason).toContain('Frequently used');
      expect(suggestions[0].reason).toContain('2 times');
    });

    it('should calculate confidence based on relative frequency', () => {
      detector.recordUsage('developer', 'Task 1');
      detector.recordUsage('developer', 'Task 2');
      detector.recordUsage('tester', 'Task 3');

      const suggestions = detector.getPersonalizedSuggestions();

      const devSuggestion = suggestions.find((s) => s.mode === 'developer');
      const testSuggestion = suggestions.find((s) => s.mode === 'tester');

      expect(devSuggestion?.confidence).toBeGreaterThan(
        testSuggestion?.confidence ?? 0,
      );
    });

    it('should cap confidence at 0.95', () => {
      for (let i = 0; i < 100; i++) {
        detector.recordUsage('developer', `Task ${i}`);
      }

      const suggestions = detector.getPersonalizedSuggestions();
      const devSuggestion = suggestions.find((s) => s.mode === 'developer');

      expect(devSuggestion?.confidence).toBeLessThanOrEqual(0.95);
    });

    it('should return empty array when no usage history', () => {
      const suggestions = detector.getPersonalizedSuggestions();
      expect(suggestions).toEqual([]);
    });

    it('should sort personalized suggestions by confidence descending', () => {
      detector.recordUsage('reviewer', 'Review 1');
      detector.recordUsage('reviewer', 'Review 2');
      detector.recordUsage('reviewer', 'Review 3');
      detector.recordUsage('developer', 'Dev 1');
      detector.recordUsage('tester', 'Test 1');

      const suggestions = detector.getPersonalizedSuggestions();

      for (let i = 1; i < suggestions.length; i++) {
        expect(suggestions[i].confidence).toBeLessThanOrEqual(
          suggestions[i - 1].confidence,
        );
      }
    });

    it('should lowercase task descriptions when recording', () => {
      detector.recordUsage('developer', 'IMPLEMENT Feature');
      const history = detector.getUsageHistory();

      expect(history[0].taskDescription).toBe('implement feature');
    });

    it('should retain only last 1000 usage entries', () => {
      for (let i = 0; i < 1100; i++) {
        detector.recordUsage('developer', `Task ${i}`);
      }

      const history = detector.getUsageHistory();
      expect(history.length).toBe(1000);
    });
  });

  describe('addRule with custom rule', () => {
    it('should detect modes using custom rules', () => {
      detector.addRule({
        patterns: ['migrate', 'migration', 'database migration'],
        mode: 'developer',
        confidence: 0.85,
        reason: 'Task involves database migration',
      });

      const suggestions = detector.detect('Run the database migration script');

      const devSuggestion = suggestions.find(
        (s) => s.mode === 'developer' && s.confidence === 0.85,
      );
      expect(devSuggestion).toBeDefined();
      expect(devSuggestion?.reason).toContain('database migration');
    });

    it('should support regex patterns in custom rules', () => {
      detector.addRule({
        patterns: [/^\s*refactor/i],
        mode: 'developer',
        confidence: 0.95,
        reason: 'Refactoring task detected',
      });

      const suggestions = detector.detect('refactor the auth module');

      const devSuggestion = suggestions.find((s) => s.confidence === 0.95);
      expect(devSuggestion).toBeDefined();
    });

    it('should append custom rule to existing rules', () => {
      const rulesBefore = detector.getRules().length;

      detector.addRule({
        patterns: ['custom-keyword'],
        mode: 'developer',
        confidence: 0.5,
        reason: 'Custom rule',
      });

      expect(detector.getRules().length).toBe(rulesBefore + 1);
    });
  });

  describe('resetRules / clearHistory', () => {
    it('should reset rules to built-in defaults', () => {
      const rulesBefore = detector.getRules().length;

      detector.addRule({
        patterns: ['custom-rule'],
        mode: 'developer',
        confidence: 0.5,
        reason: 'Custom',
      });

      expect(detector.getRules().length).toBe(rulesBefore + 1);

      detector.resetRules();

      expect(detector.getRules().length).toBe(rulesBefore);
    });

    it('should still detect built-in modes after resetRules', () => {
      detector.addRule({
        patterns: ['custom-rule'],
        mode: 'developer',
        confidence: 0.5,
        reason: 'Custom',
      });

      detector.resetRules();

      const suggestions = detector.detect('write tests');
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].mode).toBe('tester');
    });

    it('should clear all usage history', () => {
      detector.recordUsage('developer', 'Task 1');
      detector.recordUsage('tester', 'Task 2');

      expect(detector.getUsageHistory().length).toBe(2);

      detector.clearHistory();

      expect(detector.getUsageHistory().length).toBe(0);
      expect(detector.getPersonalizedSuggestions()).toEqual([]);
    });

    it('should not affect rules when clearing history', () => {
      detector.addRule({
        patterns: ['custom-rule'],
        mode: 'developer',
        confidence: 0.5,
        reason: 'Custom',
      });

      const rulesBefore = detector.getRules().length;

      detector.clearHistory();

      expect(detector.getRules().length).toBe(rulesBefore);
    });
  });
});
