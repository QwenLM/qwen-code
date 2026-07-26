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
  const targetKey =
    enabled && target?.route === 'workspace-qualified'
      ? JSON.stringify([target.ownerKey, revisionKey])
      : undefined;
  const currentKeyRef = useRef(targetKey);
  currentKeyRef.current = targetKey;
  const [state, setState] = useState<{
    key: string | undefined;
    status: DaemonWorkspaceSettingsStatus | undefined;
  }>({
    key: targetKey,
    status: undefined,
  });

  const reload = useCallback(async () => {
    const key = targetKey;
    if (currentKeyRef.current !== key) return undefined;
    const request = ++requestRef.current;
    if (!key || !target || target.route !== 'workspace-qualified') {
      setState({
        key,
        status: undefined,
      });
      return undefined;
    }

    setState({
      key,
      status: undefined,
    });
    try {
      const status = await loadVoiceSettings(client, target);
      if (request === requestRef.current && currentKeyRef.current === key) {
        setState({ key, status });
      }
      return status;
    } catch {
      if (request === requestRef.current && currentKeyRef.current === key) {
        setState({
          key,
          status: undefined,
        });
      }
      return undefined;
    }
  }, [client, target, targetKey]);
  const invalidate = useCallback(() => {
    requestRef.current++;
  }, []);

  useEffect(() => {
    void reload();
    return invalidate;
  }, [invalidate, reload]);

  const current = state.key === targetKey ? state : undefined;
  return {
    descriptor: current?.status?.settings.find(
      (setting) => setting.key === 'voiceModel',
    ),
    reload,
  };
}
