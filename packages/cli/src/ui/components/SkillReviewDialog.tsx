/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import type { RadioSelectItem } from './shared/RadioButtonSelect.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';
import type { PendingSkillView } from '../contexts/UIStateContext.js';

type Choice = 'keep' | 'discard' | 'keepAll' | 'discardAll';

export interface SkillReviewDialogProps {
  skills: PendingSkillView[];
  onAccept: (skillName: string) => void;
  onReject: (skillName: string) => void;
  onClose: () => void;
}

export const SkillReviewDialog = ({
  skills,
  onAccept,
  onReject,
  onClose,
}: SkillReviewDialogProps) => {
  // Snapshot the skills on mount. `onAccept`/`onReject` trigger a
  // subscription refresh in the parent that shrinks the live `skills` prop;
  // advancing through a stable snapshot keeps the per-skill flow correct
  // (otherwise resolving the current item shifts indices and skips skills).
  const [snapshot] = useState(() => skills);
  const [index, setIndex] = useState(0);

  useKeypress(
    (key) => {
      if (key.name === 'escape') onClose();
    },
    { isActive: true },
  );

  // Defensive: if mounted with nothing to review, close on the next tick
  // (cannot call a parent callback during render).
  useEffect(() => {
    if (snapshot.length === 0) onClose();
  }, [snapshot.length, onClose]);

  if (index >= snapshot.length) {
    return null;
  }

  const current = snapshot[index]!;

  // Advance to the next snapshot entry; close once the last one is decided.
  const advance = () => {
    if (index + 1 >= snapshot.length) {
      onClose();
    } else {
      setIndex(index + 1);
    }
  };

  const handleSelect = (choice: Choice) => {
    switch (choice) {
      case 'keep':
        onAccept(current.name);
        advance();
        break;
      case 'discard':
        onReject(current.name);
        advance();
        break;
      case 'keepAll':
        for (let i = index; i < snapshot.length; i++) {
          onAccept(snapshot[i]!.name);
        }
        onClose();
        break;
      case 'discardAll':
        for (let i = index; i < snapshot.length; i++) {
          onReject(snapshot[i]!.name);
        }
        onClose();
        break;
      default:
        break;
    }
  };

  const options: Array<RadioSelectItem<Choice>> = [
    { label: t('Keep this skill'), value: 'keep', key: 'keep' },
    { label: t('Discard this skill'), value: 'discard', key: 'discard' },
    { label: t('Keep all remaining'), value: 'keepAll', key: 'keepAll' },
    {
      label: t('Discard all remaining'),
      value: 'discardAll',
      key: 'discardAll',
    },
  ];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.status.warning}
      paddingX={1}
      width="100%"
      marginLeft={1}
    >
      <Text bold color={theme.text.primary}>
        {t('Auto-generated skill — keep it?')} ({index + 1}/{snapshot.length})
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.primary}>{current.name}</Text>
        {current.description ? (
          <Text color={theme.text.secondary}>{current.description}</Text>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <RadioButtonSelect items={options} onSelect={handleSelect} isFocused />
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>{t('Esc to decide later')}</Text>
      </Box>
    </Box>
  );
};
