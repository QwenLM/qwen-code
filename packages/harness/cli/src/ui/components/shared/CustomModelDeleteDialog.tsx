/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef } from 'react';
import { Box, Text } from 'ink';
import type { Config } from '@qwen-code/core';
import {
  deleteLocalProviderFromTui,
  getLocalProviderDeletionBlock,
} from '../../utils/localCustomModels.js';
import { useI18nService } from '../../i18n/index.js';
import { theme } from '../../semantic-colors.js';
import { RadioButtonSelect } from './RadioButtonSelect.js';

export function CustomModelDeleteDialog({
  config,
  modelKey,
  isLocalProvider,
  name,
  currentModel,
  onDeleteLegacy,
  onDeleted,
  onClose,
}: {
  config?: Config;
  modelKey: string;
  isLocalProvider: boolean;
  name: string;
  currentModel?: string;
  onDeleteLegacy: () => void;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const i18n = useI18nService();
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const busy = useRef(false);
  const provider = config
    ?.getCustomProviderRegistry()
    .getPublicProviders()
    .find((entry) => entry.models.some((model) => model.key === modelKey));
  const deletionBlock = isLocalProvider
    ? config
      ? getLocalProviderDeletionBlock(config, modelKey)
      : 'unavailable'
    : undefined;
  const current =
    modelKey === currentModel ||
    provider?.models.some(
      (model) =>
        model.key === currentModel || model.displayName === currentModel,
    );
  const remove = async () => {
    if (busy.current || current || deletionBlock) return;
    busy.current = true;
    setStatus('saving');
    try {
      if (isLocalProvider && config)
        await deleteLocalProviderFromTui(config, modelKey);
      else onDeleteLegacy();
      onDeleted();
    } catch {
      setStatus('error');
    } finally {
      busy.current = false;
    }
  };
  return (
    <Box flexDirection="column">
      <Text bold>{i18n.get('models.customProvider.deleteTitle')}</Text>
      <Text>{name}</Text>
      {deletionBlock && (
        <Text color={theme.status.warning}>
          {i18n.get(
            deletionBlock === 'shared'
              ? 'models.local.deleteShared'
              : 'models.local.deleteSource',
          )}
        </Text>
      )}
      {current && (
        <Text color={theme.status.warning}>
          {i18n.get('models.local.switchBeforeDelete')}
        </Text>
      )}
      {status === 'error' && (
        <Text color={theme.status.error}>
          {i18n.get('models.local.saveFailed')}
        </Text>
      )}
      <RadioButtonSelect
        isFocused={status !== 'saving'}
        items={[
          {
            key: 'cancel',
            value: false,
            label: i18n.get('models.local.cancel'),
          },
          ...(!current && !deletionBlock
            ? [
                {
                  key: 'delete',
                  value: true,
                  label: i18n.get('models.local.delete'),
                },
              ]
            : []),
        ]}
        onCancel={onClose}
        onSelect={(confirmed) => (confirmed ? void remove() : onClose())}
      />
    </Box>
  );
}
