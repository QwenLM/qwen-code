/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createElement, useMemo, useState } from 'react';
import { CommandDescriptionContext } from '../contexts/CommandDescriptionContext.js';
import { describe, expect, it } from 'vitest';
import { renderHook } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
} from '../commands/types.js';
import type { Suggestion } from '../components/SuggestionsDisplay.js';
import { DefaultI18nService, type UiLocale } from '@qwen-code/core';
import { registerCliUiMessages } from '../i18n/register.js';
const service = new DefaultI18nService();
registerCliUiMessages(service);
function getMessageTemplate(locale: UiLocale, key: string): string {
  service.configureUi({
    locale,
    preference: locale,
    dynamicContentEnabled: false,
  });
  return service.getTemplate(key);
}
import { formatMessage } from '../i18n/formatMessage.js';
import type { UiMessageKey } from '../i18n/types.js';
import type { I18nService } from '@qwen-code/core';
import { useSlashCompletion } from './useSlashCompletion.js';

const makeT =
  (locale: 'en' | 'zh-CN'): I18nService['get'] =>
  (key, params) =>
    formatMessage(getMessageTemplate(locale, key as UiMessageKey), params);

const HELP_COMMANDS = [
  {
    name: 'help',
    description: 'Show application help and keyboard shortcuts',
    kind: CommandKind.BUILT_IN,
  },
] as const;

const NESTED_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'goal',
    description: 'Manage the current goal',
    kind: CommandKind.BUILT_IN,
    subCommands: [
      {
        name: 'status',
        description: 'Show current goal status',
        kind: CommandKind.BUILT_IN,
      },
    ],
  },
  {
    name: 'custom',
    description: 'Manage custom commands',
    kind: CommandKind.BUILT_IN,
    subCommands: [
      {
        name: 'status',
        description: 'Custom status description',
        kind: CommandKind.BUILT_IN,
      },
    ],
  },
  {
    name: 'plugins',
    altNames: ['plugin'],
    description: 'Manage plugins',
    kind: CommandKind.BUILT_IN,
    subCommands: [
      {
        name: 'install',
        description: 'Install a plugin',
        kind: CommandKind.BUILT_IN,
      },
      {
        name: 'marketplace',
        altNames: ['market'],
        description: 'Manage plugin marketplaces',
        kind: CommandKind.BUILT_IN,
        subCommands: [
          {
            name: 'add',
            description: 'Add a marketplace',
            kind: CommandKind.BUILT_IN,
          },
        ],
      },
    ],
  },
];

const noop = () => {};
const COMMAND_CONTEXT = {} as CommandContext;

function useHarness(
  locale: 'en' | 'zh-CN',
  query = '/',
  slashCommands: readonly SlashCommand[] = HELP_COMMANDS,
) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const translate = useMemo(() => makeT(locale), [locale]);
  useSlashCompletion({
    enabled: true,
    query,
    slashCommands,
    commandContext: COMMAND_CONTEXT,
    setSuggestions,
    setIsLoadingSuggestions: noop,
    setIsPerfectMatch: noop,
    translate,
    locale,
  });
  return suggestions;
}

describe('useSlashCompletion i18n', () => {
  it('passes product keys to the resolver for canonical subcommand paths', async () => {
    const keys = { 'custom status': 'product.custom.status' };
    const rendered = await renderHook(
      () => useHarness('zh-CN', '/custom st', NESTED_COMMANDS),
      {
        wrapper: ({ children }) =>
          createElement(
            CommandDescriptionContext.Provider,
            { value: keys },
            children,
          ),
      },
    );
    await waitFor(() => {
      expect(rendered.result.current[0]?.description).toBe(
        'product.custom.status',
      );
    });
    rendered.unmount();
  });
  it('updates an open suggestion list when the translator changes', async () => {
    const rendered = await renderHook(
      ({ locale }: { locale: 'en' | 'zh-CN' }) => useHarness(locale),
      { initialProps: { locale: 'en' as 'en' | 'zh-CN' } },
    );

    await waitFor(() => {
      expect(rendered.result.current[0]?.description).toBe(
        'Show application help and keyboard shortcuts',
      );
    });

    rendered.rerender({ locale: 'zh-CN' });
    await waitFor(() => {
      expect(rendered.result.current[0]?.description).toBe(
        '显示应用帮助和键盘快捷键',
      );
    });
    rendered.unmount();
  });

  it('uses the full nested path and keeps the filtered suggestion across locale changes', async () => {
    const rendered = await renderHook(
      ({ locale }: { locale: 'en' | 'zh-CN' }) =>
        useHarness(locale, '/goal st', NESTED_COMMANDS),
      { initialProps: { locale: 'en' as 'en' | 'zh-CN' } },
    );

    await waitFor(() => {
      expect(rendered.result.current).toHaveLength(1);
      expect(rendered.result.current[0]).toMatchObject({
        label: 'status',
        description: 'Show current goal status',
      });
    });

    rendered.rerender({ locale: 'zh-CN' });
    await waitFor(() => {
      expect(rendered.result.current).toHaveLength(1);
      expect(rendered.result.current[0]).toMatchObject({
        label: 'status',
        description: '显示当前目标状态',
      });
    });
    rendered.unmount();
  });

  it('does not collide same-name subcommands from different parents', async () => {
    const rendered = await renderHook(
      () => useHarness('zh-CN', '/custom st', NESTED_COMMANDS),
      { initialProps: undefined },
    );

    await waitFor(() => {
      expect(rendered.result.current).toHaveLength(1);
      expect(rendered.result.current[0]).toMatchObject({
        label: 'status',
        description: 'Custom status description',
      });
    });
    rendered.unmount();
  });

  it.each([
    ['/plugin i', 'install', '安装插件'],
    ['/plugins market a', 'add', '添加插件市场'],
  ] as const)(
    'uses canonical description keys when completing aliases from %s',
    async (query, label, description) => {
      const rendered = await renderHook(
        () => useHarness('zh-CN', query, NESTED_COMMANDS),
        { initialProps: undefined },
      );

      await waitFor(() => {
        expect(rendered.result.current).toHaveLength(1);
        expect(rendered.result.current[0]).toMatchObject({
          label,
          description,
        });
      });
      rendered.unmount();
    },
  );
});
