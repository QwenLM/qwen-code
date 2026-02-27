/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PromptComposer, composePromptForMode } from '../src/prompt-composer.js';
import { ARCHITECT_MODE, CODE_MODE } from '../src/modes/builtin-modes.js';

describe('PromptComposer', () => {
  let composer: PromptComposer;

  beforeEach(() => {
    composer = new PromptComposer(ARCHITECT_MODE);
  });

  describe('constructor', () => {
    it('should initialize with mode', () => {
      expect(composer).toBeDefined();
    });
  });

  describe('setGlobalInstructions', () => {
    it('should set global instructions', () => {
      composer.setGlobalInstructions('Be helpful');
      expect(composer['globalInstructions']).toBe('Be helpful');
    });
  });

  describe('composeSystemPrompt', () => {
    it('should compose prompt with identity block', () => {
      const prompt = composer.composeSystemPrompt();
      expect(prompt).toContain('[SYSTEM BLOCK: CORE IDENTITY]');
      expect(prompt).toContain('Architect');
    });

    it('should compose prompt with capabilities block', () => {
      const prompt = composer.composeSystemPrompt();
      expect(prompt).toContain('[SYSTEM BLOCK: STRICT CAPABILITIES]');
      expect(prompt).toContain('ДОСТУПНЫ только следующие инструменты');
    });

    it('should compose prompt with safety block', () => {
      const prompt = composer.composeSystemPrompt();
      expect(prompt).toContain('[SYSTEM BLOCK: SAFETY CONSTRAINTS]');
    });

    it('should include global instructions when set', () => {
      composer.setGlobalInstructions('Global test instruction');
      const prompt = composer.composeSystemPrompt();
      expect(prompt).toContain('[USER BLOCK: GLOBAL INSTRUCTIONS]');
      expect(prompt).toContain('Global test instruction');
    });

    it('should include mode custom instructions', () => {
      const modeWithCustomInstructions = {
        ...ARCHITECT_MODE,
        customInstructions: 'Mode-specific instruction',
      };
      const customComposer = new PromptComposer(modeWithCustomInstructions);
      const prompt = customComposer.composeSystemPrompt();
      expect(prompt).toContain('[USER BLOCK: MODE CUSTOM INSTRUCTIONS]');
      expect(prompt).toContain('Mode-specific instruction');
    });

    it('should include custom instructions from parameter', () => {
      const prompt = composer.composeSystemPrompt('Custom instruction');
      expect(prompt).toContain('[USER BLOCK: CUSTOM INSTRUCTIONS]');
      expect(prompt).toContain('Custom instruction');
    });

    it('should include enforcement block', () => {
      const prompt = composer.composeSystemPrompt();
      expect(prompt).toContain('[SYSTEM BLOCK: ENFORCEMENT CAUTION]');
      expect(prompt).toContain('ОБЯЗАН неукоснительно соблюдать ограничения');
    });

    it('should order blocks correctly', () => {
      composer.setGlobalInstructions('Global');
      const prompt = composer.composeSystemPrompt('Custom');

      const identityIndex = prompt.indexOf('[SYSTEM BLOCK: CORE IDENTITY]');
      const capabilitiesIndex = prompt.indexOf(
        '[SYSTEM BLOCK: STRICT CAPABILITIES]',
      );
      const safetyIndex = prompt.indexOf('[SYSTEM BLOCK: SAFETY CONSTRAINTS]');
      const globalIndex = prompt.indexOf('[USER BLOCK: GLOBAL INSTRUCTIONS]');
      const customIndex = prompt.indexOf('[USER BLOCK: CUSTOM INSTRUCTIONS]');
      const enforcementIndex = prompt.indexOf(
        '[SYSTEM BLOCK: ENFORCEMENT CAUTION]',
      );

      expect(identityIndex).toBeLessThan(capabilitiesIndex);
      expect(capabilitiesIndex).toBeLessThan(safetyIndex);
      expect(safetyIndex).toBeLessThan(globalIndex);
      expect(globalIndex).toBeLessThan(customIndex);
      expect(customIndex).toBeLessThan(enforcementIndex);
    });
  });

  describe('compose', () => {
    it('should return composed prompt with system prompt', () => {
      const result = composer.compose();
      expect(result.systemPrompt).toBeDefined();
      expect(result.systemPrompt.length).toBeGreaterThan(0);
    });

    it('should return allowed tools', () => {
      const result = composer.compose();
      expect(result.allowedTools).toEqual(
        expect.arrayContaining(ARCHITECT_MODE.allowedTools),
      );
    });

    it('should return mode info', () => {
      const result = composer.compose();
      expect(result.mode).toBe(ARCHITECT_MODE);
      expect(result.mode.id).toBe('architect');
    });

    it('should pass custom instructions to compose', () => {
      const result = composer.compose('Test instruction');
      expect(result.systemPrompt).toContain('Test instruction');
    });
  });

  describe('getModeSummary', () => {
    it('should return mode summary', () => {
      const summary = composer.getModeSummary();
      expect(summary).toContain('Architect');
      expect(summary).toContain('Инструменты:');
    });
  });

  describe('forMode', () => {
    it('should create composer for different mode', () => {
      const newComposer = composer.forMode(CODE_MODE);
      expect(newComposer).toBeDefined();
      expect(newComposer['mode']).toBe(CODE_MODE);
    });

    it('should copy global instructions to new composer', () => {
      composer.setGlobalInstructions('Global');
      const newComposer = composer.forMode(CODE_MODE);
      expect(newComposer['globalInstructions']).toBe('Global');
    });
  });
});

describe('composePromptForMode', () => {
  it('should compose prompt for mode', () => {
    const result = composePromptForMode(ARCHITECT_MODE);
    expect(result.systemPrompt).toBeDefined();
    expect(result.allowedTools).toBeDefined();
    expect(result.mode).toBe(ARCHITECT_MODE);
  });

  it('should include global instructions', () => {
    const result = composePromptForMode(ARCHITECT_MODE, {
      globalInstructions: 'Global',
    });
    expect(result.systemPrompt).toContain('Global');
  });

  it('should include custom instructions', () => {
    const result = composePromptForMode(ARCHITECT_MODE, {
      customInstructions: 'Custom',
    });
    expect(result.systemPrompt).toContain('Custom');
  });

  it('should include both global and custom instructions', () => {
    const result = composePromptForMode(ARCHITECT_MODE, {
      globalInstructions: 'Global',
      customInstructions: 'Custom',
    });
    expect(result.systemPrompt).toContain('Global');
    expect(result.systemPrompt).toContain('Custom');
  });
});
