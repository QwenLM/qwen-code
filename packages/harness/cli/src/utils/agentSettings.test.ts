/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SettingScope,
  type LoadedSettings,
  type LoadableSettingScope,
} from '../config/settings.js';
import { enableAgent, disableAgent } from './agentSettings.js';
import { CONFIG_DIR } from '@qwen-code/core';

function createMockLoadedSettings(opts: {
  userSettings?: Record<string, unknown>;
  projectSettings?: Record<string, unknown>;
  userPath?: string;
  workspacePath?: string;
}): LoadedSettings {
  const scopes: Record<
    string,
    {
      settings: Record<string, unknown>;
      originalSettings: Record<string, unknown>;
      path: string;
    }
  > = {
    [SettingScope.User]: {
      settings: opts.userSettings ?? {},
      originalSettings: opts.userSettings ?? {},
      path: opts.userPath ?? `/home/user/${CONFIG_DIR}/settings.json`,
    },
    [SettingScope.Project]: {
      settings: opts.projectSettings ?? {},
      originalSettings: opts.projectSettings ?? {},
      path: opts.workspacePath ?? `/project/${CONFIG_DIR}/settings.json`,
    },
  };

  return {
    forScope: vi.fn((scope: LoadableSettingScope) => scopes[scope]),
    setValue: vi.fn().mockReturnValue(true),
  } as unknown as LoadedSettings;
}

describe('agentSettings', () => {
  describe('agentStrategy (via enableAgent / disableAgent)', () => {
    describe('enableAgent', () => {
      it('should return no-op when the agent is already enabled in both scopes', () => {
        const settings = createMockLoadedSettings({
          userSettings: {
            agents: { overrides: { 'my-agent': { enabled: true } } },
          },
          projectSettings: {
            agents: { overrides: { 'my-agent': { enabled: true } } },
          },
        });

        const result = enableAgent(settings, 'my-agent');

        expect(result.status).toBe('no-op');
        expect(result.action).toBe('enable');
        expect(result.agentName).toBe('my-agent');
        expect(result.modifiedScopes).toHaveLength(0);
        expect(settings.setValue).not.toHaveBeenCalled();
      });

      it('should enable the agent when not present in any scope', () => {
        const settings = createMockLoadedSettings({
          userSettings: {},
          projectSettings: {},
        });

        const result = enableAgent(settings, 'my-agent');

        expect(result.status).toBe('success');
        expect(result.action).toBe('enable');
        expect(result.agentName).toBe('my-agent');
        expect(result.modifiedScopes).toHaveLength(2);
        expect(settings.setValue).toHaveBeenCalledTimes(2);
      });

      it('should enable the agent only in the scope where it is not enabled', () => {
        const settings = createMockLoadedSettings({
          userSettings: {
            agents: { overrides: { 'my-agent': { enabled: true } } },
          },
          projectSettings: {
            agents: { overrides: { 'my-agent': { enabled: false } } },
          },
        });

        const result = enableAgent(settings, 'my-agent');

        expect(result.status).toBe('success');
        expect(result.modifiedScopes).toHaveLength(1);
        expect(result.modifiedScopes[0].scope).toBe(SettingScope.Project);
        expect(result.alreadyInStateScopes).toHaveLength(1);
        expect(result.alreadyInStateScopes[0].scope).toBe(SettingScope.User);
        expect(settings.setValue).toHaveBeenCalledTimes(1);
      });
    });

    describe('disableAgent', () => {
      it('should return no-op when agent is already explicitly disabled', () => {
        const settings = createMockLoadedSettings({
          userSettings: {
            agents: { overrides: { 'my-agent': { enabled: false } } },
          },
        });

        const result = disableAgent(settings, 'my-agent', SettingScope.User);

        expect(result.status).toBe('no-op');
        expect(result.action).toBe('disable');
        expect(result.agentName).toBe('my-agent');
        expect(settings.setValue).not.toHaveBeenCalled();
      });

      it('should disable the agent when it is currently enabled', () => {
        const settings = createMockLoadedSettings({
          userSettings: {
            agents: { overrides: { 'my-agent': { enabled: true } } },
          },
        });

        const result = disableAgent(settings, 'my-agent', SettingScope.User);

        expect(result.status).toBe('success');
        expect(result.action).toBe('disable');
        expect(result.modifiedScopes).toHaveLength(1);
        expect(result.modifiedScopes[0].scope).toBe(SettingScope.User);
        expect(settings.setValue).toHaveBeenCalledTimes(1);
      });

      it('should return error for an invalid scope', () => {
        const settings = createMockLoadedSettings({});

        const result = disableAgent(settings, 'my-agent', SettingScope.Session);

        expect(result.status).toBe('error');
        expect(result.error).toContain('Invalid settings scope');
      });
    });
  });
});
