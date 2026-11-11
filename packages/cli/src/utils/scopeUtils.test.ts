/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { ConfigSource } from '@qwen-code/core';
import { SettingScope } from '../config/settings.js';
import { getScopeForAgentSource, getScopeForHookSource } from './scopeUtils.js';

describe('getScopeForAgentSource', () => {
  it('returns Project for project source', () => {
    expect(getScopeForAgentSource('project')).toBe(SettingScope.Project);
  });

  it('returns User for built-in source', () => {
    expect(getScopeForAgentSource('built-in')).toBe(SettingScope.User);
  });

  it('returns User for user source', () => {
    expect(getScopeForAgentSource('user')).toBe(SettingScope.User);
  });

  it('returns User for plugin source', () => {
    expect(getScopeForAgentSource('plugin')).toBe(SettingScope.User);
  });

  it('returns User for flag source', () => {
    expect(getScopeForAgentSource('flag')).toBe(SettingScope.User);
  });

  it('returns User for undefined source', () => {
    expect(getScopeForAgentSource(undefined)).toBe(SettingScope.User);
  });
});

describe('getScopeForHookSource', () => {
  it('returns Project for Project source', () => {
    expect(getScopeForHookSource(ConfigSource.Project)).toBe(
      SettingScope.Project,
    );
  });

  it('returns Local for Local source', () => {
    expect(getScopeForHookSource(ConfigSource.Local)).toBe(
      SettingScope.Local,
    );
  });

  it('returns User for User source', () => {
    expect(getScopeForHookSource(ConfigSource.User)).toBe(SettingScope.User);
  });

  it('returns User for Plugins source', () => {
    expect(getScopeForHookSource(ConfigSource.Plugins)).toBe(SettingScope.User);
  });

  it('returns User for Flag source', () => {
    expect(getScopeForHookSource(ConfigSource.Flag)).toBe(SettingScope.User);
  });

  it('returns User for System source', () => {
    expect(getScopeForHookSource(ConfigSource.System)).toBe(SettingScope.User);
  });

  it('returns User for Runtime source', () => {
    expect(getScopeForHookSource(ConfigSource.Runtime)).toBe(SettingScope.User);
  });
});
