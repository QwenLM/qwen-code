/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { makeFakeConfig, type Config } from '@qwen-code/core';
import { Box, Text } from 'ink';
import { act, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '../../test-utils/async.js';
import {
  cleanup,
  renderWithProviders,
} from '../../test-utils/render.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { CommandKind, type SlashCommand } from '../commands/types.js';
import { InputStateProvider } from '../contexts/InputStateProvider.js';
import { StreamingState } from '../types.js';
import { InputPrompt, type InputPromptProps } from './InputPrompt.js';
import {
  SuggestionsDisplay,
  type SuggestionsDisplayProps,
} from './SuggestionsDisplay.js';
import type { TextBuffer } from './shared/text-buffer.js';

const slashCommands: SlashCommand[] = Array.from(
  { length: 8 },
  (_, index) => ({
    name: `command-${index}`,
    description: `Command ${index}`,
    kind: CommandKind.BUILT_IN,
    action: vi.fn(),
  }),
);

function FooterLifecycleHarness({
  config,
  commands = slashCommands,
  onSubmit = vi.fn(),
}: {
  config: Config;
  commands?: SlashCommand[];
  onSubmit?: InputPromptProps['onSubmit'];
}) {
  const bufferRef = useRef<TextBuffer | null>(null);
  const [shellModeActive, setShellModeActive] = useState(false);
  const [footerSuggestions, setFooterSuggestions] =
    useState<SuggestionsDisplayProps | null>(null);

  return (
      <InputStateProvider
        userMessages={[]}
        shellModeActive={shellModeActive}
        showEscapePrompt={false}
        inputWidth={80}
        suggestionsWidth={80}
        getPreferredEditor={() => undefined}
        bufferRef={bufferRef}
      >
        <Box flexDirection="column">
          <InputPrompt
            onSubmit={onSubmit}
            onClearScreen={vi.fn()}
            config={config}
            slashCommands={commands}
            commandContext={createMockCommandContext()}
            setShellModeActive={setShellModeActive}
            permissionMode="default"
            focus={true}
            setQueueErrorMessage={vi.fn()}
            streamingState={StreamingState.Idle}
            suggestionsPosition="footer"
            onFooterSuggestionsChange={setFooterSuggestions}
          />
          {footerSuggestions ? (
            <SuggestionsDisplay {...footerSuggestions} />
          ) : (
            <Text>Footer restored</Text>
          )}
        </Box>
      </InputStateProvider>
  );
}

describe('InputPrompt footer suggestion lifecycle', () => {
  afterEach(() => {
    cleanup();
  });

  it('releases footer suggestions after typing and deleting the slash trigger', async () => {
    const config = makeFakeConfig();
    const { stdin, lastFrame, unmount } = await renderWithProviders(
      <FooterLifecycleHarness config={config} />,
      { config },
    );

    await act(async () => {
      stdin.write('/');
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('command-0');
      expect(lastFrame()).not.toContain('Footer restored');
    });

    await act(async () => {
      stdin.write('\x7f');
    });
    await waitFor(() => {
      expect(lastFrame()).not.toContain('command-0');
      expect(lastFrame()).toContain('Footer restored');
    });

    unmount();
  });

  it.each([1, 2])(
    'prefills the highlighted model ID on Enter with %i candidates, then submits',
    async (count) => {
      const config = makeFakeConfig();
      const onSubmit = vi.fn();
      const models = [
        { label: 'Qwen3.8-Max', value: 'qmodel_38max' },
        { label: 'Qwen3.8-Plus', value: 'qmodel_38plus' },
      ].slice(0, count);
      const commands: SlashCommand[] = [
        {
          name: 'model',
          description: 'Select a model',
          kind: CommandKind.BUILT_IN,
          autoExecute: false,
          completion: (_context, partial) =>
            models.filter(
              (model) =>
                model.label.startsWith(partial) ||
                model.value.startsWith(partial),
            ),
          action: vi.fn(),
        },
      ];
      const { stdin, lastFrame, unmount } = await renderWithProviders(
        <FooterLifecycleHarness
          config={config}
          commands={commands}
          onSubmit={onSubmit}
        />,
        { config },
      );

      await act(async () => {
        stdin.write('/model Qwen');
      });
      await waitFor(() => expect(lastFrame()).toContain('Qwen3.8-Max'));

      await act(async () => {
        stdin.write('\r');
      });
      await waitFor(() => expect(lastFrame()).toContain('/model qmodel_38max'));
      expect(onSubmit).not.toHaveBeenCalled();

      await act(async () => {
        stdin.write('\r');
      });
      await waitFor(() =>
        expect(onSubmit.mock.calls[0]?.[0]).toBe('/model qmodel_38max'),
      );
      unmount();
    },
  );
});
