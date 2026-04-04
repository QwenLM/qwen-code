/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { t } from '../../../../i18n/index.js';
import type { AuthenticateStepProps } from '../types.js';
import { useConfig } from '../../../contexts/ConfigContext.js';
import {
  MCPOAuthProvider,
  MCPOAuthTokenStorage,
  getErrorMessage,
} from '@qwen-code/qwen-code-core';
import type { OAuthDisplayPayload } from '@qwen-code/qwen-code-core';
import { appEvents, AppEvent } from '../../../../utils/events.js';

type AuthState = 'idle' | 'authenticating' | 'success' | 'error';

const AUTO_BACK_DELAY_MS = 2000;

export const AuthenticateStep: React.FC<AuthenticateStepProps> = ({
  server,
  onBack,
}) => {
  const config = useConfig();
  const [authState, setAuthState] = useState<AuthState>('idle');
  const [messages, setMessages] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isRunning = useRef(false);

  const runAuthentication = useCallback(async () => {
    if (!server || !config || isRunning.current) return;
    isRunning.current = true;

    setAuthState('authenticating');
    setMessages([]);
    setErrorMessage(null);

    // Listen for OAuth display messages - supports both plain strings and
    // structured i18n messages ({ key, params }) emitted by the core layer.
    const displayListener = (message: OAuthDisplayPayload) => {
      const text =
        typeof message === 'string' ? message : t(message.key, message.params);
      setMessages((prev) => [...prev, text]);
    };
    appEvents.on(AppEvent.OauthDisplayMessage, displayListener);

    try {
      setMessages([
        t("Starting OAuth authentication for MCP server '{{name}}'...", {
          name: server.name,
        }),
      ]);

      let oauthConfig = server.config.oauth;
      if (!oauthConfig) {
        oauthConfig = { enabled: false };
      }

      const mcpServerUrl = server.config.httpUrl || server.config.url;
      const authProvider = new MCPOAuthProvider(new MCPOAuthTokenStorage());
      await authProvider.authenticate(
        server.name,
        oauthConfig,
        mcpServerUrl,
        appEvents,
      );

      setMessages((prev) => [
        ...prev,
        t("Successfully authenticated and refreshed tools for '{{name}}'.", {
          name: server.name,
        }),
      ]);

      // Trigger tool re-discovery to pick up authenticated server
      const toolRegistry = config.getToolRegistry();
      if (toolRegistry) {
        setMessages((prev) => [
          ...prev,
          t("Re-discovering tools from '{{name}}'...", {
            name: server.name,
          }),
        ]);
        await toolRegistry.discoverToolsForServer(server.name);

        // Show discovered tool count
        const discoveredTools = toolRegistry.getToolsByServer(server.name);
        setMessages((prev) => [
          ...prev,
          t("Discovered {{count}} tool(s) from '{{name}}'.", {
            count: String(discoveredTools.length),
            name: server.name,
          }),
        ]);
      }

      // Update the client with the new tools
      const geminiClient = config.getGeminiClient();
      if (geminiClient) {
        await geminiClient.setTools();
      }

      setMessages((prev) => [
        ...prev,
        t('Authentication complete. Returning to server details...'),
      ]);

      setAuthState('success');
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
      setAuthState('error');
    } finally {
      isRunning.current = false;
      appEvents.removeListener(AppEvent.OauthDisplayMessage, displayListener);
    }
  }, [server, config]);

  useEffect(() => {
    runAuthentication();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-navigate back after authentication succeeds
  useEffect(() => {
    if (authState !== 'success') return;
    const timer = setTimeout(() => {
      onBack();
    }, AUTO_BACK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [authState, onBack]);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onBack();
      }
    },
    { isActive: true },
  );

  if (!server) {
    return (
      <Box>
        <Text color={theme.status.error}>{t('No server selected')}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      {/* Server info */}
      <Box>
        <Text color={theme.text.secondary}>
          {t('Server:')} {server.name}
        </Text>
      </Box>

      {/* Progress messages */}
      {messages.length > 0 && (
        <Box flexDirection="column">
          {messages.map((msg, i) => (
            <Text key={i} color={theme.text.secondary}>
              {msg}
            </Text>
          ))}
        </Box>
      )}

      {/* Error message */}
      {authState === 'error' && errorMessage && (
        <Box>
          <Text color={theme.status.error}>{errorMessage}</Text>
        </Box>
      )}

      {/* Action hints */}
      <Box>
        {authState === 'authenticating' && (
          <Text color={theme.text.secondary}>
            {t('Authenticating... Please complete the login in your browser.')}
          </Text>
        )}
        {authState === 'success' && (
          <Text color={theme.status.success}>
            {t('Authentication successful.')}
          </Text>
        )}
      </Box>
    </Box>
  );
};
