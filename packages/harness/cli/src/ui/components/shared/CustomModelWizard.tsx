/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useReducer } from 'react';
import { Box, Text } from 'ink';
import type { Config, CustomModelProviderProtocol } from '@qwen-code/core';
import { LocalCustomModelForm } from './LocalCustomModelForm.js';
import { useI18nService } from '../../i18n/index.js';
import { useRegisterHints } from '../../contexts/HintRegistryContext.js';
import { ProviderSelectionList } from './ProviderSelectionList.js';
import { useRegisterFallbackHandler } from '../../contexts/ActionHandlerRegistry.js';
import { useKeyMatchers } from '../../hooks/useKeyMatchers.js';
import { Command } from '../../key/keyBindings.js';
import { RadioButtonSelect } from './RadioButtonSelect.js';

export type CustomModelWizardEntry = 'openai' | 'anthropic' | 'gemini';

interface Props {
  config?: Config;
  /**
   * Skips the provider page and opens the given protocol directly. Backing out
   * of that protocol closes the wizard, so a host with its own provider page
   * can embed this one for the Custom Provider branch.
   */
  entry?: CustomModelWizardEntry;
  onSaved: (modelKey?: string, applied?: boolean) => void;
  onClose: () => void;
  providerIdPrefix?: string;
}
type State = {
  page: 'provider' | 'protocol' | 'local';
  protocol: CustomModelProviderProtocol;
  focusKey?: string;
};
type Action = { type: 'patch'; patch: Partial<State> };
function reducer(state: State, action: Action): State {
  return { ...state, ...action.patch };
}

export function CustomModelWizard(props: Props) {
  const i18n = useI18nService();
  const [state, dispatch] = useReducer(reducer, {
    page: props.entry
      ? props.entry === 'openai'
        ? 'protocol'
        : 'local'
      : 'provider',
    protocol: props.entry ?? 'openai',
  });
  // Account gating is the caller's job; this only checks that providers are
  // stored locally rather than managed by the server.
  const customAvailable =
    props.config?.getCustomProviderAccessMode() === 'local';
  const backToProvider = () =>
    props.entry
      ? props.onClose()
      : dispatch({ type: 'patch', patch: { page: 'provider' } });
  const keyMatchers = useKeyMatchers();
  useRegisterFallbackHandler(
    'Select',
    (key) => {
      if (!customAvailable || !keyMatchers[Command.PROVIDER_CUSTOM](key))
        return false;
      dispatch({
        type: 'patch',
        patch: { focusKey: state.focusKey ?? '__local_openai__' },
      });
      return true;
    },
    state.page === 'provider',
  );
  useRegisterHints(
    'CustomModelWizard',
    state.page === 'local'
      ? []
      : [
          {
            label:
              state.page === 'provider'
                ? [
                    i18n.get('models.local.providerNavigate'),
                    customAvailable ? i18n.get('models.local.jumpCustom') : '',
                    i18n.get('models.local.wizardKeys'),
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : i18n.get('models.local.wizardKeys'),
            order: 20,
          },
        ],
  );

  if (state.page === 'local' && props.config)
    return (
      <LocalCustomModelForm
        config={props.config}
        protocol={state.protocol}
        onClose={() =>
          state.protocol === 'openai'
            ? dispatch({ type: 'patch', patch: { page: 'protocol' } })
            : backToProvider()
        }
        onSaved={props.onSaved}
        providerIdPrefix={props.providerIdPrefix}
      />
    );
  if (state.page === 'provider') {
    const items = customAvailable
      ? [
          {
            key: '__local_openai__',
            label: 'OpenAI-compatible...',
            value: '__local_openai__',
            sublabel: i18n.get('models.local.openai'),
          },
          {
            key: '__local_anthropic__',
            label: 'Anthropic-compatible...',
            value: '__local_anthropic__',
            sublabel: i18n.get('models.local.anthropic'),
          },
          {
            key: '__local_gemini__',
            label: 'Gemini-compatible...',
            value: '__local_gemini__',
            sublabel: i18n.get('models.local.gemini'),
          },
        ]
      : [];
    return (
      <Box flexDirection="column">
        <ProviderSelectionList
          items={items}
          customCount={items.length}
          customTitle={i18n.get('models.local.customProviders')}
          presetTitle={i18n.get('models.local.presets')}
          focusKey={state.focusKey}
          customFocus={state.focusKey}
          onHighlight={(focusKey) =>
            dispatch({ type: 'patch', patch: { focusKey } })
          }
          onCancel={props.onClose}
          onSelect={(value) =>
            dispatch({
              type: 'patch',
              patch: {
                focusKey: value,
                page: value === '__local_openai__' ? 'protocol' : 'local',
                protocol:
                  value === '__local_openai__'
                    ? 'openai'
                    : value === '__local_anthropic__'
                      ? 'anthropic'
                      : 'gemini',
              },
            })
          }
        />
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text bold>OpenAI-compatible</Text>
      <RadioButtonSelect
        items={[
          { key: 'chat', label: 'Chat Completions', value: 'openai' as const },
          {
            key: 'responses',
            label: 'Responses',
            value: 'openai-responses' as const,
          },
        ]}
        initialIndex={state.protocol === 'openai-responses' ? 1 : 0}
        onCancel={backToProvider}
        onSelect={(protocol) =>
          dispatch({ type: 'patch', patch: { protocol, page: 'local' } })
        }
      />
    </Box>
  );
}
