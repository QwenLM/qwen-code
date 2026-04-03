/**
 * @license
 * Copyright 2025 ProtoLabs
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../semantic-colors.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';

/**
 * Compact voice status button rendered in the Footer right section.
 *
 * Visual states:
 *   disabled / not enabled → dim  "🎤 /voice enable"
 *   enabled, no backend    → dim  "🎤 no mic"
 *   idle                   →      "🎤 ctrl+space"
 *   recording              → red  "● REC"
 *   transcribing           → dim  "◌ STT…"
 *   error                  → red  "✗ mic err"
 *
 * Keyboard: ctrl+space (existing shortcut)
 * Focus:    Tab to focus this button, Enter/Space to toggle
 */
export const VoiceMicButton: React.FC = () => {
  const { voiceEnabled, voiceBackendAvailable, voiceState } = useUIState();
  const { onVoiceToggle } = useUIActions();

  // Let Enter activate the button when the user uses keyboard focus
  useInput(
    (input, key) => {
      if (key.return || input === ' ') {
        if (voiceEnabled && voiceBackendAvailable) {
          onVoiceToggle();
        }
      }
    },
    { isActive: voiceEnabled && voiceBackendAvailable },
  );

  if (!voiceEnabled) {
    return (
      <Box>
        <Text dimColor>🎤 </Text>
        <Text color={theme.text.secondary} dimColor>
          /voice enable
        </Text>
      </Box>
    );
  }

  if (!voiceBackendAvailable) {
    return (
      <Box>
        <Text dimColor>🎤 no mic</Text>
      </Box>
    );
  }

  if (voiceState === 'recording') {
    return (
      <Box>
        <Text color={theme.status.error} bold>
          ● REC
        </Text>
      </Box>
    );
  }

  if (voiceState === 'transcribing') {
    return (
      <Box>
        <Text dimColor>◌ STT…</Text>
      </Box>
    );
  }

  if (voiceState === 'error') {
    return (
      <Box>
        <Text color={theme.status.errorDim ?? theme.status.error}>
          ✗ mic err
        </Text>
      </Box>
    );
  }

  // idle + available
  return (
    <Box>
      <Text color={theme.text.secondary}>🎤 ctrl+space</Text>
    </Box>
  );
};
