import { Box, Text } from 'ink';
import type React from 'react';
import { t } from '../i18n/index.js';
import { useUIActions } from './contexts/UIActionsContext.js';
import { useUIState } from './contexts/UIStateContext.js';
import { useKeypress } from './hooks/useKeypress.js';

const FEEDBACK_OPTIONS = {
  GOOD: 1,
  BAD: 2,
  NOT_SURE: 3,
} as const;

const FEEDBACK_OPTION_KEYS = {
  [FEEDBACK_OPTIONS.GOOD]: '1',
  [FEEDBACK_OPTIONS.BAD]: '2',
  [FEEDBACK_OPTIONS.NOT_SURE]: 'any',
} as const;

export const FEEDBACK_DIALOG_KEYS = ['1', '2'] as const;

export const FeedbackDialog: React.FC = () => {
  const uiState = useUIState();
  const uiActions = useUIActions();

  useKeypress(
    (key) => {
      if (key.name === FEEDBACK_OPTION_KEYS[FEEDBACK_OPTIONS.GOOD]) {
        uiActions.submitFeedback(FEEDBACK_OPTIONS.GOOD);
      } else if (key.name === FEEDBACK_OPTION_KEYS[FEEDBACK_OPTIONS.BAD]) {
        uiActions.submitFeedback(FEEDBACK_OPTIONS.BAD);
      } else {
        uiActions.submitFeedback(FEEDBACK_OPTIONS.NOT_SURE);
      }

      uiActions.closeFeedbackDialog();
    },
    { isActive: uiState.isFeedbackDialogOpen },
  );

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text color="cyan">● </Text>
        <Text bold>{t('How is Qwen doing this session? (optional)')}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="cyan">
          {FEEDBACK_OPTION_KEYS[FEEDBACK_OPTIONS.GOOD]}:{' '}
        </Text>
        <Text>{t('Good')}</Text>
        <Text> </Text>
        <Text color="cyan">{FEEDBACK_OPTION_KEYS[FEEDBACK_OPTIONS.BAD]}: </Text>
        <Text>{t('Bad')}</Text>
        <Text> </Text>
        <Text color="cyan">{t('Any other key')}: </Text>
        <Text>{t('Not Sure Yet')}</Text>
      </Box>
    </Box>
  );
};
