/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Box, Static, Text } from 'ink';
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
 *
 * We terminate with BEL (\x07) rather than ST (ESC \\). Both are valid
 * per the OSC 8 spec, but Ink's renderer uses @alcalzone/ansi-tokenize,
 * which only recognizes OSC 8 sequences ended with BEL.
 */
function osc8Hyperlink(url: string, label = url): string {
  return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;
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
  const [authState, setAuthState] = useState<AuthState>('idle');
  const [messages, setMessages] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<
    { status: 'idle' } | { status: 'copied' | 'unsupported'; nonce: number }
  >({ status: 'idle' });
  const isRunning = useRef(false);

  // We emit the authorization URL through <Static> as a single logical
  // line whose Ink-level box is sized to the URL length. That prevents
  // Ink (and wrap-ansi) from splitting the URL across Ink rows — the
  // terminal is the one that wraps the line visually. Because the whole
  // URL is a single OSC 8 hyperlink sequence, the hyperlink state
  // persists across the terminal's soft-wrap boundaries, so every
  // visible line stays clickable. The item is keyed by URL so a fresh
  // auth attempt emits a new line without redrawing the previous one.
  const staticAuthUrlItems = useMemo(
    () => (authUrl ? [{ key: authUrl, url: authUrl }] : []),
    [authUrl],
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
      {/*
        Render the authorization URL through <Static>, which writes
        permanently to stdout above the dynamic UI. The inner Box is
        sized to the URL length so Ink does not wrap the URL — the
        terminal wraps it visually, and the single OSC 8 hyperlink state
        carries across those soft-wrap boundaries, keeping every
        wrapped line clickable in terminals that support OSC 8.
      */}
      <Static items={staticAuthUrlItems}>
        {(item) => (
          <Box key={item.key} width={item.url.length}>
            <Text color={theme.text.accent}>{osc8Hyperlink(item.url)}</Text>
          </Box>
        )}
      </Static>

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
