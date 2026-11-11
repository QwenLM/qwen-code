/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { act } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config, CustomProviderModelEdit } from '@qwen-code/core';
import { updateLocalModelFromTui } from '../../utils/localCustomModels.js';
import { renderWithProviders } from '../../../test-utils/render.js';
import { waitFor } from '../../../test-utils/async.js';
import { BaseTabDialog } from './BaseTabDialog.js';
import { LocalCustomModelForm } from './LocalCustomModelForm.js';
vi.mock('../../utils/localCustomModels.js', () => ({
  updateLocalModelFromTui: vi
    .fn()
    .mockResolvedValue({ modelKey: 'gateway/model', applied: true }),
  createLocalProviderFromTui: vi.fn(),
}));
const ENTER = '\r';
const DOWN = '\u001b[B';
const ESC = '\u001b';
const edit: CustomProviderModelEdit = {
  providerId: 'gateway',
  modelKey: 'gateway/model',
  revision: 'snapshot',
  protocol: 'openai',
  baseUrl: 'https://gateway.example/v1',
  hasApiKey: true,
  model: {
    model: 'model',
    displayName: 'Coding',
    contextWindow: 256000,
    maxOutputTokens: 8192,
    capabilities: { tools: true, cacheControl: true, vision: false },
  },
};
describe('LocalCustomModelForm', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['openai', 'openai-responses'] as const)(
    'edits %s capabilities, preserves an unchanged key, and reviews before updating',
    async (protocol) => {
      const onSaved = vi.fn();
      const result = await renderWithProviders(
        <BaseTabDialog isActive={false}>
          <LocalCustomModelForm
            config={{} as Config}
            edit={edit}
            protocol={protocol}
            onClose={vi.fn()}
            onSaved={onSaved}
          />
        </BaseTabDialog>,
      );
      const press = async (key: string) => {
        await act(async () => {
          result.stdin.write(key);
        });
        await result.waitUntilReady();
      };
      await result.waitUntilReady();
      expect(result.lastFrame()).toContain('Edit custom model');
      await press(DOWN + DOWN + ENTER); // API Key
      expect(result.lastFrame()).toContain('Leave blank to keep');
      await press(ENTER);
      await press(ENTER); // Capabilities
      await press(DOWN + DOWN + ENTER); // Image input
      await press(DOWN + ENTER); // Thinking
      expect(result.lastFrame()).not.toContain('Supported modes');
      expect(result.lastFrame()).not.toContain('Required betas');
      await expect(result).toMatchSvgSnapshot();
      await press(ENTER); // Levels
      await press(ENTER); // low
      await press(DOWN + DOWN + ENTER); // high
      await press(DOWN + DOWN + DOWN + ENTER); // Done
      await press(DOWN + ENTER); // Back to capabilities
      await press(DOWN + DOWN + DOWN + DOWN + ENTER); // Back to form
      await press(DOWN + DOWN + DOWN + DOWN + ENTER); // Review
      expect(result.lastFrame()).toContain('Review custom model');
      expect(result.lastFrame()).toContain('low / high');
      expect(result.lastFrame()).not.toContain('API Key');
      await expect(result).toMatchSvgSnapshot();
      expect(updateLocalModelFromTui).not.toHaveBeenCalled();
      await press(ENTER);
      await waitFor(() =>
        expect(onSaved).toHaveBeenCalledWith('gateway/model', true),
      );
      expect(updateLocalModelFromTui).toHaveBeenCalledWith(
        {},
        edit,
        expect.objectContaining({
          model: expect.objectContaining({
            capabilities: expect.objectContaining({
              vision: true,
              cacheControl: true,
              thinking: expect.objectContaining({
                supportedEffortLevels: ['low', 'high'],
              }),
            }),
          }),
        }),
      );
      expect(
        vi.mocked(updateLocalModelFromTui).mock.calls[0][2],
      ).not.toHaveProperty('apiKey');
      result.unmount();
    },
  );
  it('edits Anthropic modes while preserving advanced beta configuration', async () => {
    const seed: CustomProviderModelEdit = {
      ...edit,
      protocol: 'anthropic',
      model: {
        ...edit.model,
        capabilities: {
          tools: true,
          cacheControl: true,
          thinking: {
            modes: ['enabled'],
            preferredMode: 'enabled',
            requiresBudgetForEnabled: true,
            supportsEffort: true,
            supportedEffortLevels: ['low'],
            requiredBetasForEffort: ['test-beta-2026'],
          },
        },
      },
    };
    const onSaved = vi.fn();
    const result = await renderWithProviders(
      <BaseTabDialog isActive={false}>
        <LocalCustomModelForm
          config={{} as Config}
          edit={seed}
          protocol="anthropic"
          onClose={vi.fn()}
          onSaved={onSaved}
        />
      </BaseTabDialog>,
    );
    const press = async (key: string) => {
      await act(async () => {
        result.stdin.write(key);
      });
      await result.waitUntilReady();
    };
    await result.waitUntilReady();
    await expect(result).toMatchSvgSnapshot();
    await press(DOWN.repeat(3) + ENTER);
    await expect(result).toMatchSvgSnapshot();
    await press(DOWN.repeat(3) + ENTER);
    expect(result.lastFrame()).toContain('Supported modes');
    expect(result.lastFrame()).not.toContain('Required betas');
    expect(result.lastFrame()).not.toContain('Enabled betas');
    await expect(result).toMatchSvgSnapshot();
    await press(ENTER);
    await press(ENTER); // Add adaptive alongside enabled
    await press(DOWN.repeat(2) + ENTER); // No budget required
    await press(DOWN.repeat(2) + ENTER); // Done modes
    await press(DOWN.repeat(2) + ENTER); // Done thinking
    await press(DOWN.repeat(4) + ENTER); // Done capabilities
    await press(DOWN.repeat(4) + ENTER); // Review
    expect(result.lastFrame()).toContain('Review custom model');
    expect(result.lastFrame()).not.toContain('API Key');
    expect(result.lastFrame()).not.toContain('betas');
    await press(ENTER);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(updateLocalModelFromTui).toHaveBeenCalledWith(
      {},
      seed,
      expect.objectContaining({
        model: expect.objectContaining({
          capabilities: expect.objectContaining({
            cacheControl: true,
            thinking: expect.objectContaining({
              modes: ['enabled', 'adaptive'],
              preferredMode: 'enabled',
              requiresBudgetForEnabled: false,
              requiredBetasForEffort: ['test-beta-2026'],
              supportedEffortLevels: ['low'],
            }),
          }),
        }),
      }),
    );
    result.unmount();
  });

  it('restores the originating field and nested menu item on Escape', async () => {
    const result = await renderWithProviders(
      <BaseTabDialog isActive={false}>
        <LocalCustomModelForm
          config={{} as Config}
          edit={edit}
          protocol="openai"
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />
      </BaseTabDialog>,
    );
    const press = async (key: string) => {
      await act(async () => {
        result.stdin.write(key);
      });
      await result.waitUntilReady();
    };
    await result.waitUntilReady();
    await press(DOWN + ENTER); // Name
    await press(ESC);
    expect(result.lastFrame()).toContain('❯ Name');
    await press(ENTER);
    expect(result.lastFrame()).toContain('Leave blank to use the model ID.');
    await press(ESC);
    await press(DOWN.repeat(2) + ENTER); // Capabilities
    await press(DOWN + ENTER); // Max output
    await press(ESC);
    expect(result.lastFrame()).toContain('❯ Max output');
    await press(DOWN.repeat(2) + ENTER); // Thinking
    await press(ENTER); // Levels
    await press(DOWN.repeat(2));
    await press(ESC);
    expect(result.lastFrame()).toContain('❯ Effort levels');
    await press(ENTER);
    expect(result.lastFrame()).toContain('❯ [ ] high');
    await press(ESC);
    await press(ESC);
    expect(result.lastFrame()).toContain('❯ Thinking controls');
    await press(ESC);
    expect(result.lastFrame()).toContain('❯ Model capabilities...');
    expect(updateLocalModelFromTui).not.toHaveBeenCalled();
    result.unmount();
  });

  it('does not save when editing is cancelled', async () => {
    const onClose = vi.fn();
    const result = await renderWithProviders(
      <BaseTabDialog isActive={false}>
        <LocalCustomModelForm
          config={{} as Config}
          edit={edit}
          protocol="openai"
          onClose={onClose}
          onSaved={vi.fn()}
        />
      </BaseTabDialog>,
    );
    await result.waitUntilReady();
    await act(async () => {
      result.stdin.write(ESC);
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(updateLocalModelFromTui).not.toHaveBeenCalled();
    result.unmount();
  });
});
