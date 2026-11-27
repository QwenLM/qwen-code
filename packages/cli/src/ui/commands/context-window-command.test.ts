/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { ModelPreferences } from '@qwen-code/qwen-code-core/models/model-preferences.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadedSettings, type Settings } from '../../config/settings.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { contextWindowCommand } from './context-window-command.js';

describe('contextWindowCommand', () => {
  let directory: string;
  const route = 'openai/model.v2';
  const baseline = 128_000;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'qwen-context-window-'));
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  function setup(user: Settings, workspace: Settings = {}) {
    const files = ['system', 'defaults', 'user', 'workspace'].map((name) =>
      join(directory, `${name}.json`),
    );
    const [systemFile, defaultsFile, userFile, workspaceFile] = files.map(
      (path, index) => {
        const settings = [undefined, undefined, user, workspace][index] ?? {};
        writeFileSync(path, JSON.stringify(settings));
        return { path, settings, originalSettings: structuredClone(settings) };
      },
    );
    const settings = new LoadedSettings(
      systemFile!,
      defaultsFile!,
      userFile!,
      workspaceFile!,
      true,
      new Set(),
    );
    let contextWindowSize = baseline;
    const setModelPreferences = vi.fn((preferences: ModelPreferences) => {
      contextWindowSize = preferences[route]?.contextWindow ?? baseline;
    });
    const context = createMockCommandContext({
      services: {
        config: {
          getModel: () => 'model.v2',
          getModelPreferenceKey: () => route,
          getModelPreferenceContextLimit: () => baseline,
          getContentGeneratorConfig: () => ({ contextWindowSize }),
          setModelPreferences,
        } as unknown as Config,
      },
    });
    context.services.settings = settings;
    return {
      context,
      setModelPreferences,
      readUserPreferences: () =>
        JSON.parse(readFileSync(userFile!.path, 'utf8')).model.preferences,
      readWorkspacePreferences: () =>
        JSON.parse(readFileSync(workspaceFile!.path, 'utf8')).model.preferences,
    };
  }

  it('persists only the window on the literal model route', async () => {
    const other = { contextWindow: 40_000 };
    const reasoning = { effort: 'high' as const };
    const { context, setModelPreferences, readUserPreferences } = setup({
      model: { preferences: { [route]: { reasoning }, other } },
    });

    const result = await contextWindowCommand.action!(context, '64000');

    const expected = { [route]: { reasoning, contextWindow: 64_000 }, other };
    expect(result).toMatchObject({ messageType: 'info' });
    expect(readUserPreferences()).toEqual(expected);
    expect(setModelPreferences).toHaveBeenCalledWith(expected, 'contextWindow');
  });

  it('clears the workspace override and immediately reveals the user preference', async () => {
    const userPreference = { contextWindow: 32_000 };
    const reasoning = { effort: 'low' as const };
    const { context, setModelPreferences, readWorkspacePreferences } = setup(
      { model: { preferences: { [route]: userPreference } } },
      {
        model: {
          preferences: { [route]: { reasoning, contextWindow: 64_000 } },
        },
      },
    );

    await contextWindowCommand.action!(context, 'default');

    expect(readWorkspacePreferences()).toEqual({ [route]: { reasoning } });
    expect(setModelPreferences).toHaveBeenCalledWith(
      { [route]: { ...userPreference, reasoning } },
      'contextWindow',
    );
  });

  it.each(['0', '1e4', '128001'])(
    'rejects the invalid window %s',
    async (value) => {
      const { context, setModelPreferences } = setup({});
      const result = await contextWindowCommand.action!(context, value);
      expect(result).toMatchObject({ messageType: 'error' });
      expect(setModelPreferences).not.toHaveBeenCalled();
    },
  );
});
