/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookEventName, HooksConfigSource } from '@qwen-code/qwen-code-core';

// Mock i18n module
vi.mock('../../../i18n/index.js', () => ({
  t: vi.fn((key: string) => key),
}));

// Import after mocking
import {
  getHookExitCodes,
  getHookShortDescription,
  getHookDescription,
  getTranslatedSourceDisplayMap,
  createEmptyHookEventInfo,
  DISPLAY_HOOK_EVENTS,
} from './constants.js';

describe('hooks constants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getHookExitCodes', () => {
    it('should return exit codes for Stop event', () => {
      const exitCodes = getHookExitCodes(HookEventName.Stop);
      expect(exitCodes).toHaveLength(3);
      expect(exitCodes[0]).toEqual({
        code: 0,
        description: expect.any(String),
      });
      expect(exitCodes[1]).toEqual({
        code: 2,
        description: expect.any(String),
      });
      expect(exitCodes[2]).toEqual({
        code: 'Other',
        description: expect.any(String),
      });
    });

    it('should return exit codes for PreToolUse event', () => {
      const exitCodes = getHookExitCodes(HookEventName.PreToolUse);
      expect(exitCodes).toHaveLength(3);
      expect(exitCodes[0].code).toBe(0);
      expect(exitCodes[1].code).toBe(2);
      expect(exitCodes[2].code).toBe('Other');
    });

    it('should return exit codes for PostToolUse event', () => {
      const exitCodes = getHookExitCodes(HookEventName.PostToolUse);
      expect(exitCodes).toHaveLength(3);
    });

    it('should return exit codes for UserPromptSubmit event', () => {
      const exitCodes = getHookExitCodes(HookEventName.UserPromptSubmit);
      expect(exitCodes).toHaveLength(3);
    });

    it('should return exit codes for Notification event', () => {
      const exitCodes = getHookExitCodes(HookEventName.Notification);
      expect(exitCodes).toHaveLength(2);
    });

    it('should return exit codes for SessionStart event', () => {
      const exitCodes = getHookExitCodes(HookEventName.SessionStart);
      expect(exitCodes).toHaveLength(2);
    });

    it('should return exit codes for SessionEnd event', () => {
      const exitCodes = getHookExitCodes(HookEventName.SessionEnd);
      expect(exitCodes).toHaveLength(2);
    });

    it('should return exit codes for PreCompact event', () => {
      const exitCodes = getHookExitCodes(HookEventName.PreCompact);
      expect(exitCodes).toHaveLength(3);
    });

    it('should return empty array for unknown event', () => {
      const exitCodes = getHookExitCodes('unknown_event' as HookEventName);
      expect(exitCodes).toEqual([]);
    });
  });

  describe('getHookShortDescription', () => {
    it('should return description for PreToolUse', () => {
      const desc = getHookShortDescription(HookEventName.PreToolUse);
      expect(desc).toBe('Before tool execution');
    });

    it('should return description for PostToolUse', () => {
      const desc = getHookShortDescription(HookEventName.PostToolUse);
      expect(desc).toBe('After tool execution');
    });

    it('should return description for UserPromptSubmit', () => {
      const desc = getHookShortDescription(HookEventName.UserPromptSubmit);
      expect(desc).toBe('When the user submits a prompt');
    });

    it('should return description for SessionStart', () => {
      const desc = getHookShortDescription(HookEventName.SessionStart);
      expect(desc).toBe('When a new session is started');
    });

    it('should return empty string for unknown event', () => {
      const desc = getHookShortDescription('unknown_event' as HookEventName);
      expect(desc).toBe('');
    });
  });

  describe('getHookDescription', () => {
    it('should return description for PreToolUse', () => {
      const desc = getHookDescription(HookEventName.PreToolUse);
      expect(desc).toBe('Input to command is JSON of tool call arguments.');
    });

    it('should return description for PostToolUse', () => {
      const desc = getHookDescription(HookEventName.PostToolUse);
      expect(desc).toContain('inputs');
      expect(desc).toContain('response');
    });

    it('should return empty string for Stop event', () => {
      const desc = getHookDescription(HookEventName.Stop);
      expect(desc).toBe('');
    });

    it('should return empty string for unknown event', () => {
      const desc = getHookDescription('unknown_event' as HookEventName);
      expect(desc).toBe('');
    });
  });

  describe('getTranslatedSourceDisplayMap', () => {
    it('should return mapping for all sources', () => {
      const map = getTranslatedSourceDisplayMap();

      expect(map[HooksConfigSource.Project]).toBe('Local Settings');
      expect(map[HooksConfigSource.User]).toBe('User Settings');
      expect(map[HooksConfigSource.System]).toBe('System Settings');
      expect(map[HooksConfigSource.Extensions]).toBe('Extensions');
    });

    it('should return translated strings', () => {
      const map = getTranslatedSourceDisplayMap();

      // All values should be strings (translated)
      Object.values(map).forEach((value) => {
        expect(typeof value).toBe('string');
        expect(value.length).toBeGreaterThan(0);
      });
    });
  });

  describe('DISPLAY_HOOK_EVENTS', () => {
    it('should contain all expected hook events', () => {
      expect(DISPLAY_HOOK_EVENTS).toContain(HookEventName.Stop);
      expect(DISPLAY_HOOK_EVENTS).toContain(HookEventName.PreToolUse);
      expect(DISPLAY_HOOK_EVENTS).toContain(HookEventName.PostToolUse);
      expect(DISPLAY_HOOK_EVENTS).toContain(HookEventName.PostToolUseFailure);
      expect(DISPLAY_HOOK_EVENTS).toContain(HookEventName.Notification);
      expect(DISPLAY_HOOK_EVENTS).toContain(HookEventName.UserPromptSubmit);
      expect(DISPLAY_HOOK_EVENTS).toContain(HookEventName.SessionStart);
      expect(DISPLAY_HOOK_EVENTS).toContain(HookEventName.SessionEnd);
      expect(DISPLAY_HOOK_EVENTS).toContain(HookEventName.SubagentStart);
      expect(DISPLAY_HOOK_EVENTS).toContain(HookEventName.SubagentStop);
      expect(DISPLAY_HOOK_EVENTS).toContain(HookEventName.PreCompact);
      expect(DISPLAY_HOOK_EVENTS).toContain(HookEventName.PermissionRequest);
    });

    it('should match HookEventName count', () => {
      expect(DISPLAY_HOOK_EVENTS).toHaveLength(
        Object.values(HookEventName).length,
      );
    });
  });

  describe('createEmptyHookEventInfo', () => {
    it('should create empty info for PreToolUse', () => {
      const info = createEmptyHookEventInfo(HookEventName.PreToolUse);

      expect(info.event).toBe(HookEventName.PreToolUse);
      expect(info.shortDescription).toBe('Before tool execution');
      expect(info.description).toBe(
        'Input to command is JSON of tool call arguments.',
      );
      expect(info.exitCodes).toHaveLength(3);
      expect(info.configs).toEqual([]);
    });

    it('should create empty info for Stop', () => {
      const info = createEmptyHookEventInfo(HookEventName.Stop);

      expect(info.event).toBe(HookEventName.Stop);
      expect(info.shortDescription).toBe(
        'Right before proto concludes its response',
      );
      expect(info.description).toBe('');
      expect(info.exitCodes).toHaveLength(3);
      expect(info.configs).toEqual([]);
    });

    it('should create empty info for unknown event', () => {
      const info = createEmptyHookEventInfo('unknown_event' as HookEventName);

      expect(info.event).toBe('unknown_event');
      expect(info.shortDescription).toBe('');
      expect(info.description).toBe('');
      expect(info.exitCodes).toEqual([]);
      expect(info.configs).toEqual([]);
    });
  });
});
