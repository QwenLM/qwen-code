/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
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
const COPY_FEEDBACK_MS = 2000;

/**
 * Wrap an OSC sequence for terminal multiplexers so the host terminal
 * receives it. tmux requires a DCS passthrough with inner ESCs doubled;
 * GNU screen uses a plain DCS envelope.
 */
function wrapForMultiplexer(osc: string): string {
  if (process.env['TMUX']) {
    return `\x1bPtmux;${osc.split('\x1b').join('\x1b\x1b')}\x1b\\`;
  }
  if (process.env['STY']) {
    return `\x1bP${osc}\x1b\\`;
  }
  return osc;
}

/**
 * Wrap a URL in an OSC 8 hyperlink escape sequence. Supported terminals
 * (iTerm2, WezTerm, Kitty, Windows Terminal, VS Code, GNOME Terminal, …)
 * render it as a clickable link; terminals without OSC 8 support ignore
 * the escapes and still show the raw text.
 */
function osc8Hyperlink(url: string, label = url): string {
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

/**
 * Slice a string into chunks of up to `width` characters. We pre-split the
 * URL ourselves instead of relying on Ink / wrap-ansi so that:
 *   1. Each visible line is an independent, complete OSC 8 hyperlink
 *      (wrap-ansi preserves SGR codes across wraps but does not re-open
 *      OSC 8 hyperlinks, which would leave all lines but the first
 *      unclickable).
 *   2. No line exceeds the container width, avoiding overflow past the
 *      dialog border.
 */
function sliceIntoLines(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += width) {
    lines.push(text.slice(i, i + width));
  }
  return lines.length > 0 ? lines : [''];
}

/**
 * Copy a string to the user's clipboard using the OSC 52 terminal escape
 * sequence. Works through SSH and most web terminals (iTerm2, Windows
 * Terminal, xterm.js-based emulators) without spawning a subprocess.
 * Returns true if the sequence was written to a TTY; false otherwise.
 * A return of true does not guarantee the terminal accepted the write —
 * some terminals disable OSC 52 by default.
 */
function copyToClipboardViaOsc52(text: string): boolean {
  const base64 = Buffer.from(text, 'utf8').toString('base64');
  const seq = wrapForMultiplexer(`\x1b]52;c;${base64}\x07`);
  const stream = process.stderr.isTTY
    ? process.stderr
    : process.stdout.isTTY
      ? process.stdout
      : null;
  if (!stream) return false;
  try {
    stream.write(seq);
    return true;
  } catch {
    return false;
  }
}

export const AuthenticateStep: React.FC<AuthenticateStepProps> = ({
  server,
  onBack,
}) => {
  const config = useConfig();
  const { columns } = useTerminalSize();
  const [authState, setAuthState] = useState<AuthState>('idle');
  const [messages, setMessages] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<
    { status: 'idle' } | { status: 'copied' | 'unsupported'; nonce: number }
  >({ status: 'idle' });
  const isRunning = useRef(false);

  // MCPManagementDialog wraps us in a box of `columns - 4` with a
  // single-line border and padding of 1 on each side, so our usable
  // content width is `columns - 8`. Clamp low so the URL still renders
  // on extremely narrow terminals.
  const urlLineWidth = Math.max(20, columns - 8);
  const authUrlLines = useMemo(
    () => (authUrl ? sliceIntoLines(authUrl, urlLineWidth) : []),
    [authUrl, urlLineWidth],
  );

  const runAuthentication = useCallback(async () => {
    if (!server || !config || isRunning.current) return;
    isRunning.current = true;

    setAuthState('authenticating');
    setMessages([]);
    setErrorMessage(null);

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
    }
  }, [server, config]);

  // Subscribe to OAuth events for the lifetime of this component. Keeping
  // the subscription tied to mount/unmount (rather than to runAuthentication's
  // async flow) ensures listeners are released immediately on unmount even if
  // the authentication promise is still pending.
  useEffect(() => {
    const displayListener = (message: OAuthDisplayPayload) => {
      const text =
        typeof message === 'string' ? message : t(message.key, message.params);
      setMessages((prev) => [...prev, text]);
    };
    const authUrlListener = (url: string) => {
      setAuthUrl(url);
    };
    appEvents.on(AppEvent.OauthDisplayMessage, displayListener);
    appEvents.on(AppEvent.OauthAuthUrl, authUrlListener);
    return () => {
      appEvents.removeListener(AppEvent.OauthDisplayMessage, displayListener);
      appEvents.removeListener(AppEvent.OauthAuthUrl, authUrlListener);
    };
  }, []);

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
        return;
      }
      if (
        key.name === 'c' &&
        !key.ctrl &&
        !key.meta &&
        !key.paste &&
        authUrl &&
        authState === 'authenticating'
      ) {
        const ok = copyToClipboardViaOsc52(authUrl);
        setCopyState({
          status: ok ? 'copied' : 'unsupported',
          nonce: Date.now(),
        });
      }
    },
    { isActive: true },
  );

  useEffect(() => {
    if (copyState.status === 'idle') return;
    const timer = setTimeout(
      () => setCopyState({ status: 'idle' }),
      COPY_FEEDBACK_MS,
    );
    return () => clearTimeout(timer);
    // Depend on the nonce so repeated presses reset the timer.
  }, [copyState]);

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
      <Box flexDirection="column">
        {authState === 'authenticating' && (
          <Text color={theme.text.secondary}>
            {t('Authenticating... Please complete the login in your browser.')}
          </Text>
        )}
        {authState === 'authenticating' && authUrl && (
          <>
            <Box flexDirection="column" marginTop={1}>
              {authUrlLines.map((line, i) => (
                <Text key={i} color={theme.text.accent} wrap="truncate">
                  {osc8Hyperlink(authUrl, line)}
                </Text>
              ))}
            </Box>
            <Text
              bold={copyState.status === 'idle'}
              color={
                copyState.status === 'copied'
                  ? theme.status.success
                  : copyState.status === 'unsupported'
                    ? theme.status.warning
                    : theme.text.accent
              }
            >
              {copyState.status === 'copied'
                ? t(
                    'Copy request sent to your terminal. If paste is empty, copy the URL above manually.',
                  )
                : copyState.status === 'unsupported'
                  ? t('Cannot write to terminal — copy the URL above manually.')
                  : t(
                      'Press c to copy the authorization URL to your clipboard.',
                    )}
            </Text>
          </>
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
