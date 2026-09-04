/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DaemonClient,
  DaemonSettingDescriptor,
  DaemonWorkspaceSettingsStatus,
} from '@qwen-code/sdk/daemon';
import {
  loadVoiceSettings,
  type VoiceWorkspaceTarget,
} from './voice-workspace-target';

interface VoiceWorkspaceSettingsState {
  descriptor: DaemonSettingDescriptor | undefined;
  reload: () => Promise<DaemonWorkspaceSettingsStatus | undefined>;
}

export function useVoiceWorkspaceSettings(
  client: DaemonClient,
  target: VoiceWorkspaceTarget | undefined,
  enabled: boolean,
  revisionKey: string,
): VoiceWorkspaceSettingsState {
  const requestRef = useRef(0);
  const ownerKey =
    enabled && target?.route === 'workspace-qualified'
      ? target.ownerKey
      : undefined;
  const requestKey = ownerKey
    ? JSON.stringify([ownerKey, revisionKey])
    : undefined;
  const currentRequestKeyRef = useRef(requestKey);
  currentRequestKeyRef.current = requestKey;
  const [state, setState] = useState<{
    ownerKey: string | undefined;
    status: DaemonWorkspaceSettingsStatus | undefined;
  }>({
    ownerKey,
    status: undefined,
  });

  const reload = useCallback(async () => {
    const key = requestKey;
    if (currentRequestKeyRef.current !== key) return undefined;
    const request = ++requestRef.current;
    if (
      !key ||
      !ownerKey ||
      !target ||
      target.route !== 'workspace-qualified'
    ) {
      setState({
        ownerKey,
        status: undefined,
      });
      return undefined;
    }

    setState((current) =>
      current.ownerKey === ownerKey
        ? current
        : {
            ownerKey,
            status: undefined,
          },
    );
    try {
      const status = await loadVoiceSettings(client, target);
      if (
        request === requestRef.current &&
        currentRequestKeyRef.current === key
      ) {
        setState({ ownerKey, status });
      }
      return status;
    } catch {
      return undefined;
    }
  }, [client, ownerKey, requestKey, target]);
  const invalidate = useCallback(() => {
    requestRef.current++;
  }, []);

  useEffect(() => {
    void reload();
    return invalidate;
  }, [invalidate, reload]);

  const current = state.ownerKey === ownerKey ? state : undefined;
  return {
    descriptor: current?.status?.settings.find(
      (setting) => setting.key === 'voiceModel',
    ),
    reload,
  };
}
