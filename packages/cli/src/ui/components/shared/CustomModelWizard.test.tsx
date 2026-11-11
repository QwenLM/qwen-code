/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/core';
import { createLocalProviderFromTui } from '../../utils/localCustomModels.js';
import { renderWithProviders } from '../../../test-utils/render.js';
import { waitFor } from '../../../test-utils/async.js';
import { BaseTabDialog } from './BaseTabDialog.js';
import { CustomModelWizard } from './CustomModelWizard.js';
vi.mock('../../utils/localCustomModels.js', () => ({
  createLocalProviderFromTui: vi
    .fn()
    .mockResolvedValue({ modelKey: 'local/model', applied: true }),
}));
const config = { getCustomProviderAccessMode: () => 'local' } as Config;
const ENTER = '\r';
const DOWN = '\u001b[B';

describe('CustomModelWizard', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['openai', 'openai-responses', 'anthropic'] as const)(
    'saves %s locally with a masked key and without selecting it',
    async (protocol) => {
      const displayName =
        protocol === 'openai'
          ? ''
          : protocol === 'openai-responses'
            ? 'vendor/model'
            : 'My coding model';
      const expectedName = displayName || 'vendor/model';
      const onSaved = vi.fn();
      const result = await renderWithProviders(
        <BaseTabDialog isActive={false}>
          <CustomModelWizard
            config={config}
            onSaved={onSaved}
            onClose={vi.fn()}
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
      expect(result.lastFrame()).toContain('OpenAI-compatible...');
      if (protocol === 'anthropic') await press(DOWN);
      await press(ENTER);
      if (protocol !== 'anthropic') {
        await waitFor(() =>
          expect(result.lastFrame()).toContain('Chat Completions'),
        );
        if (protocol === 'openai-responses') await press(DOWN);
        await press(ENTER);
      }
      expect(result.lastFrame()).not.toContain('CLI ->');
      for (const value of [
        'https://gateway.example/v1',
        'vendor/model',
        displayName,
        'top-secret-key',
      ]) {
        expect(result.lastFrame()).not.toContain('CLI ->');
        await press(ENTER);
        if (value) await press(value);
        if (value === 'top-secret-key')
          expect(result.lastFrame()).not.toContain(value);
        await press(ENTER);
      }
      await press(DOWN);
      await press(ENTER);
      await waitFor(() => expect(result.lastFrame()).toContain('Save model'));
      expect(result.lastFrame()).not.toContain('top-secret-key');
      expect(result.lastFrame()).toContain('Review custom model');
      expect(result.lastFrame()).toContain('Model ID');
      expect(result.lastFrame()).not.toContain('API Key');
      expect(result.lastFrame()?.includes('Name')).toBe(Boolean(displayName));
      expect(result.lastFrame()).toContain('Connection has not been tested.');
      expect(result.lastFrame()).toContain('Enter save');
      await result.waitUntilReady();
      await expect(result).toMatchSvgSnapshot();
      expect(createLocalProviderFromTui).not.toHaveBeenCalled();
      await press(ENTER);
      expect(result.lastFrame()).toContain('Save with 128K default budget');
      expect(createLocalProviderFromTui).not.toHaveBeenCalled();
      await press(ENTER);
      await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
      expect(createLocalProviderFromTui).toHaveBeenCalledWith(
        config,
        expect.objectContaining({
          protocol,
          model: 'vendor/model',
          displayName: expectedName,
          models: [
            expect.objectContaining({
              model: 'vendor/model',
              displayName: expectedName,
              maxOutputTokens: 32000,
            }),
          ],
          apiKey: 'top-secret-key',
          baseUrl: 'https://gateway.example/v1',
          authType: protocol === 'anthropic' ? 'api-key' : 'bearer',
        }),
      );
      result.unmount();
    },
  );

  it.each(['openai', 'anthropic'] as const)(
    'opens the %s entry directly and closes when backing out of it',
    async (entry) => {
      const onClose = vi.fn();
      const result = await renderWithProviders(
        <BaseTabDialog isActive={false}>
          <CustomModelWizard
            config={config}
            entry={entry}
            onSaved={vi.fn()}
            onClose={onClose}
          />
        </BaseTabDialog>,
      );
      await result.waitUntilReady();
      expect(result.lastFrame()).not.toContain('OpenAI-compatible...');
      if (entry === 'openai')
        expect(result.lastFrame()).toContain('Chat Completions');
      await act(async () => {
        result.stdin.write('\u001b');
      });
      await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
      result.unmount();
    },
  );
});
