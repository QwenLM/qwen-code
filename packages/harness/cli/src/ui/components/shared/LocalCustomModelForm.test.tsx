/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { act, useReducer } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ModelInferenceError,
  type Config,
  type CustomProviderModelEdit,
} from '@qwen-code/core';
import {
  createLocalProviderFromTui,
  updateLocalModelFromTui,
} from '../../utils/localCustomModels.js';
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

  it.each(['escape', 'unmount', 'persist', 'parent-escape'] as const)(
    'handles cancellation at the %s boundary',
    async (cancel) => {
      let signal: AbortSignal | undefined;
      let finishSave!: (result: { modelKey: string; applied: boolean }) => void;
      vi.mocked(createLocalProviderFromTui).mockImplementationOnce(
        async (_config, _input, options) => {
          signal = options!.signal!;
          if (cancel === 'persist') options!.onPersist!();
          return new Promise<{ modelKey: string; applied: boolean }>(
            (resolve, reject) => {
              finishSave = resolve;
              signal!.addEventListener('abort', () => reject(signal!.reason), {
                once: true,
              });
            },
          );
        },
      );
      const onSaved = vi.fn();
      const onClose = vi.fn();
      const onParentClose = vi.fn();
      const hasParent = cancel === 'parent-escape';
      const dialog = (showForm: boolean) => (
        <BaseTabDialog
          isActive={hasParent}
          onClose={hasParent ? onParentClose : undefined}
        >
          {showForm && (
            <LocalCustomModelForm
              config={{} as Config}
              protocol="openai"
              onClose={onClose}
              onSaved={onSaved}
            />
          )}
        </BaseTabDialog>
      );
      let showForm!: () => void;
      let rerenderParent!: () => void;
      function ParentDialog() {
        const [visible, show] = useReducer(() => true, false);
        const [, refresh] = useReducer((value: number) => value + 1, 0);
        showForm = show;
        rerenderParent = refresh;
        return dialog(visible);
      }
      // Register the parent's Escape handler before mounting the nested form.
      const result = await renderWithProviders(
        hasParent ? <ParentDialog /> : dialog(true),
      );
      if (hasParent) {
        await result.waitUntilReady();
        await act(async () => showForm());
      }
      const press = async (key: string) => {
        await act(async () => {
          result.stdin.write(key);
        });
        await result.waitUntilReady();
      };
      await result.waitUntilReady();
      await press(ENTER);
      await press('http://127.0.0.1:12345/v1');
      await press(ENTER);
      await press(ENTER);
      await press('cancel-test-model');
      await press(ENTER);
      await press(ENTER);
      await press('Test name');
      await press(ENTER);
      await press(ENTER);
      await press('test-key');
      await press(ENTER);
      await press(DOWN + ENTER);
      await press(ENTER);
      await press(ENTER); // Confirm the default context budget.
      await waitFor(() => expect(signal).toBeDefined());
      if (cancel === 'persist') {
        expect(result.lastFrame()).toContain('Saving...');
        expect(result.lastFrame()).not.toContain('Esc cancel check');
        await press(ESC);
        expect(signal!.aborted).toBe(false);
        expect(onClose).not.toHaveBeenCalled();
        expect(onSaved).not.toHaveBeenCalled();
        await act(async () =>
          finishSave({ modelKey: 'custom/model', applied: true }),
        );
        await waitFor(() =>
          expect(onSaved).toHaveBeenCalledWith('custom/model', true),
        );
        result.unmount();
        return;
      }
      if (hasParent) {
        await act(async () => rerenderParent());
        await result.waitUntilReady();
      }
      expect(result.lastFrame()).toContain('Checking connection...');
      expect(result.lastFrame()).toContain('Esc cancel check');
      await press(ENTER); // A second save must not start another check.
      expect(createLocalProviderFromTui).toHaveBeenCalledTimes(1);
      if (cancel === 'unmount') {
        await act(async () => result.unmount());
      } else {
        await press(ESC);
        expect(result.lastFrame()).toContain('Add custom model');
        expect(result.lastFrame()).toContain('http://127.0.0.1:12345/v1');
        expect(result.lastFrame()).toContain('cancel-test-model');
        expect(result.lastFrame()).toContain('Test name');
        expect(result.lastFrame()).not.toContain('failed');
      }
      expect(signal!.aborted).toBe(true);
      expect(onSaved).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(onParentClose).not.toHaveBeenCalled();
      if (cancel === 'escape' || cancel === 'parent-escape') {
        const firstInput = vi.mocked(createLocalProviderFromTui).mock
          .calls[0][1];
        vi.mocked(createLocalProviderFromTui).mockImplementationOnce(
          async (_config, _input, options) => {
            expect(options!.signal!.aborted).toBe(false);
            options!.onPersist!();
            return { modelKey: 'custom/model', applied: true };
          },
        );
        await press(ENTER); // Review again, with every field preserved.
        await press(ENTER);
        await press(ENTER);
        await waitFor(() =>
          expect(onSaved).toHaveBeenCalledWith('custom/model', true),
        );
        expect(vi.mocked(createLocalProviderFromTui).mock.calls[1][1]).toEqual(
          firstInput,
        );
        result.unmount();
      }
    },
  );

  it('shows the upstream reason when the connection check fails', async () => {
    vi.mocked(createLocalProviderFromTui).mockRejectedValueOnce(
      new ModelInferenceError(
        "HTTP 400: 'reasoning_effort' must be one of: 'low', 'high', 'max'",
        { kind: 'invalid_request', phase: 'before_output', status: 400 },
      ),
    );
    const onSaved = vi.fn();
    const result = await renderWithProviders(
      <BaseTabDialog isActive={false}>
        <LocalCustomModelForm
          config={{} as Config}
          protocol="openai"
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
    await press(ENTER);
    await press('http://127.0.0.1:12345/v1');
    await press(ENTER);
    await press(ENTER);
    await press('glm-5.3');
    await press(ENTER);
    await press(DOWN + DOWN + DOWN + ENTER); // Review
    await press(ENTER);
    await press(ENTER); // Confirm the default context budget.
    await waitFor(() =>
      expect(result.lastFrame()).toContain('Connection check failed'),
    );
    expect(result.lastFrame()).toContain("'reasoning_effort' must be one of");
    expect(result.lastFrame()).not.toContain('Could not save or apply');
    expect(onSaved).not.toHaveBeenCalled();
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
