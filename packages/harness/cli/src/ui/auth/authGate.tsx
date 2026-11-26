/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  AuthType,
  QWEN_SUBSCRIPTION_PROVIDER_ID,
  QwenSubscriptionSession,
  runLogger,
} from '@qwen-code/core';
import type { LoadedSettings } from '../../config/settings.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { theme } from '../semantic-colors.js';
import type { SessionGate, SessionGateProps } from '../sessionGate.js';
import { AuthDialog } from './AuthDialog.js';
import {
  getAuthGateRequest,
  subscribeAuthGate,
} from './authFlow.js';

type GatePhase = 'checking' | 'applying' | 'required' | 'ready';

/**
 * A stored membership login only counts as usable when its token can still be
 * produced. A rejected refresh removes the credentials here, so the settings
 * provider entry stops counting and the gate falls back to sign-in.
 */
async function subscriptionSessionUsable(
  settings: LoadedSettings,
): Promise<boolean> {
  if (
    settings.merged.security?.auth?.selectedType !== AuthType.QWEN_SUBSCRIPTION
  ) {
    return true;
  }
  const session = new QwenSubscriptionSession();
  if (!session.isSignedIn()) return false;
  try {
    await session.getAccessToken();
    return true;
  } catch (error) {
    runLogger.debug(
      `[auth-gate] subscription session unusable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * Open-source session gate: when the session has no usable model source, the
 * connect-provider flow takes over until a provider or the Qoder account is
 * connected. It never reads the commercial Qoder auth manager.
 */
export function createAuthGate(): SessionGate {
  function AuthGate({ onStateChange }: SessionGateProps): React.JSX.Element | null {
    const config = useConfig();
    const settings = useSettings();
    const [phase, setPhase] = useState<GatePhase>('checking');
    const [hadModels, setHadModels] = useState(false);
    const handledRequest = useRef(0);
    const request = useSyncExternalStore(
      subscribeAuthGate,
      getAuthGateRequest,
    );

    const check = useCallback(async (): Promise<boolean> => {
      const subscriptionUsable = await subscriptionSessionUsable(settings);
      try {
        const models = await config.getModelProviderManager().listModels();
        const ready = models.length > 0 && subscriptionUsable;
        // Keep Esc available when another provider can still serve the
        // session; a broken subscription alone keeps the gate mandatory.
        const foreignModels = models.filter(
          (model) => model.source !== QWEN_SUBSCRIPTION_PROVIDER_ID,
        );
        runLogger.debug(
          `[auth-gate] provider models=${models.length} subscription=${subscriptionUsable} ready=${ready}`,
        );
        setHadModels(ready || foreignModels.length > 0);
        setPhase(ready ? 'ready' : 'required');
        return ready;
      } catch (error) {
        runLogger.warn('[auth-gate] model listing failed', error);
        setPhase('required');
        return false;
      }
    }, [config, settings]);

    // /auth reopens the flow; /logout only asks for a re-check.
    useEffect(() => {
      if (!request || request.id === handledRequest.current) return;
      handledRequest.current = request.id;
      if (request.kind === 'login') {
        setPhase('required');
      } else {
        void check();
      }
    }, [request, check]);

    useEffect(() => {
      void check();
    }, [check]);

    useEffect(() => {
      onStateChange({
        status:
          phase === 'checking' || phase === 'applying'
            ? 'checking'
            : phase === 'ready'
              ? 'ready'
              : 'awaiting',
        // Keep the composer unmounted while the new provider is being
        // applied; a settings reload must not race a live input.
        visible: phase === 'applying' || phase === 'required',
      });
    }, [onStateChange, phase]);

    if (phase === 'applying') {
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.text.secondary}>Connecting provider…</Text>
        </Box>
      );
    }
    if (phase !== 'required') return null;
    return (
      <AuthDialog
        config={config}
        settings={settings}
        canClose={hadModels}
        onClose={() => setPhase('ready')}
        onDone={(selection) => {
          // Unmount the dialog first; the registry reload and the persisted
          // model switch run before the composer comes back.
          setPhase(selection ? 'applying' : 'checking');
          void (async () => {
            if (selection) {
              await config.reloadModelConfigFromDisk().catch((error) => {
                runLogger.warn(
                  '[auth-gate] provider registry refresh failed',
                  error,
                );
              });
              const saved = await config
                .setModel(selection.modelKey, false)
                .catch((error) => {
                  runLogger.warn('[auth-gate] model switch failed', error);
                  return false;
                });
              if (!saved) {
                runLogger.warn(
                  `[auth-gate] model selection was not persisted: ${selection.modelKey}`,
                );
              }
              // The local switch is complete; mount the composer before the
              // catalog check (which may hit the network) settles.
              setPhase('ready');
            }
            await check();
          })();
        }}
      />
    );
  }
  return AuthGate;
}
