import { useState, useCallback, useEffect } from 'react';
import * as fs from 'node:fs';
import {
  type Config,
  logUserFeedback,
  UserFeedbackEvent,
  type UserFeedbackRating,
  isNodeError,
  AuthType,
} from '@qwen-code/qwen-code-core';
import { StreamingState, MessageType, type HistoryItem } from '../types.js';
import {
  SettingScope,
  type LoadedSettings,
  USER_SETTINGS_PATH,
} from '../../config/settings.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import stripJsonComments from 'strip-json-comments';

const FEEDBACK_SHOW_PROBABILITY = 0.25; // 25% probability of showing feedback dialog
const MIN_TOOL_CALLS = 10; // Minimum tool calls to show feedback dialog
const MIN_USER_MESSAGES = 5; // Minimum user messages to show feedback dialog

// Fatigue mechanism constants
const FEEDBACK_COOLDOWN_HOURS = 24; // Hours to wait before showing feedback dialog again

/**
 * Check if the last message in the conversation history is an AI response
 */
const lastMessageIsAIResponse = (history: HistoryItem[]): boolean =>
  history.length > 0 && history[history.length - 1].type === MessageType.GEMINI;

/**
 * Read feedbackLastShownTimestamp directly from the user settings file
 */
const getFeedbackLastShownTimestampFromFile = (): number => {
  try {
    if (fs.existsSync(USER_SETTINGS_PATH)) {
      const content = fs.readFileSync(USER_SETTINGS_PATH, 'utf-8');
      const settings = JSON.parse(stripJsonComments(content));
      return settings?.ui?.feedbackLastShownTimestamp ?? 0;
    }
  } catch (error) {
    if (isNodeError(error) && error.code !== 'ENOENT') {
      console.warn(
        'Failed to read feedbackLastShownTimestamp from settings file:',
        error,
      );
    }
  }
  return 0;
};

/**
 * Check if we should show the feedback dialog based on fatigue mechanism
 */
const shouldShowFeedbackBasedOnFatigue = (): boolean => {
  const feedbackLastShownTimestamp = getFeedbackLastShownTimestampFromFile();

  const now = Date.now();
  const timeSinceLastShown = now - feedbackLastShownTimestamp;
  const cooldownMs = FEEDBACK_COOLDOWN_HOURS * 60 * 60 * 1000;

  return timeSinceLastShown >= cooldownMs;
};

/**
 * Check if the session meets the minimum requirements for showing feedback
 * Either tool calls > 10 OR user messages > 5
 */
const meetsMinimumSessionRequirements = (
  sessionStats: SessionStatsState,
): boolean => {
  const toolCallsCount = sessionStats.metrics.tools.totalCalls;
  const userMessagesCount = sessionStats.promptCount;

  return (
    toolCallsCount > MIN_TOOL_CALLS || userMessagesCount > MIN_USER_MESSAGES
  );
};

export interface UseFeedbackDialogProps {
  config: Config;
  settings: LoadedSettings;
  streamingState: StreamingState;
  history: HistoryItem[];
  sessionStats: SessionStatsState;
}

export const useFeedbackDialog = ({
  config,
  settings,
  streamingState,
  history,
  sessionStats,
}: UseFeedbackDialogProps) => {
  // Feedback dialog state
  const [isFeedbackDialogOpen, setIsFeedbackDialogOpen] = useState(false);

  const openFeedbackDialog = useCallback(() => {
    setIsFeedbackDialogOpen(true);

    // Record the timestamp when feedback dialog is shown (fire and forget)
    settings.setValue(
      SettingScope.User,
      'ui.feedbackLastShownTimestamp',
      Date.now(),
    );
  }, [settings]);

  const closeFeedbackDialog = useCallback(
    () => setIsFeedbackDialogOpen(false),
    [],
  );

  const submitFeedback = useCallback(
    (rating: number) => {
      // Create and log the feedback event
      const feedbackEvent = new UserFeedbackEvent(
        sessionStats.sessionId,
        rating as UserFeedbackRating,
        config.getModel(),
        config.getApprovalMode(),
      );

      logUserFeedback(config, feedbackEvent);
      closeFeedbackDialog();
    },
    [config, sessionStats, closeFeedbackDialog],
  );

  useEffect(() => {
    const checkAndShowFeedback = () => {
      if (streamingState === StreamingState.Idle && history.length > 0) {
        // Show feedback dialog if:
        // 1. User is authenticated via QWEN_OAUTH
        // 2. Qwen logger is enabled (required for feedback submission)
        // 3. User feedback is enabled in settings
        // 4. The last message is an AI response
        // 5. Random chance (25% probability)
        // 6. Meets minimum requirements (tool calls > 10 OR user messages > 5)
        // 7. Fatigue mechanism allows showing (not shown recently across sessions)
        if (
          config.getAuthType() !== AuthType.QWEN_OAUTH ||
          !config.getUsageStatisticsEnabled() ||
          settings.merged.ui?.enableUserFeedback === false ||
          !lastMessageIsAIResponse(history) ||
          Math.random() > FEEDBACK_SHOW_PROBABILITY ||
          !meetsMinimumSessionRequirements(sessionStats)
        ) {
          return;
        }

        // Check fatigue mechanism (synchronous)
        if (shouldShowFeedbackBasedOnFatigue()) {
          openFeedbackDialog();
        }
      }
    };

    checkAndShowFeedback();
  }, [
    streamingState,
    history,
    sessionStats,
    isFeedbackDialogOpen,
    openFeedbackDialog,
    settings.merged.ui?.enableUserFeedback,
    config,
  ]);

  return {
    isFeedbackDialogOpen,
    openFeedbackDialog,
    closeFeedbackDialog,
    submitFeedback,
  };
};
