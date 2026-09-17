/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { RadioButtonSelect } from '../../shared/RadioButtonSelect.js';
import {
  redactUrlCredentials,
  type Extension,
} from '@qwen-code/qwen-code-core';
import { t } from '../../../../i18n/index.js';
import { extensionComponentsSummary } from '../../../../services/extension-components-summary.js';
import { stripUnsafeCharacters } from '../../../utils/textUtils.js';

export type PluginDetailAction =
  | 'toggle'
  | 'favorite'
  | 'change-scope'
  | 'mark-update'
  | 'update'
  | 'uninstall';

interface PluginDetailViewProps {
  extension: Extension;
  scope: string;
  isFavorite: boolean;
  hasUpdateAvailable: boolean;
  isFocused: boolean;
  /** Whether to offer the favorite toggle (hidden in the Sources tab). */
  showFavorite?: boolean;
  /**
   * Action the cursor starts on. A busy action replaces this view with a
   * loading line, so it is remounted once the action settles and would
   * otherwise re-seed the cursor to the first row — keep it on the action the
   * user activated instead. Missing (or no longer offered) falls back to the
   * first row.
   */
  initialAction?: PluginDetailAction;
  onAction: (action: PluginDetailAction) => void;
}

const LABEL_WIDTH = 14;

const InfoRow = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <Box>
    <Box width={LABEL_WIDTH} flexShrink={0}>
      <Text color={theme.text.primary}>{label}</Text>
    </Box>
    <Box flexGrow={1}>
      <Text>{children}</Text>
    </Box>
  </Box>
);

export const PluginDetailView = ({
  extension,
  scope,
  isFavorite,
  hasUpdateAvailable,
  isFocused,
  showFavorite = true,
  initialAction,
  onAction,
}: PluginDetailViewProps) => {
  const ext = extension;
  const isActive = ext.isActive;

  const actions = useMemo(() => {
    const items: Array<{
      key: string;
      label: string;
      value: PluginDetailAction;
    }> = [
      {
        key: 'toggle',
        label: isActive ? t('Disable') : t('Enable'),
        value: 'toggle',
      },
      ...(showFavorite
        ? [
            {
              key: 'favorite',
              label: isFavorite
                ? t('Remove from Favorites')
                : t('Add to Favorites'),
              value: 'favorite' as const,
            },
          ]
        : []),
      {
        key: 'change-scope',
        label: t('Change scope'),
        value: 'change-scope',
      },
      {
        key: 'mark-update',
        label: t('Mark for Update'),
        value: 'mark-update',
      },
      ...(hasUpdateAvailable
        ? [{ key: 'update', label: t('Update Now'), value: 'update' as const }]
        : []),
      {
        key: 'uninstall',
        label: t('Uninstall'),
        value: 'uninstall',
      },
    ];
    return items;
  }, [isActive, isFavorite, hasUpdateAvailable, showFavorite]);

  // Cursor seed, resolved ONCE per mount against the rows offered at that
  // moment: the index of `initialAction`, or the first row when it is absent
  // (no request, or the action is already gone — e.g. "Update Now" after a
  // successful update).
  //
  // Deliberately not re-derived from the rows as they are now: a *changed*
  // `initialIndex` is how the list is told to move the cursor (the INITIALIZE
  // branch in useSelectionList treats it as an override of the user's cursor).
  // So re-deriving it when a row disappears mid-mount — e.g. a background
  // check landing and taking "Update Now" away — would drag the highlight off
  // the row the user is on and onto the first one ("Disable"), and the next
  // Enter would run that instead.
  const [initialIndex] = useState(() => {
    const index = actions.findIndex((item) => item.value === initialAction);
    return index < 0 ? 0 : index;
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <InfoRow label={t('Name:')}>{ext.name}</InfoRow>
        <InfoRow label={t('Version:')}>
          {stripUnsafeCharacters(ext.version ?? '')}
        </InfoRow>
        <InfoRow label={t('Scope:')}>{scope}</InfoRow>
        <InfoRow label={t('Status:')}>
          <Text color={isActive ? theme.status.success : theme.text.secondary}>
            {isActive ? t('active') : t('disabled')}
          </Text>
          {isFavorite ? <Text color={theme.status.warning}> ★</Text> : null}
        </InfoRow>
        {ext.installMetadata && (
          <InfoRow label={t('Source:')}>
            {redactUrlCredentials(ext.installMetadata.source)}
          </InfoRow>
        )}
        {ext.installMetadata?.originSource && (
          <InfoRow label={t('Origin:')}>
            {ext.installMetadata.originSource}
          </InfoRow>
        )}
        <InfoRow label={t('Components:')}>
          {extensionComponentsSummary(ext)}
        </InfoRow>
      </Box>

      <Box flexDirection="column">
        <Text color={theme.text.secondary}>{t('Actions')}</Text>
        <RadioButtonSelect
          items={actions}
          initialIndex={initialIndex}
          isFocused={isFocused}
          showNumbers={false}
          onSelect={onAction}
        />
      </Box>
    </Box>
  );
};
